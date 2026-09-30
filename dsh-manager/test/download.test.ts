// DL-CORRUPT / FB-RETRY: actual Zig HTTP code, local socket faults, observed requests.
// Only external request: pinned Zig LICENSE over HTTPS; skip only DSH_MANAGER_OFFLINE=1.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";

const DIR = resolve(import.meta.dir, "..");
let driver: string;
let dir: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "dsh-http-test-"));
	driver = join(dir, process.platform === "win32" ? "dl-driver.exe" : "dl-driver");
	execFileSync("zig", ["build-exe", "-fsingle-threaded", "--dep", "http", "-Mroot=" + join(import.meta.dir, "download-driver.zig"), "-Mhttp=" + join(DIR, "src/http.zig"), "-femit-bin=" + driver], { timeout: 120_000, stdio: "inherit", cwd: dir });
}, 120_000);
afterAll(() => {
	server.stop(true);
	if (dir) rmSync(dir, { recursive: true, force: true });
});

function env(extra: Record<string, string> = {}) {
	return {
		PATH: process.env.PATH ?? "",
		...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
		HOME: dir,
		USERPROFILE: dir,
		TEMP: dir,
		TMP: dir,
		TMPDIR: dir,
		DSH_MANAGER_TEST: "1",
		DSH_MANAGER_TEST_RETRY_MS: "30",
		DSH_MANAGER_TEST_INACTIVITY_MS: "250",
		...extra,
	};
}

// Fixture shares Bun's event loop. Never block it while waiting for Zig.
function runDriver(args: string[], extra: Record<string, string> = {}, deadline = 15_000): Promise<{ status: number | null; stderr: string }> {
	return new Promise((resolveP, reject) => {
		const p = spawn(driver, args, { env: env(extra), cwd: dir });
		let stderr = "";
		p.stderr.on("data", (d) => (stderr += d));
		const timer = setTimeout(() => {
			p.kill("SIGKILL");
			reject(new Error(`driver exceeded external ${deadline}ms deadline: ${stderr}`));
		}, deadline);
		p.on("close", (status) => { clearTimeout(timer); resolveP({ status, stderr }); });
		p.on("error", (e) => { clearTimeout(timer); reject(e); });
	});
}

type Received = { method: string; path: string; host: string; range: string | null; encoding: string | null; at: number };
const requests: Received[] = [];
function record(req: Request) {
	requests.push({ method: req.method, path: new URL(req.url).pathname, host: req.headers.get("host") ?? "", range: req.headers.get("range"), encoding: req.headers.get("accept-encoding"), at: Date.now() });
}
type Handler = (req: Request) => Response | Promise<Response>;
let handler: Handler = () => new Response(null, { status: 404 });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { record(req); return handler(req); }, error() { return new Response(null, { status: 500 }); } });
const BASE = `http://127.0.0.1:${server.port}`;
beforeEach(() => { requests.length = 0; handler = () => new Response(null, { status: 404 }); });

const BODY = Buffer.from("dsh manager http test body: ".repeat(400) + "end");
const SIZE = BODY.length;
const sha = (body: Uint8Array | string) => createHash("sha256").update(body).digest("hex");
const SHA = sha(BODY);
const ranges = () => requests.filter((r) => r.path === "/asset").map((r) => r.range);
const dest = (name: string) => join(dir, name + ".bin");
const download = (path: string, extra: Record<string, string> = {}, body = BODY, hash = sha(body)) => runDriver(["download", `${BASE}/asset`, path, String(body.length), hash], extra);
const fetchSmall = (max = SIZE, extra: Record<string, string> = {}) => runDriver(["fetch", `${BASE}/index`, String(max)], extra);

function okBody(req: Request, body = BODY) {
	const range = req.headers.get("range");
	if (!range) return new Response(body);
	const start = Number(/^bytes=(\d+)-$/.exec(range)?.[1]);
	if (!Number.isSafeInteger(start) || start >= body.length) return new Response(null, { status: 416 });
	return new Response(body.subarray(start), { status: 206, headers: { "content-range": `bytes ${start}-${body.length - 1}/${body.length}` } });
}

