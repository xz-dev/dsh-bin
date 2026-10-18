import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
	put(join(app, "lib/bin.js"), readFileSync(join(import.meta.dir, "../fixtures/fixed-cli.js"), "utf8"));
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
	return { dir, app, pnpm, native };
}

const slotA = { commit: "a".repeat(40), kitVersion: "0.1.2" };
const slotB = { commit: "b".repeat(40), kitVersion: "0.1.3" };
const addon = (seq: number, version: string, slot: typeof slotA) => ({
	seq,
	tag: `addon-office-v${version}`,
	version,
	slot,
	assets: { linux: { name: "dsh-addon-office-linux.zip", size: 1, sha256: "0".repeat(64) } },
});
const index = {
	schema: 1,
	channels: { release: [], live: [] },
	addons: { office: [addon(1, "0.1.2-b1.1.g11111111", slotA), addon(2, "0.1.3-b2.1.g22222222", slotB), addon(3, "0.1.2-b3.1.g33333333", slotA)] },
};

describe("office table (6.1)", () => {
	test("known equals the index snapshot and pinned is the newest in-slot entry", () => {
		const t = officeTable(slotA, index);
		expect(t.known).toEqual(index.addons.office);
		expect(t.pinned).toBe("0.1.2-b3.1.g33333333");
		expect(t.slot).toEqual(slotA);
		expect(officeTable(slotB, index).pinned).toBe("0.1.3-b2.1.g22222222");
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
		identity: { id: "0.1.7-rc.2-b1.1.gabcdef12", tag: "runtime-v0.1.7-rc.2-b1.1.gabcdef12", channel: "release" },
		upstream: { commit: "4".repeat(40), commitTime: "2026-09-24T13:39:59.000Z", tag: "dsh-v0.1.7-rc.2", version: "0.1.7-rc.2" },
		run: 1,
		attempt: 1,
		builderCommit: "abcdef12".repeat(5),
		slot: slotA,
		index: idx,
	});

	test("RB-COMPLETION: bundle exports versioned fixed CLI data without loading the application", () => {
		const f = fixture();
		const r = assembleBundle(spec(f, "linux-x64-modern"));
		expect(r.meta.requiredPaths).toContain("completion.json");
		const cli = JSON.parse(readFileSync(join(r.out, "completion.json"), "utf8"));
		expect(cli.schemaVersion).toBe(1);
		expect(cli.commands.map((c: { name: string }) => c.name)).toEqual(["", "plugin"]);
		expect(cli.commands[0].options).toContainEqual({ names: ["--profile"], takesValue: true });
		expect(cli.commands[0].options).toContainEqual({ names: ["-V", "--version"], takesValue: false });
		expect(cli.commands[1].options).toEqual([{ names: ["--profile"], takesValue: true }]);
	});

	test("RB-CONTENTS: the archive root is one runtime (no manager, no bundles/ tree); bundle.json v1 and required paths", () => {
		const f = fixture();
		const idx = join(f.dir, "index.json");
		writeFileSync(idx, JSON.stringify(index));
		const r = assembleBundle(spec(f, "linux-x64-modern", idx));
		const id = "0.1.7-rc.2-b1.1.gabcdef12";
		expect(r.bundle).toBe(r.out);
		expect(readdirSync(r.out).sort()).toEqual([".usage.lock", "app", "bin", "bundle.json", "completion.json", "dsh-native", "pnpm"]);
		expect(r.meta.requiredPaths).toEqual(requiredPaths(target("linux-x64-modern")));
		for (const p of r.meta.requiredPaths) expect(existsSync(join(r.out, p))).toBe(true);
		const meta = JSON.parse(readFileSync(join(r.bundle, "bundle.json"), "utf8"));
		expect(meta).toMatchObject({ kind: "dsh-runtime", schemaVersion: 1, id, channel: "release", target: "linux-x64-modern", run: 1, attempt: 1, launchProtocol: 2, entry: "dsh-native", builderCommit: "abcdef12".repeat(5) });
		for (const legacy of ["launcherProtocol", "launcherCommit", "name", "version"]) expect(meta[legacy]).toBeUndefined();
		expect(meta.upstream.commitTime).toBe("2026-09-24T13:39:59.000Z");
		expect(meta.addons.office.pinned).toBe("0.1.2-b3.1.g33333333");
		expect(meta.addons.office.known).toEqual(index.addons.office);
		expect(readFileSync(join(r.bundle, "bin/pnpm"), "utf8")).toContain("pnpm/dist/pnpm.mjs");
	}, 30_000);

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
		const r = assembleBundle(spec(f, "darwin-arm64"));
		// darwin bundles are assembled on macOS runners; Windows has no exec bits to check.
		if (process.platform !== "win32") expect(statSync(join(r.bundle, "app/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper")).mode & 0o111).toBe(0o111);
		expect(existsSync(join(r.bundle, "app/node_modules/node-pty/prebuilds/darwin-x64"))).toBe(false);

		const w = fixture();
		noLinuxOnly(w.app);
		writeFileSync(w.native, pe(0xaa64));
		const rw = assembleBundle(spec(w, "windows-arm64"));
		expect(existsSync(join(rw.bundle, "app/node_modules/node-pty/third_party/conpty/1.25/win10-arm64/conpty.dll"))).toBe(true);
		expect(existsSync(join(rw.bundle, "app/node_modules/node-pty/third_party/conpty/1.25/win10-x64"))).toBe(false);
		expect(existsSync(join(rw.bundle, "bin/pnpm.cmd"))).toBe(true);
		expect(existsSync(join(rw.bundle, "pnpm/dist/vendor/fastlist-0.3.0-x86.exe"))).toBe(true);
		expect(existsSync(join(rw.out, "dsh-native.exe"))).toBe(true);
		expect(existsSync(join(rw.out, "dsh.exe"))).toBe(false);
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

	test("bundle.json needs the build order: an upstream commit time and positive run/attempt", () => {
		const s = () => spec(fixture(), "linux-x64-modern");
		const a = s();
		expect(() => assembleBundle({ ...a, upstream: { ...a.upstream, commitTime: "2026-09-24T21:39:59+08:00" } })).toThrow(/commitTime/);
		expect(() => assembleBundle({ ...s(), run: 0 })).toThrow(/run and attempt/);
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

test("FreeBSD prunes only declared incompatible optional variants, preserving public JS and source", () => {
	const f = fixture(), copy = join(f.dir, "copy"); cpSync(f.app, copy, { recursive: true });
	const pkg = "@koromix/koffi-linux-x64", dir = join(copy, "node_modules", pkg);
	put(join(dir, "package.json"), JSON.stringify({ name: pkg, os: ["linux"], cpu: ["x64"] }));
	put(join(copy, "node_modules/koffi/package.json"), JSON.stringify({ name: "koffi", optionalDependencies: { [pkg]: "1" } }));
	put(join(copy, "node_modules/koffi/index.js"), "unchanged public JS\n");
	expect(prunePrebuilds(copy, target("freebsd-x64"))).toContain(`node_modules/${pkg}`);
	expect(existsSync(dir)).toBe(false);
	expect(readFileSync(join(copy, "node_modules/koffi/index.js"), "utf8")).toBe("unchanged public JS\n");
	expect(existsSync(join(f.app, "node_modules", pkg))).toBe(true);
});

test("FreeBSD refuses required or unclassified incompatible packages without deleting them", () => {
	for (const optional of [false, true]) {
		const f = fixture(), pkg = "@koromix/koffi-linux-x64", dir = join(f.app, "node_modules", pkg);
		put(join(dir, "package.json"), JSON.stringify({ name: pkg, os: ["!freebsd"] }));
		if (optional) {
			put(join(f.app, "node_modules/owner/package.json"), JSON.stringify({ optionalDependencies: { [pkg]: "1" } }));
			put(join(f.app, "package.json"), JSON.stringify({ dependencies: { [pkg]: "1" } }));
		}
		expect(() => prunePrebuilds(f.app, target("freebsd-x64"))).toThrow(/required or unclassified/);
		expect(existsSync(dir)).toBe(true);
	}
});

test("FreeBSD foreign scan rejects same-machine Linux and mismatched FreeBSD machines", () => {
	const root = tmp(), bytes = elf(0x3e); bytes[4] = 2; bytes[5] = 1; bytes[7] = 9; bytes.writeUInt16LE(2, 16);
	put(join(root, "native"), bytes); expect(foreignBinaries(root, target("freebsd-x64"))).toEqual([]);
	put(join(root, "linux"), elf(0x3e)); const arm = Buffer.from(bytes); arm.writeUInt16LE(0xb7, 18); put(join(root, "arm"), arm);
	expect(foreignBinaries(root, target("freebsd-x64")).sort()).toEqual(["arm: elf/arm64", "linux: elf/x64"]);
});

function optionalVariant(platform: Record<string, unknown> = { os: ["linux"] }) {
	const f = fixture(), name = "foreign-variant", variant = join(f.app, "node_modules", name);
	put(join(f.app, "package.json"), JSON.stringify({ optionalDependencies: { [name]: "1.0.0" } }));
	put(join(variant, "package.json"), JSON.stringify({ name, ...platform }));
	put(join(variant, "index.js"), "module.exports = 'mandatory functionality';\n");
	return { ...f, name, variant };
}

test("FreeBSD rejects aliased incompatible instances without deleting mandatory or optional bytes", () => {
	const f = optionalVariant(), alias = join(f.app, "node_modules/must-keep");
	cpSync(f.variant, alias, { recursive: true });
	put(join(f.app, "package.json"), JSON.stringify({ dependencies: { "must-keep": "npm:foreign-variant@1.0.0" }, optionalDependencies: { [f.name]: "1.0.0" } }));
	const before = readFileSync(join(alias, "index.js"));
	expect(() => prunePrebuilds(f.app, target("freebsd-x64"))).toThrow(/required or unclassified/);
	expect(readFileSync(join(alias, "index.js"))).toEqual(before);
	expect(existsSync(f.variant)).toBe(true);
});

test("FreeBSD rejects malformed optional dependency containers before deleting required bytes", () => {
	for (const optionalDependencies of ["x", ["1.0.0"], null, true, 1]) {
		const f = fixture(), name = "0", variant = join(f.app, "node_modules", name), file = join(variant, "index.js");
		put(join(f.app, "package.json"), JSON.stringify({ dependencies: { [name]: "1.0.0" }, optionalDependencies }));
		put(join(variant, "package.json"), JSON.stringify({ name, os: ["linux"] }));
		put(file, "module.exports = 'mandatory functionality';\n");
		const before = readFileSync(file);
		expect(() => prunePrebuilds(f.app, target("freebsd-x64"))).toThrow(/invalid optionalDependencies/);
		expect(readFileSync(file)).toEqual(before);
	}
});

test("FreeBSD required peers prevent deletion; explicitly optional peers do not", () => {
	for (const optional of [false, true]) {
		const f = optionalVariant();
		put(join(f.app, "node_modules/consumer/package.json"), JSON.stringify({ name: "consumer", peerDependencies: { [f.name]: "1.0.0" }, peerDependenciesMeta: { [f.name]: { optional } } }));
		if (optional) expect(prunePrebuilds(f.app, target("freebsd-x64"))).toContain(`node_modules/${f.name}`);
		else {
			expect(() => prunePrebuilds(f.app, target("freebsd-x64"))).toThrow(/required or unclassified/);
			expect(existsSync(join(f.variant, "index.js"))).toBe(true);
		}
	}
});

test("FreeBSD validates both complete platform arrays before deleting anything", () => {
	for (const platform of [{ os: ["linux", null] }, { os: ["linux"], cpu: ["x64", null] }, { os: ["any"], cpu: ["arm64", false] }, { os: "linux" }, { cpu: null }, { os: ["linux", ""] }]) {
		const f = optionalVariant(platform);
		expect(() => prunePrebuilds(f.app, target("freebsd-x64"))).toThrow(/invalid.*(os|cpu)/);
		expect(existsSync(join(f.variant, "index.js"))).toBe(true);
	}
});

test("FreeBSD authorizes the resolved optional instance, not a same-name hoisted instance", () => {
	for (const requiredHoisted of [false, true]) {
		const f = optionalVariant({ os: requiredHoisted ? ["any"] : ["linux"] }), nested = join(f.app, "node_modules/owner/node_modules", f.name);
		put(join(f.app, "package.json"), JSON.stringify(requiredHoisted ? { dependencies: { [f.name]: "1.0.0" } } : {}));
		put(join(f.app, "node_modules/owner/package.json"), JSON.stringify({ name: "owner", optionalDependencies: { [f.name]: "1.0.0" } }));
		put(join(nested, "package.json"), JSON.stringify({ name: f.name, os: requiredHoisted ? ["linux"] : ["any"] }));
		if (requiredHoisted) {
			expect(prunePrebuilds(f.app, target("freebsd-x64"))).toContain(`node_modules/owner/node_modules/${f.name}`);
			expect(existsSync(nested)).toBe(false);
		} else {
			expect(() => prunePrebuilds(f.app, target("freebsd-x64"))).toThrow(/required or unclassified/);
			expect(existsSync(nested)).toBe(true);
		}
		expect(existsSync(join(f.variant, "index.js"))).toBe(true);
	}
});

test("FreeBSD keeps valid positive, negative and any OS/CPU restrictions", () => {
	for (const [platform, prune] of [[{ os: ["linux"] }, true], [{ os: ["!freebsd"] }, true], [{ os: ["any"] }, false], [{ os: ["any", "!freebsd"] }, true], [{ os: ["!linux"] }, false], [{ cpu: ["arm64"] }, true], [{ cpu: ["!x64"] }, true], [{ cpu: ["any"] }, false], [{ cpu: ["x64"] }, false]] as const) {
		const f = optionalVariant(platform);
		const removed = prunePrebuilds(f.app, target("freebsd-x64"));
		expect(removed.includes(`node_modules/${f.name}`)).toBe(prune);
		expect(existsSync(f.variant)).toBe(!prune);
	}
});

test("FreeBSD rejects ownership obscured by an unclassified lookup directory", () => {
	const f = optionalVariant(), owner = join(f.app, "node_modules/consumer");
	put(join(owner, "package.json"), JSON.stringify({ name: "consumer", peerDependencies: { [f.name]: "1.0.0" } }));
	mkdirSync(join(owner, "node_modules", f.name), { recursive: true });
	expect(() => prunePrebuilds(f.app, target("freebsd-x64"))).toThrow(/required or unclassified/);
	expect(existsSync(join(f.variant, "index.js"))).toBe(true);
});

test("FreeBSD does not treat a scope container as an optional installed package", () => {
	const f = fixture(), scope = join(f.app, "node_modules/@scope"), mandatory = join(scope, "must-keep/index.js");
	put(join(f.app, "package.json"), JSON.stringify({ dependencies: { "@scope/must-keep": "1.0.0" }, optionalDependencies: { "@scope": "1.0.0" } }));
	put(join(scope, "package.json"), JSON.stringify({ name: "@scope", os: ["linux"] }));
	put(join(scope, "must-keep/package.json"), JSON.stringify({ name: "@scope/must-keep" }));
	put(mandatory, "mandatory bytes\n");
	expect(() => prunePrebuilds(f.app, target("freebsd-x64"))).toThrow(/required or unclassified/);
	expect(readFileSync(mandatory, "utf8")).toBe("mandatory bytes\n");
});
