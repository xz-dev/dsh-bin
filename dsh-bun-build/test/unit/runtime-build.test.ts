// RL-RUNTIME-BUILD / RB-CONTENTS: build an archive from a runtime-only checkout.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readZipEntries } from "../../runtime/zip.ts";
import { PROFILE_SITES, RULES } from "../../scripts/transform-app.mjs";
import { hostTargetId, target } from "../../scripts/targets.mjs";

const ROOT = resolve(import.meta.dir, "../..");
const REPO = resolve(ROOT, "..");

test("RL-OWNERSHIP: root holds two product directories, desc/ and openspec/; no generic scripts/, docs/ or install.sh", () => {
	for (const dir of ["dsh-manager", "dsh-bun-build", "desc", "openspec"]) expect(existsSync(join(REPO, dir))).toBe(true);
	for (const retired of ["scripts", "docs", "install.sh"]) expect(existsSync(join(REPO, retired))).toBe(false);
});

test("RL-OWNERSHIP: manager packaging scripts belong to dsh-manager, not the runtime build", () => {
	for (const name of ["create-scoop-manifest.mjs", "publish-scoop-bucket.sh", "gentoo-ebuild.mjs", "gentoo-layout-check.sh"]) {
		expect(existsSync(join(REPO, "dsh-manager/scripts", name))).toBe(true);
		expect(existsSync(join(ROOT, "scripts", name))).toBe(false);
	}
});

test("RL-RUNTIME-BUILD / RB-CONTENTS: runtime-only checkout builds one v1 archive with no Zig or manager", () => {
	const cache = join(homedir(), ".cache");
	mkdirSync(cache, { recursive: true });
	const dir = mkdtempSync(join(cache, "dsh-runtime-build-"));
	try {
		for (const name of ["scripts", "runtime", "package.json"]) cpSync(join(ROOT, name), join(dir, name), { recursive: true });
		const put = (path: string, text: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
		const app = join(dir, "work/app");
		put(join(app, "package.json"), '{"name":"runtime-build-fixture","type":"module"}');
		put(join(app, "lib/bin.js"), `${readFileSync(join(ROOT, "test/fixtures/fixed-cli.js"), "utf8")}\nexport async function runCli() {}\n`);
		mkdirSync(join(app, "node_modules"), { recursive: true });
		for (const rule of RULES) for (const file of rule.files) put(join(app, file), rule.marker === "stripTypeScriptTypes" ? 'import { stripTypeScriptTypes } from "node:module";\n' : 'import { isSea } from "node:sea";\n');
		for (const [file, sites] of Object.entries(PROFILE_SITES)) {
			put(join(app, file), [
				'import { join } from "node:path";',
				...Array(sites.dir ?? 0).fill('function profileDir(name, home) { return join(home, PROFILES_DIR, name); }'),
				...Array(sites.root ?? 0).fill('const profilesDir = join(home, PROFILES_DIR);'),
				...Array(sites.file ?? 0).fill('join(dir, PROFILE_PATCH_FILENAME);'),
			].join("\n"));
		}
		const t = target(hostTargetId());
		put(join(dir, `work/pnpm-${t.os === "windows" ? "windows" : t.os}-${t.arch}/dist/pnpm.mjs`), "// fixture pnpm\n");
		const path = join(dir, "path");
		mkdirSync(path);
		// Empty PATH: build Bun via its absolute path, no zig/bun/node subprocess lookup.
		const out = join(dir, "out");
		const script = `import { localBuild } from ${JSON.stringify(join(dir, "scripts/local-build.mjs"))};
			const built = localBuild({ out: ${JSON.stringify(out)}, channel: "release", run: 1, upstreamCommit: "${"a".repeat(40)}", upstreamCommitTime: "2026-09-01T00:00:00.000Z" });
			console.log(JSON.stringify({ id: built.id, zip: built.zip }));`;
		const result = spawnSync(process.execPath, ["-e", script], {
			cwd: dir, timeout: 180_000, encoding: "utf8",
			env: { ...process.env, PATH: path, DSH_BUILDER_COMMIT: "b".repeat(40) },
		});
		expect(result.stderr).not.toMatch(/\b(zig|manager)\b/i);
		expect(result.status).toBe(0);
		const built = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
		const entries = readZipEntries(readFileSync(built.zip)).map((e) => e.name);
		expect(entries).toContain("bundle.json");
		expect(entries).toContain("completion.json");
		expect(entries).toContain(t.executable);
		expect(entries.filter((p) => /^(bundles\/|dsh(?:\.exe)?$|dsh-manager\/)/.test(p))).toEqual([]);
		const manifests = entries.filter((p) => p === "bundle.json");
		expect(manifests).toHaveLength(1);
		const scratch = join(out, `.scratch-${built.id}/root`);
		expect(JSON.parse(readFileSync(join(scratch, "bundle.json"), "utf8"))).toMatchObject({ kind: "dsh-runtime", schemaVersion: 1, launchProtocol: 2, entry: t.executable });
	} finally { rmSync(dir, { recursive: true, force: true }); }
}, 240_000);
