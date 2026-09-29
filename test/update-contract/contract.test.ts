// Golden update-behaviour contract (7.10; self-update spec "Update behaviour contract tests"). Each case
// runs the real compiled entry of a fixture bundle, whose upstream `app/lib/bin.js` implements its own
// `update` command, against a local fixture index/download server. Every case pins the exit status,
// output substrings, the exact requests made and the resulting filesystem state.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { acquireClaim, type Claim } from "../../runtime/usage-claim.ts";
import {
	ADDON_PLATFORM,
	addAddon,
	addBundle,
	compiledNative,
	dsh,
	EXE,
	installRoot,
	launch,
	type AddonSpec,
	type RunResult,
	removeRoot,
	type ServeOptions,
	serve,
	SLOT_A,
	SLOT_B,
	snapshot,
	TARGET,
	tagOf,
	orderTime,
	addonTag,
	type World,
} from "./harness.ts";
import { buildWorld, SLOT_A2, V } from "./worlds.ts";
import { claimSnapshot, createSnapshot, listSnapshots, snapshotDir } from "../../runtime/snapshot/store.ts";

let world: World;
let evilEntry: any;
const roots: string[] = [];

beforeAll(() => {
	const built = buildWorld();
	world = built.world;
	evilEntry = built.evil;
}, 120_000);
afterAll(() => {
	for (const r of roots) removeRoot(r);
	world?.dispose();
});

const bundleUrl = (channel: "release" | "live", v: string) => `/download/${tagOf(channel, v)}/dsh-${TARGET}.zip`;
const addonUrl = (v: string) => `/download/${addonTag(v)}/dsh-addon-office-${ADDON_PLATFORM}.zip`;
const INDEX = "/index.json";
/** An unreachable index (HTTP 503) is tried INDEX_ATTEMPTS times. */
const INDEX_TRIES = [INDEX, INDEX, INDEX];

type Root = { version: string; channelFile?: "release" | "live"; managed?: string; addons?: AddonSpec[]; extra?: string[] };

type Step = {
	argv: string[];
	serve?: ServeOptions;
	offline?: boolean;
	/** Run through the root launcher instead of the given bundle's entry. */
	viaLauncher?: boolean;
	/** Bundle whose entry runs (default: the root's initial version). */
	from?: string;
	/** Extra environment for the run (`root` is substituted with the install root). */
	env?: (root: string) => Record<string, string>;
	code: number;
	stdout?: (string | RegExp)[];
	stderr?: (string | RegExp)[];
	requests?: string[];
	unchanged?: boolean;
	check?: (root: string, r: RunResult) => void;
};
type Case = { name: string; root: Root; arrange?: (root: string) => (() => void) | void; steps: Step[] };

const bundles = (root: string) => readdirSync(join(root, "bundles")).sort();
const channelFile = (root: string) => (existsSync(join(root, "channel")) ? readFileSync(join(root, "channel"), "utf8").trim() : undefined);
const launcherOf = (root: string) => /DSH_BIN_LAUNCHER_VERSION=(\S+)/.exec(readFileSync(join(root, `dsh${EXE}`), "utf8"))?.[1];
const leftovers = (root: string) => readdirSync(root).filter((n) => n.startsWith(".staging-") || n.startsWith(".trash-") || n === "update.lock");
/**
 * Leftovers once the next maintenance run has swept. Windows cannot delete the executable a process is
 * running from, so a generation retired by the dsh running from it stays quarantined in `.trash-*` until
 * then; everywhere else it is removed at once.
 */
const settledLeftovers = async (root: string, origin: string) => {
	if (process.platform === "win32" && leftovers(root).some((n) => n.startsWith(".trash-"))) await launch(root, ["update"], origin);
	return leftovers(root);
};
const isReadOnly = (dir: string) => {
	try {
		writeFileSync(join(dir, ".probe"), "");
		return false;
	} catch {
		return true;
	}
};
const holdShared = (root: string, v: string): Claim => {
	const c = acquireClaim(join(root, "bundles", v, ".usage.lock"), "shared");
	if (c === "busy") throw new Error("claim busy");
	return c;
};
const json = (r: RunResult) => JSON.parse(r.stdout);
const corrupt = (b: Uint8Array) => {
	const c = Uint8Array.from(b);
	c[c.length >> 1] ^= 0xff;
	return c;
};

const UNCHANGED_UPDATE = { unchanged: true };

// ── dsh select (version-selection) ────────────────────────────────────────────────────────────────────
const homeOf = (root: string) => join(`${root}-home`, ".dsh");
const selectionFile = (root: string) => join(homeOf(root), "dsh-bin", "selection.json");
const selectionOf = (root: string) => (existsSync(selectionFile(root)) ? JSON.parse(readFileSync(selectionFile(root), "utf8")) : undefined);
const writeSel = (root: string, s: unknown) => {
	mkdirSync(join(homeOf(root), "dsh-bin"), { recursive: true });
	writeFileSync(selectionFile(root), typeof s === "string" ? s : JSON.stringify(s));
};
const snap = (root: string, version: string, seq: number, alias?: string) =>
	createSnapshot(homeOf(root), { version, order: { upstream: { commitTime: orderTime(seq) }, run: seq, attempt: 1 }, reason: "user", alias, source: () => null }).snapshot.id;
/** The selection file is left exactly as it was. */
const selectionKept = (before: unknown) => (root: string) => expect(selectionOf(root)).toEqual(before);

// ── dsh snapshot (plugin-snapshots "Snapshot commands") ────────────────────────────────────────────────────────────
const snapIds = (root: string) => listSnapshots(homeOf(root)).map((s) => s.id);
const snapMeta = (root: string, id: string) => listSnapshots(homeOf(root)).find((s) => s.id === id);
/** A file in a snapshot's tui runtime, standing for an installed plugin. */
const plugin = (root: string, id: string, name: string) => {
	const dir = join(snapshotDir(homeOf(root), id), "profiles", "tui", "node_modules", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), `{"name":"${name}"}`);
};
const hasPlugin = (root: string, id: string, name: string) => existsSync(join(snapshotDir(homeOf(root), id), "profiles", "tui", "node_modules", name, "package.json"));
const holdSnapshot = (root: string, id: string) => {
	const c = claimSnapshot(homeOf(root), id);
	if (typeof c === "string") throw new Error(`claim ${c}`);
	return () => c.release();
};

