// Office addon release assets (D7b, release-distribution "Office addon"): one ZIP per addon platform,
// each `addon.json` + `node_modules/` holding the kit's JS closure (split out of the frozen deploy by
// split-addon.mjs) plus exactly one engine package. Engine tarballs are the only registry bytes; each
// must match the sha512 integrity upstream's pnpm-lock.yaml pins, or the build aborts.
// usage: bun scripts/build-addon.mjs <addon-tree> <upstream-src> <out-dir> <identity-json> [--platforms linux,darwin-arm64,...]
//   identity-json: {"version","tag","slot":{"commit","kitVersion"}}
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { archive } from "./archive.mjs";
import { sha256 } from "./fetch-pnpm.mjs";
import { checkLockfile, readLockfile } from "./lockfile-guard.mjs";

export const KIT = "@deepseek-ai/libreoffice-kit";
/** Addon platform → engine package suffix. Linux uses the portable WASM engine on every arch. */
export const ADDON_PLATFORMS = Object.freeze({
	linux: "wasm",
	"darwin-arm64": "darwin-arm64",
	"darwin-x64": "darwin-x64",
	"windows-x64": "win32-x64",
	"windows-arm64": "win32-arm64",
});
const REGISTRY = "https://registry.npmjs.org";

export const tarballUrl = (name, version) => `${REGISTRY}/${name}/-/${name.split("/")[1]}-${version}.tgz`;

/** Throw unless `bytes` match an npm `sha512-<base64>` integrity. */
export function verifyIntegrity(bytes, integrity, what) {
	const actual = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
	if (actual !== integrity) throw new Error(`${what}: integrity mismatch (lockfile ${integrity}, got ${actual})`);
}

/** Extract an npm tarball's `package/` into `dest`. */
async function unpackTarball(bytes, dest) {
	const files = await new Bun.Archive(bytes).files();
	for (const [path, file] of files) {
		if (!path.startsWith("package/")) continue;
		const rel = path.slice("package/".length);
		if (!rel || rel.split("/").includes("..")) throw new Error(`unsafe tarball entry ${path}`);
		const out = join(dest, rel);
		mkdirSync(dirname(out), { recursive: true });
		writeFileSync(out, new Uint8Array(await file.arrayBuffer()));
	}
}

const engineDirs = (tree) => {
	const scope = join(tree, "node_modules/@deepseek-ai");
	return existsSync(scope) ? readdirSync(scope).filter((n) => n.startsWith("libreoffice-kit-")).map((n) => join(scope, n)) : [];
};

/**
 * @param {{tree: string, office: Record<string,{version:string,integrity:string}>, out: string,
 *   identity: {version:string, tag:string, slot:{commit:string,kitVersion:string}}, platforms?: string[],
 *   fetchBytes?: (url: string) => Promise<Uint8Array>}} spec
 * @returns the addon release manifest `{tag, version, slot, assets: {<platform>: {file, size, sha256}}}`
 */
export async function buildAddon({ tree, office, out, identity, platforms = Object.keys(ADDON_PLATFORMS), fetchBytes }) {
	const base = JSON.parse(readFileSync(join(tree, "addon.json"), "utf8"));
	if (office[KIT]?.version !== base.kitVersion) throw new Error(`addon tree kit ${base.kitVersion} is not the lockfile's ${office[KIT]?.version}`);
	if (identity.slot?.kitVersion !== base.kitVersion) throw new Error(`slot kit ${identity.slot?.kitVersion} is not the tree's ${base.kitVersion}`);
	fetchBytes ??= async (url) => {
		const r = await fetch(url);
		if (!r.ok) throw new Error(`GET ${url}: HTTP ${r.status}`);
		return new Uint8Array(await r.arrayBuffer());
	};
	mkdirSync(out, { recursive: true });
	const assets = {};
	for (const platform of platforms) {
		const suffix = ADDON_PLATFORMS[platform];
		if (!suffix) throw new Error(`unknown addon platform ${platform}`);
		const engine = `${KIT}-${suffix}`;
		const locked = office[engine];
		if (!locked) throw new Error(`${engine} is not locked in pnpm-lock.yaml`);
		const root = join(out, `.addon-${platform}`);
		rmSync(root, { recursive: true, force: true });
		cpSync(tree, root, { recursive: true });
		for (const dir of engineDirs(root)) rmSync(dir, { recursive: true, force: true });
		const bytes = await fetchBytes(tarballUrl(engine, locked.version));
		verifyIntegrity(bytes, locked.integrity, `${engine}@${locked.version}`);
		await unpackTarball(bytes, join(root, "node_modules", engine));
		const packages = base.packages.filter((p) => !p.startsWith(`${KIT}-`)).concat(`${engine}@${locked.version}`).sort();
		const meta = { name: "office", version: identity.version, tag: identity.tag, slot: identity.slot, kitVersion: base.kitVersion, platform, packages };
		writeFileSync(join(root, "addon.json"), `${JSON.stringify(meta, null, 2)}\n`);
		const file = `dsh-addon-office-${platform}.zip`;
		const zip = join(out, file);
		archive(root, zip);
		rmSync(root, { recursive: true, force: true });
		assets[platform] = { file, size: statSync(zip).size, sha256: sha256(readFileSync(zip)) };
	}
	const manifest = { tag: identity.tag, version: identity.version, slot: identity.slot, assets };
	writeFileSync(join(out, "addon-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	return manifest;
}

if (import.meta.main) {
	const [tree, src, out, identity, ...rest] = process.argv.slice(2);
	if (!tree || !src || !out || !identity) throw new Error("usage: build-addon.mjs <addon-tree> <upstream-src> <out-dir> <identity-json> [--platforms a,b]");
	const i = rest.indexOf("--platforms");
	const platforms = i >= 0 ? rest[i + 1].split(",") : undefined;
	const { office } = checkLockfile(readLockfile(src));
	const m = await buildAddon({ tree: resolve(tree), office, out: resolve(out), identity: JSON.parse(identity), platforms });
	console.log(JSON.stringify(m, null, 2));
}
