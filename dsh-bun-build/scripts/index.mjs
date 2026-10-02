// Runtime-index v1 writer: local-build manifest in, append-only runtime entries out.
import { addonDistribution, distribution } from "./versioning.mjs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const emptyIndex = () => ({ schema: 1, channels: { release: [], live: [] }, addons: { office: [] } });
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const positive = (v) => Number.isSafeInteger(v) && v > 0;
const name = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(v);

export function parseIndex(text) {
	const index = JSON.parse(text);
	if (!object(index) || index.schema !== 1 || !object(index.channels) || !object(index.addons) || !Array.isArray(index.addons.office)) throw new Error("unsupported runtime index (expected schema 1)");
	for (const channel of ["release", "live"]) {
		const list = index.channels[channel];
		if (!Array.isArray(list)) throw new Error(`runtime index ${channel} must be a list`);
		let seq = 0;
		const tags = new Set();
		for (const entry of list) {
			if (!object(entry) || entry.kind !== "dsh-runtime" || "launcherProtocol" in entry || entry.channel !== channel || !name(entry.id) || entry.tag !== `${channel === "release" ? "runtime-v" : "runtime-"}${entry.id}` || !positive(entry.seq) || entry.seq <= seq || tags.has(entry.tag)) throw new Error(`invalid runtime entry in ${channel}`);
			if (!object(entry.upstream) || typeof entry.upstream.commit !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(entry.upstream.commitTime) || typeof entry.upstream.version !== "string" || !positive(entry.run) || !positive(entry.attempt) || !positive(entry.launchProtocol) || typeof entry.builderCommit !== "string" || !object(entry.addons?.office)) throw new Error(`invalid runtime metadata: ${entry.tag}`);
			const identity = distribution({ channel, upstreamVersion: entry.upstream.version, upstreamCommit: entry.upstream.commit, run: entry.run, attempt: entry.attempt, builderCommit: entry.builderCommit });
			if (identity.id !== entry.id || identity.tag !== entry.tag) throw new Error(`runtime identity differs from build metadata: ${entry.tag}`);
			if (!object(entry.assets) || Object.keys(entry.assets).length === 0) throw new Error(`missing runtime assets: ${entry.tag}`);
			for (const asset of Object.values(entry.assets)) if (!object(asset) || !name(asset.name) || !positive(asset.size) || !/^[0-9a-f]{64}$/.test(asset.sha256)) throw new Error(`invalid runtime asset: ${entry.tag}`);
			seq = entry.seq;
			tags.add(entry.tag);
		}
	}
	let addonSeq = 0;
	for (const e of index.addons.office) {
		if (!object(e) || !/^addon-office-v[0-9A-Za-z.+-]+$/.test(e.tag ?? "") || e.tag !== `addon-office-v${e.version}` || !positive(e.seq) || e.seq <= addonSeq || !/^[0-9a-f]{40}$/.test(e.slot?.commit ?? "") || typeof e.slot?.kitVersion !== "string" || !object(e.assets) || !Object.keys(e.assets).length) throw new Error("invalid new-format office addon index entry");
		for (const a of Object.values(e.assets)) if (!object(a) || !name(a.name) || !positive(a.size) || !/^[0-9a-f]{64}$/.test(a.sha256)) throw new Error(`invalid office addon asset: ${e.tag}`);
		addonSeq = e.seq;
	}
	return index;
}

export const readIndex = (path) => existsSync(path) ? parseIndex(readFileSync(path, "utf8")) : emptyIndex();
export const serialize = (index) => `${JSON.stringify(parseIndex(JSON.stringify(index)), null, 2)}\n`;

/** Identical reruns are no-ops; changed metadata or assets under an existing tag are rejected. */
export function appendBundle(index, manifest) {
	const list = index.channels[manifest.channel];
	if (!list || manifest.kind !== "dsh-runtime" || "launcherProtocol" in manifest) throw new Error("expected a runtime manifest and release|live channel");
	const entry = {
		kind: manifest.kind, tag: manifest.tag, id: manifest.id, channel: manifest.channel,
		upstream: manifest.upstream, run: manifest.run, attempt: manifest.attempt,
		launchProtocol: manifest.launchProtocol, builderCommit: manifest.builderCommit,
		addons: manifest.addons,
		assets: Object.fromEntries(Object.entries(manifest.targets).map(([target, a]) => [target, { name: a.file, size: a.size, sha256: a.sha256 }])),
		seq: Math.max(0, ...list.map((e) => e.seq)) + 1,
	};
	const fields = ["kind", "tag", "id", "channel", "upstream", "run", "attempt", "launchProtocol", "builderCommit", "addons", "assets"];
	const existing = list.find((e) => e.tag === entry.tag);
	if (existing) {
		const content = (e) => JSON.stringify(Object.fromEntries(fields.map((key) => [key, e[key]])));
		if (content(existing) === content(entry)) return existing;
		throw new Error(`index already lists ${entry.tag} with different content; entries are never modified`);
	}
	parseIndex(JSON.stringify({ ...index, channels: { ...index.channels, [manifest.channel]: [...list, entry] } }));
	list.push(entry);
	return entry;
}

export function appendAddon(index, manifest) {
	const identity = addonDistribution({ kitVersion: manifest.slot?.kitVersion, run: manifest.run, attempt: manifest.attempt, builderCommit: manifest.builderCommit });
	if (identity.tag !== manifest.tag || identity.version !== manifest.version) throw new Error("addon manifest identity mismatch");
	const list = index.addons.office;
	if (list.some((entry) => entry.tag === manifest.tag)) throw new Error(`index already lists ${manifest.tag}; addon entries are never modified`);
	const entry = {
		tag: manifest.tag, version: manifest.version, slot: manifest.slot,
		run: manifest.run, attempt: manifest.attempt, builderCommit: manifest.builderCommit,
		assets: Object.fromEntries(Object.entries(manifest.assets).map(([platform, a]) => [platform, { name: a.file, size: a.size, sha256: a.sha256 }])),
		seq: Math.max(0, ...list.map((e) => e.seq)) + 1,
	};
	parseIndex(JSON.stringify({ ...index, addons: { ...index.addons, office: [...list, entry] } }));
	list.push(entry);
	return entry;
}

export function assertAppendOnly(prev, next) {
	for (const [before, after] of [[prev.channels.release, next.channels.release], [prev.channels.live, next.channels.live], [prev.addons.office, next.addons.office]]) {
		before.forEach((entry, n) => { if (JSON.stringify(entry) !== JSON.stringify(after[n])) throw new Error(`index entry ${entry.tag} was modified or removed`); });
	}
}

// Independent runtime publisher writes only runtime-index.json; no legacy index conversion.
if (import.meta.main) {
	const [cmd, path, manifestPath] = process.argv.slice(2);
	if (cmd === "check" && path) {
		readIndex(path);
		console.log(`${path}: valid`);
	} else if (["append-bundle", "append-addon"].includes(cmd) && path && manifestPath) {
		const prev = readIndex(path), next = structuredClone(prev);
		const entry = (cmd === "append-addon" ? appendAddon : appendBundle)(next, JSON.parse(readFileSync(manifestPath, "utf8")));
		assertAppendOnly(prev, next);
		writeFileSync(path, serialize(next));
		console.log(`${entry.tag}: seq ${entry.seq}`);
	} else {
		console.error("usage: index.mjs append-bundle|append-addon <runtime-index.json> <manifest.json> | check <runtime-index.json>");
		process.exit(2);
	}
}
