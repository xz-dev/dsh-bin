// Native install acceptance: local HTTP source, real manager, no host JS in tested PATH.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeZip, type ZipInput } from "../../dsh-bun-build/runtime/zip.ts";
import { hostTargetId } from "../../dsh-bun-build/scripts/targets.mjs";
import { acquireClaim } from "./claim-probe.ts";
import { connectProxy, TEST_CA_FILE, TEST_TLS } from "./proxy-fixture.ts";
import { addRuntime, argvOf, baseEnv, build, bundleMeta, cleanup, EXE, hasZig, launchOf, MANAGER_DIR, newInstall, run, started, tempDir, tree, WIN, type Install } from "./harness.ts";

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
function source(entries: ReturnType<typeof entry>[], assets: Map<string, Uint8Array>, handler?: (req: Request, bytes: Uint8Array) => Response, tls = false) {
	const requests: { path: string; range: string | null }[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, ...(tls ? { tls: TEST_TLS } : {}), fetch(req) {
		const path = new URL(req.url).pathname;
		requests.push({ path, range: req.headers.get("range") });
		if (path === "/runtime-index.json") return Response.json({ schema: 1, channels: { release: entries.filter((e) => e.channel === "release"), live: entries.filter((e) => e.channel === "live") }, addons: { office: [] } });
		if (path === "/manager-index.json") return Response.json({ schema: 1, versions: [{ version: "99.0.0", tag: "manager-v99.0.0", assets: {} }] });
		const bytes = assets.get(path);
		return bytes ? (handler ? handler(req, bytes) : ranged(req, bytes)) : new Response(null, { status: 404 });
	} });
	return { requests, origin: `${tls ? "https" : "http"}://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
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

const OLD = "0.1.6-b1.1.gcafebabe";
function existingInstall() {
	const i = newInstall();
	addRuntime(i.data, OLD);
	const state = join(i.data, "state");
	// Create selection through fixture only; select command belongs to section 6.
	mkdirSync(state);
	writeFileSync(join(state, "selection.json"), JSON.stringify({ schema: 1, use: OLD, snapshot: null, addons: {} }));
	writeFileSync(join(state, "channel"), "release\n");
	return i;
}
const original = (i: Install) => readFileSync(join(i.data, "bundles", OLD, `dsh-native${EXE}`));
const selection = (i: Install) => readFileSync(join(i.data, "state/selection.json"), "utf8");

test.skipIf(!hasZig).each(["bad hash", "interrupted"])("DL-CORRUPT / FB-RETRY: %s download never installs; rerun verifies and completes", async (fault) => {
	const i = existingInstall(), a = archive(), e = entry(ID, a.bytes);
	const previous = original(i), pin = selection(i);
	if (fault === "bad hash") e.assets[TARGET].sha256 = "a".repeat(64);
	let broken = true;
	const s = source([e], new Map([[assetPath(e), a.bytes]]), (req, bytes) => {
		if (!broken) return ranged(req, bytes);
		if (fault === "bad hash") return new Response(bytes); // Valid ZIP but not the digest promised by index.
		const start = Number(/^bytes=(\d+)-$/.exec(req.headers.get("range") ?? "")?.[1] ?? 0);
		return new Response(new ReadableStream({ start(c) {
			c.enqueue(bytes.subarray(start, start + 37));
			setTimeout(() => { try { c.error(null); } catch {} }, 20);
		} }), { status: start ? 206 : 200, headers: start ? { "content-range": `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {} });
	});
	try {
		const failed = await install(i, s.origin);
		expect(failed.status).toBe(1);
		expect(failed.stderr).toContain(fault === "bad hash" ? "HashMismatch" : "Network");
		expect(installed(i)).toBe(false);
		expect(existsSync(join(i.data, "snapshots", `${ID}@1`))).toBe(false);
		expect(original(i).equals(previous)).toBe(true);
		expect(selection(i)).toBe(pin);
		expect(started(i)).toBe(false);
		if (fault === "interrupted") {
			const partials = readdirSync(join(i.data, "cache/downloads")).filter((n) => n.endsWith(".part"));
			expect(partials.length).toBe(1);
			expect(statSync(join(i.data, "cache/downloads", partials[0]!)).size).toBeGreaterThan(0);
		}
		const requestsBefore = s.requests.length;
		broken = false;
		e.assets[TARGET].sha256 = sha(a.bytes);
		expect((await install(i, s.origin)).status).toBe(0);
		expect(installed(i)).toBe(true);
		expect(selection(i)).toBe(pin);
		if (fault === "interrupted") expect(s.requests.slice(requestsBefore).some((r) => r.range !== null)).toBe(true);
	} finally { await s.stop(); }
	expect(run(i, ["--version"]).status).toBe(0); // top-level is still read-only manager version
	expect(run(i, ["--use", OLD, "probe"]).status).toBe(0);
});

function renameMember(bytes: Buffer, from: string, to: string) {
	const old = Buffer.from(from), replacement = Buffer.from(to);
	expect(replacement.length).toBe(old.length);
	const copy = Buffer.from(bytes);
	let at = 0, count = 0;
	while ((at = copy.indexOf(old, at)) !== -1) { replacement.copy(copy, at); at += old.length; count++; }
	expect(count).toBe(2); // local and central header, payload unchanged
	return copy;
}

