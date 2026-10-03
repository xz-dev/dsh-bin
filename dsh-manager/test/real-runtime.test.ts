// RB-INDEPENDENT / MC-ARGS: one real local runtime archive, two independently versioned managers.
// CI intentionally skips when work/app is absent; fake-native tests are not this acceptance gate.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireClaim } from "./claim-probe.ts";
import { tree } from "./harness.ts";
import { MANAGER_DIR, EXE } from "./harness.ts";

const RUNTIME_PROJECT = resolve(MANAGER_DIR, "../dsh-bun-build");
const available = existsSync(join(RUNTIME_PROJECT, "work/app"));
const skipReason = "requires local dsh-bun-build/work/app (absent on CI; real archive not tested)";
let root: string, bundle: string, id: string, managers: string[], home: string, cwd: string, path: string, version: string, runtimeZip: string, runtimeManifest: string;

beforeAll(() => {
	if (!available) return;
	root = realpathSync(mkdtempSync(join(tmpdir(), "dsh-real-runtime-")));
	const out = join(root, "build");
	const result = execFileSync(process.execPath, ["scripts/local-build.mjs", out, "release", "1"], { cwd: RUNTIME_PROJECT, encoding: "utf8", timeout: 240_000 });
	const built = JSON.parse(result.trim().split("\n").at(-1)!);
	id = built.id;
	runtimeZip = built.zip;
	runtimeManifest = join(out, `${built.tag}.json`);
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
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); }, 60_000);

const env = () => ({ PATH: path, HOME: home, USERPROFILE: home, DSH_HOME: home, NO_COLOR: "1", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) });
const run = (exe: string, args: string[]) => spawnSync(exe, ["--use", id, ...args], { cwd, env: env(), encoding: "utf8", timeout: 30_000 });

