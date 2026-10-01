//! Windows same-program self-update helper. Handles, not argv paths, authorize every mutation.
const std = @import("std");
const builtin = @import("builtin");
const win = std.os.windows;
const binary = @import("manager_binary.zig");
const util = @import("util.zig");
const Ctx = @import("context.zig").Ctx;
const options = @import("build_options");
pub const command = "__manager-self-update-helper";
pub const helper_prefix = ".dsh-manager-helper-";
pub const result_name = "self-update-result.txt";

extern "kernel32" fn GetFileInformationByHandle(win.HANDLE, *win.BY_HANDLE_FILE_INFORMATION) callconv(.winapi) win.BOOL;
extern "kernel32" fn GetProcessId(win.HANDLE) callconv(.winapi) win.DWORD;
extern "kernel32" fn OpenProcess(win.DWORD, win.BOOL, win.DWORD) callconv(.winapi) ?win.HANDLE;
extern "kernel32" fn InitializeProcThreadAttributeList(?*anyopaque, win.DWORD, win.DWORD, *usize) callconv(.winapi) win.BOOL;
extern "kernel32" fn UpdateProcThreadAttribute(*anyopaque, win.DWORD, usize, *anyopaque, usize, ?*anyopaque, ?*usize) callconv(.winapi) win.BOOL;
extern "kernel32" fn DeleteProcThreadAttributeList(*anyopaque) callconv(.winapi) void;
extern "kernel32" fn LockFileEx(win.HANDLE, win.DWORD, win.DWORD, win.DWORD, win.DWORD, *win.OVERLAPPED) callconv(.winapi) win.BOOL;
const Startup = extern struct { info: win.STARTUPINFOW, attributes: *anyopaque };
const Identity = struct { volume: u32, index: u64 };
const Request = struct {
    parent_pid: u32,
    parent: usize,
    dir: usize,
    entry: usize,
    candidate: usize,
    tmp: usize,
    mutex: usize,
    dir_id: Identity,
    entry_id: Identity,
    candidate_id: Identity,
    tmp_id: Identity,
    mutex_id: Identity,
    entry_path: []const u8,
    candidate_name: []const u8,
    data_root: []const u8,
    mode: []const u8 = "portable",
    old: []const u8,
    new: []const u8,
    hash: []const u8,
};
fn handle(value: usize) win.HANDLE {
    return @ptrFromInt(value);
}
fn info(h: win.HANDLE) !win.BY_HANDLE_FILE_INFORMATION {
    var i: win.BY_HANDLE_FILE_INFORMATION = undefined;
    if (GetFileInformationByHandle(h, &i) == 0) return error.InvalidHelperHandle;
    if (i.dwFileAttributes & win.FILE_ATTRIBUTE_REPARSE_POINT != 0) return error.LinkedManagerFile;
    return i;
}
fn identity(h: win.HANDLE) !Identity {
    const i = try info(h);
    return .{ .volume = i.dwVolumeSerialNumber, .index = (@as(u64, i.nFileIndexHigh) << 32) | i.nFileIndexLow };
}
fn equal(a: Identity, b: Identity) bool {
    return a.volume == b.volume and a.index == b.index;
}
fn check(h: win.HANDLE, expected: Identity, directory: bool) !void {
    const i = try info(h);
    if ((i.dwFileAttributes & win.FILE_ATTRIBUTE_DIRECTORY != 0) != directory or (!directory and i.nNumberOfLinks != 1)) return error.InvalidHelperHandle;
    if (!equal(try identity(h), expected)) return error.ManagerFileChanged;
}

