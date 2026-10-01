// Native persistent selection port; complete snapshot creation/copying/removal stays in task 6.2.
const std = @import("std");
const util = @import("util.zig");
const select = @import("select.zig");
const lock = @import("lock.zig");
const Ctx = @import("context.zig").Ctx;

pub const Snapshot = struct { id: []const u8, dir: []const u8 };

/// Resolve an existing numeric ID or metadata name without creating or copying anything.
pub fn existing(ctx: *const Ctx, query: []const u8) !Snapshot {
    const version = select.snapshotVersion(query) orelse return error.InvalidSnapshotId;
    for (version) |c| if (!(std.ascii.isAlphanumeric(c) or c == '.' or c == '+' or c == '_' or c == '-')) return error.InvalidSnapshotId;
    const name = query[version.len + 1 ..];
    var root = try std.fs.cwd().openDir(ctx.path(&.{"snapshots"}), .{ .iterate = true, .no_follow = true });
    defer root.close();
    var it = root.iterate();
    var found: ?Snapshot = null;
    const Meta = struct { id: []const u8, version: []const u8, n: u64, alias: ?[]const u8 = null };
    var snapshots: std.ArrayList(Meta) = .empty;
    var versions: std.ArrayList(select.Bundle) = .empty;
    while (try it.next()) |entry| {
        const v = select.snapshotVersion(entry.name) orelse continue;
        const n = std.fmt.parseInt(u64, entry.name[v.len + 1 ..], 10) catch continue;
        if (n == 0 or entry.kind != .directory) continue;
        var dir = try root.openDir(entry.name, .{ .no_follow = true });
        defer dir.close();
        const bytes = try dir.readFileAlloc(ctx.a, "snapshot.json", 1 << 20);
        const meta = try std.json.parseFromSliceLeaky(Meta, ctx.a, bytes, .{ .ignore_unknown_fields = true });
        if (!std.mem.eql(u8, meta.id, entry.name) or !std.mem.eql(u8, meta.version, v) or meta.n != n) return error.InvalidSnapshot;
        try dir.access(".usage.lock", .{});
        try snapshots.append(ctx.a, meta);
        var known = false;
        for (versions.items) |b| if (std.mem.eql(u8, b.version, v)) {
            known = true;
            break;
        };
        if (!known) try versions.append(ctx.a, .{ .version = meta.version, .meta = null });
    }
    const matched = switch (select.matchVersion(versions.items, version)) {
        .found => |v| v,
        .none => return error.SnapshotNotFound,
        .ambiguous => return error.AmbiguousSnapshot,
    };
    const number = std.fmt.parseInt(u64, name, 10) catch null;
    for (snapshots.items) |meta| {
        if (!std.mem.eql(u8, matched, meta.version)) continue;
        if (if (number) |n| meta.n != n else meta.alias == null or !std.mem.eql(u8, name, meta.alias.?)) continue;
        if (found != null) return error.AmbiguousSnapshot;
        found = .{ .id = meta.id, .dir = ctx.path(&.{ "snapshots", meta.id }) };
    }
    return found orelse error.SnapshotNotFound;
}

