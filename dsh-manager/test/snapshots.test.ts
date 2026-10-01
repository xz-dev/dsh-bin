// MC-SNAPSHOT: native snapshot lifecycle, isolated homes and real manager/fake-native processes.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireClaim } from "./claim-probe.ts";
import { addRuntime, baseEnv, build, cleanup, hasZig, launchOf, newInstall, run, started, tree, WIN, type Install } from "./harness.ts";

beforeAll(() => { if (hasZig) build(); }, 300_000);
afterAll(cleanup);
const A = "1.0.0-b1.1.gdeadbeef", B = "1.0.0-b2.1.gdeadbeef";
const root = (i: Install) => join(i.data, "snapshots");
const dir = (i: Install, id: string) => join(root(i), id);
const command = (i: Install, args: string[], env = {}) => run(i, ["manager", "snapshot", ...args], { env });
const rows = (i: Install) => { const r = command(i, ["list", "--json"]); expect(r.status).toBe(0); return JSON.parse(r.stdout).snapshots; };
const digest = (path: string) => tree(path).filter(p => lstatSync(join(path, p)).isFile()).map(p => [p, createHash("sha256").update(readFileSync(join(path, p))).digest("hex")]);
function install() { const i = newInstall(); addRuntime(i.data, A, { run: 1 }); addRuntime(i.data, B, { run: 2 }); return i; }

test.skipIf(!hasZig)("MC-SNAPSHOT: names, empty/copy, selection guard and all-delete numbering never reuse IDs", () => {
	const cold = newInstall(), before = tree(cold.dir);
	expect(rows(cold)).toEqual([]); expect(tree(cold.dir)).toEqual(before);
	const i = install();
	expect(command(i, ["new", "--use", A, "--empty", "--name", "base"]).status).toBe(0);
	const first = dir(i, `${A}@1`), profile = join(first, "profiles", "probe"); mkdirSync(profile);
	writeFileSync(join(profile, "plugin"), "plugin bytes");
	mkdirSync(join(i.data, "home", "profiles", "probe"), { recursive: true });
	writeFileSync(join(i.data, "home", "profiles", "probe", "cordis.patch.yml"), "shared config");
	const saved = digest(first);
	expect(command(i, ["new", "--use", A, "--name", "copy"]).status).toBe(0);
	expect(digest(first)).toEqual(saved); expect(readFileSync(join(dir(i, `${A}@2`), "profiles/probe/plugin"), "utf8")).toBe("plugin bytes");
	writeFileSync(join(dir(i, `${A}@2`), "profiles/probe/plugin"), "different"); expect(digest(first)).toEqual(saved);
	expect(command(i, ["new", "--use", B, "--target", `${A}@base`, "--name", "base"]).status).toBe(0);
	expect(existsSync(join(dir(i, `${B}@1`), "profiles/probe/cordis.patch.yml"))).toBe(false);
	const initial = rows(i); expect(initial.map((s: any) => s.id)).toEqual([`${A}@1`, `${A}@2`, `${B}@1`]);
	expect(initial.find((s: any) => s.id === `${B}@1`)).toMatchObject({ alias: "base", source: `${A}@1`, reason: "user", newest: true, bundleInstalled: true });
	for (const args of [["new", "--use", A, "--name", "copy"], ["new", "--use", A, "--name", "123"], ["new", "--use", A, "--name", "../outside"], ["new", "--use", A, "--empty", "--target", `${A}@1`], ["remove", `${A}@1`, "missing@1"]]) {
		expect(command(i, args).status).toBe(1); expect(rows(i)).toEqual(initial); expect(started(i)).toBe(false);
	}
	expect(run(i, ["manager", "select", "--use", B, "--snapshot", `${A}@1`]).status).toBe(0);
	const rejected = command(i, ["remove", `${A}@2`, `${A}@1`]); expect(rejected.status).toBe(1); expect(rejected.stderr).toContain("selection"); expect(rows(i)).toHaveLength(3);
	expect(run(i, ["manager", "select", "--use", "latest"]).status).toBe(0);
	expect(command(i, ["remove", `${A}@base`, `${A}@2`, `${A}@2`]).status).toBe(0);
	expect(command(i, ["new", "--use", A, "--empty"]).status).toBe(0); expect(rows(i).map((s: any) => s.id)).toContain(`${A}@3`);
	expect(command(i, ["remove", `${A}@3`]).status).toBe(0);
	expect(run(i, ["--use", A, "probe"]).status).toBe(0); expect(launchOf(i).snapshot.id).toBe(`${A}@4`);
	expect(command(i, ["list"]).stdout).toContain(`${A}@4`); expect(started(i)).toBe(false);
});

