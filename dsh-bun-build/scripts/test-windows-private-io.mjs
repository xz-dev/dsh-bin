// Native-only gate. Run with Bun 1.4.2 on Windows x64/arm64, not wine/cross-build/mock.
// bun dsh-bun-build/scripts/test-windows-private-io.mjs
import { execFileSync } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.platform !== "win32") throw new Error("native Windows configuration I/O gate requires Windows; NOT RUN");
if (Bun.version !== "1.4.2") throw new Error("native Windows configuration I/O gate requires pinned Bun 1.4.2");
const mode = process.argv.slice(2);
if (mode.length && (mode.length !== 1 || mode[0] !== "--constructor-compare")) throw new Error("usage: test-windows-private-io.mjs [--constructor-compare]");
// CI artifact collection is rooted at RUNNER_TEMP, not the account's unrelated LocalAppData Temp.
const root = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "dsh-windows-private-io-"));
const home = join(root, "home"), tmp = join(root, "tmp"), cache = join(root, "cache");
for (const p of [home, tmp, cache, join(home, "AppData/Roaming"), join(home, "AppData/Local"), join(cache, "PowerShell")]) mkdirSync(p, { recursive: true });
const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
	COMSPEC: process.env.COMSPEC, PATHEXT: process.env.PATHEXT,
	HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
	TMPDIR: tmp, TMP: tmp, TEMP: tmp, XDG_CACHE_HOME: cache, BUN_INSTALL_CACHE_DIR: cache,
	PSModuleAnalysisCachePath: join(cache, "PowerShell", "ModuleAnalysisCache"),
	DSH_WINDOWS_PRIVATE_IO_NATIVE: "1", NO_COLOR: "1" };
console.log(`NATIVE_WINDOWS_PRIVATE_IO_ARTIFACT ${root}`);
if (mode[0] === "--constructor-compare") {
	// Explicit diagnostic-only A/B/C. Capture all controls, including expected baseline timeout;
	// never treat these constructors/module probes as the required 15-case native acceptance suite.
	const helper = resolve(import.meta.dir, "../test/runtime/fixtures/windows-private-fixture.ps1");
	const results = [];
	for (const action of ["constructor-cmdlet", "constructor-direct", "constructor-loaded"]) {
		const stem = join(tmp, action), started = Date.now();
		const stdout = openSync(`${stem}.stdout`, "wx"), stderr = openSync(`${stem}.stderr`, "wx");
		writeFileSync(`${stem}.stages`, "", { flag: "wx" });
		writeFileSync(`${stem}.request.json`, JSON.stringify({ action, timeoutMs: 20_000, started }));
		let result;
		try {
			execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", helper, action, join(tmp, `${action}-object`)], {
				stdio: ["ignore", stdout, stderr], timeout: 20_000, env: { ...env, DSH_WINDOWS_PRIVATE_IO_TRACE: `${stem}.stages` },
			});
			result = { action, elapsedMs: Date.now() - started, status: 0 };
		} catch (error) {
			result = { action, elapsedMs: Date.now() - started, status: error.status, code: error.code, signal: error.signal };
		} finally { closeSync(stdout); closeSync(stderr); }
		results.push(result); writeFileSync(`${stem}.result.json`, JSON.stringify(result));
		console.log(`NATIVE_CONSTRUCTOR_CONTROL ${JSON.stringify(result)} artifact=${stem}`);
		process.stderr.write(readFileSync(`${stem}.stderr`));
	}
	writeFileSync(join(root, "constructor-comparison.json"), JSON.stringify(results, null, 2));
	console.log("NATIVE_CONSTRUCTOR_COMPARISON_ONLY_NOT_ACCEPTANCE; run default 15-case gate separately");
	process.exit(0);
}
const child = Bun.spawn([process.execPath, "test", resolve(import.meta.dir, "../test/runtime/windows-private-config.test.ts")], {
	cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 240_000,
});
async function drain(stream, file, output) {
	const chunks = [];
	for await (const chunk of stream) {
		appendFileSync(file, chunk); chunks.push(Buffer.from(chunk)); output.write(chunk);
	}
	return Buffer.concat(chunks);
}
// Drain both pipes while child runs, preserving original bytes and showing failure stage before timeout.
const [, stderr, exitCode] = await Promise.all([
	drain(child.stdout, join(root, "native.stdout"), process.stdout),
	drain(child.stderr, join(root, "native.stderr"), process.stderr), child.exited,
]);
if (exitCode !== 0 || !/\b15 pass\b/.test(stderr.toString()) || /\b[1-9]\d* (?:skip|fail)\b/.test(stderr.toString())) process.exit(1);
console.log("NATIVE_WINDOWS_PRIVATE_IO_GATE_PASSED (module seam; real application I/O gate separate)");
