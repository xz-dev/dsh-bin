//! Install context (design D2), resolved once per process: the real manager executable, the install mode,
//! the data root and the application home. No module recomputes these on its own.
const std = @import("std");
const builtin = @import("builtin");
const util = @import("util.zig");

pub const is_windows = builtin.os.tag == .windows;
pub const data_dir_name = "dsh-bin";

pub const Ctx = struct {
    a: std.mem.Allocator,
    env: std.process.EnvMap,
    /// Real path of the manager executable (symlinks resolved).
    exe: []const u8,
    /// Directory holding `exe`.
    dir: []const u8,
    /// Data root: runtimes, snapshots, state, cache, default home.
    data: []const u8,

    pub fn path(self: *const Ctx, parts: []const []const u8) []u8 {
        var all: std.ArrayList([]const u8) = .empty;
        all.append(self.a, self.data) catch util.oom();
        all.appendSlice(self.a, parts) catch util.oom();
        return util.join(self.a, all.items);
    }

    /// The application home: a non-blank `DSH_HOME` (`~` expanded, relative to the cwd), else `<data>/home`.
    pub fn home(self: *const Ctx) []const u8 {
        if (self.env.get("DSH_HOME")) |v| if (std.mem.trim(u8, v, " \t\r\n").len > 0) {
            var p = v;
            if (std.mem.eql(u8, v, "~") or std.mem.startsWith(u8, v, "~/") or std.mem.startsWith(u8, v, "~\\")) {
                const h = self.env.get(if (is_windows) "USERPROFILE" else "HOME") orelse util.fatal("DSH_HOME={s} needs HOME to expand ~", .{v});
                p = if (v.len == 1) h else util.join(self.a, &.{ h, v[2..] });
            }
            if (std.fs.path.isAbsolute(p)) return std.fs.path.resolve(self.a, &.{p}) catch util.oom();
            const cwd = std.process.getCwdAlloc(self.a) catch |err| util.fatal("cannot resolve DSH_HOME={s}: {s}", .{ v, @errorName(err) });
            return std.fs.path.resolve(self.a, &.{ cwd, p }) catch util.oom();
        };
        return self.path(&.{"home"});
    }
};

pub fn init(a: std.mem.Allocator) Ctx {
    // selfExePath resolves /proc/self/exe (Linux) or _NSGetExecutablePath + realpath (macOS), so a
    // `~/.local/bin/dsh -> ~/.config/dsh/dsh` symlink finds the real install.
    const exe = std.fs.selfExePathAlloc(a) catch |err| util.fatal("cannot resolve the manager's own path: {s}", .{@errorName(err)});
    const dir = std.fs.path.dirname(exe) orelse util.fatal("cannot resolve the manager's directory", .{});
    return .{
        .a = a,
        .env = std.process.getEnvMap(a) catch util.oom(),
        .exe = exe,
        .dir = dir,
        .data = util.join(a, &.{ dir, data_dir_name }),
    };
}
