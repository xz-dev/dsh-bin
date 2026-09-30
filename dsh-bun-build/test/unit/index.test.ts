// FB-EMPTY / RB-LEGACY: real local-build manifests, independent runtime index, append-only identity.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "dsh-runtime-index-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const script = resolve(import.meta.dir, "../../scripts/index.mjs");
const manifest = (channel = "release", run = 1) => ({
	kind: "dsh-runtime", id: channel === "release" ? `0.1.7-b${run}.1.gdeadbeef` : `live-cafebad-b${run}.1.gdeadbeef`,
	tag: channel === "release" ? `runtime-v0.1.7-b${run}.1.gdeadbeef` : `runtime-live-cafebad-b${run}.1.gdeadbeef`, channel,
	upstream: { commit: "c".repeat(40), commitTime: "2026-09-01T00:00:00.000Z", version: "0.1.7" },
	run, attempt: 1, launchProtocol: 1, builderCommit: "d".repeat(40), addons: { office: { slot: null, pinned: null } },
	targets: { "linux-x64-modern": { file: "runtime-linux-x64-modern.zip", size: 123, sha256: "a".repeat(64) } },
});
const invoke = (args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 15_000 });
const append = (index: string, data: object) => {
	const file = join(root, "manifest.json");
	writeFileSync(file, JSON.stringify(data));
	return invoke(["append-bundle", index, file]);
};

test("FB-EMPTY: local manifest produces schema 1 runtime-index with independent channel seq and unchanged reruns", () => {
	const file = join(root, "runtime-index.json");
	const release = manifest();
	const first = append(file, release);
	expect(first.stderr).toBe("");
	expect(first.status).toBe(0);
	expect(append(file, manifest("live")).status).toBe(0);
	const before = readFileSync(file, "utf8");
	expect(append(file, release).status).toBe(0);
	expect(readFileSync(file, "utf8")).toBe(before);
	expect(append(file, manifest("release", 2)).status).toBe(0);
	const index = JSON.parse(readFileSync(file, "utf8"));
	expect(index.schema).toBe(1);
	expect(index.channels.release.map((e: any) => e.seq)).toEqual([1, 2]);
	expect(index.channels.live.map((e: any) => e.seq)).toEqual([1]);
	expect(index.addons).toEqual({ office: [] });
	expect(index.channels.release[0]).toMatchObject({ kind: "dsh-runtime", id: release.id, tag: release.tag, launchProtocol: 1, builderCommit: release.builderCommit, assets: { "linux-x64-modern": { name: "runtime-linux-x64-modern.zip", size: 123, sha256: "a".repeat(64) } } });
	const stable = readFileSync(file, "utf8");
	for (const patch of [{ run: 9 }, { builderCommit: "e".repeat(40) }, { targets: { "linux-x64-modern": { ...release.targets["linux-x64-modern"], sha256: "b".repeat(64) } } }]) {
		expect(append(file, { ...release, ...patch }).status).not.toBe(0);
		expect(readFileSync(file, "utf8")).toBe(stable);
	}
	expect(invoke(["check", file]).status).toBe(0);
});

test("RB-LEGACY: old index and coupled manifest are rejected, never converted", () => {
	const file = join(root, "legacy.json");
	writeFileSync(file, JSON.stringify({ schemaVersion: 2, channels: { release: [], live: [] }, addons: { office: [] } }));
	const before = readFileSync(file, "utf8");
	expect(append(file, manifest()).status).not.toBe(0);
	expect(readFileSync(file, "utf8")).toBe(before);
	expect(append(join(root, "bad.json"), { ...manifest(), kind: undefined, launcherProtocol: 2 }).status).not.toBe(0);
});
