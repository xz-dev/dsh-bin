//! Read-only manager path reports. Inventory and intent never enter ensure/bootstrap or acquire locks.
const std = @import("std");
const builtin = @import("builtin");
const util = @import("util.zig");
const context = @import("context.zig");
const binary = @import("manager_binary.zig");
const select = @import("select.zig");
const snapshot = @import("snapshot.zig");
const runtimes = @import("runtimes.zig");
const addons = @import("addons.zig");
const completion = @import("completion.zig");
const first_run = @import("first_run.zig");
const Ctx = context.Ctx;
const eq = std.mem.eql;
pub const scopes = [_][]const u8{ "self", "home", "runtime", "snapshot", "addon", "cache", "tmp", "completion" };
const Scope = enum { overview, self, home, runtime, snapshot, addon, cache, tmp, completion };
const Record = struct { role: []const u8, path: ?[]const u8, status: []const u8, source: []const u8, reason: []const u8 = "", kind: ?snapshot.Kind = null, id: ?[]const u8 = null, version: ?[]const u8 = null, slot: ?addons.Slot = null };
const Diagnostic = struct { code: []const u8, role: ?[]const u8 = null, path: ?[]const u8 = null, message: []const u8 };
const Choice = struct { id: []const u8, path: []const u8, source: []const u8 };
const Effective = struct { status: []const u8 = "unresolved", runtime: ?Choice = null, plugins: ?Choice = null, config: ?Choice = null, addons: struct { office: ?Choice = null } = .{}, reason: ?[]const u8 = null };

fn problem(err: anyerror) []const u8 {
    return switch (err) {
        error.AccessDenied => "unreadable",
        error.NotDir, error.SymLinkLoop, error.InvalidManagerFile, error.InvalidSnapshot, error.AddonDirectoryConflict => "conflict",
        else => "invalid",
    };
}

/// Path information only, never open a regular file (including an rc or credential) to stat it.
fn pathStatus(path: []const u8, directory: bool, missing: []const u8) []const u8 {
    if (context.is_windows) {
        const win = std.os.windows;
        const w = win.sliceToPrefixedFileW(null, path) catch return "invalid";
        const attrs = win.GetFileAttributesW(w.span().ptr) catch |err| return if (err == error.FileNotFound) missing else problem(err);
        if (attrs & win.FILE_ATTRIBUTE_REPARSE_POINT != 0) return "conflict";
        return if ((attrs & win.FILE_ATTRIBUTE_DIRECTORY != 0) == directory) "exists" else "conflict";
    }
    const st = std.posix.fstatat(std.posix.AT.FDCWD, path, std.posix.AT.SYMLINK_NOFOLLOW) catch |err| return if (err == error.FileNotFound) missing else problem(err);
    const expected: @TypeOf(st.mode) = if (directory) std.posix.S.IFDIR else std.posix.S.IFREG;
    return if (st.mode & std.posix.S.IFMT == expected) "exists" else "conflict";
}

