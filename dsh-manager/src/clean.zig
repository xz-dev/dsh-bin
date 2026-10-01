//! Offline cleanup: only exact manager-generated names in their designated stores.
//! Preflight locks/claims all live objects before deleting anything; unknown data is never adopted.
const std = @import("std");
const util = @import("util.zig");
const lock = @import("lock.zig");
const index = @import("index.zig");
const select = @import("select.zig");
const binary = @import("manager_binary.zig");
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

fn displayPath(a: std.mem.Allocator, parent: []const u8, name: []const u8) ![]const u8 {
    if (parent.len == 0) return a.dupe(u8, name);
    return std.fmt.allocPrint(a, "{s}/{s}", .{ parent, name });
}

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
        const store = Store{ .dir = dir, .path = try displayPath(self.ctx.a, parent.path, name) };
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
            try self.hold(.{ .dir = dir, .path = try displayPath(self.ctx.a, parent.path, name) }, ".usage.lock", false);
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
    if (dash <= 8) return false;
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

/// A public generation must not obtain a required file/directory through a recovery-backup link.
/// Walk every component without following links, including ancestors of nested required paths.
fn independentPath(root: std.fs.Dir, path: []const u8) bool {
    var parent = root;
    var owned: ?std.fs.Dir = null;
    defer if (owned) |*d| d.close();
    var parts = std.mem.tokenizeScalar(u8, path, '/');
    var part = parts.next() orelse return false;
    while (true) {
        var it = parent.iterate();
        const kind = while (it.next() catch return false) |entry| {
            if (eq(u8, entry.name, part)) break entry.kind;
        } else return false;
        if (kind != .file and kind != .directory) return false;
        if (@import("builtin").os.tag == .windows) {
            // Zig's iterator reports directory reparse points as directories. Inspect the
            // component itself before accepting a final path or descending through it.
            const win = std.os.windows;
            const path_w = win.sliceToPrefixedFileW(parent.fd, part) catch return false;
            const file = std.fs.File{ .handle = win.OpenFile(path_w.span(), .{
                .dir = parent.fd,
                .access_mask = win.FILE_READ_ATTRIBUTES,
                .creation = win.FILE_OPEN,
                .filter = .any,
                .follow_symlinks = false,
            }) catch return false };
            defer file.close();
            const inspected = (file.stat() catch return false).kind;
            // File.stat distinguishes all reparse points (sym_link or unknown).
            if (inspected != .file and inspected != .directory) return false;
        }
        const next = parts.next() orelse return true;
        if (kind != .directory) return false;
        var child = parent.openDir(part, .{ .iterate = true, .no_follow = true }) catch return false;
        if ((child.stat() catch {
            child.close();
            return false;
        }).kind != .directory) {
            child.close();
            return false;
        }
        if (owned) |*d| d.close();
        owned = child;
        parent = child;
        part = next;
    }
}

/// Conservatively require a complete public generation before discarding a recovery backup.
fn publicValid(ctx: *const Ctx, parent: ?Store, id: []const u8, addon: bool) bool {
    const s = parent orelse return false;
    var dir = s.dir.openDir(id, .{ .iterate = true, .no_follow = true }) catch return false;
    defer dir.close();
    if ((dir.stat() catch return false).kind != .directory) return false;
    if (!independentPath(dir, ".usage.lock")) return false;
    if (addon) {
        if (!independentPath(dir, "addon.json") or !independentPath(dir, "node_modules")) return false;
        const meta = @import("addons.zig").readIn(ctx, s.dir, id, id) catch return false;
        for (meta.packages) |p| {
            if (!index.component(p) and !std.mem.startsWith(u8, p, "@")) return false;
            if (std.mem.indexOf(u8, p, "..") != null or std.mem.indexOfScalar(u8, p, '\\') != null) return false;
            // addon packages use package@version labels; the installed directory omits that version suffix.
            const end = std.mem.lastIndexOfScalar(u8, p, '@') orelse p.len;
            const package = if (end == 0) p else p[0..end];
            if (!independentPath(dir, std.fmt.allocPrint(ctx.a, "node_modules/{s}", .{package}) catch return false)) return false;
        }
        return true;
    }
    if (!independentPath(dir, "bundle.json")) return false;
    const bytes = dir.readFileAlloc(ctx.a, "bundle.json", 1 << 20) catch return false;
    const meta = select.parseMeta(ctx.a, bytes) orelse return false;
    if (!meta.ordered() or meta.protocol != select.protocol or meta.entry == null) return false;
    const Identity = struct { id: []const u8, requiredPaths: []const []const u8 };
    const m = std.json.parseFromSliceLeaky(Identity, ctx.a, bytes, .{ .ignore_unknown_fields = true }) catch return false;
    if (!eq(u8, m.id, id) or m.requiredPaths.len == 0) return false;
    for (m.requiredPaths) |p| {
        if (std.fs.path.isAbsolute(p) or std.mem.indexOf(u8, p, "..") != null or std.mem.indexOfAny(u8, p, "\\:\x00") != null) return false;
        if (!independentPath(dir, p)) return false;
    }
    if (!independentPath(dir, meta.entry.?)) return false;
    const stat = dir.statFile(meta.entry.?) catch return false;
    return stat.kind == .file and (@import("builtin").os.tag == .windows or stat.mode & 0o111 != 0);
}

