import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createConfigPaths, installConfigPaths } from "../../runtime/compat/config-paths.ts";
import { currentTokenDiagnostics, observeProcess } from "./fixtures/windows-private-probe.ts";

// Source/cross-compilation cannot satisfy this suite. Dedicated runner supplies isolated HOME/TEMP.
const enabled = process.platform === "win32" && process.env.DSH_WINDOWS_PRIVATE_IO_NATIVE === "1";
const nativeTest = test.skipIf(!enabled);
const helper = join(import.meta.dir, "fixtures/windows-private-fixture.ps1");
const probe = join(import.meta.dir, "fixtures/windows-private-probe.ts");
function fixture(action: string, path: string) {
	const started = Date.now(), stem = join(process.env.TEMP!, `fixture-${action}-${started}`);
	const stdout = openSync(`${stem}.stdout`, "wx"), stderr = openSync(`${stem}.stderr`, "wx");
	writeFileSync(`${stem}.stages`, "", { flag: "wx" });
	// Write before spawn: even an outer runner kill leaves request identity and partial raw streams.
	writeFileSync(`${stem}.request.json`, JSON.stringify({ action, path, started, timeoutMs: 20_000 }));
	process.stderr.write(`NATIVE_FIXTURE_BEGIN ${action} ${path} artifact=${stem}\n`);
	try {
		execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", helper, action, path], {
			timeout: 20_000, stdio: ["ignore", stdout, stderr],
			env: { ...process.env, DSH_WINDOWS_PRIVATE_IO_TRACE: `${stem}.stages` },
		});
		writeFileSync(`${stem}.result.json`, JSON.stringify({ elapsedMs: Date.now() - started, status: 0 }));
		process.stderr.write(`NATIVE_FIXTURE_END ${action} ${Date.now() - started}ms artifact=${stem}\n`);
		return readFileSync(`${stem}.stdout`, "utf8");
	} catch (error) {
		const failure = error as { code?: string; status?: number; signal?: string };
		writeFileSync(`${stem}.result.json`, JSON.stringify({ elapsedMs: Date.now() - started, code: failure.code, status: failure.status, signal: failure.signal }));
		process.stderr.write(`NATIVE_FIXTURE_FAILED ${action} ${Date.now() - started}ms code=${failure.code} status=${failure.status} signal=${failure.signal} artifact=${stem}\n${readFileSync(`${stem}.stderr`, "utf8")}\n`);
		throw error;
	} finally { closeSync(stdout); closeSync(stderr); }
}
function inspect(path: string) { return JSON.parse(fixture("inspect", path)); }
function setup() {
	const dir = mkdtempSync(join(process.env.TEMP!, "private-case-")), config = join(dir, "C"), control = join(dir, "control");
	fixture("directory", config); mkdirSync(control);
	const file = join(config, "secret.yaml"); fixture("file", file);
	const paths = createConfigPaths(undefined, config);
	// Authenticate before fixture writes even synthetic secret bytes.
	writeFileSync(paths.check(file), "synthetic-private-config-only\n");
	return { dir, config, control, file, paths };
}
function boundary(f: () => unknown) {
	try { f(); throw new Error("unsafe object accepted"); } catch (error) {
		expect((error as { code?: string }).code).toBe("DSH_CONFIG_BOUNDARY");
		expect((error as Error).message).toBe("dsh: configuration path violates selected configuration boundary");
	}
}
function child(config: string, control: string) {
	const result = Bun.spawnSync([process.execPath, probe, "read", config, control], { env: process.env, timeout: 20_000 });
	return result;
}
function rejectedBeforeOpen(config: string, control: string) {
	const result = child(config, control);
	expect(result.exitCode, result.stderr.toString()).not.toBe(0);
	expect(readFileSync(join(control, "result"), "utf8")).toBe("DSH_CONFIG_BOUNDARY");
	expect(existsSync(join(control, "sensitive-open"))).toBe(false);
	expect(existsSync(join(control, "sensitive-watch"))).toBe(false);
	expect(existsSync(join(control, "ready"))).toBe(false);
	expect(result.stdout.toString() + result.stderr.toString()).not.toContain("synthetic-private-config-only");
}
async function until(path: string) {
	const end = Date.now() + 20_000;
	while (!existsSync(path)) { if (Date.now() > end) throw new Error(`native probe timeout: ${path}`); await Bun.sleep(20); }
}

