// `dsh install <version>` and `dsh uninstall <version>...` (self-update "Installing and uninstalling
// versions"). Several dsh versions live side by side under `bundles/`; installing or uninstalling never
// changes the selection, and uninstalling keeps the version's snapshots. Caller holds `update.lock`.
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Channel, compareVersionOrder, dshHome, installedBundles, matchVersion } from "../layout.ts";
import { readSelection } from "../selection.ts";
import { activateBundle, snapshotAfterInstall, UNINSTALLED_MARK } from "./bundle.ts";
import { type Context, UserError } from "./context.ts";
import { discard, quarantine, unquarantine } from "./fsops.ts";
import { type BundleEntry, fetchIndex, type ReleaseIndex } from "./index-client.ts";

/**
 * The index entry `query` names on `channel`: the exact version, its tag, or an upstream version
 * (`0.1.7-rc.2`, `live.abc1234`), which picks the newest entry (highest seq) built from it.
 */
export function findEntry(index: ReleaseIndex, channel: Channel, target: string, query: string): BundleEntry | undefined {
	// A release tag is `dsh-v<version>`; a live tag (`dsh-live-<sha7>-xz...`) is matched as a whole below.
	const q = query.replace(/^dsh-v/, "");
	const entries = index.channels[channel].filter((e) => e.assets[target]);
	const exact = entries.find((e) => e.version === q || e.tag === query);
	if (exact) return exact;
	return entries.filter((e) => e.version.startsWith(`${q}-xz.`)).reduce<BundleEntry | undefined>((a, e) => (!a || e.seq > a.seq ? e : a), undefined);
}

export async function installVersion(ctx: Context, opts: { query: string; channel?: Channel; force: boolean }) {
	const channel = opts.channel ?? ctx.channel;
	const index = await fetchIndex();
	const entry = findEntry(index, channel, ctx.meta.target, opts.query);
	if (!entry) {
		throw new UserError(`no ${channel} entry of the release index matches ${opts.query} for target ${ctx.meta.target}`, [
			`Run \`dsh list${channel === ctx.channel ? "" : ` --channel ${channel}`}\` to see the installable versions.`,
		]);
	}
	if (existsSync(join(ctx.root, "bundles", entry.version)) && !opts.force) {
		ctx.out(`dsh ${entry.version} is already installed.`);
		return;
	}
	const meta = await activateBundle(ctx, entry, "newer-protocol");
	ctx.out(`Installed dsh ${entry.version}`);
	snapshotAfterInstall(ctx, meta);
	for (const line of pinnedWarning(ctx, meta.version)) ctx.err(line);
}

/**
 * Warning when a newly installed version is newer in version order than the version the selection pins
 * (version-selection "Installing never switches").
 */
export function pinnedWarning(ctx: Context, installed: string): string[] {
	const stored = readSelection(dshHome());
	if (stored.kind !== "ok" || stored.selection.use === "latest") return [];
	const bundles = installedBundles(ctx.root);
	const m = matchVersion(
		bundles.map((b) => b.version),
		stored.selection.use,
	);
	const pinned = m.kind === "found" ? bundles.find((b) => b.version === m.version) : undefined;
	const fresh = bundles.find((b) => b.version === installed);
	if (!pinned || !fresh || compareVersionOrder(fresh, pinned) <= 0) return [];
	return [`warning: plain \`dsh\` still starts ${pinned.version}, which the selection pins.`, "Run `dsh select --use latest` to follow the newest installed version."];
}

export function uninstallVersions(ctx: Context, queries: readonly string[]) {
	const dir = join(ctx.root, "bundles");
	// Every directory under bundles/, readable or not, so a broken or other-protocol bundle can be removed.
	const installed = existsSync(dir) ? readdirSync(dir).filter((n) => !n.startsWith(".")) : [];
	const targets: string[] = [];
	for (const q of queries) {
		const m = matchVersion(installed, q);
		if (m.kind === "ambiguous") throw new UserError(`version ${q} is ambiguous (${m.versions.join(", ")}, ...); give more of the version`);
		if (m.kind === "none") throw new UserError(`dsh ${q} is not installed`, ["Run `dsh list` to see the installed versions."]);
		if (!targets.includes(m.version)) targets.push(m.version);
	}
	if (targets.length === installed.length) {
		throw new UserError(`cannot uninstall ${targets.length > 1 ? "every installed version" : `dsh ${targets[0]}, the last installed version`}`, [
			"Install another version first (`dsh install <version>`), or remove dsh itself.",
		]);
	}
	const stored = readSelection(dshHome());
	if (stored.kind === "ok" && stored.selection.use !== "latest") {
		const m = matchVersion(installed, stored.selection.use);
		if (m.kind === "found" && targets.includes(m.version)) {
			throw new UserError(`dsh ${m.version} is pinned by the selection`, ["Run `dsh select --use latest` (or pin another version) first."]);
		}
	}
	// All or none: quarantine every target under its exclusive usage claim, put them back if one is in use.
	const moved: { home: string; trash: string }[] = [];
	for (const version of targets) {
		const home = join(dir, version);
		const trash = quarantine(ctx.root, home, ctx.platform);
		if (!trash) {
			for (const m of moved.reverse()) unquarantine(m.trash, m.home);
			throw new UserError(`dsh ${version} is in use by a running dsh process; nothing was uninstalled`, ["Close the dsh sessions using it and try again."]);
		}
		moved.push({ home, trash });
	}
	for (const m of moved) {
		try {
			writeFileSync(join(m.trash, UNINSTALLED_MARK), "");
		} catch {
			// Without the mark a crash before removal restores the bundle, which loses nothing.
		}
		discard(m.trash);
	}
	for (const version of targets) ctx.out(`Uninstalled dsh ${version}; its plugin snapshots are kept (\`dsh snapshot list\`).`);
}
