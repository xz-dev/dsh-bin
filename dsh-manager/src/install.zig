//! Explicit native runtime install (section 3). Selection is never written; no runtime is executed.
const std = @import("std");
const builtin = @import("builtin");
const util = @import("util.zig");
const index = @import("index.zig");
const target = @import("target.zig");
const http = @import("http.zig");
const zip = @import("zip.zig");
const select = @import("select.zig");
const state = @import("state.zig");
const snapshot = @import("snapshot.zig");
const lock = @import("lock.zig");
const runtimes = @import("runtimes.zig");
const Ctx = @import("context.zig").Ctx;

pub fn run(ctx: *Ctx, args: []const []const u8, opts: select.Options) u8 {
    return command(ctx, args, false, opts);
}

pub fn update(ctx: *Ctx, args: []const []const u8) u8 {
    return command(ctx, args, true, .{});
}

fn command(ctx: *Ctx, args: []const []const u8, updating: bool, opts: select.Options) u8 {
    var query: ?[]const u8 = if (updating) "latest" else null;
    var channel: ?[]const u8 = null;
    var force = false;
    var addon: ?[]const u8 = null;
    var n: usize = 0;
    while (n < args.len) : (n += 1) {
        const arg = args[n];
        if (std.mem.eql(u8, arg, "--help") or std.mem.eql(u8, arg, "-h")) {
            util.print("{s}", .{@import("manager.zig").help_text});
            return 0;
        }
        if (std.mem.eql(u8, arg, "--addon") or std.mem.startsWith(u8, arg, "--addon=")) {
            if (updating or addon != null) return usage();
            if (std.mem.eql(u8, arg, "--addon")) {
                n += 1;
                if (n == args.len) return usage();
                addon = args[n];
            } else addon = arg[8..];
            continue;
        }
        if (std.mem.eql(u8, arg, "--force")) {
            force = true;
        } else if (std.mem.eql(u8, arg, "--channel") or std.mem.startsWith(u8, arg, "--channel=")) {
            if (channel != null) return usage();
            if (std.mem.eql(u8, arg, "--channel")) {
                n += 1;
                if (n == args.len) return usage();
                channel = args[n];
            } else channel = arg[10..];
            if (!std.mem.eql(u8, channel.?, "release") and !std.mem.eql(u8, channel.?, "live")) return usage();
        } else if (!std.mem.startsWith(u8, arg, "-") and query == null) {
            query = arg;
        } else return usage();
    }
    if (addon) |a| {
        if (query != null or channel != null) return usage();
        return @import("addons.zig").install(ctx, a, force, opts);
    }
    if (query == null) return usage();
    ctx.ensureData();
    const mutex = state.maintenance(ctx) catch |err| {
        util.warn("cannot acquire maintenance lock {s}: {s}; retry when the other manager operation finishes", .{ ctx.path(&.{ "state", "manager.lock" }), @errorName(err) });
        return 1;
    };
    defer mutex.release();
    const installed = perform(ctx, query.?, channel orelse state.channel(ctx), force, false) catch |err| {
        if (err == error.UsageReported) return 1;
        util.warn("runtime install failed: {s}; no selection was changed", .{@errorName(err)});
        return 1;
    };
    pinnedWarning(ctx, installed);
    return 0;
}

fn pinnedWarning(ctx: *const Ctx, installed: []const u8) void {
    const stored = state.readSelection(ctx);
    if (stored != .ok or std.mem.eql(u8, stored.ok.use, "latest")) return;
    // Advisory only: read the two known IDs, never fatal storage enumeration after activation.
    if (!index.component(stored.ok.use)) return;
    const pinned_bytes = std.fs.cwd().readFileAlloc(ctx.a, ctx.path(&.{ "bundles", stored.ok.use, "bundle.json" }), 1 << 20) catch return;
    const fresh_bytes = std.fs.cwd().readFileAlloc(ctx.a, ctx.path(&.{ "bundles", installed, "bundle.json" }), 1 << 20) catch return;
    const pinned = select.Bundle{ .version = stored.ok.use, .meta = select.parseMeta(ctx.a, pinned_bytes) };
    const fresh = select.Bundle{ .version = installed, .meta = select.parseMeta(ctx.a, fresh_bytes) };
    if (pinned.meta != null and fresh.meta != null and pinned.meta.?.ordered() and fresh.meta.?.ordered() and select.before(pinned, fresh))
        util.warn("plain `dsh` still starts {s}, which the selection pins; run `dsh manager select --use latest` to follow the newest installed version", .{stored.ok.use});
}

