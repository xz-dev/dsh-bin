import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assembleBundle, foreignBinaries, officeTable, prunePrebuilds, requiredPaths } from "../../scripts/assemble-bundle.mjs";
import { target } from "../../scripts/targets.mjs";

const ROOT = resolve(import.meta.dir, "../..");
const tmp = () => mkdtempSync(join(tmpdir(), "dsh-assemble-"));

// Minimal headers the arch check recognizes.
const elf = (machine: number) => {
	const b = Buffer.alloc(128);
	b.set([0x7f, 0x45, 0x4c, 0x46]);
	b.writeUInt16LE(machine, 18);
	return b;
};
const macho = (cpu: number) => {
	const b = Buffer.alloc(128);
	b.writeUInt32LE(0xfeedfacf, 0);
	b.writeUInt32LE(cpu, 4);
	return b;
};
const pe = (machine: number) => {
	const b = Buffer.alloc(256);
	b.write("MZ", 0, "latin1");
	b.writeUInt32LE(0x80, 0x3c);
	b.write("PE\0\0", 0x80, "latin1");
	b.writeUInt16LE(machine, 0x84);
	return b;
};
const put = (path: string, data: string | Buffer) => {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, data);
};

function fixture() {
	const dir = tmp();
	const app = join(dir, "app");
	put(join(app, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh" }));
	put(join(app, "lib/bin.js"), "export {}");
	const pty = join(app, "node_modules/node-pty");
	put(join(pty, "prebuilds/linux-x64/pty.node"), elf(0x3e));
	put(join(pty, "prebuilds/linux-arm64/pty.node"), elf(0xb7));
	put(join(pty, "prebuilds/darwin-arm64/pty.node"), macho(0x0100000c));
	put(join(pty, "prebuilds/darwin-arm64/spawn-helper"), macho(0x0100000c));
	put(join(pty, "prebuilds/darwin-x64/pty.node"), macho(0x01000007));
	put(join(pty, "prebuilds/win32-x64/conpty.node"), pe(0x8664));
	put(join(pty, "third_party/conpty/1.25/win10-arm64/conpty.dll"), pe(0xaa64));
	put(join(pty, "third_party/conpty/1.25/win10-x64/conpty.dll"), pe(0x8664));
	put(join(app, "node_modules/@koromix/koffi-linux-x64/musl_x64/koffi.node"), elf(0x3e));
	const pnpm = join(dir, "pnpm");
	put(join(pnpm, "dist/pnpm.mjs"), "// pnpm");
	put(join(pnpm, "dist/vendor/fastlist-0.3.0-x64.exe"), pe(0x8664));
	put(join(pnpm, "dist/vendor/fastlist-0.3.0-x86.exe"), pe(0x14c));
	const native = join(dir, "dsh-native");
	put(native, elf(0x3e));
	const launcher = join(dir, "dsh");
	put(launcher, elf(0x3e));
	return { dir, app, pnpm, native, launcher };
}

const slotA = { commit: "a".repeat(40), kitVersion: "0.1.2" };
const slotB = { commit: "b".repeat(40), kitVersion: "0.1.3" };
const addon = (seq: number, version: string, slot: typeof slotA) => ({
	seq,
	tag: `dsh-addon-office-v${version}`,
	version,
	slot,
	assets: { linux: { name: "dsh-addon-office-linux.zip", size: 1, sha256: "0".repeat(64) } },
});
const index = {
	schemaVersion: 1,
	channels: { release: [], live: [] },
	addons: { office: [addon(1, "0.1.2-xz.1.1.g11111111", slotA), addon(2, "0.1.3-xz.2.1.g22222222", slotB), addon(3, "0.1.2-xz.3.1.g33333333", slotA)] },
};

describe("office table (6.1)", () => {
	test("known equals the index snapshot and pinned is the newest in-slot entry", () => {
		const t = officeTable(slotA, index);
		expect(t.known).toEqual(index.addons.office);
		expect(t.pinned).toBe("0.1.2-xz.3.1.g33333333");
		expect(t.slot).toEqual(slotA);
		expect(officeTable(slotB, index).pinned).toBe("0.1.3-xz.2.1.g22222222");
	});

	test("a slot with no addon pins nothing; no kit means no slot", () => {
		expect(officeTable({ commit: "c".repeat(40), kitVersion: "9" }, index).pinned).toBeNull();
		expect(officeTable(null, index)).toEqual({ slot: null, pinned: null, known: index.addons.office });
		expect(officeTable(slotA, undefined).known).toEqual([]);
	});
});

describe("assemble (6.1)", () => {
	const spec = (f: ReturnType<typeof fixture>, id: string, idx?: string) => ({
		target: id,
		out: join(f.dir, `out-${id}`),
		app: f.app,
		pnpm: f.pnpm,
		native: f.native,
		launcher: f.launcher,
		identity: { version: "0.1.7-rc.2-xz.1.1.gabcdef12", tag: "dsh-v0.1.7-rc.2-xz.1.1.gabcdef12", channel: "release" },
		upstream: { commit: "4".repeat(40), tag: "dsh-v0.1.7-rc.2", version: "0.1.7-rc.2" },
		launcherCommit: "abcdef12".repeat(5),
		slot: slotA,
		index: idx,
	});

	test("inventory: layout, bundle.json and required paths", () => {
		const f = fixture();
		const idx = join(f.dir, "index.json");
		writeFileSync(idx, JSON.stringify(index));
		const r = assembleBundle(spec(f, "linux-x64-modern", idx));
		const v = "0.1.7-rc.2-xz.1.1.gabcdef12";
		expect(r.meta.requiredPaths).toEqual(requiredPaths(target("linux-x64-modern"), v));
		for (const p of r.meta.requiredPaths) expect(existsSync(join(r.out, p))).toBe(true);
		const meta = JSON.parse(readFileSync(join(r.bundle, "bundle.json"), "utf8"));
		expect(meta).toMatchObject({ schemaVersion: 1, name: "dsh-bin", version: v, channel: "release", target: "linux-x64-modern" });
		expect(meta.addons.office.pinned).toBe("0.1.2-xz.3.1.g33333333");
		expect(meta.addons.office.known).toEqual(index.addons.office);
		expect(readFileSync(join(r.bundle, "bin/pnpm"), "utf8")).toContain("pnpm/dist/pnpm.mjs");
	});

	test("prunes other-platform prebuilds; every remaining native file matches the target", () => {
		const f = fixture();
		const r = assembleBundle(spec(f, "linux-x64-modern"));
		const pty = join(r.bundle, "app/node_modules/node-pty");
		expect(existsSync(join(pty, "prebuilds/linux-x64/pty.node"))).toBe(true);
		for (const gone of ["prebuilds/linux-arm64", "prebuilds/darwin-arm64", "prebuilds/win32-x64", "third_party/conpty/1.25/win10-x64"]) {
			expect(existsSync(join(pty, gone))).toBe(false);
		}
		expect(foreignBinaries(r.bundle, target("linux-x64-modern"))).toEqual([]);
		expect(existsSync(join(r.bundle, "pnpm/dist/vendor"))).toBe(false);
	});

	test("darwin: spawn-helper is executable; windows keeps win10-<arch> only", () => {
		// Per-target optional packages come from the native runner's deploy; linux-only ones are absent there.
		const noLinuxOnly = (app: string) => rmSync(join(app, "node_modules/@koromix"), { recursive: true });
		const f = fixture();
		noLinuxOnly(f.app);
		writeFileSync(f.native, macho(0x0100000c));
		writeFileSync(f.launcher, macho(0x0100000c));
		const r = assembleBundle(spec(f, "darwin-arm64"));
		// darwin bundles are assembled on macOS runners; Windows has no exec bits to check.
		if (process.platform !== "win32") expect(statSync(join(r.bundle, "app/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper")).mode & 0o111).toBe(0o111);
		expect(existsSync(join(r.bundle, "app/node_modules/node-pty/prebuilds/darwin-x64"))).toBe(false);

		const w = fixture();
		noLinuxOnly(w.app);
		writeFileSync(w.native, pe(0xaa64));
		writeFileSync(w.launcher, pe(0xaa64));
		const rw = assembleBundle(spec(w, "windows-arm64"));
		expect(existsSync(join(rw.bundle, "app/node_modules/node-pty/third_party/conpty/1.25/win10-arm64/conpty.dll"))).toBe(true);
		expect(existsSync(join(rw.bundle, "app/node_modules/node-pty/third_party/conpty/1.25/win10-x64"))).toBe(false);
		expect(existsSync(join(rw.bundle, "bin/pnpm.cmd"))).toBe(true);
		expect(existsSync(join(rw.bundle, "pnpm/dist/vendor/fastlist-0.3.0-x86.exe"))).toBe(true);
		expect(existsSync(join(rw.out, "dsh.exe"))).toBe(true);
	});

	test("a foreign native file that pruning cannot explain fails the build", () => {
		const f = fixture();
		put(join(f.app, "node_modules/odd/lib/helper.node"), elf(0xb7)); // arm64 in an x64 build
		expect(() => assembleBundle(spec(f, "linux-x64-modern"))).toThrow(/another target.*odd/s);
	});

	test("an app tree that still contains the office kit is refused", () => {
		const f = fixture();
		put(join(f.app, "node_modules/@deepseek-ai/libreoffice-kit/package.json"), "{}");
		expect(() => assembleBundle(spec(f, "linux-x64-modern"))).toThrow(/office kit/);
	});

	test("prunePrebuilds keeps the matching libc on linux", () => {
		const f = fixture();
		put(join(f.app, "node_modules/x/prebuilds/linux-x64-musl/a.node"), elf(0x3e));
		put(join(f.app, "node_modules/x/prebuilds/linux-x64-gnu/a.node"), elf(0x3e));
		const app = join(f.dir, "copy");
		cpSync(f.app, app, { recursive: true });
		prunePrebuilds(app, target("linux-x64-musl-modern"));
		expect(existsSync(join(app, "node_modules/x/prebuilds/linux-x64-musl"))).toBe(true);
		expect(existsSync(join(app, "node_modules/x/prebuilds/linux-x64-gnu"))).toBe(false);
	});
});

test.skipIf(!existsSync(join(ROOT, "work/app/lib/bin.js")))("real app tree: host target assembles with no foreign native file", () => {
	const t = target("linux-x64-modern");
	const app = join(ROOT, "work/app");
	const copy = join(tmp(), "app");
	cpSync(join(app, "node_modules/node-pty"), join(copy, "node_modules/node-pty"), { recursive: true });
	prunePrebuilds(copy, t);
	expect(foreignBinaries(copy, t)).toEqual([]);
});
