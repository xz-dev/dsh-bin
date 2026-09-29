// Automatic snapshot at runtime start (task 4.2): the compiled entry creates the version's snapshot before
// app/lib/bin.js runs. The app here is a stub bin.js that reports it ran, so no upstream build is needed.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createSnapshot, snapshotDir } from "../../runtime/snapshot/store.ts";

const ROOT = resolve(import.meta.dir, "../..");
const EXE = process.platform === "win32" ? ".exe" : "";
const V1 = { version: "0.1.7-rc.2-xz.7.1.g4e41a3f1", upstream: { commitTime: "2026-09-24T10:00:00.000Z" }, run: 7, attempt: 1 };
const V2 = { version: "0.2.0-rc.1-xz.10.1.ga83dab63", upstream: { commitTime: "2026-09-28T10:00:00.000Z" }, run: 10, attempt: 1 };
let root: string;
let native: string;

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
	writeFileSync(
		join(bundle, "app", "lib", "bin.js"),
		`import { existsSync, readdirSync } from "node:fs";\nimport { join } from "node:path";\nexport async function runCli() { const d = join(process.env.DSH_HOME, "snapshots"); process.stdout.write("BIN " + (existsSync(d) ? readdirSync(d).filter((n) => !n.startsWith(".")).join(",") : "-") + "\\n"); }\n`,
	);
	writeFileSync(join(bundle, "bundle.json"), JSON.stringify({ schemaVersion: 2, name: "dsh-bin", version: V2.version, channel: "release", upstream: V2.upstream, run: V2.run, attempt: V2.attempt, addons: {} }));
}, 120_000);
afterAll(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

async function start(home: string, launch?: object) {
	const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home, DSH_HOME: join(home, ".dsh"), NO_COLOR: "1" };
	if (launch) env.DSH_BIN_LAUNCH = JSON.stringify({ protocol: 2, addons: [], selection: null, use: null, snapshot: null, ...launch });
	const proc = Bun.spawn([native], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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

test("an explicitly named snapshot creates nothing", async () => {
	const home = mkdtempSync(join(root, "home-"));
	const r = await start(home, { version: V2.version, source: "snapshot", snapshot: `${V1.version}@1` });
	expect(r.stderr).not.toContain("Created plugin snapshot");
	expect(existsSync(join(home, ".dsh", "snapshots", `${V2.version}@1`))).toBe(false);
}, 60_000);
