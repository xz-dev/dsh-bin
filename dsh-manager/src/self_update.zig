//! Self-update discovery/validation. 7.1 prepares a same-volume candidate; 7.2/7.3 own replacement.
const std = @import("std");
const options = @import("build_options");
const util = @import("util.zig");
const binary = @import("manager_binary.zig");
const index = @import("manager_index.zig");
const install = @import("install.zig");
const http = @import("http.zig");
const state = @import("state.zig");
const Ctx = @import("context.zig").Ctx;

pub fn run(ctx: *Ctx, args: []const []const u8) u8 {
    const force = args.len == 1 and std.mem.eql(u8, args[0], "--force");
    if (args.len != 0 and !force) {
        util.warn("usage: dsh manager self-update [--force]", .{});
        return 1;
    }
    if (ctx.mode != .portable) {
        util.warn("this manager is owned by {s}; update it with `{s}`, not self-update", .{ @tagName(ctx.mode), if (ctx.mode == .portage) "emerge --ask --update dsh" else "scoop update dsh" });
        return 1;
    }
    prepare(ctx, force) catch |err| {
        util.warn("manager candidate preparation failed: {s}; installed manager and application data unchanged", .{@errorName(err)});
        return 1;
    };
    return 0;
}
fn prepare(ctx: *Ctx, force: bool) !void {
    const endpoints = http.endpoints(ctx.a, &ctx.env);
    defer endpoints.deinit(ctx.a);
    const bytes = try http.fetchSmall(ctx.a, &ctx.env, endpoints.manager_index, 16 << 20);
    const candidate = try index.choose(ctx.a, bytes, try binary.host());
    const current = std.SemanticVersion.parse(options.version) catch return error.InvalidInstalledManagerVersion;
    switch (candidate.version.order(current)) {
        .lt => return error.ManagerDowngradeRefused,
        .eq => if (!force) {
            util.print("Manager {s} is already current ({s}); use `dsh manager self-update --force` to prepare a same-version repair.\n", .{ options.version, candidate.entry.version });
            return;
        },
        .gt => {},
    }
    ctx.ensureData();
    const mutex = try state.maintenance(ctx);
    defer mutex.release();
    var parent = try std.fs.cwd().openDir(ctx.dir, .{ .iterate = true, .no_follow = true });
    defer parent.close();
    const name = try std.fmt.allocPrint(ctx.a, "{s}{s}", .{ binary.candidate_prefix, candidate.entry.version });
    // A conflicting user file/link is not ours to overwrite.
    try reusable(ctx, parent, name, candidate.entry.version);
    var tmp = ctx.ensureDir(&.{"tmp"});
    defer tmp.close();
    const staging = try install.fetchTree(ctx, tmp, candidate.asset, candidate.entry.tag);
    defer tmp.deleteTree(staging) catch |err| util.warn("leftover tmp/{s}: {s}; run `dsh manager clean`", .{ staging, @errorName(err) });
    var tree = try tmp.openDir(staging, .{ .iterate = true, .no_follow = true });
    defer tree.close();
    var it = tree.iterate();
    const entry = try it.next() orelse return error.MissingManagerEntry;
    if (entry.kind != .file or !std.mem.eql(u8, entry.name, binary.executable) or try it.next() != null) return error.InvalidManagerArchive;
    try binary.validate(ctx.a, tree, binary.executable, candidate.entry.version);
    // Copy from a validated private tree into an exclusive file beside the executable. Never execute it.
    const part = try std.fmt.allocPrint(ctx.a, "{s}.part-{x}", .{ name, std.crypto.random.int(u64) });
    var file = try parent.createFile(part, .{ .exclusive = true, .mode = 0o755 });
    var open = true;
    defer if (open) file.close();
    defer parent.deleteFile(part) catch {};
    var source = try binary.openRegular(tree, binary.executable);
    defer source.close();
    var buf: [64 * 1024]u8 = undefined;
    while (true) {
        const n = try source.read(&buf);
        if (n == 0) break;
        try file.writeAll(buf[0..n]);
    }
    try file.sync();
    file.close();
    open = false;
    try binary.validate(ctx.a, parent, part, candidate.entry.version);
    // Refuse a concurrent change rather than overwrite unknown input; maintenance serializes managers.
    try reusable(ctx, parent, name, candidate.entry.version);
    try parent.rename(part, name);
    var old = parent.iterate();
    while (try old.next()) |item| {
        if (item.kind != .file or std.mem.eql(u8, item.name, name)) continue;
        const old_version = binary.candidateVersion(item.name) orelse continue;
        binary.validate(ctx.a, parent, item.name, old_version) catch continue;
        parent.deleteFile(item.name) catch |err| util.warn("candidate prepared; leftover {s}: {s}; run `dsh manager clean`", .{ item.name, @errorName(err) });
    }
    util.print("Manager {s} prepared, not installed: {s}/{s}; installed manager remains {s}.\n", .{ candidate.entry.version, ctx.dir, name, options.version });
}

fn reusable(ctx: *const Ctx, parent: std.fs.Dir, name: []const u8, version: []const u8) !void {
    const file = binary.openRegular(parent, name) catch |err| {
        if (err == error.FileNotFound) return;
        return err;
    };
    file.close();
    try binary.validate(ctx.a, parent, name, version);
}
