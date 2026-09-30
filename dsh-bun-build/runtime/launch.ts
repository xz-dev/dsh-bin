// `DSH_MANAGER_LAUNCH` (split-dsh-manager design D3/D10): what the manager resolved for this process tree —
// the runtime, the data root, the application home, the plugin snapshot and the addon directories. The
// runtime only consumes it: it never picks another version, creates a snapshot or reads the selection.
// An in-app restart inherits the variable, so it runs on the same values.

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

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isAbs = (v: unknown): v is string => typeof v === "string" && /^([A-Za-z]:)?[\\/]/.test(v);

/** The manager's launch, or undefined for a direct start. A present but invalid payload is an error, never "no payload". */
export function readManagerLaunch(env: NodeJS.ProcessEnv = process.env): ManagerLaunch | undefined {
	const raw = env[LAUNCH_VAR];
	if (raw === undefined || raw === "") return undefined;
	let v: unknown;
	try {
		v = JSON.parse(raw);
	} catch {
		throw new LaunchError(`${LAUNCH_VAR} is not JSON`);
	}
	if (!isObj(v)) throw new LaunchError(`${LAUNCH_VAR} is not an object`);
	if (v.protocol !== LAUNCH_PROTOCOL) throw new LaunchError(`${LAUNCH_VAR} uses launch protocol ${String(v.protocol)}; this dsh runtime implements ${LAUNCH_PROTOCOL}`);
	if (typeof v.runtime !== "string" || !v.runtime || !isAbs(v.dataRoot) || !isAbs(v.home)) throw new LaunchError(`${LAUNCH_VAR} lacks runtime, dataRoot or home`);
	let snapshot: ManagerLaunch["snapshot"] = null;
	if (v.snapshot !== null && v.snapshot !== undefined) {
		if (!isObj(v.snapshot) || typeof v.snapshot.id !== "string" || !isAbs(v.snapshot.dir)) throw new LaunchError(`${LAUNCH_VAR} has an invalid snapshot`);
		snapshot = { id: v.snapshot.id, dir: v.snapshot.dir };
	}
	const addons: ManagerLaunch["addons"] = {};
	if (v.addons !== undefined && !isObj(v.addons)) throw new LaunchError(`${LAUNCH_VAR} has invalid addons`);
	const office = isObj(v.addons) ? v.addons.office : undefined;
	if (office !== undefined && office !== null) {
		if (!isObj(office) || typeof office.version !== "string" || !isAbs(office.dir)) throw new LaunchError(`${LAUNCH_VAR} has an invalid office addon`);
		addons.office = { version: office.version, dir: office.dir, ...(typeof office.warning === "string" ? { warning: office.warning } : {}) };
	}
	return {
		protocol: 1,
		runtime: v.runtime,
		dataRoot: v.dataRoot,
		home: v.home,
		snapshot,
		addons,
		cache: isAbs(v.cache) ? v.cache : null,
		manager: typeof v.manager === "string" ? v.manager : "",
	};
}
