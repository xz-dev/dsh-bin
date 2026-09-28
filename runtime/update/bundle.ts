// `dsh update` (binary) and `dsh update --clean` (self-update spec: Channels, Version selection,
// Verification before activation, Atomic activation and read-only result, Cleanup).
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { addonDir, type BundleMeta, BUNDLE_META, type Channel, exeName, readAddonMeta, readAddonsState, readBundleMeta, USAGE_GUARD } from "../layout.ts";
import { type Context, launcherPath, launcherVersion, launcherVersionOf, UserError } from "./context.ts";
import { discard, newWorkDir, placeReadOnly, quarantine, removeTree, retire, unquarantine, replaceLauncher, STAGING_PREFIX, writeFileAtomic } from "./fsops.ts";
import { type BundleEntry, fetchIndex, isNewer, newestFor, type ReleaseIndex } from "./index-client.ts";
import { checkRoots, fetchAndExtract, mismatch } from "./stage.ts";
import { defaultVersion } from "./addon-resolve.ts";

export type SelfResult = { updated: boolean; index: ReleaseIndex; version: string; meta: BundleMeta };

/** Select, verify and activate the newest bundle of `channel` (caller holds `update.lock`). */
export async function updateSelf(ctx: Context, opts: { channel?: Channel; force: boolean }): Promise<SelfResult> {
	const channel = opts.channel ?? ctx.channel;
	const switching = channel !== ctx.channel;
	const index = await fetchIndex();
	const entry = newestFor(index, channel, ctx.meta.target);
	if (!entry) throw new UserError(`the release index has no ${channel} release for target ${ctx.meta.target}`);
	const sameVersion = entry.version === ctx.running;
	if (!switching && !opts.force && !isNewer(index, channel, ctx.running, entry)) {
		ctx.out(`dsh is already up to date (${ctx.running})`);
		return { updated: false, index, version: ctx.running, meta: ctx.meta };
	}
	if (!switching && opts.force && !sameVersion && !isNewer(index, channel, ctx.running, entry)) {
		// Never move backwards within a channel, even with --force.
		ctx.out(`dsh is already up to date (${ctx.running})`);
		return { updated: false, index, version: ctx.running, meta: ctx.meta };
	}
	const meta = await activateBundle(ctx, entry);
	writeFileAtomic(join(ctx.root, "channel"), `${channel}\n`);
	ctx.out(`Updated dsh from ${ctx.running} to ${entry.version}`);
	return { updated: true, index, version: entry.version, meta };
}

async function activateBundle(ctx: Context, entry: BundleEntry): Promise<BundleMeta> {
	const target = ctx.meta.target;
	const asset = entry.assets[target]!;
	const launcher = exeName("dsh", ctx.platform);
	const rel = `bundles/${entry.version}`;
	const staging = newWorkDir(ctx.root, STAGING_PREFIX);
	try {
		const { tree, entries } = await fetchAndExtract(entry.tag, asset, staging, ctx.out);
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
		// An existing generation (same-version --force, or leftovers of a crash between the two renames) is
		// retired under its exclusive usage claim; a version in use is never replaced.
		let previous: string | undefined;
		if (existsSync(dest)) {
			previous = quarantine(ctx.root, dest);
			if (!previous) {
				throw new UserError(`dsh ${entry.version} is in use by another dsh process, so it cannot be replaced now.`, [
					"Close the other dsh sessions and run the update again.",
				]);
			}
		}
		try {
			placeReadOnly(staged, dest, ctx.platform);
			replaceLauncher(stagedLauncher, launcherPath(ctx.root, ctx.platform), ctx.platform);
		} catch (error) {
			// Put the previous generation back; a crash here instead is repaired by the next run's sweep.
			if (previous && !existsSync(dest)) unquarantine(previous, dest);
			throw error;
		}
		if (previous) discard(previous);
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
 * Home of a quarantined tree that must survive a crash: a bundle the root launcher (or the running process)
 * still starts, or the enabled addon version. Used by the leftover sweep.
 */
export function referencedHome(ctx: Context): (trash: string) => string | undefined {
	const active = launcherVersion(ctx.root, ctx.platform);
	const enabled = readAddonsState(ctx.root);
	return (trash) => {
		const meta = readBundleMeta(trash);
		if (meta?.name === "dsh-bin" && (meta.version === active || meta.version === ctx.running)) return join(ctx.root, "bundles", meta.version);
		const addon = readAddonMeta(trash);
		if (addon && enabled[addon.name]?.version === addon.version) return addonDir(ctx.root, addon.name, addon.version);
		return undefined;
	};
}

/** Hint when the enabled addon is not the new bundle's default (plain self-update leaves addons alone). */
export function addonHints(ctx: Context, meta: BundleMeta, index: ReleaseIndex | undefined): string[] {
	const state = readAddonsState(ctx.root);
	const lines: string[] = [];
	for (const [name, rec] of Object.entries(state)) {
		const table = meta.addons?.[name as "office"];
		if (!rec || !table) continue;
		const def = defaultVersion(table, meta.channel, index);
		if (def && def !== rec.version) {
			lines.push(`The ${name} addon ${rec.version}${rec.forced ? " (forced)" : ""} is not the default for dsh ${meta.version} (${def}).`);
			lines.push(`Run \`dsh update --addon ${name}\` or \`dsh update --all\` to update it.`);
		}
	}
	return lines;
}

/** `dsh update --clean` (caller holds `update.lock`): offline retirement of unused bundles and addons. */
export function clean(ctx: Context) {
	const keep = new Set([ctx.running]);
	const active = launcherVersion(ctx.root, ctx.platform);
	if (active) keep.add(active);
	const bundles = join(ctx.root, "bundles");
	let removed = 0;
	const kept: BundleMeta[] = [];
	for (const version of existsSync(bundles) ? readdirSync(bundles).sort() : []) {
		const dir = join(bundles, version);
		if (!keep.has(version) && retire(ctx.root, dir)) {
			removed++;
			continue;
		}
		const meta = readBundleMeta(dir);
		if (meta) kept.push(meta);
	}
	ctx.out(`Removed ${removed} old bundle(s)`);

	// Addon versions: keep the enabled one and each kept bundle's default (offline: its pinned version).
	const state = readAddonsState(ctx.root);
	let addonsRemoved = 0;
	const addonsRoot = join(ctx.root, "addons");
	for (const name of existsSync(addonsRoot) ? readdirSync(addonsRoot) : []) {
		const keepAddon = new Set<string>();
		const enabled = state[name as "office"]?.version;
		if (enabled) keepAddon.add(enabled);
		for (const m of kept) {
			const pinned = m.addons?.[name as "office"]?.pinned;
			if (pinned) keepAddon.add(pinned);
		}
		for (const version of readdirSync(join(addonsRoot, name))) {
			if (!keepAddon.has(version) && retire(ctx.root, join(addonsRoot, name, version))) addonsRemoved++;
		}
	}
	if (addonsRemoved) ctx.out(`Removed ${addonsRemoved} old addon version(s)`);
}
