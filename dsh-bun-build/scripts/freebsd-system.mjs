// Fixed rc.2 system/flock component only. No app rebuild, fallback or runtime tool lookup.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { binaryArch, isFreebsdElf } from "./binary-arch.mjs";

export const SYSTEM_SOURCE = { commit: "639ed015397290b3745d163aafe02ffee4aa3f84", version: "0.1.2", flockSha256: "c1aa773c7a62b03ce3973156b928f41773fef9407afd79d71b2f625b5616421f" };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const json = file => JSON.parse(readFileSync(file, "utf8"));
const save = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const packageName = arch => `@deepseek-ai/node-addon-system-freebsd-${arch}`;
const guard = "platform !== 'linux' && platform !== 'darwin'";
const freebsdGuard = `${guard} && platform !== 'freebsd'`;
// Official node-v24.0.0 headers archive SHA: 4605ee37eef345568f43de8c1843f3f7a243865654c1e942c50584de6bd59bb5.
const HEADERS = {
	"node_api.h": "d14db85d16f182045c42745a6e44b96e932dfe6e3bfcaac7a1096fae8412c579",
	"node_api_types.h": "8d5d854088d5725fec9775510e0aeeeb790a41ad083c49bb721d950b86e6bd61",
	"js_native_api.h": "048b4efdcd823f30afd323d61c8aba5be285077f9d790feb52a6fa6382df2541",
	"js_native_api_types.h": "0410c31e227f81e2981363c4d543f4832ac3df785343ec64cee621742ff8a034",
	"node_version.h": "57c49e74c909c33a852462ac29c61c727faa9ce393255872c47a0d635e662cca",
};
const FLAGS = ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-fPIC", "-fvisibility=hidden", "-DNAPI_VERSION=8"];
const ABI_SOURCE = '__attribute__((section(".note.ABI-tag"), used, aligned(4))) static const struct { unsigned namesz, descsz, type; char name[8]; unsigned version; } abi = {8, 4, 1, "FreeBSD", 1501000};\n';

function inspectElf(binary, arch) {
	const bytes = readFileSync(binary);
	if (!isFreebsdElf(bytes) || binaryArch(bytes).arch !== arch || bytes.readUInt16LE(16) !== 3) throw new Error("FreeBSD system payload must be matching FreeBSD shared ELF");
	// Build/assembly tool only. Reject readelf warnings as well as malformed-table errors.
	const result = spawnSync("/usr/bin/readelf", ["-h", "-l", "-S", "-d", "--dyn-syms", "--wide", binary], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, timeout: 30_000 });
	if (result.error || result.status !== 0 || result.stderr.trim()) throw new Error(`invalid FreeBSD system ELF: ${result.stderr || result.error}`);
	const text = result.stdout;
	if (!/^\s*LOAD\s/m.test(text) || !/^\s*DYNAMIC\s/m.test(text)) throw new Error("FreeBSD system ELF lacks load/dynamic segments");
	for (const symbol of ["napi_register_module_v1", "node_api_module_get_api_version_v1"]) {
		if (!text.split("\n").some(line => {
			const match = /^\s*\d+:\s+[0-9a-f]+\s+\d+\s+FUNC\s+GLOBAL\s+DEFAULT\s+(\d+)\s+(\S+)\s*$/.exec(line);
			return match && Number(match[1]) > 0 && match[2] === symbol;
		})) throw new Error(`FreeBSD system missing defined Node-API export: ${symbol}`);
	}
	const dependencies = [...text.matchAll(/\(NEEDED\).*?\[([^\]]+)\]/g)].map(m => m[1]).sort();
	if (JSON.stringify(dependencies) !== '["libc.so.7"]') throw new Error("FreeBSD system actual DT_NEEDED must be libc.so.7 only");
	return dependencies;
}

export function adaptFreebsdSystemLoader(text) {
	const source = text.replace(freebsdGuard, guard);
	if (hash(source) !== "e42af00c298d56322c073bf7cc66485096028318ab645a2e69dc2aa7481ba646") throw new Error("system flock loader source changed");
	return source.replace(guard, freebsdGuard);
}

// expected comes from a trusted build return value or independently authenticated artifact receipt.
// Never derive it from the package being checked; a package's own checksums are not authority.
export function verifyFreebsdSystemPackage(dir, arch, expected) {
	if (!expected || expected.platform !== `freebsd-${arch}` || ![expected.sha256, expected.provenanceSha256].every(value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value))) throw new Error("independently trusted FreeBSD system receipt required");
	if (!["x64", "arm64"].includes(arch)) throw new Error("invalid FreeBSD system architecture");
	const provenanceBytes = readFileSync(join(dir, "provenance.json"));
	const meta = json(join(dir, "package.json")), prebuilds = json(join(dir, "prebuilds.json")), provenance = JSON.parse(provenanceBytes);
	const bytes = readFileSync(join(dir, "bin/system.node"));
	if (meta.name !== packageName(arch) || meta.version !== SYSTEM_SOURCE.version || JSON.stringify(meta.os) !== '["freebsd"]' || JSON.stringify(meta.cpu) !== JSON.stringify([arch])) throw new Error("FreeBSD system package identity mismatch");
	const declaration = { platform: `freebsd-${arch}`, binaries: [{ tool: "flock", kind: "node-api", napi: 8, path: "bin/system.node" }] };
	if (JSON.stringify(prebuilds) !== JSON.stringify(declaration)) throw new Error("FreeBSD system prebuild declaration mismatch");
	inspectElf(join(dir, "bin/system.node"), arch);
	if (hash(bytes) !== expected.sha256 || hash(provenanceBytes) !== expected.provenanceSha256) throw new Error("FreeBSD system trusted artifact identity mismatch");
	if (provenance.source?.commit !== SYSTEM_SOURCE.commit || provenance.source?.version !== SYSTEM_SOURCE.version || provenance.source?.flockSha256 !== SYSTEM_SOURCE.flockSha256 || provenance.sha256 !== hash(bytes) || provenance.napi !== 8 || JSON.stringify(provenance.dependencies) !== '["libc.so.7"]') throw new Error("FreeBSD system provenance/hash/dependencies mismatch");
	if (!Object.entries(HEADERS).every(([name, digest]) => provenance.headers?.[name] === digest) || provenance.abiNoteSha256 !== hash(ABI_SOURCE) || typeof provenance.compiler !== "string" || !isAbsolute(provenance.compiler) || !Array.isArray(provenance.args) || !FLAGS.every(flag => provenance.args.includes(flag)) || provenance.args.some(arg => /NAPI_VERSION/.test(arg) && arg !== "-DNAPI_VERSION=8")) throw new Error("FreeBSD system fixed source/header/API8 build provenance required");
	return provenance;
}

