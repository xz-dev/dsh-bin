// Compiled entry (D1): install the Bun compatibility layer (D3), then run dsh from the on-disk app tree
// next to this executable (`bundles/<v>/dsh-native` + `bundles/<v>/app`).
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { dshArgv } from "./argv.ts";
import { installHostPackages } from "./compat/host-packages.ts";
import { installNodeModuleCompat } from "./compat/node-module-compat.ts";
import { installRequireBuiltin } from "./compat/require-builtin.ts";

const appDir = realpathSync(join(dirname(process.execPath), "app"));
const binJs = join(appDir, "lib", "bin.js");

installRequireBuiltin(join(appDir, "lib"));
installHostPackages(appDir);
installNodeModuleCompat();

process.argv = dshArgv(process.argv, process.execPath, binJs);
const { runCli } = (await import(binJs)) as { runCli(): Promise<void> };
await runCli();
