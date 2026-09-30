const std = @import("std");
const zip = @import("zip");

pub fn main() !void {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try std.process.argsAlloc(a);
    if (args.len != 3) return error.InvalidArgs;
    try zip.extract(a, args[1], args[2]);
}
