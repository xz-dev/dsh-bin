// Argument parsing for `dsh update|install|uninstall|list` (self-update spec, "Command surface" and
// "Listing versions"). A port of pi's parsePackageCommand update branch: extension targets removed,
// `--addon`/`--version`/`--channel` added. Every error exits 1; only the first error found is reported,
// in pi's order (unknown option, missing value, bad value, unexpected argument, conflicts).
import { ADDON_NAMES, type AddonName, type Channel, CHANNELS } from "../layout.ts";

export const MAINTENANCE_COMMANDS = ["update", "install", "uninstall", "list", "select", "snapshot"] as const;
export type MaintenanceCommand = (typeof MAINTENANCE_COMMANDS)[number];

export type UpdateTarget = { type: "self" } | { type: "all" } | { type: "addon"; name: AddonName };
export type ParsedCommand =
	| { command: MaintenanceCommand; help: true }
	| { command: "update"; help: false; clean: true }
	| { command: "update"; help: false; clean: false; target: UpdateTarget; force: boolean; channel?: Channel; version?: string }
	| { command: "install"; help: false; addon: AddonName; version?: string; force: boolean }
	| { command: "install"; help: false; bundle: string; channel?: Channel; force: boolean }
	| { command: "uninstall"; help: false; addon: AddonName }
	| { command: "uninstall"; help: false; bundles: string[] }
	| { command: "list"; help: false; addon?: AddonName; channel?: Channel; json: boolean }
	| { command: "select"; help: false; use?: string; snapshot?: string; addons: { name: AddonName; version: string }[] }
	| { command: "snapshot"; help: false; action: "new"; target?: string; name?: string; empty: boolean }
	| { command: "snapshot"; help: false; action: "remove"; ids: string[] }
	| { command: "snapshot"; help: false; action: "list"; json: boolean };
export type ParseError = { command: MaintenanceCommand; error: string; usage: string };
export type ParseResult = ParsedCommand | ParseError;

export const PLUGIN_REDIRECT = "Plugins are managed with `dsh plugin --profile <name> …`.";
const VALID_CHANNELS = `valid channels: ${[...CHANNELS].sort().join(", ")}`;
const VALID_ADDONS = `valid addons: ${ADDON_NAMES.join(", ")}`;

export const USAGE: Record<MaintenanceCommand, string> = {
	update: "dsh update [self|dsh] [--self | --all | --addon <name> [--version <v>]] [--force] [--channel <live|release>] | dsh update --clean",
	install: "dsh install <version> [--channel <live|release>] [--force] | dsh install --addon <name> [--version <v>] [--force]",
	uninstall: "dsh uninstall <version>... | dsh uninstall --addon <name>",
	list: "dsh list [--addon <name>] [--channel <live|release>] [--json]",
	select: "dsh select [--use <version|latest> [--snapshot <id>] [--addon <name>:<version>]...]",
	snapshot: "dsh snapshot new [--target <id> | --empty] [--name <alias>] | dsh snapshot remove <id>... | dsh snapshot list [--json]",
};

/** Options of each `dsh snapshot` action. */
const SNAPSHOT_OPTIONS: Record<string, string[]> = { new: ["--target", "--name", "--empty"], remove: [], list: ["--json"] };

/** Options each command accepts: flags, and options that take a value. */
const GRAMMAR: Record<MaintenanceCommand, { flags: string[]; values: string[] }> = {
	update: { flags: ["--self", "--all", "--force", "--clean"], values: ["--addon", "--version", "--channel"] },
	install: { flags: ["--force"], values: ["--addon", "--version", "--channel"] },
	uninstall: { flags: [], values: ["--addon"] },
	list: { flags: ["--json"], values: ["--addon", "--channel"] },
	select: { flags: [], values: ["--use", "--snapshot", "--addon"] },
	snapshot: { flags: ["--empty", "--json"], values: ["--target", "--name"] },
};

/** Options that may be repeated. */
const REPEATABLE: Partial<Record<MaintenanceCommand, string[]>> = { select: ["--addon"] };

export const isMaintenance = (argv: readonly string[]) => (MAINTENANCE_COMMANDS as readonly string[]).includes(argv[0] ?? "");

/**
 * `dsh --help` / `dsh -h` for the launcher itself (no profile named): upstream prints its own help, and
 * dsh-bin appends the commands it adds. A profile's help (`dsh tui --help`) is the app's and is left alone.
 */
export function isTopLevelHelp(argv: readonly string[]): boolean {
	const first = argv[0];
	if (first !== "-h" && first !== "--help") return false;
	return !argv.includes("--profile") && !argv.some((a) => a.startsWith("--profile="));
}

