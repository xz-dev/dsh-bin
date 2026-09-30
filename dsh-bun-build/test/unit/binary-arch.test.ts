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

test("binaryArch reads ELF, Mach-O and PE headers", () => {
	expect(binaryArch(elf(0x3e))).toEqual({ format: "elf", arch: "x64" });
	expect(binaryArch(elf(0xb7))).toEqual({ format: "elf", arch: "arm64" });
	expect(binaryArch(macho(0x01000007))).toEqual({ format: "macho", arch: "x64" });
	expect(binaryArch(macho(0x0100000c))).toEqual({ format: "macho", arch: "arm64" });
	expect(binaryArch(pe(0x8664))).toEqual({ format: "pe", arch: "x64" });
	expect(binaryArch(pe(0xaa64))).toEqual({ format: "pe", arch: "arm64" });
	expect(binaryArch(Buffer.from("#!/bin/sh\n")).format).toBe("unknown");
});
