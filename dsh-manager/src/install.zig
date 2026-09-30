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

pub fn run(ctx: *Ctx, args: []const []const u8) u8 {
    var query: ?[]const u8 = null;
    var channel: ?[]const u8 = null;
    var force = false;
    var n: usize = 0;
    while (n < args.len) : (n += 1) {
        const arg = args[n];
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
    if (query == null) return usage();
    ctx.ensureData();
    var state_dir = ctx.ensureDir(&.{"state"});
    state_dir.close();
    const mutex = lock.tryAcquire(ctx.path(&.{ "state", "manager.lock" }), .exclusive, true) catch |err| {
        util.warn("cannot acquire maintenance lock {s}: {s}; retry when the other manager operation finishes", .{ ctx.path(&.{ "state", "manager.lock" }), @errorName(err) });
        return 1;
    };
    defer mutex.release();
    perform(ctx, query.?, channel orelse state.channel(ctx), force) catch |err| {
        util.warn("runtime install failed: {s}; no selection was changed", .{@errorName(err)});
        return 1;
    };
    return 0;
}

fn usage() u8 {
    util.warn("usage: dsh manager install <version|tag|prefix|latest> [--channel <release|live>] [--force]", .{});
    return 1;
}

fn perform(ctx: *Ctx, query: []const u8, channel: []const u8, force: bool) !void {
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
    const backup = ctx.path(&.{ "tmp", try std.fmt.allocPrint(ctx.a, ".previous-{s}", .{e.id}) });
    // Windows cannot atomically replace a nonempty directory. Restore an interrupted retirement
    // on the next explicit install, under the maintenance lock; never delete the only generation.
    if (!util.exists(dest) and util.exists(backup)) try std.fs.cwd().rename(backup, dest);
    const exists = util.exists(dest);
    if (exists and !force) {
        if (runtimes.check(ctx, runtimes.list(ctx), e.id) != .ok) return error.IncompleteRuntimeUseForce;
        _ = snapshot.prepare(ctx, e.id, e.bundle().meta.?);
        util.print("dsh {s} is already installed.\n", .{e.id});
        return;
    }
    var cache = ctx.ensureDir(&.{ "cache", "downloads" });
    defer cache.close();
    const archive = ctx.path(&.{ "cache", "downloads", try std.fmt.allocPrint(ctx.a, "{s}.zip", .{candidate.asset.sha256}) });
    const url = try std.fmt.allocPrint(ctx.a, "{s}/{s}/{s}", .{ endpoints.download_base, e.tag, candidate.asset.name });
    var digest: [32]u8 = undefined;
    _ = try std.fmt.hexToBytes(&digest, candidate.asset.sha256);
    try http.download(ctx.a, &ctx.env, url, archive, .{ .size = candidate.asset.size, .sha256 = digest }, null);
    const staging = ctx.path(&.{ "tmp", try std.fmt.allocPrint(ctx.a, ".install-{x}", .{std.crypto.random.int(u64)}) });
    try std.fs.cwd().makeDir(staging);
    defer std.fs.cwd().deleteTree(staging) catch {};
    try zip.extract(ctx.a, archive, staging);
    const meta = try validate(ctx, staging, e, host);
    var dir = try std.fs.cwd().openDir(staging, .{});
    const installed_meta = try std.json.Stringify.valueAlloc(ctx.a, .{ .kind = "dsh-runtime-install", .schema = @as(u32, 1), .id = e.id, .target = host, .tag = e.tag, .asset = candidate.asset, .seq = e.seq }, .{});
    try dir.writeFile(.{ .sub_path = ".dsh-install.json", .data = installed_meta });
    try dir.writeFile(.{ .sub_path = runtimes.guard_name, .data = "" });
    dir.close(); // No open directory/file handles at Windows activation.
    crashPoint(ctx, "before-activation");
    try activate(ctx, staging, dest, backup, exists);
    crashPoint(ctx, "after-activation");
    _ = snapshot.prepare(ctx, e.id, meta);
    util.print("Installed dsh {s} ({s}); selection unchanged.\n", .{ e.id, host });
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
    while (parts.next()) |p| if (!index.component(p)) return false;
    return true;
}

fn validate(ctx: *const Ctx, staging: []const u8, e: index.Entry, host: []const u8) !select.Meta {
    var dir = try std.fs.cwd().openDir(staging, .{});
    defer dir.close();
    // Old outer install trees and coupled protocol fields are never adopted.
    if (util.exists(util.join(ctx.a, &.{ staging, "bundles" }))) return error.LegacyBundle;
    const bytes = try dir.readFileAlloc(ctx.a, "bundle.json", 1 << 20);
    const meta = select.parseMeta(ctx.a, bytes) orelse return error.InvalidBundle;
    const root = try std.json.parseFromSliceLeaky(std.json.Value, ctx.a, bytes, .{});
    if (root != .object or root.object.contains("launcherProtocol") or meta.format != .runtime_v1) return error.LegacyBundle;
    const Meta = struct { kind: []const u8, schemaVersion: u32, id: []const u8, target: []const u8, launchProtocol: u64, entry: []const u8, requiredPaths: []const []const u8 };
    const m = std.json.parseFromSliceLeaky(Meta, ctx.a, bytes, .{ .ignore_unknown_fields = true }) catch return error.InvalidBundle;
    if (!std.mem.eql(u8, m.id, e.id) or !std.mem.eql(u8, m.target, host) or m.launchProtocol != select.protocol or meta.entry == null or !meta.ordered()) return error.BundleMismatch;
    const expected_entry = if (builtin.os.tag == .windows) "dsh-native.exe" else "dsh-native";
    if (!std.mem.eql(u8, m.entry, expected_entry) or !std.mem.eql(u8, meta.channel.?, e.channel) or !std.mem.eql(u8, meta.commit_time.?, e.upstream.commitTime) or meta.run.? != e.run or meta.attempt.? != e.attempt) return error.BundleMismatch;
    var file = dir.openFile(m.entry, .{}) catch return error.MissingEntry;
    defer file.close();
    const stat = try file.stat();
    if (stat.kind != .file or (builtin.os.tag != .windows and stat.mode & 0o111 == 0)) return error.MissingEntry;
    if (m.requiredPaths.len == 0) return error.MissingRequiredPath;
    for (m.requiredPaths) |path| {
        if (!safeRelative(path)) return error.UnsafeRequiredPath;
        dir.access(path, .{}) catch return error.MissingRequiredPath;
    }
    return meta;
}

// POSIX exchange keeps a force reinstall continuously visible; Windows uses validated
// retirement + rename, with rollback on error and the backup recovery above on process death.
fn activate(ctx: *const Ctx, staging: []const u8, dest: []const u8, backup: []const u8, exists: bool) !void {
    if (!exists) return std.fs.cwd().rename(staging, dest);
    const guard = util.join(ctx.a, &.{ dest, runtimes.guard_name });
    var claim: ?lock.Lock = lock.tryAcquire(guard, .exclusive, false) catch |err| switch (err) {
        error.Missing => null,
        else => return error.RuntimeInUse,
    };
    defer if (claim) |l| l.release();
    if (builtin.os.tag == .linux) {
        const src_z = try ctx.a.dupeZ(u8, staging);
        const dst_z = try ctx.a.dupeZ(u8, dest);
        const result = std.os.linux.renameat2(std.posix.AT.FDCWD, src_z, std.posix.AT.FDCWD, dst_z, 2);
        if (std.posix.errno(result) != .SUCCESS) return error.AtomicReplacementFailed;
        return;
    }
    if (builtin.os.tag == .macos) {
        const src_z = try ctx.a.dupeZ(u8, staging);
        const dst_z = try ctx.a.dupeZ(u8, dest);
        if (renamex_np(src_z, dst_z, 2) != 0) return error.AtomicReplacementFailed;
        return;
    }
    if (claim) |l| { l.release(); claim = null; } // Windows rename refuses our own guard handle too.
    if (util.exists(backup)) try std.fs.cwd().deleteTree(backup);
    try std.fs.cwd().rename(dest, backup);
    std.fs.cwd().rename(staging, dest) catch |err| {
        std.fs.cwd().rename(backup, dest) catch return error.RestoreFailed;
        return err;
    };
    std.fs.cwd().deleteTree(backup) catch {}; // Valid new generation is already active; clean is task 6.6.
}
extern "c" fn renamex_np([*:0]const u8, [*:0]const u8, c_uint) c_int;
