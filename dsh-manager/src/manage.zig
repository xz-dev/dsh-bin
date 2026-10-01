//! Native persistent selection, local/available listing and runtime removal. Never executes dsh.
const std = @import("std");
const util = @import("util.zig");
const select = @import("select.zig");
const state = @import("state.zig");
const runtimes = @import("runtimes.zig");
const snapshot = @import("snapshot.zig");
const index = @import("index.zig");
const http = @import("http.zig");
const target = @import("target.zig");
const lock = @import("lock.zig");
const Ctx = @import("context.zig").Ctx;

fn require(bundles: []const select.Bundle, query: []const u8) []const u8 {
    return switch (select.matchVersion(bundles, query)) {
        .found => |id| id,
        .none => util.fatal("version {s} is not installed; run `dsh manager install {s}`", .{ query, query }),
        .ambiguous => |ids| util.fatal("version {s} is ambiguous ({s}, {s}, ...); give more of the version", .{ query, ids[0], ids[1] }),
    };
}

fn selected(ctx: *const Ctx) ?select.Selection {
    return switch (state.readSelection(ctx)) {
        .none => null,
        .ok => |s| s,
        .invalid => |why| util.fatal("cannot read selection {s} ({s}); run `dsh manager select --use latest` to reset it", .{ state.selectionPath(ctx), why }),
    };
}

fn maintenance(ctx: *const Ctx) lock.Lock {
    return state.maintenance(ctx) catch |err|
        util.fatal("cannot acquire maintenance lock: {s}; retry when the other manager operation finishes", .{@errorName(err)});
}

pub fn selection(ctx: *Ctx, args: []const []const u8) u8 {
    const opts = @import("launch.zig").parseLeading(ctx.a, args);
    if (opts.addons.len != 0) util.fatal("addon selection is not available in this build yet", .{});
    if (opts.consumed != args.len) util.fatal("usage: dsh manager select [--use <version|latest>] [--snapshot <id>]", .{});
    if (args.len == 0) {
        const stored = selected(ctx);
        printSelection(ctx, if (stored) |s| s.use else "latest", if (stored) |s| snapshotChoice(s) else null);
        return 0;
    }
    const query = opts.use orelse util.fatal("dsh manager select requires --use <version|latest>; add --use when selecting a snapshot", .{});
    ctx.ensureData();
    const mutex = maintenance(ctx);
    defer mutex.release();
    const use = if (std.mem.eql(u8, query, "latest")) query else require(runtimes.list(ctx), query);
    const snap: ?snapshot.Snapshot = if (opts.snapshot) |id| snapshot.existing(ctx, id) catch |err|
        util.fatal("cannot select snapshot {s}: {s}; run `dsh manager snapshot list`", .{ id, @errorName(err) }) else null;
    const bytes = std.json.Stringify.valueAlloc(ctx.a, .{ .schema = @as(u32, 1), .use = use, .snapshot = if (snap) |s| s.id else null, .addons = struct {}{} }, .{}) catch util.oom();
    state.write(ctx, "selection.json", bytes) catch |err| util.fatal("cannot save selection: {s}", .{@errorName(err)});
    util.print("Selected --use {s}.\n", .{use});
    printSelection(ctx, use, if (snap) |s| s.id else null);
    return 0;
}

pub fn snapshotChoice(s: select.Selection) ?[]const u8 {
    const value = s.value.object.get("snapshot") orelse return null;
    return if (value == .string and value.string.len > 0) value.string else null;
}

fn printSelection(ctx: *const Ctx, use: []const u8, snap: ?[]const u8) void {
    util.print("selection: --use {s}\n  snapshot: {s}\n", .{ use, snap orelse "newest (default)" });
    const resolved = select.resolve(.{ .opts = .{}, .bundles = runtimes.list(ctx), .channel = state.channel(ctx), .selection_use = use });
    switch (resolved) {
        .ok => |r| util.print("  version: {s}\n", .{r.version}),
        .err => util.print("  version: unresolved; run `dsh manager list` or `dsh manager install <version>`\n", .{}),
    }
}

