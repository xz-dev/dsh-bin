// D7b startup wiring: resolve the office addon version a launch uses (version-selection "Selection
// resolution") and produce the host-package extras (kit packages) or the declared office degradation.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { addonDir, defaultAddon, exeName, installedAddons, installOf, managedBy, readAddonMeta, readBundleMeta, sameSlot, slotLabel, USAGE_GUARD } from "../layout.ts";
import { UserError } from "../update/context.ts";
import { holdSessionClaim } from "../usage-claim.ts";
import { type Degradation, OFFICE_PACKAGES, officeDegradations } from "./degradations.ts";

const KIT = /^@deepseek-ai\/libreoffice-kit(?:-.+)?$/;

export type OfficeWiring =
	| { kind: "enabled"; version: string; dir: string; warning?: string; extra: Map<string, string> }
	| { kind: "degraded"; degradations: Degradation[] };

/** First-party kit packages (name → dir) inside an installed addon version. */
function kitPackages(dir: string): Map<string, string> {
	const scope = join(dir, "node_modules", "@deepseek-ai");
	const found = new Map<string, string>();
	if (!existsSync(scope)) return found;
	for (const entry of readdirSync(scope)) {
		const name = `@deepseek-ai/${entry}`;
		if (KIT.test(name)) found.set(name, join(scope, entry));
	}
	return found;
}

/**
 * The office addon of a launch of the bundle in `bundleDir`. `named`: the version the launch names (its
 * `--addon office:<v>`, or the selection's when the version came from the selection); otherwise the
 * **default**, the installed in-slot version with the highest index sequence. A managed install uses the one
 * version its package installed. A named version that is not installed fails the launch (UserError, no
 * fallback); a named out-of-slot version is used with a warning; no in-slot default degrades office.
 * The session holds the chosen version's shared usage claim, so it is not removed under it.
 */
export function officeWiring(bundleDir: string, named?: string): OfficeWiring {
	const install = installOf(bundleDir);
	const bundleSlot = readBundleMeta(bundleDir)?.addons?.office?.slot;
	const installed = install ? installedAddons(install.root, "office") : [];
	const managed = install && managedBy(install.root, bundleDir);
	let version: string | undefined;
	if (named && !managed) {
		version = named.replace(/^dsh-addon-office-v/, "");
		if (!installed.some((a) => a.version === version)) {
			throw new UserError(`office addon ${version} is not installed`, [`Run \`dsh install --addon office:${version}\` to install it.`]);
		}
	} else {
		version = (managed ? installed.filter((a) => sameSlot(a.slot, bundleSlot)).at(-1) : defaultAddon(installed, bundleSlot))?.version;
		if (!version) {
			const why = installed.length ? `no installed office addon version fits this dsh (slot ${slotLabel(bundleSlot)})` : "the office addon is not installed";
			return { kind: "degraded", degradations: officeDegradations(`${why}; run \`dsh install --addon office\``) };
		}
	}
	const dir = addonDir(install!.root, "office", version);
	const meta = readAddonMeta(dir);
	const extra = kitPackages(dir);
	if (!meta || extra.size === 0) {
		return { kind: "degraded", degradations: officeDegradations(`office addon ${version} is incomplete; run \`dsh install --addon office:${version} --force\``) };
	}
	const guard = join(dir, USAGE_GUARD);
	if (existsSync(guard) && holdSessionClaim(guard) === "busy") {
		return { kind: "degraded", degradations: officeDegradations(`office addon ${version} is being removed; start dsh again`) };
	}
	if (sameSlot(meta.slot, bundleSlot)) return { kind: "enabled", version, dir, extra };
	return {
		kind: "enabled",
		version,
		dir,
		extra,
		warning: `dsh: warning: office addon ${version} is out of slot for this dsh (addon slot ${slotLabel(meta.slot)}, bundle slot ${slotLabel(bundleSlot)}); it is unsupported`,
	};
}

/**
 * skill-office runs the kit CLI as `<node> <cli.js>` and defaults `node` to `process.execPath`, which is
 * dsh-native here. Default it to the bundle's `bin/node` shim instead; an explicit config still wins.
 */
export function withOfficeNode(bundleDir: string, platform = process.platform) {
	const node = join(bundleDir, "bin", platform === "win32" ? "node.cmd" : exeName("node", platform));
	return (exports: Record<string, unknown>): Record<string, unknown> => {
		const apply = exports.apply as (ctx: unknown, config?: Record<string, unknown>) => unknown;
		const wrapped = (ctx: unknown, config: Record<string, unknown> = {}) => apply(ctx, { node, ...config });
		return { ...exports, apply: wrapped, ...(exports.default ? { default: { ...(exports.default as object), apply: wrapped } } : {}) };
	};
}

export const SKILL_OFFICE = OFFICE_PACKAGES[1];
