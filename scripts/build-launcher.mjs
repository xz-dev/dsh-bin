// Cross-compile the Zig launcher (design D4) for one or all targets, then check each output's
// executable format and architecture from its header.
// usage: bun scripts/build-launcher.mjs <version> <channel> <out-dir> [target-id...]
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TARGETS, target as targetById } from "./targets.mjs";

const LAUNCHER_DIR = resolve(import.meta.dir, "../launcher");

/** `{format, arch}` of an ELF, Mach-O or PE executable, from its header. */
export function binaryArch(bytes) {
	const u16 = (o) => bytes.readUInt16LE(o);
	const u32 = (o) => bytes.readUInt32LE(o);
	if (bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
		const machine = u16(18);
		return { format: "elf", arch: { 0x3e: "x64", 0xb7: "arm64" }[machine] ?? `elf:${machine}` };
	}
	if (u32(0) === 0xfeedfacf) {
		const cpu = u32(4);
		return { format: "macho", arch: { 0x01000007: "x64", 0x0100000c: "arm64" }[cpu] ?? `macho:${cpu}` };
	}
	if (bytes.subarray(0, 2).toString("latin1") === "MZ") {
		const pe = u32(0x3c);
		if (bytes.subarray(pe, pe + 4).toString("latin1") !== "PE\0\0") return { format: "unknown", arch: "unknown" };
		const machine = u16(pe + 4);
		return { format: "pe", arch: { 0x8664: "x64", 0xaa64: "arm64" }[machine] ?? `pe:${machine}` };
	}
	return { format: "unknown", arch: "unknown" };
}

const FORMAT = { linux: "elf", darwin: "macho", windows: "pe" };

/** Throw unless the file at `path` is an executable for target `t`. */
export function assertTargetBinary(path, t) {
	const got = binaryArch(readFileSync(path));
	if (got.format !== FORMAT[t.os] || got.arch !== t.arch) {
		throw new Error(`${path}: expected ${FORMAT[t.os]}/${t.arch} for ${t.id}, got ${got.format}/${got.arch}`);
	}
}

/** Build the launcher for target `t` into `<out>/<t.id>/<t.launcher>`; returns the output path. */
export function buildLauncher(t, { version, channel, out }) {
	const prefix = mkdtempSync(join(tmpdir(), "dsh-launcher-"));
	try {
		execFileSync("zig", ["build", `-Dtarget=${t.zigTarget}`, `-Dversion=${version}`, `-Dchannel=${channel}`, "--prefix", prefix], {
			cwd: LAUNCHER_DIR,
			stdio: ["ignore", "inherit", "inherit"],
		});
		const dir = join(out, t.id);
		mkdirSync(dir, { recursive: true });
		const dest = join(dir, t.launcher);
		renameSync(join(prefix, "bin", t.launcher), dest);
		assertTargetBinary(dest, t);
		return dest;
	} finally {
		rmSync(prefix, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const [version, channel, out, ...ids] = process.argv.slice(2);
	if (!version || !channel || !out) throw new Error("usage: build-launcher.mjs <version> <channel> <out-dir> [target-id...]");
	for (const t of ids.length ? ids.map(targetById) : TARGETS) console.log(`${t.id}: ${buildLauncher(t, { version, channel, out })}`);
}
