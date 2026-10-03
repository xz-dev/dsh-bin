//! Typed snapshot storage: atomic publication, persistent monotonic counters and independent copies.
const std = @import("std");
const builtin = @import("builtin");
const binary = @import("manager_binary.zig");
const util = @import("util.zig");
const select = @import("select.zig");
const state = @import("state.zig");
const runtimes = @import("runtimes.zig");
const lock = @import("lock.zig");
const Ctx = @import("context.zig").Ctx;

pub const Kind = enum {
    plugins,
    config,

    pub fn root(self: Kind) []const u8 {
        return if (self == .plugins) "snapshots" else "config-snapshots";
    }
};
pub const Snapshot = struct { kind: Kind, id: []const u8, dir: []const u8 };
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

fn list(ctx: *const Ctx, kind: Kind) ![]Meta {
    var root = std.fs.cwd().openDir(ctx.path(&.{kind.root()}), .{ .iterate = true, .no_follow = true }) catch |err| switch (err) {
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
        const file = try binary.openRegular(dir, "snapshot.json");
        defer file.close();
        const bytes = try file.readToEndAlloc(ctx.a, 1 << 20);
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

pub fn existing(ctx: *const Ctx, kind: Kind, query: []const u8) !Snapshot {
    const s = try lookup(ctx, try list(ctx, kind), query);
    return .{ .kind = kind, .id = s.id, .dir = ctx.path(&.{ kind.root(), s.id }) };
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

const Store = struct {
    dir: std.fs.Dir,
    mutex: lock.Lock,
    fn close(self: Store) void {
        self.mutex.release();
        var dir = self.dir;
        dir.close();
    }
};

fn storeLock(ctx: *const Ctx, kind: Kind) !Store {
    var data = try std.fs.cwd().openDir(ctx.data, .{ .iterate = true, .no_follow = true });
    defer data.close();
    _ = try makeDirectory(ctx, data, kind.root(), kind);
    var root = try data.openDir(kind.root(), .{ .iterate = true, .no_follow = true });
    errdefer root.close();
    if ((try root.stat()).kind != .directory) return error.InvalidSnapshotStore;
    if (kind == .config) try privateAccess(ctx, data, kind.root(), .{ .handle = root.fd });
    return .{ .dir = root, .mutex = try lock.tryAcquireIn(root, ".lock", .exclusive, true) };
}

pub fn prepare(ctx: *const Ctx, kind: Kind, version: []const u8, meta: select.Meta) Snapshot {
    return ensure(ctx, kind, version, meta, "start") catch |err| {
        if (err == error.UnsafeSnapshotLink) std.process.exit(1); // Named diagnostic already emitted; staging defers completed.
        util.fatal("cannot prepare snapshot for {s}: {s}; inspect `dsh manager snapshot <plugins|config> list` and retry", .{ version, @errorName(err) });
    };
}

pub fn ensure(ctx: *const Ctx, kind: Kind, version: []const u8, meta: select.Meta, reason: []const u8) !Snapshot {
    // Ordinary launches reuse immutable published metadata without contending on the store lock.
    if (newest(try list(ctx, kind), version)) |s| return .{ .kind = kind, .id = s.id, .dir = ctx.path(&.{ kind.root(), s.id }) };
    const store = try storeLock(ctx, kind);
    defer store.close();
    const all = try listIn(ctx, store.dir);
    if (newest(all, version)) |s| return .{ .kind = kind, .id = s.id, .dir = ctx.path(&.{ kind.root(), s.id }) };
    const order = Order{ .upstream = .{ .commitTime = meta.commit_time.? }, .run = meta.run.?, .attempt = meta.attempt.? };
    return create(ctx, kind, store.dir, all, version, order, reason, null, previous(all, version, order));
}

fn create(ctx: *const Ctx, kind: Kind, root: std.fs.Dir, all: []const Meta, version: []const u8, order: Order, reason: []const u8, alias: ?[]const u8, source: ?Meta) !Snapshot {
    if (!safeVersion(version)) return error.InvalidRuntimeId;
    if (alias) |name| {
        if (name.len == 0 or std.mem.indexOfNone(u8, name, "0123456789") == null) return error.InvalidSnapshotName;
        for (name) |c| if (!(std.ascii.isAlphanumeric(c) or c == '.' or c == '_' or c == '-')) return error.InvalidSnapshotName;
        for (all) |s| if (std.mem.eql(u8, version, s.version) and s.alias != null and std.mem.eql(u8, name, s.alias.?)) return error.SnapshotNameTaken;
    }
    // Hold the existing counter through atomic replacement; links/hardlinks are never mutation targets.
    const old_counter = binary.openRegular(root, ".counters.json") catch |err| switch (err) {
        error.FileNotFound => null,
        else => return err,
    };
    defer if (old_counter) |file| file.close();
    const counter_bytes = if (old_counter) |file| blk: {
        try singleLink(file);
        break :blk try file.readToEndAlloc(ctx.a, 1 << 20);
    } else null;
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
    var counter_file = try root.atomicFile(".counters.json", .{ .mode = if (kind == .config) 0o600 else 0o644, .write_buffer = &buffer });
    defer counter_file.deinit();
    try counter_file.file_writer.interface.writeAll(try std.json.Stringify.valueAlloc(ctx.a, std.json.Value{ .object = counters }, .{}));
    if (old_counter) |file| {
        if (!binary.sameFile(root, ".counters.json", file)) return error.SnapshotChanged;
    } else {
        try absent(root, ".counters.json");
    }
    try counter_file.finish(); // Reserve first: failures and interruptions never recycle an ID.
    crashPoint(ctx, "snapshot-reserved");
    const id = try std.fmt.allocPrint(ctx.a, "{s}@{d}", .{ version, n });
    const staging = try std.fmt.allocPrint(ctx.a, ".staging-{x}", .{std.crypto.random.int(u64)});
    if (!try makeDirectory(ctx, root, staging, kind)) return error.PathAlreadyExists;
    var dir = try root.openDir(staging, .{ .iterate = true, .no_follow = true });
    const staging_stat = try dir.stat();
    var open = true;
    defer if (open) dir.close();
    // Keep failed staging private. Never delete a name whose identity may have changed.
    errdefer {
        if (sameDirectory(root, staging, staging_stat)) root.deleteTree(staging) catch {};
    }
    _ = try makeDirectory(ctx, dir, "profiles", kind);
    if (source) |s| {
        var src = try root.openDir(s.id, .{ .iterate = true, .no_follow = true });
        defer src.close();
        const source_stat = try src.stat();
        binary.testPause(ctx, "snapshot-copy", s.id); // Handles pinned before any handoff.
        if (!sameDirectory(root, s.id, source_stat)) return error.SnapshotChanged;
        if (kind == .config) {
            try copyConfig(ctx, src, dir, "");
        } else {
            var profiles = try src.openDir("profiles", .{ .iterate = true, .no_follow = true });
            defer profiles.close();
            var dest = try dir.openDir("profiles", .{ .iterate = true, .no_follow = true });
            defer dest.close();
            try copyProfiles(ctx, profiles, dest, try profiles.realpathAlloc(ctx.a, "."), "");
            try validateCopiedLinks(ctx, dest, try dest.realpathAlloc(ctx.a, "."), "");
        }
        if (!sameDirectory(root, s.id, source_stat) or !unchanged(source_stat, try src.stat())) return error.SnapshotChanged;
    }
    crashPoint(ctx, "snapshot-copied");
    const guard = try privateFile(ctx, dir, ".usage.lock", kind);
    guard.close();
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
    const file = try privateFile(ctx, dir, "snapshot.json", kind);
    var file_open = true;
    defer if (file_open) file.close();
    try file.writeAll(bytes);
    try file.sync();
    file.close();
    file_open = false;
    if (!sameDirectory(root, staging, staging_stat)) return error.SnapshotChanged;
    dir.close();
    open = false; // Windows publication needs closed staging handles.
    try @import("self_update.zig").publish(ctx.a, root, staging, id);
    if (!sameDirectory(root, id, staging_stat)) return error.SnapshotChanged;
    return .{ .kind = kind, .id = id, .dir = ctx.path(&.{ kind.root(), id }) };
}

/// Copy files, not hardlinks. Relative pnpm links may remain only within the copied profiles tree.
fn copyProfiles(ctx: *const Ctx, src: std.fs.Dir, dest: std.fs.Dir, base: []const u8, rel: []const u8) !void {
    var it = src.iterate();
    while (try it.next()) |entry| {
        const child = try std.fs.path.join(ctx.a, &.{ rel, entry.name });
        switch (entry.kind) {
            .file => try copyFile(ctx, src, dest, entry.name, .plugins),
            .directory => {
                try dest.makeDir(entry.name);
                var source_dir = try src.openDir(entry.name, .{ .iterate = true, .no_follow = true });
                defer source_dir.close();
                var dest_dir = try dest.openDir(entry.name, .{});
                defer dest_dir.close();
                const before = try source_dir.stat();
                try copyProfiles(ctx, source_dir, dest_dir, base, child);
                if (!sameDirectory(src, entry.name, before) or !unchanged(before, try source_dir.stat())) return error.SnapshotChanged;
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

pub fn run(ctx: *Ctx, args: []const []const u8, opts: select.Options) u8 {
    return command(ctx, args, opts) catch |err| {
        if (err == error.UnsafeSnapshotLink) return 1;
        if (err == error.SnapshotUsage) {
            util.warn("usage: dsh manager snapshot <plugins|config> new [--target <id> | --empty] [--name <alias>] | list [--json] | remove <id>...", .{});
            return 1;
        }
        util.warn("snapshot operation failed: {s}; inspect `dsh manager snapshot <plugins|config> list` (retry if another operation is busy)", .{@errorName(err)});
        return 1;
    };
}

fn command(ctx: *Ctx, input: []const []const u8, opts: select.Options) !u8 {
    if (input.len < 2) return error.SnapshotUsage;
    const kind = std.meta.stringToEnum(Kind, input[0]) orelse return error.SnapshotUsage;
    const args = input[1..];
    if (std.mem.eql(u8, args[0], "list")) {
        if (args.len > 2 or (args.len == 2 and !std.mem.eql(u8, args[1], "--json"))) return error.SnapshotUsage;
        const all = try list(ctx, kind);
        const bundles = runtimes.list(ctx);
        const stored = state.readSelection(ctx);
        const chosen = if (stored == .ok) @import("manage.zig").snapshotChoice(stored.ok, kind) else null;
        const Row = struct { kind: Kind, id: []const u8, alias: ?[]const u8, version: []const u8, createdAt: []const u8, source: []const u8, reason: []const u8, newest: bool, selected: bool, inUse: bool, bundleInstalled: bool };
        const rows = try ctx.a.alloc(Row, all.len);
        for (all, rows) |s, *r| r.* = .{ .kind = kind, .id = s.id, .alias = s.alias, .version = s.version, .createdAt = s.createdAt, .source = s.source, .reason = s.reason, .newest = newest(all, s.version).?.n == s.n, .selected = chosen != null and std.mem.eql(u8, chosen.?, s.id), .inUse = lock.inUse(ctx.path(&.{ kind.root(), s.id, ".usage.lock" })), .bundleInstalled = select.matchVersion(bundles, s.version) == .found };
        if (args.len == 2) util.print("{s}\n", .{try std.json.Stringify.valueAlloc(ctx.a, .{ .snapshots = rows }, .{})}) else {
            if (rows.len == 0) util.print("No snapshots yet (one is created when a runtime is installed or started).\n", .{});
            for (rows) |r| util.print("{s} {s} ({s})  {s}  from {s}  {s}{s}{s}{s}{s}\n", .{ @tagName(kind), r.id, r.alias orelse "unnamed", r.createdAt, r.source, r.reason, if (r.newest) " [newest]" else "", if (r.selected) " [selected]" else "", if (r.inUse) " [in use]" else "", if (!r.bundleInstalled) " [bundle not installed]" else "" });
        }
        return 0;
    }
    if (!std.mem.eql(u8, args[0], "new") and !std.mem.eql(u8, args[0], "remove")) return error.SnapshotUsage;
    // Validate CLI before creating storage or taking mutation locks.
    var use: ?[]const u8 = opts.use;
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
    const store = try storeLock(ctx, kind);
    defer store.close();
    const root = store.dir;
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
            util.warn("dsh {s} has no snapshot to copy; use `dsh manager snapshot <plugins|config> new --use {s} --empty` or --target <id>", .{ version, version });
            return 1;
        };
        const s = try create(ctx, kind, store.dir, all, version, .{ .upstream = .{ .commitTime = meta.commit_time.? }, .run = meta.run.?, .attempt = meta.attempt.? }, "user", alias, source);
        util.print("Created {s} snapshot {s} ({s}).\n", .{ @tagName(kind), s.id, if (source) |v| v.id else "empty" });
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
    const chosen = if (stored == .ok) @import("manage.zig").snapshotChoice(stored.ok, kind) else null;
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
            if (err == error.UsageReported) return 1;
            util.warn("cannot remove snapshot {s}: {s}; earlier reported removals remain removed", .{ s.id, @errorName(err) });
            return 1;
        };
        util.print("Removed snapshot {s}.\n", .{s.id});
        util.flush(); // A later failure must not hide earlier successful removals.
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

fn absent(parent: std.fs.Dir, name: []const u8) !void {
    var it = parent.iterate();
    while (try it.next()) |entry| if (std.mem.eql(u8, entry.name, name)) return error.PathAlreadyExists;
}

fn sameDirectory(parent: std.fs.Dir, name: []const u8, held: std.fs.File.Stat) bool {
    var current = parent.openDir(name, .{ .no_follow = true }) catch return false;
    defer current.close();
    const stat = current.stat() catch return false;
    return stat.kind == .directory and held.inode == stat.inode;
}

fn unchanged(before: std.fs.File.Stat, after: std.fs.File.Stat) bool {
    return before.inode == after.inode and before.kind == after.kind and before.size == after.size and
        before.mtime == after.mtime and before.ctime == after.ctime;
}

fn singleLink(file: std.fs.File) !void {
    if (builtin.os.tag == .windows) {
        var info: std.os.windows.BY_HANDLE_FILE_INFORMATION = undefined;
        if (GetFileInformationByHandle(file.handle, &info) == 0 or info.nNumberOfLinks != 1) return error.UnsafeSnapshotFile;
    } else if ((try std.posix.fstat(file.handle)).nlink != 1) return error.UnsafeSnapshotFile;
}

/// Independent bytes from a pinned regular source, checked before/after copy and against final output.
fn copyFile(ctx: *const Ctx, src: std.fs.Dir, dest: std.fs.Dir, name: []const u8, kind: Kind) !void {
    const source = try binary.openRegular(src, name);
    defer source.close();
    if (kind == .config) try singleLink(source);
    const before = try source.stat();
    const file = if (kind == .config) try privateFile(ctx, dest, name, kind) else try dest.createFile(name, .{ .read = true, .exclusive = true, .mode = before.mode });
    defer file.close();
    if (kind == .config and builtin.os.tag != .windows) {
        if (!binary.sameFile(dest, name, file)) return error.SnapshotChanged;
        try singleLink(file);
        try file.chmod(before.mode & 0o600); // Never broaden source owner access either.
    }
    var hash = std.crypto.hash.sha2.Sha256.init(.{});
    var buf: [64 * 1024]u8 = undefined;
    while (true) {
        const n = try source.read(&buf);
        if (n == 0) break;
        hash.update(buf[0..n]);
        try file.writeAll(buf[0..n]);
    }
    binary.testPause(ctx, "snapshot-file-copied", name);
    if (std.mem.eql(u8, ctx.env.get("DSH_MANAGER_TEST") orelse "", "1") and
        std.mem.eql(u8, ctx.env.get("DSH_MANAGER_TEST_FAIL") orelse "", "snapshot-copy")) return error.TestCopyFailed;
    if (!binary.sameFile(src, name, source) or !unchanged(before, try source.stat())) return error.SnapshotChanged;
    try file.sync();
    if (!binary.sameFile(dest, name, file) or !std.mem.eql(u8, &(try binary.digest(file)), &hash.finalResult())) return error.SnapshotChanged;
}

/// This store owns configuration, not home. Unknown future config names stay byte-preserved;
/// known non-content and operation temporaries never travel to another snapshot.
fn configExcluded(name: []const u8) bool {
    for ([_][]const u8{ "snapshot.json", ".usage.lock", ".lock", ".counters.json", "node_modules", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "cordis.yml", "addons", "bundles", "sessions", "session", "cache", "tmp", "state" }) |skip|
        if (std.mem.eql(u8, name, skip)) return true;
    return std.mem.endsWith(u8, name, ".lock") or std.mem.endsWith(u8, name, ".tmp") or
        std.mem.startsWith(u8, name, ".staging-") or std.mem.startsWith(u8, name, ".tmp-") or
        std.mem.indexOf(u8, name, ".tmp-") != null or std.mem.endsWith(u8, name, ".jsonl");
}

fn copyConfig(ctx: *const Ctx, src: std.fs.Dir, dest: std.fs.Dir, rel: []const u8) !void {
    const before = try src.stat();
    if (before.kind != .directory or (try dest.stat()).kind != .directory) return error.UnsafeSnapshotFile;
    var it = src.iterate();
    while (try it.next()) |entry| {
        if (configExcluded(entry.name)) continue;
        const child = try std.fs.path.join(ctx.a, &.{ rel, entry.name });
        switch (entry.kind) {
            .file => try copyFile(ctx, src, dest, entry.name, .config),
            .directory => {
                _ = try makeDirectory(ctx, dest, entry.name, .config);
                var source = try src.openDir(entry.name, .{ .iterate = true, .no_follow = true });
                defer source.close();
                const held = try source.stat();
                var target = try dest.openDir(entry.name, .{ .iterate = true, .no_follow = true });
                defer target.close();
                try copyConfig(ctx, source, target, child);
                if (!sameDirectory(src, entry.name, held)) return error.SnapshotChanged;
            },
            // Credentials never follow links, even within the tree: copying their target could
            // silently capture external bytes. Config copies use independent regular files only.
            else => return error.UnsafeSnapshotFile,
        }
    }
    if (!unchanged(before, try src.stat())) return error.SnapshotChanged;
}

fn makeDirectory(ctx: *const Ctx, parent: std.fs.Dir, name: []const u8, kind: Kind) !bool {
    if (kind == .plugins) {
        parent.makeDir(name) catch |err| {
            if (err == error.PathAlreadyExists) return false;
            return err;
        };
    } else if (builtin.os.tag == .windows) {
        var security = try PrivateSecurity.init(ctx.a);
        defer security.deinit();
        const path = try win.sliceToPrefixedFileW(parent.fd, name);
        const handle = win.OpenFile(path.span(), .{
            .dir = parent.fd,
            .sa = &security.attributes,
            .access_mask = win.GENERIC_READ | win.GENERIC_WRITE | win.SYNCHRONIZE,
            .creation = win.FILE_CREATE,
            .filter = .dir_only,
            .follow_symlinks = false,
        }) catch |err| {
            if (err == error.PathAlreadyExists) return false;
            return err;
        };
        win.CloseHandle(handle);
    } else std.posix.mkdirat(parent.fd, name, 0o700) catch |err| {
        if (err == error.PathAlreadyExists) return false;
        return err;
    };
    return true;
}

fn privateFile(ctx: *const Ctx, parent: std.fs.Dir, name: []const u8, kind: Kind) !std.fs.File {
    if (kind == .config and builtin.os.tag == .windows) {
        var security = try PrivateSecurity.init(ctx.a);
        defer security.deinit();
        const path = try win.sliceToPrefixedFileW(parent.fd, name);
        // Exclusive create establishes DACL before any sensitive bytes. Reopen synchronously
        // through the retained parent, then compare identity before writing.
        const first = std.fs.File{ .handle = try win.OpenFile(path.span(), .{ .dir = parent.fd, .sa = &security.attributes, .access_mask = win.GENERIC_READ | win.GENERIC_WRITE | win.SYNCHRONIZE, .creation = win.FILE_CREATE, .follow_symlinks = false }) };
        defer first.close();
        const file = try parent.openFile(name, .{ .mode = .read_write });
        errdefer file.close();
        if ((try file.stat()).kind != .file or (try first.stat()).inode != (try file.stat()).inode) return error.SnapshotChanged;
        try singleLink(file);
        return file;
    }
    return parent.createFile(name, .{ .read = true, .exclusive = true, .mode = if (kind == .config) 0o600 else 0o644 });
}

fn privateAccess(ctx: *const Ctx, parent: std.fs.Dir, name: []const u8, file: std.fs.File) !void {
    if (!sameDirectory(parent, name, try file.stat())) return error.SnapshotChanged;
    if (builtin.os.tag == .windows) {
        var security = try PrivateSecurity.init(ctx.a);
        defer security.deinit();
        const path = try win.sliceToPrefixedFileW(parent.fd, name);
        const handle = try win.OpenFile(path.span(), .{ .dir = parent.fd, .access_mask = 0x40000 | win.FILE_READ_ATTRIBUTES, .creation = win.FILE_OPEN, .filter = .dir_only, .follow_symlinks = false }); // WRITE_DAC
        defer win.CloseHandle(handle);
        const target = std.fs.File{ .handle = handle };
        if ((try target.stat()).kind != .directory or (try target.stat()).inode != (try file.stat()).inode) return error.SnapshotChanged;
        var present: win.BOOL = 0;
        var defaulted: win.BOOL = 0;
        var acl: ?*anyopaque = null;
        if (GetSecurityDescriptorDacl(security.descriptor, &present, &acl, &defaulted) == 0 or present == 0 or acl == null) return error.PrivateAccessFailed;
        if (SetSecurityInfo(handle, 1, 0x80000004, null, null, acl, null) != 0) return error.PrivateAccessFailed;
    } else try file.chmod(0o700);
}

const win = std.os.windows;
extern "kernel32" fn GetFileInformationByHandle(win.HANDLE, *win.BY_HANDLE_FILE_INFORMATION) callconv(.winapi) win.BOOL;
extern "kernel32" fn LocalFree(?*anyopaque) callconv(.winapi) ?*anyopaque;
extern "advapi32" fn OpenProcessToken(win.HANDLE, win.DWORD, *win.HANDLE) callconv(.winapi) win.BOOL;
extern "advapi32" fn GetTokenInformation(win.HANDLE, c_uint, ?*anyopaque, win.DWORD, *win.DWORD) callconv(.winapi) win.BOOL;
extern "advapi32" fn ConvertSidToStringSidW(*anyopaque, *[*:0]u16) callconv(.winapi) win.BOOL;
extern "advapi32" fn ConvertStringSecurityDescriptorToSecurityDescriptorW([*:0]const u16, win.DWORD, *?*anyopaque, ?*win.DWORD) callconv(.winapi) win.BOOL;
extern "advapi32" fn GetSecurityDescriptorDacl(?*anyopaque, *win.BOOL, *?*anyopaque, *win.BOOL) callconv(.winapi) win.BOOL;
extern "advapi32" fn SetSecurityInfo(win.HANDLE, c_uint, win.DWORD, ?*anyopaque, ?*anyopaque, ?*anyopaque, ?*anyopaque) callconv(.winapi) win.DWORD;

/// Current process user only, protected DACL; OI/CI makes subsequent application-created
/// files private too. No shell/PowerShell invocation, POSIX mode simulation or inherited broad ACL.
const PrivateSecurity = struct {
    descriptor: ?*anyopaque,
    attributes: win.SECURITY_ATTRIBUTES,
    fn init(a: std.mem.Allocator) !PrivateSecurity {
        var token: win.HANDLE = undefined;
        if (OpenProcessToken(win.GetCurrentProcess(), 8, &token) == 0) return error.PrivateAccessFailed;
        defer win.CloseHandle(token);
        var needed: win.DWORD = 0;
        _ = GetTokenInformation(token, 1, null, 0, &needed); // TokenUser
        if (needed == 0) return error.PrivateAccessFailed;
        const info = try a.alignedAlloc(u8, .of(usize), needed);
        defer a.free(info);
        if (GetTokenInformation(token, 1, info.ptr, needed, &needed) == 0) return error.PrivateAccessFailed;
        const sid = (@as(*const extern struct { sid: *anyopaque, attributes: win.DWORD }, @ptrCast(info.ptr))).sid;
        var sid_text: [*:0]u16 = undefined;
        if (ConvertSidToStringSidW(sid, &sid_text) == 0) return error.PrivateAccessFailed;
        defer _ = LocalFree(@ptrCast(sid_text));
        const sid_utf8 = try std.unicode.utf16LeToUtf8Alloc(a, std.mem.span(sid_text));
        defer a.free(sid_utf8);
        const text = try std.fmt.allocPrint(a, "D:P(A;OICI;FA;;;{s})", .{sid_utf8});
        defer a.free(text);
        const wide = try std.unicode.utf8ToUtf16LeAllocZ(a, text);
        defer a.free(wide);
        var descriptor: ?*anyopaque = null;
        if (ConvertStringSecurityDescriptorToSecurityDescriptorW(wide, 1, &descriptor, null) == 0) return error.PrivateAccessFailed;
        return .{ .descriptor = descriptor, .attributes = .{ .nLength = @sizeOf(win.SECURITY_ATTRIBUTES), .lpSecurityDescriptor = descriptor, .bInheritHandle = win.FALSE } };
    }
    fn deinit(self: PrivateSecurity) void {
        _ = LocalFree(self.descriptor);
    }
};

test "CS-IDENTITY: roots are typed; config exclusions leave opaque future content intact" {
    const t = std.testing;
    try t.expectEqualStrings("snapshots", Kind.plugins.root());
    try t.expectEqualStrings("config-snapshots", Kind.config.root());
    try t.expect(!configExcluded(".credentials.yaml"));
    try t.expect(!configExcluded("settings.yaml.imported"));
    try t.expect(!configExcluded("future-format.bin"));
    for ([_][]const u8{ "node_modules", "pnpm-lock.yaml", "cordis.yml", "sessions", ".credentials.yaml.lock", ".credentials.yaml.tmp-123", ".tmp-test" }) |name| try t.expect(configExcluded(name));
}
