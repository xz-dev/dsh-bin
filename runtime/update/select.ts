// `dsh select` (version-selection "Persistent selection", "Managed installations are pre-selected"): set or
// print what a plain `dsh` launch uses. Every named item must exist; a refusal changes nothing. Installing,
// updating and uninstalling never touch the selection.
import { type AddonName, ADDON_NAMES, type BundleMeta, defaultAddon, dshHome, installedAddons, installedBundles, latestOf, matchVersion } from "../layout.ts";
import { DEFAULT_SELECTION, readSelection, type Selection, selectionPath, writeSelection } from "../selection.ts";
import { listSnapshots, newestOf, requireSnapshot } from "../snapshot/store.ts";
import { readLaunch } from "../snapshot/launch.ts";
import { type Context, UserError } from "./context.ts";

export type SelectOptions = { use?: string; snapshot?: string; addons: { name: AddonName; version: string }[] };

/** The installed bundle `query` names (exact, tag or unique prefix), or a UserError naming `dsh install`. */
export function requireBundle(bundles: readonly BundleMeta[], query: string): BundleMeta {
	const m = matchVersion(
		bundles.map((b) => b.version),
		query,
	);
	if (m.kind === "ambiguous") throw new UserError(`version ${query} is ambiguous (${m.versions.join(", ")}, ...); give more of the version`);
	if (m.kind === "none") throw new UserError(`dsh ${query} is not installed`, [`Run \`dsh install ${query}\` to install it.`]);
	return bundles.find((b) => b.version === m.version)!;
}

/**
 * The effective version of a maintenance command (version-selection "Leading launch options"): what the
 * launcher resolved from the leading options and the selection (`DSH_BIN_LAUNCH`), or, for a process
 * started directly, the selection resolved by the launcher's rules. A UserError when it does not resolve.
 */
export function effectiveBundle(ctx: Context, env: NodeJS.ProcessEnv = process.env): BundleMeta {
	const bundles = installedBundles(ctx.root);
	const launch = readLaunch(env);
	if (ctx.managed) {
		const option = launch?.use ? "--use" : launch?.addons.length ? "--addon" : undefined;
		if (option) throw new UserError(`${option} is not available: the dsh version and addons are managed by ${ctx.managed}`);
		const newest = latestOf(bundles, null);
		if (!newest) throw new UserError("no dsh version is installed");
		return newest;
	}
	if (launch) {
		const found = launch.version ? bundles.find((b) => b.version === launch.version) : undefined;
		if (found) return found;
	}
	if (launch?.use) return requireBundle(bundles, launch.use);
	if (launch?.snapshot) {
		const at = launch.snapshot.lastIndexOf("@");
		if (at <= 0) throw new UserError(`invalid snapshot id ${launch.snapshot}: expected <version>@<n|name>`);
		return requireBundle(bundles, launch.snapshot.slice(0, at));
	}
	const stored = readSelection(dshHome());
	if (stored.kind === "invalid") throw new UserError(`cannot read the selection ${selectionPath(dshHome())} (${stored.reason})`, ["Run `dsh select --use latest` to reset it."]);
	const use = stored.kind === "ok" ? stored.selection.use : "latest";
	if (use !== "latest") {
		try {
			return requireBundle(bundles, use);
		} catch (error) {
			if (error instanceof UserError) throw new UserError(`the selected ${error.message}`, [...error.hints, "Run `dsh select --use latest` to follow the newest installed version."]);
			throw error;
		}
	}
	const latest = latestOf(bundles, ctx.channel);
	if (!latest) throw new UserError(`no dsh version of the ${ctx.channel} channel is installed`, ["Run `dsh update` to install one."]);
	return latest;
}

