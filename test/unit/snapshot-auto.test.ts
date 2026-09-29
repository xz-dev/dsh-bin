// Automatic snapshot by copy (task 4.2, plugin-snapshots spec "Automatic snapshot by copy").
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createdLine, ensureSnapshot, previousSource } from "../../runtime/snapshot/auto.ts";
import { createSnapshot, listSnapshots, removeSnapshot, snapshotDir } from "../../runtime/snapshot/store.ts";

const homes: string[] = [];
afterAll(() => {
	for (const h of homes) rmSync(h, { recursive: true, force: true });
});
function newHome() {
	const h = mkdtempSync(join(tmpdir(), "dsh-snap-auto-"));
	homes.push(h);
	return h;
}

const V = {
	R2: { version: "0.1.7-rc.2-xz.7.1.g4e41a3f1", upstream: { commitTime: "2026-09-24T10:00:00.000Z" }, run: 7, attempt: 1 },
	R2B: { version: "0.1.7-rc.2-xz.21.1.g4e41a3f1", upstream: { commitTime: "2026-09-24T10:00:00.000Z" }, run: 21, attempt: 1 },
	R1: { version: "0.2.0-rc.1-xz.10.1.ga83dab63", upstream: { commitTime: "2026-09-28T10:00:00.000Z" }, run: 10, attempt: 1 },
	L1: { version: "0.2.1-xz.11.1.gdeadbeef", upstream: { commitTime: "2026-09-29T10:00:00.000Z" }, run: 11, attempt: 1 },
};
type B = (typeof V)[keyof typeof V];

const user = (home: string, b: B, marker?: string) => {
	const s = createSnapshot(home, { version: b.version, order: b, reason: "user", source: () => null }).snapshot;
	if (marker) {
		mkdirSync(join(snapshotDir(home, s.id), "profiles", "tui", "node_modules", "p"), { recursive: true });
		writeFileSync(join(snapshotDir(home, s.id), "profiles", "tui", "node_modules", "p", "index.js"), marker);
	}
	return s;
};
const marker = (home: string, id: string) => {
	const p = join(snapshotDir(home, id), "profiles", "tui", "node_modules", "p", "index.js");
	return existsSync(p) ? readFileSync(p, "utf8") : undefined;
};

test("first install: no snapshot anywhere gives an empty <version>@1", () => {
	const home = newHome();
	const r = ensureSnapshot(home, V.R2.version, V.R2, "start");
	expect(r).toMatchObject({ created: true, snapshot: { id: `${V.R2.version}@1`, source: "empty", reason: "start" } });
	expect(readdirSync(join(snapshotDir(home, r.snapshot.id), "profiles"))).toEqual([]);
	expect(createdLine(r.snapshot)).toBe(`Created plugin snapshot ${V.R2.version}@1 (empty).`);
	// Idempotent: the version now has a snapshot.
	expect(ensureSnapshot(home, V.R2.version, V.R2, "start")).toMatchObject({ created: false, snapshot: { id: `${V.R2.version}@1` } });
});

test("Tumbleweed-style update: the new version copies the previous version's newest snapshot", () => {
	const home = newHome();
	user(home, V.R2, "one");
	user(home, V.R2, "two");
	const r = ensureSnapshot(home, V.R1.version, V.R1, "install");
	expect(r.snapshot).toMatchObject({ id: `${V.R1.version}@1`, source: `${V.R2.version}@2`, reason: "install" });
	expect(marker(home, r.snapshot.id)).toBe("two");
	expect(createdLine(r.snapshot)).toBe(`Created plugin snapshot ${V.R1.version}@1 (copy of ${V.R2.version}@2).`);
});

test("all snapshots removed: the next one is @<next n>, copied from the previous version", () => {
	const home = newHome();
	user(home, V.R2, "prev");
	const a = user(home, V.R1, "mine");
	removeSnapshot(home, a.id);
	const r = ensureSnapshot(home, V.R1.version, V.R1, "start");
	expect(r.snapshot).toMatchObject({ id: `${V.R1.version}@2`, source: `${V.R2.version}@1`, reason: "start" });
	expect(marker(home, r.snapshot.id)).toBe("prev");
});

test("the previous version is the nearest earlier one in version order that has a snapshot", () => {
	const home = newHome();
	user(home, V.R2, "r2");
	user(home, V.R2B, "r2b");
	user(home, V.L1, "later");
	// R2B (a later run of the same upstream commit) is nearer than R2; L1 is later, never a source.
	const r = ensureSnapshot(home, V.R1.version, V.R1, "install");
	expect(r.snapshot.source).toBe(`${V.R2B.version}@1`);
	expect(marker(home, r.snapshot.id)).toBe("r2b");
	// Nothing earlier: empty, even though a later version has snapshots.
	const first = newHome();
	user(first, V.L1, "later");
	expect(ensureSnapshot(first, V.R2.version, V.R2, "start").snapshot.source).toBe("empty");
});

test("uninstalled source: the order comes from snapshot.json, not from installed bundles", () => {
	// No install root exists at all here: only snapshot metadata orders the versions.
	const home = newHome();
	user(home, V.R2, "gone");
	expect(previousSource(listSnapshots(home), V.R1.version, V.R1)?.id).toBe(`${V.R2.version}@1`);
	expect(marker(home, ensureSnapshot(home, V.R1.version, V.R1, "install").snapshot.id)).toBe("gone");
});