function disconnected(body: Uint8Array) {
	// Asynchronous stream error sends the prefix, then drops the socket without
	// a final HTTP chunk. A fixed Response body would be a complete transfer.
	return new Response(new ReadableStream({
		start(c) {
			c.enqueue(body);
			setTimeout(() => { try { c.error(null); } catch {} }, 20);
		},
	}));
}

// Sends bytes now, remaining body only well after client's configured socket idle timeout.
function stall(req: Request, cut = 64) {
	const start = Number(/^bytes=(\d+)-$/.exec(req.headers.get("range") ?? "")?.[1] ?? 0);
	let timer: ReturnType<typeof setTimeout>;
	return new Response(new ReadableStream({
		start(c) {
			c.enqueue(BODY.subarray(start, start + cut));
			timer = setTimeout(() => { try { c.enqueue(BODY.subarray(start + cut)); c.close(); } catch {} }, 4000);
			timer.unref();
		},
		cancel() { clearTimeout(timer); },
	}), { status: start ? 206 : 200, headers: { "content-length": String(SIZE - start), ...(start ? { "content-range": `bytes ${start}-${SIZE - 1}/${SIZE}` } : {}) } });
}

function success(res: { status: number | null; stderr: string }, path?: string, body = BODY) {
	expect(res.stderr).not.toContain("leaked");
	expect(res.status).toBe(0);
	if (path) { expect(readFileSync(path).equals(body)).toBe(true); expect(existsSync(path + ".part")).toBe(false); }
}

function failure(res: { status: number | null; stderr: string }, error: string, path?: string) {
	expect(res.stderr).not.toContain("leaked");
	expect(res.status).toBe(1);
	expect(res.stderr).toContain(error);
	if (path) expect(readFileSync(path).toString()).toBe("current usable version");
}

