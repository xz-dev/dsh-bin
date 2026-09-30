// Office addon wiring at startup: the manager chose the addon version (or none) and passes its directory in
// `DSH_MANAGER_LAUNCH`; the runtime turns it into host-package extras (the kit packages) or the declared
// office degradation. It never picks a version itself.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { holdSessionClaim } from "../usage-claim.ts";
import { type Degradation, OFFICE_PACKAGES, officeDegradations } from "./degradations.ts";

const KIT = /^@deepseek-ai\/libreoffice-kit(?:-.+)?$/;
const USAGE_GUARD = ".usage.lock";

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
 * The office addon the manager resolved for this launch (`undefined`: none fits, office degrades). The session
 * holds the version's shared usage claim again, so an in-app restart keeps it protected.
 */
export function officeWiring(office: { version: string; dir: string; warning?: string } | undefined): OfficeWiring {
	if (!office) return { kind: "degraded", degradations: officeDegradations("the office addon is not installed for this dsh; run `dsh manager install --addon office`") };
	const extra = kitPackages(office.dir);
	if (extra.size === 0) {
		return { kind: "degraded", degradations: officeDegradations(`office addon ${office.version} is incomplete; run \`dsh manager install --addon office:${office.version} --force\``) };
	}
	const guard = join(office.dir, USAGE_GUARD);
	if (existsSync(guard) && holdSessionClaim(guard) === "busy") {
		return { kind: "degraded", degradations: officeDegradations(`office addon ${office.version} is being removed; start dsh again`) };
	}
	return { kind: "enabled", version: office.version, dir: office.dir, extra, ...(office.warning ? { warning: office.warning } : {}) };
}

/**
 * skill-office runs the kit CLI as `<node> <cli.js>` and defaults `node` to `process.execPath`, which is
 * dsh-native here. Default it to the bundle's `bin/node` shim instead; an explicit config still wins.
 */
export function withOfficeNode(bundleDir: string, platform = process.platform) {
	const node = join(bundleDir, "bin", platform === "win32" ? "node.cmd" : "node");
	return (exports: Record<string, unknown>): Record<string, unknown> => {
		const apply = exports.apply as (ctx: unknown, config?: Record<string, unknown>) => unknown;
		const wrapped = (ctx: unknown, config: Record<string, unknown> = {}) => apply(ctx, { node, ...config });
		return { ...exports, apply: wrapped, ...(exports.default ? { default: { ...(exports.default as object), apply: wrapped } } : {}) };
	};
}

export const SKILL_OFFICE = OFFICE_PACKAGES[1];
