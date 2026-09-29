// The snapshot a launch runs on (version-selection "Selection resolution", plugin-snapshots): the named one,
// else the version's newest (created first when the version has none). The caller holds the returned
// shared claim for its lifetime.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type BundleMeta, matchVersion } from "../layout.ts";
import { UserError } from "../update/context.ts";
import type { Claim } from "../usage-claim.ts";
import { ensureSnapshot } from "./auto.ts";
import { type Launch, namedSnapshot, parseLeading } from "./launch.ts";
import { claimSnapshot, listSnapshots, requireSnapshot, SNAPSHOT_META, type SnapshotMeta, snapshotDir } from "./store.ts";

export type Resolution = { snapshot: SnapshotMeta; created: boolean; claim: Claim };

const SNAPSHOT_LIST_HINT = "Run `dsh snapshot list` to see the snapshots.";

/** Take the shared claim, then make sure the snapshot was not removed between lookup and claim. */
function claimExisting(home: string, id: string): Claim | "busy" | "missing" {
	const claim = claimSnapshot(home, id);
	if (typeof claim === "string") return claim;
	// A removal renames under the exclusive claim: with our shared claim held, it is either done or not begun.
	if (existsSync(join(snapshotDir(home, id), SNAPSHOT_META))) return claim;
	claim.release();
	return "missing";
}

export function resolveSnapshot(home: string, meta: BundleMeta, launch: Launch | undefined, onWait?: () => void): Resolution {
	const named = namedSnapshot(launch);
	if (named) {
		const fromSelection = !launch?.resolved && !launch?.snapshot;
		const hints = fromSelection ? [SNAPSHOT_LIST_HINT, "Run `dsh select --use latest` to reset the selection."] : [SNAPSHOT_LIST_HINT];
		let snapshot: SnapshotMeta;
		try {
			snapshot = requireSnapshot(listSnapshots(home), named);
		} catch (error) {
			if (error instanceof UserError && fromSelection) throw new UserError(`the selected ${error.message}`, hints);
			throw error;
		}
		const claim = claimExisting(home, snapshot.id);
		if (claim === "busy") throw new UserError(`snapshot ${snapshot.id} is being removed`, hints);
		if (claim === "missing") throw new UserError(`snapshot ${snapshot.id} does not exist`, hints);
		return { snapshot, created: false, claim };
	}
	// The newest can be removed between lookup and claim: look again (a new newest, or a new automatic one).
	let created = false;
	for (let attempt = 0; attempt < 5; attempt++) {
		const r = ensureSnapshot(home, meta.version, meta, "start", onWait);
		created ||= r.created;
		const claim = claimExisting(home, r.snapshot.id);
		if (typeof claim === "object") return { snapshot: r.snapshot, created, claim };
	}
	throw new UserError(`the snapshots of dsh ${meta.version} are being removed; start dsh again`);
}

/**
 * Strip leading `--use/--snapshot/--addon` from a process started directly (not through the launcher, which
 * already removed them) and record them in the launch, as the launcher would. A direct start runs this
 * bundle only, so an option naming another version is refused. Returns the remaining arguments.
 */
export function applyLeading(args: readonly string[], version: string, previous: Launch | undefined): { args: string[]; launch: Launch | undefined } {
	const p = parseLeading(args);
	if ("error" in p) throw new UserError(p.error);
	if (!p.use && !p.snapshot && p.addons.length === 0) return { args: p.rest, launch: previous };
	const other = (named: string) =>
		new UserError(`${named} names another dsh version than ${version}; start it through the dsh launcher`);
	if (p.use && matchVersion([version], p.use).kind !== "found") throw other(`--use ${p.use}`);
	if (!p.use && p.snapshot) {
		const at = p.snapshot.lastIndexOf("@");
		if (at <= 0 || at === p.snapshot.length - 1) throw new UserError(`invalid snapshot id ${p.snapshot}: expected <version>@<n|name>`);
		if (matchVersion([version], p.snapshot.slice(0, at)).kind !== "found") throw other(`--snapshot ${p.snapshot}`);
	}
	if (p.use || p.snapshot) {
		return { args: p.rest, launch: { version, source: p.use ? "use" : "snapshot", use: p.use, snapshot: p.snapshot, addons: p.addons, selection: null } };
	}
	const base: Launch = previous ?? { version, source: null, use: null, snapshot: null, addons: [], selection: null };
	return { args: p.rest, launch: { ...base, addons: p.addons } };
}
