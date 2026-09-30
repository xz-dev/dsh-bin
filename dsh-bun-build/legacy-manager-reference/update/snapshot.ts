// `dsh snapshot new|remove|list` (plugin-snapshots "Snapshot commands"). Works in managed installations.
// dsh-bin copies and removes runtimes; it never repairs them.
import { dshHome, installedBundles } from "../layout.ts";
import { readSelection } from "../selection.ts";
import { createdLine } from "../snapshot/auto.ts";
import { createSnapshot, listSnapshots, newestOf, removeSnapshots, requireSnapshot, type SnapshotMeta, snapshotInUse } from "../snapshot/store.ts";
import { type Context, UserError } from "./context.ts";
import { effectiveBundle } from "./select.ts";

export type SnapshotCommand = { action: "new"; target?: string; name?: string; empty: boolean } | { action: "remove"; ids: string[] } | { action: "list"; json: boolean };

const onWait = () => process.stderr.write("dsh: waiting for another dsh snapshot operation...\n");

export function snapshot(ctx: Context, cmd: SnapshotCommand) {
	if (cmd.action === "new") return newSnapshot(ctx, cmd);
	if (cmd.action === "remove") return remove(ctx, cmd.ids);
	return list(ctx, cmd.json);
}

function newSnapshot(ctx: Context, cmd: { target?: string; name?: string; empty: boolean }) {
	const home = dshHome();
	const meta = effectiveBundle(ctx);
	// Validate the named target before taking the lock, for a plain diagnostic; `source` re-reads it.
	if (cmd.target) requireSnapshot(listSnapshots(home), cmd.target);
	const { snapshot: s } = createSnapshot(home, {
		version: meta.version,
		order: meta,
		reason: "user",
		...(cmd.name !== undefined ? { alias: cmd.name } : {}),
		source: (list) => {
			if (cmd.empty) return null;
			if (cmd.target) return requireSnapshot(list, cmd.target);
			const newest = newestOf(list, meta.version);
			if (!newest) throw new UserError(`dsh ${meta.version} has no snapshot to copy`, ["Run `dsh snapshot new --empty` for an empty one, or name one with `--target <id>`."]);
			return newest;
		},
		onWait,
	});
	ctx.out(createdLine(s));
}

function remove(ctx: Context, ids: readonly string[]) {
	const home = dshHome();
	const all = listSnapshots(home);
	const targets = [...new Set(ids.map((id) => requireSnapshot(all, id).id))];
	const stored = readSelection(home, !!ctx.managed);
	const selected = stored.kind === "ok" ? stored.selection.snapshot : null;
	if (selected && targets.includes(selected)) {
		throw new UserError(`snapshot ${selected} is named by the selection`, ["Run `dsh select` with another --snapshot (or none) first."]);
	}
	const r = removeSnapshots(home, targets);
	if (r !== "removed") throw new UserError(`snapshot ${r.busy.join(", ")} is in use by a running dsh process; nothing was removed`, ["Close the dsh sessions using it and try again."]);
	for (const id of targets) ctx.out(`Removed snapshot ${id}.`);
}

type Row = SnapshotMeta & { newest: boolean; selected: boolean; inUse: boolean; installed: boolean };

function list(ctx: Context, json: boolean) {
	const home = dshHome();
	const all = listSnapshots(home);
	const installed = new Set(installedBundles(ctx.root).map((b) => b.version));
	const stored = readSelection(home, !!ctx.managed);
	const selected = stored.kind === "ok" ? stored.selection.snapshot : null;
	const rows: Row[] = all.map((s) => ({
		...s,
		newest: newestOf(all, s.version)?.id === s.id,
		selected: s.id === selected,
		inUse: snapshotInUse(home, s.id),
		installed: installed.has(s.version),
	}));
	if (json) {
		const out = rows.map(({ id, alias, version, createdAt, source, reason, newest, selected, inUse, installed }) => ({
			id,
			alias: alias ?? null,
			version,
			createdAt,
			source,
			reason,
			newest,
			selected,
			inUse,
			bundleInstalled: installed,
		}));
		ctx.out(JSON.stringify({ snapshots: out }, null, 2));
		return;
	}
	if (!rows.length) {
		ctx.out("No snapshots yet (one is created when a dsh version is installed or first started).");
		return;
	}
	for (const r of rows) {
		const marks = [r.newest && "newest", r.selected && "selected", r.inUse && "in use", !r.installed && "bundle not installed"].filter(Boolean);
		const name = r.alias ? ` (${r.alias})` : "";
		ctx.out(`${r.id}${name}  ${r.createdAt}  ${r.source === "empty" ? "empty" : `from ${r.source}`}  ${r.reason}${marks.length ? `  [${marks.join(", ")}]` : ""}`);
	}
}
