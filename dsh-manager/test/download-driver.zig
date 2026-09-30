//! Test-only driver for `src/http.zig`. Not part of the shipped manager.
//! Usage:
//!   driver download <url> <dest> <size> <sha256hex>
//!   driver fetch    <url> <max_bytes>
//!   driver endpoints
const std = @import("std");
const http = @import("http");

pub fn main() u8 {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const env = std.process.getEnvMap(a) catch return err("env");
    const args = std.process.argsAlloc(a) catch return err("args");
    if (args.len < 2) return err("usage");

    if (std.mem.eql(u8, args[1], "endpoints")) {
        const e = http.endpoints(&env);
        std.debug.print("runtime_index={s}\nmanager_index={s}\ndownload_base={s}\n", .{ e.runtime_index, e.manager_index, e.download_base });
        return 0;
    }

    if (std.mem.eql(u8, args[1], "fetch")) {
        if (args.len != 4) return err("usage");
        const max = std.fmt.parseInt(usize, args[3], 10) catch return err("max");
        const body = http.fetchSmall(a, &env, args[2], max) catch |e| return err(@errorName(e));
        std.debug.print("ok {d} bytes\n", .{body.len});
        return 0;
    }

    if (std.mem.eql(u8, args[1], "download")) {
        if (args.len != 6) return err("usage");
        const size = std.fmt.parseInt(u64, args[4], 10) catch return err("size");
        var sha: [32]u8 = undefined;
        const hex = args[5];
        if (hex.len != 64) return err("sha");
        _ = std.fmt.hexToBytes(&sha, hex) catch return err("sha");
        http.download(a, &env, args[2], args[3], .{ .size = size, .sha256 = sha }, null) catch |e| return err(@errorName(e));
        std.debug.print("ok\n", .{});
        return 0;
    }

    return err("usage");
}

fn err(name: []const u8) u8 {
    std.debug.print("error {s}\n", .{name});
    return 1;
}
