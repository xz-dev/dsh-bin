// Fill the manager-only Gentoo template from manager-index.json (schema 1).
// Asset filenames come from the index, not a runtime asset naming convention.
// usage: bun scripts/gentoo-ebuild.mjs <manager-index.json> <out-dir>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Gentoo PV for release / alpha.N / beta.N / rc.N manager SemVer; other prereleases refuse. */
export function gentooVersion(version) {
	const n = "(0|[1-9][0-9]*)";
	const m = new RegExp(`^${n}\\.${n}\\.${n}(?:-(alpha|beta|rc)\\.${n})?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`).exec(version);
	if (!m) throw new Error(`cannot map ${version} to a Gentoo version`);
	return `${m[1]}.${m[2]}.${m[3]}${m[4] ? `_${m[4]}${m[5]}` : ""}`;
}

export function gentooEbuild(index, template) {
	if (index.schema !== 1 || !Array.isArray(index.versions) || !index.versions.length) throw new Error("no manager-index schema 1 versions");
	for (const e of index.versions) {
		gentooVersion(e.version);
		if (e.tag !== `manager-v${e.version}` || !/^manager-v[0-9A-Za-z.+-]+$/.test(e.tag)) throw new Error("invalid manager identity");
	}
	const entries = [...index.versions].sort((a, b) => Bun.semver.order(b.version, a.version));
	for (let i = 1; i < entries.length; i++) if (Bun.semver.order(entries[i - 1].version, entries[i].version) === 0) throw new Error("ambiguous manager version");
	const manager = entries[0], pv = gentooVersion(manager.version);
	if (!manager.launchProtocols?.includes(2)) throw new Error("incompatible manager protocol");
	let ebuild = template.replaceAll("@TAG@", manager.tag);
	const dist = [["linux-x64", "AMD64"], ["linux-arm64", "ARM64"]].map(([target, arch]) => {
		const a = manager.assets?.[target];
		if (!a || !/^[0-9A-Za-z][0-9A-Za-z._+-]*\.zip$/.test(a.name) || !Number.isSafeInteger(a.size) || a.size <= 0 || !/^[0-9a-fA-F]{64}$/.test(a.sha256)) throw new Error(`${target}: invalid manager asset`);
		ebuild = ebuild.replaceAll(`@${arch}_ASSET@`, a.name);
		return `DIST ${manager.tag}-${target}.zip ${a.size} SHA256 ${a.sha256}`;
	});
	return { pv, ebuild, manifest: `${dist.join("\n")}\n` };
}

if (import.meta.main) {
	const [indexPath, out] = process.argv.slice(2);
	if (!indexPath || !out) throw new Error("usage: gentoo-ebuild.mjs <manager-index.json> <out-dir>");
	const tpl = readFileSync(join(import.meta.dir, "../packaging/gentoo/dsh-bin-9999.ebuild.in"), "utf8");
	const r = gentooEbuild(JSON.parse(readFileSync(indexPath, "utf8")), tpl);
	mkdirSync(out, { recursive: true });
	writeFileSync(join(out, `dsh-bin-${r.pv}.ebuild`), r.ebuild);
	writeFileSync(join(out, "Manifest"), r.manifest);
	console.log(`dsh-bin-${r.pv}.ebuild`);
}
