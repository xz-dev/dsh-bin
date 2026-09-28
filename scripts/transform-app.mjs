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
export function transformApp(app, rules = RULES) {
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
	const rewritten = [...new Set(rules.flatMap((r) => r.files))].sort();
	for (const rel of rewritten) writeFileSync(join(app, rel), texts.get(rel));
	return rewritten;
}

if (import.meta.main) {
	const [app] = process.argv.slice(2);
	if (!app) throw new Error("usage: transform-app.mjs <app-dir>");
	console.log(transformApp(app).join("\n"));
}
