// Automatic snapshot by copy (plugin-snapshots spec): a version with no snapshot gets one, copied from the
// previous version's newest snapshot, or empty. Tumbleweed-style: each version starts from where the last
// one left off, and dsh-bin never repairs what it copied.
import { type BuildOrder, compareVersionOrder } from "../layout.ts";
import { createSnapshot, type Created, newestOf, type SnapshotMeta, type SnapshotReason } from "./store.ts";

/**
 * The newest snapshot of the nearest earlier version in version order that has a snapshot, whether or not
 * its bundle is still installed (the order comes from `snapshot.json`).
 */
export function previousSource(list: readonly SnapshotMeta[], version: string, order: BuildOrder): SnapshotMeta | null {
	let prev: SnapshotMeta | undefined;
	for (const s of list) {
		if (s.version === version || compareVersionOrder(s.order, order) >= 0) continue;
		if (!prev || compareVersionOrder(s.order, prev.order) > 0) prev = s;
	}
	return prev ? (newestOf(list, prev.version) ?? null) : null;
}

/** The version's newest snapshot, creating it (reason `install` or `start`) when the version has none. */
export function ensureSnapshot(home: string, version: string, order: BuildOrder, reason: Exclude<SnapshotReason, "user">, onWait?: () => void): Created {
	return createSnapshot(home, { version, order, reason, ifNone: true, source: (list) => previousSource(list, version, order), onWait });
}

/** One line describing an automatic creation, for maintenance output and the startup notice. */
export const createdLine = (s: SnapshotMeta) => `Created plugin snapshot ${s.id} (${s.source === "empty" ? "empty" : `copy of ${s.source}`}).`;
