// Section 2 acceptance: real manager process, isolated user dirs, no host JS runtime on PATH.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireClaim } from "./claim-probe.ts";
import { addRuntime, baseEnv, build, cleanup, envOf, EXE, hasZig, launchOf, newInstall, run, started, tempDir, tree, WIN } from "./harness.ts";

beforeAll(() => { if (hasZig) build(); }, 300_000);
afterAll(cleanup);
const ID = "0.2.0-b1.1.gdeadbeef";
const DATA_MARKER = ".dsh-bin-data.json";
const OWNED = { kind: "dsh-manager-data", schema: 1 };

function rejected(i: ReturnType<typeof newInstall>, result: ReturnType<typeof run>, reason: string) {
	expect(result.status).toBe(1);
	expect(result.stderr).toContain(i.data);
	expect(result.stderr).toContain(reason);
	expect(started(i)).toBe(false);
	expect(tree(i.home)).toEqual([]);
}

// Windows directory READONLY is not an access restriction. Exercise actual denied write access.
function denyWrites(dir: string): () => void {
	if (!WIN) { chmodSync(dir, 0o555); return () => chmodSync(dir, 0o755); }
	const sid = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" }).match(/S-1-[0-9-]+/)![0];
	execFileSync("icacls", [dir, "/deny", `*${sid}:(OI)(CI)(WD,AD,WEA,WA)`], { stdio: "pipe" });
	return () => { execFileSync("icacls", [dir, "/remove:d", `*${sid}`], { stdio: "pipe" }); };
}

test.skipIf(!hasZig)("PS-HOME: first stateful start initializes only adjacent owned data, even with no runtime yet", () => {
	const i = newInstall();
	i.exe = join(i.home, `dsh${EXE}`);
	renameSync(join(i.dir, `dsh${EXE}`), i.exe);
	i.dir = i.home;
	i.data = join(i.home, "dsh-bin");
	const cwd = tempDir("dsh-other-cwd-");
	const result = run(i, [], { cwd, env: { DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_ORIGIN: "not-a-url" } });
	expect(result.status).toBe(1); // No controlled archive in this storage-only fixture.
	expect(result.stderr).toContain("automatic runtime install failed");
	expect(JSON.parse(readFileSync(join(i.data, DATA_MARKER), "utf8"))).toEqual(OWNED);
	expect(tree(i.home).filter((p) => !p.startsWith("dsh-bin/"))).toEqual([`dsh${EXE}`, "dsh-bin"].sort());
	expect(tree(cwd)).toEqual([]);
});

test.skipIf(!hasZig || WIN)("PS-SYMLINK: first write follows real executable, not symlink or calling cwd (Windows symlink privilege not assumed)", () => {
	const i = newInstall();
	const links = tempDir("dsh-links-");
	const link = join(links, "dsh");
	symlinkSync(i.exe, link);
	const cwd = tempDir("dsh-workspace-");
	run(i, [], { exe: link, cwd, env: { DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_ORIGIN: "not-a-url" } });
	expect(JSON.parse(readFileSync(join(i.data, DATA_MARKER), "utf8"))).toEqual(OWNED);
	expect(tree(links)).toEqual(["dsh"]);
	expect(tree(cwd)).toEqual([]);
	expect(tree(i.home)).toEqual([]);
});

test.skipIf(!hasZig)("PS-HOME: help, version and local list create nothing, including top-level queries", () => {
	const i = newInstall();
	for (const args of [["--help"], ["--version"], ["manager", "help"], ["manager", "version"], ["manager", "list"]]) {
		const result = run(i, args);
		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(/manager|runtime/i);
	}
	expect(tree(i.dir)).toEqual([`dsh${EXE}`]);
	expect(tree(i.home)).toEqual([]);
});

test.skipIf(!hasZig)("PS-CONFLICT: same-name file and nonempty unmarked directory are refused without adoption", () => {
	for (const file of [true, false]) {
		const i = newInstall();
		if (!file) mkdirSync(i.data);
		const sentinel = file ? i.data : join(i.data, "personal.txt");
		writeFileSync(sentinel, "not manager data");
		rejected(i, run(i, []), "conflict");
		expect(readFileSync(sentinel, "utf8")).toBe("not manager data");
		if (!file) expect(tree(i.data)).toEqual(["personal.txt"]);
	}
});

test.skipIf(!hasZig)("PS-CONFLICT: corrupt ownership marker is not permission to write", () => {
	const i = newInstall();
	mkdirSync(i.data);
	writeFileSync(join(i.data, DATA_MARKER), JSON.stringify({ kind: "dsh-manager-data", schema: 99 }));
	rejected(i, run(i, []), "conflict");
	expect(tree(i.data)).toEqual([DATA_MARKER]);
});

