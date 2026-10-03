//! Pure selection logic of the manager: leading launch options, version matching, version order,
//! runtime `bundle.json` / `selection.json` reading, and version resolution. No I/O, so it is unit tested
//! on every host (`zig build test`).
const std = @import("std");
const Allocator = std.mem.Allocator;

/// Launch protocol this manager implements; each runtime `bundle.json` declares `launchProtocol`.
pub const protocol: u32 = 1;

// ------------------------------------------------------------------------------------ leading options

pub const Options = struct {
    use: ?[]const u8 = null,
    snapshot: ?[]const u8 = null,
    config_snapshot: ?[]const u8 = null,
    addons: []const []const u8 = &.{},
    /// Number of leading arguments consumed by the options.
    consumed: usize = 0,
};

pub const ParseError = struct {
    kind: enum { missing_value, repeated },
    option: []const u8,
};

pub const Parsed = union(enum) { ok: Options, err: ParseError };

/// `--use/--snapshot/--config-snapshot/--addon` as leading arguments only (`--opt value` or `--opt=value`); parsing stops at
/// the first other argument, which is passed on unchanged with everything after it.
pub fn parseLeading(allocator: Allocator, args: []const []const u8) Allocator.Error!Parsed {
    var opts = Options{};
    var addons: std.ArrayList([]const u8) = .empty;
    var i: usize = 0;
    while (i < args.len) {
        const arg = args[i];
        const name = for ([_][]const u8{ "--use", "--snapshot", "--config-snapshot", "--addon" }) |n| {
            if (std.mem.eql(u8, arg, n) or (std.mem.startsWith(u8, arg, n) and arg.len > n.len and arg[n.len] == '=')) break n;
        } else break;
        var value: []const u8 = undefined;
        if (arg.len > name.len) {
            value = arg[name.len + 1 ..];
            i += 1;
        } else {
            if (i + 1 >= args.len) return .{ .err = .{ .kind = .missing_value, .option = name } };
            value = args[i + 1];
            i += 2;
        }
        if (value.len == 0) return .{ .err = .{ .kind = .missing_value, .option = name } };
        if (std.mem.eql(u8, name, "--addon")) {
            try addons.append(allocator, value);
        } else {
            const slot = if (std.mem.eql(u8, name, "--use")) &opts.use else if (std.mem.eql(u8, name, "--snapshot")) &opts.snapshot else &opts.config_snapshot;
            if (slot.* != null) return .{ .err = .{ .kind = .repeated, .option = name } };
            slot.* = value;
        }
    }
    opts.addons = try addons.toOwnedSlice(allocator);
    opts.consumed = i;
    return .{ .ok = opts };
}

/// Version part of a snapshot id `<version>@<n|alias>` (before the last `@`), or null when malformed.
pub fn snapshotVersion(id: []const u8) ?[]const u8 {
    const at = std.mem.lastIndexOfScalar(u8, id, '@') orelse return null;
    if (at == 0 or at + 1 == id.len) return null;
    return id[0..at];
}

// ------------------------------------------------------------------------------------ version matching

pub const Match = union(enum) { found: []const u8, none, ambiguous: [2][]const u8 };

/// An installed runtime named by its exact id, its tag (`runtime-v<id>`, `runtime-<live id>`), or a unique prefix.
pub fn matchVersion(installed: []const Bundle, query: []const u8) Match {
    var q = query;
    for ([_][]const u8{ "runtime-v", "runtime-" }) |p| {
        if (std.mem.startsWith(u8, q, p)) {
            q = q[p.len..];
            break;
        }
    }
    for (installed) |b| if (std.mem.eql(u8, b.version, q)) return .{ .found = b.version };
    if (q.len == 0) return .none;
    var hit: ?[]const u8 = null;
    for (installed) |b| {
        if (!std.mem.startsWith(u8, b.version, q)) continue;
        if (hit) |h| return .{ .ambiguous = .{ h, b.version } };
        hit = b.version;
    }
    return if (hit) |h| .{ .found = h } else .none;
}

// ------------------------------------------------------------------------------------------ bundle.json

