// Compile the dsh-bin entry (D1). The executable loads dsh from the on-disk `app/` next to it, so:
// - `--compile-autoload-package-json` lets the executable resolve packages from that node_modules tree;
// - dotenv and bunfig autoloading stay off, so files in the user's cwd cannot change the runtime;
// - `--minify --bytecode --format=esm` as in xz-dev/pi. ESM bytecode is only safe when compiled on the
//   target's own OS/arch (oven-sh/bun#18416); every release target builds natively, and a cross build
//   (local experiments only) drops --bytecode. The on-disk app tree cannot get bytecode: Bun 1.4 emits ESM
//   bytecode only into --compile executables, and dsh loads its plugins as on-disk packages.
// usage: bun scripts/compile-entry.mjs <bun-target> <outfile>
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ENTRY = fileURLToPath(new URL("../runtime/entry.ts", import.meta.url));

const hostTarget = () => `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;

export function compileArgs(target, outfile, host = hostTarget()) {
	// bun-linux-x64-musl-modern etc. start with the host os-arch prefix.
	const native = target === host || target.startsWith(`${host}-`);
	return [
		"build",
		"--compile",
		"--minify",
		...(native ? ["--bytecode"] : []),
		"--format=esm",
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
