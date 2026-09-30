//! dsh manager (design D1/D4). One standalone program: `dsh manager ...` is the native management
//! namespace; everything else starts the selected dsh runtime with the arguments unchanged.
const std = @import("std");
const builtin = @import("builtin");
const options = @import("build_options");
const util = @import("util.zig");
const context = @import("context.zig");
const launch = @import("launch.zig");
const manager = @import("manager.zig");

pub const version: []const u8 = options.version;

/// Byte-readable marker of the manager version (read without executing the file).
pub const marker = "DSH_MANAGER_VERSION=" ++ version ++ "\x00";

comptime {
    for (version) |c| {
        if (!(std.ascii.isAlphanumeric(c) or c == '.' or c == '-' or c == '+' or c == '_'))
            @compileError("invalid manager version");
    }
    if (version.len == 0) @compileError("manager version is required (-Dversion=)");
}

pub fn main() void {
    std.mem.doNotOptimizeAway(marker.ptr);
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    const a = arena.allocator();
    const args: []const []const u8 = if (context.is_windows) launch.windowsArgs(a) else blk: {
        const raw = std.os.argv;
        const out = a.alloc([]const u8, raw.len - 1) catch util.oom();
        for (raw[1..], out) |arg, *o| o.* = std.mem.span(arg);
        break :blk out;
    };
    var ctx = context.init(a);
    // `manager` is a namespace only as the first argument after the leading options.
    const opts = launch.parseLeading(a, args);
    if (opts.consumed < args.len and std.mem.eql(u8, args[opts.consumed], "manager")) {
        const code = manager.run(&ctx, opts, args[opts.consumed + 1 ..]);
        util.flush();
        std.process.exit(code);
    }
    launch.run(&ctx, args);
}

test {
    _ = @import("select.zig");
    _ = @import("zip.zig");
}
