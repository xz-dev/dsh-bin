// Filesystem primitives for maintenance commands (design D6): the install-root mutex, staging and trash
// directories, atomic file replacement and retirement of read-only trees under an exclusive usage claim.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { USAGE_GUARD } from "../layout.ts";
import { makeReadOnly, makeWritable } from "../readonly.ts";
import { acquireClaim } from "../usage-claim.ts";
import { exchange } from "./exchange.ts";
import { UserError } from "./context.ts";

export const LOCK_NAME = "update.lock";
/** Work directories the updater creates in the install root; leftovers from interrupted runs. */
export const STAGING_PREFIX = ".staging-";
export const TRASH_PREFIX = ".trash-";
export const OLD_LAUNCHER = /^\.dsh(?:\.exe)?\.old-[0-9a-f]+$/;

export const token = () => randomBytes(6).toString("hex");

/**
 * Crash injection for the contract tests (`DSH_BIN_TEST=1 DSH_BIN_TEST_CRASH=<point>`): exit immediately,
 * without cleanup, as a SIGKILL would. Inert in real installations.
 */
export function crashPoint(point: string) {
	if (process.env.DSH_BIN_TEST === "1" && process.env.DSH_BIN_TEST_CRASH === point) {
		process.stderr.write(`dsh: test crash at ${point}\n`);
		process.kill(process.pid, "SIGKILL");
	}
}

/**
 * Run `fn` holding `<root>/update.lock`, a directory created with mkdir (atomic on every platform).
 * An existing lock is never reclaimed by age: the owner could be a slow update on another terminal.
 */