test.skipIf(!hasZig).each(["absolute", "traversal", "link"])("DL-ESCAPE: %s archive cannot write outside staging or damage usable version", async (fault) => {
	const i = existingInstall(), sentinel = join(i.dir, "escape");
	writeFileSync(sentinel, "external file stays");
	const previous = original(i), pin = selection(i);
	const badName = fault === "absolute" ? sentinel.replaceAll("\\", "/") : "../../../escape";
	const placeholder = "x".repeat(Buffer.byteLength(badName));
	let bytes = archive(ID, {}, [{ name: placeholder, data: Buffer.from(fault === "link" ? sentinel : "overwrite"), mode: 0o644 }]).bytes;
	if (fault === "link") {
		bytes = Buffer.from(bytes);
		for (let at = 0; at < bytes.length - 46; at++) if (bytes.readUInt32LE(at) === 0x02014b50 && bytes.toString("utf8", at + 46, at + 46 + bytes.readUInt16LE(at + 28)) === placeholder) bytes.writeUInt32LE((0o120777 << 16) >>> 0, at + 38);
	} else bytes = renameMember(bytes, placeholder, badName);
	const e = entry(ID, bytes), s = source([e], new Map([[assetPath(e), bytes]]));
	try {
		const result = await install(i, s.origin);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(fault === "link" ? "UnsupportedEntry" : "UnsafeEntryName");
		expect(installed(i)).toBe(false);
		expect(readFileSync(sentinel, "utf8")).toBe("external file stays");
		expect(original(i).equals(previous)).toBe(true);
		expect(selection(i)).toBe(pin);
		expect(readdirSync(join(i.data, "tmp")).filter((n) => n.startsWith(".install-"))).toEqual([]);
	} finally { await s.stop(); }
});

test.skipIf(!hasZig).each([
	["legacy", { schemaVersion: 2, launcherProtocol: 2 }, "LegacyBundle"],
	["wrong id", { id: "foreign" }, "BundleMismatch"],
	["wrong target", { target: "foreign" }, "BundleMismatch"],
	["protocol", { launchProtocol: 2 }, "BundleMismatch"],
	["wrong entry", { entry: "bundle.json" }, "BundleMismatch"],
	["upstream mismatch", { upstream: { commit: "e".repeat(40), commitTime: "2026-09-01T00:00:00.000Z", version: "0.1.7" } }, "BundleMismatch"],
	["builder mismatch", { builderCommit: "e".repeat(40) }, "BundleMismatch"],
	["missing required path", { requiredPaths: ["app/missing.js"] }, "MissingRequiredPath"],
	["required traversal", { requiredPaths: ["../escape"] }, "UnsafeRequiredPath"],
])("DL-CORRUPT / RB-LEGACY: %s bundle rejected before activation", async (_name, patch, error) => {
	const i = existingInstall(), a = archive(ID, patch), e = entry(ID, a.bytes), pin = selection(i), previous = original(i);
	const s = source([e], new Map([[assetPath(e), a.bytes]]));
	try {
		const result = await install(i, s.origin);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(error);
		expect(installed(i)).toBe(false);
		expect(original(i).equals(previous)).toBe(true);
		expect(selection(i)).toBe(pin);
		expect(started(i)).toBe(false);
	} finally { await s.stop(); }
});

test.skipIf(!hasZig).each(["before-activation", "after-activation"])("DL-CORRUPT / FB-RETRY: crash %s leaves previous runtime usable and rerun completes", async (point) => {
	const i = existingInstall(), a = archive(), e = entry(ID, a.bytes), pin = selection(i), previous = original(i);
	const s = source([e], new Map([[assetPath(e), a.bytes]]));
	try {
		const result = await install(i, s.origin, [ID], { DSH_MANAGER_TEST_CRASH: point });
		expect(result.status).toBe(86);
		expect(result.stderr).toContain(`test crash at ${point}`);
		expect(installed(i)).toBe(point === "after-activation");
		expect(original(i).equals(previous)).toBe(true);
		expect(selection(i)).toBe(pin);
		expect(run(i, ["--use", OLD, "probe"]).status).toBe(0);
		if (point === "after-activation") expect(run(i, ["--use", ID, "probe"]).status).toBe(0);
		expect((await install(i, s.origin)).status).toBe(0);
		expect(installed(i)).toBe(true);
		expect(selection(i)).toBe(pin);
	} finally { await s.stop(); }
});

test.skipIf(!hasZig)("MC-BROKEN: force reinstall repairs missing entry without executing it or resetting snapshot/home/selection", async () => {
	const i = newInstall(), a = archive(), e = entry(ID, a.bytes), s = source([e], new Map([[assetPath(e), a.bytes]]));
	try {
		expect((await install(i, s.origin)).status).toBe(0);
		const state = join(i.data, "state/selection.json");
		writeFileSync(state, JSON.stringify({ schema: 1, use: ID, snapshot: `${ID}@1`, addons: {} }));
		const pin = readFileSync(state, "utf8"), snapshot = join(i.data, "snapshots", `${ID}@1`);
		writeFileSync(join(snapshot, "plugin-state"), "keep plugin");
		writeFileSync(join(i.data, "home-secret"), "keep credentials");
		const metadata = readFileSync(join(snapshot, "snapshot.json"), "utf8");
		rmSync(join(i.data, "bundles", ID, `dsh-native${EXE}`));
		expect(run(i, ["--use", ID, "probe"]).status).toBe(1);
		expect((await install(i, s.origin)).stderr).toContain("IncompleteRuntimeUseForce");
		expect((await install(i, s.origin, [e.tag, "--force"])).status).toBe(0);
		expect(started(i)).toBe(false);
		expect(readFileSync(state, "utf8")).toBe(pin);
		expect(readFileSync(join(snapshot, "snapshot.json"), "utf8")).toBe(metadata);
		expect(readFileSync(join(snapshot, "plugin-state"), "utf8")).toBe("keep plugin");
		expect(readFileSync(join(i.data, "home-secret"), "utf8")).toBe("keep credentials");
		expect(run(i, ["probe"]).status).toBe(0);
	} finally { await s.stop(); }
});

