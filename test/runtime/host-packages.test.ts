// Integration (3.2): needs a built app tree. Set DSH_BIN_APP, or build work/app with scripts/build-app.mjs.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hostScope, packageSpecifiers } from "../../runtime/compat/host-packages.ts";

const appDir = resolve(process.env.DSH_BIN_APP ?? join(import.meta.dir, "../../work/app"));
const hasApp = existsSync(join(appDir, "lib/bin.js"));

function write(path: string, text: string) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
}

/** A profile plugin with its own nested copies of the host packages it imports. */
function fixtureProfile() {
	const dir = mkdtempSync(join(tmpdir(), "dsh-bin-profile-"));
	const plugin = join(dir, "node_modules/fixture-plugin");
	const local = (name: string, main: string) => {
		write(join(plugin, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", exports: { ".": "./index.js", "./*": "./*.js" } }));
		write(join(plugin, "node_modules", name, main), "export const localMarker = 1;\n");
	};
	local("@deepseek-ai/cordis", "index.js");
	local("@deepseek-ai/dsh-credentials", "invariant.js");
	local("@earendil-works/pi-ai", "providers/all.js");
	write(join(plugin, "package.json"), JSON.stringify({ name: "fixture-plugin", type: "module", main: "index.js" }));
	write(
		join(plugin, "index.js"),
		[
			'export * as cordis from "@deepseek-ai/cordis";',
			'export * as invariant from "@deepseek-ai/dsh-credentials/invariant";',
			'export * as providers from "@earendil-works/pi-ai/providers/all";',
			'export const cordisManifest = import.meta.resolve("@deepseek-ai/cordis/package.json");',
		].join("\n"),
	);
	return join(plugin, "index.js");
}

test.skipIf(!hasApp)("host scope is the first-party dependency and peer closure", () => {
	const scope = hostScope(appDir);
	expect(scope.has("@deepseek-ai/cordis")).toBe(true);
	expect(scope.has("@earendil-works/pi-ai")).toBe(true);
	expect([...scope.keys()].every((n) => /^@(deepseek-ai|earendil-works)\//.test(n))).toBe(true);
	// Other-platform native addons are installed but not reachable from the app package.
	expect([...scope.keys()].some((n) => n.startsWith("@deepseek-ai/node-addon-system-darwin"))).toBe(false);
});

test.skipIf(!hasApp)("wildcard exports expand to files; data exports are skipped", () => {
	const specs = packageSpecifiers("@earendil-works/pi-ai", join(appDir, "node_modules/@earendil-works/pi-ai"));
	expect(specs).toContain("@earendil-works/pi-ai");
	expect(specs).toContain("@earendil-works/pi-ai/providers/all");
	expect(specs.some((s) => s.endsWith(".json"))).toBe(false);
});

test.skipIf(!hasApp)("a profile plugin gets host singletons for root, subpath and wildcard imports", () => {
	const probe = join(import.meta.dir, "fixtures/identity-probe.ts");
	const r = Bun.spawnSync([process.execPath, probe, appDir, fixtureProfile()], { stderr: "pipe" });
	expect(r.stderr.toString()).toBe("");
	const out = JSON.parse(r.stdout.toString());
	expect(out).toMatchObject({
		service: true,
		subpath: true,
		wildcard: true,
		localShadowed: true,
		invocation: true,
		wrappedIsContext: true,
		manifest: `file://${join(appDir, "node_modules/@deepseek-ai/cordis/package.json")}`,
	});
	expect(out.counts.packages).toBeGreaterThan(200);
});
