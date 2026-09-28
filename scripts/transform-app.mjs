// Build-output transform (D3): Bun cannot provide `stripTypeScriptTypes` from `node:module`, and
// Bun.plugin().module() cannot override `node:` builtins. Rewrite the known host files that import it
// to the dsh-bin compat virtual module. Any unknown occurrence fails the build instead of the runtime.
// usage: bun scripts/transform-app.mjs <app-dir>
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const COMPAT_SPECIFIER = "dsh-bin:node-module-compat";
export const KNOWN_FILES = ["node_modules/@deepseek-ai/dsh-ptc-runtime-node/lib/index.js"];
const IMPORT = /^import \{ stripTypeScriptTypes \} from "node:module";$/m;
const CODE = /\.(?:m|c)?js$/;
const DECL = /\.d\.(?:m|c)?ts$|\.map$/;

function* codeFiles(dir) {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) yield* codeFiles(p);
		else if (CODE.test(e.name) && !DECL.test(e.name)) yield p;
	}
}

/** Rewrite the stripTypeScriptTypes imports in `app`; returns the rewritten relative paths. */
export function transformApp(app) {
	const hits = [];
	for (const file of codeFiles(app)) {
		const text = readFileSync(file, "utf8");
		if (!text.includes("stripTypeScriptTypes")) continue;
		hits.push({ file, rel: relative(app, file).split(sep).join("/"), text });
	}
	const found = hits.map((h) => h.rel).sort();
	if (JSON.stringify(found) !== JSON.stringify([...KNOWN_FILES].sort())) {
		throw new Error(`stripTypeScriptTypes occurrences changed: expected ${JSON.stringify(KNOWN_FILES)}, found ${JSON.stringify(found)}`);
	}
	for (const { file, rel, text } of hits) {
		if (!IMPORT.test(text)) throw new Error(`${rel}: stripTypeScriptTypes is used without the known node:module import form`);
		writeFileSync(file, text.replace(IMPORT, `import { stripTypeScriptTypes } from "${COMPAT_SPECIFIER}";`));
	}
	return found;
}

if (import.meta.main) {
	const [app] = process.argv.slice(2);
	if (!app) throw new Error("usage: transform-app.mjs <app-dir>");
	console.log(transformApp(app).join("\n"));
}
