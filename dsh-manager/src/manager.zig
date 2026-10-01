//! `dsh manager ...` (manager-control spec): native management; never starts a runtime.
const std = @import("std");
const options = @import("build_options");
const util = @import("util.zig");
const select = @import("select.zig");
const manage = @import("manage.zig");
const install = @import("install.zig");
const completion = @import("completion.zig");
const Ctx = @import("context.zig").Ctx;

pub const help_text =
    \\Usage: dsh manager <command> [options]
    \\
    \\Manage dsh runtimes, plugin snapshots, addons and this manager. Management never starts dsh.
    \\
    \\  install <version> [--channel <live|release>] [--force]   install a dsh runtime next to the others
    \\  install --addon office[:<version>] [--force]              install an office addon version
    \\  update [--channel <live|release>] [--force]               install the channel's newest dsh runtime
    \\  uninstall <version>... | --addon office[:<version>]       remove runtimes or addon versions (data is kept)
    \\  list [--available] [--json]                               installed runtimes (--available: also the index)
    \\  select [--use <version|latest>] [--snapshot <id>] [--addon office:<version>]
    \\                                                            choose what a plain `dsh` starts
    \\  snapshot new [--target <id> | --empty] [--name <alias>] | remove <id>... | list [--json]
    \\                                                            plugin-runtime snapshots
    \\  clean                                                     remove interrupted downloads and leftovers (offline)
    \\  self-update                                               update this manager only
    \\  completion script|install|uninstall <bash|zsh|fish|pwsh|powershell>
    \\                                                            shell completion (--dry-run; PowerShell: --profile <path>)
    \\  info                                                      install mode, data root and application home
    \\  --version, --help
    \\
    \\Launch options (before the dsh arguments; for one run): dsh --use <version> --snapshot <id> --addon office:<v> ...
    \\
;

pub fn run(ctx: *Ctx, opts: select.Options, args: []const []const u8) u8 {
    const cmd = if (args.len > 0) args[0] else "--help";
    if (std.mem.eql(u8, cmd, "__complete")) return completion.query(ctx, opts, args[1..]);
    if (std.mem.eql(u8, cmd, "--help") or std.mem.eql(u8, cmd, "-h") or std.mem.eql(u8, cmd, "help")) {
        util.print("{s}", .{help_text});
        return 0;
    }
    if (std.mem.eql(u8, cmd, "--version") or std.mem.eql(u8, cmd, "-V") or std.mem.eql(u8, cmd, "version")) {
        util.print("dsh manager {s} (launch protocol {d})\n", .{ options.version, select.protocol });
        return 0;
    }
    if (std.mem.eql(u8, cmd, "completion")) return completion.run(ctx, args[1..]);
    if (args.len == 2 and (std.mem.eql(u8, args[1], "--help") or std.mem.eql(u8, args[1], "-h"))) {
        util.print("{s}", .{help_text});
        return 0;
    }
    if (std.mem.eql(u8, cmd, "install")) return install.run(ctx, args[1..]);
    if (std.mem.eql(u8, cmd, "update")) return install.update(ctx, args[1..]);
    if (std.mem.eql(u8, cmd, "select")) return manage.selection(ctx, args[1..]);
    if (std.mem.eql(u8, cmd, "uninstall")) return manage.uninstall(ctx, args[1..]);
    if (std.mem.eql(u8, cmd, "list")) return manage.list(ctx, args[1..]);
    if (std.mem.eql(u8, cmd, "info")) {
        util.print("Install mode: {s}\nData root: {s}\nApp home: {s}\n", .{ @tagName(ctx.mode), ctx.data, ctx.home() });
        if (ctx.mode != .portable) util.print("Managed user data is an exception to the portable executable-adjacent layout.\n", .{});
        const rel = std.fs.path.relative(ctx.a, ctx.data, ctx.home()) catch util.oom();
        if (std.fs.path.isAbsolute(rel) or std.mem.eql(u8, rel, "..") or std.mem.startsWith(u8, rel, "../") or std.mem.startsWith(u8, rel, "..\\"))
            util.print("External DSH_HOME is outside the portability guarantee; only manager data moves with the installation.\n", .{});
        return 0;
    }
    const known = [_][]const u8{ "snapshot", "clean", "self-update" };
    for (known) |k| if (std.mem.eql(u8, cmd, k)) {
        util.warn("`dsh manager {s}` is not available in this build yet", .{cmd});
        return 1;
    };
    util.warn("unknown manager command {s}; see `dsh manager --help`", .{cmd});
    return 1;
}
