// Only app.ts installs this module, after protocol/root/guard validation. Raw env is not authority.
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createWindowsPrivateAccess } from "./windows-private-access.ts";

export const CONFIG_PATHS_SPECIFIER = "dsh-bin:config-paths";

const contains = (root: string, path: string) => {
	const rel = relative(root, path);
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};

/** Canonicalize existing ancestors before any config open/watch; reject links escaping C and hardlinks.
 * Final check → upstream syscall race remains, as for archived filesystem boundaries; no new lock layer.
 */
export function createConfigPaths(plugins?: string, config?: string, home?: string) {
	const boundary = (message = "dsh: configuration path violates selected configuration boundary"): never => {
		const error = Object.assign(new Error(message), { code: "DSH_CONFIG_BOUNDARY" });
		// Explicit message property survives Bun compiled Error/cause inspection (native Error alone
		// can print only its name). Diagnostic remains constant; never format caught parser content.
		Object.defineProperty(error, "message", { value: message, enumerable: true, configurable: true });
		throw error;
	};
	// Authenticate Windows independently of manager claims, including empty snapshots, before startup.
	let windows: ReturnType<typeof createWindowsPrivateAccess> | undefined;
	if (config && process.platform === "win32") {
		try { windows = createWindowsPrivateAccess(config); } catch { boundary(); }
	}
	function validate(path: string, parents = false, auxiliary = false, creation = false): string {
		if (!config) return path;
		if (windows) {
			if (creation) windows.checkCreation(path, parents);
			else windows.check(path, parents);
			// Known writer sibling preflight; atomic-write's inner read/create/rename seams still
			// must call checkAuxiliary themselves, not rely on this earlier wrapper check.
			if (!auxiliary) windows.check(`${path}.lock`);
			return path;
		}
		const root = resolve(config);
		if (!contains(root, path) || relative(root, path) === "") boundary();
		const privateNode = (p: string, directory: boolean) => {
			const st = lstatSync(p);
			if (directory ? !st.isDirectory() : !st.isFile()) boundary();
			if (process.platform !== "win32" && ((st.mode & 0o077) !== 0 || st.uid !== process.getuid?.())) boundary();
			if (!directory && st.nlink !== 1) boundary();
		};
		privateNode(root, true);
		const canonicalRoot = realpathSync(root);
		if (canonicalRoot !== root) boundary();
		const parts = relative(root, path).split(sep).filter(Boolean);
		let current = root;
		for (const [i, part] of parts.entries()) {
			current = join(current, part);
			let st;
			try { st = lstatSync(current); } catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				if (parents && i < parts.length - 1) { mkdirSync(current, { mode: 0o700 }); st = lstatSync(current); }
				else return path; // deepest existing ancestor already proved private and contained
			}
			const canonical = realpathSync(current); // dangling links fail too
			if (!contains(canonicalRoot, canonical)) boundary();
			privateNode(canonical, i < parts.length - 1);
		}
		return path;
	}
	function checked(path: string, parents = false, auxiliary = false, creation = false): string {
		try { return validate(path, parents, auxiliary, creation); } catch (error) {
			if (!config) throw error;
			return boundary(); // Stable code, no filesystem/parser error can quote secret bytes.
		}
	}
	const root = () => plugins ? join(plugins, "profiles") : undefined;
	const configFile = (upstreamHome: string, file: string) => config ? checked(join(config, file), true) : join(upstreamHome, file);
	function profileFile(dir: string, file: string) {
		const pr = root();
		if (!config || !pr || file !== "cordis.patch.yml") return join(dir, file);
		const rel = relative(pr, dir);
		if (!rel || !contains(pr, dir)) boundary();
		return checked(join(config, "profiles", rel, file), true);
	}
	function credentialFile(path: string | undefined, overrideHome: string | undefined, fallback: () => string) {
		if (!config) return fallback();
		if (overrideHome !== undefined) checked(join(resolve(overrideHome), ".credentials.yaml"));
		if (path?.split(/[\\/]/).includes("..")) boundary();
		return checked(path === undefined ? join(overrideHome ?? config, ".credentials.yaml") : resolve(config, path), true);
	}
	// Directory identity comparison happens BEFORE either .env file is opened. Independent project layers stay upstream.
	function envDirectory(dir: string) {
		if (!config || !home) return dir;
		const canonical = (p: string) => {
			let current = resolve(p); const missing: string[] = [];
			for (;;) { try { return join(realpathSync(current), ...missing.reverse()); } catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				const parent = dirname(current); if (parent === current) throw error;
				missing.push(basename(current)); current = parent;
			} }
		};
		return canonical(dir) === canonical(home) ? config : dir;
	}
	const isManagedHome = (dir: string) => Boolean(config && envDirectory(dir) === config);
	const envFile = (dir: string) => isManagedHome(dir) ? checked(join(config!, ".env")) : resolve(dir, ".env");
	function assertStartup(failures: { outcome: { kind: string; error?: unknown } }[]) {
		if (config && failures.some(({ outcome }) => outcome.kind === "failed" && (outcome.error as { code?: string })?.code === "DSH_CONFIG_BOUNDARY")) boundary();
	}
	const managedPath = (path: string) => Boolean(config && contains(resolve(config), resolve(path)));
	return { root, dir: (name: string) => root() ? join(root()!, name) : undefined, profileFile, configFile, credentialFile,
		// Windows privacy comes from verified inheritable DACLs before creation, never this POSIX mode.
		privateWriteOptions: config ? { mode: 0o600 } : undefined,
		check: (path: string) => checked(path),
		// Shared atomic-write also handles sessions/cache outside C; preserve those upstream semantics.
		checkAuxiliary: (path: string) => managedPath(path) ? checked(path, false, true) : path,
		checkCreation: (path: string) => managedPath(path) ? checked(path, true, true, true) : path,
		rethrowBoundary: (error: unknown) => {
			if (config && (error as { code?: string })?.code === "DSH_CONFIG_BOUNDARY") boundary();
		},
		checkWatchPath: (path: string) => config && contains(resolve(config), resolve(path)) ? checked(path) : path,
		envDirectory, envFile, isManagedHome, assertStartup };
}

export function installConfigPaths(plugins?: string, config?: string, home?: string): void {
	const paths = createConfigPaths(plugins, config, home);
	// Module authentication is implemented, but atomic-write's generated lock/read/wx/rename
	// seams are not wired in this scoped change. Do not enable unmanaged inner Windows writes.
	// Remove this startup gate only together with those syscall guards and native I/O acceptance.
	if (config && process.platform === "win32") {
		throw Object.assign(new Error("dsh: configuration path violates selected configuration boundary"), { code: "DSH_CONFIG_BOUNDARY" });
	}
	Bun.plugin({ name: CONFIG_PATHS_SPECIFIER, setup(build) {
		build.module(CONFIG_PATHS_SPECIFIER, () => ({ exports: { paths }, loader: "object" }));
	} });
}
