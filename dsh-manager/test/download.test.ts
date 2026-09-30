// Black-box tests for src/http.zig: real code over real sockets against a fault-injecting
// Bun.serve fixture on 127.0.0.1, plus one real HTTPS fetch (skipped only on DSH_MANAGER_OFFLINE=1).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIR = resolve(import.meta.dir, "..");
const DRIVER_SRC = join(import.meta.dir, "download-driver.zig");
const HTTP_SRC = join(DIR, "src", "http.zig");
const hasZig = Bun.which("zig") !== null;

let driver: string;
let dir: string;
const requests: { method: string; url: string; range: string | null }[] = [];

beforeAll(() => {
	if (!hasZig) return;
	dir = mkdtempSync(join(tmpdir(), "dsh-http-test-"));
	driver = join(dir, "dl-driver");
	execFileSync("zig", ["build-exe", "--dep", "http", "-Mroot=" + DRIVER_SRC, "-Mhttp=" + HTTP_SRC, "-femit-bin=" + driver], { stdio: "inherit" });
}, 120_000);
afterAll(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

function env(extra: Record<string, string> = {}) {
	return {
		PATH: process.env.PATH ?? "",
		DHOME: dir,
		DSH_MANAGER_TEST: "1",
		DSH_MANAGER_TEST_RETRY_MS: "40",
		DSH_MANAGER_TEST_INACTIVITY_MS: "800",
		...extra,
	};
}

// Bun.serve runs on this process's event loop, so the driver must be spawned async.
function runDriver(args: string[], extra: Record<string, string> = {}): Promise<{ status: number | null; stderr: string; stdout: string }> {
	return new Promise((resolveP) => {
		const p = spawn(driver, args, { env: env(extra) });
		let stderr = "";
		let stdout = "";
		p.stderr.on("data", (d) => (stderr += d));
		p.stdout.on("data", (d) => (stdout += d));
		p.on("close", (status) => resolveP({ status, stderr, stdout }));
		p.on("error", (e) => resolveP({ status: null, stderr: String(e), stdout }));
		setTimeout(() => { p.kill("SIGKILL"); }, 60_000).unref();
	});
}

type Handler = (req: Request, url: URL) => Response | Promise<Response>;
let handler: Handler = () => new Response("nope", { status: 404 });
const server = Bun.serve({
	port: 0,
	fetch(req) {
		const url = new URL(req.url);
		requests.push({ method: req.method, url: url.pathname, range: req.headers.get("range") });
		return handler(req, url);
	},
});
const BASE = `http://127.0.0.1:${server.port}`;

const BODY = Buffer.from("dsh manager http test body: ".repeat(400) + "end");
const SHA = createHash("sha256").update(BODY).digest("hex");
const SIZE = BODY.length;

function okBody(req: Request): Response {
	const range = req.headers.get("range");
	if (range) {
		const m = /^bytes=(\d+)-$/.exec(range);
		if (m) {
			const start = Number(m[1]);
			if (start >= SIZE) return new Response(null, { status: 416 });
			return new Response(BODY.subarray(start), {
				status: 206,
				headers: { "content-range": `bytes ${start}-${SIZE - 1}/${SIZE}`, "content-length": String(SIZE - start) },
			});
		}
	}
	return new Response(BODY);
}

describe("http.zig (black-box, real sockets)", () => {
	test("endpoints: test origin honoured only with both variables", async () => {
		const origin = "http://fixture.example";
		const both = await runDriver(["endpoints"], { DSH_MANAGER_TEST_ORIGIN: origin });
		expect(both.status).toBe(0);
		expect(both.stderr).toContain(`runtime_index=${origin}/runtime-index.json`);
		expect(both.stderr).toContain(`download_base=${origin}/download`);

		const onlyFlag = await runDriver(["endpoints"], {});
		expect(onlyFlag.stderr).toContain("raw.githubusercontent.com/xz-dev/dsh-bin/releases/runtime-index.json");

		const onlyOrigin = await runDriver(["endpoints"], { DSH_MANAGER_TEST_ORIGIN: origin, DSH_MANAGER_TEST: "" });
		expect(onlyOrigin.stderr).toContain("raw.githubusercontent.com/xz-dev/dsh-bin/releases/runtime-index.json");
	});

	test("normal download: 200, file written, no .part left", async () => {
		handler = (req) => okBody(req);
		const dest = join(dir, "normal.bin");
		const res = await runDriver(["download", `${BASE}/x`, dest, String(SIZE), SHA]);
		expect(res.status).toBe(0);
		expect(readFileSync(dest).equals(BODY)).toBe(true);
		expect(existsSync(dest + ".part")).toBe(false);
		expect(requests.at(-1)!.range).toBeNull();
	});

	test("mid-body disconnect then Range resume with 206", async () => {
		let dropped = false;
		const cut = Math.floor(SIZE / 2);
		handler = (req) => {
			const range = req.headers.get("range");
			if (!range && !dropped) {
				dropped = true;
				// Truncated body: declare full length but close early.
				return new Response(BODY.subarray(0, cut), { headers: { "content-length": String(SIZE) } });
			}
			return okBody(req);
		};
		const dest = join(dir, "resume.bin");
		const res = await runDriver(["download", `${BASE}/r`, dest, String(SIZE), SHA]);
		expect(res.status).toBe(0);
		expect(readFileSync(dest).equals(BODY)).toBe(true);
		expect(existsSync(dest + ".part")).toBe(false);
		const ranges = requests.filter((r) => r.url === "/r").map((r) => r.range);
		expect(ranges).toContain(`bytes=${cut}-`);
	});

	test("server ignores Range and answers 200: restart from zero, correct result", async () => {
		handler = (req) => new Response(BODY); // no Range handling at all
		const dest = join(dir, "ignore-range.bin");
		// Seed a partial first.
		const half = BODY.subarray(0, Math.floor(SIZE / 3));
		writeFileSync(dest + ".part", half);
		const res = await runDriver(["download", `${BASE}/i`, dest, String(SIZE), SHA]);
		expect(res.status).toBe(0);
		expect(readFileSync(dest).equals(BODY)).toBe(true);
	});

	test("wrong Content-Range start: no splice, restart from 0", async () => {
		handler = (req) => {
			const range = req.headers.get("range");
			if (range) {
				// Lying server: claims a different start offset.
				return new Response(BODY, {
					status: 206,
					headers: { "content-range": `bytes 0-${SIZE - 1}/${SIZE}`, "content-length": String(SIZE) },
				});
			}
			return new Response(BODY);
		};
		const dest = join(dir, "bad-range.bin");
		writeFileSync(dest + ".part", BODY.subarray(0, 100));
		const res = await runDriver(["download", `${BASE}/cr`, dest, String(SIZE), SHA]);
		expect(res.status).toBe(0);
		expect(readFileSync(dest).equals(BODY)).toBe(true);
	});

	test("503 with Retry-After then success", async () => {
		let n = 0;
		handler = (req) => {
			n++;
			if (n === 1) return new Response("busy", { status: 503, headers: { "retry-after": "1" } });
			return okBody(req);
		};
		const dest = join(dir, "retry.bin");
		const t0 = Date.now();
		const res = await runDriver(["download", `${BASE}/ra`, dest, String(SIZE), SHA]);
		expect(res.status).toBe(0);
		expect(Date.now() - t0).toBeGreaterThanOrEqual(900); // honoured the 1 s hint (capped min)
		expect(readFileSync(dest).equals(BODY)).toBe(true);
	});

	test("stall longer than inactivity timeout aborts the attempt, retry succeeds", async () => {
		let stalled = false;
		handler = async (req) => {
			if (!stalled && !req.headers.get("range")) {
				stalled = true;
				// Send headers then hang past the inactivity timeout.
				return new Response(
					new ReadableStream({
						async start(c) {
							c.enqueue(BODY.subarray(0, 64));
							await new Promise((r) => setTimeout(r, 3000)); // > 800 ms inactivity
							c.enqueue(BODY.subarray(64));
							c.close();
						},
					}),
					{ headers: { "content-length": String(SIZE) } },
				);
			}
			return okBody(req);
		};
		const dest = join(dir, "stall.bin");
		const res = await runDriver(["download", `${BASE}/s`, dest, String(SIZE), SHA]);
		expect(res.status).toBe(0);
		expect(readFileSync(dest).equals(BODY)).toBe(true);
	}, 30_000);

	test("bad hash: failure, no dest, no .part", async () => {
		handler = (req) => okBody(req);
		const dest = join(dir, "badhash.bin");
		const wrongSha = createHash("sha256").update("wrong").digest("hex");
		const res = await runDriver(["download", `${BASE}/h`, dest, String(SIZE), wrongSha]);
		expect(res.status).toBe(1);
		expect(res.stderr).toContain("HashMismatch");
		expect(existsSync(dest)).toBe(false);
		expect(existsSync(dest + ".part")).toBe(false);
	});

	test("oversize .part is refused", async () => {
		handler = (req) => okBody(req);
		const dest = join(dir, "oversize.bin");
		writeFileSync(dest + ".part", Buffer.alloc(SIZE + 10));
		const res = await runDriver(["download", `${BASE}/o`, dest, String(SIZE), SHA]);
		expect(res.status).toBe(1);
		expect(res.stderr).toContain("PartialTooLarge");
		expect(existsSync(dest)).toBe(false);
	});

	test("fetchSmall: body over max_bytes refused", async () => {
		handler = () => new Response("x".repeat(100));
		const res = await runDriver(["fetch", `${BASE}/f`, "50"]);
		expect(res.status).toBe(1);
		expect(res.stderr).toContain("TooLarge");
	});

	test("fetchSmall: small body returned", async () => {
		handler = () => new Response("hello index");
		const res = await runDriver(["fetch", `${BASE}/f2`, "1000"]);
		expect(res.status).toBe(0);
		expect(res.stderr).toContain("ok 11 bytes");
	});

	test("real HTTPS fetch over TLS (skippable only via DSH_MANAGER_OFFLINE=1)", async () => {
		if (process.env.DSH_MANAGER_OFFLINE === "1") return;
		// A stable public file; sha256 established once.
		const url = "https://raw.githubusercontent.com/ziglang/zig/0.15.2/LICENSE";
		const dest = join(dir, "zig-license");
		const expectedSha = "5c537d6853e005298a285d508cff9ac7192cea23576c840d485b2b586a7ff177";
		const res = await new Promise<{ status: number | null; stderr: string }>((res2) => {
			const p = spawn(driver, ["download", url, dest, "1080", expectedSha], { env: { PATH: process.env.PATH ?? "" } });
			let stderr = "";
			p.stderr.on("data", (d) => (stderr += d));
			p.on("close", (status) => res2({ status, stderr }));
			setTimeout(() => p.kill("SIGKILL"), 60_000).unref();
		});
		if (res.status !== 0) {
			// Report the actual digest so the expectation can be corrected once.
			if (existsSync(dest)) {
				const got = createHash("sha256").update(readFileSync(dest)).digest("hex");
				throw new Error(`download failed (${res.stderr.trim()}); actual sha256=${got}`);
			}
			throw new Error(`download failed: ${res.stderr.trim()}`);
		}
	});
});
