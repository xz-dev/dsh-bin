// Launcher tests (launcher spec, version-selection "Selection resolution"/"Leading launch options"/"Managed
// installations") on the host platform, Windows included: a fake `dsh-native` (fake-native.zig) records the
// arguments and environment it gets.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireClaim } from "../../runtime/usage-claim.ts";

const LAUNCHER_DIR = resolve(import.meta.dir, "../../launcher");
const WIN = process.platform === "win32";
const EXE = WIN ? ".exe" : "";
const hasZig = Bun.which("zig") !== null;
let built: string;
let fake: string;
const made: string[] = [];
const tempDir = (prefix: string) => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	made.push(dir);
	return dir;
};

afterAll(() => {
	for (const dir of made) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// A Windows fake still sleeping in a killed launcher's tree keeps its directory until it exits.
		}
	}
});

beforeAll(() => {
	if (!hasZig) return;
	const prefix = tempDir("dsh-launcher-build-");
	execFileSync("zig", ["build", "-Dversion=1.2.3-xz.1.1.gabcdef12", "-Dchannel=release", "--prefix", prefix], { cwd: LAUNCHER_DIR, stdio: "inherit" });
	built = join(prefix, "bin", `dsh${EXE}`);
	fake = join(prefix, `dsh-native${EXE}`);
	execFileSync("zig", ["build-exe", join(import.meta.dir, "fake-native.zig"), "-OReleaseSmall", `-femit-bin=${fake}`], { cwd: prefix, stdio: "inherit" });
}, 300_000);

const R2 = "0.1.7-rc.2-xz.7.1.g4e41a3f1";
const R2B = "0.1.7-rc.2-xz.21.1.g4e41a3f1";
const R1 = "0.2.0-rc.1-xz.10.1.ga83dab63";
const L1 = "0.2.1-xz.11.1.gdeadbeef";
type Spec = { channel?: "release" | "live"; time?: string; run?: number; attempt?: number; protocol?: number | null; native?: boolean; meta?: string };
const SPECS: Record<string, Spec> = {
	[R2]: { time: "2026-09-24T10:00:00.000Z", run: 7 },
	[R2B]: { time: "2026-09-24T10:00:00.000Z", run: 21 },
	[R1]: { time: "2026-09-28T10:00:00.000Z", run: 10 },
	[L1]: { channel: "live", time: "2026-09-29T10:00:00.000Z", run: 11 },
};

type Root = { root: string; home: string; out: string };

function addBundle(root: string, version: string, spec: Spec = SPECS[version] ?? {}) {
	const dir = join(root, "bundles", version);
	mkdirSync(dir, { recursive: true });
	const meta = {
		schemaVersion: 2,
		name: "dsh-bin",
		version,
		channel: spec.channel ?? "release",
		upstream: { commit: "c".repeat(40), commitTime: spec.time ?? "2026-09-01T00:00:00.000Z", version: "0.1.7-rc.2" },
		run: spec.run ?? 1,
		attempt: spec.attempt ?? 1,
		...(spec.protocol === null ? {} : { launcherProtocol: spec.protocol ?? 2 }),
	};
	writeFileSync(join(dir, "bundle.json"), spec.meta ?? JSON.stringify(meta));
	writeFileSync(join(dir, ".usage.lock"), "");
	if (spec.native !== false) {
		cpSync(fake, join(dir, `dsh-native${EXE}`));
		chmodSync(join(dir, `dsh-native${EXE}`), 0o755);
	}
}

/** An install root with the launcher and the given bundles, a DSH_HOME and an output directory for the fake. */
function install(versions: string[] = [R2, R1], opts: { channel?: string; selection?: unknown; managed?: string } = {}): Root {
	// Real path: the launcher resolves its own executable (macOS tmpdir is a /var -> /private/var symlink).
	const base = tempDir("dsh-launcher-");
	const root = join(base, "root");
	const home = join(base, "home");
	const out = join(base, "out");
	for (const d of [root, home, out]) mkdirSync(d, { recursive: true });
	cpSync(built, join(root, `dsh${EXE}`));
	for (const v of versions) addBundle(root, v);
	if (opts.channel) writeFileSync(join(root, "channel"), `${opts.channel}\n`);
	if (opts.selection !== undefined) select({ home }, opts.selection);
	if (opts.managed) writeFileSync(join(root, `.${opts.managed}.managed.lock`), "");
	return { root, home, out };
}

