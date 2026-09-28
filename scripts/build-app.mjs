// Build the upstream workspace and deploy a flat, symlink-free @deepseek-ai/dsh runtime tree.
// Mirrors upstream's own proven closure deploy (scripts/build-exe-for-python-sdk.ts).
// usage: bun scripts/build-app.mjs <upstream-src> <pnpm-dir> <out-app-dir>
// Build-time Node is allowed (upstream's build scripts need it); the product runtime is Node-free.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { checkLockfile, readLockfile } from "./lockfile-guard.mjs";

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, CI: "true", LEFTHOOK: "0" } });

/** Copy a package dir without its nested node_modules (host keeps one flat instance). */
function copyPackage(source, destination) {
	const nested = join(source, "node_modules");
	cpSync(source, destination, { recursive: true, dereference: true, filter: (p) => p !== nested && !p.startsWith(nested + sep) });
}

function findSymlink(dir) {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (lstatSync(p).isSymbolicLink()) return p;
		if (e.isDirectory()) {
			const n = findSymlink(p);
			if (n) return n;
		}
	}
}

export function materializeLinks(nodeModules) {
	for (let link = findSymlink(nodeModules); link; link = findSymlink(nodeModules)) {
		const rel = link.slice(nodeModules.length + 1).split(sep);
		const bin = rel.lastIndexOf(".bin");
		if (bin >= 0) {
			rmSync(join(nodeModules, ...rel.slice(0, bin + 1)), { recursive: true, force: true });
			continue;
		}
		const source = realpathSync(link);
		rmSync(link, { recursive: true, force: true });
		copyPackage(source, link);
	}
}

/** Map workspace package name -> source dir. */
function workspacePackages(src) {
	const lock = readLockfile(src);
	const map = new Map();
	for (const dir of Object.keys(lock.importers ?? {})) {
		const pj = join(src, dir, "package.json");
		if (existsSync(pj)) map.set(JSON.parse(readFileSync(pj, "utf8")).name, join(src, dir));
	}
	return map;
}

/**
 * Legacy deploy installs neither peers of workspace packages nor some direct deps hoisted
 * beside the deploy source. Walk the runtime closure (dependencies, optional and peer
 * dependencies, as npm would install them) and copy any missing workspace package from its
 * built source dir into the flat tree. A missing third-party package fails the build.
 */
export function restoreClosure(src, out) {
	const ws = workspacePackages(src);
	const nm = join(out, "node_modules");
	const restored = [];
	const seen = new Set();
	const queue = [JSON.parse(readFileSync(join(out, "package.json"), "utf8"))];
	while (queue.length) {
		const pkg = queue.shift();
		const optional = new Set(Object.keys(pkg.optionalDependencies ?? {}));
		for (const [k, o] of Object.entries(pkg.peerDependenciesMeta ?? {})) if (o?.optional) optional.add(k);
		const names = [pkg.dependencies, pkg.optionalDependencies, pkg.peerDependencies].flatMap((d) => Object.keys(d ?? {}));
		for (const name of names) {
			if (seen.has(name)) continue;
			seen.add(name);
			const dest = join(nm, name);
			if (!existsSync(dest)) {
				const from = ws.get(name);
				if (from) {
					const manifest = JSON.parse(readFileSync(join(from, "package.json"), "utf8"));
					if (manifest.os && !manifest.os.includes(process.platform)) continue;
					if (manifest.cpu && !manifest.cpu.includes(process.arch)) continue;
					copyPackage(from, dest);
					restored.push(name);
				} else if (optional.has(name)) continue;
				else throw new Error(`runtime dependency ${name} (of ${pkg.name}) is missing from the deployed tree`);
			}
			queue.push(JSON.parse(readFileSync(join(dest, "package.json"), "utf8")));
		}
	}
	return restored;
}

export function buildApp(src, pnpmDir, out) {
	src = resolve(src);
	out = resolve(out);
	checkLockfile(readLockfile(src)); // D2: fail before any network install
	const pnpm = (...args) => run("node", [join(resolve(pnpmDir), "dist/pnpm.mjs"), ...args], src);

	pnpm("install", "--frozen-lockfile");
	run("node", ["node_modules/tsx/dist/cli.mjs", "native/system/scripts/build.ts", "--host-addon-only"], src);
	run("node", ["--max-old-space-size=4096", "node_modules/typescript/bin/tsc", "-b", "tsconfig.host.json"], src);
	run("node", ["node_modules/tsdown/dist/run.mjs", "--env.DSH_BUILD_FACE", "host"], src);
	// Client face feeds the web SPA, which the web profile serves from dsh-web-frontend/dist.
	// (The desktop Electron bundle in upstream's build:lib:host is a non-goal.)
	pnpm("run", "build:lib:client");
	pnpm("run", "build:web");

	rmSync(out, { recursive: true, force: true });
	pnpm(
		"--filter", "@deepseek-ai/dsh", "deploy", "--legacy", "--prod",
		"--config.allow-unused-patches=true", "--config.node-linker=hoisted",
		"--config.auto-install-peers=false", "--config.link-workspace-packages=true", out,
	);
	materializeLinks(join(out, "node_modules"));
	const restored = restoreClosure(src, out);
	if (restored.length) console.error(`build-app: restored ${restored.length} workspace packages omitted by legacy deploy`);
	for (const f of ["pnpm-lock.yaml", "pnpm-workspace.yaml", "README.md", "README.zh.md", "README.i18n.yaml"]) rmSync(join(out, f), { force: true });
	if (findSymlink(out)) throw new Error("deployed tree still contains a symlink");
	return out;
}

if (import.meta.main) {
	const [src, pnpmDir, out] = process.argv.slice(2);
	if (!src || !pnpmDir || !out) throw new Error("usage: build-app.mjs <upstream-src> <pnpm-dir> <out-app-dir>");
	console.log(buildApp(src, pnpmDir, out));
}
