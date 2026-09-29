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

// Plugin snapshots (dsh-bin-select-snapshots S1): a profile's plugin runtime lives in the selected snapshot
// (`$DSH_BIN_SNAPSHOT_DIR/profiles/<name>`), while its user config (`cordis.patch.yml`) stays shared in
// `$DSH_HOME/profiles/<name>`; the snapshot dir is always `$DSH_HOME/snapshots/<id>`, so that is `<snapshot>/../../profiles`. `cordis.yml` stays in the snapshot: upstream anchors plugin resolution at
// its directory and rewrites it on every boot. Upstream derives every profile path from resolveProfileDir and
// `join(<profile dir>, <file>)`; each such site is rewritten to ask the injected helper first. The helper
// reads the environment, so worker threads and child processes follow the same snapshot. Unset: upstream paths.
export const PROFILE_HELPER = "__dshBinProfiles";
const PROFILE_PRELUDE = `import { isAbsolute as __dshBinIsAbs, join as __dshBinJoin, relative as __dshBinRel } from "node:path";
import { mkdirSync as __dshBinMkdir } from "node:fs";
const ${PROFILE_HELPER} = {
	root() { const s = process.env.DSH_BIN_SNAPSHOT_DIR; return s ? __dshBinJoin(s, "profiles") : undefined; },
	dir(name) { const r = this.root(); return r ? __dshBinJoin(r, name) : undefined; },
	sharedProfileFile(dir, file) {
		const r = this.root();
		if (!r || file !== "cordis.patch.yml") return undefined;
		const shared = __dshBinJoin(process.env.DSH_BIN_SNAPSHOT_DIR, "..", "..", "profiles");
		const rel = __dshBinRel(r, dir);
		if (!rel || rel.startsWith("..") || __dshBinIsAbs(rel)) return undefined;
		__dshBinMkdir(__dshBinJoin(shared, rel), { recursive: true });
		return __dshBinJoin(shared, rel, file);
	},
};
`;
const FILE_SITE = /join\((dir|profileDir|profile\.dir|composed\.profile\.dir|loaded\.dir|this\.profile\.dir), (PROFILE_PATCH_FILENAME|PROFILE_ROOT_FILENAME|"cordis\.yml"|file)\)/g;
/** Every profile-path site, per file, as `[kind, count]`; the build fails if upstream adds, moves or drops one. */
export const PROFILE_SITES = {
	"node_modules/@deepseek-ai/dsh-app-boot/lib/index.js": { dir: 1, root: 1, file: 4 },
	"node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js": { file: 1 },
	"node_modules/@deepseek-ai/dsh-plugin-manager/lib/types/index.js": { file: 1 },
	"lib/profile-boot-BZ2ZjNWi.js": { file: 3 },
	"lib/dump-config-BEDI-dNY.js": { file: 1 },
};
/** Upstream's own code: the app's `lib/` and its `@deepseek-ai/*` packages (third-party code has look-alike joins). */
const FIRST_PARTY = /^(?:lib\/|node_modules\/@deepseek-ai\/)/;
const DIR_SITE = /return join\(home, PROFILES_DIR, name\);/g;
const ROOT_SITE = /const profilesDir = join\(home, PROFILES_DIR\);/g;

/** Rewrite one file's profile-path sites; returns the new text and the counts found. */
export function rewriteProfileSites(text) {
	if (text.includes(PROFILE_HELPER)) return { text, counts: null };
	const counts = { dir: 0, root: 0, file: 0 };
	let out = text
		.replace(DIR_SITE, () => (counts.dir++, `return ${PROFILE_HELPER}.dir(name) ?? join(home, PROFILES_DIR, name);`))
		.replace(ROOT_SITE, () => (counts.root++, `const profilesDir = ${PROFILE_HELPER}.root() ?? join(home, PROFILES_DIR);`))
		.replace(FILE_SITE, (_m, d, f) => (counts.file++, `(${PROFILE_HELPER}.sharedProfileFile(${d}, ${f}) ?? join(${d}, ${f}))`));
	for (const k of Object.keys(counts)) if (counts[k] === 0) delete counts[k];
	if (Object.keys(counts).length > 0) out = PROFILE_PRELUDE + out;
	return { text: out, counts };
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
export function transformApp(app, rules = RULES, profileSites = PROFILE_SITES) {
	const texts = new Map();
	for (const file of codeFiles(app)) texts.set(relative(app, file).split(sep).join("/"), readFileSync(file, "utf8"));
	for (const rule of rules) {
		const found = [...texts].filter(([, text]) => text.includes(rule.marker)).map(([rel]) => rel).sort();
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
		if (counts === null) found[rel] = PROFILE_SITES[rel]; // already rewritten (re-run)
		else if (Object.keys(counts).length > 0) {
			found[rel] = counts;
			texts.set(rel, out);
			rewritten.add(rel);
		}
	}
	const sorted = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
	if (sorted(found) !== sorted(profileSites)) {
		throw new Error(`profile path sites changed: expected ${sorted(profileSites)}, found ${sorted(found)}`);
	}
	for (const rel of rewritten) writeFileSync(join(app, rel), texts.get(rel));
	return [...rewritten].sort();
}

if (import.meta.main) {
	const [app] = process.argv.slice(2);
	if (!app) throw new Error("usage: transform-app.mjs <app-dir>");
	console.log(transformApp(app).join("\n"));
}
