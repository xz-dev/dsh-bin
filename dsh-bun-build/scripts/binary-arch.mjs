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

/** FreeBSD ELF identity, not just same-machine Linux ELF. OSABI System V needs a valid ABI note. */
export function isFreebsdElf(bytes) {
	if (bytes.length < 64 || bytes.subarray(0, 4).toString("latin1") !== "\x7fELF" || bytes[4] !== 2 || bytes[5] !== 1 || ![2, 3].includes(bytes.readUInt16LE(16))) return false;
	if (bytes[7] === 9) return true;
	if (bytes[7] !== 0) return false;
	const table = bytes.readBigUInt64LE(32), size = bytes.readUInt16LE(54), count = bytes.readUInt16LE(56);
	if (size < 56 || table > BigInt(bytes.length) || count > Math.floor((bytes.length - Number(table)) / size)) return false;
	for (let i = 0; i < count; i++) {
		const header = Number(table) + i * size;
		if (bytes.readUInt32LE(header) !== 4) continue;
		const offset = bytes.readBigUInt64LE(header + 8), length = bytes.readBigUInt64LE(header + 32);
		if (offset > BigInt(bytes.length) || length > BigInt(bytes.length) - offset) return false;
		let at = Number(offset); const end = Number(offset + length);
		while (end - at >= 12) {
			const names = bytes.readUInt32LE(at), desc = bytes.readUInt32LE(at + 4), kind = bytes.readUInt32LE(at + 8);
			at += 12;
			const nameSize = Math.ceil(names / 4) * 4, descSize = Math.ceil(desc / 4) * 4;
			if (nameSize > end - at || descSize > end - at - nameSize) return false;
			if (kind === 1 && names === 8 && desc === 4 && bytes.subarray(at, at + 8).equals(Buffer.from("FreeBSD\0")) && bytes.readUInt32LE(at + nameSize) >= 1501000) return true;
			at += nameSize + descSize;
		}
	}
	return false;
}
