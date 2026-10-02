// Build/test helper for read-only runtime trees. Production activation and retirement permissions
// belong to the Zig manager; the application entry does not import this module. Tests use it to check
// that upstream self-updaters cannot create a sibling executable or rename over the installed one.
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
		// Deny write-data/add-file, append/add-subdirectory, attribute writes and delete-child for Everyone
		// (S-1-1-0), inherited by the tree. Measured on windows-2022: this blocks creating files or
		// directories and renaming a file in place (dsh-tui's `.old` path), while reads still work. Denying
		// the generic `W` or `D` (DELETE) breaks Bun's own reads, because Bun opens files and directories
		// requesting DELETE access.
		// ponytail: without a DELETE deny, a whole subdirectory can still be moved out of the bundle by its
		// owner; closing that needs Bun to open without DELETE access.
		icacls([dir, "/deny", "*S-1-1-0:(OI)(CI)(WD,AD,WEA,WA,DC)", "/q"]);
		return;
	}
	walk(dir, (path) => strip(path));
	strip(dir);
}

/** Restore owner write on an exclusively owned fixture tree so tests can remove it. */
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
