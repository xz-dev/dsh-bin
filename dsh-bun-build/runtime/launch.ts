// Protocol v1: runtime consumes resolved paths; selection and snapshot creation belong to manager.
import { isAbsolute } from "node:path";

export const LAUNCH_VAR = "DSH_MANAGER_LAUNCH";
export const LAUNCH_PROTOCOL = 1;
export type ManagerLaunch = {
	protocol: 1;
	runtime: string;
	dataRoot: string;
	home: string;
	snapshot: { id: string; dir: string } | null;
	addons: { office?: { version: string; dir: string; warning?: string } };
	cache: string | null;
	manager: string;
};
export class LaunchError extends Error {}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const absolute = (v: unknown): v is string => typeof v === "string" && isAbsolute(v);

export function readManagerLaunch(env: NodeJS.ProcessEnv = process.env): ManagerLaunch | undefined {
	const raw = env[LAUNCH_VAR];
	if (raw === undefined) return undefined;
	let v: unknown;
	try { v = JSON.parse(raw); } catch { throw new LaunchError(`${LAUNCH_VAR} is not JSON`); }
	if (!object(v)) throw new LaunchError(`${LAUNCH_VAR} is not an object`);
	if (v.protocol !== LAUNCH_PROTOCOL) throw new LaunchError(`${LAUNCH_VAR} uses launch protocol ${String(v.protocol)}; this dsh runtime implements ${LAUNCH_PROTOCOL}`);
	if (typeof v.runtime !== "string" || !v.runtime || !absolute(v.dataRoot) || !absolute(v.home)) throw new LaunchError(`${LAUNCH_VAR} lacks runtime, dataRoot or home`);
	let snapshot: ManagerLaunch["snapshot"] = null;
	if (v.snapshot != null) {
		if (!object(v.snapshot) || typeof v.snapshot.id !== "string" || !absolute(v.snapshot.dir)) throw new LaunchError(`${LAUNCH_VAR} has an invalid snapshot`);
		snapshot = { id: v.snapshot.id, dir: v.snapshot.dir };
	}
	if (v.addons !== undefined && !object(v.addons)) throw new LaunchError(`${LAUNCH_VAR} has invalid addons`);
	const addons: ManagerLaunch["addons"] = {};
	const office = object(v.addons) ? v.addons.office : undefined;
	if (office != null) {
		if (!object(office) || typeof office.version !== "string" || !absolute(office.dir)) throw new LaunchError(`${LAUNCH_VAR} has an invalid office addon`);
		addons.office = { version: office.version, dir: office.dir, ...(typeof office.warning === "string" ? { warning: office.warning } : {}) };
	}
	return { protocol: 1, runtime: v.runtime, dataRoot: v.dataRoot, home: v.home, snapshot, addons, cache: absolute(v.cache) ? v.cache : null, manager: typeof v.manager === "string" ? v.manager : "" };
}
