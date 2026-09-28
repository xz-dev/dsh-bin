import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { COMPAT_SPECIFIER, RULES, transformApp } from "../../scripts/transform-app.mjs";

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
	expect(transformApp(app, strip)).toEqual([known]);
	const out = readFileSync(join(app, known), "utf8");
	expect(out).toContain(`from "${COMPAT_SPECIFIER}"`);
	expect(out).not.toContain("node:module");
});

test("an unknown extra occurrence fails the build", () => {
	const app = fixture({
		[known]: `${IMPORT}stripTypeScriptTypes("");\n`,
		"node_modules/new-pkg/lib/index.mjs": `${IMPORT}stripTypeScriptTypes("");\n`,
	});
	expect(() => transformApp(app, strip)).toThrow(/occurrences changed/);
});

test("a missing known occurrence fails the build", () => {
	expect(() => transformApp(fixture({ "node_modules/x/index.js": "export {};\n" }), strip)).toThrow(/occurrences changed/);
});

test("an unexpected import form fails the build", () => {
	const app = fixture({ [known]: 'import { createRequire, stripTypeScriptTypes } from "node:module";\n' });
	expect(() => transformApp(app, strip)).toThrow(/known import form/);
});

test("rewrites node:sea in skill-office alongside stripTypeScriptTypes", () => {
	const sea = RULES[1].files[0];
	const app = fixture({
		[known]: `${IMPORT}stripTypeScriptTypes("");\n`,
		[sea]: 'import { isSea } from "node:sea";\nisSea();\n',
	});
	expect(transformApp(app)).toEqual([known, sea].sort());
	expect(readFileSync(join(app, sea), "utf8")).toStartWith(`import { isSea } from "${COMPAT_SPECIFIER}";`);
});
