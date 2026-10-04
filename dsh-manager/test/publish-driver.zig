// Calls the production Zig publish seam; native actor, not a separate syscall implementation.
const std = @import("std");
const update = @import("update");

pub fn main() !void {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try std.process.argsAlloc(a);
    if (args.len != 5 and args.len != 7) return error.InvalidArgs;
    var parent = try std.fs.cwd().openDir(args[2], .{ .iterate = true, .no_follow = true });
    defer parent.close();
    if (std.mem.eql(u8, args[1], "move-parent")) {
        if (args.len != 7) return error.InvalidArgs;
        // Controlled fixture actor replaces pathname AFTER production caller retained its no-follow fd.
        try std.fs.cwd().rename(args[2], args[5]);
        try std.fs.cwd().symLink(args[6], args[2], .{ .is_directory = true });
    } else if (!std.mem.eql(u8, args[1], "publish") or args.len != 5) return error.InvalidArgs;
    try update.publish(a, parent, args[3], args[4]);
}
