// Run dsh (D1): install the Bun compatibility layer (D3), then run dsh from the on-disk app tree next to
// this executable (`bundles/<v>/dsh-native` + `bundles/<v>/app`). Imported by entry.ts for non-maintenance commands.
import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { dshArgv } from "./argv.ts";
import { officeWiring, SKILL_OFFICE, withOfficeNode } from "./compat/addons.ts";
import { degradedPlugin, HMR_DEGRADATION } from "./compat/degradations.ts";
import { installHostPackages } from "./compat/host-packages.ts";
import { installNodeModuleCompat } from "./compat/node-module-compat.ts";
import { installRequireBuiltin } from "./compat/require-builtin.ts";
import { dshHome, isCommitTime, readBundleMeta, USAGE_GUARD } from "./layout.ts";
import { createdLine, ensureSnapshot } from "./snapshot/auto.ts";
import { namedSnapshot, readLaunch } from "./snapshot/launch.ts";
import { seedTranspilerCache } from "./transpiler-cache.ts";
import { holdSessionClaim } from "./usage-claim.ts";

const bundleDir = dirname(process.execPath);
// D4: directly started processes (in-app restarts) take the same shared claim the launcher takes.
const guard = join(bundleDir, USAGE_GUARD);
if (existsSync(guard) && holdSessionClaim(guard) === "busy") {
	process.stderr.write("dsh: this bundle is being removed by `dsh update`; start dsh again to use the active version\n");
	process.exit(1);
}
// plugin-snapshots "Automatic snapshot by copy": a launch of a version with no snapshot, and no snapshot
// named, first gets one. Only an installed bundle (bundle.json with its build order) takes part.
const meta = readBundleMeta(bundleDir);
if (meta && isCommitTime(meta.upstream?.commitTime) && namedSnapshot(readLaunch()) === null) {
	try {
		const r = ensureSnapshot(dshHome(), meta.version, meta, "start", () => process.stderr.write("dsh: waiting for another dsh snapshot operation...\n"));
		if (r.created) process.stderr.write(`dsh: ${createdLine(r.snapshot)}\n`);
	} catch (error) {
		process.stderr.write(`dsh: cannot create the plugin snapshot of dsh ${meta.version}: ${(error as Error).message}\n`);
		process.exit(1);
	}
}

const appDir = realpathSync(join(bundleDir, "app"));
if (process.env.DSH_BUNDLE_VERSION) seedTranspilerCache(bundleDir, process.env.DSH_BUNDLE_VERSION);
const binJs = join(appDir, "lib", "bin.js");

// D5: the bundle's pnpm and node shims come first on PATH for dsh and everything it starts (the plugin
// manager's `pnpm`, lifecycle scripts' `node`, `#!/usr/bin/env node` MCP servers). An explicit
// plugin-manager pnpmCommand still wins because dsh passes it directly.
const shimDir = join(bundleDir, "bin");
if (existsSync(shimDir)) {
	const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
	const rest = (process.env[pathKey] ?? "").split(delimiter).filter((p) => p && p !== shimDir);
	process.env[pathKey] = [shimDir, ...rest].join(delimiter);
}

const office = officeWiring(bundleDir);
if (office.kind === "enabled" && office.warning) process.stderr.write(`${office.warning}\n`);
const degradations = [HMR_DEGRADATION, ...(office.kind === "degraded" ? office.degradations : [])];
const host = installHostPackages(appDir, {
	extra: office.kind === "enabled" ? office.extra : undefined,
	overrides: new Map(degradations.map((d) => [d.packageName, degradedPlugin(d)])),
	wrap: office.kind === "enabled" ? new Map([[SKILL_OFFICE, withOfficeNode(bundleDir)]]) : undefined,
});
installRequireBuiltin(join(appDir, "lib"), host.specifiers);
installNodeModuleCompat();

process.argv = dshArgv(process.argv, process.execPath, binJs);
const { runCli } = (await import(binJs)) as { runCli(): Promise<void> };
await runCli();
