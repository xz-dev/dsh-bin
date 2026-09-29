// `DSH_BIN_LAUNCH`: what the launcher parsed and resolved (design S2). The launcher resolves only the
// version; the runtime resolves the snapshot and records it in `resolved`, so a restart, which inherits the
// variable, runs on the same values (launcher spec "Restart re-enters through the launcher"). A fresh launch
// through the launcher always replaces the variable.

export type VersionSource = "use" | "snapshot" | "selection" | "managed";

export type Launch = {
	version: string | null;
	source: VersionSource | null;
	use: string | null;
	snapshot: string | null;
	addons: string[];
	selection: { use?: unknown; snapshot?: unknown; addons?: unknown } | null;
	/** Set by the runtime once resolved: the snapshot id this process tree runs on. */
	resolved?: { snapshot: string };
};

/** The launch record, or undefined when the process was not started by a protocol-2 launcher. */
export function readLaunch(env: NodeJS.ProcessEnv = process.env): Launch | undefined {
	const raw = env.DSH_BIN_LAUNCH;
	if (!raw) return undefined;
	try {
		const v = JSON.parse(raw);
		if (!v || typeof v !== "object" || v.protocol !== 2) return undefined;
		const str = (x: unknown) => (typeof x === "string" ? x : null);
		const launch: Launch = {
			version: str(v.version),
			source: ["use", "snapshot", "selection", "managed"].includes(v.source) ? v.source : null,
			use: str(v.use),
			snapshot: str(v.snapshot),
			addons: Array.isArray(v.addons) ? v.addons.filter((a: unknown) => typeof a === "string") : [],
			selection: v.selection && typeof v.selection === "object" && !Array.isArray(v.selection) ? v.selection : null,
		};
		if (typeof v.resolved?.snapshot === "string") launch.resolved = { snapshot: v.resolved.snapshot };
		return launch;
	} catch {
		return undefined;
	}
}

export const writeLaunch = (launch: Launch, env: NodeJS.ProcessEnv = process.env) => {
	env.DSH_BIN_LAUNCH = JSON.stringify({ protocol: 2, ...launch });
};

/**
 * The snapshot id the launch names (version-selection "Selection resolution"): the one already resolved
 * (a restart), the launch's `--snapshot`, else the selection's when the version came from the selection
 * (or is fixed by a managed install). Null: the resolved version's newest snapshot.
 */
export function namedSnapshot(launch: Launch | undefined): string | null {
	if (!launch) return null;
	if (launch.resolved) return launch.resolved.snapshot;
	if (launch.snapshot) return launch.snapshot;
	if (launch.source !== "selection" && launch.source !== "managed") return null;
	return typeof launch.selection?.snapshot === "string" ? launch.selection.snapshot : null;
}

export type Leading = { use: string | null; snapshot: string | null; addons: string[]; rest: string[] };

/**
 * Leading `--use/--snapshot/--addon` (`--opt value` or `--opt=value`) before the first other argument, as the
 * launcher parses them (launcher `parseLeading`). Everything from the first other argument is kept unchanged.
 */
export function parseLeading(args: readonly string[]): Leading | { error: string } {
	const out: Leading = { use: null, snapshot: null, addons: [], rest: [] };
	let i = 0;
	while (i < args.length) {
		const arg = args[i]!;
		const name = ["--use", "--snapshot", "--addon"].find((n) => arg === n || arg.startsWith(`${n}=`));
		if (!name) break;
		let value: string | undefined;
		if (arg.length > name.length) {
			value = arg.slice(name.length + 1);
			i += 1;
		} else {
			value = args[i + 1];
			i += 2;
		}
		if (!value) return { error: `${name} requires a value` };
		if (name === "--addon") out.addons.push(value);
		else {
			const key = name === "--use" ? "use" : "snapshot";
			if (out[key] !== null) return { error: `${name} given more than once` };
			out[key] = value;
		}
	}
	out.rest = args.slice(i);
	return out;
}