fn usage() u8 {
    util.warn("usage: dsh manager install <version|tag|prefix|latest> [--channel <release|live>] [--force]", .{});
    return 1;
}

/// Ordinary empty launch: serialize with explicit installs, then recheck before activating anything.
/// No stdout output: it belongs to the runtime that will start after this returns.
pub fn bootstrap(ctx: *Ctx) void {
    var state_dir = ctx.ensureDir(&.{"state"});
    state_dir.close();
    const mutex = lock.acquire(ctx.path(&.{ "state", "manager.lock" }), .exclusive, true, null) catch |err|
        util.fatal("cannot acquire automatic install lock: {s}", .{@errorName(err)});
    defer mutex.release();
    if (runtimes.list(ctx).len != 0) return;
    const channel = state.channel(ctx);
    util.warn("no runtime installed; installing latest compatible {s} runtime", .{channel});
    _ = perform(ctx, "latest", channel, false, true) catch |err|
        util.fatal("automatic runtime install failed: {s}; retry with `dsh manager install latest --channel {s}`", .{ @errorName(err), channel });
}

fn perform(ctx: *Ctx, query: []const u8, channel: []const u8, force: bool, automatic: bool) ![]const u8 {
    const host = try target.host();
    const endpoints = http.endpoints(ctx.a, &ctx.env);
    defer endpoints.deinit(ctx.a);
    const bytes = try http.fetchSmall(ctx.a, &ctx.env, endpoints.runtime_index, 16 << 20);
    const candidates = try index.candidates(ctx.a, bytes, channel, host);
    const candidate = switch (try index.choose(ctx.a, candidates, query)) {
        .found => |c| c,
        .none => {
            util.warn("no compatible {s} runtime matches {s} for host target {s} (launch protocol {d})", .{ channel, query, host, select.protocol });
            return error.NoCandidate;
        },
        .ambiguous => |ids| {
            util.warn("version {s} is ambiguous ({s}, {s}, ...); give more of the version", .{ query, ids[0], ids[1] });
            return error.AmbiguousVersion;
        },
    };
    const e = candidate.entry;
    const dest = ctx.path(&.{ "bundles", e.id });
    var bundles = ctx.ensureDir(&.{"bundles"});
    defer bundles.close();
    var tmp = ctx.ensureDir(&.{"tmp"});
    defer tmp.close();
    const backup = try std.fmt.allocPrint(ctx.a, ".previous-{s}", .{e.id});
    // Windows cannot atomically replace a nonempty directory. Restore an interrupted retirement
    // on the next explicit install, under the maintenance lock; never delete the only generation.
    if (!existsIn(bundles, e.id) and existsIn(tmp, backup)) {
        try recognized(ctx, tmp, backup, e.id);
        try std.fs.rename(tmp, backup, bundles, e.id);
    }
    const exists = existsIn(bundles, e.id);
    if (exists) try recognized(ctx, bundles, e.id, e.id);
    if (exists and !force) {
        _ = validate(ctx, dest, e, host) catch return error.IncompleteRuntimeUseForce;
        _ = try snapshot.ensure(ctx, .plugins, e.id, e.bundle().meta.?, "install");
        _ = try snapshot.ensure(ctx, .config, e.id, e.bundle().meta.?, "install");
        try state.write(ctx, "channel", try std.fmt.allocPrint(ctx.a, "{s}\n", .{channel}));
        if (automatic) util.warn("dsh {s} is already installed", .{e.id}) else util.print("dsh {s} is already installed.\n", .{e.id});
        return e.id;
    }
    if (exists) try checkIdle(bundles, e.id, "dsh");
    const staging = try fetchTree(ctx, tmp, candidate.asset, e.tag);
    defer tmp.deleteTree(staging) catch |err| util.warn("leftover tmp/{s} could not be deleted ({s}); run `dsh manager clean`", .{ staging, @errorName(err) });
    var dir = try tmp.openDir(staging, .{ .no_follow = true });
    var dir_open = true;
    defer if (dir_open) dir.close();
    const meta = try validateIn(ctx, dir, e, host);
    const installed_meta = try std.json.Stringify.valueAlloc(ctx.a, .{ .kind = "dsh-runtime-install", .schema = @as(u32, 1), .id = e.id, .target = host, .tag = e.tag, .asset = candidate.asset, .seq = e.seq }, .{});
    try dir.writeFile(.{ .sub_path = ".dsh-install.json", .data = installed_meta });
    try dir.writeFile(.{ .sub_path = runtimes.guard_name, .data = "" });
    dir.close(); // No open directory/file handles at Windows activation.
    dir_open = false;
    crashPoint(ctx, "before-activation");
    if (existsIn(tmp, backup)) try recognized(ctx, tmp, backup, e.id);
    try activate(ctx, tmp, staging, bundles, e.id, backup, exists);
    crashPoint(ctx, "after-activation");
    _ = try snapshot.ensure(ctx, .plugins, e.id, meta, "install");
    _ = try snapshot.ensure(ctx, .config, e.id, meta, "install");
    try state.write(ctx, "channel", try std.fmt.allocPrint(ctx.a, "{s}\n", .{channel}));
    if (automatic) util.warn("installed dsh {s} ({s}); starting original command", .{ e.id, host }) else util.print("Installed dsh {s} ({s}); selection unchanged.\n", .{ e.id, host });
    return e.id;
}

