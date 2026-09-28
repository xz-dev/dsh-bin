// Launcher tests (5.1–5.3) on the host platform: a fake `dsh-native` shell script records what it gets.
import { beforeAll, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireClaim } from "../../runtime/usage-claim.ts";

const LAUNCHER_DIR = resolve(import.meta.dir, "../../launcher");
const hasZig = Bun.which("zig") !== null;
let built: string;

beforeAll(() => {
	if (!hasZig) return;
	const prefix = mkdtempSync(join(tmpdir(), "dsh-launcher-build-"));
	execFileSync("zig", ["build", "-Dversion=1.2.3-xz.1.1.gabcdef12", "-Dchannel=live", "--prefix", prefix], { cwd: LAUNCHER_DIR, stdio: "inherit" });
	built = join(prefix, "bin", "dsh");
});

/** An install root with the launcher and a fake runtime that dumps argv, env and holds-claim state. */
function install(runtime = "") {
	const root = mkdtempSync(join(tmpdir(), "dsh-launcher-"));
	const bundle = join(root, "bundles", "1.2.3-xz.1.1.gabcdef12");
	mkdirSync(bundle, { recursive: true });
	cpSync(built, join(root, "dsh"));
	writeFileSync(join(bundle, ".usage.lock"), "");
	writeFileSync(
		join(bundle, "dsh-native"),
		`#!/bin/sh\nprintf '%s\\n' "$@" > "${root}/argv"\nenv > "${root}/env"\n${runtime}\n`,
	);
	chmodSync(join(bundle, "dsh-native"), 0o755);
	return { root, bundle };
}

test.skipIf(!hasZig)("5.1: arguments and exit status pass through unchanged", () => {
	const { root } = install("exit 3");
	const args = ["--profile", "tui", "--resume", "abc", "with space", ""];
	const r = spawnSync(join(root, "dsh"), args);
	expect(r.status).toBe(3);
	expect(readFileSync(join(root, "argv"), "utf8")).toBe(`${args.join("\n")}\n`);
});

test.skipIf(!hasZig)("5.1: a missing bundle is one diagnostic naming the path, no fallback", () => {
	const { root, bundle } = install();
	mkdirSync(join(root, "bundles", "0.9.0-xz.1.1.g00000000"));
	writeFileSync(join(root, "bundles", "0.9.0-xz.1.1.g00000000", "dsh-native"), "#!/bin/sh\necho fallback\n", { mode: 0o755 });
	execFileSync("rm", [join(bundle, "dsh-native")]);
	const r = spawnSync(join(root, "dsh"), ["--version"], { encoding: "utf8" });
	expect(r.status).not.toBe(0);
	expect(r.stdout).toBe("");
	expect(r.stderr.trim().split("\n")).toHaveLength(1);
	expect(r.stderr).toContain(join(bundle, "dsh-native"));
});

test.skipIf(!hasZig)("5.2: environment contract; DSH_HOME and user variables untouched", () => {
	const { root } = install();
	const env = { PATH: "/usr/bin:/bin", DSH_HOME: "/x/home", DSH_TUI_STANDALONE: "1", DSH_TUI_STANDALONE_BINARY: "/b", BUN_BE_BUN: "1", KEEP: "k" };
	spawnSync(join(root, "dsh"), [], { env });
	const seen = Object.fromEntries(readFileSync(join(root, "env"), "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
	expect(seen.DSH_BUNDLE_ROOT).toBe(root);
	expect(seen.DSH_BUNDLE_VERSION).toBe("1.2.3-xz.1.1.gabcdef12");
	expect(seen.DSH_BUNDLE_LAUNCHER).toBe(join(root, "dsh"));
	expect(seen.DSH_BUNDLE_CHANNEL).toBe("live");
	expect(seen.DSH_HOME).toBe("/x/home");
	expect(seen.KEEP).toBe("k");
	for (const name of ["DSH_TUI_STANDALONE", "DSH_TUI_STANDALONE_BINARY", "BUN_BE_BUN"]) expect(seen[name]).toBeUndefined();
});

test.skipIf(!hasZig)("5.1/D9: a symlinked launcher resolves the real install root", () => {
	const { root } = install();
	const link = join(mkdtempSync(join(tmpdir(), "dsh-bin-link-")), "dsh");
	symlinkSync(join(root, "dsh"), link);
	expect(spawnSync(link, ["a"]).status).toBe(0);
	expect(readFileSync(join(root, "argv"), "utf8")).toBe("a\n");
});

test.skipIf(!hasZig)("5.3: the running bundle holds the shared claim until it exits", async () => {
	// `exec`: the killed pid must be the only holder of the inherited descriptor.
	const { root, bundle } = install('echo started > "$DSH_BUNDLE_ROOT/started"; exec sleep 30');
	const proc = Bun.spawn([join(root, "dsh")], { stdout: "ignore", stderr: "inherit" });
	for (let i = 0; i < 100 && !(await Bun.file(join(root, "started")).exists()); i++) await Bun.sleep(20);
	expect(acquireClaim(join(bundle, ".usage.lock"), "exclusive")).toBe("busy");
	proc.kill("SIGKILL");
	await proc.exited;
	const claim = acquireClaim(join(bundle, ".usage.lock"), "exclusive");
	expect(claim).not.toBe("busy");
	if (claim !== "busy") claim.release();
});

test.skipIf(!hasZig)("7.6: the launcher embeds a byte-readable version marker", async () => {
	const { launcherVersionOf } = await import("../../runtime/update/context.ts");
	expect(launcherVersionOf(readFileSync(built))).toBe("1.2.3-xz.1.1.gabcdef12");
});

test.skipIf(!hasZig)("7.2: maintenance commands run without the shared claim; everything else holds it", async () => {
	const { root, bundle } = install('echo started > "$DSH_BUNDLE_ROOT/started"; exec sleep 30');
	for (const [args, held] of [[["update", "--force"], false], [["list"], false], [["install", "--addon", "office"], false], [["--profile", "update"], true]] as const) {
		const proc = Bun.spawn([join(root, "dsh"), ...args], { stdout: "ignore", stderr: "inherit" });
		for (let i = 0; i < 100 && !(await Bun.file(join(root, "started")).exists()); i++) await Bun.sleep(20);
		const claim = acquireClaim(join(bundle, ".usage.lock"), "exclusive");
		expect(claim === "busy").toBe(held);
		if (claim !== "busy") claim.release();
		proc.kill("SIGKILL");
		await proc.exited;
		execFileSync("rm", ["-f", join(root, "started")]);
	}
});
