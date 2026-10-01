//! Advisory file locks (usage claims and mutexes, design D4/D5): flock on POSIX, LockFileEx on Windows.
//! Both are released by the kernel when the holder dies. POSIX descriptors are opened without O_CLOEXEC,
//! so a shared claim taken before execve stays with the runtime for its lifetime.
const std = @import("std");
const builtin = @import("builtin");
const is_windows = builtin.os.tag == .windows;
const win = std.os.windows;

pub const Mode = enum { shared, exclusive };

extern "kernel32" fn LockFileEx(h: win.HANDLE, flags: win.DWORD, reserved: win.DWORD, low: win.DWORD, high: win.DWORD, ov: *win.OVERLAPPED) callconv(.winapi) win.BOOL;
extern "kernel32" fn UnlockFileEx(h: win.HANDLE, reserved: win.DWORD, low: win.DWORD, high: win.DWORD, ov: *win.OVERLAPPED) callconv(.winapi) win.BOOL;

pub const Lock = struct {
    handle: std.fs.File.Handle,

    pub fn release(self: Lock) void {
        if (is_windows) {
            var ov = std.mem.zeroes(win.OVERLAPPED);
            _ = UnlockFileEx(self.handle, 0, 1, 0, &ov);
            win.CloseHandle(self.handle);
        } else {
            std.posix.flock(self.handle, std.posix.LOCK.UN) catch {};
            std.posix.close(self.handle);
        }
    }
};

pub const Error = error{ Busy, Missing, Failed };

/// Try once, without waiting. `Missing` when the lock file does not exist (and `create` is false).
pub fn tryAcquire(path: []const u8, mode: Mode, create: bool) Error!Lock {
    return tryAcquireIn(std.fs.cwd(), path, mode, create);
}

/// Same lock, rooted at an already validated directory rather than re-resolving ancestors.
pub fn tryAcquireIn(dir: std.fs.Dir, path: []const u8, mode: Mode, create: bool) Error!Lock {
    if (is_windows) {
        const file = (if (create)
            dir.createFile(path, .{ .truncate = false, .read = true })
        else
            dir.openFile(path, .{})) catch |err| return if (err == error.FileNotFound) error.Missing else error.Failed;
        testPause(path, mode);
        var ov = std.mem.zeroes(win.OVERLAPPED);
        const flags: win.DWORD = 1 | (if (mode == .exclusive) @as(win.DWORD, 2) else 0);
        if (LockFileEx(file.handle, flags, 0, 1, 0, &ov) == 0) {
            file.close();
            return error.Busy;
        }
        return checked(dir, path, .{ .handle = file.handle });
    }
    const flags: std.posix.O = .{ .ACCMODE = .RDONLY, .CREAT = create };
    const fd = std.posix.openat(dir.fd, path, flags, 0o644) catch |err| return if (err == error.FileNotFound) error.Missing else error.Failed;
    testPause(path, mode);
    const op: i32 = @as(i32, if (mode == .shared) std.posix.LOCK.SH else std.posix.LOCK.EX) | std.posix.LOCK.NB;
    std.posix.flock(fd, op) catch |err| {
        std.posix.close(fd);
        return if (err == error.WouldBlock) error.Busy else error.Failed;
    };
    return checked(dir, path, .{ .handle = fd });
}

/// The opened inode may have been retired before we took the lock. Never protect one generation and run another.
fn checked(dir: std.fs.Dir, path: []const u8, held: Lock) Error!Lock {
    const opened = (std.fs.File{ .handle = held.handle }).stat() catch {
        held.release();
        return error.Failed;
    };
    const current = dir.statFile(path) catch {
        held.release();
        return error.Busy;
    };
    if (opened.inode != current.inode) {
        held.release();
        return error.Busy;
    }
    return held;
}

/// Test-only barrier between open and flock/LockFileEx; production ignores both variables.
fn testPause(path: []const u8, mode: Mode) void {
    if (mode != .shared) return;
    const a = std.heap.page_allocator;
    const enabled = std.process.getEnvVarOwned(a, "DSH_MANAGER_TEST") catch return;
    defer a.free(enabled);
    if (!std.mem.eql(u8, enabled, "1")) return;
    const target = std.process.getEnvVarOwned(a, "DSH_MANAGER_TEST_CLAIM_PAUSE") catch return;
    defer a.free(target);
    if (!std.mem.eql(u8, target, path)) return;
    @import("util.zig").warn("test pause: claim-open", .{});
    var byte: [1]u8 = undefined;
    if ((std.fs.File.stdin().read(&byte) catch 0) == 0) std.process.exit(1);
}

/// Wait for the lock; `on_wait` is called once when another holder makes us wait.
pub fn acquire(path: []const u8, mode: Mode, create: bool, on_wait: ?*const fn () void) Error!Lock {
    var waited = false;
    while (true) {
        return tryAcquire(path, mode, create) catch |err| switch (err) {
            error.Busy => {
                if (!waited) if (on_wait) |f| f();
                waited = true;
                std.Thread.sleep(50 * std.time.ns_per_ms);
                continue;
            },
            else => err,
        };
    }
}

/// Whether some process holds a claim on `path` (exclusive probe, released at once). A missing file is not in use.
pub fn inUse(path: []const u8) bool {
    const l = tryAcquire(path, .exclusive, false) catch |err| return err == error.Busy;
    l.release();
    return false;
}
