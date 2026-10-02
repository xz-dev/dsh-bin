// DL-MANAGER-ONLY: separate product indexes, archive identities and release side effects.
import { afterAll, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { aggregate, appendManager, emptyIndex, managerZip, TARGETS, verifyZip, version } from "../scripts/release.mjs";
import { readZipEntries } from "../../dsh-bun-build/runtime/zip.ts";
import { appendBundle, emptyIndex as runtimeIndex } from "../../dsh-bun-build/scripts/index.mjs";
import { aggregateRelease } from "../../dsh-bun-build/scripts/aggregate-release.mjs";
import { checkedIndex } from "../../dsh-bun-build/scripts/artifact-e2e.mjs";
import { publishRelease } from "../../dsh-bun-build/scripts/publish-release.mjs";
import { sha256 } from "../scripts/release.mjs";
import { upstreamCheck } from "../../dsh-bun-build/scripts/upstream-check.mjs";

const root = mkdtempSync(join(tmpdir(), "dsh-independent-release-"));
const bashPath = (p: string) => process.platform === "win32" ? p.replaceAll("\\", "/").replace(/^([A-Za-z]):\//, (_, drive) => `/${drive.toLowerCase()}/`) : p;
afterAll(() => rmSync(root, { recursive: true, force: true }));
function bytes(t: string, v = "1.2.3-rc.1") {
	const b = Buffer.alloc(160); const x64 = t.endsWith("x64");
	if (t.startsWith("linux")) { b.set([127, 69, 76, 70, 2, 1]); b.writeUInt16LE(2, 16); b.writeUInt16LE(x64 ? 62 : 183, 18); }
	else if (t.startsWith("darwin")) { b.writeUInt32LE(0xfeedfacf); b.writeUInt32LE(x64 ? 0x01000007 : 0x0100000c, 4); b.writeUInt32LE(2, 12); }
	else { b.write("MZ"); b.writeUInt32LE(64, 60); b.write("PE\0\0", 64); b.writeUInt16LE(x64 ? 0x8664 : 0xaa64, 68); b.writeUInt16LE(0x20b, 88); }
	return Buffer.concat([b, Buffer.from(`DSH_MANAGER_VERSION=${v}\0DSH_MANAGER_LAUNCH_PROTOCOL=1\0`)]);
}
const manifest = () => ({ kind: "dsh-runtime", tag: "runtime-v0.1.7-b1.1.gdddddddd", id: "0.1.7-b1.1.gdddddddd", channel: "release", upstream: { commit: "c".repeat(40), commitTime: "2026-09-01T00:00:00.000Z", version: "0.1.7" }, run: 1, attempt: 1, builderCommit: "d".repeat(40), launchProtocol: 1, addons: { office: { slot: null, pinned: null } }, targets: { "linux-x64-modern": { file: "runtime-linux-x64-modern.zip", size: 3, sha256: sha256(Buffer.from("zip")) } } });

test("8.3: six single-entry manager ZIPs validate headers, markers, CRC and strict SemVer", () => {
	const out = join(root, "manager"); mkdirSync(out);
	for (const t of Object.keys(TARGETS)) {
		const zip = managerZip(bytes(t), t, "1.2.3-rc.1");
		expect(readZipEntries(zip).map((e) => e.name)).toEqual([t.startsWith("windows") ? "dsh.exe" : "dsh"]);
		expect(verifyZip(zip, t, "1.2.3-rc.1")).toEqual(bytes(t));
		const bad = Buffer.from(zip); bad[40] ^= 1; expect(() => verifyZip(bad, t, "1.2.3-rc.1")).toThrow();
		expect(() => managerZip(Buffer.concat([bytes(t), Buffer.from("DSH_MANAGER_VERSION=other\0")]), t, "1.2.3-rc.1")).toThrow(/ambiguous/);
		writeFileSync(join(out, `manager-${t}.zip`), zip);
	}
	const m = aggregate(out, "1.2.3-rc.1"); const i = emptyIndex(); appendManager(i, m); const before = JSON.stringify(i); appendManager(i, m); expect(JSON.stringify(i)).toBe(before);
	const altered = bytes("linux-x64"); altered[120] = 1; writeFileSync(join(out, "manager-linux-x64.zip"), managerZip(altered, "linux-x64", "1.2.3-rc.1"));
	expect(() => aggregate(out, "1.2.3-rc.1")).toThrow(/original build manifest/);
	writeFileSync(join(out, "manager-linux-x64.zip"), managerZip(bytes("linux-x64"), "linux-x64", "1.2.3-rc.1"));
	expect(() => appendManager(i, { ...m, version: "1.2.3-rc.1+repair", tag: "manager-v1.2.3-rc.1+repair" })).toThrow(/different content/);
	for (const v of ["01.2.3", "1.2", "1.2.3-01", "1.2.3-rc.01", "1.2.3+", "1.2.3\n"]) expect(() => version(v)).toThrow();
});

test("DL-MANAGER-ONLY: manager/runtime dry-run generators and Git index publication leave counterpart and legacy index byte-identical", () => {
	const dir = join(root, "independence"); mkdirSync(dir);
	const m = JSON.parse(readFileSync(join(root, "manager/manager-manifest.json"), "utf8"));
	const remote = join(dir, "remote.git"), seed = join(dir, "seed");
	execFileSync("git", ["init", "--bare", "-q", remote]); mkdirSync(seed); execFileSync("git", ["init", "-q", seed]);
	const git = (...args: string[]) => execFileSync("git", ["-C", seed, ...args], { encoding: "utf8" });
	git("config", "user.name", "test"); git("config", "user.email", "test@example.invalid"); git("config", "commit.gpgsign", "false");
	const original = { "index.json": "legacy index KEEP\n", "runtime-index.json": JSON.stringify(runtimeIndex()), "manager-index.json": JSON.stringify(emptyIndex()) };
	for (const [name, text] of Object.entries(original)) writeFileSync(join(seed, name), text);
	git("add", "index.json", "runtime-index.json", "manager-index.json"); git("commit", "-qm", "seed"); git("push", "-q", remote, "HEAD:releases");
	const script = resolve(import.meta.dir, "../../dsh-bun-build/scripts/publish-index.sh");
	const publish = (product: string, data: object) => { const f = join(dir, `${product}-manifest.json`); writeFileSync(f, JSON.stringify(data)); const p = spawnSync("bash", [bashPath(script), product, bashPath(f)], { env: { ...process.env, DSH_BIN_INDEX_REMOTE: bashPath(remote), RUNNER_TEMP: bashPath(dir) }, encoding: "utf8" }); expect(p.stderr, p.stdout).not.toContain("Error"); expect(p.status, p.stderr).toBe(0); };
	const read = (f: string) => execFileSync("git", ["--git-dir", remote, "show", `releases:${f}`], { encoding: "utf8" });
	publish("manager", m); expect(read("runtime-index.json")).toBe(original["runtime-index.json"]); expect(read("index.json")).toBe(original["index.json"]);
	const manager = read("manager-index.json"); publish("runtime", manifest()); expect(read("manager-index.json")).toBe(manager); expect(read("index.json")).toBe(original["index.json"]);
});

test("8.3: runtime aggregate accepts D10 identities and refuses mixed builder/protocol or corrupt bytes", () => {
	const dir = join(root, "runtime"); mkdirSync(dir); const m = manifest(); writeFileSync(join(dir, `${m.tag}.linux-x64-modern.json`), JSON.stringify(m)); writeFileSync(join(dir, "runtime-linux-x64-modern.zip"), "zip");
	expect(aggregateRelease(dir, 1).id).toBe(m.id);
	writeFileSync(join(dir, "runtime-vother.linux-arm64.json"), JSON.stringify({ ...m, builderCommit: "e".repeat(40), targets: {} }));
	expect(() => aggregateRelease(dir, 1)).toThrow(/builderCommit/); rmSync(join(dir, "runtime-vother.linux-arm64.json"));
	writeFileSync(join(dir, "runtime-linux-x64-modern.zip"), "bad"); expect(() => aggregateRelease(dir, 1)).toThrow(/sha256/);
});

test("RL-ARTIFACT-E2E: accepted counterpart digest is checked before parsing or executing", async () => {
	const dir = join(root, "accepted"); mkdirSync(dir); const text = JSON.stringify(runtimeIndex()); writeFileSync(join(dir, "runtime-index.json"), text);
	expect(await checkedIndex(dir, sha256(text), "runtime")).toEqual(runtimeIndex());
	await expect(checkedIndex(dir, "0".repeat(64), "runtime")).rejects.toThrow(/SHA256 mismatch/);
});

test("8.3: manager publication is prerelease, immutable, never Latest, and verifies every uploaded asset", async () => {
	const path = join(root, "manager/manager-manifest.json"); const m = JSON.parse(readFileSync(path, "utf8")); const calls: any[] = [];
	let release: any = { id: 1, tag_name: m.tag, target_commitish: "a".repeat(40), draft: true, prerelease: true, immutable: false, assets: [], upload_url: "https://upload.invalid/assets{?name}" };
	const api = async (url: any, options: any = {}) => {
		url = String(url); calls.push({ url, method: options.method ?? "GET" });
		if (url.endsWith("/immutable-releases")) return Response.json({ enabled: true });
		if (url.includes("/releases/tags/")) return new Response("missing", { status: 404 });
		if (url.includes("?per_page=")) return Response.json([]);
		if (url.startsWith("https://upload.invalid")) { const name = new URL(url).searchParams.get("name"); release.assets.push({ name, digest: `sha256:${sha256(options.body)}` }); return Response.json({}, { status: 201 }); }
		if (options.method === "POST") { const body = JSON.parse(options.body); expect(body.prerelease).toBe(true); expect(body.tag_name).toBe(m.tag); return Response.json(release, { status: 201 }); }
		if (options.method === "PATCH") { const body = JSON.parse(options.body); expect(body).toEqual({ draft: false, prerelease: true, make_latest: "false" }); release = { ...release, ...body, immutable: true }; }
		return Response.json(release);
	};
	const result = await publishRelease(path, { GITHUB_TOKEN: "fixture", GITHUB_REPOSITORY: "fixture/repo", GITHUB_SHA: "a".repeat(40), DSH_RELEASE_PRERELEASE: "true" }, api as typeof fetch);
	expect(result.published).toBe(true); expect(release.assets).toHaveLength(8); expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
	let mutations = 0;
	await expect(publishRelease(path, { GITHUB_TOKEN: "fixture", GITHUB_REPOSITORY: "fixture/repo", GITHUB_SHA: "a".repeat(40) }, (async (_u: any, o: any) => { if (o?.method) mutations++; return Response.json({ enabled: false }); }) as typeof fetch)).rejects.toThrow(/immutability is disabled/);
	expect(mutations).toBe(0);
});

test("8.3: executable workflow preflight permits explicit bootstrap but refuses publication or malformed counterpart inputs", () => {
	const w = Bun.YAML.parse(readFileSync(resolve(import.meta.dir, "../../.github/workflows/manager-release.yml"), "utf8")) as any;
	const script = w.jobs.build.steps.find((s: any) => s.id === "identity").run;
	const run = (extra: Record<string, string>) => spawnSync("bash", ["-c", script], { cwd: resolve(import.meta.dir, "../.."), env: { ...process.env, VERSION: "1.0.0-rc.1", PUBLISH: "false", INDEX: "", RUN: "", ARTIFACT: "", DIGEST: "", GITHUB_OUTPUT: bashPath(join(root, "outputs")), ...extra }, encoding: "utf8" });
	const dry = run({}); expect(dry.status).toBe(0); expect(dry.stdout).toContain("combination gate skipped: no accepted counterpart (bootstrap)");
	const pub = run({ PUBLISH: "true" }); expect(pub.status).not.toBe(0); expect(pub.stderr).toContain("publish refused");
	const bad = run({ INDEX: "https://fixture.invalid/index", DIGEST: "bad" }); expect(bad.status).not.toBe(0);
	const complete = run({ PUBLISH: "true", INDEX: "https://fixture.invalid/index", DIGEST: "a".repeat(64) }); expect(complete.status).toBe(0);
});

test("8.3: parsed workflows have independent triggers and publish gates; no counterpart build", () => {
	for (const product of ["manager", "runtime"]) {
		const w = Bun.YAML.parse(readFileSync(resolve(import.meta.dir, `../../.github/workflows/${product}-release.yml`), "utf8")) as any;
		expect(w.on.workflow_dispatch.inputs.publish.default).toBe(false); expect(w.on.workflow_dispatch.inputs.prerelease.default).toBe(true);
		expect(w.on.push.paths).toContain(`${product === "manager" ? "dsh-manager" : "dsh-bun-build"}/**`);
		expect(w.jobs.publish.needs).toContain("combination"); expect(w.jobs.publish.if).toContain("inputs.publish"); expect(w.jobs.publish.if).toContain("success");
		expect(w.jobs.publish.if).toContain("github.event_name == 'workflow_dispatch'");
		expect(w.jobs.publish.if).toContain("github.ref == 'refs/heads/main'");
		const scheduledPublish = Function("inputs", "github", "needs", `return ${w.jobs.publish.if}`)({ publish: true }, { event_name: "schedule", ref: "refs/heads/main" }, { combination: { result: "success" } });
		expect(scheduledPublish).toBe(false);
		for (const [name, job] of Object.entries(w.jobs) as [string, any][]) if (name !== "publish") expect(job.permissions).toEqual({ contents: "read", actions: "read" });
		if (product === "runtime") {
			expect(w.on.schedule).toEqual([{ cron: "17 0,6,12,18 * * *" }]);
			expect(w.jobs.prepare.needs).toBe("detect");
			expect(w.jobs.prepare.if).toBe("needs.detect.outputs.build == 'true'");
			expect(w.jobs.detect.steps.find((s: any) => s.id === "poll").if).toBe("github.event_name == 'schedule'");
			expect(w.jobs.combination.if).toContain("needs.prepare.outputs.index");
			expect(w.jobs.combination.steps.find((s: any) => s.name?.startsWith("Candidate")).env.DIGEST).toBe("${{ needs.prepare.outputs.digest }}");
		}
		const build = JSON.stringify(w.jobs.build); expect(build).not.toContain(product === "manager" ? "build-target.mjs" : "zig build");
	}
});

test("Upstream tracking: unchanged release does nothing; new tag builds dry-run with pinned manager, bootstrap skips combination", async () => {
	const old = manifest(), published = runtimeIndex();
	appendBundle(published, { ...old, upstream: { ...old.upstream, tag: "dsh-v0.1.7" } });
	const refs = `${"c".repeat(40)}\trefs/tags/dsh-v0.1.7\n`;
	const manager = emptyIndex(); appendManager(manager, { kind: "dsh-manager", version: "1.2.3", tag: "manager-v1.2.3", launchProtocols: [1], assets: Object.fromEntries(Object.keys(TARGETS).map(target => [target, { name: `manager-${target}.zip`, size: 3, sha256: sha256("zip") }])) });
	const managerText = JSON.stringify(manager), calls: string[] = [];
	const source = (index: any, counterpart: string | null) => (async (url: any, options: any) => {
		calls.push(String(url)); expect(options.redirect).toBe("error");
		return String(url).endsWith("runtime-index.json") ? Response.json(index) : counterpart === null ? new Response(null, { status: 404 }) : new Response(counterpart);
	}) as typeof fetch;
	expect(await upstreamCheck(refs, "fixture/repo", source(published, managerText))).toEqual({ build: false, channel: "release", upstream: "dsh-v0.1.7", index: "", digest: "" });
	expect(calls).toHaveLength(1); calls.length = 0;
	const next = `${refs}${"d".repeat(40)}\trefs/tags/dsh-v0.1.8-rc.2\n${"e".repeat(40)}\trefs/tags/dsh-v0.1.8-rc.10\n`;
	expect(await upstreamCheck(next, "fixture/repo", source(published, managerText))).toEqual({ build: true, channel: "release", upstream: "dsh-v0.1.8-rc.10", index: "https://raw.githubusercontent.com/fixture/repo/releases/manager-index.json", digest: sha256(managerText) });
	const absent = (async () => new Response(null, { status: 404 })) as typeof fetch;
	expect(await upstreamCheck(next, "fixture/repo", absent)).toEqual({ build: false, bootstrap: true, channel: "release", upstream: "dsh-v0.1.8-rc.10", index: "", digest: "" });
	const malformed = `${next}${"f".repeat(40)}\trefs/tags/dsh-v99.99.99-rc..1\n${"f".repeat(40)}\trefs/tags/dsh-v01.0.0\n${"f".repeat(40)}\trefs/tags/dsh-v9.0.0-rc.01\n`;
	expect((await upstreamCheck(malformed, "fixture/repo", source(published, managerText))).upstream).toBe("dsh-v0.1.8-rc.10");
	await expect(upstreamCheck(refs.replace("c".repeat(40), "d".repeat(40)), "fixture/repo", source(published, managerText))).rejects.toThrow("published upstream tag moved");
	await expect(upstreamCheck(next, "fixture/repo", (async () => new Response("denied", { status: 403 })) as typeof fetch)).rejects.toThrow("HTTP 403");
	await expect(upstreamCheck(next, "fixture/repo", source(published, "{}"))).rejects.toThrow("published manager index");
});
