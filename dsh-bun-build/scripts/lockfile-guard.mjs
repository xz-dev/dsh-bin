// Build-time guard (design D2): first-party @deepseek-ai/* code must come from the source
// workspace. The only registry exception is the LibreOffice Kit allowlist, which must be
// pinned by an sha512 integrity in the upstream lockfile (and ships only in the office addon).
// usage: bun scripts/lockfile-guard.mjs <upstream-src>
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const OFFICE_ALLOWLIST = Object.freeze([
	"@deepseek-ai/libreoffice-kit",
	"@deepseek-ai/libreoffice-kit-wasm",
	"@deepseek-ai/libreoffice-kit-darwin-arm64",
	"@deepseek-ai/libreoffice-kit-darwin-x64",
	"@deepseek-ai/libreoffice-kit-win32-x64",
	"@deepseek-ai/libreoffice-kit-win32-arm64",
]);

const SCOPE = "@deepseek-ai/";
const isLocal = (v) => /^(link|file|workspace):/.test(String(v));

/** Split a lockfile package key `@scope/name@version(peer...)` into [name, version]. */
function splitKey(key) {
	const at = key.indexOf("@", 1);
	return [key.slice(0, at), key.slice(at + 1).replace(/\(.*$/, "")];
}

/**
 * @returns {{office: Record<string, {version: string, integrity: string}>}} allowlisted registry packages
 * @throws on any first-party registry resolution outside the allowlist, or an unpinned allowlisted one
 */
export function checkLockfile(lock) {
	const errors = [];
	const office = {};
	if (String(lock?.lockfileVersion) !== "9.0") errors.push(`unsupported lockfileVersion ${lock?.lockfileVersion}`);

	for (const [importer, sections] of Object.entries(lock.importers ?? {})) {
		for (const kind of ["dependencies", "devDependencies", "optionalDependencies"]) {
			for (const [name, dep] of Object.entries(sections?.[kind] ?? {})) {
				if (!name.startsWith(SCOPE) || isLocal(dep?.version)) continue;
				if (!OFFICE_ALLOWLIST.includes(name)) errors.push(`${importer}: ${name} resolves from a registry (${dep?.version})`);
			}
		}
	}
	for (const [name, spec] of Object.entries(lock.overrides ?? {})) {
		if (name.startsWith(SCOPE) && !isLocal(spec) && !OFFICE_ALLOWLIST.includes(name)) errors.push(`override ${name}: ${spec} is not a source link`);
	}
	for (const [key, pkg] of Object.entries(lock.packages ?? {})) {
		if (!key.startsWith(SCOPE)) continue;
		const [name, version] = splitKey(key);
		if (isLocal(version) || pkg?.resolution?.directory) continue;
		if (!OFFICE_ALLOWLIST.includes(name)) {
			errors.push(`package ${key} resolves from a registry`);
			continue;
		}
		const integrity = pkg?.resolution?.integrity;
		if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity ?? "") || pkg.resolution.tarball) {
			errors.push(`package ${key} is not pinned by a registry sha512 integrity`);
			continue;
		}
		if (office[name] && office[name].version !== version) errors.push(`${name} locked at two versions: ${office[name].version}, ${version}`);
		office[name] = { version, integrity };
	}
	if (errors.length) throw new Error(`lockfile guard failed:\n  ${errors.join("\n  ")}`);
	return { office };
}

export const readLockfile = (src) => Bun.YAML.parse(readFileSync(join(src, "pnpm-lock.yaml"), "utf8"));

if (import.meta.main) {
	const [src] = process.argv.slice(2);
	if (!src) throw new Error("usage: lockfile-guard.mjs <upstream-src>");
	console.log(JSON.stringify(checkLockfile(readLockfile(src)), null, 2));
}
