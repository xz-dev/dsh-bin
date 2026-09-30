// `dsh list` (self-update spec "Listing versions"): read-only. No lock, no download, no file change; the
// only network request is the release index, and its failure degrades to local and embedded data.
import { join } from "node:path";
import { ADDON_NAMES, type AddonName, type BundleMeta, type Channel, CHANNELS, dshHome, installedAddons, installedBundles, latestOf, sameSlot, slotLabel, USAGE_GUARD } from "../layout.ts";
import { DEFAULT_SELECTION, readSelection, selectionPath } from "../selection.ts";
import { guardInUse } from "../usage-claim.ts";
import { candidates, defaultVersion } from "./addon-resolve.ts";
import type { Context } from "./context.ts";
import { fetchIndex, newestFor, type ReleaseIndex } from "./index-client.ts";
import { effectiveBundle, type ResolvedSelection, resolveSelection } from "./select.ts";

export type ListOptions = { addon?: AddonName; channel?: Channel; json: boolean };

export async function list(ctx: Context, opts: ListOptions) {
	let index: ReleaseIndex | undefined;
	let indexError: string | undefined;
	try {
		index = await fetchIndex();
	} catch (error) {
		indexError = (error as Error).message;
	}
	const managedHint = ctx.managed ? `Upgrade dsh through ${ctx.managed} instead.` : undefined;
	const home = dshHome();
	const bundles = installedBundles(ctx.root);

	// Selection: the stored selection and what a plain launch resolves it to now.
	const stored = readSelection(home, !!ctx.managed);
	const resolved: ResolvedSelection | undefined = stored.kind === "invalid" ? undefined : resolveSelection(ctx, home, stored.kind === "ok" ? stored.selection : DEFAULT_SELECTION);
	const selection = resolved
		? {
				valid: true as const,
				stored: stored.kind === "ok" ? stored.selection : null,
				label: resolved.label,
				version: resolved.version.value,
				snapshot: resolved.snapshot.value,
				addons: Object.fromEntries(Object.entries(resolved.addons).map(([n, a]) => [n, a.value])),
			}
		: { valid: false as const, error: `cannot read the selection ${selectionPath(home)} (${(stored as { reason: string }).reason}); run \`dsh select --use latest\`` };

	// The effective version (launch options, else the selection) decides the slot, target and addon default.
	let meta: BundleMeta;
	try {
		meta = effectiveBundle(ctx);
	} catch {
		meta = resolved?.bundle ?? ctx.meta;
	}
	const target = meta.target;

	const latest = latestOf(bundles, ctx.managed ? null : ctx.channel)?.version;
	const installed = bundles
		.filter((b) => !opts.channel || b.channel === opts.channel)
		.map((b) => ({
			version: b.version,
			channel: b.channel,
			slot: b.addons?.office?.slot ?? null,
			selected: b.version === resolved?.version.value,
			latest: b.version === latest,
			inUse: guardInUse(join(ctx.root, "bundles", b.version, USAGE_GUARD)),
		}));

	const channels = (opts.channel ? [opts.channel] : [ctx.channel, ...CHANNELS.filter((c) => c !== ctx.channel)]).map((channel) => {
		const newest = index ? newestFor(index, channel, target) : undefined;
		const current = channel === ctx.channel;
		const isInstalled = !!newest && bundles.some((b) => b.version === newest.version);
		const hint = !newest || isInstalled ? undefined : (managedHint ?? (current ? "dsh update" : `dsh update --channel ${channel}`));
		return { channel, current, newest: newest?.version ?? null, installed: isInstalled, hint: hint ?? null };
	});

	const addons = ADDON_NAMES.filter((n) => !opts.addon || n === opts.addon).map((name) => {
		const table = meta.addons?.[name] ?? { slot: null, pinned: null, known: [] };
		const have = installedAddons(ctx.root, name).map((a) => ({ version: a.version, slot: a.slot, inSlot: sameSlot(a.slot, table.slot) }));
		const def = defaultVersion(table, index);
		const hint = def && !have.some((a) => a.version === def) ? (managedHint ?? `dsh install --addon ${name}`) : null;
		const versions = opts.addon
			? candidates(table, index).map((c) => ({
					version: c.version,
					tag: c.tag,
					slot: c.slot,
					inSlot: c.inSlot,
					source: c.source,
					conflict: c.conflict,
					installed: have.some((a) => a.version === c.version),
					default: def === c.version,
					pinned: table.pinned === c.version,
				}))
			: undefined;
		return { name, slot: table.slot, pinned: table.pinned, default: def, installed: have, hint, ...(versions ? { versions } : {}) };
	});

	const data = {
		selection,
		dsh: { version: ctx.running, effective: meta.version, channel: ctx.channel, target, slot: meta.addons?.office?.slot ?? null, installed },
		channels,
		addons,
		managed: ctx.managed ?? null,
		index: indexError ? { ok: false, error: indexError } : { ok: true },
	};
	if (opts.json) {
		ctx.out(JSON.stringify(data, null, 2));
		return;
	}
	if (indexError) ctx.err(`warning: ${indexError}; showing installed and embedded data only`);
	if (resolved) {
		ctx.out(`selection: ${resolved.label}`);
		ctx.out(`  version:  ${resolved.version.line}`);
		ctx.out(`  snapshot: ${resolved.snapshot.line}`);
		for (const [name, a] of Object.entries(resolved.addons)) ctx.out(`  ${`${name}:`.padEnd(9)} ${a.line}`);
	} else ctx.out(`selection: ${(selection as { error: string }).error}`);
	ctx.out("");
	ctx.out(`dsh (channel ${ctx.channel}, ${target})`);
	const rows: string[][] = installed.map((b) => {
		const marks = [b.selected && "selected", b.latest && "latest", b.inUse && "in use"].filter(Boolean).join(", ");
		return [`  ${b.version}`, b.channel, `slot ${slotLabel(b.slot)}`, marks ? `[${marks}]` : ""];
	});
	if (!rows.length) rows.push([`  none installed${opts.channel ? ` on the ${opts.channel} channel` : ""}`]);
	printTable(ctx, rows);
	printTable(
		ctx,
		channels.map((c) => [`  ${c.channel}${c.current ? " *" : ""}`, `newest ${c.newest ?? (index ? "none" : "unknown")}`, c.installed ? "installed" : "", c.hint ?? ""]),
	);
	for (const a of addons) {
		ctx.out("");
		const have = a.installed.length ? a.installed.map((i) => `${i.version}${i.inSlot ? "" : " (out of slot)"}`).join(", ") : "not installed";
		printTable(ctx, [
			[`addon ${a.name}`, have, `default ${a.default ?? "none"}`, `slot ${slotLabel(a.slot)}`],
			...(a.hint ? [["", "", "", a.hint]] : []),
		]);
		if (a.versions) {
			const vrows = [["  version", "slot", "source", "markers"]];
			for (const v of a.versions) {
				const markers = [v.installed && "installed", v.default && "default", v.pinned && "pinned", v.conflict && "SHA-256 CONFLICT"].filter(Boolean).join(", ");
				vrows.push([`  ${v.version}`, v.inSlot ? "in slot" : `out of slot ${slotLabel(v.slot)} (needs --force)`, v.source, markers]);
			}
			printTable(ctx, vrows);
		}
	}
	if (managedHint) {
		ctx.out("");
		ctx.out(`This dsh installation is managed by ${ctx.managed}.`);
	}
}

function printTable(ctx: Context, rows: string[][]) {
	const cols = Math.max(...rows.map((r) => r.length));
	const widths = Array.from({ length: cols }, (_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
	for (const r of rows) ctx.out(r.map((cell, i) => cell.padEnd(i === r.length - 1 ? 0 : widths[i]!)).join("  ").trimEnd());
}
