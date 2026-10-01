//! Plugin snapshot storage: atomic publication, persistent monotonic counters and independent copies.
const std = @import("std");
const util = @import("util.zig");
const select = @import("select.zig");
const state = @import("state.zig");
const runtimes = @import("runtimes.zig");
const lock = @import("lock.zig");
const Ctx = @import("context.zig").Ctx;

pub const Snapshot = struct { id: []const u8, dir: []const u8 };
const Order = struct { upstream: struct { commitTime: []const u8 }, run: u64, attempt: u64 };
const Meta = struct {
    id: []const u8,
    version: []const u8,
    n: u64,
    alias: ?[]const u8 = null,
    createdAt: []const u8 = "",
    source: []const u8 = "empty",
    reason: []const u8 = "start",
    order: ?Order = null,
};

fn safeVersion(version: []const u8) bool {
    if (version.len == 0 or std.mem.eql(u8, version, ".") or std.mem.eql(u8, version, "..")) return false;
    for (version) |c| if (!(std.ascii.isAlphanumeric(c) or c == '.' or c == '+' or c == '_' or c == '-')) return false;
    return true;
}

fn list(ctx: *const Ctx) ![]Meta {
    var root = std.fs.cwd().openDir(ctx.path(&.{"snapshots"}), .{ .iterate = true, .no_follow = true }) catch |err| switch (err) {
        error.FileNotFound => return &.{},
        else => return err,
    };
    defer root.close();
    return listIn(ctx, root);
}

fn listIn(ctx: *const Ctx, root: std.fs.Dir) ![]Meta {
    var result: std.ArrayList(Meta) = .empty;
    var it = root.iterate();
    while (try it.next()) |entry| {
        if (entry.name[0] == '.') continue;
        const v = select.snapshotVersion(entry.name) orelse continue;
        if (!safeVersion(v)) return error.InvalidSnapshot;
        const n = std.fmt.parseInt(u64, entry.name[v.len + 1 ..], 10) catch return error.InvalidSnapshot;
        if (n == 0 or entry.kind != .directory) return error.InvalidSnapshot;
        var dir = try root.openDir(entry.name, .{ .no_follow = true });
        defer dir.close();
        const bytes = try dir.readFileAlloc(ctx.a, "snapshot.json", 1 << 20);
        const meta = try std.json.parseFromSliceLeaky(Meta, ctx.a, bytes, .{ .ignore_unknown_fields = true });
        if (!std.mem.eql(u8, meta.id, entry.name) or !std.mem.eql(u8, meta.version, v) or meta.n != n) return error.InvalidSnapshot;
        try dir.access(".usage.lock", .{});
        try result.append(ctx.a, meta);
    }
    std.mem.sort(Meta, result.items, {}, struct {
        fn less(_: void, a: Meta, b: Meta) bool {
            if (a.order != null and b.order != null) {
                const cmp = orderCompare(a.order.?, b.order.?);
                if (cmp != .eq) return cmp == .lt;
            }
            const cmp = std.mem.order(u8, a.version, b.version);
            return if (cmp != .eq) cmp == .lt else a.n < b.n;
        }
    }.less);
    return result.toOwnedSlice(ctx.a);
}

fn lookup(ctx: *const Ctx, all: []const Meta, query: []const u8) !Meta {
    const version = select.snapshotVersion(query) orelse return error.InvalidSnapshotId;
    if (!safeVersion(version)) return error.InvalidSnapshotId;
    const key = query[version.len + 1 ..];
    var versions: std.ArrayList(select.Bundle) = .empty;
    for (all) |s| {
        var known = false;
        for (versions.items) |v| if (std.mem.eql(u8, v.version, s.version)) {
            known = true;
            break;
        };
        if (!known) try versions.append(ctx.a, .{ .version = s.version, .meta = null });
    }
    const matched = switch (select.matchVersion(versions.items, version)) {
        .found => |v| v,
        .none => return error.SnapshotNotFound,
        .ambiguous => return error.AmbiguousSnapshot,
    };
    const number = std.fmt.parseInt(u64, key, 10) catch null;
    var found: ?Meta = null;
    for (all) |s| {
        if (!std.mem.eql(u8, s.version, matched)) continue;
        if (if (number) |n| s.n != n else s.alias == null or !std.mem.eql(u8, key, s.alias.?)) continue;
        if (found != null) return error.AmbiguousSnapshot;
        found = s;
    }
    return found orelse error.SnapshotNotFound;
}

