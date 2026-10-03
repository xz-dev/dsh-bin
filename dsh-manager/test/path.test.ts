// manager-paths: real native manager queries; fake entries establish selection only, not application I/O.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addRuntime, baseEnv, build, cleanup, EXE, hasZig, launchOf, newInstall, run, started, tempDir, tree, WIN, type Install } from "./harness.ts";

beforeAll(() => { if (hasZig) build(); }, 300_000);
afterAll(cleanup);
const A = "1.0.0-test.1", B = "2.0.0-test.2";
const scopes = ["self", "home", "runtime", "snapshot", "addon", "cache", "tmp", "completion"];
function seed(i: Install, kind: "plugins" | "config", version = A, n = 1, alias: string | null = null) {
	mkdirSync(i.data, { recursive: true });
	writeFileSync(join(i.data, ".dsh-bin-data.json"), JSON.stringify({ kind: "dsh-manager-data", schema: 1 }));
	const id = `${version}@${n}`, folder = kind === "plugins" ? "snapshots" : "config-snapshots";
	const path = join(i.data, folder, id); mkdirSync(path, { recursive: true });
	writeFileSync(join(path, "snapshot.json"), JSON.stringify({ id, version, n, alias }));
	writeFileSync(join(path, ".usage.lock"), ""); return { id, path };
}
function query(i: Install, args: string[] = [], opts: Parameters<typeof run>[2] = {}) {
	const r = run(i, ["manager", "path", ...args, "--json"], opts);
	expect(r.stdout.trim().startsWith("{")).toBe(true);
	const value = JSON.parse(r.stdout); expect(value.schemaVersion).toBe(1);
	expect(Array.isArray(value.records)).toBe(true); expect(Array.isArray(value.diagnostics)).toBe(true);
	return { ...r, value };
}
const record = (v: any, role: string) => v.records.find((r: any) => r.role === role);

