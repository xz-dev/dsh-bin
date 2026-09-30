// Declared degradations (3.5) and office addon wiring (3.7) against the compiled entry and the built app
// (work/app, or DSH_BIN_TEST_APP). Hermetic: temp DSH_HOME, no API key, PATH without node.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { degradationDetail, HMR_DEGRADATION, officeDegradations } from "../../runtime/compat/degradations.ts";

const ROOT = resolve(import.meta.dir, "../..");
const APP = resolve(process.env.DSH_BIN_TEST_APP ?? join(ROOT, "work/app"));
const ADDON = resolve(process.env.DSH_BIN_TEST_ADDON ?? join(ROOT, "work/addon-office"));
const built = existsSync(join(APP, "lib/bin.js")) && existsSync(join(ADDON, "node_modules"));
const SLOT_A = { commit: "a".repeat(40), kitVersion: "0.1.1" };
const SLOT_B = { commit: "b".repeat(40), kitVersion: "0.1.1" };

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
	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "dsh-startup-"));
		const bundle = join(root, "bundles", "V1");
		mkdirSync(join(bundle, "bin"), { recursive: true });
		native = join(bundle, "dsh-native");
		execFileSync("bun", [join(ROOT, "scripts/compile-entry.mjs"), `bun-${process.platform}-${process.arch}`, native], { stdio: "ignore" });
		symlinkSync(APP, join(bundle, "app"));
		writeFileSync(join(bundle, "bin", "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		writeFileSync(
			join(bundle, "bundle.json"),
			JSON.stringify({ schemaVersion: 2, name: "dsh-bin", version: "V1", channel: "release", addons: { office: { slot: SLOT_A, pinned: "A1", known: [] } } }),
		);
		for (const [version, slot] of [["A1", SLOT_A], ["B1", SLOT_B]] as const) {
			const dir = join(root, "addons", "office", version);
			cpSync(join(ADDON, "node_modules"), join(dir, "node_modules"), { recursive: true });
			writeFileSync(join(dir, "addon.json"), JSON.stringify({ name: "office", version, tag: `dsh-addon-office-v${version}`, kitVersion: "0.1.1", slot, packages: [] }));
		}
	});
	afterAll(() => {
		if (root) rmSync(root, { recursive: true, force: true });
	});

	const installOnly = (versions: string[]) => {
		for (const v of ["A1", "B1"]) {
			const dir = join(root, "addons", "office", v);
			const parked = join(root, "parked", v);
			mkdirSync(join(root, "parked"), { recursive: true });
			if (versions.includes(v) && existsSync(parked)) renameSync(parked, dir);
			if (!versions.includes(v) && existsSync(dir)) renameSync(dir, parked);
		}
	};
	test("3.5: tui startup warnings equal the declared degradation list", async () => {
		installOnly([]);
		const home = profile(
			mkdtempSync(join(root, "home-")),
			"tui",
			{ bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] },
			"- id: hmr\n  disabled: false\n",
		);
		const { stderr } = await run(["--profile", "tui", "--no-open", "--port", "0", "--host", "127.0.0.1"], home, /dsh web: http/);
		const office = officeDegradations("the office addon is not installed; run `dsh install --addon office`");
		expect(inactive(stderr).sort()).toEqual([line("hmr", HMR_DEGRADATION), line("office-to-pdf", office[0])].sort());
	}, 60_000);

	const OFFICE_PATCH =
		"- insert:\n    - id: office-to-pdf\n      name: '@deepseek-ai/dsh-office-to-pdf'\n    - id: skill-office\n      name: '@deepseek-ai/dsh-skill-office'\n";
	// 5.5: the version comes from the launch (`--addon office:<v>` in DSH_BIN_LAUNCH), else the in-slot default.
	const launch = (addons: string[]) => JSON.stringify({ protocol: 2, version: "V1", source: "use", use: "V1", snapshot: null, addons, selection: null });
	const cases: [string, string[], string[], (stderr: string, code: number) => void][] = [
		["the in-slot default is used", ["A1", "B1"], [], (e) => {
			expect(inactive(e)).toEqual([]);
			expect(e).not.toContain("out of slot");
		}],
		["a named out-of-slot addon is used with one warning", ["A1", "B1"], ["office:B1"], (e) => {
			expect(inactive(e)).toEqual([]);
			expect(e.split("\n").filter((l) => l.includes("office addon B1 is out of slot"))).toHaveLength(1);
		}],
		["only an out-of-slot version installed: office degrades, naming dsh install --addon office", ["B1"], [], (e) => {
			const reasons = inactive(e);
			expect(reasons).toHaveLength(2);
			for (const r of reasons) expect(r).toMatch(/DeclaredDegradation: .*no installed office addon version fits.*dsh install --addon office/);
		}],
		["no addon degrades office naming dsh install --addon office", [], [], (e) => {
			const office = officeDegradations("the office addon is not installed; run `dsh install --addon office`");
			expect(inactive(e).sort()).toEqual([line("office-to-pdf", office[0]), line("skill-office", office[1])].sort());
		}],
	];
	for (const [name, versions, addons, check] of cases) {
		test(`3.7/5.5: ${name}`, async () => {
			installOnly(versions);
			const home = profile(mkdtempSync(join(root, "home-")), "headless", { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] }, OFFICE_PATCH);
			const { code, stderr } = await run(["--profile", "headless", "hi"], home, undefined, addons.length ? { DSH_BIN_LAUNCH: launch(addons) } : {});
			expect(code).toBe(1);
			expect(stderr).toContain("MISSING_CREDENTIAL");
			check(stderr, code);
		}, 60_000);
	}
	test("5.5: a named office version that is not installed fails the launch with one diagnostic", async () => {
		installOnly(["A1"]);
		const home = profile(mkdtempSync(join(root, "home-")), "headless", { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] }, OFFICE_PATCH);
		const { code, stderr } = await run(["--profile", "headless", "hi"], home, undefined, { DSH_BIN_LAUNCH: launch(["office:C9"]) });
		expect(code).toBe(1);
		expect(stderr).toContain("office addon C9 is not installed");
		expect(stderr).toContain("dsh install --addon office:C9");
		expect(stderr).not.toContain("MISSING_CREDENTIAL");
	}, 60_000);
});
