// `dsh install --addon <name>[:<version>]` and `dsh uninstall --addon <name>[:<version>]` (self-update spec
// "Optional addons", "Addon slots"). Same discovery, verification, locking and activation rules as bundles.
// Several versions of an addon live side by side in `addons/<name>/<version>/`; which one a launch uses is
// decided by the selection (version-selection), never recorded here. An addon archive holds `addon.json`
// and `node_modules/`; it is activated read-only with a `.usage.lock` that sessions using it hold shared.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADDON_META, type AddonName, addonDir, type BundleMeta, dshHome, readAddonMeta, slotLabel, USAGE_GUARD } from "../layout.ts";
import { readSelection } from "../selection.ts";
import { addonAssetName, addonPlatform, type Candidate, candidates, defaultVersion, findCandidate } from "./addon-resolve.ts";
import { UNINSTALLED_MARK } from "./bundle.ts";
import { type Context, UserError } from "./context.ts";
import { discard, installTree, newWorkDir, quarantine, removeTree, STAGING_PREFIX, unquarantine } from "./fsops.ts";
import { fetchIndex, type ReleaseIndex } from "./index-client.ts";
import { checkRoots, fetchAndExtract, mismatch } from "./stage.ts";

export type AddonRequest = { name: AddonName; version?: string; force: boolean };

/** Online index for addon resolution; the default falls back to `pinned` when it is unreachable. */
export async function indexOrUndefined(ctx: Context): Promise<ReleaseIndex | undefined> {
	try {
		return await fetchIndex();
	} catch (error) {
		ctx.err(`warning: ${(error as Error).message}; using the addon table embedded in this dsh`);
		return undefined;
	}
}

/** Install one addon version for the bundle described by `meta` (the effective version). Caller holds `update.lock`. */
export async function installAddon(ctx: Context, meta: BundleMeta, req: AddonRequest) {
	const table = meta.addons?.[req.name];
	if (!table) throw new UserError(`dsh ${meta.version} has no ${req.name} addon table.`);
	const idx = await indexOrUndefined(ctx);
	const list = candidates(table, idx);
	let chosen: Candidate | undefined;
	if (req.version) {
		chosen = findCandidate(list, req.version);
		if (!chosen) {
			throw new UserError(`${req.name} addon version ${req.version} is not in the embedded table${idx ? " or the release index" : " and the release index is unreachable"}.`, [
				`List versions with \`dsh list --addon ${req.name}\`.`,
			]);
		}
	} else {
		const def = defaultVersion(table, idx);
		if (!def) throw new UserError(`dsh ${meta.version} has no default ${req.name} addon version (slot ${slotLabel(table.slot)}).`);
		chosen = findCandidate(list, def);
		if (!chosen) throw new UserError(`the default ${req.name} addon ${def} is not in the embedded table or the release index.`);
	}
	if (chosen.conflict) {
		throw new UserError(`${req.name} addon ${chosen.version}: the embedded table and the release index disagree on its SHA-256; refusing to install.`);
	}
	if (!chosen.inSlot && !req.force) {
		throw new UserError(
			`${req.name} addon ${chosen.version} is out of slot: it belongs to slot ${slotLabel(chosen.slot)}, but dsh ${meta.version} uses slot ${slotLabel(table.slot)}.`,
			[`Add --force to install it anyway (unsupported).`],
		);
	}
	const present = existsSync(join(addonDir(ctx.root, req.name, chosen.version), ADDON_META));
	if (present && !req.force) {
		ctx.out(`The ${req.name} addon ${chosen.version} is already installed.`);
		return;
	}
	await activateAddon(ctx, req.name, chosen, meta.target);
	ctx.out(`Installed the ${req.name} addon ${chosen.version}${chosen.inSlot ? "" : " (out of slot)"}.`);
	if (chosen.inSlot) ctx.out(`New sessions of dsh versions in slot ${slotLabel(table.slot)} use it by default.`);
	else {
		ctx.err(`warning: ${req.name} addon ${chosen.version} is out of slot for dsh ${meta.version}; it is unsupported.`);
		ctx.out(`Launches use it only when named: \`dsh --addon ${req.name}:${chosen.version}\` or \`dsh select --use <version> --addon ${req.name}:${chosen.version}\`.`);
	}
}

