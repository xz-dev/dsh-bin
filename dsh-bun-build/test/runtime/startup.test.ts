// Declared degradations (3.5) and office addon wiring (3.7) against the compiled entry and the built app
// (work/app, or DSH_BIN_TEST_APP). Hermetic: temp DSH_HOME, no API key, PATH without node.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { degradationDetail, HMR_DEGRADATION, officeDegradations } from "../../runtime/compat/degradations.ts";

const ROOT = resolve(import.meta.dir, "../..");
const APP = resolve(process.env.DSH_BIN_TEST_APP ?? join(ROOT, "work/app"));
const ADDON = resolve(process.env.DSH_BIN_TEST_ADDON ?? join(ROOT, "work/addon-office"));
const built = existsSync(join(APP, "lib/bin.js")) && existsSync(join(ADDON, "node_modules"));

let root: string;
let native: string;

/** `id (package): detail` lines of dsh's "did not activate" startup warning. */
function inactive(stderr: string): string[] {
	const lines = stderr.split("\n");
	const start = lines.findIndex((l) => / did not activate$/.test(l));
	if (start < 0) return [];
	const out: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (!/^\S+ \(@?[^)]+\): /.test(line)) break;
		out.push(line);
	}
	return out;
}

function profile(home: string, name: string, pkg: object, patch: string) {
	const dir = join(home, "profiles", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, private: true, dsh: { profile: pkg } }));
	writeFileSync(join(dir, "cordis.patch.yml"), patch);
	return home;
}

/** A PATH directory with only git and sh, so no JavaScript runtime is reachable. */
function noNodePath() {
	const dir = join(root, "path");
	if (!existsSync(dir)) {
		mkdirSync(dir);
		for (const tool of ["git", "sh"]) symlinkSync(Bun.which(tool)!, join(dir, tool));
	}
	return dir;
}

const env = (home: string) => {
	const e: Record<string, string> = { PATH: noNodePath(), HOME: home, DSH_HOME: home, NO_COLOR: "1" };
	for (const k of ["TMPDIR", "LANG"]) if (process.env[k]) e[k] = process.env[k]!;
	return e;
};

