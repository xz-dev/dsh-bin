// Maintenance command dispatch (self-update spec "Launcher owns the update command"). Runs before any
// usage claim, app resolution or compat layer, so it works whatever the upstream app contains.
import { isMaintenance, type ParsedCommand, parseMaintenance, USAGE } from "./args.ts";
import { parseLeading, writeLaunch } from "../snapshot/launch.ts";
import { cleanTranspiler, cleanUpdateLeftovers, newSlotHints, referencedHome, updateSelf } from "./bundle.ts";
import { installAddon, uninstallAddon } from "./addon.ts";
import { dshHome, type BundleMeta } from "../layout.ts";
import { sweepSnapshotLeftovers } from "../snapshot/store.ts";
import { type Context, resolveContext, UserError } from "./context.ts";
import { sweepLeftovers, withUpdateLock } from "./fsops.ts";
import { list } from "./list.ts";
import { effectiveBundle, select } from "./select.ts";
import { snapshot } from "./snapshot.ts";
import { installVersion, pinnedWarning, uninstallVersions } from "./versions.ts";

/** Bundle an addon command acts on: the effective version, or the running bundle when it does not resolve. */
function addonTarget(ctx: Context): BundleMeta {
	try {
		return effectiveBundle(ctx);
	} catch {
		return ctx.meta;
	}
}

const HELP: Record<string, string[]> = {
	update: [
		`Usage: ${USAGE.update}`,
		"",
		"Install the newest dsh version of the channel from xz-dev/dsh-bin releases, next to the installed ones.",
		"It never changes the selection (`dsh select`); older versions stay until `dsh uninstall <version>`.",
		"  update, update self, update dsh, --self   the same install",
		"  --force                                   reinstall the newest version when it is already installed",
		"  --channel <live|release>                  switch channel (recorded after a successful update)",
		"Addons: `dsh install --addon <name>`. Plugins are managed with `dsh plugin --profile <name> …`.",
	],
	clean: [
		`Usage: ${USAGE.clean}`,
		"",
		"Remove what dsh-bin leaves behind (offline). No option means --all.",
		"  --update       leftovers of interrupted installs, updates and uninstalls, and partial downloads",
		"  --snapshots    interrupted snapshot copies and removals",
		"  --transpiler   dsh-bin's own transpiler cache (a path you set yourself is left alone)",
		"Installed versions and snapshots are removed only by `dsh uninstall` and `dsh snapshot remove`.",
	],
	install: [
		`Usage: ${USAGE.install}`,
		"",
		"Install a dsh version next to the installed ones, or an optional addon (office) for the active dsh bundle.",
		"  <version>                  exact version, its tag, or an upstream version (0.1.7-rc.2: its newest build)",
		"  --channel <live|release>   index channel to look the version up in (default: the recorded channel)",
		"  --force                    reinstall an installed version",
		"Installing never changes the selection (`dsh select`).",
	],
	uninstall: [
		`Usage: ${USAGE.uninstall}`,
		"",
		"Remove installed dsh versions (not the last one, one in use, or the one `dsh select` pins); their plugin",
		"snapshots are kept. With --addon, disable an installed addon and remove its unused files.",
	],
	list: [`Usage: ${USAGE.list}`, "", "Show installed and installable dsh and addon versions (read-only)."],
	select: [
		`Usage: ${USAGE.select}`,
		"",
		"Choose what a plain `dsh` launch uses; with no options, print the selection and what it resolves to.",
		"  --use <version|latest>        installed version (exact, tag or unique prefix); latest follows new installs",
		"  --snapshot <id>               plugin snapshot <version>@<n|name>, of any version (default: the version's newest)",
		"  --addon <name>:<version>      installed addon version (default: the newest in-slot one)",
		"Omitted options go back to their default. Managed installs accept only --snapshot.",
	],
	snapshot: [
		`Usage: ${USAGE.snapshot}`,
		"",
		"Plugin-runtime snapshots <version>@<n>; a launch uses its version's newest one unless one is named.",
		"  new [--target <id>] [--name <alias>]   copy <id> (default: the newest of the effective version) into a new",
		"                                         snapshot of the effective version (`dsh --use <v> snapshot new`)",
		"  new --empty [--name <alias>]           a new empty snapshot",
		"  remove <id>...                         remove snapshots (not one in use or named by `dsh select`)",
		"  list [--json]                          every snapshot, with the newest, selected and in-use ones marked",
	],
};

