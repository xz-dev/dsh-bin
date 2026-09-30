//! Install context (D2): resolve real executable, explicit package ownership, data root and app home once.
//! Reads create nothing. First write may claim only an absent/empty data root (D10).
const std = @import("std");
const builtin = @import("builtin");
const util = @import("util.zig");

pub const is_windows = builtin.os.tag == .windows;
pub const data_dir_name = "dsh-bin";
pub const data_marker = ".dsh-bin-data.json";

pub const Ctx = struct {
    a: std.mem.Allocator,
    env: std.process.EnvMap,
    exe: []const u8,
    dir: []const u8,
    data: []const u8,
    app_home: []const u8,

    pub fn path(self: *const Ctx, parts: []const []const u8) []u8 {
        var all: std.ArrayList([]const u8) = .empty;
        all.append(self.a, self.data) catch util.oom();
        all.appendSlice(self.a, parts) catch util.oom();
        return util.join(self.a, all.items);
    }

    pub fn home(self: *const Ctx) []const u8 {
        return self.app_home;
    }

    /// Check ownership before any stateful operation. Never infer managed mode from a failed write.
    pub fn ensureData(self: *const Ctx) void {
        var dir = std.fs.cwd().openDir(self.data, .{ .iterate = true, .no_follow = true }) catch |err| blk: {
            if (err == error.FileNotFound) {
                std.fs.cwd().makePath(self.data) catch |e| self.writeError(e);
                break :blk std.fs.cwd().openDir(self.data, .{ .iterate = true, .no_follow = true }) catch |e| self.writeError(e);
            }
            if (err == error.NotDir or err == error.SymLinkLoop) self.conflict();
            self.writeError(err);
        };
        defer dir.close();
        const bytes = dir.readFileAlloc(self.a, data_marker, 4096) catch |err| switch (err) {
            error.FileNotFound => null,
            else => self.conflict(),
        };
        if (bytes) |b| {
            const Marker = struct { kind: []const u8, schema: u32 };
            const m = std.json.parseFromSliceLeaky(Marker, self.a, b, .{}) catch self.conflict();
            if (m.schema != 1 or !std.mem.eql(u8, m.kind, "dsh-manager-data")) self.conflict();
        } else {
            var it = dir.iterate();
            if ((it.next() catch |err| self.writeError(err)) != null) self.conflict();
        }
        // A real exclusive write catches Windows ACLs too; POSIX mode bits alone are insufficient.
        const temp = std.fmt.allocPrint(self.a, ".dsh-data-{x}.tmp", .{std.crypto.random.int(u64)}) catch util.oom();
        const file = dir.createFile(temp, .{ .exclusive = true, .mode = 0o600 }) catch |err| self.writeError(err);
        defer dir.deleteFile(temp) catch {};
        if (bytes == null) {
            file.writeAll("{\"kind\":\"dsh-manager-data\",\"schema\":1}\n") catch |err| self.writeError(err);
            file.sync() catch |err| self.writeError(err);
        }
        file.close(); // Close before rename, including Windows.
        if (bytes == null) dir.rename(temp, data_marker) catch |err| self.writeError(err);
    }

    fn conflict(self: *const Ctx) noreturn {
        util.fatal("data root conflict at {s}: expected an empty directory or a valid {s}", .{ self.data, data_marker });
    }

    fn writeError(self: *const Ctx, err: anyerror) noreturn {
        util.fatal("data root {s} is not writable: {s}; no fallback location is used", .{ self.data, @errorName(err) });
    }
};

fn userHome(env: *const std.process.EnvMap) []const u8 {
    const key = if (is_windows) "USERPROFILE" else "HOME";
    const h = env.get(key) orelse util.fatal("{s} is required to resolve user data", .{key});
    if (!std.fs.path.isAbsolute(h)) util.fatal("{s} must be an absolute path", .{key});
    return h;
}

fn appHome(a: std.mem.Allocator, env: *const std.process.EnvMap, data: []const u8) []const u8 {
    if (env.get("DSH_HOME")) |v| if (std.mem.trim(u8, v, " \t\r\n").len > 0) {
        var p = v;
        if (std.mem.eql(u8, v, "~") or std.mem.startsWith(u8, v, "~/") or std.mem.startsWith(u8, v, "~\\")) {
            const h = userHome(env);
            p = if (v.len == 1) h else util.join(a, &.{ h, v[2..] });
        }
        if (std.fs.path.isAbsolute(p)) return std.fs.path.resolve(a, &.{p}) catch util.oom();
        const cwd = std.process.getCwdAlloc(a) catch |err| util.fatal("cannot resolve DSH_HOME={s}: {s}", .{ v, @errorName(err) });
        return std.fs.path.resolve(a, &.{ cwd, p }) catch util.oom();
    };
    return util.join(a, &.{ data, "home" });
}

pub fn init(a: std.mem.Allocator) Ctx {
    const raw = std.fs.selfExePathAlloc(a) catch |err| util.fatal("cannot resolve the manager's own path: {s}", .{@errorName(err)});
    // realpath also handles Windows symlink/reparse-point entries.
    const exe = std.fs.cwd().realpathAlloc(a, raw) catch |err| util.fatal("cannot resolve the manager's real path: {s}", .{@errorName(err)});
    const dir = std.fs.path.dirname(exe) orelse util.fatal("cannot resolve the manager's directory", .{});
    const env = std.process.getEnvMap(a) catch util.oom();
    const data = util.join(a, &.{ dir, data_dir_name });
    return .{ .a = a, .env = env, .exe = exe, .dir = dir, .data = data, .app_home = appHome(a, &env, data) };
}
