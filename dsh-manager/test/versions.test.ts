// Native runtime management: real processes, recording origin, isolated data and no JS on child PATH.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeZip } from "../../dsh-bun-build/runtime/zip.ts";
import { hostTargetId } from "../../dsh-bun-build/scripts/targets.mjs";
import { baseEnv, build, bundleMeta, cleanup, EXE, hasZig, launchOf, newInstall, run, started, tempDir, tree, type Install } from "./harness.ts";

beforeAll(() => { if (hasZig) build(); }, 300_000);
afterAll(cleanup);
const A = "1.0.0-b1.1.gdeadbeef", B = "1.0.0-b2.1.gdeadbeef", L = "live-cafebad-b3.1.gdeadbeef";
const target = hostTargetId();
type Entry = ReturnType<typeof bundleMeta> & { tag: string; seq: number; assets: Record<string, { name: string; size: number; sha256: string }> };
function source() {
	const requests: string[] = [], entries: Entry[] = [], assets = new Map<string, Buffer>();
	for (const [id, channel, time, n] of [[A, "release", "2026-09-01T00:00:00.000Z", 1], [B, "release", "2026-09-01T00:00:00.000Z", 2], [L, "live", "2026-09-02T00:00:00.000Z", 3]] as const) {
		const meta = bundleMeta(id, { channel, commitTime: time, run: n, patch: { target } });
		const zip = join(tempDir("dsh-versions-zip-"), "runtime.zip");
		writeZip(zip, [{ name: "bundle.json", data: Buffer.from(JSON.stringify(meta)), mode: 0o644 }, { name: `dsh-native${EXE}`, data: readFileSync(build().fake), mode: 0o755 }]);
		const bytes = readFileSync(zip), tag = `${channel === "release" ? "runtime-v" : "runtime-"}${id}`;
		entries.push({ ...meta, tag, seq: n, assets: { [target]: { name: "runtime.zip", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } } });
		assets.set(`/download/${tag}/runtime.zip`, bytes);
	}
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
		const path = new URL(req.url).pathname; requests.push(path);
		if (path === "/runtime-index.json") return Response.json({ schema: 1, channels: { release: [...entries.filter(e => e.channel === "release"), { kind: "dsh-manager", version: "99.0.0" }], live: entries.filter(e => e.channel === "live") }, addons: { office: [] } });
		return assets.has(path) ? new Response(assets.get(path)) : new Response(null, { status: 404 });
	} });
	return { requests, entries, assets, origin: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
async function command(i: Install, s: ReturnType<typeof source>, args: string[]) {
	rmSync(join(i.out, "1.argv"), { force: true });
	const proc = Bun.spawn([i.exe, ...args], { cwd: i.home, env: { ...baseEnv(i), DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_ORIGIN: s.origin, DSH_MANAGER_TEST_RETRY_MS: "10" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => proc.kill("SIGKILL"), 30_000);
	try { const [status, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]); return { status, stdout, stderr }; }
	finally { clearTimeout(timer); if (proc.exitCode === null) { proc.kill("SIGKILL"); await proc.exited; } }
}
const statePath = (i: Install, file: string) => join(i.data, "state", file);
const selection = (i: Install) => readFileSync(statePath(i, "selection.json"), "utf8");
const channel = (i: Install) => readFileSync(statePath(i, "channel"), "utf8").trim();
const manager = (i: Install, s: ReturnType<typeof source>, args: string[]) => command(i, s, ["manager", ...args]);

// MC-PIN / MC-NAMESPACE: install/select/update all use the native manager, not the runtime's update command.
test.skipIf(!hasZig)("MC-PIN / MC-NAMESPACE: native update adds newest release, reports pin, and plain launch stays pinned", async () => {
	const i = newInstall(), s = source();
	try {
		expect((await manager(i, s, ["install", `runtime-v${A}`])).status).toBe(0);
		expect(run(i, ["manager", "select", "--use", "1.0.0-b1"]).status).toBe(0);
		const pin = selection(i);
		const updated = await manager(i, s, ["update"]);
		expect(updated.status).toBe(0); expect(updated.stderr).toContain("pins");
		expect(selection(i)).toBe(pin); expect(channel(i)).toBe("release");
		expect(readdirSync(join(i.data, "bundles")).sort()).toEqual([A, B]); expect(started(i)).toBe(false);
		const completed = s.requests.length;
		expect((await manager(i, s, ["update"])).status).toBe(0);
		expect(s.requests.slice(completed)).toEqual(["/runtime-index.json"]);
		rmSync(join(i.data, "bundles", B, `dsh-native${EXE}`));
		expect((await manager(i, s, ["update"])).status).toBe(1);
		expect((await manager(i, s, ["update", "--force"])).status).toBe(0);
		expect(existsSync(join(i.data, "bundles", B, `dsh-native${EXE}`))).toBe(true);
		expect(selection(i)).toBe(pin); expect(started(i)).toBe(false);
		expect(run(i, ["probe"]).status).toBe(0); expect(launchOf(i).runtime).toBe(A);
		expect(run(i, ["--use", "latest", "probe"]).status).toBe(0); expect(launchOf(i).runtime).toBe(B);
		expect(run(i, ["manager", "select"]).stdout).toContain(A); expect(started(i)).toBe(false);
	} finally { s.stop(); }
});

test.skipIf(!hasZig)("MC-CHANNEL: failed live update leaves channel/runtime/selection; success and already-installed switch record live", async () => {
	const i = newInstall(), s = source();
	try {
		expect((await manager(i, s, ["install", A])).status).toBe(0);
		expect(run(i, ["manager", "select", "--use", A]).status).toBe(0);
		const pin = selection(i), original = readFileSync(join(i.data, "bundles", A, `dsh-native${EXE}`));
		const live = s.entries.find(e => e.id === L)!, hash = live.assets[target].sha256;
		live.assets[target].sha256 = "a".repeat(64);
		const bad = await manager(i, s, ["update", "--channel", "live"]);
		expect(bad.status).toBe(1); expect(bad.stderr).toContain("HashMismatch");
		expect(channel(i)).toBe("release"); expect(selection(i)).toBe(pin);
		expect(readFileSync(join(i.data, "bundles", A, `dsh-native${EXE}`))).toEqual(original); expect(existsSync(join(i.data, "bundles", L))).toBe(false); expect(started(i)).toBe(false);
		live.assets[target].sha256 = hash;
		expect((await manager(i, s, ["update", "--channel=live"])).status).toBe(0); expect(channel(i)).toBe("live"); expect(selection(i)).toBe(pin);
		expect((await manager(i, s, ["update", "--channel", "release"])).status).toBe(0); expect(channel(i)).toBe("release");
		expect((await manager(i, s, ["update", "--channel", "live"])).status).toBe(0); expect(channel(i)).toBe("live");
        expect((await manager(i, s, ["install", A, "--channel", "release"])).status).toBe(0); expect(channel(i)).toBe("release");
        expect((await manager(i, s, ["install", "missing", "--channel", "live"])).status).toBe(1); expect(channel(i)).toBe("release");
        expect((await manager(i, s, ["install", L, "--channel", "live"])).status).toBe(0); expect(channel(i)).toBe("live");
        expect(selection(i)).toBe(pin); expect(started(i)).toBe(false);
	} finally { s.stop(); }
});

test.skipIf(!hasZig)("MC-NAMESPACE: list is offline/read-only; --available lists host-compatible runtime candidates, never manager", async () => {
	const i = newInstall(), s = source();
	try {
		const before = tree(i.dir), cold = run(i, ["manager", "list", "--json"]);
		expect(cold.status).toBe(0); expect(JSON.parse(cold.stdout).installed).toEqual([]); expect(tree(i.dir)).toEqual(before); expect(s.requests).toEqual([]);
		const available = await manager(i, s, ["list", "--available", "--json"]);
		expect(available.status).toBe(0); expect(JSON.parse(available.stdout).available.map((e: any) => e.version).sort()).toEqual([A, B, L].sort());
		expect(s.requests).toEqual(["/runtime-index.json"]); expect(tree(i.dir)).toEqual(before); expect(started(i)).toBe(false);
		expect((await manager(i, s, ["install", A])).status).toBe(0);
		expect(run(i, ["manager", "select", "--use", A]).status).toBe(0);
		const seen = s.requests.length, files = tree(i.data);
		const local = run(i, ["manager", "list", "--json"]);
		expect(JSON.parse(local.stdout)).toMatchObject({ channel: "release", selection: { use: A }, installed: [{ version: A, selected: true, startable: true }] });
		expect(s.requests.length).toBe(seen); expect(tree(i.data)).toEqual(files);
		const text = run(i, ["manager", "list"]); expect(text.stdout).toContain(A); expect(text.stdout).toContain("selected");
	} finally { s.stop(); }
});

test.skipIf(!hasZig)("MC-PIN: ambiguous/missing selectors refuse unchanged; --use latest resets snapshot and repairs invalid state", async () => {
	const i = newInstall(), s = source();
	try {
		const ambiguous = await manager(i, s, ["install", "1.0.0"]);
		expect(ambiguous.status).toBe(1); expect(ambiguous.stderr).toContain(A); expect(ambiguous.stderr).toContain(B); expect(s.requests).toEqual(["/runtime-index.json"]);
		for (const id of [A, B]) expect((await manager(i, s, ["install", id])).status).toBe(0);
		expect(run(i, ["manager", "select", "--use", A]).status).toBe(0);
		const original = selection(i);
		for (const [args, message] of [[["--use", "1.0.0"], "ambiguous"], [["--use", "missing"], "not installed"], [["--snapshot", `${A}@1`], "--use"], [["--use", B, "--snapshot", `${A}@999`], "snapshot"], [["--addon", "office:1"], "not available"]] as const) {
			const bad = run(i, ["manager", "select", ...args]); expect(bad.status).toBe(1); expect(bad.stderr).toContain(message); expect(selection(i)).toBe(original); expect(started(i)).toBe(false);
		}
		const metadata = join(i.data, "snapshots", `${A}@1`, "snapshot.json");
		const meta = JSON.parse(readFileSync(metadata, "utf8")); writeFileSync(metadata, JSON.stringify({ ...meta, alias: "keep" }));
		expect(run(i, ["manager", "select", "--use", B, "--snapshot", "1.0.0-b1@keep"]).status).toBe(0);
		expect(JSON.parse(selection(i))).toMatchObject({ use: B, snapshot: `${A}@1` });
		expect(run(i, ["probe"]).status).toBe(0); expect(launchOf(i)).toMatchObject({ runtime: B, snapshot: { id: `${A}@1` } });
		expect(run(i, ["--use", B, "probe"]).status).toBe(0); expect(launchOf(i)).toMatchObject({ runtime: B, snapshot: { id: `${B}@1` } });
		expect(run(i, ["--snapshot", "1.0.0-b1@keep", "probe"]).status).toBe(0); expect(launchOf(i)).toMatchObject({ runtime: A, snapshot: { id: `${A}@1` } });
		expect(run(i, ["--use", A, "probe"]).status).toBe(0); expect(launchOf(i)).toMatchObject({ runtime: A, snapshot: { id: `${A}@1` } });
		rmSync(join(i.data, "snapshots", `${A}@1`), { recursive: true });
		expect(run(i, ["probe"]).status).toBe(1); expect(started(i)).toBe(false);
		expect(run(i, ["manager", "select", "--use", "latest"]).status).toBe(0); expect(JSON.parse(selection(i))).toMatchObject({ use: "latest", snapshot: null });
		writeFileSync(statePath(i, "selection.json"), "not JSON");
		expect(run(i, ["manager", "select"]).status).toBe(1);
		expect(run(i, ["manager", "select", "--use", "latest"]).status).toBe(0);
		expect(JSON.parse(selection(i))).toEqual({ schema: 1, use: "latest", snapshot: null, addons: {} });
		expect(run(i, ["manager", "select", "--use", A, "--use", B]).status).toBe(1);
		expect(run(i, ["manager", "select", "--use", A, "--snapshot", "../../outside@1"]).status).toBe(1);
	} finally { s.stop(); }
});

test.skipIf(!hasZig)("MC-REINSTALL: --force actually replaces damaged runtime, preserving snapshot files, counter and selection", async () => {
	const i = newInstall(), s = source();
	try {
		expect((await manager(i, s, ["install", A])).status).toBe(0);
		expect(run(i, ["manager", "select", "--use", A]).status).toBe(0);
		const snapshot = join(i.data, "snapshots", `${A}@1`), meta = readFileSync(join(snapshot, "snapshot.json")), pin = selection(i);
		writeFileSync(join(snapshot, "plugin"), "plugin stays"); writeFileSync(join(i.data, "snapshots", ".counters.json"), JSON.stringify({ [A]: 9 }));
		rmSync(join(i.data, "bundles", A, `dsh-native${EXE}`));
		expect((await manager(i, s, ["install", A])).status).toBe(1);
		expect((await manager(i, s, ["install", A, "--force"])).status).toBe(0); expect(started(i)).toBe(false);
		expect(existsSync(join(i.data, "bundles", A, `dsh-native${EXE}`))).toBe(true);
		expect(selection(i)).toBe(pin); expect(readFileSync(join(snapshot, "snapshot.json"))).toEqual(meta); expect(readFileSync(join(snapshot, "plugin"), "utf8")).toBe("plugin stays");
		expect(JSON.parse(readFileSync(join(i.data, "snapshots", ".counters.json"), "utf8"))).toEqual({ [A]: 9 });
	} finally { s.stop(); }
});

test.skipIf(!hasZig)("MC-LAST / MC-REINSTALL: unpin then uninstall all, preserve data; reinstall same runtime reuses snapshot", async () => {
	const i = newInstall(), s = source();
	try {
		for (const id of [A, B]) expect((await manager(i, s, ["install", id])).status).toBe(0);
		expect(run(i, ["manager", "select", "--use", A]).status).toBe(0);
		const pin = selection(i);
		for (const ids of [[B, A], [B, "missing"], ["1.0.0"]]) { const bad = run(i, ["manager", "uninstall", ...ids]); expect(bad.status).toBe(1); expect(readdirSync(join(i.data, "bundles")).sort()).toEqual([A, B]); expect(selection(i)).toBe(pin); }
		expect(run(i, ["manager", "select", "--use", "latest"]).status).toBe(0);
		mkdirSync(join(i.data, "home")); writeFileSync(join(i.data, "home", "credentials"), "keep credentials");
		writeFileSync(join(i.data, "snapshots", `${A}@1`, "plugin"), "keep plugin");
		writeFileSync(join(i.data, "snapshots", ".counters.json"), JSON.stringify({ [A]: 7, [B]: 2 }));
		const saved = selection(i), meta = readFileSync(join(i.data, "snapshots", `${A}@1`, "snapshot.json"));
		expect(run(i, ["manager", "uninstall", `runtime-v${B}`]).status).toBe(0);
		expect(run(i, ["manager", "uninstall", A, A]).status).toBe(0); expect(started(i)).toBe(false);
		expect(readdirSync(join(i.data, "bundles"))).toEqual([]); expect(selection(i)).toBe(saved); expect(channel(i)).toBe("release");
		expect(run(i, ["manager", "--version"]).status).toBe(0); expect(run(i, ["manager", "list"]).stdout).toMatch(/no dsh runtime/i);
		expect((await manager(i, s, ["install", A])).status).toBe(0);
		expect(readFileSync(join(i.data, "snapshots", `${A}@1`, "snapshot.json"))).toEqual(meta); expect(readFileSync(join(i.data, "snapshots", `${A}@1`, "plugin"), "utf8")).toBe("keep plugin");
		expect(readFileSync(join(i.data, "home", "credentials"), "utf8")).toBe("keep credentials");
		expect(JSON.parse(readFileSync(join(i.data, "snapshots", ".counters.json"), "utf8"))).toEqual({ [A]: 7, [B]: 2 });
		expect(run(i, ["probe"]).status).toBe(0); expect(launchOf(i)).toMatchObject({ runtime: A, snapshot: { id: `${A}@1` } });
		expect(run(i, ["manager", "select", "--use", "latest", "--snapshot", `${A}@1`]).status).toBe(0);
		expect((await manager(i, s, ["update", "--channel", "live"])).status).toBe(0);
		const cross = selection(i), snapMeta = readFileSync(join(i.data, "snapshots", `${A}@1`, "snapshot.json"));
		expect(run(i, ["manager", "uninstall", A, L]).status).toBe(0);
		expect((await command(i, s, ["probe"])).status).toBe(0);
		expect(launchOf(i)).toMatchObject({ runtime: L, snapshot: { id: `${A}@1` } });
		expect(channel(i)).toBe("live"); expect(selection(i)).toBe(cross);
		expect(readFileSync(join(i.data, "snapshots", `${A}@1`, "snapshot.json"))).toEqual(snapMeta);
		expect(readFileSync(join(i.data, "snapshots", `${A}@1`, "plugin"), "utf8")).toBe("keep plugin");
	} finally { s.stop(); }
});

test.skipIf(!hasZig)("FB-RESTORE-CHANNEL: uninstall last live then plain launch restores live; new empty installation defaults release", async () => {
	const i = newInstall(), s = source();
	try {
		expect((await manager(i, s, ["update", "--channel", "live"])).status).toBe(0);
		expect(run(i, ["manager", "select", "--use", "latest"]).status).toBe(0);
		const saved = selection(i); expect(run(i, ["manager", "uninstall", L]).status).toBe(0); expect(channel(i)).toBe("live");
		const before = s.requests.length;
		expect((await command(i, s, ["probe"])).status).toBe(0); expect(launchOf(i).runtime).toBe(L); expect(selection(i)).toBe(saved); expect(channel(i)).toBe("live");
		expect(s.requests.slice(before).some(p => p.includes(`runtime-${L}`))).toBe(true); expect(existsSync(join(i.data, "bundles", B))).toBe(false);
		const fresh = newInstall(); expect((await command(fresh, s, ["probe"])).status).toBe(0); expect(launchOf(fresh).runtime).toBe(B); expect(channel(fresh)).toBe("release");
	} finally { s.stop(); }
});

test.skipIf(!hasZig)("MC-SNAPSHOT / MC-CROSS-SNAPSHOT: install, update and bootstrap copy the previous version's newest snapshot without touching source/home", async () => {
	const i = newInstall(), s = source();
	const fingerprint = (path: string) => tree(path).filter(p => !p.endsWith(".usage.lock")).map(p => { try { return [p, createHash("sha256").update(readFileSync(join(path, p))).digest("hex")]; } catch { return [p, "dir"]; } });
	try {
		expect((await manager(i, s, ["install", A])).status).toBe(0);
		expect(run(i, ["--use", A, "probe"], { env: { FAKE_SNAPSHOT_WRITE: "first plugin" } }).status).toBe(0);
		expect(run(i, ["manager", "snapshot", "new", "--use", A, "--name", "newest"]).status).toBe(0);
		expect(run(i, ["--use", A, "probe"], { env: { FAKE_SNAPSHOT_WRITE: "newest plugin" } }).status).toBe(0);
		const a = join(i.data, "snapshots", `${A}@2`), b = join(i.data, "snapshots", `${B}@1`), home = join(i.data, "home/profiles/probe");
		mkdirSync(home, { recursive: true }); writeFileSync(join(home, "cordis.patch.yml"), "shared only");
		const original = fingerprint(a);
		expect((await manager(i, s, ["install", B])).status).toBe(0);
		expect(readFileSync(join(b, "profiles/probe/plugin"), "utf8")).toBe("newest plugin");
		expect(JSON.parse(readFileSync(join(b, "snapshot.json"), "utf8"))).toMatchObject({ source: `${A}@2`, reason: "install" });
		expect(existsSync(join(b, "profiles/probe/cordis.patch.yml"))).toBe(false); expect(fingerprint(a)).toEqual(original); expect(started(i)).toBe(false);
		expect(run(i, ["--use", B, "probe"], { env: { FAKE_SNAPSHOT_WRITE: "B plugin" } }).status).toBe(0); expect(fingerprint(a)).toEqual(original);
		const savedB = fingerprint(b);
		expect(run(i, ["--use", B, "--snapshot", `${A}@2`, "probe"]).status).toBe(0);
		expect(launchOf(i)).toMatchObject({ runtime: B, snapshot: { id: `${A}@2` } }); expect(fingerprint(a)).toEqual(original); expect(fingerprint(b)).toEqual(savedB);
		expect(run(i, ["manager", "uninstall", A]).status).toBe(0);
		expect((await manager(i, s, ["update", "--channel", "live"])).status).toBe(0);
		const live = join(i.data, "snapshots", `${L}@1`); expect(readFileSync(join(live, "profiles/probe/plugin"), "utf8")).toBe("B plugin");
		expect(JSON.parse(readFileSync(join(live, "snapshot.json"), "utf8")).source).toBe(`${B}@1`);
		expect(run(i, ["manager", "snapshot", "remove", `${L}@1`]).status).toBe(0);
		expect(run(i, ["manager", "uninstall", B, L]).status).toBe(0);
		expect((await command(i, s, ["probe"])).status).toBe(0);
		expect(launchOf(i).snapshot.id).toBe(`${L}@2`); expect(readFileSync(join(i.data, "snapshots", `${L}@2`, "profiles/probe/plugin"), "utf8")).toBe("B plugin");
		expect(fingerprint(a)).toEqual(original); expect(readFileSync(join(home, "cordis.patch.yml"), "utf8")).toBe("shared only");
	} finally { s.stop(); }
});