describe("http.zig (black-box, real sockets)", () => {
	test("D10 endpoints require both nonempty test variables, never ordinary config", async () => {
		const origin = "http://fixture.example///";
		const both = await runDriver(["endpoints"], { DSH_MANAGER_TEST_ORIGIN: origin });
		success(both);
		expect(both.stderr).toContain("runtime_index=http://fixture.example/runtime-index.json");
		expect(both.stderr).toContain("manager_index=http://fixture.example/manager-index.json");
		expect(both.stderr).toContain("download_base=http://fixture.example/download");
		for (const extra of [{}, { DSH_MANAGER_TEST_ORIGIN: origin, DSH_MANAGER_TEST: "0" }, { DSH_MANAGER_TEST_ORIGIN: "" }, { DSH_MANAGER_ORIGIN: origin }]) {
			const res = await runDriver(["endpoints"], extra);
			success(res);
			expect(res.stderr).toContain("runtime_index=https://raw.githubusercontent.com/xz-dev/dsh-bin/releases/runtime-index.json");
			expect(res.stderr).toContain("download_base=https://github.com/xz-dev/dsh-bin/releases/download");
		}
	});

	test("verified 200 replaces existing dest, adjacent .part disappears, identity encoding", async () => {
		handler = (req) => okBody(req);
		const path = dest("normal");
		writeFileSync(path, "current usable version");
		success(await download(path), path);
		expect(ranges()).toEqual([null]);
		expect(requests[0]!.encoding).toBe("identity");
	});

	test("FB-RETRY kept partial appends and hashes entire file, exactly one Range request", async () => {
		handler = (req) => okBody(req);
		const path = dest("kept-partial");
		writeFileSync(path + ".part", BODY.subarray(0, 100));
		success(await download(path), path);
		expect(ranges()).toEqual(["bytes=100-"]);
	});

	test("FB-RETRY truncated body keeps bytes and next attempt resumes, no third download", async () => {
		const cut = Math.floor(SIZE / 2);
		handler = (req) => requests.length === 1 ? disconnected(BODY.subarray(0, cut)) : okBody(req);
		const path = dest("disconnect");
		success(await download(path), path);
		expect(ranges()).toEqual([null, `bytes=${cut}-`]);
	});

	test("ignored Range 200 replaces partial instead of splicing", async () => {
		handler = () => new Response(BODY);
		const path = dest("ignored");
		writeFileSync(path + ".part", BODY.subarray(0, 100));
		success(await download(path), path);
		expect(ranges()).toEqual(["bytes=100-"]);
	});

	test.each([
		["wrong start", `bytes 0-${SIZE - 1}/${SIZE}`],
		["wrong total", `bytes 100-${SIZE - 1}/${SIZE + 1}`],
		["wildcard total", `bytes 100-${SIZE - 1}/*`],
		["missing", ""],
		["reversed end", `bytes 100-99/${SIZE}`],
		["end beyond total", `bytes 100-${SIZE}/${SIZE}`],
		["malformed end", `bytes 100-oops/${SIZE}`],
	])("DL-CORRUPT %s Content-Range restarts from zero", async (_name, value) => {
		handler = (req) => req.headers.has("range") ? new Response(BODY.subarray(100), { status: 206, headers: value ? { "content-range": value } : {} }) : new Response(BODY);
		const path = dest("range-" + _name);
		writeFileSync(path + ".part", BODY.subarray(0, 100));
		success(await download(path), path);
		expect(ranges()).toEqual(["bytes=100-", null]);
	});

	test("DL-CORRUPT missing Content-Range never defaults to a valid zero-byte range", async () => {
		handler = () => new Response(null, { status: 206 });
		const path = dest("empty-bad-range");
		writeFileSync(path, "current usable version");
		failure(await download(path, {}, Buffer.alloc(0)), "DownloadFailed", path);
		expect(ranges()).toEqual(Array(5).fill(null));
	});

	test("416 discards partial, retries from zero", async () => {
		handler = (req) => req.headers.has("range") ? new Response(null, { status: 416 }) : new Response(BODY);
		const path = dest("416");
		writeFileSync(path + ".part", BODY.subarray(0, 100));
		success(await download(path), path);
		expect(ranges()).toEqual(["bytes=100-", null]);
	});

	test.each([416, 206])("persistent %i restart path stops at five attempts", async (status) => {
		handler = () => new Response(null, { status, headers: status === 206 ? { "content-range": `bytes 0-0/${SIZE + 1}` } : {} });
		const path = dest("bounded-" + status);
		writeFileSync(path, "current usable version");
		writeFileSync(path + ".part", BODY.subarray(0, 100));
		failure(await download(path), "DownloadFailed", path);
		expect(ranges()).toEqual(["bytes=100-", null, null, null, null]);
	});

	test("DL-CORRUPT stale resumed prefix gets only one from-zero hash retry", async () => {
		handler = (req) => okBody(req);
		const path = dest("stale-prefix");
		writeFileSync(path + ".part", Buffer.alloc(100));
		success(await download(path), path);
		expect(ranges()).toEqual(["bytes=100-", null]);
	});

	test("DL-CORRUPT hash failure leaves current dest intact and removes partial", async () => {
		handler = (req) => okBody(req);
		const path = dest("bad-hash");
		writeFileSync(path, "current usable version");
		writeFileSync(path + ".part", BODY.subarray(0, 100));
		failure(await download(path, {}, BODY, sha("wrong")), "HashMismatch", path);
		expect(ranges()).toEqual(["bytes=100-", null]);
		expect(existsSync(path + ".part")).toBe(false);
	});

	test("DL-CORRUPT overlarge kept partial refused without sending a request", async () => {
		const path = dest("overlarge-part");
		writeFileSync(path, "current usable version");
		writeFileSync(path + ".part", Buffer.alloc(SIZE + 1));
		failure(await download(path), "PartialTooLarge", path);
		expect(requests).toHaveLength(0);
	});

	test("DL-CORRUPT overlarge response removes partial, current dest unchanged", async () => {
		handler = () => new Response(Buffer.alloc(SIZE + 1));
		const path = dest("overlarge-body");
		writeFileSync(path, "current usable version");
		failure(await download(path), "PartialTooLarge", path);
		expect(requests).toHaveLength(1);
		expect(existsSync(path + ".part")).toBe(false);
	});

	test("all transient statuses retry both APIs, nonretryable statuses fail immediately", async () => {
		for (const status of [408, 425, 429, 500, 502, 503, 504, 403, 404]) {
			for (const mode of ["download", "fetch"] as const) {
				requests.length = 0;
				handler = (req) => requests.length === 1 ? new Response(null, { status, headers: { "retry-after": "0", "content-encoding": "gzip" } }) : okBody(req);
				const path = dest(`status-${status}-${mode}`);
				const res = mode === "download" ? await download(path) : await fetchSmall();
				if (status !== 403 && status !== 404) { success(res, mode === "download" ? path : undefined); expect(requests).toHaveLength(2); }
				else { failure(res, "HttpStatus"); expect(requests).toHaveLength(1); }
			}
		}
	}, 30_000);

	test("persistent status and socket errors stop both APIs after five attempts", async () => {
		for (const mode of ["download", "fetch"] as const) {
			for (const fault of ["status", "disconnect"]) {
				requests.length = 0;
				handler = () => fault === "status" ? new Response(null, { status: 503, headers: { "retry-after": "0" } }) : disconnected(Buffer.alloc(1));
				const res = mode === "download" ? await download(dest(`persistent-${mode}-${fault}`)) : await fetchSmall();
				failure(res, fault === "status" ? "HttpStatus" : "Network");
				expect(requests).toHaveLength(5);
			}
		}
	});

	test("Retry-After seconds honoured by both APIs", async () => {
		for (const mode of ["download", "fetch"] as const) {
			requests.length = 0;
			handler = (req) => requests.length === 1 ? new Response(null, { status: 429, headers: { "retry-after": "1" } }) : okBody(req);
			success(mode === "download" ? await download(dest("seconds")) : await fetchSmall());
			expect(requests).toHaveLength(2);
			expect(requests[1]!.at - requests[0]!.at).toBeGreaterThanOrEqual(900);
		}
	}, 10_000);

	test("Retry-After HTTP-date honoured, past dates retry without an extra second", async () => {
		let retryAt = 0;
		handler = (req) => {
			if (requests.length !== 1) return okBody(req);
			retryAt = (Math.floor(Date.now() / 1000) + 3) * 1000;
			return new Response(null, { status: 503, headers: { "retry-after": new Date(retryAt).toUTCString() } });
		};
		success(await download(dest("date")));
		expect(requests).toHaveLength(2);
		expect(requests[1]!.at).toBeGreaterThanOrEqual(retryAt - 150);
		requests.length = 0;
		handler = (req) => requests.length === 1 ? new Response(null, { status: 503, headers: { "retry-after": "Sun, 06 Nov 1994 08:49:37 GMT" } }) : okBody(req);
		success(await fetchSmall());
		expect(requests[1]!.at - requests[0]!.at).toBeLessThan(800);
	}, 10_000);

	test("invalid Retry-After falls back to exponential backoff, never fixed one second", async () => {
		handler = () => new Response(null, { status: 503, headers: { "retry-after": "not a date" } });
		failure(await fetchSmall(SIZE, { DSH_MANAGER_TEST_RETRY_MS: "60" }), "HttpStatus");
		expect(requests).toHaveLength(5);
		for (let i = 1; i < 5; i++) expect(requests[i]!.at - requests[i - 1]!.at).toBeGreaterThanOrEqual(40 * 2 ** (i - 1));
		expect(requests[1]!.at - requests[0]!.at).toBeLessThan(800);
	}, 10_000);

	test("socket idle timeout preserves received bytes, reports progress, retries before late body", async () => {
		handler = (req) => requests.length === 1 ? stall(req) : okBody(req);
		const path = dest("stall");
		writeFileSync(path, "current usable version");
		const started = Date.now();
		const pending = download(path);
		for (let i = 0; i < 100 && (!existsSync(path + ".part") || statSync(path + ".part").size < 64); i++) await Bun.sleep(10);
		expect(existsSync(path + ".part")).toBe(true);
		expect(statSync(path + ".part").size).toBe(64);
		expect(readFileSync(path).toString()).toBe("current usable version");
		const res = await pending;
		success(res, path);
		expect(ranges()).toEqual([null, "bytes=64-"]);
		expect(res.stderr).toContain(`progress 64/${SIZE}`);
		expect(Date.now() - started).toBeLessThan(2000);
	});

	test("progress never resets retry budget; exhausted partial resumes on next invocation", async () => {
		handler = (req) => stall(req);
		const path = dest("repeated-stall");
		writeFileSync(path, "current usable version");
		failure(await download(path, { DSH_MANAGER_TEST_INACTIVITY_MS: "100" }), "Network", path);
		expect(ranges()).toEqual([null, "bytes=64-", "bytes=128-", "bytes=192-", "bytes=256-"]);
		expect(statSync(path + ".part").size).toBe(320);
		requests.length = 0;
		handler = (req) => okBody(req);
		success(await download(path), path);
		expect(ranges()).toEqual(["bytes=320-"]);
	}, 10_000);

	test("header stall and fetch body stall retry within socket idle timeout", async () => {
		for (const fault of ["head", "body"]) {
			requests.length = 0;
			handler = async (req) => {
				if (requests.length !== 1) return okBody(req);
				if (fault === "body") return stall(req);
				await Bun.sleep(4000);
				return okBody(req);
			};
			const started = Date.now();
			success(await fetchSmall());
			expect(requests).toHaveLength(2);
			expect(Date.now() - started).toBeLessThan(2000);
		}
	});

	test("cross-host redirect retains Range/identity and times out on new connection", async () => {
		let attempts = 0;
		const other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { record(req); attempts++; return attempts === 1 ? stall(req) : okBody(req); } });
		try {
			handler = () => new Response(null, { status: 302, headers: { location: `http://localhost:${other.port}/other` } });
			const path = dest("redirect-stall");
			writeFileSync(path + ".part", BODY.subarray(0, 100));
			const started = Date.now();
			success(await download(path), path);
			// Windows localhost may try refused IPv6 before IPv4 (~2s/connect).
			// Measure the idle stall after the first redirected request, not TCP setup.
			expect(requests[2]!.at - requests[1]!.at).toBeLessThan(2000);
			expect(Date.now() - started).toBeLessThan(process.platform === "win32" ? 10_000 : 2000);
			expect(requests.map((r) => r.range)).toEqual(["bytes=100-", "bytes=100-", "bytes=164-", "bytes=164-"]);
			expect(requests[1]!.host).toContain("localhost:");
			expect(requests.every((r) => r.method === "GET" && r.encoding === "identity")).toBe(true);
		} finally { other.stop(true); }
	}, 12_000);

	test("relative redirects work; redirect loops are bounded without consuming response bodies", async () => {
		handler = (req) => new URL(req.url).pathname === "/index" ? new Response("ignored body", { status: 307, headers: { location: "./final" } }) : new Response("index");
		success(await fetchSmall());
		expect(requests.map((r) => r.path)).toEqual(["/index", "/final"]);
		requests.length = 0;
		handler = () => new Response(null, { status: 302, headers: { location: "/index" } });
		failure(await fetchSmall(), "HttpStatus");
		expect(requests).toHaveLength(6); // initial request + five redirects, no retry loop around it
	});

	test("unexpected transfer compression refused by both APIs", async () => {
		handler = () => new Response(BODY, { headers: { "content-encoding": "gzip" } });
		failure(await download(dest("encoded")), "HttpStatus");
		failure(await fetchSmall(), "HttpStatus");
		expect(requests).toHaveLength(2);
		expect(requests.every((r) => r.encoding === "identity")).toBe(true);
	});

	test("fetchSmall bounds both declared and chunked bodies; exact limit and zero succeed", async () => {
		for (const chunked of [false, true]) {
			handler = () => chunked ? new Response(new ReadableStream({
				start(c) {
					c.enqueue(BODY.subarray(0, 32));
					setTimeout(() => { try { c.enqueue(BODY.subarray(32)); c.close(); } catch {} }, 20);
				},
			})) : new Response(BODY);
			failure(await fetchSmall(50), "TooLarge");
			success(await fetchSmall(SIZE));
		}
		handler = () => new Response(Buffer.alloc(8192));
		success(await fetchSmall(8192));
		handler = () => new Response(null);
		success(await fetchSmall(0));
	});

	test("fetchSmall retries a truncated declared body, never returns incomplete index", async () => {
		// Bun rewrites Content-Length for completed streams. A raw local peer tests
		// this precise wire contract; all other fault fixtures remain Bun.serve.
		const received: string[] = [];
		const raw = createServer((socket) => {
			socket.once("data", (data) => {
				received.push(data.toString().split("\r\n")[0]!);
				const body = received.length === 1 ? "incomplete" : "complete index";
				socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${received.length === 1 ? 100 : body.length}\r\nConnection: close\r\n\r\n${body}`);
			});
		});
		await new Promise<void>((resolveP) => raw.listen(0, "127.0.0.1", resolveP));
		try {
			const address = raw.address();
			if (!address || typeof address === "string") throw new Error("expected TCP address");
			const res = await runDriver(["fetch", `http://127.0.0.1:${address.port}/index`, "1000"]);
			success(res);
			expect(res.stderr).toContain("ok 14 bytes");
			expect(received).toEqual(["GET /index HTTP/1.1", "GET /index HTTP/1.1"]);
		} finally { await new Promise<void>((resolveP) => raw.close(() => resolveP())); }
	});

	test("HTTP proxy works; HTTPS proxy routes fail closed before CONNECT or origin bytes", async () => {
		for (const name of ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) {
			requests.length = 0;
			handler = () => new Response("proxied index");
			const res = await runDriver(["fetch", "http://does-not-exist.invalid/index", "100"], { [name]: BASE });
			success(res);
			expect(requests).toHaveLength(1);
			expect(requests[0]!.host).toBe("does-not-exist.invalid");
		}
		for (const name of ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) {
			requests.length = 0;
			const res = await runDriver(["fetch", "https://does-not-exist.invalid/secret?token=hidden", "100"], { [name]: `http://user:password@127.0.0.1:${server.port}` });
			failure(res, "UnsupportedProxy");
			expect(res.stderr.toLowerCase()).toContain(name.toLowerCase());
			expect(res.stderr).toContain("unset");
			expect(res.stderr).not.toContain("password");
			expect(res.stderr).not.toContain("token=hidden");
			expect(requests).toHaveLength(0);
		}
	});

	test("HTTPS redirect checks proxy policy again before contacting redirected origin", async () => {
		handler = () => new Response(null, { status: 302, headers: { location: "https://does-not-exist.invalid/index" } });
		const res = await fetchSmall(SIZE, { HTTPS_PROXY: BASE });
		failure(res, "UnsupportedProxy");
		expect(requests).toHaveLength(1);
	});

	test("connection refusal retried, invalid URL rejected immediately", async () => {
		const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response(null); } });
		const port = closed.port;
		closed.stop(true);
		for (const mode of ["download", "fetch"]) {
			const started = Date.now();
			const args = mode === "download" ? [mode, `http://127.0.0.1:${port}/asset`, dest("refused"), String(SIZE), SHA] : [mode, `http://127.0.0.1:${port}/index`, "100"];
			// Winsock retries a refused local connect for ~2s before returning.
			// Keep five HTTP attempts and an external per-invocation kill deadline.
			failure(await runDriver(args, {}, 25_000), "Network");
			const elapsed = Date.now() - started;
			expect(elapsed).toBeGreaterThanOrEqual(400); // four backoffs: 30+60+120+240 ms
			expect(elapsed).toBeLessThan(25_000);
			args[1] = "file:///not-http";
			failure(await runDriver(args), "BadUrl");
		}
	}, 55_000);

	test.skipIf(process.env.DSH_MANAGER_OFFLINE === "1")("real HTTPS: pinned Zig 0.15.2 LICENSE, verified size and SHA-256", async () => {
		const path = dest("zig-license");
		const hash = "5c537d6853e005298a285d508cff9ac7192cea23576c840d485b2b586a7ff177";
		const res = await runDriver(["download", "https://raw.githubusercontent.com/ziglang/zig/0.15.2/LICENSE", path, "1080", hash], { DSH_MANAGER_TEST: "" }, 60_000);
		success(res);
		expect(statSync(path).size).toBe(1080);
		expect(sha(readFileSync(path))).toBe(hash);
		expect(existsSync(path + ".part")).toBe(false);
	}, 65_000);
});
