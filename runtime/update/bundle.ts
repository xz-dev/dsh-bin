// `dsh update` and `dsh clean` (self-update spec: Channels, Version selection, Verification before
// activation, Atomic activation and read-only result, Cleanup).
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
	ADDON_NAMES,
	addonDir,
	type BundleMeta,
	BUNDLE_META,
	type Channel,
	defaultAddon,
	dshHome,
	exeName,
	installedAddons,
	installedBundles,
	latestOf,
	readAddonMeta,
	readBundleMeta,
	USAGE_GUARD,
} from "../layout.ts";
import { createdLine, ensureSnapshot } from "../snapshot/auto.ts";
import { type Context, launcherPath, launcherVersionOf, replacesLauncher, UserError } from "./context.ts";
import { removePartials } from "./download.ts";
import { installTree, newWorkDir, removeTree, replaceLauncher, STAGING_PREFIX, sweepLeftovers, writeFileAtomic } from "./fsops.ts";
import { type BundleEntry, fetchIndex, newestFor, type ReleaseIndex } from "./index-client.ts";
import { checkRoots, fetchAndExtract, mismatch } from "./stage.ts";

/** Mark written into a bundle quarantined by `dsh uninstall`: the leftover sweep never restores it. */
export const UNINSTALLED_MARK = ".uninstalled";

export type SelfResult = { updated: boolean; index: ReleaseIndex; version: string; meta: BundleMeta };

/**
 * Install the newest bundle of `channel` next to the installed ones (caller holds `update.lock`). The
 * selection is never changed; a pinned selection gets a warning.
 */
export async function updateSelf(ctx: Context, opts: { channel?: Channel; force: boolean }): Promise<SelfResult> {
	const channel = opts.channel ?? ctx.channel;
	const index = await fetchIndex();
	const entry = newestFor(index, channel, ctx.meta.target);
	if (!entry) throw new UserError(`the release index has no ${channel} release for target ${ctx.meta.target}`);
	const installed = existsSync(join(ctx.root, "bundles", entry.version, BUNDLE_META));
	if (installed && !opts.force) {
		if (channel !== ctx.channel) writeFileAtomic(join(ctx.root, "channel"), `${channel}\n`);
		ctx.out(`dsh is already up to date (${entry.version})`);
		return { updated: false, index, version: entry.version, meta: readBundleMeta(join(ctx.root, "bundles", entry.version)) ?? ctx.meta };
	}
	const from = latestOf(installedBundles(ctx.root), ctx.channel)?.version ?? ctx.running;
	const meta = await activateBundle(ctx, entry, "newer-protocol");
	writeFileAtomic(join(ctx.root, "channel"), `${channel}\n`);
	ctx.out(installed ? `Installed dsh ${entry.version}` : `Updated dsh from ${from} to ${entry.version}`);
	snapshotAfterInstall(ctx, meta);
	return { updated: true, index, version: entry.version, meta };
}

/**
 * Automatic snapshot of a newly installed version (plugin-snapshots). The install itself has succeeded: a
 * failed copy is reported, and the next start of that version tries again.
 */
export function snapshotAfterInstall(ctx: Context, meta: BundleMeta) {
	if (ctx.managed) return;
	try {
		const r = ensureSnapshot(dshHome(), meta.version, meta, "install", () => ctx.out("Waiting for another dsh snapshot operation..."));
		if (r.created) ctx.out(createdLine(r.snapshot));
	} catch (error) {
		ctx.err(`warning: could not create the plugin snapshot of dsh ${meta.version}: ${(error as Error).message}`);
		ctx.err("The next start of this version creates it.");
	}
}

/**
 * Download, verify and place one bundle (caller holds `update.lock`). The root launcher is replaced only
 * when the bundle declares a newer launcher protocol than the installed launcher (never downgraded).
 */
