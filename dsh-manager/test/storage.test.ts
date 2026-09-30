// Section 2 acceptance: real manager process, isolated user dirs, no host JS runtime on PATH.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addRuntime, build, cleanup, EXE, hasZig, launchOf, newInstall, run, started, tempDir, tree, WIN } from "./harness.ts";

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
	execFileSync("icacls", [dir, "/deny", `*${sid}:(OI)(CI)(W)`], { stdio: "pipe" });
	return () => { execFileSync("icacls", [dir, "/remove:d", `*${sid}`], { stdio: "pipe" }); };
}

test.skipIf(!hasZig)("PS-HOME: first stateful start initializes only adjacent owned data, even with no runtime yet", () => {
	const i = newInstall();
	i.exe = join(i.home, `dsh${EXE}`);
	renameSync(join(i.dir, `dsh${EXE}`), i.exe);
	i.dir = i.home;
	i.data = join(i.home, "dsh-bin");
	const cwd = tempDir("dsh-other-cwd-");
	const result = run(i, [], { cwd });
	expect(result.status).toBe(1); // Installing the first runtime belongs to section 3/5.
	expect(result.stderr).toContain("no release-channel dsh runtime");
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
	run(i, [], { exe: link, cwd });
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
			const xdg = tempDir("dsh-unused-xdg-");
			rejected(i, run(i, [], { env: { XDG_DATA_HOME: xdg, LOCALAPPDATA: xdg } }), "not writable");
			expect(existsSync(join(i.data, DATA_MARKER))).toBe(false);
			expect(tree(xdg)).toEqual([]);
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
		const before = tree(i.dir);
		const restore = denyWrites(i.dir);
		try {
			const env = { XDG_DATA_HOME: absoluteXdg ? xdg : "relative-data" };
			const info = run(i, ["manager", "info"], { env });
			expect(info.status).toBe(0);
			expect(info.stdout).toContain("portage");
			expect(info.stdout).toContain(data);
			expect(info.stdout).toContain(join(data, "home"));
			expect(existsSync(data)).toBe(false); // info is read-only
			run(i, [], { env });
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
