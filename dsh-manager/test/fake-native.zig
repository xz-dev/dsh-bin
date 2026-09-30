//! Fake `dsh-native` for the launcher tests, portable to every host (a real executable, also on Windows).
//! Driven by environment variables, which the launcher passes through:
//! - FAKE_OUT (required): directory for `<gen>.argv` (one argument per line) and `<gen>.env` (KEY=VALUE lines);
//! - FAKE_EXIT: exit status (default 0);
//! - `<gen>.cwd` gets the working directory; with FAKE_STDIN set, `<gen>.stdin` gets up to 4 KiB of stdin;
//! - FAKE_HOLD: when set, write `<FAKE_OUT>/started` and then sleep 30 s;
//! - FAKE_RESTART_WRITE / FAKE_RESTART_DATA: restart once like an in-app restart, after writing DATA to the
//!   file WRITE: respawn this executable with the same arguments and environment (plus FAKE_GEN=2), then
//!   exit with the replacement's status.
const std = @import("std");

pub fn main() !void {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    const a = arena.allocator();
    var env = try std.process.getEnvMap(a);
    const out = env.get("FAKE_OUT") orelse return error.NoFakeOut;
    const gen = env.get("FAKE_GEN") orelse "1";
    const args = try std.process.argsAlloc(a);

    var argv_text: std.ArrayList(u8) = .empty;
    for (args[1..]) |arg| try argv_text.print(a, "{s}\n", .{arg});
    var dir = try std.fs.openDirAbsolute(out, .{});
    defer dir.close();
    try dir.writeFile(.{ .sub_path = try std.fmt.allocPrint(a, "{s}.argv", .{gen}), .data = argv_text.items });
    var env_text: std.ArrayList(u8) = .empty;
    var it = env.iterator();
    while (it.next()) |e| try env_text.print(a, "{s}={s}\n", .{ e.key_ptr.*, e.value_ptr.* });
    try dir.writeFile(.{ .sub_path = try std.fmt.allocPrint(a, "{s}.env", .{gen}), .data = env_text.items });
    try dir.writeFile(.{ .sub_path = try std.fmt.allocPrint(a, "{s}.cwd", .{gen}), .data = try std.process.getCwdAlloc(a) });
    if (env.get("FAKE_STDIN") != null) {
        var buf: [4096]u8 = undefined;
        const n = try std.fs.File.stdin().readAll(&buf);
        try dir.writeFile(.{ .sub_path = try std.fmt.allocPrint(a, "{s}.stdin", .{gen}), .data = buf[0..n] });
    }

    if (env.get("FAKE_RESTART_WRITE")) |path| if (std.mem.eql(u8, gen, "1")) {
        try std.fs.cwd().writeFile(.{ .sub_path = path, .data = env.get("FAKE_RESTART_DATA") orelse "" });
        try env.put("FAKE_GEN", "2");
        const self = try std.fs.selfExePathAlloc(a);
        const child_argv = try a.alloc([]const u8, args.len);
        child_argv[0] = self;
        for (args[1..], 1..) |arg, i| child_argv[i] = arg;
        var child = std.process.Child.init(child_argv, a);
        child.env_map = &env;
        const term = try child.spawnAndWait();
        std.process.exit(switch (term) {
            .Exited => |c| c,
            else => 1,
        });
    };

    if (env.get("FAKE_HOLD") != null) {
        try dir.writeFile(.{ .sub_path = "started", .data = "" });
        std.Thread.sleep(30 * std.time.ns_per_s);
    }
    const code = std.fmt.parseInt(u8, env.get("FAKE_EXIT") orelse "0", 10) catch 0;
    std.process.exit(code);
}