/// The runtime `bundle.json` fields the manager reads (design D10). Null fields are absent or of the wrong type.
pub const Meta = struct {
    /// `kind="dsh-runtime"` with `schemaVersion=1`; anything else (an old coupled bundle, a foreign file)
    /// is not a runtime this manager can start.
    format: enum { runtime_v1, legacy, unknown } = .unknown,
    channel: ?[]const u8 = null,
    commit_time: ?[]const u8 = null,
    run: ?u64 = null,
    attempt: ?u64 = null,
    protocol: ?u64 = null,
    entry: ?[]const u8 = null,

    pub fn ordered(self: Meta) bool {
        return self.format == .runtime_v1 and self.channel != null and self.commit_time != null and self.run != null and self.attempt != null;
    }
};

fn field(obj: std.json.ObjectMap, name: []const u8) ?std.json.Value {
    return obj.get(name);
}

fn str(v: ?std.json.Value) ?[]const u8 {
    return if (v) |x| switch (x) {
        .string => |s| if (s.len > 0) s else null,
        else => null,
    } else null;
}

fn uint(v: ?std.json.Value) ?u64 {
    return if (v) |x| switch (x) {
        .integer => |n| if (n >= 0) @intCast(n) else null,
        else => null,
    } else null;
}

/// Canonical `Date.toISOString()` form (`YYYY-MM-DDTHH:MM:SS.sssZ`), so byte order is time order.
pub fn isCommitTime(s: []const u8) bool {
    const shape = "0000-00-00T00:00:00.000Z";
    if (s.len != shape.len) return false;
    for (s, shape) |c, want| {
        if (want == '0') {
            if (!std.ascii.isDigit(c)) return false;
        } else if (c != want) return false;
    }
    return true;
}

/// Null when the file is not a JSON object.
pub fn parseMeta(allocator: Allocator, bytes: []const u8) ?Meta {
    const root = std.json.parseFromSliceLeaky(std.json.Value, allocator, bytes, .{}) catch return null;
    if (root != .object) return null;
    const obj = root.object;
    const kind = str(field(obj, "kind"));
    const v1 = kind != null and std.mem.eql(u8, kind.?, "dsh-runtime") and uint(field(obj, "schemaVersion")) == 1;
    var meta = Meta{
        .format = if (v1) .runtime_v1 else if (field(obj, "launcherProtocol") != null or kind == null) .legacy else .unknown,
        .channel = str(field(obj, "channel")),
        .run = uint(field(obj, "run")),
        .attempt = uint(field(obj, "attempt")),
        .protocol = uint(field(obj, "launchProtocol")),
        .entry = safeEntry(str(field(obj, "entry"))),
    };
    if (field(obj, "upstream")) |up| if (up == .object) {
        if (str(up.object.get("commitTime"))) |t| {
            if (isCommitTime(t)) meta.commit_time = t;
        }
    };
    return meta;
}

/// A bundle entry is one plain file name inside the runtime directory.
fn safeEntry(e: ?[]const u8) ?[]const u8 {
    const v = e orelse return null;
    if (std.mem.eql(u8, v, ".") or std.mem.eql(u8, v, "..")) return null;
    for (v) |c| if (c == '/' or c == '\\' or c == ':' or c == 0) return null;
    return v;
}

pub const Bundle = struct { version: []const u8, meta: ?Meta };

/// Version order: upstream commit time, then run, then attempt (then the name, for a total order).
/// Both bundles must be `ordered`.
pub fn before(a: Bundle, b: Bundle) bool {
    const x = a.meta.?;
    const y = b.meta.?;
    switch (std.mem.order(u8, x.commit_time.?, y.commit_time.?)) {
        .lt => return true,
        .gt => return false,
        .eq => {},
    }
    if (x.run.? != y.run.?) return x.run.? < y.run.?;
    if (x.attempt.? != y.attempt.?) return x.attempt.? < y.attempt.?;
    return std.mem.order(u8, a.version, b.version) == .lt;
}

// --------------------------------------------------------------------------------------- selection.json

pub const Selection = struct {
    use: []const u8,
    value: std.json.Value,
};

pub const SelectionError = enum { not_json_object, bad_schema, bad_use };

pub const ParsedSelection = union(enum) { ok: Selection, err: SelectionError };

pub fn parseSelection(allocator: Allocator, bytes: []const u8) ParsedSelection {
    const root = std.json.parseFromSliceLeaky(std.json.Value, allocator, bytes, .{}) catch return .{ .err = .not_json_object };
    if (root != .object) return .{ .err = .not_json_object };
    if (uint(root.object.get("schema")) != 1) return .{ .err = .bad_schema };
    const use = str(root.object.get("use")) orelse return .{ .err = .bad_use };
    return .{ .ok = .{ .use = use, .value = root } };
}

