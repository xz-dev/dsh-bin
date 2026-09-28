import { expect, test } from "bun:test";
import { createRequireBuiltin, UnsupportedBuiltinError } from "../../runtime/compat/require-builtin.ts";
import { stripTypeScriptTypes } from "../../runtime/compat/node-module-compat.ts";

const IDS = [
	"internal/modules/esm/loader",
	"internal/modules/cjs/loader",
	"internal/modules/helpers",
	"internal/modules/esm/utils",
	"internal/modules/esm/resolve",
];

test("require-builtin provides the five loader stand-ins and names unknown ids", () => {
	const { requireBuiltin } = createRequireBuiltin(import.meta.dir);
	for (const id of IDS) expect(requireBuiltin(id)).toBeDefined();
	expect(() => requireBuiltin("internal/process/esm_loader")).toThrow(UnsupportedBuiltinError);
});

test("esm stand-in resolves from the importer, then falls back to the host dir", async () => {
	const loader = (createRequireBuiltin(import.meta.dir).requireBuiltin("internal/modules/esm/loader") as {
		getOrInitializeCascadedLoader(): {
			resolveSync(parent: string, req: { specifier: string }): { url: string };
			import(spec: string, parent: string): Promise<Record<string, unknown>>;
		};
	}).getOrInitializeCascadedLoader();
	expect(loader.resolveSync("file:///nonexistent/dir/", { specifier: "./compat.test.ts" }).url).toBe(Bun.pathToFileURL(`${import.meta.dir}/compat.test.ts`).href);
	expect(Object.keys(await loader.import("node:path", "file:///"))).toContain("join");
});

test("stripTypeScriptTypes strips types and keeps ptc-runtime's 35-char prefix framing", () => {
	// dsh-ptc-runtime-node wraps the program and slices [35, -2]; the frame must survive the reprint.
	const prefix = "async function __dsh_program__() {\n";
	expect(prefix.length).toBe(35);
	const out = stripTypeScriptTypes(`${prefix}const a: number = await tools.x() as number;\nreturn a\n}`);
	expect(out.startsWith(prefix)).toBe(true);
	expect(out.endsWith("\n}\n")).toBe(true);
	expect(out).not.toContain(": number");
});
