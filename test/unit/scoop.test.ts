import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scoopManifests } from "../../scripts/create-scoop-manifest.mjs";

const h = (c: string) => c.repeat(64);
const bundle = (seq: number, version: string, channel: string, pinned: string) => ({
	seq,
	tag: channel === "release" ? `dsh-v${version}` : `dsh-${version}`,
	version,
	channel,
	addons: { office: { slot: { commit: "8e816b7ea4950f53b7eeb4623d63d74bd1341491", kitVersion: "0.1.1" }, pinned } },
	assets: {
		"windows-x64-modern": { name: "dsh-windows-x64-modern.zip", size: 1, sha256: h(String(seq)) },
		"windows-arm64": { name: "dsh-windows-arm64.zip", size: 1, sha256: h("a") },
	},
});
const addon = (seq: number, version: string) => ({
	seq,
	tag: `dsh-addon-office-v${version}`,
	version,
	slot: { commit: "8e816b7ea4950f53b7eeb4623d63d74bd1341491", kitVersion: "0.1.1" },
	assets: { "windows-x64": { name: "dsh-addon-office-windows-x64.zip", size: 1, sha256: h("b") }, "windows-arm64": { name: "dsh-addon-office-windows-arm64.zip", size: 1, sha256: h("c") } },
});
const INDEX = {
	schemaVersion: 1,
	channels: {
		release: [bundle(1, "0.1.7-rc.2-xz.1.1.g00000001", "release", "0.1.1-xz.1.1.g00000001"), bundle(2, "0.1.7-rc.2-xz.5.1.g00000005", "release", "0.1.1-xz.1.1.g00000001")],
		live: [bundle(1, "live.4878cda-xz.6.1.g00000006", "live", "0.1.1-xz.2.1.g00000002")],
	},
	addons: { office: [addon(1, "0.1.1-xz.1.1.g00000001"), addon(2, "0.1.1-xz.2.1.g00000002")] },
};

describe("scoop manifests (9.1, 9.4)", () => {
	const m = scoopManifests(INDEX, "xz-dev/dsh-bin") as Record<string, any>;

	test("dsh.json follows the newest release entry with both Windows archives and the managed lock", () => {
		expect(m.dsh.version).toBe("0.1.7-rc.2-xz.5.1.g00000005");
		expect(m.dsh.bin).toBe("dsh.exe");
		expect(m.dsh.architecture["64bit"]).toEqual({ url: "https://github.com/xz-dev/dsh-bin/releases/download/dsh-v0.1.7-rc.2-xz.5.1.g00000005/dsh-windows-x64-modern.zip", hash: h("2") });
		expect(m.dsh.architecture.arm64.url).toEndWith("/dsh-windows-arm64.zip");
		expect(m.dsh.post_install[0]).toContain(".scoop.managed.lock");
		expect(m.dsh.persist).toEqual(["addons", "addons.json"]);
	});

	test("dsh-live.json follows the newest live entry", () => {
		expect(m["dsh-live"].version).toBe("live.4878cda-xz.6.1.g00000006");
		expect(m["dsh-live"].architecture["64bit"].url).toContain("/download/dsh-live.4878cda-xz.6.1.g00000006/");
	});

	test("dsh-office.json installs the addon pinned by the newest release bundle, not the newest addon", () => {
		const o = m["dsh-office"];
		expect(o.version).toBe("0.1.1-xz.1.1.g00000001");
		expect(o.depends).toBe("dsh");
		expect(o.architecture["64bit"].url).toBe("https://github.com/xz-dev/dsh-bin/releases/download/dsh-addon-office-v0.1.1-xz.1.1.g00000001/dsh-addon-office-windows-x64.zip");
		expect(o.post_install.join("\n")).toContain("addons\\office\\0.1.1-xz.1.1.g00000001");
		expect(o.post_install.join("\n")).toContain("forced = $false");
		expect(o.pre_uninstall.join("\n")).toContain("Remove('office')");
	});

	test("a missing Windows asset fails instead of writing a broken manifest", () => {
		const bad = structuredClone(INDEX);
		delete (bad.channels.release[1].assets as Record<string, unknown>)["windows-arm64"];
		expect(() => scoopManifests(bad)).toThrow(/windows-arm64/);
	});

	test("publish-scoop-bucket.sh writes the scoop branch and is idempotent", () => {
		const t = mkdtempSync(join(tmpdir(), "dsh-scoop-"));
		try {
			execFileSync("git", ["init", "-q", "--bare", join(t, "r.git")]);
			writeFileSync(join(t, "index.json"), JSON.stringify(INDEX));
			const env = { ...process.env, DSH_BIN_BUCKET_REMOTE: join(t, "r.git"), DSH_BIN_INDEX_FILE: join(t, "index.json"), GITHUB_REPOSITORY: "xz-dev/dsh-bin", RUNNER_TEMP: t };
			const script = join(import.meta.dir, "../../scripts/publish-scoop-bucket.sh");
			expect(execFileSync("bash", [script], { env, encoding: "utf8" })).toContain("updated");
			expect(execFileSync("bash", [script], { env, encoding: "utf8" })).toContain("already current");
			const files = execFileSync("git", ["--git-dir", join(t, "r.git"), "ls-tree", "-r", "--name-only", "scoop"], { encoding: "utf8" }).trim().split("\n");
			expect(files).toEqual(["bucket/dsh-live.json", "bucket/dsh-office.json", "bucket/dsh.json"]);
		} finally {
			rmSync(t, { recursive: true, force: true });
		}
	});
});
