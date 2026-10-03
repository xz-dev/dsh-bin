// MC-IN-USE / RB-RESTART: real manager processes, live fake-native sessions, no user installation.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireClaim } from "./claim-probe.ts";
import { addRuntime, build, cleanup, hasZig, holdSession, launchOf, newInstall, run, tree, WIN, type Install } from "./harness.ts";

beforeAll(() => { if (hasZig) build(); }, 300_000);
afterAll(cleanup);
const A = "1.0.0-b1.1.gdeadbeef", B = "2.0.0-b2.1.gdeadbeef", C = "3.0.0-b3.1.gdeadbeef";
const O = "0.1.1-b1.1.gdeadbeef", P = "0.1.1-b2.1.gdeadbeef";
const slot = { commit: "a".repeat(40), kitVersion: "0.1.1" };
const platform = process.platform === "linux" ? "linux" : `${WIN ? "windows" : process.platform}-${process.arch}`;
const bytes = (dir: string) => tree(dir).map(p => [p, lstatSync(join(dir, p)).isFile() ? createHash("sha256").update(readFileSync(join(dir, p))).digest("hex") : "dir"]);
function fixture(addon = false) {
	const i = newInstall();
	for (const [id, n] of [[A, 1], [B, 2], [C, 3]] as const) {
		addRuntime(i.data, id, { run: n, patch: addon ? { addons: { office: { slot, known: [], pinned: null } } } : {} });
		expect(run(i, ["manager", "snapshot", "plugins", "new", "--use", id, "--empty"]).status).toBe(0);
	}
	if (addon) for (const [version, seq] of [[O, 1], [P, 2]] as const) {
		const dir = join(i.data, "addons", "office", version); mkdirSync(join(dir, "node_modules"), { recursive: true });
		writeFileSync(join(dir, "addon.json"), JSON.stringify({ name: "office", version, tag: `addon-office-v${version}`, slot, kitVersion: slot.kitVersion, platform, packages: [], seq }));
		writeFileSync(join(dir, ".usage.lock"), ""); writeFileSync(join(dir, "node_modules", "keep"), "addon bytes");
	}
	return i;
}
function refused(i: Install, args: string[], ids: string[]) {
	const r = run(i, ["manager", ...args]);
	expect(r.status).toBe(1); expect(r.stdout).toBe("");
	for (const id of ids) expect(r.stderr).toContain(id);
	return r;
}

test.skipIf(!hasZig)("MC-IN-USE: runtime, snapshot and addon batch removal refuse busy objects unchanged, succeed after exit", async () => {
	const i = fixture(true), roots = ["bundles", "snapshots", "addons"].map(p => join(i.data, p));
	const saved = roots.map(bytes), session = await holdSession(i, ["--use", A, "--snapshot", `${A}@1`, "--addon", `office:${O}`, "probe"]);
	try {
		for (const args of [["uninstall", B, A], ["snapshot", "plugins", "remove", `${B}@1`, `${A}@1`], ["uninstall", "--addon", "office"]]) {
			const r = refused(i, args, [args[0] === "snapshot" ? `${A}@1` : args.includes("--addon") ? O : A]);
			expect(r.stderr).toContain("in use"); expect(roots.map(bytes)).toEqual(saved);
		}
	} finally { expect(await session.finish()).toBe(0); }
	for (const args of [["uninstall", B, A], ["snapshot", "plugins", "remove", `${B}@1`, `${A}@1`], ["uninstall", "--addon", "office"]]) expect(run(i, ["manager", ...args]).status).toBe(0);
	expect(existsSync(join(i.data, "bundles", A))).toBe(false); expect(existsSync(join(i.data, "snapshots", `${A}@1`))).toBe(false); expect(existsSync(join(i.data, "addons", "office", O))).toBe(false);
});

