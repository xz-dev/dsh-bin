// scripts/upstream-diff.mjs: index-based detection for upstream-poll (8.5) and addon dispatch (8.8).
import { expect, test } from "bun:test";
import { compareVersions, upstreamDiff } from "../../scripts/upstream-diff.mjs";

const c = (ch: string) => ch.repeat(40);
const ls = (master: string, tags: Record<string, string>, annotated: Record<string, string> = {}) =>
	[`${master}\trefs/heads/master`, ...Object.entries(tags).map(([t, s]) => `${s}\trefs/tags/${t}`), ...Object.entries(annotated).flatMap(([t, s]) => [`${c("f")}\trefs/tags/${t}`, `${s}\trefs/tags/${t}^{}`])].join("\n");
const rel = (tag: string, commit: string, seq: number) => ({ seq, tag: `${tag}-xz.1.1.gdeadbeef`, channel: "release", upstream: { tag, commit } });
const liv = (commit: string, seq: number) => ({ seq, tag: `dsh-live-${commit.slice(0, 7)}-xz.1.1.gdeadbeef`, channel: "live", upstream: { commit } });
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