pub fn existing(ctx: *const Ctx, query: []const u8) !Snapshot {
    const s = try lookup(ctx, try list(ctx), query);
    return .{ .id = s.id, .dir = ctx.path(&.{ "snapshots", s.id }) };
}

fn newest(all: []const Meta, version: []const u8) ?Meta {
    var best: ?Meta = null;
    for (all) |s| if (std.mem.eql(u8, s.version, version) and (best == null or s.n > best.?.n)) {
        best = s;
    };
    return best;
}

fn orderCompare(a: Order, b: Order) std.math.Order {
    const t = std.mem.order(u8, a.upstream.commitTime, b.upstream.commitTime);
    if (t != .eq) return t;
    if (a.run != b.run) return std.math.order(a.run, b.run);
    return std.math.order(a.attempt, b.attempt);
}

fn previous(all: []const Meta, version: []const u8, order: Order) ?Meta {
    var best: ?Meta = null;
    for (all) |s| {
        if (s.order == null or std.mem.eql(u8, s.version, version) or orderCompare(s.order.?, order) != .lt) continue;
        if (best == null or orderCompare(s.order.?, best.?.order.?) == .gt or
            (orderCompare(s.order.?, best.?.order.?) == .eq and std.mem.order(u8, s.version, best.?.version) == .gt)) best = s;
    }
    return if (best) |s| newest(all, s.version) else null;
}

fn storeLock(ctx: *const Ctx) !lock.Lock {
    var root = ctx.ensureDir(&.{"snapshots"});
    root.close();
    return lock.tryAcquire(ctx.path(&.{ "snapshots", ".lock" }), .exclusive, true);
}

pub fn prepare(ctx: *const Ctx, version: []const u8, meta: select.Meta) Snapshot {
    return ensure(ctx, version, meta, "start") catch |err| {
        if (err == error.UnsafeSnapshotLink) std.process.exit(1); // Named diagnostic already emitted; staging defers completed.
        util.fatal("cannot prepare snapshot for {s}: {s}; inspect `dsh manager snapshot list` and retry", .{ version, @errorName(err) });
    };
}

pub fn ensure(ctx: *const Ctx, version: []const u8, meta: select.Meta, reason: []const u8) !Snapshot {
    // Ordinary launches reuse immutable published metadata without contending on the store lock.
    if (newest(try list(ctx), version)) |s| return .{ .id = s.id, .dir = ctx.path(&.{ "snapshots", s.id }) };
    const mutex = try storeLock(ctx);
    defer mutex.release();
    const all = try list(ctx);
    if (newest(all, version)) |s| return .{ .id = s.id, .dir = ctx.path(&.{ "snapshots", s.id }) };
    const order = Order{ .upstream = .{ .commitTime = meta.commit_time.? }, .run = meta.run.?, .attempt = meta.attempt.? };
    return create(ctx, all, version, order, reason, null, previous(all, version, order));
}