test.skipIf(!hasZig)("PATH-MISSING / PATH-OVERVIEW / PATH-JSON: cold eight scopes compute roots without initialization", () => {
	const i = newInstall(), before = tree(i.dir);
	for (const scope of [[], ...scopes.map(s => [s])]) {
		const r = query(i, scope); expect(r.status).toBe(0); expect(r.value.complete).toBe(true);
		for (const item of r.value.records) if (item.path !== null) expect(item.path).toMatch(WIN ? /^[A-Za-z]:[\\/]/ : /^\//);
		expect(r.stdout).not.toContain("\u001b"); expect(r.stderr).toBe("");
		const human = run(i, ["manager", "path", ...scope]); expect(human.status).toBe(0);
		for (const item of r.value.records) { expect(human.stdout).toContain(item.role); expect(human.stdout).toContain(item.status); if (item.path) expect(human.stdout).toContain(item.path); }
	}
	const all = query(i).value; expect(all.effective.status).toBe("empty");
	expect(record(all, "self.data").status).toBe("not-created"); expect(record(all, "home").path).toBe(join(i.data, "home"));
	expect(record(query(i, ["cache"]).value, "cache.app-default").path).toBe(join(i.data, "home", "cache"));
	expect(tree(i.dir)).toEqual(before); expect(tree(i.home)).toEqual([]); expect(started(i)).toBe(false);
}, 120_000);

test.skipIf(!hasZig)("PATH-CURRENT / PATH-SNAPSHOTS: typed aliases, override intent and orphan inventory agree with native launch", () => {
	const i = newInstall(); addRuntime(i.data, A); addRuntime(i.data, B, { run: 2 });
	const p1 = seed(i, "plugins"), p2 = seed(i, "plugins", B), c1 = seed(i, "config", A, 1, "daily"), c2 = seed(i, "config", B);
	mkdirSync(join(i.data, "state")); const selected = JSON.stringify({ schema: 1, use: A, snapshot: p1.id, configSnapshot: c1.id, addons: {} });
	writeFileSync(join(i.data, "state/selection.json"), selected);
	const before = tree(i.data), ordinary = query(i); expect(ordinary.status).toBe(0);
	expect(ordinary.value.effective.runtime.id).toBe(A); expect(ordinary.value.effective.plugins.id).toBe(p1.id); expect(ordinary.value.effective.config.id).toBe(c1.id);
	const changed = run(i, ["--config-snapshot", c2.id, "manager", "path", "--json"]); expect(changed.status).toBe(0);
	const eff = JSON.parse(changed.stdout).effective; expect(eff.runtime.id).toBe(B); expect(eff.plugins.id).toBe(p2.id); expect(eff.config.id).toBe(c2.id);
	expect(tree(i.data)).toEqual(before); expect(readFileSync(join(i.data, "state/selection.json"), "utf8")).toBe(selected);
	const exact = query(i, ["snapshot", "config", `${A}@daily`]); expect(exact.status).toBe(0);
	expect(exact.value.records.filter((r: any) => r.role === "snapshot").map((r: any) => [r.kind, r.id, r.path])).toEqual([["config", c1.id, c1.path]]);
	expect(run(i, ["--config-snapshot", c2.id, "probe"]).status).toBe(0); const launched = launchOf(i);
	expect([eff.runtime.id, eff.plugins.id, eff.config.id]).toEqual([launched.runtime, launched.snapshot.id, launched.configSnapshot.id]);
	rmSync(join(i.data, "bundles", A), { recursive: true }); const orphan = query(i, ["snapshot"]); expect(orphan.status).toBe(0);
	expect(orphan.value.records.filter((r: any) => r.role === "snapshot" && r.id === c1.id).map((r: any) => r.kind).sort()).toEqual(["config", "plugins"]);
}, 120_000);

test.skipIf(!hasZig)("PATH-RUNTIME / PATH-TARGET-ERROR / PATH-UNREADABLE: exact local targets and invalid selection fail without fallback", () => {
	const i = newInstall(); addRuntime(i.data, A); addRuntime(i.data, `${A}.other`, { run: 2 }); seed(i, "plugins"); seed(i, "config");
	for (const args of [["runtime", "missing"], ["runtime", "1.0"], ["snapshot", `${A}@1`], ["snapshot", "config", `${A}@99`], ["addon", "office:missing"], ["completion", "unknown"]]) {
		const before = tree(i.data), r = query(i, args); expect(r.status).toBe(1); expect(r.value.complete).toBe(false); expect(r.value.diagnostics.length).toBeGreaterThan(0); expect(tree(i.data)).toEqual(before);
	}
	const exact = query(i, ["runtime", A]); expect(exact.status).toBe(0); expect(exact.value.records.filter((r: any) => r.role === "runtime").map((r: any) => r.id)).toEqual([A]);
	mkdirSync(join(i.data, "state")); writeFileSync(join(i.data, "state/selection.json"), "broken");
	const r = query(i); expect(r.status).toBe(1); expect(r.value.effective.status).toBe("unresolved"); expect(record(r.value, "self.data").path).toBe(i.data);
	expect(query(i, ["self"]).status).toBe(0); expect(query(i, ["home"]).status).toBe(0); expect(started(i)).toBe(false);
	writeFileSync(join(i.data, "state/selection.json"), JSON.stringify({ schema: 1, use: A, configSnapshot: `${A}@99` }));
	expect(query(i).value.effective.status).toBe("unresolved"); expect(readFileSync(join(i.data, "state/selection.json"), "utf8")).toContain("@99");
}, 120_000);

test.skipIf(!hasZig)("PATH-CONFLICT: foreign nonempty data, wrong-type roots and bad metadata remain diagnostic, not adopted", () => {
	const i = newInstall(); mkdirSync(i.data); writeFileSync(join(i.data, "private-user-file"), "do-not-open-me");
	let before = tree(i.data), r = query(i); expect(r.status).toBe(1); expect(record(r.value, "self.data").status).toBe("conflict"); expect(tree(i.data)).toEqual(before);
	rmSync(i.data, { recursive: true }); writeFileSync(i.data, "not a directory"); r = query(i, ["runtime"]); expect(r.status).toBe(1); expect(r.value.diagnostics.length).toBeGreaterThan(0); expect(readFileSync(i.data, "utf8")).toBe("not a directory");
	rmSync(i.data); addRuntime(i.data, A); writeFileSync(join(i.data, "bundles", A, "bundle.json"), "bad metadata");
	r = query(i, ["runtime"]); expect(r.status).toBe(1); expect(r.value.records.some((r: any) => r.id === A && r.status === "invalid")).toBe(true);
	before = tree(i.data); expect(query(i).status).toBe(1); expect(tree(i.data)).toEqual(before);
}, 120_000);

test.skipIf(!hasZig)("PATH-COMPLETION: real future registration records paths; missing, legacy and unregistered differ without reading rc", () => {
	const i = newInstall(), rc = join(i.home, ".bashrc"); writeFileSync(rc, "# SECRET-RC-CONTENT\n");
	expect(run(i, ["manager", "completion", "install", "bash"]).status).toBe(0);
	const metadata = JSON.parse(readFileSync(join(i.data, "state/completion.json"), "utf8")); expect(metadata.shells.bash.path).toBe(rc);
	const q = query(i, ["completion", "bash"]); expect(q.status).toBe(0); expect(record(q.value, "completion.registration").path).toBe(rc); expect(record(q.value, "completion.registration").status).toBe("exists"); expect(q.stdout).not.toContain("SECRET-RC");
	renameSync(rc, `${rc}.moved`); const missing = query(i, ["completion", "bash"]); expect(record(missing.value, "completion.registration").status).toBe("missing");
	writeFileSync(join(i.data, "state/completion.json"), JSON.stringify({ schema: 1, shells: { bash: { result: "registered" }, zsh: { result: "declined" } } }));
	const old = query(i, ["completion", "bash"]); expect(record(old.value, "completion.registration").status).toBe("unknown"); expect(record(old.value, "completion.registration").path).toBe(null);
	expect(record(query(i, ["completion", "fish"]).value, "completion.registration").reason).toBe("not-registered");
}, 120_000);

test.skipIf(!hasZig)("PATH-ADDONS / PATH-CACHES: local slot identity and external application default cache remain distinct", () => {
	const i = newInstall(); addRuntime(i.data, A); const version = "0.2.0", slot = { commit: "a".repeat(40), kitVersion: version };
	const dir = join(i.data, "addons/office", version); mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "addon.json"), JSON.stringify({ name: "office", version, tag: `addon-office-v${version}`, slot, kitVersion: version, platform: process.platform === "linux" ? "linux" : `${WIN ? "windows" : process.platform}-${process.arch}`, packages: [], seq: 1 }));
	const a = query(i, ["addon", `office:${version}`]); expect(a.status).toBe(0); const obj = record(a.value, "addon"); expect(obj.path).toBe(dir); expect(obj.slot).toEqual(slot);
	const ext = join(i.home, "non-config-data"), cache = query(i, ["cache"], { env: { DSH_HOME: ext } }); expect(cache.status).toBe(0);
	expect(record(cache.value, "cache.manager").path).toBe(join(i.data, "cache")); expect(record(cache.value, "cache.app-default").path).toBe(join(ext, "cache")); expect(record(cache.value, "cache.app-default").source).toBe("application-default");
	expect(existsSync(ext)).toBe(false); expect(started(i)).toBe(false);
}, 120_000);

