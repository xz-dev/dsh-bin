// Only app.ts installs this module, after protocol/root/guard validation. Raw env is not authority.
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
		throw Object.assign(new Error(message), { code: "DSH_CONFIG_BOUNDARY" });
	};
	// No POSIX-mode fiction for Windows ACLs. Managed IO stays closed until native ACL proof exists.
	if (config && process.platform === "win32") boundary("dsh: managed configuration I/O requires native Windows ACL validation; configuration not opened");
	function validate(path: string, parents = false): string {
		if (!config) return path;
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
	function checked(path: string, parents = false): string {
		try { return validate(path, parents); } catch (error) {
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
	return { root, dir: (name: string) => root() ? join(root()!, name) : undefined, profileFile, configFile, credentialFile,
		privateWriteOptions: config ? { mode: 0o600 } : undefined,
		check: (path: string) => checked(path),
		checkWatchPath: (path: string) => config && contains(resolve(config), resolve(path)) ? checked(path) : path,
		envDirectory, envFile, isManagedHome, assertStartup };
}

export function installConfigPaths(plugins?: string, config?: string, home?: string): void {
	const paths = createConfigPaths(plugins, config, home);
	Bun.plugin({ name: CONFIG_PATHS_SPECIFIER, setup(build) {
		build.module(CONFIG_PATHS_SPECIFIER, () => ({ exports: { paths }, loader: "object" }));
	} });
}
