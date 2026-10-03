//! Installed runtimes: `<data>/bundles/<id>/bundle.json` (design D3/D10), read without executing anything.
const std = @import("std");
const util = @import("util.zig");
const select = @import("select.zig");
const Ctx = @import("context.zig").Ctx;

pub const guard_name = ".usage.lock";

/// Read every runtime directory. Staging lives in tmp/, never in bundles/; an unrecognized
/// storage entry is damage, not proof of an empty installation eligible for bootstrap.
pub fn list(ctx: *const Ctx) []select.Bundle {
    const path = ctx.path(&.{"bundles"});
    var dir = std.fs.cwd().openDir(path, .{ .iterate = true, .no_follow = true }) catch |err| {
        if (err == error.FileNotFound) {
            var link: [std.fs.max_path_bytes]u8 = undefined;
            if (std.fs.cwd().readLink(path, &link)) |_| storageProblem(path) else |_| return &.{};
        }
        storageProblem(path);
    };
    defer dir.close();
    return readIn(ctx, dir) catch storageProblem(path);
}

/// Fallible handle-relative inventory for read-only reports; policy/parsing is shared with list.
pub fn readIn(ctx: *const Ctx, dir: std.fs.Dir) ![]select.Bundle {
    var out: std.ArrayList(select.Bundle) = .empty;
    var it = dir.iterate();
    while (try it.next()) |e| {
        // Finder/Explorer metadata is not a runtime or evidence of a damaged install.
        if (std.mem.eql(u8, e.name, ".DS_Store") or std.mem.startsWith(u8, e.name, "._") or
            std.ascii.eqlIgnoreCase(e.name, "Thumbs.db") or std.ascii.eqlIgnoreCase(e.name, "desktop.ini")) continue;
        if (e.kind != .directory or e.name[0] == '.') return error.DamagedRuntimeStorage;
        const name = try ctx.a.dupe(u8, e.name);
        var runtime = try dir.openDir(name, .{ .no_follow = true });
        defer runtime.close();
        const bytes = @import("manager_binary.zig").readMetadata(ctx.a, runtime, "bundle.json", 1 << 20) catch null;
        try out.append(ctx.a, .{ .version = name, .meta = if (bytes) |b| select.parseMeta(ctx.a, b) else null });
    }
    std.mem.sort(select.Bundle, out.items, {}, struct {
        fn lt(_: void, x: select.Bundle, y: select.Bundle) bool {
            const xo = x.meta != null and x.meta.?.ordered();
            const yo = y.meta != null and y.meta.?.ordered();
            if (xo and yo) return select.before(x, y);
            if (xo != yo) return !xo;
            return std.mem.order(u8, x.version, y.version) == .lt;
        }
    }.lt);
    return out.items;
}

fn storageProblem(path: []const u8) noreturn {
    util.fatal("damaged runtime storage at {s}; inspect it and use `dsh manager install <version> --force` or `dsh manager clean`; automatic install refused", .{path});
}

pub fn metaOf(bundles: []const select.Bundle, id: []const u8) ?select.Meta {
    for (bundles) |b| if (std.mem.eql(u8, b.version, id)) return b.meta;
    return null;
}

pub const Problem = union(enum) {
    ok: []const u8,
    unreadable,
    legacy,
    unknown_format,
    protocol: ?u64,
    no_entry,
    missing_entry: []const u8,
};

/// Whether runtime `id` can be started by this manager; `.ok` carries the entry path.
pub fn check(ctx: *const Ctx, bundles: []const select.Bundle, id: []const u8) Problem {
    const m = metaOf(bundles, id) orelse return .unreadable;
    switch (m.format) {
        .legacy => return .legacy,
        .unknown => return .unknown_format,
        .runtime_v1 => {},
    }
    if (m.protocol != select.protocol) return .{ .protocol = m.protocol };
    const entry = m.entry orelse return .no_entry;
    const p = ctx.path(&.{ "bundles", id, entry });
    if (!util.exists(p)) return .{ .missing_entry = p };
    return .{ .ok = p };
}

/// One diagnostic naming the explicit repair, for a runtime that cannot start.
pub fn report(id: []const u8, p: Problem) noreturn {
    switch (p) {
        .ok => unreachable,
        .unreadable => util.fatal("dsh {s} has no readable bundle.json; reinstall it with `dsh manager install {s} --force`", .{ id, id }),
        .legacy, .unknown_format => util.fatal("dsh {s} is not in the supported runtime format; remove it with `dsh manager uninstall {s}` and install a current build", .{ id, id }),
        .protocol => |v| if (v) |n|
            util.fatal("dsh {s} needs launch protocol {d}, but this manager implements {d}; update the manager with `dsh manager self-update`, or reinstall it with `dsh manager install {s} --force`", .{ id, n, select.protocol, id })
        else
            util.fatal("dsh {s} declares no launch protocol; reinstall it with `dsh manager install {s} --force`", .{ id, id }),
        .no_entry => util.fatal("dsh {s} declares no entry; reinstall it with `dsh manager install {s} --force`", .{ id, id }),
        .missing_entry => |path| util.fatal("dsh {s} is incomplete ({s} is missing); reinstall it with `dsh manager install {s} --force`", .{ id, path, id }),
    }
}
