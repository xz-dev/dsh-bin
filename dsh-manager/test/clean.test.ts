// MC-CLEAN: offline native cleanup is not uninstall or user-data cleanup.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireClaim } from "./claim-probe.ts";
import { addRuntime, baseEnv, build, cleanup, EXE, hasZig, holdSession, newInstall, replaceAncestor, run, started, tree, WIN, type Install } from "./harness.ts";

beforeAll(() => { if (hasZig) build(); }, 300_000);
afterAll(cleanup);
const A = "1.0.0-b1.1.gdeadbeef", O = "0.1.1-b1.1.gdeadbeef";
const digest = "a".repeat(64);
const offline = { HTTPS_PROXY: "http://127.0.0.1:1", ALL_PROXY: "http://127.0.0.1:1" };
const bytes = (dir: string) => tree(dir).map(p => [p, lstatSync(join(dir, p)).isFile() ? createHash("sha256").update(readFileSync(join(dir, p))).digest("hex") : "dir"]);
function put(i: Install, path: string, data = "residue") {
	const p = join(i.data, path); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, data); return p;
}
function fixture() {
	const i = newInstall(); addRuntime(i.data, A);
	expect(run(i, ["manager", "snapshot", "new", "--use", A, "--empty"]).status).toBe(0);
	put(i, `snapshots/${A}@1/profiles/plugin`, "plugin installed by user");
	put(i, "home/profiles/cordis.patch.yml", "user config"); put(i, "home/credentials.json", "secret");
	put(i, "user-file", "unrecognised user bytes"); put(i, "state/custom", "user state");
	writeFileSync(join(i.home, ".bashrc"), "user shell config"); writeFileSync(join(i.home, "credential"), "external secret");
	expect(run(i, ["manager", "select", "--use", A, "--snapshot", `${A}@1`]).status).toBe(0);
	const addon = join(i.data, "addons/office", O); mkdirSync(join(addon, "node_modules"), { recursive: true });
	writeFileSync(join(addon, ".usage.lock"), "");
	writeFileSync(join(addon, "addon.json"), JSON.stringify({ name: "office", version: O, tag: `addon-office-v${O}`, slot: { commit: "a".repeat(40), kitVersion: "0.1.1" }, kitVersion: "0.1.1", platform: process.platform === "linux" ? "linux" : `${WIN ? "windows" : process.platform}-${process.arch}`, packages: [], seq: 1 }));
	put(i, `addons/office/${O}/node_modules/keep`, "addon");
	return i;
}
function residues(i: Install) {
	const files = [`cache/downloads/${digest}.zip`, `cache/downloads/${digest}.zip.part`, "cache/bun/item", "cache/transpiler/item", "cache/npm/item", "cache/pnpm/store/item", "tmp/.install-a/item", `tmp/.remove-${A}@1-b/item`, "snapshots/.staging-c/profiles/item"];
	for (const f of files) put(i, f);
	cpSync(join(i.data, "bundles", A), join(i.data, "tmp", `.previous-${A}`), { recursive: true });
	cpSync(join(i.data, "addons/office", O), join(i.data, "tmp", `.previous-addon-office-${O}`), { recursive: true });
	return [`cache/downloads/${digest}.zip`, `cache/downloads/${digest}.zip.part`, ...["bun", "transpiler", "npm", "pnpm"].map(p => `cache/${p}`), "tmp/.install-a", `tmp/.remove-${A}@1-b`, "snapshots/.staging-c", `tmp/.previous-${A}`, `tmp/.previous-addon-office-${O}`];
}