/// Synchronous, no-follow handle; candidate denies writes/deletes for the entire handoff.
pub fn openFile(dir: std.fs.Dir, name: []const u8, deleting: bool) !std.fs.File {
    const w = try std.unicode.wtf8ToWtf16LeAlloc(std.heap.page_allocator, name);
    defer std.heap.page_allocator.free(w);
    var nt_name = win.UNICODE_STRING{ .Length = @intCast(w.len * 2), .MaximumLength = @intCast(w.len * 2), .Buffer = w.ptr };
    var attr = win.OBJECT_ATTRIBUTES{ .Length = @sizeOf(win.OBJECT_ATTRIBUTES), .RootDirectory = dir.fd, .Attributes = 0, .ObjectName = &nt_name, .SecurityDescriptor = null, .SecurityQualityOfService = null };
    var h: win.HANDLE = undefined;
    var io: win.IO_STATUS_BLOCK = undefined;
    const rc = win.ntdll.NtCreateFile(&h, win.GENERIC_READ | win.SYNCHRONIZE | (if (deleting) @as(u32, win.DELETE) else 0), &attr, &io, null, win.FILE_ATTRIBUTE_NORMAL, if (deleting) win.FILE_SHARE_READ else win.FILE_SHARE_READ | win.FILE_SHARE_DELETE, win.FILE_OPEN, win.FILE_OPEN_REPARSE_POINT | win.FILE_SYNCHRONOUS_IO_NONALERT | win.FILE_NON_DIRECTORY_FILE, null, 0);
    if (rc != .SUCCESS) return error.ManagerFileUnavailable;
    const file = std.fs.File{ .handle = h };
    errdefer file.close();
    const i = try info(h);
    if (i.dwFileAttributes & win.FILE_ATTRIBUTE_DIRECTORY != 0 or i.nNumberOfLinks != 1) return error.InvalidManagerFile;
    return file;
}

pub fn start(ctx: *Ctx, dir: std.fs.Dir, installed: std.fs.File, name: []const u8, version: []const u8, expected: [32]u8, mutex: std.fs.File.Handle, tmp: std.fs.Dir) !void {
    binary.testPause(ctx, "self-update-before-handoff", name);
    const candidate = try openFile(dir, name, true);
    defer candidate.close();
    try binary.validateFile(ctx.a, candidate, version);
    if (!std.mem.eql(u8, &(try binary.digest(candidate)), &expected) or !binary.sameFile(dir, std.fs.path.basename(ctx.exe), installed)) return error.ManagerFileChanged;
    const helper_name = try std.fmt.allocPrint(ctx.a, "{s}{x}.exe", .{ helper_prefix, std.crypto.random.int(u64) });
    var copy = try dir.createFile(helper_name, .{ .exclusive = true });
    var opened = true;
    defer if (opened) copy.close();
    errdefer dir.deleteFile(helper_name) catch {};
    const original_hash = try binary.digest(installed);
    try installed.seekTo(0);
    var buf: [64 * 1024]u8 = undefined;
    while (true) {
        const n = try installed.read(&buf);
        if (n == 0) break;
        try copy.writeAll(buf[0..n]);
    }
    try copy.sync();
    copy.close();
    opened = false;
    const helper = try openFile(dir, helper_name, true);
    defer helper.close();
    try binary.validateFile(ctx.a, helper, options.version);
    if (!std.mem.eql(u8, &(try binary.digest(helper)), &original_hash)) return error.ManagerFileChanged;
    const parent_process = OpenProcess(win.SYNCHRONIZE | 0x1000, win.FALSE, win.GetCurrentProcessId()) orelse return error.ParentProcessUnavailable;
    defer win.CloseHandle(parent_process);
    const request = Request{
        .parent_pid = win.GetCurrentProcessId(),
        .parent = @intFromPtr(parent_process),
        .dir = @intFromPtr(dir.fd),
        .entry = @intFromPtr(installed.handle),
        .candidate = @intFromPtr(candidate.handle),
        .tmp = @intFromPtr(tmp.fd),
        .mutex = @intFromPtr(mutex),
        .dir_id = try identity(dir.fd),
        .entry_id = try identity(installed.handle),
        .candidate_id = try identity(candidate.handle),
        .tmp_id = try identity(tmp.fd),
        .mutex_id = try identity(mutex),
        .entry_path = ctx.exe,
        .candidate_name = name,
        .data_root = ctx.data,
        .old = options.version,
        .new = version,
        .hash = try std.fmt.allocPrint(ctx.a, "{x}", .{expected}),
    };
    const json = try std.json.Stringify.valueAlloc(ctx.a, request, .{});
    const helper_path = try dir.realpathAlloc(ctx.a, helper_name);
    // Hex avoids any argv interpretation of JSON/path quotes; only the executable needs Windows quoting.
    const payload = try std.fmt.allocPrint(ctx.a, "{x}", .{json});
    const line = try std.unicode.wtf8ToWtf16LeAllocZ(ctx.a, try std.fmt.allocPrint(ctx.a, "\"{s}\" {s} {s}", .{ helper_path, command, payload }));
    const app = try std.unicode.wtf8ToWtf16LeAllocZ(ctx.a, helper_path);
    var handles = [_]win.HANDLE{ parent_process, dir.fd, installed.handle, candidate.handle, tmp.fd, mutex };
    // Only this allowlist is inherited. Standard pipes are deliberately not inherited: parent exit is observable.
    defer for (handles) |h| win.SetHandleInformation(h, win.HANDLE_FLAG_INHERIT, 0) catch {};
    for (handles) |h| try win.SetHandleInformation(h, win.HANDLE_FLAG_INHERIT, win.HANDLE_FLAG_INHERIT);
    var size: usize = 0;
    _ = InitializeProcThreadAttributeList(null, 1, 0, &size);
    const attrs = try ctx.a.alignedAlloc(u8, .fromByteUnits(@alignOf(usize)), size);
    if (InitializeProcThreadAttributeList(attrs.ptr, 1, 0, &size) == 0) return error.HelperSpawnFailed;
    defer DeleteProcThreadAttributeList(attrs.ptr);
    if (UpdateProcThreadAttribute(attrs.ptr, 0, 0x20002, @ptrCast(&handles), @sizeOf(@TypeOf(handles)), null, null) == 0) return error.HelperSpawnFailed;
    var startup: Startup = .{ .info = std.mem.zeroes(win.STARTUPINFOW), .attributes = attrs.ptr };
    startup.info.cb = @sizeOf(Startup);
    var process: win.PROCESS_INFORMATION = undefined;
    // Inherit environment, not location-derived context. Paths are diagnostics only; handles authorize mutations.
    try win.CreateProcessW(app.ptr, line.ptr, null, null, win.TRUE, .{ .extended_startupinfo_present = true, .create_no_window = true }, null, null, &startup.info, &process);
    win.CloseHandle(process.hThread);
    win.CloseHandle(process.hProcess);
    util.print("update handed off to helper; run `dsh manager --version` to confirm\n", .{});
    util.flush();
    pause(ctx.env, "helper-parent", win.GetCurrentProcessId());
}

