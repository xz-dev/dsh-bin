// RB-INDEPENDENT / MC-ARGS: one real local runtime archive, two independently versioned managers.
// CI intentionally skips when work/app is absent; fake-native tests are not this acceptance gate.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { acquireClaim } from "./claim-probe.ts";
import { MANAGER_DIR, EXE } from "./harness.ts";

const RUNTIME_PROJECT = resolve(MANAGER_DIR, "../dsh-bun-build");
const available = existsSync(join(RUNTIME_PROJECT, "work/app"));
const skipReason = "requires local dsh-bun-build/work/app (absent on CI; real archive not tested)";
let root: string, bundle: string, id: string, managers: string[], home: string, cwd: string, path: string, version: string;

beforeAll(() => {
	if (!available) return;
	const cache = join(homedir(), ".cache");
	mkdirSync(cache, { recursive: true });
	root = realpathSync(mkdtempSync(join(cache, "dsh-real-runtime-")));
	const out = join(root, "build");
	const result = execFileSync(process.execPath, ["scripts/local-build.mjs", out, "release", "1"], { cwd: RUNTIME_PROJECT, encoding: "utf8", timeout: 240_000 });
	const built = JSON.parse(result.trim().split("\n").at(-1)!);
	id = built.id;
	const tools = join(root, "tools");
	mkdirSync(tools);
	const data = join(tools, "dsh-bin");
	bundle = join(data, "bundles", id);
	mkdirSync(bundle, { recursive: true });
	writeFileSync(join(data, ".dsh-bin-data.json"), JSON.stringify({ kind: "dsh-manager-data", schema: 1 }));
	// Tiny Zig test driver uses the manager's own ZIP extraction, not an external unzip.
	const driver = join(root, `extract${EXE}`);
	execFileSync("zig", ["build-exe", "--dep", "zip", `-Mroot=${join(import.meta.dir, "extract-driver.zig")}`, `-Mzip=${join(MANAGER_DIR, "src/zip.zig")}`, `-femit-bin=${driver}`], { cwd: root, stdio: "inherit", timeout: 120_000 });
	execFileSync(driver, [built.zip, bundle], { cwd: root, timeout: 120_000 });
	version = JSON.parse(readFileSync(join(bundle, "app/package.json"), "utf8")).version;
	managers = ["1.0.0", "2.0.0"].map((v) => {
		const prefix = join(root, `manager-${v}`);
		execFileSync("zig", ["build", `-Dversion=${v}`, "--prefix", prefix], { cwd: MANAGER_DIR, stdio: "inherit", timeout: 300_000 });
		const exe = join(tools, `dsh-${v}${EXE}`);
		cpSync(join(prefix, `bin/dsh${EXE}`), exe);
		return exe;
	});
	home = join(root, "external home");
	cwd = join(root, "workspace with spaces");
	path = join(root, "empty-path");
	for (const dir of [home, cwd, path]) mkdirSync(dir);
}, 600_000);
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

const env = () => ({ PATH: path, HOME: home, USERPROFILE: home, DSH_HOME: home, NO_COLOR: "1", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) });
const run = (exe: string, args: string[]) => spawnSync(exe, ["--use", id, ...args], { cwd, env: env(), encoding: "utf8", timeout: 30_000 });

test.skipIf(!available)(`RB-HOME: real app reads shared cordis.patch.yml from external home, not snapshot/../../profiles${available ? "" : ` — SKIP: ${skipReason}`}`, () => {
	const snapshot = join(root, "tools/dsh-bin/snapshots", `${id}@1`);
	const profile = join(snapshot, "profiles", "split-probe");
	mkdirSync(profile, { recursive: true });
	writeFileSync(join(profile, "package.json"), JSON.stringify({ name: "split-profile", private: true, dsh: { profile: { bundles: [] } } }));
	writeFileSync(join(snapshot, ".usage.lock"), "");
	const shared = join(home, "profiles", "split-probe");
	mkdirSync(shared, { recursive: true });
	writeFileSync(join(shared, "cordis.patch.yml"), "- insert:\n    - id: from-external-home\n      name: dsh-acceptance-probe\n");
	const launch = { protocol: 1, runtime: id, dataRoot: join(root, "tools/dsh-bin"), home, snapshot: { id: `${id}@1`, dir: snapshot }, addons: {}, cache: null, manager: "1.0.0" };
	const result = spawnSync(join(bundle, `dsh-native${EXE}`), ["--profile", "split-probe", "--dump-config"], { cwd, env: { ...env(), DSH_MANAGER_LAUNCH: JSON.stringify(launch) }, encoding: "utf8", timeout: 30_000 });
	if (result.status !== 0) console.error(result.stdout, result.stderr);
	expect(result.status).toBe(0);
	expect(result.stdout).toContain("from-external-home");
	expect(readFileSync(join(shared, "cordis.patch.yml"), "utf8")).toContain("from-external-home");
	expect(existsSync(join(root, "tools/dsh-bin/profiles"))).toBe(false);
	expect(existsSync(join(profile, "cordis.patch.yml"))).toBe(false);
}, 60_000);