test.skipIf(!hasZig)("PS-READONLY: denied portable prefix or data directory fails by path, never switches to HOME/XDG", () => {
	for (const existingData of [false, true]) {
		const i = newInstall();
		if (existingData) mkdirSync(i.data);
		const restore = denyWrites(existingData ? i.data : i.dir);
		try {
			rejected(i, run(i, [], { env: { XDG_DATA_HOME: i.out, LOCALAPPDATA: i.out } }), "not writable");
			expect(existsSync(join(i.data, DATA_MARKER))).toBe(false);
			expect(tree(i.out)).toEqual([]);
			for (const args of [["manager", "list"], ["--help"], ["--version"]]) expect(run(i, args).status).toBe(0);
		} finally { restore(); }
	}
});

function managed(i: ReturnType<typeof newInstall>, owner: string, data: string) {
	writeFileSync(join(i.dir, ".dsh-manager-install.json"), JSON.stringify({ schema: 1, owner }));
	i.data = data;
}

test.skipIf(!hasZig)("PS-MANAGED: portage writes absolute XDG data or HOME fallback, never read-only package prefix", () => {
	for (const absoluteXdg of [true, false]) {
		const i = newInstall();
		const xdg = tempDir("dsh-user-data-");
		const data = absoluteXdg ? join(xdg, "dsh-bin") : join(i.home, ".local", "share", "dsh-bin");
		managed(i, "portage", data);
		const env = { XDG_DATA_HOME: absoluteXdg ? xdg : "relative-data" };
		const info = run(i, ["manager", "info"], { env });
		expect(info.status).toBe(0);
		expect(info.stdout).toContain("portage");
		expect(info.stdout).toContain(data);
		expect(info.stdout).toContain(join(data, "home"));
		expect(existsSync(data)).toBe(false); // info is read-only
		const before = tree(i.dir);
		const restore = denyWrites(i.dir);
		try {
			run(i, [], { env: { ...env, DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_ORIGIN: "not-a-url" } });
			expect(JSON.parse(readFileSync(join(data, DATA_MARKER), "utf8"))).toEqual(OWNED);
			expect(tree(i.dir)).toEqual(before);
			expect(existsSync(join(i.dir, "dsh-bin"))).toBe(false);
		} finally { restore(); }
	}
});

test.skipIf(!hasZig)("PS-SCOOP: two read-only package versions retain same LOCALAPPDATA root and preinstalled runtime", () => {
	const local = tempDir("dsh-localappdata-");
	const data = join(local, "dsh-bin");
	for (const version of ["1.0.0", "2.0.0"]) {
		const i = newInstall();
		managed(i, "scoop", data);
		if (version === "1.0.0") addRuntime(data, ID);
		const before = tree(i.dir);
		const restore = denyWrites(i.dir);
		try {
			const env = { LOCALAPPDATA: local };
			expect(run(i, [], { env }).status).toBe(0);
			expect(launchOf(i)).toMatchObject({ runtime: ID, dataRoot: data, home: join(data, "home") });
			const info = run(i, ["manager", "info"], { env });
			expect(info.status).toBe(0);
			expect(info.stdout).toContain("scoop");
			expect(info.stdout).toContain(data);
			expect(tree(i.dir)).toEqual(before);
		} finally { restore(); }
	}
});

test.skipIf(!hasZig)("PS-MANAGED / PS-SCOOP: unknown/corrupt markers or missing absolute LOCALAPPDATA fail without mode switch", () => {
	for (const marker of ["{", JSON.stringify({ schema: 1, owner: "other" }), JSON.stringify({ schema: 99, owner: "portage" }), JSON.stringify({ owner: "scoop" })]) {
		const i = newInstall();
		writeFileSync(join(i.dir, ".dsh-manager-install.json"), marker);
		for (const args of [[], ["manager", "info"]]) {
			const result = run(i, args);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(join(i.dir, ".dsh-manager-install.json"));
		}
		expect(existsSync(i.data)).toBe(false);
		expect(tree(i.home)).toEqual([]);
	}
	const i = newInstall();
	managed(i, "scoop", i.data);
	for (const env of [{}, { LOCALAPPDATA: "relative" }]) {
		const result = run(i, [], { env });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("absolute LOCALAPPDATA");
		expect(existsSync(i.data)).toBe(false);
	}
});

test.skipIf(!hasZig)("PS-OVERRIDE: manager info reports resolved app home and external portability exception without writing", () => {
	const i = newInstall();
	const external = tempDir("dsh-external-home-");
	const result = run(i, ["manager", "info"], { env: { DSH_HOME: external } });
	expect(result.status).toBe(0);
	expect(result.stdout).toContain("portable");
	expect(result.stdout).toContain(i.data);
	expect(result.stdout).toContain(external);
	expect(result.stdout).toContain("outside the portability guarantee");
	expect(existsSync(i.data)).toBe(false);
	expect(tree(i.home)).toEqual([]);
});