export async function withUpdateLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
	const lock = join(root, LOCK_NAME);
	try {
		mkdirSync(lock);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		throw new UserError("Another dsh update or cleanup is already running.", [
			`If you are sure no dsh update or cleanup is running, remove ${lock} manually.`,
		]);
	}
	try {
		writeFileSync(join(lock, "owner.json"), `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
		return await fn();
	} finally {
		rmSync(lock, { recursive: true, force: true });
	}
}

/** Remove a tree the updater owns (staging or trash), restoring write permission first. */
export function removeTree(path: string) {
	if (!existsSync(path)) return;
	try {
		makeWritable(path);
	} catch {
		// Partially removed or never read-only; rmSync reports what really fails.
	}
	rmSync(path, { recursive: true, force: true });
}

export function newWorkDir(root: string, prefix: string): string {
	const dir = join(root, `${prefix}${token()}`);
	mkdirSync(dir);
	return dir;
}

/**
 * Move a read-only tree to a `.trash-*` quarantine in the install root under its exclusive usage claim.
 * Returns the quarantine path, or undefined (and changes nothing) when the tree is in use.
 */
export function quarantine(root: string, dir: string, platform = process.platform): string | undefined {
	const guard = join(dir, USAGE_GUARD);
	const claim = existsSync(guard) ? acquireClaim(guard, "exclusive") : undefined;
	if (claim === "busy") return undefined;
	// Windows refuses to move a directory while any handle inside it is open, our own claim included, and
	// every dsh process using a tree holds its guard open. So the claim only checks for current users; the
	// rename itself then refuses a tree that came into use meanwhile (measured on windows-2022).
	if (platform === "win32") claim?.release();
	const trash = join(root, `${TRASH_PREFIX}${token()}`);
	try {
		unsealTop(dir, platform);
		renameDir(dir, trash, platform);
	} catch (error) {
		// In use, or a user holds a file inside it open: leave it in place.
		if (isShareViolation(error)) {
			sealTop(dir);
			return undefined;
		}
		throw error;
	} finally {
		claim?.release();
	}
	return trash;
}

export const isShareViolation = (error: unknown) => ["EBUSY", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "");

/**
 * Rename a directory. Windows retries for up to 3 s, as pi does: scanners, indexers and a just-killed
 * process hold short-lived handles inside trees, while a handle held by a dsh session outlasts the retries
 * and surfaces as in use.
 */
export function renameDir(src: string, dest: string, platform: string = process.platform) {
	for (let attempt = 0; ; attempt++) {
		try {
			renameSync(src, dest);
			return;
		} catch (error) {
			if (platform !== "win32" || attempt >= 29 || !isShareViolation(error)) throw error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
		}
	}
}

/** Put a quarantined tree back (activation failed after `quarantine`). */
export function unquarantine(trash: string, dir: string) {
	renameSync(trash, dir);
	sealTop(dir);
}

/** Quarantine and remove a tree; false when it is in use. */
export function retire(root: string, dir: string): boolean {
	const trash = quarantine(root, dir);
	if (!trash) return false;
	discard(trash);
	return true;
}

/**
 * Remove a quarantined tree; a failure leaves it for the next maintenance run. `last` (a marker file) is
 * removed only after everything else, so a partial removal (Windows: the running executable cannot be
 * deleted) keeps it and the sweep never mistakes the remains for a tree to restore.
 */
export function discard(trash: string, last?: string) {
	try {
		if (last && existsSync(join(trash, last))) {
			try {
				makeWritable(trash);
			} catch {
				// rmSync reports what really fails.
			}
			for (const name of readdirSync(trash)) if (name !== last) rmSync(join(trash, name), { recursive: true, force: true });
		}
		removeTree(trash);
	} catch {
		// Swept later.
	}
}

/**
 * Remove staging/trash leftovers and replaced launchers from interrupted runs (caller holds the lock).
 * A quarantined tree that is still referenced (`isReferenced` returns its home) and whose home is missing
 * was interrupted between quarantine and replacement: it is restored instead of removed.
 */
export function sweepLeftovers(root: string, isReferenced: (trash: string) => string | undefined = () => undefined): number {
	let removed = 0;
	for (const name of readdirSync(root)) {
		const path = join(root, name);
		if (name.startsWith(TRASH_PREFIX)) {
			const home = isReferenced(path);
			if (home && !existsSync(home)) {
				mkdirSync(join(home, ".."), { recursive: true });
				unquarantine(path, home);
				continue;
			}
		}
		if (name.startsWith(STAGING_PREFIX) || name.startsWith(TRASH_PREFIX)) {
			const guards = findGuards(path);
			const claims = guards.map((g) => acquireClaim(g, "exclusive"));
			const busy = claims.includes("busy");
			for (const c of claims) if (c !== "busy") c.release();
			if (busy) continue;
			try {
				removeTree(path);
				removed++;
			} catch {
				// Still in use (Windows) or not removable now; try again next time.
			}
		} else if (OLD_LAUNCHER.test(name)) {
			try {
				rmSync(path, { force: true });
			} catch {
				// A replaced launcher that is still running on Windows.
			}
		}
	}
	return removed;
}

/** Usage guards inside a work dir (`bundles/<v>/.usage.lock` or a retired `<v>/.usage.lock`). */
function findGuards(dir: string): string[] {
	const found: string[] = [];
	const visit = (d: string, depth: number) => {
		let names: string[];
		try {
			names = readdirSync(d);
		} catch {
			return;
		}
		for (const name of names) {
			const p = join(d, name);
			if (name === USAGE_GUARD) found.push(p);
			else if (depth < 2 && statSync(p, { throwIfNoEntry: false })?.isDirectory()) visit(p, depth + 1);
		}
	};
	visit(dir, 0);
	return found;
}

/**
 * Moving a directory to another parent needs write permission on the directory itself (POSIX updates its
 * `..`; Windows needs DELETE, which the read-only ACL denies). Only the updater calls this, on trees it
 * holds exclusively.
 */
function unsealTop(dir: string, platform = process.platform) {
	if (platform === "win32") makeWritable(dir, platform);
	else chmodSync(dir, statSync(dir).mode | 0o700);
}

function sealTop(dir: string, platform = process.platform) {
	if (platform === "win32") makeReadOnly(dir, platform);
	else chmodSync(dir, statSync(dir).mode & 0o7555);
}

/**
 * Move a validated staged tree to `dest` and leave it read-only. POSIX: everything below the top is
 * sealed before the move and the top right after it. Windows: sealed right after the move (the deny-DELETE
 * ACL would block the rename). Either way nothing starts it before the caller switches the launcher/state.
 */
export function placeReadOnly(src: string, dest: string, platform = process.platform) {
	if (platform === "win32") {
		renameSync(src, dest);
		makeReadOnly(dest, platform);
		return;
	}
	makeReadOnly(src, platform);
	chmodSync(src, statSync(src).mode | 0o700);
	renameSync(src, dest);
	chmodSync(dest, statSync(dest).mode & 0o7555);
}

/**
 * Put the validated staged tree `src` at `dest`, read-only. When `dest` exists (same-version `--force`), the
 * old generation is replaced under its exclusive usage claim:
 * - POSIX with renameat2/renamex_np: one atomic exchange, so `dest` is never missing;
 * - otherwise (Windows): quarantine, rename, and restore on failure; a crash in between is repaired by
 *   the next maintenance run's leftover sweep.
 * Returns "busy" (and changes nothing) when the old generation is in use. `afterPlace` runs while the old
 * generation can still be restored (e.g. the launcher switch).
 */
export function installTree(root: string, src: string, dest: string, afterPlace: () => void = () => {}, platform = process.platform): "ok" | "busy" {
	crashPoint("before-place");
	if (!existsSync(dest)) {
		placeReadOnly(src, dest, platform);
		crashPoint("after-place");
		afterPlace();
		crashPoint("after-launcher");
		return "ok";
	}
	if (platform !== "win32") {
		const guard = join(dest, USAGE_GUARD);
		const claim = existsSync(guard) ? acquireClaim(guard, "exclusive") : undefined;
		if (claim === "busy") return "busy";
		try {
			makeReadOnly(src, platform);
			unsealTop(src, platform);
			unsealTop(dest, platform);
			if (exchange(src, dest)) {
				sealTop(dest, platform);
				crashPoint("after-place");
				try {
					afterPlace();
					crashPoint("after-launcher");
				} catch (error) {
					if (exchange(src, dest)) sealTop(dest, platform);
					throw error;
				}
				discard(src); // now the old generation
				return "ok";
			}
			sealTop(dest, platform);
		} finally {
			claim?.release();
		}
	}
	const previous = quarantine(root, dest, platform);
	if (!previous) return "busy";
	crashPoint("after-quarantine");
	try {
		placeReadOnly(src, dest, platform);
		crashPoint("after-place");
		afterPlace();
		crashPoint("after-launcher");
	} catch (error) {
		if (!existsSync(dest)) unquarantine(previous, dest);
		throw error;
	}
	discard(previous);
	return "ok";
}

/** Atomically replace `dest` with `data` (write a sibling temp file, then rename over it). */
export function writeFileAtomic(dest: string, data: string) {
	const tmp = `${dest}.${token()}.tmp`;
	writeFileSync(tmp, data);
	renameSync(tmp, dest);
}

/**
 * Replace the root launcher with `staged` (same filesystem). POSIX renames over it. Windows never
 * overwrites a running executable: the old launcher is renamed aside first and swept on a later run.
 */
export function replaceLauncher(staged: string, dest: string, platform = process.platform) {
	if (platform === "win32" && existsSync(dest)) {
		const aside = join(dest, "..", `.dsh.exe.old-${token()}`);
		renameSync(dest, aside);
		try {
			renameSync(staged, dest);
		} catch (error) {
			renameSync(aside, dest);
			throw error;
		}
		try {
			rmSync(aside, { force: true });
		} catch {
			// Running; swept later.
		}
		return;
	}
	renameSync(staged, dest);
}
