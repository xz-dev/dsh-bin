// 6.3: a read-only bundle defeats dsh-tui's standalone self-updater without intercepting it.
// The emulation below is the replacement step of dsh-tui's `downloadAndReplaceStandaloneBinary`
// (lib/types/update.js): POSIX stages `.dsh-tui-new-<pid>` next to execPath and renames it over;
// Windows renames execPath to `.old` and copies the new file in.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeReadOnly, makeWritable } from "../../runtime/readonly.ts";

function treeHash(dir: string): string {
	const h = createHash("sha256");
	const walk = (d: string) => {
		for (const name of readdirSync(d).sort()) {
			const p = join(d, name);
			const st = lstatSync(p);
			h.update(`${p.slice(dir.length)}\0${st.mode & 0o7777}\0`);
			if (st.isDirectory()) walk(p);
			else h.update(readFileSync(p));
		}
	};
	walk(dir);
	return h.digest("hex");
}

/** dsh-tui's replacement step, verbatim in behaviour. */
function dshTuiReplace(currentBinary: string, newBinaryPath: string, platform = process.platform) {
	const targetDir = join(currentBinary, "..");
	if (platform === "win32") {
		const oldBinary = `${currentBinary}.old`;
		rmSync(oldBinary, { force: true });
		renameSync(currentBinary, oldBinary);
		try {
			copyFileSync(newBinaryPath, currentBinary);
		} catch (e) {
			renameSync(oldBinary, currentBinary);
			throw e;
		}
		return;
	}
	const stagedTarget = join(targetDir, `.dsh-tui-new-${process.pid}`);
	copyFileSync(newBinaryPath, stagedTarget);
	chmodSync(stagedTarget, 0o755);
	renameSync(stagedTarget, currentBinary);
}

function bundle() {
	const root = mkdtempSync(join(tmpdir(), "dsh-ro-"));
	const b = join(root, "bundles", "V1");
	mkdirSync(join(b, "app/lib"), { recursive: true });
	mkdirSync(join(b, "bin"), { recursive: true });
	writeFileSync(join(b, "dsh-native"), "#!/bin/sh\necho v1\n", { mode: 0o755 });
	writeFileSync(join(b, "app/lib/bin.js"), "export {}");
	writeFileSync(join(b, "bin/node"), "#!/bin/sh\n", { mode: 0o755 });
	writeFileSync(join(b, ".usage.lock"), "");
	writeFileSync(join(root, "new-binary"), "#!/bin/sh\necho hijacked\n", { mode: 0o755 });
	return { root, b };
}

const isRoot = process.getuid?.() === 0;

describe.skipIf(isRoot)("read-only bundle (6.3)", () => {
	test("every file and directory is non-writable by owner, group and others", () => {
		const { b } = bundle();
		makeReadOnly(b);
		const check = (p: string) => {
			// Windows: directories carry no read-only attribute; the deny-write ACL protects them (next tests).
			if (process.platform !== "win32" || !lstatSync(p).isDirectory()) expect(lstatSync(p).mode & 0o222).toBe(0);
			if (lstatSync(p).isDirectory()) for (const n of readdirSync(p)) check(join(p, n));
		};
		check(b);
		makeWritable(b);
	});

	test("dsh-tui's standalone replacement fails and the bundle is byte-for-byte unchanged", () => {
		const { root, b } = bundle();
		makeReadOnly(b);
		const before = treeHash(b);
		expect(() => dshTuiReplace(join(b, "dsh-native"), join(root, "new-binary"))).toThrow(/EACCES|EPERM|permission/i);
		expect(treeHash(b)).toBe(before);
		expect(readdirSync(b)).not.toContain(`.dsh-tui-new-${process.pid}`);
		makeWritable(b);
	});

	test("the Windows-style rename-to-.old path also fails", () => {
		const { root, b } = bundle();
		makeReadOnly(b);
		const before = treeHash(b);
		expect(() => dshTuiReplace(join(b, "dsh-native"), join(root, "new-binary"), "win32")).toThrow(/EACCES|EPERM|permission/i);
		expect(treeHash(b)).toBe(before);
		makeWritable(b);
	});

	test("the shared usage claim can still be taken on a read-only .usage.lock", async () => {
		const { b } = bundle();
		makeReadOnly(b);
		const { acquireClaim } = await import("../../runtime/usage-claim.ts");
		const claim = acquireClaim(join(b, ".usage.lock"), "shared");
		expect(claim).toBeTruthy();
		claim?.release();
		makeWritable(b);
	});

	test("makeWritable restores owner write so the updater can remove a quarantined tree", () => {
		const { b } = bundle();
		makeReadOnly(b);
		expect(() => rmSync(b, { recursive: true })).toThrow();
		makeWritable(b);
		rmSync(b, { recursive: true });
	});
});
