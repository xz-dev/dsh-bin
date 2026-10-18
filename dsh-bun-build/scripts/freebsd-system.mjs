// Fixed rc.2 system/flock component only. No app rebuild, fallback or runtime tool lookup.
import { execFileSync } from "node:child_process";
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

export function adaptFreebsdSystemLoader(text) {
	const source = text.replace(freebsdGuard, guard);
	if (source.split(guard).length !== 2 || !source.includes("ERR_FLOCK_UNSUPPORTED_PLATFORM") || !source.includes("@deepseek-ai/node-addon-system-${platform}-${arch}/package.json")) throw new Error("system flock loader source changed");
	return source.replace(guard, freebsdGuard);
}

export function verifyFreebsdSystemPackage(dir, arch) {
	if (!["x64", "arm64"].includes(arch)) throw new Error("invalid FreeBSD system architecture");
	const meta = json(join(dir, "package.json")), prebuilds = json(join(dir, "prebuilds.json")), provenance = json(join(dir, "provenance.json"));
	const bytes = readFileSync(join(dir, "bin/system.node"));
	if (meta.name !== packageName(arch) || meta.version !== SYSTEM_SOURCE.version || JSON.stringify(meta.os) !== '["freebsd"]' || JSON.stringify(meta.cpu) !== JSON.stringify([arch])) throw new Error("FreeBSD system package identity mismatch");
	const expected = { platform: `freebsd-${arch}`, binaries: [{ tool: "flock", kind: "node-api", napi: 8, path: "bin/system.node" }] };
	if (JSON.stringify(prebuilds) !== JSON.stringify(expected)) throw new Error("FreeBSD system prebuild declaration mismatch");
	if (!isFreebsdElf(bytes) || binaryArch(bytes).arch !== arch || bytes.readUInt16LE(16) !== 3) throw new Error("FreeBSD system payload must be matching FreeBSD shared ELF");
	for (const symbol of ["napi_register_module_v1", "node_api_module_get_api_version_v1"]) if (!bytes.includes(Buffer.from(`${symbol}\0`))) throw new Error(`FreeBSD system missing Node-API export: ${symbol}`);
	if (provenance.source?.commit !== SYSTEM_SOURCE.commit || provenance.source?.flockSha256 !== SYSTEM_SOURCE.flockSha256 || provenance.sha256 !== hash(bytes) || provenance.napi !== 8 || JSON.stringify(provenance.dependencies) !== '["libc.so.7"]') throw new Error("FreeBSD system provenance/hash/dependencies mismatch");
	return provenance;
}

/** Called on the assembly COPY only; original certified app bytes remain untouched. */
export function installFreebsdSystem(app, arch, component) {
	const entry = join(app, "node_modules/@deepseek-ai/node-addon-system");
	if (!existsSync(entry)) throw new Error("FreeBSD system entry required");
	if (!component) throw new Error("FreeBSD system component required");
	const provenance = verifyFreebsdSystemPackage(component, arch);
	const meta = json(join(entry, "package.json"));
	if (meta.version !== SYSTEM_SOURCE.version) throw new Error("unsupported system entry version");
	const loader = join(entry, "lib/flock.js"), original = readFileSync(loader, "utf8");
	const adapted = adaptFreebsdSystemLoader(original);
	const destination = join(app, "node_modules", packageName(arch));
	if (existsSync(destination)) throw new Error("FreeBSD system package already staged");
	cpSync(component, destination, { recursive: true });
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
	const headerFiles = ["node_api.h", "node_api_types.h", "js_native_api.h", "js_native_api_types.h", "node_version.h"];
	const headerHashes = Object.fromEntries(headerFiles.map(file => [file, hash(readFileSync(join(headers, file)))]));
	if (!/^#define NODE_MAJOR_VERSION 24$/m.test(readFileSync(join(headers, "node_version.h"), "utf8"))) throw new Error("Node 24 headers required");
	mkdirSync(join(out, "bin"), { recursive: true });
	const binary = join(resolve(out), "bin/system.node");
	// Shared objects have no crt1 ABI note. Declare the actual compiler target's 15.1 ABI.
	const abi = join(resolve(out), "freebsd-abi.c");
	const abiSource = '__attribute__((section(".note.ABI-tag"), used, aligned(4))) static const struct { unsigned namesz, descsz, type; char name[8]; unsigned version; } abi = {8, 4, 1, "FreeBSD", 1501000};\n';
	writeFileSync(abi, abiSource);
	const args = [...compilerArgs, "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-fPIC", "-fvisibility=hidden", "-DNAPI_VERSION=8", "-I", resolve(headers), "-shared", "-o", binary, c, abi, "-lc"];
	try { execFileSync(compiler, args, { stdio: "inherit" }); } finally { rmSync(abi); }
	// readelf is a build-time tool, never a product dependency.
	const readelf = "/usr/bin/readelf";
	const dynamic = execFileSync(readelf, ["-d", binary], { encoding: "utf8" });
	const dependencies = [...dynamic.matchAll(/\(NEEDED\).*?\[([^\]]+)\]/g)].map(m => m[1]).sort();
	const exports = execFileSync(readelf, ["--dyn-syms", "--wide", binary], { encoding: "utf8" });
	for (const symbol of ["napi_register_module_v1", "node_api_module_get_api_version_v1"]) if (!exports.split("\n").some(line => line.includes(symbol) && !line.includes(" UND "))) throw new Error(`missing exported ${symbol}`);
	save(join(out, "package.json"), { name: packageName(arch), version: SYSTEM_SOURCE.version, type: "module", description: `FreeBSD ${arch} POSIX flock Node-API binding`, os: ["freebsd"], cpu: [arch], files: ["bin/", "prebuilds.json", "provenance.json", "LICENSE"], license: "BSD-3-Clause", engines: { node: ">=20" }, repository: { type: "git", url: "git+https://github.com/deepseek-ai/deepseek-harness.git", directory: `native/system/packages/freebsd-${arch}` } });
	cpSync(join(source, "LICENSE"), join(out, "LICENSE"));
	save(join(out, "prebuilds.json"), { platform: `freebsd-${arch}`, binaries: [{ tool: "flock", kind: "node-api", napi: 8, path: "bin/system.node" }] });
	save(join(out, "provenance.json"), { source: SYSTEM_SOURCE, abiNoteSha256: hash(abiSource), napi: 8, sha256: hash(readFileSync(binary)), dependencies, compiler, args, headers: headerHashes });
	return verifyFreebsdSystemPackage(out, arch);
}

if (import.meta.main) {
	const [source, headers, arch, out, compiler, ...args] = process.argv.slice(2);
	if (!compiler) throw new Error("usage: freebsd-system.mjs <native/system> <Node24 include/node> <x64|arm64> <out> <absolute-cc> [cc-prefix-args...]");
	console.log(JSON.stringify(buildFreebsdSystem(source, headers, arch, out, compiler, args), null, 2));
}