export function select(ctx: Context, opts: SelectOptions) {
	const home = dshHome();
	const stored = readSelection(home, !!ctx.managed);
	if (stored.kind === "invalid" && (opts.use === undefined || ctx.managed)) {
		// Only `--use` can replace an unreadable selection (a managed install never writes `use`).
		throw new UserError(`cannot read the selection ${selectionPath(home)} (${stored.reason})`, ctx.managed ? [] : ["Run `dsh select --use latest` to reset it."]);
	}
	const current = stored.kind === "ok" ? stored.selection : DEFAULT_SELECTION;
	if (opts.use === undefined && opts.snapshot === undefined && opts.addons.length === 0) return print(ctx, home, current);

	if (ctx.managed) {
		const option = opts.use !== undefined ? "--use" : opts.addons.length ? "--addon" : undefined;
		if (option) throw new UserError(`${option} is not available: the dsh version and addons are managed by ${ctx.managed}`, ["`dsh select --snapshot <id>` still works."]);
	} else if (opts.use === undefined) {
		throw new UserError("dsh select requires --use <version|latest>", ["Run `dsh select --use latest` for the default, which follows the newest installed version."]);
	}

	const bundles = installedBundles(ctx.root);
	const use = opts.use === undefined || opts.use === "latest" ? opts.use : requireBundle(bundles, opts.use).version;
	const snapshot = opts.snapshot === undefined ? null : requireSnapshot(listSnapshots(home), opts.snapshot).id;
	const addons: Record<string, string> = {};
	for (const a of opts.addons) {
		if (!installedAddons(ctx.root, a.name).some((m) => m.version === a.version)) {
			throw new UserError(`${a.name} addon ${a.version} is not installed`, [`Run \`dsh install --addon ${a.name}:${a.version}\` to install it.`]);
		}
		addons[a.name] = a.version;
	}

	// Omitted options are stored as default. A managed install sets only the snapshot, and keeps a user's
	// unmanaged version and addon choices in the same $DSH_HOME intact.
	const next: Selection = ctx.managed ? { ...current, snapshot } : { schema: 1, use: use!, snapshot, addons };
	writeSelection(home, next);
	ctx.out(`Selected ${describe(next)}.`);
	print(ctx, home, next);
}

const describe = (s: Selection) =>
	[`--use ${s.use}`, ...(s.snapshot ? [`--snapshot ${s.snapshot}`] : []), ...Object.entries(s.addons).map(([n, v]) => `--addon ${n}:${v}`)].join(" ");

/** The selection and what a plain launch resolves it to now. */
function print(ctx: Context, home: string, s: Selection) {
	const bundles = installedBundles(ctx.root);
	const snapshots = listSnapshots(home);
	let version: BundleMeta | undefined;
	let versionLine: string;
	if (ctx.managed) {
		version = latestOf(bundles, null);
		versionLine = `${version?.version ?? "none installed"} (managed by ${ctx.managed})`;
	} else if (s.use === "latest") {
		version = latestOf(bundles, ctx.channel);
		versionLine = version ? `${version.version} (latest on the ${ctx.channel} channel)` : `none installed on the ${ctx.channel} channel; run \`dsh update\``;
	} else {
		const m = matchVersion(
			bundles.map((b) => b.version),
			s.use,
		);
		version = m.kind === "found" ? bundles.find((b) => b.version === m.version) : undefined;
		versionLine = version ? version.version : `${s.use} is not installed; run \`dsh install ${s.use}\` or \`dsh select --use latest\``;
	}
	ctx.out(`selection: ${ctx.managed ? `managed by ${ctx.managed}${s.snapshot ? `, --snapshot ${s.snapshot}` : ""}` : describe(s)}`);
	ctx.out(`  version:  ${versionLine}`);
	let snapshotLine: string;
	if (s.snapshot) {
		const found = snapshots.find((x) => x.id === s.snapshot);
		snapshotLine = found ? s.snapshot : `${s.snapshot} does not exist; run \`dsh snapshot list\``;
	} else if (version) {
		const newest = newestOf(snapshots, version.version);
		snapshotLine = newest ? `${newest.id} (newest)` : "none yet (created at the next start)";
	} else snapshotLine = "-";
	ctx.out(`  snapshot: ${snapshotLine}`);
	for (const name of ADDON_NAMES) {
		const installed = installedAddons(ctx.root, name);
		const managedAddon = ctx.managed ? installed.at(-1) : undefined;
		const named = ctx.managed ? undefined : s.addons[name];
		let line: string;
		if (named) line = installed.some((a) => a.version === named) ? named : `${named} is not installed; run \`dsh install --addon ${name}:${named}\``;
		else if (managedAddon) line = `${managedAddon.version} (managed)`;
		else {
			const def = version ? defaultAddon(installed, version.addons?.[name]?.slot) : undefined;
			line = def ? `${def.version} (default)` : `none installed for this version; run \`dsh install --addon ${name}\``;
		}
		ctx.out(`  ${`${name}:`.padEnd(9)} ${line}`);
	}
}
