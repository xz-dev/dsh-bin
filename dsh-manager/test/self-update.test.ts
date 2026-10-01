// Manager discovery/verification only: real Zig candidates, isolated HOME, no JS in child PATH.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeZip, type ZipInput } from "../../dsh-bun-build/runtime/zip.ts";
import { hostTargetId } from "../../dsh-bun-build/scripts/targets.mjs";
import { addRuntime, baseEnv, build, bundleMeta, cleanup, EXE, hasZig, MANAGER_VERSION, newInstall, run, started, tempDir, tree, WIN, type Install } from "./harness.ts";

const NEXT = "9.8.8", A = "1.0.0-b1.1.gdeadbeef", OLD = "0.1.0-b1.1.gcafebabe";
const TARGET = `${process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "x64" ? "x64" : "arm64"}`;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
let next: string;
beforeAll(() => { if (hasZig) { build(); next = build(NEXT).manager; } }, 300_000);
afterAll(cleanup);
function archive(binary = next, extra: ZipInput[] = []) {
	const zip = join(tempDir("dsh-manager-zip-"), "manager.zip");
	writeZip(zip, [{ name: `dsh${EXE}`, data: readFileSync(binary), mode: 0o755 }, ...extra]);
	return readFileSync(zip);
}
function entry(version: string, bytes: Uint8Array, patch: Record<string, unknown> = {}) {
	return { version, tag: `manager-v${version}`, launchProtocols: [1], assets: { [TARGET]: { name: `manager-${TARGET}.zip`, size: bytes.length, sha256: sha(bytes) } }, ...patch };
}
function source(versions: ReturnType<typeof entry>[], bytes: Uint8Array, runtime?: { entry: unknown; bytes: Uint8Array }) {
	const requests: string[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
		const path = new URL(req.url).pathname; requests.push(path);
		if (path === "/manager-index.json") return Response.json({ schema: 1, versions });
		if (path === "/runtime-index.json") return Response.json({ schema: 1, channels: { release: runtime ? [runtime.entry] : [], live: [] }, addons: { office: [] } });
		if (path.startsWith("/download/runtime-")) return new Response(runtime?.bytes);
		if (path.startsWith("/download/manager-")) return new Response(bytes);
		return new Response(null, { status: 404 });
	} });
	return { requests, origin: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
async function command(i: Install, s: ReturnType<typeof source>, args = ["manager", "self-update"], env: Record<string, string> = {}) {
	const p = Bun.spawn([i.exe, ...args], { cwd: i.home, env: { ...baseEnv(i), DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_ORIGIN: s.origin, DSH_MANAGER_TEST_RETRY_MS: "10", ...env }, stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => p.kill(), 30_000);
	try { const [stdout, stderr, status] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]); return { stdout, stderr, status }; }
	finally { clearTimeout(timer); }
}
const protectedDirs = ["bundles", "snapshots", "addons", "home"];
function protectedBytes(i: Install) {
	const result: Record<string, string> = {};
	for (const folder of protectedDirs) for (const path of tree(join(i.data, folder))) {
		const file = join(i.data, folder, path); try { result[`${folder}/${path}`] = sha(readFileSync(file)); } catch { result[`${folder}/${path}`] = "directory"; }
	}
	for (const path of ["state/selection.json", "state/channel", "state/config.json", ".dsh-bin-data.json"]) if (existsSync(join(i.data, path))) result[path] = sha(readFileSync(join(i.data, path)));
	return result;
}
function fixture() {
	const i = newInstall(); addRuntime(i.data, A);
	expect(run(i, ["manager", "snapshot", "new", "--use", A, "--empty"]).status).toBe(0);
	expect(run(i, ["manager", "select", "--use", A, "--snapshot", `${A}@1`]).status).toBe(0);
	for (const path of ["home/profiles/main/cordis.patch.yml", "home/credential", "addons/office/keep", "snapshots/" + A + "@1/profiles/plugin", "state/config.json"]) { mkdirSync(join(i.data, path, ".."), { recursive: true }); writeFileSync(join(i.data, path), "KEEP"); }
	return i;
}

