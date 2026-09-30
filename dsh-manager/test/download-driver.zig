//! Black-box test adapter; never shipped with the manager. DebugAllocator makes
//! retries, failed reads, endpoint overrides and successful downloads leak-checked.
//! Usage: driver download <url> <dest> <size> <sha256hex> | fetch <url> <max_bytes> | endpoints
const std = @import("std");
const http = @import("http");

pub fn main() u8 {
    var gpa: std.heap.DebugAllocator(.{}) = .init;
    const status = run(gpa.allocator());
    if (gpa.deinit() == .leak) return err("allocation leak");
    return status;
}

fn run(a: std.mem.Allocator) u8 {
    var env = std.process.getEnvMap(a) catch return err("env");
    defer env.deinit();
    const args = std.process.argsAlloc(a) catch return err("args");
    defer std.process.argsFree(a, args);
    if (args.len < 2) return err("usage");

    if (std.mem.eql(u8, args[1], "endpoints")) {
        if (args.len != 2) return err("usage");
        const e = http.endpoints(a, &env);
        defer e.deinit(a);
        std.debug.print("runtime_index={s}\nmanager_index={s}\ndownload_base={s}\n", .{ e.runtime_index, e.manager_index, e.download_base });
        return 0;
    }
    if (std.mem.eql(u8, args[1], "fetch")) {
        if (args.len != 4) return err("usage");
        const max = std.fmt.parseInt(usize, args[3], 10) catch return err("max");
        const body = http.fetchSmall(a, &env, args[2], max) catch |e| return err(@errorName(e));
        defer a.free(body);
        std.debug.print("ok {d} bytes\n", .{body.len});
        return 0;
    }
    if (std.mem.eql(u8, args[1], "download")) {
        if (args.len != 6) return err("usage");
        const size = std.fmt.parseInt(u64, args[4], 10) catch return err("size");
        var hash: [32]u8 = undefined;
        if (args[5].len != 64) return err("sha");
        _ = std.fmt.hexToBytes(&hash, args[5]) catch return err("sha");
        http.download(a, &env, args[2], args[3], .{ .size = size, .sha256 = hash }, reportProgress) catch |e| return err(@errorName(e));
        std.debug.print("ok\n", .{});
        return 0;
    }
    return err("usage");
}

fn reportProgress(done: u64, total: u64) void {
    std.debug.print("progress {d}/{d}\n", .{ done, total });
}

fn err(name: []const u8) u8 {
    std.debug.print("error {s}\n", .{name});
    return 1;
}