const Query = struct {
    ctx: *Ctx,
    records: std.ArrayList(Record) = .empty,
    diagnostics: std.ArrayList(Diagnostic) = .empty,
    complete: bool = true,
    data: ?std.fs.Dir = null,

    fn fail(q: *Query, code: []const u8, role: []const u8, path: ?[]const u8, message: []const u8) void {
        q.complete = false;
        q.diagnostics.append(q.ctx.a, .{ .code = code, .role = role, .path = path, .message = message }) catch util.oom();
    }
    fn add(q: *Query, record: Record) void {
        q.records.append(q.ctx.a, record) catch util.oom();
        if (eq(u8, record.status, "unreadable") or eq(u8, record.status, "invalid") or eq(u8, record.status, "conflict")) q.fail(record.status, record.role, record.path, record.reason);
    }
    fn location(q: *Query, role: []const u8, path: []const u8, source: []const u8, reason: []const u8, directory: bool) void {
        q.add(.{ .role = role, .path = path, .status = pathStatus(path, directory, "not-created"), .source = source, .reason = reason });
    }
    fn open(q: *Query, parent: std.fs.Dir, name: []const u8, role: []const u8, path: []const u8) ?std.fs.Dir {
        const d = parent.openDir(name, .{ .iterate = true, .no_follow = true }) catch |err| {
            if (err != error.FileNotFound) q.fail(problem(err), role, path, @errorName(err));
            return null;
        };
        return d;
    }
    fn claimReadRoot(q: *Query) void {
        const status = pathStatus(q.ctx.data, true, "not-created");
        if (eq(u8, status, "not-created")) return;
        if (!eq(u8, status, "exists")) {
            q.fail(status, "self.data", q.ctx.data, "expected an ordinary manager data directory");
            return;
        }
        var d = std.fs.cwd().openDir(q.ctx.data, .{ .iterate = true, .no_follow = true }) catch |err| {
            q.fail(problem(err), "self.data", q.ctx.data, @errorName(err));
            return;
        };
        const bytes = binary.readMetadata(q.ctx.a, d, context.data_marker, 4096) catch |err| {
            if (err == error.FileNotFound) {
                var it = d.iterate();
                const entry = it.next() catch |e| {
                    d.close();
                    q.fail(problem(e), "self.data", q.ctx.data, @errorName(e));
                    return;
                };
                d.close();
                if (entry != null) q.fail("conflict", "self.data", q.ctx.data, "nonempty data directory has no valid ownership marker");
                return;
            }
            d.close();
            q.fail(problem(err), "self.data", q.ctx.data, "cannot read ordinary ownership metadata");
            return;
        };
        if (!context.validDataMarker(q.ctx.a, bytes)) {
            d.close();
            q.fail("conflict", "self.data", q.ctx.data, "invalid manager ownership marker");
            return;
        }
        q.data = d;
    }
    fn metadata(q: *Query, parts: []const []const u8, limit: usize) !?[]const u8 {
        var d = q.data orelse return null;
        var owned = false;
        defer if (owned) d.close();
        for (parts[0 .. parts.len - 1]) |part| {
            const next = d.openDir(part, .{ .no_follow = true }) catch |err| {
                if (err == error.FileNotFound) return null;
                return err;
            };
            if (owned) d.close();
            d = next;
            owned = true;
        }
        return binary.readMetadata(q.ctx.a, d, parts[parts.len - 1], limit) catch |err| {
            if (err == error.FileNotFound) return null;
            return err;
        };
    }
    fn bundles(q: *Query) []select.Bundle {
        const parent = q.data orelse return &.{};
        var d = q.open(parent, "bundles", "runtime.root", q.ctx.path(&.{"bundles"})) orelse return &.{};
        defer d.close();
        return runtimes.readIn(q.ctx, d) catch |err| {
            q.fail(problem(err), "runtime.root", q.ctx.path(&.{"bundles"}), @errorName(err));
            return &.{};
        };
    }
    fn snapshots(q: *Query, kind: snapshot.Kind) []snapshot.Meta {
        const parent = q.data orelse return &.{};
        var d = q.open(parent, kind.root(), "snapshot.root", q.ctx.path(&.{kind.root()})) orelse return &.{};
        defer d.close();
        return snapshot.listIn(q.ctx, d) catch |err| {
            q.fail(problem(err), "snapshot.root", q.ctx.path(&.{kind.root()}), @errorName(err));
            return &.{};
        };
    }
    fn office(q: *Query) []addons.Meta {
        const parent = q.data orelse return &.{};
        var a = q.open(parent, "addons", "addon.root", q.ctx.path(&.{"addons"})) orelse return &.{};
        defer a.close();
        var d = q.open(a, "office", "addon.root", q.ctx.path(&.{ "addons", "office" })) orelse return &.{};
        defer d.close();
        return addons.localIn(q.ctx, d) catch |err| {
            q.fail(problem(err), "addon.root", q.ctx.path(&.{ "addons", "office" }), @errorName(err));
            return &.{};
        };
    }
    fn static(q: *Query, scope: Scope) void {
        const ctx = q.ctx;
        if (scope == .overview or scope == .self) {
            q.location("self.executable", ctx.exe, "real-executable", "resolved executable, not the invocation symlink or cwd", false);
            const source = switch (ctx.mode) {
                .portable => "executable-adjacent",
                .portage => if (ctx.env.get("XDG_DATA_HOME")) |s| if (std.fs.path.isAbsolute(s)) "XDG_DATA_HOME" else "HOME/.local/share" else "HOME/.local/share",
                .scoop => "LOCALAPPDATA",
            };
            q.location("self.data", ctx.data, source, @tagName(ctx.mode), true);
            for (q.diagnostics.items) |d| if (d.role != null and eq(u8, d.role.?, "self.data")) {
                for (q.records.items) |*r| if (eq(u8, r.role, "self.data")) {
                    r.status = d.code;
                    r.reason = d.message;
                };
            };
            q.location("self.state", ctx.path(&.{"state"}), "manager-data", "manager state, not application configuration", true);
        }
        if (scope == .overview or scope == .home) {
            const raw = ctx.env.get("DSH_HOME");
            const overridden = raw != null and std.mem.trim(u8, raw.?, " \t\r\n").len != 0;
            const reason = if (overridden and !std.fs.path.isAbsolute(raw.?) and raw.?[0] != '~') std.fmt.allocPrint(ctx.a, "DSH_HOME relative to calling cwd {s}; non-configuration application data", .{std.process.getCwdAlloc(ctx.a) catch util.oom()}) catch util.oom() else "non-configuration application home; no configuration/credential fallback";
            q.location("home", ctx.home(), if (overridden) "DSH_HOME" else "manager-data-default", reason, true);
        }
        if (scope == .overview) {
            q.location("runtime.root", ctx.path(&.{"bundles"}), "manager-data", "installed runtime inventory", true);
            for (std.enums.values(snapshot.Kind)) |kind| q.add(.{ .role = "snapshot.root", .path = ctx.path(&.{kind.root()}), .status = pathStatus(ctx.path(&.{kind.root()}), true, "not-created"), .source = "manager-data", .reason = "typed snapshot inventory, independent of application home", .kind = kind });
            q.location("addon.root", ctx.path(&.{"addons"}), "manager-data", "local addon inventory", true);
        }
        if (scope == .overview or scope == .cache) {
            q.location("cache.manager", ctx.path(&.{"cache"}), "manager-data", "manager cache", true);
            q.location("cache.app-default", util.join(ctx.a, &.{ ctx.home(), "cache" }), "application-default", "default only; custom plugin caches are not discovered", true);
            inline for (@import("clean.zig").cache_env) |pair| q.add(.{ .role = "cache.controlled", .path = ctx.path(pair[1]), .status = pathStatus(ctx.path(pair[1]), true, "not-created"), .source = "launch-controlled", .reason = "controlled launch cache; no environment dump", .id = pair[0] });
        }
        if (scope == .overview or scope == .tmp) q.location("tmp", ctx.path(&.{"tmp"}), "manager-data", "manager work root; ongoing transactions are not enumerated or authorized for deletion", true);
    }
    fn runtimeRows(q: *Query, query: ?[]const u8) void {
        q.location("runtime.root", q.ctx.path(&.{"bundles"}), "manager-data", "installed local runtimes", true);
        const all = q.bundles();
        const chosen: ?[]const u8 = if (query) |v| switch (select.matchVersion(all, v)) {
            .found => |id| id,
            .none => {
                q.fail("target-not-found", "runtime", null, "explicit runtime is not installed");
                return;
            },
            .ambiguous => {
                q.fail("ambiguous-target", "runtime", null, "runtime prefix is ambiguous");
                return;
            },
        } else null;
        for (all) |b| {
            if (chosen != null and !eq(u8, chosen.?, b.version)) continue;
            q.add(.{ .role = "runtime", .path = q.ctx.path(&.{ "bundles", b.version }), .status = if (b.meta == null) "invalid" else "exists", .source = "local-inventory", .reason = if (b.meta) |m| if (m.format != .runtime_v1) "unsupported-runtime-format" else if (m.protocol != select.protocol) "incompatible-launch-protocol" else "installed runtime" else "unreadable or invalid ordinary bundle metadata", .id = b.version, .version = b.version });
        }
    }
    fn snapshotRows(q: *Query, kind: ?snapshot.Kind, target: ?[]const u8) void {
        for (std.enums.values(snapshot.Kind)) |k| {
            if (kind != null and kind.? != k) continue;
            const path = q.ctx.path(&.{k.root()});
            q.add(.{ .role = "snapshot.root", .path = path, .status = pathStatus(path, true, "not-created"), .source = "manager-data", .reason = "typed local snapshot inventory", .kind = k });
            const all = q.snapshots(k);
            const chosen: ?snapshot.Meta = if (target) |t| snapshot.lookup(q.ctx, all, t) catch |err| {
                q.fail("invalid-target", "snapshot", null, @errorName(err));
                return;
            } else null;
            for (all) |s| {
                if (chosen != null and !eq(u8, chosen.?.id, s.id)) continue;
                q.add(.{ .role = "snapshot", .path = q.ctx.path(&.{ k.root(), s.id }), .status = "exists", .source = "local-inventory", .reason = "snapshot remains queryable without its runtime", .kind = k, .id = s.id, .version = s.version });
            }
        }
    }
    fn addonRows(q: *Query, target: ?[]const u8) void {
        q.location("addon.root", q.ctx.path(&.{"addons"}), "manager-data", "local addon inventory", true);
        const wanted = if (target) |t| addons.request(t) catch |err| {
            q.fail("invalid-target", "addon", null, @errorName(err));
            return;
        } else null;
        var found = target == null or wanted == null;
        for (q.office()) |m| {
            if (wanted != null and !eq(u8, wanted.?, m.version)) continue;
            found = true;
            q.add(.{ .role = "addon", .path = q.ctx.path(&.{ "addons", m.name, m.version }), .status = "exists", .source = "local-inventory", .reason = m.name, .id = m.version, .version = m.version, .slot = m.slot });
        }
        if (!found) q.fail("target-not-found", "addon", null, "explicit addon version is not installed");
    }
    fn completionRows(q: *Query, selected: ?completion.Shell) void {
        const bytes = q.metadata(&.{ "state", "completion.json" }, 16384) catch |err| {
            q.fail(problem(err), "completion", q.ctx.path(&.{ "state", "completion.json" }), @errorName(err));
            return;
        };
        const s: first_run.State = if (bytes) |b| std.json.parseFromSliceLeaky(first_run.State, q.ctx.a, b, .{}) catch {
            q.fail("invalid", "completion", q.ctx.path(&.{ "state", "completion.json" }), "invalid completion registration metadata");
            return;
        } else .{ .schema = 1, .shells = .{} };
        if (s.schema != 1) {
            q.fail("invalid", "completion", null, "unsupported completion registration schema");
            return;
        }
        inline for (std.meta.fields(first_run.Choices)) |field| {
            const shell = @field(completion.Shell, field.name);
            if (selected == null or selected.? == shell) {
                const e = @field(s.shells, field.name);
                const registered = e != null and e.?.result == .registered;
                const path = if (registered) e.?.path else null;
                const status = if (!registered) "not-created" else if (path) |p| if (!std.fs.path.isAbsolute(p)) "invalid" else pathStatus(p, false, "missing") else "unknown";
                const reason = if (!registered) "not-registered" else if (path == null) "registration-path-not-recorded" else if (eq(u8, status, "conflict")) "recorded registration is no longer a regular file; not followed" else "recorded registration; not proof current shell loaded it";
                for ([_][]const u8{ "completion.registration", "completion.script" }) |role| q.add(.{ .role = role, .path = path, .status = status, .source = "recorded-registration", .reason = reason, .id = field.name });
                if (registered and path == null) q.fail("completion-path-unrecorded", "completion.registration", null, "historical registration has no recorded location; not guessed");
                if (registered and e.?.binding != null) {
                    const binding = e.?.binding.?;
                    const absolute = std.mem.startsWith(u8, binding, "abs:") and std.fs.path.isAbsolute(binding[4..]);
                    q.add(.{ .role = "completion.binding", .path = if (absolute) binding[4..] else null, .status = if (absolute) pathStatus(binding[4..], false, "missing") else "unknown", .source = "recorded-registration", .reason = if (absolute) "historical manager binding; current self location reported separately" else "registered by name; current shell resolution is not observed", .id = field.name });
                }
            }
        }
    }
    fn resolveEffective(q: *Query, opts: select.Options) Effective {
        var result = Effective{};
        if (!q.complete) {
            result.reason = "incomplete-storage-query";
            return result;
        }
        const raw = q.metadata(&.{ "state", "selection.json" }, 1 << 20) catch |err| {
            q.fail(problem(err), "selection", q.ctx.path(&.{ "state", "selection.json" }), @errorName(err));
            result.reason = "invalid-selection";
            return result;
        };
        const stored: ?select.Selection = if (raw) |bytes| switch (select.parseSelection(q.ctx.a, bytes)) {
            .ok => |s| s,
            .err => {
                q.fail("invalid-selection", "selection", q.ctx.path(&.{ "state", "selection.json" }), "cannot parse persistent selection; no fallback");
                result.reason = "invalid-selection";
                return result;
            },
        } else null;
        const channel_raw = q.metadata(&.{ "state", "channel" }, 64) catch |err| {
            q.fail(problem(err), "channel", q.ctx.path(&.{ "state", "channel" }), @errorName(err));
            return result;
        };
        const channel = if (channel_raw != null and eq(u8, std.mem.trim(u8, channel_raw.?, " \t\r\n"), "live")) "live" else "release";
        const all = q.bundles();
        var effective = opts;
        var picked: [2]?snapshot.Meta = .{ null, null };
        var inventories: [2][]snapshot.Meta = undefined;
        for (std.enums.values(snapshot.Kind), 0..) |kind, n| {
            const inventory = q.snapshots(kind);
            inventories[n] = inventory;
            const single = if (kind == .plugins) opts.snapshot else opts.config_snapshot;
            const fixed = if (!opts.overridesSnapshots() and stored != null) @import("manage.zig").snapshotChoice(stored.?, kind) else null;
            if (single orelse fixed) |query| picked[n] = snapshot.lookup(q.ctx, inventory, query) catch |err| {
                q.fail("invalid-snapshot-reference", "snapshot", null, @errorName(err));
                result.reason = "invalid-snapshot-reference";
                return result;
            };
            if (single != null) {
                if (kind == .plugins) effective.snapshot = picked[n].?.id else effective.config_snapshot = picked[n].?.id;
            }
        }
        const resolved = select.resolve(.{ .opts = effective, .bundles = all, .channel = channel, .selection_use = if (stored) |s| s.use else null });
        if (resolved == .err) {
            if (all.len == 0 and !opts.overridesSnapshots() and (stored == null or eq(u8, stored.?.use, "latest")) and q.complete) {
                result.status = "empty";
                result.reason = "no-installed-runtime";
                return result;
            }
            const why = @tagName(resolved.err);
            q.fail(why, "effective", null, "runtime intent cannot be resolved; no fallback or initialization");
            result.reason = why;
            return result;
        }
        const id = resolved.ok.version;
        const m = runtimes.metaOf(all, id) orelse {
            q.fail("invalid-runtime", "runtime", null, "invalid runtime metadata");
            return result;
        };
        if (m.format != .runtime_v1 or m.protocol != select.protocol or m.entry == null or !eq(u8, pathStatus(q.ctx.path(&.{ "bundles", id, m.entry orelse "" }), false, "missing"), "exists")) {
            q.fail("unstartable-runtime", "runtime", q.ctx.path(&.{ "bundles", id }), "runtime format/protocol/entry cannot start; not executed");
            result.reason = "unstartable-runtime";
            return result;
        }
        result.runtime = .{ .id = id, .path = q.ctx.path(&.{ "bundles", id }), .source = if (opts.use != null) "explicit-use" else if (opts.snapshot != null or opts.config_snapshot != null) "explicit-snapshot" else if (stored != null) "persistent-use" else "default-latest" };
        for (std.enums.values(snapshot.Kind), 0..) |kind, n| {
            const single = if (kind == .plugins) opts.snapshot else opts.config_snapshot;
            const fixed = if (!opts.overridesSnapshots() and stored != null) @import("manage.zig").snapshotChoice(stored.?, kind) else null;
            const s = picked[n] orelse snapshot.newest(inventories[n], id) orelse {
                // Enumeration succeeded. A missing default is a valid gap, not damaged storage;
                // only a later launch may initialize it, never this read-only query.
                result.reason = "snapshot-not-created";
                return result;
            };
            const choice = Choice{ .id = s.id, .path = q.ctx.path(&.{ kind.root(), s.id }), .source = if (single != null) "explicit-snapshot" else if (fixed != null) "persistent-snapshot" else "default-latest" };
            if (kind == .plugins) result.plugins = choice else result.config = choice;
        }
        const wanted = (if (opts.addons.len != 0) addons.option(opts.addons) else addons.storedChoice(stored)) catch |err| {
            q.fail("invalid-addon-reference", "addon", null, @errorName(err));
            return result;
        };
        if (wanted == null or !eq(u8, wanted.?, "none")) {
            const local = q.office();
            const bytes = q.metadata(&.{ "bundles", id, "bundle.json" }, 1 << 20) catch |err| {
                q.fail(problem(err), "runtime", null, @errorName(err));
                return result;
            };
            if (bytes) |b| {
                const table = addons.parseTable(q.ctx, b) catch null;
                if (table) |t| if (addons.candidate(t, local, wanted)) |a| {
                    if (addons.compatible(t, a.slot)) result.addons.office = .{ .id = a.version, .path = q.ctx.path(&.{ "addons", "office", a.version }), .source = if (opts.addons.len != 0) "explicit-addon" else if (wanted != null) "persistent-addon" else "default-compatible" };
                };
            }
        }
        if (!q.complete) {
            result.reason = "incomplete-storage-query";
            return result;
        }
        result.status = "resolved";
        return result;
    }
};

