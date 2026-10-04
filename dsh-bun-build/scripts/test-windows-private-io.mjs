// Native-only gate. Run with Bun 1.4.2 on Windows x64/arm64, not wine/cross-build/mock.
// bun dsh-bun-build/scripts/test-windows-private-io.mjs
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.platform !== "win32") throw new Error("native Windows configuration I/O gate requires Windows; NOT RUN");
if (Bun.version !== "1.4.2") throw new Error("native Windows configuration I/O gate requires pinned Bun 1.4.2");
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
