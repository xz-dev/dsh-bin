// D3: on musl, Bun's `createRequire(from)` calls a replaced `Module._resolveFilename` with no parent
// module (glibc passes one; seen with Bun 1.4.0 and 1.4.2). dsh's installation scope replaces
// `_resolveFilename`, so every relative `createRequire(import.meta.url)("../package.json")` in a plugin
// fails there. Where the probe sees that, `Module.createRequire` is replaced with one that hands the
// resolver a real parent. ESM `import { createRequire } from "node:module"` sees the replacement.
import Module from "node:module";
import { dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

type Resolve = (request: string, parent: unknown, isMain: boolean, options?: unknown) => string;
type ModuleInternals = typeof Module & { _resolveFilename: Resolve; _nodeModulePaths(dir: string): string[] };
const M = Module as ModuleInternals;

/** Whether `createRequire` hands a replaced `_resolveFilename` its parent module. */
export function createRequirePassesParent(probeFile: string): boolean {
	const original = M._resolveFilename;
	let parent: { filename?: unknown } | undefined;
	M._resolveFilename = function (this: unknown, request, p, isMain, options) {
		parent = p as typeof parent;
		return original.call(this, request, p, isMain, options);
	};
	try {
		Module.createRequire(probeFile).resolve(`./${probeFile.split(/[\\/]/).pop()}`);
	} catch {
		// Only the parent passed matters.
	} finally {
		M._resolveFilename = original;
	}
	return typeof parent?.filename === "string";
}

function filenameOf(from: string | URL): string {
	if (from instanceof URL) return fileURLToPath(from);
	if (from.startsWith("file:")) return fileURLToPath(from);
	if (!isAbsolute(from)) throw new TypeError(`createRequire needs an absolute path or file URL, got ${JSON.stringify(from)}`);
	return from;
}

/** `createRequire` whose resolution always goes through `Module._resolveFilename` with a real parent. */
export function createRequireWithParent(native: typeof Module.createRequire): typeof Module.createRequire {
	return function createRequire(from: string | URL) {
		const req = native(from);
		const filename = filenameOf(from);
		const dir = dirname(filename);
		const parent = { id: filename, filename, path: dir, paths: M._nodeModulePaths(dir), loaded: true, children: [] };
		const resolve = ((request: string, options?: unknown) => {
			try {
				return M._resolveFilename(request, parent, false, options);
			} catch (error) {
				try {
					return req.resolve(request, options as never);
				} catch {
					throw error;
				}
			}
		}) as NodeJS.RequireResolve;
		// Bun's `resolve.paths` needs its own `this`: detached, it returns [].
		resolve.paths = req.resolve.paths.bind(req.resolve);
		// The native require goes first: it alone serves Bun plugin virtual modules (a path resolution would
		// load the file on disk instead). Only what it cannot find is resolved again with the parent;
		// loading that absolute result needs no parent.
		const require = ((id: string) => {
			try {
				return req(id);
			} catch (error) {
				if ((error as { code?: string }).code !== "MODULE_NOT_FOUND" && !String(error).includes("Cannot find module")) throw error;
				let path: string;
				try {
					path = M._resolveFilename(id, parent, false);
				} catch {
					throw error;
				}
				return req(path);
			}
		}) as NodeJS.Require;
		return Object.assign(require, { resolve, cache: req.cache, main: req.main, extensions: req.extensions });
	} as typeof Module.createRequire;
}

/** Install the replacement where this Bun needs it; returns whether it did. */
export function installCreateRequireCompat(probeFile: string): boolean {
	if (createRequirePassesParent(probeFile)) return false;
	Module.createRequire = createRequireWithParent(Module.createRequire);
	return true;
}
