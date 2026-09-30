//! Independent runtime-index schema 1 (D10). No manager index or legacy conversion.
const std = @import("std");
const select = @import("select.zig");

pub const Asset = struct { name: []const u8, size: u64, sha256: []const u8 };
pub const Entry = struct {
    kind: []const u8,
    tag: []const u8,
    id: []const u8,
    channel: []const u8,
    upstream: struct { commit: []const u8, commitTime: []const u8, tag: ?[]const u8 = null, version: []const u8 },
    run: u64,
    attempt: u64,
    launchProtocol: u64,
    builderCommit: []const u8,
    addons: struct { office: struct { slot: std.json.Value, pinned: ?[]const u8 } },
    assets: std.json.ArrayHashMap(Asset),
    seq: u64,

    pub fn bundle(self: Entry) select.Bundle {
        return .{ .version = self.id, .meta = .{
            .format = .runtime_v1, .channel = self.channel, .commit_time = self.upstream.commitTime,
            .run = self.run, .attempt = self.attempt, .protocol = self.launchProtocol,
        } };
    }
};
pub const Candidate = struct { entry: Entry, asset: Asset };

/// Only portable, plain path/URL components. No index-provided absolute or relative path syntax.
pub fn component(s: []const u8) bool {
    if (s.len == 0 or s.len > 255 or !std.ascii.isAlphanumeric(s[0]) or s[s.len - 1] == '.') return false;
    for (s) |c| if (!std.ascii.isAlphanumeric(c) and std.mem.indexOfScalar(u8, "._+-", c) == null) return false;
    return true;
}

pub fn candidates(a: std.mem.Allocator, bytes: []const u8, channel: []const u8, target: []const u8) ![]Candidate {
    const Index = struct { schema: u32, channels: struct { release: []std.json.Value, live: []std.json.Value }, addons: struct { office: []std.json.Value } };
    const index = std.json.parseFromSliceLeaky(Index, a, bytes, .{ .ignore_unknown_fields = true }) catch return error.InvalidRuntimeIndex;
    if (index.schema != 1) return error.InvalidRuntimeIndex;
    const list = if (std.mem.eql(u8, channel, "release")) index.channels.release else index.channels.live;
    var out: std.ArrayList(Candidate) = .empty;
    for (list) |value| {
        if (value != .object or value.object.contains("launcherProtocol")) continue;
        const e = std.json.parseFromValueLeaky(Entry, a, value, .{ .ignore_unknown_fields = true }) catch continue;
        if (!std.mem.eql(u8, e.kind, "dsh-runtime") or !std.mem.eql(u8, e.channel, channel) or e.launchProtocol != select.protocol) continue;
        if (!component(e.id) or !component(e.tag) or !select.isCommitTime(e.upstream.commitTime) or e.run == 0 or e.attempt == 0 or e.seq == 0) continue;
        const prefix = if (std.mem.eql(u8, channel, "release")) "runtime-v" else "runtime-";
        if (!std.mem.startsWith(u8, e.tag, prefix) or !std.mem.eql(u8, e.tag[prefix.len..], e.id)) continue;
        const asset = e.assets.map.get(target) orelse continue;
        if (!component(asset.name) or asset.size == 0 or asset.sha256.len != 64) continue;
        var digest: [32]u8 = undefined;
        _ = std.fmt.hexToBytes(&digest, asset.sha256) catch continue;
        try out.append(a, .{ .entry = e, .asset = asset });
    }
    return out.items;
}

pub const Choice = union(enum) { found: Candidate, none, ambiguous: [2][]const u8 };
pub fn choose(a: std.mem.Allocator, list: []const Candidate, query: []const u8) !Choice {
    if (list.len == 0) return .none;
    if (std.mem.eql(u8, query, "latest")) {
        var best = list[0];
        for (list[1..]) |c| if (select.before(best.entry.bundle(), c.entry.bundle())) { best = c; };
        return .{ .found = best };
    }
    const bundles = try a.alloc(select.Bundle, list.len);
    for (list, bundles) |c, *b| b.* = c.entry.bundle();
    return switch (select.matchVersion(bundles, query)) {
        .found => |id| blk: {
            for (list) |c| if (std.mem.eql(u8, c.entry.id, id)) break :blk .{ .found = c };
            unreachable;
        },
        .none => .none,
        .ambiguous => |ids| .{ .ambiguous = ids },
    };
}
