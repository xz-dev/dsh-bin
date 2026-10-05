import { expect, test } from "bun:test";
import { binaryArch } from "../../scripts/binary-arch.mjs";

function elf(machine: number) {
	const b = Buffer.alloc(64);
	b.set([0x7f, 0x45, 0x4c, 0x46]);
	b.writeUInt16LE(machine, 18);
	return b;
}
function macho(cpu: number) {
	const b = Buffer.alloc(32);
	b.writeUInt32LE(0xfeedfacf, 0);
	b.writeUInt32LE(cpu, 4);
	return b;
}
function pe(machine: number) {
	const b = Buffer.alloc(0x100);
	b.write("MZ", 0, "latin1");
	b.writeUInt32LE(0x80, 0x3c);
	b.write("PE\0\0", 0x80, "latin1");
	b.writeUInt16LE(machine, 0x84);
	return b;
}

test("RB-CONTENTS: inspecting small non-native files does not require a complete executable header", () => {
	for (const bytes of [Buffer.alloc(0), Buffer.from("a"), Buffer.from("MZ"), Buffer.from("\\x7fELF")]) expect(binaryArch(bytes).format).toBe("unknown");
});

test("binaryArch reads ELF, Mach-O and PE headers", () => {
	expect(binaryArch(elf(0x3e))).toEqual({ format: "elf", arch: "x64" });
	expect(binaryArch(elf(0xb7))).toEqual({ format: "elf", arch: "arm64" });
	expect(binaryArch(macho(0x01000007))).toEqual({ format: "macho", arch: "x64" });
	expect(binaryArch(macho(0x0100000c))).toEqual({ format: "macho", arch: "arm64" });
	expect(binaryArch(pe(0x8664))).toEqual({ format: "pe", arch: "x64" });
	expect(binaryArch(pe(0xaa64))).toEqual({ format: "pe", arch: "arm64" });
	expect(binaryArch(Buffer.from("#!/bin/sh\n")).format).toBe("unknown");
});

test("FreeBSD identity accepts OSABI/note, rejects Linux, malformed, old and wrong headers", async () => {
	const { isFreebsdElf } = await import("../../scripts/binary-arch.mjs");
	const native = elf(0x3e); native[4] = 2; native[5] = 1; native[7] = 9; native.writeUInt16LE(2, 16);
	expect(isFreebsdElf(native)).toBe(true);
	for (const [offset, value] of [[4, 1], [5, 2], [7, 3], [16, 1]]) { const bad = Buffer.from(native); bad[offset] = value; expect(isFreebsdElf(bad)).toBe(false); }
	const note = Buffer.alloc(144); native.copy(note); note[7] = 0;
	note.writeBigUInt64LE(64n, 32); note.writeUInt16LE(56, 54); note.writeUInt16LE(1, 56);
	note.writeUInt32LE(4, 64); note.writeBigUInt64LE(120n, 72); note.writeBigUInt64LE(24n, 96);
	note.writeUInt32LE(8, 120); note.writeUInt32LE(4, 124); note.writeUInt32LE(1, 128); note.write("FreeBSD\0", 132, "latin1"); note.writeUInt32LE(1501000, 140);
	expect(isFreebsdElf(note)).toBe(true);
	for (const length of [0, 63, 119, 143]) expect(isFreebsdElf(note.subarray(0, length))).toBe(false);
	const old = Buffer.from(note); old.writeUInt32LE(1500068, 140); expect(isFreebsdElf(old)).toBe(false);
	const wrong = Buffer.from(note); wrong.write("Linux", 132); expect(isFreebsdElf(wrong)).toBe(false);
});
