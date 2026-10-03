// Starting a runtime through the manager (manager-control "Management and app commands are separate",
// runtime-bundles "Compatibility is expressed by format and launch protocol"). A fake runtime entry
// (fake-native.zig) records the arguments, environment and cwd it gets.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireClaim } from "./claim-probe.ts";
import { addRuntime, argvOf, baseEnv, build, cleanup, cwdOf, envOf, EXE, hasZig, type Install, launchOf, MANAGER_VERSION, newInstall, run, started, tempDir, WIN } from "./harness.ts";

beforeAll(() => {
	if (hasZig) build();
}, 300_000);
afterAll(cleanup);

const R2 = "0.1.7-rc.2-b7.1.g4e41a3f1";
const R2B = "0.1.7-rc.2-b21.1.g4e41a3f1";
const R1 = "0.2.0-rc.1-b10.1.ga83dab63";
const L1 = "live-deadbee-b11.1.gdeadbeef";
const SPECS = {
	[R2]: { commitTime: "2026-09-24T10:00:00.000Z", run: 7 },
	[R2B]: { commitTime: "2026-09-24T10:00:00.000Z", run: 21 },
	[R1]: { commitTime: "2026-09-28T10:00:00.000Z", run: 10 },
	[L1]: { channel: "live" as const, commitTime: "2026-09-29T10:00:00.000Z", run: 11 },
};

function install(ids: string[] = [R2, R1], opts: { channel?: string; selection?: unknown } = {}): Install {
	const i = newInstall();
	for (const id of ids) addRuntime(i.data, id, SPECS[id]);
	if (opts.channel) state(i, "channel", `${opts.channel}\n`);
	if (opts.selection !== undefined) select(i, opts.selection);
	return i;
}
function state(i: Install, name: string, text: string) {
	mkdirSync(join(i.data, "state"), { recursive: true });
	writeFileSync(join(i.data, "state", name), text);
}
const select = (i: Install, s: unknown) => state(i, "selection.json", typeof s === "string" ? s : JSON.stringify(s));

/** One diagnostic line, nothing started, nothing on stdout. */
function refused(i: Install, res: ReturnType<typeof run>, ...parts: string[]) {
	expect(res.status).toBe(1);
	expect(res.stdout).toBe("");
	expect(res.stderr.trim().split("\n")).toHaveLength(1);
	for (const p of parts) expect(res.stderr).toContain(p);
	expect(started(i)).toBe(false);
}

// ── Arguments ────────────────────────────────────────────────────────────────────────────────────────

test.skipIf(!hasZig)("MC-ARGS: leading options select the runtime; the app gets the rest unchanged, prompt text included", () => {
	const i = install();
	const cwd = tempDir("dsh-project-");
	const args = ["--profile", "tui", "-p", "manager update --use latest", "with space", ""];
	const res = run(i, ["--use", "0.2.0", ...args], { env: { FAKE_EXIT: "3" }, cwd });
	expect(res.status).toBe(3);
	expect(argvOf(i)).toEqual(args);
	expect(cwdOf(i)).toBe(cwd);
	expect(launchOf(i)).toMatchObject({ protocol: 2, runtime: R1, source: "use", manager: MANAGER_VERSION });
});

test.skipIf(!hasZig)("MC-ARGS: `manager` after the first app argument is an app argument", () => {
	const i = install();
	expect(run(i, ["--profile", "manager", "manager"]).status).toBe(0);
	expect(argvOf(i)).toEqual(["--profile", "manager", "manager"]);
});

test.skipIf(!hasZig)("stdin and stdout belong to the app", () => {
	const i = install();
	const res = run(i, ["-p", "x"], { env: { FAKE_STDIN: "1" }, input: "piped input" });
	expect(res.status).toBe(0);
	expect(readFileSync(join(i.out, "1.stdin"), "utf8")).toBe("piped input");
});