function select(r: Pick<Root, "home">, selection: unknown) {
	mkdirSync(join(r.home, "dsh-bin"), { recursive: true });
	writeFileSync(join(r.home, "dsh-bin", "selection.json"), typeof selection === "string" ? selection : JSON.stringify(selection));
}

/** Variables every child needs on this host (Windows cannot start processes without SystemRoot). */
function baseEnv(): Record<string, string> {
	const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
	for (const k of ["SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP"]) if (process.env[k]) env[k] = process.env[k]!;
	return env;
}

function run(r: Root, args: string[], env: Record<string, string> = {}) {
	for (const g of ["1", "2"]) rmSync(join(r.out, `${g}.argv`), { force: true });
	return spawnSync(join(r.root, `dsh${EXE}`), args, { encoding: "utf8", env: { ...baseEnv(), DSH_HOME: r.home, FAKE_OUT: r.out, ...env } });
}

const argvOf = (r: Root, gen = "1") => readFileSync(join(r.out, `${gen}.argv`), "utf8").split("\n").slice(0, -1);
function envOf(r: Root, gen = "1"): Record<string, string> {
	const lines = readFileSync(join(r.out, `${gen}.env`), "utf8").split("\n").filter(Boolean);
	return Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}
const launchOf = (r: Root, gen = "1") => JSON.parse(envOf(r, gen).DSH_BIN_LAUNCH);
const started = (r: Root) => existsSync(join(r.out, "1.argv"));

/** One diagnostic line, nothing started, nothing on stdout. */
function refused(r: Root, res: ReturnType<typeof run>, ...parts: string[]) {
	expect(res.status).toBe(1);
	expect(res.stdout).toBe("");
	expect(res.stderr.trim().split("\n")).toHaveLength(1);
	for (const p of parts) expect(res.stderr).toContain(p);
	expect(started(r)).toBe(false);
}

// ── Selection-based dispatch ─────────────────────────────────────────────────────────────────────────

test.skipIf(!hasZig)("arguments and exit status pass through; leading options are removed", () => {
	const r = install();
	const args = ["--profile", "tui", "--resume", "abc", "with space", ""];
	const res = run(r, ["--use", "0.1.7-rc.2", ...args], { FAKE_EXIT: "3" });
	expect(res.status).toBe(3);
	expect(argvOf(r)).toEqual(args);
	expect(envOf(r).DSH_BUNDLE_VERSION).toBe(R2);
	expect(launchOf(r)).toMatchObject({ protocol: 2, version: R2, source: "use", use: "0.1.7-rc.2", snapshot: null, addons: [] });
});

test.skipIf(!hasZig)("--opt=value forms, repeated --addon, and arguments after the first other argument", () => {
	const r = install();
	expect(run(r, ["--snapshot=0.1.7-rc.2@2", "--addon", "office:0.1.1", "--addon=office:0.1.2", "plugin", "--use", "x"]).status).toBe(0);
	expect(argvOf(r)).toEqual(["plugin", "--use", "x"]);
	expect(launchOf(r)).toMatchObject({ version: R2, source: "snapshot", snapshot: "0.1.7-rc.2@2", addons: ["office:0.1.1", "office:0.1.2"] });
});

test.skipIf(!hasZig)("prompt text is not parsed; the selection is used", () => {
	const r = install([R2, R1], { selection: { schema: 1, use: R2, snapshot: null, addons: {} } });
	expect(run(r, ["-p", "--use 1"]).status).toBe(0);
	expect(argvOf(r)).toEqual(["-p", "--use 1"]);
	expect(launchOf(r)).toMatchObject({ version: R2, source: "selection", use: null, selection: { use: R2 } });
});

