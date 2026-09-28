// D3: dsh reaches Node's internal module loader through `node-addon-require-builtin`. Bun has no such
// internals, so this virtual module hands dsh Bun-backed stand-ins for the five ids it reads.
import Module from "node:module";
import { dirname, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REQUIRE_BUILTIN_SPECIFIER = "node-addon-require-builtin";

/** An internal id dsh asked for that dsh-bin does not provide. */
export class UnsupportedBuiltinError extends Error {
	override name = "UnsupportedBuiltinError";
	constructor(readonly id: string) {
		super(`dsh-bin: no Bun stand-in for Node internal "${id}"`);
	}
}

const toUrl = (resolved: string) => (isAbsolute(resolved) ? pathToFileURL(resolved).href : resolved);

function parentDir(parentURL: string | undefined): string {
	if (!parentURL) return process.cwd();
	try {
		const path = parentURL.startsWith("file:") ? fileURLToPath(parentURL) : parentURL;
		return parentURL.endsWith("/") ? path : dirname(path);
	} catch {
		return process.cwd();
	}
}

/**
 * Build the `requireBuiltin` export. `hostDir` is a directory inside the app tree; a specifier the
 * importer cannot resolve falls back to the host tree, as dsh's installation scope does. Specifiers in
 * `virtuals` (host-package and degradation modules) are imported by name, so the Bun plugin serves them
 * instead of the file a path resolution would bypass them with.
 */
export function createRequireBuiltin(hostDir: string, virtuals: ReadonlySet<string> = new Set()) {
	const resolveFrom = (specifier: string, dir: string) => {
		try {
			return Bun.resolveSync(specifier, dir);
		} catch {
			return Bun.resolveSync(specifier, hostDir);
		}
	};
	const esm = {
		resolveSync(parentURL: string | undefined, request: { specifier: string }) {
			return { url: toUrl(resolveFrom(request.specifier, parentDir(parentURL))), format: "module" };
		},
		getOrCreateModuleJob(): never {
			throw new UnsupportedBuiltinError("internal/modules/esm/loader#getOrCreateModuleJob");
		},
		import(specifier: string, parentURL: string | undefined) {
			if (virtuals.has(specifier)) return import(specifier);
			return import(esm.resolveSync(parentURL, { specifier }).url);
		},
	};
	const builtins: Record<string, unknown> = {
		"internal/modules/esm/loader": { getOrInitializeCascadedLoader: () => esm },
		"internal/modules/cjs/loader": { Module },
		"internal/modules/helpers": { getCjsConditions: () => new Set(["require", "node", "bun", "default"]) },
		"internal/modules/esm/utils": { getDefaultConditions: () => ["node", "import", "bun", "default"] },
		"internal/modules/esm/resolve": {
			defaultResolve: (specifier: string, context: { parentURL?: string }) => esm.resolveSync(context.parentURL, { specifier }),
		},
	};
	return {
		requireBuiltin(id: string): unknown {
			if (Object.hasOwn(builtins, id)) return builtins[id];
			throw new UnsupportedBuiltinError(id);
		},
	};
}

export function installRequireBuiltin(hostDir: string, virtuals?: ReadonlySet<string>): void {
	Bun.plugin({
		name: "dsh-bin:require-builtin",
		setup(build) {
			build.module(REQUIRE_BUILTIN_SPECIFIER, () => ({ exports: createRequireBuiltin(hostDir, virtuals), loader: "object" }));
		},
	});
}