function addSnapshot(i: Install, id: string, n: number) {
	const dir = join(i.data, "snapshots", `${id}@${n}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "snapshot.json"), JSON.stringify({ id: `${id}@${n}`, version: id, n }));
	writeFileSync(join(dir, ".usage.lock"), "");
}

test.skipIf(!hasZig)("--opt=value forms, repeated --addon, and arguments after the first other argument", () => {
	const i = install();
	addSnapshot(i, R2, 2);
	expect(run(i, [`--snapshot=${R2}@2`, "--addon", "office:0.1.1", "--addon=office:0.1.2", "plugin", "--use", "x"]).status).toBe(0);
	expect(argvOf(i)).toEqual(["plugin", "--use", "x"]);
	expect(launchOf(i)).toMatchObject({ runtime: R2, source: "snapshot" });
});

test.skipIf(!hasZig)("--use overrides the version implied by --snapshot; tags and unique prefixes name versions", () => {
	const i = install();
	addSnapshot(i, R2, 2);
	expect(run(i, ["--use", "0.2.0-rc.1", "--snapshot", `${R2}@2`]).status).toBe(0);
	expect(launchOf(i)).toMatchObject({ runtime: R1, source: "use" });
	run(i, ["--use", `runtime-v${R2}`]);
	expect(launchOf(i).runtime).toBe(R2);
});

// ── Selection ────────────────────────────────────────────────────────────────────────────────────────

test.skipIf(!hasZig)("latest: last in version order of the recorded channel", () => {
	const i = install([R2B, L1, R2, R1]);
	run(i, []);
	expect(launchOf(i)).toMatchObject({ runtime: R1, source: "selection" });
	state(i, "channel", "live\n");
	run(i, []);
	expect(launchOf(i).runtime).toBe(L1);
	const rebuilt = install([R2B, R2], { selection: { schema: 1, use: "latest", snapshot: null, addons: {} } });
	run(rebuilt, []);
	expect(launchOf(rebuilt).runtime).toBe(R2B);
});

test.skipIf(!hasZig)("a pinned selection is used; prompt text is not parsed", () => {
	const i = install([R2, R1], { selection: { schema: 1, use: R2, snapshot: null, addons: {} } });
	expect(run(i, ["-p", "--use 1"]).status).toBe(0);
	expect(argvOf(i)).toEqual(["-p", "--use 1"]);
	expect(launchOf(i)).toMatchObject({ runtime: R2, source: "selection" });
});

test.skipIf(!hasZig)("FB-MISSING / no fallback: a missing or ambiguous version is one diagnostic naming `dsh manager install`", () => {
	const i = install([R2, R2B, R1]);
	refused(i, run(i, ["--use", "0.1.5"]), "0.1.5", "dsh manager install 0.1.5");
	refused(i, run(i, ["--use", "0.1.7-rc.2"]), "ambiguous");
	refused(i, run(i, ["--snapshot", "nover"]), "invalid snapshot id nover");
	refused(i, run(i, ["--use"]), "--use needs a value");
	const pinned = install([R1], { selection: { schema: 1, use: R2, snapshot: null, addons: {} } });
	refused(pinned, run(pinned, []), R2, `dsh manager install ${R2}`, "dsh manager select --use latest");
	const live = install([R2, R1], { channel: "live" });
	refused(live, run(live, []), "no live-channel dsh runtime is installed", "dsh manager update");
});

test.skipIf(!hasZig)("an unreadable selection is refused for launches, naming the reset", () => {
	const i = install([R2], { selection: "{not json" });
	refused(i, run(i, []), join("dsh-bin", "state", "selection.json"), "dsh manager select --use latest");
	select(i, { schema: 9, use: "latest" });
	refused(i, run(i, []), "unsupported schema");
});

// ── Runtime format ───────────────────────────────────────────────────────────────────────────────────

test.skipIf(!hasZig)("RB-LEGACY: an old coupled bundle, another protocol, a missing entry are refused without running anything", () => {
	const i = install([R2]);
	addRuntime(i.data, R1, { ...SPECS[R1], raw: JSON.stringify({ schemaVersion: 2, name: "dsh-bin", version: R1, channel: "release", launcherProtocol: 2, run: 10, attempt: 1, upstream: { commitTime: "2026-09-28T10:00:00.000Z" } }) });
	refused(i, run(i, ["--use", R1]), R1, "not in the supported runtime format");
	addRuntime(i.data, L1, { ...SPECS[L1], patch: { launchProtocol: 1 } });
	refused(i, run(i, ["--use", L1]), "needs launch protocol 1", "self-update");
	addRuntime(i.data, R2B, { ...SPECS[R2B], entry: false });
	refused(i, run(i, ["--use", R2B]), "is incomplete", `dsh manager install ${R2B} --force`);
	// latest never skips an unorderable runtime silently.
	const broken = install([R2]);
	addRuntime(broken.data, R1, { raw: "{" });
	refused(broken, run(broken, []), R1, `dsh manager install ${R1} --force`);
});

test.skipIf(!hasZig)("an entry naming a path outside the runtime is not run", () => {
	const i = install([R2]);
	addRuntime(i.data, R1, { ...SPECS[R1], patch: { entry: "../x" } });
	refused(i, run(i, ["--use", R1]), "declares no entry");
});

// ── Environment ──────────────────────────────────────────────────────────────────────────────────────

test.skipIf(!hasZig)("environment: launch payload and DSH_HOME in the data root; user variables kept; stale markers cleared", () => {
	const i = install([R2]);
	run(i, [], { env: { DSH_TUI_STANDALONE: "1", DSH_TUI_STANDALONE_BINARY: "/b", BUN_BE_BUN: "1", KEEP: "k", DSH_BIN_LAUNCH: "{}", DSH_MANAGER_LAUNCH: '{"runtime":"stale"}' } });
	const seen = envOf(i);
	expect(seen.KEEP).toBe("k");
	for (const name of ["DSH_TUI_STANDALONE", "DSH_TUI_STANDALONE_BINARY", "BUN_BE_BUN", "DSH_BIN_LAUNCH"]) expect(seen[name]).toBeUndefined();
	expect(seen.DSH_HOME).toBe(join(i.data, "home"));
	expect(launchOf(i)).toMatchObject({ runtime: R2, dataRoot: i.data, home: join(i.data, "home"), addons: {} });
	expect(launchOf(i).addons).toEqual({});
});

test.skipIf(!hasZig)("DSH_HOME: a non-blank value wins (`~` expanded, relative to the cwd); blank means the default", () => {
	const i = install([R2]);
	const cwd = tempDir("dsh-cwd-");
	for (const [value, expected] of [[" ", join(i.data, "home")], ["~/alt", join(i.home, "alt")], ["rel", join(cwd, "rel")]] as const) {
		run(i, [], { env: { DSH_HOME: value }, cwd });
		expect(envOf(i).DSH_HOME).toBe(expected);
		expect(launchOf(i).home).toBe(expected);
		expect(launchOf(i).dataRoot).toBe(i.data);
	}
});

test.skipIf(!hasZig || WIN)("PS-SYMLINK: a symlinked entry from another cwd uses the real manager's data root", () => {
	const i = install([R2]);
	const link = join(tempDir("dsh-link-"), "dsh");
	symlinkSync(i.exe, link);
	const cwd = tempDir("dsh-project-");
	expect(spawnSync(link, ["a"], { cwd, env: baseEnv(i) }).status).toBe(0);
	expect(argvOf(i)).toEqual(["a"]);
	expect(launchOf(i).dataRoot).toBe(i.data);
	expect(cwdOf(i)).toBe(cwd);
});

test.skipIf(!hasZig)("the manager embeds a byte-readable version marker", () => {
	expect(readFileSync(build().manager).includes(`DSH_MANAGER_VERSION=${MANAGER_VERSION}\0`)).toBe(true);
});

test.skipIf(!hasZig)("FB-OFFLINE review: filesystem metadata leaves intact runtime launch/list/version usable offline", () => {
	const i = install([R2]);
	for (const name of [".DS_Store", `._${R2}`, "Thumbs.db", "desktop.ini"]) writeFileSync(join(i.data, "bundles", name), "filesystem metadata");
	const env = { DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_ORIGIN: "http://127.0.0.1:1" };
	expect(run(i, ["probe"], { env }).status).toBe(0);
	expect(launchOf(i).runtime).toBe(R2);
	const list = run(i, ["manager", "list"], { env });
	expect(list.status).toBe(0); expect(list.stdout).toContain(R2); expect(started(i)).toBe(false);
	expect(run(i, ["--version"], { env }).status).toBe(0);
});

// ── Usage claim ──────────────────────────────────────────────────────────────────────────────────────

async function waitStarted(i: Install) {
	for (let n = 0; n < 250 && !started(i); n++) await Bun.sleep(20);
	expect(started(i)).toBe(true);
}

test.skipIf(!hasZig)("the running runtime holds the shared claim until it exits; manager commands take none", async () => {
	const i = install([R2]);
	const guard = join(i.data, "bundles", R2, ".usage.lock");
	rmSync(join(i.out, "1.argv"), { force: true });
	const proc = Bun.spawn([i.exe], { env: { ...baseEnv(i), FAKE_HOLD: "1" }, stdout: "ignore", stderr: "inherit" });
	await waitStarted(i);
	expect(acquireClaim(guard, "exclusive")).toBe("busy");
	proc.kill("SIGKILL");
	await proc.exited;
	let claim = acquireClaim(guard, "exclusive");
	for (let n = 0; n < 50 && claim === "busy"; n++) {
		await Bun.sleep(100);
		claim = acquireClaim(guard, "exclusive");
	}
	expect(claim).not.toBe("busy");
	if (claim !== "busy") claim.release();
	expect(run(i, ["manager", "list"]).status).toBe(0);
	expect(started(i)).toBe(false);
});

test.skipIf(!hasZig)("MC-CONFIG-SELECT / MC-AMBIGUOUS: dual launch transport, symmetric version intent, no state writes", () => {
	const i = install([R2, R1], { selection: { schema: 1, use: R1, snapshot: `${R1}@7`, configSnapshot: `${R1}@7`, addons: {} } });
	for (const kind of ["snapshots", "config-snapshots"]) for (const [id, n] of [[R2, 2], [R1, 7]] as const) {
		const dir = join(i.data, kind, `${id}@${n}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "snapshot.json"), JSON.stringify({ id: `${id}@${n}`, version: id, n }));
		writeFileSync(join(dir, ".usage.lock"), "");
	}
	const selectionPath = join(i.data, "state", "selection.json"), before = readFileSync(selectionPath);
	expect(run(i, ["--config-snapshot", `${R2}@2`, "--profile", "tui", "--snapshot", "untouched"]).status).toBe(0);
	expect(argvOf(i)).toEqual(["--profile", "tui", "--snapshot", "untouched"]);
	expect(launchOf(i)).toMatchObject({ protocol: 2, runtime: R2, snapshot: { id: `${R2}@2`, dir: join(i.data, "snapshots", `${R2}@2`) }, configSnapshot: { id: `${R2}@2`, dir: join(i.data, "config-snapshots", `${R2}@2`) }, tmp: join(i.data, "tmp") });
	refused(i, run(i, ["--snapshot", `${R2}@2`, "--config-snapshot", `${R1}@7`]), "different versions", "--use");
	expect(run(i, ["--use", R1, "--snapshot", `${R2}@2`, "--config-snapshot", `${R1}@7`]).status).toBe(0);
	expect(launchOf(i)).toMatchObject({ runtime: R1, snapshot: { id: `${R2}@2` }, configSnapshot: { id: `${R1}@7` } });
	expect(readFileSync(selectionPath)).toEqual(before);
});

