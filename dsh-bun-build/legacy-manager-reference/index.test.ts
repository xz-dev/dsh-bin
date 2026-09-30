// scripts/index.mjs: append-only index with per-list sequences, validated by the updater's schema check.
import { expect, test } from "bun:test";
import { appendAddon, appendBundle, assertAppendOnly, emptyIndex, serialize } from "../../scripts/index.mjs";
import { newestFor, parseIndex } from "../../runtime/update/index-client.ts";
import { compareVersionOrder, isCommitTime } from "../../runtime/layout.ts";

const sha = (c: string) => c.repeat(64);
const bundle = (tag: string, version: string, channel: string, s = "a") => ({
	tag,
	version,
	channel,
	upstream: { commit: "c".repeat(40), commitTime: "2026-09-24T13:39:59.000Z" },
	run: 1,
	attempt: 1,
	launcherProtocol: 2,
	launcherCommit: "d".repeat(40),
	addons: { office: { slot: { commit: "e".repeat(40), kitVersion: "0.1.2" }, pinned: null } },
	targets: { "linux-arm64": { file: "dsh-linux-arm64.zip", size: 10, sha256: sha(s) } },
});

test("sequences are per list; entries are appended, never modified", () => {
	const i = emptyIndex();
	expect(appendBundle(i, bundle("dsh-v1-xz.1.1.g1", "1-xz.1.1.g1", "release")).seq).toBe(1);
	expect(appendBundle(i, bundle("dsh-live-abc-xz.2.1.g2", "abc-xz.2.1.g2", "live")).seq).toBe(1);
	expect(appendBundle(i, bundle("dsh-v2-xz.3.1.g3", "2-xz.3.1.g3", "release")).seq).toBe(2);
	expect(appendAddon(i, { tag: "dsh-addon-office-v0.1.2-xz.4.1.g4", version: "0.1.2-xz.4.1.g4", slot: { commit: "e".repeat(40), kitVersion: "0.1.2" }, assets: { linux: { file: "dsh-addon-office-linux.zip", size: 5, sha256: sha("f") } } }).seq).toBe(1);
	const parsed = parseIndex(serialize(i));
	expect(newestFor(parsed, "release", "linux-arm64")?.version).toBe("2-xz.3.1.g3");
	expect(parsed.channels.release[0]!.assets["linux-arm64"]).toEqual({ name: "dsh-linux-arm64.zip", size: 10, sha256: sha("a") });
});

test("schema-2 entries carry commit time, run, attempt and launcher protocol", () => {
	const i = emptyIndex();
	appendBundle(i, bundle("dsh-v1-xz.7.2.g1", "1-xz.7.2.g1", "release"));
	const e = parseIndex(serialize(i)).channels.release[0]!;
	expect(i.schemaVersion).toBe(2);
	expect(e).toMatchObject({ upstream: { commitTime: "2026-09-24T13:39:59.000Z" }, run: 1, attempt: 1, launcherProtocol: 2 });
});

test("a schema-1 index is rejected", () => {
	const i = { ...emptyIndex(), schemaVersion: 1 };
	expect(() => parseIndex(JSON.stringify(i))).toThrow("unsupported index schemaVersion 1 (expected 2)");
});

test("entries without the build order are rejected", () => {
	const i = emptyIndex();
	appendBundle(i, bundle("dsh-v1-xz.1.1.g1", "1-xz.1.1.g1", "release"));
	const text = serialize(i);
	const broken = (patch: (e: any) => void) => {
		const j = JSON.parse(text);
		patch(j.channels.release[0]);
		return () => parseIndex(JSON.stringify(j));
	};
	expect(broken((e) => delete e.upstream.commitTime)).toThrow("invalid upstream");
	expect(broken((e) => (e.upstream.commitTime = "2026-09-24T21:39:59+08:00"))).toThrow("invalid upstream");
	expect(broken((e) => (e.run = 0))).toThrow("invalid build order");
	expect(broken((e) => delete e.attempt)).toThrow("invalid build order");
	expect(broken((e) => delete e.launcherProtocol)).toThrow("launcher protocol");
});

test("version order: upstream commit time, then run, then attempt", () => {
	const o = (commitTime: string, run: number, attempt: number, name: string) => ({ upstream: { commitTime }, run, attempt, name });
	const rc2 = o("2026-09-24T13:39:59.000Z", 7, 1, "rc.2 run 7");
	const rc2rebuild = o("2026-09-24T13:39:59.000Z", 21, 1, "rc.2 run 21");
	const rc2retry = o("2026-09-24T13:39:59.000Z", 21, 2, "rc.2 run 21 attempt 2");
	const rc1 = o("2026-09-28T02:00:00.000Z", 10, 1, "rc.1");
	const live = o("2026-09-29T08:00:00.000Z", 3, 1, "live");
	// Upstream time wins over run numbers (live run 3 is still last); equal time falls back to run, then attempt.
	const sorted = [live, rc2retry, rc1, rc2, rc2rebuild].sort(compareVersionOrder).map((x) => x.name);
	expect(sorted).toEqual(["rc.2 run 7", "rc.2 run 21", "rc.2 run 21 attempt 2", "rc.1", "live"]);
	expect(compareVersionOrder(rc2, rc2)).toBe(0);
});

test("commit times are one canonical UTC form", () => {
	expect(isCommitTime("2026-09-24T13:39:59.000Z")).toBe(true);
	for (const bad of ["2026-09-24T21:39:59+08:00", "2026-09-24T13:39:59Z", "yesterday", 1790257199]) expect(isCommitTime(bad)).toBe(false);
});

test("an identical rerun is a no-op; a conflicting one fails", () => {
	const i = emptyIndex();
	appendBundle(i, bundle("dsh-v1-xz.1.1.g1", "1-xz.1.1.g1", "release"));
	appendBundle(i, bundle("dsh-v1-xz.1.1.g1", "1-xz.1.1.g1", "release"));
	expect(i.channels.release).toHaveLength(1);
	expect(() => appendBundle(i, bundle("dsh-v1-xz.1.1.g1", "1-xz.1.1.g1", "release", "b"))).toThrow("never modified");
});

test("assertAppendOnly rejects modified or removed entries", () => {
	const prev = emptyIndex();
	appendBundle(prev, bundle("dsh-v1-xz.1.1.g1", "1-xz.1.1.g1", "release"));
	const removed = structuredClone(prev);
	removed.channels.release = [];
	expect(() => assertAppendOnly(prev, removed)).toThrow("modified or removed");
	const grown = structuredClone(prev);
	appendBundle(grown, bundle("dsh-v2-xz.2.1.g2", "2-xz.2.1.g2", "release"));
	expect(() => assertAppendOnly(prev, grown)).not.toThrow();
});