nativeTest("native private ACL positive, protected nested creation, inherited file/lock/atomic temp before bytes", () => {
	const { config, control, file, paths } = setup();
	const rootAcl = inspect(config), fileAcl = inspect(file);
	expect(rootAcl.protected).toBe(true); expect(rootAcl.owner).toBe(rootAcl.user);
	expect(fileAcl.owner).toBe(rootAcl.user); expect(fileAcl.rules.some((r: any) => r.inherited)).toBe(true);
	for (const acl of [rootAcl, fileAcl]) for (const rule of acl.rules) { expect(rule.sid).toBe(rootAcl.user); expect(rule.type).toBe("Allow"); }
	expect(paths.check(file)).toBe(file); expect(paths.checkWatchPath(file)).toBe(file);
	const target = paths.credentialFile("accounts/work.yaml", undefined, () => { throw new Error("fallback"); });
	const nested = inspect(join(config, "accounts"));
	expect(nested.protected).toBe(true); expect(nested.owner).toBe(rootAcl.user);
	// Read-only same-Bun TokenUser/TokenOwner plus zero-byte wx owner under a separate private
	// diagnostic directory. No production bypass, token adjustment or secret write before guard.
	const token = currentTokenDiagnostics();
	writeFileSync(join(control, "creation-token.result.json"), JSON.stringify(token));
	const diagnosticDir = join(control, "owner-diagnostic"); fixture("directory", diagnosticDir);
	const diagnosticFile = join(diagnosticDir, "zero-byte-wx"); writeFileSync(diagnosticFile, "", { flag: "wx", mode: 0o666 });
	const defaultAcl = inspect(diagnosticFile);
	writeFileSync(join(control, "creation-wx-owner.result.json"), JSON.stringify({ token, acl: defaultAcl }));
	console.log(`NATIVE_CREATION_TOKEN_OWNER ${JSON.stringify({ token, actualWxOwner: defaultAcl.owner, rules: defaultAcl.rules })}`);
	// Actual wx-created sensitive siblings retain the exact production guard, despite Windows ignoring POSIX mode bits.
	for (const name of [target, `${target}.lock`, `${target}.lock.takeover-test`, `${target}.0123456789ab.tmp`]) {
		writeFileSync(paths.checkCreation(name), "", { flag: "wx", mode: 0o666 });
		const acl = inspect(name);
		expect(acl.owner).toBe(rootAcl.user); expect(acl.protected).toBe(false);
		expect(acl.rules.length).toBeGreaterThan(0);
		for (const rule of acl.rules) { expect(rule.sid).toBe(rootAcl.user); expect(rule.inherited).toBe(true); }
		writeFileSync(paths.checkAuxiliary(name), "synthetic-private-write\n");
	}
	expect(child(config, control).exitCode).toBe(0);
	expect(readFileSync(join(control, "result"), "utf8")).toBe("READY");
}, 120_000);

for (const action of ["owner", "everyone", "null-dacl"]) nativeTest(`native ${action} file rejected before sensitive open/watch/ready`, () => {
	const { config, control, file, paths } = setup(); fixture(action, file);
	boundary(() => paths.check(file)); boundary(() => paths.checkWatchPath(file)); rejectedBeforeOpen(config, control);
}, 60_000);

nativeTest("native inherited Everyone grant rejected, not an effective-access approximation", () => {
	const { config, control, file, paths } = setup();
	fixture("inherit-everyone", config);
	expect(inspect(file).rules.some((r: any) => r.sid === "S-1-1-0" && r.inherited)).toBe(true);
	boundary(() => paths.check(file)); rejectedBeforeOpen(config, control);
}, 60_000);

for (const action of ["unprotect", "no-inherit", "everyone", "null-dacl", "owner"]) nativeTest(`native ${action} selected root rejected, even empty config`, () => {
	const { dir, config, control, file, paths } = setup(); fixture(action, config);
	boundary(() => paths.check(file)); boundary(() => createConfigPaths(undefined, config)); rejectedBeforeOpen(config, control);
	const empty = join(dir, "empty"); fixture("directory", empty); fixture(action, empty);
	boundary(() => createConfigPaths(undefined, empty));
}, 60_000);

nativeTest("native junction ancestor/root, hardlink, ADS/device aliases rejected; no external sensitive open", () => {
	const { dir, config, control, file, paths } = setup(), outside = join(dir, "outside"); fixture("directory", outside);
	fixture("file", join(outside, "secret.yaml"));
	symlinkSync(outside, join(config, "escape"), "junction");
	boundary(() => paths.credentialFile("escape/secret.yaml", undefined, () => "fallback"));
	boundary(() => paths.credentialFile("escape/missing.yaml", undefined, () => "fallback"));
	boundary(() => paths.credentialFile(join(outside, "secret.yaml"), undefined, () => "fallback"));
	linkSync(file, join(config, "hard.yaml")); boundary(() => paths.check(file)); rejectedBeforeOpen(config, control);
	for (const name of ["secret.yaml:stream", "future/NUL.yaml", "future/COM1", "future/trailing."]) boundary(() => paths.credentialFile(name, undefined, () => "fallback"));
	const alias = join(dir, "alias"); symlinkSync(config, alias, "junction"); boundary(() => createConfigPaths(undefined, alias));
}, 60_000);