test.skipIf(!available)(`RB-COMPLETION: real archive CLI description matches actual fixed --help, without profile/plugin probing${available ? "" : ` — SKIP: ${skipReason}`}`, () => {
	const cli = JSON.parse(readFileSync(join(bundle, "completion.json"), "utf8"));
	const metadata = JSON.parse(readFileSync(join(bundle, "bundle.json"), "utf8"));
	expect(metadata.requiredPaths).toContain("completion.json");
	expect(cli.schemaVersion).toBe(1);
	const help = run(managers[0]!, ["--help"]);
	expect(help.status).toBe(0);
	const helpOptions = [...help.stdout.matchAll(/^  (-\S[^\n]*)/gm)].flatMap((m) => m[1].split(/\s{2,}/)[0]!.match(/--?[A-Za-z][\w-]*/g) ?? []).sort();
	const rootOptions = cli.commands.find((c: { name: string }) => c.name === "").options;
	expect(rootOptions.flatMap((o: { names: string[] }) => o.names).sort()).toEqual(helpOptions);
	for (const option of rootOptions) {
		const line = help.stdout.split("\n").find((s: string) => option.names.some((n: string) => s.trimStart().startsWith(n)))!;
		expect(/[<[]/.test(line.split(/\s{2,}/).filter(Boolean)[0]!)).toBe(option.takesValue);
	}
	for (const command of cli.commands.filter((c: { name: string }) => c.name)) {
		expect(help.stdout).toContain(`dsh ${command.name} `);
	}
}, 60_000);

test.skipIf(!available)(`RB-HOME: real app reads shared cordis.patch.yml from external home, not snapshot/../../profiles${available ? "" : ` — SKIP: ${skipReason}`}`, () => {
	const first = run(managers[0]!, ["--version"]);
	expect(first.status).toBe(0);
	const snapshot = join(root, "tools/dsh-bin/snapshots", `${id}@1`);
	const profile = join(snapshot, "profiles", "split-probe");
	mkdirSync(profile, { recursive: true });
	writeFileSync(join(profile, "package.json"), JSON.stringify({ name: "split-profile", private: true, dsh: { profile: { bundles: [] } } }));
	writeFileSync(join(snapshot, ".usage.lock"), "");
	const shared = join(home, "profiles", "split-probe");
	mkdirSync(shared, { recursive: true });
	writeFileSync(join(shared, "cordis.patch.yml"), "- insert:\n    - id: from-external-home\n      name: dsh-acceptance-probe\n");
	const result = run(managers[0]!, ["--profile", "split-probe", "--dump-config"]);
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
	const profile = join(root, "tools/dsh-bin/snapshots", `${id}@1`, "profiles", "probe");
	const shared = join(home, "profiles", "probe");
	mkdirSync(shared, { recursive: true });
	const plugin = join(profile, "node_modules", "dsh-acceptance-probe");
	mkdirSync(plugin, { recursive: true });
	writeFileSync(join(profile, "package.json"), JSON.stringify({ name: "acceptance-profile", private: true, dsh: { profile: { bundles: [] } } }));
	writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "dsh-acceptance-probe", version: "1.0.0", type: "module", main: "index.js" }));
	writeFileSync(join(plugin, "index.js"), PROBE);
	writeFileSync(join(shared, "cordis.patch.yml"), "- insert:\n    - id: acceptance-probe\n      name: dsh-acceptance-probe\n");
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
					for (const guard of [join(bundle, ".usage.lock"), join(root, "tools/dsh-bin/snapshots", `${id}@1`, ".usage.lock")]) {
						const claim = acquireClaim(guard, "exclusive");
						try { expect(claim).toBe("busy"); } finally { if (claim !== "busy") claim.release(); }
					}
				}
			}
			const code = await proc.exited;
			if (code !== 7 || !stdout.includes("DSH_PROBE ")) console.error(stdout, await stderr);
			expect(code).toBe(7);
			const report = JSON.parse(stdout.split("\n").find((l) => l.startsWith("DSH_PROBE "))!.slice(10));
			expect(report).toMatchObject({ args, cwd, input, launch: { protocol: 2, runtime: id, home, snapshot: { id: `${id}@1`, dir: join(root, "tools/dsh-bin/snapshots", `${id}@1`) }, manager: n ? "2.0.0" : "1.0.0" } });
			expect(stdout).toContain("DSH_HELD");
			expect(await stderr).not.toContain("failed to load");
		} finally { clearTimeout(timer); if (proc.exitCode === null) { proc.kill("SIGKILL"); await proc.exited; } }
		const claim = acquireClaim(join(bundle, ".usage.lock"), "exclusive");
		expect(claim).not.toBe("busy");
		if (claim !== "busy") claim.release();
	}
	expect(readFileSync(join(bundle, `dsh-native${EXE}`)).equals(nativeBefore)).toBe(true);
}, 120_000);

