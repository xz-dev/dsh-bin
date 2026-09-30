// The runtime consumes `DSH_MANAGER_LAUNCH` (split-dsh-manager D3, runtime-bundles "应用仅消费已确定的启动环境"
// and "重启保持当前运行上下文"). The app is a stub bin.js that reports what it sees, so no upstream build is
// needed. Snapshot creation and selection belong to the manager; the runtime never creates, picks or
// repairs anything.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { writeShims } from "../../scripts/shims.mjs";
import { acquireClaim } from "../../runtime/usage-claim.ts";

const ROOT = resolve(import.meta.dir, "../..");
const EXE = process.platform === "win32" ? ".exe" : "";
const RUNTIME = "0.2.0-rc.1-b10.1.ga83dab63";
let root: string;
let native: string;

// Stub app: reports argv, the snapshot dir, DSH_HOME, what the bundle's `node` shim sees and the launch; with
// STUB_HOLD it waits; with STUB_RESTART it respawns itself once as upstream's restartTui does (through
// node:child_process, which sees runtime changes to process.env).
const STUB_BIN = `import { spawnSync } from "node:child_process";
export async function runCli() {
	const launch = JSON.parse(process.env.DSH_MANAGER_LAUNCH ?? "null");
	const shim = spawnSync("node", ["-e", "process.stdout.write(process.env.DSH_BIN_SNAPSHOT_DIR ?? '-')"], { encoding: "utf8" }).stdout;
	process.stdout.write("REPORT " + JSON.stringify({ args: process.argv.slice(2), dir: process.env.DSH_BIN_SNAPSHOT_DIR ?? null, home: process.env.DSH_HOME ?? null, runtime: launch?.runtime ?? null, shim }) + "\\n");
	if (process.env.STUB_HOLD) { process.stdout.write("HELD\\n"); await Bun.sleep(30000); }
	if (process.env.STUB_RESTART) {
		const env = { ...process.env };
		delete env.STUB_RESTART;
		const p = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { env, stdio: "inherit" });
		process.exitCode = p.status ?? 1;
	}
}
`;

