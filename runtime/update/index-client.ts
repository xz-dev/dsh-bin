// Release discovery (self-update spec "Release discovery via the index branch"): the only network inputs
// are the `releases` branch index.json on raw.githubusercontent.com and exact-tag release downloads.
// Never the GitHub REST/GraphQL API, the "latest" redirect, or a package registry.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { AddonRelease, AssetRef, Channel, Slot } from "../layout.ts";
import { UserError } from "./context.ts";

export const INDEX_URL = "https://raw.githubusercontent.com/xz-dev/dsh-bin/releases/index.json";
export const DOWNLOAD_BASE = "https://github.com/xz-dev/dsh-bin/releases/download";

export type BundleEntry = {
	seq: number;
	tag: string;
	version: string;
	channel: Channel;
	upstream: { commit: string; tag?: string };
	launcherCommit?: string;
	publishedAt?: string;
	addons?: { office?: { slot: Slot | null; pinned: string | null } };
	assets: Record<string, AssetRef>;
};
export type ReleaseIndex = {
	schemaVersion: 1;
	channels: Record<Channel, BundleEntry[]>;
	addons: { office: AddonRelease[] };
};

/**
 * Endpoints. A local fixture origin is honoured only in test mode (`DSH_BIN_TEST=1` together with
 * `DSH_BIN_TEST_ORIGIN`), so a stray variable cannot redirect a real installation.
 */
export function endpoints(env = process.env) {
	if (env.DSH_BIN_TEST === "1" && env.DSH_BIN_TEST_ORIGIN) {
		const origin = env.DSH_BIN_TEST_ORIGIN.replace(/\/+$/, "");
		return { index: `${origin}/index.json`, download: `${origin}/download` };
	}
	return { index: INDEX_URL, download: DOWNLOAD_BASE };
}

export const assetUrl = (tag: string, name: string, env = process.env) =>
	`${endpoints(env).download}/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;

const SHA256 = /^[0-9a-f]{64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function checkAssets(where: string, assets: unknown) {
	if (!isObj(assets)) throw new Error(`${where}: assets must be an object`);
	for (const [key, a] of Object.entries(assets)) {
		if (!isObj(a) || typeof a.name !== "string" || !/^[A-Za-z0-9._-]+$/.test(a.name) || typeof a.size !== "number" || !SHA256.test(String(a.sha256))) {
			throw new Error(`${where}: invalid asset ${key}`);
		}
	}
}

function checkSlot(where: string, slot: unknown, nullable: boolean) {
	if (slot === null && nullable) return;
	if (!isObj(slot) || typeof slot.commit !== "string" || typeof slot.kitVersion !== "string") throw new Error(`${where}: invalid slot`);
}

/** Validate the index schema; throws with a diagnostic naming the first problem. */
export function parseIndex(text: string): ReleaseIndex {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		throw new Error("index is not valid JSON");
	}
	if (!isObj(data)) throw new Error("index is not an object");
	if (data.schemaVersion !== 1) throw new Error(`unsupported index schemaVersion ${String(data.schemaVersion)} (expected 1)`);
	if (!isObj(data.channels)) throw new Error("index has no channels");
	for (const channel of ["release", "live"] as const) {
		const list = data.channels[channel] ?? [];
		if (!Array.isArray(list)) throw new Error(`index channel ${channel} is not a list`);
		for (const [i, e] of list.entries()) {
			const where = `index ${channel}[${i}]`;
			if (!isObj(e) || !Number.isInteger(e.seq) || typeof e.tag !== "string" || typeof e.version !== "string") throw new Error(`${where}: invalid entry`);
			if (e.channel !== channel) throw new Error(`${where}: channel ${String(e.channel)} is listed under ${channel}`);
			checkAssets(where, e.assets);
		}
		data.channels[channel] = list;
	}
	const addons = isObj(data.addons) ? data.addons : {};
	const office = addons.office ?? [];
	if (!Array.isArray(office)) throw new Error("index addons.office is not a list");
	for (const [i, e] of office.entries()) {
		const where = `index addons.office[${i}]`;
		if (!isObj(e) || !Number.isInteger(e.seq) || typeof e.tag !== "string" || typeof e.version !== "string") throw new Error(`${where}: invalid entry`);
		checkSlot(where, e.slot, false);
		checkAssets(where, e.assets);
	}
	data.addons = { ...addons, office };
	return data as ReleaseIndex;
}

export async function fetchIndex(env = process.env): Promise<ReleaseIndex> {
	const url = endpoints(env).index;
	let res: Response;
	try {
		res = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { "cache-control": "no-cache" } });
	} catch (error) {
		throw new UserError(`could not read the release index ${url}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!res.ok) throw new UserError(`could not read the release index ${url}: HTTP ${res.status}`);
	try {
		return parseIndex(await res.text());
	} catch (error) {
		throw new UserError(`invalid release index ${url}: ${(error as Error).message}`);
	}
}

/** Newest entry (highest seq) of `channel` that has an asset for `target`. */
export function newestFor(index: ReleaseIndex, channel: Channel, target: string): BundleEntry | undefined {
	return index.channels[channel].filter((e) => e.assets[target]).reduce<BundleEntry | undefined>((a, e) => (!a || e.seq > a.seq ? e : a), undefined);
}

/** Whether `entry` is newer than the running version within one channel (index sequence order). */
export function isNewer(index: ReleaseIndex, channel: Channel, running: string, entry: BundleEntry): boolean {
	if (entry.version === running) return false;
	const current = index.channels[channel].find((e) => e.version === running);
	return !current || entry.seq > current.seq;
}

export async function sha256File(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
	return hash.digest("hex");
}

/** Download an exact-tag asset to `dest` and check its size and SHA-256. */
export async function downloadAsset(tag: string, asset: AssetRef, dest: string, log: (line: string) => void, env = process.env) {
	const url = assetUrl(tag, asset.name, env);
	log(`Downloading ${asset.name} (${(asset.size / 1048576).toFixed(1)} MiB) from ${tag}...`);
	let res: Response;
	try {
		res = await fetch(url, { redirect: "follow" });
	} catch (error) {
		throw new UserError(`download failed: ${url}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!res.ok) throw new UserError(`download failed: ${url}: HTTP ${res.status}`);
	await Bun.write(dest, res);
	const size = Bun.file(dest).size;
	const digest = await sha256File(dest);
	if (digest !== asset.sha256 || size !== asset.size) {
		throw new UserError(`sha256 mismatch for ${asset.name}: expected ${asset.sha256} (${asset.size} bytes), got ${digest} (${size} bytes)`);
	}
}