test.skipIf(!hasZig)("--use overrides the version implied by --snapshot; tags and unique prefixes name versions", () => {
	const r = install();
	run(r, ["--use", "0.2.0-rc.1", "--snapshot", "0.1.7-rc.2@2"]);
	expect(launchOf(r)).toMatchObject({ version: R1, source: "use", snapshot: "0.1.7-rc.2@2" });
	run(r, ["--use", `dsh-v${R2}`]);
	expect(envOf(r).DSH_BUNDLE_VERSION).toBe(R2);
});

test.skipIf(!hasZig)("latest: last in version order of the recorded channel", () => {
	const r = install([R2B, L1, R2, R1]);
	run(r, []);
	expect(envOf(r).DSH_BUNDLE_VERSION).toBe(R1);
	expect(envOf(r).DSH_BUNDLE_CHANNEL).toBe("release");
	expect(launchOf(r)).toMatchObject({ version: R1, source: "selection", selection: null });
	writeFileSync(join(r.root, "channel"), "live\n");
	run(r, []);
	expect(envOf(r).DSH_BUNDLE_VERSION).toBe(L1);
	expect(envOf(r).DSH_BUNDLE_CHANNEL).toBe("live");
	// Rebuild of one upstream commit: the later run wins.
	const rebuilt = install([R2B, R2], { selection: { schema: 1, use: "latest", snapshot: null, addons: {} } });
	run(rebuilt, []);
	expect(envOf(rebuilt).DSH_BUNDLE_VERSION).toBe(R2B);
});

test.skipIf(!hasZig)("latest with no bundle of the recorded channel fails; no fallback", () => {
	const r = install([R2, R1], { channel: "live" });
	refused(r, run(r, []), "no live-channel dsh version is installed", "dsh update");
});

test.skipIf(!hasZig)("selected bundle missing: one diagnostic naming the version and `dsh install`, no fallback", () => {
	const pinned = install([R1], { selection: { schema: 1, use: R2, snapshot: null, addons: {} } });
	refused(pinned, run(pinned, ["--version"]), R2, `dsh install ${R2}`, "dsh select --use latest");

	const r = install([R1]);
	addBundle(r.root, R2, { ...SPECS[R2], native: false });
	refused(r, run(r, ["--use", R2]), R2, `dsh install ${R2}`, join("bundles", R2, `dsh-native${EXE}`));
	refused(r, run(r, ["--use", "0.1.5"]), "0.1.5", "dsh install 0.1.5");
	refused(r, run(r, ["--snapshot", "0.1.5@1"]), "0.1.5", "dsh install 0.1.5");
	refused(r, run(r, ["--snapshot", "nover"]), "invalid snapshot id nover");
	refused(r, run(r, ["--use"]), "--use needs a value");
});

test.skipIf(!hasZig)("a bundle of another launcher protocol is refused, naming the reinstall command", () => {
	const r = install([R2]);
	addBundle(r.root, R1, { ...SPECS[R1], protocol: 3 });
	refused(r, run(r, ["--use", R1]), `dsh ${R1} needs launcher protocol 3`, `dsh install ${R1} --force`);
	addBundle(r.root, L1, { ...SPECS[L1], protocol: null });
	refused(r, run(r, ["--use", L1]), "declares no launcher protocol", `dsh install ${L1} --force`);
	// An unreadable bundle.json cannot take part in version order: latest refuses instead of guessing.
	const broken = install([R2]);
	addBundle(broken.root, R1, { meta: "{" });
	refused(broken, run(broken, []), R1, `dsh install ${R1} --force`);
});

test.skipIf(!hasZig)("an unreadable selection is refused for launches", () => {
	const r = install([R2], { selection: "{not json" });
	refused(r, run(r, []), join("dsh-bin", "selection.json"), "dsh select --use latest");
	select(r, { schema: 9, use: "latest" });
	refused(r, run(r, []), "unsupported selection");
});

// ── Maintenance commands ─────────────────────────────────────────────────────────────────────────────

