//! Manager candidate identity: fixed build markers and native executable headers, never execute a download.
const std = @import("std");
const builtin = @import("builtin");
const options = @import("build_options");
const protocol = @import("select.zig").protocol;
pub const version_marker = "DSH_MANAGER_VERSION=" ++ options.version ++ "\x00";
pub const protocol_marker = "DSH_MANAGER_LAUNCH_PROTOCOL=" ++ std.fmt.comptimePrint("{d}", .{protocol}) ++ "\x00";
pub const candidate_prefix = ".dsh-manager-candidate-";
pub const executable = if (builtin.os.tag == .windows) "dsh.exe" else "dsh";

pub fn host() ![]const u8 {
    return switch (builtin.os.tag) {
        .linux => switch (builtin.cpu.arch) {
            .x86_64 => "linux-x64",
            .aarch64 => "linux-arm64",
            else => error.UnsupportedHost,
        },
        .macos => switch (builtin.cpu.arch) {
            .x86_64 => "darwin-x64",
            .aarch64 => "darwin-arm64",
            else => error.UnsupportedHost,
        },
        .windows => switch (builtin.cpu.arch) {
            .x86_64 => "windows-x64",
            .aarch64 => "windows-arm64",
            else => error.UnsupportedHost,
        },
        else => error.UnsupportedHost,
    };
}
fn word(bytes: []const u8, at: usize) u16 {
    return std.mem.readInt(u16, bytes[at..][0..2], .little);
}
fn dword(bytes: []const u8, at: usize) u32 {
    return std.mem.readInt(u32, bytes[at..][0..4], .little);
}
fn native(bytes: []const u8) bool {
    if (bytes.len < 64) return false;
    switch (builtin.os.tag) {
        .linux => return std.mem.eql(u8, bytes[0..4], "\x7fELF") and bytes[4] == 2 and bytes[5] == 1 and
            (word(bytes, 16) == 2 or word(bytes, 16) == 3) and word(bytes, 18) == @as(u16, if (builtin.cpu.arch == .x86_64) 62 else 183),
        .windows => {
            if (!std.mem.eql(u8, bytes[0..2], "MZ")) return false;
            const at: usize = dword(bytes, 60);
            if (at > bytes.len - 26) return false;
            return std.mem.eql(u8, bytes[at..][0..4], "PE\x00\x00") and word(bytes, at + 4) == @as(u16, if (builtin.cpu.arch == .x86_64) 0x8664 else 0xaa64) and word(bytes, at + 24) == 0x20b;
        },
        .macos => return dword(bytes, 0) == 0xfeedfacf and dword(bytes, 4) == @as(u32, if (builtin.cpu.arch == .x86_64) 0x01000007 else 0x0100000c) and dword(bytes, 12) == 2,
        else => return false,
    }
}

/// Open the final component itself, never a symlink/junction or a special file.
pub fn openRegular(dir: std.fs.Dir, name: []const u8) !std.fs.File {
    const file: std.fs.File = if (builtin.os.tag == .windows) blk: {
        const win = std.os.windows;
        const path = try win.sliceToPrefixedFileW(dir.fd, name);
        break :blk .{ .handle = try win.OpenFile(path.span(), .{ .dir = dir.fd, .access_mask = win.GENERIC_READ, .creation = win.FILE_OPEN, .filter = .any, .follow_symlinks = false }) };
    } else .{ .handle = try std.posix.openat(dir.fd, name, .{ .ACCMODE = .RDONLY, .NOFOLLOW = true, .NONBLOCK = true }, 0) };
    errdefer file.close();
    const stat = try file.stat();
    if (stat.kind != .file) return error.InvalidManagerFile;
    if (builtin.os.tag == .windows) {
        // OpenFile(follow_symlinks=false) omits FILE_SYNCHRONOUS_IO_NONALERT.
        // File.read passes no OVERLAPPED, so reopen synchronously and verify the same file index.
        const readable = try dir.openFile(name, .{});
        const current = readable.stat() catch |err| {
            readable.close();
            return err;
        };
        if (current.kind != .file or current.inode != stat.inode) {
            readable.close();
            return error.ManagerFileChanged;
        }
        file.close();
        return readable;
    }
    return file;
}
pub fn validate(a: std.mem.Allocator, dir: std.fs.Dir, name: []const u8, version: []const u8) !void {
    _ = std.SemanticVersion.parse(version) catch return error.InvalidManagerVersion;
    var file = try openRegular(dir, name);
    defer file.close();
    const st = try file.stat();
    if (builtin.os.tag != .windows and st.mode & 0o111 == 0) return error.ManagerNotExecutable;
    const bytes = try file.readToEndAlloc(a, 128 << 20);
    defer a.free(bytes);
    if (!native(bytes)) return error.WrongManagerTarget;
    const marker = try std.fmt.allocPrint(a, "DSH_MANAGER_VERSION={s}\x00", .{version});
    defer a.free(marker);
    if (std.mem.indexOf(u8, bytes, marker) == null) return error.ManagerVersionMismatch;
    if (std.mem.indexOf(u8, bytes, protocol_marker) == null) return error.ManagerProtocolMismatch;
}
/// Deterministic race barrier; production ignores both variables.
pub fn testPause(ctx: *const @import("context.zig").Ctx, stage: []const u8, name: []const u8) void {
    if (!std.mem.eql(u8, ctx.env.get("DSH_MANAGER_TEST") orelse "", "1") or
        !std.mem.eql(u8, ctx.env.get("DSH_MANAGER_TEST_PAUSE") orelse "", stage)) return;
    @import("util.zig").warn("test pause: {s} {s}", .{ stage, name });
    var byte: [1]u8 = undefined;
    if ((std.fs.File.stdin().read(&byte) catch 0) == 0) std.process.exit(1);
}

pub fn candidateVersion(name: []const u8) ?[]const u8 {
    if (!std.mem.startsWith(u8, name, candidate_prefix)) return null;
    const version = name[candidate_prefix.len..];
    if (name.len > 255) return null;
    _ = std.SemanticVersion.parse(version) catch return null;
    return version;
}

pub fn partialCandidate(name: []const u8) bool {
    const at = std.mem.lastIndexOf(u8, name, ".part-") orelse return false;
    if (candidateVersion(name[0..at]) == null) return false;
    const nonce = name[at + 6 ..];
    if (nonce.len == 0 or nonce.len > 16) return false;
    for (nonce) |c| if (!std.ascii.isHex(c)) return false;
    return true;
}

/// Only exact complete candidates or an exclusive-write partial name belong to self-update.
pub fn reclaimable(a: std.mem.Allocator, dir: std.fs.Dir, name: []const u8) bool {
    // A prerelease partial name is itself parseable SemVer (rc.1.part-ab12); classify it first.
    if (partialCandidate(name)) {
        const file = openRegular(dir, name) catch return false;
        file.close();
        return true;
    }
    const v = candidateVersion(name) orelse return false;
    validate(a, dir, name, v) catch return false;
    return true;
}

test "MC-SELF-ONLY regular candidate handles support synchronous reads and refuse directories" {
    const t = std.testing;
    var tmp = t.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(.{ .sub_path = "candidate", .data = "manager bytes" });
    const file = try openRegular(tmp.dir, "candidate");
    defer file.close();
    const bytes = try file.readToEndAlloc(t.allocator, 64);
    defer t.allocator.free(bytes);
    try t.expectEqualStrings("manager bytes", bytes);
    try tmp.dir.makeDir("directory");
    try t.expectError(error.InvalidManagerFile, openRegular(tmp.dir, "directory"));
}