pub fn prepare(ctx: *const Ctx, version: []const u8, meta: select.Meta) Snapshot {
    for (version) |c| if (!(std.ascii.isAlphanumeric(c) or c == '.' or c == '+' or c == '_' or c == '-'))
        util.fatal("invalid runtime id for snapshot: {s}", .{version});
    var root = ctx.ensureDir(&.{"snapshots"});
    defer root.close();
    const mutex_path = ctx.path(&.{ "snapshots", ".lock" });
    const mutex = lock.acquire(mutex_path, .exclusive, true, null) catch |err|
        util.fatal("cannot lock snapshots at {s}: {s}", .{ mutex_path, @errorName(err) });
    defer mutex.release();
    const prefix = std.fmt.allocPrint(ctx.a, "{s}@", .{version}) catch util.oom();
    var it = root.iterate();
    var newest: ?[]const u8 = null;
    var last: u64 = 0;
    while (it.next() catch |err| util.fatal("cannot read snapshots at {s}: {s}", .{ ctx.data, @errorName(err) })) |entry| {
        if (!std.mem.startsWith(u8, entry.name, prefix)) continue;
        const n = std.fmt.parseInt(u64, entry.name[prefix.len..], 10) catch continue;
        if (n == 0) continue;
        const path = ctx.path(&.{ "snapshots", entry.name });
        if (entry.kind != .directory) util.fatal("invalid snapshot at {s}", .{path});
        var dir = root.openDir(entry.name, .{ .no_follow = true }) catch util.fatal("invalid snapshot at {s}", .{path});
        defer dir.close();
        const obj = (util.readJsonObject(ctx.a, util.join(ctx.a, &.{ path, "snapshot.json" })) catch null) orelse util.fatal("invalid snapshot metadata at {s}", .{path});
        const id = obj.get("id") orelse util.fatal("invalid snapshot metadata at {s}", .{path});
        const v = obj.get("version") orelse util.fatal("invalid snapshot metadata at {s}", .{path});
        const number = obj.get("n") orelse util.fatal("invalid snapshot metadata at {s}", .{path});
        if (id != .string or v != .string or number != .integer or !std.mem.eql(u8, id.string, entry.name) or !std.mem.eql(u8, v.string, version) or number.integer != n)
            util.fatal("invalid snapshot metadata at {s}", .{path});
        dir.access(".usage.lock", .{}) catch util.fatal("snapshot usage guard is missing at {s}", .{path});
        if (n > last) {
            last = n;
            newest = ctx.a.dupe(u8, entry.name) catch util.oom();
        }
    }
    if (newest) |id| return .{ .id = id, .dir = ctx.path(&.{ "snapshots", id }) };

    const id = std.fmt.allocPrint(ctx.a, "{s}@1", .{version}) catch util.oom();
    const staging = std.fmt.allocPrint(ctx.a, ".staging-{x}", .{std.crypto.random.int(u64)}) catch util.oom();
    root.makeDir(staging) catch |err| util.fatal("cannot prepare snapshot at {s}: {s}", .{ ctx.data, @errorName(err) });
    defer root.deleteTree(staging) catch {};
    var dir = root.openDir(staging, .{}) catch util.fatal("cannot open snapshot staging at {s}", .{ctx.data});
    dir.makeDir("profiles") catch util.fatal("cannot prepare snapshot profiles at {s}", .{ctx.data});
    dir.writeFile(.{ .sub_path = ".usage.lock", .data = "" }) catch util.fatal("cannot prepare snapshot guard at {s}", .{ctx.data});
    const bytes = std.json.Stringify.valueAlloc(ctx.a, .{
        .id = id,
        .version = version,
        .n = @as(u32, 1),
        .createdAt = timestamp(ctx.a),
        .source = "empty",
        .reason = "start",
        .order = .{ .upstream = .{ .commitTime = meta.commit_time }, .run = meta.run, .attempt = meta.attempt },
    }, .{}) catch util.oom();
    const file = dir.createFile("snapshot.json", .{}) catch util.fatal("cannot prepare snapshot metadata at {s}", .{ctx.data});
    file.writeAll(bytes) catch util.fatal("cannot write snapshot metadata at {s}", .{ctx.data});
    file.sync() catch util.fatal("cannot sync snapshot metadata at {s}", .{ctx.data});
    file.close();
    dir.close(); // Close Windows handles before atomic same-directory publication.
    root.rename(staging, id) catch |err| util.fatal("cannot publish snapshot {s}: {s}", .{ id, @errorName(err) });
    return .{ .id = id, .dir = ctx.path(&.{ "snapshots", id }) };
}

fn timestamp(a: std.mem.Allocator) []const u8 {
    const seconds: std.time.epoch.EpochSeconds = .{ .secs = @intCast(@max(0, std.time.timestamp())) };
    const day = seconds.getEpochDay().calculateYearDay();
    const month = day.calculateMonthDay();
    const time = seconds.getDaySeconds();
    return std.fmt.allocPrint(a, "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.000Z", .{ day.year, @intFromEnum(month.month), month.day_index + 1, time.getHoursIntoDay(), time.getMinutesIntoHour(), time.getSecondsIntoMinute() }) catch util.oom();
}
