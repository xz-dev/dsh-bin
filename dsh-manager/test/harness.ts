// Black-box harness for the manager: builds the real Zig binary once, and makes isolated installs
// (manager file + its data root) with fake runtime bundles that record how they were started.
// Scenario IDs from openspec/changes/split-dsh-manager/specs appear in the test names.
import { execFileSync, spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const MANAGER_DIR = resolve(import.meta.dir, "..");
export const WIN = process.platform === "win32";
export const EXE = WIN ? ".exe" : "";
export const hasZig = Bun.which("zig") !== null;
export const MANAGER_VERSION = "9.8.7-test.1";

const made: string[] = [];
export function tempDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	made.push(dir);
	return dir;
}
export function cleanup() {
	for (const dir of made.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// A Windows child still sleeping keeps its directory until it exits.
		}
	}
}

let built: { manager: string; fake: string } | undefined;
const builds: string[] = [];
process.on("exit", () => {
	for (const dir of builds) rmSync(dir, { recursive: true, force: true });
});
/** Build the manager (and the fake runtime entry) once per test process; kept until the process exits. */
export function build(version = MANAGER_VERSION): { manager: string; fake: string } {
	if (built && version === MANAGER_VERSION) return built;
	const prefix = realpathSync(mkdtempSync(join(tmpdir(), "dsh-manager-build-")));
	builds.push(prefix);
	execFileSync("zig", ["build", `-Dversion=${version}`, "--prefix", prefix], { cwd: MANAGER_DIR, stdio: "inherit" });
	const fake = join(prefix, `dsh-native${EXE}`);
	execFileSync("zig", ["build-exe", join(import.meta.dir, "fake-native.zig"), "-OReleaseSmall", `-femit-bin=${fake}`], { cwd: prefix, stdio: "inherit" });
	const r = { manager: join(prefix, "bin", `dsh${EXE}`), fake };
	if (version === MANAGER_VERSION) built = r;
	return r;
}

export type Install = { dir: string; exe: string; data: string; out: string; home: string };

/** A directory holding only the manager binary; `data` is its (not yet created) portable data root. */
export function newInstall(manager = build().manager): Install {
	const base = tempDir("dsh-manager-");
	const dir = join(base, "tools");
	const out = join(base, "out");
	const home = join(base, "userhome");
	for (const d of [dir, out, home]) mkdirSync(d, { recursive: true });
	const exe = join(dir, `dsh${EXE}`);
	cpSync(manager, exe);
	chmodSync(exe, 0o755);
	return { dir, exe, data: join(dir, "dsh-bin"), out, home };
}

export type RuntimeSpec = {
	channel?: "release" | "live";
	commitTime?: string;
	run?: number;
	attempt?: number;
	/** Overrides of the bundle.json fields (e.g. `launchProtocol: 1`), or raw text. */
	patch?: Record<string, unknown>;
	raw?: string;
	entry?: boolean;
	completion?: unknown;
};

export const bundleMeta = (id: string, spec: RuntimeSpec = {}) => ({
	kind: "dsh-runtime",
	schemaVersion: 1,
	id,
	channel: spec.channel ?? "release",
	target: "test",
	upstream: { commit: "c".repeat(40), commitTime: spec.commitTime ?? "2026-09-01T00:00:00.000Z", version: id.split("-")[0] },
	run: spec.run ?? 1,
	attempt: spec.attempt ?? 1,
	builderCommit: "d".repeat(40),
	launchProtocol: 2,
	entry: `dsh-native${EXE}`,
	requiredPaths: [`dsh-native${EXE}`, "bundle.json"],
	addons: { office: { slot: null, pinned: null, known: [] } },
	...spec.patch,
});

/** An installed runtime `data/bundles/<id>/` whose entry is the recording fake. */
export function addRuntime(data: string, id: string, spec: RuntimeSpec = {}) {
	mkdirSync(data, { recursive: true });
	writeFileSync(join(data, ".dsh-bin-data.json"), JSON.stringify({ kind: "dsh-manager-data", schema: 1 }));
	const dir = join(data, "bundles", id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "bundle.json"), spec.raw ?? JSON.stringify(bundleMeta(id, spec)));
	writeFileSync(join(dir, ".usage.lock"), "");
	if (spec.completion !== undefined) writeFileSync(join(dir, "completion.json"), JSON.stringify(spec.completion));
	if (spec.entry !== false) {
		cpSync(build().fake, join(dir, `dsh-native${EXE}`));
		chmodSync(join(dir, `dsh-native${EXE}`), 0o755);
	}
}

