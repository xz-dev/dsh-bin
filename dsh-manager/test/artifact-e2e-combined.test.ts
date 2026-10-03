// DL-REAL-E2E / PS-MOVE / PS-CONTAIN / RB-INDEPENDENT / MC-REINSTALL.
// Explicit CI artifacts only: no locally built manager/runtime substitutes.
import { expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { appendAddon, appendBundle, emptyIndex } from "../../dsh-bun-build/scripts/index.mjs";
import { appendManager, emptyIndex as emptyManagerIndex, sha256, verifyZip } from "../scripts/release.mjs";
import { tree } from "./harness.ts";

const artifacts = process.env.DSH_COMBINED_ARTIFACTS;
const WIN = process.platform === "win32", suffix = WIN ? ".exe" : "";
const managerTarget = WIN ? "windows-x64" : "linux-x64";
const skip = " — SKIP: set DSH_COMBINED_ARTIFACTS to verified CI artifacts (a/{manager,runtime}, b/{manager,runtime}, addon)";
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));

function digest(dir: string): Record<string, string> {
	return Object.fromEntries(tree(dir).map(p => {
		const file = join(dir, p), stat = lstatSync(file);
		return [p, stat.isSymbolicLink() ? `link:${readlinkSync(file)}` : stat.isFile() ? sha256(readFileSync(file)) : "directory"];
	}));
}
function checkedAsset(dir: string, a: any) {
	const bytes = readFileSync(join(dir, a.name ?? a.file));
	expect(bytes.length).toBe(a.size); expect(sha256(bytes)).toBe(a.sha256);
	return bytes;
}
const PROBE = `export function apply(ctx) {
 ctx.appReady.onReady(() => {
  console.log("COMBINED_PLUGIN " + JSON.stringify({launch:JSON.parse(process.env.DSH_MANAGER_LAUNCH),path:process.env.PATH,cwd:process.cwd(),home:process.env.HOME,restarted:process.env.COMBINED_CHILD === '1'}));
  if (process.env.COMBINED_RESTART === '1' && !process.env.COMBINED_CHILD) {
   // Same respawn shape as upstream dsh-tui; real compiled entry re-normalizes argv and reacquires claims.
   const child = Bun.spawnSync([process.execPath,...process.execArgv,...process.argv.slice(1)], {env:{...process.env,COMBINED_CHILD:'1'},stdout:'pipe',stderr:'pipe'});
   process.stdout.write(child.stdout); process.stderr.write(child.stderr); ctx.appExit(child.exitCode);
  } else ctx.appExit(0);
 });
}`;

