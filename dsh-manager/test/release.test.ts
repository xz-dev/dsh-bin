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
import { sha256 } from "../scripts/release.mjs";

const root = mkdtempSync(join(tmpdir(), "dsh-independent-release-"));
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
	const publish = (product: string, data: object) => { const f = join(dir, `${product}-manifest.json`); writeFileSync(f, JSON.stringify(data)); const p = spawnSync("bash", [script, product, f], { env: { ...process.env, DSH_BIN_INDEX_REMOTE: remote, RUNNER_TEMP: dir }, encoding: "utf8" }); expect(p.stderr, p.stdout).not.toContain("Error"); expect(p.status, p.stderr).toBe(0); };
	const read = (f: string) => execFileSync("git", ["--git-dir", remote, "show", `releases:${f}`], { encoding: "utf8" });
	publish("manager", m); expect(read("runtime-index.json")).toBe(original["runtime-index.json"]); expect(read("index.json")).toBe(original["index.json"]);
	const manager = read("manager-index.json"); publish("runtime", manifest()); expect(read("manager-index.json")).toBe(manager); expect(read("index.json")).toBe(original["index.json"]);
});

test("8.3: runtime aggregate accepts D10 identities and refuses mixed builder/protocol or corrupt bytes", () => {
	const dir = join(root, "runtime"); mkdirSync(dir); const m = manifest(); writeFileSync(join(dir, `${m.tag}.linux-x64-modern.json`), JSON.stringify(m)); writeFileSync(join(dir, "runtime-linux-x64-modern.zip"), "zip");
	expect(aggregateRelease(dir, 1).id).toBe(m.id);
	writeFileSync(join(dir, "runtime-linux-x64-modern.zip"), "bad"); expect(() => aggregateRelease(dir, 1)).toThrow(/sha256/);
});

test("RL-ARTIFACT-E2E: accepted counterpart digest is checked before parsing or executing", async () => {
	const dir = join(root, "accepted"); mkdirSync(dir); const text = JSON.stringify(runtimeIndex()); writeFileSync(join(dir, "runtime-index.json"), text);
	expect(await checkedIndex(dir, sha256(text), "runtime")).toEqual(runtimeIndex());
	await expect(checkedIndex(dir, "0".repeat(64), "runtime")).rejects.toThrow(/SHA256 mismatch/);
});

test("8.3: parsed workflows have independent triggers and publish gates; no counterpart build", () => {
	for (const product of ["manager", "runtime"]) {
		const w = Bun.YAML.parse(readFileSync(resolve(import.meta.dir, `../../.github/workflows/${product}-release.yml`), "utf8")) as any;
		expect(w.on.workflow_dispatch.inputs.publish.default).toBe(false); expect(w.on.workflow_dispatch.inputs.prerelease.default).toBe(true);
		expect(w.on.push.paths).toContain(`${product === "manager" ? "dsh-manager" : "dsh-bun-build"}/**`);
		expect(w.jobs.publish.needs).toContain("combination"); expect(w.jobs.publish.if).toContain("inputs.publish"); expect(w.jobs.publish.if).toContain("success");
		const build = JSON.stringify(w.jobs.build); expect(build).not.toContain(product === "manager" ? "build-target.mjs" : "zig build");
	}
});