fn pause(env: std.process.EnvMap, stage: []const u8, pid: u32) void {
    if (!std.mem.eql(u8, env.get("DSH_MANAGER_TEST") orelse "", "1") or !std.mem.eql(u8, env.get("DSH_MANAGER_TEST_HELPER_PAUSE") orelse "", stage)) return;
    const root = env.get("DSH_MANAGER_TEST_HELPER_CONTROL") orelse return;
    const a = std.heap.page_allocator;
    const ready = std.fmt.allocPrint(a, "{s}/{s}.ready", .{ root, stage }) catch return;
    defer a.free(ready);
    const go = std.fmt.allocPrint(a, "{s}/{s}.go", .{ root, stage }) catch return;
    defer a.free(go);
    const value = std.fmt.allocPrint(a, "{d}", .{pid}) catch return;
    defer a.free(value);
    std.fs.cwd().writeFile(.{ .sub_path = ready, .data = value }) catch return;
    // ponytail: bounded test barrier only, not a production retry/recovery loop.
    for (0..3000) |_| {
        std.fs.cwd().access(go, .{}) catch {
            std.Thread.sleep(10 * std.time.ns_per_ms);
            continue;
        };
        return;
    }
    std.process.exit(1);
}

pub fn run(a: std.mem.Allocator, args: []const []const u8) u8 {
    if (builtin.os.tag != .windows) return 1;
    if (args.len != 1) return 1;
    const own = std.fs.selfExePathAlloc(a) catch return 1;
    if (!helperName(std.fs.path.basename(own)) or args[0].len % 2 != 0 or args[0].len > 64 * 1024) return 1;
    const json = a.alloc(u8, args[0].len / 2) catch return 1;
    _ = std.fmt.hexToBytes(json, args[0]) catch return 1;
    const r = std.json.parseFromSliceLeaky(Request, a, json, .{}) catch return 1;
    const tmp = std.fs.Dir{ .fd = handle(r.tmp) };
    check(tmp.fd, r.tmp_id, true) catch return 1;
    check(handle(r.dir), r.dir_id, true) catch return 1;
    check(handle(r.entry), r.entry_id, false) catch return 1;
    check(handle(r.candidate), r.candidate_id, false) catch return 1;
    check(handle(r.mutex), r.mutex_id, false) catch return 1;
    const env = std.process.getEnvMap(a) catch return 1;
    execute(a, r, env) catch |err| {
        writeResult(a, tmp, tryFormat(a, "failed: {s}; installed entry remains complete", .{@errorName(err)})) catch {};
        return 1;
    };
    writeResult(a, tmp, tryFormat(a, "updated {s} -> {s}", .{ r.old, r.new })) catch return 1;
    return 0;
}
fn tryFormat(a: std.mem.Allocator, comptime fmt: []const u8, args: anytype) []const u8 {
    return std.fmt.allocPrint(a, fmt, args) catch "failed: OutOfMemory";
}

