// musl Bun's createRequire gives a replaced Module._resolveFilename no parent; the compat createRequire
// always passes one, so dsh's installation scope can resolve relative requests.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import Module from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequirePassesParent, createRequireWithParent } from "../../runtime/compat/create-require.ts";

type Resolve = (request: string, parent: any, isMain: boolean, options?: unknown) => string;
const M = Module as unknown as { _resolveFilename: Resolve };
const original = M._resolveFilename;
afterEach(() => {
	M._resolveFilename = original;
});

const dir = mkdtempSync(join(tmpdir(), "create-require-"));
mkdirSync(join(dir, "pkg", "lib"), { recursive: true });
writeFileSync(join(dir, "pkg", "package.json"), JSON.stringify({ name: "pkg", version: "1.2.3" }));
writeFileSync(join(dir, "pkg", "lib", "index.js"), "");
const file = join(dir, "pkg", "lib", "index.js");

/**
 * Like dsh's installation scope: a call without a parent goes straight to the original resolver, which
 * can resolve absolute paths and builtins but not a relative request.
 */
function installScope(seen: unknown[]) {
	M._resolveFilename = function (this: unknown, request, parent, isMain, options) {
		seen.push(parent?.filename);
		if (typeof parent?.filename !== "string" && request.startsWith(".")) throw new Error(`Cannot find module '${request}'`);
		return original.call(this, request, parent, isMain, options);
	};
}

test("the replacement passes a real parent for paths and file URLs", () => {
	const seen: unknown[] = [];
	installScope(seen);
	const createRequire = createRequireWithParent(Module.createRequire);
	for (const from of [file, pathToFileURL(file).href, pathToFileURL(file)]) {
		const req = createRequire(from);
		expect(req("../package.json").version).toBe("1.2.3");
		expect(req.resolve("../package.json")).toBe(join(dir, "pkg", "package.json"));
		expect(req("node:path").join("a", "b")).toBe(join("a", "b"));
	}
	// Every relative resolution had the parent.
	expect(seen.filter((f) => f !== undefined).every((f) => f === file)).toBe(true);
	expect(() => createRequire("relative/path.js")).toThrow(TypeError);
});

test("Bun plugin virtual modules still load by name", () => {
	const name = "dsh-bin-test-virtual-create-require";
	Bun.plugin({
		name,
		setup(build) {
			build.module(name, () => ({ exports: { virtual: true }, loader: "object" }));
		},
	});
	installScope([]);
	expect(createRequireWithParent(Module.createRequire)(file)(name)).toEqual({ virtual: true });
});

test("resolve.paths keeps the native lookup paths", () => {
	// dsh-app-boot finds profile bundles through `createRequire(anchor).resolve.paths(name)`.
	const paths = createRequireWithParent(Module.createRequire)(file).resolve.paths("some-package");
	expect(paths).toEqual(Module.createRequire(file).resolve.paths("some-package"));
	expect(paths?.[0]).toBe(join(dir, "pkg", "lib", "node_modules"));
});

test("the probe restores the resolver and reports this Bun's behaviour", () => {
	const passes = createRequirePassesParent(file);
	expect(M._resolveFilename).toBe(original);
	// glibc and macOS/Windows Bun pass the parent; musl Bun does not.
	const musl = process.platform === "linux" && !process.report?.getReport?.()?.header?.glibcVersionRuntime;
	expect(passes).toBe(!musl);
});