const snapshotCases: Case[] = [
	{
		name: "snapshot: migrate a runtime to another version with --use … snapshot new --target",
		root: { version: V.R1, extra: [V.R2] },
		arrange: (root) => {
			snap(root, V.R1, 1);
			snap(root, V.R1, 1);
			plugin(root, `${V.R1}@2`, "dsh-caveman");
			snap(root, V.R2, 2);
		},
		steps: [
			{
				argv: ["--use", "0.1.7-rc.2-xz.2", "snapshot", "new", "--target", "0.1.7-rc.2-xz.1@2"],
				code: 0,
				stdout: [`Created plugin snapshot ${V.R2}@2 (copy of ${V.R1}@2).`],
				requests: [],
				unchanged: true,
				check: (root) => {
					expect(snapMeta(root, `${V.R2}@2`)).toMatchObject({ source: `${V.R1}@2`, reason: "user" });
					expect(hasPlugin(root, `${V.R2}@2`, "dsh-caveman")).toBe(true);
				},
			},
			// It is now R2's newest: the next plain start of R2 uses it.
			{ argv: ["select", "--use", V.R2], code: 0, stdout: [`snapshot: ${V.R2}@2 (newest)`] },
		],
	},
	{
		name: "snapshot: new copies the effective version's newest; --empty, --name; numbers are never reused",
		root: { version: V.R1 },
		arrange: (root) => {
			snap(root, V.R1, 1);
			plugin(root, `${V.R1}@1`, "dsh-caveman");
		},
		steps: [
			{ argv: ["snapshot", "new", "--name", "before-caveman"], code: 0, stdout: [`Created plugin snapshot ${V.R1}@2 (copy of ${V.R1}@1).`], check: (root) => expect(hasPlugin(root, `${V.R1}@2`, "dsh-caveman")).toBe(true) },
			{ argv: ["snapshot", "new", "--empty"], code: 0, stdout: [`Created plugin snapshot ${V.R1}@3 (empty).`], check: (root) => expect(hasPlugin(root, `${V.R1}@3`, "dsh-caveman")).toBe(false) },
			{ argv: ["snapshot", "remove", `${V.R1}@3`], code: 0, stdout: [`Removed snapshot ${V.R1}@3.`] },
			{ argv: ["snapshot", "new"], code: 0, stdout: [`Created plugin snapshot ${V.R1}@4 (copy of ${V.R1}@2).`] },
			// The alias names the same snapshot under a version prefix.
			{ argv: ["select", "--use", "latest", "--snapshot", "0.1.7-rc.2-xz.1@before-caveman"], code: 0, stdout: [`Selected --use latest --snapshot ${V.R1}@2.`] },
			{
				argv: ["snapshot", "list", "--json"],
				code: 0,
				check: (_root, r) =>
					expect(json(r).snapshots).toEqual([
						expect.objectContaining({ id: `${V.R1}@1`, alias: null, source: "empty", reason: "user", newest: false, selected: false, inUse: false, bundleInstalled: true }),
						expect.objectContaining({ id: `${V.R1}@2`, alias: "before-caveman", source: `${V.R1}@1`, newest: false, selected: true }),
						expect.objectContaining({ id: `${V.R1}@4`, alias: null, source: `${V.R1}@2`, newest: true, selected: false }),
					]),
			},
		],
	},
	{
		name: "snapshot before a risky change: removing the broken newest goes back to the previous one; removing the middle closes the gap",
		root: { version: V.R1 },
		arrange: (root) => {
			snap(root, V.R1, 1, "first");
			snap(root, V.R1, 1);
		},
		steps: [
			{ argv: ["snapshot", "new"], code: 0, stdout: [`Created plugin snapshot ${V.R1}@3 (copy of ${V.R1}@2).`], check: (root) => plugin(root, `${V.R1}@3`, "broken-plugin") },
			{ argv: ["select"], code: 0, stdout: [`snapshot: ${V.R1}@3 (newest)`] },
			{ argv: ["snapshot", "remove", `${V.R1}@3`], code: 0, stdout: [`Removed snapshot ${V.R1}@3.`], check: (root) => expect(snapIds(root)).toEqual([`${V.R1}@1`, `${V.R1}@2`]) },
			{ argv: ["select"], code: 0, stdout: [`snapshot: ${V.R1}@2 (newest)`], check: (root) => expect(hasPlugin(root, `${V.R1}@2`, "broken-plugin")).toBe(false) },
			{ argv: ["snapshot", "remove", `${V.R1}@2`], code: 0, check: (root) => expect(snapIds(root)).toEqual([`${V.R1}@1`]) },
			{ argv: ["snapshot", "list"], code: 0, stdout: [`${V.R1}@1 (first)`, "[newest]"] },
		],
	},
	{
		name: "snapshot remove: in use or named by the selection is refused; several ids are all or none",
		root: { version: V.R1 },
		arrange: (root) => {
			snap(root, V.R1, 1);
			snap(root, V.R1, 1);
			snap(root, V.R1, 1);
			writeSel(root, { schema: 1, use: "latest", snapshot: `${V.R1}@3`, addons: {} });
			return holdSnapshot(root, `${V.R1}@1`);
		},
		steps: [
			{ argv: ["snapshot", "remove", `${V.R1}@1`], code: 1, stderr: [`snapshot ${V.R1}@1 is in use`], unchanged: true, check: (root) => expect(snapIds(root)).toHaveLength(3) },
			{ argv: ["snapshot", "remove", `${V.R1}@2`, `${V.R1}@1`], code: 1, stderr: ["in use", "nothing was removed"], check: (root) => expect(snapIds(root)).toHaveLength(3) },
			{ argv: ["snapshot", "remove", `${V.R1}@3`], code: 1, stderr: [`snapshot ${V.R1}@3 is named by the selection`, "dsh select"], check: (root) => expect(snapIds(root)).toHaveLength(3) },
			{ argv: ["snapshot", "list"], code: 0, stdout: [`${V.R1}@1  `, "[in use]", "[newest, selected]"] },
		],
	},
	{
		name: "snapshot: argument errors and unknown ids exit 1 and change nothing",
		root: { version: V.R1 },
		arrange: (root) => void snap(root, V.R1, 1, "a"),
		steps: [
			{ argv: ["snapshot", "new", "--target", `${V.R1}@1`, "--empty"], code: 1, stderr: ["--target cannot be combined with --empty"] },
			{ argv: ["snapshot", "new", "--target", `${V.R1}@9`], code: 1, stderr: [`snapshot ${V.R1}@9 does not exist`] },
			{ argv: ["snapshot", "new", "--name", "a"], code: 1, stderr: [`snapshot name a is already used by ${V.R1}@1`] },
			{ argv: ["snapshot", "new", "--name", "12"], code: 1, stderr: ["cannot be all digits"] },
			{ argv: ["snapshot", "new", "--json"], code: 1, stderr: ['Unknown option --json for "snapshot new"'] },
			{ argv: ["snapshot", "new", "--bogus"], code: 1, stderr: ["Unknown option --bogus"] },
			{ argv: ["snapshot", "remove", `${V.R1}@9`], code: 1, stderr: [`snapshot ${V.R1}@9 does not exist`] },
			{ argv: ["snapshot", "remove"], code: 1, stderr: ["requires at least one snapshot id"] },
			{ argv: ["snapshot", "prune"], code: 1, stderr: ["Unknown snapshot action prune"] },
			{ argv: ["snapshot"], code: 1, stderr: ["requires an action"], check: (root) => expect(snapIds(root)).toEqual([`${V.R1}@1`]) },
		],
	},
	{
		name: "snapshot new with no source names --empty; list marks a snapshot whose bundle is not installed",
		root: { version: V.R1 },
		arrange: (root) => void snap(root, V.L1, 0),
		steps: [
			{ argv: ["snapshot", "new"], code: 1, stderr: [`dsh ${V.R1} has no snapshot to copy`, "dsh snapshot new --empty"], check: (root) => expect(snapIds(root)).toEqual([`${V.L1}@1`]) },
			{ argv: ["snapshot", "list"], code: 0, stdout: [`${V.L1}@1`, "bundle not installed"] },
			{ argv: ["snapshot", "list", "--json"], code: 0, check: (_root, r) => expect(json(r).snapshots[0]).toMatchObject({ id: `${V.L1}@1`, bundleInstalled: false, newest: true }) },
			// A snapshot of an uninstalled version still starts on an installed one.
			{ argv: ["select", "--use", V.R1, "--snapshot", `${V.L1}@1`], code: 0, stdout: [`snapshot: ${V.L1}@1`] },
		],
	},
	{
		name: "snapshot commands work in a managed install; --use is refused there",
		root: { version: V.R1, managed: "portage" },
		arrange: (root) => void snap(root, V.R1, 1),
		steps: [
			{ argv: ["snapshot", "new"], code: 0, stdout: [`Created plugin snapshot ${V.R1}@2 (copy of ${V.R1}@1).`] },
			{ argv: ["snapshot", "remove", `${V.R1}@1`], code: 0 },
			{ argv: ["snapshot", "list"], code: 0, stdout: [`${V.R1}@2`] },
			{ argv: ["--use", V.R1, "snapshot", "new"], code: 1, stderr: ["--use is not available", "managed by portage"], check: (root) => expect(snapIds(root)).toEqual([`${V.R1}@2`]) },
		],
	},
	{
		name: "snapshot list with no snapshots",
		root: { version: V.R1 },
		steps: [
			{ argv: ["snapshot", "list"], code: 0, stdout: ["No snapshots yet"], requests: [], unchanged: true },
			{ argv: ["snapshot", "list", "--json"], code: 0, check: (_root, r) => expect(json(r)).toEqual({ snapshots: [] }) },
		],
	},
];

