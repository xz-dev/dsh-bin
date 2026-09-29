// Plugin-runtime snapshot store (design S3, plugin-snapshots spec). Layout under `$DSH_HOME/snapshots/`:
//
//   <version>@<n>/profiles/<name>/...     the plugin runtimes and each profile's cordis.yml
//   <version>@<n>/snapshot.json           SnapshotMeta
//   <version>@<n>/.usage.lock             shared while a process runs on it; exclusive to remove it
//   .counters.json                        {<version>: last n}; n is allocated before copying, never reused
//   .lock                                 flock: serializes creation, removal and counter updates
//   .staging-<rand>/  .trash-<rand>/      an interrupted copy / removal; swept under the lock
//
// dsh-bin stores and copies runtimes; it never repairs them.
import { constants, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BuildOrder, compareVersionOrder, isCommitTime, matchVersion, USAGE_GUARD } from "../layout.ts";
import { crashPoint, discard, isShareViolation, newWorkDir, removeTree, renameDir, STAGING_PREFIX, TRASH_PREFIX, token, writeFileAtomic } from "../update/fsops.ts";
import { UserError } from "../update/context.ts";
import { acquireClaim, type Claim } from "../usage-claim.ts";

export type SnapshotReason = "install" | "start" | "user";

export type SnapshotMeta = {
	id: string;
	version: string;
	n: number;
	alias?: string;
	createdAt: string;
	/** The copied snapshot's id, or `empty`. */
	source: string;
	reason: SnapshotReason;
	/**
	 * Build order of `version`, so version order (and so "the previous version") works for snapshots whose
	 * bundle is no longer installed.
	 */
	order: BuildOrder;
};

export const SNAPSHOT_META = "snapshot.json";
const COUNTERS = ".counters.json";
const LOCK = ".lock";
const VERSION_RE = /^[0-9A-Za-z.+_-]+$/;
const ALIAS_RE = /^[0-9A-Za-z._-]+$/;

export const snapshotsDir = (home: string) => join(home, "snapshots");
export const snapshotDir = (home: string, id: string) => join(snapshotsDir(home), id);
export const snapshotId = (version: string, n: number) => `${version}@${n}`;

/** Why an alias cannot be used, or undefined when it can (`existing`: the version's snapshots). */
export function aliasProblem(alias: string, existing: readonly SnapshotMeta[]): string | undefined {
	if (!ALIAS_RE.test(alias)) return `invalid snapshot name ${JSON.stringify(alias)}: use letters, digits, '.', '_' and '-'`;
	if (/^\d+$/.test(alias)) return `invalid snapshot name ${alias}: a name cannot be all digits`;
	const taken = existing.find((s) => s.alias === alias);
	if (taken) return `snapshot name ${alias} is already used by ${taken.id}`;
	return undefined;
}

function readMeta(dir: string): SnapshotMeta | undefined {
	try {
		const m = JSON.parse(readFileSync(join(dir, SNAPSHOT_META), "utf8")) as SnapshotMeta;
		const ok =
			typeof m.version === "string" &&
			Number.isInteger(m.n) &&
			m.n > 0 &&
			m.id === snapshotId(m.version, m.n) &&
			isCommitTime(m.order?.upstream?.commitTime) &&
			Number.isInteger(m.order.run) &&
			Number.isInteger(m.order.attempt);
		return ok ? m : undefined;
	} catch {
		return undefined;
	}
}

/** Snapshots in version order, then by `n` (ascending: the last of a version is its newest). */
export function listSnapshots(home: string): SnapshotMeta[] {
	const root = snapshotsDir(home);
	if (!existsSync(root)) return [];
	const out: SnapshotMeta[] = [];
	for (const name of readdirSync(root)) {
		if (name.startsWith(".")) continue;
		const meta = readMeta(join(root, name));
		if (meta && meta.id === name) out.push(meta);
	}
	return out.sort((a, b) => compareVersionOrder(a.order, b.order) || (a.version < b.version ? -1 : a.version > b.version ? 1 : 0) || a.n - b.n);
}

/** The version's newest snapshot: the highest remaining `n`. */
export function newestOf(list: readonly SnapshotMeta[], version: string): SnapshotMeta | undefined {
	let best: SnapshotMeta | undefined;
	for (const s of list) if (s.version === version && (!best || s.n > best.n)) best = s;
	return best;
}