const CACHE_PATHS = {
	BUN_INSTALL_CACHE_DIR: "cache/bun",
	BUN_RUNTIME_TRANSPILER_CACHE_PATH: "cache/transpiler",
	npm_config_cache: "cache/npm",
	pnpm_config_store_dir: "cache/pnpm/store",
	pnpm_config_cache_dir: "cache/pnpm/cache",
	pnpm_config_state_dir: "state/pnpm",
	PNPM_HOME: "cache/pnpm/home",
	TMPDIR: "tmp", TEMP: "tmp", TMP: "tmp",
};

test.skipIf(!hasZig)("PS-CONTAIN / RB-HOME: first launch supplies real empty snapshot with guard and relative metadata, then reuses newest", () => {
	const i = newInstall();
	addRuntime(i.data, ID);
	expect(run(i, []).status).toBe(0);
	const snapshot = { id: `${ID}@1`, dir: join(i.data, "snapshots", `${ID}@1`) };
	expect(launchOf(i).snapshot).toEqual(snapshot);
	expect(existsSync(join(snapshot.dir, ".usage.lock"))).toBe(true);
	const meta = JSON.parse(readFileSync(join(snapshot.dir, "snapshot.json"), "utf8"));
	expect(meta).toMatchObject({ id: snapshot.id, version: ID, n: 1, source: "empty", reason: "start" });
	expect(JSON.stringify(meta)).not.toContain(i.dir);
	expect(tree(snapshot.dir)).toEqual([".usage.lock", "profiles", "snapshot.json"]);
	expect(meta.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	const newest = join(i.data, "snapshots", `${ID}@3`);
	mkdirSync(newest);
	writeFileSync(join(newest, ".usage.lock"), "");
	writeFileSync(join(newest, "snapshot.json"), JSON.stringify({ ...meta, id: `${ID}@3`, n: 3 }));
	writeFileSync(join(newest, "plugin-data"), "keep");
	const before = tree(i.data);
	expect(run(i, []).status).toBe(0);
	expect(launchOf(i).snapshot).toEqual({ id: `${ID}@3`, dir: newest });
	expect(tree(i.data)).toEqual(before);
	expect(readFileSync(join(newest, "plugin-data"), "utf8")).toBe("keep");
});

test.skipIf(!hasZig)("PS-CONTAIN: fake runtime file audit uses controlled Bun/pnpm/temp paths, never inherited global caches", () => {
	const i = newInstall();
	addRuntime(i.data, ID);
	const poisoned = Object.fromEntries(Object.keys(CACHE_PATHS).map((k) => [k, join(i.home, k)]));
	expect(run(i, [], { env: { ...poisoned, FAKE_WRITE_STATE: "1" } }).status).toBe(0);
	const env = envOf(i);
	for (const [key, relative] of Object.entries(CACHE_PATHS)) {
		expect(env[key]).toBe(join(i.data, relative));
		expect(readFileSync(join(env[key], `${key}.probe`), "utf8")).toBe("contained");
	}
	expect(launchOf(i)).toMatchObject({ home: join(i.data, "home"), cache: join(i.data, "cache"), tmp: join(i.data, "tmp") });
	expect(env.HOME).toBe(i.home);
	expect(env.USERPROFILE).toBe(i.home);
	expect(tree(i.home)).toEqual([]);
});

// Task 6.2 owns explicit snapshot selection; this slice only hands off and protects the initial/newest one.
test.skipIf(!hasZig)("RB-HOME: initial snapshot usage claim stays held until runtime exits", async () => {
	const i = newInstall();
	addRuntime(i.data, ID);
	const proc = Bun.spawn([i.exe], { env: { ...baseEnv(i), FAKE_HOLD: "1" }, stdout: "ignore", stderr: "pipe" });
	try {
		for (let n = 0; n < 250 && !started(i); n++) await Bun.sleep(20);
		expect(started(i)).toBe(true);
		const guard = join(launchOf(i).snapshot.dir, ".usage.lock");
		const claim = acquireClaim(guard, "exclusive");
		try { expect(claim).toBe("busy"); } finally { if (claim !== "busy") claim.release(); }
	} finally { proc.kill("SIGKILL"); await proc.exited; }
	const guard = join(i.data, "snapshots", `${ID}@1`, ".usage.lock");
	let claim = acquireClaim(guard, "exclusive");
	for (let n = 0; n < 50 && claim === "busy"; n++) {
		await Bun.sleep(100);
		claim = acquireClaim(guard, "exclusive");
	}
	try { expect(claim).not.toBe("busy"); } finally { if (claim !== "busy") claim.release(); }
});

test.skipIf(!hasZig)("PS-MOVE / DL-NO-MIGRATION: stopped binary+data relocate offline; moving only binary starts fresh", () => {
	const i = newInstall();
	addRuntime(i.data, ID);
	addRuntime(i.data, "0.3.0-b2.1.gcafefeed", { run: 2 });
	mkdirSync(join(i.data, "state"));
	const selection = JSON.stringify({ schema: 1, use: ID, snapshot: null, addons: {} });
	writeFileSync(join(i.data, "state/selection.json"), selection);
	expect(run(i, []).status).toBe(0); // stopped before move
	const first = launchOf(i).snapshot;
	writeFileSync(join(first.dir, "saved-plugin-state"), "survives move");
	mkdirSync(join(i.data, "home"));
	writeFileSync(join(i.data, "home/session"), "session survives");
	const oldDir = i.dir;
	const moved = join(tempDir("dsh-relocated-"), "install with spaces");
	renameSync(oldDir, moved);
	writeFileSync(oldDir, "old path inaccessible: not a directory");
	i.dir = moved; i.exe = join(moved, `dsh${EXE}`); i.data = join(moved, "dsh-bin");
	expect(run(i, [], { env: { DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_ORIGIN: "http://127.0.0.1:1", HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1" } }).status).toBe(0);
	expect(launchOf(i)).toMatchObject({ runtime: ID, dataRoot: i.data, home: join(i.data, "home"), snapshot: { id: `${ID}@1`, dir: join(i.data, "snapshots", `${ID}@1`) } });
	expect(readFileSync(join(launchOf(i).snapshot.dir, "saved-plugin-state"), "utf8")).toBe("survives move");
	expect(readFileSync(join(i.data, "home/session"), "utf8")).toBe("session survives");
	expect(readFileSync(join(i.data, "state/selection.json"), "utf8")).toBe(selection);
	const metadata = readFileSync(join(launchOf(i).snapshot.dir, "snapshot.json"), "utf8");
	expect(metadata).not.toContain(oldDir);
	expect(metadata).not.toContain(moved);

	const fresh = newInstall();
	// Replace an existing executable explicitly; Node rename-over-file is not uniform on Windows.
	rmSync(fresh.exe);
	renameSync(i.exe, fresh.exe);
	mkdirSync(join(fresh.home, ".dsh"));
	writeFileSync(join(fresh.home, ".dsh/legacy-data"), "do not adopt");
	const result = run(fresh, [], { env: { DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_ORIGIN: "not-a-url" } });
	expect(result.status).toBe(1);
	expect(result.stderr).toContain("automatic runtime install failed");
	expect(started(fresh)).toBe(false);
	expect(JSON.parse(readFileSync(join(fresh.data, DATA_MARKER), "utf8"))).toEqual(OWNED);
	expect(existsSync(join(fresh.data, "bundles"))).toBe(false);
	expect(readFileSync(join(fresh.home, ".dsh/legacy-data"), "utf8")).toBe("do not adopt");
	expect(readFileSync(join(i.data, "home/session"), "utf8")).toBe("session survives");
});

test.skipIf(!hasZig)("PS-CONFLICT / PS-CONTAIN: directory links cannot redirect managed data/cache outside root", () => {
	for (const child of [false, true]) {
		const i = newInstall();
		const external = tempDir("dsh-do-not-write-");
		if (child) addRuntime(i.data, ID);
		else writeFileSync(join(external, DATA_MARKER), JSON.stringify(OWNED));
		symlinkSync(external, child ? join(i.data, "cache") : i.data, WIN ? "junction" : "dir");
		const before = tree(external);
		const result = run(i, []);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(i.data);
		expect(started(i)).toBe(false);
		expect(tree(external)).toEqual(before);
	}
});

test.skipIf(!hasZig)("FB-CONCURRENT: initialization residue gets retry diagnostic, never adoption or extra writes", () => {
	for (const [name, bytes] of [[".dsh-data-123abc.tmp", '{"kind":"dsh-manager-data"'], [DATA_MARKER, ""], [DATA_MARKER, '{"kind":"dsh-manager-data","schema":']]) {
		const i = newInstall(); mkdirSync(i.data); writeFileSync(join(i.data, name!), bytes!);
		const before = tree(i.data), result = run(i, []);
		expect(result.status).toBe(1); expect(result.stderr).toContain("initialization was interrupted");
		expect(result.stderr).toContain("retry"); expect(result.stderr).toContain("Never remove a root containing user data");
		expect(tree(i.data)).toEqual(before); expect(readFileSync(join(i.data, name!), "utf8")).toBe(bytes!);
	}
});
