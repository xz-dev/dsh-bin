// DL-CUTOVER / DL-CLEANUP-BLOCKED: API fixture rehearsal; no real GitHub mutations.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freezeReleases, inventorySha256 } from "../../scripts/cutover-freeze.mjs";
import { deleteFrozen } from "../../scripts/cutover-delete.mjs";

const env = { GITHUB_REPOSITORY: "fixture/repo", GH_TOKEN: "fixture-only" };
const root = mkdtempSync(join(tmpdir(), "dsh-cutover-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const release = (id: number, tag: string, extra = {}) => ({ id, tag_name: tag, name: tag, html_url: `https://github.com/fixture/repo/releases/tag/${tag}`, draft: false, prerelease: false, immutable: false, ...extra });
const asset = (id: number) => ({ id, name: `file-${id}.zip`, size: 3, browser_download_url: `https://github.com/fixture/repo/releases/download/dsh-v1/file-${id}.zip`, digest: `sha256:${"a".repeat(64)}` });
const releases = [release(1, "dsh-v1"), release(2, "dsh-live-old", { prerelease: true }), release(3, "dsh-addon-office-v1", { draft: true }), release(4, "manager-v1"), release(5, "runtime-v1"), release(6, "runtime-live-new"), release(7, "addon-office-v1"), release(8, "manual-note"), ...Array.from({ length: 94 }, (_, n) => release(9 + n, `manager-v${n + 2}`))];
const assets = Array.from({ length: 101 }, (_, n) => asset(100 + n));

function fixture({ order = releases, permissions = { push: true } as object | undefined, failures = {} as Record<string, number>, messages = {} as Record<string, string>, changed = {} as Record<number, object>, changedAssets = {} as Record<number, object[]>, gone = [] as number[], network = "" } = {}) {
	const calls: string[] = [], deleted: number[] = [];
	const api = async (input: any, options: any = {}) => {
		const url = new URL(String(input)), method = options.method ?? "GET", path = url.pathname.replace("/repos/fixture/repo", ""), call = `${method} ${path}`;
		calls.push(call);
		expect(options.redirect).toBe("error");
		if (call === network) throw new Error("fixture network failure");
		if (failures[call]) return new Response(messages[call] ?? "blocked", { status: failures[call] });
		if (path === "" && method === "GET") return Response.json({ permissions });
		const page = Number(url.searchParams.get("page") ?? "1");
		if (path === "/releases" && method === "GET") return Response.json(order.slice((page - 1) * 100, page * 100));
		const items = path.match(/^\/releases\/(\d+)\/assets$/);
		if (items && method === "GET") return Response.json((changedAssets[Number(items[1])] ?? (Number(items[1]) === 1 ? assets : [asset(Number(items[1]) + 1000)])).slice((page - 1) * 100, page * 100));
		if (path.startsWith("/contents/")) return Response.json({ sha: "blob", encoding: "base64", content: Buffer.from("legacy https://github.com/fixture/repo/releases/download/dsh-v1/old.zip\n").toString("base64"), html_url: "https://github.com/fixture/repo/blob/main/file" });
		const item = path.match(/^\/releases\/(\d+)$/);
		if (item) {
			const id = Number(item[1]);
			if (gone.includes(id)) return new Response("gone", { status: 404 });
			if (method === "GET") return Response.json(changed[id] ?? releases.find((r) => r.id === id));
			if (method === "DELETE") { deleted.push(id); return new Response(null, { status: 204 }); }
		}
		throw new Error(`unexpected API call: ${call}`);
	};
	return { api: api as typeof fetch, calls, deleted };
}
const frozen = async () => freezeReleases(env, fixture().api);

test("DL-CUTOVER: freeze refuses missing draft visibility before listing any releases", async () => {
	for (const permissions of [{ push: false }, {}, { push: "true" }, null]) {
		const f = fixture({ permissions: permissions as any });
		await expect(freezeReleases(env, f.api)).rejects.toThrow("push permission required to include draft releases");
		expect(f.calls).toEqual(["GET "]);
	}
});

test("DL-CUTOVER: freeze CLI leaves no output when draft visibility is refused", () => {
	const out = join(root, "denied-freeze.json"), preload = join(root, "deny-freeze.mjs");
	writeFileSync(preload, `globalThis.fetch = async (url, options) => {
		if (options.method !== "GET" || String(url) !== "https://api.github.com/repos/fixture/repo") throw new Error("release listing must not run");
		return Response.json({permissions:{push:false}});
	};`);
	const result = spawnSync(process.execPath, ["--preload", preload, resolve(import.meta.dir, "../../scripts/cutover-freeze.mjs"), out], { encoding: "utf8", timeout: 10_000, env: { ...process.env, ...env } });
	expect(result.status).toBe(1); expect(result.stderr).toContain("push permission required"); expect(existsSync(out)).toBe(false);
});

test("DL-CUTOVER: freeze paginates releases/assets including drafts, sorts old IDs, protects new/unknown tags and hashes discovery", async () => {
	const f = fixture(), inventory = await freezeReleases(env, f.api);
	expect(inventory.releases.map((r: any) => r.id)).toEqual([1, 2, 3]);
	expect(inventory.releases[1].prerelease).toBe(true);
	expect(inventory.releases[2].draft).toBe(true);
	expect(inventory.counts).toEqual({ releases: 3, release: 1, live: 1, addon: 1, assets: 103, bytes: 309, protected: 98, unknown: 1 });
	expect(inventory.unknown.map((r: any) => r.tag)).toEqual(["manual-note"]);
	expect(inventory.releases[0].assets).toHaveLength(101);
	expect(f.calls.filter((c) => c === "GET /releases")).toHaveLength(2);
	expect(f.calls.filter((c) => c === "GET /releases/1/assets")).toHaveLength(2);
	expect(inventory.discovery.map((d: any) => `${d.ref}:${d.path}`)).toEqual(["releases:index.json", "scoop:bucket/dsh.json", "scoop:bucket/dsh-live.json", "scoop:bucket/dsh-office.json", "main:README.md", "main:README.zh-CN.md", "main:install.sh"]);
	expect(inventory.discovery.every((d: any) => d.content && d.urls.length === 1)).toBe(true);
	const reversed = await freezeReleases(env, fixture({ order: [...releases].reverse() }).api);
	expect(reversed.sha256).toBe(inventory.sha256);
	const edited = structuredClone(inventory); edited.releases[0].assets[0].name = "different.zip";
	expect(inventorySha256(edited)).not.toBe(inventory.sha256);
});

test("DL-CUTOVER: confirmed deletion GETs/deletes only frozen IDs, never relists, records each item, leaves new releases/tags untouched", async () => {
	const inventory = await frozen(), f = fixture(), records: any[] = [];
	const result = await deleteFrozen(inventory, inventory.sha256, env, f.api, true, (r: any) => records.push(structuredClone(r)));
	expect(f.deleted).toEqual([1, 2, 3]);
	expect(f.calls).toEqual(["GET /releases/1", "GET /releases/1/assets", "GET /releases/1/assets", "DELETE /releases/1", "GET /releases/2", "GET /releases/2/assets", "DELETE /releases/2", "GET /releases/3", "GET /releases/3/assets", "DELETE /releases/3"]);
	expect(result.done.map((r: any) => r.status)).toEqual(["deleted", "deleted", "deleted"]);
	expect(result.failed).toEqual([]); expect(result.notAttempted).toEqual([]);
	expect(records).toHaveLength(4); expect(records[0].notAttempted).toHaveLength(3);
});

test("DL-CUTOVER: tampered/wrong digest or repository and forged new-family ID fail before API; dry run has zero API mutations", async () => {
	const inventory = await frozen(), f = fixture();
	await expect(deleteFrozen(inventory, "b".repeat(64), env, f.api, true)).rejects.toThrow("SHA256 mismatch");
	const tampered = structuredClone(inventory); tampered.releases[0].id = 4;
	await expect(deleteFrozen(tampered, inventory.sha256, env, f.api, true)).rejects.toThrow("SHA256 mismatch");
	const forged = structuredClone(inventory); forged.releases[0].tag = "manager-v1"; forged.sha256 = inventorySha256(forged);
	await expect(deleteFrozen(forged, forged.sha256, env, f.api, true)).rejects.toThrow("unsafe frozen release");
	await expect(deleteFrozen(inventory, inventory.sha256, { ...env, GITHUB_REPOSITORY: "other/repo" }, f.api, true)).rejects.toThrow("repository differs");
	expect(f.calls).toEqual([]);
	const result = await deleteFrozen(inventory, inventory.sha256, {}, f.api);
	expect(result.dryRun).toBe(true); expect(result.notAttempted).toHaveLength(3); expect(result.done).toEqual([]); expect(f.calls).toEqual([]);
});

test("DL-CUTOVER: changed ID/tag identity (including new family) stops deletion with pending records", async () => {
	const inventory = await frozen();
	for (const changed of [release(1, "manager-v1"), release(1, "dsh-v-edited"), release(4, "dsh-v1")]) {
		const f = fixture({ changed: { 1: changed } });
		const result = await deleteFrozen(inventory, inventory.sha256, env, f.api, true);
		expect(f.deleted).toEqual([]); expect(f.calls).toEqual(["GET /releases/1"]);
		expect(result.failed[0].reason).toContain("identity changed"); expect(result.notAttempted.map((r: any) => r.id)).toEqual([2, 3]);
	}
});

test("DL-CUTOVER: 404 means already deleted; 500/network failures persist while remaining IDs continue", async () => {
	const inventory = await frozen();
	for (const options of [{ gone: [1] }, { failures: { "DELETE /releases/1": 404 } }, { failures: { "DELETE /releases/1": 500 } }, { failures: { "GET /releases/1": 500 } }, { network: "DELETE /releases/1" }]) {
		const f = fixture(options), result = await deleteFrozen(inventory, inventory.sha256, env, f.api, true);
		expect(f.deleted).toEqual([2, 3]); expect(result.notAttempted).toEqual([]);
		if (result.failed.length) { expect(result.failed).toHaveLength(1); expect(result.failed[0].id).toBe(1); }
		else expect(result.done[0].status).toBe("already-deleted");
	}
});

test("DL-CLEANUP-BLOCKED: 401/403/422 stop immediately without auth/settings fallback; immutable metadata is not an API refusal", async () => {
	const inventory = await frozen();
	for (const method of ["GET", "DELETE"]) for (const status of [401, 403, 422]) {
		const f = fixture({ failures: { [`${method} /releases/1`]: status } }), result = await deleteFrozen(inventory, inventory.sha256, env, f.api, true);
		expect(f.deleted).toEqual([]); expect(result.failed).toHaveLength(1); expect(result.failed[0].reason).toContain(`HTTP ${status}`);
		expect(result.notAttempted.map((r: any) => r.id)).toEqual([2, 3]); expect(f.calls).toEqual(method === "GET" ? ["GET /releases/1"] : ["GET /releases/1", "GET /releases/1/assets", "GET /releases/1/assets", "DELETE /releases/1"]);
	}
	const badBody = fixture();
	const brokenResponse = async (url: any, options: any) => options.method === "DELETE" && String(url).endsWith("/releases/1") ? { status: 403, text: async () => { throw new Error("response body disconnected"); } } as Response : badBody.api(url, options);
	const disconnected = await deleteFrozen(inventory, inventory.sha256, env, brokenResponse as typeof fetch, true);
	expect(disconnected.failed).toHaveLength(1); expect(disconnected.notAttempted).toHaveLength(2); expect(badBody.deleted).toEqual([]);
	expect(disconnected.failed[0].reason).toBe("DELETE release 1: HTTP 403: response body read failed: response body disconnected");
	const refusal = fixture({ failures: { "DELETE /releases/1": 409 }, messages: { "DELETE /releases/1": "Release immutable: deletion blocked" } });
	const blocked = await deleteFrozen(inventory, inventory.sha256, env, refusal.api, true);
	expect(blocked.failed[0].reason).toContain("immutable"); expect(blocked.notAttempted).toHaveLength(2); expect(refusal.deleted).toEqual([]);
	const f = fixture({ changed: { 1: release(1, "dsh-v1", { immutable: true }) } });
	const result = await deleteFrozen(inventory, inventory.sha256, env, f.api, true);
	expect(result.failed).toEqual([]); expect(f.deleted).toEqual([1, 2, 3]); expect(result.notAttempted).toEqual([]);
});

test("DL-CUTOVER: adding/changing assets after freeze refuses the release instead of deleting unconfirmed files", async () => {
	const inventory = await frozen();
	for (const changedAssets of [[...assets, asset(9999)], assets.slice(1), assets.map((a, n) => n ? a : { ...a, digest: `sha256:${"b".repeat(64)}` })]) {
		const f = fixture({ changedAssets: { 1: changedAssets } });
		const result = await deleteFrozen(inventory, inventory.sha256, env, f.api, true);
		expect(f.deleted).toEqual([]); expect(result.failed[0].reason).toContain("assets changed"); expect(result.notAttempted).toHaveLength(2);
	}
});

test("DL-CLEANUP-BLOCKED: CLI persists partial results and exits nonzero for fixture 500/403/422 without real API calls", async () => {
	const inventory = await frozen();
	for (const status of [500, 403, 422]) {
		const path = join(root, `frozen-${status}.json`), preload = join(root, `fixture-${status}.mjs`), trace = join(root, `calls-${status}.jsonl`);
		writeFileSync(path, JSON.stringify(inventory));
		writeFileSync(preload, `import {appendFileSync} from 'node:fs';
const releases = ${JSON.stringify(releases)}, assets = ${JSON.stringify(Object.fromEntries(inventory.releases.map((r: any) => [r.id, r.assets])))};
globalThis.fetch = async (url, options) => {
 const u = new URL(url), match = u.pathname.match(/^\\/repos\\/fixture\\/repo\\/releases\\/(\\d+)(\\/assets)?$/);
 if (!match) throw new Error('fixture rejects nonnumeric release endpoint: '+url);
 const id=Number(match[1]); appendFileSync(${JSON.stringify(trace)}, options.method+' '+u.pathname+'\\n');
 if (match[2] && options.method === 'GET') { const a=assets[id]; const page=Number(u.searchParams.get('page')); return Response.json(a.slice((page-1)*100,page*100)); }
 if (options.method === 'GET') return Response.json(releases.find(r=>r.id===id));
 if (options.method === 'DELETE') return new Response(id===1?'failure':null,{status:id===1?${status}:204});
 throw new Error('unexpected fixture method');
};`);
		const result = spawnSync(process.execPath, ["--preload", preload, resolve(import.meta.dir, "../../scripts/cutover-delete.mjs"), path, "--expect-sha256", inventory.sha256, "--confirm"], { encoding: "utf8", timeout: 10_000, env: { ...process.env, ...env } });
		expect(result.status, result.stderr).toBe(1);
		const log = JSON.parse(readFileSync(`${path}.results.json`, "utf8"));
		expect(log.failed.map((r: any) => r.id)).toEqual([1]);
		expect(log.done.map((r: any) => r.id)).toEqual(status === 500 ? [2, 3] : []);
		expect(log.notAttempted.map((r: any) => r.id)).toEqual(status === 500 ? [] : [2, 3]);
		expect(readFileSync(trace, "utf8")).not.toContain("/tags");
	}
});

test("DL-CUTOVER: CLI dry run prints exact plan/log, wrong hash refuses, existing result/user files never overwritten", async () => {
	const inventory = await frozen(), path = join(root, "frozen.json"); writeFileSync(path, JSON.stringify(inventory));
	const invoke = (args: string[]) => spawnSync(process.execPath, [resolve(import.meta.dir, "../../scripts/cutover-delete.mjs"), path, ...args], { encoding: "utf8", timeout: 10_000, env: { ...process.env, GITHUB_REPOSITORY: "fixture/repo" } });
	const wrong = invoke(["--expect-sha256", "b".repeat(64), "--confirm"]);
	expect(wrong.status).toBe(1); expect(wrong.stderr).toContain("SHA256 mismatch");
	const dry = invoke(["--expect-sha256", inventory.sha256]);
	expect(dry.status, dry.stderr).toBe(0); expect(dry.stdout).toContain('"action":"plan-only"');
	const log = readFileSync(`${path}.results.json`, "utf8"); expect(JSON.parse(log).notAttempted).toHaveLength(3);
	const second = invoke(["--expect-sha256", inventory.sha256]); expect(second.status).toBe(1); expect(readFileSync(`${path}.results.json`, "utf8")).toBe(log);
	writeFileSync(join(root, "user.json"), "KEEP");
	const freeze = spawnSync(process.execPath, [resolve(import.meta.dir, "../../scripts/cutover-freeze.mjs"), join(root, "user.json")], { encoding: "utf8", timeout: 10_000, env: { ...process.env, ...env } });
	expect(freeze.status).toBe(1); expect(readFileSync(join(root, "user.json"), "utf8")).toBe("KEEP");
});