fn execute(a: std.mem.Allocator, r: Request, env: std.process.EnvMap) !void {
    if (!std.mem.eql(u8, r.mode, "portable") or !std.fs.path.isAbsolute(r.entry_path) or !std.fs.path.isAbsolute(r.data_root)) return error.InvalidHelperContext;
    const dir = std.fs.Dir{ .fd = handle(r.dir) };
    const installed = std.fs.File{ .handle = handle(r.entry) };
    const candidate = std.fs.File{ .handle = handle(r.candidate) };
    try check(dir.fd, r.dir_id, true);
    try check(installed.handle, r.entry_id, false);
    try check(candidate.handle, r.candidate_id, false);
    try check(handle(r.tmp), r.tmp_id, true);
    try check(handle(r.mutex), r.mutex_id, false);
    const version = binary.candidateVersion(r.candidate_name) orelse return error.InvalidHelperContext;
    if (!std.mem.eql(u8, version, r.new)) return error.InvalidHelperContext;
    if (GetProcessId(handle(r.parent)) != r.parent_pid) return error.InvalidHelperContext;
    pause(env, "helper-before-wait", win.GetCurrentProcessId());
    var timeout: u32 = 60_000;
    if (std.mem.eql(u8, env.get("DSH_MANAGER_TEST") orelse "", "1")) if (env.get("DSH_MANAGER_TEST_HELPER_TIMEOUT_MS")) |v| {
        timeout = try std.fmt.parseInt(u32, v, 10);
    };
    try win.WaitForSingleObject(handle(r.parent), timeout);
    var ov = std.mem.zeroes(win.OVERLAPPED);
    if (LockFileEx(handle(r.mutex), 3, 0, 1, 0, &ov) == 0) return error.MaintenanceBusy;
    pause(env, "helper-before-move", win.GetCurrentProcessId());
    try binary.validateFile(a, candidate, r.new);
    var hash: [32]u8 = undefined;
    _ = try std.fmt.hexToBytes(&hash, r.hash);
    if (!std.mem.eql(u8, &(try binary.digest(candidate)), &hash)) return error.ManagerFileChanged;
    try check(dir.fd, r.dir_id, true);
    if (!binary.sameFile(dir, std.fs.path.basename(r.entry_path), installed) or !binary.sameFile(dir, r.candidate_name, candidate)) return error.ManagerFileChanged;
    // Classic FileRenameInformation cannot retire a target with an outstanding open handle.
    // Parent has exited; release only our checked target handle immediately before the single rename.
    installed.close();
    try renameHandle(a, candidate.handle, dir, std.fs.path.basename(r.entry_path));
    if (!binary.sameFile(dir, std.fs.path.basename(r.entry_path), candidate) or !std.mem.eql(u8, &(try binary.digest(candidate)), &hash)) return error.ManagerFileChanged;
    pause(env, "helper-after-move", win.GetCurrentProcessId());
}

