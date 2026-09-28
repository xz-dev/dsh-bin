// Compiled entry (D1): install the Bun compatibility layer (D3), then run dsh from the on-disk app tree
// next to this executable (`bundles/<v>/dsh-native` + `bundles/<v>/app`).
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { dshArgv } from "./argv.ts";
import { officeWiring, SKILL_OFFICE, withOfficeNode } from "./compat/addons.ts";
import { degradedPlugin, HMR_DEGRADATION } from "./compat/degradations.ts";
import { installHostPackages } from "./compat/host-packages.ts";
import { installNodeModuleCompat } from "./compat/node-module-compat.ts";
import { installRequireBuiltin } from "./compat/require-builtin.ts";

const bundleDir = dirname(process.execPath);
const appDir = realpathSync(join(bundleDir, "app"));
const binJs = join(appDir, "lib", "bin.js");

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