fn create(ctx: *const Ctx, all: []const Meta, version: []const u8, order: Order, reason: []const u8, alias: ?[]const u8, source: ?Meta) !Snapshot {
    if (!safeVersion(version)) return error.InvalidRuntimeId;
    if (alias) |name| {
        if (name.len == 0 or std.mem.indexOfNone(u8, name, "0123456789") == null) return error.InvalidSnapshotName;
        for (name) |c| if (!(std.ascii.isAlphanumeric(c) or c == '.' or c == '_' or c == '-')) return error.InvalidSnapshotName;
        for (all) |s| if (std.mem.eql(u8, version, s.version) and s.alias != null and std.mem.eql(u8, name, s.alias.?)) return error.SnapshotNameTaken;
    }
    var root = try std.fs.cwd().openDir(ctx.path(&.{"snapshots"}), .{ .no_follow = true });
    defer root.close();
    const counter_bytes = root.readFileAlloc(ctx.a, ".counters.json", 1 << 20) catch |err| switch (err) {
        error.FileNotFound => null,
        else => return err,
    };
    var counters: std.json.ObjectMap = .init(ctx.a);
    if (counter_bytes) |bytes| {
        const value = std.json.parseFromSliceLeaky(std.json.Value, ctx.a, bytes, .{}) catch return error.InvalidSnapshotCounters;
        if (value != .object) return error.InvalidSnapshotCounters;
        counters = value.object;
        var it = counters.iterator();
        while (it.next()) |entry| if (!safeVersion(entry.key_ptr.*) or entry.value_ptr.* != .integer or entry.value_ptr.integer < 0) return error.InvalidSnapshotCounters;
    }
    var last: u64 = if (counters.get(version)) |v| @intCast(v.integer) else 0;
    for (all) |s| if (std.mem.eql(u8, s.version, version)) {
        last = @max(last, s.n);
    };
    if (last >= std.math.maxInt(i64)) return error.SnapshotCounterOverflow;
    const n = last + 1;
    try counters.put(version, .{ .integer = @intCast(n) });
    var buffer: [4096]u8 = undefined;
    var counter_file = try root.atomicFile(".counters.json", .{ .write_buffer = &buffer });
    defer counter_file.deinit();
    try counter_file.file_writer.interface.writeAll(try std.json.Stringify.valueAlloc(ctx.a, std.json.Value{ .object = counters }, .{}));
    try counter_file.finish(); // Reserve first: failures and interruptions never recycle an ID.
    crashPoint(ctx, "snapshot-reserved");
    const id = try std.fmt.allocPrint(ctx.a, "{s}@{d}", .{ version, n });
    const staging = try std.fmt.allocPrint(ctx.a, ".staging-{x}", .{std.crypto.random.int(u64)});
    try root.makeDir(staging);
    defer root.deleteTree(staging) catch {};
    var dir = try root.openDir(staging, .{});
    var open = true;
    defer if (open) dir.close();
    try dir.makeDir("profiles");
    if (source) |s| {
        const src_path = ctx.path(&.{ "snapshots", s.id, "profiles" });
        var src = try std.fs.cwd().openDir(src_path, .{ .iterate = true, .no_follow = true });
        defer src.close();
        var dest = try dir.openDir("profiles", .{ .iterate = true });
        defer dest.close();
        try copyProfiles(ctx, src, dest, src_path, "");
        try validateCopiedLinks(ctx, dest, try dest.realpathAlloc(ctx.a, "."), "");
    }
    crashPoint(ctx, "snapshot-copied");
    try dir.writeFile(.{ .sub_path = ".usage.lock", .data = "" });
    const bytes = try std.json.Stringify.valueAlloc(ctx.a, Meta{
        .id = id,
        .version = version,
        .n = n,
        .alias = alias,
        .createdAt = timestamp(ctx.a),
        .source = if (source) |s| s.id else "empty",
        .reason = reason,
        .order = order,
    }, .{});
    const file = try dir.createFile("snapshot.json", .{});
    var file_open = true;
    defer if (file_open) file.close();
    try file.writeAll(bytes);
    try file.sync();
    file.close();
    file_open = false;
    dir.close();
    open = false; // Windows publication needs closed staging handles.
    try root.rename(staging, id);
    return .{ .id = id, .dir = ctx.path(&.{ "snapshots", id }) };
}

