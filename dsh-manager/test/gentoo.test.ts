import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gentooEbuild, gentooVersion } from "../scripts/gentoo-ebuild.mjs";
import { hostTargetId } from "../../dsh-bun-build/scripts/targets.mjs";
import { writeZip } from "../../dsh-bun-build/runtime/zip.ts";
import { baseEnv, build, bundleMeta, cleanup, hasZig, holdSession, launchOf, MANAGER_VERSION, newInstall, run, tempDir, tree } from "./harness.ts";

afterAll(cleanup);

const TPL = readFileSync(join(import.meta.dir, "../packaging/gentoo/dsh-bin-9999.ebuild.in"), "utf8");
const asset = (name: string, c: string) => ({ name, size: 7, sha256: c.repeat(64) });
const entry = (version: string) => ({ version, tag: `manager-v${version}`, launchProtocols: [1], assets: {
	"linux-x64": asset("manager-linux-x64.zip", "1"), "linux-arm64": asset("manager-linux-arm64.zip", "2"),
} });

test("7.4: manager SemVer maps to Gentoo PV independently of runtime builds", () => {
	expect(gentooVersion("1.2.0-rc.2")).toBe("1.2.0_rc2");
	expect(gentooVersion("1.10.0+repair")).toBe("1.10.0");
	expect(() => gentooVersion("1.0.0-xz.9.1.gabcdef12")).toThrow();
	expect(() => gentooVersion("01.0.0")).toThrow();
});

test("PS-MANAGED / DL-MANAGED-UPDATE: Gentoo package owns only newest manager, marker and entry", () => {
	const r = gentooEbuild({ schema: 1, versions: [entry("1.9.0"), entry("1.10.0-rc.1"), entry("1.10.0")] }, TPL);
	expect(r.pv).toBe("1.10.0"); expect(r.ebuild).toContain('MY_TAG="manager-v1.10.0"');
	expect(r.ebuild).toContain(".dsh-manager-install.json"); expect(r.ebuild).toContain('"owner":"portage"');
	expect(r.ebuild).toContain("doexe root/dsh"); expect(r.ebuild).toContain("dosym -r /usr/lib/dsh-bin/dsh /usr/bin/dsh");
	for (const old of ["OFFICE", ".portage.managed.lock", "linux-x64-baseline", 'IUSE="office"', "cp -a root/."]) expect(r.ebuild).not.toContain(old);
	expect(r.ebuild).not.toContain("@");
	const srcNames = [...r.ebuild.matchAll(/-> (\S+)/g)].map(m => m[1].replace("${MY_TAG}", "manager-v1.10.0"));
	expect(r.manifest.trim().split("\n").map(l => l.split(" ")[1]).sort()).toEqual(srcNames.sort());
	expect(r.manifest.trim().split("\n")).toHaveLength(2);
});

test("7.4: invalid manager identity or missing Linux asset refuses packaging", () => {
	for (const e of [{ ...entry("1.0.0"), tag: "../bad" }, { ...entry("1.0.0"), launchProtocols: [2] }, { ...entry("1.0.0"), assets: {} },
		{ ...entry("1.0.0"), assets: { "linux-x64": asset("$(touch bad).zip", "1"), "linux-arm64": asset("ok.zip", "2") } }]) {
		expect(() => gentooEbuild({ schema: 1, versions: [e] }, TPL)).toThrow();
	}
});