nativeTest("native current named root generation replaced by equally private root is rejected", () => {
	const { dir, config, file, paths } = setup(); renameSync(config, join(dir, "retired")); fixture("directory", config);
	fixture("file", file);
	boundary(() => paths.check(file)); boundary(() => paths.checkWatchPath(file));
}, 60_000);

nativeTest("native existing writer lock/takeover/temp receive same object authentication", () => {
	const { file, paths } = setup();
	for (const suffix of [".lock", ".lock.takeover-test", ".0123456789ab.tmp"]) {
		const path = file + suffix; fixture("file", path); fixture("everyone", path);
		boundary(() => paths.checkAuxiliary(path)); // helper seam for upstream's actual auxiliary read/create/rename call
		if (suffix === ".lock") boundary(() => paths.check(file)); // known writer sibling preflight, not complete inner-wrapper coverage
	}
}, 60_000);

nativeTest("native restart authenticates afresh; parent death cannot authenticate replacement child", async () => {
	const { config, control, file } = setup();
	expect(child(config, control).exitCode).toBe(0);
	const restartControl = join(control, "restart"); mkdirSync(restartControl);
	fixture("everyone", file); rejectedBeforeOpen(config, restartControl);
	for (const corrupt of [false, true]) {
		const second = setup();
		const parentStdout = openSync(join(second.control, "parent.stdout"), "wx"), parentStderr = openSync(join(second.control, "parent.stderr"), "wx");
		const parent = Bun.spawn([process.execPath, probe, "parent", second.config, second.control], { env: process.env, stdin: "ignore", stdout: parentStdout, stderr: parentStderr });
		closeSync(parentStdout); closeSync(parentStderr);
		let pid: number | undefined, observed: ReturnType<typeof observeProcess> | undefined;
		const samples: object[] = [];
		const capture = (stage: string) => {
			const sample = { stage, time: Date.now(), parentPid: parent.pid, parentExitCode: parent.exitCode, parentSignal: parent.signalCode,
				child: observed?.snapshot(), waiting: existsSync(join(second.control, "child-waiting")), released: existsSync(join(second.control, "release")), result: existsSync(join(second.control, "result")) };
			samples.push(sample); writeFileSync(join(second.control, "parent-death-lifecycle.result.json"), JSON.stringify(samples, null, 2));
			console.log(`NATIVE_PARENT_DEATH_SAMPLE ${JSON.stringify(sample)} artifact=${second.control}`);
		};
		try {
			await until(join(second.control, "parent-authenticated")); await until(join(second.control, "child-waiting"));
			pid = Number(readFileSync(join(second.control, "child-pid"), "utf8")); observed = observeProcess(pid);
			capture("before-parent-kill");
			parent.kill(); await parent.exited; capture("after-parent-exit");
			if (corrupt) fixture("everyone", second.file);
			writeFileSync(join(second.control, "release"), "1"); capture("release-written");
			try { await until(join(second.control, "result")); } finally { capture("after-result-wait"); }
			expect(readFileSync(join(second.control, "result"), "utf8")).toBe(corrupt ? "DSH_CONFIG_BOUNDARY" : "READY");
			for (const name of ["sensitive-open", "sensitive-watch", "ready"]) expect(existsSync(join(second.control, name))).toBe(!corrupt);
		} finally {
			observed?.close();
			if (pid) { try { process.kill(pid); } catch {} }
			if (parent.exitCode === null) { parent.kill(); await parent.exited; }
		}
	}
}, 120_000);

nativeTest("native standalone ignores raw snapshot env; boundary-only managed startup audit", () => {
	const { dir, config, paths } = setup();
	boundary(() => installConfigPaths(undefined, config)); // runtime stays closed until inner write seams + real native I/O gate
	process.env.DSH_BIN_CONFIG_SNAPSHOT_DIR = join(dir, "fake");
	try {
		const standalone = createConfigPaths();
		expect(standalone.credentialFile("outside", dir, () => "upstream")).toBe("upstream");
		expect(standalone.check(join(dir, "outside"))).toBe(join(dir, "outside"));
		const ordinary = [{ outcome: { kind: "failed", error: new Error("ordinary optional plugin failure") } }];
		expect(() => paths.assertStartup(ordinary)).not.toThrow();
		boundary(() => paths.assertStartup([{ outcome: { kind: "failed", error: { code: "DSH_CONFIG_BOUNDARY" } } }]));
		expect(() => standalone.assertStartup([{ outcome: { kind: "failed", error: { code: "DSH_CONFIG_BOUNDARY" } } }])).not.toThrow();
	} finally { delete process.env.DSH_BIN_CONFIG_SNAPSHOT_DIR; }
}, 60_000);
