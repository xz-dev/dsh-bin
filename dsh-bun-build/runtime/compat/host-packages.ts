// D3: route profile imports of host-provided first-party packages to the single host copy, as dsh's
// Node loader interception does. Bun cannot run that interception, so each exported specifier of the
// installation scope becomes a lazy `Bun.plugin().module()` virtual that re-exports the host module.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Scopes whose packages must be host singletons. Third-party packages resolve natively. */
const HOST_SCOPES = /^@(?:deepseek-ai|earendil-works)\//;
const CONDITIONS = ["bun", "import", "node", "default"];
const JS = /\.(?:m|c)?js$/;

type Manifest = {
	name?: string;
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	exports?: unknown;
};

const readManifest = (dir: string): Manifest => JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

/**
 * First-party packages of the installation scope: the dependency and peer closure of the app package,
 * walked the way dsh's `collectInstallationScopePackages` does (first resolution wins, uninstalled
 * declarations are skipped). The app tree is flat, so every package lives at `node_modules/<name>`.
 */
export function hostScope(appDir: string): Map<string, string> {
	const dirs = new Map<string, string>();
	const queue = [readManifest(appDir)];
	for (let manifest = queue.shift(); manifest; manifest = queue.shift()) {
		for (const dep of [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]) {
			if (dirs.has(dep)) continue;
			const dir = join(appDir, "node_modules", dep);
			if (!existsSync(join(dir, "package.json"))) continue;
			dirs.set(dep, dir);
			queue.push(readManifest(dir));
		}
	}
	return new Map([...dirs].filter(([name]) => HOST_SCOPES.test(name)));
}

/** The first string target of an exports value under Bun's import conditions. */
function conditionTarget(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		for (const item of value) {
			const target = conditionTarget(item);
			if (target) return target;
		}
		return undefined;
	}
	if (value && typeof value === "object") {
		for (const condition of CONDITIONS) {
			if (condition in value) {
				const target = conditionTarget((value as Record<string, unknown>)[condition]);
				if (target) return target;
			}
		}
	}
	return undefined;
}

function* filesUnder(dir: string): Generator<string> {
	for (const entry of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
		if (statSync(join(dir, entry)).isFile()) yield entry.split("\\").join("/");
	}
}

/**
 * Importable specifiers of one package: every JavaScript export key, with `./x/*` wildcards expanded
 * by listing the target directory. Data exports (json, yml) and missing targets are skipped.
 */
export function packageSpecifiers(name: string, dir: string): string[] {
	const { exports } = readManifest(dir);
	const map =
		exports && typeof exports === "object" && !Array.isArray(exports) && Object.keys(exports).some((k) => k.startsWith("."))
			? (exports as Record<string, unknown>)
			: { ".": exports ?? "./index.js" };
	const specs: string[] = [];
	for (const [key, value] of Object.entries(map)) {
		const target = conditionTarget(value);
		if (!target?.startsWith("./")) continue;
		const star = key.indexOf("*");
		if (star < 0) {
			if (JS.test(target) && existsSync(join(dir, target))) specs.push(key === "." ? name : `${name}/${key.slice(2)}`);
			continue;
		}
		const targetStar = target.indexOf("*");
		const base = target.slice(2, targetStar);
		const suffix = target.slice(targetStar + 1);
		if (!JS.test(suffix) || !base.endsWith("/") || !existsSync(join(dir, base))) continue;
		for (const file of filesUnder(join(dir, base))) {
			if (!file.endsWith(suffix)) continue;
			const stem = file.slice(0, file.length - suffix.length);
			specs.push(`${name}/${key.slice(2, star)}${stem}${key.slice(star + 1)}`);
		}
	}
	return specs;
}

/**
 * dsh-tui guards root capabilities once its workspace runtime starts, and dsh-typert-protocol registers
 * the root `invocation` accessor on its first Remote Service bind. Node activates a bind first; the
 * compiled Bun entry activates dsh-tui first, so the late `ctx.root.accessor("invocation")` is rejected.
 * Registering the same accessor (same getter, same own-props check) when a root is created removes the
 * ordering dependency. Upstream-report candidate; see design D3.
 */
export function withInvocationAccessor<T extends new (...args: never[]) => object>(Context: T): T {
	return new Proxy(Context, {
		construct(target, args, newTarget) {
			const root = Reflect.construct(target, args, newTarget) as {
				reflect: { props: object };
				accessor(name: string, options: { get(): undefined }): unknown;
			};
			if (!Object.hasOwn(root.reflect.props, "invocation")) root.accessor("invocation", { get: () => undefined });
			return root;
		},
	});
}

export type HostPackages = { packages: number; specifiers: ReadonlySet<string> };

export type HostPackageOptions = {
	/** Extra first-party packages (name → dir) outside the app tree, for example from an enabled addon. */
	extra?: ReadonlyMap<string, string>;
	/** Package root specifiers replaced by a fixed module namespace (declared degradations, D8). */
	overrides?: ReadonlyMap<string, Record<string, unknown>>;
	/** Specifiers whose host namespace is adapted before profiles see it (for example skill-office's node). */
	wrap?: ReadonlyMap<string, (exports: Record<string, unknown>) => Record<string, unknown>>;
};

const CORDIS_WRAP = (exports: Record<string, unknown>) => ({ ...exports, Context: withInvocationAccessor(exports.Context as new () => object) });

export function installHostPackages(appDir: string, options: HostPackageOptions = {}): HostPackages {
	const scope = new Map([...hostScope(appDir), ...(options.extra ?? [])]);
	const overrides = options.overrides ?? new Map();
	const wrap = new Map([["@deepseek-ai/cordis", CORDIS_WRAP], ...(options.wrap ?? [])]);
	const targets = new Map<string, string>();
	for (const [name, dir] of scope) {
		if (overrides.has(name)) continue;
		for (const spec of packageSpecifiers(name, dir)) {
			try {
				targets.set(spec, Bun.resolveSync(spec, dir));
			} catch {
				// Export keys whose conditions Bun cannot select are not importable natively either.
			}
		}
	}
	Bun.plugin({
		name: "dsh-bin:host-packages",
		setup(build) {
			for (const [spec, exports] of overrides) build.module(spec, () => ({ exports, loader: "object" }));
			for (const [spec, target] of targets) {
				build.module(spec, async () => {
					const exports: Record<string, unknown> = { ...(await import(target)) };
					return { exports: wrap.get(spec)?.(exports) ?? exports, loader: "object" };
				});
			}
			// Filesystem-layout lookups (import.meta.resolve of `<pkg>/package.json`, then resolve.paths and
			// existsSync) need a real host path, which a virtual module cannot give.
			build.onResolve({ filter: /^@[^/]+\/[^/]+\/package\.json$/ }, (args) => {
				const dir = scope.get(args.path.slice(0, -"/package.json".length));
				return dir ? { path: join(dir, "package.json") } : undefined;
			});
		},
	});
	return { packages: scope.size, specifiers: new Set([...overrides.keys(), ...targets.keys()]) };
}
