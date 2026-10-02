import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scoopManifests } from "../scripts/create-scoop-manifest.mjs";

const h = (c: string) => c.repeat(64);
const entry = (version: string) => ({ version, tag: `manager-v${version}`, launchProtocols: [1], assets: {
	"windows-x64": { name: "manager-windows-x64.zip", size: 7, sha256: h("1") },
	"windows-arm64": { name: "manager-windows-arm64.zip", size: 7, sha256: h("2") },
} });
const INDEX = { schema: 1, versions: [entry("1.9.0"), entry("1.10.0-rc.1"), entry("1.10.0")] };

describe("7.5: Scoop owns only the manager", () => {
	test("PS-SCOOP / DL-MANAGED-UPDATE: newest manager has Windows assets, shim and explicit ownership only", () => {
		const m = scoopManifests(INDEX, "xz-dev/dsh-bin") as Record<string, any>;
		expect(Object.keys(m)).toEqual(["dsh"]);
		expect(m.dsh.version).toBe("1.10.0"); expect(m.dsh.bin).toBe("dsh.exe");
		expect(m.dsh.architecture["64bit"]).toEqual({ url: "https://github.com/xz-dev/dsh-bin/releases/download/manager-v1.10.0/manager-windows-x64.zip", hash: h("1") });
		expect(m.dsh.architecture.arm64.url).toEndWith("/manager-windows-arm64.zip");
		expect(m.dsh.post_install.join("\n")).toContain('.dsh-manager-install.json');
		expect(m.dsh.post_install.join("\n")).toContain('"owner":"scoop"');
		for (const key of ["persist", "pre_uninstall", "post_uninstall", "depends"]) expect(m.dsh[key]).toBeUndefined();
		for (const old of [".scoop.managed.lock", "addons/", "dsh-live", "dsh-office"]) expect(JSON.stringify(m)).not.toContain(old);
	});

	test.skipIf(!Bun.which("pwsh"))("PS-SCOOP / DL-MANAGED-SELF: real post_install writes the UTF-8 ownership marker and sets no attributes by path", () => {
		const t = mkdtempSync(join(tmpdir(), "dsh-scoop-hook-"));
		try {
			const manifest = scoopManifests(INDEX).dsh;
			execFileSync("pwsh", ["-NoProfile", "-Command", "$ErrorActionPreference = 'Stop'; $dir = $env:DSH_SCOOP_HOOK_DIR; " + manifest.post_install.join("; ")], { env: { ...process.env, DSH_SCOOP_HOOK_DIR: t } });
			const path = join(t, ".dsh-manager-install.json");
			expect(readFileSync(path, "utf8")).toBe('{"schema":1,"owner":"scoop"}');
			expect(manifest.post_install.join(" ")).not.toMatch(/SetAttributes|IsReadOnly/);
		} finally { rmSync(t, { recursive: true, force: true }); }
	});

	test.skipIf(!Bun.which("pwsh"))("7.5 review: post_install never follows or overwrites an existing marker (file, symlink, hardlink)", () => {
		const manifest = scoopManifests(INDEX).dsh;
		for (const kind of ["file", "symlink", "hardlink"]) {
			const t = mkdtempSync(join(tmpdir(), "dsh-scoop-hook-")), outside = mkdtempSync(join(tmpdir(), "dsh-scoop-outside-"));
			try {
				const credential = join(outside, "credential"), marker = join(t, ".dsh-manager-install.json");
				writeFileSync(credential, "SECRET KEEP");
				if (kind === "file") writeFileSync(marker, "USER FILE"); else if (kind === "symlink") symlinkSync(credential, marker); else linkSync(credential, marker);
				let failed = false;
				try { execFileSync("pwsh", ["-NoProfile", "-Command", "$ErrorActionPreference = 'Stop'; $dir = $env:DSH_SCOOP_HOOK_DIR; " + manifest.post_install.join("; ")], { env: { ...process.env, DSH_SCOOP_HOOK_DIR: t }, stdio: "pipe" }); }
				catch (e: any) { failed = true; expect(String(e.stderr)).toContain("refusing to replace existing"); }
				expect(failed).toBe(true);
				expect(readFileSync(credential, "utf8")).toBe("SECRET KEEP");
				if (kind === "file") expect(readFileSync(marker, "utf8")).toBe("USER FILE");
			} finally { rmSync(t, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
		}
	});

	test("7.5: invalid manager index, identity, protocol or asset refuses packaging", () => {
		for (const e of [{ ...entry("1.0.0"), tag: "../bad" }, entry("01.0.0"), entry("1.0.0-rc.01"), entry("1.0.0+"), { ...entry("1.0.0"), launchProtocols: [2] }, { ...entry("1.0.0"), launchProtocols: "91" }, { ...entry("1.0.0"), launchProtocols: ["1"] }, { ...entry("1.0.0"), launchProtocols: [-1, 1] }, { ...entry("1.0.0"), assets: {} },
			{ ...entry("1.0.0"), assets: { "windows-x64": { name: "$(touch bad).zip", size: 7, sha256: h("1") }, "windows-arm64": entry("1.0.0").assets["windows-arm64"] } }]) {
			expect(() => scoopManifests({ schema: 1, versions: [e] })).toThrow();
		}
		expect(() => scoopManifests({ schemaVersion: 2, channels: { release: [] } })).toThrow();
		expect(() => scoopManifests({ schema: 1, versions: [] })).toThrow();
		expect(() => scoopManifests({ schema: 1, versions: [entry("1.0.0"), entry("1.0.0+repair")] })).toThrow(/ambiguous/);
	});

	test("DL-MANAGED-REMOVE: publishing new manager index retires legacy manifests and is idempotent", () => {
		const t = mkdtempSync(join(tmpdir(), "dsh-scoop-"));
		try {
			const remote = join(t, "r.git"), seed = join(t, "seed");
			execFileSync("git", ["init", "-q", "--bare", remote]); execFileSync("git", ["init", "-q", seed]);
			execFileSync("git", ["-C", seed, "checkout", "-q", "--orphan", "scoop"]);
			for (const name of ["dsh-live", "dsh-office"]) writeFileSync(join(seed, `${name}.json`), "{}");
			execFileSync("git", ["-C", seed, "add", "dsh-live.json", "dsh-office.json"]);
			execFileSync("git", ["-C", seed, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "legacy manifests"]);
			execFileSync("git", ["-C", seed, "push", "-q", remote, "HEAD:scoop"]);
			writeFileSync(join(t, "manager-index.json"), JSON.stringify(INDEX));
			const env = { ...process.env, DSH_BIN_BUCKET_REMOTE: remote, DSH_BIN_INDEX_FILE: join(t, "manager-index.json"), GITHUB_REPOSITORY: "xz-dev/dsh-bin", RUNNER_TEMP: t };
			const script = join(import.meta.dir, "../scripts/publish-scoop-bucket.sh");
			expect(execFileSync("bash", [script], { env, encoding: "utf8" })).toContain("updated");
			expect(execFileSync("bash", [script], { env, encoding: "utf8" })).toContain("already current");
			const files = execFileSync("git", ["--git-dir", remote, "ls-tree", "-r", "--name-only", "scoop"], { encoding: "utf8" }).trim().split("\n");
			expect(files).toEqual(["bucket/dsh.json"]);
		} finally { rmSync(t, { recursive: true, force: true }); }
	});
});