test.skipIf(!hasZig)("MC-SELF-ONLY: same-protocol newer manager is prepared, never executed or installed, protected bytes unchanged", async () => {
	const i = fixture(), bytes = archive(), s = source([entry(NEXT, bytes)], bytes), before = protectedBytes(i), exe = sha(readFileSync(i.exe)), allBefore = tree(i.data);
	try {
		const r = await command(i, s); expect(r.stderr).toBe(""); expect(r.status).toBe(0); expect(r.stdout).toContain("prepared, not installed");
		const candidate = join(i.dir, `.dsh-manager-candidate-${NEXT}`); expect(sha(readFileSync(candidate))).toBe(sha(readFileSync(next)));
		expect(protectedBytes(i)).toEqual(before); expect(sha(readFileSync(i.exe))).toBe(exe); expect(started(i)).toBe(false);
		expect(s.requests).toEqual(["/manager-index.json", `/download/manager-v${NEXT}/manager-${TARGET}.zip`]);
		const added = tree(i.data).filter(p => !allBefore.includes(p));
		expect(added.filter(p => !["cache", "cache/downloads", `cache/downloads/${sha(bytes)}.zip`, "tmp", "state/manager.lock"].includes(p))).toEqual([]);
		expect(run(i, ["manager", "--version"]).stdout).toContain(MANAGER_VERSION);
		expect((await command(i, s)).status).toBe(0); expect(readdirSync(i.dir).filter(n => n.startsWith(".dsh-manager-candidate-"))).toEqual([`.dsh-manager-candidate-${NEXT}`]);
	} finally { s.stop(); }
});

test.skipIf(!hasZig)("MC-SELF-ONLY: SemVer 1.10 > 1.9, prerelease ordering and same-version force repair ignore build metadata", async () => {
	const bytes = archive();
	for (const [versions, force, status, text, asset] of [
		[["1.9.0", "1.10.0", NEXT], false, 0, "prepared", true],
		[[MANAGER_VERSION], false, 0, "already current", false],
		[[MANAGER_VERSION], true, 0, "prepared", true],
		[["9.8.7-test.0"], true, 1, "Downgrade", false],
		[["9.8.7-test.1+repair"], false, 0, "already current", false],
	] as const) {
		const i = newInstall(), version = versions[0], payload = version === MANAGER_VERSION ? archive(build().manager) : bytes;
		const s = source(versions.map(v => entry(v, payload)), payload);
		try { const r = await command(i, s, ["manager", "self-update", ...(force ? ["--force"] : [])]); expect(r.status).toBe(status); expect(r.stdout + r.stderr).toContain(text); expect(s.requests.some(p => p.startsWith("/download/"))).toBe(asset); }
		finally { s.stop(); }
	}
});

test.skipIf(!hasZig)("MC-SELF-FAIL: incompatible protocol/target, downgrade, duplicate or invalid identity refuse before archive", async () => {
	const bytes = archive(), good = entry(NEXT, bytes);
	for (const versions of [[{ ...good, launchProtocols: [2] }], [{ ...good, assets: { wrong: good.assets[TARGET] } }], [entry("1.0.0", bytes)], [good, good], [entry("09.0.0", bytes)], [{ ...good, tag: "../manager-v9.8.8" }]]) {
		const i = newInstall(), before = sha(readFileSync(i.exe)), s = source(versions, bytes);
		try { const r = await command(i, s); expect(r.status).toBe(1); expect(s.requests).toEqual(["/manager-index.json"]); expect(sha(readFileSync(i.exe))).toBe(before); expect(readdirSync(i.dir).some(n => n.startsWith(".dsh-manager-candidate-"))).toBe(false); }
		finally { s.stop(); }
	}
});

