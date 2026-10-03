// Build-output transform (D3): Bun lacks some Node builtin exports (`node:module` stripTypeScriptTypes,
// the `node:sea` module), and Bun.plugin().module() cannot override `node:` builtins. Rewrite the known
// files that import them to the dsh-bin compat virtual module. Any unknown occurrence fails the build
// instead of the runtime.
// usage: bun scripts/transform-app.mjs <app-dir>
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const COMPAT_SPECIFIER = "dsh-bin:node-module-compat";
/** One rewrite per missing builtin: the marker that finds users, the exact files, and the import form. */
export const RULES = [
	{
		marker: "stripTypeScriptTypes",
		files: ["node_modules/@deepseek-ai/dsh-ptc-runtime-node/lib/index.js"],
		from: /^import \{ stripTypeScriptTypes \} from "node:module";$/m,
		to: `import { stripTypeScriptTypes } from "${COMPAT_SPECIFIER}";`,
	},
	{
		marker: '"node:sea"',
		files: ["node_modules/@deepseek-ai/dsh-skill-office/lib/index.js"],
		from: /^import \{ isSea \} from "node:sea";$/m,
		to: `import { isSea } from "${COMPAT_SPECIFIER}";`,
	},
];
export const KNOWN_FILES = RULES.flatMap((r) => r.files);

// One process-local mapping, installed only by validated runtime bootstrap; no HOME/env authority here.
export const PROFILE_HELPER = "__dshBinPaths";
export const CONFIG_SPECIFIER = "dsh-bin:config-paths";
const PROFILE_PRELUDE = `import { paths as ${PROFILE_HELPER} } from "${CONFIG_SPECIFIER}";\n`;
const FILE_SITE = /join\((dir|profileDir|profile\.dir|composed\.profile\.dir|loaded\.dir|this\.profile\.dir), (PROFILE_PATCH_FILENAME|PROFILE_ROOT_FILENAME|"cordis\.yml"|file)\)/g;
export const PROFILE_SITES = {
	"node_modules/@deepseek-ai/dsh-app-boot/lib/index.js": { dir: 1, root: 1, file: 4 },
	"node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js": { file: 1 },
	"node_modules/@deepseek-ai/dsh-plugin-manager/lib/types/index.js": { file: 1 },
	"lib/profile-boot-BZ2ZjNWi.js": { file: 3 },
	"lib/dump-config-BEDI-dNY.js": { file: 1 },
};
const FIRST_PARTY = /^(?:lib\/|node_modules\/@deepseek-ai\/(?!libreoffice-kit(?:-|\/)))/;
const DIR_SITE = /return join\(home, PROFILES_DIR, name\);/g;
const ROOT_SITE = /const profilesDir = join\(home, PROFILES_DIR\);/g;

/** Counts stay checked on re-runs too: undo ONLY exact generated forms before checking upstream sites. */
export function rewriteProfileSites(text) {
	if (text.includes("__dshBinProfiles")) throw new Error("retired profile adaptation; rebuild from upstream output");
	let source = text.replace(PROFILE_PRELUDE, "")
		.replace(/return __dshBinPaths\.dir\(name\) \?\? join\(home, PROFILES_DIR, name\);/g, "return join(home, PROFILES_DIR, name);")
		.replace(/const profilesDir = __dshBinPaths\.root\(\) \?\? join\(home, PROFILES_DIR\);/g, "const profilesDir = join(home, PROFILES_DIR);")
		.replace(/__dshBinPaths\.profileFile\((dir|profileDir|profile\.dir|composed\.profile\.dir|loaded\.dir|this\.profile\.dir), (PROFILE_PATCH_FILENAME|PROFILE_ROOT_FILENAME|"cordis\.yml"|file)\)/g, "join($1, $2)");
	const counts = { dir: 0, root: 0, file: 0 };
	let out = source
		.replace(DIR_SITE, () => (counts.dir++, `return ${PROFILE_HELPER}.dir(name) ?? join(home, PROFILES_DIR, name);`))
		.replace(ROOT_SITE, () => (counts.root++, `const profilesDir = ${PROFILE_HELPER}.root() ?? join(home, PROFILES_DIR);`))
		.replace(FILE_SITE, (_m, d, f) => (counts.file++, `${PROFILE_HELPER}.profileFile(${d}, ${f})`));
	for (const k of Object.keys(counts)) if (counts[k] === 0) delete counts[k];
	return { text: out, counts };
}

