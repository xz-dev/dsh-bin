// scripts/upstream-diff.mjs: index-based detection for upstream-poll (8.5) and addon dispatch (8.8).
import { expect, test } from "bun:test";
import { compareVersions, packagingChanged, upstreamDiff } from "../../scripts/upstream-diff.mjs";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const c = (ch: string) => ch.repeat(40);
const ls = (master: string, tags: Record<string, string>, annotated: Record<string, string> = {}) =>
	[`${master}\trefs/heads/master`, ...Object.entries(tags).map(([t, s]) => `${s}\trefs/tags/${t}`), ...Object.entries(annotated).flatMap(([t, s]) => [`${c("f")}\trefs/tags/${t}`, `${s}\trefs/tags/${t}^{}`])].join("\n");
const rel = (tag: string, commit: string, seq: number, launcherCommit = c("d")) => ({ seq, tag: `${tag}-xz.1.1.gdeadbeef`, channel: "release", upstream: { tag, commit }, launcherCommit });
const liv = (commit: string, seq: number, launcherCommit = c("d")) => ({ seq, tag: `dsh-live-${commit.slice(0, 7)}-xz.1.1.gdeadbeef`, channel: "live", upstream: { commit }, launcherCommit });
const index = (release: object[], live: object[], office: object[] = []) => ({ schemaVersion: 1, channels: { release, live }, addons: { office } });

test("no-op when every tag and master are published", () => {
	const r = upstreamDiff({ lsRemote: ls(c("1"), { "dsh-v0.1.7-rc.2": c("a"), "dsh-v0.1.6": c("0") }), index: index([rel("dsh-v0.1.7-rc.2", c("a"), 1)], [liv(c("1"), 1)]) });
	expect(r.builds).toEqual([]);
});

test("two new tags are built in version order; older-than-first tags are ignored", () => {
	const r = upstreamDiff({
		lsRemote: ls(c("1"), { "dsh-v0.1.8": c("c"), "dsh-v0.1.7": c("b"), "dsh-v0.1.7-rc.2": c("a"), "dsh-v0.1.7-rc.1": c("9") }),
		index: index([rel("dsh-v0.1.7-rc.2", c("a"), 1)], [liv(c("1"), 1)]),
	});
	expect(r.builds.map((b) => b.tag)).toEqual(["dsh-v0.1.7", "dsh-v0.1.8"]);
	expect(r.builds[0]).toMatchObject({ channel: "release", commit: c("b"), upstreamVersion: "0.1.7" });
});

test("a multi-commit master advance builds only the observed commit, once", () => {
	const r = upstreamDiff({ lsRemote: ls(c("5"), {}), index: index([], [liv(c("1"), 1), liv(c("2"), 2)]) });
	expect(r.builds).toEqual([{ channel: "live", commit: c("5") }]);
	// The newest live entry (highest seq) decides, not the first.
	expect(upstreamDiff({ lsRemote: ls(c("2"), {}), index: index([], [liv(c("2"), 2), liv(c("1"), 1)]) }).builds).toEqual([]);
});

test("a moved tag fails naming the tag and both commits", () => {
	expect(() => upstreamDiff({ lsRemote: ls(c("1"), { "dsh-v0.1.7-rc.2": c("b") }), index: index([rel("dsh-v0.1.7-rc.2", c("a"), 1)], []) })).toThrow(
		`upstream tag dsh-v0.1.7-rc.2 moved from ${c("a")} to ${c("b")}`,
	);
});

test("a deleted tag is only a notice", () => {
	const r = upstreamDiff({ lsRemote: ls(c("1"), {}), index: index([rel("dsh-v0.1.7-rc.2", c("a"), 1)], [liv(c("1"), 1)]) });
	expect(r.builds).toEqual([]);
	expect(r.notices).toEqual(["upstream tag dsh-v0.1.7-rc.2 was deleted; its release and index entry are kept"]);
});

test("annotated tags use the peeled commit", () => {
	const r = upstreamDiff({ lsRemote: ls(c("1"), {}, { "dsh-v0.1.7-rc.2": c("a") }), index: index([rel("dsh-v0.1.7-rc.2", c("a"), 1)], [liv(c("1"), 1)]) });
	expect(r.builds).toEqual([]);
});