fn renameHandle(a: std.mem.Allocator, file: win.HANDLE, dir: std.fs.Dir, name: []const u8) !void {
    const w = try std.unicode.wtf8ToWtf16LeAlloc(a, name);
    const len = @offsetOf(win.FILE_RENAME_INFORMATION, "FileName") + w.len * 2;
    const bytes = try a.alignedAlloc(u8, .fromByteUnits(@alignOf(win.FILE_RENAME_INFORMATION)), len);
    const data: *win.FILE_RENAME_INFORMATION = @ptrCast(bytes.ptr);
    data.Flags = win.TRUE;
    data.RootDirectory = dir.fd;
    data.FileNameLength = @intCast(w.len * 2);
    @memcpy(bytes[@offsetOf(win.FILE_RENAME_INFORMATION, "FileName")..], std.mem.sliceAsBytes(w));
    var io: win.IO_STATUS_BLOCK = undefined;
    if (win.ntdll.NtSetInformationFile(file, &io, bytes.ptr, @intCast(len), .FileRenameInformation) != .SUCCESS) return error.ManagerReplacementRefused;
}
fn writeResult(a: std.mem.Allocator, tmp: std.fs.Dir, message: []const u8) !void {
    const name = try std.fmt.allocPrint(a, ".self-update-result-{x}.tmp", .{std.crypto.random.int(u64)});
    const file = try tmp.createFile(name, .{ .exclusive = true });
    defer tmp.deleteFile(name) catch {};
    var open = true;
    defer if (open) file.close();
    try file.writeAll(message);
    try file.writeAll("\n");
    try file.sync();
    file.close();
    open = false;
    // No-replace prevents overwriting any preexisting result/user file.
    const src = try win.sliceToPrefixedFileW(tmp.fd, name);
    const dst = try win.sliceToPrefixedFileW(tmp.fd, result_name);
    try std.posix.renameatW(tmp.fd, src.span(), tmp.fd, dst.span(), win.FALSE);
}

pub fn consume(ctx: *const Ctx) void {
    if (builtin.os.tag != .windows) return;
    var root = std.fs.cwd().openDir(ctx.data, .{ .no_follow = true }) catch return;
    defer root.close();
    var tmp = root.openDir("tmp", .{ .no_follow = true }) catch return;
    defer tmp.close();
    const file = binary.openRegular(tmp, result_name) catch return;
    defer file.close();
    const bytes = file.readToEndAlloc(ctx.a, 4096) catch return;
    if (bytes.len > 2048 or !std.mem.endsWith(u8, bytes, "\n") or std.mem.indexOfScalar(u8, bytes[0 .. bytes.len - 1], '\n') != null) return;
    if (std.mem.startsWith(u8, bytes, "updated ")) {
        const arrow = std.mem.indexOf(u8, bytes, " -> ") orelse return;
        _ = std.SemanticVersion.parse(bytes[8..arrow]) catch return;
        _ = std.SemanticVersion.parse(bytes[arrow + 4 .. bytes.len - 1]) catch return;
    } else if (!std.mem.startsWith(u8, bytes, "failed: ")) return;
    if (!binary.sameFile(tmp, result_name, file)) return;
    tmp.deleteFile(result_name) catch return;
    util.warn("self-update result: {s}", .{std.mem.trim(u8, bytes, "\r\n")});
}

pub fn helperName(name: []const u8) bool {
    if (!std.mem.startsWith(u8, name, helper_prefix) or !std.mem.endsWith(u8, name, ".exe")) return false;
    const nonce = name[helper_prefix.len .. name.len - 4];
    if (nonce.len == 0 or nonce.len > 16) return false;
    for (nonce) |c| if (!std.ascii.isHex(c)) return false;
    return true;
}