const rule = (file, from, to, count = 1) => ({ file, from, to, count });
const bootFile = "node_modules/@deepseek-ai/dsh-app-boot/lib/index.js";
const credFile = "node_modules/@deepseek-ai/dsh-credentials-local/lib/index.js";
// Actual rc.2 built paths, including duplicate settings types module and all credential opens/watch/lock parents.
export const CONFIG_SITES = [
	rule(bootFile, 'async function auditStartupEntries(ctx, binName, warn = (line) => void process.stderr.write(line)) {\n\tconst failures = await inactiveEntries(ctx);', 'async function auditStartupEntries(ctx, binName, warn = (line) => void process.stderr.write(line)) {\n\tconst failures = await inactiveEntries(ctx);\n\t__dshBinPaths.assertStartup(failures);'),
	rule(bootFile, 'if (!existsSync(patchPath)) writeFileSync(patchPath, PROFILE_PATCH_TEMPLATE);', 'if (!existsSync(patchPath)) writeFileSync(patchPath, PROFILE_PATCH_TEMPLATE, __dshBinPaths.privateWriteOptions);'),
	rule(bootFile, 'loadOptionalPatches(binName, context.patchPath)', 'loadOptionalPatches(binName, __dshBinPaths.check(context.patchPath))'),
	rule("node_modules/@deepseek-ai/dsh-hmr/lib/index.js", 'async function watchConfig(ctx, filename, options, refresh, inTransaction = () => false) {', 'async function watchConfig(ctx, filename, options, refresh, inTransaction = () => false) {\n\t__dshBinPaths.checkWatchPath(filename);'),
	rule(bootFile, 'join(context.home, "cordis.patch.yml")', '__dshBinPaths.configFile(context.home, "cordis.patch.yml")'),
	rule("lib/profile-boot-BZ2ZjNWi.js", 'join(resolveDshHome(), PROFILE_PATCH_FILENAME)', '__dshBinPaths.configFile(resolveDshHome(), PROFILE_PATCH_FILENAME)'),
	rule("node_modules/@deepseek-ai/dsh-hmr/lib/index.js", 'const patchFiles = [profile.patchPath, join(profile.home, PROFILE_PATCH_FILENAME)];', 'const patchFiles = [__dshBinPaths.check(profile.patchPath), __dshBinPaths.configFile(profile.home, PROFILE_PATCH_FILENAME)];'),
	rule(bootFile, 'process.loadEnvFile(resolve(dir, ".env"))', 'process.loadEnvFile(__dshBinPaths.envFile(dir))'),
	rule(bootFile, 'const path = resolve(dir, ".env");', 'const path = __dshBinPaths.envFile(dir);'),
	rule(bootFile, 'const isHome = resolve(dir) === home;', 'const isHome = resolve(dir) === home || __dshBinPaths.isManagedHome(dir);'),
	rule(bootFile, 'const project = readEnvLayer(binName, cwd, warn, home);', 'const project = __dshBinPaths.isManagedHome(cwd) ? void 0 : readEnvLayer(binName, cwd, warn, home);'),
	rule(bootFile, 'const user = home === resolve(cwd) ? void 0 : readEnvLayer(binName, home, warn, home);', 'const user = !__dshBinPaths.isManagedHome(home) && home === resolve(cwd) ? void 0 : readEnvLayer(binName, home, warn, home);'),
	...['node_modules/@deepseek-ai/dsh-settings/lib/index.js', 'node_modules/@deepseek-ai/dsh-settings/lib/types/index.js'].flatMap(file => {
		const q = file.includes('/types/') ? "'" : '"';
		return [rule(file, `join(profile.home, ${q}settings.yaml${q})`, `__dshBinPaths.configFile(profile.home, ${q}settings.yaml${q})`),
			rule(file, 'const imported = `${path}.imported`;', 'const imported = __dshBinPaths.check(`${path}.imported`);'),
			rule(file, 'await rename(path, imported);', 'await rename(__dshBinPaths.check(path), __dshBinPaths.check(imported));'),
			rule(file, `readFile(imported, ${q}utf8${q})`, `readFile(__dshBinPaths.check(imported), ${q}utf8${q})`)];
	}),
	rule(credFile, 'resolve(config.path ?? join(resolveDshHome(config.dshHome), ".credentials.yaml"))', '__dshBinPaths.credentialFile(config.path, config.dshHome === void 0 ? void 0 : resolveDshHome(config.dshHome), () => resolve(config.path ?? join(resolveDshHome(config.dshHome), ".credentials.yaml")))'),
	rule(credFile, 'async function assertOwnerOnly(filename) {', 'async function assertOwnerOnly(filename) {\n\t__dshBinPaths.check(filename);'),
	rule(credFile, 'canonicalizeWatchPath(this.spec.filename)', 'canonicalizeWatchPath(__dshBinPaths.check(this.spec.filename))'),
	rule(credFile, 'mkdir(dirname(this.spec.filename)', 'mkdir(dirname(__dshBinPaths.check(this.spec.filename))', 3),
	rule(credFile, 'readFile(this.spec.filename, "utf8")', 'readFile(__dshBinPaths.check(this.spec.filename), "utf8")', 3),
	rule(credFile, 'writeFileAtomic(this.spec.filename,', 'writeFileAtomic(__dshBinPaths.check(this.spec.filename),', 4),
	rule(credFile, 'withFileLock(this.spec.filename,', 'withFileLock(__dshBinPaths.check(this.spec.filename),', 4),
	rule('node_modules/@deepseek-ai/dsh-config-editor/lib/index.js', 'return this.ownerContext.profileContext.patchPath;', 'return __dshBinPaths.check(this.ownerContext.profileContext.patchPath);'),
	rule('node_modules/@deepseek-ai/dsh-config-editor/lib/index.js', 'readFile(path, "utf8")', 'readFile(__dshBinPaths.check(path), "utf8")'),
	rule('node_modules/@deepseek-ai/dsh-config-editor/lib/index.js', 'writeFileAtomic(path,', 'writeFileAtomic(__dshBinPaths.check(path),', 2),
	rule('node_modules/@deepseek-ai/dsh-hmr/lib/index.js', 'const target = await findWatchRoot(filename);', 'const target = await findWatchRoot(filename);\n\t__dshBinPaths.checkWatchPath(filename);'),
	rule('node_modules/@deepseek-ai/dsh-hmr/lib/index.js', 'return readFileSync(filename, "utf8");', 'return readFileSync(__dshBinPaths.checkWatchPath(filename), "utf8");'),
];
export const CONFIG_SITES_BY_VERSION = { "0.2.0-rc.2": CONFIG_SITES };
const occurrences = (text, needle) => text.split(needle).length - 1;
function rewriteConfigSites(texts, sites, rewritten) {
	for (const { file, from, to, count } of sites) {
		const text = texts.get(file);
		if (text === undefined) throw new Error(`configuration path site missing: ${file}`);
		const source = text.split(to).join(from);
		const found = occurrences(source, from);
		if (found !== count) throw new Error(`${file}: configuration path site changed (${from}): expected ${count}, found ${found}`);
		texts.set(file, source.split(from).join(to));
		rewritten.add(file);
	}
	// Scan original and re-run output alike. Unknown file/form/count is build failure, never ignored.
	const known = new Map();
	for (const site of sites) { const list = known.get(site.file) ?? []; list.push(site); known.set(site.file, list); }
	for (const [file, text] of texts) {
		if (!FIRST_PARTY.test(file)) continue;
		let rest = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
		for (const { to } of known.get(file) ?? []) rest = rest.split(to).join("");
		// Profile sites were independently enumerated above; this one is diagnostic-only, not I/O.
		rest = rest.replace(/__dshBinPaths\.profileFile\([^\n]+?\)/g, "")
			.replace('resolve(home, ".env")', "");
		if (/\b(?:join|resolve|dshHomePath)\([^;\n]*(?:PROFILE_PATCH_FILENAME|cordis\.patch\.yml|settings\.yaml|\.credentials\.yaml|["']\.env["'])/.test(rest)) {
			throw new Error(`${file}: unknown configuration path site`);
		}
	}
}
const CODE = /\.(?:m|c)?js$/;
const DECL = /\.d\.(?:m|c)?ts$|\.map$/;

function* codeFiles(dir) {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) yield* codeFiles(p);
		else if (CODE.test(e.name) && !DECL.test(e.name)) yield p;
	}
}

/** Apply every rule in `app`; returns the rewritten relative paths. */
export function transformApp(app, rules = RULES, profileSites = PROFILE_SITES, configSites) {
	if (configSites === undefined) {
		if (profileSites !== PROFILE_SITES) configSites = []; // explicitly synthetic transform fixtures
		else {
			const version = JSON.parse(readFileSync(join(app, "package.json"), "utf8")).version;
			configSites = CONFIG_SITES_BY_VERSION[version];
			if (!configSites) throw new Error(`unsupported configuration path version: ${version}`);
		}
	}
	const texts = new Map();
	for (const file of codeFiles(app)) texts.set(relative(app, file).split(sep).join("/"), readFileSync(file, "utf8"));
	for (const rule of rules) {
		// A file already rewritten (a re-run) no longer holds a marker like `"node:sea"`; it still counts.
		const found = [...texts].filter(([, text]) => text.includes(rule.marker) || text.includes(rule.to)).map(([rel]) => rel).sort();
		if (JSON.stringify(found) !== JSON.stringify([...rule.files].sort())) {
			throw new Error(`${rule.marker} occurrences changed: expected ${JSON.stringify(rule.files)}, found ${JSON.stringify(found)}`);
		}
		for (const rel of found) {
			const text = texts.get(rel);
			if (text.includes(rule.to)) continue; // already rewritten (re-run)
			if (!rule.from.test(text)) throw new Error(`${rel}: ${rule.marker} is used without the known import form`);
			texts.set(rel, text.replace(rule.from, rule.to));
		}
	}
	const rewritten = new Set(rules.flatMap((r) => r.files));
	const found = {};
	for (const [rel, text] of texts) {
		if (!FIRST_PARTY.test(rel)) continue;
		const { text: out, counts } = rewriteProfileSites(text);
		if (Object.keys(counts).length > 0) {
			found[rel] = counts;
			texts.set(rel, out);
			rewritten.add(rel);
		}
	}
	const sorted = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
	if (sorted(found) !== sorted(profileSites)) {
		throw new Error(`profile path sites changed: expected ${sorted(profileSites)}, found ${sorted(found)}`);
	}
	rewriteConfigSites(texts, configSites, rewritten);
	for (const rel of rewritten) {
		const text = texts.get(rel);
		writeFileSync(join(app, rel), text.includes(PROFILE_HELPER) ? PROFILE_PRELUDE + text.replace(PROFILE_PRELUDE, "") : text);
	}
	return [...rewritten].sort();
}

if (import.meta.main) {
	const [app] = process.argv.slice(2);
	if (!app) throw new Error("usage: transform-app.mjs <app-dir>");
	console.log(transformApp(app).join("\n"));
}
