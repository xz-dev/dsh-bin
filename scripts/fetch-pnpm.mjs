// Download the upstream-declared pnpm from the official pnpm/pnpm GitHub release, verify its
// digest against GitHub's release metadata, and keep only the platform-neutral dist/.
// usage: bun scripts/fetch-pnpm.mjs <upstream-src> <target-id> <out-dir>
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { target } from "./targets.mjs";

// pnpm/reflink v0.1.19 predates GitHub asset digests; pinned here (verified equal to
// the arm64 binary pnpm itself bundles, byte for byte).
const REFLINK = { version: "0.1.19", "reflink.darwin-x64.node": "e107629c8000ad509954bdc84e4bb8fec38453c210d8a4370a9fadb28aff5b97" };

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

export function pnpmVersion(src) {
	const pm = JSON.parse(readFileSync(join(src, "package.json"), "utf8")).packageManager ?? "";
	const m = /^pnpm@([0-9]+\.[0-9]+\.[0-9]+[^+]*)/.exec(pm);
	if (!m) throw new Error(`upstream packageManager is not pnpm: ${pm}`);
	return m[1];
}

/** Throws unless bytes match the expected "sha256:<hex>" (or bare hex) digest. */
export function verifyDigest(bytes, expected, name) {
	const want = String(expected ?? "").replace(/^sha256:/, "");
	if (!/^[0-9a-f]{64}$/.test(want)) throw new Error(`no sha256 digest published for ${name}`);
	const got = sha256(bytes);
	if (got !== want) throw new Error(`sha256 mismatch for ${name}: got ${got}, want ${want}`);
}

async function download(url) {
	const res = await fetch(url, { redirect: "follow" });
	if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
	return new Uint8Array(await res.arrayBuffer());
}

async function releaseDigest(repo, tag, name) {
	// Release metadata is read with gh (authenticated in CI) to avoid anonymous API limits.
	const out = execFileSync("gh", ["api", `repos/${repo}/releases/tags/${tag}`, "--jq", `.assets[] | select(.name == "${name}") | .digest`], { encoding: "utf8" }).trim();
	return out;
}

export async function fetchPnpm(src, targetId, outDir) {
	const t = target(targetId);
	const version = pnpmVersion(src);
	const tag = `v${version}`;
	const bytes = await download(`https://github.com/pnpm/pnpm/releases/download/${tag}/${t.pnpmAsset}`);
	verifyDigest(bytes, await releaseDigest("pnpm/pnpm", tag, t.pnpmAsset), t.pnpmAsset);

	outDir = resolve(outDir);
	mkdirSync(dirname(outDir), { recursive: true });
	const tmp = mkdtempSync(`${outDir}.tmp-`); // same filesystem as outDir for rename
	try {
		const archive = join(tmp, t.pnpmAsset);
		writeFileSync(archive, bytes);
		const ex = join(tmp, "x");
		mkdirSync(ex);
		if (t.pnpmAsset.endsWith(".zip")) execFileSync("unzip", ["-q", archive, "-d", ex]);
		else execFileSync("tar", ["-xzf", archive, "-C", ex]);
		for (const p of t.pnpmDrop ?? []) rmSync(join(ex, p), { recursive: true, force: true });
		if (t.reflinkAsset) {
			const node = await download(`https://github.com/pnpm/reflink/releases/download/v${REFLINK.version}/${t.reflinkAsset}`);
			verifyDigest(node, REFLINK[t.reflinkAsset], t.reflinkAsset);
			const dir = join(ex, "dist/node_modules/@reflink", `reflink-${t.nodePlatform}-${t.arch}`);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, t.reflinkAsset), node);
			writeFileSync(
				join(dir, "package.json"),
				`${JSON.stringify({ name: `@reflink/reflink-${t.nodePlatform}-${t.arch}`, version: REFLINK.version, os: [t.nodePlatform], cpu: [t.arch], main: t.reflinkAsset, license: "MIT" }, null, 2)}\n`,
			);
		}
		rmSync(outDir, { recursive: true, force: true });
		mkdirSync(outDir, { recursive: true });
		renameSync(join(ex, "dist"), join(outDir, "dist"));
		writeFileSync(join(outDir, "pnpm-source.json"), `${JSON.stringify({ version, asset: t.pnpmAsset, sha256: sha256(bytes) }, null, 2)}\n`);
		return { version, asset: t.pnpmAsset };
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const [src, id, out] = process.argv.slice(2);
	if (!src || !id || !out) throw new Error("usage: fetch-pnpm.mjs <upstream-src> <target-id> <out-dir>");
	console.log(JSON.stringify(await fetchPnpm(src, id, out)));
}
