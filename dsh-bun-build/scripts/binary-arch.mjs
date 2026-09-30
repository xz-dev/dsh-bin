// Executable format and architecture from a file header (ELF, Mach-O, PE), used to check that every
// native file of a runtime bundle matches its target.
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
