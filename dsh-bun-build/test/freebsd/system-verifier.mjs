// Real-artifact regression, no native execution. Receipts must come from independent build/archive identity.
// bun test/freebsd/system-verifier.mjs <x64-dir> <trusted-receipt.json> <arm64-dir> <trusted-receipt.json> <new-scratch>
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { verifyFreebsdSystemPackage, installFreebsdSystem } from "../../scripts/freebsd-system.mjs";
import { localBuild } from "../../scripts/local-build.mjs";
import { CONFIG_SITES, PROFILE_SITES, RULES } from "../../scripts/transform-app.mjs";

const [x64, x64Receipt, arm64, arm64Receipt, scratch] = process.argv.slice(2);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const json = file => JSON.parse(readFileSync(file, "utf8"));
const expected = json(x64Receipt);
mkdirSync(scratch); // Refuse to overwrite earlier evidence.
for (const [dir, arch, receipt] of [[x64, "x64", expected], [arm64, "arm64", json(arm64Receipt)]]) {
	assert.equal(verifyFreebsdSystemPackage(dir, arch, receipt).napi, 8);
	assert.throws(() => verifyFreebsdSystemPackage(dir, arch), /trusted.*receipt/);
	console.log(`${arch}: genuine package PASS; missing receipt rejects`);
}

// Mutation offsets from the review probe; never load or execute mutant code.
function symbol(bytes, name) {
	const base = Number(bytes.readBigUInt64LE(40)), stride = bytes.readUInt16LE(58), count = bytes.readUInt16LE(60);
	const sections = Array.from({ length: count }, (_, i) => {
		const at = base + i * stride;
		return { type: bytes.readUInt32LE(at + 4), addr: Number(bytes.readBigUInt64LE(at + 16)), offset: Number(bytes.readBigUInt64LE(at + 24)), size: Number(bytes.readBigUInt64LE(at + 32)), link: bytes.readUInt32LE(at + 40), stride: Number(bytes.readBigUInt64LE(at + 56)) };
	});
	const dyn = sections.find(s => s.type === 11), strings = sections[dyn.link];
	for (let at = dyn.offset; at < dyn.offset + dyn.size; at += dyn.stride) {
		const start = strings.offset + bytes.readUInt32LE(at);
		if (bytes.subarray(start, bytes.indexOf(0, start)).toString() !== name) continue;
		const section = sections[bytes.readUInt16LE(at + 6)];
		return { at, offset: section.offset + Number(bytes.readBigUInt64LE(at + 8)) - section.addr, size: Number(bytes.readBigUInt64LE(at + 16)) };
	}
	throw new Error(`fixture symbol missing: ${name}`);
}
const cases = [
	["nonbase-dependency", bytes => { const at = bytes.indexOf(Buffer.from("libc.so.7\0")); assert(at >= 0); bytes.write("libX.so.7\0", at); }, /actual DT_NEEDED/],
	["undefined-register", bytes => bytes.writeUInt16LE(0, symbol(bytes, "napi_register_module_v1").at + 6), /defined Node-API export/],
	["wrong-napi", bytes => { const s = symbol(bytes, "node_api_module_get_api_version_v1"); const at = bytes.indexOf(Buffer.from([0xb8, 8, 0, 0, 0]), s.offset); assert(at >= s.offset && at < s.offset + s.size); bytes.writeUInt32LE(9, at + 1); }, /trusted artifact identity/],
	["malformed-elf", bytes => { bytes.fill(0); bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 9]); bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(0x3e, 18); bytes.write("napi_register_module_v1\0node_api_module_get_api_version_v1\0", 64); }, /ELF/],
];
for (const [name, mutate, error] of cases) {
	const dir = join(scratch, name); cpSync(x64, dir, { recursive: true });
	const file = join(dir, "bin/system.node"), bytes = readFileSync(file); mutate(bytes); writeFileSync(file, bytes);
	const provenance = json(join(dir, "provenance.json")); provenance.sha256 = hash(bytes);
	writeFileSync(join(dir, "provenance.json"), JSON.stringify(provenance));
	assert.throws(() => verifyFreebsdSystemPackage(dir, "x64", expected), error);
	const app = join(scratch, `${name}-app`), entry = join(app, "node_modules/@deepseek-ai/node-addon-system");
	mkdirSync(join(entry, "lib"), { recursive: true });
	writeFileSync(join(entry, "package.json"), '{"version":"0.1.2"}');
	const loader = readFileSync(new URL("../fixtures/system-flock.js", import.meta.url));
	writeFileSync(join(entry, "lib/flock.js"), loader);
	assert.throws(() => installFreebsdSystem(app, "x64", { directory: dir, expected }), error);
	assert.deepEqual(readFileSync(join(entry, "lib/flock.js")), loader);
	console.log(`${name}: REJECTED by package and install seams; self-rehashed claims do not authorize payload`);
}
const stripped = join(scratch, "missing-build-provenance"); cpSync(x64, stripped, { recursive: true });
const provenance = json(join(stripped, "provenance.json"));
for (const field of ["headers", "compiler", "args", "abiNoteSha256"]) delete provenance[field];
writeFileSync(join(stripped, "provenance.json"), JSON.stringify(provenance));
assert.throws(() => verifyFreebsdSystemPackage(stripped, "x64", expected), /trusted artifact identity/);
// Even a mistakenly re-pinned metadata digest cannot replace the required fixed build facts.
assert.throws(() => verifyFreebsdSystemPackage(stripped, "x64", { ...expected, provenanceSha256: hash(readFileSync(join(stripped, "provenance.json"))) }), /build provenance/);
console.log("missing-build-provenance: REJECTED; PASS");

