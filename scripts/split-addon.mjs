// Split the optional office addon (LibreOffice Kit, D2/D7b) out of a deployed app tree.
// The kit is the only approved registry-sourced @deepseek-ai code and never ships in the main archive.
// usage: bun scripts/split-addon.mjs <app-dir> <addon-dir>
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export const KIT = "@deepseek-ai/libreoffice-kit";
const isKit = (name) => name === KIT || name.startsWith(`${KIT}-`);
const manifest = (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

/** Node resolution of `name` from package dir `from`, bounded by `root`. */
function resolveFrom(root, from, name) {
	for (let dir = from; ; dir = dirname(dir)) {
		const candidate = join(dir, "node_modules", name);
		if (existsSync(join(candidate, "package.json"))) return candidate;
		if (dir === root) return undefined;
	}
}

/** Package dirs reachable from `roots` (deps, optional deps, peers), not descending into `skip` names. */
function closure(root, roots, skip = () => false) {
	const seen = new Set();
	const queue = [...roots];
	while (queue.length) {
		const dir = queue.pop();
		if (seen.has(dir)) continue;
		seen.add(dir);
		const m = manifest(dir);
		for (const name of Object.keys({ ...m.dependencies, ...m.optionalDependencies, ...m.peerDependencies })) {
			if (skip(name)) continue;
			const found = resolveFrom(root, dir, name);
			if (found) queue.push(found);
		}
	}
	return seen;
}

/**
 * Copy the kit's full closure into `<addon>/node_modules` (self-contained, relative layout kept)
 * and remove from `app` every package only the kit needs. Returns the addon metadata.
 */
export function splitOfficeAddon(app, addon) {
	const kitDir = join(app, "node_modules", KIT);
	if (!existsSync(kitDir)) throw new Error(`${KIT} is not in the deployed tree`);
	const kitVersion = manifest(kitDir).version;
	const kitClosure = closure(app, [kitDir]);
	const mainClosure = closure(app, [app], isKit);
	rmSync(addon, { recursive: true, force: true });
	const packages = [];
	for (const dir of kitClosure) {
		const rel = relative(app, dir);
		cpSync(dir, join(addon, rel), { recursive: true, filter: (p) => !relative(dir, p).startsWith("node_modules") });
		packages.push(`${manifest(dir).name}@${manifest(dir).version}`);
	}
	for (const dir of kitClosure) if (!mainClosure.has(dir)) rmSync(dir, { recursive: true, force: true });
	const meta = { name: "office", kitVersion, packages: packages.sort() };
	mkdirSync(addon, { recursive: true });
	writeFileSync(join(addon, "addon.json"), `${JSON.stringify(meta, null, 2)}\n`);
	return meta;
}

if (import.meta.main) {
	const [app, addon] = process.argv.slice(2);
	if (!app || !addon) throw new Error("usage: split-addon.mjs <app-dir> <addon-dir>");
	console.log(JSON.stringify(splitOfficeAddon(app, addon), null, 2));
}
