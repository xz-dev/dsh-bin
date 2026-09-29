// Automatic snapshot at runtime start (task 4.2): the compiled entry creates the version's snapshot before
// app/lib/bin.js runs. The app here is a stub bin.js that reports it ran, so no upstream build is needed.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createSnapshot, removeSnapshot, snapshotDir } from "../../runtime/snapshot/store.ts";
import { writeShims } from "../../scripts/shims.mjs";

const ROOT = resolve(import.meta.dir, "../..");
const EXE = process.platform === "win32" ? ".exe" : "";
const V1 = { version: "0.1.7-rc.2-xz.7.1.g4e41a3f1", upstream: { commitTime: "2026-09-24T10:00:00.000Z" }, run: 7, attempt: 1 };
const V2 = { version: "0.2.0-rc.1-xz.10.1.ga83dab63", upstream: { commitTime: "2026-09-28T10:00:00.000Z" }, run: 10, attempt: 1 };
let root: string;
let native: string;

// Stub app: prints the snapshots present when it runs. With STUB_REPORT it also prints its argv, the
// snapshot dir and resolved snapshot, and what the bundle's `node` shim sees; with STUB_RESTART_WRITE it
// changes the selection, then respawns itself as upstream's restartTui does. Upstream spawns through
// node:child_process (no upstream package calls Bun.spawn), which sees runtime changes to process.env.
const STUB_BIN = `import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export async function runCli() {
	const d = join(process.env.DSH_HOME, "snapshots");
	process.stdout.write("BIN " + (existsSync(d) ? readdirSync(d).filter((n) => !n.startsWith(".")).join(",") : "-") + "\\n");
	if (process.env.STUB_HOLD) { process.stdout.write("HELD\\n"); await Bun.sleep(30000); }
	if (!process.env.STUB_REPORT) return;
	const launch = JSON.parse(process.env.DSH_BIN_LAUNCH ?? "null");
	const shim = spawnSync("node", ["-e", "process.stdout.write(process.env.DSH_BIN_SNAPSHOT_DIR ?? '-')"], { encoding: "utf8" }).stdout;
	process.stdout.write("REPORT " + JSON.stringify({ args: process.argv.slice(2), dir: process.env.DSH_BIN_SNAPSHOT_DIR, resolved: launch?.resolved?.snapshot, version: launch?.version, addons: launch?.selection?.addons, shim }) + "\\n");
	if (process.env.STUB_RESTART_WRITE) {
		writeFileSync(process.env.STUB_RESTART_WRITE, process.env.STUB_RESTART_DATA);
		const env = { ...process.env };
		delete env.STUB_RESTART_WRITE;
		const p = Bun.spawnSync([process.execPath, ...process.execArgv, ...process.argv.slice(1)], { env, stdout: "inherit", stderr: "inherit" });
		process.exitCode = p.exitCode;
	}
}
`;

