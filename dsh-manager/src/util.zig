//! Small process-level helpers shared by the manager modules: diagnostics, output and JSON files.
const std = @import("std");

/// A user-facing failure: one `dsh: ...` line on stderr, exit status 1.
pub fn fatal(comptime fmt: []const u8, args: anytype) noreturn {
    var buf: [8192]u8 = undefined;
    const msg = std.fmt.bufPrint(&buf, "dsh: " ++ fmt ++ "\n", args) catch "dsh: error\n";
    std.fs.File.stderr().writeAll(msg) catch {};
    std.process.exit(1);
}

pub fn oom() noreturn {
    fatal("out of memory", .{});
}

var out_buf: [16384]u8 = undefined;
var out_writer: ?std.fs.File.Writer = null;

/// Buffered stdout; `flush` before exiting.
pub fn stdout() *std.Io.Writer {
    if (out_writer == null) out_writer = std.fs.File.stdout().writer(&out_buf);
    return &out_writer.?.interface;
}

pub fn print(comptime fmt: []const u8, args: anytype) void {
    stdout().print(fmt, args) catch {};
}

pub fn flush() void {
    if (out_writer) |*w| w.interface.flush() catch {};
}

pub fn warn(comptime fmt: []const u8, args: anytype) void {
    var buf: [8192]u8 = undefined;
    const msg = std.fmt.bufPrint(&buf, "dsh: " ++ fmt ++ "\n", args) catch return;
    std.fs.File.stderr().writeAll(msg) catch {};
}

/// Parsed JSON object from a file; null when missing. `error.Invalid` when unreadable or not an object.
pub fn readJsonObject(a: std.mem.Allocator, path: []const u8) error{Invalid}!?std.json.ObjectMap {
    const bytes = std.fs.cwd().readFileAlloc(a, path, 16 << 20) catch |err| switch (err) {
        error.FileNotFound => return null,
        else => return error.Invalid,
    };
    const v = std.json.parseFromSliceLeaky(std.json.Value, a, bytes, .{}) catch return error.Invalid;
    if (v != .object) return error.Invalid;
    return v.object;
}

pub fn exists(path: []const u8) bool {
    std.fs.cwd().access(path, .{}) catch return false;
    return true;
}

pub fn join(a: std.mem.Allocator, parts: []const []const u8) []u8 {
    return std.fs.path.join(a, parts) catch oom();
}
