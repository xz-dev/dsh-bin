// Manager self-update: real Zig candidates, isolated HOME, no JS in child PATH.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { writeZip, type ZipInput } from "../../dsh-bun-build/runtime/zip.ts";
import { hostTargetId } from "../../dsh-bun-build/scripts/targets.mjs";
import { addRuntime, baseEnv, build, bundleMeta, cleanup, EXE, hasZig, MANAGER_VERSION, newInstall, run, started, tempDir, tree, WIN, type Install } from "./harness.ts";

const NEXT = "9.8.8", A = "1.0.0-b1.1.gdeadbeef", OLD = "0.1.0-b1.1.gcafebabe";
const TARGET = `${process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "x64" ? "x64" : "arm64"}`;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
let next: string, numeric: string, prerelease: string;
beforeAll(() => { if (hasZig) { build(); next = build(NEXT).manager; numeric = build("9.10.0").manager; prerelease = build("9.8.8-rc.10").manager; } }, 300_000);
afterAll(cleanup);
function archive(binary = next, extra: ZipInput[] = []) {
	const zip = join(tempDir("dsh-manager-zip-"), "manager.zip");
	writeZip(zip, [{ name: `dsh${EXE}`, data: readFileSync(binary), mode: 0o755 }, ...extra]);
	return readFileSync(zip);
}
function entry(version: string, bytes: Uint8Array, patch: Record<string, unknown> = {}) {
	return { version, tag: `manager-v${version}`, launchProtocols: [1], assets: { [TARGET]: { name: `manager-${TARGET}.zip`, size: bytes.length, sha256: sha(bytes) } }, ...patch };
}
function source(versions: ReturnType<typeof entry>[], bytes: Uint8Array, runtime?: { entry: unknown; bytes: Uint8Array }) {
	const requests: string[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
		const path = new URL(req.url).pathname; requests.push(path);
		if (path === "/manager-index.json") return Response.json({ schema: 1, versions });
		if (path === "/runtime-index.json") return Response.json({ schema: 1, channels: { release: runtime ? [runtime.entry] : [], live: [] }, addons: { office: [] } });
		if (path.startsWith("/download/runtime-")) return new Response(runtime?.bytes);
		if (path.startsWith("/download/manager-")) return new Response(bytes);
		return new Response(null, { status: 404 });
	} });
	return { requests, origin: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
async function command(i: Install, s: ReturnType<typeof source>, args = ["manager", "self-update"], env: Record<string, string> = {}) {
	const p = Bun.spawn([i.exe, ...args], { cwd: i.home, env: { ...baseEnv(i), DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_ORIGIN: s.origin, DSH_MANAGER_TEST_RETRY_MS: "10", ...env }, stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => p.kill(), 30_000);
	try { const [stdout, stderr, status] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]); return { stdout, stderr, status }; }
	finally { clearTimeout(timer); }
}
async function paused(i: Install, args: string[], stage: string, action: (name: string) => void, env: Record<string, string> = {}, kill = false) {
	const p = spawn(i.exe, args, { cwd: i.home, env: { ...baseEnv(i), DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_PAUSE: stage, ...env }, stdio: "pipe" });
	let stdout = "", stderr = ""; p.stdout.on("data", b => { stdout += b.toString(); }); p.stderr.on("data", b => { stderr += b.toString(); });
	const done = new Promise<number | null>((resolve, reject) => { p.on("close", resolve); p.on("error", reject); });
	const timer = setTimeout(() => p.kill("SIGKILL"), 20_000);
	try {
		const deadline = Date.now() + 10_000;
		while (!stderr.includes(`test pause: ${stage} `) && p.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
		expect(stderr).toContain(`test pause: ${stage} `);
		const name = stderr.split(`test pause: ${stage} `)[1].split("\n")[0]; action(name); if (kill) p.kill("SIGKILL"); else p.stdin.end("continue");
		const status = await done; return { stdout, stderr, status };
	} finally { clearTimeout(timer); if (p.exitCode === null) { p.kill("SIGKILL"); await done; } }
}
const protectedDirs = ["bundles", "snapshots", "addons", "home"];
function protectedBytes(i: Install) {
	const result: Record<string, string> = {};
	for (const folder of protectedDirs) for (const path of tree(join(i.data, folder))) {
		const file = join(i.data, folder, path); try { result[`${folder}/${path}`] = sha(readFileSync(file)); } catch { result[`${folder}/${path}`] = "directory"; }
	}
	for (const path of ["state/selection.json", "state/channel", "state/config.json", ".dsh-bin-data.json"]) if (existsSync(join(i.data, path))) result[path] = sha(readFileSync(join(i.data, path)));
	return result;
}
function fixture() {
	const i = newInstall(); addRuntime(i.data, A);
	expect(run(i, ["manager", "snapshot", "new", "--use", A, "--empty"]).status).toBe(0);
	expect(run(i, ["manager", "select", "--use", A, "--snapshot", `${A}@1`]).status).toBe(0);
	for (const path of ["home/profiles/main/cordis.patch.yml", "home/credential", "addons/office/keep", "snapshots/" + A + "@1/profiles/plugin", "state/config.json"]) { mkdirSync(join(i.data, path, ".."), { recursive: true }); writeFileSync(join(i.data, path), "KEEP"); }
	return i;
}

test.skipIf(!hasZig)("MC-SELF-ONLY: same-protocol newer manager changes only its entry on POSIX; Windows prepares for 7.3", async () => {
	const i = fixture(), bytes = archive(), s = source([entry(NEXT, bytes)], bytes), before = protectedBytes(i), exe = sha(readFileSync(i.exe)), allBefore = tree(i.data);
	try {
		const r = await command(i, s); expect(r.stderr).toBe(""); expect(r.status).toBe(0); expect(r.stdout).toContain(WIN ? "prepared, not installed" : `updated manager ${MANAGER_VERSION} -> ${NEXT}`);
		const candidate = join(i.dir, `.dsh-manager-candidate-${NEXT}`); if (WIN) expect(sha(readFileSync(candidate))).toBe(sha(readFileSync(next))); else expect(existsSync(candidate)).toBe(false);
		expect(protectedBytes(i)).toEqual(before); expect(sha(readFileSync(i.exe))).toBe(WIN ? exe : sha(readFileSync(next))); expect(started(i)).toBe(false);
		expect(s.requests).toEqual(["/manager-index.json", `/download/manager-v${NEXT}/manager-${TARGET}.zip`]);
		const added = tree(i.data).filter(p => !allBefore.includes(p));
		expect(added.filter(p => !["cache", "cache/downloads", `cache/downloads/${sha(bytes)}.zip`, "tmp", "state/manager.lock"].includes(p))).toEqual([]);
		expect(run(i, ["manager", "--version"]).stdout).toContain(WIN ? MANAGER_VERSION : NEXT); expect(tree(i.home)).toEqual([]);
		cpSync(build().manager, join(i.dir, `.dsh-manager-candidate-${MANAGER_VERSION}`));
		expect((await command(i, s, ["manager", "self-update", "--force"])).status).toBe(0); expect(readdirSync(i.dir).filter(n => n.startsWith(".dsh-manager-candidate-"))).toEqual(WIN ? [`.dsh-manager-candidate-${NEXT}`] : []);
	} finally { s.stop(); }
}, 60_000);

test.skipIf(!hasZig)("MC-SELF-ONLY: SemVer 1.10 > 1.9, prerelease ordering and same-version force repair ignore build metadata", async () => {
	const bytes = archive();
	const repairFile = join(tempDir("manager-repair-"), `dsh${EXE}`); writeFileSync(repairFile, Buffer.concat([readFileSync(build().manager), Buffer.from("same-version-rebuild")]));
	const repaired = archive(repairFile);
	for (const [versions, force, status, text, asset] of [
		[["9.9.0", "9.10.0"], false, 0, WIN ? "9.10.0 prepared" : "-> 9.10.0", true],
		[["9.8.8-rc.2", "9.8.8-rc.10"], false, 0, WIN ? "9.8.8-rc.10 prepared" : "-> 9.8.8-rc.10", true],
		[[MANAGER_VERSION], false, 0, "already current", false],
		[[MANAGER_VERSION], true, 0, WIN ? "prepared" : "updated manager", true],
		[["9.8.7-test.0"], true, 1, "Downgrade", false],
		[["9.8.7-test.1+repair"], false, 0, "already current", false],
	] as const) {
		const i = newInstall(), version = versions[0], payload = version === MANAGER_VERSION ? (force ? repaired : archive(build().manager)) : version === "9.9.0" ? archive(numeric) : version === "9.8.8-rc.2" ? archive(prerelease) : bytes;
		const s = source(versions.map(v => entry(v, payload)), payload);
		try { const r = await command(i, s, ["manager", "self-update", ...(force ? ["--force"] : [])]); expect(r.status).toBe(status); expect(r.stdout + r.stderr).toContain(text); expect(s.requests.some(p => p.startsWith("/download/"))).toBe(asset); if (version === MANAGER_VERSION && force) { expect(sha(readFileSync(WIN ? join(i.dir, `.dsh-manager-candidate-${version}`) : i.exe))).toBe(sha(readFileSync(repairFile))); expect(sha(readFileSync(repairFile))).not.toBe(sha(readFileSync(build().manager))); } }
		finally { s.stop(); }
	}
}, 60_000);

test.skipIf(!hasZig)("MC-SELF-FAIL: incompatible protocol/target, downgrade, duplicate or invalid identity refuse before archive", async () => {
	const bytes = archive(), good = entry(NEXT, bytes);
	for (const versions of [[{ ...good, launchProtocols: [2] }], [{ ...good, assets: { wrong: good.assets[TARGET] } }], [entry("1.0.0", bytes)], [good, good], [entry("09.0.0", bytes)], [{ ...good, tag: "../manager-v9.8.8" }]]) {
		const i = newInstall(), before = sha(readFileSync(i.exe)), s = source(versions, bytes);
		try { const r = await command(i, s); expect(r.status).toBe(1); expect(s.requests).toEqual(["/manager-index.json"]); expect(sha(readFileSync(i.exe))).toBe(before); expect(readdirSync(i.dir).some(n => n.startsWith(".dsh-manager-candidate-"))).toBe(false); }
		finally { s.stop(); }
	}
}, 60_000);

test.skipIf(!hasZig)("MC-SELF-FAIL: bad digest/size, wrong binary marker/type, extra roots and traversal never publish a candidate", async () => {
	const valid = archive();
	const wrong = Buffer.from(readFileSync(next)); wrong.fill(0, 0, 4);
	const file = join(tempDir("bad-manager-"), "bad.zip"); writeZip(file, [{ name: `dsh${EXE}`, data: wrong, mode: 0o755 }]);
	const traversed = Buffer.from(archive(next, [{ name: "safe_file_", data: Buffer.from("bad") }]));
	for (let at = traversed.indexOf("safe_file_"); at !== -1; at = traversed.indexOf("safe_file_", at + 10)) traversed.write("../outside", at);
	const wrongProtocolFile = join(tempDir("wrong-protocol-"), `dsh${EXE}`), wrongProtocol = Buffer.from(readFileSync(next)), protocolAt = wrongProtocol.indexOf("DSH_MANAGER_LAUNCH_PROTOCOL=1\0");
	expect(protocolAt).toBeGreaterThanOrEqual(0); wrongProtocol[protocolAt + "DSH_MANAGER_LAUNCH_PROTOCOL=".length] = "2".charCodeAt(0); writeFileSync(wrongProtocolFile, wrongProtocol);
	for (const [bytes, patch] of [[valid, { sha256: "a".repeat(64) }], [valid, { size: valid.length + 1 }], [archive(build().manager), {}], [readFileSync(file), {}], [archive(wrongProtocolFile), {}], [archive(next, [{ name: "user-file", data: Buffer.from("bad") }]), {}], [traversed, {}]] as const) {
		const i = fixture(), before = protectedBytes(i), e = entry(NEXT, bytes); Object.assign(e.assets[TARGET], patch); const s = source([e], bytes);
		try { const r = await command(i, s); expect(r.status).toBe(1); expect(protectedBytes(i)).toEqual(before); expect(readdirSync(i.dir).some(n => n.startsWith(".dsh-manager-candidate-"))).toBe(false); expect(started(i)).toBe(false); }
		finally { s.stop(); }
	}
}, 60_000);

test.skipIf(!hasZig)("DL-MANAGED-SELF: portage/scoop refuse before any request, state creation or candidate staging", async () => {
	const bytes = archive(), s = source([entry(NEXT, bytes)], bytes);
	try { for (const owner of ["portage", "scoop"]) { const i = newInstall(); writeFileSync(join(i.dir, ".dsh-manager-install.json"), JSON.stringify({ schema: 1, owner })); const r = await command(i, s, undefined, { LOCALAPPDATA: join(i.home, "local") }); expect(r.status).toBe(1); expect(r.stderr).toContain(owner === "portage" ? "emerge" : "scoop update"); expect(tree(i.home)).toEqual([]); expect(s.requests).toEqual([]); } }
	finally { s.stop(); }
}, 60_000);

test.skipIf(!hasZig)("MC-OLD-RUNTIME: older upstream install/select never downgrades updated manager or Windows candidate", async () => {
	const i = fixture(), meta = bundleMeta(OLD, { commitTime: "2020-01-01T00:00:00.000Z", patch: { target: hostTargetId() } }), file = join(tempDir("old-runtime-"), "runtime.zip");
	writeZip(file, [{ name: "bundle.json", data: Buffer.from(JSON.stringify(meta)) }, { name: `dsh-native${EXE}`, data: readFileSync(build().fake), mode: 0o755 }]);
	const runtimeBytes = readFileSync(file), e = { ...meta, tag: `runtime-v${OLD}`, seq: 1, assets: { [hostTargetId()]: { name: "runtime.zip", size: runtimeBytes.length, sha256: sha(runtimeBytes) } } };
	const bytes = archive(), s = source([entry(NEXT, bytes)], bytes, { entry: e, bytes: runtimeBytes }), exe = sha(readFileSync(i.exe));
	try { expect((await command(i, s)).status).toBe(0); const staged = WIN ? join(i.dir, `.dsh-manager-candidate-${NEXT}`) : i.exe, before = sha(readFileSync(staged)); expect((await command(i, s, ["manager", "install", OLD])).status).toBe(0); expect(run(i, ["manager", "select", "--use", OLD]).status).toBe(0); expect(run(i, ["manager", "--version"]).stdout).toContain(WIN ? MANAGER_VERSION : NEXT); expect(sha(readFileSync(i.exe))).toBe(WIN ? exe : sha(readFileSync(next))); expect(sha(readFileSync(staged))).toBe(before); expect(run(i, []).status).toBe(0); }
	finally { s.stop(); }
}, 60_000);

test.skipIf(!hasZig)("MC-SELF-FAIL: a conflicting candidate path refuses before download without changing user bytes", async () => {
	const bytes = archive(), s = source([entry(NEXT, bytes)], bytes);
	try {
		for (const linked of [false, true]) {
			const i = fixture(), name = `.dsh-manager-candidate-${NEXT}`, path = join(i.dir, name), external = join(i.home, "external");
			if (linked) { mkdirSync(external); writeFileSync(join(external, "keep"), "KEEP"); symlinkSync(external, path, WIN ? "junction" : "dir"); }
			else writeFileSync(path, "USER FILE");
			const before = protectedBytes(i), requests = s.requests.length, r = await command(i, s);
			expect(r.status).toBe(1); expect(r.stderr).toContain("application data unchanged"); expect(protectedBytes(i)).toEqual(before);
			expect(s.requests.slice(requests)).toEqual(["/manager-index.json"]);
			if (linked) expect(readFileSync(join(external, "keep"), "utf8")).toBe("KEEP"); else expect(readFileSync(path, "utf8")).toBe("USER FILE");
			expect(readdirSync(i.dir).filter(n => n.startsWith(name))).toEqual([name]);
		}
	} finally { s.stop(); }
}, 60_000);

test.skipIf(!hasZig)("MC-CLEAN: portable manager candidates reclaim only exact marked regular files, never links or unknown bytes", () => {
	const i = fixture(), real = join(i.dir, `.dsh-manager-candidate-${NEXT}`), unknown = join(i.dir, ".dsh-manager-candidate-8.0.0"), alias = join(i.dir, ".dsh-manager-candidate-7.0.0");
	cpSync(next, real); writeFileSync(unknown, "USER FILE");
	const external = join(i.home, "external"); mkdirSync(external); writeFileSync(join(external, "keep"), "KEEP");
	if (!WIN) symlinkSync(real, alias); else symlinkSync(external, alias, "junction");
	const partial = join(i.dir, `.dsh-manager-candidate-${NEXT}.part-ab12`), prereleasePart = join(i.dir, ".dsh-manager-candidate-9.8.8-rc.10.part-cd34"), malformedPart = join(i.dir, `.dsh-manager-candidate-${NEXT}.part-nothex`), partialAlias = join(i.dir, `.dsh-manager-candidate-${NEXT}.part-ef56`);
	writeFileSync(partial, "interrupted"); writeFileSync(prereleasePart, "interrupted prerelease"); writeFileSync(malformedPart, "USER PART FILE"); symlinkSync(external, partialAlias, WIN ? "junction" : "dir");
	expect(run(i, ["manager", "clean"]).status).toBe(0); expect(existsSync(partial)).toBe(false); expect(existsSync(prereleasePart)).toBe(false); expect(readFileSync(malformedPart, "utf8")).toBe("USER PART FILE"); expect(existsSync(partialAlias)).toBe(true); expect(existsSync(real)).toBe(false); expect(readFileSync(unknown, "utf8")).toBe("USER FILE"); expect(readdirSync(i.dir)).toContain(alias.split(/[\\/]/).at(-1)!); expect(readFileSync(join(external, "keep"), "utf8")).toBe("KEEP");
}, 60_000);

test.skipIf(!hasZig)("MC-CLEAN review: a candidate swapped for a user directory never deletes credentials", async () => {
	const i = fixture(), name = `.dsh-manager-candidate-${NEXT}`, path = join(i.dir, name);
	cpSync(next, path);
	const r = await paused(i, ["manager", "clean"], "candidate-clean-delete", () => {
		renameSync(path, join(i.home, "saved")); mkdirSync(path); writeFileSync(join(path, "credential"), "USER CREDENTIAL");
	});
	expect(r.status).toBe(0); expect(readFileSync(join(path, "credential"), "utf8")).toBe("USER CREDENTIAL");
	expect(r.stderr).toContain("kept manager candidate"); expect(r.stdout).not.toContain(`Removed manager-directory/${name}`);
}, 30_000);

test.skipIf(!hasZig)("MC-SELF-FAIL review: concurrent candidate names and swapped partial bytes never get a false prepared result", async () => {
	const bytes = archive(), s = source([entry(NEXT, bytes)], bytes);
	try {
		for (const mode of ["destination", "partial", "old", "clean"]) {
			const i = fixture(), name = `.dsh-manager-candidate-${NEXT}`, dest = join(i.dir, name), old = join(i.dir, `.dsh-manager-candidate-${MANAGER_VERSION}`);
			if (mode === "old" || mode === "clean") cpSync(build().manager, old);
			const stage = mode === "old" ? "candidate-old-delete" : mode === "clean" ? "candidate-clean-delete" : "candidate-publish";
			const r = await paused(i, mode === "clean" ? ["manager", "clean"] : ["manager", "self-update"], stage, pausedName => {
				const path = mode === "destination" ? dest : mode === "partial" ? join(i.dir, pausedName) : old;
				if (existsSync(path)) renameSync(path, join(i.home, "saved")); writeFileSync(path, "USER CREDENTIAL");
			}, { DSH_MANAGER_TEST_ORIGIN: s.origin });
			if (mode === "destination" || mode === "partial") {
				expect(r.status).toBe(1); expect(r.stdout).not.toContain("prepared, not installed"); expect(readFileSync(dest, "utf8")).toBe("USER CREDENTIAL");
			} else { expect(r.status).toBe(0); expect(readFileSync(old, "utf8")).toBe("USER CREDENTIAL"); expect(r.stderr).toContain("identity changed"); }
		}
	} finally { s.stop(); }
}, 60_000);

test.skipIf(!hasZig)("MC-SELF-FAIL review: duplicate or conflicting identity markers refuse preparation and remain untouched by clean", async () => {
	for (const marker of [`DSH_MANAGER_VERSION=${NEXT}\0`, "DSH_MANAGER_VERSION=1.0.0\0", "DSH_MANAGER_LAUNCH_PROTOCOL=1\0", "DSH_MANAGER_LAUNCH_PROTOCOL=2\0"]) {
		const file = join(tempDir("contradictory-manager-"), `dsh${EXE}`); writeFileSync(file, Buffer.concat([readFileSync(next), Buffer.from(marker)]), { mode: 0o755 });
		const bytes = archive(file), s = source([entry(NEXT, bytes)], bytes), i = fixture(), path = join(i.dir, `.dsh-manager-candidate-${NEXT}`);
		try {
			const r = await command(i, s); expect(r.status).toBe(1); expect(r.stdout).not.toContain("prepared, not installed"); expect(existsSync(path)).toBe(false);
			cpSync(file, path); const before = sha(readFileSync(path)); expect(run(i, ["manager", "clean"]).status).toBe(0); expect(sha(readFileSync(path))).toBe(before);
		} finally { s.stop(); }
	}
}, 60_000);

// 7.2 is POSIX atomic replacement; Windows retains preparation until helper slice 7.3.
test.skipIf(!hasZig || WIN)("MC-SELF-ONLY / MC-SELF-FAIL POSIX: replacement preserves mode and owner, uses resolved entry not its symlink", async () => {
	const i = fixture(), bytes = archive(), s = source([entry(NEXT, bytes)], bytes), before = protectedBytes(i);
	const link = join(i.home, "dsh-link"); symlinkSync(i.exe, link); chmodSync(i.exe, 0o751);
	const old = statSync(i.exe);
	try {
		const r = await command({ ...i, exe: link }, s); expect(r.status).toBe(0); expect(r.stderr).toBe("");
		expect(r.stdout).toContain(`updated manager ${MANAGER_VERSION} -> ${NEXT}`);
		expect(lstatSync(link).isSymbolicLink()).toBe(true); expect(sha(readFileSync(i.exe))).toBe(sha(readFileSync(next)));
		expect(statSync(i.exe).mode & 0o7777).toBe(old.mode & 0o7777); expect(statSync(i.exe).uid).toBe(old.uid); expect(statSync(i.exe).gid).toBe(old.gid);
		expect(run(i, ["manager", "--version"], { exe: link }).stdout).toContain(NEXT); expect(protectedBytes(i)).toEqual(before);
		expect(started(i)).toBe(false);
	} finally { s.stop(); }
}, 60_000);

test.skipIf(!hasZig || WIN)("MC-SELF-FAIL POSIX: SIGKILL at download, validation and replacement boundaries leaves old or complete new entry", async () => {
	const bytes = archive(), s = source([entry(NEXT, bytes)], bytes);
	try {
		for (const stage of ["self-update-download", "self-update-verify", "self-update-before-replace", "self-update-after-replace"]) {
			const i = fixture(), before = protectedBytes(i), old = sha(readFileSync(i.exe));
			const r = await paused(i, ["manager", "self-update"], stage, () => {}, { DSH_MANAGER_TEST_ORIGIN: s.origin }, true);
			expect(r.stdout).not.toContain("updated manager");
			const updated = stage === "self-update-after-replace";
			expect(sha(readFileSync(i.exe))).toBe(updated ? sha(readFileSync(next)) : old);
			expect(run(i, ["manager", "--version"]).stdout).toContain(updated ? NEXT : MANAGER_VERSION);
			expect(protectedBytes(i)).toEqual(before); expect(started(i)).toBe(false);
			// Normal retry is sufficient; clean reclaims candidate/partial leftovers, not application state.
			expect((await command(i, s)).status).toBe(0); expect(run(i, ["manager", "--version"]).stdout).toContain(NEXT);
			expect(run(i, ["manager", "clean"]).status).toBe(0); expect(protectedBytes(i)).toEqual(before);
		}
	} finally { s.stop(); }
}, 60_000);

test.skipIf(!hasZig || WIN)("MC-SELF-FAIL POSIX: candidate tampered after preparation never replaces installed entry", async () => {
	const bytes = archive(), s = source([entry(NEXT, bytes)], bytes);
	try {
		for (const change of ["bytes", "version", "protocol", "header", "link"]) {
			const i = fixture(), before = protectedBytes(i), old = sha(readFileSync(i.exe));
			const r = await paused(i, ["manager", "self-update"], "self-update-before-replace", name => {
				const path = join(i.dir, name), data = Buffer.from(readFileSync(path));
				if (change === "link") { renameSync(path, join(i.home, "saved")); symlinkSync(i.exe, path); return; }
				if (change === "bytes") { writeFileSync(path, Buffer.concat([data, Buffer.from("unverified addition")])); return; }
				if (change === "header") data[0] = 0;
				else { const key = change === "version" ? "DSH_MANAGER_VERSION=" : "DSH_MANAGER_LAUNCH_PROTOCOL="; data[data.indexOf(key) + key.length] = "2".charCodeAt(0); }
				writeFileSync(path, data);
			}, { DSH_MANAGER_TEST_ORIGIN: s.origin });
			expect(r.status).toBe(1); expect(r.stdout).not.toContain("updated manager"); expect(r.stderr).toContain("self-update failed");
			expect(sha(readFileSync(i.exe))).toBe(old); expect(protectedBytes(i)).toEqual(before);
			expect(run(i, ["manager", "--version"]).stdout).toContain(MANAGER_VERSION);
		}
	} finally { s.stop(); }
}, 60_000);

test.skipIf(!hasZig || WIN)("MC-SELF-FAIL POSIX: read-only manager directory refuses replacement without fallback", async () => {
	const i = fixture(), bytes = archive(), s = source([entry(NEXT, bytes)], bytes), before = protectedBytes(i), old = sha(readFileSync(i.exe));
	chmodSync(i.dir, 0o555);
	try {
		const r = await command(i, s); expect(r.status).toBe(1); expect(r.stderr).toContain("AccessDenied");
		expect(r.stdout).not.toContain("updated manager"); expect(sha(readFileSync(i.exe))).toBe(old);
		expect(protectedBytes(i)).toEqual(before); expect(tree(i.home)).toEqual([]); expect(readdirSync(i.dir).filter(n => n.startsWith(".dsh-manager-candidate-"))).toEqual([]);
	} finally { chmodSync(i.dir, 0o755); s.stop(); }
}, 60_000);

test.skipIf(!hasZig || WIN)("MC-SELF-FAIL POSIX: killed partial download retries without exposing a partial manager entry", async () => {
	const i = fixture(), bytes = archive(), before = protectedBytes(i), old = sha(readFileSync(i.exe));
	let release: (() => void) | undefined;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
		if (new URL(req.url).pathname === "/manager-index.json") return Response.json({ schema: 1, versions: [entry(NEXT, bytes)] });
		return new Response(new ReadableStream<Uint8Array>({ start(c) {
			c.enqueue(bytes.subarray(0, Math.floor(bytes.length / 2)));
			release = () => { try { c.enqueue(bytes.subarray(Math.floor(bytes.length / 2))); c.close(); } catch {} };
		} }), { headers: { "Content-Length": String(bytes.length) } });
	} });
	const p = spawn(i.exe, ["manager", "self-update"], { cwd: i.home, env: { ...baseEnv(i), DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_ORIGIN: `http://127.0.0.1:${server.port}` }, stdio: "pipe" });
	p.stdout.resume(); p.stderr.resume(); const done = new Promise(resolve => p.on("close", resolve));
	const timer = setTimeout(() => p.kill("SIGKILL"), 20_000), partial = join(i.data, "cache/downloads", `${sha(bytes)}.zip.part`);
	try {
		const deadline = Date.now() + 10_000;
		while ((!existsSync(partial) || statSync(partial).size === 0) && p.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
		expect(existsSync(partial)).toBe(true); expect(statSync(partial).size).toBeGreaterThan(0); expect(statSync(partial).size).toBeLessThan(bytes.length);
		p.kill("SIGKILL"); await done;
		expect(sha(readFileSync(i.exe))).toBe(old); expect(run(i, ["manager", "--version"]).stdout).toContain(MANAGER_VERSION); expect(protectedBytes(i)).toEqual(before);
	} finally { clearTimeout(timer); if (p.exitCode === null && p.signalCode === null) { p.kill("SIGKILL"); await done; } release?.(); server.stop(true); }
	const retry = source([entry(NEXT, bytes)], bytes);
	try { expect((await command(i, retry)).status).toBe(0); expect(run(i, ["manager", "--version"]).stdout).toContain(NEXT); expect(protectedBytes(i)).toEqual(before); }
	finally { retry.stop(); }
}, 60_000);