test.skipIf(!hasZig)("MC-EMPTY: exact tags/unique prefixes reused; ambiguous prefix never downloads", async () => {
	const other = "0.1.7-b2.1.gdeadbeef", i = newInstall(), a = archive(), b = archive(other, { run: 2 });
	const e = entry(ID, a.bytes, { seq: 2 }), f = entry(other, b.bytes, { run: 2, seq: 1 });
	const s = source([e, f], new Map([[assetPath(e), a.bytes], [assetPath(f), b.bytes]]));
	try {
		const ambiguous = await install(i, s.origin, ["0.1.7"]);
		expect(ambiguous.status).toBe(1);
		expect(ambiguous.stderr).toContain("ambiguous");
		expect(s.requests.map((r) => r.path)).toEqual(["/runtime-index.json"]);
		const newest = newInstall();
		expect((await install(newest, s.origin, ["latest"])).status).toBe(0);
		expect(installed(newest, other)).toBe(true); // Build order, not manager version or index array order.
		expect(installed(newest, ID)).toBe(false);
		expect((await install(i, s.origin, ["0.1.7-b1"])).status).toBe(0);
		expect((await install(i, s.origin, [f.tag])).status).toBe(0);
		expect(run(i, ["manager", "list"]).stdout).toContain(other);
		const before = s.requests.length;
		expect(run(i, ["manager", "list", "--available"]).status).toBe(1);
		expect(s.requests.length).toBe(before);
	} finally { await s.stop(); }
});

test.skipIf(!hasZig)("MC-EMPTY: maintenance and usage locks block install/replacement without starting runtime", async () => {
	const i = existingInstall(), a = archive(), e = entry(ID, a.bytes), s = source([e], new Map([[assetPath(e), a.bytes]]));
	writeFileSync(join(i.data, "state/manager.lock"), "");
	const guard = acquireClaim(join(i.data, "state/manager.lock"), "exclusive");
	if (guard === "busy") throw new Error("fixture could not acquire lock");
	try {
		const blocked = await install(i, s.origin);
		expect(blocked.status).toBe(1);
		expect(blocked.stderr).toContain("maintenance lock");
		expect(s.requests).toEqual([]);
	} finally { guard.release(); }
	try {
		expect((await install(i, s.origin)).status).toBe(0);
		const usage = acquireClaim(join(i.data, "bundles", ID, ".usage.lock"), "shared");
		if (usage === "busy") throw new Error("fixture could not claim runtime");
		try {
			const before = readFileSync(join(i.data, "bundles", ID, `dsh-native${EXE}`));
			const blocked = await install(i, s.origin, [ID, "--force"]);
			expect(blocked.status).toBe(1);
			expect(blocked.stderr).toContain("RuntimeInUse");
			expect(readFileSync(join(i.data, "bundles", ID, `dsh-native${EXE}`)).equals(before)).toBe(true);
			expect(started(i)).toBe(false);
		} finally { usage.release(); }
	} finally { await s.stop(); }
});

test.skipIf(!hasZig).each(["before-activation", "after-activation"])("DL-CORRUPT: same-id force crash %s leaves complete runtime and existing snapshot usable", async (point) => {
	const i = newInstall(), a = archive(), e = entry(ID, a.bytes), s = source([e], new Map([[assetPath(e), a.bytes]]));
	try {
		expect((await install(i, s.origin)).status).toBe(0);
		const snapshot = join(i.data, "snapshots", `${ID}@1`, "plugin-state");
		writeFileSync(snapshot, "keep this");
		const result = await install(i, s.origin, [ID, "--force"], { DSH_MANAGER_TEST_CRASH: point });
		expect(result.status).toBe(86);
		expect(run(i, ["--use", ID, "probe"]).status).toBe(0);
		expect(readFileSync(snapshot, "utf8")).toBe("keep this");
		expect((await install(i, s.origin, [ID, "--force"])).status).toBe(0);
	} finally { await s.stop(); }
});