/** Variables every child needs on this host; PATH holds no JS runtime. */
export function baseEnv(i: Pick<Install, "home" | "out">): Record<string, string> {
	const env: Record<string, string> = { PATH: emptyPath(), HOME: i.home, USERPROFILE: i.home, FAKE_OUT: i.out };
	for (const k of ["SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP"]) if (process.env[k]) env[k] = process.env[k]!;
	return env;
}
let emptyBin: string | undefined;
const emptyPath = () => (emptyBin ??= tempDir("dsh-empty-path-"));

export type Run = SpawnSyncReturns<string>;
export function run(i: Install, args: string[], opts: { env?: Record<string, string>; cwd?: string; input?: string; exe?: string } = {}): Run {
	for (const g of ["1", "2"]) rmSync(join(i.out, `${g}.argv`), { force: true });
	return spawnSync(opts.exe ?? i.exe, args, { encoding: "utf8", cwd: opts.cwd ?? i.home, input: opts.input, env: { ...baseEnv(i), ...opts.env }, timeout: 30_000 });
}

/** Controlled fake session: graceful stdin release also lets Windows' waiting manager exit. */
export async function holdSession(i: Install, args: string[] = [], env: Record<string, string> = {}) {
	for (const g of ["1", "2"]) rmSync(join(i.out, `${g}.ready`), { force: true });
	const proc = spawn(i.exe, args, { cwd: i.home, env: { ...baseEnv(i), FAKE_HOLD_STDIN: "1", ...env }, stdio: "pipe" });
	let stderr = ""; proc.stderr.on("data", b => { stderr += b.toString(); }); proc.stdout.resume();
	const done = new Promise<number | null>((resolve, reject) => { proc.on("close", resolve); proc.on("error", reject); });
	const timer = setTimeout(() => proc.kill("SIGKILL"), 20_000);
	done.finally(() => clearTimeout(timer));
	const wait = async (gen = "1") => {
		const deadline = Date.now() + 5000;
		while (!existsSync(join(i.out, `${gen}.ready`)) && proc.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
		if (!existsSync(join(i.out, `${gen}.ready`))) throw new Error(`fake session did not become ready: ${stderr}`);
	};
	try { await wait(); } catch (err) { proc.stdin.end(); await done; throw err; }
	return { proc, wait, finish: async () => { if (proc.exitCode === null) proc.stdin.end("x"); return await done; } };
}

export const started = (i: Install) => existsSync(join(i.out, "1.argv"));
export const argvOf = (i: Install, gen = "1") => readFileSync(join(i.out, `${gen}.argv`), "utf8").split("\n").slice(0, -1);
export function envOf(i: Install, gen = "1"): Record<string, string> {
	const lines = readFileSync(join(i.out, `${gen}.env`), "utf8").split("\n").filter(Boolean);
	return Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}
export const cwdOf = (i: Install, gen = "1") => readFileSync(join(i.out, `${gen}.cwd`), "utf8");
export const launchOf = (i: Install, gen = "1") => JSON.parse(envOf(i, gen).DSH_MANAGER_LAUNCH);

/** Try the attack, not a skip: Windows may protect the open validated directory from rename. */
export function replaceAncestor(root: string, external: string): string {
	const original = `${root}-original`;
	try { renameSync(root, original); }
	catch (err) {
		if (!WIN || (err as NodeJS.ErrnoException).code !== "EPERM") throw err;
		console.info(`ancestor swap blocked by Windows EPERM for open validated directory: ${root}`);
		return root;
	}
	symlinkSync(external, root, WIN ? "junction" : "dir");
	return original;
}

/** Every path under `dir`, relative, sorted (for "nothing was created" assertions). */
export function tree(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	const walk = (d: string, rel: string) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const r = rel ? `${rel}/${e.name}` : e.name;
			out.push(r);
			if (e.isDirectory()) walk(join(d, e.name), r);
		}
	};
	walk(dir, "");
	return out.sort();
}