// Real pinned Bun + embedded pnpm, using the environment seen by a plugin in a real manager start.
// Local registry supplies deterministic bytes; no public registry or host Bun/Node in tested PATH.
test.skipIf(!available)(`PS-CONTAIN: isolated HOME file-change audit over real runtime, Bun caches, embedded pnpm and temp${available ? "" : ` — SKIP: ${skipReason}`}`, async () => {
	const audit = join(root, "audit");
	const tools = join(audit, "tools");
	const data = join(tools, "dsh-bin");
	const userHome = join(audit, "isolated-home");
	mkdirSync(tools, { recursive: true });
	mkdirSync(userHome);
	cpSync(join(root, "tools/dsh-bin"), data, { recursive: true });
	rmSync(join(data, "cache"), { recursive: true, force: true });
	const exe = join(tools, `dsh${EXE}`);
	cpSync(managers[0]!, exe);
	const inherited = { PATH: path, HOME: userHome, USERPROFILE: userHome, NO_COLOR: "1", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
	const initialize = spawnSync(exe, ["--use", id, "--version"], { cwd, env: inherited, encoding: "utf8", timeout: 30_000 });
	if (initialize.status !== 0) console.error(initialize.stdout, initialize.stderr);
	expect(initialize.status).toBe(0);
	const profile = join(data, "snapshots", `${id}@1`, "profiles", "audit");
	const plugin = join(profile, "node_modules", "dsh-audit-probe");
	mkdirSync(plugin, { recursive: true });
	writeFileSync(join(profile, "package.json"), JSON.stringify({ name: "audit-profile", private: true, dsh: { profile: { bundles: [] } } }));
	const shared = join(data, "home", "profiles", "audit");
	mkdirSync(shared, { recursive: true });
	writeFileSync(join(shared, "cordis.patch.yml"), "- insert:\n    - id: audit-probe\n      name: dsh-audit-probe\n");
	writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "dsh-audit-probe", type: "module", main: "index.js" }));
	writeFileSync(join(plugin, "index.js"), `export function apply(ctx) {
		ctx.appReady.onReady(() => { console.log("DSH_AUDIT_ENV " + JSON.stringify(process.env)); ctx.appExit(0); });
	}`);
	const start = spawnSync(exe, ["--profile", "audit"], { cwd, env: inherited, encoding: "utf8", timeout: 30_000 });
	if (start.status !== 0) console.error(start.stdout, start.stderr);
	expect(start.status).toBe(0);
	const childEnv = JSON.parse(start.stdout.split("\n").find((l) => l.startsWith("DSH_AUDIT_ENV "))!.slice(14));
	expect(childEnv.HOME).toBe(userHome);
	expect(childEnv.DSH_HOME).toBe(join(data, "home"));
	const native = join(data, "bundles", id, `dsh-native${EXE}`);
	const embedded = (args: string[], workingDir = cwd) => spawnSync(native, args, { cwd: workingDir, env: { ...childEnv, BUN_BE_BUN: "1" }, encoding: "utf8", timeout: 30_000 });
	const pnpm = (args: string[]) => embedded([join(data, "bundles", id, "pnpm/dist/pnpm.mjs"), ...args]);
	expect(embedded(["--version"]).stdout.trim()).toBe("1.4.2");
	expect(pnpm(["--version"]).stdout.trim()).toBe("11.7.0");
	for (const [key, value] of [["store-dir", join(data, "cache/pnpm/store")], ["cache-dir", join(data, "cache/pnpm/cache")], ["state-dir", join(data, "state/pnpm")]]) {
		const config = pnpm(["config", "get", key]);
		expect(config.status).toBe(0);
		expect(config.stdout.trim()).toBe(value);
	}
	const store = pnpm(["store", "path"]);
	expect(store.status).toBe(0);
	expect(store.stdout.trim()).toBe(join(data, "cache/pnpm/store/v11"));
	const tmp = embedded(["-e", "console.log(require('node:os').tmpdir())"]);
	expect(tmp.status).toBe(0);
	expect(tmp.stdout.trim()).toBe(join(data, "tmp"));
	const transpiler = join(data, "cache/transpiler");
	const cacheBefore = tree(transpiler);
	const source = join(data, "tmp/transpiler-probe.ts");
	writeFileSync(source, `${"// real Bun transpiler cache probe\n".repeat(4000)}const value: string = 'cached'; console.log(value);\n`);
	const compiled = embedded([source]);
	expect(compiled.status).toBe(0);
	expect(compiled.stdout.trim()).toBe("cached");
	expect(tree(transpiler).length).toBeGreaterThan(cacheBefore.length);

	const bytes = await new Bun.Archive({
		"package/package.json": JSON.stringify({ name: "dsh-cache-probe", version: "1.0.0", main: "index.js" }),
		"package/index.js": "module.exports = 'local-registry-probe';\n",
	}, { compress: "gzip" }).bytes();
	const requests: string[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
		const url = new URL(req.url);
		requests.push(url.pathname);
		if (url.pathname.endsWith(".tgz")) return new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } });
		if (url.pathname === "/dsh-cache-probe") return Response.json({ name: "dsh-cache-probe", "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { name: "dsh-cache-probe", version: "1.0.0", dist: { tarball: `${url.origin}/dsh-cache-probe/-/probe.tgz`, shasum: new Bun.CryptoHasher("sha1").update(bytes).digest("hex") } } } });
		return new Response("not found", { status: 404 });
	} });
	const install = async (args: string[], workingDir: string) => {
		const proc = Bun.spawn([native, ...args], { cwd: workingDir, env: { ...childEnv, BUN_BE_BUN: "1" }, stdout: "pipe", stderr: "pipe" });
		const timer = setTimeout(() => proc.kill("SIGKILL"), 30_000);
		try {
			const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
			if (code !== 0) console.error(stdout, stderr);
			expect(code).toBe(0);
		} finally { clearTimeout(timer); if (proc.exitCode === null) { proc.kill("SIGKILL"); await proc.exited; } }
	};
	try {
		const registry = `http://127.0.0.1:${server.port}`;
		const bunProject = join(data, "tmp/bun-install");
		const pnpmProject = join(data, "tmp/pnpm-install");
		for (const dir of [bunProject, pnpmProject]) {
			mkdirSync(dir);
			writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "cache-audit", private: true, dependencies: { "dsh-cache-probe": "1.0.0" } }));
		}
		await install(["install", "--registry", registry, "--ignore-scripts", "--no-progress"], bunProject);
		await install([join(data, "bundles", id, "pnpm/dist/pnpm.mjs"), "install", "--registry", registry, "--ignore-scripts", "--no-frozen-lockfile", "--config.update-notifier=false"], pnpmProject);
		expect(requests.some((p) => p.endsWith(".tgz"))).toBe(true);
		expect(tree(join(data, "cache/bun"))).not.toEqual([]);
		expect(tree(join(data, "cache/pnpm/store"))).not.toEqual([]);
		expect(tree(join(data, "cache/pnpm/cache"))).not.toEqual([]);
		expect(tree(join(data, "cache/transpiler"))).not.toEqual([]);
		expect(existsSync(join(bunProject, "node_modules/dsh-cache-probe/index.js"))).toBe(true);
		expect(existsSync(join(pnpmProject, "node_modules/dsh-cache-probe/index.js"))).toBe(true);
		expect(tree(userHome)).toEqual([]);
		expect(tree(audit).filter((p) => !p.startsWith("tools/dsh-bin/"))).toEqual(["isolated-home", "tools", `tools/dsh${EXE}`, "tools/dsh-bin"].sort());
	} finally { await server.stop(true); }
}, 180_000);

