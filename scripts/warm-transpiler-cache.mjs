// Prebuild Bun's transpiler cache for an assembled bundle (runtime/transpiler-cache.ts seeds it into the
// user's cache on first start). Runs the bundle's own dsh-native natively (the cache format belongs to that
// Bun build) with each shipped profile template's --help in a throwaway HOME, so every file the boot path
// transpiles gets an entry. Entries are content-keyed, so the build path does not leak into them.
// usage: bun scripts/warm-transpiler-cache.mjs <bundle-dir>
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// dsh-app-boot's PROFILE_TEMPLATES (each boots its plugin stack and prints the app's help).
export const WARM_PROFILES = ["acp", "headless", "sdk", "sdk-minimal", "web"];
export const BUNDLE_CACHE_DIR = "transpiler-cache";

export function warmTranspilerCache(bundleDir, { profiles = WARM_PROFILES, log = console.error } = {}) {
	const native = join(bundleDir, process.platform === "win32" ? "dsh-native.exe" : "dsh-native");
	if (!existsSync(native)) throw new Error(`no runtime at ${native}`);
	const tmp = mkdtempSync(join(tmpdir(), "dsh-warm-"));
	const cache = join(tmp, "cache");
	try {
		mkdirSync(cache);
		const env = { PATH: process.env.PATH ?? "", HOME: tmp, USERPROFILE: tmp, DSH_HOME: join(tmp, ".dsh"), DSH_TELEMETRY_DISABLED: "1", NO_COLOR: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: cache };
		for (const k of ["TMPDIR", "TEMP", "TMP", "SystemRoot", "LANG"]) if (process.env[k]) env[k] = process.env[k];
		for (const p of profiles) {
			const r = spawnSync(native, ["--profile", `warm-${p}`, "--from-default-profile", p, "--help"], { cwd: tmp, env, encoding: "utf8", timeout: 120_000, windowsHide: true });
			if (r.status !== 0) throw new Error(`warming with profile ${p} failed (status ${r.status ?? r.signal}):\n${(r.stderr ?? "").slice(-2000)}`);
		}
		const entries = readdirSync(cache);
		if (entries.length === 0) throw new Error("warming produced no transpiler cache entries");
		const dest = join(bundleDir, BUNDLE_CACHE_DIR);
		rmSync(dest, { recursive: true, force: true });
		cpSync(cache, dest, { recursive: true });
		log(`transpiler cache: ${entries.length} entries from profiles ${profiles.join(", ")}`);
		return entries.length;
	} finally {
		rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
	}
}

if (import.meta.main) {
	const [bundleDir] = process.argv.slice(2);
	if (!bundleDir) throw new Error("usage: warm-transpiler-cache.mjs <bundle-dir>");
	warmTranspilerCache(bundleDir);
}