test.skipIf(!hasZig)("PATH-EXPLAIN / PATH-MODES: real symlink, offline move and managed roots reuse authoritative context", () => {
	const i = newInstall(), alias = join(i.home, `entry${EXE}`); symlinkSync(i.exe, alias);
	const relative = query(i, ["home"], { exe: alias, env: { DSH_HOME: "relative-home" } }); expect(relative.status).toBe(0); expect(record(relative.value, "home").path).toBe(join(i.home, "relative-home")); expect(record(relative.value, "home").reason).toContain(i.home);
	const actual = query(i, ["self"], { exe: alias }); expect(record(actual.value, "self.executable").path).toBe(i.exe);
	const moved = join(tempDir("dsh-path-move-"), "tools"); renameSync(i.dir, moved); const target = { ...i, dir: moved, exe: join(moved, `dsh${EXE}`), data: join(moved, "dsh-bin") };
	expect(record(query(target, ["self"]).value, "self.data").path).toBe(target.data); expect(existsSync(i.dir)).toBe(false);
	writeFileSync(join(moved, ".dsh-manager-install.json"), JSON.stringify({ schema: 1, owner: "portage" })); const xdg = join(i.home, "xdg");
	expect(record(query(target, ["self"], { env: { XDG_DATA_HOME: xdg } }).value, "self.data").path).toBe(join(xdg, "dsh-bin"));
	writeFileSync(join(moved, ".dsh-manager-install.json"), JSON.stringify({ schema: 1, owner: "scoop" })); const local = join(i.home, "local");
	expect(record(query(target, ["self"], { env: { LOCALAPPDATA: local } }).value, "self.data").path).toBe(join(local, "dsh-bin"));
}, 120_000);

