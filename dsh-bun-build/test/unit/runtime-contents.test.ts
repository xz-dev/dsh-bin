// RB-CONTENTS: inspect Bun's actual build graph, not a hand-written import scanner.
import { expect, test } from "bun:test";
import { relative, resolve } from "node:path";
import { ENTRY } from "../../scripts/compile-entry.mjs";
import { readManagerLaunch } from "../../runtime/launch.ts";

const ROOT = resolve(import.meta.dir, "../..");

test("a present empty launch is invalid, not a standalone start", () => {
	expect(readManagerLaunch({})).toBeUndefined();
	expect(() => readManagerLaunch({ DSH_MANAGER_LAUNCH: "" })).toThrow(/DSH_MANAGER_LAUNCH/);
});

test("RB-CONTENTS: Bun's runtime entry graph contains no management engine", async () => {
	const build = await Bun.build({ entrypoints: [ENTRY], target: "bun", metafile: true });
	expect(build.success).toBe(true);
	const files = Object.keys(build.metafile!.inputs).map((p) => relative(ROOT, resolve(p)).replaceAll("\\", "/"));
	expect(files).toContain("runtime/app.ts");
	expect(files.filter((p) => /legacy-manager-reference|dsh-manager|runtime\/(?:update|snapshot)\/|runtime\/(?:layout|selection|zip)\.ts/.test(p))).toEqual([]);
});
