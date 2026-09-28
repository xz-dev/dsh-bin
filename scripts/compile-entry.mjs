// Compile the dsh-bin entry (D1). The executable loads dsh from the on-disk `app/` next to it, so:
// - `--compile-autoload-package-json` lets the executable resolve packages from that node_modules tree;
// - dotenv and bunfig autoloading stay off, so files in the user's cwd cannot change the runtime.
// usage: bun scripts/compile-entry.mjs <bun-target> <outfile>
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ENTRY = fileURLToPath(new URL("../runtime/entry.ts", import.meta.url));

export function compileArgs(target, outfile) {
	return [
		"build",
		"--compile",
		`--target=${target}`,
		"--compile-autoload-package-json",
		"--no-compile-autoload-dotenv",
		"--no-compile-autoload-bunfig",
		ENTRY,
		"--outfile",
		outfile,
	];
}

export function compileEntry(target, outfile) {
	const r = spawnSync(process.execPath, compileArgs(target, outfile), { stdio: "inherit" });
	if (r.status !== 0) throw new Error(`bun build --compile failed for ${target} (exit ${r.status})`);
	return outfile;
}

if (import.meta.main) {
	const [target, outfile] = process.argv.slice(2);
	if (!target || !outfile) {
		console.error("usage: bun scripts/compile-entry.mjs <bun-target> <outfile>");
		process.exit(2);
	}
	compileEntry(target, outfile);
}