pub fn fetchTree(ctx: *const Ctx, tmp: std.fs.Dir, asset: index.Asset, tag: []const u8) ![]const u8 {
    return fetchTreeHashed(ctx, tmp, asset, tag, null);
}

pub fn fetchTreeHashed(ctx: *const Ctx, tmp: std.fs.Dir, asset: index.Asset, tag: []const u8, entry_digest: ?*zip.EntryDigest) ![]const u8 {
    const endpoints = http.endpoints(ctx.a, &ctx.env);
    defer endpoints.deinit(ctx.a);
    var cache = ctx.ensureDir(&.{ "cache", "downloads" });
    defer cache.close();
    const archive = ctx.path(&.{ "cache", "downloads", try std.fmt.allocPrint(ctx.a, "{s}.zip", .{asset.sha256}) });
    const url = try std.fmt.allocPrint(ctx.a, "{s}/{s}/{s}", .{ endpoints.download_base, tag, asset.name });
    var digest: [32]u8 = undefined;
    _ = try std.fmt.hexToBytes(&digest, asset.sha256);
    try http.download(ctx.a, &ctx.env, url, archive, .{ .size = asset.size, .sha256 = digest }, null);
    const staging = try std.fmt.allocPrint(ctx.a, ".install-{x}", .{std.crypto.random.int(u64)});
    try tmp.makeDir(staging);
    errdefer tmp.deleteTree(staging) catch {};
    var dir = try tmp.openDir(staging, .{ .iterate = true, .no_follow = true });
    defer dir.close();
    try zip.extractInHashed(ctx.a, archive, dir, entry_digest);
    return staging;
}

pub fn existsIn(dir: std.fs.Dir, name: []const u8) bool {
    dir.access(name, .{}) catch return false;
    return true;
}

fn recognized(ctx: *const Ctx, parent: std.fs.Dir, name: []const u8, id: []const u8) !void {
    var dir = parent.openDir(name, .{ .no_follow = true }) catch return error.RuntimeDirectoryConflict;
    defer dir.close();
    if ((try dir.stat()).kind != .directory) return error.RuntimeDirectoryConflict;
    const bytes = dir.readFileAlloc(ctx.a, "bundle.json", 1 << 20) catch return error.RuntimeDirectoryConflict;
    const Identity = struct { kind: []const u8, schemaVersion: u32, id: []const u8 };
    const m = std.json.parseFromSliceLeaky(Identity, ctx.a, bytes, .{ .ignore_unknown_fields = true }) catch return error.RuntimeDirectoryConflict;
    if (m.schemaVersion != 1 or !std.mem.eql(u8, m.kind, "dsh-runtime") or !std.mem.eql(u8, m.id, id)) return error.RuntimeDirectoryConflict;
}

