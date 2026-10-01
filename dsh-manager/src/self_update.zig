//! Self-update discovery/validation and atomic POSIX replacement; Windows helper belongs to 7.3.
const std = @import("std");
const builtin = @import("builtin");
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
        util.warn("manager self-update failed: {s}; installed entry remains complete and application data unchanged", .{@errorName(err)});
        return 1;
    };
    return 0;
}
fn prepare(ctx: *Ctx, force: bool) !void {
    // Pin this installation before the first network wait; no later path resolution selects a target.
    var parent = try std.fs.cwd().openDir(ctx.dir, .{ .iterate = true, .no_follow = true });
    defer parent.close();
    const installed: ?std.fs.File = if (builtin.os.tag == .windows) null else try binary.validated(ctx.a, parent, std.fs.path.basename(ctx.exe), options.version);
    defer if (installed) |f| f.close();
    if (installed) |f| try runningEntry(ctx, f);
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
    try sameParent(ctx, parent);
    ctx.ensureData();
    const mutex = try state.maintenance(ctx);
    defer mutex.release();
    try sameParent(ctx, parent);
    const name = try std.fmt.allocPrint(ctx.a, "{s}{s}", .{ binary.candidate_prefix, candidate.entry.version });
    // A conflicting user file/link is not ours to overwrite.
    try reusable(ctx, parent, name, candidate.entry.version);
    var tmp = ctx.ensureDir(&.{"tmp"});
    defer tmp.close();
    binary.testPause(ctx, "self-update-download", name);
    var archive_digest: [32]u8 = undefined;
    _ = try std.fmt.hexToBytes(&archive_digest, candidate.asset.sha256);
    var trusted = @import("zip.zig").EntryDigest{ .name = binary.executable, .archive_size = candidate.asset.size, .archive_sha256 = archive_digest };
    const staging = try install.fetchTreeHashed(ctx, tmp, candidate.asset, candidate.entry.tag, &trusted);
    const expected = trusted.value orelse return error.MissingManagerEntry;
    defer tmp.deleteTree(staging) catch |err| util.warn("leftover tmp/{s}: {s}; run `dsh manager clean`", .{ staging, @errorName(err) });
    var tree = try tmp.openDir(staging, .{ .iterate = true, .no_follow = true });
    defer tree.close();
    var it = tree.iterate();
    const entry = try it.next() orelse return error.MissingManagerEntry;
    if (entry.kind != .file or !std.mem.eql(u8, entry.name, binary.executable) or try it.next() != null) return error.InvalidManagerArchive;
    binary.testPause(ctx, "self-update-verify", name);
    var source = try binary.validated(ctx.a, tree, binary.executable, candidate.entry.version);
    defer source.close();
    if (!std.mem.eql(u8, &(try binary.digest(source)), &expected)) return error.ManagerFileChanged;
    try source.seekTo(0);
    // Copy from a validated private tree into an exclusive file beside the executable. Never execute it.
    const part = try std.fmt.allocPrint(ctx.a, "{s}.part-{x}", .{ name, std.crypto.random.int(u64) });
    var file = try parent.createFile(part, .{ .exclusive = true, .mode = 0o755 });
    var open = true;
    defer if (open) file.close();
    defer parent.deleteFile(part) catch {};
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
    // Remove an existing validated candidate only after checking its identity. Publication never replaces a name.
    const existing = binary.validated(ctx.a, parent, name, candidate.entry.version) catch |err| blk: {
        if (err == error.FileNotFound) break :blk null;
        return err;
    };
    if (existing) |held| {
        defer held.close();
        if (!binary.deleteValidated(ctx, parent, name, held, "candidate-replace-delete")) return error.ManagerFileChanged;
    }
    binary.testPause(ctx, "candidate-publish", part);
    publish(ctx.a, parent, part, name) catch |err| {
        util.warn("cannot publish manager candidate {s}: {s}; existing file unchanged", .{ name, @errorName(err) });
        return err;
    };
    const final = try binary.openRegular(parent, name);
    defer final.close();
    if (!std.mem.eql(u8, &(try binary.digest(final)), &expected)) {
        util.warn("manager candidate {s} changed after validation; not prepared; retained for inspection", .{name});
        return error.ManagerFileChanged;
    }
    var old = parent.iterate();
    while (try old.next()) |item| {
        if (item.kind != .file or std.mem.eql(u8, item.name, name)) continue;
        const old_version = binary.candidateVersion(item.name) orelse continue;
        const held = binary.validated(ctx.a, parent, item.name, old_version) catch continue;
        defer held.close();
        _ = binary.deleteValidated(ctx, parent, item.name, held, "candidate-old-delete");
    }
    if (builtin.os.tag == .windows) {
        util.print("Manager {s} prepared, not installed: {s}/{s}; installed manager remains {s}.\n", .{ candidate.entry.version, ctx.dir, name, options.version });
    } else {
        try replace(ctx, parent, installed.?, name, candidate.entry.version, expected);
        util.print("updated manager {s} -> {s}\n", .{ options.version, candidate.entry.version });
    }
}

