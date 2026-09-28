// Argument parsing for `dsh update|install|uninstall|list` (self-update spec, "Command surface" and
// "Listing versions"). A port of pi's parsePackageCommand update branch: extension targets removed,
// `--addon`/`--version`/`--channel` added. Every error exits 1; only the first error found is reported,
// in pi's order (unknown option, missing value, bad value, unexpected argument, conflicts).
import { ADDON_NAMES, type AddonName, type Channel, CHANNELS } from "../layout.ts";

export const MAINTENANCE_COMMANDS = ["update", "install", "uninstall", "list"] as const;
export type MaintenanceCommand = (typeof MAINTENANCE_COMMANDS)[number];

export type UpdateTarget = { type: "self" } | { type: "all" } | { type: "addon"; name: AddonName };
export type ParsedCommand =
	| { command: MaintenanceCommand; help: true }
	| { command: "update"; help: false; clean: true }
	| { command: "update"; help: false; clean: false; target: UpdateTarget; force: boolean; channel?: Channel; version?: string }
	| { command: "install"; help: false; addon: AddonName; version?: string; force: boolean }
	| { command: "uninstall"; help: false; addon: AddonName }
	| { command: "list"; help: false; addon?: AddonName; channel?: Channel; json: boolean };
export type ParseError = { command: MaintenanceCommand; error: string; usage: string };
export type ParseResult = ParsedCommand | ParseError;

export const PLUGIN_REDIRECT = "Plugins are managed with `dsh plugin --profile <name> …`.";
const VALID_CHANNELS = `valid channels: ${[...CHANNELS].sort().join(", ")}`;
const VALID_ADDONS = `valid addons: ${ADDON_NAMES.join(", ")}`;

export const USAGE: Record<MaintenanceCommand, string> = {
	update: "dsh update [self|dsh] [--self | --all | --addon <name> [--version <v>]] [--force] [--channel <live|release>] | dsh update --clean",
	install: "dsh install --addon <name> [--version <v>] [--force]",
	uninstall: "dsh uninstall --addon <name>",
	list: "dsh list [--addon <name>] [--channel <live|release>] [--json]",
};

/** Options each command accepts: flags, and options that take a value. */
const GRAMMAR: Record<MaintenanceCommand, { flags: string[]; values: string[] }> = {
	update: { flags: ["--self", "--all", "--force", "--clean"], values: ["--addon", "--version", "--channel"] },
	install: { flags: ["--force"], values: ["--addon", "--version"] },
	uninstall: { flags: [], values: ["--addon"] },
	list: { flags: ["--json"], values: ["--addon", "--channel"] },
};

export const isMaintenance = (argv: readonly string[]) => (MAINTENANCE_COMMANDS as readonly string[]).includes(argv[0] ?? "");

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

	const channel = values.get("--channel");
	if (channel !== undefined && !(CHANNELS as readonly string[]).includes(channel)) return fail(`Invalid channel ${channel}; ${VALID_CHANNELS}.`);
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
