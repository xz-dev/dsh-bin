// Header architecture probe for runtime assembly (no Zig/manager build dependency).
export function binaryArch(bytes) {
	const unknown = { format: "unknown", arch: "unknown" };
	if (bytes.length < 4) return unknown;
	if (bytes.subarray(0, 4).toString("latin1") === "\x7fELF" && bytes.length >= 20) {
		const machine = bytes.readUInt16LE(18);
		return { format: "elf", arch: { 0x3e: "x64", 0xb7: "arm64" }[machine] ?? `elf:${machine}` };
	}
	if (bytes.readUInt32LE(0) === 0xfeedfacf && bytes.length >= 8) {
		const cpu = bytes.readUInt32LE(4);
		return { format: "macho", arch: { 0x01000007: "x64", 0x0100000c: "arm64" }[cpu] ?? `macho:${cpu}` };
	}
	if (bytes.subarray(0, 2).toString("latin1") === "MZ" && bytes.length >= 64) {
		const pe = bytes.readUInt32LE(0x3c);
		if (pe + 6 > bytes.length || bytes.subarray(pe, pe + 4).toString("latin1") !== "PE\0\0") return unknown;
		const machine = bytes.readUInt16LE(pe + 4);
		return { format: "pe", arch: { 0x8664: "x64", 0xaa64: "arm64" }[machine] ?? `pe:${machine}` };
	}
	return unknown;
}
