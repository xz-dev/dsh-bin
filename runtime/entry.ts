// Compiled entry (D1): install the Bun compatibility layer (D3), then run dsh from the on-disk app tree
// next to this executable (`bundles/<v>/dsh-native` + `bundles/<v>/app`).
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { installHostPackages } from "./compat/host-packages.ts";
import { installNodeModuleCompat } from "./compat/node-module-compat.ts";
import { installRequireBuiltin } from "./compat/require-builtin.ts";

const appDir = realpathSync(join(dirname(process.execPath), "app"));
const binJs = join(appDir, "lib", "bin.js");

installRequireBuiltin(join(appDir, "lib"));
installHostPackages(appDir);
installNodeModuleCompat();

// dsh reads `process.argv.slice(2)` and respawns itself with `argv.slice(1)` (D3, restart normalization).
process.argv = [process.execPath, binJs, ...process.argv.slice(2)];
const { runCli } = (await import(binJs)) as { runCli(): Promise<void> };
await runCli();