beforeAll(() => {
	// ~/.cache, not /tmp: the compiled entry is ~100 MB.
	const base = join(homedir(), ".cache");
	mkdirSync(base, { recursive: true });
	root = mkdtempSync(join(base, "dsh-snapshot-start-"));
	const bundle = join(root, "bundles", V2.version);
	mkdirSync(join(bundle, "app", "lib"), { recursive: true });
	mkdirSync(join(bundle, "app", "node_modules"));
	writeFileSync(join(bundle, "app", "package.json"), '{"name":"stub-app","private":true}');
	native = join(bundle, `dsh-native${EXE}`);
	execFileSync("bun", [join(ROOT, "scripts/compile-entry.mjs"), `bun-${process.platform}-${process.arch}`, native], { stdio: "ignore" });
	writeFileSync(join(bundle, "app", "lib", "bin.js"), STUB_BIN);
	writeShims(bundle, process.platform === "win32" ? "windows" : process.platform);
	writeFileSync(join(bundle, "bundle.json"), JSON.stringify({ schemaVersion: 2, name: "dsh-bin", version: V2.version, channel: "release", upstream: V2.upstream, run: V2.run, attempt: V2.attempt, addons: {} }));
}, 120_000);
afterAll(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

async function start(home: string, launch?: object, args: string[] = [], extra: Record<string, string> = {}) {
	const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home, DSH_HOME: join(home, ".dsh"), NO_COLOR: "1", ...extra };
	if (launch) env.DSH_BIN_LAUNCH = JSON.stringify({ protocol: 2, addons: [], selection: null, use: null, snapshot: null, ...launch });
	const proc = Bun.spawn([native, ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { code: await proc.exited, stdout, stderr };
}

test("first start: an empty snapshot exists before bin.js runs; the next start reuses it", async () => {
	const home = mkdtempSync(join(root, "home-"));
	const r = await start(home);
	if (r.code !== 0) console.error(r.stderr);
	expect(r.code).toBe(0);
	expect(r.stdout).toBe(`BIN ${V2.version}@1\n`);
	expect(r.stderr).toContain(`Created plugin snapshot ${V2.version}@1 (empty).`);
	expect(readdirSync(join(home, ".dsh", "snapshots", `${V2.version}@1`, "profiles"))).toEqual([]);
	const again = await start(home);
	expect(again.stdout).toBe(`BIN ${V2.version}@1\n`);
	expect(again.stderr).not.toContain("Created plugin snapshot");
}, 60_000);

test("start after an update copies the previous version's newest snapshot, even with its bundle gone", async () => {
	const home = mkdtempSync(join(root, "home-"));
	const dshHome = join(home, ".dsh");
	createSnapshot(dshHome, { version: V1.version, order: V1, reason: "user", source: () => null });
	const s = createSnapshot(dshHome, { version: V1.version, order: V1, reason: "user", source: () => null }).snapshot;
	mkdirSync(join(snapshotDir(dshHome, s.id), "profiles", "tui"), { recursive: true });
	writeFileSync(join(snapshotDir(dshHome, s.id), "profiles", "tui", "package.json"), '{"name":"kept"}');
	const r = await start(home, { version: V2.version, source: "selection" });
	expect(r.stderr).toContain(`Created plugin snapshot ${V2.version}@1 (copy of ${V1.version}@2).`);
	expect(readFileSync(join(snapshotDir(dshHome, `${V2.version}@1`), "profiles", "tui", "package.json"), "utf8")).toBe('{"name":"kept"}');
	expect(JSON.parse(readFileSync(join(snapshotDir(dshHome, `${V2.version}@1`), "snapshot.json"), "utf8"))).toMatchObject({ reason: "start", source: `${V1.version}@2` });
}, 60_000);

test("an explicitly named snapshot creates nothing; a missing one fails with one diagnostic", async () => {
	const home = mkdtempSync(join(root, "home-"));
	const dshHome = join(home, ".dsh");
	const missing = await start(home, { version: V2.version, source: "snapshot", snapshot: `${V1.version}@1` });
	expect(missing.code).toBe(1);
	expect(missing.stdout).toBe("");
	expect(missing.stderr).toContain(`dsh: snapshot ${V1.version}@1 does not exist`);
	expect(missing.stderr).toContain("dsh snapshot list");
	createSnapshot(dshHome, { version: V1.version, order: V1, reason: "user", alias: "old", source: () => null });
	const r = await start(home, { version: V2.version, source: "use", use: V2.version, snapshot: "0.1.7-rc.2@old" }, [], { STUB_REPORT: "1" });
	expect(r.code).toBe(0);
	expect(r.stderr).not.toContain("Created plugin snapshot");
	expect(existsSync(join(dshHome, "snapshots", `${V2.version}@1`))).toBe(false);
	expect(r.stdout).toContain(`"dir":${JSON.stringify(snapshotDir(dshHome, `${V1.version}@1`))}`);
}, 60_000);

test("the selection's snapshot is used only when the version came from the selection", async () => {
	const home = mkdtempSync(join(root, "home-"));
	const dshHome = join(home, ".dsh");
	createSnapshot(dshHome, { version: V2.version, order: V2, reason: "user", source: () => null });
	createSnapshot(dshHome, { version: V2.version, order: V2, reason: "user", source: () => null });
	const selection = { use: V2.version, snapshot: `${V2.version}@1`, addons: {} };
	const fromSel = await start(home, { version: V2.version, source: "selection", selection }, [], { STUB_REPORT: "1" });
	expect(fromSel.stdout).toContain(`"resolved":"${V2.version}@1"`);
	const fromUse = await start(home, { version: V2.version, source: "use", use: V2.version, selection }, [], { STUB_REPORT: "1" });
	expect(fromUse.stdout).toContain(`"resolved":"${V2.version}@2"`);
	// A stale selected snapshot fails and names the reset.
	const stale = await start(home, { version: V2.version, source: "selection", selection: { ...selection, snapshot: `${V2.version}@9` } });
	expect(stale.code).toBe(1);
	expect(stale.stderr).toContain(`the selected snapshot ${V2.version}@9 does not exist`);
	expect(stale.stderr).toContain("dsh select --use latest");
}, 60_000);

test("a restart keeps the snapshot after a selection change; the node shim inherits it", async () => {
	const home = mkdtempSync(join(root, "home-"));
	const dshHome = join(home, ".dsh");
	createSnapshot(dshHome, { version: V2.version, order: V2, reason: "user", source: () => null });
	createSnapshot(dshHome, { version: V2.version, order: V2, reason: "user", source: () => null });
	const selPath = join(dshHome, "dsh-bin", "selection.json");
	mkdirSync(join(dshHome, "dsh-bin"), { recursive: true });
	const selection = { schema: 1, use: V2.version, snapshot: `${V2.version}@1`, addons: { office: "0.1.1" } };
	writeFileSync(selPath, JSON.stringify(selection));
	const env = { STUB_REPORT: "1", STUB_RESTART_WRITE: selPath, STUB_RESTART_DATA: JSON.stringify({ ...selection, use: "latest", snapshot: `${V2.version}@2`, addons: { office: "0.1.2" } }), PATH: `/usr/bin:/bin` };
	const r = await start(home, { version: V2.version, source: "selection", selection }, ["--profile", "tui"], env);
	expect(r.code).toBe(0);
	const reports = r.stdout.split("\n").filter((l) => l.startsWith("REPORT ")).map((l) => JSON.parse(l.slice(7)));
	expect(reports).toHaveLength(2);
	const dir = snapshotDir(dshHome, `${V2.version}@1`);
	for (const rep of reports) expect(rep).toEqual({ args: ["--profile", "tui"], dir, resolved: `${V2.version}@1`, version: V2.version, addons: { office: "0.1.1" }, shim: dir });
}, 60_000);

test("a running session holds the snapshot's claim; removal is refused until it exits", async () => {
	const home = mkdtempSync(join(root, "home-"));
	const dshHome = join(home, ".dsh");
	const s = createSnapshot(dshHome, { version: V2.version, order: V2, reason: "user", source: () => null }).snapshot;
	const proc = Bun.spawn([native], { env: { PATH: process.env.PATH ?? "", HOME: home, DSH_HOME: dshHome, STUB_HOLD: "1" }, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
	const reader = proc.stdout.getReader();
	let out = "";
	while (!out.includes("HELD")) {
		const { value, done } = await reader.read();
		if (done) break;
		out += new TextDecoder().decode(value);
	}
	expect(out).toContain("HELD");
	expect(removeSnapshot(dshHome, s.id)).toBe("busy");
	proc.kill("SIGKILL");
	await proc.exited;
	let r = removeSnapshot(dshHome, s.id);
	for (let i = 0; i < 30 && r === "busy"; i++) {
		await Bun.sleep(100);
		r = removeSnapshot(dshHome, s.id);
	}
	expect(r).toBe("removed");
}, 60_000);

test("direct start: leading options are stripped; another version is refused", async () => {
	const home = mkdtempSync(join(root, "home-"));
	const dshHome = join(home, ".dsh");
	createSnapshot(dshHome, { version: V2.version, order: V2, reason: "user", alias: "a", source: () => null });
	createSnapshot(dshHome, { version: V2.version, order: V2, reason: "user", source: () => null });
	const r = await start(home, undefined, ["--snapshot", "0.2.0-rc.1@a", "--profile", "tui", "--use", "x"], { STUB_REPORT: "1" });
	expect(r.code).toBe(0);
	expect(r.stdout).toContain(`"args":["--profile","tui","--use","x"]`);
	expect(r.stdout).toContain(`"resolved":"${V2.version}@1"`);
	const other = await start(home, undefined, ["--use", "0.1.7-rc.2"]);
	expect(other.code).toBe(1);
	expect(other.stderr).toContain("names another dsh version");
	const prompt = await start(home, undefined, ["-p", "--use 1"], { STUB_REPORT: "1" });
	expect(prompt.stdout).toContain(`"args":["-p","--use 1"]`);
}, 60_000);
