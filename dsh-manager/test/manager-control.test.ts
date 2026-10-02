// manager-control spec: the manager works with no runtime and never hands `manager ...` to an app.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { addRuntime, argvOf, build, cleanup, hasZig, MANAGER_DIR, MANAGER_VERSION, newInstall, run, started, tempDir, tree, WIN } from "./harness.ts";

beforeAll(() => {
	if (hasZig) build();
}, 300_000);
afterAll(cleanup);

test.skipIf(!hasZig)("MC-EMPTY: manager only, no runtime, no JS runtime on PATH: version, help and list work and create nothing", () => {
	const i = newInstall();
	const version = run(i, ["manager", "--version"]);
	expect(version.status).toBe(0);
	expect(version.stdout).toContain(MANAGER_VERSION);
	const help = run(i, ["manager", "--help"]);
	expect(help.status).toBe(0);
	for (const cmd of ["install", "update", "uninstall", "list", "select", "snapshot", "clean", "self-update", "completion"]) expect(help.stdout).toContain(cmd);
	const list = run(i, ["manager", "list"]);
	expect(list.status).toBe(0);
	expect(list.stdout).toMatch(/no dsh runtime is installed/i);
	expect(`${help.stdout}${help.stderr}${list.stdout}${list.stderr}`).not.toMatch(/install (the old )?dsh first/i);
	expect(tree(i.dir)).toEqual([`dsh${WIN ? ".exe" : ""}`]);
	expect(tree(i.home)).toEqual([]);
});

test.skipIf(!hasZig)("MC-NAMESPACE: `dsh manager <anything>` never starts the app, even when the app has the same command", () => {
	const i = newInstall();
	addRuntime(i.data, "0.2.0-b1.1.gdeadbeef");
	for (const args of [["manager", "update", "--help"], ["manager", "list"], ["manager", "--help"], ["manager", "no-such-command"]]) {
		run(i, args);
		expect(started(i)).toBe(false);
	}
	expect(run(i, ["manager", "no-such-command"]).status).not.toBe(0);
});

test.skipIf(!hasZig)("MC-NAMESPACE: old top-level management words are app commands, not aliases", () => {
	const i = newInstall();
	addRuntime(i.data, "0.2.0-b1.1.gdeadbeef");
	for (const word of ["update", "install", "list", "select", "snapshot", "clean"]) {
		expect(run(i, [word, "x"]).status).toBe(0);
		expect(argvOf(i)).toEqual([word, "x"]);
	}
});

test.skipIf(!hasZig)("RL-MANAGER-BUILD: `zig build` with only zig on PATH, from a copy without the runtime project", () => {
	const copy = join(tempDir("dsh-manager-src-"), "dsh-manager");
	mkdirSync(copy);
	for (const p of ["build.zig", "src"]) cpSync(join(MANAGER_DIR, p), join(copy, p), { recursive: true });
	const zig = realZig();
	const zigDir = tempDir("dsh-zig-only-");
	const shim = join(zigDir, WIN ? "zig.exe" : "zig");
	cpSync(zig.exe, shim, { dereference: true });
	const prefix = tempDir("dsh-manager-out-");
	const r = spawnSync(shim, ["build", "-Dversion=1.0.0", "--prefix", prefix, "--zig-lib-dir", zig.lib], {
		cwd: copy,
		encoding: "utf8",
		env: { PATH: zigDir, HOME: process.env.HOME ?? "", ZIG_GLOBAL_CACHE_DIR: join(prefix, ".cache"), ...(WIN ? { SystemRoot: process.env.SystemRoot ?? "" } : {}) },
	});
	expect(r.stderr).not.toMatch(/\b(bun|node)\b/i);
	expect(r.status).toBe(0);
	const out = spawnSync(join(prefix, "bin", `dsh${WIN ? ".exe" : ""}`), ["manager", "--version"], { encoding: "utf8", cwd: prefix, env: { PATH: zigDir } });
	expect(out.status).toBe(0);
	expect(out.stdout).toContain("1.0.0");
}, 300_000);

test("RL-MANAGER-BUILD: zig env decodes escaped Windows paths", () => {
	const exe = "D:\\tools\\zig\\zig.exe", lib = "D:\\tools\\zig\\lib";
	expect(realZig(`.{ .zig_exe = ${JSON.stringify(exe)}, .lib_dir = ${JSON.stringify(lib)} }`)).toEqual({ exe, lib });
});

function realZig(env = spawnSync("zig", ["env"], { encoding: "utf8" }).stdout) {
	const field = (k: string) => JSON.parse(env.match(new RegExp(`\\.${k} = ("(?:[^"\\\\]|\\\\.)*")`))![1]!);
	return { exe: field("zig_exe"), lib: field("lib_dir") };
}