test.skipIf(!hasZig)("MC-TYPED: persisted dual pins, canonical aliases and dropped single-shot dimensions", () => {
	const i = install([R2, R1]);
	for (const root of ["snapshots", "config-snapshots"]) for (const [version, n, alias] of [[R2, 1, "keep"], [R2, 2, "new"], [R1, 1, "keep"]] as const) {
		const dir = join(i.data, root, `${version}@${n}`); mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "snapshot.json"), JSON.stringify({ id: `${version}@${n}`, version, n, alias })); writeFileSync(join(dir, ".usage.lock"), "");
	}
	expect(run(i, ["manager", "select", "--use", R1, "--snapshot", `${R2}@keep`, "--config-snapshot", `${R2}@new`]).status).toBe(0);
	const path = join(i.data, "state", "selection.json"), saved = readFileSync(path);
	expect(run(i, ["probe"]).status).toBe(0);
	expect(launchOf(i)).toMatchObject({ runtime: R1, snapshot: { id: `${R2}@1` }, configSnapshot: { id: `${R2}@2` } });
	expect(run(i, ["--snapshot", "0.1.7@keep", "--config-snapshot", `${R2}@new`, "probe"]).status).toBe(0);
	expect(launchOf(i)).toMatchObject({ runtime: R2, snapshot: { id: `${R2}@1` }, configSnapshot: { id: `${R2}@2` } });
	expect(run(i, ["--use", R1, "probe"]).status).toBe(0);
	expect(launchOf(i)).toMatchObject({ runtime: R1, snapshot: { id: `${R1}@1` }, configSnapshot: { id: `${R1}@1` } });
	expect(run(i, ["--snapshot", `${R2}@keep`, "probe"]).status).toBe(0);
	expect(launchOf(i)).toMatchObject({ runtime: R2, configSnapshot: { id: `${R2}@2` } });
	expect(readFileSync(path)).toEqual(saved);
});
