//! dsh launcher (design D4). The bundle version and channel are compile-time constants; the launcher runs
//! `<launcher-dir>/bundles/<version>/dsh-native` with the arguments unchanged and returns its exit status.
//! No pointer file is read and there is no fallback version. Before starting the runtime it takes the
//! shared usage claim on `bundles/<version>/.usage.lock`: on POSIX the flock'd descriptor survives execve,
//! on Windows the launcher holds the lock while it waits for the child.
const std = @import("std");
const builtin = @import("builtin");
const options = @import("build_options");

pub const version: []const u8 = options.version;
pub const channel: []const u8 = options.channel;
const is_windows = builtin.os.tag == .windows;
const native_name = if (is_windows) "dsh-native.exe" else "dsh-native";
const guard_name = ".usage.lock";

/// Variables the runtime must not inherit: dsh-tui's standalone self-update markers and Bun's
/// "act as bun" switch (the runtime sets that itself only for its embedded pnpm).
pub const cleared_vars = [_][]const u8{ "DSH_TUI_STANDALONE", "DSH_TUI_STANDALONE_BINARY", "BUN_BE_BUN" };

comptime {
    for (version) |c| {
        if (!(std.ascii.isAlphanumeric(c) or c == '.' or c == '-' or c == '+' or c == '_'))
            @compileError("invalid bundle version");
    }
    if (version.len == 0) @compileError("bundle version is required (-Dversion=)");
    if (!std.mem.eql(u8, channel, "release") and !std.mem.eql(u8, channel, "live"))
        @compileError("channel must be release or live (-Dchannel=)");
}

fn fatal(comptime fmt: []const u8, args: anytype) noreturn {
    var buf: [4096]u8 = undefined;
    const msg = std.fmt.bufPrint(&buf, "dsh: " ++ fmt ++ "\n", args) catch "dsh: launcher error\n";
    std.fs.File.stderr().writeAll(msg) catch {};
    std.process.exit(1);
}

const Paths = struct {
    launcher: []const u8,
    root: []const u8,
    native: []const u8,
    guard: []const u8,
};

fn resolvePaths(allocator: std.mem.Allocator) !Paths {
    // selfExePath resolves /proc/self/exe (Linux) or _NSGetExecutablePath + realpath (macOS), so a
    // `/usr/bin/dsh -> /usr/lib/dsh-bin/dsh` symlink finds the real install root.
    const launcher = try std.fs.selfExePathAlloc(allocator);
    const root = std.fs.path.dirname(launcher) orelse return error.NoLauncherDir;
    return .{
        .launcher = launcher,
        .root = root,
        .native = try std.fs.path.join(allocator, &.{ root, "bundles", version, native_name }),
        .guard = try std.fs.path.join(allocator, &.{ root, "bundles", version, guard_name }),
    };
}

/// The runtime's environment: the parent's, minus `cleared_vars`, plus the DSH_BUNDLE_* contract.
fn runtimeEnv(allocator: std.mem.Allocator, paths: Paths) !std.process.EnvMap {
    var env = try std.process.getEnvMap(allocator);
    for (cleared_vars) |name| env.remove(name);
    try env.put("DSH_BUNDLE_ROOT", paths.root);
    try env.put("DSH_BUNDLE_VERSION", version);
    try env.put("DSH_BUNDLE_LAUNCHER", paths.launcher);
    try env.put("DSH_BUNDLE_CHANNEL", channel);
    return env;
}

// ---------------------------------------------------------------------------------------------- POSIX

/// Shared flock on the guard, inherited across execve (no O_CLOEXEC). A missing guard means the
/// bundle is incomplete; cleanup never retires a bundle it cannot validate, so run without a claim.
/// A busy guard means `dsh update --force` is replacing this version: wait briefly, reopening each try.
fn posixClaim(guard: []const u8) void {
    var attempt: usize = 0;
    while (attempt < 100) : (attempt += 1) {
        const fd = std.posix.open(guard, .{ .ACCMODE = .RDONLY }, 0) catch return;
        std.posix.flock(fd, std.posix.LOCK.SH | std.posix.LOCK.NB) catch |err| switch (err) {
            error.WouldBlock => {
                std.posix.close(fd);
                std.Thread.sleep(100 * std.time.ns_per_ms);
                continue;
            },
            else => {
                std.posix.close(fd);
                return;
            },
        };
        return; // keep fd open: the claim lives as long as the exec'd runtime
    }
    fatal("bundle {s} is being replaced by `dsh update`; try again", .{version});
}

fn runPosix(allocator: std.mem.Allocator, paths: Paths) noreturn {
    std.posix.access(paths.native, std.posix.X_OK) catch
        fatal("bundle runtime not found: {s} (this launcher runs only version {s}; reinstall dsh-bin)", .{ paths.native, version });
    posixClaim(paths.guard);

    var env = runtimeEnv(allocator, paths) catch fatal("out of memory", .{});
    const envp = std.process.createNullDelimitedEnvMap(allocator, &env) catch fatal("out of memory", .{});

    const args = std.os.argv;
    const argv = allocator.allocSentinel(?[*:0]const u8, args.len, null) catch fatal("out of memory", .{});
    const native_z = allocator.dupeZ(u8, paths.native) catch fatal("out of memory", .{});
    argv[0] = native_z.ptr;
    for (args[1..], 1..) |arg, i| argv[i] = arg;

    const err = std.posix.execveZ(native_z.ptr, argv.ptr, envp.ptr);
    fatal("could not execute {s}: {s}", .{ paths.native, @errorName(err) });
}

