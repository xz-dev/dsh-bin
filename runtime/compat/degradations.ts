// D8: declared degradations. A degraded plugin package is replaced by a stub that imports cleanly and
// fails its activation with a named reason, so dsh's startup audit lists it as an inactive optional
// entry with that reason. No plugin is required (dsh-app-boot's required set is agent-loop, webserver,
// modules, connection, headless-runner, acp, sdk-jsonrpc-server), so startup completes.

/** A plugin that cannot work in this runtime, with the reason shown in the startup audit. */
export class DeclaredDegradation extends Error {
	override name = "DeclaredDegradation";
	constructor(message: string) {
		super(message);
		// dsh prints `error.stack`; cordis appends only its outer plugin frames to it.
		this.stack = `${this.name}: ${message}`;
	}
}

export type Degradation = { packageName: string; reason: string };

export const HMR_DEGRADATION: Degradation = {
	packageName: "@deepseek-ai/dsh-hmr",
	reason: "hmr is unsupported in the Bun runtime (it needs Node's internal module loader); dsh-bin declared degradation",
};

export const OFFICE_PACKAGES = ["@deepseek-ai/dsh-office-to-pdf", "@deepseek-ai/dsh-skill-office"] as const;

/** The office degradation (D7b/D8), with the cause and the command that fixes it. */
export const officeDegradations = (cause: string): Degradation[] =>
	OFFICE_PACKAGES.map((packageName) => ({ packageName, reason: `LibreOffice Kit is unavailable: ${cause}; dsh-bin declared degradation` }));

/** Module namespace of the stub that replaces a degraded plugin package. */
export function degradedPlugin({ packageName, reason }: Degradation): Record<string, unknown> {
	const plugin = {
		name: packageName,
		apply() {
			throw new DeclaredDegradation(reason);
		},
	};
	return { default: plugin, ...plugin };
}

/** The one-line audit detail dsh prints for a degraded entry. */
export const degradationDetail = (d: Degradation) => `DeclaredDegradation: ${d.reason}`;