// 3.4: local-build's real archive and the release writer, through the public install command.
test.skipIf(!available)(`MC-EMPTY / MC-BROKEN: only manager -> local runtime index -> verified real archive -> launch -> force repair${available ? "" : ` — SKIP: ${skipReason}`}`, async () => {
	const fresh = join(root, "native-install");
	const tools = join(fresh, "tools"), userHome = join(fresh, "isolated-home"), working = join(fresh, "workspace");
	for (const dir of [tools, userHome, working]) mkdirSync(dir, { recursive: true });
	const exe = join(tools, `dsh${EXE}`);
	cpSync(managers[0]!, exe);
	const indexPath = join(fresh, "runtime-index.json");
	execFileSync(process.execPath, ["scripts/index.mjs", "append-bundle", indexPath, runtimeManifest], { cwd: RUNTIME_PROJECT, timeout: 30_000 });
	const index = JSON.parse(readFileSync(indexPath, "utf8")), entry = index.channels.release[0];
	const asset = entry.assets[JSON.parse(readFileSync(join(bundle, "bundle.json"), "utf8")).target];
	const requests: string[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
		const url = new URL(req.url);
		requests.push(url.pathname);
		if (url.pathname === "/runtime-index.json") return Response.json(index);
		if (url.pathname === `/download/${entry.tag}/${asset.name}`) return new Response(Bun.file(runtimeZip));
		if (url.pathname === "/manager-index.json") return Response.json({ schema: 1, versions: [{ version: "99.0.0", tag: "manager-v99.0.0", assets: {} }] });
		return new Response(null, { status: 404 });
	} });
	const childEnv = { PATH: path, HOME: userHome, USERPROFILE: userHome, NO_COLOR: "1", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
	const install = async (force = false) => {
		const proc = Bun.spawn([exe, "manager", "install", entry.tag, ...(force ? ["--force"] : [])], { cwd: working, env: { ...childEnv, DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_ORIGIN: `http://127.0.0.1:${server.port}` }, stdout: "pipe", stderr: "pipe" });
		const timer = setTimeout(() => proc.kill("SIGKILL"), 120_000);
		try {
			const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
			if (code !== 0) console.error(stdout, stderr);
			expect(code).toBe(0);
		} finally { clearTimeout(timer); if (proc.exitCode === null) { proc.kill("SIGKILL"); await proc.exited; } }
	};
	const data = join(tools, "dsh-bin"), installed = join(data, "bundles", id), native = join(installed, `dsh-native${EXE}`);
	try {
		expect(tree(tools)).toEqual([`dsh${EXE}`]);
		await install();
		expect(requests).toEqual(["/runtime-index.json", `/download/${entry.tag}/${asset.name}`]);
		expect(existsSync(join(data, "snapshots", `${id}@1`, "snapshot.json"))).toBe(true);
		const metadata = readFileSync(join(data, "snapshots", `${id}@1`, "snapshot.json"), "utf8");
		for (const args of [["--version"], ["--help"]]) {
			const result = spawnSync(exe, ["--use", id, ...args], { cwd: working, env: childEnv, encoding: "utf8", timeout: 30_000 });
			if (result.status !== 0) console.error(result.stdout, result.stderr);
			expect(result.status).toBe(0);
			expect(result.stdout).toContain(args[0] === "--version" ? version : "dsh: boot a DeepSeek Harness profile");
		}
		const before = readFileSync(native);
		rmSync(native);
		expect(spawnSync(exe, ["--use", id, "--version"], { env: childEnv, encoding: "utf8", timeout: 30_000 }).status).toBe(1);
		await install(true);
		expect(readFileSync(native).equals(before)).toBe(true);
		expect(readFileSync(join(data, "snapshots", `${id}@1`, "snapshot.json"), "utf8")).toBe(metadata);
		expect(spawnSync(exe, ["--use", id, "--version"], { env: childEnv, encoding: "utf8", timeout: 30_000 }).status).toBe(0);
		expect(tree(userHome)).toEqual([]);
		expect(tree(working)).toEqual([]);
	} finally { await server.stop(true); }
}, 180_000);

