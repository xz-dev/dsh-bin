import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { COMPAT_SPECIFIER, CONFIG_SITES, PROFILE_SITES, RULES, rewriteProfileSites, transformApp } from "../../scripts/transform-app.mjs";

const IMPORT = 'import { stripTypeScriptTypes } from "node:module";\n';

function fixture(files: Record<string, string>) {
	const app = mkdtempSync(join(tmpdir(), "transform-app-"));
	for (const [rel, text] of Object.entries(files)) {
		mkdirSync(dirname(join(app, rel)), { recursive: true });
		writeFileSync(join(app, rel), text);
	}
	return app;
}

const known = RULES[0].files[0];
const strip = [RULES[0]];

test("rewrites exactly the known file to the compat virtual", () => {
	const app = fixture({
		[known]: `${IMPORT}export const f = (s) => stripTypeScriptTypes(s);\n`,
		"node_modules/@deepseek-ai/dsh-ptc-runtime-node/lib/types/index.d.ts": "export declare function stripTypeScriptTypes(): void;\n",
		"node_modules/other/lib/index.js": "export {};\n",
	});
	expect(transformApp(app, strip, {})).toEqual([known]);
	const out = readFileSync(join(app, known), "utf8");
	expect(out).toContain(`from "${COMPAT_SPECIFIER}"`);
	expect(out).not.toContain("node:module");
});

test("an unknown extra occurrence fails the build", () => {
	const app = fixture({
		[known]: `${IMPORT}stripTypeScriptTypes("");\n`,
		"node_modules/new-pkg/lib/index.mjs": `${IMPORT}stripTypeScriptTypes("");\n`,
	});
	expect(() => transformApp(app, strip, {})).toThrow(/occurrences changed/);
});

test("a missing known occurrence fails the build", () => {
	expect(() => transformApp(fixture({ "node_modules/x/index.js": "export {};\n" }), strip, {})).toThrow(/occurrences changed/);
});

test("an unexpected import form fails the build", () => {
	const app = fixture({ [known]: 'import { createRequire, stripTypeScriptTypes } from "node:module";\n' });
	expect(() => transformApp(app, strip, {})).toThrow(/known import form/);
});

test("rewrites node:sea in skill-office alongside stripTypeScriptTypes", () => {
	const sea = RULES[1].files[0];
	const app = fixture({
		[known]: `${IMPORT}stripTypeScriptTypes("");\n`,
		[sea]: 'import { isSea } from "node:sea";\nisSea();\n',
	});
	expect(transformApp(app, RULES, {})).toEqual([known, sea].sort());
	expect(readFileSync(join(app, sea), "utf8")).toStartWith(`import { isSea } from "${COMPAT_SPECIFIER}";`);
	// A second run over the rewritten tree (a stale local app) is a no-op, not a failure.
	const before = readFileSync(join(app, sea), "utf8");
	expect(transformApp(app, RULES, {})).toEqual([known, sea].sort());
	expect(readFileSync(join(app, sea), "utf8")).toBe(before);
});

// A condensed dsh-app-boot: the profile dir, the profiles tree and the patch/root file sites.
const BOOT = `import { join } from "node:path";
const PROFILES_DIR = "profiles";
const PROFILE_PATCH_FILENAME = "cordis.patch.yml";
const PROFILE_ROOT_FILENAME = "cordis.yml";
export function resolveProfileDir(name, home) {
	return join(home, PROFILES_DIR, name);
}
export function tree(home) {
	const profilesDir = join(home, PROFILES_DIR);
	return profilesDir;
}
export const patchOf = (dir) => join(dir, PROFILE_PATCH_FILENAME);
export const rootOf = (dir) => join(dir, PROFILE_ROOT_FILENAME);
`;
const BOOT_REL = "node_modules/@deepseek-ai/dsh-app-boot/lib/index.js";

