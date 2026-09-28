// D7b startup wiring: decide from the install root whether the enabled office addon is usable by this
// bundle, and produce the host-package extras (kit packages) or the declared office degradation.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	addonDir,
	exeName,
	installOf,
	readAddonMeta,
	readAddonsState,
	readBundleMeta,
	sameSlot,
	slotLabel,
} from "../layout.ts";
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

export function officeWiring(bundleDir: string): OfficeWiring {
	const install = installOf(bundleDir);
	const enabled = install && readAddonsState(install.root).office;
	if (!install || !enabled) {
		return { kind: "degraded", degradations: officeDegradations("the office addon is not installed; run `dsh install --addon office`") };
	}
	const dir = addonDir(install.root, "office", enabled.version);
	const meta = readAddonMeta(dir);
	const extra = kitPackages(dir);
	if (!meta || extra.size === 0) {
		return {
			kind: "degraded",
			degradations: officeDegradations(`the enabled office addon ${enabled.version} is missing or incomplete; run \`dsh update --addon office\``),
		};
	}
	const bundleSlot = readBundleMeta(bundleDir)?.addons?.office?.slot;
	if (sameSlot(meta.slot, bundleSlot)) return { kind: "enabled", version: enabled.version, dir, extra };
	if (enabled.forced) {
		return {
			kind: "enabled",
			version: enabled.version,
			dir,
			extra,
			warning: `dsh: warning: office addon ${enabled.version} is forced out of slot (addon slot ${slotLabel(meta.slot)}, bundle slot ${slotLabel(bundleSlot)}); run \`dsh update --addon office\` to return to the default`,
		};
	}
	return {
		kind: "degraded",
		degradations: officeDegradations(
			`office addon ${enabled.version} is out of slot for this bundle (addon slot ${slotLabel(meta.slot)}, bundle slot ${slotLabel(bundleSlot)}); run \`dsh update --addon office\``,
		),
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
