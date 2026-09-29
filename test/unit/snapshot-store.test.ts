// Snapshot store (task 4.1, plugin-snapshots spec "Snapshot identity and order", "Automatic snapshot by
// copy" (storage part) and "Snapshot usage claim").
import { afterAll, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aliasProblem, claimSnapshot, createSnapshot, findSnapshot, listSnapshots, newestOf, removeSnapshot, type SnapshotMeta, snapshotDir, snapshotsDir, sweepSnapshotLeftovers } from "../../runtime/snapshot/store.ts";
import { acquireClaim } from "../../runtime/usage-claim.ts";

const WIN = process.platform === "win32";
const CHILD = join(import.meta.dir, "snapshot-child.ts");
const homes: string[] = [];
afterAll(() => {
	for (const h of homes) rmSync(h, { recursive: true, force: true });
});
function newHome() {
	const h = mkdtempSync(join(tmpdir(), "dsh-snap-"));
	homes.push(h);
	return h;
}

const R2 = "0.1.7-rc.2-xz.7.1.g4e41a3f1";
const R1 = "0.2.0-rc.1-xz.10.1.ga83dab63";
const T = { [R2]: "2026-09-24T10:00:00.000Z", [R1]: "2026-09-28T10:00:00.000Z" } as Record<string, string>;
const order = (v: string) => ({ upstream: { commitTime: T[v] ?? "2026-09-01T00:00:00.000Z" }, run: 1, attempt: 1 });
const empty = () => null;

function make(home: string, version: string, opts: { alias?: string; from?: SnapshotMeta } = {}) {
	return createSnapshot(home, { version, order: order(version), reason: "user", alias: opts.alias, source: () => opts.from ?? null }).snapshot;
}
const ids = (home: string) => listSnapshots(home).map((s) => s.id);

test("numbers increase per version and are never reused; the newest is the highest remaining n", () => {
	const home = newHome();
	for (let i = 0; i < 3; i++) make(home, R2);
	expect(ids(home)).toEqual([`${R2}@1`, `${R2}@2`, `${R2}@3`]);
	expect(removeSnapshot(home, `${R2}@3`)).toBe("removed");
	expect(make(home, R2).id).toBe(`${R2}@4`);
	expect(newestOf(listSnapshots(home), R2)?.id).toBe(`${R2}@4`);
	// Removing every snapshot does not reset the counter either.
	for (const id of ids(home)) removeSnapshot(home, id);
	expect(make(home, R2).id).toBe(`${R2}@5`);
	// Another version counts on its own.
	expect(make(home, R1).id).toBe(`${R1}@1`);
});

test("remove in the middle closes the gap; the order is version order, then n", () => {
	const home = newHome();
	make(home, R1);
	for (let i = 0; i < 3; i++) make(home, R2);
	removeSnapshot(home, `${R2}@2`);
	expect(ids(home)).toEqual([`${R2}@1`, `${R2}@3`, `${R1}@1`]);
	expect(newestOf(listSnapshots(home), R2)?.id).toBe(`${R2}@3`);
	expect(existsSync(snapshotDir(home, `${R2}@2`))).toBe(false);
	expect(readdirSync(snapshotsDir(home)).filter((n) => n.startsWith(".trash-") || n.startsWith(".staging-"))).toEqual([]);
});

test("aliases: unique per version, not all digits, and any accepted version form finds the snapshot", () => {
	const home = newHome();
	const s = make(home, R1, { alias: "before-caveman" });
	make(home, R2, { alias: "before-caveman" });
	const list = listSnapshots(home);
	for (const id of [`${R1}@before-caveman`, `${R1}@1`, "0.2.0-rc.1@before-caveman", "0.2.0-rc.1@1", `dsh-v${R1}@1`]) {
		expect(findSnapshot(list, id)).toEqual({ kind: "found", snapshot: s });
	}
	expect(findSnapshot(list, "0.2.0-rc.1@2").kind).toBe("unknown");
	expect(findSnapshot(list, "0.1.5@1").kind).toBe("unknown");
	expect(findSnapshot(list, "0.@1").kind).toBe("ambiguous");
	expect(findSnapshot(list, "nover").kind).toBe("invalid");
	expect(aliasProblem("123", [])).toContain("all digits");
	expect(aliasProblem("a/b", [])).toContain("invalid snapshot name");
	expect(() => make(home, R1, { alias: "before-caveman" })).toThrow(`snapshot name before-caveman is already used by ${R1}@1`);
	// A refused alias allocates no number.
	expect(make(home, R1).id).toBe(`${R1}@2`);
});