pub fn list(ctx: *Ctx, args: []const []const u8) u8 {
    var available = false;
    var json = false;
    for (args) |arg| {
        if (std.mem.eql(u8, arg, "--available")) available = true else if (std.mem.eql(u8, arg, "--json")) json = true else util.fatal("usage: dsh manager list [--available] [--json]", .{});
    }
    const bundles = runtimes.list(ctx);
    const stored = state.readSelection(ctx);
    const use = if (stored == .ok) stored.ok.use else "latest";
    const resolved = select.resolve(.{ .opts = .{}, .bundles = bundles, .channel = state.channel(ctx), .selection_use = use });
    const latest = select.resolve(.{ .opts = .{}, .bundles = bundles, .channel = state.channel(ctx) });
    const Row = struct { version: []const u8, channel: ?[]const u8, selected: bool, latest: bool, startable: bool, inUse: bool };
    const rows = ctx.a.alloc(Row, bundles.len) catch util.oom();
    for (bundles, rows) |b, *r| r.* = .{ .version = b.version, .channel = if (b.meta) |m| m.channel else null, .selected = stored != .invalid and resolved == .ok and std.mem.eql(u8, b.version, resolved.ok.version), .startable = runtimes.check(ctx, bundles, b.version) == .ok, .latest = latest == .ok and std.mem.eql(u8, b.version, latest.ok.version), .inUse = lock.inUse(ctx.path(&.{ "bundles", b.version, runtimes.guard_name })) };
    const Remote = struct { version: []const u8, channel: []const u8, installed: bool };
    var remote: std.ArrayList(Remote) = .empty;
    if (available) {
        const endpoints = http.endpoints(ctx.a, &ctx.env);
        defer endpoints.deinit(ctx.a);
        const bytes = http.fetchSmall(ctx.a, &ctx.env, endpoints.runtime_index, 16 << 20) catch |err|
            util.fatal("cannot read runtime index: {s}; use `dsh manager list` for offline local state", .{@errorName(err)});
        const host = target.host() catch util.fatal("unsupported host target", .{});
        for ([_][]const u8{ "release", "live" }) |ch| {
            const candidates = index.candidates(ctx.a, bytes, ch, host) catch |err| util.fatal("cannot read runtime index: {s}", .{@errorName(err)});
            for (candidates) |c| remote.append(ctx.a, .{ .version = c.entry.id, .channel = ch, .installed = select.matchVersion(bundles, c.entry.id) == .found }) catch util.oom();
        }
    }
    if (json) {
        const bytes = std.json.Stringify.valueAlloc(ctx.a, .{ .channel = state.channel(ctx), .selection = if (stored == .ok) stored.ok.value else @as(?std.json.Value, null), .selectionValid = stored != .invalid, .installed = rows, .available = remote.items }, .{}) catch util.oom();
        util.print("{s}\n", .{bytes});
    } else {
        if (stored == .invalid) util.print("Invalid selection ({s}); run `dsh manager select --use latest` to reset it.\n", .{stored.invalid});
        if (bundles.len == 0) util.print("No dsh runtime is installed. Run `dsh manager update` or plain `dsh` to install one.\n", .{}) else {
            util.print("Installed dsh runtimes (channel {s}):\n", .{state.channel(ctx)});
            for (rows) |r| util.print("  {s}  {s}{s}{s}{s}{s}\n", .{ r.version, r.channel orelse "?", if (r.selected) "  (selected)" else "", if (r.latest) "  (latest)" else "", if (r.inUse) "  (in use)" else "", if (r.startable) "" else "  (not startable)" });
        }
        if (available) {
            util.print("Available host-compatible runtimes:\n", .{});
            for (remote.items) |r| util.print("  {s}  {s}{s}\n", .{ r.version, r.channel, if (r.installed) "  (installed)" else "" });
        }
    }
    return 0;
}

pub fn uninstall(ctx: *Ctx, args: []const []const u8) u8 {
    if (args.len == 0) util.fatal("usage: dsh manager uninstall <version>...", .{});
    for (args) |arg| {
        if (std.mem.eql(u8, arg, "--addon") or std.mem.startsWith(u8, arg, "--addon=")) util.fatal("addon management is not available in this build yet", .{});
        if (std.mem.startsWith(u8, arg, "-")) util.fatal("usage: dsh manager uninstall <version>...", .{});
    }
    ctx.ensureData();
    const mutex = maintenance(ctx);
    defer mutex.release();
    const bundles = runtimes.list(ctx);
    var ids: std.ArrayList([]const u8) = .empty;
    for (args) |arg| {
        const id = require(bundles, arg);
        var duplicate = false;
        for (ids.items) |v| if (std.mem.eql(u8, v, id)) {
            duplicate = true;
            break;
        };
        if (!duplicate) ids.append(ctx.a, id) catch util.oom();
    }
    const stored = selected(ctx);
    if (stored) |s| if (!std.mem.eql(u8, s.use, "latest")) {
        const pin = select.matchVersion(bundles, s.use);
        if (pin == .ambiguous) util.fatal("selection {s} is ambiguous; run `dsh manager select --use latest` before uninstalling", .{s.use});
        if (pin == .found) for (ids.items) |id| if (std.mem.eql(u8, id, pin.found))
            util.fatal("dsh {s} is pinned by the selection; run `dsh manager select --use latest` or pin another version first; nothing was uninstalled", .{id});
    };
    // Existing guard only; full process/restart protection is task 6.4.
    var claims: std.ArrayList(lock.Lock) = .empty;
    defer for (claims.items) |claim| claim.release();
    for (ids.items) |id| {
        const claim = lock.tryAcquire(ctx.path(&.{ "bundles", id, runtimes.guard_name }), .exclusive, false) catch |err| switch (err) {
            error.Missing => continue,
            else => util.fatal("cannot uninstall dsh {s}: {s} (possibly in use); nothing was uninstalled", .{ id, @errorName(err) }),
        };
        claims.append(ctx.a, claim) catch util.oom();
    }
    // Windows cannot delete our own open guard handle. Runtime deletion failures stay explicit.
    if (@import("builtin").os.tag == .windows) {
        for (claims.items) |claim| claim.release();
        claims.clearRetainingCapacity();
    }
    for (ids.items) |id| {
        std.fs.cwd().deleteTree(ctx.path(&.{ "bundles", id })) catch |err|
            util.fatal("cannot remove runtime {s}: {s}; inspect remaining runtime files; snapshots and home were kept", .{ id, @errorName(err) });
        util.print("Uninstalled dsh {s}; snapshots, selection and application home kept.\n", .{id});
    }
    return 0;
}