// A real plugin mounted by upstream's unmodified profile boot. It observes app args/cwd/stdin
// and returns a nonzero exit through upstream's cmdline shutdown, not a replacement bin.js.
const PROBE = `export function apply(ctx) {
	const readInput = (async () => { let text = ""; for await (const chunk of process.stdin) text += chunk; return text; })();
	ctx.appReady.onReady(() => {
		setTimeout(async () => {
			const input = await readInput;
			console.log("DSH_PROBE " + JSON.stringify({ args: ctx.cmdlineArgs.get(), cwd: process.cwd(), input, launch: JSON.parse(process.env.DSH_MANAGER_LAUNCH) }));
			console.log("DSH_HELD");
			setTimeout(() => ctx.appExit(7), 4000);
		}, 0);
	});
}
`;

test.skipIf(!available)(`RB-INDEPENDENT / MC-ARGS: same real archive through two manager versions, no host Node/Bun${available ? "" : ` — SKIP: ${skipReason}`}`, async () => {
	const nativeBefore = readFileSync(join(bundle, `dsh-native${EXE}`));
	for (const [n, exe] of managers.entries()) {
		const appVersion = run(exe, ["--version"]);
		if (appVersion.status !== 0) console.error(appVersion.stdout, appVersion.stderr);
		expect(appVersion.status).toBe(0);
		expect(appVersion.stdout).toContain(version);
		const help = run(exe, ["--help"]);
		expect(help.status).toBe(0);
		expect(help.stdout).toContain("dsh: boot a DeepSeek Harness profile");
		expect(spawnSync(exe, ["manager", "--version"], { env: env(), encoding: "utf8" }).stdout).toContain(n ? "2.0.0" : "1.0.0");
	}
	const profile = join(home, "profiles", "probe");
	const plugin = join(profile, "node_modules", "dsh-acceptance-probe");
	mkdirSync(plugin, { recursive: true });
	writeFileSync(join(profile, "package.json"), JSON.stringify({ name: "acceptance-profile", private: true, dsh: { profile: { bundles: [] } } }));
	writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "dsh-acceptance-probe", version: "1.0.0", type: "module", main: "index.js" }));
	writeFileSync(join(plugin, "index.js"), PROBE);
	writeFileSync(join(profile, "cordis.patch.yml"), "- insert:\n    - id: acceptance-probe\n      name: dsh-acceptance-probe\n");
	const args = ["-p", "manager update --use latest", "with space", "", "--use", "app-tail"];
	const input = "stdin belongs to real dsh\n第二行\n";
	for (const [n, exe] of managers.entries()) {
		const proc = Bun.spawn([exe, "--use", id, "--profile", "probe", ...args], { cwd, env: env(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		proc.stdin.write(input);
		proc.stdin.end();
		const timer = setTimeout(() => proc.kill("SIGKILL"), 30_000);
		let stdout = "";
		const stderr = new Response(proc.stderr).text();
		try {
			for await (const chunk of proc.stdout) {
				stdout += new TextDecoder().decode(chunk);
				if (stdout.includes("DSH_HELD")) {
					const claim = acquireClaim(join(bundle, ".usage.lock"), "exclusive");
					try { expect(claim).toBe("busy"); } finally { if (claim !== "busy") claim.release(); }
				}
			}
			const code = await proc.exited;
			if (code !== 7 || !stdout.includes("DSH_PROBE ")) console.error(stdout, await stderr);
			expect(code).toBe(7);
			const report = JSON.parse(stdout.split("\n").find((l) => l.startsWith("DSH_PROBE "))!.slice(10));
			expect(report).toMatchObject({ args, cwd, input, launch: { protocol: 1, runtime: id, home, snapshot: null, manager: n ? "2.0.0" : "1.0.0" } });
			expect(stdout).toContain("DSH_HELD");
			expect(await stderr).not.toContain("failed to load");
		} finally { clearTimeout(timer); if (proc.exitCode === null) { proc.kill("SIGKILL"); await proc.exited; } }
		const claim = acquireClaim(join(bundle, ".usage.lock"), "exclusive");
		expect(claim).not.toBe("busy");
		if (claim !== "busy") claim.release();
	}
	expect(readFileSync(join(bundle, `dsh-native${EXE}`)).equals(nativeBefore)).toBe(true);
}, 120_000);
