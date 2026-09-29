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
	const self = { command: "update", help: false, force: false };
	test.each(["update", "update self", "update dsh", "update --self", "update self --self"])("%s is the binary update", (s) => {
		expect(p(s)).toEqual(self as never);
	});
	test("options", () => {
		expect(p("update --force --channel live")).toEqual({ ...self, force: true, channel: "live" } as never);
		expect(p("update --channel=release")).toEqual({ ...self, channel: "release" } as never);
		expect(p("clean")).toEqual({ command: "clean", help: false, parts: ["update", "snapshots", "transpiler"] });
		expect(p("clean --all --snapshots")).toEqual({ command: "clean", help: false, parts: ["update", "snapshots", "transpiler"] });
		expect(p("clean --transpiler --update")).toEqual({ command: "clean", help: false, parts: ["update", "transpiler"] });
		expect(p("clean --snapshots")).toEqual({ command: "clean", help: false, parts: ["snapshots"] });
		expect(p("install --addon office")).toEqual({ command: "install", help: false, addon: "office", force: false });
		expect(p("install --addon office:dsh-addon-office-v1 --force")).toEqual({ command: "install", help: false, addon: "office", force: true, version: "dsh-addon-office-v1" });
		expect(p("uninstall --addon=office:0.1.2")).toEqual({ command: "uninstall", help: false, addon: "office", version: "0.1.2" });
		expect(p("uninstall --addon=office")).toEqual({ command: "uninstall", help: false, addon: "office" });
		expect(p("install 0.1.7-rc.2")).toEqual({ command: "install", help: false, bundle: "0.1.7-rc.2", force: false });
		expect(p("install dsh-live-abc1234-xz.4.1.g44444444 --channel live --force")).toEqual({ command: "install", help: false, bundle: "dsh-live-abc1234-xz.4.1.g44444444", channel: "live", force: true });
		expect(p("uninstall 0.1.7-rc.2 live.abc1234")).toEqual({ command: "uninstall", help: false, bundles: ["0.1.7-rc.2", "live.abc1234"] });
		expect(p("list")).toEqual({ command: "list", help: false, json: false });
		expect(p("list --addon office --channel live --json")).toEqual({ command: "list", help: false, json: true, addon: "office", channel: "live" });
	});
	test.each(["update -h", "update --help", "update --bogus --help", "install -h", "uninstall --help", "list -h", "clean -h"])("%s is help", (s) => {
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
		["update --clean", 'Unknown option --clean for "update".'],
		["update --version 1", 'Unknown option --version for "update".'],
		["update --all", 'Unknown option --all for "update". Run `dsh install --addon office` to install an addon version.'],
		["update --addon office", 'Unknown option --addon for "update". Run `dsh install --addon office` to install an addon version.'],
		["update --addon=office", 'Unknown option --addon=office for "update". Run `dsh install --addon office` to install an addon version.'],
		["clean --force", 'Unknown option --force for "clean".'],
		["clean update", "Unexpected argument update."],
		["update --channel beta", "Invalid channel beta; valid channels: live, release."],
		["list --channel beta", "Invalid channel beta; valid channels: live, release."],
		["install --addon foo", "Unknown addon foo; valid addons: office."],
		["list --addon foo", "Unknown addon foo; valid addons: office."],
		["update some-plugin", "dsh update does not update plugins (some-plugin). Plugins are managed with `dsh plugin --profile <name> …`."],
		["update npm:foo --force", "dsh update does not update plugins (npm:foo). Plugins are managed with `dsh plugin --profile <name> …`."],
		["update self dsh", "Unexpected argument dsh."],
		["install github:x/y", "dsh install does not install plugins (github:x/y). Plugins are managed with `dsh plugin --profile <name> …`."],
		["uninstall foo", "dsh uninstall does not uninstall plugins (foo). Plugins are managed with `dsh plugin --profile <name> …`."],
		["list foo", "dsh list does not list plugins (foo). Plugins are managed with `dsh plugin --profile <name> …`."],
		["install", "dsh install requires a dsh version or --addon <name> (valid addons: office). Plugins are managed with `dsh plugin --profile <name> …`."],
		["uninstall", "dsh uninstall requires a dsh version or --addon <name> (valid addons: office). Plugins are managed with `dsh plugin --profile <name> …`."],
		["install 0.1.7 0.1.8", "Unexpected argument 0.1.8."],
		["install 0.1.7 --addon office", "--addon cannot be combined with a dsh version"],
		["install 0.1.7 --version 1", 'Unknown option --version for "install".'],
		["install --addon office --channel live", "--channel requires a dsh version"],
		["uninstall 0.1.7 --force", 'Unknown option --force for "uninstall".'],
		["update --channel live --channel release", "--channel can only be provided once"],
		["install --addon office:1 --addon office:2", "--addon can only be provided once"],
		["install --addon office:", "--addon office:: expected <name> or <name>:<version>"],
		["list --addon office:1", "Unknown addon office:1; valid addons: office."],
		["list --channel live --channel release", "--channel can only be provided once"],
	])("%s", (argv, message) => {
		expect(err(argv)).toBe(message);
	});
});
