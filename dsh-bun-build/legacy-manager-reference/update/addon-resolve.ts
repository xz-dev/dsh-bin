// Addon version resolution (self-update spec "Addon slots"). Pure functions shared by install/update
// (which act on the result) and `dsh list` (which only shows it).
import type { AddonRelease, AddonTable, Slot } from "../layout.ts";
import type { ReleaseIndex } from "./index-client.ts";

export type Source = "embedded" | "index" | "both";
export type Candidate = AddonRelease & { source: Source; conflict: boolean; inSlot: boolean };

/** Addon platform key of a bundle target: one portable Linux build, per-OS/arch elsewhere. */
export function addonPlatform(target: string): string {
	const [os, arch] = target.split("-");
	return os === "linux" ? "linux" : `${os}-${arch}`;
}
export const addonAssetName = (name: string, platform: string) => `dsh-addon-${name}-${platform}.zip`;

const sameDigests = (a: AddonRelease, b: AddonRelease) => {
	const keys = new Set([...Object.keys(a.assets), ...Object.keys(b.assets)]);
	for (const k of keys) {
		const x = a.assets[k];
		const y = b.assets[k];
		if (x && y && (x.sha256 !== y.sha256 || x.size !== y.size || x.name !== y.name)) return false;
	}
	return a.tag === b.tag && a.slot.commit === b.slot.commit;
};

/** Every known version: embedded table first, index second, merged by version; ordered by sequence. */
export function candidates(table: AddonTable, index: ReleaseIndex | undefined): Candidate[] {
	const slot = table.slot;
	const inSlot = (s: Slot) => !!slot && s.commit === slot.commit;
	const byVersion = new Map<string, Candidate>();
	for (const e of table.known) byVersion.set(e.version, { ...e, source: "embedded", conflict: false, inSlot: inSlot(e.slot) });
	for (const e of index?.addons.office ?? []) {
		const known = byVersion.get(e.version);
		if (!known) byVersion.set(e.version, { ...e, source: "index", conflict: false, inSlot: inSlot(e.slot) });
		else byVersion.set(e.version, { ...known, seq: e.seq ?? known.seq, source: "both", conflict: !sameDigests(known, e) });
	}
	return [...byVersion.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.version.localeCompare(b.version));
}

/**
 * Default addon version to install for a bundle (self-update "Optional addons"): the in-slot index entry
 * with the highest sequence, falling back to `pinned` when the index is unreachable or has none.
 */
export function defaultVersion(table: AddonTable, index: ReleaseIndex | undefined): string | null {
	if (index && table.slot) {
		const inSlot = index.addons.office.filter((e) => e.slot.commit === table.slot!.commit);
		const newest = inSlot.reduce<AddonRelease | undefined>((a, e) => (!a || (e.seq ?? 0) > (a.seq ?? 0) ? e : a), undefined);
		if (newest) return newest.version;
	}
	return table.pinned;
}

/** A candidate by addon version or by its `dsh-addon-<name>-v<version>` tag. */
export function findCandidate(list: Candidate[], wanted: string): Candidate | undefined {
	return list.find((c) => c.version === wanted || c.tag === wanted);
}
