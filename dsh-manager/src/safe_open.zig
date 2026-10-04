//! Descriptor-relative no-follow opens. Fixed Zig 0.15.2 omits FreeBSD EMLINK.
//! Keep that errno at the syscall seam; all other platforms keep their std paths.
const std = @import("std");
const builtin = @import("builtin");
const posix = std.posix;

pub fn openat(dir: posix.fd_t, name: []const u8, flags: posix.O, mode: posix.mode_t) posix.OpenError!posix.fd_t {
    if (builtin.os.tag != .freebsd) return posix.openat(dir, name, flags, mode);
    if (!flags.NOFOLLOW) return posix.openat(dir, name, flags, mode);
    const path = try posix.toPosixPath(name);
    while (true) {
        const rc = posix.system.openat(dir, &path, flags, mode);
        // Capture before any formatting, allocation or second syscall can change errno.
        const err = posix.errno(rc);
        switch (err) {
            .SUCCESS => return @intCast(rc),
            .INTR => continue,
            .MLINK, .LOOP => return error.SymLinkLoop,
            // Remaining cases match std.posix.openatZ in the pinned Zig version.
            .FAULT, .BADF => unreachable,
            .INVAL => return error.BadPathName,
            .ACCES => return error.AccessDenied,
            .FBIG, .OVERFLOW => return error.FileTooBig,
            .ISDIR => return error.IsDir,
            .MFILE => return error.ProcessFdQuotaExceeded,
            .NAMETOOLONG => return error.NameTooLong,
            .NFILE => return error.SystemFdQuotaExceeded,
            .NODEV, .NXIO => return error.NoDevice,
            .NOENT => return error.FileNotFound,
            .SRCH => return error.ProcessNotFound,
            .NOMEM => return error.SystemResources,
            .NOSPC => return error.NoSpaceLeft,
            .NOTDIR => return error.NotDir,
            .PERM => return error.PermissionDenied,
            .EXIST => return error.PathAlreadyExists,
            .BUSY => return error.DeviceBusy,
            .OPNOTSUPP => return error.FileLocksNotSupported,
            .AGAIN => return error.WouldBlock,
            .TXTBSY => return error.FileBusy,
            else => return posix.unexpectedErrno(err),
        }
    }
}

pub fn openDir(dir: std.fs.Dir, name: []const u8, options: std.fs.Dir.OpenOptions) !std.fs.Dir {
    if (builtin.os.tag != .freebsd) return dir.openDir(name, options);
    if (!options.no_follow) return dir.openDir(name, options);
    // Same flags as std.fs.Dir.openDirZ, including O_PATH for non-iterable handles.
    var flags: posix.O = .{ .ACCMODE = .RDONLY, .NOFOLLOW = true, .DIRECTORY = true, .CLOEXEC = true };
    if (!options.iterate) flags.PATH = true;
    return .{ .fd = try openat(dir.fd, name, flags, 0) };
}

test "FBSD-NOFOLLOW final links fail at open; retained parent and ordinary errors survive" {
    if (builtin.os.tag == .windows) return error.SkipZigTest; // POSIX seam; Windows negatives remain in manager_binary.
    const t = std.testing;
    var tmp = t.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();
    try tmp.dir.makeDir("outside");
    try tmp.dir.writeFile(.{ .sub_path = "outside/sentinel", .data = "outside untouched" });
    try tmp.dir.writeFile(.{ .sub_path = "regular", .data = "regular bytes" });
    try tmp.dir.symLink("outside", "dir-link", .{ .is_directory = true });
    try tmp.dir.symLink("outside/sentinel", "file-link", .{});
    try tmp.dir.symLink("missing", "broken", .{});
    try tmp.dir.symLink("loop", "loop", .{});
    const flags: posix.O = .{ .ACCMODE = .RDONLY, .NOFOLLOW = true, .NONBLOCK = true };
    for ([_][]const u8{ "dir-link", "file-link", "broken", "loop" }) |name| {
        const file = openat(tmp.dir.fd, name, flags, 0);
        try t.expectError(error.SymLinkLoop, file);
        // O_DIRECTORY may report ENOTDIR instead of ELOOP on other POSIX hosts.
        if (openDir(tmp.dir, name, .{ .iterate = true, .no_follow = true })) |opened| {
            var invalid = opened;
            invalid.close();
            return error.TestUnexpectedResult;
        } else |err| try t.expect(err == error.SymLinkLoop or err == error.NotDir);
    }
    try t.expectError(error.FileNotFound, openat(tmp.dir.fd, "missing", flags, 0));
    try t.expectError(error.FileNotFound, openDir(tmp.dir, "missing", .{ .iterate = true, .no_follow = true }));
    try t.expectError(error.NotDir, openat(tmp.dir.fd, "regular/child", flags, 0));
    try t.expectError(error.NotDir, openDir(tmp.dir, "regular", .{ .iterate = true, .no_follow = true }));
    const fd = try openat(tmp.dir.fd, "regular", flags, 0);
    const file: std.fs.File = .{ .handle = fd };
    defer file.close();
    const bytes = try file.readToEndAlloc(t.allocator, 64);
    defer t.allocator.free(bytes);
    try t.expectEqualStrings("regular bytes", bytes);
    var held = try openDir(tmp.dir, "outside", .{ .iterate = true, .no_follow = true });
    defer held.close();
    try tmp.dir.rename("outside", "moved");
    try tmp.dir.symLink("moved", "outside", .{ .is_directory = true });
    const sentinel = try held.readFileAlloc(t.allocator, "sentinel", 64);
    defer t.allocator.free(sentinel);
    try t.expectEqualStrings("outside untouched", sentinel);
    try t.expectError(error.SymLinkLoop, openat(tmp.dir.fd, "file-link", flags, 0));
}
