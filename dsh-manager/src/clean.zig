//! Offline cleanup: only exact manager-generated names in their designated stores.
//! Preflight locks/claims all live objects before deleting anything; unknown data is never adopted.
const std = @import("std");
const util = @import("util.zig");
const lock = @import("lock.zig");
const index = @import("index.zig");
const select = @import("select.zig");
const Ctx = @import("context.zig").Ctx;
const eq = std.mem.eql;

// Shared with launch's cache environment: never clean arbitrary entries under cache/ or tmp/.
pub const cache_names = [_][]const u8{ "bun", "transpiler", "npm", "pnpm" };
pub const cache_env = .{
    .{ "BUN_INSTALL_CACHE_DIR", &.{ "cache", cache_names[0] } },
    .{ "BUN_RUNTIME_TRANSPILER_CACHE_PATH", &.{ "cache", cache_names[1] } },
    .{ "npm_config_cache", &.{ "cache", cache_names[2] } },
    .{ "pnpm_config_store_dir", &.{ "cache", cache_names[3], "store" } },
    .{ "pnpm_config_cache_dir", &.{ "cache", cache_names[3], "cache" } },
    .{ "PNPM_HOME", &.{ "cache", cache_names[3], "home" } },
};

const Store = struct { dir: std.fs.Dir, path: []const u8 };
const Item = struct { store: Store, name: []const u8, kind: std.fs.File.Kind };
const Cleanup = struct {
    ctx: *const Ctx,
    stores: std.ArrayList(Store) = .empty,
    items: std.ArrayList(Item) = .empty,
    claims: std.ArrayList(lock.Lock) = .empty,

    fn deinit(self: *Cleanup) void {
        for (self.claims.items) |claim| claim.release();
        for (self.stores.items) |*s| s.dir.close();
    }
    fn open(self: *Cleanup, parent: Store, name: []const u8) !?Store {
        var dir = parent.dir.openDir(name, .{ .iterate = true, .no_follow = true }) catch |err| {
            if (err == error.FileNotFound) {
                // A dangling link is not an absent store.
                var buf: [std.fs.max_path_bytes]u8 = undefined;
                if (parent.dir.readLink(name, &buf)) |_| return error.LinkedStorage else |_| {}
                return null;
            }
            return err;
        };
        errdefer dir.close();
        if ((try dir.stat()).kind != .directory) return error.LinkedStorage;
        const store = Store{ .dir = dir, .path = try std.fs.path.join(self.ctx.a, &.{ parent.path, name }) };
        try self.stores.append(self.ctx.a, store);
        return store;
    }
    fn add(self: *Cleanup, s: Store, entry: std.fs.Dir.Entry) !void {
        try self.items.append(self.ctx.a, .{ .store = s, .name = try self.ctx.a.dupe(u8, entry.name), .kind = entry.kind });
    }
    fn hold(self: *Cleanup, s: Store, name: []const u8, create: bool) !void {
        const claim = lock.tryAcquireIn(s.dir, name, .exclusive, create) catch |err| {
            if (!create and err == error.Missing) return;
            util.warn("cannot clean: {s}/{s} is in use or an operation is in progress ({s}); nothing removed; exit running sessions and retry", .{ s.path, name, @errorName(err) });
            return error.Reported;
        };
        errdefer claim.release();
        try self.claims.append(self.ctx.a, claim);
    }
    fn guard(self: *Cleanup, parent: Store, name: []const u8) !void {
        var dir = try parent.dir.openDir(name, .{ .iterate = true, .no_follow = true });
        defer dir.close();
        // Never follow a guard link into another tree, or silently treat a malformed guard as idle.
        var it = dir.iterate();
        while (try it.next()) |entry| if (eq(u8, entry.name, ".usage.lock")) {
            if (entry.kind != .file) return error.InvalidUsageGuard;
            try self.hold(.{ .dir = dir, .path = try std.fs.path.join(self.ctx.a, &.{ parent.path, name }) }, ".usage.lock", false);
            return;
        };
    }
    fn live(self: *Cleanup, s: ?Store) !void {
        const store = s orelse return;
        var it = store.dir.iterate();
        while (try it.next()) |entry| if (entry.kind == .directory and entry.name[0] != '.') try self.guard(store, entry.name);
    }
};

