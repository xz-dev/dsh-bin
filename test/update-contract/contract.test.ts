// Golden update-behaviour contract (7.10; self-update spec "Update behaviour contract tests"). Each case
// runs the real compiled entry of a fixture bundle, whose upstream `app/lib/bin.js` implements its own
// `update` command, against a local fixture index/download server. Every case pins the exit status,
// output substrings, the exact requests made and the resulting filesystem state.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
	type RunResult,
	removeRoot,
	type ServeOptions,
	serve,
	SLOT_A,
	SLOT_B,
	snapshot,
	TARGET,
	tagOf,
	addonTag,
	type World,
} from "./harness.ts";
import { buildWorld, SLOT_A2, V } from "./worlds.ts";

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

type Root = { version: string; channelFile?: "release" | "live"; managed?: string; addon?: { version: string; slot: typeof SLOT_A; forced: boolean }; extra?: string[] };

type Step = {
	argv: string[];
	serve?: ServeOptions;
	offline?: boolean;
	/** Run through the root launcher instead of the given bundle's entry. */
	viaLauncher?: boolean;
	/** Bundle whose entry runs (default: the root's initial version). */
	from?: string;
	code: number;
	stdout?: (string | RegExp)[];
	stderr?: (string | RegExp)[];
	requests?: string[];
	unchanged?: boolean;
	check?: (root: string, r: RunResult) => void;
};
type Case = { name: string; root: Root; arrange?: (root: string) => (() => void) | void; steps: Step[] };