test.skipIf(!hasZig)("maintenance commands with a missing pin run on the newest installed bundle", () => {
	const r = install([R2, L1, R1], { selection: { schema: 1, use: "0.1.5", snapshot: null, addons: {} } });
	for (const args of [["select", "--use", "latest"], ["install", "0.1.5"], ["list"], ["uninstall", R2], ["update"], ["snapshot", "list"]]) {
		const res = run(r, args);
		expect(res.status).toBe(0);
		expect(argvOf(r)).toEqual(args);
		// Newest of any channel this launcher can start.
		expect(envOf(r).DSH_BUNDLE_VERSION).toBe(L1);
		expect(launchOf(r)).toMatchObject({ version: null, source: null, selection: { use: "0.1.5" } });
	}
	// A broken selection or bundle never blocks the commands that repair it.
	select(r, "{not json");
	addBundle(r.root, "9.9.9", { time: "2027-01-01T00:00:00.000Z", protocol: 3 });
	expect(run(r, ["select", "--use", "latest"]).status).toBe(0);
	expect(envOf(r).DSH_BUNDLE_VERSION).toBe(L1);
	expect(launchOf(r)).toMatchObject({ version: null, selection: null });
});

test.skipIf(!hasZig)("maintenance commands carry the leading options' resolved version", () => {
	const r = install([R2, R1]);
	expect(run(r, ["--use", "0.1.7-rc.2", "snapshot", "new"]).status).toBe(0);
	expect(argvOf(r)).toEqual(["snapshot", "new"]);
	expect(envOf(r).DSH_BUNDLE_VERSION).toBe(R1);
	expect(launchOf(r)).toMatchObject({ version: R2, source: "use", use: "0.1.7-rc.2" });
});

// ── Managed installations ────────────────────────────────────────────────────────────────────────────

test.skipIf(!hasZig)("managed: the stored version pin is ignored, --use/--addon are refused naming the manager, --snapshot works", () => {
	const r = install([R1], { managed: "portage", selection: { schema: 1, use: R2, snapshot: null, addons: {} } });
	expect(run(r, []).status).toBe(0);
	expect(launchOf(r)).toMatchObject({ version: R1, source: "managed", selection: { use: R2 } });
	refused(r, run(r, ["--use", R2]), "--use", "managed by portage");
	refused(r, run(r, ["--addon", "office:0.1.1", "list"]), "--addon", "managed by portage");
	expect(run(r, ["--snapshot", "0.1.7-rc.2@2", "--profile", "tui"]).status).toBe(0);
	expect(argvOf(r)).toEqual(["--profile", "tui"]);
	expect(launchOf(r)).toMatchObject({ version: R1, source: "managed", snapshot: "0.1.7-rc.2@2" });
	// A managed selection may hold only a snapshot.
	select(r, { schema: 1, snapshot: `${R1}@2`, addons: {} });
	expect(run(r, []).status).toBe(0);
	expect(launchOf(r)).toMatchObject({ version: R1, selection: { snapshot: `${R1}@2` } });

	const scoop = install([R1], { managed: "scoop" });
	refused(scoop, run(scoop, ["--use", "0.1.7-rc.2"]), "managed by scoop");
});

// ── Restart ──────────────────────────────────────────────────────────────────────────────────────────

// The launcher's half of "Restart after a selection change": the resolved version travels in
// DSH_BIN_LAUNCH, which a direct respawn of `dsh-native` (upstream restarts re-execute process.execPath)
// inherits even though the selection changed; the runtime's reuse of it is task 4.3.
test.skipIf(!hasZig)("restart after a selection change keeps the resolved version and arguments", () => {
	const r = install([R2, R1], { selection: { schema: 1, use: R2, snapshot: `${R2}@1`, addons: {} } });
	const other = JSON.stringify({ schema: 1, use: R1, snapshot: null, addons: {} });
	const res = run(r, ["--profile", "tui"], { FAKE_RESTART_WRITE: join(r.home, "dsh-bin", "selection.json"), FAKE_RESTART_DATA: other, FAKE_EXIT: "4" });
	expect(res.status).toBe(4);
	expect(argvOf(r, "2")).toEqual(["--profile", "tui"]);
	expect(envOf(r, "2").DSH_BUNDLE_VERSION).toBe(R2);
	expect(launchOf(r, "2")).toEqual(launchOf(r, "1"));
	expect(launchOf(r, "2")).toMatchObject({ version: R2, source: "selection", selection: { use: R2, snapshot: `${R2}@1` } });
	// A fresh launch sees the new selection.
	run(r, []);
	expect(envOf(r).DSH_BUNDLE_VERSION).toBe(R1);
});

