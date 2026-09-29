// `DSH_BIN_LAUNCH`: what the launcher parsed and resolved (design S2). The launcher resolves only the
// version; the runtime reads the rest from here. A restart inherits the variable, so the restarted process
// makes the same decisions (launcher spec "Restart re-enters through the launcher").

export type VersionSource = "use" | "snapshot" | "selection" | "managed";

export type Launch = {
	version: string | null;
	source: VersionSource | null;
	use: string | null;
	snapshot: string | null;
	addons: string[];
	selection: { use?: unknown; snapshot?: unknown; addons?: unknown } | null;
};

/** The launch record, or undefined when the process was not started by a protocol-2 launcher. */
export function readLaunch(env: NodeJS.ProcessEnv = process.env): Launch | undefined {
	const raw = env.DSH_BIN_LAUNCH;
	if (!raw) return undefined;
	try {
		const v = JSON.parse(raw);
		if (!v || typeof v !== "object" || v.protocol !== 2) return undefined;
		const str = (x: unknown) => (typeof x === "string" ? x : null);
		return {
			version: str(v.version),
			source: ["use", "snapshot", "selection", "managed"].includes(v.source) ? v.source : null,
			use: str(v.use),
			snapshot: str(v.snapshot),
			addons: Array.isArray(v.addons) ? v.addons.filter((a: unknown) => typeof a === "string") : [],
			selection: v.selection && typeof v.selection === "object" && !Array.isArray(v.selection) ? v.selection : null,
		};
	} catch {
		return undefined;
	}
}

/**
 * The snapshot id the launch names (version-selection "Selection resolution"): the launch's `--snapshot`,
 * else the selection's when the version came from the selection (or is fixed by a managed install).
 * Null: the resolved version's newest snapshot.
 */
export function namedSnapshot(launch: Launch | undefined): string | null {
	if (!launch) return null;
	if (launch.snapshot) return launch.snapshot;
	if (launch.source !== "selection" && launch.source !== "managed") return null;
	return typeof launch.selection?.snapshot === "string" ? launch.selection.snapshot : null;
}