/// Copy files, not hardlinks. Relative pnpm links may remain only within the copied profiles tree.
fn copyProfiles(ctx: *const Ctx, src: std.fs.Dir, dest: std.fs.Dir, base: []const u8, rel: []const u8) !void {
    var it = src.iterate();
    while (try it.next()) |entry| {
        const child = try std.fs.path.join(ctx.a, &.{ rel, entry.name });
        switch (entry.kind) {
            .file => try src.copyFile(entry.name, dest, entry.name, .{}),
            .directory => {
                try dest.makeDir(entry.name);
                var source_dir = try src.openDir(entry.name, .{ .iterate = true, .no_follow = true });
                defer source_dir.close();
                var dest_dir = try dest.openDir(entry.name, .{});
                defer dest_dir.close();
                try copyProfiles(ctx, source_dir, dest_dir, base, child);
            },
            .sym_link => {
                var buffer: [4096]u8 = undefined;
                const target = try src.readLink(entry.name, &buffer);
                const resolved = try std.fs.path.resolve(ctx.a, &.{ base, rel, target });
                const inside = try std.fs.path.relative(ctx.a, base, resolved);
                if (std.fs.path.isAbsolute(target) or std.mem.indexOfAny(u8, target, "\\:") != null or std.fs.path.isAbsolute(inside) or std.mem.eql(u8, inside, "..") or std.mem.startsWith(u8, inside, "../") or std.mem.startsWith(u8, inside, "..\\")) {
                    util.warn("cannot copy snapshot link {s}: target {s} escapes profiles; nothing was published", .{ child, target });
                    return error.UnsafeSnapshotLink;
                }
                const stat = src.statFile(entry.name) catch return error.InvalidSnapshotLink;
                try dest.symLink(target, entry.name, .{ .is_directory = stat.kind == .directory });
            },
            else => return error.UnsupportedSnapshotFile,
        }
    }
}

/// Resolve links only after the entire copy exists, so chained links are checked against staging, not the source.
fn validateCopiedLinks(ctx: *const Ctx, dir: std.fs.Dir, base: []const u8, rel: []const u8) !void {
    var it = dir.iterate();
    while (try it.next()) |entry| {
        const child = try std.fs.path.join(ctx.a, &.{ rel, entry.name });
        switch (entry.kind) {
            .directory => {
                var subdir = try dir.openDir(entry.name, .{ .iterate = true, .no_follow = true });
                defer subdir.close();
                try validateCopiedLinks(ctx, subdir, base, child);
            },
            .sym_link => {
                const resolved = dir.realpathAlloc(ctx.a, entry.name) catch |err| {
                    util.warn("cannot copy snapshot link {s}: cannot resolve target ({s}); nothing was published", .{ child, @errorName(err) });
                    return error.UnsafeSnapshotLink;
                };
                const inside = try std.fs.path.relative(ctx.a, base, resolved);
                if (std.fs.path.isAbsolute(inside) or std.mem.eql(u8, inside, "..") or std.mem.startsWith(u8, inside, "../") or std.mem.startsWith(u8, inside, "..\\")) {
                    util.warn("cannot copy snapshot link {s}: resolved target escapes profiles; nothing was published", .{child});
                    return error.UnsafeSnapshotLink;
                }
            },
            else => {},
        }
    }
}

fn crashPoint(ctx: *const Ctx, point: []const u8) void {
    if (std.mem.eql(u8, ctx.env.get("DSH_MANAGER_TEST") orelse "", "1") and std.mem.eql(u8, ctx.env.get("DSH_MANAGER_TEST_CRASH") orelse "", point)) std.process.exit(86);
}

pub fn run(ctx: *Ctx, args: []const []const u8) u8 {
    return command(ctx, args) catch |err| {
        if (err == error.UnsafeSnapshotLink) return 1;
        util.warn("snapshot operation failed: {s}; inspect `dsh manager snapshot list` (retry if another operation is busy)", .{@errorName(err)});
        return 1;
    };
}

