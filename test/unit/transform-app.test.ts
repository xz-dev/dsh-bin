import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { COMPAT_SPECIFIER, KNOWN_FILES, transformApp } from "../../scripts/transform-app.mjs";

const IMPORT = 'import { stripTypeScriptTypes } from "node:module";\n';

function fixture(files: Record<string, string>) {
	const app = mkdtempSync(join(tmpdir(), "transform-app-"));
	for (const [rel, text] of Object.entries(files)) {
		mkdirSync(dirname(join(app, rel)), { recursive: true });
		writeFileSync(join(app, rel), text);
	}
	return app;
}

const known = KNOWN_FILES[0];

test("rewrites exactly the known file to the compat virtual", () => {
	const app = fixture({
		[known]: `${IMPORT}export const f = (s) => stripTypeScriptTypes(s);\n`,
		"node_modules/@deepseek-ai/dsh-ptc-runtime-node/lib/types/index.d.ts": "export declare function stripTypeScriptTypes(): void;\n",
		"node_modules/other/lib/index.js": "export {};\n",
	});
	expect(transformApp(app)).toEqual([known]);
	const out = readFileSync(join(app, known), "utf8");
	expect(out).toContain(`from "${COMPAT_SPECIFIER}"`);
	expect(out).not.toContain("node:module");
});

test("an unknown extra occurrence fails the build", () => {
	const app = fixture({
		[known]: `${IMPORT}stripTypeScriptTypes("");\n`,
		"node_modules/new-pkg/lib/index.mjs": `${IMPORT}stripTypeScriptTypes("");\n`,
	});
	expect(() => transformApp(app)).toThrow(/occurrences changed/);
});

test("a missing known occurrence fails the build", () => {
	expect(() => transformApp(fixture({ "node_modules/x/index.js": "export {};\n" }))).toThrow(/occurrences changed/);
});

test("an unexpected import form fails the build", () => {
	const app = fixture({ [known]: 'import { createRequire, stripTypeScriptTypes } from "node:module";\n' });
	expect(() => transformApp(app)).toThrow(/known node:module import form/);
});