test("a copy is a full copy of the runtime with symlinks kept; metadata records source and reason", () => {
	const home = newHome();
	const src = make(home, R2);
	const tui = join(snapshotDir(home, src.id), "profiles", "tui");
	mkdirSync(join(tui, "node_modules", ".bin"), { recursive: true });
	mkdirSync(join(tui, "node_modules", "x"), { recursive: true });
	writeFileSync(join(tui, "node_modules", "x", "cli.js"), "cli");
	writeFileSync(join(tui, "package.json"), "{}");
	writeFileSync(join(tui, "cordis.yml"), "plugins: {}\n");
	if (!WIN) symlinkSync("../x/cli.js", join(tui, "node_modules", ".bin", "x"));
	const copy = createSnapshot(home, { version: R1, order: order(R1), reason: "install", source: (l) => newestOf(l, R2)! }).snapshot;
	expect(copy).toMatchObject({ id: `${R1}@1`, version: R1, n: 1, source: src.id, reason: "install" });
	const dest = join(snapshotDir(home, copy.id), "profiles", "tui");
	expect(readFileSync(join(dest, "node_modules", "x", "cli.js"), "utf8")).toBe("cli");
	expect(readFileSync(join(dest, "cordis.yml"), "utf8")).toBe("plugins: {}\n");
	if (!WIN) {
		expect(lstatSync(join(dest, "node_modules", ".bin", "x")).isSymbolicLink()).toBe(true);
		expect(readlinkSync(join(dest, "node_modules", ".bin", "x"))).toBe("../x/cli.js");
	}
	// The copy is independent of its source.
	writeFileSync(join(dest, "package.json"), '{"changed":true}');
	expect(readFileSync(join(tui, "package.json"), "utf8")).toBe("{}");
	const meta = JSON.parse(readFileSync(join(snapshotDir(home, copy.id), "snapshot.json"), "utf8"));
	expect(meta).toMatchObject({ id: copy.id, version: R1, n: 1, source: src.id, reason: "install", order: order(R1) });
	expect(Number.isNaN(Date.parse(meta.createdAt))).toBe(false);
	expect(createSnapshot(home, { version: R2, order: order(R2), reason: "user", source: empty }).snapshot.source).toBe("empty");
});

test("automatic creation (ifNone) returns the existing newest snapshot", () => {
	const home = newHome();
	make(home, R2);
	make(home, R2);
	const r = createSnapshot(home, { version: R2, order: order(R2), reason: "start", ifNone: true, source: empty });
	expect(r).toMatchObject({ created: false, snapshot: { id: `${R2}@2` } });
});

async function spawnChild(home: string, ...args: string[]) {
	const proc = Bun.spawn([process.execPath, CHILD, home, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, DSH_BIN_TEST: "1" } });
	return proc;
}

test("concurrent automatic creation yields exactly one snapshot", async () => {
	const home = newHome();
	const procs = await Promise.all(Array.from({ length: 4 }, () => spawnChild(home, "create", R1, T[R1]!)));
	const outs = await Promise.all(procs.map(async (p) => ((await p.exited) === 0 ? (await new Response(p.stdout).text()).trim() : `failed ${await new Response(p.stderr).text()}`)));
	expect(ids(home)).toEqual([`${R1}@1`]);
	expect(outs.sort()).toEqual([`${R1}@1 false`, `${R1}@1 false`, `${R1}@1 false`, `${R1}@1 true`]);
}, 30_000);

test("a running snapshot is protected; SIGKILL releases the claim", async () => {
	const home = newHome();
	const s = make(home, R2);
	const proc = await spawnChild(home, "hold", s.id);
	const reader = proc.stdout.getReader();
	const { value } = await reader.read();
	expect(new TextDecoder().decode(value)).toBe("held\n");
	expect(removeSnapshot(home, s.id)).toBe("busy");
	expect(ids(home)).toEqual([s.id]);
	proc.kill("SIGKILL");
	await proc.exited;
	let result = removeSnapshot(home, s.id);
	for (let i = 0; i < 30 && result === "busy"; i++) {
		await Bun.sleep(100);
		result = removeSnapshot(home, s.id);
	}
	expect(result).toBe("removed");
	expect(ids(home)).toEqual([]);
}, 30_000);

test("the shared claim stacks and blocks exclusive removal until released", () => {
	const home = newHome();
	const s = make(home, R2);
	const a = claimSnapshot(home, s.id);
	const b = claimSnapshot(home, s.id);
	expect(typeof a).toBe("object");
	expect(typeof b).toBe("object");
	expect(acquireClaim(join(snapshotDir(home, s.id), ".usage.lock"), "exclusive")).toBe("busy");
	if (typeof a === "object") a.release();
	if (typeof b === "object") b.release();
	expect(claimSnapshot(home, `${R2}@9`)).toBe("missing");
	expect(removeSnapshot(home, s.id)).toBe("removed");
});

test("an interrupted copy leaves no snapshot; its staging is swept and n is not reused", async () => {
	const home = newHome();
	make(home, R2);
	const proc = Bun.spawn([process.execPath, CHILD, home, "create", R1, T[R1]!], { stdout: "pipe", stderr: "pipe", env: { ...process.env, DSH_BIN_TEST: "1", DSH_BIN_TEST_CRASH: "snapshot-copied" } });
	expect(await proc.exited).not.toBe(0);
	expect(ids(home)).toEqual([`${R2}@1`]);
	expect(readdirSync(snapshotsDir(home)).some((n) => n.startsWith(".staging-"))).toBe(true);
	// The lock died with the process: the next operation proceeds and sweeps the staging copy.
	expect(sweepSnapshotLeftovers(home)).toBe(1);
	expect(readdirSync(snapshotsDir(home)).filter((n) => n.startsWith("."))).toEqual([".counters.json", ".lock"].sort());
	expect(createSnapshot(home, { version: R1, order: order(R1), reason: "start", ifNone: true, source: empty }).snapshot.id).toBe(`${R1}@2`);
}, 30_000);

test("unreadable snapshot directories are ignored, never guessed", () => {
	const home = newHome();
	make(home, R2);
	mkdirSync(join(snapshotsDir(home), `${R2}@7`));
	writeFileSync(join(snapshotsDir(home), `${R2}@7`, "snapshot.json"), "{");
	expect(ids(home)).toEqual([`${R2}@1`]);
	// Its number stays taken: the counter moves past it only through allocation, and a directory clash fails loudly.
	expect(() => {
		for (let i = 0; i < 7; i++) make(home, R2);
	}).toThrow();
});
