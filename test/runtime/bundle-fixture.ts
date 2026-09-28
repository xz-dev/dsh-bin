// A test bundle `<root>/bundles/<version>/` built from the local build outputs (work/app, work/pnpm-*,
// work/addon-office): compiled dsh-native, shims, and links to the app and pnpm trees.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeShims } from "../../scripts/shims.mjs";

export const ROOT = resolve(import.meta.dir, "../..");
export const APP = resolve(process.env.DSH_BIN_TEST_APP ?? join(ROOT, "work/app"));
export const ADDON = resolve(process.env.DSH_BIN_TEST_ADDON ?? join(ROOT, "work/addon-office"));
const os = process.platform === "win32" ? "windows" : process.platform;
export const PNPM = resolve(process.env.DSH_BIN_TEST_PNPM ?? join(ROOT, `work/pnpm-${os}-${process.arch}`));
export const appBuilt = existsSync(join(APP, "lib/bin.js"));
export const addonBuilt = existsSync(join(ADDON, "node_modules"));
export const pnpmFetched = existsSync(join(PNPM, "dist/pnpm.mjs"));

export type Fixture = { root: string; bundle: string; native: string };

export function makeBundle(version = "V1"): Fixture {
	const root = mkdtempSync(join(tmpdir(), "dsh-bundle-"));
	const bundle = join(root, "bundles", version);
	mkdirSync(bundle, { recursive: true });
	const native = join(bundle, process.platform === "win32" ? "dsh-native.exe" : "dsh-native");
	execFileSync("bun", [join(ROOT, "scripts/compile-entry.mjs"), `bun-${process.platform}-${process.arch}`, native], { stdio: "ignore" });
	symlinkSync(APP, join(bundle, "app"));
	if (pnpmFetched) symlinkSync(PNPM, join(bundle, "pnpm"));
	writeShims(bundle, os);
	return { root, bundle, native };
}

/** A PATH directory holding only `tools` (default git and sh), so no JavaScript runtime is reachable. */
export function toolsOnlyPath(root: string, tools = ["git", "sh"]): string {
	const dir = join(root, `path-${tools.join("-")}`);
	if (!existsSync(dir)) {
		mkdirSync(dir);
		for (const tool of tools) symlinkSync(Bun.which(tool)!, join(dir, tool));
	}
	return dir;
}
