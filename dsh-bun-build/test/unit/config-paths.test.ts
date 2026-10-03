import { expect, test } from "bun:test";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigPaths } from "../../runtime/compat/config-paths.ts";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "config-paths-"));
	const config = join(root, "C"), plugins = join(root, "P"), home = join(root, "home");
	for (const dir of [config, plugins, home]) mkdirSync(dir, { mode: 0o700 });
	return { root, config, plugins, home, paths: createConfigPaths(plugins, config, home) };
}
test("private config path resolution covers default/relative/absolute/home, never cwd or raw env", () => {
	const { config, paths } = fixture();
	const fallback = () => { throw new Error("must not fall back"); };
	expect(paths.credentialFile(undefined, undefined, fallback)).toBe(join(config, ".credentials.yaml"));
	expect(paths.credentialFile("accounts/work.yaml", undefined, fallback)).toBe(join(config, "accounts/work.yaml"));
	expect(paths.credentialFile(join(config, "work.yaml"), undefined, fallback)).toBe(join(config, "work.yaml"));
	expect(paths.credentialFile(undefined, join(config, "accounts"), fallback)).toBe(join(config, "accounts/.credentials.yaml"));
	expect(createConfigPaths().credentialFile("outside", "home", () => "upstream")).toBe("upstream");
});
test("outside, other C, parent traversal, symlink, hardlink, loose roots/parents/files fail before any open", () => {
	const { config, root, paths } = fixture();
	const outside = join(root, "outside.yaml"); writeFileSync(outside, "synthetic-outside", { mode: 0o600 });
	for (const path of [outside, "../outside.yaml", "accounts/../../outside.yaml", join(root, "C2/.credentials.yaml")]) expect(() => paths.credentialFile(path, undefined, () => "fallback")).toThrow(/boundary/);
	expect(() => paths.credentialFile(undefined, root, () => "fallback")).toThrow(/boundary/);
	symlinkSync(outside, join(config, "escape.yaml"));
	expect(() => paths.credentialFile("escape.yaml", undefined, () => "fallback")).toThrow(/boundary/);
	symlinkSync(join(root, "missing"), join(config, "dangling"));
	expect(() => paths.check(join(config, "dangling/secret"))).toThrow();
	linkSync(outside, join(config, "hard.yaml"));
	expect(() => paths.check(join(config, "hard.yaml"))).toThrow(/boundary/);
	mkdirSync(join(config, "loose"), { mode: 0o755 });
	expect(() => paths.check(join(config, "loose/secret"))).toThrow(/boundary/);
	writeFileSync(join(config, "loose.yaml"), "not-private", { mode: 0o644 });
	expect(() => paths.check(join(config, "loose.yaml"))).toThrow(/boundary/);
	chmodSync(config, 0o755); expect(() => paths.check(join(config, "missing.yaml"))).toThrow(/boundary/);
	expect(paths.checkWatchPath(join(root, "project/manifest.json"))).toBe(join(root, "project/manifest.json"));
	expect(() => paths.checkWatchPath(join(config, "escape.yaml"))).toThrow(/boundary/);
	expect(readFileSync(outside, "utf8")).toBe("synthetic-outside");
});
test("HOME aliases map before env open; unrelated project .env stays upstream", () => {
	const { paths, config, home, root } = fixture();
	symlinkSync(home, join(root, "home-alias"));
	expect(paths.envFile(join(root, "home-alias"))).toBe(join(config, ".env"));
	expect(paths.envFile(join(home, "."))).toBe(join(config, ".env"));
	expect(paths.isManagedHome(join(root, "home-alias"))).toBe(true);
	expect(paths.envFile(join(root, "project"))).toBe(join(root, "project/.env"));
	expect(createConfigPaths().envFile(home)).toBe(join(home, ".env"));
});

test("startup audit escalates managed boundary code only, not ordinary optional errors or standalone", () => {
	const { paths } = fixture();
	expect(() => paths.assertStartup([{ outcome: { kind: "failed", error: new Error("ordinary optional failure") } }])).not.toThrow();
	expect(() => paths.assertStartup([{ outcome: { kind: "failed", error: { code: "DSH_CONFIG_BOUNDARY" } } }])).toThrow(/boundary/);
	expect(() => createConfigPaths().assertStartup([{ outcome: { kind: "failed", error: { code: "DSH_CONFIG_BOUNDARY" } } }])).not.toThrow();
});
