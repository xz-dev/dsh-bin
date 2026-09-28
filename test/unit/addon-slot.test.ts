import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addonSlot, kitVersionOf } from "../../scripts/addon-slot.mjs";

const lock = (kit: string | null, extra = "") =>
	`lockfileVersion: '9.0'\n\npackages:\n\n${kit ? `  '@deepseek-ai/libreoffice-kit@${kit}':\n    resolution: {integrity: sha512-x}\n\n` : ""}  zod@4.0.0:\n    resolution: {integrity: sha512-y}\n${extra}`;

function repo() {
	const dir = mkdtempSync(join(tmpdir(), "addon-slot-"));
	const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
	git("init", "-q", "-b", "master");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	git("config", "commit.gpgsign", "false");
	const commit = (text: string | null, msg: string) => {
		if (text !== null) writeFileSync(join(dir, "pnpm-lock.yaml"), text);
		else writeFileSync(join(dir, "README"), msg);
		git("add", "-A");
		git("commit", "-q", "-m", msg);
		return git("rev-parse", "HEAD");
	};
	return { dir: join(dir, ".git"), git, commit };
}

test("kitVersionOf reads the packages key (v9 and v6 forms)", () => {
	expect(kitVersionOf(lock("0.1.2"))).toBe("0.1.2");
	expect(kitVersionOf("packages:\n  /@deepseek-ai/libreoffice-kit@0.1.0:\n")).toBe("0.1.0");
	expect(kitVersionOf(lock(null))).toBeNull();
	expect(kitVersionOf("  '@deepseek-ai/libreoffice-kit-wasm@0.1.1':\n")).toBeNull();
});

test("slot is the kit-introducing commit; unrelated edits keep it; switch-back opens a new slot", () => {
	const r = repo();
	const none = r.commit(lock(null), "no kit");
	const a = r.commit(lock("0.1.2"), "kit 0.1.2");
	const aEdit = r.commit(lock("0.1.2", "  other@1.0.0:\n"), "unrelated lock edit");
	const aDoc = r.commit(null, "docs only");
	const b = r.commit(lock("0.1.3"), "kit 0.1.3");
	const c = r.commit(lock("0.1.2", "  other@2.0.0:\n"), "kit back to 0.1.2");
	const cDoc = r.commit(null, "docs again");

	expect(addonSlot(r.dir, none)).toBeNull();
	expect(addonSlot(r.dir, a)).toEqual({ commit: a, kitVersion: "0.1.2" });
	expect(addonSlot(r.dir, aEdit)).toEqual({ commit: a, kitVersion: "0.1.2" });
	expect(addonSlot(r.dir, aDoc)).toEqual({ commit: a, kitVersion: "0.1.2" });
	expect(addonSlot(r.dir, b)).toEqual({ commit: b, kitVersion: "0.1.3" });
	expect(addonSlot(r.dir, cDoc)).toEqual({ commit: c, kitVersion: "0.1.2" });
	// Batch boundaries must not change the answer.
	expect(addonSlot(r.dir, cDoc, 1)).toEqual({ commit: c, kitVersion: "0.1.2" });
	expect(addonSlot(r.dir, aDoc, 1)).toEqual({ commit: a, kitVersion: "0.1.2" });
});

test("side-branch kit changes merged back follow the first-parent merge", () => {
	const r = repo();
	r.commit(lock("0.1.2"), "kit 0.1.2");
	r.git("checkout", "-q", "-b", "bump");
	r.commit(lock("0.1.3"), "bump on branch");
	r.git("checkout", "-q", "master");
	r.commit(null, "master work");
	r.git("merge", "-q", "--no-ff", "-m", "merge bump", "bump");
	const merge = r.git("rev-parse", "HEAD");
	expect(addonSlot(r.dir, merge)).toEqual({ commit: merge, kitVersion: "0.1.3" });
});