function refuseManaged(ctx: Context) {
	if (!ctx.managed) return;
	throw new UserError(`this dsh installation is managed by ${ctx.managed}; self-update is disabled.`, [`Upgrade dsh through ${ctx.managed} instead.`]);
}

async function run(cmd: ParsedCommand, ctx: Context) {
	if (cmd.help) return;
	if (cmd.command === "list") return list(ctx, cmd);
	if (cmd.command === "select") return select(ctx, cmd);
	if (cmd.command === "snapshot") return snapshot(ctx, cmd);
	if (cmd.command === "clean") return clean(ctx, cmd.parts);
	refuseManaged(ctx);
	await withUpdateLock(ctx.root, async () => {
		// Staging/trash leftovers of an interrupted run are removed first (when no longer claimed).
		sweepLeftovers(ctx.root, referencedHome(ctx));
		switch (cmd.command) {
			case "install":
				if ("bundle" in cmd) return installVersion(ctx, { query: cmd.bundle, channel: cmd.channel, force: cmd.force });
				await installAddon(ctx, addonTarget(ctx), { name: cmd.addon, version: cmd.version, force: cmd.force, mode: "install" });
				return;
			case "uninstall":
				if ("bundles" in cmd) return uninstallVersions(ctx, cmd.bundles);
				uninstallAddon(ctx, cmd.addon);
				return;
			case "update": {
				const self = await updateSelf(ctx, { channel: cmd.channel, force: cmd.force });
				if (!self.updated) return;
				for (const line of newSlotHints(ctx, self.meta)) ctx.out(line);
				for (const line of pinnedWarning(ctx, self.version)) ctx.err(line);
			}
		}
	});
}

/**
 * `dsh clean` (self-update "Cleanup"): offline, each part only what can be claimed. A managed install root
 * belongs to the package manager, so `--update` is skipped there.
 */
async function clean(ctx: Context, parts: readonly string[]) {
	if (parts.includes("update")) {
		if (ctx.managed) ctx.out(`Skipped the install root: it is managed by ${ctx.managed}.`);
		else await withUpdateLock(ctx.root, async () => cleanUpdateLeftovers(ctx));
	}
	if (parts.includes("snapshots")) ctx.out(`Removed ${sweepSnapshotLeftovers(dshHome())} interrupted snapshot leftover(s)`);
	if (parts.includes("transpiler")) cleanTranspiler(ctx);
}

/** Run a maintenance command; resolves to the process exit status. */
export async function main(argv: readonly string[], execPath = process.execPath): Promise<number> {
	if (!isMaintenance(argv)) {
		// A direct start with leading options: strip and record them as the launcher would. Any installed
		// version can be the effective one (under the launcher, maintenance runs on the newest bundle).
		const p = parseLeading(argv);
		if ("error" in p) return report(new UserError(p.error));
		writeLaunch({ version: null, source: p.use ? "use" : p.snapshot ? "snapshot" : null, use: p.use, snapshot: p.snapshot, addons: p.addons, selection: null });
		argv = p.rest;
	}
	const parsed = parseMaintenance(argv);
	if (!parsed) return 2;
	if ("error" in parsed) {
		process.stderr.write(`error: ${parsed.error}\nUsage: ${parsed.usage}\n`);
		return 1;
	}
	if (parsed.help) {
		process.stdout.write(`${HELP[parsed.command]!.join("\n")}\n`);
		return 0;
	}
	try {
		await run(parsed, resolveContext(execPath));
		return 0;
	} catch (error) {
		return report(error);
	}
}

function report(error: unknown): number {
	if (error instanceof UserError) {
		process.stderr.write(`error: ${error.message}\n${error.hints.map((h) => `${h}\n`).join("")}`);
		return error.code;
	}
	process.stderr.write(`error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	return 1;
}
