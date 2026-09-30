//! Manager state under `<data>/state/` (design D10): the persistent selection and the recorded channel.
//! Reads never create anything; writes are atomic (temp file + rename).
const std = @import("std");
const util = @import("util.zig");
const select = @import("select.zig");
const Ctx = @import("context.zig").Ctx;

pub fn selectionPath(ctx: *const Ctx) []u8 {
    return ctx.path(&.{ "state", "selection.json" });
}

pub const ReadSelection = union(enum) { none, ok: select.Selection, invalid: []const u8 };

pub fn readSelection(ctx: *const Ctx) ReadSelection {
    const bytes = std.fs.cwd().readFileAlloc(ctx.a, selectionPath(ctx), 1 << 20) catch |err| switch (err) {
        error.FileNotFound => return .none,
        else => return .{ .invalid = "unreadable" },
    };
    return switch (select.parseSelection(ctx.a, bytes)) {
        .ok => |s| .{ .ok = s },
        .err => |e| .{ .invalid = switch (e) {
            .not_json_object => "not a JSON object",
            .bad_schema => "unsupported schema",
            .bad_use => "no version",
        } },
    };
}

/// Recorded channel (`state/channel`); release when none is recorded.
pub fn channel(ctx: *const Ctx) []const u8 {
    const bytes = std.fs.cwd().readFileAlloc(ctx.a, ctx.path(&.{ "state", "channel" }), 64) catch return "release";
    const v = std.mem.trim(u8, bytes, " \t\r\n");
    return if (std.mem.eql(u8, v, "live")) "live" else "release";
}
