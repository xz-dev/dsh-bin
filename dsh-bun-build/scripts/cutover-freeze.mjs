// DL-CUTOVER: read-only release inventory. The real freeze runs only after old publishers are paused.
// usage: bun scripts/cutover-freeze.mjs <out.json>; env GITHUB_REPOSITORY, GH_TOKEN/GITHUB_TOKEN
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export function releaseFamily(tag) {
	if (typeof tag !== "string") return "unknown";
	if (/^(manager-v|runtime-v|runtime-live-|addon-office-v)/.test(tag)) return "new";
	if (tag.startsWith("dsh-v")) return "release";
	if (tag.startsWith("dsh-live-")) return "live";
	if (tag.startsWith("dsh-addon-")) return "addon";
	return "unknown";
}

const canonical = (value) => JSON.stringify(value, (_, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]])) : v);
export const inventorySha256 = ({ sha256, ...inventory }) => createHash("sha256").update(canonical(inventory)).digest("hex");
export function githubContext(env = process.env) {
	const repository = env.GITHUB_REPOSITORY;
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) throw new Error("GITHUB_REPOSITORY must be owner/name");
	const token = env.GITHUB_TOKEN || env.GH_TOKEN;
	if (!token) throw new Error("GH_TOKEN or GITHUB_TOKEN is required (drafts must be included)");
	return { repository, api: `https://api.github.com/repos/${repository}`, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "dsh-bin-cutover", "X-GitHub-Api-Version": "2022-11-28" } };
}

export function assertFileIdentity(fd, path) {
	const held = fstatSync(fd), named = lstatSync(path);
	if (!held.isFile() || !named.isFile() || held.nlink !== 1 || named.nlink !== 1 || held.dev !== named.dev || held.ino !== named.ino) throw new Error(`file identity changed or not a single regular file: ${path}`);
}

export function readFrozen(path) {
	const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		assertFileIdentity(fd, path);
		return JSON.parse(readFileSync(fd, "utf8"));
	} finally { closeSync(fd); }
}

export async function freezeReleases(env = process.env, fetchImpl = fetch) {
	const { repository, api, headers } = githubContext(env);
	const get = async (path) => {
		const r = await fetchImpl(`${api}${path}`, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
		if (!r.ok) throw new Error(`GitHub GET ${path}: HTTP ${r.status}`);
		return r.json();
	};
	const permissions = (await get(""))?.permissions;
	if (!["push", "admin", "maintain"].some((level) => permissions?.[level] === true)) throw new Error("push permission required to include draft releases; refusing incomplete freeze");
	const pages = async (path) => {
		const all = [];
		for (let page = 1; ; page++) {
			const values = await get(`${path}?per_page=100&page=${page}`);
			if (!Array.isArray(values)) throw new Error(`GitHub ${path}: expected array`);
			all.push(...values);
			if (values.length < 100) return all;
		}
	};
	const releases = [], protectedReleases = [], unknown = [], seen = new Set();
	for (const r of await pages("/releases")) {
		if (!Number.isSafeInteger(r.id) || r.id <= 0 || seen.has(r.id) || typeof r.tag_name !== "string") throw new Error("invalid or duplicate release identity; freeze again after publishers stop");
		seen.add(r.id);
		const family = releaseFamily(r.tag_name);
		const record = { id: r.id, tag: r.tag_name, name: r.name, draft: Boolean(r.draft), prerelease: Boolean(r.prerelease), immutable: Boolean(r.immutable), html_url: r.html_url };
		if (family === "new") { protectedReleases.push(record); continue; }
		if (family === "unknown") { unknown.push(record); continue; }
		const assetIds = new Set();
		record.assets = (await pages(`/releases/${r.id}/assets`)).map((a) => {
			if (!Number.isSafeInteger(a.id) || a.id <= 0 || assetIds.has(a.id) || !Number.isSafeInteger(a.size) || a.size < 0 || typeof a.name !== "string" || typeof a.browser_download_url !== "string") throw new Error(`invalid or duplicate asset for release ${r.id}`);
			assetIds.add(a.id);
			return { id: a.id, name: a.name, size: a.size, browser_download_url: a.browser_download_url, ...(a.digest ? { digest: a.digest } : {}) };
		}).sort((a, b) => a.id - b.id);
		releases.push({ ...record, family });
	}
	for (const list of [releases, protectedReleases, unknown]) list.sort((a, b) => a.id - b.id);
	const discovery = [];
	for (const [ref, path] of [["releases", "index.json"], ["scoop", "bucket/dsh.json"], ["scoop", "bucket/dsh-live.json"], ["scoop", "bucket/dsh-office.json"], ["main", "README.md"], ["main", "README.zh-CN.md"], ["main", "install.sh"]]) {
		const url = `${api}/contents/${path}?ref=${ref}`;
		const r = await fetchImpl(url, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
		if (r.status === 404) { discovery.push({ ref, path, status: "absent" }); continue; }
		if (!r.ok) throw new Error(`GitHub discovery ${ref}:${path}: HTTP ${r.status}`);
		const file = await r.json();
		if (file.encoding !== "base64" || typeof file.content !== "string" || typeof file.sha !== "string") throw new Error(`GitHub discovery ${ref}:${path}: expected file content`);
		const content = Buffer.from(file.content, "base64").toString("utf8");
		discovery.push({ ref, path, status: "present", gitBlob: file.sha, html_url: file.html_url, content, urls: [...new Set(content.match(/https?:\/\/[^\s"'<>`)]+/g) ?? [])].sort() });
	}
	const assets = releases.flatMap((r) => r.assets);
	const inventory = { schema: 1, repository, releases, protected: protectedReleases, unknown, discovery, counts: { releases: releases.length, release: releases.filter((r) => r.family === "release").length, live: releases.filter((r) => r.family === "live").length, addon: releases.filter((r) => r.family === "addon").length, assets: assets.length, bytes: assets.reduce((n, a) => n + a.size, 0), protected: protectedReleases.length, unknown: unknown.length } };
	return { ...inventory, sha256: inventorySha256(inventory) };
}

if (import.meta.main) {
	let fd;
	try {
		const [out, ...extra] = process.argv.slice(2);
		if (!out || extra.length) throw new Error("usage: cutover-freeze.mjs <out.json>");
		githubContext();
		const inventory = await freezeReleases();
		// This is a new output: O_EXCL atomically creates/pins it after GETs; an existing name is untouched.
		fd = openSync(resolve(out), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
		assertFileIdentity(fd, resolve(out));
		writeFileSync(fd, `${JSON.stringify(inventory, null, 2)}\n`);
		console.log(JSON.stringify({ repository: inventory.repository, sha256: inventory.sha256, counts: inventory.counts, unknown: inventory.unknown.map((r) => ({ id: r.id, tag: r.tag })) }));
	} catch (e) { console.error(`cutover-freeze: ${e.message}`); process.exitCode = 1; }
	finally { if (fd !== undefined) closeSync(fd); }
}
