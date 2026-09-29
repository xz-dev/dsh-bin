// Prebuilt Bun transpiler cache (build: scripts/warm-transpiler-cache.mjs). The launcher points
// BUN_RUNTIME_TRANSPILER_CACHE_PATH at dsh-bin's user cache (`$DSH_BUNDLE_CACHE/transpiler`); the bundle
// ships the entries its own app tree produces, and the first start of each bundle version copies the
// missing ones there, so a fresh install or update starts warm. Measured (see docs/IMPLEMENTATION-REPORT.md):
// entries are content-keyed .pile files, valid across install paths and mtimes, and Bun ignores a cache it
// cannot write. Seeding here (not at `dsh update` activation) also covers zip, Scoop and system-package
// installs, which never run the updater. Best effort: any failure only costs one cold start.
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BUNDLE_CACHE_DIR = "transpiler-cache";
export const CACHE_VAR = "BUN_RUNTIME_TRANSPILER_CACHE_PATH";

/** Copy the bundle's shipped cache entries into the active transpiler cache, once per bundle version. */
export function seedTranspilerCache(bundleDir: string, version: string, env: NodeJS.ProcessEnv = process.env): "seeded" | "skipped" {
	const dest = env[CACHE_VAR];
	const src = join(bundleDir, BUNDLE_CACHE_DIR);
	// "0"/"" disable the cache; a relative value is not ours to interpret.
	if (!dest || dest === "0" || !/^([A-Za-z]:)?[\\/]/.test(dest) || !existsSync(src)) return "skipped";
	const stamp = join(dest, `.seeded-${version}`);
	try {
		if (existsSync(stamp)) return "skipped";
		mkdirSync(dest, { recursive: true });
		for (const name of readdirSync(src)) {
			if (!existsSync(join(dest, name))) copyFileSync(join(src, name), join(dest, name));
		}
		writeFileSync(stamp, "");
		return "seeded";
	} catch {
		return "skipped";
	}
}
