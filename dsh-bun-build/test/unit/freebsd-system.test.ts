import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { adaptFreebsdSystemLoader, installFreebsdSystem, SYSTEM_SOURCE, verifyFreebsdSystemPackage } from "../../scripts/freebsd-system.mjs";
import { localBuild } from "../../scripts/local-build.mjs";

const loader = readFileSync(join(import.meta.dir, "../fixtures/system-flock.js"), "utf8");

test("FreeBSD loader remains lazy, selects only matching package, rejects unsupported OS", () => {
	const dir = mkdtempSync(join(tmpdir(), "system-loader-"));
	try {
		const file = join(dir, "flock.mjs");
		const patched = adaptFreebsdSystemLoader(loader);
		expect(adaptFreebsdSystemLoader(patched)).toBe(patched);
		writeFileSync(file, patched);
		for (const platform of ["freebsd", "openbsd", "win32", "linux", "darwin"]) {
			const script = `Object.defineProperty(process, 'platform', {value:${JSON.stringify(platform)}}); Object.defineProperty(process, 'arch', {value:'arm64'}); const m = await import(${JSON.stringify(file)}); console.log('imported'); try { await m.tryLockExclusive(7); } catch(e) { console.log(e.code); console.log(e.message); }`;
			const p = Bun.spawnSync([process.execPath, "-e", script]);
			expect(p.exitCode).toBe(0);
			const text = p.stdout.toString();
			expect(text).toContain("imported");
			if (["openbsd", "win32"].includes(platform)) expect(text).toContain("ERR_FLOCK_UNSUPPORTED_PLATFORM");
			else {
				expect(text).not.toContain("ERR_FLOCK_UNSUPPORTED_PLATFORM");
				expect(text).toContain(`node-addon-system-${platform}-arm64`);
			}
		}
		expect(() => adaptFreebsdSystemLoader(loader.replace("platform !== 'darwin'", "platform != 'darwin'"))).toThrow(/loader.*changed/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

// Deliberately invalid ELF with convincing strings/claims must never become a positive fixture.
function packageFixture(dir: string) {
	const bytes = Buffer.alloc(256);
	bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 9]);
	bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(0x3e, 18);
	bytes.write("napi_register_module_v1\0node_api_module_get_api_version_v1\0", 64);
	mkdirSync(join(dir, "bin"));
	const write = (name: string, value: unknown) => writeFileSync(join(dir, name), JSON.stringify(value));
	writeFileSync(join(dir, "bin/system.node"), bytes);
	write("package.json", { name: "@deepseek-ai/node-addon-system-freebsd-x64", version: "0.1.2", os: ["freebsd"], cpu: ["x64"] });
	write("prebuilds.json", { platform: "freebsd-x64", binaries: [{ tool: "flock", kind: "node-api", napi: 8, path: "bin/system.node" }] });
	write("provenance.json", { source: SYSTEM_SOURCE, napi: 8, dependencies: ["libc.so.7"], sha256: createHash("sha256").update(bytes).digest("hex") });
	return { platform: "freebsd-x64", sha256: createHash("sha256").update(bytes).digest("hex"), provenanceSha256: createHash("sha256").update(readFileSync(join(dir, "provenance.json"))).digest("hex") };
}

test("header-only fake ELF rejects even when caller pins its claimed identity", () => {
	const dir = mkdtempSync(join(tmpdir(), "system-package-"));
	try {
		const expected = packageFixture(dir);
		expect(() => verifyFreebsdSystemPackage(dir, "x64")).toThrow(/trusted.*receipt/);
		expect(() => verifyFreebsdSystemPackage(dir, "x64", expected)).toThrow(/ELF/);
		expect(() => verifyFreebsdSystemPackage(dir, "arm64", expected)).toThrow(/receipt/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("install fails before loader mutation without authenticated component; unrelated loader rejects", () => {
	const dir = mkdtempSync(join(tmpdir(), "system-install-"));
	try {
		const app = join(dir, "app"), entry = join(app, "node_modules/@deepseek-ai/node-addon-system");
		mkdirSync(join(entry, "lib"), { recursive: true });
		writeFileSync(join(entry, "package.json"), JSON.stringify({ version: "0.1.2" }));
		writeFileSync(join(entry, "lib/flock.js"), loader);
		expect(() => installFreebsdSystem(app, "x64")).toThrow(/component required/);
		const component = join(dir, "component"); mkdirSync(component);
		const expected = packageFixture(component);
		expect(() => installFreebsdSystem(app, "x64", { directory: component })).toThrow(/trusted.*receipt/);
		expect(() => installFreebsdSystem(app, "x64", { directory: component, expected })).toThrow(/ELF/);
		expect(readFileSync(join(entry, "lib/flock.js"), "utf8")).toBe(loader);
		expect(() => adaptFreebsdSystemLoader(loader.replace("loadBinding().tryLock(fd, resolve)", "resolve(0)"))).toThrow(/source changed/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("local FreeBSD build requires independent component receipt before filesystem/compile work", () => {
	for (const targetId of ["freebsd-x64", "freebsd-arm64"]) {
		expect(() => localBuild({ targetId })).toThrow(/trusted.*receipt/);
		expect(() => localBuild({ targetId, system: { directory: "/missing/component" } })).toThrow(/trusted.*receipt/);
	}
});

test("native-runner source build refuses missing component before upstream work", () => {
	const script = `Object.defineProperty(process, 'platform', {value:'freebsd'}); Object.defineProperty(process, 'arch', {value:'x64'}); const {buildTarget} = await import(${JSON.stringify(join(import.meta.dir, "../../scripts/build-target.mjs"))}); try { await buildTarget({targetId:'freebsd-x64'}); } catch (error) { console.log(error.message); }`;
	const result = Bun.spawnSync([process.execPath, "-e", script]);
	expect(result.exitCode).toBe(0);
	expect(result.stdout.toString()).toContain("independently trusted FreeBSD system receipt required");
});
