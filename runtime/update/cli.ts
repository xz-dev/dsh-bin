// Maintenance command dispatch (self-update spec "Launcher owns the update command"). Runs before any
// usage claim, app resolution or compat layer, so it works whatever the upstream app contains.
import { type ParsedCommand, parseMaintenance, USAGE } from "./args.ts";
import { addonHints, clean, referencedHome, updateSelf } from "./bundle.ts";
import { installAddon, uninstallAddon } from "./addon.ts";
import { readAddonsState } from "../layout.ts";
import { activeMeta, type Context, resolveContext, UserError } from "./context.ts";
import { sweepLeftovers, withUpdateLock } from "./fsops.ts";
import { list } from "./list.ts";
import { pluginCompatWarning } from "./plugin-compat.ts";
import { join } from "node:path";

const HELP: Record<string, string[]> = {
	update: [
		`Usage: ${USAGE.update}`,
		"",
		"Update the dsh binary from xz-dev/dsh-bin releases, or an installed addon.",
		"  update, update self, update dsh, --self   update the binary only",
		"  --all                                     update the binary, then every installed addon",
		"  --addon <name> [--version <v|tag>]        update one installed addon (to its default, or to <v>)",
		"  --force                                   reinstall the current version (with --addon --version: allow out of slot)",
		"  --channel <live|release>                  switch channel (recorded after a successful update)",
		"  --clean                                   remove bundles and addon versions no longer in use (offline)",
		"Plugins are managed with `dsh plugin --profile <name> …`.",
	],
	install: [`Usage: ${USAGE.install}`, "", "Install an optional addon (office) for the active dsh bundle."],
	uninstall: [`Usage: ${USAGE.uninstall}`, "", "Disable an installed addon and remove its unused files."],
	list: [`Usage: ${USAGE.list}`, "", "Show installed and installable dsh and addon versions (read-only)."],
};

function refuseManaged(ctx: Context) {
	if (!ctx.managed) return;
	throw new UserError(`this dsh installation is managed by ${ctx.managed}; self-update is disabled.`, [`Upgrade dsh through ${ctx.managed} instead.`]);
}

async function run(cmd: ParsedCommand, ctx: Context) {
	if (cmd.help) return;
	if (cmd.command === "list") return list(ctx, cmd);
	refuseManaged(ctx);
	await withUpdateLock(ctx.root, async () => {
		// Staging/trash leftovers of an interrupted run are removed first (when no longer claimed).
		sweepLeftovers(ctx.root, referencedHome(ctx));
		switch (cmd.command) {
			case "install":
				await installAddon(ctx, activeMeta(ctx), { name: cmd.addon, version: cmd.version, force: cmd.force, mode: "install" });
				return;
			case "uninstall":
				uninstallAddon(ctx, cmd.addon);
				return;
			case "update": {
				if (cmd.clean) return clean(ctx);
				if (cmd.target.type === "addon") {
					await installAddon(ctx, activeMeta(ctx), { name: cmd.target.name, version: cmd.version, force: cmd.force, mode: "update" });
					return;
				}
				const self = await updateSelf(ctx, { channel: cmd.channel, force: cmd.force });
				if (self.updated) for (const line of await pluginCompatWarning(join(ctx.root, "bundles", self.version))) ctx.err(line);
				if (cmd.target.type === "all") {
					const meta = self.updated ? self.meta : activeMeta(ctx);
					for (const name of Object.keys(readAddonsState(ctx.root)) as "office"[]) {
						await installAddon(ctx, meta, { name, force: cmd.force, mode: "update" }, self.index);
					}
					return;
				}
				for (const line of addonHints(ctx, self.updated ? self.meta : activeMeta(ctx), self.index)) ctx.out(line);
			}
		}
	});
}

/** Run a maintenance command; resolves to the process exit status. */
export async function main(argv: readonly string[], execPath = process.execPath): Promise<number> {
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
		if (error instanceof UserError) {
			process.stderr.write(`error: ${error.message}\n${error.hints.map((h) => `${h}\n`).join("")}`);
			return error.code;
		}
		process.stderr.write(`error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
		return 1;
	}
}
