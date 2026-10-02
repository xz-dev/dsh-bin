// Prebuilt Bun transpiler cache (build: scripts/warm-transpiler-cache.mjs). The manager points
// BUN_RUNTIME_TRANSPILER_CACHE_PATH at the data root's cache/transpiler; the bundle ships entries from
// its own app tree, and its first start copies missing entries there. Cache keys do not depend on
// install paths or mtimes (see desc/IMPLEMENTATION-REPORT.md). Runtime seeding keeps cache policy out
// of the manager's installation path. Best effort: any failure only costs one cold start.
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
