// Read-only runtime tree (launcher spec "Read-only runtime tree", design D6). Activated bundles and addon
// versions are made non-writable for everyone; only the updater restores owner write, and only on staging
// or quarantine paths it owns exclusively. dsh-tui's standalone self-updater fails against this without
// any interception: it cannot create `.dsh-tui-new-<pid>` next to the executable or rename over it.
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

const walk = (dir: string, visit: (path: string, isDir: boolean) => void) => {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		const st = lstatSync(path);
		if (st.isSymbolicLink()) throw new Error(`read-only tree must not contain symlinks: ${path}`);
		if (st.isDirectory()) walk(path, visit);
		visit(path, st.isDirectory());
	}
};

function icacls(args: string[]) {
	const r = spawnSync("icacls", args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", windowsHide: true });
	if (r.status !== 0) throw new Error(`icacls ${args.join(" ")} failed: ${r.stderr || r.stdout || r.error}`);
}

/** Recursively remove write permission (POSIX `a-w`; Windows read-only attribute plus a deny-write ACL). */
export function makeReadOnly(dir: string, platform = process.platform): void {
	const strip = (path: string) => chmodSync(path, lstatSync(path).mode & 0o7555);
	if (platform === "win32") {
		walk(dir, (path, isDir) => isDir || strip(path));
		// Deny writing, creating, deleting and re-attributing for Everyone (S-1-1-0), inherited by the tree.
		// Specific rights only: the generic `W` also carries SYNCHRONIZE and READ_CONTROL, and denying those
		// breaks reading, listing and opening the claim file.
		icacls([dir, "/deny", "*S-1-1-0:(OI)(CI)(WD,AD,WEA,WA,D,DC)", "/q"]);
		return;
	}
	walk(dir, (path) => strip(path));
	strip(dir);
}

/** Restore owner write on a tree the updater exclusively owns (staging or quarantine), so it can be removed. */
export function makeWritable(dir: string, platform = process.platform): void {
	if (platform === "win32") {
		try {
			icacls([dir, "/remove:d", "*S-1-1-0", "/t", "/q"]);
		} catch {
			// No ACL was applied (for example a staging tree that never became read-only).
		}
		walk(dir, (path, isDir) => isDir || chmodSync(path, lstatSync(path).mode | 0o200));
		return;
	}
	chmodSync(dir, lstatSync(dir).mode | 0o700);
	const visitDirsFirst = (d: string) => {
		for (const name of readdirSync(d)) {
			const path = join(d, name);
			const st = lstatSync(path);
			if (st.isSymbolicLink()) continue;
			chmodSync(path, st.mode | (st.isDirectory() ? 0o700 : 0o200));
			if (st.isDirectory()) visitDirsFirst(path);
		}
	};
	visitDirsFirst(dir);
}