fn treeEntry(kind: std.fs.File.Kind) bool {
    return kind == .directory or kind == .sym_link;
}
fn overlap(a: std.mem.Allocator, x: []const u8, y: []const u8) bool {
    const rel = std.fs.path.relative(a, x, y) catch return true;
    return !std.fs.path.isAbsolute(rel) and !eq(u8, rel, "..") and !std.mem.startsWith(u8, rel, "../") and !std.mem.startsWith(u8, rel, "..\\");
}
/// Visit every home alias before resolving it, not just the final realpath. Ordinary home
/// symlinks outside cleanup candidates remain supported; unresolvable chains fail closed.
fn homeOverlap(ctx: *const Ctx, candidate: []const u8) !bool {
    var home = ctx.home();
    for (0..40) |_| {
        if (overlap(ctx.a, candidate, home) or overlap(ctx.a, home, candidate)) return true;
        var parts = try std.fs.path.componentIterator(home);
        home = while (parts.next()) |part| {
            // Do not normalize '..' across an unresolved link: visit the alias first.
            if (overlap(ctx.a, candidate, part.path)) return true;
            // Windows readLink reports NOT_A_REPARSE_POINT as Unexpected, not NotLink.
            // Inspect the final component through a no-follow handle before calling it.
            if (@import("builtin").os.tag == .windows) {
                const win = std.os.windows;
                const path_w = try win.sliceToPrefixedFileW(null, part.path);
                const file = std.fs.File{ .handle = win.OpenFile(path_w.span(), .{
                    .access_mask = win.FILE_READ_ATTRIBUTES,
                    .creation = win.FILE_OPEN,
                    .filter = .any,
                    .follow_symlinks = false,
                }) catch |err| switch (err) {
                    error.FileNotFound => return false,
                    else => return err,
                } };
                const stat = file.stat();
                file.close();
                const kind = (try stat).kind;
                if (kind == .file or kind == .directory) continue;
                if (kind != .sym_link) return error.UnsupportedReparsePointType;
            }
            var buf: [std.fs.max_path_bytes]u8 = undefined;
            const target = std.fs.cwd().readLink(part.path, &buf) catch |err| switch (err) {
                error.NotLink => continue,
                error.FileNotFound => return false, // A not-yet-created application home is allowed.
                else => return err,
            };
            const base = std.fs.path.dirname(part.path) orelse part.path;
            const resolved = if (std.fs.path.isAbsolute(target)) try ctx.a.dupe(u8, target) else try std.fs.path.join(ctx.a, &.{ base, target });
            break try std.fs.path.join(ctx.a, &.{ resolved, home[part.path.len..] });
        } else return false;
    }
    return error.SymLinkLoop;
}

fn protectHome(ctx: *const Ctx, items: []const Item) !void {
    for (items) |item| {
        const parent = try item.store.dir.realpathAlloc(ctx.a, ".");
        const path = try std.fs.path.join(ctx.a, &.{ parent, item.name });
        const resolved = if (item.kind == .sym_link) path else std.fs.cwd().realpathAlloc(ctx.a, path) catch path;
        const depends = homeOverlap(ctx, path) catch true;
        if (depends or (homeOverlap(ctx, resolved) catch true)) {
            util.warn("cannot clean {s}/{s}: overlaps or cannot safely resolve DSH_HOME {s}; nothing removed; choose a separate application home before retry", .{ item.store.path, item.name, ctx.home() });
            return error.Reported;
        }
    }
}

fn collect(c: *Cleanup, root: Store) !void {
    if (c.ctx.mode == .portable) {
        var dir = try std.fs.cwd().openDir(c.ctx.dir, .{ .iterate = true, .no_follow = true });
        const store = Store{ .dir = dir, .path = "manager-directory" };
        c.stores.append(c.ctx.a, store) catch |err| {
            dir.close();
            return err;
        };
        var files = dir.iterate();
        while (try files.next()) |entry| {
            if (entry.kind != .file) continue;
            if (!@import("manager_binary.zig").reclaimable(c.ctx.a, dir, entry.name)) continue;
            try c.add(store, entry);
        }
    }
    const cache = try c.open(root, "cache");
    if (cache) |s| {
        var it = s.dir.iterate();
        while (try it.next()) |entry| for (cache_names) |name| if (eq(u8, entry.name, name) and treeEntry(entry.kind)) {
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
            if (entry.kind == .file and std.mem.startsWith(u8, entry.name, ".self-update-result-") and std.mem.endsWith(u8, entry.name, ".tmp") and nonce(entry.name[20 .. entry.name.len - 4])) {
                try c.add(tmp, entry);
                continue;
            }
            if (!treeEntry(entry.kind)) continue;
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
        while (try it.next()) |entry| if (namedNonce(entry.name, ".staging-") and treeEntry(entry.kind)) try c.add(s, entry);
    }
    try protectHome(c.ctx, c.items.items);
    const work = c.items.items.len != 0;
    // With no residue, still check existing mutexes/claims, but create nothing.
    if (work) root.dir.makeDir("state") catch |err| if (err != error.PathAlreadyExists) return err;
    if (try c.open(root, "state")) |state| try c.hold(state, "manager.lock", work);
    if (snapshots) |s| try c.hold(s, ".lock", work);
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
        if (eq(u8, item.store.path, "manager-directory")) {
            const file = binary.reclaimableFile(ctx.a, item.store.dir, item.name) catch {
                util.warn("kept manager candidate {s}: not a regular valid candidate", .{item.name});
                continue;
            };
            defer file.close();
            if (!binary.deleteValidated(ctx, item.store.dir, item.name, file, "candidate-clean-delete")) continue;
        } else if (std.mem.startsWith(u8, item.name, ".self-update-result-")) {
            const file = binary.openRegular(item.store.dir, item.name) catch continue;
            defer file.close();
            if (!binary.deleteValidated(ctx, item.store.dir, item.name, file, "result-clean-delete")) continue;
        } else item.store.dir.deleteTree(item.name) catch |err| {
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
