// 7.1: every accepted and rejected form of the self-update spec's command surface.
import { describe, expect, test } from "bun:test";
import { parseMaintenance } from "../../runtime/update/args.ts";

const p = (s: string) => parseMaintenance(s.split(" ").filter(Boolean));
const err = (s: string) => {
	const r = p(s);
	if (!r || !("error" in r)) throw new Error(`expected an error for "${s}", got ${JSON.stringify(r)}`);
	return r.error;
};

describe("accepted", () => {
	const self = { command: "update", help: false, clean: false, target: { type: "self" }, force: false };
	test.each(["update", "update self", "update dsh", "update --self", "update self --self"])("%s is the binary update", (s) => {
		expect(p(s)).toEqual(self as never);
	});
	test("options", () => {
		expect(p("update --force --channel live")).toEqual({ ...self, force: true, channel: "live" } as never);
		expect(p("update --channel=release")).toEqual({ ...self, channel: "release" } as never);
		expect(p("update --all --force --channel live")).toEqual({ ...self, target: { type: "all" }, force: true, channel: "live" } as never);
		expect(p("update --clean")).toEqual({ command: "update", help: false, clean: true });
		expect(p("update --addon office")).toEqual({ ...self, target: { type: "addon", name: "office" } } as never);
		expect(p("update --addon=office --version=0.1.2-xz.1.1.gabcdef12 --force")).toEqual({
			...self,
			target: { type: "addon", name: "office" },
			force: true,
			version: "0.1.2-xz.1.1.gabcdef12",
		} as never);
		expect(p("install --addon office")).toEqual({ command: "install", help: false, addon: "office", force: false });
		expect(p("install --addon office --version dsh-addon-office-v1 --force")).toEqual({ command: "install", help: false, addon: "office", force: true, version: "dsh-addon-office-v1" });
		expect(p("uninstall --addon=office")).toEqual({ command: "uninstall", help: false, addon: "office" });
		expect(p("install 0.1.7-rc.2")).toEqual({ command: "install", help: false, bundle: "0.1.7-rc.2", force: false });
		expect(p("install dsh-live-abc1234-xz.4.1.g44444444 --channel live --force")).toEqual({ command: "install", help: false, bundle: "dsh-live-abc1234-xz.4.1.g44444444", channel: "live", force: true });
		expect(p("uninstall 0.1.7-rc.2 live.abc1234")).toEqual({ command: "uninstall", help: false, bundles: ["0.1.7-rc.2", "live.abc1234"] });
		expect(p("list")).toEqual({ command: "list", help: false, json: false });
		expect(p("list --addon office --channel live --json")).toEqual({ command: "list", help: false, json: true, addon: "office", channel: "live" });
	});
	test.each(["update -h", "update --help", "update --bogus --help", "install -h", "uninstall --help", "list -h"])("%s is help", (s) => {
		expect(p(s)).toMatchObject({ help: true });
	});
	test("other commands are not maintenance commands", () => {
		expect(p("plugin --profile x list")).toBeUndefined();
		expect(p("--profile update")).toBeUndefined();
		expect(parseMaintenance([])).toBeUndefined();
	});
});

describe("rejected (first error wins)", () => {
	test.each([
		["update --extensions", 'Unknown option --extensions for "update".'],
		["update --models", 'Unknown option --models for "update".'],
		["update --extension foo", 'Unknown option --extension for "update".'],
		["update --approve", 'Unknown option --approve for "update".'],
		["update --no-approve", 'Unknown option --no-approve for "update".'],
		["update --self=1", 'Unknown option --self=1 for "update".'],
		["update --json", 'Unknown option --json for "update".'],
		["list --force", 'Unknown option --force for "list".'],
		["install --addon office --all", 'Unknown option --all for "install".'],
		["update --models --channel", 'Unknown option --models for "update".'],
		["update --channel", "Missing value for --channel; valid channels: live, release."],
		["update --channel=", "Missing value for --channel; valid channels: live, release."],
		["update --addon", "Missing value for --addon."],
		["update --addon --force", "Missing value for --addon."],
		["update --channel beta", "Invalid channel beta; valid channels: live, release."],
		["list --channel beta", "Invalid channel beta; valid channels: live, release."],
		["install --addon foo", "Unknown addon foo; valid addons: office."],
		["list --addon foo", "Unknown addon foo; valid addons: office."],
		["update some-plugin", "dsh update does not update plugins (some-plugin). Plugins are managed with `dsh plugin --profile <name> …`."],
		["update npm:foo --clean", "dsh update does not update plugins (npm:foo). Plugins are managed with `dsh plugin --profile <name> …`."],
		["update self dsh", "Unexpected argument dsh."],
		["install github:x/y", "dsh install does not install plugins (github:x/y). Plugins are managed with `dsh plugin --profile <name> …`."],
		["uninstall foo", "dsh uninstall does not uninstall plugins (foo). Plugins are managed with `dsh plugin --profile <name> …`."],
		["list foo", "dsh list does not list plugins (foo). Plugins are managed with `dsh plugin --profile <name> …`."],
		["install", "dsh install requires a dsh version or --addon <name> (valid addons: office). Plugins are managed with `dsh plugin --profile <name> …`."],
		["uninstall", "dsh uninstall requires a dsh version or --addon <name> (valid addons: office). Plugins are managed with `dsh plugin --profile <name> …`."],
		["install 0.1.7 0.1.8", "Unexpected argument 0.1.8."],
		["install 0.1.7 --addon office", "--addon cannot be combined with a dsh version"],
		["install 0.1.7 --version 1", "--version requires --addon"],
		["install --addon office --channel live", "--channel requires a dsh version"],
		["uninstall 0.1.7 --force", 'Unknown option --force for "uninstall".'],
		["update --clean --force", "--clean cannot be combined with another update target, --force, or --channel"],
		["update --clean self", "--clean cannot be combined with another update target, --force, or --channel"],
		["update --clean --channel live", "--clean cannot be combined with another update target, --force, or --channel"],
		["update --clean --all", "--clean cannot be combined with another update target, --force, or --channel"],
		["update --clean --addon office", "--clean cannot be combined with another update target, --force, or --channel"],
		["update --all --addon office", "--all cannot be combined with --self, --addon, or a positional target"],
		["update --all --self", "--all cannot be combined with --self, --addon, or a positional target"],
		["update self --all", "--all cannot be combined with --self, --addon, or a positional target"],
		["update --addon office --addon office", "--addon can only be provided once"],
		["update --addon office --self", "--addon cannot be combined with --self or a positional target"],
		["update dsh --addon office", "--addon cannot be combined with --self or a positional target"],
		["update --addon office --channel live", "--channel requires a dsh update (--self, --all, or no target)"],
		["update --version 0.1.2-xz.1.1.gabcdef12", "--version requires --addon"],
		["update --all --version 0.1.2-xz.1.1.gabcdef12", "--version cannot be combined with --all, --self, or --channel"],
		["update --self --version 1", "--version cannot be combined with --all, --self, or --channel"],
		["update --addon office --version 1 --channel live", "--version cannot be combined with --all, --self, or --channel"],
		["update --addon office --version 1 --version 2", "--version can only be provided once"],
		["install --addon office --version 1 --version 1", "--version can only be provided once"],
		["list --channel live --channel release", "--channel can only be provided once"],
	])("%s", (argv, message) => {
		expect(err(argv)).toBe(message);
	});
});