const bundles = (root: string) => readdirSync(join(root, "bundles")).sort();
const addonsState = (root: string) => (existsSync(join(root, "addons.json")) ? JSON.parse(readFileSync(join(root, "addons.json"), "utf8")) : {});
const channelFile = (root: string) => (existsSync(join(root, "channel")) ? readFileSync(join(root, "channel"), "utf8").trim() : undefined);
const launcherOf = (root: string) => /DSH_BIN_LAUNCHER_VERSION=(\S+)/.exec(readFileSync(join(root, `dsh${EXE}`), "utf8"))?.[1];
const leftovers = (root: string) => readdirSync(root).filter((n) => n.startsWith(".staging-") || n.startsWith(".trash-") || n === "update.lock");
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
					expect(bundles(root)).toEqual([V.R1, V.R3].sort());
					expect(launcherOf(root)).toBe(V.R3);
					expect(channelFile(root)).toBe("release");
					expect(isReadOnly(join(root, "bundles", V.R3))).toBe(true);
					expect(isReadOnly(join(root, "bundles", V.R3, "app", "lib"))).toBe(true);
					expect(leftovers(root)).toEqual([]);
				},
			},
			{ argv: ["--version"], viaLauncher: true, code: 97, stdout: [join("bundles", V.R3, "app", "lib")], requests: [] },
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
	...[
		["update", "--clean", "--force"],
		["update", "--clean", "self"],
		["update", "--clean", "--channel", "live"],
	].map<Case>((argv) => ({
		name: `clean conflict: ${argv.join(" ")}`,
		root: { version: V.R1 },
		steps: [{ argv, code: 1, stderr: ["--clean cannot be combined with another update target, --force, or --channel"], requests: [], ...UNCHANGED_UPDATE }],
	})),
	...(
		[
			[["update", "--all", "--addon", "office"], "--all cannot be combined with --self, --addon, or a positional target"],
			[["update", "--addon", "office", "--addon", "office"], "--addon can only be provided once"],
			[["update", "--addon", "office", "--channel", "live"], "--channel requires a dsh update"],
			[["update", "--version", V.P1], "--version requires --addon"],
			[["update", "--all", "--version", V.P1], "--version cannot be combined with --all, --self, or --channel"],
			[["update", "--channel", "beta"], "valid channels: live, release"],
			[["update", "--channel"], "valid channels: live, release"],
			[["install", "--addon", "foo"], "valid addons: office"],
			[["install"], "requires --addon"],
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
		name: "--all updates the binary, then the addon to the new default",
		root: { version: V.R1, addon: { version: V.P1, slot: SLOT_A, forced: false } },
		steps: [
			{
				argv: ["update", "--all"],
				code: 0,
				stdout: [`Updated dsh from ${V.R1} to ${V.R3}`, `Installed the office addon ${V.P3}`],
				requests: [INDEX, bundleUrl("release", V.R3), addonUrl(V.P3)],
				check: (root) => {
					expect(launcherOf(root)).toBe(V.R3);
					expect(addonsState(root)).toEqual({ office: { version: V.P3, forced: false } });
					expect(isReadOnly(join(root, "addons", "office", V.P3))).toBe(true);
				},
			},
		],
	},
	{
		name: "plain self-update leaves the addon alone and prints the --addon/--all hint",
		root: { version: V.R1, addon: { version: V.P1, slot: SLOT_A, forced: false } },
		steps: [
			{
				argv: ["update"],
				code: 0,
				stdout: [`Updated dsh from ${V.R1} to ${V.R3}`, "`dsh update --addon office` or `dsh update --all`"],
				requests: [INDEX, bundleUrl("release", V.R3)],
				check: (root) => expect(addonsState(root)).toEqual({ office: { version: V.P1, forced: false } }),
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
				stdout: [`Updated dsh from ${V.R1} to ${V.R3}`],
				requests: [INDEX, bundleUrl("release", V.R3)],
				check: (root) => expect(existsSync(join(root, ".dsh"))).toBe(false),
			},
			{ argv: ["list", "--json"], viaLauncher: true, code: 0, stdout: [`"active": "${V.R3}"`], requests: [INDEX] },
			{ argv: ["--profile", "update"], viaLauncher: true, code: 97, stdout: ["UPSTREAM-DSH", "--profile update"], requests: [] },
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
					expect(launcherOf(root)).toBe(V.L1);
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
			["unsupported schema", { index: (i: any) => ({ ...i, schemaVersion: 2 }) }, "unsupported index schemaVersion 2"],
			["no entry for this target", { index: (i: any) => ({ ...i, channels: { release: [], live: i.channels.live } }) }, `no release release for target ${TARGET}`],
			["unreachable index", { indexStatus: 503 }, "HTTP 503"],
		] as const
	).map<Case>(([what, opts, message]) => ({
		name: `malformed index fails with a diagnostic and changes nothing: ${what}`,
		root: { version: V.R1 },
		steps: [{ argv: ["update"], serve: opts as ServeOptions, code: 1, stderr: [message], requests: [INDEX], unchanged: true }],
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
				stdout: [`Updated dsh from ${V.R3} to ${V.R3}`],
				requests: [INDEX, bundleUrl("release", V.R3)],
				check: (root) => {
					expect(bundles(root)).toEqual([V.R3]);
					expect(isReadOnly(join(root, "bundles", V.R3))).toBe(true);
					expect(leftovers(root)).toEqual([]);
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
			{ argv: ["update", "--clean"], code: 1, stderr: ["Another dsh update or cleanup is already running."], requests: [], unchanged: true },
			{ argv: ["install", "--addon", "office"], code: 1, stderr: ["Another dsh update or cleanup is already running."], requests: [], unchanged: true },
		],
	},
	// ── Cleanup ──────────────────────────────────────────────────────────────────────────────────────
	{
		name: "--clean keeps the running, launcher and claimed versions; offline",
		root: { version: V.R3, extra: [V.R1, V.R2] },
		arrange: (root) => {
			const c = holdShared(root, V.R2);
			return () => c.release();
		},
		steps: [
			{
				argv: ["update", "--clean"],
				offline: true,
				code: 0,
				stdout: ["Removed 1 old bundle(s)"],
				requests: [],
				check: (root) => expect(bundles(root)).toEqual([V.R2, V.R3].sort()),
			},
		],
	},
	{
		name: "--clean keeps the launcher version when run from another bundle",
		root: { version: V.R3, extra: [V.R1, V.R2] },
		steps: [{ argv: ["update", "--clean"], from: V.R1, offline: true, code: 0, stdout: ["Removed 1 old bundle(s)"], requests: [], check: (root) => expect(bundles(root)).toEqual([V.R1, V.R3].sort()) }],
	},
	{
		name: "--clean keeps the enabled addon and kept bundles' pinned addon, removes the rest",
		root: { version: V.R3, addon: { version: V.B1, slot: SLOT_B, forced: true } },
		arrange: (root) => {
			addAddon(world, root, { version: V.P1, seq: 1, slot: SLOT_A });
			addAddon(world, root, { version: V.Q, seq: 2, slot: SLOT_A });
			addAddon(world, root, { version: V.P3, seq: 4, slot: SLOT_A2 });
		},
		steps: [
			{
				argv: ["update", "--clean"],
				offline: true,
				code: 0,
				stdout: ["Removed 0 old bundle(s)", "Removed 2 old addon version(s)"],
				requests: [],
				check: (root) => expect(readdirSync(join(root, "addons", "office")).sort()).toEqual([V.B1, V.P3].sort()),
			},
		],
	},
	// ── Optional addons ──────────────────────────────────────────────────────────────────────────────
	{
		name: "install office: the release pin, read-only, recorded; then already installed; then uninstall",
		root: { version: V.R1 },
		steps: [
			{
				argv: ["install", "--addon", "office"],
				code: 0,
				stdout: [`Installed the office addon ${V.P1}`],
				requests: [INDEX, addonUrl(V.P1)],
				check: (root) => {
					expect(addonsState(root)).toEqual({ office: { version: V.P1, forced: false } });
					const dir = join(root, "addons", "office", V.P1);
					expect(isReadOnly(dir)).toBe(true);
					expect(existsSync(join(dir, "node_modules", "@deepseek-ai", "libreoffice-kit", "package.json"))).toBe(true);
				},
			},
			{ argv: ["install", "--addon", "office"], code: 0, stdout: [`The office addon ${V.P1} is already installed.`], requests: [INDEX], unchanged: true },
			{
				argv: ["uninstall", "--addon", "office"],
				code: 0,
				stdout: [`Uninstalled the office addon ${V.P1}.`],
				requests: [],
				check: (root) => {
					expect(addonsState(root)).toEqual({});
					expect(readdirSync(join(root, "addons", "office"))).toEqual([]);
				},
			},
		],
	},
	{
		name: "update --addon when the addon is not installed",
		root: { version: V.R1 },
		steps: [{ argv: ["update", "--addon", "office"], code: 1, stderr: ["the office addon is not installed.", "dsh install --addon office"], requests: [], unchanged: true }],
	},
	// ── Addon slots ──────────────────────────────────────────────────────────────────────────────────
	{
		name: "newer-slot addon refused; --force installs it forced; update --addon returns to the default",
		root: { version: V.R1 },
		steps: [
			{
				argv: ["install", "--addon", "office", "--version", V.B1],
				code: 1,
				stderr: [`is out of slot`, SLOT_A.commit.slice(0, 12), SLOT_B.commit.slice(0, 12), "--force"],
				requests: [INDEX],
				unchanged: true,
			},
			{
				argv: ["install", "--addon", "office", "--version", addonTag(V.B1), "--force"],
				code: 0,
				stdout: [`Installed the office addon ${V.B1} (forced, out of slot)`],
				stderr: ["out of slot"],
				requests: [INDEX, addonUrl(V.B1)],
				check: (root) => expect(addonsState(root)).toEqual({ office: { version: V.B1, forced: true } }),
			},
			{
				argv: ["list", "--json"],
				code: 0,
				requests: [INDEX],
				unchanged: true,
				check: (_root, r) => expect(json(r).addons[0]).toMatchObject({ installed: { version: V.B1, forced: true, inSlot: false }, default: V.P1, hint: "dsh update --addon office" }),
			},
			{
				argv: ["update", "--addon", "office"],
				code: 0,
				stdout: [`Installed the office addon ${V.P1}`, `(was ${V.B1})`],
				requests: [INDEX, addonUrl(V.P1)],
				check: (root) => expect(addonsState(root)).toEqual({ office: { version: V.P1, forced: false } }),
			},
		],
	},
	{
		name: "update --addon --version --force switches to an out-of-slot version; --all returns it to the default",
		root: { version: V.R3, addon: { version: V.P3, slot: SLOT_A2, forced: false } },
		steps: [
			{
				argv: ["update", "--addon", "office", "--version", V.P1, "--force"],
				code: 0,
				requests: [INDEX, addonUrl(V.P1)],
				check: (root) => expect(addonsState(root)).toEqual({ office: { version: V.P1, forced: true } }),
			},
			{
				argv: ["update", "--all"],
				code: 0,
				stdout: [`dsh is already up to date (${V.R3})`, `Installed the office addon ${V.P3}`],
				requests: [INDEX],
				check: (root) => expect(addonsState(root)).toEqual({ office: { version: V.P3, forced: false } }),
			},
		],
	},
	{
		name: "release bundle uses its pin even when a newer in-slot addon exists",
		root: { version: V.R1 },
		steps: [{ argv: ["install", "--addon", "office"], code: 0, stdout: [`Installed the office addon ${V.P1}`], requests: [INDEX, addonUrl(V.P1)] }],
	},
	{
		name: "live bundle follows its slot's newest addon",
		root: { version: V.L1 },
		steps: [{ argv: ["install", "--addon", "office"], code: 0, stdout: [`Installed the office addon ${V.Q}`], requests: [INDEX, addonUrl(V.Q)] }],
	},
	{
		name: "live bundle falls back to its pin when the index is unreachable",
		root: { version: V.L1 },
		steps: [
			{
				argv: ["install", "--addon", "office"],
				serve: { indexStatus: 503 },
				code: 0,
				stdout: [`Installed the office addon ${V.P1}`],
				stderr: ["warning:", "embedded"],
				requests: [INDEX, addonUrl(V.P1)],
			},
		],
	},
	{
		name: "kit switch-back opens a new slot: an addon from the first 0.1.2 slot is out of slot",
		root: { version: V.R3 },
		steps: [{ argv: ["install", "--addon", "office", "--version", V.P1], code: 1, stderr: ["is out of slot", "kit 0.1.2", "--force"], requests: [INDEX], unchanged: true }],
	},
	{
		name: "a pinned addon removed from the index installs from the embedded table",
		root: { version: V.R1 },
		steps: [
			{
				argv: ["install", "--addon", "office"],
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
				argv: ["install", "--addon", "office"],
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
		steps: [{ argv: ["install", "--addon", "office", "--version", "9.9.9"], code: 1, stderr: ["9.9.9 is not in the embedded table or the release index"], requests: [INDEX], unchanged: true }],
	},
	// ── Channel-managed installations ────────────────────────────────────────────────────────────────
	...(
		[
			["portage", ["update", "--force"]],
			["scoop", ["update"]],
			["portage", ["update", "--clean"]],
			["scoop", ["install", "--addon", "office"]],
			["portage", ["uninstall", "--addon", "office"]],
			["portage", ["update", "--addon", "office"]],
			["scoop", ["update", "--all"]],
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
		name: "list: newer version available, read-only, index only",
		root: { version: V.R1 },
		steps: [
			{
				argv: ["list", "--json"],
				code: 0,
				requests: [INDEX],
				unchanged: true,
				check: (_root, r) => {
					const d = json(r);
					expect(d.dsh).toMatchObject({ version: V.R1, channel: "release", target: TARGET, slot: SLOT_A });
					expect(d.channels).toEqual([
						{ channel: "release", current: true, newest: V.R3, newer: true, hint: "dsh update" },
						{ channel: "live", current: false, newest: V.L1, newer: true, hint: "dsh update --channel live" },
					]);
					expect(d.addons[0]).toMatchObject({ name: "office", installed: null, default: V.P1, pinned: V.P1, hint: "dsh install --addon office" });
					expect(d.index).toEqual({ ok: true });
				},
			},
			{ argv: ["list"], code: 0, stdout: ["dsh", V.R1, V.R3, "dsh update", "addon office"], requests: [INDEX], unchanged: true },
			{
				argv: ["list", "--channel", "live", "--json"],
				code: 0,
				requests: [INDEX],
				check: (_r, r) => expect(json(r).channels.map((c: any) => c.channel)).toEqual(["live"]),
			},
		],
	},
	{
		name: "list --addon office offline: embedded versions with slot states and a warning",
		root: { version: V.R3 },
		steps: [
			{ argv: ["list", "--addon", "office"], serve: { indexStatus: 503 }, code: 0, stderr: [/^warning: .*HTTP 503.*\n$/], stdout: [V.P3, "in slot", "out of slot", "--force", "embedded"], requests: [INDEX], unchanged: true },
			{
				argv: ["list", "--addon", "office", "--json"],
				serve: { indexStatus: 503 },
				code: 0,
				requests: [INDEX],
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
					expect(rows[V.P1]).toMatchObject({ inSlot: true, default: true, pinned: true, source: "both", conflict: false });
					expect(rows[V.Q]).toMatchObject({ inSlot: true, default: false, source: "index" });
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
				stdout: ["Upgrade dsh through portage instead.", V.R3],
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
	for (const c of cases) {
		test(c.name, async () => {
			const root = installRoot(world, c.root.version, { channelFile: c.root.channelFile, managed: c.root.managed });
			roots.push(root);
			for (const v of c.root.extra ?? []) addBundle(world, root, v);
			if (c.root.addon) addAddon(world, root, { version: c.root.addon.version, seq: 0, slot: c.root.addon.slot }, { forced: c.root.addon.forced });
			const release = c.arrange?.(root);
			try {
				for (const [i, step] of c.steps.entries()) {
					const server = serve(world, step.serve);
					const origin = step.offline ? "http://127.0.0.1:9" : server.origin;
					const before = snapshot(root);
					const r = step.viaLauncher ? await launch(root, step.argv, origin) : await dsh(root, step.from ?? c.root.version, step.argv, origin);
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
	});

	test("two concurrent updaters: one completes, the other reports the running update", async () => {
		const root = installRoot(world, V.R1);
		roots.push(root);
		const server = serve(world, { indexDelayMs: 500 });
		const [a, b] = await Promise.all([dsh(root, V.R1, ["update"], server.origin), (async () => (await Bun.sleep(150), dsh(root, V.R1, ["update", "--clean"], server.origin)))()]);
		server.stop();
		expect([a.code, b.code].sort()).toEqual([0, 1]);
		const loser = a.code === 1 ? a : b;
		expect(loser.stderr).toContain("Another dsh update or cleanup is already running.");
		expect(launcherOf(root)).toBe(V.R3);
		expect(leftovers(root)).toEqual([]);
		removeRoot(root);
	});

	// Crash injection (7.6): kill the updater at each step. The launcher must then start the old or the new
	// version, and the next update must succeed and leave no leftovers.
	/** The killed updater's update.lock stays (never reclaimed); the user removes it as the diagnostic says. */
	const afterCrash = async (root: string, origin: string) => {
		const refused = await launch(root, ["update", "--clean"], origin);
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain("Another dsh update or cleanup is already running.");
		rmSync(join(root, "update.lock"), { recursive: true });
	};
	const runs = (r: RunResult) => /UPSTREAM-DSH \S*bundles\/([^/]+)\/app\/lib/.exec(r.stdout)?.[1];
	for (const point of ["after-download", "after-extract", "before-place", "after-place", "after-launcher"]) {
		test(`crash ${point} on a version change: old or new starts, then the update completes`, async () => {
			const root = installRoot(world, V.R1);
			try {
				const server = serve(world);
				const crashed = await dsh(root, V.R1, ["update"], server.origin, { DSH_BIN_TEST_CRASH: point });
				expect(crashed.code).not.toBe(0);
				expect(crashed.stderr).toContain(`test crash at ${point}`);
				const started = runs(await launch(root, ["--version"], server.origin));
				expect([V.R1, V.R3]).toContain(started!);
				if (point !== "after-launcher") expect(started).toBe(V.R1);
				await afterCrash(root, server.origin);
				const again = await launch(root, ["update"], server.origin);
				server.stop();
				expect(again.code).toBe(0);
				expect(runs(await launch(root, ["--version"], server.origin))).toBe(V.R3);
				expect(leftovers(root)).toEqual([]);
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
					const r = await dsh(root, "", ["update", "--force"], server.origin, {}, join(root, trash, "dsh-native"));
					expect(r.code).toBe(0);
				} else expect((await launch(root, ["update", "--force"], server.origin)).code).toBe(0);
				server.stop();
				expect(runs(await launch(root, ["--version"], server.origin))).toBe(V.R3);
				expect(bundles(root)).toEqual([V.R3]);
				expect(leftovers(root)).toEqual([]);
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