beforeAll(() => {
	// ~/.cache, not /tmp: the compiled entry is ~100 MB.
	const base = join(homedir(), ".cache");
	mkdirSync(base, { recursive: true });
	root = mkdtempSync(join(base, "dsh-runtime-launch-"));
	const bundle = join(root, "data", "bundles", RUNTIME);
	mkdirSync(join(bundle, "app", "lib"), { recursive: true });
	mkdirSync(join(bundle, "app", "node_modules"));
	writeFileSync(join(bundle, "app", "package.json"), '{"name":"stub-app","private":true}');
	native = join(bundle, `dsh-native${EXE}`);
	execFileSync("bun", [join(ROOT, "scripts/compile-entry.mjs"), `bun-${process.platform}-${process.arch}`, native], { stdio: "ignore" });
	writeFileSync(join(bundle, "app", "lib", "bin.js"), STUB_BIN);
	writeShims(bundle, process.platform === "win32" ? "windows" : process.platform);
	writeFileSync(join(bundle, ".usage.lock"), "");
}, 120_000);
afterAll(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

const data = () => join(root, "data");
function snapshot(id: string) {
	const dir = join(data(), "snapshots", id);
	mkdirSync(join(dir, "profiles"), { recursive: true });
	writeFileSync(join(dir, ".usage.lock"), "");
	return dir;
}
const launchOf = (home: string, snap: { id: string; dir: string } | null, extra: object = {}) =>
	JSON.stringify({ protocol: 1, runtime: RUNTIME, dataRoot: data(), home, snapshot: snap, addons: {}, cache: null, manager: "9.9.9", ...extra });

async function start(env: Record<string, string>, args: string[] = []) {
	const proc = Bun.spawn([native, ...args], { env: { PATH: process.env.PATH ?? "", HOME: root, NO_COLOR: "1", ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const reports = stdout.split("\n").filter((l) => l.startsWith("REPORT ")).map((l) => JSON.parse(l.slice(7)));
	return { code: await proc.exited, stdout, stderr, reports };
}

test("RB-HOME: the snapshot from the launch is the plugin dir; DSH_HOME is the given home; nothing is created", async () => {
	const home = mkdtempSync(join(root, "home-"));
	const dir = snapshot(`${RUNTIME}@1`);
	const before = readdirSync(data(), { recursive: true }).sort();
	const r = await start({ DSH_HOME: home, DSH_MANAGER_LAUNCH: launchOf(home, { id: `${RUNTIME}@1`, dir }) }, ["--profile", "tui"]);
	if (r.code !== 0) console.error(r.stderr);
	expect(r.code).toBe(0);
	expect(r.reports).toEqual([{ args: ["--profile", "tui"], dir, home, runtime: RUNTIME, shim: dir }]);
	expect(readdirSync(data(), { recursive: true }).sort()).toEqual(before);
	expect(readdirSync(home)).toEqual([]);
}, 60_000);

test("RB-HOME: the resolved launch home wins; a null snapshot does not inherit an old plugin directory", async () => {
	const home = mkdtempSync(join(root, "resolved-home-"));
	const r = await start({ DSH_HOME: join(root, "stale-home"), DSH_BIN_SNAPSHOT_DIR: join(root, "stale-snapshot"), DSH_MANAGER_LAUNCH: launchOf(home, null) });
	expect(r.code).toBe(0);
	expect(r.reports).toEqual([{ args: [], dir: null, home, runtime: RUNTIME, shim: "-" }]);
});

test("RB-RESTART: an in-app restart keeps the launch, the snapshot and its claim", async () => {
	const home = mkdtempSync(join(root, "home-"));
	const dir = snapshot(`${RUNTIME}@2`);
	const r = await start({ DSH_HOME: home, DSH_MANAGER_LAUNCH: launchOf(home, { id: `${RUNTIME}@2`, dir }), STUB_RESTART: "1" }, ["--profile", "tui"]);
	expect(r.code).toBe(0);
	expect(r.reports).toHaveLength(2);
	for (const rep of r.reports) expect(rep).toMatchObject({ args: ["--profile", "tui"], dir, runtime: RUNTIME });
}, 60_000);

test("a running session holds the runtime's and the snapshot's claims until it exits", async () => {
	const home = mkdtempSync(join(root, "home-"));
	const dir = snapshot(`${RUNTIME}@3`);
	const proc = Bun.spawn([native], { env: { PATH: process.env.PATH ?? "", HOME: root, DSH_HOME: home, DSH_MANAGER_LAUNCH: launchOf(home, { id: `${RUNTIME}@3`, dir }), STUB_HOLD: "1" }, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
	const reader = proc.stdout.getReader();
	let out = "";
	while (!out.includes("HELD")) {
		const { value, done } = await reader.read();
		if (done) break;
		out += new TextDecoder().decode(value);
	}
	expect(out).toContain("HELD");
	const guards = [join(dir, ".usage.lock"), join(data(), "bundles", RUNTIME, ".usage.lock")];
	for (const g of guards) expect(acquireClaim(g, "exclusive")).toBe("busy");
	proc.kill("SIGKILL");
	await proc.exited;
	for (const g of guards) {
		let c = acquireClaim(g, "exclusive");
		for (let i = 0; i < 30 && c === "busy"; i++) {
			await Bun.sleep(100);
			c = acquireClaim(g, "exclusive");
		}
		expect(c).not.toBe("busy");
		if (c !== "busy") c.release();
	}
}, 60_000);

test("a snapshot being removed or missing fails the launch with one diagnostic, never another snapshot", async () => {
	const home = mkdtempSync(join(root, "home-"));
	const missing = await start({ DSH_HOME: home, DSH_MANAGER_LAUNCH: launchOf(home, { id: `${RUNTIME}@9`, dir: join(data(), "snapshots", `${RUNTIME}@9`) }) });
	expect(missing.code).toBe(1);
	expect(missing.stdout).toBe("");
	expect(missing.stderr).toContain(`plugin snapshot ${RUNTIME}@9 does not exist`);
	expect(existsSync(join(data(), "snapshots", `${RUNTIME}@9`))).toBe(false);
	const dir = snapshot(`${RUNTIME}@4`);
	const held = acquireClaim(join(dir, ".usage.lock"), "exclusive");
	try {
		const busy = await start({ DSH_HOME: home, DSH_MANAGER_LAUNCH: launchOf(home, { id: `${RUNTIME}@4`, dir }) });
		expect(busy.code).toBe(1);
		expect(busy.stderr).toContain("is being removed");
	} finally {
		if (held !== "busy") held.release();
	}
}, 60_000);

test("an invalid launch payload is an error, not a direct start; `manager` is an app argument", async () => {
	const home = mkdtempSync(join(root, "home-"));
	for (const bad of ["{", JSON.stringify({ protocol: 2 }), launchOf(home, null, { dataRoot: "relative" })]) {
		const r = await start({ DSH_HOME: home, DSH_MANAGER_LAUNCH: bad });
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("DSH_MANAGER_LAUNCH");
		expect(r.stdout).toBe("");
	}
	const direct = await start({ DSH_HOME: home }, ["manager", "update"]);
	expect(direct.code).toBe(0);
	expect(direct.reports).toEqual([{ args: ["manager", "update"], dir: null, home, runtime: null, shim: "-" }]);
	expect(readdirSync(home)).toEqual([]);
}, 60_000);