export type Lookup = { kind: "found"; snapshot: SnapshotMeta } | { kind: "invalid" } | { kind: "ambiguous"; versions: [string, string] } | { kind: "unknown" };

/**
 * A snapshot named `<version>@<n|alias>`, where `<version>` is any form the version selection accepts
 * (exact, tag or unique prefix), matched among the versions that have snapshots.
 */
export function findSnapshot(list: readonly SnapshotMeta[], id: string): Lookup {
	const at = id.lastIndexOf("@");
	if (at <= 0 || at === id.length - 1) return { kind: "invalid" };
	const versions = [...new Set(list.map((s) => s.version))];
	const match = matchVersion(versions, id.slice(0, at));
	if (match.kind === "ambiguous") return match;
	if (match.kind === "none") return { kind: "unknown" };
	const key = id.slice(at + 1);
	const hit = list.find((s) => s.version === match.version && (/^\d+$/.test(key) ? s.n === Number(key) : s.alias === key));
	return hit ? { kind: "found", snapshot: hit } : { kind: "unknown" };
}

/** `findSnapshot`, or a UserError naming `dsh snapshot list`. */
export function requireSnapshot(list: readonly SnapshotMeta[], id: string): SnapshotMeta {
	const r = findSnapshot(list, id);
	if (r.kind === "found") return r.snapshot;
	if (r.kind === "invalid") throw new UserError(`invalid snapshot id ${id}: expected <version>@<n|name>`);
	if (r.kind === "ambiguous") throw new UserError(`snapshot id ${id} is ambiguous (${r.versions.join(", ")}, ...); give more of the version`);
	throw new UserError(`snapshot ${id} does not exist`, ["Run `dsh snapshot list` to see the snapshots."]);
}

// ── Lock ─────────────────────────────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Run `fn` holding the store's `.lock` (an exclusive flock/LockFileEx, released by the kernel if the process
 * dies). Waits for another holder; `onWait` is called once when it has to. Leftovers of interrupted runs
 * are swept first.
 */
export function withStoreLock<T>(home: string, fn: (swept: number) => T, onWait?: () => void): T {
	const root = snapshotsDir(home);
	mkdirSync(root, { recursive: true });
	const path = join(root, LOCK);
	if (!existsSync(path)) writeFileSync(path, "", { flag: "a" });
	let claim = acquireClaim(path, "exclusive");
	if (claim === "busy") onWait?.();
	while (claim === "busy") {
		sleep(50);
		claim = acquireClaim(path, "exclusive");
	}
	try {
		return fn(sweepLocked(root));
	} finally {
		claim.release();
	}
}

function sweepLocked(root: string): number {
	let removed = 0;
	for (const name of readdirSync(root)) {
		if (!name.startsWith(STAGING_PREFIX) && !name.startsWith(TRASH_PREFIX)) continue;
		try {
			removeTree(join(root, name));
			removed++;
		} catch {
			// Still held open (Windows); swept next time.
		}
	}
	return removed;
}

/** Remove interrupted copies and removals (`dsh update --clean`); returns how many were removed. */
export function sweepSnapshotLeftovers(home: string): number {
	if (!existsSync(snapshotsDir(home))) return 0;
	return withStoreLock(home, (swept) => swept);
}

// ── Creation ─────────────────────────────────────────────────────────────────────────────────────────

function readCounters(root: string): Record<string, number> {
	try {
		const c = JSON.parse(readFileSync(join(root, COUNTERS), "utf8"));
		return c && typeof c === "object" && !Array.isArray(c) ? c : {};
	} catch {
		return {};
	}
}

/** Allocate and persist the next `n` of `version` (caller holds the lock). */
function allocate(root: string, version: string, list: readonly SnapshotMeta[]): number {
	const counters = readCounters(root);
	const last = Math.max(Number.isInteger(counters[version]) ? counters[version]! : 0, ...list.filter((s) => s.version === version).map((s) => s.n));
	counters[version] = last + 1;
	writeFileAtomic(join(root, COUNTERS), `${JSON.stringify(counters, null, 2)}\n`);
	return last + 1;
}

