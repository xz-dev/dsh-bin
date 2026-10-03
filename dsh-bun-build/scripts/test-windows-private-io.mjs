// Native-only gate. Run with Bun 1.4.2 on Windows x64/arm64, not wine/cross-build/mock.
// bun dsh-bun-build/scripts/test-windows-private-io.mjs
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.platform !== "win32") throw new Error("native Windows configuration I/O gate requires Windows; NOT RUN");
if (Bun.version !== "1.4.2") throw new Error("native Windows configuration I/O gate requires pinned Bun 1.4.2");
const root = mkdtempSync(join(tmpdir(), "dsh-windows-private-io-"));
const home = join(root, "home"), tmp = join(root, "tmp"), cache = join(root, "cache");
for (const p of [home, tmp, cache]) mkdirSync(p);
const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
	COMSPEC: process.env.COMSPEC, PATHEXT: process.env.PATHEXT,
	HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
	TMPDIR: tmp, TMP: tmp, TEMP: tmp, XDG_CACHE_HOME: cache, BUN_INSTALL_CACHE_DIR: cache,
	DSH_WINDOWS_PRIVATE_IO_NATIVE: "1", NO_COLOR: "1" };
console.log(`NATIVE_WINDOWS_PRIVATE_IO_ARTIFACT ${root}`);
const result = Bun.spawnSync([process.execPath, "test", resolve(import.meta.dir, "../test/runtime/windows-private-config.test.ts")], {
	cwd: root, env, stdout: "pipe", stderr: "pipe", timeout: 240_000,
});
// Test output is metadata/known synthetic fixture data only. Caller may save it inside task temp root.
process.stdout.write(result.stdout); process.stderr.write(result.stderr);
if (result.exitCode !== 0 || !/\b15 pass\b/.test(result.stderr.toString()) || /\b[1-9]\d* (?:skip|fail)\b/.test(result.stderr.toString())) process.exit(1);
console.log("NATIVE_WINDOWS_PRIVATE_IO_GATE_PASSED (module seam; real application I/O gate separate)");