test.skipIf(!hasZig)("MC-CLEAN: offline clean removes each residue kind but preserves runtime, snapshot, addon, config and credentials separately", () => {
	const i = fixture(), gone = residues(i);
	for (const p of ["cache/downloads/user.zip.part", "cache/downloads/" + digest + ".zip.extra", "cache/user-cache/keep", "tmp/user-file", "tmp/.install-nothex/keep", "tmp/.remove-user-nothex/keep", "snapshots/.staging-user/keep"]) put(i, p, "KEEP");
	for (const p of ["tmp/.install-11", "tmp/.remove-foo", "snapshots/.staging-22"]) put(i, p, "unrecognised user file");
	const roots = ["bundles", `snapshots/${A}@1`, "addons", "home", "state"], saved = roots.map(p => bytes(join(i.data, p))), user = bytes(i.home);
	const result = run(i, ["manager", "clean"], { env: offline });
	expect(result.status).toBe(0); expect(result.stderr).toBe(""); expect(started(i)).toBe(false);
	for (const p of gone) { expect(existsSync(join(i.data, p))).toBe(false); expect(result.stdout).toContain(p); }
	for (let n = 0; n < roots.length; n++) expect(bytes(join(i.data, roots[n]))).toEqual(saved[n]);
	expect(bytes(i.home)).toEqual(user); expect(readFileSync(join(i.data, "user-file"), "utf8")).toBe("unrecognised user bytes");
	for (const p of ["cache/downloads/user.zip.part", "cache/user-cache/keep", "tmp/user-file", "tmp/.install-nothex/keep", "tmp/.remove-user-nothex/keep", "snapshots/.staging-user/keep"]) expect(readFileSync(join(i.data, p), "utf8")).toBe("KEEP");
	for (const p of ["tmp/.install-11", "tmp/.remove-foo", "snapshots/.staging-22"]) expect(readFileSync(join(i.data, p), "utf8")).toBe("unrecognised user file");
	const before = bytes(i.data); expect(run(i, ["manager", "clean"], { env: offline }).status).toBe(0); expect(bytes(i.data)).toEqual(before);
});

test.skipIf(!hasZig)("MC-CLEAN: absent, empty and clean owned roots create nothing; initialization residue needs manual recovery", () => {
	const i = newInstall(); const before = tree(i.dir);
	expect(run(i, ["manager", "clean"], { env: offline }).status).toBe(0); expect(tree(i.dir)).toEqual(before);
	mkdirSync(i.data); expect(run(i, ["manager", "clean"]).status).toBe(0); expect(readdirSync(i.data)).toEqual([]);
	put(i, ".dsh-data-a.tmp", "partial"); const partial = bytes(i.data);
	const r = run(i, ["manager", "clean"]); expect(r.status).toBe(1); expect(r.stderr).toContain("initialization"); expect(bytes(i.data)).toEqual(partial);
	rmSync(join(i.data, ".dsh-data-a.tmp")); put(i, ".dsh-bin-data.json", JSON.stringify({ kind: "dsh-manager-data", schema: 1 }));
	const owned = bytes(i.data); expect(run(i, ["manager", "clean"]).status).toBe(0); expect(bytes(i.data)).toEqual(owned);
});

test.skipIf(!hasZig)("MC-CLEAN: live sessions, maintenance, snapshot-store and residue claims refuse the entire clean without deleting anything", async () => {
	const i = fixture(); residues(i);
	const session = await holdSession(i, ["--use", A]);
	try { const before = bytes(i.data), r = run(i, ["manager", "clean"]); expect(r.status).toBe(1); expect(r.stderr).toContain(A); expect(r.stderr).toContain("retry"); expect(bytes(i.data)).toEqual(before); }
	finally { expect(await session.finish()).toBe(0); }
	for (const p of ["state/manager.lock", "snapshots/.lock", "tmp/.install-a/.usage.lock", `addons/office/${O}/.usage.lock`]) {
		if (!existsSync(join(i.data, p))) put(i, p, "");
		const held = acquireClaim(join(i.data, p), "shared"); expect(held).not.toBe("busy");
		try { const before = bytes(i.data), r = run(i, ["manager", "clean"]); expect(r.status).toBe(1); expect(r.stderr).toContain(p); expect(r.stderr).toContain("retry"); expect(bytes(i.data)).toEqual(before); }
		finally { if (held !== "busy") held.release(); }
	}
	expect(run(i, ["manager", "clean"]).status).toBe(0);
});

test.skipIf(!hasZig)("MC-CLEAN: keep the only previous generation, including when the public runtime is damaged, and name recovery commands", () => {
	const i = fixture(); residues(i);
	rmSync(join(i.data, "bundles", A, `dsh-native${EXE}`)); rmSync(join(i.data, "addons/office", O), { recursive: true });
	const r = run(i, ["manager", "clean"]); expect(r.status).toBe(0);
	expect(existsSync(join(i.data, "tmp", `.previous-${A}`, `dsh-native${EXE}`))).toBe(true);
	expect(existsSync(join(i.data, "tmp", `.previous-addon-office-${O}`, "addon.json"))).toBe(true);
	expect(r.stderr).toContain(`dsh manager install ${A} --force`); expect(r.stderr).toContain(`dsh manager install --addon office:${O} --force`);
});