// ------------------------------------------------------------------------------------------- resolution

pub const Source = enum { use, snapshot, selection };

pub const Resolved = struct { version: []const u8, source: Source };

pub const Failure = union(enum) {
    /// A version named by `--use`, the `--snapshot` id or the selection is not installed.
    not_installed: struct { query: []const u8, source: Source },
    ambiguous: struct { query: []const u8, candidates: [2][]const u8 },
    bad_snapshot_id: []const u8,
    /// `latest` found no installed runtime of the channel.
    none_installed: []const u8,
    /// A `latest` candidate whose `bundle.json` lacks the version-order fields.
    unordered: []const u8,
};

pub const Resolution = union(enum) { ok: Resolved, err: Failure };

pub const Input = struct {
    opts: Options,
    /// Installed bundles (directory names under `bundles/`), with their parsed `bundle.json`.
    bundles: []const Bundle,
    /// Recorded channel (`<data>/state/channel`; `release` when missing or invalid).
    channel: []const u8,
    /// The selection's `use`; null when there is no selection (`latest`).
    selection_use: ?[]const u8 = null,
};

fn newest(bundles: []const Bundle, channel: ?[]const u8) union(enum) { found: []const u8, none, unordered: []const u8 } {
    var best: ?Bundle = null;
    for (bundles) |b| {
        if (channel) |c| {
            const bc = if (b.meta) |m| m.channel else null;
            if (bc) |x| if (!std.mem.eql(u8, x, c)) continue;
        }
        const m = b.meta orelse return .{ .unordered = b.version };
        if (!m.ordered()) return .{ .unordered = b.version };
        if (best == null or before(best.?, b)) best = b;
    }
    return if (best) |b| .{ .found = b.version } else .none;
}

/// Runtime to start: `--use`, else the version of `--snapshot`, else the selection (`latest` by default).
pub fn resolve(in: Input) Resolution {
    var query: []const u8 = undefined;
    var source: Source = undefined;
    if (in.opts.use) |u| {
        query = u;
        source = .use;
        if (in.opts.snapshot) |id| if (snapshotVersion(id) == null) return .{ .err = .{ .bad_snapshot_id = id } };
    } else if (in.opts.snapshot) |id| {
        query = snapshotVersion(id) orelse return .{ .err = .{ .bad_snapshot_id = id } };
        source = .snapshot;
    } else {
        source = .selection;
        query = in.selection_use orelse "latest";
    }
    if (std.mem.eql(u8, query, "latest")) {
        return switch (newest(in.bundles, in.channel)) {
            .found => |v| .{ .ok = .{ .version = v, .source = source } },
            .none => .{ .err = .{ .none_installed = in.channel } },
            .unordered => |v| .{ .err = .{ .unordered = v } },
        };
    }
    return switch (matchVersion(in.bundles, query)) {
        .found => |v| .{ .ok = .{ .version = v, .source = source } },
        .none => .{ .err = .{ .not_installed = .{ .query = query, .source = source } } },
        .ambiguous => |c| .{ .err = .{ .ambiguous = .{ .query = query, .candidates = c } } },
    };
}

// ------------------------------------------------------------------------------------ Windows arguments

/// Offset in the raw command line `cmd` (WTF-16) of the first argument after the program name and `skip`
/// more arguments, split exactly as `CommandLineToArgvW`/the C runtime do. The launcher passes
/// `cmd[offset..]` on unchanged, so the child sees the user's own quoting.
pub fn windowsTailOffset(allocator: Allocator, cmd: []const u16, skip: usize) Allocator.Error!usize {
    var it = try std.process.ArgIteratorWindows.init(allocator, cmd);
    defer it.deinit();
    var i: usize = 0;
    while (i <= skip) : (i += 1) if (!it.skip()) return cmd.len;
    var at = it.index;
    while (at < cmd.len and (cmd[at] == ' ' or cmd[at] == '\t')) at += 1;
    return at;
}

// ---------------------------------------------------------------------------------------------- tests

const tt = std.testing;