const strace = process.platform === "linux" ? Bun.which("strace") : null;
test.skipIf(!hasZig || !strace)("PATH-READONLY / PATH-SECRET: all eight queries and hostile metadata have no sensitive open, child exec or network", () => {
	const i = newInstall(); addRuntime(i.data, A); seed(i, "plugins"); const c = seed(i, "config");
	const secret = "TEST-SECRET-DO-NOT-READ", paths = [join(c.path, ".credentials.yaml"), join(c.path, "settings.yaml"), join(i.home, ".bashrc")];
	for (const p of paths) writeFileSync(p, secret); mkdirSync(join(i.data, "state"));
	writeFileSync(join(i.data, "state/completion.json"), JSON.stringify({ schema: 1, shells: { bash: { result: "registered", path: paths[2], binding: `abs:${i.exe}` } } }));
	writeFileSync(join(i.data, "state/selection.json"), "broken"); const before = tree(i.data);
	for (const scope of [[], ...scopes.map(s => [s])]) {
		const log = join(i.out, `trace-${scope[0] ?? "overview"}`);
		const r = spawnSync(strace!, ["-f", "-qq", "-e", "trace=file,network,process", "-o", log, i.exe, "manager", "path", ...scope, "--json"], { cwd: i.home, encoding: "utf8", env: baseEnv(i), timeout: 30_000 });
		expect(r.stdout).not.toContain(secret); expect(r.stderr).not.toContain(secret); const trace = readFileSync(log, "utf8");
		for (const line of trace.split("\n")) if (/\b(open|openat|openat2)\(/.test(line)) for (const p of paths) expect(line).not.toContain(p);
		expect((trace.match(/\bexecve(?:at)?\(/g) ?? []).length).toBe(1); expect(trace).not.toMatch(/\b(connect|sendto|socket)\(/); expect(tree(i.data)).toEqual(before);
	}
	const outside = join(i.home, "external-metadata.json"); writeFileSync(outside, JSON.stringify({ id: A, extra: secret }));
	const metadata = join(i.data, "bundles", A, "bundle.json"); rmSync(metadata); symlinkSync(outside, metadata);
	const log = join(i.out, "hostile-meta-trace"); const r = spawnSync(strace!, ["-f", "-qq", "-e", "trace=file", "-o", log, i.exe, "manager", "path", "runtime", "--json"], { cwd: i.home, encoding: "utf8", env: baseEnv(i) });
	expect(r.status).toBe(1); expect(r.stdout).not.toContain(secret); expect(readFileSync(log, "utf8")).not.toMatch(new RegExp(`openat[^\n]*${outside.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
	rmSync(metadata); linkSync(outside, metadata); expect(query(i, ["runtime"]).status).toBe(1); expect(started(i)).toBe(false);
}, 120_000);

test.skipIf(!hasZig || WIN)("PATH-UNREADABLE: inaccessible managed inventory is not reported empty", () => {
	const i = newInstall(); addRuntime(i.data, A); chmodSync(join(i.data, "bundles"), 0o000);
	try { const r = query(i, ["runtime"]); expect(r.status).toBe(1); expect(r.value.complete).toBe(false); expect(r.value.diagnostics.some((d: any) => d.code === "unreadable")).toBe(true); }
	finally { chmodSync(join(i.data, "bundles"), 0o700); }
}, 120_000);

test.skipIf(!hasZig)("PATH-COMPLETION: actual registration never adopts a foreign nonempty manager root", () => {
	const i = newInstall(); mkdirSync(i.data); writeFileSync(join(i.data, "user-owned"), "keep");
	const rc = join(i.home, ".bashrc"), original = "# untouched before ownership check\n"; writeFileSync(rc, original);
	const before = tree(i.data), r = run(i, ["manager", "completion", "install", "bash"]);
	expect(r.status).toBe(1); expect(r.stderr).toContain("data root conflict");
	expect(tree(i.data)).toEqual(before); expect(readFileSync(rc, "utf8")).toBe(original);
});

test.skipIf(!hasZig)("PATH-READONLY: pending self-update result and locks are untouched by every query", () => {
	const i = newInstall(); addRuntime(i.data, A); mkdirSync(join(i.data, "tmp")); const receipt = join(i.data, "tmp/self-update-result.txt"); writeFileSync(receipt, "failed: synthetic test receipt\n");
	for (const s of scopes) { query(i, [s]); expect(readFileSync(receipt, "utf8")).toBe("failed: synthetic test receipt\n"); }
}, 120_000);