test.skipIf(!hasZig)("MC-SELF-FAIL: bad digest/size, wrong binary marker/type, extra roots and traversal never publish a candidate", async () => {
	const valid = archive();
	const wrong = Buffer.from(readFileSync(next)); wrong.fill(0, 0, 4);
	const file = join(tempDir("bad-manager-"), "bad.zip"); writeZip(file, [{ name: `dsh${EXE}`, data: wrong, mode: 0o755 }]);
	const traversed = Buffer.from(archive(next, [{ name: "safe_file_", data: Buffer.from("bad") }]));
	for (let at = traversed.indexOf("safe_file_"); at !== -1; at = traversed.indexOf("safe_file_", at + 10)) traversed.write("../outside", at);
	for (const [bytes, patch] of [[valid, { sha256: "a".repeat(64) }], [valid, { size: valid.length + 1 }], [archive(build().manager), {}], [readFileSync(file), {}], [archive(next, [{ name: "user-file", data: Buffer.from("bad") }]), {}], [traversed, {}]] as const) {
		const i = fixture(), before = protectedBytes(i), e = entry(NEXT, bytes); Object.assign(e.assets[TARGET], patch); const s = source([e], bytes);
		try { const r = await command(i, s); expect(r.status).toBe(1); expect(protectedBytes(i)).toEqual(before); expect(readdirSync(i.dir).some(n => n.startsWith(".dsh-manager-candidate-"))).toBe(false); expect(started(i)).toBe(false); }
		finally { s.stop(); }
	}
});

test.skipIf(!hasZig)("DL-MANAGED-SELF: portage/scoop refuse before any request, state creation or candidate staging", async () => {
	const bytes = archive(), s = source([entry(NEXT, bytes)], bytes);
	try { for (const owner of ["portage", "scoop"]) { const i = newInstall(); writeFileSync(join(i.dir, ".dsh-manager-install.json"), JSON.stringify({ schema: 1, owner })); const r = await command(i, s, undefined, { LOCALAPPDATA: join(i.home, "local") }); expect(r.status).toBe(1); expect(r.stderr).toContain(owner === "portage" ? "emerge" : "scoop update"); expect(tree(i.home)).toEqual([]); expect(s.requests).toEqual([]); } }
	finally { s.stop(); }
});

test.skipIf(!hasZig)("MC-OLD-RUNTIME: older upstream install/select never changes the manager identity or prepared newer candidate", async () => {
	const i = fixture(), meta = bundleMeta(OLD, { commitTime: "2020-01-01T00:00:00.000Z", patch: { target: hostTargetId() } }), file = join(tempDir("old-runtime-"), "runtime.zip");
	writeZip(file, [{ name: "bundle.json", data: Buffer.from(JSON.stringify(meta)) }, { name: `dsh-native${EXE}`, data: readFileSync(build().fake), mode: 0o755 }]);
	const runtimeBytes = readFileSync(file), e = { ...meta, tag: `runtime-v${OLD}`, seq: 1, assets: { [hostTargetId()]: { name: "runtime.zip", size: runtimeBytes.length, sha256: sha(runtimeBytes) } } };
	const bytes = archive(), s = source([entry(NEXT, bytes)], bytes, { entry: e, bytes: runtimeBytes }), exe = sha(readFileSync(i.exe));
	try { expect((await command(i, s)).status).toBe(0); const staged = join(i.dir, `.dsh-manager-candidate-${NEXT}`), before = sha(readFileSync(staged)); expect((await command(i, s, ["manager", "install", OLD])).status).toBe(0); expect(run(i, ["manager", "select", "--use", OLD]).status).toBe(0); expect(run(i, ["manager", "--version"]).stdout).toContain(MANAGER_VERSION); expect(sha(readFileSync(i.exe))).toBe(exe); expect(sha(readFileSync(staged))).toBe(before); expect(run(i, []).status).toBe(0); }
	finally { s.stop(); }
});

test.skipIf(!hasZig)("MC-CLEAN: portable manager candidates reclaim only exact marked regular files, never links or unknown bytes", () => {
	const i = fixture(), real = join(i.dir, `.dsh-manager-candidate-${NEXT}`), unknown = join(i.dir, ".dsh-manager-candidate-8.0.0"), alias = join(i.dir, ".dsh-manager-candidate-7.0.0");
	cpSync(next, real); writeFileSync(unknown, "USER FILE");
	if (!WIN) symlinkSync(real, alias); else { mkdirSync(alias); writeFileSync(join(alias, "keep"), "KEEP"); }
	expect(run(i, ["manager", "clean"]).status).toBe(0); expect(existsSync(real)).toBe(false); expect(readFileSync(unknown, "utf8")).toBe("USER FILE"); expect(readdirSync(i.dir)).toContain(alias.split(/[\\/]/).at(-1)!);
});