pub fn run(ctx: *Ctx, opts: select.Options, args: []const []const u8) u8 {
    var q = Query{ .ctx = ctx };
    defer if (q.data) |*d| d.close();
    var positional: std.ArrayList([]const u8) = .empty;
    var json = false;
    for (args) |arg| {
        if (eq(u8, arg, "--json") and !json) json = true else positional.append(ctx.a, arg) catch util.oom();
    }
    const scope = if (positional.items.len == 0) Scope.overview else std.meta.stringToEnum(Scope, positional.items[0]) orelse Scope.overview;
    const count = if (positional.items.len == 0) 0 else positional.items.len - 1;
    const rest = if (positional.items.len == 0) &.{} else positional.items[1..];
    if ((scope == .overview and positional.items.len != 0) or count > 2 or (scope != .snapshot and count > @as(usize, if (scope == .runtime or scope == .addon or scope == .completion) 1 else 0))) {
        q.fail("invalid-query", "path", null, "use path [self|home|runtime [version]|snapshot [plugins|config] [id]|addon [office[:version]]|cache|tmp|completion [shell]] [--json]");
    } else {
        if (scope != .home) q.claimReadRoot();
        q.static(scope);
        switch (scope) {
            .runtime => q.runtimeRows(if (count == 1) rest[0] else null),
            .snapshot => {
                const kind = if (count > 0) std.meta.stringToEnum(snapshot.Kind, rest[0]) else null;
                if (count > 0 and kind == null) q.fail("invalid-query", "snapshot", null, "an explicit snapshot target requires plugins|config") else q.snapshotRows(kind, if (count == 2) rest[1] else null);
            },
            .addon => q.addonRows(if (count == 1) rest[0] else null),
            .completion => {
                const shell = if (count == 1) std.meta.stringToEnum(completion.Shell, rest[0]) else null;
                if (count == 1 and shell == null) q.fail("invalid-target", "completion", null, "unsupported completion shell") else q.completionRows(shell);
            },
            else => {},
        }
    }
    const effective: ?Effective = if (scope == .overview and positional.items.len == 0) q.resolveEffective(opts) else null;
    std.mem.sort(Record, q.records.items, {}, struct {
        fn less(_: void, x: Record, y: Record) bool {
            for ([_][2][]const u8{ .{ x.role, y.role }, .{ if (x.kind) |k| @tagName(k) else "", if (y.kind) |k| @tagName(k) else "" }, .{ x.id orelse "", y.id orelse "" }, .{ x.path orelse "", y.path orelse "" } }) |pair| {
                const order = std.mem.order(u8, pair[0], pair[1]);
                if (order != .eq) return order == .lt;
            }
            return false;
        }
    }.less);
    if (json) {
        const out = std.json.Stringify.valueAlloc(ctx.a, .{ .schemaVersion = @as(u32, 1), .scope = @tagName(scope), .complete = q.complete, .records = q.records.items, .effective = effective, .diagnostics = q.diagnostics.items }, .{}) catch util.oom();
        util.print("{s}\n", .{out});
    } else {
        for (q.records.items) |r| util.print("{s} {s} [{s}] source={s} {s} {s}\n", .{ r.role, r.path orelse "unknown", r.status, r.source, r.id orelse "", r.reason });
        if (effective) |e| {
            util.print("effective: {s} {s}\n", .{ e.status, e.reason orelse "" });
            inline for (.{ "runtime", "plugins", "config" }) |name| if (@field(e, name)) |c| util.print("  {s}: {s} {s} ({s})\n", .{ name, c.id, c.path, c.source });
            if (e.addons.office) |a| util.print("  office: {s} {s} ({s})\n", .{ a.id, a.path, a.source });
        }
        for (q.diagnostics.items) |d| util.warn("path {s}: {s} {s}", .{ d.code, d.path orelse "", d.message });
    }
    return if (q.complete) 0 else 1;
}
