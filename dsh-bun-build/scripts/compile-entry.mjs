// Compile the dsh-bin entry (D1). The executable loads dsh from the on-disk `app/` next to it, so:
// - `--compile-autoload-package-json` lets the executable resolve packages from that node_modules tree;
// - dotenv and bunfig autoloading stay off, so files in the user's cwd cannot change the runtime;
// - `--minify --bytecode --format=esm` as in xz-dev/pi. ESM bytecode is only safe when compiled on the
//   target's own OS/arch (oven-sh/bun#18416); every release target builds natively, and a cross build
//   (local experiments only) drops --bytecode. The on-disk app tree cannot get bytecode: Bun 1.4 emits ESM
//   bytecode only into --compile executables, and dsh loads its plugins as on-disk packages.
// usage: bun scripts/compile-entry.mjs <bun-target> <outfile> [--compile-executable-path <verified-native-bun>]
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BUN_VERSION, FREEBSD_BUN } from "./targets.mjs";

export const ENTRY = fileURLToPath(new URL("../runtime/entry.ts", import.meta.url));

const hostTarget = () => `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;

export function compileArgs(target, outfile, host = hostTarget(), executablePath = process.execPath) {
	// bun-linux-x64-musl-modern etc. start with the host os-arch prefix.
	const native = target === host || target.startsWith(`${host}-`);
	const freebsd = target.startsWith("bun-freebsd-");
	if (freebsd && !["bun-freebsd-x64-baseline", "bun-freebsd-arm64"].includes(target)) throw new Error(`unsupported FreeBSD compile target: ${target}`);
	if (freebsd && !native) throw new Error(`compile ${target} on native FreeBSD (host ${host})`);
	return [
		"build",
		"--compile",
		...(freebsd ? [`--compile-executable-path=${executablePath}`] : []),
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

export function validateFreebsdBun(target, executablePath) {
	const arch = target === "bun-freebsd-x64-baseline" ? "x64" : "arm64";
	if (process.platform !== "freebsd" || process.arch !== arch || process.versions.bun !== BUN_VERSION) {
		throw new Error(`compile ${target} with native FreeBSD ${arch} Bun ${BUN_VERSION}`);
	}
	const digest = createHash("sha256").update(readFileSync(executablePath)).digest("hex");
	if (digest !== FREEBSD_BUN[arch].executableSha256) throw new Error(`native Bun executable SHA-256 mismatch: ${executablePath}`);
	const probe = spawnSync(executablePath, ["-e", "console.log(JSON.stringify([process.platform,process.arch,process.versions.bun]))"], { encoding: "utf8" });
	if (probe.status !== 0 || probe.stdout.trim() !== JSON.stringify(["freebsd", arch, BUN_VERSION])) {
		throw new Error(`native Bun identity mismatch: ${executablePath}`);
	}
}

export function compileEntry(target, outfile, executablePath = process.execPath) {
	const args = compileArgs(target, outfile, hostTarget(), executablePath);
	if (target.startsWith("bun-freebsd-")) validateFreebsdBun(target, executablePath);
	const r = spawnSync(process.execPath, args, { stdio: "inherit" });
	if (r.status !== 0) throw new Error(`bun build --compile failed for ${target} (exit ${r.status})`);
	return outfile;
}

if (import.meta.main) {
	const [target, outfile, option, executablePath] = process.argv.slice(2);
	if (!target || !outfile || (option && (option !== "--compile-executable-path" || !executablePath)) || process.argv.length > 6) {
		console.error("usage: bun scripts/compile-entry.mjs <bun-target> <outfile> [--compile-executable-path <verified-native-bun>]");
		process.exit(2);
	}
	compileEntry(target, outfile, executablePath);
}
