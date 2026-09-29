// The `releases` branch index.json (release-distribution spec "Release index"): append-only, one ordered
// list per channel plus `addons.office`, each entry with a per-list sequence. Used by the publish
// workflows and local end-to-end runs; validated with the updater's own schema check.
// usage:
//   bun scripts/index.mjs append-bundle <index.json> <release-manifest.json> [--published-at iso]
//   bun scripts/index.mjs append-addon  <index.json> <addon-manifest.json>   [--published-at iso]
//   bun scripts/index.mjs check <index.json>
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseIndex } from "../runtime/update/index-client.ts";

export const emptyIndex = () => ({ schemaVersion: 2, channels: { release: [], live: [] }, addons: { office: [] } });

export function readIndex(path) {
	return existsSync(path) ? parseIndex(readFileSync(path, "utf8")) : emptyIndex();
}

const nextSeq = (list) => list.reduce((m, e) => Math.max(m, e.seq), 0) + 1;
const sameAssets = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/**
 * Append a bundle release. `manifest` is `release-manifest.json`: {tag, version, channel,
 * upstream: {commit, commitTime, tag?, version}, run, attempt, launcherProtocol, launcherCommit, addons: {office: {slot, pinned}}, targets: {<target>: {file, size, sha256}}}.
 * Re-appending an identical tag is a no-op (idempotent reruns); a different one with the same tag fails.
 */
export function appendBundle(index, manifest, publishedAt = new Date().toISOString()) {
	const list = index.channels[manifest.channel];
	if (!list) throw new Error(`unknown channel ${manifest.channel}`);
	const assets = Object.fromEntries(Object.entries(manifest.targets).map(([t, a]) => [t, { name: a.file, size: a.size, sha256: a.sha256 }]));
	const existing = list.find((e) => e.tag === manifest.tag);
	if (existing) {
		if (existing.version === manifest.version && sameAssets(existing.assets, assets)) return existing;
		throw new Error(`index already lists ${manifest.tag} with different content; entries are never modified`);
	}
	const entry = {
		seq: nextSeq(list),
		tag: manifest.tag,
		version: manifest.version,
		channel: manifest.channel,
		upstream: manifest.upstream,
		run: manifest.run,
		attempt: manifest.attempt,
		launcherProtocol: manifest.launcherProtocol,
		launcherCommit: manifest.launcherCommit,
		publishedAt,
		addons: manifest.addons ?? {},
		assets,
	};
	list.push(entry);
	return entry;
}

/** Append an addon release. `manifest`: {tag, version, slot, assets: {<platform>: {file, size, sha256}}}. */
export function appendAddon(index, manifest, publishedAt = new Date().toISOString()) {
	const list = index.addons.office;
	const assets = Object.fromEntries(Object.entries(manifest.assets).map(([p, a]) => [p, { name: a.file, size: a.size, sha256: a.sha256 }]));
	const existing = list.find((e) => e.tag === manifest.tag);
	if (existing) {
		if (existing.version === manifest.version && sameAssets(existing.assets, assets)) return existing;
		throw new Error(`index already lists ${manifest.tag} with different content; entries are never modified`);
	}
	const entry = { seq: nextSeq(list), tag: manifest.tag, version: manifest.version, slot: manifest.slot, publishedAt, assets };
	list.push(entry);
	return entry;
}

/** Fail unless `next` keeps every entry of `prev` unchanged and in order (the append-only rule). */
export function assertAppendOnly(prev, next) {
	const lists = (i) => ({ release: i.channels.release, live: i.channels.live, office: i.addons.office });
	const a = lists(prev);
	const b = lists(next);
	for (const key of Object.keys(a)) {
		a[key].forEach((e, n) => {
			if (JSON.stringify(e) !== JSON.stringify(b[key][n])) throw new Error(`index ${key}[${n}] (${e.tag}) was modified or removed`);
		});
	}
}

export const serialize = (index) => `${JSON.stringify(parseIndex(JSON.stringify(index)), null, 2)}\n`;

if (import.meta.main) {
	const [cmd, path, manifestPath, ...rest] = process.argv.slice(2);
	// DSH_BIN_PUBLISHED_AT: a candidate addon's entry is appended at build, acceptance and publication
	// time; one fixed timestamp keeps those entries (and the embedded table) identical.
	const at = rest.includes("--published-at") ? rest[rest.indexOf("--published-at") + 1] : process.env.DSH_BIN_PUBLISHED_AT || undefined;
	if (cmd === "check" && path) {
		readIndex(path);
		console.log(`${path}: valid`);
	} else if ((cmd === "append-bundle" || cmd === "append-addon") && path && manifestPath) {
		const prev = readIndex(path);
		const next = structuredClone(prev);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		const entry = cmd === "append-bundle" ? appendBundle(next, manifest, at) : appendAddon(next, manifest, at);
		assertAppendOnly(prev, next);
		writeFileSync(path, serialize(next));
		console.log(`${entry.tag}: seq ${entry.seq}`);
	} else {
		console.error("usage: index.mjs append-bundle|append-addon <index.json> <manifest.json> [--published-at iso] | check <index.json>");
		process.exit(2);
	}
}
