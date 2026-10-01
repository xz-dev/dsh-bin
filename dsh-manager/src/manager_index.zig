//! Independent manager-index schema 1 (D10). SemVer is unrelated to runtime ordering/protocol numbers.
const std = @import("std");
const index = @import("index.zig");
const protocol = @import("select.zig").protocol;
pub const Entry = struct { version: []const u8, tag: []const u8, launchProtocols: []const u64, assets: std.json.ArrayHashMap(index.Asset) };
pub const Candidate = struct { entry: Entry, asset: index.Asset, version: std.SemanticVersion };

pub fn choose(a: std.mem.Allocator, bytes: []const u8, target: []const u8) !Candidate {
    const Index = struct { schema: u32, versions: []Entry };
    const parsed = std.json.parseFromSliceLeaky(Index, a, bytes, .{ .ignore_unknown_fields = true }) catch return error.InvalidManagerIndex;
    if (parsed.schema != 1) return error.InvalidManagerIndex;
    var best: ?Candidate = null;
    for (parsed.versions, 0..) |entry, n| {
        const version = std.SemanticVersion.parse(entry.version) catch return error.InvalidManagerVersion;
        if (entry.version.len > 200 or !index.component(entry.tag) or !std.mem.startsWith(u8, entry.tag, "manager-v") or !std.mem.eql(u8, entry.tag[9..], entry.version)) return error.InvalidManagerIdentity;
        for (parsed.versions[0..n]) |previous| {
            const prior = std.SemanticVersion.parse(previous.version) catch return error.InvalidManagerVersion;
            if (prior.order(version) == .eq) return error.AmbiguousManagerVersion;
        }
        const asset = entry.assets.map.get(target) orelse continue;
        if (!index.component(asset.name) or !std.mem.endsWith(u8, asset.name, ".zip") or asset.size == 0 or asset.size > 128 << 20 or asset.sha256.len != 64) return error.InvalidManagerAsset;
        var digest: [32]u8 = undefined;
        _ = std.fmt.hexToBytes(&digest, asset.sha256) catch return error.InvalidManagerAsset;
        if (best == null or best.?.version.order(version) == .lt) best = .{ .entry = entry, .asset = asset, .version = version };
    }
    const candidate = best orelse return error.NoManagerTarget;
    if (std.mem.indexOfScalar(u64, candidate.entry.launchProtocols, protocol) == null) return error.IncompatibleManagerProtocol;
    return candidate;
}

test "MC-SELF-ONLY manager SemVer uses numeric and prerelease ordering, ignores build metadata" {
    const t = std.testing;
    try t.expect((try std.SemanticVersion.parse("1.10.0")).order(try std.SemanticVersion.parse("1.9.0")) == .gt);
    try t.expect((try std.SemanticVersion.parse("1.0.0-rc.10")).order(try std.SemanticVersion.parse("1.0.0-rc.2")) == .gt);
    try t.expect((try std.SemanticVersion.parse("1.0.0-rc.2")).order(try std.SemanticVersion.parse("1.0.0")) == .lt);
    try t.expect((try std.SemanticVersion.parse("1.0.0+repair")).order(try std.SemanticVersion.parse("1.0.0")) == .eq);
    try t.expectError(error.InvalidVersion, std.SemanticVersion.parse("01.0.0"));
}
