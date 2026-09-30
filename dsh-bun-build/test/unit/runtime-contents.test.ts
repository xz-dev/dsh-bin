// RB-CONTENTS: the compiled runtime entry carries no management engine. The entry's static import graph
// (what `bun build --compile` bundles) must not reach the old updater, snapshot store or selection code.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { ENTRY } from "../../scripts/compile-entry.mjs";

const RUNTIME = resolve(import.meta.dir, "../../runtime");
const IMPORT = /(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s*["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']\s*\)/g;

function graph(entry: string): string[] {
	const seen = new Set<string>();
	const walk = (file: string) => {
		if (seen.has(file)) return;
		seen.add(file);
		for (const m of readFileSync(file, "utf8").matchAll(IMPORT)) walk(resolve(dirname(file), m[1] ?? m[2]!));
	};
	walk(entry);
	return [...seen].map((f) => relative(RUNTIME, f).split("\\").join("/")).sort();
}

test("RB-CONTENTS: the runtime entry imports no update, snapshot-store or selection code", () => {
	const files = graph(ENTRY);
	expect(files).toContain("app.ts");
	expect(files.filter((f) => /^(?:update|snapshot)\/|^(?:selection|layout|zip)\.ts$/.test(f))).toEqual([]);
});