// -------------------------------------------------------------------------------------------- Windows

const win = std.os.windows;
extern "kernel32" fn LockFileEx(h: win.HANDLE, flags: win.DWORD, reserved: win.DWORD, low: win.DWORD, high: win.DWORD, ov: *win.OVERLAPPED) callconv(.winapi) win.BOOL;
extern "kernel32" fn GetCommandLineW() callconv(.winapi) [*:0]const u16;

/// Shared LockFileEx on the guard, held by the launcher for the child's lifetime. The runtime takes its
/// own shared claim as well, so the bundle stays protected even if the launcher is killed.
fn windowsClaim(guard: []const u8) void {
    var attempt: usize = 0;
    while (attempt < 100) : (attempt += 1) {
        const file = std.fs.openFileAbsolute(guard, .{}) catch return;
        var ov = std.mem.zeroes(win.OVERLAPPED);
        const LOCKFILE_FAIL_IMMEDIATELY: win.DWORD = 1;
        if (LockFileEx(file.handle, LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &ov) != 0) return; // handle stays open
        file.close();
        std.Thread.sleep(100 * std.time.ns_per_ms);
    }
    fatal("bundle {s} is being replaced by `dsh update`; try again", .{version});
}

/// The raw command-line tail after the program name, so the child sees the user's quoting unchanged.
fn commandTail() [*:0]const u16 {
    var p = GetCommandLineW();
    if (p[0] == '"') {
        p += 1;
        while (p[0] != 0 and p[0] != '"') p += 1;
        if (p[0] == '"') p += 1;
    } else {
        while (p[0] != 0 and p[0] != ' ' and p[0] != '\t') p += 1;
    }
    while (p[0] == ' ' or p[0] == '\t') p += 1;
    return p;
}

fn runWindows(allocator: std.mem.Allocator, paths: Paths) noreturn {
    std.fs.accessAbsolute(paths.native, .{}) catch
        fatal("bundle runtime not found: {s} (this launcher runs only version {s}; reinstall dsh-bin)", .{ paths.native, version });
    windowsClaim(paths.guard);

    var env = runtimeEnv(allocator, paths) catch fatal("out of memory", .{});
    const env_block = std.process.createWindowsEnvBlock(allocator, &env) catch fatal("out of memory", .{});
    const native_w = std.unicode.utf8ToUtf16LeAllocZ(allocator, paths.native) catch fatal("invalid path", .{});
    const tail = std.mem.span(commandTail());
    var line = std.ArrayList(u16){};
    line.append(allocator, '"') catch fatal("out of memory", .{});
    line.appendSlice(allocator, native_w) catch fatal("out of memory", .{});
    line.append(allocator, '"') catch fatal("out of memory", .{});
    if (tail.len > 0) {
        line.append(allocator, ' ') catch fatal("out of memory", .{});
        line.appendSlice(allocator, tail) catch fatal("out of memory", .{});
    }
    line.append(allocator, 0) catch fatal("out of memory", .{});

    var startup = std.mem.zeroes(win.STARTUPINFOW);
    startup.cb = @sizeOf(win.STARTUPINFOW);
    startup.dwFlags = win.STARTF_USESTDHANDLES;
    startup.hStdInput = win.GetStdHandle(win.STD_INPUT_HANDLE) catch null;
    startup.hStdOutput = win.GetStdHandle(win.STD_OUTPUT_HANDLE) catch null;
    startup.hStdError = win.GetStdHandle(win.STD_ERROR_HANDLE) catch null;
    var info: win.PROCESS_INFORMATION = undefined;
    win.CreateProcessW(
        native_w.ptr,
        @ptrCast(line.items.ptr),
        null,
        null,
        win.TRUE,
        .{ .create_unicode_environment = true },
        @ptrCast(env_block.ptr),
        null,
        &startup,
        &info,
    ) catch |err| fatal("could not execute {s}: {s}", .{ paths.native, @errorName(err) });
    win.CloseHandle(info.hThread);
    win.WaitForSingleObjectEx(info.hProcess, win.INFINITE, false) catch std.process.exit(1);
    var status: win.DWORD = 1;
    if (win.kernel32.GetExitCodeProcess(info.hProcess, &status) == 0) status = 1;
    std.process.exit(@truncate(status));
}

pub fn main() void {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    const allocator = arena.allocator();
    const paths = resolvePaths(allocator) catch |err| fatal("cannot resolve the launcher path: {s}", .{@errorName(err)});
    if (is_windows) runWindows(allocator, paths) else runPosix(allocator, paths);
}