/// Candidate and resolved entry share this retained parent: rename never exposes a partial entry.
fn replace(ctx: *const Ctx, parent: std.fs.Dir, installed: std.fs.File, name: []const u8, version: []const u8, expected: [32]u8) !void {
    if (builtin.os.tag == .windows) unreachable;
    const entry = std.fs.path.basename(ctx.exe);
    const original = try std.posix.fstat(installed.handle);
    binary.testPause(ctx, "self-update-before-replace", name);
    const candidate = try binary.validated(ctx.a, parent, name, version);
    defer candidate.close();
    if (!std.mem.eql(u8, &(try binary.digest(candidate)), &expected)) return error.ManagerFileChanged;
    const current = try std.posix.fstat(candidate.handle);
    if (current.uid != original.uid or current.gid != original.gid) try candidate.chown(original.uid, original.gid);
    try candidate.chmod(original.mode & 0o7777);
    try candidate.sync();
    try sameParent(ctx, parent);
    if (!binary.sameFile(parent, name, candidate) or !binary.sameFile(parent, entry, installed)) return error.ManagerFileChanged;
    // ponytail: same-user identity-check -> rename window; private bin directory if stronger isolation is needed.
    try parent.rename(name, entry);
    binary.testPause(ctx, "self-update-after-replace", entry);
}

fn runningEntry(ctx: *const Ctx, installed: std.fs.File) !void {
    if (builtin.os.tag == .windows) return;
    const entry = try std.posix.fstat(installed.handle);
    if (builtin.os.tag == .linux) {
        const running = try std.fs.cwd().openFile("/proc/self/exe", .{});
        defer running.close();
        const actual = try std.posix.fstat(running.handle);
        if (entry.dev != actual.dev or entry.ino != actual.ino) return error.ManagerFileChanged;
    } else {
        const actual = ctx.exe_identity orelse return error.ManagerFileChanged;
        if (entry.dev != actual.device or entry.ino != actual.inode) return error.ManagerFileChanged;
    }
}

/// An ancestor move/link during I/O is a clear refusal, never a reason to select another installation.
fn sameParent(ctx: *const Ctx, held: std.fs.Dir) !void {
    if (builtin.os.tag == .windows) return;
    const opened = try std.posix.fstat(held.fd);
    const current = std.posix.fstatat(std.posix.AT.FDCWD, ctx.dir, 0) catch return error.ManagerFileChanged;
    if (opened.dev != current.dev or opened.ino != current.ino) return error.ManagerFileChanged;
}

fn reusable(ctx: *const Ctx, parent: std.fs.Dir, name: []const u8, version: []const u8) !void {
    const file = binary.openRegular(parent, name) catch |err| {
        if (err == error.FileNotFound) return;
        return err;
    };
    file.close();
    try binary.validate(ctx.a, parent, name, version);
}

/// Handle-relative no-replace publication. Existing names, even links, are never overwritten.
fn publish(a: std.mem.Allocator, parent: std.fs.Dir, part: []const u8, name: []const u8) !void {
    if (builtin.os.tag == .windows) {
        const win = std.os.windows;
        const src = try win.sliceToPrefixedFileW(parent.fd, part);
        const dst = try win.sliceToPrefixedFileW(parent.fd, name);
        return std.posix.renameatW(parent.fd, src.span(), parent.fd, dst.span(), win.FALSE);
    }
    const src = try a.dupeZ(u8, part);
    const dst = try a.dupeZ(u8, name);
    if (builtin.os.tag == .linux) {
        switch (std.posix.errno(std.os.linux.renameat2(parent.fd, src, parent.fd, dst, 1))) {
            .SUCCESS => return,
            .EXIST => return error.PathAlreadyExists,
            .NOSYS, .INVAL => {}, // Older kernels/filesystems: link creates the final name exclusively.
            else => return error.CandidatePublishFailed,
        }
    } else if (builtin.os.tag == .macos) {
        if (renameatx_np(parent.fd, src, parent.fd, dst, 4) == 0) return; // RENAME_EXCL
        return error.CandidatePublishFailed;
    }
    try std.posix.linkat(parent.fd, part, parent.fd, name, 0);
    try parent.deleteFile(part);
}
extern "c" fn renameatx_np(c_int, [*:0]const u8, c_int, [*:0]const u8, c_uint) c_int;