test.skipIf(!hasZig || WIN)("MC-SELF-FAIL POSIX: changed installed entry is kept rather than overwriting user bytes", async () => {
	const i = fixture(), bytes = archive(), s = source([entry(NEXT, bytes)], bytes), before = protectedBytes(i);
	try {
		const r = await paused(i, ["manager", "self-update"], "self-update-before-replace", () => { renameSync(i.exe, join(i.dir, "saved-manager")); writeFileSync(i.exe, "USER CREDENTIAL"); }, { DSH_MANAGER_TEST_ORIGIN: s.origin });
		expect(r.status).toBe(1); expect(r.stderr).toContain("ManagerFileChanged"); expect(r.stdout).not.toContain("updated manager");
		expect(readFileSync(i.exe, "utf8")).toBe("USER CREDENTIAL"); expect(protectedBytes(i)).toEqual(before);
		expect(run(i, ["manager", "--version"], { exe: join(i.dir, "saved-manager") }).stdout).toContain(MANAGER_VERSION);
	} finally { s.stop(); }
}, 60_000);

test.skipIf(!hasZig)("MC-SELF-FAIL review: extracted source must still match bytes from the verified archive", async () => {
	const i = fixture(), bytes = archive(), s = source([entry(NEXT, bytes)], bytes), old = sha(readFileSync(i.exe)), before = protectedBytes(i);
	try {
		const r = await paused(i, ["manager", "self-update"], "self-update-verify", () => {
			const stage = readdirSync(join(i.data, "tmp")).find(n => n.startsWith(".install-"))!;
			const path = join(i.data, "tmp", stage, `dsh${EXE}`), changed = Buffer.from(readFileSync(path));
			if (process.platform === "linux") changed.fill(0, 24, 32); // Keep headers/markers, break ELF entry point.
			else changed[changed.length - 1] ^= 1;
			writeFileSync(path, changed);
		}, { DSH_MANAGER_TEST_ORIGIN: s.origin });
		expect(r.status).toBe(1); expect(r.stdout).not.toContain("updated manager"); expect(r.stdout).not.toContain("prepared, not installed");
		expect(sha(readFileSync(i.exe))).toBe(old); expect(run(i, ["manager", "--version"]).stdout).toContain(MANAGER_VERSION);
		expect(protectedBytes(i)).toEqual(before);
	} finally { s.stop(); }
}, 60_000);