fn parseOk(args: []const []const u8) !Options {
    return switch (try parseLeading(tt.allocator, args)) {
        .ok => |o| o,
        .err => error.ParseFailed,
    };
}

test "leading options: both forms, repeated addons, stop at the first other argument" {
    const o = try parseOk(&.{ "--use", "0.1.7-rc.2", "--snapshot=0.1.7-rc.2@2", "--addon", "office:0.1.1", "--addon=x:1", "--profile", "tui", "--use", "9" });
    defer tt.allocator.free(o.addons);
    try tt.expectEqualStrings("0.1.7-rc.2", o.use.?);
    try tt.expectEqualStrings("0.1.7-rc.2@2", o.snapshot.?);
    try tt.expectEqual(@as(usize, 2), o.addons.len);
    try tt.expectEqualStrings("office:0.1.1", o.addons[0]);
    try tt.expectEqualStrings("x:1", o.addons[1]);
    try tt.expectEqual(@as(usize, 6), o.consumed);
}

test "leading options: prompt text is not parsed" {
    const o = try parseOk(&.{ "-p", "--use 1" });
    try tt.expectEqual(@as(?[]const u8, null), o.use);
    try tt.expectEqual(@as(usize, 0), o.consumed);
    const p = try parseOk(&.{ "--usefoo", "x" });
    try tt.expectEqual(@as(usize, 0), p.consumed);
    const e = try parseOk(&.{});
    try tt.expectEqual(@as(usize, 0), e.consumed);
}

test "leading options: missing, empty and repeated values" {
    const cases = [_]struct { args: []const []const u8, option: []const u8, kind: @TypeOf(@as(ParseError, undefined).kind) }{
        .{ .args = &.{"--use"}, .option = "--use", .kind = .missing_value },
        .{ .args = &.{"--snapshot="}, .option = "--snapshot", .kind = .missing_value },
        .{ .args = &.{ "--addon", "" }, .option = "--addon", .kind = .missing_value },
        .{ .args = &.{ "--use", "a", "--use=b" }, .option = "--use", .kind = .repeated },
    };
    for (cases) |c| {
        const r = try parseLeading(tt.allocator, c.args);
        try tt.expectEqualStrings(c.option, r.err.option);
        try tt.expectEqual(c.kind, r.err.kind);
    }
}

test "snapshot id version prefix" {
    try tt.expectEqualStrings("0.1.7-rc.2", snapshotVersion("0.1.7-rc.2@2").?);
    try tt.expectEqualStrings("a@b", snapshotVersion("a@b@alias").?);
    try tt.expectEqual(@as(?[]const u8, null), snapshotVersion("0.1.7"));
    try tt.expectEqual(@as(?[]const u8, null), snapshotVersion("@2"));
    try tt.expectEqual(@as(?[]const u8, null), snapshotVersion("0.1.7@"));
}

test "version matching: exact, tag, unique prefix, ambiguous" {
    const v = [_]Bundle{ R2, R2b, R1 };
    try tt.expectEqualStrings(R2.version, matchVersion(&v, R2.version).found);
    try tt.expectEqualStrings(R1.version, matchVersion(&v, "runtime-v0.2.0-rc.1-xz.10.1.ga83dab63").found);
    try tt.expectEqualStrings(R1.version, matchVersion(&v, "runtime-0.2.0").found);
    try tt.expectEqualStrings(R1.version, matchVersion(&v, "0.2.0-rc.1").found);
    try tt.expect(matchVersion(&v, "0.1.7-rc.2") == .ambiguous);
    try tt.expect(matchVersion(&v, "0.1.5") == .none);
    try tt.expect(matchVersion(&v, "runtime-v") == .none);
}

fn testMeta(channel: []const u8, time: []const u8, run: u64, attempt: u64) ?Meta {
    return .{ .format = .runtime_v1, .channel = channel, .commit_time = time, .run = run, .attempt = attempt, .protocol = protocol };
}

const R2 = Bundle{ .version = "0.1.7-rc.2-xz.7.1.g4e41a3f1", .meta = testMeta("release", "2026-09-24T10:00:00.000Z", 7, 1) };
const R2b = Bundle{ .version = "0.1.7-rc.2-xz.21.1.g4e41a3f1", .meta = testMeta("release", "2026-09-24T10:00:00.000Z", 21, 1) };
const R1 = Bundle{ .version = "0.2.0-rc.1-xz.10.1.ga83dab63", .meta = testMeta("release", "2026-09-28T10:00:00.000Z", 10, 1) };
const L = Bundle{ .version = "0.2.1-xz.11.1.gdeadbeef", .meta = testMeta("live", "2026-09-29T10:00:00.000Z", 11, 1) };

