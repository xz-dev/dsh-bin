// scripts/index.mjs: append-only index with per-list sequences, validated by the updater's schema check.
import { expect, test } from "bun:test";
import { appendAddon, appendBundle, assertAppendOnly, emptyIndex, serialize } from "../../scripts/index.mjs";
import { newestFor, parseIndex } from "../../runtime/update/index-client.ts";

const sha = (c: string) => c.repeat(64);
const bundle = (tag: string, version: string, channel: string, s = "a") => ({
	tag,
	version,
	channel,
	upstream: { commit: "c".repeat(40) },
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