for (const kind of ["symlink", "hardlink"]) test.skipIf(process.platform !== "linux" || process.getuid?.() === 0)(`7.4 review: failed Portage check preserves existing ${kind} log file`, () => {
	const script = join(import.meta.dir, "../scripts/gentoo-portage-check.sh");
	const dir = tempDir("dsh-gentoo-logs-"), scratch = join(dir, "scratch"), logs = join(scratch, "logs"), tools = join(dir, "tools");
	mkdirSync(logs, { recursive: true }); mkdirSync(tools); mkdirSync(join(dir, "home"));
	const sentinel = join(dir, "credential"), bytes = Buffer.from(`SECRET KEEP ${kind}\n`);
	writeFileSync(sentinel, bytes);
	if (kind === "symlink") symlinkSync(sentinel, join(logs, "build1.log"));
	else linkSync(sentinel, join(logs, "build1.log"));
	writeFileSync(join(tools, "zig"), "#!/bin/sh\nprintf 'diagnostic-from-failed-build\\n'\nexit 1\n", { mode: 0o755 });
	const source = readFileSync(script, "utf8").replace("base=/var/tmp/dsh-74-gentoo", `base='${scratch}'`);
	const p = Bun.spawnSync(["sh", "-c", source, script], { env: { ...process.env, PATH: `${tools}:${process.env.PATH}`, HOME: join(dir, "home"), TMPDIR: dir }, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
	expect(p.exitCode).toBe(1); expect(readFileSync(sentinel)).toEqual(bytes); expect(readFileSync(join(logs, "build1.log"))).toEqual(bytes);
	const runs = readdirSync(logs).filter(name => name !== "build1.log"); expect(runs).toHaveLength(1);
	const runLogs = join(logs, runs[0]); expect(statSync(runLogs).mode & 0o777).toBe(0o700);
	expect(readFileSync(join(runLogs, "build1.log"), "utf8")).toBe("diagnostic-from-failed-build\n");
	expect(p.stdout.toString()).toContain(runLogs);
});

const A = "1.0.0-b1.1.gdeadbeef", B = "1.0.0-b2.1.gdeadbeef";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function files(dir: string) {
	return Object.fromEntries(tree(dir).map(p => { try { return [p, hash(readFileSync(join(dir, p)))]; } catch { return [p, "directory"]; } }));
}

// Opt-in real Portage run: ROOT/config/dist/builds must all be prepared under this throwaway path.
const realRoot = process.env.DSH_GENTOO_TEST_ROOT;
const realLogs = process.env.DSH_GENTOO_TEST_LOGS;
const realBase = "/var/tmp/dsh-74-gentoo";
test.skipIf(!hasZig || process.platform !== "linux")(`PS-MANAGED / DL-MANAGED-UPDATE / DL-MANAGED-SELF / DL-MANAGED-REMOVE: ${realRoot ? "real non-root Portage lifecycle" : "isolated Gentoo package lifecycle"}`, async () => {
	if (realRoot && (realRoot !== `${realBase}/root` || process.getuid?.() === 0 || !realLogs)) throw new Error("real run requires non-root throwaway ROOT and fresh log directory");
	const i = newInstall(); i.data = join(i.home, "xdg/dsh-bin");
	if (realRoot) { i.dir = join(realRoot, "usr/lib/dsh-bin"); i.exe = join(realRoot, "usr/bin/dsh"); }
	else writeFileSync(join(i.dir, ".dsh-manager-install.json"), '{"schema":1,"owner":"portage"}\n');
	const packagedDir = i.dir, prefix = files(i.dir), env = { ...baseEnv(i), XDG_DATA_HOME: join(i.home, "xdg") };
	for (const p of tree(i.dir)) chmodSync(join(i.dir, p), p === "dsh" ? 0o555 : 0o444);
	chmodSync(i.dir, 0o555);
	const requests: string[] = [], target = hostTargetId(), archives = new Map<string, Buffer>();
	const versions = [A, B].map((id, n) => {
		const meta = bundleMeta(id, { run: n + 1, patch: { target } }), zip = join(tempDir("dsh-gentoo-runtime-"), "runtime.zip");
		writeZip(zip, [{ name: "bundle.json", data: Buffer.from(JSON.stringify(meta)), mode: 0o644 }, { name: "dsh-native", data: readFileSync(build().fake), mode: 0o755 }]);
		const bytes = readFileSync(zip), tag = `runtime-v${id}`; archives.set(`/download/${tag}/runtime.zip`, bytes);
		return { ...meta, tag, seq: n + 1, assets: { [target]: { name: "runtime.zip", size: bytes.length, sha256: hash(bytes) } } };
	});
	const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
		const path = new URL(req.url).pathname; requests.push(path);
		if (path === "/runtime-index.json") return Response.json({ schema: 1, channels: { release: versions, live: [] }, addons: { office: [] } });
		return archives.has(path) ? new Response(archives.get(path)) : new Response(null, { status: 404 });
	} });
	async function command(args: string[]) {
		const p = Bun.spawn([i.exe, ...args], { cwd: i.home, env: { ...env, DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_ORIGIN: `http://127.0.0.1:${s.port}` }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
		const timer = setTimeout(() => p.kill("SIGKILL"), 30_000);
		try { const [status, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]); return { status, stdout, stderr }; }
		finally { clearTimeout(timer); }
	}
	async function portage(action: "upgrade" | "unmerge") {
		const args = action === "upgrade" ? [`${realBase}/overlay/app-misc/dsh-bin/dsh-bin-1.0.1.ebuild`, "clean", "install", "merge"] : [`${realBase}/overlay/app-misc/dsh-bin/dsh-bin-1.0.1.ebuild`, "unmerge"];
		const p = Bun.spawn(["/usr/bin/ebuild", ...args], { env: { PATH: "/usr/bin:/bin", HOME: i.home, ROOT: realRoot!, PORTAGE_CONFIGROOT: `${realBase}/config`, TMPDIR: `${realBase}/tmp` }, stdout: "pipe", stderr: "pipe" });
		const timer = setTimeout(() => p.kill("SIGKILL"), 120_000);
		try { const [status, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]); writeFileSync(join(realLogs!, `${action}.log`), stdout + stderr); expect({ status, stderr }).toMatchObject({ status: 0 }); }
		finally { clearTimeout(timer); }
	}
	let session: Awaited<ReturnType<typeof holdSession>> | undefined;
	try {
		const info = run(i, ["manager", "info"], { env }); expect(info.status).toBe(0); expect(info.stdout).toContain("mode: portage"); expect(info.stdout).toContain(i.data);
		let before = requests.length, r = await command(["manager", "self-update"]); expect(r.status).toBe(1); expect(r.stderr).toContain("emerge --ask --update app-misc/dsh-bin"); expect(requests.length).toBe(before); expect(existsSync(i.data)).toBe(false);
		for (const id of [A, B]) expect(await command(["manager", "install", id])).toMatchObject({ status: 0 });
		expect((await command(["manager", "select", "--use", A])).status).toBe(0); expect((await command(["probe"])).status).toBe(0); expect(launchOf(i).runtime).toBe(A);
		expect((await command(["manager", "select", "--use", B])).status).toBe(0); expect((await command(["manager", "snapshot", "new", "--use", B, "--empty", "--name", "kept"])).status).toBe(0);
		expect((await command(["probe"])).status).toBe(0); expect(launchOf(i).runtime).toBe(B);
		mkdirSync(join(i.data, "home/profiles"), { recursive: true }); writeFileSync(join(i.data, "home/credential"), "SECRET KEEP"); writeFileSync(join(i.data, "home/profiles/config"), "CONFIG KEEP");
		expect(files(i.dir)).toEqual(prefix); expect(existsSync(join(i.dir, "dsh-bin"))).toBe(false);
		session = await holdSession(i, ["--use", B], env); const protectedBefore = files(i.data);
		chmodSync(i.dir, 0o755);
		if (realRoot) await portage("upgrade");
		else { const next = newInstall(); writeFileSync(join(next.dir, ".dsh-manager-install.json"), '{"schema":1,"owner":"portage"}\n'); i.dir = next.dir; i.exe = next.exe; }
		const version = run(i, ["manager", "--version"], { env }); expect(version.status).toBe(0); expect(version.stdout).toContain(realRoot ? "1.0.1" : MANAGER_VERSION);
		expect(files(i.data)).toEqual(protectedBefore); expect(run(i, ["manager", "list", "--json"], { env }).stdout).toContain(B);
		before = requests.length; expect((await command(["manager", "self-update"])).status).toBe(1); expect(requests.length).toBe(before);
		if (realRoot) await portage("unmerge"); else { rmSync(i.exe); rmSync(join(i.dir, ".dsh-manager-install.json")); }
		expect(existsSync(i.exe)).toBe(false); expect(files(i.data)).toEqual(protectedBefore); expect(session.proc.exitCode).toBe(null); expect(await session.finish()).toBe(0); session = undefined;
		expect(readFileSync(join(i.data, "home/credential"), "utf8")).toBe("SECRET KEEP");
		console.info(`Gentoo lifecycle: uid=${process.getuid?.()}, ${realRoot ? "Portage install 1.0.0 → upgrade 1.0.1 → unmerge" : "automated layout"}; prefix untouched, data/credentials/session preserved; requests=${requests.length}`);
	} finally { if (session) await session.finish(); s.stop(true); for (const dir of [packagedDir, i.dir]) if (existsSync(dir)) chmodSync(dir, 0o755); }
}, 300_000);