fn nonce(s: []const u8) bool {
    if (s.len == 0 or s.len > 16) return false;
    for (s) |c| if (!std.ascii.isHex(c)) return false;
    return true;
}
fn namedNonce(name: []const u8, prefix: []const u8) bool {
    return std.mem.startsWith(u8, name, prefix) and nonce(name[prefix.len..]);
}
fn removed(name: []const u8) bool {
    if (!std.mem.startsWith(u8, name, ".remove-")) return false;
    const dash = std.mem.lastIndexOfScalar(u8, name, '-') orelse return false;
    const id = name[8..dash];
    if (!nonce(name[dash + 1 ..])) return false;
    if (select.snapshotVersion(id)) |v| {
        if (!index.component(v)) return false;
        const n = std.fmt.parseInt(u64, id[v.len + 1 ..], 10) catch return false;
        return n > 0;
    }
    return index.component(id);
}
fn download(name: []const u8) bool {
    const hash = if (std.mem.endsWith(u8, name, ".zip.part")) name[0 .. name.len - 9] else if (std.mem.endsWith(u8, name, ".zip")) name[0 .. name.len - 4] else return false;
    if (hash.len != 64) return false;
    for (hash) |c| if (!std.ascii.isHex(c)) return false;
    return true;
}

/// Conservatively require a complete public generation before discarding a recovery backup.
fn publicValid(ctx: *const Ctx, parent: ?Store, id: []const u8, addon: bool) bool {
    const s = parent orelse return false;
    var dir = s.dir.openDir(id, .{ .iterate = true, .no_follow = true }) catch return false;
    defer dir.close();
    if ((dir.stat() catch return false).kind != .directory) return false;
    dir.access(".usage.lock", .{}) catch return false;
    if (addon) {
        const bytes = dir.readFileAlloc(ctx.a, "addon.json", 1 << 20) catch return false;
        const meta = std.json.parseFromSliceLeaky(@import("addons.zig").Meta, ctx.a, bytes, .{ .ignore_unknown_fields = true }) catch return false;
        if (!eq(u8, meta.name, "office") or !eq(u8, meta.version, id)) return false;
        dir.access("node_modules", .{}) catch return false;
        for (meta.packages) |p| {
            if (!index.component(p) and !std.mem.startsWith(u8, p, "@")) return false;
            if (std.mem.indexOf(u8, p, "..") != null or std.mem.indexOfScalar(u8, p, '\\') != null) return false;
            dir.access(util.join(ctx.a, &.{ "node_modules", p }), .{}) catch return false;
        }
        return true;
    }
    const bytes = dir.readFileAlloc(ctx.a, "bundle.json", 1 << 20) catch return false;
    const meta = select.parseMeta(ctx.a, bytes) orelse return false;
    if (meta.format != .runtime_v1 or meta.protocol != select.protocol or meta.entry == null) return false;
    const Identity = struct { id: []const u8, requiredPaths: []const []const u8 };
    const m = std.json.parseFromSliceLeaky(Identity, ctx.a, bytes, .{ .ignore_unknown_fields = true }) catch return false;
    if (!eq(u8, m.id, id) or m.requiredPaths.len == 0) return false;
    for (m.requiredPaths) |p| {
        if (std.fs.path.isAbsolute(p) or std.mem.indexOf(u8, p, "..") != null or std.mem.indexOfAny(u8, p, "\\:\x00") != null) return false;
        dir.access(p, .{}) catch return false;
    }
    const stat = dir.statFile(meta.entry.?) catch return false;
    return stat.kind == .file and (@import("builtin").os.tag == .windows or stat.mode & 0o111 != 0);
}