test("RB-HOME/CS-PLUGIN-BASE: validated process mapping splits patch from plugin base, standalone stays upstream", async () => {
	const app = fixture({ [BOOT_REL]: BOOT, "node_modules/express/lib/view.js": "const p = join(dir, file);\n" });
	const sites = { [BOOT_REL]: { dir: 1, root: 1, file: 2 } };
	expect(transformApp(app, [], sites)).toEqual([BOOT_REL]);
	const before = readFileSync(join(app, BOOT_REL), "utf8");
	transformApp(app, [], sites); expect(readFileSync(join(app, BOOT_REL), "utf8")).toBe(before);
	expect(readFileSync(join(app, "node_modules/express/lib/view.js"), "utf8")).toBe("const p = join(dir, file);\n");
	const home = mkdtempSync(join(tmpdir(), "snap-home-"));
	const snap = mkdtempSync(join(tmpdir(), "plugins-"));
	const config = mkdtempSync(join(tmpdir(), "config-"));
	const helper = new URL("../../runtime/compat/config-paths.ts", import.meta.url).pathname;
	const probe = (managed: boolean) => `import { installConfigPaths } from ${JSON.stringify(helper)};
		installConfigPaths(${managed ? [snap, config, home].map(v => JSON.stringify(v)).join(",") : ""});
		const m = await import(${JSON.stringify(join(app, BOOT_REL))}); const d = m.resolveProfileDir("tui", ${JSON.stringify(home)});
		console.log(JSON.stringify([d, m.tree(${JSON.stringify(home)}), m.patchOf(d), m.rootOf(d)]));`;
	for (const managed of [true, false]) {
		const p = Bun.spawnSync([process.execPath, "-e", probe(managed)], { env: { ...process.env, DSH_BIN_CONFIG_SNAPSHOT_DIR: "/untrusted" } });
		expect(p.exitCode, p.stderr.toString()).toBe(0);
		expect(JSON.parse(p.stdout.toString())).toEqual(managed ? [join(snap, "profiles/tui"), join(snap, "profiles"), join(config, "profiles/tui/cordis.patch.yml"), join(snap, "profiles/tui/cordis.yml")] : [join(home, "profiles/tui"), join(home, "profiles"), join(home, "profiles/tui/cordis.patch.yml"), join(home, "profiles/tui/cordis.yml")]);
	}
});

test("changed transformed counts and retired shared-home transforms fail closed on re-run", () => {
	const sites = { [BOOT_REL]: { dir: 1, root: 1, file: 2 } };
	const app = fixture({ [BOOT_REL]: BOOT }); transformApp(app, [], sites);
	const file = join(app, BOOT_REL);
	writeFileSync(file, readFileSync(file, "utf8").replace('__dshBinPaths.profileFile(dir, PROFILE_PATCH_FILENAME)', 'join(dir, "changed.yml")'));
	expect(() => transformApp(app, [], sites)).toThrow(/profile path sites changed/);
	expect(() => rewriteProfileSites("const __dshBinProfiles = {};" )).toThrow(/retired profile adaptation/);
});

test("LibreOffice Kit packages are not profile code: their look-alike joins are left alone", () => {
	// windows-x64 build, 2026-09-30: the native engine ships sources/scripts/stage-native.mjs with join(dir, file).
	const engine = "node_modules/@deepseek-ai/libreoffice-kit-win32-x64/sources/scripts/stage-native.mjs";
	const text = 'import { join } from "node:path";\nexport const f = (dir, file) => join(dir, file);\n';
	const app = fixture({ [BOOT_REL]: BOOT, [engine]: text, "node_modules/@deepseek-ai/libreoffice-kit/lib/index.js": text });
	expect(transformApp(app, [], { [BOOT_REL]: { dir: 1, root: 1, file: 2 } })).toEqual([BOOT_REL]);
	expect(readFileSync(join(app, engine), "utf8")).toBe(text);
});

test("a changed profile site list fails the build", () => {
	const app = fixture({ [BOOT_REL]: BOOT });
	expect(() => transformApp(app, [], { [BOOT_REL]: { dir: 1, root: 1, file: 3 } })).toThrow(/profile path sites changed/);
});

function configurationFixture() {
	const files: Record<string, string> = { "package.json": '{"version":"0.2.0-rc.2"}' };
	for (const { file, from, count } of CONFIG_SITES) files[file] = (files[file] ?? "") + "\n" + Array(count).fill(from).join("\n");
	return fixture(files);
}
test("configuration site table fails closed for every changed known site; no partial writes", () => {
	for (const { file, from } of CONFIG_SITES) {
		const app = configurationFixture(), path = join(app, file);
		writeFileSync(path, readFileSync(path, "utf8").replace(from, "upstream changed site"));
		const before = readFileSync(path, "utf8");
		expect(() => transformApp(app, [], {}, CONFIG_SITES)).toThrow(/configuration path site changed/);
		expect(readFileSync(path, "utf8")).toBe(before);
	}
});
test("unknown config path in another first-party file and unsupported upstream version fail closed", () => {
	const app = configurationFixture();
	writeFileSync(join(app, "node_modules/@deepseek-ai/dsh-settings/lib/new.js"), 'const path = join(home, "settings.yaml");');
	expect(() => transformApp(app, [], {}, CONFIG_SITES)).toThrow(/unknown configuration path site/);
	const unknown = fixture({ "package.json": '{"version":"0.2.0-rc.3"}' });
	expect(() => transformApp(unknown, [], PROFILE_SITES)).toThrow(/unsupported configuration path version/);
});
test("configuration transform re-run preserves counts instead of trusting old marker", () => {
	const app = configurationFixture(); transformApp(app, [], {}, CONFIG_SITES);
	const file = join(app, CONFIG_SITES[0].file), first = readFileSync(file, "utf8");
	transformApp(app, [], {}, CONFIG_SITES); expect(readFileSync(file, "utf8")).toBe(first);
	writeFileSync(file, first.replace(CONFIG_SITES[0].to, "changed-after-transform"));
	expect(() => transformApp(app, [], {}, CONFIG_SITES)).toThrow(/configuration path site changed/);
});
