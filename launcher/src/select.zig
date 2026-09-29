//! Pure selection logic of the launcher (design S2): leading launch options, version matching, version
//! order, `bundle.json` / `selection.json` reading, and version resolution. No I/O, so it is unit tested
//! on every host (`zig build test`).
const std = @import("std");
const Allocator = std.mem.Allocator;

/// Launcher protocol this launcher implements; each `bundle.json` declares `launcherProtocol`.
pub const protocol: u32 = 2;

/// dsh-bin maintenance commands: run on the newest installed bundle, without a usage claim, so a missing
/// or broken selected version can always be fixed.
pub const maintenance_cmds = [_][]const u8{ "update", "install", "uninstall", "list", "select", "snapshot" };

pub fn isMaintenance(arg: ?[]const u8) bool {
    const a = arg orelse return false;
    for (maintenance_cmds) |cmd| if (std.mem.eql(u8, a, cmd)) return true;
    return false;
}

// ------------------------------------------------------------------------------------ leading options

pub const Options = struct {
    use: ?[]const u8 = null,
    snapshot: ?[]const u8 = null,
    addons: []const []const u8 = &.{},
    /// Number of leading arguments consumed by the options.
    consumed: usize = 0,
};

pub const ParseError = struct {
    kind: enum { missing_value, repeated },
    option: []const u8,
};

pub const Parsed = union(enum) { ok: Options, err: ParseError };