test.skipIf(!hasZig)("MC-CLEAN: residue symlinks or junctions are unlinked, never followed; linked storage ancestors refuse", () => {
	const i = fixture(), external = join(i.home, "external"); mkdirSync(external); writeFileSync(join(external, "credential"), "KEEP");
	mkdirSync(join(i.data, "tmp"), { recursive: true });
	for (const p of ["tmp/.install-d", "snapshots/.staging-e"]) symlinkSync(external, join(i.data, p), WIN ? "junction" : "dir");
	const r = run(i, ["manager", "clean"]); expect(r.status).toBe(0); expect(existsSync(join(i.data, "tmp/.install-d"))).toBe(false); expect(existsSync(join(i.data, "snapshots/.staging-e"))).toBe(false); expect(readFileSync(join(external, "credential"), "utf8")).toBe("KEEP");
	rmSync(join(i.data, "tmp"), { recursive: true }); symlinkSync(external, join(i.data, "tmp"), WIN ? "junction" : "dir");
	const rejected = run(i, ["manager", "clean"]); expect(rejected.status).toBe(1); expect(readFileSync(join(external, "credential"), "utf8")).toBe("KEEP");
});

test.skipIf(!hasZig)("MC-CLEAN: explicit application homes inside residue or cache are protected, even through a home alias", () => {
	for (const p of ["cache/bun", "tmp/.install-a", "cache", "tmp/.install-a/profiles"]) {
		const i = fixture(); residues(i); const before = bytes(i.data);
		const r = run(i, ["manager", "clean"], { env: { DSH_HOME: join(i.data, p) } });
		expect(r.status).toBe(1); expect(r.stderr).toContain("DSH_HOME"); expect(r.stderr).toContain("nothing removed"); expect(bytes(i.data)).toEqual(before);
	}
	const i = fixture(); residues(i); const alias = join(i.home, "home-alias"); symlinkSync(join(i.data, "cache/bun"), alias, WIN ? "junction" : "dir");
	const before = bytes(i.data), r = run(i, ["manager", "clean"], { env: { DSH_HOME: alias } }); expect(r.status).toBe(1); expect(r.stderr).toContain("DSH_HOME"); expect(bytes(i.data)).toEqual(before);
});

test.skipIf(!hasZig)("MC-CLEAN: no residue still refuses a live claim without creating state or cache", () => {
	const i = newInstall(); addRuntime(i.data, A); const held = acquireClaim(join(i.data, "bundles", A, ".usage.lock"), "shared"); expect(held).not.toBe("busy");
	try { const before = bytes(i.data), r = run(i, ["manager", "clean"]); expect(r.status).toBe(1); expect(r.stderr).toContain(A); expect(bytes(i.data)).toEqual(before); }
	finally { if (held !== "busy") held.release(); }
});

test.skipIf(!hasZig)("MC-CLEAN: validated parent handles keep deletion inside the original root after an ancestor swap", async () => {
	const i = fixture(); put(i, "tmp/.install-f/item");
	const external = join(i.home, "external"); mkdirSync(join(external, ".install-f"), { recursive: true }); writeFileSync(join(external, ".install-f/credential"), "KEEP");
	const p = spawn(i.exe, ["manager", "clean"], { cwd: i.home, env: { ...baseEnv(i), DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_PAUSE: "clean" }, stdio: "pipe" });
	let stderr = ""; p.stderr.on("data", b => stderr += b.toString()); p.stdout.resume();
	const done = new Promise<number | null>((resolve, reject) => { p.on("close", resolve); p.on("error", reject); });
	const timer = setTimeout(() => p.kill("SIGKILL"), 15_000);
	try {
		const deadline = Date.now() + 5000;
		while (!stderr.includes("test pause: clean") && p.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
		expect(stderr).toContain("test pause: clean"); const original = replaceAncestor(join(i.data, "tmp"), external);
		p.stdin.end("continue"); expect(await done).toBe(0); expect(readFileSync(join(external, ".install-f/credential"), "utf8")).toBe("KEEP"); expect(existsSync(join(original, ".install-f"))).toBe(false);
	} finally { clearTimeout(timer); if (p.exitCode === null) { p.kill("SIGKILL"); await done; } }
}, 30_000);
