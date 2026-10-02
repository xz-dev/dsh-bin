// 7.5: same public lifecycle runs with an isolated layout locally and actual Scoop in the Windows job.
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hostTargetId } from "../../dsh-bun-build/scripts/targets.mjs";
import { writeZip } from "../../dsh-bun-build/runtime/zip.ts";
import { scoopManifests } from "../scripts/create-scoop-manifest.mjs";
import { baseEnv, build, bundleMeta, cleanup, EXE, hasZig, launchOf, newInstall, run, tempDir, tree, WIN } from "./harness.ts";

afterAll(cleanup);
const real = process.env.DSH_SCOOP_TEST === "1";
const V = "1.0.0-b1.1.gdeadbeef", W = "2.0.0-b2.1.gdeadbeef", A = "0.1.1-b1.1.gdeadbeef";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function files(dir: string) {
	return Object.fromEntries(tree(dir).map(p => { try { return [p, hash(readFileSync(join(dir, p)))]; } catch { return [p, "directory"]; } }));
}

test.skipIf(!hasZig)(`PS-SCOOP / DL-MANAGED-UPDATE / DL-MANAGED-SELF / DL-MANAGED-REMOVE: ${real ? "real Windows Scoop install upgrade uninstall" : "isolated Scoop package lifecycle"}`, async () => {
	if (real) {
		if (!WIN || !process.env.RUNNER_TEMP || !Bun.which("scoop")) throw new Error("real Scoop requires the isolated Windows workflow setup");
		const isolatedHome = resolve(process.env.RUNNER_TEMP, "dsh-scoop-user");
		if (process.env.DSH_SCOOP_TEST_HOME !== isolatedHome || process.env.SCOOP !== join(isolatedHome, "scoop")) throw new Error("real Scoop refuses a non-workflow HOME or Scoop root");
	}
	const i = newInstall(), fixture = tempDir("dsh-scoop-lifecycle-");
	if (real) i.home = process.env.DSH_SCOOP_TEST_HOME!;
	const local = join(i.home, "local"), env = { ...baseEnv(i), LOCALAPPDATA: local };
	i.data = join(local, "dsh-bin");
	if (existsSync(i.data)) throw new Error("Scoop lifecycle needs an empty isolated user data root");
	const manifestPath = join(fixture, "dsh.json"), versions = ["1.0.0", "1.0.1"];
	const managers = versions.map(version => {
		const archive = join(fixture, `manager-${version}.zip`);
		writeZip(archive, [{ name: `dsh${EXE}`, data: readFileSync(build(version).manager), mode: 0o755 }]);
		const bytes = readFileSync(archive), asset = { name: `manager-${version}.zip`, size: bytes.length, sha256: hash(bytes) };
		const m = scoopManifests({ schema: 1, versions: [{ version, tag: `manager-v${version}`, launchProtocols: [1], assets: { "windows-x64": asset, "windows-arm64": asset } }] }).dsh;
		// The fixture supplies host-native binaries. Production URLs/hashes still come from manager-index.
		m.architecture["64bit"].url = pathToFileURL(archive).href;
		return m;
	});
	async function scoop(args: string[]) {
		const p = Bun.spawn(["pwsh", "-NoProfile", "-Command", "$a = ConvertFrom-Json $env:DSH_SCOOP_ARGS; & scoop @a; exit $LASTEXITCODE"], {
			env: { ...process.env, HOME: i.home, USERPROFILE: i.home, LOCALAPPDATA: local, DSH_SCOOP_ARGS: JSON.stringify(args) }, stdout: "pipe", stderr: "pipe", stdin: "ignore",
		});
		const timer = setTimeout(() => p.kill(), 120_000);
		try {
			const [status, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
			console.info(`scoop ${args.join(" ")}: exit=${status}\n${stdout}${stderr}`);
			expect({ status, stderr }).toMatchObject({ status: 0 }); return stdout.trim();
		} finally { clearTimeout(timer); }
	}
	async function packageVersion(n: number) {
		writeFileSync(manifestPath, JSON.stringify(managers[n], null, 2));
		if (real) { await scoop(n === 0 ? ["install", manifestPath] : ["update", "dsh"]); i.dir = realpathSync(await scoop(["prefix", "dsh"])); i.exe = join(i.dir, "dsh.exe"); }
		else {
			i.dir = join(fixture, "apps/dsh", versions[n]); mkdirSync(i.dir, { recursive: true }); i.exe = join(i.dir, `dsh${EXE}`);
			cpSync(build(versions[n]).manager, i.exe); chmodSync(i.exe, 0o755);
			writeFileSync(join(i.dir, ".dsh-manager-install.json"), '{"schema":1,"owner":"scoop"}');
		}
		expect(readFileSync(join(i.dir, ".dsh-manager-install.json"), "utf8")).toBe('{"schema":1,"owner":"scoop"}');
		expect(run(i, ["manager", "--version"], { env }).stdout).toContain(versions[n]);
	}
	const requests: string[] = [], assets = new Map<string, Buffer>(), target = hostTargetId();
	const slot = { commit: "a".repeat(40), kitVersion: "0.1.1" };
	const runtimes = [V, W].map((id, n) => {
		const meta = bundleMeta(id, { run: n + 1, patch: { target, addons: { office: { slot, pinned: A, known: [] } } } });
		const zip = join(fixture, `${id}.zip`);
		writeZip(zip, [{ name: "bundle.json", data: Buffer.from(JSON.stringify(meta)), mode: 0o644 }, { name: `dsh-native${EXE}`, data: readFileSync(build().fake), mode: 0o755 }]);
		const bytes = readFileSync(zip), tag = `runtime-v${id}`; assets.set(`/download/${tag}/runtime.zip`, bytes);
		return { ...meta, tag, seq: n + 1, assets: { [target]: { name: "runtime.zip", size: bytes.length, sha256: hash(bytes) } } };
	});
	const platform = process.platform === "linux" ? "linux" : `${WIN ? "windows" : process.platform}-${process.arch}`, tag = `addon-office-v${A}`, addonZip = join(fixture, "office.zip");
	writeZip(addonZip, [{ name: "addon.json", data: Buffer.from(JSON.stringify({ name: "office", version: A, tag, slot, kitVersion: slot.kitVersion, platform, packages: [] })), mode: 0o644 }, { name: "node_modules/keep", data: Buffer.from("ADDON KEEP"), mode: 0o644 }]);
	const addonName = `dsh-addon-office-${platform}.zip`, addonBytes = readFileSync(addonZip); assets.set(`/download/${tag}/${addonName}`, addonBytes);
	const addon = { version: A, tag, slot, seq: 1, assets: { [platform]: { name: addonName, size: addonBytes.length, sha256: hash(addonBytes) } } };
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
		const path = new URL(req.url).pathname; requests.push(path);
		if (path === "/runtime-index.json") return Response.json({ schema: 1, channels: { release: runtimes, live: [] }, addons: { office: [addon] } });
		return assets.has(path) ? new Response(assets.get(path)) : new Response(null, { status: 404 });
	} });
	async function command(args: string[]) {
		const p = Bun.spawn([i.exe, ...args], { cwd: i.home, env: { ...env, DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_ORIGIN: `http://127.0.0.1:${server.port}` }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
		const timer = setTimeout(() => p.kill(), 30_000);
		try { const [status, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]); return { status, stdout, stderr }; }
		finally { clearTimeout(timer); }
	}
	try {
		await packageVersion(0);
		const oldDir = i.dir, prefix = files(i.dir);
		const info = run(i, ["manager", "info"], { env }); expect(info.status).toBe(0); expect(info.stdout).toContain("mode: scoop"); expect(info.stdout).toContain(i.data);
		if (real) {
			const shim = join(process.env.SCOOP!, "shims/dsh.exe"); expect(existsSync(shim)).toBe(true);
			expect(run(i, ["manager", "info"], { env, exe: shim }).stdout).toContain(i.data);
		}
		let before = requests.length, r = await command(["manager", "self-update"]);
		expect(r.status).toBe(1); expect(r.stderr).toContain("scoop update dsh"); expect(requests.length).toBe(before); expect(existsSync(i.data)).toBe(false);
		for (const id of [V, W]) expect(await command(["manager", "install", id])).toMatchObject({ status: 0 });
		expect(await command(["--use", V, "manager", "install", "--addon", `office:${A}`])).toMatchObject({ status: 0 });
		expect((await command(["manager", "select", "--use", V, "--addon", `office:${A}`])).status).toBe(0);
		expect((await command(["probe"])).status).toBe(0); expect(launchOf(i).runtime).toBe(V); expect(launchOf(i).addons.office.version).toBe(A);
		expect((await command(["--use", W, "probe"])).status).toBe(0); expect(launchOf(i).runtime).toBe(W);
		expect((await command(["manager", "snapshot", "new", "--use", V, "--empty", "--name", "kept"])).status).toBe(0);
		mkdirSync(join(i.data, "home/profiles"), { recursive: true }); writeFileSync(join(i.data, "home/credential"), "SECRET KEEP"); writeFileSync(join(i.data, "home/profiles/config"), "CONFIG KEEP"); writeFileSync(join(i.data, "home/session"), "SESSION KEEP");
		expect(files(i.dir)).toEqual(prefix); expect(existsSync(join(i.dir, "dsh-bin"))).toBe(false); expect(existsSync(join(i.dir, "addons"))).toBe(false);
		const protectedBefore = files(i.data);
		await packageVersion(1); expect(i.dir).not.toBe(oldDir); expect(files(i.data)).toEqual(protectedBefore);
		expect(run(i, ["manager", "info"], { env }).stdout).toContain(i.data);
		const list = run(i, ["manager", "list", "--json"], { env }); expect(list.status).toBe(0); expect(list.stdout).toContain(V); expect(list.stdout).toContain(W); expect(list.stdout).toContain(A);
		expect(run(i, ["manager", "snapshot", "list"], { env }).stdout).toContain("kept");
		expect((await command(["probe"])).status).toBe(0); expect(launchOf(i).runtime).toBe(V); expect(launchOf(i).addons.office.version).toBe(A);
		expect(files(i.data)).toEqual(protectedBefore);
		before = requests.length; r = await command(["manager", "self-update"]); expect(r.status).toBe(1); expect(r.stderr).toContain("scoop update dsh"); expect(requests.length).toBe(before);
		if (real) { await scoop(["uninstall", "dsh"]); expect(existsSync(join(process.env.SCOOP!, "shims/dsh.exe"))).toBe(false); }
		else { rmSync(i.exe); rmSync(join(i.dir, ".dsh-manager-install.json")); }
		expect(existsSync(i.exe)).toBe(false); expect(files(i.data)).toEqual(protectedBefore);
		console.info(`Scoop lifecycle: ${real ? "REAL Windows Scoop" : "isolated layout"} 1.0.0 → 1.0.1 → uninstall; data=${i.data}; ${Object.keys(protectedBefore).length} paths byte-identical; requests=${requests.length}`);
	} finally { server.stop(true); }
}, 300_000);