// Packaging-only caller fixture: synthetic app; native input never executed, no product-pass claim.
for (const [dir, arch, receipt] of [[x64, "x64", expected], [arm64, "arm64", json(arm64Receipt)]]) {
	const work = join(scratch, `caller-${arch}`), app = join(work, "app");
	const put = (file, value) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, value); };
	put(join(app, "package.json"), '{"name":"system-caller-fixture","version":"0.2.0-rc.2","type":"module"}');
	put(join(app, "lib/bin.js"), readFileSync(new URL("../fixtures/fixed-cli.js", import.meta.url)));
	for (const rule of RULES) for (const file of rule.files) put(join(app, file), rule.marker === "stripTypeScriptTypes" ? 'import { stripTypeScriptTypes } from "node:module";\n' : 'import { isSea } from "node:sea";\n');
	for (const [file, sites] of Object.entries(PROFILE_SITES)) put(join(app, file), [
		...Array(sites.dir ?? 0).fill('function profileDir(name, home) { return join(home, PROFILES_DIR, name); }'),
		...Array(sites.root ?? 0).fill('const profilesDir = join(home, PROFILES_DIR);'),
		...Array(sites.file ?? 0).fill('join(dir, PROFILE_PATCH_FILENAME);'),
	].join("\n"));
	for (const { file, from, count } of CONFIG_SITES) {
		const path = join(app, file);
		let text = ""; try { text = readFileSync(path, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
		put(path, text + "\n" + Array(count).fill(from).join("\n"));
	}
	const entry = join(app, "node_modules/@deepseek-ai/node-addon-system");
	put(join(entry, "package.json"), '{"name":"@deepseek-ai/node-addon-system","version":"0.1.2"}');
	const original = readFileSync(new URL("../fixtures/system-flock.js", import.meta.url));
	put(join(entry, "lib/flock.js"), original);
	put(join(work, `pnpm-freebsd-${arch}/dist/pnpm.mjs`), "// unused packaging fixture\n");
	const built = localBuild({ out: join(work, "out"), work, targetId: `freebsd-${arch}`, channel: "release", run: 1, upstreamCommit: "639ed015397290b3745d163aafe02ffee4aa3f84", upstreamCommitTime: "2026-09-01T00:00:00.000Z", upstreamVersion: "0.2.0-rc.2", native: join(dir, "bin/system.node"), system: { directory: dir, expected: receipt } });
	verifyFreebsdSystemPackage(join(built.root, `app/node_modules/@deepseek-ai/node-addon-system-freebsd-${arch}`), arch, receipt);
	assert.deepEqual(readFileSync(join(entry, "lib/flock.js")), original);
	console.log(`${arch}: localBuild -> assembleBundle -> installed component/receipt PASS; input untouched`);
}
