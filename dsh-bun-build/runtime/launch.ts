// Protocol v2: runtime consumes resolved paths; selection and snapshot creation belong to manager.
import { isAbsolute, join, relative, resolve } from "node:path";

export const LAUNCH_VAR = "DSH_MANAGER_LAUNCH";
export const LAUNCH_PROTOCOL = 2;
export type ManagerLaunch = {
	protocol: 2;
	runtime: string;
	dataRoot: string;
	home: string;
	snapshot: { id: string; dir: string };
	configSnapshot: { id: string; dir: string };
	addons: { office?: { version: string; dir: string; warning?: string } };
	cache: string;
	tmp: string;
	manager: string;
};
export class LaunchError extends Error {}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const absolute = (v: unknown): v is string => typeof v === "string" && isAbsolute(v);
const component = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(v);
const samePath = (a: string, b: string) => relative(resolve(a), resolve(b)) === "";

export function readManagerLaunch(env: NodeJS.ProcessEnv = process.env, bundleDir?: string): ManagerLaunch | undefined {
	const raw = env[LAUNCH_VAR];
	if (raw === undefined) return undefined;
	let v: unknown;
	try { v = JSON.parse(raw); } catch { throw new LaunchError(`${LAUNCH_VAR} is not JSON`); }
	if (!object(v)) throw new LaunchError(`${LAUNCH_VAR} is not an object`);
	if (v.protocol !== LAUNCH_PROTOCOL) throw new LaunchError(`${LAUNCH_VAR} uses launch protocol ${String(v.protocol)}; this dsh runtime implements ${LAUNCH_PROTOCOL}`);
	if (!component(v.runtime) || !absolute(v.dataRoot) || !absolute(v.home) || !absolute(v.cache) || !absolute(v.tmp) || typeof v.manager !== "string" || !v.manager) throw new LaunchError(`${LAUNCH_VAR} lacks runtime, dataRoot, home, cache, tmp or manager`);
	if (!samePath(v.cache, join(v.dataRoot, "cache")) || !samePath(v.tmp, join(v.dataRoot, "tmp"))) throw new LaunchError(`${LAUNCH_VAR} has mismatched cache or tmp roots`);
	if (bundleDir && !samePath(bundleDir, join(v.dataRoot, "bundles", v.runtime))) throw new LaunchError(`${LAUNCH_VAR} has a mismatched runtime identity/root`);
	const snapshot = (field: "snapshot" | "configSnapshot", root: string): ManagerLaunch["snapshot"] => {
		const s = v[field];
		if (!object(s) || typeof s.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.+_-]*@[1-9][0-9]*$/.test(s.id) || !absolute(s.dir) || !samePath(s.dir, join(v.dataRoot as string, root, s.id))) throw new LaunchError(`${LAUNCH_VAR} has an invalid ${field} identity/root`);
		return { id: s.id, dir: s.dir };
	};
	const plugins = snapshot("snapshot", "snapshots");
	const config = snapshot("configSnapshot", "config-snapshots");
	if (!object(v.addons)) throw new LaunchError(`${LAUNCH_VAR} has invalid addons`);
	const addons: ManagerLaunch["addons"] = {};
	const office = v.addons.office;
	if (office != null) {
		if (!object(office) || !component(office.version) || !absolute(office.dir) || !samePath(office.dir, join(v.dataRoot, "addons", "office", office.version))) throw new LaunchError(`${LAUNCH_VAR} has an invalid office addon`);
		addons.office = { version: office.version, dir: office.dir, ...(typeof office.warning === "string" ? { warning: office.warning } : {}) };
	}
	return { protocol: 2, runtime: v.runtime, dataRoot: v.dataRoot, home: v.home, snapshot: plugins, configSnapshot: config, addons, cache: v.cache, tmp: v.tmp, manager: v.manager };
}