fn command(ctx: *Ctx, args: []const []const u8) !u8 {
    if (args.len == 0) return error.SnapshotUsage;
    if (std.mem.eql(u8, args[0], "list")) {
        if (args.len > 2 or (args.len == 2 and !std.mem.eql(u8, args[1], "--json"))) return error.SnapshotUsage;
        const all = try list(ctx);
        const bundles = runtimes.list(ctx);
        const stored = state.readSelection(ctx);
        const chosen = if (stored == .ok) @import("manage.zig").snapshotChoice(stored.ok) else null;
        const Row = struct { id: []const u8, alias: ?[]const u8, version: []const u8, createdAt: []const u8, source: []const u8, reason: []const u8, newest: bool, selected: bool, inUse: bool, bundleInstalled: bool };
        const rows = try ctx.a.alloc(Row, all.len);
        for (all, rows) |s, *r| r.* = .{ .id = s.id, .alias = s.alias, .version = s.version, .createdAt = s.createdAt, .source = s.source, .reason = s.reason, .newest = newest(all, s.version).?.n == s.n, .selected = chosen != null and std.mem.eql(u8, chosen.?, s.id), .inUse = lock.inUse(ctx.path(&.{ "snapshots", s.id, ".usage.lock" })), .bundleInstalled = select.matchVersion(bundles, s.version) == .found };
        if (args.len == 2) util.print("{s}\n", .{try std.json.Stringify.valueAlloc(ctx.a, .{ .snapshots = rows }, .{})}) else {
            if (rows.len == 0) util.print("No snapshots yet (one is created when a runtime is installed or started).\n", .{});
            for (rows) |r| util.print("{s} ({s})  {s}  from {s}  {s}{s}{s}{s}{s}\n", .{ r.id, r.alias orelse "unnamed", r.createdAt, r.source, r.reason, if (r.newest) " [newest]" else "", if (r.selected) " [selected]" else "", if (r.inUse) " [in use]" else "", if (!r.bundleInstalled) " [bundle not installed]" else "" });
        }
        return 0;
    }
    if (!std.mem.eql(u8, args[0], "new") and !std.mem.eql(u8, args[0], "remove")) return error.SnapshotUsage;
    // Validate CLI before creating storage or taking mutation locks.
    var use: ?[]const u8 = null;
    var alias: ?[]const u8 = null;
    var target: ?[]const u8 = null;
    var empty = false;
    if (std.mem.eql(u8, args[0], "new")) {
        var i: usize = 1;
        while (i < args.len) : (i += 1) {
            const arg = args[i];
            if (std.mem.eql(u8, arg, "--empty") and !empty) {
                empty = true;
                continue;
            }
            var matched = false;
            inline for (.{ "--use", "--name", "--target" }) |flag| {
                if (std.mem.eql(u8, arg, flag) or std.mem.startsWith(u8, arg, flag ++ "=")) {
                    const slot = if (std.mem.eql(u8, flag, "--use")) &use else if (std.mem.eql(u8, flag, "--name")) &alias else &target;
                    if (slot.* != null) return error.SnapshotUsage;
                    if (std.mem.eql(u8, arg, flag)) {
                        i += 1;
                        if (i == args.len) return error.SnapshotUsage;
                        slot.* = args[i];
                    } else slot.* = arg[flag.len + 1 ..];
                    if (slot.*.?.len == 0) return error.SnapshotUsage;
                    matched = true;
                }
            }
            if (!matched) return error.SnapshotUsage;
        }
        if (empty and target != null) return error.SnapshotUsage;
    } else {
        if (args.len < 2) return error.SnapshotUsage;
        for (args[1..]) |arg| if (std.mem.startsWith(u8, arg, "-")) return error.SnapshotUsage;
    }
    ctx.ensureData();
    const maintenance = try state.maintenance(ctx);
    defer maintenance.release();
    const mutex = try storeLock(ctx);
    defer mutex.release();
    var root = try std.fs.cwd().openDir(ctx.path(&.{"snapshots"}), .{ .iterate = true, .no_follow = true });
    defer root.close();
    const all = try listIn(ctx, root);
    if (std.mem.eql(u8, args[0], "new")) {
        const bundles = runtimes.list(ctx);
        const stored = state.readSelection(ctx);
        if (stored == .invalid and use == null) return error.InvalidSelection;
        const result = select.resolve(.{ .opts = .{ .use = use }, .bundles = bundles, .channel = state.channel(ctx), .selection_use = if (stored == .ok) stored.ok.use else null });
        if (result == .err) {
            util.warn("cannot resolve runtime for snapshot; give an installed --use version (see `dsh manager list`)", .{});
            return 1;
        }
        const version = result.ok.version;
        const meta = runtimes.metaOf(bundles, version) orelse return error.InvalidRuntime;
        if (!meta.ordered()) return error.InvalidRuntime;
        const source = if (empty) null else if (target) |q| try lookup(ctx, all, q) else newest(all, version) orelse {
            util.warn("dsh {s} has no snapshot to copy; use `dsh manager snapshot new --use {s} --empty` or --target <id>", .{ version, version });
            return 1;
        };
        const s = try create(ctx, all, version, .{ .upstream = .{ .commitTime = meta.commit_time.? }, .run = meta.run.?, .attempt = meta.attempt.? }, "user", alias, source);
        util.print("Created plugin snapshot {s} ({s}).\n", .{ s.id, if (source) |v| v.id else "empty" });
        return 0;
    }
    var targets: std.ArrayList(Meta) = .empty;
    var failures: std.ArrayList(u8) = .empty;
    for (args[1..]) |q| {
        const s = lookup(ctx, all, q) catch |err| {
            try failures.print(ctx.a, "{s} ({s}); ", .{ q, @errorName(err) });
            continue;
        };
        var duplicate = false;
        for (targets.items) |t| if (std.mem.eql(u8, s.id, t.id)) {
            duplicate = true;
            break;
        };
        if (!duplicate) try targets.append(ctx.a, s);
    }
    const stored = state.readSelection(ctx);
    if (stored == .invalid) return error.InvalidSelection;
    const chosen = if (stored == .ok) @import("manage.zig").snapshotChoice(stored.ok) else null;
    const chosen_id = if (chosen) |q| (try lookup(ctx, all, q)).id else null;
    const claims = try ctx.a.alloc(?lock.Lock, targets.items.len);
    @memset(claims, null);
    defer for (claims) |c| if (c) |l| l.release();
    for (targets.items, claims) |s, *c| {
        if (chosen_id != null and std.mem.eql(u8, s.id, chosen_id.?)) try failures.print(ctx.a, "{s} (named by selection); ", .{s.id});
        c.* = lock.tryAcquireIn(root, util.join(ctx.a, &.{ s.id, ".usage.lock" }), .exclusive, false) catch |err| {
            try failures.print(ctx.a, "{s} ({s}); ", .{ s.id, if (err == error.Busy) "in use" else @errorName(err) });
            continue;
        };
    }
    if (failures.items.len != 0) {
        util.warn("cannot remove snapshots: {s}nothing was removed; reset selection or retry after sessions exit", .{failures.items});
        return 1;
    }
    // Test-only stdin barrier permits deterministic ancestor replacement after validation.
    if (std.mem.eql(u8, ctx.env.get("DSH_MANAGER_TEST") orelse "", "1") and std.mem.eql(u8, ctx.env.get("DSH_MANAGER_TEST_PAUSE") orelse "", "snapshot-remove")) {
        util.warn("test pause: snapshot-remove", .{});
        util.flush();
        var byte: [1]u8 = undefined;
        if (try std.fs.File.stdin().read(&byte) == 0) return error.TestPauseAborted;
    }
    for (targets.items, claims) |s, *c| {
        @import("install.zig").remove(ctx, root, s.id, c) catch |err| {
            util.warn("cannot remove snapshot {s}: {s}; earlier reported removals remain removed", .{ s.id, @errorName(err) });
            return 1;
        };
        util.print("Removed snapshot {s}.\n", .{s.id});
    }
    return 0;
}

fn timestamp(a: std.mem.Allocator) []const u8 {
    const seconds: std.time.epoch.EpochSeconds = .{ .secs = @intCast(@max(0, std.time.timestamp())) };
    const day = seconds.getEpochDay().calculateYearDay();
    const month = day.calculateMonthDay();
    const time = seconds.getDaySeconds();
    return std.fmt.allocPrint(a, "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.000Z", .{ day.year, @intFromEnum(month.month), month.day_index + 1, time.getHoursIntoDay(), time.getMinutesIntoHour(), time.getSecondsIntoMinute() }) catch util.oom();
}