// RB-PLUGIN: install via the real managed dsh CLI and embedded pnpm, not a fabricated node_modules tree.
test.skipIf(!available)(`RB-PLUGIN / MC-SNAPSHOT / MC-CROSS-SNAPSHOT: real installed plugin inherits independently; runtime and manager bytes unchanged${available ? "" : ` — SKIP: ${skipReason}`}`, async () => {
	const fresh = join(root, "snapshot-plugin"), tools = join(fresh, "tools"), userHome = join(fresh, "isolated-home"), working = join(fresh, "workspace");
	for (const d of [tools, userHome, working]) mkdirSync(d, { recursive: true });
	const exe = join(tools, `dsh${EXE}`), data = join(tools, "dsh-bin"); cpSync(managers[0]!, exe);
	const secondOut = join(fresh, "second-build");
	const built = JSON.parse(execFileSync(process.execPath, ["scripts/local-build.mjs", secondOut, "release", "2", "--native", join(bundle, `dsh-native${EXE}`)], { cwd: RUNTIME_PROJECT, encoding: "utf8", timeout: 240_000 }).trim().split("\n").at(-1)!);
	const indexPath = join(fresh, "runtime-index.json");
	for (const manifest of [runtimeManifest, join(secondOut, `${built.tag}.json`)]) execFileSync(process.execPath, ["scripts/index.mjs", "append-bundle", indexPath, manifest], { cwd: RUNTIME_PROJECT, timeout: 30_000 });
	const index = JSON.parse(readFileSync(indexPath, "utf8"));
	const zips = new Map([[index.channels.release.find((e: any) => e.id === id).tag, runtimeZip], [built.tag, built.zip]]);
	const requests: string[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
		const p = new URL(req.url).pathname; requests.push(p);
		if (p === "/runtime-index.json") return Response.json(index);
		const tag = p.split("/")[2]; if (p.startsWith("/download/") && zips.has(tag)) return new Response(Bun.file(zips.get(tag)!));
		return new Response(null, { status: 404 });
	} });
	const inherited = { PATH: path, HOME: userHome, USERPROFILE: userHome, NO_COLOR: "1", DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_ORIGIN: `http://127.0.0.1:${server.port}`, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
	const command = async (args: string[]) => {
		const p = Bun.spawn([exe, ...args], { cwd: working, env: inherited, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		const timer = setTimeout(() => p.kill("SIGKILL"), 120_000);
		try { const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]); if (code !== 0) console.error(stdout, stderr); expect(code).toBe(0); return stdout; }
		finally { clearTimeout(timer); if (p.exitCode === null) { p.kill("SIGKILL"); await p.exited; } }
	};
	const { createHash } = await import("node:crypto"), { lstatSync, readlinkSync } = await import("node:fs");
	const digest = (dir: string) => tree(dir).map(p => {
		const file = join(dir, p), stat = lstatSync(file);
		return [p, stat.isSymbolicLink() ? `link:${readlinkSync(file)}` : stat.isFile() ? createHash("sha256").update(readFileSync(file)).digest("hex") : "directory"];
	});
	try {
		await command(["manager", "install", id]);
		const managerBefore = readFileSync(exe), runtimeBefore = digest(join(data, "bundles", id));
		const snapshotA = join(data, "snapshots", `${id}@1`), profile = join(snapshotA, "profiles", "snapshot-probe");
		mkdirSync(profile); writeFileSync(join(profile, "package.json"), JSON.stringify({ name: "snapshot-profile", private: true, dsh: { profile: { bundles: [] } } }));
		const plugin = join(fresh, "dsh-snapshot-probe.tgz");
		const bytes = await new Bun.Archive({
			"package/package.json": JSON.stringify({ name: "dsh-snapshot-probe", version: "1.0.0", type: "module", main: "index.js" }),
			"package/index.js": 'export function apply(ctx) { ctx.appReady.onReady(() => { console.log("REAL_SNAPSHOT_PLUGIN " + JSON.parse(process.env.DSH_MANAGER_LAUNCH).snapshot.id); ctx.appExit(0); }); }\n',
		}, { compress: "gzip" }).bytes(); writeFileSync(plugin, bytes);
		await command(["--use", id, "plugin", "--profile", "snapshot-probe", "add", plugin, "--offline", "--ignore-scripts", "--config.update-notifier=false"]);
		expect(existsSync(join(profile, "node_modules/dsh-snapshot-probe/index.js"))).toBe(true);
		const shared = join(data, "home/profiles/snapshot-probe"); mkdirSync(shared, { recursive: true });
		writeFileSync(join(shared, "cordis.patch.yml"), "- insert:\n    - id: real-snapshot-probe\n      name: dsh-snapshot-probe\n");
		expect(await command(["--use", id, "--profile", "snapshot-probe"])).toContain(`REAL_SNAPSHOT_PLUGIN ${id}@1`);
		expect(digest(join(data, "bundles", id))).toEqual(runtimeBefore); expect(readFileSync(exe)).toEqual(managerBefore);
		const sourceBefore = digest(snapshotA), sharedBefore = digest(shared);
		await command(["manager", "install", built.id]);
		const snapshotB = join(data, "snapshots", `${built.id}@1`), runtimeBBefore = digest(join(data, "bundles", built.id));
		expect(digest(snapshotA)).toEqual(sourceBefore); expect(digest(shared)).toEqual(sharedBefore);
		expect(existsSync(join(snapshotB, "profiles/snapshot-probe/cordis.patch.yml"))).toBe(false);
		expect(readFileSync(join(snapshotB, "profiles/snapshot-probe/node_modules/dsh-snapshot-probe/index.js"))).toEqual(readFileSync(join(profile, "node_modules/dsh-snapshot-probe/index.js")));
		expect(await command(["--use", built.id, "--profile", "snapshot-probe"])).toContain(`REAL_SNAPSHOT_PLUGIN ${built.id}@1`);
		const crossSource = digest(snapshotA), crossTarget = digest(snapshotB), seen = requests.length;
		expect(await command(["--use", built.id, "--snapshot", `${id}@1`, "--profile", "snapshot-probe"])).toContain(`REAL_SNAPSHOT_PLUGIN ${id}@1`);
		expect(digest(snapshotA)).toEqual(crossSource); expect(digest(snapshotB)).toEqual(crossTarget); expect(requests.length).toBe(seen);
		writeFileSync(join(snapshotB, "profiles/snapshot-probe/node_modules/dsh-snapshot-probe/index.js"), "// changed copied plugin\n");
		expect(digest(snapshotA)).toEqual(crossSource);
		expect(digest(join(data, "bundles", id))).toEqual(runtimeBefore); expect(digest(join(data, "bundles", built.id))).toEqual(runtimeBBefore); expect(readFileSync(exe)).toEqual(managerBefore);
		expect(tree(userHome)).toEqual([]);
	} finally { await server.stop(true); }
}, 360_000);
// MC-ADDON acceptance uses the real upstream office plugins and real kit/engine closure,
// packaged locally from already-built work/addon-office (no substitute office implementation).
const officeTree = join(RUNTIME_PROJECT, "work/addon-office");
const officeAvailable = available && process.platform === "linux" && existsSync(join(officeTree, "node_modules/@deepseek-ai/libreoffice-kit-wasm/package.json"));
const officeSkip = "requires Linux real work/app + work/addon-office with WASM kit engine; no real office artifact on this host";
test.skipIf(!officeAvailable)(`MC-ADDON: real managed office addon enables both plugins; missing selected addon degrades with no download${officeAvailable ? "" : ` — SKIP: ${officeSkip}`}`, async () => {
	const { createHash } = await import("node:crypto"), { archive } = await import("../../dsh-bun-build/scripts/archive.mjs");
	const fresh = join(root, "real-office"), tools = join(fresh, "tools"), userHome = join(fresh, "user-home"), working = join(fresh, "workspace");
	for (const dir of [tools, userHome, working]) mkdirSync(dir, { recursive: true });
	const exe = join(tools, `dsh${EXE}`), data = join(tools, "dsh-bin"); cpSync(managers[0]!, exe);
	const base = JSON.parse(readFileSync(join(officeTree, "addon.json"), "utf8"));
	const slot = { commit: execFileSync("git", ["-C", join(RUNTIME_PROJECT, "work/src-rc2"), "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), kitVersion: base.kitVersion };
	const out = join(fresh, "runtime");
	const built = JSON.parse(execFileSync(process.execPath, ["scripts/local-build.mjs", out, "release", "3", "--slot", JSON.stringify(slot), "--native", join(bundle, `dsh-native${EXE}`)], { cwd: RUNTIME_PROJECT, encoding: "utf8", timeout: 240_000 }).trim().split("\n").at(-1)!);
	const manifest = JSON.parse(readFileSync(join(out, `${built.tag}.json`), "utf8"));
	const kitVersion = `${base.kitVersion}-b1.1.gdeadbeef`, kitTag = `addon-office-v${kitVersion}`, kitRoot = join(fresh, "addon"), zip = join(fresh, "office.zip");
	cpSync(officeTree, kitRoot, { recursive: true });
	writeFileSync(join(kitRoot, "addon.json"), JSON.stringify({ ...base, version: kitVersion, tag: kitTag, slot, platform: "linux" }));
	archive(kitRoot, zip);
	const bytes = readFileSync(zip), asset = { name: "dsh-addon-office-linux.zip", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
	const requests: string[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
		const p = new URL(req.url).pathname; requests.push(p);
		if (p === "/runtime-index.json") return Response.json({ schema: 1, channels: { release: [{ ...manifest, seq: 1, assets: { [built.asset.name.slice(8, -4)]: built.asset } }], live: [] }, addons: { office: [{ version: kitVersion, tag: kitTag, seq: 1, slot, assets: { linux: asset } }] } });
		if (p === `/download/${built.tag}/${built.asset.name}`) return new Response(Bun.file(built.zip));
		if (p === `/download/${kitTag}/${asset.name}`) return new Response(Bun.file(zip));
		return new Response(null, { status: 404 });
	} });
	const inherited = { PATH: path, HOME: userHome, USERPROFILE: userHome, NO_COLOR: "1", DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_ORIGIN: `http://127.0.0.1:${server.port}` };
	const command = async (args: string[]) => {
		const p = Bun.spawn([exe, ...args], { cwd: working, env: inherited, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		const timer = setTimeout(() => p.kill("SIGKILL"), 120_000);
		try { const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]); return { code, stdout, stderr }; }
		finally { clearTimeout(timer); if (p.exitCode === null) { p.kill("SIGKILL"); await p.exited; } }
	};
	try {
		for (const args of [["manager", "install", built.id], ["manager", "install", "--addon", "office"]]) {
			const r = await command(args); if (r.code !== 0) console.error(r.stdout, r.stderr); expect(r.code).toBe(0);
			expect(r.stderr).not.toContain("MISSING_CREDENTIAL"); expect(existsSync(join(data, "home"))).toBe(false);
		}
		const addon = join(data, "addons/office", kitVersion), native = join(data, "bundles", built.id, `dsh-native${EXE}`);
		expect(readFileSync(join(addon, "node_modules/@deepseek-ai/libreoffice-kit-wasm/package.json"))).toEqual(readFileSync(join(officeTree, "node_modules/@deepseek-ai/libreoffice-kit-wasm/package.json")));
		const nativeBefore = readFileSync(native), managerBefore = readFileSync(exe);
		const selected = await command(["manager", "select", "--use", built.id, "--addon", `office:${kitVersion}`]); expect(selected.code).toBe(0);
		const profile = join(data, "snapshots", `${built.id}@1`, "profiles/office-probe"), shared = join(data, "home/profiles/office-probe");
		mkdirSync(profile, { recursive: true }); mkdirSync(shared, { recursive: true });
		writeFileSync(join(profile, "package.json"), JSON.stringify({ name: "office-probe", private: true, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } } }));
		writeFileSync(join(shared, "cordis.patch.yml"), "- insert:\n    - id: office-to-pdf\n      name: '@deepseek-ai/dsh-office-to-pdf'\n    - id: skill-office\n      name: '@deepseek-ai/dsh-skill-office'\n");
		const seen = requests.length, args = ["--profile", "office-probe", "hi"];
		const enabled = await command(args);
		if (!enabled.stderr.includes("MISSING_CREDENTIAL")) console.error(enabled.stdout, enabled.stderr);
		expect(enabled.code).toBe(1); expect(enabled.stderr).toContain("MISSING_CREDENTIAL");
		expect(enabled.stderr).not.toContain("DeclaredDegradation"); expect(enabled.stderr).not.toContain("did not activate"); expect(enabled.stderr).not.toContain("failed to import");
		rmSync(addon, { recursive: true });
		const missing = await command(args);
		expect(missing.code).toBe(1); expect(missing.stderr).toContain("MISSING_CREDENTIAL"); expect(missing.stderr).toContain(`office addon ${kitVersion} is missing`);
		for (const name of ["office-to-pdf", "skill-office"]) expect(missing.stderr).toMatch(new RegExp(`${name} \\(@deepseek-ai/dsh-${name}\\): DeclaredDegradation: .*office addon is not installed`));
		expect(requests.length).toBe(seen); expect(readFileSync(native)).toEqual(nativeBefore); expect(readFileSync(exe)).toEqual(managerBefore);
		expect(tree(userHome)).toEqual([]); expect(tree(working)).toEqual([]);
	} finally { await server.stop(true); }
}, 360_000);