test.skipIf(!hasZig)("DL-CORRUPT: failed force candidate keeps current entry, install metadata and snapshot unchanged", async () => {
	const i = newInstall(), a = archive(), good = entry(ID, a.bytes);
	const bad = archive(ID, { requiredPaths: ["missing"] }), e = entry(ID, bad.bytes);
	let bytes = a.bytes;
	let current = good;
	const requests: string[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
		const path = new URL(req.url).pathname;
		requests.push(path);
		if (path === "/runtime-index.json") return Response.json({ schema: 1, channels: { release: [current], live: [] }, addons: { office: [] } });
		return new Response(bytes);
	} });
	try {
		const origin = `http://127.0.0.1:${server.port}`;
		expect((await install(i, origin)).status).toBe(0);
		const installedDir = join(i.data, "bundles", ID);
		const entryBefore = readFileSync(join(installedDir, `dsh-native${EXE}`));
		const metaBefore = readFileSync(join(installedDir, ".dsh-install.json"));
		bytes = bad.bytes; current = e;
		const failed = await install(i, origin, [ID, "--force"]);
		expect(failed.status).toBe(1);
		expect(failed.stderr).toContain("MissingRequiredPath");
		expect(readFileSync(join(installedDir, `dsh-native${EXE}`)).equals(entryBefore)).toBe(true);
		expect(readFileSync(join(installedDir, ".dsh-install.json")).equals(metaBefore)).toBe(true);
		expect(run(i, ["--use", ID, "probe"]).status).toBe(0);
	} finally { await server.stop(true); }
});

test.skipIf(!hasZig).each(["missing entry", "old outer tree"])("DL-CORRUPT / RB-LEGACY: %s archive is never activated", async (fault) => {
	const i = existingInstall();
	const a = archive(ID, {}, fault === "old outer tree" ? [{ name: "bundles/old/entry", data: Buffer.from("do not execute"), mode: 0o755 }] : []);
	const bytes = fault === "missing entry" ? renameMember(a.bytes, `dsh-native${EXE}`, `not-native${EXE}`) : a.bytes;
	const e = entry(ID, bytes), s = source([e], new Map([[assetPath(e), bytes]]));
	try {
		const result = await install(i, s.origin);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(fault === "missing entry" ? "MissingEntry" : "LegacyBundle");
		expect(installed(i)).toBe(false);
		expect(started(i)).toBe(false);
	} finally { await s.stop(); }
});

test.skipIf(!hasZig)("DL-CORRUPT / FB-RETRY: manager-only install verifies HTTPS index/archive through authenticated CONNECT then starts offline", async () => {
	const i = newInstall(), a = archive(), e = entry(ID, a.bytes);
	const s = source([e], new Map([[assetPath(e), a.bytes]]), undefined, true);
	const proxy = await connectProxy();
	try {
		const result = await install(i, s.origin, [ID], { HTTPS_PROXY: proxy.url.replace("://", "://private:secret@"), DSH_MANAGER_TEST_CA_FILE: TEST_CA_FILE });
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(installed(i)).toBe(true);
		expect(started(i)).toBe(false);
		expect(s.requests.map((r) => r.path)).toEqual(["/runtime-index.json", assetPath(e)]);
		expect(proxy.requests.map((r) => r.line)).toEqual(Array(2).fill(`CONNECT ${new URL(s.origin).host} HTTP/1.1`));
		expect(proxy.requests.every((r) => r.authorization === `Basic ${Buffer.from("private:secret").toString("base64")}` && r.firstBytes[0] === 0x16 && r.firstBytes[1] === 0x03)).toBe(true);
		expect(readFileSync(join(i.data, "bundles", ID, `dsh-native${EXE}`)).equals(readFileSync(build().fake))).toBe(true);
		expect(existsSync(join(i.data, "snapshots", `${ID}@1`, "snapshot.json"))).toBe(true);
		expect(tree(i.home)).toEqual([]);
	} finally { s.stop(); await proxy.stop(); }
	expect(run(i, ["--use", ID, "probe"]).status).toBe(0);
	expect(launchOf(i).runtime).toBe(ID);
});

test.skipIf(!hasZig)("DL-CORRUPT: https:// proxy transport stays fail-closed at install discovery", async () => {
	const i = newInstall();
	const proxy = await connectProxy();
	try {
		const result = await install(i, "https://fixture.invalid", [ID], { HTTPS_PROXY: proxy.url.replace("http:", "https:").replace("://", "://private:secret@") });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("UnsupportedProxy");
		expect(result.stderr).toContain("https:// proxy");
		expect(result.stderr).not.toContain("private");
		expect(result.stderr).not.toContain("secret");
		expect(proxy.requests).toEqual([]);
		expect(installed(i)).toBe(false);
	} finally { await proxy.stop(); }
});

test.skipIf(!hasZig || process.platform !== "linux")(`FB-EMPTY: static musl-ABI manager detects actual host libc without installed bundle${process.platform === "linux" ? "" : " — SKIP: executing Linux ELF requires Linux host"}`, async () => {
	const prefix = tempDir("dsh-musl-manager-");
	execFileSync("zig", ["build", `-Dtarget=${process.arch === "arm64" ? "aarch64" : "x86_64"}-linux-musl`, "--prefix", prefix], { cwd: MANAGER_DIR, stdio: "inherit", timeout: 300_000 });
	// This runtime target is from the executing userspace, not the manager's musl compile target.
	const i = newInstall(join(prefix, "bin/dsh")), a = archive(), e = entry(ID, a.bytes), s = source([e], new Map([[assetPath(e), a.bytes]]));
	try {
		const result = await install(i, s.origin);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain(`(${TARGET})`);
		expect(installed(i)).toBe(true);
	} finally { await s.stop(); }
}, 360_000);

