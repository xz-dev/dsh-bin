// DL-CUTOVER / DL-CLEANUP-BLOCKED: delete a confirmed frozen list, never a dynamically listed set.
// usage: bun scripts/cutover-delete.mjs <frozen.json> --expect-sha256 <sha> [--confirm]
// No --confirm = plan only. A new <frozen.json>.results.json records every result; existing logs are refused.
import { closeSync, constants, ftruncateSync, openSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { assertFileIdentity, githubContext, inventorySha256, readFrozen, releaseFamily } from "./cutover-freeze.mjs";

export function validateFrozen(inventory, expected) {
	if (!/^[0-9a-f]{64}$/.test(expected ?? "") || inventory.sha256 !== expected || inventorySha256(inventory) !== expected) throw new Error("frozen inventory SHA256 mismatch; no API calls made");
	if (inventory.schema !== 1 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(inventory.repository ?? "") || !Array.isArray(inventory.releases)) throw new Error("invalid frozen inventory");
	const ids = new Set();
	for (const r of inventory.releases) {
		if (!Number.isSafeInteger(r.id) || r.id <= 0 || ids.has(r.id) || !["release", "live", "addon"].includes(releaseFamily(r.tag)) || !Array.isArray(r.assets)) throw new Error(`unsafe frozen release: ${r.id}/${r.tag}`);
		ids.add(r.id);
	}
}

function listedAsset(a) {
	return { id: a.id, name: a.name, size: a.size, browser_download_url: a.browser_download_url, ...(a.digest ? { digest: a.digest } : {}) };
}

export async function deleteFrozen(inventory, expected, env = process.env, fetchImpl = fetch, confirm = false, record = () => {}) {
	validateFrozen(inventory, expected);
	if (env.GITHUB_REPOSITORY && env.GITHUB_REPOSITORY !== inventory.repository) throw new Error("frozen repository differs from GITHUB_REPOSITORY");
	const result = { schema: 1, repository: inventory.repository, inventorySha256: expected, dryRun: !confirm, done: [], failed: [], notAttempted: inventory.releases.map((r) => ({ id: r.id, tag: r.tag, reason: confirm ? "not attempted" : "dry run; confirmation required" })) };
	record(result);
	if (!confirm) return result;
	const { api, headers } = githubContext({ ...env, GITHUB_REPOSITORY: inventory.repository });
	const request = (path, method) => fetchImpl(`${api}/releases/${path}`, { method, headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
	for (const frozen of inventory.releases) {
		const item = result.notAttempted.shift();
		let stop = false;
		const refused = async (response, operation) => {
			stop = [401, 403, 422].includes(response.status);
			let message;
			try { message = (await response.text()).slice(0, 2000); }
			catch (e) { message = `response body read failed: ${e.message}`; }
			stop ||= /immutable/i.test(message);
			throw new Error(`${operation}: HTTP ${response.status}${message ? `: ${message}` : ""}`);
		};
		try {
			const current = await request(frozen.id, "GET");
			if (current.status === 404) result.done.push({ id: frozen.id, tag: frozen.tag, status: "already-deleted" });
			else if (!current.ok) await refused(current, `GET release ${frozen.id}`);
			else {
				const release = await current.json();
				if (release.id !== frozen.id || release.tag_name !== frozen.tag || !["release", "live", "addon"].includes(releaseFamily(release.tag_name))) {
					stop = true;
					throw new Error(`release ${frozen.id} identity changed; refusing deletion`);
				}
				// Immutability protects individual assets/tags; whole-release DELETE is still allowed.
				// Any API refusal (401/403/422) below stops without changing protections.
				// Deleting a release also deletes its assets. Refuse additions/edits outside the confirmed list.
				const assets = [];
				for (let page = 1; ; page++) {
					const response = await request(`${frozen.id}/assets?per_page=100&page=${page}`, "GET");
					if (!response.ok) await refused(response, `GET assets for release ${frozen.id}`);
					const batch = await response.json();
					if (!Array.isArray(batch)) throw new Error(`invalid assets for release ${frozen.id}`);
					assets.push(...batch.map(listedAsset));
					if (batch.length < 100) break;
				}
				const snapshot = (items) => inventorySha256({ assets: items.map(listedAsset).sort((a, b) => a.id - b.id) });
				if (snapshot(assets) !== snapshot(frozen.assets)) { stop = true; throw new Error(`release ${frozen.id} assets changed; refusing deletion outside frozen list`); }
				const deleted = await request(frozen.id, "DELETE");
				if (deleted.status === 204 || deleted.status === 404) result.done.push({ id: frozen.id, tag: frozen.tag, status: deleted.status === 404 ? "already-deleted" : "deleted" });
				else await refused(deleted, `DELETE release ${frozen.id}`);
			}
		} catch (e) {
			result.failed.push({ id: item.id, tag: item.tag, reason: e.message });
		}
		if (stop) for (const pending of result.notAttempted) pending.reason = `stopped after release ${frozen.id}; authentication, identity or protection blocked`;
		record(result);
		if (stop) break;
	}
	return result;
}

if (import.meta.main) {
	let fd;
	try {
		const [path, ...args] = process.argv.slice(2), index = args.indexOf("--expect-sha256"), expected = args[index + 1];
		if (!path || index < 0 || !expected || args.filter((arg) => arg === "--confirm").length > 1 || args.length !== (args.includes("--confirm") ? 3 : 2) || args.some((arg, n) => n !== index + 1 && !["--expect-sha256", "--confirm"].includes(arg))) throw new Error("usage: cutover-delete.mjs <frozen.json> --expect-sha256 <sha> [--confirm]");
		const inventory = readFrozen(resolve(path));
		validateFrozen(inventory, expected);
		if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY !== inventory.repository) throw new Error("frozen repository differs from GITHUB_REPOSITORY");
		const confirm = args.includes("--confirm");
		if (confirm) githubContext({ ...process.env, GITHUB_REPOSITORY: inventory.repository });
		for (const r of inventory.releases) console.log(JSON.stringify({ action: confirm ? "delete" : "plan-only", id: r.id, tag: r.tag, html_url: r.html_url, assets: r.assets }));
		const resultPath = `${resolve(path)}.results.json`;
		// Keep one exclusive regular-file handle across network calls; never reopen/truncate by name.
		fd = openSync(resultPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
		const result = await deleteFrozen(inventory, expected, process.env, fetch, confirm, (r) => {
			assertFileIdentity(fd, resultPath);
			const bytes = Buffer.from(`${JSON.stringify(r, null, 2)}\n`);
			ftruncateSync(fd, 0);
			for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
		});
		console.log(JSON.stringify({ resultPath, dryRun: result.dryRun, done: result.done.length, failed: result.failed.length, notAttempted: result.notAttempted.length }));
		if (result.failed.length) process.exitCode = 1;
	} catch (e) { console.error(`cutover-delete: ${e.message}`); process.exitCode = 1; }
	finally { if (fd !== undefined) closeSync(fd); }
}