export async function activateBundle(ctx: Context, entry: BundleEntry): Promise<BundleMeta> {
	const target = ctx.meta.target;
	const asset = entry.assets[target]!;
	const launcher = exeName("dsh", ctx.platform);
	const rel = `bundles/${entry.version}`;
	const staging = newWorkDir(ctx.root, STAGING_PREFIX);
	try {
		const { tree, entries } = await fetchAndExtract(entry.tag, asset, staging, ctx.root, ctx.out);
		checkRoots(entries, [launcher, `${rel}/`, "bundles/"], "bundle archive");
		const staged = join(tree, rel);
		const meta = readBundleMeta(staged);
		const what = `bundle ${asset.name}`;
		if (!meta) throw new UserError(`invalid bundle archive ${asset.name}: missing ${rel}/${BUNDLE_META}`);
		if (meta.name !== "dsh-bin") mismatch(what, "name", "dsh-bin", meta.name);
		if (meta.tag !== entry.tag) mismatch(what, "tag", entry.tag, meta.tag);
		if (meta.version !== entry.version) mismatch(what, "version", entry.version, meta.version);
		if (meta.channel !== entry.channel) mismatch(what, "channel", entry.channel, meta.channel);
		if (meta.target !== target) mismatch(what, "target", target, meta.target);
		if (meta.upstream?.commit !== entry.upstream.commit) mismatch(what, "upstream commit", entry.upstream.commit, meta.upstream?.commit);
		const required = new Set([launcher, `${rel}/${BUNDLE_META}`, `${rel}/${USAGE_GUARD}`, `${rel}/${exeName("dsh-native", ctx.platform)}`, ...(meta.requiredPaths ?? [])]);
		const missing = [...required].filter((p) => !existsSync(join(tree, p)));
		if (missing.length) throw new UserError(`invalid bundle archive ${asset.name}: missing ${missing.join(", ")}`);
		const stagedLauncher = join(tree, launcher);
		const embedded = launcherVersionOf(readFileSync(stagedLauncher));
		if (embedded !== entry.version) mismatch(what, "launcher version", entry.version, embedded);

		chmodSync(stagedLauncher, statSync(stagedLauncher).mode & 0o7555);

		mkdirSync(join(ctx.root, "bundles"), { recursive: true });
		const dest = join(ctx.root, rel);
		// An existing generation (same-version --force) is replaced under its exclusive usage claim; a version
		// in use is never replaced.
		const rootLauncher = launcherPath(ctx.root, ctx.platform);
		const replace = replacesLauncher(rootLauncher, meta.launcherProtocol);
		const placed = installTree(ctx.root, staged, dest, () => replace && replaceLauncher(stagedLauncher, rootLauncher, ctx.platform), ctx.platform);
		if (placed === "busy") {
			throw new UserError(`dsh ${entry.version} is in use by another dsh process, so it cannot be replaced now.`, ["Close the other dsh sessions and run the update again."]);
		}
		return meta;
	} finally {
		try {
			removeTree(staging);
		} catch {
			// Swept by the next run.
		}
	}
}

/**
 * Home of a quarantined tree that must survive a crash: an installed bundle or addon version caught
 * mid-replacement (`--force`), unless `dsh uninstall` removed it. Used by the leftover sweep, which restores
 * it only when its home is missing.
 */
export function referencedHome(ctx: Context): (trash: string) => string | undefined {
	return (trash) => {
		if (existsSync(join(trash, UNINSTALLED_MARK))) return undefined;
		const meta = readBundleMeta(trash);
		if (meta?.name === "dsh-bin") return join(ctx.root, "bundles", meta.version);
		const addon = readAddonMeta(trash);
		if (addon && (ADDON_NAMES as readonly string[]).includes(addon.name)) return addonDir(ctx.root, addon.name, addon.version);
		return undefined;
	};
}

/**
 * Hint when the new bundle's slot has no installed version of an addon that is installed for another slot
 * (self-update "New slot hint"). Nothing is downloaded.
 */
export function newSlotHints(ctx: Context, meta: BundleMeta): string[] {
	const lines: string[] = [];
	for (const name of ADDON_NAMES) {
		const installed = installedAddons(ctx.root, name);
		const slot = meta.addons?.[name]?.slot;
		if (!installed.length || !slot || defaultAddon(installed, slot)) continue;
		lines.push(`No installed ${name} addon version fits dsh ${meta.version} (kit ${slot.kitVersion}); run \`dsh install --addon ${name}\` to install one.`);
	}
	return lines;
}

/**
 * `dsh clean --update` (caller holds `update.lock`): leftovers of interrupted installs, updates and
 * uninstalls in the install root, and partial downloads. Installed versions are never touched.
 */
export function cleanUpdateLeftovers(ctx: Context) {
	const removed = sweepLeftovers(ctx.root, referencedHome(ctx));
	ctx.out(`Removed ${removed} interrupted install leftover(s)`);
	const partials = removePartials(ctx.root);
	if (partials) ctx.out(`Removed ${partials} partial download(s)`);
}

/**
 * `dsh clean --transpiler`: dsh-bin's own transpiler cache (launcher-chosen; a user-set
 * BUN_RUNTIME_TRANSPILER_CACHE_PATH is not ours). Entries are content-keyed, so old versions' files only
 * accumulate; each bundle reseeds on its next start.
 */
export function cleanTranspiler(ctx: Context) {
	const cache = process.env.DSH_BUNDLE_CACHE;
	const transpiler = cache && isAbsolute(cache) ? join(cache, "transpiler") : undefined;
	if (!transpiler || !existsSync(transpiler)) {
		ctx.out("No transpiler cache to clear");
		return;
	}
	try {
		rmSync(transpiler, { recursive: true, force: true, maxRetries: 3 });
		ctx.out("Cleared the transpiler cache");
	} catch {
		// In use on Windows: stale entries are harmless; cleared next time.
		ctx.out("The transpiler cache is in use; cleared next time");
	}
}