fn crashPoint(ctx: *const Ctx, point: []const u8) void {
    if (std.mem.eql(u8, ctx.env.get("DSH_MANAGER_TEST") orelse "", "1") and std.mem.eql(u8, ctx.env.get("DSH_MANAGER_TEST_CRASH") orelse "", point)) {
        util.warn("test crash at {s}", .{point});
        std.process.exit(86); // No defers; models sudden process death on every host.
    }
}

fn safeRelative(path: []const u8) bool {
    if (path.len == 0 or path[0] == '/' or std.mem.indexOfAny(u8, path, "\\:\x00") != null) return false;
    var parts = std.mem.splitScalar(u8, path, '/');
    while (parts.next()) |p| {
        if (p.len == 0 or std.mem.eql(u8, p, ".") or std.mem.eql(u8, p, "..")) return false;
        for (p) |c| if (c < 32 or c == 127) return false;
    }
    return true;
}

fn validate(ctx: *const Ctx, staging: []const u8, e: index.Entry, host: []const u8) !select.Meta {
    var dir = try std.fs.cwd().openDir(staging, .{});
    defer dir.close();
    return validateIn(ctx, dir, e, host);
}

fn validateIn(ctx: *const Ctx, dir: std.fs.Dir, e: index.Entry, host: []const u8) !select.Meta {
    // Old outer install trees and coupled protocol fields are never adopted.
    if (existsIn(dir, "bundles")) return error.LegacyBundle;
    const bytes = try dir.readFileAlloc(ctx.a, "bundle.json", 1 << 20);
    const meta = select.parseMeta(ctx.a, bytes) orelse return error.InvalidBundle;
    const root = try std.json.parseFromSliceLeaky(std.json.Value, ctx.a, bytes, .{});
    if (root != .object or root.object.contains("launcherProtocol") or meta.format != .runtime_v1) return error.LegacyBundle;
    const Meta = struct {
        kind: []const u8,
        schemaVersion: u32,
        id: []const u8,
        target: []const u8,
        launchProtocol: u64,
        entry: []const u8,
        requiredPaths: []const []const u8,
        upstream: @FieldType(index.Entry, "upstream"),
        builderCommit: []const u8,
    };
    const m = std.json.parseFromSliceLeaky(Meta, ctx.a, bytes, .{ .ignore_unknown_fields = true }) catch return error.InvalidBundle;
    if (!std.mem.eql(u8, m.id, e.id) or !std.mem.eql(u8, m.target, host) or m.launchProtocol != select.protocol or meta.entry == null or !meta.ordered()) return error.BundleMismatch;
    if (!std.mem.eql(u8, m.upstream.commit, e.upstream.commit) or !std.mem.eql(u8, m.upstream.version, e.upstream.version) or !std.mem.eql(u8, m.builderCommit, e.builderCommit)) return error.BundleMismatch;
    const expected_entry = if (builtin.os.tag == .windows) "dsh-native.exe" else "dsh-native";
    if (!std.mem.eql(u8, m.entry, expected_entry) or !std.mem.eql(u8, meta.channel.?, e.channel) or !std.mem.eql(u8, meta.commit_time.?, e.upstream.commitTime) or meta.run.? != e.run or meta.attempt.? != e.attempt) return error.BundleMismatch;
    var file = dir.openFile(m.entry, .{}) catch return error.MissingEntry;
    defer file.close();
    const stat = try file.stat();
    if (stat.kind != .file or (builtin.os.tag != .windows and stat.mode & 0o111 == 0)) return error.MissingEntry;
    if (m.requiredPaths.len == 0) return error.MissingRequiredPath;
    for (m.requiredPaths) |path| {
        if (!safeRelative(path)) return error.UnsafeRequiredPath;
        const required = dir.statFile(path) catch return error.MissingRequiredPath;
        if (required.kind != .file and required.kind != .directory) return error.MissingRequiredPath;
    }
    return meta;
}

/// One usage check for replacements, before downloading and again at activation. Missing guards are repairable.
fn idleClaim(parent: std.fs.Dir, name: []const u8, label: []const u8) !?lock.Lock {
    var dir = try parent.openDir(name, .{ .no_follow = true });
    defer dir.close();
    return lock.tryAcquireIn(dir, runtimes.guard_name, .exclusive, false) catch |err| {
        if (err == error.Missing) return null;
        util.warn("cannot replace {s} {s}: {s}; object unchanged, retry after sessions exit", .{ label, name, if (err == error.Busy) "in use" else @errorName(err) });
        return error.UsageReported;
    };
}

