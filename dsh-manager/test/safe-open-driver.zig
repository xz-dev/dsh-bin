// Small native seam driver; no app/runtime fixture and no caller-side errno remapping.
const std = @import("std");
const safe = @import("safe");

pub fn main() !void {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const args = try std.process.argsAlloc(arena.allocator());
    if (args.len != 4) return error.InvalidArgs;
    var parent = try std.fs.cwd().openDir(args[2], .{ .iterate = true });
    defer parent.close();
    if (std.mem.eql(u8, args[1], "directory")) {
        var dir = try safe.openDir(parent, args[3], .{ .iterate = true, .no_follow = true });
        defer dir.close();
        if ((try dir.stat()).kind != .directory) return error.NotDir;
    } else if (std.mem.eql(u8, args[1], "file")) {
        const file: std.fs.File = .{ .handle = try safe.openat(parent.fd, args[3], .{ .ACCMODE = .RDONLY, .NOFOLLOW = true, .NONBLOCK = true }, 0) };
        defer file.close();
        if ((try file.stat()).kind != .file) return error.InvalidFile;
    } else return error.InvalidArgs;
}
