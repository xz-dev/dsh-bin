// After a self-update that changes the upstream dsh version: warn about profile plugins the new version
// will deny at startup, with the plugin version to move to. Warning only (the user's choice, 2026-09-29):
// the update itself has already happened. The rule is upstream's own `evaluatePluginCompatibility`,
// loaded from the new bundle, so the warning matches what startup will do; a bundle without it gets no
// warning.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type Manifest = { name?: string; version?: string; peerDependencies?: Record<string, string> };
type Issue = { name: string; version: string; peers: Record<string, string>; exempted: boolean };
export type Rules = {
	/** The version startup checks against: app-boot's own package.json, as upstream reads it. */
	runtimeVersion: string;
	evaluate(manifest: Manifest, exemptions: Record<string, string[]>, runtimeVersion: string): Issue | undefined;
	exemptions(profileDir: string): Record<string, string[]>;
};
/** A plugin version that the new dsh accepts, and the command that installs it. */
export type Suggestion = { version: string; command: string } | undefined;
export type Finder = (dep: { profile: string; name: string; spec: string }, accepts: (m: Manifest) => boolean) => Promise<Suggestion>;
export type Incompatible = { profile: string; name: string; version: string; spec: string; peers: Record<string, string>; suggestion: Suggestion };

/**
 * Upstream's compatibility rule from the bundle's app, or undefined when this upstream has none (older
 * dsh has no peer check). Throws when the rule exists but cannot be loaded.
 */
export async function loadRules(bundleDir: string): Promise<Rules | undefined> {
	let entry: string;
	try {
		entry = Bun.resolveSync("@deepseek-ai/dsh-app-boot", join(bundleDir, "app"));
	} catch {
		return undefined; // No app-boot in this app: nothing enforces peers at startup either.
	}
	const m = await import(pathToFileURL(entry).href);
	if (typeof m.evaluatePluginCompatibility !== "function" || typeof m.readProfileVersionExemptions !== "function") return undefined;
	const runtimeVersion = readJson(join(entry, "..", "..", "package.json"))?.version;
	if (typeof runtimeVersion !== "string") throw new Error("dsh-app-boot has no version");
	return { runtimeVersion, evaluate: m.evaluatePluginCompatibility, exemptions: m.readProfileVersionExemptions };
}

/** The profiles root dsh uses: `$DSH_HOME` (blank means unset) or `~/.dsh`. */
export function profilesRoot(env = process.env): string {
	const home = env.DSH_HOME?.trim() ? env.DSH_HOME : join(homedir(), ".dsh");
	return join(home, "profiles");
}

const readJson = (file: string): any => {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
};

/** Direct plugin dependencies of every profile that `runtimeVersion` would deny. */
export async function findIncompatible(root: string, rules: Rules, find: Finder): Promise<Incompatible[]> {
	if (!existsSync(root)) return [];
	const found: Omit<Incompatible, "suggestion">[] = [];
	const accepts = new Map<string, (m: Manifest) => boolean>();
	for (const profile of readdirSync(root).sort()) {
		const dir = join(root, profile);
		const deps: Record<string, string> = readJson(join(dir, "package.json"))?.dependencies ?? {};
		let exemptions: Record<string, string[]>;
		try {
			exemptions = rules.exemptions(dir);
		} catch {
			exemptions = {};
		}
		accepts.set(profile, (m) => {
			try {
				const issue = rules.evaluate(m, exemptions, rules.runtimeVersion);
				return !issue || issue.exempted;
			} catch {
				return false;
			}
		});
		for (const [name, spec] of Object.entries(deps)) {
			const manifest: Manifest | undefined = readJson(join(dir, "node_modules", name, "package.json"));
			if (!manifest) continue;
			let issue: Issue | undefined;
			try {
				issue = rules.evaluate(manifest, exemptions, rules.runtimeVersion);
			} catch {
				continue; // Malformed manifests are upstream's diagnosis at startup, not a compatibility warning.
			}
			if (issue && !issue.exempted) found.push({ profile, name, version: issue.version, spec, peers: issue.peers });
		}
	}
	return Promise.all(found.map(async (f) => ({ ...f, suggestion: await find(f, accepts.get(f.profile)!).catch(() => undefined) })));
}

/** Warning lines for `findIncompatible`'s result (none when everything is compatible). */
export function formatWarning(runtimeVersion: string, list: Incompatible[]): string[] {
	if (!list.length) return [];
	const lines = [`warning: ${list.length} profile plugin${list.length === 1 ? "" : "s"} do not support dsh ${runtimeVersion}; startup will disable ${list.length === 1 ? "it" : "them"}:`];
	for (const i of list) {
		const ranges = [...new Set(Object.values(i.peers))].join(", ");
		const needs = ranges.length > 40 ? `${ranges.slice(0, 37)}...` : ranges;
		const fix = i.suggestion ? `update to ${i.suggestion.version}: ${i.suggestion.command}` : "no compatible version is published yet";
		lines.push(`  [${i.profile}] ${i.name} ${i.version} (needs dsh ${needs}) -> ${fix}`);
	}
	return lines;
}

const TIMEOUT = 10_000;
const newestFirst = (versions: string[]) => versions.filter((v) => Bun.semver.order(v, v) === 0).sort((a, b) => Bun.semver.order(b, a));

/** Suggest from the npm registry (registry specs) or the GitHub default branch (`github:` specs). */
export const findOnline: Finder = async ({ profile, name, spec }, accepts) => {
	const gh = /^github:([\w.-]+\/[\w.-]+?)(?:\.git)?(?:#(.+))?$/.exec(spec);
	if (gh) {
		const res = await fetch(`https://raw.githubusercontent.com/${gh[1]}/${gh[2] ?? "HEAD"}/package.json`, { signal: AbortSignal.timeout(TIMEOUT) });
		if (!res.ok) return undefined;
		const m = (await res.json()) as Manifest;
		return m.name === name && m.version && accepts(m) ? { version: m.version, command: `dsh plugin --profile ${profile} update ${name}` } : undefined;
	}
	if (/^[a-z]+:|^[./~]/i.test(spec)) return undefined; // file:, link:, npm: aliases, paths: nothing to look up.
	const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}`, {
		signal: AbortSignal.timeout(TIMEOUT),
		headers: { accept: "application/vnd.npm.install-v1+json" },
	});
	if (!res.ok) return undefined;
	const doc = (await res.json()) as { versions?: Record<string, Manifest> };
	for (const v of newestFirst(Object.keys(doc.versions ?? {}))) {
		if (accepts({ name, version: v, ...doc.versions![v] })) return { version: v, command: `dsh plugin --profile ${profile} add ${name}@${v}` };
	}
	return undefined;
};

/** The whole post-update check. Never fails the update; a check that could not run says so. */
export async function pluginCompatWarning(bundleDir: string, find: Finder = findOnline, root = profilesRoot()): Promise<string[]> {
	try {
		const rules = await loadRules(bundleDir);
		return rules ? formatWarning(rules.runtimeVersion, await findIncompatible(root, rules, find)) : [];
	} catch (error) {
		return [`warning: could not check profile plugins against the new dsh: ${error instanceof Error ? error.message : String(error)}`];
	}
}