async function activateAddon(ctx: Context, name: AddonName, chosen: Candidate, target: string) {
	const platform = addonPlatform(target);
	const asset = chosen.assets[platform];
	if (!asset || asset.name !== addonAssetName(name, platform)) {
		throw new UserError(`${name} addon ${chosen.version} has no asset for ${platform}.`);
	}
	const staging = newWorkDir(ctx.root, STAGING_PREFIX);
	try {
		const { tree, entries } = await fetchAndExtract(chosen.tag, asset, staging, ctx.root, ctx.out);
		checkRoots(entries, [ADDON_META, "node_modules/"], "addon archive");
		const meta = readAddonMeta(tree);
		const what = `addon ${asset.name}`;
		if (!meta) throw new UserError(`invalid addon archive ${asset.name}: missing ${ADDON_META}`);
		if (meta.name !== name) mismatch(what, "name", name, meta.name);
		if (meta.version !== chosen.version) mismatch(what, "version", chosen.version, meta.version);
		if (meta.tag !== chosen.tag) mismatch(what, "tag", chosen.tag, meta.tag);
		if (meta.slot?.commit !== chosen.slot.commit) mismatch(what, "slot", chosen.slot.commit, meta.slot?.commit);
		if (!existsSync(join(tree, "node_modules"))) throw new UserError(`invalid addon archive ${asset.name}: missing node_modules/`);
		// The index sequence orders installed versions for the default (version-selection); it is assigned at
		// publication, so the archive cannot carry it.
		if (chosen.seq !== undefined) writeFileSync(join(tree, ADDON_META), `${JSON.stringify({ ...meta, seq: chosen.seq }, null, 2)}\n`);
		writeFileSync(join(tree, USAGE_GUARD), "");
		const dest = addonDir(ctx.root, name, chosen.version);
		mkdirSync(join(dest, ".."), { recursive: true });
		if (installTree(ctx.root, tree, dest, undefined, ctx.platform) === "busy") {
			throw new UserError(`${name} addon ${chosen.version} is in use by a running dsh session, so it cannot be replaced now.`);
		}
	} finally {
		try {
			removeTree(staging);
		} catch {
			// Swept by the next run.
		}
	}
}

/**
 * `dsh uninstall --addon <name>[:<version>]` (caller holds `update.lock`): that version, or every installed
 * version. All or none: refused (nothing removed) when one is in use or named by the stored selection.
 */
export function uninstallAddon(ctx: Context, name: AddonName, version?: string) {
	const dir = join(ctx.root, "addons", name);
	const installed = existsSync(dir) ? readdirSync(dir).filter((v) => !v.startsWith(".")) : [];
	const wanted = version?.replace(new RegExp(`^dsh-addon-${name}-v`), "");
	const targets = wanted === undefined ? installed : installed.filter((v) => v === wanted);
	if (!targets.length) {
		ctx.out(wanted === undefined ? `The ${name} addon is not installed.` : `The ${name} addon ${wanted} is not installed.`);
		return;
	}
	const stored = readSelection(dshHome(), !!ctx.managed);
	const selected = stored.kind === "ok" ? stored.selection.addons[name] : undefined;
	if (selected && targets.includes(selected)) {
		throw new UserError(`the ${name} addon ${selected} is named by the selection`, ["Run `dsh select` without that --addon (or with another version) first."]);
	}
	const moved: { home: string; trash: string }[] = [];
	for (const v of targets) {
		const home = join(dir, v);
		const trash = quarantine(ctx.root, home, ctx.platform);
		if (!trash) {
			for (const m of moved.reverse()) unquarantine(m.trash, m.home);
			throw new UserError(`the ${name} addon ${v} is in use by a running dsh session; nothing was uninstalled`, ["Close the dsh sessions using it and try again."]);
		}
		moved.push({ home, trash });
	}
	for (const m of moved) {
		try {
			writeFileSync(join(m.trash, UNINSTALLED_MARK), "");
		} catch {
			// Without the mark a crash before removal restores it, which loses nothing.
		}
		discard(m.trash, UNINSTALLED_MARK);
	}
	for (const v of targets) ctx.out(`Uninstalled the ${name} addon ${v}.`);
}