/// `--use/--snapshot/--addon` as leading arguments only (`--opt value` or `--opt=value`); parsing stops at
/// the first other argument, which is passed on unchanged with everything after it.
pub fn parseLeading(allocator: Allocator, args: []const []const u8) Allocator.Error!Parsed {
    var opts = Options{};
    var addons: std.ArrayList([]const u8) = .empty;
    var i: usize = 0;
    while (i < args.len) {
        const arg = args[i];
        const name = for ([_][]const u8{ "--use", "--snapshot", "--addon" }) |n| {
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
            const slot = if (std.mem.eql(u8, name, "--use")) &opts.use else &opts.snapshot;
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

/// An installed version named by its exact version, its tag (`dsh-v<v>`, `dsh-live-<v>`), or a unique prefix.
pub fn matchVersion(installed: []const Bundle, query: []const u8) Match {
    var q = query;
    for ([_][]const u8{ "dsh-v", "dsh-live-" }) |p| {
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

/// The `bundle.json` fields the launcher reads. Null fields are absent or of the wrong type.
pub const Meta = struct {
    channel: ?[]const u8 = null,
    commit_time: ?[]const u8 = null,
    run: ?u64 = null,
    attempt: ?u64 = null,
    protocol: ?u64 = null,

    pub fn ordered(self: Meta) bool {
        return self.channel != null and self.commit_time != null and self.run != null and self.attempt != null;
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
    var meta = Meta{
        .channel = str(field(obj, "channel")),
        .run = uint(field(obj, "run")),
        .attempt = uint(field(obj, "attempt")),
        .protocol = uint(field(obj, "launcherProtocol")),
    };
    if (field(obj, "upstream")) |up| if (up == .object) {
        if (str(up.object.get("commitTime"))) |t| {
            if (isCommitTime(t)) meta.commit_time = t;
        }
    };
    return meta;
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
    /// `use` of the selection; null only when absent in a managed install, which ignores it.
    use: ?[]const u8,
    value: std.json.Value,
};

pub const SelectionError = enum { not_json_object, bad_schema, bad_use };

pub const ParsedSelection = union(enum) { ok: Selection, err: SelectionError };

pub fn parseSelection(allocator: Allocator, bytes: []const u8, managed: bool) ParsedSelection {
    const root = std.json.parseFromSliceLeaky(std.json.Value, allocator, bytes, .{}) catch return .{ .err = .not_json_object };
    if (root != .object) return .{ .err = .not_json_object };
    if (uint(root.object.get("schema")) != 1) return .{ .err = .bad_schema };
    const use = str(root.object.get("use"));
    if (use == null and !managed) return .{ .err = .bad_use };
    return .{ .ok = .{ .use = use, .value = root } };
}

// ------------------------------------------------------------------------------------------- resolution

pub const Source = enum { use, snapshot, selection, managed };

pub const Resolved = struct { version: []const u8, source: Source };

pub const Failure = union(enum) {
    /// A version named by `--use`, the `--snapshot` id or the selection is not installed.
    not_installed: struct { query: []const u8, source: Source },
    ambiguous: struct { query: []const u8, candidates: [2][]const u8 },
    bad_snapshot_id: []const u8,
    /// `latest` found no installed bundle of the channel (or, managed, no bundle at all).
    none_installed: ?[]const u8,
    /// A `latest` candidate whose `bundle.json` lacks the version-order fields.
    unordered: []const u8,
    managed_option: struct { manager: []const u8, option: []const u8 },
};

pub const Resolution = union(enum) { ok: Resolved, err: Failure };

pub const Input = struct {
    opts: Options,
    /// Installed bundles (directory names under `bundles/`), with their parsed `bundle.json`.
    bundles: []const Bundle,
    /// Recorded channel (`<root>/channel`, else the launcher's own channel).
    channel: []const u8,
    /// `.<manager>.managed.lock` in the install root.
    managed: ?[]const u8 = null,
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

/// Version to start (version-selection "Selection resolution", step 1; managed installs use their bundle).
pub fn resolve(in: Input) Resolution {
    if (in.managed) |m| {
        if (in.opts.use != null) return .{ .err = .{ .managed_option = .{ .manager = m, .option = "--use" } } };
        if (in.opts.addons.len > 0) return .{ .err = .{ .managed_option = .{ .manager = m, .option = "--addon" } } };
        if (in.opts.snapshot) |id| if (snapshotVersion(id) == null) return .{ .err = .{ .bad_snapshot_id = id } };
        return switch (newest(in.bundles, null)) {
            .found => |v| .{ .ok = .{ .version = v, .source = .managed } },
            .none => .{ .err = .{ .none_installed = null } },
            .unordered => |v| .{ .err = .{ .unordered = v } },
        };
    }
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
        const use = in.selection_use orelse "latest";
        if (std.mem.eql(u8, use, "latest")) {
            return switch (newest(in.bundles, in.channel)) {
                .found => |v| .{ .ok = .{ .version = v, .source = source } },
                .none => .{ .err = .{ .none_installed = in.channel } },
                .unordered => |v| .{ .err = .{ .unordered = v } },
            };
        }
        query = use;
    }
    return switch (matchVersion(in.bundles, query)) {
        .found => |v| .{ .ok = .{ .version = v, .source = source } },
        .none => .{ .err = .{ .not_installed = .{ .query = query, .source = source } } },
        .ambiguous => |c| .{ .err = .{ .ambiguous = .{ .query = query, .candidates = c } } },
    };
}

/// Bundle that runs maintenance commands: the newest installed bundle this launcher can start (any
/// channel). Unreadable or other-protocol bundles are skipped, so `dsh uninstall` can remove them.
pub fn maintenanceBundle(bundles: []const Bundle) ?[]const u8 {
    var best: ?Bundle = null;
    for (bundles) |b| {
        const m = b.meta orelse continue;
        if (!m.ordered() or m.protocol != protocol) continue;
        if (best == null or before(best.?, b)) best = b;
    }
    return if (best) |b| b.version else null;
}

// ---------------------------------------------------------------------------------------- DSH_BIN_LAUNCH

/// `DSH_BIN_LAUNCH`: the parsed launch options, the resolved version and its source, and the selection the
/// launcher read (so the runtime resolves the snapshot and addons from the same selection, and a restart
/// keeps them). `version`/`source` are null for a maintenance command whose effective version did not resolve.
pub fn launchJson(allocator: Allocator, opts: Options, resolved: ?Resolved, selection: ?std.json.Value) Allocator.Error![]u8 {
    return std.json.Stringify.valueAlloc(allocator, .{
        .protocol = protocol,
        .version = if (resolved) |r| r.version else null,
        .source = if (resolved) |r| @tagName(r.source) else null,
        .use = opts.use,
        .snapshot = opts.snapshot,
        .addons = opts.addons,
        .selection = selection,
    }, .{});
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
    try tt.expectEqualStrings(R1.version, matchVersion(&v, "dsh-v0.2.0-rc.1-xz.10.1.ga83dab63").found);
    try tt.expectEqualStrings(R1.version, matchVersion(&v, "dsh-live-0.2.0").found);
    try tt.expectEqualStrings(R1.version, matchVersion(&v, "0.2.0-rc.1").found);
    try tt.expect(matchVersion(&v, "0.1.7-rc.2") == .ambiguous);
    try tt.expect(matchVersion(&v, "0.1.5") == .none);
    try tt.expect(matchVersion(&v, "dsh-v") == .none);
}

fn testMeta(channel: []const u8, time: []const u8, run: u64, attempt: u64) ?Meta {
    return .{ .channel = channel, .commit_time = time, .run = run, .attempt = attempt, .protocol = protocol };
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

test "bundle.json fields" {
    var arena = std.heap.ArenaAllocator.init(tt.allocator);
    defer arena.deinit();
    const m = parseMeta(arena.allocator(), "{\"channel\":\"live\",\"run\":7,\"attempt\":2,\"launcherProtocol\":2,\"upstream\":{\"commitTime\":\"2026-09-24T10:00:00.000Z\",\"version\":\"x\"},\"addons\":{}}").?;
    try tt.expectEqualStrings("live", m.channel.?);
    try tt.expectEqual(@as(?u64, 2), m.protocol);
    try tt.expect(m.ordered());
    const old = parseMeta(arena.allocator(), "{\"schemaVersion\":1,\"channel\":\"release\",\"upstream\":{\"commitTime\":\"2026-09-24\"}}").?;
    try tt.expectEqual(@as(?u64, null), old.protocol);
    try tt.expect(!old.ordered());
    try tt.expect(parseMeta(arena.allocator(), "[1]") == null);
    try tt.expect(parseMeta(arena.allocator(), "{") == null);
}

test "selection.json" {
    var arena = std.heap.ArenaAllocator.init(tt.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try tt.expectEqualStrings("0.1.7-rc.2", parseSelection(a, "{\"schema\":1,\"use\":\"0.1.7-rc.2\",\"snapshot\":null,\"addons\":{}}", false).ok.use.?);
    try tt.expectEqual(SelectionError.bad_schema, parseSelection(a, "{\"schema\":2,\"use\":\"latest\"}", false).err);
    try tt.expectEqual(SelectionError.bad_use, parseSelection(a, "{\"schema\":1,\"use\":\"\"}", false).err);
    try tt.expectEqual(@as(?[]const u8, null), parseSelection(a, "{\"schema\":1,\"snapshot\":\"v@1\"}", true).ok.use);
    try tt.expectEqual(SelectionError.not_json_object, parseSelection(a, "nope", false).err);
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
    try tt.expectEqualStrings("live", resolve(.{ .opts = .{}, .bundles = &.{R2}, .channel = "live" }).err.none_installed.?);
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

test "resolution: managed installs ignore the selection's use and refuse --use/--addon" {
    const one = [_]Bundle{R1};
    var r = resolve(.{ .opts = .{}, .bundles = &one, .channel = "release", .managed = "portage", .selection_use = "0.1.7-rc.2" });
    try tt.expectEqualStrings(R1.version, r.ok.version);
    try tt.expectEqual(Source.managed, r.ok.source);
    r = resolve(.{ .opts = .{ .snapshot = "0.1.7-rc.2@2" }, .bundles = &one, .channel = "live", .managed = "portage" });
    try tt.expectEqualStrings(R1.version, r.ok.version);
    r = resolve(.{ .opts = .{ .use = "0.1.7-rc.2" }, .bundles = &one, .channel = "release", .managed = "scoop" });
    try tt.expectEqualStrings("scoop", r.err.managed_option.manager);
    try tt.expectEqualStrings("--use", r.err.managed_option.option);
    r = resolve(.{ .opts = .{ .addons = &.{"office:1"} }, .bundles = &one, .channel = "release", .managed = "scoop" });
    try tt.expectEqualStrings("--addon", r.err.managed_option.option);
}

test "maintenance bundle: newest this launcher can start, any channel" {
    const future = Bundle{ .version = "9", .meta = .{ .channel = "release", .commit_time = "2027-01-01T00:00:00.000Z", .run = 1, .attempt = 1, .protocol = 3 } };
    const all = [_]Bundle{ R2, L, R1, future, .{ .version = "junk", .meta = null } };
    try tt.expectEqualStrings(L.version, maintenanceBundle(&all).?);
    try tt.expectEqual(@as(?[]const u8, null), maintenanceBundle(&.{future}));
    try tt.expect(isMaintenance("select") and isMaintenance("snapshot") and !isMaintenance("plugin") and !isMaintenance(null));
}

test "DSH_BIN_LAUNCH" {
    var arena = std.heap.ArenaAllocator.init(tt.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const sel = parseSelection(a, "{\"schema\":1,\"use\":\"latest\",\"snapshot\":\"v@1\"}", false).ok.value;
    const j = try launchJson(a, .{ .snapshot = "v@2", .addons = &.{"office:1"} }, .{ .version = "v", .source = .snapshot }, sel);
    try tt.expectEqualStrings("{\"protocol\":2,\"version\":\"v\",\"source\":\"snapshot\",\"use\":null,\"snapshot\":\"v@2\",\"addons\":[\"office:1\"],\"selection\":{\"schema\":1,\"use\":\"latest\",\"snapshot\":\"v@1\"}}", j);
    const m = try launchJson(a, .{}, null, null);
    try tt.expectEqualStrings("{\"protocol\":2,\"version\":null,\"source\":null,\"use\":null,\"snapshot\":null,\"addons\":[],\"selection\":null}", m);
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