test.skipIf(!hasZig)("MC-SNAPSHOT: staged interruptions publish nothing and reserved numbers stay spent", () => {
	const i = install(); expect(command(i, ["new", "--use", A, "--empty"]).status).toBe(0);
	for (const [point, n] of [["snapshot-reserved", 2], ["snapshot-copied", 3]] as const) {
		const r = command(i, ["new", "--use", A], { DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_CRASH: point });
		expect(r.status).toBe(86); expect(rows(i).map((s: any) => s.id)).toEqual([`${A}@1`]); expect(existsSync(dir(i, `${A}@${n}`))).toBe(false);
	}
	expect(command(i, ["new", "--use", A]).status).toBe(0); expect(rows(i).map((s: any) => s.id)).toEqual([`${A}@1`, `${A}@4`]);
	writeFileSync(join(root(i), ".counters.json"), "not JSON");
	expect(command(i, ["new", "--use", A]).status).toBe(1); expect(rows(i)).toHaveLength(2);
});

test.skipIf(!hasZig || WIN)("MC-SNAPSHOT: internal pnpm-style links copy independently; escaping/absolute links refuse unpublished", () => {
	const i = install(); expect(command(i, ["new", "--use", A, "--empty"]).status).toBe(0);
	const profile = join(dir(i, `${A}@1`), "profiles/probe"), mod = join(profile, "node_modules"); mkdirSync(join(mod, ".pnpm/pkg/node_modules/pkg"), { recursive: true });
	writeFileSync(join(mod, ".pnpm/pkg/node_modules/pkg/index.js"), "original");
	symlinkSync(".pnpm/pkg/node_modules/pkg", join(mod, "pkg"));
	expect(command(i, ["new", "--use", B, "--target", `${A}@1`]).status).toBe(0);
	const copied = join(dir(i, `${B}@1`), "profiles/probe/node_modules"); expect(readlinkSync(join(copied, "pkg"))).toBe(".pnpm/pkg/node_modules/pkg");
	writeFileSync(join(copied, "pkg/index.js"), "copy changed"); expect(readFileSync(join(mod, "pkg/index.js"), "utf8")).toBe("original");
	for (const target of ["../../../../home", i.home]) {
		symlinkSync(target, join(profile, "unsafe")); const r = command(i, ["new", "--use", B, "--target", `${A}@1`]);
		expect(r.status).toBe(1); expect(r.stderr).toContain("unsafe"); expect(rows(i).filter((s: any) => s.version === B)).toHaveLength(1); rmSync(join(profile, "unsafe"));
	}
});

test.skipIf(!hasZig || WIN)("MC-SNAPSHOT review: chained relative links cannot make a copy modify its source", () => {
	const i = install(); expect(command(i, ["new", "--use", A, "--empty"]).status).toBe(0);
	const source = join(dir(i, `${A}@1`), "profiles"), plugin = join(source, "probe/plugin");
	mkdirSync(join(source, "probe")); writeFileSync(plugin, "source original");
	mkdirSync(join(source, "dir")); symlinkSync(".", join(source, "dir/alias"));
	symlinkSync(`dir/alias/alias/../../../${A}@1/profiles/probe`, join(source, "leak"));
	const copied = command(i, ["new", "--use", B, "--target", `${A}@1`]);
	if (copied.status === 0) writeFileSync(join(dir(i, `${B}@1`), "profiles/leak/plugin"), "changed through copy");
	expect(readFileSync(plugin, "utf8")).toBe("source original");
	expect(copied.status).toBe(1); expect(copied.stderr).toContain("leak"); expect(copied.stderr).toContain("nothing was published");
	expect(rows(i).map((s: any) => s.id)).toEqual([`${A}@1`]);
	expect(readdirSync(root(i)).some(p => p.startsWith(".staging-"))).toBe(false);
	expect(JSON.parse(readFileSync(join(root(i), ".counters.json"), "utf8"))[B]).toBe(1);
});

test.skipIf(!hasZig)("MC-SNAPSHOT: concurrent starts reuse prepared snapshot without taking the busy store lock", async () => {
	const i = install(); expect(command(i, ["new", "--use", A, "--empty"]).status).toBe(0);
	const held = acquireClaim(join(root(i), ".lock"), "exclusive"); expect(held).not.toBe("busy");
	const start = async () => {
		const p = Bun.spawn([i.exe, "--use", A, "probe"], { cwd: i.home, env: baseEnv(i), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		const timer = setTimeout(() => p.kill("SIGKILL"), 30_000);
		try { const [code, stderr] = await Promise.all([p.exited, new Response(p.stderr).text(), new Response(p.stdout).text()]); expect(stderr).not.toContain("Busy"); return code; }
		finally { clearTimeout(timer); if (p.exitCode === null) { p.kill("SIGKILL"); await p.exited; } }
	};
	try { expect(await Promise.all([start(), start()])).toEqual([0, 0]); expect(rows(i).map((s: any) => s.id)).toEqual([`${A}@1`]); }
	finally { if (held !== "busy") held.release(); }
});
