// MC-ADDON: native manager operations and launch payload, no application needed.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { writeZip } from "../../dsh-bun-build/runtime/zip.ts";
import { hostTargetId } from "../../dsh-bun-build/scripts/targets.mjs";
import { acquireClaim } from "./claim-probe.ts";
import { addRuntime, baseEnv, build, cleanup, hasZig, holdSession, launchOf, newInstall, run, started, tempDir, tree, replaceAncestor, type Install } from "./harness.ts";

beforeAll(() => { if (hasZig) build(); }, 300_000);
afterAll(cleanup);
const V = "1.0.0-b1.1.gdeadbeef", W = "2.0.0-b2.1.gdeadbeef";
const A = "0.1.1-b1.1.gdeadbeef", B = "0.1.1-b2.1.gdeadbeef", C = "0.2.0-b3.1.gdeadbeef";
const slot = { commit: "a".repeat(40), kitVersion: "0.1.1" }, other = { commit: "b".repeat(40), kitVersion: "0.2.0" };
const platform = process.platform === "linux" ? "linux" : `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
function source(i: Install, beforeDownload?: () => void | Promise<void>) {
	const requests: string[] = [], assets = new Map<string, Buffer>();
	const entries = [A, B, C].map((version, n) => {
		const tag = `addon-office-v${version}`, s = n === 2 ? other : slot;
		const zip = join(tempDir("dsh-addon-zip-"), "addon.zip");
		writeZip(zip, [
			{ name: "addon.json", data: Buffer.from(JSON.stringify({ name: "office", version, tag, slot: s, kitVersion: s.kitVersion, platform, packages: ["@deepseek-ai/libreoffice-kit@" + s.kitVersion] })), mode: 0o644 },
			{ name: "node_modules/@deepseek-ai/libreoffice-kit/package.json", data: Buffer.from('{"name":"@deepseek-ai/libreoffice-kit"}'), mode: 0o644 },
		]);
		const bytes = readFileSync(zip), name = `dsh-addon-office-${platform}.zip`;
		assets.set(`/download/${tag}/${name}`, bytes);
		return { version, tag, slot: s, seq: n + 1, assets: { [platform]: { name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } } };
	});
	const table = { slot, pinned: A, known: [entries[0]] };
	addRuntime(i.data, V, { patch: { target: hostTargetId(), addons: { office: table } } });
	addRuntime(i.data, W, { run: 2, patch: { target: hostTargetId(), addons: { office: { slot: other, pinned: C, known: [] } } } });
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
		const p = new URL(req.url).pathname; requests.push(p);
		if (p === "/runtime-index.json") return Response.json({ schema: 1, channels: { release: [{ kind: "dsh-manager", version: "99" }], live: [] }, addons: { office: entries } });
		if (assets.has(p)) await beforeDownload?.();
		return assets.has(p) ? new Response(assets.get(p)) : new Response(null, { status: 404 });
	} });
	return { entries, assets, requests, origin: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
async function command(i: Install, s: ReturnType<typeof source>, args: string[]) {
	rmSync(join(i.out, "1.argv"), { force: true });
	const p = Bun.spawn([i.exe, ...args], { cwd: i.home, env: { ...baseEnv(i), DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_ORIGIN: s.origin, DSH_MANAGER_TEST_RETRY_MS: "1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => p.kill(), 30_000);
	try { const [status, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]); return { status, stdout, stderr }; }
	finally { clearTimeout(timer); }
}
const selection = (i: Install) => readFileSync(join(i.data, "state/selection.json"), "utf8");
const install = (i: Install, s: ReturnType<typeof source>, v = "office") => command(i, s, ["--use", V, "manager", "install", "--addon", v]);

test.skipIf(!hasZig)("MC-CLEAN: explicit addon install restores a validated interrupted retirement before downloading", async () => {
	const i = newInstall(), s = source(i);
	try {
		expect((await install(i, s, `office:${A}`)).status).toBe(0);
		const dir = join(i.data, "addons/office", A), backup = join(i.data, "tmp", `.previous-addon-office-${A}`);
		writeFileSync(join(dir, "node_modules/keep"), "last generation"); renameSync(dir, backup);
		const before = s.requests.length, recovered = await install(i, s, `office:${A}`);
		expect(recovered.status).toBe(0); expect(s.requests.slice(before)).toEqual(["/runtime-index.json"]);
		expect(readFileSync(join(dir, "node_modules/keep"), "utf8")).toBe("last generation"); expect(existsSync(backup)).toBe(false); expect(started(i)).toBe(false);
	} finally { s.stop(); }
});

test.skipIf(!hasZig)("MC-IN-USE: force addon activation rechecks a session that starts during download", async () => {
	const i = newInstall(); let armed = false, session: Awaited<ReturnType<typeof holdSession>> | undefined;
	const s = source(i, async () => { if (armed) { armed = false; session = await holdSession(i, ["--use", V, "--addon", `office:${A}`]); } });
	try {
		expect((await install(i, s, `office:${A}`)).status).toBe(0);
		const marker = join(i.data, "addons/office", A, "node_modules/keep"); writeFileSync(marker, "old generation");
		rmSync(join(i.data, "cache/downloads"), { recursive: true }); armed = true;
		const r = await command(i, s, ["--use", V, "manager", "install", "--addon", `office:${A}`, "--force"]);
		expect(session).toBeDefined(); expect(r.status).toBe(1); expect(r.stderr.trim().split("\n")).toHaveLength(1); expect(r.stderr).toContain(A); expect(r.stderr).toContain("in use"); expect(readFileSync(marker, "utf8")).toBe("old generation"); expect(tree(join(i.data, "tmp"))).toEqual([]);
	} finally { if (session) expect(await session.finish()).toBe(0); s.stop(); }
});

test.skipIf(!hasZig)("MC-IN-USE: force addon replacement refuses live addon before download, keeps bytes; repairs after exit", async () => {
	const i = newInstall(), s = source(i);
	try {
		expect((await install(i, s, `office:${A}`)).status).toBe(0);
		const dir = join(i.data, "addons/office", A), original = tree(dir).map(p => { try { return [p, readFileSync(join(dir, p)).toString("hex")]; } catch { return [p, "dir"]; } });
		const session = await holdSession(i, ["--use", V, "--addon", `office:${A}`]);
		try {
			const before = s.requests.length, r = await command(i, s, ["--use", V, "manager", "install", "--addon", `office:${A}`, "--force"]);
			expect(r.status).toBe(1); expect(r.stderr).toContain(A); expect(r.stderr).toContain("in use"); expect(r.stdout).toBe(""); expect(s.requests.slice(before)).toEqual(["/runtime-index.json"]);
			expect(tree(dir).map(p => { try { return [p, readFileSync(join(dir, p)).toString("hex")]; } catch { return [p, "dir"]; } })).toEqual(original);
		} finally { expect(await session.finish()).toBe(0); }
		expect((await command(i, s, ["--use", V, "manager", "install", "--addon", `office:${A}`, "--force"])).status).toBe(0);
	} finally { s.stop(); }
});

test.skipIf(!hasZig)("MC-ADDON: install/select/list/uninstall are native; default uses newest in-slot; selected deletion refuses", async () => {
	const i = newInstall(), s = source(i);
	try {
		const first = await install(i, s); expect(first.status).toBe(0); expect(first.stdout).toContain(B); expect(started(i)).toBe(false);
		expect(existsSync(join(i.data, "addons/office", B, "node_modules"))).toBe(true);
		expect(existsSync(join(i.data, "state/channel"))).toBe(false);
		expect((await install(i, s, `office:${A}`)).status).toBe(0);
		const list = run(i, ["manager", "list", "--json"]); expect(list.status).toBe(0); expect(JSON.parse(list.stdout).addons.office.map((e: any) => e.version).sort()).toEqual([A, B]); expect(started(i)).toBe(false);
		const before = tree(i.data), count = s.requests.length;
		expect(run(i, ["manager", "list"]).stdout).toContain(B); expect(tree(i.data)).toEqual(before); expect(s.requests.length).toBe(count);
		expect(run(i, ["--use", V, "probe"]).status).toBe(0); expect(launchOf(i).addons.office.version).toBe(B);
		expect(run(i, ["manager", "select", "--use", V, "--addon", `office:${A}`]).status).toBe(0); expect(started(i)).toBe(false);
		expect(JSON.parse(selection(i)).addons).toEqual({ office: A }); expect(run(i, ["manager", "select"]).stdout).toContain(`office: ${A}`);
		expect(run(i, ["probe"]).status).toBe(0); expect(launchOf(i).addons.office.version).toBe(A);
		const refused = run(i, ["manager", "uninstall", "--addon", "office"]); expect(refused.status).toBe(1); expect(refused.stderr).toContain("selection"); expect(existsSync(join(i.data, "addons/office", B))).toBe(true);
		expect(run(i, ["--addon", "office:none", "probe"]).status).toBe(0); expect(launchOf(i).addons.office).toBeUndefined();
		expect(run(i, ["manager", "select", "--use", V, "--addon", "office:none"]).status).toBe(0); expect(run(i, ["probe"]).status).toBe(0); expect(launchOf(i).addons.office).toBeUndefined();
		expect(run(i, ["manager", "uninstall", "--addon", "office"]).status).toBe(0); expect(started(i)).toBe(false); expect(existsSync(join(i.data, "addons/office", A))).toBe(false);
		expect(existsSync(join(i.data, "bundles", V))).toBe(true); expect(existsSync(join(i.data, "snapshots", `${V}@1`))).toBe(true);
	} finally { s.stop(); }
});

test.skipIf(!hasZig)("MC-ADDON: slots never bypassed by force; missing/incompatible stored or explicit addon degrades offline", async () => {
	const i = newInstall(), s = source(i);
	try {
		expect((await install(i, s, `office:${A}`)).status).toBe(0);
		const bad = await command(i, s, ["--use", V, "manager", "install", "--addon", `office:${C}`, "--force"]);
		expect(bad.status).toBe(1); expect(bad.stderr).toContain("slot"); expect(existsSync(join(i.data, "addons/office", C))).toBe(false); expect(started(i)).toBe(false);
		expect(run(i, ["manager", "select", "--use", V, "--addon", `office:${A}`]).status).toBe(0);
		const saved = selection(i), count = s.requests.length;
		for (const args of [["--use", W, "probe"], ["--use", W, "--addon", `office:${A}`, "probe"], ["--use", V, "--addon", "office:missing", "probe"]]) {
			const r = run(i, args); expect(r.status).toBe(0); expect(r.stderr).toMatch(/office addon .* (missing|incompatible)/); expect(launchOf(i).addons.office).toBeUndefined();
		}
		rmSync(join(i.data, "addons/office", A), { recursive: true });
		const missing = run(i, ["probe"]); expect(missing.status).toBe(0); expect(missing.stderr).toContain("missing"); expect(launchOf(i).addons.office).toBeUndefined(); expect(selection(i)).toBe(saved); expect(s.requests.length).toBe(count);
		for (const addon of ["../../bad", "office:../bad", "unknown:1", "office:", "office:addon-office-v"]) expect(run(i, ["--addon", addon, "probe"]).status).toBe(1);
		expect(run(i, ["--addon", "office:../bad", "--addon", "office:none", "probe"]).status).toBe(1);
		expect(run(i, ["manager", "select", "--use", V, "--addon", "office:none"]).status).toBe(0);
		expect(run(i, ["manager", "select", "--use", "latest", "--addon", "office:none"]).status).toBe(0);
		expect(run(i, ["manager", "uninstall", V, W]).status).toBe(0);
		expect(run(i, ["manager", "select", "--use", "latest", "--addon", "office:none"]).status).toBe(0);
	} finally { s.stop(); }
});

test.skipIf(!hasZig)("MC-ADDON: digest/size/metadata failures publish nothing; force replaces only validated addon; available is in-slot", async () => {
	const i = newInstall(), s = source(i);
	try {
		const asset = s.entries[1].assets[platform], hash = asset.sha256, size = asset.size;
		asset.sha256 = "a".repeat(64); const corrupt = await install(i, s); expect(corrupt.status).toBe(1); expect(corrupt.stderr).toContain("HashMismatch"); expect(existsSync(join(i.data, "addons/office", B))).toBe(false); expect(started(i)).toBe(false);
		asset.sha256 = hash; asset.size = size + 1; expect((await install(i, s)).status).toBe(1); expect(existsSync(join(i.data, "addons/office", B))).toBe(false); asset.size = size;
		expect((await install(i, s)).status).toBe(0);
		const marker = join(i.data, "addons/office", B, "node_modules/keep"); writeFileSync(marker, "old generation");
		asset.sha256 = "b".repeat(64); expect((await command(i, s, ["--use", V, "manager", "install", "--addon", "office", "--force"])).status).toBe(1); expect(readFileSync(marker, "utf8")).toBe("old generation"); asset.sha256 = hash;
		expect((await command(i, s, ["--use", V, "manager", "install", "--addon", "office", "--force"])).status).toBe(0); expect(existsSync(marker)).toBe(false); expect(started(i)).toBe(false);
		const available = await command(i, s, ["--use", V, "manager", "list", "--available", "--json"]); expect(available.status).toBe(0); expect(JSON.parse(available.stdout).availableAddons.office.map((e: any) => e.version).sort()).toEqual([A, B]);
		s.entries[0].assets[platform].sha256 = "c".repeat(64); const conflict = await install(i, s, `office:${A}`); expect(conflict.status).toBe(1); expect(conflict.stderr).toContain("Conflict");
	} finally { s.stop(); }
});


test.skipIf(!hasZig)("MC-ADDON: verified bytes still require matching metadata and addon-only archive roots", async () => {
	const i = newInstall(), s = source(i);
	try {
		const e = s.entries[1], asset = e.assets[platform], zip = join(tempDir("dsh-addon-invalid-"), "addon.zip");
		const path = `/download/${e.tag}/${asset.name}`;
		for (const [patch, extra] of [[{ slot: other }, []], [{ tag: "dsh-addon-office-vold" }, []], [{}, [{ name: "dsh-native", data: Buffer.from("unexpected application"), mode: 0o755 }]]] as const) {
			writeZip(zip, [{ name: "addon.json", data: Buffer.from(JSON.stringify({ name: "office", version: B, tag: e.tag, slot, kitVersion: slot.kitVersion, platform, packages: [], ...patch })), mode: 0o644 }, { name: "node_modules/", dir: true }, ...extra]);
			const bytes = readFileSync(zip); s.assets.set(path, bytes); asset.size = bytes.length; asset.sha256 = createHash("sha256").update(bytes).digest("hex");
			const r = await install(i, s); expect(r.status).toBe(1); expect(r.stderr).toMatch(/Metadata|UnexpectedAddonRoot/); expect(existsSync(join(i.data, "addons/office", B))).toBe(false); expect(started(i)).toBe(false);
		}
	} finally { s.stop(); }
});

test.skipIf(!hasZig)("MC-ADDON review: uninstall through a replaced ancestor preserves external files", async () => {
	const i = newInstall(), s = source(i);
	try {
		expect((await install(i, s, `office:${A}`)).status).toBe(0);
		const addons = join(i.data, "addons"), external = join(i.home, "external"), target = join(external, "office", A), sentinel = join(target, "unrelated-user-file");
		mkdirSync(target, { recursive: true }); writeFileSync(sentinel, "KEEP");
		const p = spawn(i.exe, ["manager", "uninstall", "--addon", `office:${A}`], { cwd: i.home, env: { ...baseEnv(i), DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_PAUSE: "addon-remove" }, stdio: "pipe" });
		let stderr = ""; p.stderr.on("data", b => { stderr += b.toString(); }); p.stdout.resume();
		const done = new Promise<number | null>((resolve, reject) => { p.on("close", resolve); p.on("error", reject); });
		const watchdog = setTimeout(() => p.kill("SIGKILL"), 15_000);
		try {
			const deadline = Date.now() + 5000;
			while (!stderr.includes("test pause: addon-remove") && p.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
			expect(stderr).toContain("test pause: addon-remove");
			const claim = acquireClaim(join(addons, "office", A, ".usage.lock"), "shared");
			try { expect(claim).toBe("busy"); } finally { if (claim !== "busy") claim.release(); }
			const original = replaceAncestor(addons, external);
			p.stdin.end("continue"); const code = await done;
			expect(existsSync(sentinel)).toBe(true); expect(readFileSync(sentinel, "utf8")).toBe("KEEP");
			expect(code).toBe(0); expect(existsSync(join(original, "office", A))).toBe(false); expect(started(i)).toBe(false);
		} finally { clearTimeout(watchdog); if (p.exitCode === null) { p.kill("SIGKILL"); await done; } }
	} finally { s.stop(); }
}, 30_000);

test.skipIf(!hasZig)("MC-ADDON review: force install through a download-time ancestor swap preserves external files", async () => {
	const i = newInstall(), addons = join(i.data, "addons"), external = join(i.home, "external"), target = join(external, "office", A), sentinel = join(target, "unrelated-user-file");
	let armed = false, attempted = false, original = addons;
	const s = source(i, () => { if (armed && !attempted) { original = replaceAncestor(addons, external); attempted = true; } });
	try {
		expect((await install(i, s, `office:${A}`)).status).toBe(0);
		const marker = join(addons, "office", A, "node_modules/old"); writeFileSync(marker, "old generation");
		mkdirSync(target, { recursive: true }); writeFileSync(sentinel, "KEEP");
		rmSync(join(i.data, "cache/downloads"), { recursive: true }); armed = true;
		const r = await command(i, s, ["--use", V, "manager", "install", "--addon", `office:${A}`, "--force"]);
		expect(attempted).toBe(true); expect(existsSync(sentinel)).toBe(true); expect(readFileSync(sentinel, "utf8")).toBe("KEEP");
		expect(existsSync(join(target, "addon.json"))).toBe(false); expect(existsSync(join(target, "node_modules"))).toBe(false);
		expect(r.status).toBe(0); expect(existsSync(join(original, "office", A, "node_modules/old"))).toBe(false);
		expect(existsSync(join(original, "office", A, "addon.json"))).toBe(true); expect(started(i)).toBe(false);
		expect(tree(join(i.data, "tmp")).filter(p => p.startsWith(".install-") || p.startsWith(".previous-"))).toEqual([]);
	} finally { s.stop(); }
}, 30_000);