// ── dsh install <version> / dsh uninstall <version> (self-update "Installing and uninstalling versions") ──
const versionCases: Case[] = [
	{
		name: "install an older version by upstream version: its newest build, next to the others; launcher and selection untouched",
		root: { version: V.R3 },
		steps: [
			{
				argv: ["install", "0.1.7-rc.2"],
				code: 0,
				stdout: [`Installed dsh ${V.R2}`, `Created plugin snapshot ${V.R2}@1 (empty).`],
				requests: [INDEX, bundleUrl("release", V.R2)],
				check: (root) => {
					expect(bundles(root)).toEqual([V.R2, V.R3].sort());
					expect(launcherOf(root)).toBe(V.R3);
					expect(isReadOnly(join(root, "bundles", V.R2))).toBe(true);
					expect(selectionOf(root)).toBeUndefined();
					expect(leftovers(root)).toEqual([]);
				},
			},
			{ argv: ["select", "--use", "0.1.7-rc.2"], code: 0, stdout: [`Selected --use ${V.R2}.`] },
			// Already installed: nothing downloaded; --force reinstalls it.
			{ argv: ["install", `dsh-v${V.R2}`], code: 0, stdout: [`dsh ${V.R2} is already installed.`], requests: [INDEX], unchanged: true },
			{ argv: ["install", V.R2, "--force"], code: 0, stdout: [`Installed dsh ${V.R2}`], requests: [INDEX, bundleUrl("release", V.R2)], check: (root) => expect(launcherOf(root)).toBe(V.R3) },
		],
	},
	{
		name: "install replaces a launcher of an older protocol (no protocol marker = protocol 1)",
		root: { version: V.R3 },
		arrange: (root) => {
			const path = join(root, `dsh${EXE}`);
			const old = readFileSync(path, "utf8").replace(/# DSH_BIN_LAUNCHER_PROTOCOL=\d+\n/, "");
			chmodSync(path, 0o755);
			writeFileSync(path, old);
		},
		steps: [{ argv: ["install", V.R1], code: 0, stdout: [`Installed dsh ${V.R1}`], check: (root) => expect(launcherOf(root)).toBe(V.R1) }],
	},
	{
		name: "install a newer version while pinned warns and keeps the selection",
		root: { version: V.R1 },
		arrange: (root) => writeSel(root, { schema: 1, use: V.R1, snapshot: null, addons: {} }),
		steps: [
			{
				argv: ["install", V.R2],
				code: 0,
				stdout: [`Installed dsh ${V.R2}`],
				stderr: [`plain \`dsh\` still starts ${V.R1}`, "dsh select --use latest"],
				check: selectionKept({ schema: 1, use: V.R1, snapshot: null, addons: {} }),
			},
		],
	},
	{
		name: "install: a version not in the channel's index entries exits 1 with no download",
		root: { version: V.R1 },
		steps: [
			{ argv: ["install", "9.9.9"], code: 1, stderr: ["no release entry of the release index matches 9.9.9"], requests: [INDEX], unchanged: true },
			// The live build is found only on the live channel.
			{ argv: ["install", "0.1.7-rc.1"], code: 1, stderr: ["no release entry", "dsh list"], requests: [INDEX], unchanged: true },
			{ argv: ["install", "0.1.7-rc.1", "--channel", "live"], code: 0, stdout: [`Installed dsh ${V.L1}`], requests: [INDEX, bundleUrl("live", V.L1)], check: (root) => expect(channelFile(root)).toBeUndefined() },
		],
	},
	{
		name: "uninstall keeps snapshots; they still start on another version",
		root: { version: V.R2, extra: [V.R1] },
		arrange: (root) => {
			snap(root, V.R1, 1);
			snap(root, V.R1, 1);
			snap(root, V.R2, 2);
		},
		steps: [
			{
				argv: ["uninstall", "0.1.7-rc.2-xz.1"],
				code: 0,
				stdout: [`Uninstalled dsh ${V.R1}; its plugin snapshots are kept`],
				requests: [],
				check: (root) => {
					expect(bundles(root)).toEqual([V.R2]);
					expect(snapIds(root)).toEqual([`${V.R1}@1`, `${V.R1}@2`, `${V.R2}@1`]);
					expect(leftovers(root)).toEqual([]);
				},
			},
			{ argv: ["snapshot", "list", "--json"], code: 0, check: (_root, r) => expect(json(r).snapshots.filter((s: { bundleInstalled: boolean }) => !s.bundleInstalled).map((s: { id: string }) => s.id)).toEqual([`${V.R1}@1`, `${V.R1}@2`]) },
			{ argv: ["select", "--use", V.R2, "--snapshot", `${V.R1}@2`], code: 0, stdout: [`version:  ${V.R2}`, `snapshot: ${V.R1}@2`] },
			// A later sweep never brings the uninstalled bundle back.
			{ argv: ["clean", "--update"], code: 0, check: (root) => expect(bundles(root)).toEqual([V.R2]) },
		],
	},
	{
		name: "uninstall refuses the pinned, the last and an in-use version; several are all or none",
		root: { version: V.R3, extra: [V.R1, V.R2] },
		arrange: (root) => {
			writeSel(root, { schema: 1, use: "0.1.7-rc.2-xz.2", snapshot: null, addons: {} });
			const held = holdShared(root, V.R1);
			return () => held.release();
		},
		steps: [
			{ argv: ["uninstall", V.R2], code: 1, stderr: [`dsh ${V.R2} is pinned by the selection`, "dsh select --use latest"], requests: [], unchanged: true },
			{ argv: ["uninstall", V.R1], code: 1, stderr: [`dsh ${V.R1} is in use`, "nothing was uninstalled"], unchanged: true },
			{ argv: ["uninstall", V.R3, V.R1], code: 1, stderr: ["in use"], unchanged: true, check: (root) => expect(bundles(root)).toEqual([V.R1, V.R2, V.R3].sort()) },
			{ argv: ["uninstall", V.R1, V.R2, V.R3], code: 1, stderr: ["cannot uninstall every installed version"], unchanged: true },
			{ argv: ["uninstall", "0.1.5"], code: 1, stderr: ["dsh 0.1.5 is not installed"], unchanged: true },
			{ argv: ["uninstall", "0.1.7"], code: 1, stderr: ["version 0.1.7 is ambiguous"], unchanged: true },
		],
	},
	{
		name: "uninstall the last installed version is refused",
		root: { version: V.R1 },
		steps: [{ argv: ["uninstall", V.R1], code: 1, stderr: [`cannot uninstall dsh ${V.R1}, the last installed version`], requests: [], unchanged: true }],
	},
];

const selectCases: Case[] = [
	{
		name: "select with no options prints the initial state: latest, the newest snapshot, default addons",
		root: { version: V.R1, extra: [V.R2] },
		arrange: (root) => void snap(root, V.R2, 2),
		steps: [
			{
				argv: ["select"],
				code: 0,
				stdout: ["selection: --use latest", `version:  ${V.R2} (latest on the release channel)`, `snapshot: ${V.R2}@1 (newest)`, "office:   none installed for this version; run `dsh install --addon office`"],
				requests: [],
				unchanged: true,
				check: (root) => expect(selectionOf(root)).toBeUndefined(),
			},
		],
	},
	{
		name: "initial state follows the newest install",
		root: { version: V.R1 },
		steps: [
			{ argv: ["update"], code: 0, stdout: [`Updated dsh from ${V.R1} to ${V.R3}`], requests: [INDEX, bundleUrl("release", V.R3)] },
			{ argv: ["select"], code: 0, stdout: [`version:  ${V.R3} (latest on the release channel)`, `snapshot: ${V.R3}@1 (newest)`], requests: [] },
		],
	},
	{
		name: "pin a version by unique prefix; omitted options are stored as default",
		root: { version: V.R1, extra: [V.R2] },
		arrange: (root) => {
			snap(root, V.R1, 1);
			snap(root, V.R1, 1);
			writeSel(root, { schema: 1, use: "latest", snapshot: `${V.R1}@1`, addons: {} });
		},
		steps: [
			{
				argv: ["select", "--use", "0.1.7-rc.2-xz.1"],
				code: 0,
				stdout: [`Selected --use ${V.R1}.`, `selection: --use ${V.R1}`, `version:  ${V.R1}`, `snapshot: ${V.R1}@2 (newest)`],
				requests: [],
				unchanged: true,
				check: (root) => expect(selectionOf(root)).toEqual({ schema: 1, use: V.R1, snapshot: null, addons: {} }),
			},
			// The tag names the same version.
			{ argv: ["select", `--use=dsh-v${V.R2}`], code: 0, stdout: [`Selected --use ${V.R2}.`], check: (root) => expect(selectionOf(root).use).toBe(V.R2) },
			{ argv: ["select", "--use", "latest"], code: 0, stdout: ["Selected --use latest."], check: (root) => expect(selectionOf(root)).toEqual({ schema: 1, use: "latest", snapshot: null, addons: {} }) },
		],
	},
	{
		name: "select a snapshot of another version with an explicit version (migration)",
		root: { version: V.R1, extra: [V.R2] },
		arrange: (root) => void snap(root, V.R1, 1, "before-caveman"),
		steps: [
			{
				argv: ["select", "--use", V.R2, "--snapshot", "0.1.7-rc.2-xz.1@before-caveman"],
				code: 0,
				stdout: [`Selected --use ${V.R2} --snapshot ${V.R1}@1.`, `version:  ${V.R2}`, `snapshot: ${V.R1}@1`],
				unchanged: true,
				check: (root) => expect(selectionOf(root)).toEqual({ schema: 1, use: V.R2, snapshot: `${V.R1}@1`, addons: {} }),
			},
		],
	},
	{
		name: "missing --use is refused on an unmanaged install",
		root: { version: V.R1 },
		arrange: (root) => void snap(root, V.R1, 1),
		steps: [{ argv: ["select", "--snapshot", `${V.R1}@1`], code: 1, stderr: ["dsh select requires --use <version|latest>"], unchanged: true, check: (root) => expect(selectionOf(root)).toBeUndefined() }],
	},
	{
		name: "version not installed: names `dsh install`, the selection is unchanged",
		root: { version: V.R1, extra: [V.R2] },
		arrange: (root) => writeSel(root, { schema: 1, use: V.R2, snapshot: null, addons: {} }),
		steps: [
			{ argv: ["select", "--use", "0.1.5"], code: 1, stderr: ["dsh 0.1.5 is not installed", "dsh install 0.1.5"], requests: [], unchanged: true, check: selectionKept({ schema: 1, use: V.R2, snapshot: null, addons: {} }) },
			{ argv: ["select", "--use", "0.1.7"], code: 1, stderr: ["version 0.1.7 is ambiguous"], check: selectionKept({ schema: 1, use: V.R2, snapshot: null, addons: {} }) },
		],
	},
	{
		name: "a snapshot or addon version that does not exist is refused; nothing changes",
		root: { version: V.R1 },
		steps: [
			{ argv: ["select", "--use", "latest", "--snapshot", `${V.R1}@3`], code: 1, stderr: [`snapshot ${V.R1}@3 does not exist`, "dsh snapshot list"], unchanged: true, check: (root) => expect(selectionOf(root)).toBeUndefined() },
			{ argv: ["select", "--use", "latest", "--addon", `office:${V.Q}`], code: 1, stderr: [`office addon ${V.Q} is not installed`, `dsh install --addon office:${V.Q}`], unchanged: true, check: (root) => expect(selectionOf(root)).toBeUndefined() },
			{ argv: ["select", "--use", "latest", "--addon", "office"], code: 1, stderr: ["--addon office: expected <name>:<version>"] },
			{ argv: ["select", "--use", "latest", "--addon", "word:1"], code: 1, stderr: ["Unknown addon word"] },
			{ argv: ["select", "--use", "latest", "--use", "latest"], code: 1, stderr: ["--use can only be provided once"] },
			{ argv: ["select", "latest"], code: 1, stderr: ["Unexpected argument latest"] },
		],
	},
	{
		name: "select an installed addon version, out of slot included",
		root: { version: V.R1, addons: [{ version: V.B1, seq: 0, slot: SLOT_B }] },
		steps: [
			{
				argv: ["select", "--use", "latest", "--addon", `office:${V.B1}`],
				code: 0,
				stdout: [`Selected --use latest --addon office:${V.B1}.`, `office:   ${V.B1}`],
				check: (root) => expect(selectionOf(root)).toEqual({ schema: 1, use: "latest", snapshot: null, addons: { office: V.B1 } }),
			},
		],
	},
	{
		name: "an unreadable selection is reported; only --use replaces it",
		root: { version: V.R1 },
		arrange: (root) => writeSel(root, "{not json"),
		steps: [
			{ argv: ["select"], code: 1, stderr: ["cannot read the selection", "dsh select --use latest"] },
			{ argv: ["select", "--use", "latest"], code: 0, check: (root) => expect(selectionOf(root)).toEqual({ schema: 1, use: "latest", snapshot: null, addons: {} }) },
		],
	},
	{
		name: "managed: --use and --addon are refused naming the manager; --snapshot alone works and keeps the rest",
		root: { version: V.R1, managed: "portage" },
		arrange: (root) => {
			snap(root, V.R1, 1);
			snap(root, V.R1, 1);
			writeSel(root, { schema: 1, use: V.R2, snapshot: null, addons: { office: V.Q } });
		},
		steps: [
			{ argv: ["select", "--use", V.R1], code: 1, stderr: ["--use is not available: the dsh version and addons are managed by portage"], unchanged: true, check: selectionKept({ schema: 1, use: V.R2, snapshot: null, addons: { office: V.Q } }) },
			{ argv: ["select", "--snapshot", `${V.R1}@1`, "--addon", `office:${V.Q}`], code: 1, stderr: ["--addon is not available", "portage"] },
			{
				argv: ["select", "--snapshot", `${V.R1}@1`],
				code: 0,
				stdout: [`selection: managed by portage, --snapshot ${V.R1}@1`, `version:  ${V.R1} (managed by portage)`, `snapshot: ${V.R1}@1`],
				unchanged: true,
				check: selectionKept({ schema: 1, use: V.R2, snapshot: `${V.R1}@1`, addons: { office: V.Q } }),
			},
		],
	},
	{
		name: "updating while pinned installs without switching the selection",
		root: { version: V.R1 },
		arrange: (root) => writeSel(root, { schema: 1, use: V.R1, snapshot: null, addons: {} }),
		steps: [
			{ argv: ["update"], code: 0, stdout: [`Updated dsh from ${V.R1} to ${V.R3}`], check: selectionKept({ schema: 1, use: V.R1, snapshot: null, addons: {} }) },
			{ argv: ["select"], code: 0, stdout: [`selection: --use ${V.R1}`, `version:  ${V.R1}`] },
		],
	},
];

const cases: Case[] = [
	// ── Command surface ───────────────────────────────────────────────────────────────────────────────
	...[["update"], ["update", "self"], ["update", "dsh"], ["update", "--self"]].map<Case>((argv) => ({
		name: `equivalent self target: dsh ${argv.join(" ")}`,
		root: { version: V.R1 },
		steps: [
			{
				argv,
				code: 0,
				stdout: [`Updated dsh from ${V.R1} to ${V.R3}`],
				requests: [INDEX, bundleUrl("release", V.R3)],
				check: (root) => {
					// Installed next to R1; the launcher (same protocol) and the selection are untouched.
					expect(bundles(root)).toEqual([V.R1, V.R3].sort());
					expect(launcherOf(root)).toBe(V.R1);
					expect(selectionOf(root)).toBeUndefined();
					expect(channelFile(root)).toBe("release");
					expect(isReadOnly(join(root, "bundles", V.R3))).toBe(true);
					expect(isReadOnly(join(root, "bundles", V.R3, "app", "lib"))).toBe(true);
					expect(leftovers(root)).toEqual([]);
				},
			},
			// The initial selection (`latest`) now resolves to the new version.
			{ argv: ["select"], code: 0, stdout: [`version:  ${V.R3} (latest on the release channel)`], requests: [] },
		],
	})),
	...[
		["update", "some-plugin"],
		["update", "npm:@scope/pkg"],
	].map<Case>((argv) => ({
		name: `plugin target refused: dsh ${argv.join(" ")}`,
		root: { version: V.R1 },
		steps: [{ argv, code: 1, stderr: ["Plugins are managed with `dsh plugin --profile <name> …`."], requests: [], ...UNCHANGED_UPDATE }],
	})),
	...["--extensions", "--models", "--extension", "--approve", "--no-approve"].map<Case>((opt) => ({
		name: `pi-only option is unknown: ${opt}`,
		root: { version: V.R1 },
		steps: [{ argv: ["update", opt], code: 1, stderr: [`Unknown option ${opt} for "update".`], requests: [], ...UNCHANGED_UPDATE }],
	})),
	...(
		[
			// Removed options (self-update "Removed addon options"): unknown, the addon ones naming `dsh install --addon`.
			[["update", "--all"], 'Unknown option --all for "update". Run `dsh install --addon office`'],
			[["update", "--addon", "office"], 'Unknown option --addon for "update". Run `dsh install --addon office`'],
			[["update", "--version", V.P1], 'Unknown option --version for "update".'],
			[["update", "--clean"], 'Unknown option --clean for "update".'],
			[["update", "--clean", "--force"], 'Unknown option --clean for "update".'],
			[["clean", "--force"], 'Unknown option --force for "clean".'],
			[["clean", "everything"], "Unexpected argument everything."],
			[["update", "--channel", "beta"], "valid channels: live, release"],
			[["update", "--channel"], "valid channels: live, release"],
			[["install", "--addon", "foo"], "valid addons: office"],
			[["install"], "requires a dsh version or --addon"],
			[["install", "github:x/y"], "Plugins are managed with `dsh plugin --profile <name> …`."],
			[["list", "--addon", "foo"], "valid addons: office"],
			[["list", "--force"], 'Unknown option --force for "list".'],
			[["list", "foo"], "Plugins are managed with"],
		] as const
	).map<Case>(([argv, message]) => ({
		name: `rejected: dsh ${argv.join(" ")}`,
		root: { version: V.R1 },
		steps: [{ argv: [...argv], code: 1, stderr: [message], requests: [], ...UNCHANGED_UPDATE }],
	})),
	{
		name: "new slot hint: the new bundle's slot has no installed office version; nothing is downloaded",
		root: { version: V.R1, addons: [{ version: V.P1, seq: 0, slot: SLOT_A }] },
		steps: [
			{
				argv: ["update"],
				code: 0,
				stdout: [`Updated dsh from ${V.R1} to ${V.R3}`, `No installed office addon version fits dsh ${V.R3}`, "dsh install --addon office"],
				requests: [INDEX, bundleUrl("release", V.R3)],
				check: (root) => expect(readdirSync(join(root, "addons", "office"))).toEqual([V.P1]),
			},
		],
	},
	{
		name: "no new slot hint when the new bundle's slot has an installed office version",
		root: { version: V.R1, addons: [{ version: V.P1, seq: 0, slot: SLOT_A }] },
		steps: [
			{
				argv: ["update", "--channel", "live"],
				code: 0,
				stdout: [`Updated dsh from ${V.R1} to ${V.L1}`],
				requests: [INDEX, bundleUrl("live", V.L1)],
				check: (_root, r) => expect(r.stdout).not.toContain("dsh install --addon"),
			},
		],
	},
	// ── Launcher owns the update command ─────────────────────────────────────────────────────────────
	{
		name: "update through the root launcher with no profiles; upstream `update` never runs",
		root: { version: V.R1 },
		steps: [
			{
				argv: ["update"],
				viaLauncher: true,
				code: 0,
				stdout: [`Updated dsh from ${V.R1} to ${V.R3}`, `Created plugin snapshot ${V.R3}@1 (empty).`],
				requests: [INDEX, bundleUrl("release", V.R3)],
				// No profile directory; the installed version gets its automatic (empty) snapshot.
				check: (root) => {
					expect(existsSync(join(root, ".dsh", "profiles"))).toBe(false);
					expect(existsSync(join(root, ".dsh", "snapshots", `${V.R3}@1`, "snapshot.json"))).toBe(true);
				},
			},
			{ argv: ["list", "--json"], viaLauncher: true, code: 0, stdout: [`"effective": "${V.R3}"`], requests: [INDEX] },
			{ argv: ["--profile", "update"], viaLauncher: true, code: 97, stdout: ["UPSTREAM-DSH", "--profile update"], requests: [] },
		],
	},
	{
		name: "dsh --help and -h: upstream help, then the dsh-bin commands; a profile's help is the app's alone",
		root: { version: V.R3 },
		steps: [
			// A launch: the first one creates the version's automatic snapshot (plugin-snapshots); nothing else changes.
			...["--help", "-h"].map<Step>((flag, i) => ({
				argv: [flag],
				viaLauncher: true,
				code: 0,
				stdout: [/^UPSTREAM-DSH [^\n]*\ndsh-bin commands/, "dsh update [self|dsh]", "dsh install --addon <name>", "dsh uninstall --addon <name>", "dsh list [--addon <name>]"],
				requests: [],
				unchanged: i > 0,
				check: (root) => expect(existsSync(join(root, ".dsh", "snapshots", `${V.R3}@1`, "snapshot.json"))).toBe(true),
			})),
			{
				argv: ["--profile", "tui", "--help"],
				viaLauncher: true,
				code: 0,
				stdout: ["UPSTREAM-DSH"],
				requests: [],
				unchanged: true,
				check: (_root, r) => expect(r.stdout).not.toContain("dsh-bin commands"),
			},
		],
	},
	{
		name: "update with an empty DSH_HOME creates no profile directory",
		root: { version: V.R3 },
		steps: [
			{
				argv: ["update"],
				code: 0,
				stdout: [`dsh is already up to date (${V.R3})`],
				requests: [INDEX],
				check: (root) => expect(existsSync(`${root}-home/.dsh`)).toBe(false),
			},
		],
	},
	// ── Channels ─────────────────────────────────────────────────────────────────────────────────────
	{
		name: "channel switch installs the older-upstream live build and persists",
		root: { version: V.R1 },
		steps: [
			{
				argv: ["update", "--channel", "live"],
				code: 0,
				stdout: [`Updated dsh from ${V.R1} to ${V.L1}`],
				requests: [INDEX, bundleUrl("live", V.L1)],
				check: (root) => {
					expect(channelFile(root)).toBe("live");
					expect(bundles(root)).toEqual([V.R1, V.L1].sort());
					expect(launcherOf(root)).toBe(V.R1);
				},
			},
			{ argv: ["update"], from: V.L1, code: 0, stdout: [`dsh is already up to date (${V.L1})`], requests: [INDEX] },
			{ argv: ["update", "--channel=release"], from: V.L1, code: 0, stdout: [`Updated dsh from ${V.L1} to ${V.R3}`], requests: [INDEX, bundleUrl("release", V.R3)] },
		],
	},
	{
		name: "failed channel switch keeps the recorded channel",
		root: { version: V.R1, channelFile: "release" },
		steps: [
			{
				argv: ["update", "--channel", "live"],
				serve: { assetBytes: (a) => (a.tag === tagOf("live", V.L1) ? corrupt(a.bytes) : a.bytes) },
				code: 1,
				stderr: ["sha256 mismatch"],
				requests: [INDEX, bundleUrl("live", V.L1)],
				unchanged: true,
				check: (root) => expect(channelFile(root)).toBe("release"),
			},
		],
	},
	// ── Release discovery ────────────────────────────────────────────────────────────────────────────
	...(
		[
			["invalid JSON", { indexBody: "{nope" }, "index is not valid JSON"],
			["unsupported schema", { index: (i: any) => ({ ...i, schemaVersion: 1 }) }, "unsupported index schemaVersion 1 (expected 2)"],
			["no entry for this target", { index: (i: any) => ({ ...i, channels: { release: [], live: i.channels.live } }) }, `no release release for target ${TARGET}`],
			["unreachable index", { indexStatus: 503 }, "HTTP 503"],
		] as const
	).map<Case>(([what, opts, message]) => ({
		name: `malformed index fails with a diagnostic and changes nothing: ${what}`,
		root: { version: V.R1 },
		steps: [{ argv: ["update"], serve: opts as ServeOptions, code: 1, stderr: [message], requests: "indexStatus" in opts ? INDEX_TRIES : [INDEX], unchanged: true }],
	})),
	// ── Version selection ────────────────────────────────────────────────────────────────────────────
	{
		name: "already up to date downloads nothing",
		root: { version: V.R3 },
		steps: [{ argv: ["update"], code: 0, stdout: [`dsh is already up to date (${V.R3})`], requests: [INDEX], unchanged: true }],
	},
	{
		name: "--force reinstalls the running version under the exclusive claim",
		root: { version: V.R3 },
		steps: [
			{
				argv: ["update", "--force"],
				code: 0,
				stdout: [`Installed dsh ${V.R3}`],
				requests: [INDEX, bundleUrl("release", V.R3)],
				check: (root) => {
					expect(bundles(root)).toEqual([V.R3]);
					expect(isReadOnly(join(root, "bundles", V.R3))).toBe(true);
					// Windows: the old generation holds the running executable, so it stays quarantined until
					// the next maintenance run (see the crash cases, which sweep it).
					expect(leftovers(root).filter((n) => process.platform !== "win32" || !n.startsWith(".trash-"))).toEqual([]);
				},
			},
		],
	},
	{
		name: "--force fails while another process uses that version",
		root: { version: V.R3 },
		arrange: (root) => {
			const c = holdShared(root, V.R3);
			return () => c.release();
		},
		steps: [{ argv: ["update", "--force"], code: 1, stderr: [`dsh ${V.R3} is in use by another dsh process`], requests: [INDEX, bundleUrl("release", V.R3)], unchanged: true }],
	},
	// ── Weak networks ────────────────────────────────────────────────────────────────────────────────
	{
		name: "transient index failures are retried",
		root: { version: V.R1 },
		steps: [{ argv: ["update"], serve: { indexStatus: 503, indexFailures: 2 }, code: 0, stdout: [`Updated dsh from ${V.R1} to ${V.R3}`], requests: [INDEX, INDEX, INDEX, bundleUrl("release", V.R3)] }],
	},
	{
		name: "a non-transient index status is not retried",
		root: { version: V.R1 },
		steps: [{ argv: ["update"], serve: { indexStatus: 404 }, code: 1, stderr: ["HTTP 404"], requests: [INDEX], unchanged: true }],
	},
	{
		name: "a reset download resumes with Range and verifies",
		root: { version: V.R1 },
		steps: [
			{
				argv: ["update"],
				serve: { assetFault: (_a, n) => (n === 0 ? { cutAt: 4096 } : n === 1 ? { status: 503 } : undefined) },
				code: 0,
				stdout: ["Download interrupted (", "retrying", `Updated dsh from ${V.R1} to ${V.R3}`, /\d+%\s+\S+ \S+ \/ \S+ \S+\s+\S+ \S+\/s\s+ETA /],
				requests: [INDEX, bundleUrl("release", V.R3), bundleUrl("release", V.R3), bundleUrl("release", V.R3)],
				check: (root) => {
					expect(bundles(root)).toContain(V.R3);
					expect(existsSync(join(root, ".downloads"))).toBe(false);
				},
			},
		],
	},
	{
		name: "an interrupted update keeps its partial download and the next run resumes it",
		root: { version: V.R1 },
		steps: [
			{
				argv: ["update"],
				serve: { assetFault: (_a, n) => (n === 0 ? { cutAt: 4096 } : { status: 503 }) },
				code: 1,
				stderr: ["download failed", "HTTP 503", "Run the same command again to resume the download."],
				check: (root) => {
					expect(bundles(root)).toEqual([V.R1]);
					expect(readdirSync(join(root, ".downloads")).map((n) => [n.endsWith(".part"), readFileSync(join(root, ".downloads", n)).length])).toEqual([[true, 4096]]);
				},
			},
			{
				argv: ["update"],
				code: 0,
				stdout: ["Resuming dsh-", `Updated dsh from ${V.R1} to ${V.R3}`],
				requests: [INDEX, bundleUrl("release", V.R3)],
				check: (root) => {
					expect(bundles(root)).toContain(V.R3);
					expect(existsSync(join(root, ".downloads"))).toBe(false);
				},
			},
		],
	},
	{
		name: "a server that ignores Range restarts the download from the start",
		root: { version: V.R1 },
		steps: [
			{
				argv: ["update"],
				serve: { assetFault: (_a, n) => (n === 0 ? { cutAt: 4096 } : { ignoreRange: true }) },
				code: 0,
				stdout: ["The server ignored the resume request", `Updated dsh from ${V.R1} to ${V.R3}`],
				check: (root) => expect(bundles(root)).toContain(V.R3),
			},
		],
	},
	{
		name: "a corrupt kept partial download is fetched again from the start",
		root: { version: V.R1 },
		arrange: (root) => {
			const asset = world.index.channels.release.find((e: { version: string }) => e.version === V.R3)!.assets[TARGET]!;
			mkdirSync(join(root, ".downloads"));
			writeFileSync(join(root, ".downloads", `${asset.sha256}.part`), new Uint8Array(4096).fill(7));
		},
		steps: [
			{
				argv: ["update"],
				code: 0,
				stdout: ["Resuming", "did not verify; downloading it again from the start", `Updated dsh from ${V.R1} to ${V.R3}`],
				requests: [INDEX, bundleUrl("release", V.R3), bundleUrl("release", V.R3)],
				check: (root) => {
					expect(bundles(root)).toContain(V.R3);
					expect(existsSync(join(root, ".downloads"))).toBe(false);
				},
			},
		],
	},
	{
		name: "a stalled download times out and resumes",
		root: { version: V.R1 },
		steps: [
			{
				argv: ["update"],
				serve: { assetFault: (_a, n) => (n === 0 ? { cutAt: 4096, stall: true } : undefined) },
				env: () => ({ DSH_BIN_TEST_INACTIVITY_MS: "300" }),
				code: 0,
				stdout: ["no data for 0s", `Updated dsh from ${V.R1} to ${V.R3}`],
				requests: [INDEX, bundleUrl("release", V.R3), bundleUrl("release", V.R3)],
			},
		],
	},
	{
		name: "clean --update removes kept partial downloads",
		root: { version: V.R1 },
		arrange: (root) => {
			mkdirSync(join(root, ".downloads"));
			writeFileSync(join(root, ".downloads", `${"0".repeat(64)}.part`), "x");
		},
		steps: [{ argv: ["clean", "--update"], offline: true, code: 0, stdout: ["Removed 1 partial download(s)"], requests: [], check: (root) => expect(existsSync(join(root, ".downloads"))).toBe(false) }],
	},
	// ── Verification before activation ───────────────────────────────────────────────────────────────
	{
		name: "digest mismatch activates nothing",
		root: { version: V.R1 },
		steps: [{ argv: ["update"], serve: { assetBytes: (a) => corrupt(a.bytes) }, code: 1, stderr: ["sha256 mismatch"], requests: [INDEX, bundleUrl("release", V.R3)], unchanged: true }],
	},
	{
		name: "archive metadata must match the index entry",
		root: { version: V.R1 },
		steps: [
			{
				argv: ["update"],
				serve: { index: (i: any) => (i.channels.release.find((e: any) => e.version === V.R3).upstream.commit = "f".repeat(40), i) },
				code: 1,
				stderr: ["metadata does not match the index: upstream commit"],
				requests: [INDEX, bundleUrl("release", V.R3)],
				unchanged: true,
			},
		],
	},
	{
		name: "unsafe archive entry creates nothing outside staging",
		root: { version: V.R1 },
		steps: [
			{
				argv: ["update"],
				serve: { index: (i: any) => (i.channels.release.push(evilEntry), i) },
				code: 1,
				stderr: ["invalid archive", "unsafe"],
				requests: [INDEX, bundleUrl("release", V.EVIL)],
				unchanged: true,
				check: (root) => {
					expect(existsSync(join(root, "..", "evil"))).toBe(false);
					expect(existsSync(join(root, "evil"))).toBe(false);
				},
			},
		],
	},
	// ── Atomic activation ────────────────────────────────────────────────────────────────────────────
	{
		name: "crash after staging: the old version still starts, the next update cleans up and succeeds",
		root: { version: V.R1 },
		arrange: (root) => {
			// An interrupted run: a half-extracted staging tree and a quarantined old generation.
			mkdirSync(join(root, ".staging-deadbeef0001", "tree", "bundles", V.R3, "app"), { recursive: true });
			mkdirSync(join(root, ".trash-deadbeef0002", "app"), { recursive: true });
			chmodSync(join(root, ".staging-deadbeef0001", "tree"), 0o555);
		},
		steps: [
			{ argv: ["--version"], viaLauncher: true, code: 97, stdout: [join("bundles", V.R1, "app", "lib")], requests: [] },
			{
				argv: ["update"],
				code: 0,
				stdout: [`Updated dsh from ${V.R1} to ${V.R3}`],
				requests: [INDEX, bundleUrl("release", V.R3)],
				check: (root) => expect(leftovers(root)).toEqual([]),
			},
		],
	},
	{
		name: "an existing update.lock is never reclaimed, even when old",
		root: { version: V.R1 },
		arrange: (root) => {
			mkdirSync(join(root, "update.lock"));
			const old = new Date(Date.now() - 30 * 86400_000);
			utimesSync(join(root, "update.lock"), old, old);
		},
		steps: [
			{ argv: ["update"], code: 1, stderr: ["Another dsh update or cleanup is already running.", "remove", "update.lock manually"], requests: [], unchanged: true },
			{ argv: ["clean"], code: 1, stderr: ["Another dsh update or cleanup is already running."], requests: [], unchanged: true },
			{ argv: ["install", "--addon", "office"], code: 1, stderr: ["Another dsh update or cleanup is already running."], requests: [], unchanged: true },
			{ argv: ["install", V.R2], code: 1, stderr: ["Another dsh update or cleanup is already running."], requests: [], unchanged: true },
		],
	},
	// ── Cleanup ──────────────────────────────────────────────────────────────────────────────────────
	{
		name: "clean keeps installed versions and removes only leftovers; offline",
		root: { version: V.R3, extra: [V.R1, V.R2] },
		arrange: (root) => {
			mkdirSync(join(root, ".staging-deadbeef0001", "tree"), { recursive: true });
			snap(root, V.R3, 3);
			mkdirSync(join(homeOf(root), "snapshots", ".staging-deadbeef0003", "profiles"), { recursive: true });
		},
		steps: [
			{
				argv: ["clean"],
				offline: true,
				code: 0,
				stdout: ["Removed 1 interrupted install leftover(s)", "Removed 1 interrupted snapshot leftover(s)", "No transpiler cache to clear"],
				requests: [],
				check: (root) => {
					expect(bundles(root)).toEqual([V.R1, V.R2, V.R3].sort());
					expect(leftovers(root)).toEqual([]);
					expect(snapIds(root)).toEqual([`${V.R3}@1`]);
					expect(readdirSync(join(homeOf(root), "snapshots")).filter((n) => n.startsWith(".staging-"))).toEqual([]);
				},
			},
		],
	},
	{
		name: "clean --snapshots removes only the interrupted snapshot copy",
		root: { version: V.R1 },
		arrange: (root) => {
			mkdirSync(join(root, ".staging-deadbeef0001", "tree"), { recursive: true });
			mkdirSync(join(homeOf(root), "snapshots", ".staging-deadbeef0003"), { recursive: true });
		},
		steps: [
			{
				argv: ["clean", "--snapshots"],
				offline: true,
				code: 0,
				stdout: ["Removed 1 interrupted snapshot leftover(s)"],
				unchanged: true,
				check: (root, r) => {
					expect(leftovers(root)).toEqual([".staging-deadbeef0001"]);
					expect(r.stdout).not.toContain("install leftover");
					expect(r.stdout).not.toContain("transpiler");
				},
			},
		],
	},
	{
		name: "managed clean: the install root is left to the manager, the rest is cleaned",
		root: { version: V.R1, managed: "portage" },
		arrange: (root) => {
			mkdirSync(join(root, ".staging-deadbeef0001", "tree"), { recursive: true });
			mkdirSync(join(homeOf(root), "snapshots", ".staging-deadbeef0003"), { recursive: true });
		},
		steps: [
			{
				argv: ["clean"],
				offline: true,
				code: 0,
				stdout: ["Skipped the install root: it is managed by portage.", "Removed 1 interrupted snapshot leftover(s)"],
				requests: [],
				unchanged: true,
				check: (root) => expect(leftovers(root)).toEqual([".staging-deadbeef0001"]),
			},
		],
	},
	{
		name: "clean --transpiler clears dsh-bin's transpiler cache, and only that cache",
		root: { version: V.R3 },
		arrange: (root) => {
			for (const d of ["cache/transpiler", "cache/other", "user-cache"]) {
				mkdirSync(join(root, "..", `${basename(root)}-x`, d), { recursive: true });
				writeFileSync(join(root, "..", `${basename(root)}-x`, d, "a.pile"), "x");
			}
		},
		steps: [
			{
				argv: ["clean", "--transpiler"],
				offline: true,
				env: (root) => ({ DSH_BUNDLE_CACHE: join(root, "..", `${basename(root)}-x`, "cache"), BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(root, "..", `${basename(root)}-x`, "user-cache") }),
				code: 0,
				stdout: ["Cleared the transpiler cache"],
				requests: [],
				unchanged: true,
				check: (root) => {
					const x = join(root, "..", `${basename(root)}-x`);
					expect(existsSync(join(x, "cache/transpiler"))).toBe(false);
					expect(existsSync(join(x, "cache/other/a.pile"))).toBe(true);
					expect(existsSync(join(x, "user-cache/a.pile"))).toBe(true);
					rmSync(x, { recursive: true, force: true });
				},
			},
		],
	},
	{
		name: "clean never removes addon versions",
		root: { version: V.R3, addons: [{ version: V.B1, seq: 0, slot: SLOT_B }] },
		arrange: (root) => {
			addAddon(world, root, { version: V.P1, seq: 1, slot: SLOT_A });
			addAddon(world, root, { version: V.P3, seq: 4, slot: SLOT_A2 });
		},
		steps: [{ argv: ["clean", "--update"], offline: true, code: 0, requests: [], unchanged: true, check: (root) => expect(readdirSync(join(root, "addons", "office")).sort()).toEqual([V.B1, V.P1, V.P3].sort()) }],
	},
	// ── Optional addons ──────────────────────────────────────────────────────────────────────────────
	{
		name: "install office: the in-slot default, read-only, with its index seq; then already installed; no addons.json",
		root: { version: V.R1 },
		steps: [
			{
				argv: ["install", "--addon", "office"],
				code: 0,
				stdout: [`Installed the office addon ${V.Q}`],
				requests: [INDEX, addonUrl(V.Q)],
				check: (root) => {
					const dir = join(root, "addons", "office", V.Q);
					expect(isReadOnly(dir)).toBe(true);
					expect(existsSync(join(dir, "node_modules", "@deepseek-ai", "libreoffice-kit", "package.json"))).toBe(true);
					expect(JSON.parse(readFileSync(join(dir, "addon.json"), "utf8")).seq).toBe(2);
					expect(existsSync(join(root, "addons.json"))).toBe(false);
				},
			},
			{ argv: ["install", "--addon", "office"], code: 0, stdout: [`The office addon ${V.Q} is already installed.`], requests: [INDEX], unchanged: true },
			// Another version side by side; selecting it never downloads.
			{ argv: ["install", "--addon", `office:${V.P1}`], code: 0, stdout: [`Installed the office addon ${V.P1}`], requests: [INDEX, addonUrl(V.P1)] },
			{ argv: ["select"], code: 0, stdout: [`office:   ${V.Q} (default)`], requests: [] },
			{ argv: ["select", "--use", "latest", "--addon", `office:${V.P1}`], code: 0, requests: [] },
			{ argv: ["install", "--addon", `office:${addonTag(V.P1)}`, "--force"], code: 0, stdout: [`Installed the office addon ${V.P1}`], requests: [INDEX, addonUrl(V.P1)] },
		],
	},
	{
		name: "uninstall office: one version, or every version; refused while selected or in use, all or none",
		root: { version: V.R1, addons: [{ version: V.P1, seq: 1, slot: SLOT_A }, { version: V.Q, seq: 2, slot: SLOT_A }, { version: V.B1, seq: 3, slot: SLOT_B }] },
		arrange: (root) => {
			writeSel(root, { schema: 1, use: "latest", snapshot: null, addons: { office: V.P1 } });
			const c = acquireClaim(join(root, "addons", "office", V.B1, ".usage.lock"), "shared");
			if (c === "busy") throw new Error("busy");
			return () => c.release();
		},
		steps: [
			{ argv: ["uninstall", "--addon", `office:${V.P1}`], code: 1, stderr: [`the office addon ${V.P1} is named by the selection`, "dsh select"], requests: [], unchanged: true },
			{ argv: ["uninstall", "--addon", `office:${V.B1}`], code: 1, stderr: [`the office addon ${V.B1} is in use`, "nothing was uninstalled"], unchanged: true },
			{ argv: ["uninstall", "--addon", `office:${V.Q}`], code: 0, stdout: [`Uninstalled the office addon ${V.Q}.`], requests: [], check: (root) => expect(readdirSync(join(root, "addons", "office")).sort()).toEqual([V.B1, V.P1].sort()) },
			{ argv: ["uninstall", "--addon", `office:${V.Q}`], code: 0, stdout: [`The office addon ${V.Q} is not installed.`], unchanged: true },
			{ argv: ["select", "--use", "latest"], code: 0 },
			{ argv: ["uninstall", "--addon", "office"], code: 1, stderr: ["in use", "nothing was uninstalled"], unchanged: true, check: (root) => expect(readdirSync(join(root, "addons", "office")).sort()).toEqual([V.B1, V.P1].sort()) },
			// A later sweep never brings an uninstalled version back.
			{ argv: ["clean", "--update"], code: 0, check: (root) => expect(readdirSync(join(root, "addons", "office")).sort()).toEqual([V.B1, V.P1].sort()) },
		],
	},
	{
		name: "uninstall every office version",
		root: { version: V.R1, addons: [{ version: V.P1, seq: 1, slot: SLOT_A }, { version: V.B1, seq: 3, slot: SLOT_B }] },
		steps: [
			{ argv: ["uninstall", "--addon", "office"], code: 0, stdout: [`Uninstalled the office addon ${V.P1}.`, `Uninstalled the office addon ${V.B1}.`], requests: [], check: (root) => expect(readdirSync(join(root, "addons", "office"))).toEqual([]) },
			{ argv: ["uninstall", "--addon", "office"], code: 0, stdout: ["The office addon is not installed."], unchanged: true },
		],
	},
	// ── Addon slots ──────────────────────────────────────────────────────────────────────────────────
	{
		name: "newer-slot addon refused; --force installs it forced; list names the install of the default",
		root: { version: V.R1 },
		steps: [
			{
				argv: ["install", "--addon", `office:${V.B1}`],
				code: 1,
				stderr: [`is out of slot`, SLOT_A.commit.slice(0, 12), SLOT_B.commit.slice(0, 12), "--force"],
				requests: [INDEX],
				unchanged: true,
			},
			{
				argv: ["install", "--addon", `office:${addonTag(V.B1)}`, "--force"],
				code: 0,
				stdout: [`Installed the office addon ${V.B1} (out of slot)`, `dsh --addon office:${V.B1}`],
				stderr: ["out of slot"],
				requests: [INDEX, addonUrl(V.B1)],
			},
			// Plain launches keep the in-slot default (none installed: office degrades); it is used only when named.
			{ argv: ["select"], code: 0, stdout: ["office:   none installed for this version"], requests: [] },
			{
				argv: ["list", "--json"],
				code: 0,
				requests: [INDEX],
				unchanged: true,
				check: (_root, r) => expect(json(r).addons[0]).toMatchObject({ installed: [{ version: V.B1, inSlot: false }], default: V.Q, hint: "dsh install --addon office" }),
			},
		],
	},
	{
		name: "default follows the index: the newest in-slot addon, not a newer one of another slot",
		root: { version: V.R1 },
		steps: [{ argv: ["install", "--addon", "office"], code: 0, stdout: [`Installed the office addon ${V.Q}`], requests: [INDEX, addonUrl(V.Q)] }],
	},
	{
		name: "live bundle follows its slot's newest addon",
		root: { version: V.L1 },
		steps: [{ argv: ["install", "--addon", "office"], code: 0, stdout: [`Installed the office addon ${V.Q}`], requests: [INDEX, addonUrl(V.Q)] }],
	},
	{
		name: "the default falls back to the pin when the index is unreachable",
		root: { version: V.R1 },
		steps: [
			{
				argv: ["install", "--addon", "office"],
				serve: { indexStatus: 503 },
				code: 0,
				stdout: [`Installed the office addon ${V.P1}`],
				stderr: ["warning:", "embedded"],
				requests: [...INDEX_TRIES, addonUrl(V.P1)],
			},
		],
	},
	{
		name: "kit switch-back opens a new slot: an addon from the first 0.1.2 slot is out of slot",
		root: { version: V.R3 },
		steps: [{ argv: ["install", "--addon", `office:${V.P1}`], code: 1, stderr: ["is out of slot", "kit 0.1.2", "--force"], requests: [INDEX], unchanged: true }],
	},
	{
		name: "a pinned addon removed from the index installs from the embedded table",
		root: { version: V.R1 },
		steps: [
			{
				argv: ["install", "--addon", `office:${V.P1}`],
				serve: { index: (i: any) => ({ ...i, addons: { office: i.addons.office.filter((e: any) => e.version !== V.P1) } }) },
				code: 0,
				stdout: [`Installed the office addon ${V.P1}`],
				requests: [INDEX, addonUrl(V.P1)],
			},
		],
	},
	{
		name: "embedded and index digests disagree: abort before downloading",
		root: { version: V.R1 },
		steps: [
			{
				argv: ["install", "--addon", `office:${V.P1}`],
				serve: { index: (i: any) => (i.addons.office.find((e: any) => e.version === V.P1).assets[ADDON_PLATFORM].sha256 = "0".repeat(64), i) },
				code: 1,
				stderr: ["disagree on its SHA-256"],
				requests: [INDEX],
				unchanged: true,
			},
		],
	},
	{
		name: "an unknown addon version exits 1",
		root: { version: V.R1 },
		steps: [{ argv: ["install", "--addon", "office:9.9.9"], code: 1, stderr: ["9.9.9 is not in the embedded table or the release index"], requests: [INDEX], unchanged: true }],
	},
	...(
		[
			[["install", "--addon", "office", "--version", V.P1], 'Unknown option --version for "install".'],
			[["install", "--addon", "office:"], "--addon office:: expected <name> or <name>:<version>"],
			[["install", V.R1, "--addon", "office"], "--addon cannot be combined with a dsh version"],
			[["uninstall", "--addon", "word:1"], "Unknown addon word; valid addons: office."],
		] as const
	).map<Case>(([argv, message]) => ({
		name: `addon form rejected: dsh ${argv.join(" ")}`,
		root: { version: V.R1 },
		steps: [{ argv: [...argv], code: 1, stderr: [message], requests: [], unchanged: true }],
	})),
	// ── Channel-managed installations ────────────────────────────────────────────────────────────────
	...(
		[
			["portage", ["update", "--force"]],
			["scoop", ["update"]],
			["portage", ["update", "--channel", "live"]],
			["scoop", ["install", "--addon", "office"]],
			["portage", ["uninstall", "--addon", "office"]],
			["portage", ["install", "0.1.7-rc.2"]],
			["scoop", ["uninstall", V.R1]],
		] as const
	).map<Case>(([manager, argv]) => ({
		name: `${manager}-managed: dsh ${argv.join(" ")} is refused before any network access`,
		root: { version: V.R1, managed: manager },
		steps: [
			{
				argv: [...argv],
				code: 1,
				stderr: [`error: this dsh installation is managed by ${manager}; self-update is disabled.`, `Upgrade dsh through ${manager} instead.`],
				requests: [],
				unchanged: true,
			},
		],
	})),
	// ── Listing versions ─────────────────────────────────────────────────────────────────────────────
	{
		name: "list: newer version available; installed versions, the selection and a dsh update hint; read-only, index only",
		root: { version: V.R1 },
		steps: [
			{
				argv: ["list", "--json"],
				code: 0,
				requests: [INDEX],
				unchanged: true,
				check: (_root, r) => {
					const d = json(r);
					expect(d.selection).toEqual({ valid: true, stored: null, label: "--use latest", version: V.R1, snapshot: null, addons: { office: null } });
					expect(d.dsh).toMatchObject({ version: V.R1, effective: V.R1, channel: "release", target: TARGET, slot: SLOT_A });
					expect(d.dsh.installed).toEqual([{ version: V.R1, channel: "release", slot: SLOT_A, selected: true, latest: true, inUse: false }]);
					expect(d.channels).toEqual([
						{ channel: "release", current: true, newest: V.R3, installed: false, hint: "dsh update" },
						{ channel: "live", current: false, newest: V.L1, installed: false, hint: "dsh update --channel live" },
					]);
					expect(d.addons[0]).toMatchObject({ name: "office", installed: [], default: V.Q, pinned: V.P1, hint: "dsh install --addon office" });
					expect(d.index).toEqual({ ok: true });
				},
			},
			{
				argv: ["list"],
				code: 0,
				stdout: ["selection: --use latest", `version:  ${V.R1} (latest on the release channel)`, new RegExp(`${V.R1.replace(/\./g, "\\.")}\\s+release\\s+slot \\S+ \\(kit 0\\.1\\.2\\)\\s+\\[selected, latest\\]`), `newest ${V.R3}`, "dsh update", "addon office"],
				requests: [INDEX],
				unchanged: true,
			},
			{
				argv: ["list", "--channel", "live", "--json"],
				code: 0,
				requests: [INDEX],
				check: (_r, r) => {
					expect(json(r).channels.map((c: any) => c.channel)).toEqual(["live"]);
					expect(json(r).dsh.installed).toEqual([]);
				},
			},
			// Once the newest entry is installed, its hint is gone.
			{ argv: ["update"], code: 0 },
			{ argv: ["list", "--json"], code: 0, check: (_r, r) => expect(json(r).channels[0]).toEqual({ channel: "release", current: true, newest: V.R3, installed: true, hint: null }) },
		],
	},
	{
		name: "list: a pinned selection is visible; the markers are selected, latest and in use",
		root: { version: V.R1, extra: [V.R2] },
		arrange: (root) => {
			writeSel(root, { schema: 1, use: "0.1.7-rc.2-xz.1", snapshot: null, addons: {} });
			const held = holdShared(root, V.R2);
			return () => held.release();
		},
		steps: [
			{
				argv: ["list", "--json"],
				code: 0,
				requests: [INDEX],
				unchanged: true,
				check: (_r, r) => {
					const d = json(r);
					expect(d.selection).toMatchObject({ valid: true, stored: { use: "0.1.7-rc.2-xz.1" }, label: "--use 0.1.7-rc.2-xz.1", version: V.R1 });
					expect(d.dsh.installed.map((b: any) => [b.version, b.selected, b.latest, b.inUse])).toEqual([
						[V.R1, true, false, false],
						[V.R2, false, true, true],
					]);
				},
			},
			{ argv: ["list"], code: 0, stdout: ["selection: --use 0.1.7-rc.2-xz.1", /xz\.1\.1\.g11111111 .*\[selected\]\n/, /xz\.2\.1\.g22222222 .*\[latest, in use\]\n/], requests: [INDEX], unchanged: true },
		],
	},
	{
		name: "list: an unreadable selection is reported and the listing still exits 0",
		root: { version: V.R1 },
		arrange: (root) => writeSel(root, "{nope"),
		steps: [
			{ argv: ["list"], code: 0, stdout: ["selection: cannot read the selection", "dsh select --use latest", V.R1], requests: [INDEX], unchanged: true },
			{ argv: ["list", "--json"], code: 0, requests: [INDEX], unchanged: true, check: (_r, r) => expect(json(r).selection).toMatchObject({ valid: false }) },
		],
	},
	{
		name: "list --addon office offline: embedded versions with slot states and a warning",
		root: { version: V.R3 },
		steps: [
			{ argv: ["list", "--addon", "office"], serve: { indexStatus: 503 }, code: 0, stderr: [/^warning: .*HTTP 503.*\n$/], stdout: [V.P3, "in slot", "out of slot", "--force", "embedded"], requests: INDEX_TRIES, unchanged: true },
			{
				argv: ["list", "--addon", "office", "--json"],
				serve: { indexStatus: 503 },
				code: 0,
				requests: INDEX_TRIES,
				check: (_r, r) => {
					const d = json(r);
					expect(d.index.ok).toBe(false);
					expect(d.addons[0].versions.map((v: any) => [v.version, v.inSlot, v.source])).toEqual([
						[V.P1, false, "embedded"],
						[V.Q, false, "embedded"],
						[V.B1, false, "embedded"],
						[V.P3, true, "embedded"],
					]);
				},
			},
		],
	},
	{
		name: "list --addon office: other-slot rows need --force; the in-slot default is marked",
		root: { version: V.R1 },
		steps: [
			{
				argv: ["list", "--addon", "office", "--json"],
				code: 0,
				requests: [INDEX],
				check: (_r, r) => {
					const rows = Object.fromEntries(json(r).addons[0].versions.map((v: any) => [v.version, v]));
					expect(rows[V.P1]).toMatchObject({ inSlot: true, default: false, pinned: true, source: "both", conflict: false });
					expect(rows[V.Q]).toMatchObject({ inSlot: true, default: true, source: "index" });
					expect(rows[V.B1]).toMatchObject({ inSlot: false, source: "index" });
					expect(rows[V.P3]).toMatchObject({ inSlot: false });
				},
			},
			{ argv: ["list", "--addon", "office"], code: 0, stdout: [/out of slot .*needs --force/, /installed|default, pinned/], requests: [INDEX] },
		],
	},
	{
		name: "list in a managed installation lists versions with the manager hint",
		root: { version: V.R1, managed: "portage" },
		steps: [
			{
				argv: ["list"],
				code: 0,
				stdout: ["Upgrade dsh through portage instead.", V.R3, "selection: managed by portage", /g11111111 .*\[selected, latest\]/],
				requests: [INDEX],
				unchanged: true,
				check: (_r, r) => expect(r.stdout).not.toContain("dsh update"),
			},
		],
	},
	{
		name: "list marks a digest conflict and still exits 0",
		root: { version: V.R1 },
		steps: [
			{
				argv: ["list", "--addon", "office", "--json"],
				serve: { index: (i: any) => (i.addons.office.find((e: any) => e.version === V.P1).assets[ADDON_PLATFORM].sha256 = "0".repeat(64), i) },
				code: 0,
				requests: [INDEX],
				unchanged: true,
				check: (_r, r) => expect(json(r).addons[0].versions.find((v: any) => v.version === V.P1).conflict).toBe(true),
			},
		],
	},
];

const allowed = () => new Set([INDEX, ...[...world.assets.keys()].map((k) => `/download/${k}`)]);

describe("update contract", () => {
	for (const c of [...cases, ...selectCases, ...snapshotCases, ...versionCases]) {
		test(c.name, async () => {
			const root = installRoot(world, c.root.version, { channelFile: c.root.channelFile, managed: c.root.managed });
			roots.push(root);
			for (const v of c.root.extra ?? []) addBundle(world, root, v);
			for (const a of c.root.addons ?? []) addAddon(world, root, a);
			const release = c.arrange?.(root);
			try {
				for (const [i, step] of c.steps.entries()) {
					const server = serve(world, step.serve);
					const origin = step.offline ? "http://127.0.0.1:9" : server.origin;
					const before = snapshot(root);
					const r = step.viaLauncher ? await launch(root, step.argv, origin) : await dsh(root, step.from ?? c.root.version, step.argv, origin, step.env?.(root));
					server.stop();
					const label = `${c.name} [step ${i}: ${step.argv.join(" ")}]\nstdout: ${r.stdout}\nstderr: ${r.stderr}`;
					expect({ label, code: r.code }).toEqual({ label, code: step.code });
					for (const s of step.stdout ?? []) typeof s === "string" ? expect(r.stdout).toContain(s) : expect(r.stdout).toMatch(s);
					for (const s of step.stderr ?? []) typeof s === "string" ? expect(r.stderr).toContain(s) : expect(r.stderr).toMatch(s);
					// No upstream code ever handles a maintenance command.
					if (!step.viaLauncher || ["update", "install", "uninstall", "list"].includes(step.argv[0]!)) expect(r.stdout).not.toContain("UPSTREAM-DSH");
					const paths = server.requests.map((q) => q.path);
					if (step.requests) expect(paths).toEqual(step.requests);
					for (const p of paths) expect(allowed().has(p)).toBe(true);
					if (step.unchanged) expect(snapshot(root)).toEqual(before);
					step.check?.(root, r);
				}
			} finally {
				if (typeof release === "function") release();
				removeRoot(root);
			}
		}, 60_000);
	}

	test("a non-bundle dsh gets bundle-install guidance and changes nothing", async () => {
		const server = serve(world);
		const proc = Bun.spawn([compiledNative(), "update"], { env: { PATH: process.env.PATH ?? "", DSH_BIN_TEST: "1", DSH_BIN_TEST_ORIGIN: server.origin }, stdout: "pipe", stderr: "pipe" });
		const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		server.stop();
		expect(code).toBe(1);
		expect(stderr).toContain("not a dsh-bin bundle installation");
		expect(stderr).toContain("https://github.com/xz-dev/dsh-bin/releases");
		expect(server.requests).toEqual([]);
	}, 30_000);

	test("two concurrent updaters: one completes, the other reports the running update", async () => {
		const root = installRoot(world, V.R1);
		roots.push(root);
		const server = serve(world, { indexDelayMs: 500 });
		const [a, b] = await Promise.all([dsh(root, V.R1, ["update"], server.origin), (async () => (await Bun.sleep(150), dsh(root, V.R1, ["clean", "--update"], server.origin)))()]);
		server.stop();
		expect([a.code, b.code].sort()).toEqual([0, 1]);
		const loser = a.code === 1 ? a : b;
		expect(loser.stderr).toContain("Another dsh update or cleanup is already running.");
		expect(bundles(root)).toEqual([V.R1, V.R3].sort());
		expect(leftovers(root)).toEqual([]);
		removeRoot(root);
	}, 60_000);

	// Crash injection (7.6): kill the updater at each step. The launcher must then start the old or the new
	// version, and the next update must succeed and leave no leftovers.
	/** The killed updater's update.lock stays (never reclaimed); the user removes it as the diagnostic says. */
	const afterCrash = async (root: string, origin: string) => {
		const refused = await launch(root, ["clean", "--update"], origin);
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain("Another dsh update or cleanup is already running.");
		rmSync(join(root, "update.lock"), { recursive: true });
	};
	const runs = (r: RunResult) => /UPSTREAM-DSH \S*bundles[\\/]([^\\/]+)[\\/]app[\\/]lib/.exec(r.stdout)?.[1];
	/**
	 * What a plain launch starts now. The fixture's shell launcher runs one fixed version, so resolve `latest`
	 * as the real launcher does (through `dsh select`) and start that bundle's entry directly.
	 */
	const startsNow = async (root: string, origin: string) => {
		const via = bundles(root).find((v) => existsSync(join(root, "bundles", v, `dsh-native${EXE}`)))!;
		const v = /version: {2}(\S+) \(latest/.exec((await dsh(root, via, ["select"], origin)).stdout)?.[1];
		return v ? runs(await dsh(root, v, ["--version"], origin)) : undefined;
	};
	for (const point of ["after-download", "after-extract", "before-place", "after-place", "after-launcher"]) {
		test(`crash ${point} on a version change: old or new starts, then the update completes`, async () => {
			const root = installRoot(world, V.R1);
			try {
				const server = serve(world);
				const crashed = await dsh(root, V.R1, ["update"], server.origin, { DSH_BIN_TEST_CRASH: point });
				expect(crashed.code).not.toBe(0);
				expect(crashed.stderr).toContain(`test crash at ${point}`);
				// Before placement `latest` is still the old version; once the new one is in bundles/ it is complete.
				expect(await startsNow(root, server.origin)).toBe(["after-place", "after-launcher"].includes(point) ? V.R3 : V.R1);
				await afterCrash(root, server.origin);
				const again = await launch(root, ["update"], server.origin);
				server.stop();
				expect(again.code).toBe(0);
				expect(await startsNow(root, server.origin)).toBe(V.R3);
				expect(await settledLeftovers(root, server.origin)).toEqual([]);
			} finally {
				removeRoot(root);
			}
		}, 60_000);
	}
	for (const [point, exchange] of [
		["after-place", true],
		["after-launcher", true],
		["after-quarantine", false],
		["after-place", false],
		["after-launcher", false],
	] as const) {
		test(`crash ${point} during same-version --force (${exchange ? "atomic exchange" : "quarantine fallback"}): the version still starts`, async () => {
			const root = installRoot(world, V.R3);
			try {
				const server = serve(world);
				const env = { DSH_BIN_TEST_CRASH: point, ...(exchange ? {} : { DSH_BIN_TEST_NO_EXCHANGE: "1" }) };
				const crashed = await dsh(root, V.R3, ["update", "--force"], server.origin, env);
				expect(crashed.stderr).toContain(`test crash at ${point}`);
				// The quarantine fallback can leave bundles/<v> missing until the next maintenance run restores it.
				if (exchange || point !== "after-quarantine") {
					expect(runs(await launch(root, ["--version"], server.origin))).toBe(V.R3);
					await afterCrash(root, server.origin);
				} else {
					// Residual window of the no-exchange fallback (Windows): between two back-to-back renames the
					// launcher's bundle is missing; it names the missing path and does not fall back.
					const r = await launch(root, ["--version"], server.origin);
					expect(r.code).not.toBe(0);
					rmSync(join(root, "update.lock"), { recursive: true });
				}
				if (!exchange && point === "after-quarantine") {
					// The launcher's bundle is gone: repair through the quarantined copy's own entry.
					const trash = readdirSync(root).find((n) => n.startsWith(".trash-"))!;
					expect(trash).toBeDefined();
					const r = await dsh(root, "", ["update", "--force"], server.origin, {}, join(root, trash, `dsh-native${EXE}`));
					expect(r.code).toBe(0);
				} else {
					const r = await launch(root, ["update", "--force"], server.origin);
					expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: "" });
				}
				expect(runs(await launch(root, ["--version"], server.origin))).toBe(V.R3);
				expect(bundles(root)).toEqual([V.R3]);
				expect(await settledLeftovers(root, server.origin)).toEqual([]);
				server.stop();
			} finally {
				removeRoot(root);
			}
		}, 60_000);
	}

	test("a test origin is ignored without DSH_BIN_TEST=1 (no redirect of real installs)", async () => {
		const { endpoints, INDEX_URL } = await import("../../runtime/update/index-client.ts");
		expect(endpoints({ DSH_BIN_TEST_ORIGIN: "http://127.0.0.1:1" }).index).toBe(INDEX_URL);
		expect(INDEX_URL).toBe("https://raw.githubusercontent.com/xz-dev/dsh-bin/releases/index.json");
		expect(endpoints({}).download).toBe("https://github.com/xz-dev/dsh-bin/releases/download");
	});
});
