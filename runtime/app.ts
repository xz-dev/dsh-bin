// Run dsh (D1): install the Bun compatibility layer (D3), then run dsh from the on-disk app tree next to
// this executable (`bundles/<v>/dsh-native` + `bundles/<v>/app`). Imported by entry.ts for non-maintenance commands.
import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { dshArgv, userArgs } from "./argv.ts";
import { officeWiring, SKILL_OFFICE, withOfficeNode } from "./compat/addons.ts";
import { degradedPlugin, HMR_DEGRADATION } from "./compat/degradations.ts";
import { installHostPackages } from "./compat/host-packages.ts";
import { installNodeModuleCompat } from "./compat/node-module-compat.ts";
import { installRequireBuiltin } from "./compat/require-builtin.ts";
import { dshHome, isCommitTime, readBundleMeta, USAGE_GUARD } from "./layout.ts";
import { UserError } from "./update/context.ts";
import { createdLine } from "./snapshot/auto.ts";
import { namedAddon, readLaunch, writeLaunch } from "./snapshot/launch.ts";
import { applyLeading, resolveSnapshot } from "./snapshot/resolve.ts";
import { snapshotDir } from "./snapshot/store.ts";
import type { Claim } from "./usage-claim.ts";
import { seedTranspilerCache } from "./transpiler-cache.ts";
import { holdSessionClaim } from "./usage-claim.ts";

const bundleDir = dirname(process.execPath);
// D4: directly started processes (in-app restarts) take the same shared claim the launcher takes.
const guard = join(bundleDir, USAGE_GUARD);
if (existsSync(guard) && holdSessionClaim(guard) === "busy") {
	process.stderr.write("dsh: this bundle is being removed by `dsh update`; start dsh again to use the active version\n");
	process.exit(1);
}
const appDir = realpathSync(join(bundleDir, "app"));
const binJs = join(appDir, "lib", "bin.js");

// Plugin snapshots (S2/S3): resolve the snapshot this process tree runs on, hold its shared claim for the
// process lifetime, point upstream's profile paths at it (DSH_BIN_SNAPSHOT_DIR), and record it in
// DSH_BIN_LAUNCH so an in-app restart, which inherits the environment, runs on the same one. Only an
// installed bundle (bundle.json with its build order) takes part; a bare app tree keeps upstream's paths.
let user = userArgs(process.argv, binJs);
let snapshotClaim: Claim | undefined;
const meta = readBundleMeta(bundleDir);
if (meta && isCommitTime(meta.upstream?.commitTime)) {
	try {
		const leading = applyLeading(user, meta.version, readLaunch());
		user = leading.args;
		const home = dshHome();
		const r = resolveSnapshot(home, meta, leading.launch, () => process.stderr.write("dsh: waiting for another dsh snapshot operation...\n"));
		snapshotClaim = r.claim;
		if (r.created) process.stderr.write(`dsh: ${createdLine(r.snapshot)}\n`);
		process.env.DSH_BIN_SNAPSHOT_DIR = snapshotDir(home, r.snapshot.id);
		const base = leading.launch ?? { version: meta.version, source: null, use: null, snapshot: null, addons: [], selection: null };
		writeLaunch({ ...base, version: meta.version, resolved: { snapshot: r.snapshot.id } });
	} catch (error) {
		if (!(error instanceof UserError)) throw error;
		process.stderr.write(`dsh: ${error.message}\n${error.hints.map((h) => `${h}\n`).join("")}`);
		process.exit(error.code);
	}
}
// Held until the process exits (the kernel releases it); referenced so the intent is explicit.
void snapshotClaim;

if (process.env.DSH_BUNDLE_VERSION) seedTranspilerCache(bundleDir, process.env.DSH_BUNDLE_VERSION);

// D5: the bundle's pnpm and node shims come first on PATH for dsh and everything it starts (the plugin
// manager's `pnpm`, lifecycle scripts' `node`, `#!/usr/bin/env node` MCP servers). An explicit
// plugin-manager pnpmCommand still wins because dsh passes it directly.
const shimDir = join(bundleDir, "bin");
if (existsSync(shimDir)) {
	const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
	const rest = (process.env[pathKey] ?? "").split(delimiter).filter((p) => p && p !== shimDir);
	process.env[pathKey] = [shimDir, ...rest].join(delimiter);
}

// The office version this launch uses (the named one, or the in-slot default); a named version that is not
// installed fails the launch with one diagnostic, never falling back to another version.
let office: ReturnType<typeof officeWiring>;
try {
	let named: string | undefined;
	try {
		named = namedAddon(readLaunch(), "office");
	} catch (error) {
		throw new UserError((error as Error).message);
	}
	office = officeWiring(bundleDir, named);
} catch (error) {
	if (!(error instanceof UserError)) throw error;
	process.stderr.write(`dsh: ${error.message}\n${error.hints.map((h) => `${h}\n`).join("")}`);
	process.exit(error.code);
}
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
