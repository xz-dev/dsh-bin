// Native install acceptance: local HTTP source, real manager, no host JS in tested PATH.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeZip, type ZipInput } from "../../dsh-bun-build/runtime/zip.ts";
import { hostTargetId } from "../../dsh-bun-build/scripts/targets.mjs";
import { acquireClaim } from "./claim-probe.ts";
import { addRuntime, argvOf, baseEnv, build, bundleMeta, cleanup, EXE, hasZig, launchOf, newInstall, run, started, tempDir, tree, type Install } from "./harness.ts";

const TARGET = hostTargetId();
const ID = "0.1.7-b1.1.gdeadbeef";
const LIVE = "live-cafebad-b2.1.gdeadbeef";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
beforeAll(() => { if (hasZig) build(); }, 300_000);
afterAll(cleanup);

function archive(id = ID, patch: Record<string, unknown> = {}, extra: ZipInput[] = []) {
	const file = join(tempDir("dsh-install-zip-"), "runtime.zip");
	const meta = bundleMeta(id, { channel: id.startsWith("live-") ? "live" : "release", patch: { target: TARGET, requiredPaths: [`dsh-native${EXE}`, "bundle.json", "app/package.json"], ...patch } });
	writeZip(file, [
		{ name: "bundle.json", data: Buffer.from(JSON.stringify(meta)), mode: 0o644 },
		{ name: `dsh-native${EXE}`, data: readFileSync(build().fake), mode: 0o755 },
		{ name: "app/package.json", data: Buffer.from('{"name":"fake-runtime"}'), mode: 0o644 },
		...extra,
	]);
	return { bytes: readFileSync(file), meta };
}
function entry(id: string, bytes: Uint8Array, patch: Record<string, unknown> = {}) {
	const meta = bundleMeta(id, { channel: id.startsWith("live-") ? "live" : "release" });
	return { kind: "dsh-runtime", tag: `${meta.channel === "release" ? "runtime-v" : "runtime-"}${id}`, id, channel: meta.channel, upstream: meta.upstream, run: meta.run, attempt: meta.attempt, launchProtocol: 1, builderCommit: meta.builderCommit, addons: { office: { slot: null, pinned: null } }, assets: { [TARGET]: { name: `runtime-${TARGET}.zip`, size: bytes.length, sha256: sha(bytes) } }, seq: 1, ...patch };
}
function source(entries: ReturnType<typeof entry>[], assets: Map<string, Uint8Array>, handler?: (req: Request, bytes: Uint8Array) => Response) {
	const requests: { path: string; range: string | null }[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
		const path = new URL(req.url).pathname;
		requests.push({ path, range: req.headers.get("range") });
		if (path === "/runtime-index.json") return Response.json({ schema: 1, channels: { release: entries.filter((e) => e.channel === "release"), live: entries.filter((e) => e.channel === "live") }, addons: { office: [] } });
		if (path === "/manager-index.json") return Response.json({ schema: 1, versions: [{ version: "99.0.0", tag: "manager-v99.0.0", assets: {} }] });
		const bytes = assets.get(path);
		return bytes ? (handler ? handler(req, bytes) : ranged(req, bytes)) : new Response(null, { status: 404 });
	} });
	return { requests, origin: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
const assetPath = (e: ReturnType<typeof entry>) => `/download/${e.tag}/${e.assets[TARGET].name}`;
function ranged(req: Request, body: Uint8Array) {
	const start = Number(/^bytes=(\d+)-$/.exec(req.headers.get("range") ?? "")?.[1] ?? 0);
	return new Response(body.subarray(start), { status: start ? 206 : 200, headers: start ? { "content-range": `bytes ${start}-${body.length - 1}/${body.length}` } : {} });
}
// Bun.serve shares event loop; never use spawnSync for HTTP clients.
async function install(i: Install, origin: string, args = [ID], extra: Record<string, string> = {}) {
	const proc = Bun.spawn([i.exe, "manager", "install", ...args], { cwd: i.home, env: { ...baseEnv(i), DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_ORIGIN: origin, DSH_MANAGER_TEST_RETRY_MS: "20", DSH_MANAGER_TEST_INACTIVITY_MS: "250", ...extra }, stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => proc.kill("SIGKILL"), 30_000);
	try {
		const [stdout, stderr, status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return { stdout, stderr, status };
	} finally { clearTimeout(timer); if (proc.exitCode === null) { proc.kill("SIGKILL"); await proc.exited; } }
}
const installed = (i: Install, id = ID) => existsSync(join(i.data, "bundles", id));

// 3.1 / 3.4 first vertical behavior.
test.skipIf(!hasZig)("FB-EMPTY / MC-EMPTY: manager-only install chooses runtime index host asset, prepares snapshot, starts offline", async () => {
	const i = newInstall(), a = archive(), e = entry(ID, a.bytes);
	const live = archive(LIVE), l = entry(LIVE, live.bytes);
	const incompatible = entry("9.0-b9.1.gdeadbeef", a.bytes, { launchProtocol: 99, seq: 2 });
	const other = entry("8.0-b8.1.gdeadbeef", a.bytes, { assets: { "wrong-target": e.assets[TARGET] }, seq: 3 });
	const legacy = entry("7.0-b7.1.gdeadbeef", a.bytes, { kind: undefined, launcherProtocol: 2, seq: 4 });
	const s = source([e, incompatible, other, legacy, l], new Map([[assetPath(e), a.bytes], [assetPath(l), live.bytes]]));
	try {
		const result = await install(i, s.origin, ["latest"]);
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		expect(installed(i)).toBe(true);
		expect(s.requests.map((r) => r.path)).toEqual(["/runtime-index.json", assetPath(e)]);
		expect(tree(i.home)).toEqual([]);
		expect(existsSync(join(i.data, "snapshots", `${ID}@1`, "snapshot.json"))).toBe(true);
		expect(JSON.parse(readFileSync(join(i.data, "bundles", ID, ".dsh-install.json"), "utf8"))).toMatchObject({ schema: 1, kind: "dsh-runtime-install", id: ID, target: TARGET, tag: e.tag, asset: e.assets[TARGET] });
		const liveResult = await install(i, s.origin, [l.tag, "--channel", "live"]);
		expect(liveResult.status).toBe(0);
		expect(installed(i, LIVE)).toBe(true);
		expect(installed(i, incompatible.id)).toBe(false);
		expect(installed(i, other.id)).toBe(false);
		expect(installed(i, legacy.id)).toBe(false);
	} finally { await s.stop(); }
	const startedApp = run(i, ["--use", ID, "--profile", "headless", "-p", "hello world"]);
	expect(startedApp.status).toBe(0);
	expect(argvOf(i)).toEqual(["--profile", "headless", "-p", "hello world"]);
	expect(launchOf(i).runtime).toBe(ID);
});

test.skipIf(!hasZig)("RB-LEGACY: only legacy/protocol/target mismatches cause no asset request or install", async () => {
	const bytes = archive().bytes;
	for (const patch of [{ kind: undefined, launcherProtocol: 2 }, { launchProtocol: 2 }, { assets: {} }]) {
		const i = newInstall(), e = entry(ID, bytes, patch), s = source([e], new Map([[assetPath(entry(ID, bytes)), bytes]]));
		try {
			const res = await install(i, s.origin);
			expect(res.status).toBe(1);
			expect(res.stderr).toContain("no compatible release runtime");
			expect(s.requests.map((r) => r.path)).toEqual(["/runtime-index.json"]);
			expect(installed(i)).toBe(false);
		} finally { await s.stop(); }
	}
});