test("addon builds: an unindexed slot dispatches one, an indexed slot none, a switch-back opens a new one", () => {
	const slots: Record<string, { commit: string; kitVersion: string }> = {
		[c("b")]: { commit: c("b"), kitVersion: "0.1.2" },
		[c("c")]: { commit: c("b"), kitVersion: "0.1.2" },
		[c("5")]: { commit: c("5"), kitVersion: "0.1.2" }, // 0.1.2 → 0.1.3 → 0.1.2: new slot
	};
	const slotOf = (commit: string) => slots[commit] ?? null;
	const lsRemote = ls(c("5"), { "dsh-v0.1.7-rc.2": c("b"), "dsh-v0.1.7": c("c") });
	let r = upstreamDiff({ lsRemote, index: index([], []), slotOf });
	expect(r.addons).toEqual([
		{ slot: slots[c("b")], for: c("b") },
		{ slot: slots[c("5")], for: c("5") },
	]);
	r = upstreamDiff({ lsRemote, index: index([], [], [{ slot: { commit: c("b"), kitVersion: "0.1.2" } }, { slot: { commit: c("5"), kitVersion: "0.1.2" } }]), slotOf });
	expect(r.addons).toEqual([]);
	expect(r.builds.map((b) => b.slot?.commit)).toEqual([c("b"), c("b"), c("5")]);
});

test("version precedence", () => {
	const sorted = ["0.1.8", "0.1.7", "0.1.7-rc.10", "0.1.7-rc.2", "0.1.7-beta", "0.1.7-rc.1"].sort(compareVersions);
	expect(sorted).toEqual(["0.1.7-beta", "0.1.7-rc.1", "0.1.7-rc.2", "0.1.7-rc.10", "0.1.7", "0.1.8"]);
});

test("a packaging change rebuilds the newest release and the observed master, once", () => {
	const lsRemote = ls(c("1"), { "dsh-v0.1.7-rc.2": c("a"), "dsh-v0.1.8": c("b") });
	const published = index([rel("dsh-v0.1.8", c("b"), 2), rel("dsh-v0.1.7-rc.2", c("a"), 1)], [liv(c("1"), 1)]);
	const staleBefore = (built: string) => built === c("d");
	const r = upstreamDiff({ lsRemote, index: published, stale: staleBefore });
	expect(r.builds).toEqual([
		{ channel: "release", tag: "dsh-v0.1.8", commit: c("b"), upstreamVersion: "0.1.8" },
		{ channel: "live", commit: c("1") },
	]);
	// Once rebuilt at the new launcher commit, the next poll is a no-op.
	const rebuilt = index([...published.channels.release, rel("dsh-v0.1.8", c("b"), 3, c("e"))], [...published.channels.live, liv(c("1"), 2, c("e"))]);
	expect(upstreamDiff({ lsRemote, index: rebuilt, stale: staleBefore }).builds).toEqual([]);
	// A pending new tag already carries the packaging change: no extra rebuild of the older one.
	const withNewTag = ls(c("1"), { "dsh-v0.1.7-rc.2": c("a"), "dsh-v0.1.8": c("b"), "dsh-v0.1.9": c("9") });
	expect(upstreamDiff({ lsRemote: withNewTag, index: published, stale: staleBefore }).builds.map((b) => b.tag ?? "live")).toEqual(["dsh-v0.1.9", "live"]);
});

test("packagingChanged ignores docs and tests, and sees runtime changes", () => {
	const dir = mkdtempSync(join(tmpdir(), "pkg-changed-"));
	const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: dir, encoding: "utf8" }).trim();
	try {
		git("init", "-q");
		mkdirSync(join(dir, "runtime"));
		mkdirSync(join(dir, "docs"));
		writeFileSync(join(dir, "runtime", "a.ts"), "1");
		git("add", "-A");
		git("commit", "-qm", "base");
		const base = git("rev-parse", "HEAD");
		writeFileSync(join(dir, "docs", "r.md"), "x");
		writeFileSync(join(dir, "README.md"), "x");
		git("add", "-A");
		git("commit", "-qm", "docs");
		const docs = git("rev-parse", "HEAD");
		expect(packagingChanged(base, docs, dir)).toBe(false);
		writeFileSync(join(dir, "runtime", "a.ts"), "2");
		git("commit", "-qam", "runtime");
		expect(packagingChanged(base, git("rev-parse", "HEAD"), dir)).toBe(true);
		expect(packagingChanged(docs, docs, dir)).toBe(false);
		expect(packagingChanged(c("0"), docs, dir)).toBe(true); // unknown commit: rebuild, never stall
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