fn collect(c: *Cleanup, root: Store) !void {
    const cache = try c.open(root, "cache");
    if (cache) |s| {
        var it = s.dir.iterate();
        while (try it.next()) |entry| for (cache_names) |name| if (eq(u8, entry.name, name)) {
            try c.add(s, entry);
            break;
        };
        if (try c.open(s, "downloads")) |downloads| {
            var files = downloads.dir.iterate();
            while (try files.next()) |entry| if (download(entry.name) and (entry.kind == .file or entry.kind == .sym_link)) try c.add(downloads, entry);
        }
    }
    const bundles = try c.open(root, "bundles");
    const addons = try c.open(root, "addons");
    const office = if (addons) |s| try c.open(s, "office") else null;
    const snapshots = try c.open(root, "snapshots");
    if (try c.open(root, "tmp")) |tmp| {
        var it = tmp.dir.iterate();
        while (try it.next()) |entry| {
            if (namedNonce(entry.name, ".install-") or removed(entry.name)) {
                try c.add(tmp, entry);
            } else if (std.mem.startsWith(u8, entry.name, ".previous-")) {
                const addon = std.mem.startsWith(u8, entry.name, ".previous-addon-office-");
                const id = entry.name[if (addon) @as(usize, 23) else @as(usize, 10)..];
                if (!index.component(id)) continue;
                if (publicValid(c.ctx, if (addon) office else bundles, id, addon)) {
                    try c.add(tmp, entry);
                } else {
                    const command = if (addon) try std.fmt.allocPrint(c.ctx.a, "dsh manager install --addon office:{s} --force", .{id}) else try std.fmt.allocPrint(c.ctx.a, "dsh manager install {s} --force", .{id});
                    util.warn("kept tmp/{s}: public generation missing or invalid; recover with `{s}`", .{ entry.name, command });
                }
            }
        }
    }
    if (snapshots) |s| {
        var it = s.dir.iterate();
        while (try it.next()) |entry| if (namedNonce(entry.name, ".staging-")) try c.add(s, entry);
    }
    if (c.items.items.len == 0) return;
    // Maintenance first, then store lock, matches install -> snapshot ordering. No waiting.
    root.dir.makeDir("state") catch |err| if (err != error.PathAlreadyExists) return err;
    const state = (try c.open(root, "state")).?;
    try c.hold(state, "manager.lock", true);
    if (snapshots) |s| try c.hold(s, ".lock", true);
    try c.live(bundles);
    try c.live(snapshots);
    try c.live(office);
    // Recheck recovery eligibility under maintenance: never delete the only surviving generation.
    var n: usize = 0;
    while (n < c.items.items.len) {
        const item = c.items.items[n];
        if (std.mem.startsWith(u8, item.name, ".previous-")) {
            const addon = std.mem.startsWith(u8, item.name, ".previous-addon-office-");
            const id = item.name[if (addon) @as(usize, 23) else @as(usize, 10)..];
            if (!publicValid(c.ctx, if (addon) office else bundles, id, addon)) {
                _ = c.items.orderedRemove(n);
                util.warn("kept tmp/{s}: public generation changed; retry explicit install before cleaning", .{item.name});
                continue;
            }
        }
        n += 1;
    }
    const live_claims = c.claims.items.len;
    for (c.items.items) |item| if (item.kind == .directory and !eq(u8, item.store.path, "cache")) try c.guard(item.store, item.name);
    // Maintenance/store mutexes serialize private residue, which has no public launch identity.
    // Close its guards before deletion: Windows cannot delete a tree with open descendants.
    for (c.claims.items[live_claims..]) |claim| claim.release();
    c.claims.shrinkRetainingCapacity(live_claims);
}

fn perform(ctx: *const Ctx) !void {
    var root_dir = std.fs.cwd().openDir(ctx.data, .{ .iterate = true, .no_follow = true }) catch |err| {
        if (err == error.FileNotFound) return;
        return err;
    };
    defer root_dir.close();
    if ((try root_dir.stat()).kind != .directory) return error.LinkedStorage;
    const bytes = root_dir.readFileAlloc(ctx.a, @import("context.zig").data_marker, 4096) catch |err| {
        if (err != error.FileNotFound) return err;
        var it = root_dir.iterate();
        if (try it.next() == null) return;
        util.warn("cannot clean unowned data root {s}: initialization may be interrupted; inspect it manually; no data adopted or removed", .{ctx.data});
        return error.Reported;
    };
    const Marker = struct { kind: []const u8, schema: u32 };
    const marker = std.json.parseFromSliceLeaky(Marker, ctx.a, bytes, .{}) catch return error.InvalidOwnershipMarker;
    if (marker.schema != 1 or !eq(u8, marker.kind, "dsh-manager-data")) return error.InvalidOwnershipMarker;
    var c = Cleanup{ .ctx = ctx };
    defer c.deinit();
    try collect(&c, .{ .dir = root_dir, .path = "" });
    if (eq(u8, ctx.env.get("DSH_MANAGER_TEST") orelse "", "1") and eq(u8, ctx.env.get("DSH_MANAGER_TEST_PAUSE") orelse "", "clean")) {
        util.warn("test pause: clean", .{});
        util.flush();
        var byte: [1]u8 = undefined;
        if ((std.fs.File.stdin().read(&byte) catch 0) == 0) return error.TestPauseAborted;
    }
    // Private residue has no launch identity. Release its guard before deleteTree on Windows.
    // Installed-object claims and store mutexes remain held until all cleanup is done.
    for (c.items.items) |item| {
        item.store.dir.deleteTree(item.name) catch |err| {
            util.warn("cannot clean {s}/{s}: {s}; earlier reported removals remain removed", .{ item.store.path, item.name, @errorName(err) });
            return error.Reported;
        };
        util.print("Removed {s}/{s}.\n", .{ item.store.path, item.name });
    }
}

pub fn run(ctx: *const Ctx, args: []const []const u8) u8 {
    if (args.len != 0) {
        util.warn("usage: dsh manager clean", .{});
        return 1;
    }
    perform(ctx) catch |err| {
        if (err != error.Reported) util.warn("cannot clean data root {s}: {s}; inspect storage and retry; no unrecognised data is removed", .{ ctx.data, @errorName(err) });
        return 1;
    };
    return 0;
}
