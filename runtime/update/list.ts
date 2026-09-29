// `dsh list` (self-update spec "Listing versions"): read-only. No lock, no download, no file change; the
// only network request is the release index, and its failure degrades to local and embedded data.
import { ADDON_NAMES, type AddonName, type Channel, CHANNELS, installedAddons, sameSlot, slotLabel } from "../layout.ts";
import { candidates, defaultVersion } from "./addon-resolve.ts";
import { activeMeta, type Context } from "./context.ts";
import { fetchIndex, isNewer, newestFor, type ReleaseIndex } from "./index-client.ts";

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
	const meta = activeMeta(ctx);
	const target = meta.target;

	const channels = (opts.channel ? [opts.channel] : [ctx.channel, ...CHANNELS.filter((c) => c !== ctx.channel)]).map((channel) => {
		const newest = index ? newestFor(index, channel, target) : undefined;
		const current = channel === ctx.channel;
		const newer = !!newest && (current ? isNewer(index!, channel, meta.version, newest) : newest.version !== meta.version);
		const hint = !newer ? undefined : (managedHint ?? (current ? "dsh update" : `dsh update --channel ${channel}`));
		return { channel, current, newest: newest?.version ?? null, newer, hint: hint ?? null };
	});

	const addons = ADDON_NAMES.filter((n) => !opts.addon || n === opts.addon).map((name) => {
		const table = meta.addons?.[name] ?? { slot: null, pinned: null, known: [] };
		const installed = installedAddons(ctx.root, name).map((a) => ({ version: a.version, slot: a.slot, inSlot: sameSlot(a.slot, table.slot) }));
		const def = defaultVersion(table, index);
		const hint = def && !installed.some((a) => a.version === def) ? (managedHint ?? `dsh install --addon ${name}`) : null;
		const versions = opts.addon
			? candidates(table, index).map((c) => ({
					version: c.version,
					tag: c.tag,
					slot: c.slot,
					inSlot: c.inSlot,
					source: c.source,
					conflict: c.conflict,
					installed: installed.some((a) => a.version === c.version),
					default: def === c.version,
					pinned: table.pinned === c.version,
				}))
			: undefined;
		return {
			name,
			slot: table.slot,
			pinned: table.pinned,
			default: def,
			installed,
			hint,
			...(versions ? { versions } : {}),
		};
	});

	const data = {
		dsh: { version: ctx.running, active: meta.version, channel: ctx.channel, target, slot: meta.addons?.office?.slot ?? null },
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
	const rows: string[][] = [["dsh", `${data.dsh.active}${ctx.running !== meta.version ? ` (running ${ctx.running})` : ""}`, `channel ${ctx.channel}`, target]];
	for (const c of channels) rows.push([`  ${c.channel}${c.current ? " *" : ""}`, c.newest ?? (index ? "none" : "unknown"), c.newer ? "newer" : c.newest ? "" : "", c.hint ?? ""]);
	printTable(ctx, rows);
	for (const a of addons) {
		ctx.out("");
		const installed = a.installed.length ? a.installed.map((i) => `${i.version}${i.inSlot ? "" : " (out of slot)"}`).join(", ") : "not installed";
		printTable(ctx, [
			[`addon ${a.name}`, installed, `default ${a.default ?? "none"}`, `slot ${slotLabel(a.slot)}`],
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
	const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
	for (const r of rows) ctx.out(r.map((cell, i) => cell.padEnd(i === r.length - 1 ? 0 : widths[i]!)).join("  ").trimEnd());
}