/** Called on the assembly COPY only; original certified app bytes remain untouched. */
export function installFreebsdSystem(app, arch, component) {
	const entry = join(app, "node_modules/@deepseek-ai/node-addon-system");
	if (!existsSync(entry)) throw new Error("FreeBSD system entry required");
	if (!component) throw new Error("FreeBSD system component required");
	const provenance = verifyFreebsdSystemPackage(component.directory, arch, component.expected);
	const meta = json(join(entry, "package.json"));
	if (meta.version !== SYSTEM_SOURCE.version) throw new Error("unsupported system entry version");
	const loader = join(entry, "lib/flock.js"), original = readFileSync(loader, "utf8");
	const adapted = adaptFreebsdSystemLoader(original);
	const destination = join(app, "node_modules", packageName(arch));
	if (existsSync(destination)) throw new Error("FreeBSD system package already staged");
	cpSync(component.directory, destination, { recursive: true });
	writeFileSync(loader, adapted);
	meta.optionalDependencies = { ...meta.optionalDependencies, [packageName(arch)]: SYSTEM_SOURCE.version };
	save(join(entry, "package.json"), meta);
	save(join(destination, "loader-provenance.json"), { source: provenance.source, before: hash(original), after: hash(adapted) });
}

/** cc may be native /usr/bin/cc or absolute Zig with explicit cross-target args. */
export function buildFreebsdSystem(source, headers, arch, out, compiler, compilerArgs = []) {
	if (!["x64", "arm64"].includes(arch) || !isAbsolute(compiler)) throw new Error("FreeBSD system requires x64|arm64 and absolute compiler");
	if (existsSync(out)) throw new Error("system component output exists");
	const c = join(resolve(source), "packages/entry/src/flock.c");
	if (hash(readFileSync(c)) !== SYSTEM_SOURCE.flockSha256 || json(join(source, "packages/entry/package.json")).version !== SYSTEM_SOURCE.version) throw new Error("fixed system source mismatch");
	const headerHashes = Object.fromEntries(Object.keys(HEADERS).map(file => [file, hash(readFileSync(join(headers, file)))]));
	if (!Object.entries(HEADERS).every(([name, digest]) => headerHashes[name] === digest)) throw new Error("authenticated Node 24.0.0 headers required");
	mkdirSync(join(out, "bin"), { recursive: true });
	const binary = join(resolve(out), "bin/system.node");
	// Shared objects have no crt1 ABI note. Declare the actual compiler target's 15.1 ABI.
	const abi = join(resolve(out), "freebsd-abi.c");
	writeFileSync(abi, ABI_SOURCE);
	const args = [...compilerArgs, ...FLAGS, "-I", resolve(headers), "-shared", "-o", binary, c, abi, "-lc"];
	try { execFileSync(compiler, args, { stdio: "inherit" }); } finally { rmSync(abi); }
	const dependencies = inspectElf(binary, arch);
	save(join(out, "package.json"), { name: packageName(arch), version: SYSTEM_SOURCE.version, type: "module", description: `FreeBSD ${arch} POSIX flock Node-API binding`, os: ["freebsd"], cpu: [arch], files: ["bin/", "prebuilds.json", "provenance.json", "LICENSE"], license: "BSD-3-Clause", engines: { node: ">=20" }, repository: { type: "git", url: "git+https://github.com/deepseek-ai/deepseek-harness.git", directory: `native/system/packages/freebsd-${arch}` } });
	cpSync(join(source, "LICENSE"), join(out, "LICENSE"));
	save(join(out, "prebuilds.json"), { platform: `freebsd-${arch}`, binaries: [{ tool: "flock", kind: "node-api", napi: 8, path: "bin/system.node" }] });
	save(join(out, "provenance.json"), { source: SYSTEM_SOURCE, abiNoteSha256: hash(ABI_SOURCE), napi: 8, sha256: hash(readFileSync(binary)), dependencies, compiler, args, headers: headerHashes });
	// Return receipt separately; callers must retain/authenticate it outside the package.
	const expected = { platform: `freebsd-${arch}`, sha256: hash(readFileSync(binary)), provenanceSha256: hash(readFileSync(join(out, "provenance.json"))) };
	verifyFreebsdSystemPackage(out, arch, expected);
	return expected;
}

if (import.meta.main) {
	const [source, headers, arch, out, compiler, ...args] = process.argv.slice(2);
	if (!compiler) throw new Error("usage: freebsd-system.mjs <native/system> <Node24 include/node> <x64|arm64> <out> <absolute-cc> [cc-prefix-args...]");
	console.log(JSON.stringify(buildFreebsdSystem(source, headers, arch, out, compiler, args), null, 2));
}
