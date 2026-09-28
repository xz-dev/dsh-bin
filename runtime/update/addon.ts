// `dsh install --addon`, `dsh uninstall --addon`, `dsh update --addon` (self-update spec "Optional addons",
// "Addon slots"). Same discovery, verification, locking and activation rules as bundle updates.
// An addon archive holds `addon.json` and `node_modules/` at its root; it is activated read-only into
// `addons/<name>/<version>/`, with a `.usage.lock` that sessions using it hold shared.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADDON_META, type AddonName, addonDir, type BundleMeta, readAddonMeta, readAddonsState, slotLabel, USAGE_GUARD } from "../layout.ts";
import { addonAssetName, addonPlatform, type Candidate, candidates, defaultVersion, findCandidate } from "./addon-resolve.ts";
import { type Context, UserError } from "./context.ts";
import { installTree, newWorkDir, removeTree, retire, STAGING_PREFIX, writeFileAtomic } from "./fsops.ts";
import { fetchIndex, type ReleaseIndex } from "./index-client.ts";
import { checkRoots, fetchAndExtract, mismatch } from "./stage.ts";

export type AddonRequest = { name: AddonName; version?: string; force: boolean; mode: "install" | "update" };

/** Online index for addon resolution. A live bundle's default falls back to `pinned` when it is unreachable. */
export async function indexOrUndefined(ctx: Context, needed: boolean): Promise<ReleaseIndex | undefined> {
	try {
		return await fetchIndex();
	} catch (error) {
		if (needed) throw error;
		ctx.err(`warning: ${(error as Error).message}; using the addon table embedded in this dsh`);
		return undefined;
	}
}

function writeState(ctx: Context, name: AddonName, value: { version: string; forced: boolean } | undefined) {
	const state = readAddonsState(ctx.root);
	if (value) state[name] = value;
	else delete state[name];
	writeFileAtomic(join(ctx.root, "addons.json"), `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Install or update an addon for the bundle described by `meta` (the active bundle). Caller holds
 * `update.lock`. `index` may be passed in when the caller already fetched it (`--all`).
 */
export async function installAddon(ctx: Context, meta: BundleMeta, req: AddonRequest, index?: ReleaseIndex | null) {
	const table = meta.addons?.[req.name];
	if (!table) throw new UserError(`dsh ${meta.version} has no ${req.name} addon table.`);
	const enabled = readAddonsState(ctx.root)[req.name];
	if (req.mode === "update" && !enabled) {
		throw new UserError(`the ${req.name} addon is not installed.`, [`Install it with \`dsh install --addon ${req.name}\`.`]);
	}
	// The index is optional only when the embedded table can answer: no --version beyond it, and for live
	// bundles the pinned fallback. Its failure is reported when the chosen version cannot be resolved offline.
	const idx = index === undefined ? await indexOrUndefined(ctx, false) : (index ?? undefined);
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
		const def = defaultVersion(table, meta.channel, idx);
		if (!def) throw new UserError(`dsh ${meta.version} has no default ${req.name} addon version (slot ${slotLabel(table.slot)}).`);
		chosen = findCandidate(list, def);
		if (!chosen) throw new UserError(`the default ${req.name} addon ${def} is not in the embedded table or the release index.`);
	}
	if (chosen.conflict) {
		throw new UserError(`${req.name} addon ${chosen.version}: the embedded table and the release index disagree on its SHA-256; refusing to install.`);
	}
	if (!chosen.inSlot && !(req.force && req.version)) {
		throw new UserError(
			`${req.name} addon ${chosen.version} is out of slot: it belongs to slot ${slotLabel(chosen.slot)}, but dsh ${meta.version} uses slot ${slotLabel(table.slot)}.`,
			[`Add --force to install it anyway (unsupported).`],
		);
	}
	const forced = !chosen.inSlot;
	const dir = addonDir(ctx.root, req.name, chosen.version);
	const present = existsSync(join(dir, ADDON_META));
	if (present && enabled?.version === chosen.version && !req.force) {
		if (enabled.forced !== forced) writeState(ctx, req.name, { version: chosen.version, forced });
		ctx.out(`The ${req.name} addon ${chosen.version} is already installed.`);
		return { changed: false, version: chosen.version };
	}
	if (!present || req.force) await activateAddon(ctx, req.name, chosen, meta.target);
	writeState(ctx, req.name, { version: chosen.version, forced });
	const from = enabled && enabled.version !== chosen.version ? ` (was ${enabled.version})` : "";
	ctx.out(`Installed the ${req.name} addon ${chosen.version}${forced ? " (forced, out of slot)" : ""}${from}.`);
	if (forced) ctx.err(`warning: ${req.name} addon ${chosen.version} is out of slot for dsh ${meta.version}; it is unsupported.`);
	ctx.out("New dsh sessions will use it.");
	return { changed: true, version: chosen.version };
}

async function activateAddon(ctx: Context, name: AddonName, chosen: Candidate, target: string) {
	const platform = addonPlatform(target);
	const asset = chosen.assets[platform];
	if (!asset || asset.name !== addonAssetName(name, platform)) {
		throw new UserError(`${name} addon ${chosen.version} has no asset for ${platform}.`);
	}
	const staging = newWorkDir(ctx.root, STAGING_PREFIX);
	try {
		const { tree, entries } = await fetchAndExtract(chosen.tag, asset, staging, ctx.out);
		checkRoots(entries, [ADDON_META, "node_modules/"], "addon archive");
		const meta = readAddonMeta(tree);
		const what = `addon ${asset.name}`;
		if (!meta) throw new UserError(`invalid addon archive ${asset.name}: missing ${ADDON_META}`);
		if (meta.name !== name) mismatch(what, "name", name, meta.name);
		if (meta.version !== chosen.version) mismatch(what, "version", chosen.version, meta.version);
		if (meta.tag !== chosen.tag) mismatch(what, "tag", chosen.tag, meta.tag);
		if (meta.slot?.commit !== chosen.slot.commit) mismatch(what, "slot", chosen.slot.commit, meta.slot?.commit);
		if (!existsSync(join(tree, "node_modules"))) throw new UserError(`invalid addon archive ${asset.name}: missing node_modules/`);
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

/** `dsh uninstall --addon <name>` (caller holds `update.lock`). */
export function uninstallAddon(ctx: Context, name: AddonName) {
	const enabled = readAddonsState(ctx.root)[name];
	if (!enabled) {
		ctx.out(`The ${name} addon is not installed.`);
		return;
	}
	writeState(ctx, name, undefined);
	const dir = addonDir(ctx.root, name, enabled.version);
	const removed = existsSync(dir) && retire(ctx.root, dir);
	ctx.out(`Uninstalled the ${name} addon ${enabled.version}.`);
	if (existsSync(dir) && !removed) ctx.out("Its files are still used by a running dsh session; `dsh update --clean` removes them later.");
}