/** The dsh-bin section appended to the launcher help (upstream's help already ends with a blank line). */
export const MAINTENANCE_HELP = [
	"dsh-bin commands (self-update and addons; see `dsh <command> --help`):",
	`  ${USAGE.update}`,
	"      update the dsh binary (--all: then every installed addon), switch channel, or remove unused versions",
	`  ${USAGE.install}`,
	"      install a dsh version next to the installed ones, or an optional addon (--force: reinstall / out of slot)",
	`  ${USAGE.uninstall}`,
	"      remove installed dsh versions (their snapshots are kept), or disable an addon",
	`  ${USAGE.list}`,
	"      show installed and installable dsh and addon versions",
	`  ${USAGE.select}`,
	"      choose the version, snapshot and addons a plain `dsh` uses; no options: print the selection",
	`  ${USAGE.snapshot}`,
	"      copy, remove or list plugin-runtime snapshots",
	"",
].join("\n");

export function parseMaintenance(argv: readonly string[]): ParseResult | undefined {
	const [command, ...rest] = argv;
	if (!isMaintenance(argv)) return undefined;
	const cmd = command as MaintenanceCommand;
	const grammar = GRAMMAR[cmd];
	const fail = (error: string): ParseError => ({ command: cmd, error, usage: USAGE[cmd] });

	let help = false;
	let unknown: string | undefined;
	let missing: string | undefined;
	let conflict: string | undefined;
	const flags = new Set<string>();
	const values = new Map<string, string>();
	const repeated: string[] = [];
	const positionals: string[] = [];

	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i]!;
		if (arg === "-h" || arg === "--help") {
			help = true;
			continue;
		}
		const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
		const name = eq > 0 ? arg.slice(0, eq) : arg;
		if (grammar.values.includes(name)) {
			let value: string | undefined;
			if (eq > 0) value = arg.slice(eq + 1);
			else {
				const next = rest[i + 1];
				if (next !== undefined && !next.startsWith("-")) {
					value = next;
					i++;
				}
			}
			if (!value) missing ??= name;
			else if (REPEATABLE[cmd]?.includes(name)) repeated.push(value);
			else if (values.has(name)) conflict ??= `${name} can only be provided once`;
			else values.set(name, value);
			continue;
		}
		if (eq < 0 && grammar.flags.includes(arg)) {
			flags.add(arg);
			continue;
		}
		if (arg.startsWith("-")) {
			unknown ??= arg;
			continue;
		}
		positionals.push(arg);
	}

	if (help) return { command: cmd, help: true };
	if (unknown) return fail(`Unknown option ${unknown} for "${cmd}".`);
	if (missing === "--channel") return fail(`Missing value for --channel; ${VALID_CHANNELS}.`);
	if (missing) return fail(`Missing value for ${missing}.`);

	if (cmd === "snapshot") {
		const [action, ...ids] = positionals;
		if (action === undefined) return fail("dsh snapshot requires an action: new, remove or list");
		const allowed = SNAPSHOT_OPTIONS[action];
		if (!allowed) return fail(`Unknown snapshot action ${action}; valid actions: new, remove, list.`);
		const given = [...flags, ...values.keys()].find((o) => !allowed.includes(o));
		if (given) return fail(`Unknown option ${given} for "snapshot ${action}".`);
		if (conflict) return fail(conflict);
		if (action === "remove") {
			if (!ids.length) return fail("dsh snapshot remove requires at least one snapshot id");
			return { command: "snapshot", help: false, action, ids };
		}
		if (ids.length) return fail(`Unexpected argument ${ids[0]}.`);
		if (action === "list") return { command: "snapshot", help: false, action, json: flags.has("--json") };
		const target = values.get("--target");
		const name = values.get("--name");
		if (target && flags.has("--empty")) return fail("--target cannot be combined with --empty");
		return { command: "snapshot", help: false, action: "new", empty: flags.has("--empty"), ...(target ? { target } : {}), ...(name ? { name } : {}) };
	}
	const channel = values.get("--channel");
	if (channel !== undefined && !(CHANNELS as readonly string[]).includes(channel)) return fail(`Invalid channel ${channel}; ${VALID_CHANNELS}.`);
	if (cmd === "select") {
		if (positionals.length) return fail(`Unexpected argument ${positionals[0]}.`);
		if (conflict) return fail(conflict);
		const addons: { name: AddonName; version: string }[] = [];
		for (const spec of repeated) {
			const colon = spec.indexOf(":");
			const name = colon < 0 ? spec : spec.slice(0, colon);
			const version = colon < 0 ? "" : spec.slice(colon + 1);
			if (!(ADDON_NAMES as readonly string[]).includes(name)) return fail(`Unknown addon ${name}; ${VALID_ADDONS}.`);
			if (!version) return fail(`--addon ${spec}: expected <name>:<version>`);
			if (addons.some((a) => a.name === name)) return fail(`--addon ${name} can only be provided once`);
			addons.push({ name: name as AddonName, version });
		}
		const use = values.get("--use");
		const snapshot = values.get("--snapshot");
		return { command: "select", help: false, addons, ...(use ? { use } : {}), ...(snapshot ? { snapshot } : {}) };
	}
	const addon = values.get("--addon");
	if (addon !== undefined && !(ADDON_NAMES as readonly string[]).includes(addon)) return fail(`Unknown addon ${addon}; ${VALID_ADDONS}.`);
	const version = values.get("--version");

	if (cmd === "update") {
		const [positional, extra] = positionals;
		if (positional !== undefined && positional !== "self" && positional !== "dsh") {
			return fail(`dsh update does not update plugins (${positional}). ${PLUGIN_REDIRECT}`);
		}
		if (extra !== undefined) return fail(`Unexpected argument ${extra}.`);
		const self = flags.has("--self");
		const all = flags.has("--all");
		const force = flags.has("--force");
		if (conflict) return fail(conflict);
		if (flags.has("--clean")) {
			if (positional || self || all || addon || version || force || channel) {
				return fail("--clean cannot be combined with another update target, --force, or --channel");
			}
			return { command: "update", help: false, clean: true };
		}
		if (all && (self || addon || positional)) return fail("--all cannot be combined with --self, --addon, or a positional target");
		if (addon && (self || positional)) return fail("--addon cannot be combined with --self or a positional target");
		if (version && (all || self || channel)) return fail("--version cannot be combined with --all, --self, or --channel");
		if (version && !addon) return fail("--version requires --addon");
		if (channel && addon) return fail("--channel requires a dsh update (--self, --all, or no target)");
		const target: UpdateTarget = all ? { type: "all" } : addon ? { type: "addon", name: addon as AddonName } : { type: "self" };
		return { command: "update", help: false, clean: false, target, force, ...(channel ? { channel: channel as Channel } : {}), ...(version ? { version } : {}) };
	}

	if (cmd === "install" || cmd === "uninstall") {
		// A positional is a dsh version (digits first, or a dsh tag / live version); anything else is taken
		// for a plugin source.
		const source = positionals.find((a) => !/^(?:(?:dsh-v)?\d|live\.[0-9a-f]|dsh-live-[0-9a-f])[0-9A-Za-z.+_-]*$/.test(a));
		if (source) return fail(`dsh ${cmd} does not ${cmd} plugins (${source}). ${PLUGIN_REDIRECT}`);
		if (conflict) return fail(conflict);
		if (positionals.length && addon) return fail("--addon cannot be combined with a dsh version");
		if (cmd === "install" && positionals.length) {
			if (positionals.length > 1) return fail(`Unexpected argument ${positionals[1]}.`);
			if (version) return fail("--version requires --addon");
			return { command: "install", help: false, bundle: positionals[0]!, force: flags.has("--force"), ...(channel ? { channel: channel as Channel } : {}) };
		}
		if (positionals.length) return { command: "uninstall", help: false, bundles: positionals };
		if (!addon) return fail(`dsh ${cmd} requires a dsh version or --addon <name> (${VALID_ADDONS}). ${PLUGIN_REDIRECT}`);
		if (channel) return fail("--channel requires a dsh version");
	}
	if (positionals.length) {
		const what = cmd === "list" ? "does not list plugins" : `does not ${cmd} plugins`;
		return fail(`dsh ${cmd} ${what} (${positionals[0]}). ${PLUGIN_REDIRECT}`);
	}
	if (conflict) return fail(conflict);
	if (cmd === "list") {
		return { command: "list", help: false, json: flags.has("--json"), ...(addon ? { addon: addon as AddonName } : {}), ...(channel ? { channel: channel as Channel } : {}) };
	}
	if (!addon) return fail(`dsh ${cmd} requires --addon <name> (${VALID_ADDONS}). ${PLUGIN_REDIRECT}`);
	if (cmd === "install") return { command: "install", help: false, addon: addon as AddonName, force: flags.has("--force"), ...(version ? { version } : {}) };
	return { command: "uninstall", help: false, addon: addon as AddonName };
}