async function run(args: string[], home: string, until?: RegExp, extra: Record<string, string> = {}) {
	const proc = Bun.spawn([native, ...args], { cwd: home, env: { ...env(home), ...extra }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	let stderr = "";
	let stdout = "";
	const read = async (stream: ReadableStream<Uint8Array>, sink: (s: string) => void) => {
		for await (const chunk of stream) {
			sink(new TextDecoder().decode(chunk));
			if (until?.test(stdout + stderr)) proc.kill();
		}
	};
	const timer = setTimeout(() => proc.kill(), 45_000);
	await Promise.all([read(proc.stdout, (s) => (stdout += s)), read(proc.stderr, (s) => (stderr += s))]);
	clearTimeout(timer);
	return { code: await proc.exited, stdout, stderr };
}

const line = (id: string, d: { packageName: string; reason: string }) => `${id} (${d.packageName}): ${degradationDetail(d)}`;

describe.skipIf(!built)("compiled entry startup", () => {
	let officeDir: string;
	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "dsh-startup-"));
		const bundle = join(root, "bundles", "V1");
		mkdirSync(join(bundle, "bin"), { recursive: true });
		writeFileSync(join(bundle, ".usage.lock"), "");
		native = join(bundle, "dsh-native");
		execFileSync("bun", [join(ROOT, "scripts/compile-entry.mjs"), `bun-${process.platform}-${process.arch}`, native], { stdio: "ignore" });
		symlinkSync(APP, join(bundle, "app"));
		writeFileSync(join(bundle, "bin", "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		officeDir = join(root, "addons", "office", "A1");
		cpSync(join(ADDON, "node_modules"), join(officeDir, "node_modules"), { recursive: true });
		writeFileSync(join(officeDir, ".usage.lock"), "");
	});
	afterAll(() => {
		if (root) rmSync(root, { recursive: true, force: true });
	});

	// The manager resolved the office addon (or none) and passes its directory in DSH_MANAGER_LAUNCH.
	let n = 0;
	const launch = (home: string, office?: object) => {
		const id = `V1@${++n}`, plugins = join(root, "snapshots", id), config = join(root, "config-snapshots", id);
		for (const dir of [plugins, config]) { mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(join(dir, ".usage.lock"), ""); }
		cpSync(join(home, "profiles"), join(plugins, "profiles"), { recursive: true });
		// Protocol 2: user patch is config content, not shared HOME or plugin inventory.
		for (const name of readdirSync(join(home, "profiles"))) {
			const dest = join(config, "profiles", name);
			mkdirSync(dest, { recursive: true, mode: 0o700 });
			cpSync(join(home, "profiles", name, "cordis.patch.yml"), join(dest, "cordis.patch.yml"));
			chmodSync(join(dest, "cordis.patch.yml"), 0o600);
			rmSync(join(plugins, "profiles", name, "cordis.patch.yml"));
		}
		return JSON.stringify({ protocol: 2, runtime: "V1", dataRoot: root, home, snapshot: { id, dir: plugins }, configSnapshot: { id, dir: config }, addons: office ? { office } : {}, cache: join(root, "cache"), tmp: join(root, "tmp"), manager: "t" });
	};
	const NO_OFFICE = "the office addon is not installed for this dsh; run `dsh manager install --addon office`";

	test("3.5: tui startup warnings equal the declared degradation list", async () => {
		const home = profile(
			mkdtempSync(join(root, "home-")),
			"tui",
			{ bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] },
			"- id: hmr\n  disabled: false\n",
		);
		const { stderr } = await run(["--profile", "tui", "--no-open", "--port", "0", "--host", "127.0.0.1"], home, /dsh web: http/, { DSH_MANAGER_LAUNCH: launch(home) });
		const office = officeDegradations(NO_OFFICE);
		expect(inactive(stderr).sort()).toEqual([line("hmr", HMR_DEGRADATION), line("office-to-pdf", office[0])].sort());
	}, 60_000);

	const OFFICE_PATCH =
		"- insert:\n    - id: office-to-pdf\n      name: '@deepseek-ai/dsh-office-to-pdf'\n    - id: skill-office\n      name: '@deepseek-ai/dsh-skill-office'\n";
	const cases: [string, () => object | undefined, (stderr: string) => void][] = [
		["the addon directory from the launch enables office", () => ({ version: "A1", dir: officeDir }), (e) => {
			expect(inactive(e)).toEqual([]);
			expect(e).not.toContain("out of slot");
		}],
		["the manager's out-of-slot warning is printed once", () => ({ version: "A1", dir: officeDir, warning: "dsh: warning: office addon A1 is out of slot for this dsh" }), (e) => {
			expect(inactive(e)).toEqual([]);
			expect(e.split("\n").filter((l) => l.includes("office addon A1 is out of slot"))).toHaveLength(1);
		}],
		["an incomplete addon directory degrades office naming the forced reinstall", () => ({ version: "C9", dir: join(root, "addons", "office", "C9") }), (e) => {
			const reasons = inactive(e);
			expect(reasons).toHaveLength(2);
			for (const r of reasons) expect(r).toMatch(/DeclaredDegradation: .*office addon C9 is incomplete.*dsh manager install --addon office:C9 --force/);
		}],
		["no addon in the launch degrades office naming `dsh manager install --addon office`", () => undefined, (e) => {
			const office = officeDegradations(NO_OFFICE);
			expect(inactive(e).sort()).toEqual([line("office-to-pdf", office[0]), line("skill-office", office[1])].sort());
		}],
	];
	for (const [name, office, check] of cases) {
		test(`MC-ADDON (runtime side): ${name}`, async () => {
			const home = profile(mkdtempSync(join(root, "home-")), "headless", { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] }, OFFICE_PATCH);
			const { code, stderr } = await run(["--profile", "headless", "hi"], home, undefined, { DSH_MANAGER_LAUNCH: launch(home, office()) });
			expect(code).toBe(1);
			expect(stderr).toContain("MISSING_CREDENTIAL");
			check(stderr);
		}, 60_000);
	}
});