test "version order: commit time, then run, then attempt" {
    try tt.expect(before(R2, R1));
    try tt.expect(before(R2, R2b));
    try tt.expect(!before(R2b, R2));
    const a2 = Bundle{ .version = R2.version, .meta = testMeta("release", "2026-09-24T10:00:00.000Z", 7, 2) };
    try tt.expect(before(R2, a2));
}

test "bundle.json fields: runtime v1, legacy coupled bundles, unsafe entries" {
    var arena = std.heap.ArenaAllocator.init(tt.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const m = parseMeta(a, "{\"kind\":\"dsh-runtime\",\"schemaVersion\":1,\"channel\":\"live\",\"run\":7,\"attempt\":2,\"launchProtocol\":1,\"entry\":\"dsh-native\",\"upstream\":{\"commitTime\":\"2026-09-24T10:00:00.000Z\",\"version\":\"x\"}}").?;
    try tt.expectEqualStrings("live", m.channel.?);
    try tt.expectEqual(@as(?u64, 1), m.protocol);
    try tt.expectEqualStrings("dsh-native", m.entry.?);
    try tt.expect(m.ordered());
    const old = parseMeta(a, "{\"schemaVersion\":2,\"name\":\"dsh-bin\",\"channel\":\"release\",\"launcherProtocol\":2,\"run\":1,\"attempt\":1,\"upstream\":{\"commitTime\":\"2026-09-24T10:00:00.000Z\"}}").?;
    try tt.expect(old.format == .legacy);
    try tt.expect(!old.ordered());
    try tt.expectEqual(@as(?[]const u8, null), parseMeta(a, "{\"kind\":\"dsh-runtime\",\"schemaVersion\":1,\"entry\":\"../x\"}").?.entry);
    try tt.expect(parseMeta(a, "{\"kind\":\"other\"}").?.format == .unknown);
    try tt.expect(parseMeta(a, "[1]") == null);
    try tt.expect(parseMeta(a, "{") == null);
}

test "selection.json" {
    var arena = std.heap.ArenaAllocator.init(tt.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try tt.expectEqualStrings("0.1.7-rc.2", parseSelection(a, "{\"schema\":1,\"use\":\"0.1.7-rc.2\",\"snapshot\":null,\"addons\":{}}").ok.use);
    try tt.expectEqual(SelectionError.bad_schema, parseSelection(a, "{\"schema\":2,\"use\":\"latest\"}").err);
    try tt.expectEqual(SelectionError.bad_use, parseSelection(a, "{\"schema\":1,\"use\":\"\"}").err);
    try tt.expectEqual(SelectionError.not_json_object, parseSelection(a, "nope").err);
}

test "resolution: launch --use, then the --snapshot version, then the selection" {
    const all = [_]Bundle{ R2, R1, L };
    var r = resolve(.{ .opts = .{ .use = "0.2.0-rc.1", .snapshot = "0.1.7-rc.2@2" }, .bundles = &all, .channel = "release" });
    try tt.expectEqualStrings(R1.version, r.ok.version);
    try tt.expectEqual(Source.use, r.ok.source);
    r = resolve(.{ .opts = .{ .snapshot = "0.1.7-rc.2@2" }, .bundles = &all, .channel = "release", .selection_use = "0.2.0-rc.1" });
    try tt.expectEqualStrings(R2.version, r.ok.version);
    try tt.expectEqual(Source.snapshot, r.ok.source);
    r = resolve(.{ .opts = .{}, .bundles = &all, .channel = "release", .selection_use = "0.1.7-rc.2" });
    try tt.expectEqualStrings(R2.version, r.ok.version);
    try tt.expectEqual(Source.selection, r.ok.source);
}

test "resolution: latest follows the recorded channel and version order" {
    const all = [_]Bundle{ L, R1, R2, R2b };
    try tt.expectEqualStrings(R1.version, resolve(.{ .opts = .{}, .bundles = &all, .channel = "release" }).ok.version);
    try tt.expectEqualStrings(R1.version, resolve(.{ .opts = .{}, .bundles = &all, .channel = "release", .selection_use = "latest" }).ok.version);
    try tt.expectEqualStrings(L.version, resolve(.{ .opts = .{}, .bundles = &all, .channel = "live" }).ok.version);
    const rebuilt = [_]Bundle{ R2b, R2 };
    try tt.expectEqualStrings(R2b.version, resolve(.{ .opts = .{}, .bundles = &rebuilt, .channel = "release" }).ok.version);
    try tt.expectEqualStrings("live", resolve(.{ .opts = .{}, .bundles = &.{R2}, .channel = "live" }).err.none_installed);
    const broken = [_]Bundle{ R1, .{ .version = "junk", .meta = null } };
    try tt.expectEqualStrings("junk", resolve(.{ .opts = .{}, .bundles = &broken, .channel = "release" }).err.unordered);
}

test "resolution: missing, ambiguous and malformed names; no fallback" {
    const all = [_]Bundle{ R2, R2b, R1 };
    var r = resolve(.{ .opts = .{}, .bundles = &all, .channel = "release", .selection_use = "0.1.5" });
    try tt.expectEqualStrings("0.1.5", r.err.not_installed.query);
    try tt.expectEqual(Source.selection, r.err.not_installed.source);
    r = resolve(.{ .opts = .{ .use = "0.1.7-rc.2" }, .bundles = &all, .channel = "release" });
    try tt.expectEqualStrings("0.1.7-rc.2", r.err.ambiguous.query);
    r = resolve(.{ .opts = .{ .snapshot = "nover" }, .bundles = &all, .channel = "release" });
    try tt.expectEqualStrings("nover", r.err.bad_snapshot_id);
    r = resolve(.{ .opts = .{ .use = "0.2.0", .snapshot = "bad" }, .bundles = &all, .channel = "release" });
    try tt.expectEqualStrings("bad", r.err.bad_snapshot_id);
}

test "Windows command-line tail after the leading options" {
    const cases = [_]struct { line: []const u8, skip: usize, tail: []const u8 }{
        .{ .line = "dsh --use 0.1.7 --profile tui", .skip = 2, .tail = "--profile tui" },
        .{ .line = "\"C:\\Program Files\\dsh\\dsh.exe\"  --use=\"a b\"\t-p \"--use 1\"", .skip = 1, .tail = "-p \"--use 1\"" },
        .{ .line = "dsh --use x", .skip = 2, .tail = "" },
        .{ .line = "dsh \"--snapshot\" v@1 \"with \\\"quote\\\"\" x", .skip = 2, .tail = "\"with \\\"quote\\\"\" x" },
        .{ .line = "dsh", .skip = 0, .tail = "" },
        .{ .line = "dsh a", .skip = 0, .tail = "a" },
    };
    for (cases) |c| {
        const w = try std.unicode.utf8ToUtf16LeAlloc(tt.allocator, c.line);
        defer tt.allocator.free(w);
        const at = try windowsTailOffset(tt.allocator, w, c.skip);
        const got = try std.unicode.utf16LeToUtf8Alloc(tt.allocator, w[at..]);
        defer tt.allocator.free(got);
        try tt.expectEqualStrings(c.tail, got);
    }
}

test "MC-TYPED / MC-ARGS: independent config leading option, boundary and repeats" {
    const o = try parseOk(&.{ "--snapshot=A@1", "--config-snapshot", "A@1", "--profile", "tui", "--config-snapshot", "B@2" });
    defer tt.allocator.free(o.addons);
    try tt.expectEqualStrings("A@1", o.snapshot.?);
    try tt.expectEqualStrings("A@1", o.config_snapshot.?);
    try tt.expectEqual(@as(usize, 3), o.consumed);
    const missing = try parseLeading(tt.allocator, &.{"--config-snapshot="});
    try tt.expectEqualStrings("--config-snapshot", missing.err.option);
    try tt.expectEqual(@as(@TypeOf(@as(ParseError, undefined).kind), .missing_value), missing.err.kind);
    const repeated = try parseLeading(tt.allocator, &.{ "--config-snapshot", "A@1", "--config-snapshot=B@1" });
    try tt.expectEqual(@as(@TypeOf(@as(ParseError, undefined).kind), .repeated), repeated.err.kind);
}