/** Copy a whole plugin runtime tree: filesystem clone where supported, symlinks kept as they are. */
export function copyRuntime(src: string, dest: string) {
	cpSync(src, dest, { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true, errorOnExist: true, force: false });
}

export type CreateSpec = {
	version: string;
	order: BuildOrder;
	reason: SnapshotReason;
	alias?: string;
	/**
	 * What to copy, decided under the lock from the current snapshots: a snapshot, or null for an empty
	 * snapshot.
	 */
	source: (list: readonly SnapshotMeta[]) => SnapshotMeta | null;
	/** Automatic creation: when the version already has a snapshot, return its newest instead. */
	ifNone?: boolean;
	onWait?: () => void;
};

export type Created = { snapshot: SnapshotMeta; created: boolean };

export function createSnapshot(home: string, spec: CreateSpec): Created {
	if (!VERSION_RE.test(spec.version)) throw new Error(`invalid bundle version ${spec.version}`);
	const root = snapshotsDir(home);
	return withStoreLock(
		home,
		() => {
			const list = listSnapshots(home);
			const existing = newestOf(list, spec.version);
			if (spec.ifNone && existing) return { snapshot: existing, created: false };
			if (spec.alias !== undefined) {
				const problem = aliasProblem(
					spec.alias,
					list.filter((s) => s.version === spec.version),
				);
				if (problem) throw new UserError(problem);
			}
			const source = spec.source(list);
			const n = allocate(root, spec.version, list);
			const id = snapshotId(spec.version, n);
			const staging = newWorkDir(root, STAGING_PREFIX);
			if (source) {
				crashPoint("snapshot-copy");
				copyRuntime(join(snapshotDir(home, source.id), "profiles"), join(staging, "profiles"));
			} else mkdirSync(join(staging, "profiles"));
			crashPoint("snapshot-copied");
			const meta: SnapshotMeta = {
				id,
				version: spec.version,
				n,
				...(spec.alias !== undefined ? { alias: spec.alias } : {}),
				createdAt: new Date().toISOString(),
				source: source ? source.id : "empty",
				reason: spec.reason,
				order: { upstream: { commitTime: spec.order.upstream.commitTime }, run: spec.order.run, attempt: spec.order.attempt },
			};
			writeFileSync(join(staging, USAGE_GUARD), "");
			writeFileSync(join(staging, SNAPSHOT_META), `${JSON.stringify(meta, null, 2)}\n`);
			renameSync(staging, snapshotDir(home, id));
			return { snapshot: meta, created: true };
		},
		spec.onWait,
	);
}

// ── Use and removal ──────────────────────────────────────────────────────────────────────────────────

/**
 * Take the shared usage claim on a snapshot (held by the caller for its lifetime). `"busy"` means it is
 * being removed; `"missing"` that it no longer exists.
 */
export function claimSnapshot(home: string, id: string): Claim | "busy" | "missing" {
	try {
		return acquireClaim(join(snapshotDir(home, id), USAGE_GUARD), "shared");
	} catch (error) {
		if (!existsSync(join(snapshotDir(home, id), USAGE_GUARD))) return "missing";
		throw error;
	}
}

/**
 * Remove a snapshot under the lock and its exclusive usage claim: rename it to `.trash-*`, then delete it,
 * so a crash never leaves a half-removed snapshot. `"busy"` (nothing changed) when a process uses it.
 */
export function removeSnapshot(home: string, id: string, platform = process.platform): "removed" | "busy" {
	const root = snapshotsDir(home);
	return withStoreLock(home, () => {
		const dir = snapshotDir(home, id);
		const claim = acquireClaim(join(dir, USAGE_GUARD), "exclusive");
		if (claim === "busy") return "busy";
		// Windows refuses to rename a directory with an open handle inside, our own claim included: release
		// it, and let the rename refuse a snapshot that came into use meanwhile (as the bundle quarantine).
		if (platform === "win32") claim.release();
		const trash = join(root, `${TRASH_PREFIX}${token()}`);
		try {
			renameDir(dir, trash, platform);
		} catch (error) {
			if (isShareViolation(error)) return "busy";
			throw error;
		} finally {
			claim.release();
		}
		crashPoint("snapshot-trashed");
		discard(trash);
		return "removed";
	});
}