test.skipIf(!hasZig)("DL-CORRUPT: --force refuses an unrecognized same-id directory instead of deleting user files", async () => {
	const i = existingInstall(), a = archive(), e = entry(ID, a.bytes), s = source([e], new Map([[assetPath(e), a.bytes]]));
	const foreign = join(i.data, "bundles", ID);
	mkdirSync(foreign);
	writeFileSync(join(foreign, "user-file"), "not a runtime");
	try {
		const result = await install(i, s.origin, [ID, "--force"]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("RuntimeDirectoryConflict");
		expect(readFileSync(join(foreign, "user-file"), "utf8")).toBe("not a runtime");
		expect(s.requests.map((r) => r.path)).toEqual(["/runtime-index.json"]);
	} finally { await s.stop(); }
});

// 5.2: ordinary empty launches reuse the native install, never manager/GitHub Latest.
async function bootstrap(i: Install, origin: string, args: string[] = [], extra: Record<string, string> = {}, input: string | Uint8Array = "") {
	for (const g of ["1", "2"]) rmSync(join(i.out, `${g}.argv`), { force: true });
	const proc = Bun.spawn([i.exe, ...args], { cwd: i.home, env: { ...baseEnv(i), DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_ORIGIN: origin, DSH_MANAGER_TEST_RETRY_MS: "20", ...extra }, stdin: new Response(input), stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => proc.kill("SIGKILL"), 30_000);
	try {
		const [stdout, stderr, status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return { stdout, stderr, status };
	} finally { clearTimeout(timer); if (proc.exitCode === null) { proc.kill("SIGKILL"); await proc.exited; } }
}

test.skipIf(!hasZig)("FB-EMPTY: ordinary empty launch installs latest compatible release and preserves argv/cwd/stdin/exit", async () => {
	const old = archive(OLD), latest = archive(ID, { run: 2 }), live = archive(LIVE);
	const e = entry(ID, latest.bytes, { run: 2 }), o = entry(OLD, old.bytes), l = entry(LIVE, live.bytes);
	const incompatible = entry("9.0-b9.1.gdeadbeef", latest.bytes, { launchProtocol: 99 });
	const other = entry("8.0-b8.1.gdeadbeef", latest.bytes, { assets: { "wrong-target": e.assets[TARGET] } });
	const manager = { ...e, kind: "dsh-manager", id: "99.0.0", tag: "manager-v99.0.0" };
	const s = source([o, e, incompatible, other, manager, l], new Map([[assetPath(e), latest.bytes], [assetPath(o), old.bytes], [assetPath(l), live.bytes]]));
	try {
		for (const args of [["--profile", "headless", "-p", "hello world"], []]) {
			const i = newInstall(); const before = s.requests.length;
			const result = await bootstrap(i, s.origin, args, { FAKE_STDIN: "1", FAKE_EXIT: "37" }, "application stdin\n");
			expect(result.status).toBe(37); expect(result.stdout).toBe("");
			expect(result.stderr).not.toMatch(/\? |\[Y\/n|download\?/i);
			expect(argvOf(i)).toEqual(args); expect(readFileSync(join(i.out, "1.cwd"), "utf8")).toBe(i.home);
			expect(readFileSync(join(i.out, "1.stdin"), "utf8")).toBe("application stdin\n");
			expect(launchOf(i).runtime).toBe(ID); expect(installed(i)).toBe(true); expect(installed(i, OLD)).toBe(false);
			expect(s.requests.slice(before).map((r) => r.path)).toEqual(["/runtime-index.json", assetPath(e)]);
			expect(existsSync(join(i.data, "state/completion.json"))).toBe(false);
		}
	} finally { await s.stop(); }
}, 120_000);

test.skipIf(!hasZig)("FB-EMPTY: automatic download failure activates nothing and never starts app", async () => {
	const i = newInstall(), a = archive(), e = entry(ID, a.bytes); e.assets[TARGET].sha256 = "a".repeat(64);
	const s = source([e], new Map([[assetPath(e), a.bytes]]));
	try {
		const result = await bootstrap(i, s.origin);
		expect(result.status).toBe(1); expect(result.stderr).toContain("HashMismatch"); expect(result.stdout).toBe("");
		expect(installed(i)).toBe(false); expect(started(i)).toBe(false); expect(existsSync(join(i.data, "snapshots", `${ID}@1`))).toBe(false);
	} finally { await s.stop(); }
});

test.skipIf(!hasZig)("FB-MISSING: explicit/pinned missing versions and damaged runtimes never auto-install", async () => {
	const a = archive(), e = entry(ID, a.bytes), s = source([e], new Map([[assetPath(e), a.bytes]]));
	try {
		for (const fixture of ["explicit", "snapshot", "pinned", "broken", "legacy", "protocol"] as const) {
			const i = newInstall(); let args: string[] = [];
			if (fixture === "explicit") args = ["--use", ID];
			if (fixture === "snapshot") args = ["--snapshot", `${ID}@1`];
			if (fixture === "pinned") { mkdirSync(join(i.data, "state"), { recursive: true }); writeFileSync(join(i.data, ".dsh-bin-data.json"), JSON.stringify({ kind: "dsh-manager-data", schema: 1 })); writeFileSync(join(i.data, "state/selection.json"), JSON.stringify({ schema: 1, use: ID })); }
			if (fixture === "broken") addRuntime(i.data, ID, { entry: false });
			if (fixture === "legacy") addRuntime(i.data, ID, { raw: '{"schemaVersion":2,"launcherProtocol":2}' });
			if (fixture === "protocol") addRuntime(i.data, ID, { patch: { launchProtocol: 99 } });
			const result = await bootstrap(i, s.origin, args);
			expect(result.status).toBe(1); expect(result.stdout).toBe(""); expect(started(i)).toBe(false);
			expect(result.stderr).toContain(fixture === "broken" || fixture === "legacy" ? "--force" : fixture === "protocol" ? "self-update" : `install ${ID}`);
		}
		expect(s.requests).toEqual([]);
	} finally { await s.stop(); }
});

test.skipIf(!hasZig)("FB-EMPTY: simultaneous empty launches activate one runtime under the existing install lock", async () => {
	const i = newInstall(), a = archive(), e = entry(ID, a.bytes), s = source([e], new Map([[assetPath(e), a.bytes]]));
	// Ownership initialization races belong to 5.4; here exercise the install/activation mutex.
	mkdirSync(i.data); writeFileSync(join(i.data, ".dsh-bin-data.json"), JSON.stringify({ kind: "dsh-manager-data", schema: 1 }));
	try {
		const results = await Promise.all([bootstrap(i, s.origin), bootstrap(i, s.origin)]);
		if (results.some((r) => r.status !== 0)) console.error(results);
		expect(results.map((r) => r.status)).toEqual([0, 0]);
		expect(s.requests.map((r) => r.path)).toEqual(["/runtime-index.json", assetPath(e)]);
		expect(readdirSync(join(i.data, "bundles"))).toEqual([ID]);
	} finally { await s.stop(); }
});

test.skipIf(!hasZig)("FB-EMPTY: recorded live channel and latest selection survive automatic restore", async () => {
	const i = newInstall(), a = archive(), live = archive(LIVE), e = entry(ID, a.bytes), l = entry(LIVE, live.bytes);
	const s = source([e, l], new Map([[assetPath(e), a.bytes], [assetPath(l), live.bytes]]));
	mkdirSync(join(i.data, "state"), { recursive: true });
	writeFileSync(join(i.data, ".dsh-bin-data.json"), JSON.stringify({ kind: "dsh-manager-data", schema: 1 }));
	writeFileSync(join(i.data, "state/channel"), "live\n");
	const pin = '{"schema":1,"use":"latest"}'; writeFileSync(join(i.data, "state/selection.json"), pin);
	try {
		expect((await bootstrap(i, s.origin)).status).toBe(0); expect(launchOf(i).runtime).toBe(LIVE);
		expect(readFileSync(join(i.data, "state/channel"), "utf8")).toBe("live\n"); expect(selection(i)).toBe(pin);
		expect(s.requests.map((r) => r.path)).toEqual(["/runtime-index.json", assetPath(l)]);
	} finally { await s.stop(); }
});

const ptyReason = process.platform === "win32" ? "real Windows console/ConPTY harness not available" : !Bun.which("python3") || !Bun.which("bash") ? "real Python PTY/Bash unavailable" : !hasZig ? "Zig unavailable" : "";
test.skipIf(!!ptyReason)(`FB-EMPTY / FB-ORDER: PTY downloads only after completion consent then launches original argv${ptyReason ? ` — SKIP: ${ptyReason}` : ""}`, async () => {
	const i = newInstall(), a = archive(), e = entry(ID, a.bytes), s = source([e], new Map([[assetPath(e), a.bytes]]));
	const python = Bun.which("python3")!, bash = Bun.which("bash")!;
	const proc = spawn(python, [join(import.meta.dir, "terminal-driver.py"), bash, "--noprofile", "--norc", "-c", '"$@"; code=$?; exit "$code"', "pty-bash", i.exe, "--profile", "headless", "-p", "hello world"], { env: { ...baseEnv(i), SHELL: bash, DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_ORIGIN: s.origin, FAKE_EXIT: "23" }, cwd: i.home, stdio: "pipe" });
	let output = ""; proc.stdout.on("data", (b) => { output += b.toString(); }); proc.stderr.on("data", (b) => { output += b.toString(); });
	const done = new Promise<number | null>((resolve, reject) => { proc.on("exit", resolve); proc.on("error", reject); });
	const timer = setTimeout(() => proc.kill("SIGTERM"), 15_000);
	try {
		for (let n = 0; n < 300 && !output.includes("[Y/n/o]") && proc.exitCode === null; n++) await Bun.sleep(20);
		expect(output).toContain("Register bash completion at "); expect(s.requests).toEqual([]); expect(started(i)).toBe(false);
		proc.stdin.write("n\n"); expect(await done).toBe(23);
		expect(s.requests.map((r) => r.path)).toEqual(["/runtime-index.json", assetPath(e)]);
		expect(argvOf(i)).toEqual(["--profile", "headless", "-p", "hello world"]);
		expect(output).not.toMatch(/download\?|install\?/i); expect(launchOf(i).runtime).toBe(ID);
	} finally { clearTimeout(timer); if (proc.exitCode === null) { proc.kill("SIGTERM"); await done; } await s.stop(); }
}, 120_000);

// 5.3/5.4: prove missing external seams; reuse the install fixtures above.
test.skipIf(!hasZig)("FB-PIPE: empty noninteractive launch preserves 1 MiB binary stdin and leaves consent unset", async () => {
	const i = newInstall(), a = archive(), e = entry(ID, a.bytes), s = source([e], new Map([[assetPath(e), a.bytes]]));
	const payload = Uint8Array.from({ length: 1 << 20 }, (_, n) => n % 256);
	try {
		const result = await bootstrap(i, s.origin, [], { FAKE_STDIN_HASH: "1" }, payload);
		expect(result.status).toBe(0); expect(result.stderr).not.toMatch(/\[Y\/n\/o\]|Choose completion/);
		expect(readFileSync(join(i.out, "1.stdin-sha256"), "utf8")).toBe(sha(payload));
		expect(existsSync(join(i.data, "state/completion.json"))).toBe(false);
	} finally { await s.stop(); }
});

test.skipIf(!hasZig)("FB-READONLY: cold helper queries use no network, create nothing, and consume no stdin", async () => {
	const i = newInstall(), s = source([], new Map());
	const queries = [["manager", "--version"], ["manager", "--help"], ["manager", "info"], ["manager", "list"], ["--help"], ["--version"], ["-h"], ["-V"], ["manager", "__complete", "--shell", "bash", "--", "manager", ""], ["manager", "completion", "script", "bash"]];
	try {
		for (const args of queries) {
			// Child inherits our open descriptor; after it exits, the shared file offset must
			// still be at the first byte, proving the query consumed none of its input.
			const input = join(i.out, "query-input"); writeFileSync(input, "unread\x00sentinel");
			const fd = openSync(input, "r");
			const p = spawn(i.exe, args, { cwd: i.home, env: { ...baseEnv(i), DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_ORIGIN: s.origin }, stdio: [fd, "pipe", "pipe"] });
			let stdout = "", stderr = ""; p.stdout!.on("data", b => stdout += b); p.stderr!.on("data", b => stderr += b);
			const timer = setTimeout(() => p.kill("SIGKILL"), 5000);
			try {
				expect(await new Promise((resolve, reject) => { p.on("exit", resolve); p.on("error", reject); })).toBe(0);
				const remaining = Buffer.alloc(32); const n = readSync(fd, remaining, 0, remaining.length, null);
				expect(remaining.subarray(0, n).toString()).toBe("unread\x00sentinel");
				expect(stderr).not.toMatch(/completion|installing/i);
				if (["--help", "--version", "-h", "-V"].includes(args[0]!) || args[1] === "list") expect(stdout).toContain("No dsh runtime is installed");
			} finally { clearTimeout(timer); closeSync(fd); if (p.exitCode === null) p.kill("SIGKILL"); }
			expect(existsSync(i.data)).toBe(false); expect(tree(i.home)).toEqual([]); expect(started(i)).toBe(false);
		}
		expect(s.requests).toEqual([]);
	} finally { await s.stop(); }
});

test.skipIf(!hasZig)("FB-OFFLINE: installed pinned runtime starts without any index or asset request", async () => {
	const i = existingInstall(), pin = selection(i), s = source([], new Map());
	try {
		expect((await bootstrap(i, s.origin)).status).toBe(0); expect(launchOf(i).runtime).toBe(OLD);
		expect(s.requests).toEqual([]); expect(selection(i)).toBe(pin);
		await s.stop();
		expect((await bootstrap(i, s.origin)).status).toBe(0); expect(selection(i)).toBe(pin);
	} finally { await s.stop(); }
});

test.skipIf(!hasZig)("FB-CONCURRENT: fresh-root first launches succeed or fail with named initialization/snapshot retry; rerun succeeds", async () => {
	const a = archive(), e = entry(ID, a.bytes), s = source([e], new Map([[assetPath(e), a.bytes]]));
	try {
		for (let n = 0; n < 24; n++) {
			const i = newInstall(), before = s.requests.length;
			const results = await Promise.all([bootstrap(i, s.origin), bootstrap(i, s.origin)]);
			expect(results.filter(r => r.status === 0).length).toBeGreaterThanOrEqual(1);
			for (const r of results.filter(r => r.status !== 0)) expect(r.stderr).toMatch(/initialization was interrupted|cannot prepare snapshot for [^\r\n]+: Busy;[^\r\n]+retry/);
			expect(JSON.parse(readFileSync(join(i.data, ".dsh-bin-data.json"), "utf8"))).toEqual({ kind: "dsh-manager-data", schema: 1 });
			expect(readdirSync(join(i.data, "bundles"))).toEqual([ID]);
			expect(s.requests.slice(before).map(r => r.path)).toEqual(["/runtime-index.json", assetPath(e)]);
			expect((await bootstrap(i, s.origin)).status).toBe(0);
			expect(launchOf(i).runtime).toBe(ID); expect(existsSync(join(i.data, "state/selection.json"))).toBe(false);
		}
	} finally { await s.stop(); }
}, 120_000);

test.skipIf(!hasZig)("FB-RETRY: interrupted automatic download resumes verified archive without resetting selection", async () => {
	const i = newInstall(), a = archive(), e = entry(ID, a.bytes); let broken = true;
	mkdirSync(join(i.data, "state"), { recursive: true });
	writeFileSync(join(i.data, ".dsh-bin-data.json"), JSON.stringify({ kind: "dsh-manager-data", schema: 1 }));
	const pin = '{"schema":1,"use":"latest","snapshot":null,"addons":{}}';
	writeFileSync(join(i.data, "state/selection.json"), pin);
	const s = source([e], new Map([[assetPath(e), a.bytes]]), (req, bytes) => {
		if (!broken) return ranged(req, bytes);
		const start = Number(/^bytes=(\d+)-$/.exec(req.headers.get("range") ?? "")?.[1] ?? 0);
		return new Response(new ReadableStream({ start(c) { c.enqueue(bytes.subarray(start, start + 37)); setTimeout(() => { try { c.error(null); } catch {} }, 20); } }), { status: start ? 206 : 200, headers: start ? { "content-range": `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {} });
	});
	try {
		const failed = await bootstrap(i, s.origin);
		expect(failed.status).toBe(1); expect(failed.stderr).toContain("Network"); expect(failed.stdout).toBe("");
		expect(installed(i)).toBe(false); expect(started(i)).toBe(false); expect(selection(i)).toBe(pin);
		expect(existsSync(join(i.data, "snapshots", `${ID}@1`))).toBe(false);
		const before = s.requests.length; broken = false;
		expect((await bootstrap(i, s.origin)).status).toBe(0); expect(launchOf(i).runtime).toBe(ID);
		expect(s.requests.slice(before).some(r => r.range !== null)).toBe(true); expect(selection(i)).toBe(pin);
	} finally { await s.stop(); }
});

test.skipIf(!hasZig)("FB-MISSING review: damaged runtime storage never bootstraps or starts app", async () => {
	const a = archive(), e = entry(ID, a.bytes), s = source([e], new Map([[assetPath(e), a.bytes]]));
	try {
		for (const fault of ["file-entry", "dangling-link", "bundles-file", "hidden-entry"] as const) {
			if (fault === "dangling-link" && process.platform === "win32") continue; // Windows link privilege not assumed.
			const i = newInstall(); mkdirSync(i.data);
			writeFileSync(join(i.data, ".dsh-bin-data.json"), JSON.stringify({ kind: "dsh-manager-data", schema: 1 }));
			const bundles = join(i.data, "bundles");
			if (fault === "bundles-file") writeFileSync(bundles, "damaged storage");
			else {
				mkdirSync(bundles);
				if (fault === "dangling-link") { const { symlinkSync } = await import("node:fs"); symlinkSync(join(i.out, "missing"), join(bundles, ID)); }
				else writeFileSync(join(bundles, fault === "hidden-entry" ? ".unknown" : ID), "not a runtime");
			}
			const before = tree(i.data), result = await bootstrap(i, s.origin);
			expect(result.status).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toContain(bundles);
			expect(result.stderr).toMatch(/manager install .*--force|manager clean/);
			expect(started(i)).toBe(false); expect(tree(i.data)).toEqual(before);
		}
		expect(s.requests).toEqual([]);
	} finally { await s.stop(); }
});

test.skipIf(!hasZig)("DL-CORRUPT review: force runtime install retains destination and staging handles across ancestor swaps", async () => {
	const i = newInstall(), a = archive(), e = entry(ID, a.bytes), bundles = join(i.data, "bundles"), tmp = join(i.data, "tmp");
	const external = join(i.home, "external"), externalTmp = join(i.home, "external-tmp"), sentinel = join(external, ID, "unrelated-user-file");
	let armed = false, swapped = false;
	const s = source([e], new Map([[assetPath(e), a.bytes]]), (req, bytes) => {
		if (armed && !swapped) {
			renameSync(bundles, `${bundles}-original`); symlinkSync(external, bundles, WIN ? "junction" : "dir");
			renameSync(tmp, `${tmp}-original`); symlinkSync(externalTmp, tmp, WIN ? "junction" : "dir"); swapped = true;
		}
		return ranged(req, bytes);
	});
	try {
		expect((await install(i, s.origin)).status).toBe(0);
		const snapshot = join(i.data, "snapshots", `${ID}@1`, "profiles/keep"); writeFileSync(snapshot, "plugin stays");
		mkdirSync(join(external, ID), { recursive: true }); writeFileSync(sentinel, "KEEP");
		mkdirSync(externalTmp); writeFileSync(join(externalTmp, "keep"), "KEEP TMP");
		rmSync(join(i.data, "cache/downloads"), { recursive: true }); armed = true;
		const r = await install(i, s.origin, [ID, "--force"]);
		expect(swapped).toBe(true); expect(existsSync(sentinel)).toBe(true); expect(readFileSync(sentinel, "utf8")).toBe("KEEP");
		expect(tree(external)).toEqual([ID, `${ID}/unrelated-user-file`]); expect(tree(externalTmp)).toEqual(["keep"]);
		expect(r.status).toBe(0); expect(existsSync(join(`${bundles}-original`, ID, "bundle.json"))).toBe(true);
		expect(tree(`${tmp}-original`).filter(p => p.startsWith(".install-") || p.startsWith(".previous-"))).toEqual([]);
		expect(readFileSync(snapshot, "utf8")).toBe("plugin stays"); expect(started(i)).toBe(false);
	} finally { s.stop(); }
}, 30_000);