// ── Environment ──────────────────────────────────────────────────────────────────────────────────────

test.skipIf(!hasZig)("environment contract; DSH_HOME and user variables untouched; an inherited DSH_BIN_LAUNCH is replaced", () => {
	const r = install([R2], { channel: "live" });
	addBundle(r.root, L1);
	run(r, [], { DSH_TUI_STANDALONE: "1", DSH_TUI_STANDALONE_BINARY: "/b", BUN_BE_BUN: "1", KEEP: "k", DSH_BIN_LAUNCH: '{"version":"stale"}' });
	const seen = envOf(r);
	expect(seen.DSH_BUNDLE_ROOT).toBe(r.root);
	expect(seen.DSH_BUNDLE_VERSION).toBe(L1);
	expect(seen.DSH_BUNDLE_LAUNCHER).toBe(join(r.root, `dsh${EXE}`));
	expect(seen.DSH_BUNDLE_CHANNEL).toBe("live");
	expect(seen.DSH_HOME).toBe(r.home);
	expect(seen.KEEP).toBe("k");
	expect(launchOf(r).version).toBe(L1);
	for (const name of ["DSH_TUI_STANDALONE", "DSH_TUI_STANDALONE_BINARY", "BUN_BE_BUN"]) expect(seen[name]).toBeUndefined();
});

test.skipIf(!hasZig)("DSH_HOME: upstream's rule (blank means unset, `~` expands, default ~/.dsh)", () => {
	const r = install([R2, R1]);
	const user = join(r.home, "..", "user");
	const pin = { schema: 1, use: R2, snapshot: null, addons: {} };
	mkdirSync(join(user, ".dsh", "dsh-bin"), { recursive: true });
	writeFileSync(join(user, ".dsh", "dsh-bin", "selection.json"), JSON.stringify(pin));
	mkdirSync(join(user, "alt", "dsh-bin"), { recursive: true });
	writeFileSync(join(user, "alt", "dsh-bin", "selection.json"), JSON.stringify({ ...pin, use: R1 }));
	const homeVars = { HOME: user, USERPROFILE: user };
	for (const [dshHome, expected] of [[" ", R2], ["~/alt", R1], [join(user, "alt"), R1]] as const) {
		run(r, [], { ...homeVars, DSH_HOME: dshHome });
		expect(envOf(r).DSH_BUNDLE_VERSION).toBe(expected);
	}
	const res = spawnSync(join(r.root, `dsh${EXE}`), [], { env: { ...baseEnv(), ...homeVars, FAKE_OUT: r.out } });
	expect(res.status).toBe(0);
	expect(envOf(r).DSH_BUNDLE_VERSION).toBe(R2);
});

