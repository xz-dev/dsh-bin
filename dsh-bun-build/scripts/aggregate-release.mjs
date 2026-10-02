// Merge per-target release manifests (`<tag>.json` from build-target/local-build) into one
// `release-manifest.json` and `SHA256SUMS` next to the archives (8.1). All inputs must agree on the
// release identity; each target appears once; every archive's size and SHA-256 are re-checked.
// usage: bun scripts/aggregate-release.mjs <dir> [--expect-targets 12]
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./fetch-pnpm.mjs";

const IDENTITY = ["kind", "tag", "id", "version", "channel", "run", "attempt", "launchProtocol", "builderCommit", "launcherProtocol", "launcherCommit"];

export function aggregateRelease(dir, expectTargets) {
	const parts = readdirSync(dir)
		.filter((n) => /^(?:dsh-(?:v|live-)|runtime-(?:v|live-)).+\.json$/.test(n))
		.map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")));
	if (!parts.length) throw new Error(`no release manifests in ${dir}`);
	const [first] = parts;
	const merged = { ...first, targets: {} };
	for (const p of parts) {
		for (const k of IDENTITY) if (p[k] !== first[k]) throw new Error(`target manifests disagree on ${k}: ${first[k]} vs ${p[k]}`);
		for (const k of ["upstream", "addons"]) if (JSON.stringify(p[k]) !== JSON.stringify(first[k])) throw new Error(`target manifests disagree on ${k}`);
		for (const [target, a] of Object.entries(p.targets)) {
			if (merged.targets[target]) throw new Error(`target ${target} listed twice`);
			// Per-target archives are uploaded as `<asset-name>`; local builds prefix the tag.
			const prefixed = join(dir, `${p.tag}-${a.file}`);
			const plain = join(dir, a.file);
			try {
				statSync(plain);
			} catch {
				renameSync(prefixed, plain);
			}
			const bytes = readFileSync(plain);
			if (bytes.length !== a.size || sha256(bytes) !== a.sha256) throw new Error(`${a.file}: size/sha256 differ from its manifest`);
			merged.targets[target] = a;
		}
	}
	const n = Object.keys(merged.targets).length;
	if (expectTargets && n !== expectTargets) throw new Error(`expected ${expectTargets} targets, got ${n}`);
	const sorted = Object.fromEntries(Object.entries(merged.targets).sort(([a], [b]) => a.localeCompare(b)));
	merged.targets = sorted;
	writeFileSync(join(dir, "release-manifest.json"), `${JSON.stringify(merged, null, 2)}\n`);
	writeFileSync(join(dir, "SHA256SUMS"), Object.values(sorted).map((a) => `${a.sha256}  ${a.file}\n`).join(""));
	return merged;
}

if (import.meta.main) {
	const [dir, ...rest] = process.argv.slice(2);
	if (!dir) throw new Error("usage: aggregate-release.mjs <dir> [--expect-targets N]");
	const i = rest.indexOf("--expect-targets");
	const m = aggregateRelease(dir, i >= 0 ? Number(rest[i + 1]) : undefined);
	console.log(`${m.tag}: ${Object.keys(m.targets).length} targets`);
}
