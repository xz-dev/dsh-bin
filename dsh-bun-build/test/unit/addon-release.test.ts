// D10 / DL-CUTOVER: office addons publish only into the independent runtime index.
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appendAddon, appendBundle, emptyIndex } from "../../scripts/index.mjs";
import { publishRelease } from "../../scripts/publish-release.mjs";

const root = mkdtempSync(join(tmpdir(), "dsh-addon-release-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const manifest = (run = 1) => ({
	tag: `addon-office-v0.1.1-b${run}.1.gdeadbeef`, version: `0.1.1-b${run}.1.gdeadbeef`,
	run, attempt: 1, builderCommit: "deadbeef" + "d".repeat(32),
	slot: { commit: "e".repeat(40), kitVersion: "0.1.1" },
	assets: { linux: { file: "dsh-addon-office-linux.zip", size: 3, sha256: sha256("zip") } },
});
const bashPath = (p: string) => process.platform === "win32" ? p.replaceAll("\\", "/").replace(/^([A-Za-z]):\//, (_, drive) => `/${drive.toLowerCase()}/`) : p;

function seededIndex() {
	const index = emptyIndex();
	appendBundle(index, {
		kind: "dsh-runtime", tag: "runtime-v0.1.7-b1.1.gdddddddd", id: "0.1.7-b1.1.gdddddddd", channel: "release",
		upstream: { commit: "c".repeat(40), commitTime: "2026-09-01T00:00:00.000Z", version: "0.1.7" },
		run: 1, attempt: 1, builderCommit: "d".repeat(40), launchProtocol: 1, addons: { office: { slot: null, pinned: null } },
		targets: { "linux-x64-modern": { file: "runtime-linux-x64-modern.zip", size: 3, sha256: sha256("zip") } },
	});
	return index;
}

test("D10: append-addon preserves existing runtime/addon entries and rejects duplicates or malformed identity without writing", () => {
	const file = join(root, "runtime-index.json"), input = join(root, "addon-manifest.json");
	writeFileSync(file, JSON.stringify(seededIndex()));
	const invoke = (data: object) => {
		writeFileSync(input, JSON.stringify(data));
		return spawnSync(process.execPath, [resolve(import.meta.dir, "../../scripts/index.mjs"), "append-addon", file, input], { encoding: "utf8", timeout: 15_000 });
	};
	const channels = JSON.stringify(JSON.parse(readFileSync(file, "utf8")).channels);
	expect(invoke(manifest()).status).toBe(0);
	const first = JSON.parse(readFileSync(file, "utf8")).addons.office[0];
	expect(first).toMatchObject({ tag: manifest().tag, seq: 1, assets: { linux: { name: "dsh-addon-office-linux.zip", size: 3, sha256: sha256("zip") } } });
	expect(invoke(manifest(2)).status).toBe(0);
	const before = readFileSync(file, "utf8"), after = JSON.parse(before);
	expect(JSON.stringify(after.channels)).toBe(channels);
	expect(JSON.stringify(after.addons.office[0])).toBe(JSON.stringify(first));
	for (const invalid of [manifest(), { ...manifest(3), builderCommit: "bad" }, { ...manifest(3), tag: "dsh-addon-office-vlegacy" }, { ...manifest(3), slot: { commit: "bad", kitVersion: "0.1.1" } }, { ...manifest(3), assets: { linux: { ...manifest().assets.linux, sha256: "bad" } } }]) {
		const result = invoke(invalid);
		expect(result.status).not.toBe(0);
		expect(readFileSync(file, "utf8")).toBe(before);
	}
	expect(invoke(manifest()).stderr).toContain("already lists");
});

test("DL-MANAGER-ONLY: addon Git publication is one append to runtime-index, keeps legacy/manager bytes, duplicate leaves HEAD unchanged", () => {
	const dir = join(root, "git"); mkdirSync(dir);
	const remote = join(dir, "remote.git"), seed = join(dir, "seed");
	execFileSync("git", ["init", "--bare", "-q", remote]); mkdirSync(seed); execFileSync("git", ["init", "-q", seed]);
	const git = (...args: string[]) => execFileSync("git", ["-C", seed, ...args], { encoding: "utf8" });
	git("config", "user.name", "test"); git("config", "user.email", "test@example.invalid"); git("config", "commit.gpgsign", "false");
	const original = { "index.json": "legacy KEEP\n", "manager-index.json": "manager KEEP\n", "runtime-index.json": JSON.stringify(seededIndex()) };
	for (const [name, text] of Object.entries(original)) writeFileSync(join(seed, name), text);
	git("add", ...Object.keys(original)); git("commit", "-qm", "seed"); git("push", "-q", remote, "HEAD:releases");
	const input = join(dir, "addon-manifest.json"); writeFileSync(input, JSON.stringify(manifest()));
	const script = resolve(import.meta.dir, "../../scripts/publish-index.sh");
	const publish = () => spawnSync("bash", [bashPath(script), "addon", bashPath(input)], { env: { ...process.env, DSH_BIN_INDEX_REMOTE: bashPath(remote), RUNNER_TEMP: bashPath(dir) }, encoding: "utf8", timeout: 20_000 });
	const result = publish(); expect(result.status, result.stderr).toBe(0);
	const read = (f: string) => execFileSync("git", ["--git-dir", remote, "show", `releases:${f}`], { encoding: "utf8" });
	for (const name of ["index.json", "manager-index.json"]) expect(read(name)).toBe(original[name]);
	const updated = JSON.parse(read("runtime-index.json"));
	expect(updated.channels).toEqual(seededIndex().channels);
	expect(updated.addons.office.map((entry: any) => entry.tag)).toEqual([manifest().tag]);
	const head = () => execFileSync("git", ["--git-dir", remote, "rev-parse", "releases"], { encoding: "utf8" });
	const before = head(); const duplicate = publish();
	expect(duplicate.status).not.toBe(0); expect(duplicate.stderr).toContain("already lists"); expect(head()).toBe(before);
});

test("DL-CUTOVER: addon publication validates builder identity and hashes before API calls; immutable addon never becomes Latest", async () => {
	const dir = join(root, "publish"); mkdirSync(dir);
	const input = join(dir, "addon-manifest.json"); writeFileSync(input, JSON.stringify(manifest())); writeFileSync(join(dir, manifest().assets.linux.file), "zip");
	const env = { GITHUB_TOKEN: "fixture", GITHUB_REPOSITORY: "fixture/repo", GITHUB_SHA: "deadbeef" + "d".repeat(32) };
	let release: any = { id: 1, tag_name: manifest().tag, target_commitish: env.GITHUB_SHA, draft: true, prerelease: false, immutable: false, assets: [], upload_url: "https://upload.invalid/assets{?name}" };
	let calls = 0;
	const api = async (u: any, opts: any = {}) => {
		const url = String(u); calls++;
		if (url.endsWith("/immutable-releases")) return Response.json({ enabled: true });
		if (url.includes("/releases/tags/")) return new Response("missing", { status: 404 });
		if (url.includes("?per_page=")) return Response.json([]);
		if (url.startsWith("https://upload.invalid")) { release.assets.push({ name: new URL(url).searchParams.get("name"), digest: `sha256:${sha256(opts.body)}` }); return Response.json({}, { status: 201 }); }
		if (opts.method === "POST") return Response.json(release, { status: 201 });
		if (opts.method === "PATCH") { expect(JSON.parse(opts.body)).toEqual({ draft: false, prerelease: false, make_latest: "false" }); release = { ...release, draft: false, immutable: true }; }
		return Response.json(release);
	};
	// Review P1: `targets` names a real, uploadable file while `assets` (what the index records) differs.
	writeFileSync(join(dir, "actually-uploaded.zip"), "up!");
	const mixed = { ...manifest(), channel: "release", targets: { "linux-x64-modern": { file: "actually-uploaded.zip", size: 3, sha256: sha256("up!") } } };
	expect(() => appendAddon(emptyIndex(), mixed)).toThrow(/assets` only/);
	for (const data of [{ ...manifest(), builderCommit: "f".repeat(40) }, { ...manifest(), slot: { ...manifest().slot, commit: "bad" } }, mixed, { ...manifest(), kind: "dsh-runtime" }]) {
		writeFileSync(input, JSON.stringify(data));
		await expect(publishRelease(input, env, api as typeof fetch)).rejects.toThrow();
		expect(calls).toBe(0);
	}
	writeFileSync(input, JSON.stringify(manifest())); writeFileSync(join(dir, manifest().assets.linux.file), "bad");
	await expect(publishRelease(input, env, api as typeof fetch)).rejects.toThrow(/differs from build manifest/); expect(calls).toBe(0);
	writeFileSync(input, JSON.stringify({ ...manifest(), channel: "release" }));
	writeFileSync(join(dir, manifest().assets.linux.file), "zip");
	expect((await publishRelease(input, env, api as typeof fetch)).published).toBe(true);
	expect(release.assets.map((asset: any) => asset.name).sort()).toEqual(["addon-manifest.json", "dsh-addon-office-linux.zip"]);
});

test("D10: addon workflow identity executes without launcher metadata; publication is main/manual-only with read-only build", () => {
	const workflow = Bun.YAML.parse(readFileSync(resolve(import.meta.dir, "../../../.github/workflows/addon.yml"), "utf8")) as any;
	const line = workflow.jobs.addon.steps.find((step: any) => step.id === "build").run.split("\n").find((l: string) => l.trim().startsWith("identity="));
	const result = spawnSync("bash", ["-ec", `${line}\nprintf '%s\\n' "$identity"`], {
		cwd: resolve(import.meta.dir, "../.."), encoding: "utf8", timeout: 15_000,
		env: { ...process.env, slot: JSON.stringify(manifest().slot), GITHUB_SHA: manifest().builderCommit, GITHUB_RUN_NUMBER: "1", GITHUB_RUN_ATTEMPT: "1" },
	});
	expect(result.status, result.stderr).toBe(0);
	expect(JSON.parse(result.stdout)).toMatchObject({ tag: manifest().tag, run: 1, attempt: 1, builderCommit: manifest().builderCommit, slot: manifest().slot });
	expect(workflow.on.workflow_dispatch.inputs.publish.default).toBe(false);
	expect(workflow.jobs.addon.permissions).toEqual({ contents: "read" });
	expect(workflow.jobs.publish.if).toContain("github.event_name == 'workflow_dispatch'");
	expect(workflow.jobs.publish.if).toContain("github.ref == 'refs/heads/main'");
	expect(workflow.jobs.publish.needs).toEqual(["addon"]);
});