test.skipIf(!hasZig || WIN)("transpiler cache: dsh-bin's user cache unless the user set one", () => {
	const r = install([R2]);
	const mac = process.platform === "darwin";
	run(r, [], { HOME: "/h", XDG_CACHE_HOME: "/xdg" });
	let seen = envOf(r);
	const cache = mac ? "/h/Library/Caches/dsh-bin" : "/xdg/dsh-bin";
	expect(seen.DSH_BUNDLE_CACHE).toBe(cache);
	expect(seen.BUN_RUNTIME_TRANSPILER_CACHE_PATH).toBe(`${cache}/transpiler`);

	run(r, [], { HOME: "/h", XDG_CACHE_HOME: "relative" });
	seen = envOf(r);
	expect(seen.DSH_BUNDLE_CACHE).toBe(mac ? "/h/Library/Caches/dsh-bin" : "/h/.cache/dsh-bin");

	run(r, [], { HOME: "/h", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" });
	expect(envOf(r).BUN_RUNTIME_TRANSPILER_CACHE_PATH).toBe("0");

	run(r, []);
	seen = envOf(r);
	expect(seen.DSH_BUNDLE_CACHE).toBeUndefined();
	expect(seen.BUN_RUNTIME_TRANSPILER_CACHE_PATH).toBeUndefined();
});

test.skipIf(!hasZig || WIN)("a symlinked launcher resolves the real install root", () => {
	const r = install([R2]);
	const link = join(tempDir("dsh-bin-link-"), "dsh");
	symlinkSync(join(r.root, "dsh"), link);
	expect(spawnSync(link, ["a"], { env: { ...baseEnv(), DSH_HOME: r.home, FAKE_OUT: r.out } }).status).toBe(0);
	expect(argvOf(r)).toEqual(["a"]);
});

test.skipIf(!hasZig)("the launcher embeds byte-readable version and protocol markers", async () => {
	const { launcherVersionOf } = await import("../../runtime/update/context.ts");
	const bytes = readFileSync(built);
	expect(launcherVersionOf(bytes)).toBe("1.2.3-xz.1.1.gabcdef12");
	expect(bytes.includes("DSH_BIN_LAUNCHER_PROTOCOL=2\0")).toBe(true);
});

// ── Usage claim ──────────────────────────────────────────────────────────────────────────────────────

async function waitStarted(r: Root) {
	for (let i = 0; i < 250 && !existsSync(join(r.out, "started")); i++) await Bun.sleep(20);
	expect(existsSync(join(r.out, "started"))).toBe(true);
}

test.skipIf(!hasZig)("the running bundle holds the shared claim until it exits", async () => {
	const r = install([R2]);
	const proc = Bun.spawn([join(r.root, `dsh${EXE}`)], { env: { ...baseEnv(), DSH_HOME: r.home, FAKE_OUT: r.out, FAKE_HOLD: "1" }, stdout: "ignore", stderr: "inherit" });
	await waitStarted(r);
	const guard = join(r.root, "bundles", R2, ".usage.lock");
	expect(acquireClaim(guard, "exclusive")).toBe("busy");
	proc.kill("SIGKILL");
	await proc.exited;
	// On POSIX the claim lives in the exec'd runtime; on Windows in the launcher, whose kill releases it.
	let claim = acquireClaim(guard, "exclusive");
	for (let i = 0; i < 50 && claim === "busy"; i++) {
		await Bun.sleep(100);
		claim = acquireClaim(guard, "exclusive");
	}
	expect(claim).not.toBe("busy");
	if (claim !== "busy") claim.release();
});

test.skipIf(!hasZig)("maintenance commands run without the shared claim; everything else holds it", async () => {
	const r = install([R2]);
	const guard = join(r.root, "bundles", R2, ".usage.lock");
	const cases = [
		[["update", "--force"], false],
		[["list"], false],
		[["install", "--addon", "office"], false],
		[["select", "--use", "latest"], false],
		[["snapshot", "list"], false],
		[["--use", R2, "uninstall", R2], false],
		[["--profile", "update"], true],
	] as const;
	for (const [args, held] of cases) {
		const proc = Bun.spawn([join(r.root, `dsh${EXE}`), ...args], { env: { ...baseEnv(), DSH_HOME: r.home, FAKE_OUT: r.out, FAKE_HOLD: "1" }, stdout: "ignore", stderr: "inherit" });
		await waitStarted(r);
		const claim = acquireClaim(guard, "exclusive");
		expect(claim === "busy").toBe(held);
		if (claim !== "busy") claim.release();
		proc.kill("SIGKILL");
		await proc.exited;
		rmSync(join(r.out, "started"), { force: true });
	}
});