test.skipIf(!hasZig)("MC-IN-USE: runtime and snapshot preflight reports every missing, pinned/selected and busy target before any delete", async () => {
	const i = fixture(); expect(run(i, ["manager", "select", "--use", B, "--snapshot", `${B}@1`]).status).toBe(0);
	const session = await holdSession(i, ["--use", A]), roots = ["bundles", "snapshots"].map(p => join(i.data, p)), saved = roots.map(bytes);
	try {
		const runtime = refused(i, ["uninstall", C, "missing-one", B, A, "missing-two"], ["missing-one", B, A, "missing-two"]);
		expect(runtime.stderr).toContain("selection"); expect(runtime.stderr).toContain("in use"); expect(roots.map(bytes)).toEqual(saved);
		const snap = refused(i, ["snapshot", "plugins", "remove", `${C}@1`, "missing@1", `${B}@1`, `${A}@1`, "another@1"], ["missing@1", `${B}@1`, `${A}@1`, "another@1"]);
		expect(snap.stderr).toContain("selection"); expect(snap.stderr).toContain("in use"); expect(roots.map(bytes)).toEqual(saved);
	} finally { expect(await session.finish()).toBe(0); }
});

test.skipIf(!hasZig)("RB-RESTART / MC-IN-USE: changing default during a session does not change restarted A/S/addon or release its claims", async () => {
	const i = fixture(true);
	expect(run(i, ["manager", "select", "--use", A, "--snapshot", `${A}@1`, "--addon", `office:${O}`]).status).toBe(0);
	const session = await holdSession(i, ["probe"], { FAKE_RESTART_WAIT: "1", FAKE_RESTART_WRITE: join(i.out, "restarted") });
	try {
		const first = launchOf(i);
		expect(run(i, ["manager", "select", "--use", B, "--snapshot", `${B}@1`, "--addon", `office:${P}`]).status).toBe(0);
		session.proc.stdin.write("r"); await session.wait("2");
		expect(launchOf(i, "2")).toEqual(first);
		for (const args of [["uninstall", A], ["snapshot", "plugins", "remove", `${A}@1`], ["uninstall", "--addon", `office:${O}`]]) expect(refused(i, args, [args[0] === "snapshot" ? `${A}@1` : args.includes("--addon") ? O : A]).stderr).toContain("in use");
		expect(run(i, ["probe"]).status).toBe(0); expect(launchOf(i)).toMatchObject({ runtime: B, snapshot: { id: `${B}@1` }, addons: { office: { version: P } } });
	} finally { expect(await session.finish()).toBe(0); }
	for (const args of [["uninstall", A], ["snapshot", "plugins", "remove", `${A}@1`], ["uninstall", "--addon", `office:${O}`]]) expect(run(i, ["manager", ...args]).status).toBe(0);
});

test.skipIf(!hasZig)("MC-IN-USE: a busy runtime launch fails fast; missing runtime guard refuses, missing addon guard degrades", () => {
	const i = fixture(true), guard = join(i.data, "bundles", A, ".usage.lock"), held = acquireClaim(guard, "exclusive");
	expect(held).not.toBe("busy");
	try {
		const start = Date.now(), r = run(i, ["--use", A, "probe"]);
		expect(r.status).toBe(1); expect(r.stderr).toContain(A); expect(r.stderr).toContain("retry"); expect(Date.now() - start).toBeLessThan(3000);
	} finally { if (held !== "busy") held.release(); }
	rmSync(guard); const r = run(i, ["--use", A, "probe"]);
	expect(r.status).toBe(1); expect(r.stderr).toContain(A); expect(r.stderr).toContain("--force");
	expect(run(i, ["manager", "uninstall", A]).status).toBe(0);
	rmSync(join(i.data, "addons", "office", O, ".usage.lock"));
	const degraded = run(i, ["--use", B, "--addon", `office:${O}`, "probe"]);
	expect(degraded.status).toBe(0); expect(degraded.stderr.trim().split("\n")).toHaveLength(1); expect(degraded.stderr).toContain(O); expect(launchOf(i).addons.office).toBeUndefined();
});
