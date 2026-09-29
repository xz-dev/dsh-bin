// Post-update warning for profile plugins the new dsh would deny (user decision 2026-09-29: warn only,
// with the version to move to).
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Finder, findIncompatible, formatWarning, loadRules, pluginCompatWarning, profilesRoot, type Rules } from "../../runtime/update/plugin-compat.ts";

const dir = mkdtempSync(join(tmpdir(), "plugin-compat-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const write = (file: string, value: unknown) => {
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
};

// The same rule as upstream's: any @deepseek-ai/dsh* peer range the runtime does not satisfy, unless
// exempted for that exact version.
const rules: Rules = {
	runtimeVersion: "0.2.0",
	evaluate(m, exemptions, runtime) {
		const peers = Object.fromEntries(Object.entries(m.peerDependencies ?? {}).filter(([n, r]) => n.startsWith("@deepseek-ai/dsh") && !Bun.semver.satisfies(runtime, r)));
		if (!Object.keys(peers).length) return undefined;
		return { name: m.name!, version: m.version!, peers, exempted: exemptions[`${m.name}@${m.version}`]?.includes(runtime) === true };
	},
	exemptions: (profileDir) => {
		try {
			return JSON.parse(require("node:fs").readFileSync(join(profileDir, "compatibility.json"), "utf8"));
		} catch {
			return {};
		}
	},
};

function profile(root: string, name: string, deps: Record<string, [spec: string, version: string, peer?: string]>, compat?: object) {
	const p = join(root, name);
	write(join(p, "package.json"), { dependencies: Object.fromEntries(Object.entries(deps).map(([n, [spec]]) => [n, spec])) });
	for (const [n, [, version, peer]] of Object.entries(deps)) {
		write(join(p, "node_modules", n, "package.json"), { name: n, version, peerDependencies: peer ? { "@deepseek-ai/dsh-agent": peer, cordis: "^4" } : {} });
	}
	if (compat) write(join(p, "compatibility.json"), compat);
}

test("finds denied direct plugins per profile, honours exemptions, and asks for a suggestion", async () => {
	const root = join(dir, "profiles");
	profile(root, "tui", {
		"dsh-tui": ["0.11.1", "0.11.1", "0.1.7"],
		"dsh-notify": ["github:xz-dev/dsh-notify", "0.2.0", "0.1.7"],
		"dsh-ok": ["^1", "1.0.0", "^0.2.0"],
		"dsh-exempt": ["1.0.0", "1.0.0", "0.1.7"],
		"not-installed": ["1.0.0", "1.0.0"],
	}, { "dsh-exempt@1.0.0": ["0.2.0"] });
	rmSync(join(root, "tui", "node_modules", "not-installed"), { recursive: true });
	profile(root, "headless", { "dsh-tui": ["0.11.1", "0.11.1", "0.1.7"] });
	const asked: string[] = [];
	const find: Finder = async (dep, accepts) => {
		asked.push(`${dep.profile}:${dep.name}:${dep.spec}`);
		// The acceptance callback applies the profile's rule to a candidate manifest.
		expect(accepts({ name: dep.name, version: "9.0.0", peerDependencies: { "@deepseek-ai/dsh-agent": "^0.2.0" } })).toBe(true);
		expect(accepts({ name: dep.name, version: "9.0.0", peerDependencies: { "@deepseek-ai/dsh-agent": "0.1.7" } })).toBe(false);
		return dep.name === "dsh-tui" ? { version: "0.11.2", command: `dsh plugin --profile ${dep.profile} add dsh-tui@0.11.2` } : undefined;
	};
	const list = await findIncompatible(root, rules, find);
	expect(list.map((i) => `${i.profile}:${i.name}@${i.version}`)).toEqual(["headless:dsh-tui@0.11.1", "tui:dsh-tui@0.11.1", "tui:dsh-notify@0.2.0"]);
	expect(asked.sort()).toEqual(["headless:dsh-tui:0.11.1", "tui:dsh-notify:github:xz-dev/dsh-notify", "tui:dsh-tui:0.11.1"]);
	expect(formatWarning("0.2.0", list)).toEqual([
		"warning: 3 profile plugins do not support dsh 0.2.0; startup will disable them:",
		"  [headless] dsh-tui 0.11.1 (needs dsh 0.1.7) -> update to 0.11.2: dsh plugin --profile headless add dsh-tui@0.11.2",
		"  [tui] dsh-tui 0.11.1 (needs dsh 0.1.7) -> update to 0.11.2: dsh plugin --profile tui add dsh-tui@0.11.2",
		"  [tui] dsh-notify 0.2.0 (needs dsh 0.1.7) -> no compatible version is published yet",
	]);
});

test("a failing lookup still warns, and nothing to report prints nothing", async () => {
	const root = join(dir, "p2");
	profile(root, "a", { x: ["1.0.0", "1.0.0", "0.1.7"] });
	const list = await findIncompatible(root, rules, async () => {
		throw new Error("offline");
	});
	expect(formatWarning("0.2.0", list)).toEqual(["warning: 1 profile plugin do not support dsh 0.2.0; startup will disable it:", "  [a] x 1.0.0 (needs dsh 0.1.7) -> no compatible version is published yet"]);
	expect(formatWarning("0.2.0", [])).toEqual([]);
	expect(await findIncompatible(join(dir, "missing"), rules, async () => undefined)).toEqual([]);
});

test("rules come from the bundle's app-boot; a bundle without them gives no warning", async () => {
	const bundle = join(dir, "bundle");
	const boot = join(bundle, "app", "node_modules", "@deepseek-ai", "dsh-app-boot");
	write(join(boot, "package.json"), { name: "@deepseek-ai/dsh-app-boot", version: "0.2.0-rc.1", type: "module", exports: { ".": "./lib/index.js" } });
	write(join(boot, "lib", "index.js"), "export const evaluatePluginCompatibility = (m, e, v) => ({ name: m.name, version: m.version, peers: { '@deepseek-ai/dsh': v }, exempted: false });\nexport const readProfileVersionExemptions = () => ({});\n");
	const loaded = await loadRules(bundle);
	expect(loaded?.runtimeVersion).toBe("0.2.0-rc.1");
	const root = join(dir, "p3");
	profile(root, "a", { x: ["1.0.0", "1.0.0"] });
	expect(await pluginCompatWarning(bundle, async () => undefined, root)).toEqual([
		"warning: 1 profile plugin do not support dsh 0.2.0-rc.1; startup will disable it:",
		"  [a] x 1.0.0 (needs dsh 0.2.0-rc.1) -> no compatible version is published yet",
	]);
	expect(await loadRules(join(dir, "nothing"))).toBeUndefined();
	expect(await pluginCompatWarning(join(dir, "nothing"), async () => undefined, root)).toEqual([]);
	// A rule that exists but cannot load is reported, never mistaken for "all compatible".
	const broken = join(dir, "broken");
	const bootB = join(broken, "app", "node_modules", "@deepseek-ai", "dsh-app-boot");
	write(join(bootB, "package.json"), { name: "@deepseek-ai/dsh-app-boot", version: "0.2.0", type: "module", exports: { ".": "./lib/index.js" } });
	write(join(bootB, "lib", "index.js"), "import 'missing-dependency-xyz';\n");
	const out = await pluginCompatWarning(broken, async () => undefined, root);
	expect(out).toHaveLength(1);
	expect(out[0]).toStartWith("warning: could not check profile plugins against the new dsh: ");
});

test("profiles root follows DSH_HOME like upstream (blank means unset)", () => {
	expect(profilesRoot({ DSH_HOME: "/x/h" })).toBe(join("/x/h", "profiles"));
	expect(profilesRoot({ DSH_HOME: "  " })).toMatch(/\.dsh[\\/]profiles$/);
});
