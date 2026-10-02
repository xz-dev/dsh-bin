// Compiled entry (D1) loads the on-disk upstream app next to this executable. Under protocol v1,
// consume manager-selected home/snapshot/addons only; direct starts retain upstream behavior.
import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { dshArgv, userArgs } from "./argv.ts";
import { officeWiring, SKILL_OFFICE, withOfficeNode } from "./compat/addons.ts";
import { degradedPlugin, HMR_DEGRADATION } from "./compat/degradations.ts";
import { installHostPackages } from "./compat/host-packages.ts";
import { installNodeModuleCompat } from "./compat/node-module-compat.ts";
import { installRequireBuiltin } from "./compat/require-builtin.ts";
import { LaunchError, readManagerLaunch } from "./launch.ts";
import { seedTranspilerCache } from "./transpiler-cache.ts";
import { holdSessionClaim } from "./usage-claim.ts";

const USAGE_GUARD = ".usage.lock";
const bundleDir = dirname(process.execPath);

function fail(message: string): never {
	process.stderr.write(`dsh: ${message}\n`);
	process.exit(1);
}

const launch = (() => {
	try {
		return readManagerLaunch();
	} catch (error) {
		if (!(error instanceof LaunchError)) throw error;
		fail(`${error.message}; start dsh through the dsh manager`);
	}
})();

// Reacquire claims after direct in-app respawn; no version/snapshot decisions here.
const claim = (dir: string, label: string) => {
	const guard = join(dir, USAGE_GUARD);
	if (existsSync(guard) && holdSessionClaim(guard) === "busy") fail(`${label} is being removed by the dsh manager; start dsh again`);
};
claim(bundleDir, "this dsh runtime");
if (launch) {
	process.env.DSH_HOME = launch.home;
	delete process.env.DSH_BIN_SNAPSHOT_DIR;
	const snapshot = launch.snapshot;
	if (snapshot) {
		if (!existsSync(snapshot.dir)) fail(`plugin snapshot ${snapshot.id} does not exist; start dsh again`);
		claim(snapshot.dir, `plugin snapshot ${snapshot.id}`);
		process.env.DSH_BIN_SNAPSHOT_DIR = snapshot.dir;
	}
}

const appDir = realpathSync(join(bundleDir, "app"));
const binJs = join(appDir, "lib", "bin.js");
const user = userArgs(process.argv, binJs);

if (launch) seedTranspilerCache(bundleDir, launch.runtime);

// D5: the bundle's pnpm and node shims come first on PATH for dsh and everything it starts (the plugin
// manager's `pnpm`, lifecycle scripts' `node`, `#!/usr/bin/env node` MCP servers). An explicit
// plugin-manager pnpmCommand still wins because dsh passes it directly.
const shimDir = join(bundleDir, "bin");
if (existsSync(shimDir)) {
	const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
	const rest = (process.env[pathKey] ?? "").split(delimiter).filter((p) => p && p !== shimDir);
	process.env[pathKey] = [shimDir, ...rest].join(delimiter);
}

const office = officeWiring(launch?.addons.office);
if (office.kind === "enabled" && office.warning) process.stderr.write(`${office.warning}\n`);
const degradations = [HMR_DEGRADATION, ...(office.kind === "degraded" ? office.degradations : [])];
const host = installHostPackages(appDir, {
	extra: office.kind === "enabled" ? office.extra : undefined,
	overrides: new Map(degradations.map((d) => [d.packageName, degradedPlugin(d)])),
	wrap: office.kind === "enabled" ? new Map([[SKILL_OFFICE, withOfficeNode(bundleDir)]]) : undefined,
});
installRequireBuiltin(join(appDir, "lib"), host.specifiers);
installNodeModuleCompat();

process.argv = dshArgv([process.argv[0]!, process.argv[1]!, ...user], process.execPath, binJs);
const { runCli } = (await import(binJs)) as { runCli(): Promise<void> };
await runCli();
