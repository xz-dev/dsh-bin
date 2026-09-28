// Fill packaging/gentoo/dsh-bin-9999.ebuild.in for the newest release-channel entry (9.2): writes
// `dsh-bin-<pv>.ebuild` and the matching `Manifest` DIST lines (SHA-256 from the index; Gentoo Manifests
// also want BLAKE2B/SHA512, which `ebuild … manifest` adds after downloading).
// usage: bun scripts/gentoo-ebuild.mjs <index.json> <out-dir>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Gentoo PV from a dsh-bin release version: 0.1.7-rc.2-xz.5.1.gabcdef12 → 0.1.7_rc2_p5 */
export function gentooVersion(version) {
	const m = /^(\d+\.\d+\.\d+)(?:-(alpha|beta|rc)\.?(\d+))?-xz\.(\d+)\.\d+\.g[0-9a-f]{8}$/.exec(version);
	if (!m) throw new Error(`cannot map ${version} to a Gentoo version`);
	return `${m[1]}${m[2] ? `_${m[2]}${m[3]}` : ""}_p${m[4]}`;
}

export function gentooEbuild(index, template) {
	const rel = [...index.channels.release].sort((a, b) => b.seq - a.seq)[0];
	if (!rel) throw new Error("no release-channel entry");
	const addon = index.addons.office.find((a) => a.version === rel.addons?.office?.pinned);
	if (!addon) throw new Error(`pinned office addon ${rel.addons?.office?.pinned} is not in the index`);
	const pv = gentooVersion(rel.version);
	const ebuild = template.replaceAll("@TAG@", rel.tag).replaceAll("@OFFICE_TAG@", addon.tag).replaceAll("@OFFICE_VERSION@", addon.version);
	const dist = [
		[`${rel.tag}-linux-x64-baseline.zip`, rel.assets["linux-x64-baseline"]],
		[`${rel.tag}-linux-arm64.zip`, rel.assets["linux-arm64"]],
		[`${addon.tag}-linux.zip`, addon.assets.linux],
	].map(([name, a]) => {
		if (!a) throw new Error(`${name}: asset missing from the index`);
		return `DIST ${name} ${a.size} SHA256 ${a.sha256}`;
	});
	return { pv, ebuild, manifest: `${dist.join("\n")}\n` };
}

if (import.meta.main) {
	const [indexPath, out] = process.argv.slice(2);
	if (!indexPath || !out) throw new Error("usage: gentoo-ebuild.mjs <index.json> <out-dir>");
	const tpl = readFileSync(join(import.meta.dir, "../packaging/gentoo/dsh-bin-9999.ebuild.in"), "utf8");
	const r = gentooEbuild(JSON.parse(readFileSync(indexPath, "utf8")), tpl);
	mkdirSync(out, { recursive: true });
	writeFileSync(join(out, `dsh-bin-${r.pv}.ebuild`), r.ebuild);
	writeFileSync(join(out, "Manifest"), r.manifest);
	console.log(`dsh-bin-${r.pv}.ebuild`);
}
