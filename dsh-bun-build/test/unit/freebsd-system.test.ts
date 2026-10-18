import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { adaptFreebsdSystemLoader, installFreebsdSystem, SYSTEM_SOURCE, verifyFreebsdSystemPackage } from "../../scripts/freebsd-system.mjs";

const loader = `import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
export async function tryLockExclusive(fd) {
	const { platform, arch } = process;
	if (platform !== 'linux' && platform !== 'darwin') {
		throw Object.assign(new Error('unsupported'), { code: 'ERR_FLOCK_UNSUPPORTED_PLATFORM' });
	}
	const require = createRequire(import.meta.url);
	const manifest = require.resolve(\`@deepseek-ai/node-addon-system-\${platform}-\${arch}/package.json\`);
	return require(join(dirname(manifest), 'bin', 'system.node')).tryLock(fd);
}`;

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

// Header-only package fixture exercises packaging gates, never native acceptance.
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
	return bytes;
}

test("FreeBSD package rejects foreign same-CPU ELF, wrong arch and changed payload", () => {
	const dir = mkdtempSync(join(tmpdir(), "system-package-"));
	try {
		const bytes = packageFixture(dir);
		expect(verifyFreebsdSystemPackage(dir, "x64").napi).toBe(8);
		expect(() => verifyFreebsdSystemPackage(dir, "arm64")).toThrow(/identity/);
		bytes[7] = 0; // Linux/System V, same CPU, no FreeBSD ABI note.
		writeFileSync(join(dir, "bin/system.node"), bytes);
		expect(() => verifyFreebsdSystemPackage(dir, "x64")).toThrow(/FreeBSD shared ELF/);
		bytes[7] = 9; bytes[255] = 1;
		writeFileSync(join(dir, "bin/system.node"), bytes);
		expect(() => verifyFreebsdSystemPackage(dir, "x64")).toThrow(/hash/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("assembly requires verified component; adapts copied entry and records exact loader hashes", () => {
	const dir = mkdtempSync(join(tmpdir(), "system-install-"));
	try {
		const app = join(dir, "app"), entry = join(app, "node_modules/@deepseek-ai/node-addon-system");
		mkdirSync(join(entry, "lib"), { recursive: true });
		writeFileSync(join(entry, "package.json"), JSON.stringify({ version: "0.1.2" }));
		writeFileSync(join(entry, "lib/flock.js"), loader);
		expect(() => installFreebsdSystem(app, "x64")).toThrow(/component required/);
		expect(readFileSync(join(entry, "lib/flock.js"), "utf8")).toBe(loader);
		const component = join(dir, "component"); mkdirSync(component);
		packageFixture(component);
		installFreebsdSystem(app, "x64", component);
		expect(readFileSync(join(entry, "lib/flock.js"), "utf8")).toContain("platform !== 'freebsd'");
		const installed = join(app, "node_modules/@deepseek-ai/node-addon-system-freebsd-x64");
		expect(verifyFreebsdSystemPackage(installed, "x64").napi).toBe(8);
		const provenance = JSON.parse(readFileSync(join(installed, "loader-provenance.json"), "utf8"));
		expect(provenance.before).toBe(createHash("sha256").update(loader).digest("hex"));
		expect(provenance.after).not.toBe(provenance.before);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