pub fn checkIdle(parent: std.fs.Dir, name: []const u8, label: []const u8) !void {
    if (try idleClaim(parent, name, label)) |c| c.release();
}

/// POSIX renames under the claim. Windows must close our guard first: any open descendant blocks retirement.
/// If another session opens its guard before rename, Windows refuses instead of removing a live object.
fn retire(parent: std.fs.Dir, name: []const u8, tmp: std.fs.Dir, retired: []const u8, claim: *?lock.Lock) !void {
    if (builtin.os.tag == .windows) {
        if (claim.*) |c| c.release();
        claim.* = null;
    }
    std.fs.rename(parent, name, tmp, retired) catch |err| {
        if (builtin.os.tag == .windows and err == error.AccessDenied) {
            util.warn("cannot retire {s}: in use or access denied; object unchanged, retry after sessions exit", .{name});
            return error.UsageReported;
        }
        return err;
    };
}

/// Retire relative to validated handles, then release before deleting the retired tree.
pub fn remove(ctx: *const Ctx, parent: std.fs.Dir, name: []const u8, claim: *?lock.Lock) !void {
    var tmp = ctx.ensureDir(&.{"tmp"});
    defer tmp.close();
    const retired = try std.fmt.allocPrint(ctx.a, ".remove-{s}-{x}", .{ name, std.crypto.random.int(u64) });
    try retire(parent, name, tmp, retired, claim);
    if (claim.*) |c| c.release();
    claim.* = null;
    tmp.deleteTree(retired) catch |err| util.warn("removed {s}; leftover tmp/{s} could not be deleted ({s}); run `dsh manager clean`", .{ name, retired, @errorName(err) });
}

// Retain validated parent handles through activation, replacement and cleanup. POSIX exchange
// keeps force reinstall visible; Windows retains the existing retirement/rollback protocol.
pub fn activate(ctx: *const Ctx, tmp: std.fs.Dir, staging: []const u8, parent: std.fs.Dir, dest: []const u8, backup: []const u8, exists: bool) !void {
    if (!exists) return std.fs.rename(tmp, staging, parent, dest);
    var current = try parent.openDir(dest, .{ .no_follow = true });
    var current_open = true;
    defer if (current_open) current.close();
    if ((try current.stat()).kind != .directory) return error.RuntimeDirectoryConflict;
    var claim = try idleClaim(parent, dest, "runtime/addon");
    defer if (claim) |l| l.release();
    if (builtin.os.tag == .linux) {
        const src_z = try ctx.a.dupeZ(u8, staging);
        const dst_z = try ctx.a.dupeZ(u8, dest);
        const result = std.os.linux.renameat2(tmp.fd, src_z, parent.fd, dst_z, 2);
        if (std.posix.errno(result) != .SUCCESS) return error.AtomicReplacementFailed;
        return;
    }
    if (builtin.os.tag == .macos) {
        const src_z = try ctx.a.dupeZ(u8, staging);
        const dst_z = try ctx.a.dupeZ(u8, dest);
        if (renameatx_np(tmp.fd, src_z, parent.fd, dst_z, 2) != 0) return error.AtomicReplacementFailed;
        return;
    }
    // Windows requires both the directory and our descendant guard handles closed before retirement.
    current.close();
    current_open = false;
    if (existsIn(tmp, backup)) try tmp.deleteTree(backup);
    try retire(parent, dest, tmp, backup, &claim);
    std.fs.rename(tmp, staging, parent, dest) catch |err| {
        std.fs.rename(tmp, backup, parent, dest) catch return error.RestoreFailed;
        return err;
    };
    if (claim) |l| l.release();
    claim = null; // POSIX replacements retain the claim; Windows retirement already released it.
    tmp.deleteTree(backup) catch |err| util.warn("replacement {s} is active; leftover tmp/{s} could not be deleted ({s}); run `dsh manager clean`", .{ dest, backup, @errorName(err) });
}
extern "c" fn renameatx_np(c_int, [*:0]const u8, c_int, [*:0]const u8, c_uint) c_int;