test.skipIf(!artifacts)(`DL-REAL-E2E: two CI runtimes/managers, real plugin/addon, reinstall, restart, self-update and offline move${artifacts ? "" : skip}`, async () => {
	const source = resolve(artifacts!);
	const root = realpathSync(mkdtempSync(join(WIN ? tmpdir() : "/var/tmp", "dsh-combined-")));
	let install = join(root, "original install"), exe = join(install, `dsh${suffix}`), data = join(install, "dsh-bin");
	const home = join(root, "isolated-home"), cwd = join(root, "workspace");
	for (const dir of [install, home, cwd]) mkdirSync(dir);
	let server: ReturnType<typeof Bun.serve> | undefined;
	const note = (step: string, details: object = {}) => {
		console.log(`DSH_COMBINED_E2E ${JSON.stringify({step, target: managerTarget, result: "passed", ...details})}`);
	};
	try {
		const runtimeIndex = emptyIndex(), managerIndex = emptyManagerIndex(), assets = new Map<string, string>();
		const runtimeManifests: any[] = [], managerManifests: any[] = [];
		for (const label of ["a", "b"]) {
			const runtimeDir = join(source, label, "runtime"), managerDir = join(source, label, "manager");
			const r = json(join(runtimeDir, "release-manifest.json")), m = json(join(managerDir, "manager-manifest.json"));
			runtimeManifests.push(r); managerManifests.push(m);
			appendBundle(runtimeIndex, r); appendManager(managerIndex, m);
			for (const a of Object.values(r.targets) as any[]) assets.set(`/download/${r.tag}/${a.file}`, join(runtimeDir, a.file));
			for (const a of Object.values(m.assets) as any[]) assets.set(`/download/${m.tag}/${a.name}`, join(managerDir, a.name));
			checkedAsset(managerDir, m.assets[managerTarget]);
			note(`input-${label}`, {runtime: r.id, manager: m.version, runtimeIndexSHA256: sha256(readFileSync(join(runtimeDir, "runtime-index.json"))), managerIndexSHA256: sha256(readFileSync(join(managerDir, "manager-index.json")))});
		}
		// b = the runtime the manager treats as newest (commitTime -> run -> attempt), whichever dry run it came from.
		const byAge = (x: any, y: any) => x.upstream.commitTime.localeCompare(y.upstream.commitTime) || x.run - y.run || x.attempt - y.attempt;
		const [a, b] = [...runtimeManifests].sort(byAge), [old, next] = managerManifests;
		const runtimeLabel = (r: any) => (r === runtimeManifests[0] ? "a" : "b");
		expect(a.id).not.toBe(b.id); expect(Bun.semver.order(next.version, old.version)).toBe(1);
		const addonDir = join(source, "addon"), addon = json(join(addonDir, "addon-manifest.json"));
		const slotMatches = runtimeManifests.every(r => JSON.stringify(r.addons.office.slot) === JSON.stringify(addon.slot));
		expect(slotMatches).toBe(true); // These fixed dry runs share one slot; mismatch must not silently skip office acceptance.
		appendAddon(runtimeIndex, addon);
		for (const asset of Object.values(addon.assets) as any[]) assets.set(`/download/${addon.tag}/${asset.file}`, join(addonDir, asset.file));
		const managerBytes = checkedAsset(join(source, "a/manager"), old.assets[managerTarget]);
		writeFileSync(exe, verifyZip(managerBytes, managerTarget, old.version), { flag: "wx", mode: 0o755 });
		chmodSync(exe, 0o755);
		let online = true;
		const requests: string[] = [];
		server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
			const path = new URL(req.url).pathname; requests.push(path);
			if (!online) return new Response("offline acceptance: network forbidden", { status: 503 });
			if (path === "/runtime-index.json") return Response.json(runtimeIndex);
			if (path === "/manager-index.json") return Response.json(managerIndex);
			const file = assets.get(path); return file ? new Response(Bun.file(file)) : new Response(null, { status: 404 });
		} });
		const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
		if (WIN) expect(systemRoot).toBeDefined();
		const system32 = WIN ? join(systemRoot!, "System32") : "";
		const env = (): Record<string, string> => {
			// .cmd shims need Windows' command processor, not a host Node/Bun installation.
			const path = WIN ? [install, system32] : [install];
			for (const dir of path) for (const name of ["node", "bun"]) for (const ext of ["", ".exe", ".cmd", ".bat", ".com"]) expect(existsSync(join(dir, name + ext))).toBe(false);
			return { PATH: path.join(delimiter), HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TMPDIR: root, TMP: root, TEMP: root, NO_COLOR: "1", DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_ORIGIN: server!.url.origin,
				...(WIN ? { SystemRoot: systemRoot!, windir: systemRoot!, COMSPEC: join(system32, "cmd.exe"), PATHEXT: ".COM;.EXE;.BAT;.CMD" } : {}) };
		};
		const command = async (args: string[], extra: Record<string, string> = {}, expectedCode = 0) => {
			const p = Bun.spawn([exe, ...args], { cwd, env: { ...env(), ...extra }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
			const stdout = Readable.fromWeb(p.stdout), stderr = Readable.fromWeb(p.stderr);
			let timer: ReturnType<typeof setTimeout>;
			try {
				const [code, out, err] = await Promise.race([
					Promise.all([p.exited, text(stdout), text(stderr)]),
					new Promise<never>((_, reject) => { timer = setTimeout(() => { p.kill(); reject(new Error(`combined command timed out: ${args.join(" ")}`)); }, 180_000); }),
				]);
				if (code !== expectedCode) throw new Error(`combined command ${args.join(" ")}: exit ${code}\n${out}\n${err}`);
				return { out, err };
			} finally { clearTimeout(timer!); if (p.exitCode === null) p.kill(); stdout.destroy(); stderr.destroy(); }
		};
		const bundle = (id: string) => join(data, "bundles", id);
		const snapshot = (id: string) => join(data, "snapshots", id);
		const protectedData = () => Object.fromEntries(["bundles", "snapshots", "addons", "home", "state"].flatMap(dir => Object.entries(digest(join(data, dir))).filter(([p]) => p !== "manager.lock").map(([p, hash]) => [`${dir}/${p}`, hash])));
		const probe = async (args: string[] = [], restart = false) => {
			const r = await command([...args, "--profile", "combined"], restart ? { COMBINED_RESTART: "1" } : {});
			const reports = r.out.split(/\r?\n/).filter(l => l.startsWith("COMBINED_PLUGIN ")).map(l => JSON.parse(l.slice(16)));
			expect(reports).toHaveLength(restart ? 2 : 1);
			for (const report of reports) {
				const shim = join(bundle(report.launch.runtime), "bin");
				expect(report.path.split(delimiter)).toEqual([shim, ...env().PATH.split(delimiter)]);
				// The only Node is the runtime's bundled shim, never a host Node/Bun executable.
				expect(Bun.which(WIN ? "node.cmd" : "node", { PATH: report.path })?.startsWith(shim)).toBe(true); expect(Bun.which("bun", { PATH: report.path })).toBeNull();
				expect(report.home).toBe(home); expect(report.cwd).toBe(cwd); expect(report.launch.dataRoot).toBe(data); expect(report.launch.home).toBe(join(data, "home"));
			}
			return reports;
		};

		// First ordinary noninteractive launch, not `manager install`: bootstrap fetches the newest runtime.
		expect(tree(install)).toEqual([`dsh${suffix}`]);
		expect((await command(["plugin", "--profile", "combined", "--help"])).out).toContain("pnpm");
		expect(requests).toContain("/runtime-index.json"); expect(existsSync(bundle(b.id))).toBe(true);
		for (const arg of ["--version", "--help"]) expect((await command(["--use", b.id, arg])).out).toContain(arg === "--version" ? b.upstream.version : "dsh");
		const actualTarget = json(join(bundle(b.id), "bundle.json")).target;
		for (const manifest of [a, b]) checkedAsset(join(source, runtimeLabel(manifest), "runtime"), manifest.targets[actualTarget]);
		note("empty-install", {runtime: b.id, actualTarget});

		const profile = join(snapshot(`${b.id}@1`), "profiles/combined"); mkdirSync(profile, { recursive: true });
		writeFileSync(join(profile, "package.json"), JSON.stringify({ name: "combined-profile", private: true, dsh: { profile: { bundles: [] } } }));
		const plugin = join(root, "combined-plugin.tgz");
		writeFileSync(plugin, await new Bun.Archive({
			"package/package.json": JSON.stringify({ name: "dsh-combined-probe", version: "1.0.0", type: "module", main: "index.js" }), "package/index.js": PROBE,
		}, { compress: "gzip" }).bytes());
		await command(["--use", b.id, "plugin", "--profile", "combined", "add", plugin, "--offline", "--ignore-scripts", "--config.update-notifier=false"]);
		const shared = join(data, "home/profiles/combined"); mkdirSync(shared, { recursive: true });
		writeFileSync(join(shared, "cordis.patch.yml"), "- insert:\n    - id: combined-probe\n      name: dsh-combined-probe\n");
		for (const p of ["home/credentials.json", "home/sessions/keep.json", "home/config.json"]) { mkdirSync(join(data, p, ".."), { recursive: true }); writeFileSync(join(data, p), '{"keep":"user data"}'); }
		expect((await probe())[0].launch.runtime).toBe(b.id);
		await command(["manager", "install", a.id]);
		const list = (await command(["manager", "list"])).out; expect(list).toContain(a.id); expect(list).toContain(b.id);
		await command(["manager", "snapshot", "plugins", "new", "--use", b.id]);
		const chosenSnapshot = `${b.id}@2`;
		await command(["manager", "select", "--use", b.id, "--snapshot", chosenSnapshot]);
		for (const runtime of [a.id, b.id]) expect((await probe(["--use", runtime, "--snapshot", chosenSnapshot]))[0].launch.snapshot.id).toBe(chosenSnapshot);
		note("versions-snapshots-plugin", {runtimes: [a.id, b.id], snapshot: chosenSnapshot});

		await command(["manager", "install", "--addon", "office"]);
		await command(["manager", "select", "--use", b.id, "--snapshot", chosenSnapshot, "--addon", `office:${addon.version}`]);
		const addonRoot = join(data, "addons/office", addon.version);
		expect(json(join(addonRoot, "addon.json")).slot).toEqual(addon.slot);
		expect((await probe())[0].launch.addons.office.version).toBe(addon.version);
		// Real upstream office plugins import their real kit/engine closure; no credentials or network needed.
		const officeProfile = join(snapshot(chosenSnapshot), "profiles/office-combined"), officeShared = join(data, "home/profiles/office-combined");
		mkdirSync(officeProfile, { recursive: true }); mkdirSync(officeShared, { recursive: true });
		writeFileSync(join(officeProfile, "package.json"), JSON.stringify({ name: "office-combined", private: true, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } } }));
		writeFileSync(join(officeShared, "cordis.patch.yml"), "- insert:\n    - id: office-to-pdf\n      name: '@deepseek-ai/dsh-office-to-pdf'\n    - id: skill-office\n      name: '@deepseek-ai/dsh-skill-office'\n");
		const office = async () => {
			const r = await command(["--profile", "office-combined", "hi"], {}, 1);
			expect(r.err).toContain("MISSING_CREDENTIAL"); expect(r.err).not.toMatch(/DeclaredDegradation|did not activate|failed to import/);
		};
		await office(); note("real-office-addon", {tag: addon.tag, slot: addon.slot});

		// Deletion refuses an explicit pin. Choose latest first, then restore the saved selection after reinstall.
		await command(["manager", "select", "--use", "latest"]);
		const preserved = Object.fromEntries(["snapshots", "home", "addons"].map(d => [d, digest(join(data, d))]));
		await command(["manager", "uninstall", a.id, b.id]);
		expect(readdirSync(join(data, "bundles"))).toEqual([]);
		online = false; const beforeOffline = requests.length;
		await command(["manager", "list"]); await command(["manager", "info"]); expect(requests.length).toBe(beforeOffline);
		online = true; await command(["manager", "install", b.id]); await command(["manager", "install", a.id]);
		for (const [d, hashes] of Object.entries(preserved)) expect(digest(join(data, d))).toEqual(hashes);
		await command(["manager", "select", "--use", b.id, "--snapshot", chosenSnapshot, "--addon", `office:${addon.version}`]);
		expect((await probe())[0].launch.snapshot.id).toBe(chosenSnapshot);
		note("uninstall-all-reinstall", {preservedPaths: Object.values(preserved).reduce((n, d) => n + Object.keys(d).length, 0)});

		online = false; const offlineRequests = requests.length;
		const restarted = await probe([], true); expect(restarted.map(r => r.restarted)).toEqual([false, true]);
		for (const r of restarted) expect(r.launch.snapshot.id).toBe(chosenSnapshot);
		expect(requests.length).toBe(offlineRequests); note("offline-in-app-restart", {processes: 2});

		online = true; const beforeUpdate = protectedData(), oldManagerHash = sha256(readFileSync(exe));
		const update = await command(["manager", "self-update"]);
		if (WIN) {
			expect(update.out).toContain("handed off to helper");
			const result = join(data, "tmp/self-update-result.txt"), deadline = Date.now() + 30_000;
			while (!existsSync(result) && Date.now() < deadline) await Bun.sleep(20);
			expect(existsSync(result)).toBe(true); expect(readFileSync(result, "utf8")).toContain(`updated ${old.version} -> ${next.version}`);
		}
		expect((await command(["manager", "--version"])).out).toContain(next.version);
		expect(sha256(readFileSync(exe))).not.toBe(oldManagerHash);
		expect(readFileSync(exe)).toEqual(verifyZip(checkedAsset(join(source, "b/manager"), next.assets[managerTarget]), managerTarget, next.version));
		expect(protectedData()).toEqual(beforeUpdate); expect((await probe())[0].launch.manager).toBe(next.version);
		note("manager-only-self-update", {from: old.version, to: next.version, unchangedPaths: Object.keys(beforeUpdate).length});

		for (const runtime of [a.id, b.id]) expect(existsSync(bundle(runtime))).toBe(true);
		const requestsBeforeMove = requests.length;
		await server.stop(true);
		const original = install, sealed = join(root, "inaccessible original");
		renameSync(install, sealed); mkdirSync(join(root, "moved")); install = join(root, "moved/portable install");
		renameSync(sealed, install); // Entire install moved; original name no longer resolves on either OS.
		exe = join(install, `dsh${suffix}`); data = join(install, "dsh-bin");
		const movedState = protectedData(), selectedReport = (await probe())[0];
		expect(selectedReport.launch.runtime).toBe(b.id); expect(selectedReport.launch.snapshot.id).toBe(chosenSnapshot);
		for (const runtime of [a.id, b.id]) {
			expect(existsSync(bundle(runtime))).toBe(true);
			const movedReport = (await probe(["--use", runtime, "--snapshot", chosenSnapshot, "--addon", `office:${addon.version}`]))[0];
			expect(movedReport.launch.runtime).toBe(runtime);
			expect(movedReport.launch.snapshot.id).toBe(chosenSnapshot); expect(movedReport.launch.addons.office.dir).toBe(join(data, "addons/office", addon.version));
		}
		await office();
		// A real app boot may create a new session; it must preserve every pre-move user/runtime path.
		const afterMove = protectedData();
		for (const [path, hash] of Object.entries(movedState)) expect(afterMove[path]).toBe(hash);
		expect(existsSync(original)).toBe(false);
		await command(["manager", "clean"]); // Also removes the retired Windows helper/candidate, never user data.
		expect(requests.length).toBe(requestsBeforeMove);
		note("offline-move", {runtimes: [a.id, b.id], snapshot: chosenSnapshot, oldPathAbsent: true, sourceStopped: true, unchangedPaths: Object.keys(movedState).length});
		expect(tree(home)).toEqual([]); expect(tree(cwd)).toEqual([]);
		const outside = tree(root).filter(p => !p.startsWith("moved/portable install/dsh-bin/"));
		expect(outside).toEqual(["combined-plugin.tgz", "isolated-home", "moved", "moved/portable install", "moved/portable install/dsh-bin", `moved/portable install/dsh${suffix}`, "workspace"].sort());
		note("containment", {outsideDataRootWrites: 0, auditedPaths: tree(root).length, isolatedHomePaths: tree(home).length, protectedPaths: Object.keys(protectedData()).length});
	} finally { if (server) await server.stop(true); rmSync(root, { recursive: true, force: true }); }
}, 900_000);