test.skipIf(!hasZig || WIN)("MC-SELF-FAIL review: index-time ancestor swap never selects another manager installation", async () => {
	const i = fixture(), bytes = archive(), root = dirname(i.dir), moved = `${root}-saved`, external = tempDir("manager-other-install-");
	const externalExe = join(external, "tools", `dsh${EXE}`); mkdirSync(dirname(externalExe)); cpSync(build().manager, externalExe);
	writeFileSync(join(external, "credential"), "KEEP");
	const old = sha(readFileSync(i.exe)), other = sha(readFileSync(externalExe));
	let readyResolve!: () => void, release!: () => void;
	const ready = new Promise<void>(r => readyResolve = r), wait = new Promise<void>(r => release = r);
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
		if (new URL(req.url).pathname === "/manager-index.json") { readyResolve(); await wait; return Response.json({ schema: 1, versions: [entry(NEXT, bytes)] }); }
		return new Response(bytes);
	} });
	const p = Bun.spawn([i.exe, "manager", "self-update"], { cwd: i.home, env: { ...baseEnv(i), DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_ORIGIN: `http://127.0.0.1:${server.port}` }, stdout: "pipe", stderr: "pipe" });
	const stdout = new Response(p.stdout).text(), stderr = new Response(p.stderr).text(), timer = setTimeout(() => p.kill(), 20_000);
	try {
		await ready; renameSync(root, moved); symlinkSync(external, root, "dir"); release();
		expect(await p.exited).toBe(1); expect(await stdout).not.toContain("updated manager"); expect(await stderr).toContain("self-update failed");
		expect(sha(readFileSync(externalExe))).toBe(other); expect(sha(readFileSync(join(moved, "tools", `dsh${EXE}`)))).toBe(old);
		expect(readFileSync(join(external, "credential"), "utf8")).toBe("KEEP");
	} finally {
		clearTimeout(timer); release(); p.kill(); await p.exited; server.stop(true);
		if (existsSync(moved)) { unlinkSync(root); renameSync(moved, root); }
	}
}, 60_000);

test.skipIf(!hasZig || WIN)("MC-SELF-FAIL review: candidate hardlinks refuse before changing external owner or mode", async () => {
	const i = fixture(), bytes = archive(), s = source([entry(NEXT, bytes)], bytes), old = sha(readFileSync(i.exe)), external = join(i.home, "other-manager");
	writeFileSync(external, readFileSync(next), { mode: 0o700 }); chmodSync(i.exe, 0o751); const before = statSync(external);
	try {
		const r = await paused(i, ["manager", "self-update"], "self-update-before-replace", name => {
			const path = join(i.dir, name); renameSync(path, join(i.home, "saved-candidate")); linkSync(external, path);
		}, { DSH_MANAGER_TEST_ORIGIN: s.origin });
		expect(r.status).toBe(1); expect(r.stdout).not.toContain("updated manager"); expect(r.stderr).toContain("self-update failed");
		const after = statSync(external); expect(after.mode & 0o7777).toBe(before.mode & 0o7777); expect(after.uid).toBe(before.uid); expect(after.gid).toBe(before.gid);
		expect(sha(readFileSync(i.exe))).toBe(old); expect(run(i, ["manager", "--version"]).stdout).toContain(MANAGER_VERSION);
	} finally { s.stop(); }
}, 60_000);
