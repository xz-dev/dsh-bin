//! Office addon policy belongs to the manager; runtime consumes only the resolved directory.
const std = @import("std");
const util = @import("util.zig");
const index = @import("index.zig");
const select = @import("select.zig");
const state = @import("state.zig");
const runtimes = @import("runtimes.zig");
const lock = @import("lock.zig");
const http = @import("http.zig");
const Ctx = @import("context.zig").Ctx;
const eq = std.mem.eql;
pub const Slot = struct { commit: []const u8, kitVersion: []const u8 };
pub const Release = struct { version: []const u8, tag: []const u8, slot: Slot, seq: u64 = 0, assets: std.json.ArrayHashMap(index.Asset) };
pub const Table = struct { slot: ?Slot = null, pinned: ?[]const u8 = null, known: []Release = &.{} };
pub const Meta = struct { name: []const u8, version: []const u8, tag: []const u8, slot: Slot, kitVersion: []const u8, platform: []const u8, packages: []const []const u8, seq: u64 = 0 };
pub const Launch = struct { office: ?struct { version: []const u8, dir: []const u8 } = null };

fn valid(r: Release) bool {
    return index.component(r.version) and
        std.mem.startsWith(u8, r.tag, "addon-office-v") and eq(u8, r.tag[14..], r.version) and validSlot(r.slot);
}
fn validSlot(s: Slot) bool {
    if (s.commit.len != 40 or !index.component(s.kitVersion)) return false;
    for (s.commit) |c| if (!std.ascii.isHex(c)) return false;
    return true;
}
fn compatible(t: Table, s: Slot) bool {
    return if (t.slot) |slot| eq(u8, slot.commit, s.commit) else false;
}
pub fn table(ctx: *const Ctx, version: []const u8) !Table {
    const bytes = try std.fs.cwd().readFileAlloc(ctx.a, ctx.path(&.{ "bundles", version, "bundle.json" }), 1 << 20);
    const M = struct { addons: struct { office: Table } };
    const m = try std.json.parseFromSliceLeaky(M, ctx.a, bytes, .{ .ignore_unknown_fields = true });
    if (m.addons.office.slot) |s| if (!validSlot(s)) return error.InvalidAddonSlot;
    for (m.addons.office.known) |r| if (!valid(r)) return error.InvalidAddonTable;
    return m.addons.office;
}
pub fn runtime(ctx: *const Ctx, opts: select.Options) ![]const u8 {
    const stored = state.readSelection(ctx);
    if (stored == .invalid) return error.InvalidSelection;
    return switch (select.resolve(.{ .opts = opts, .bundles = runtimes.list(ctx), .channel = state.channel(ctx), .selection_use = if (stored == .ok) stored.ok.use else null })) {
        .ok => |r| r.version,
        .err => error.NoSelectedRuntime,
    };
}
pub fn request(raw: []const u8) !?[]const u8 {
    if (eq(u8, raw, "office")) return null;
    if (!std.mem.startsWith(u8, raw, "office:")) return error.InvalidAddonRequest;
    const v = raw[7..];
    if (!index.component(v)) return error.InvalidAddonRequest;
    const version = if (std.mem.startsWith(u8, v, "addon-office-v")) v[14..] else v;
    if (!index.component(version)) return error.InvalidAddonRequest;
    return version;
}
pub fn option(opts: []const []const u8) !?[]const u8 {
    if (opts.len == 0) return null;
    var chosen: ?[]const u8 = null;
    for (opts) |raw| chosen = (try request(raw)) orelse return error.AddonVersionRequired;
    return chosen;
}
fn remote(ctx: *const Ctx, bytes: []const u8) ![]Release {
    const I = struct { schema: u32, channels: struct { release: []std.json.Value, live: []std.json.Value }, addons: struct { office: []std.json.Value } };
    const i = try std.json.parseFromSliceLeaky(I, ctx.a, bytes, .{ .ignore_unknown_fields = true });
    if (i.schema != 1) return error.InvalidRuntimeIndex;
    var out: std.ArrayList(Release) = .empty;
    for (i.addons.office) |v| {
        if (v == .object) if (v.object.get("kind")) |k| if (k != .string or !eq(u8, k.string, "dsh-addon")) continue;
        const r = std.json.parseFromValueLeaky(Release, ctx.a, v, .{ .ignore_unknown_fields = true }) catch continue;
        if (valid(r)) try out.append(ctx.a, r);
    }
    return out.items;
}
fn same(a: Release, b: Release) bool {
    if (!eq(u8, a.tag, b.tag) or !eq(u8, a.slot.commit, b.slot.commit)) return false;
    var it = a.assets.map.iterator();
    while (it.next()) |e| if (b.assets.map.get(e.key_ptr.*)) |asset| {
        if (asset.size != e.value_ptr.size or !eq(u8, asset.name, e.value_ptr.name) or !eq(u8, asset.sha256, e.value_ptr.sha256)) return false;
    };
    return true;
}
pub fn available(ctx: *const Ctx, t: Table, bytes: []const u8) ![]Release {
    const list = try remote(ctx, bytes);
    var out: std.ArrayList(Release) = .empty;
    const p = try platform(ctx);
    const expected = try std.fmt.allocPrint(ctx.a, "dsh-addon-office-{s}.zip", .{p});
    for (list) |r| if (compatible(t, r.slot)) {
        const asset = r.assets.map.get(p) orelse continue;
        if (!eq(u8, asset.name, expected) or asset.size == 0 or asset.sha256.len != 64) continue;
        var digest: [32]u8 = undefined;
        _ = std.fmt.hexToBytes(&digest, asset.sha256) catch continue;
        try out.append(ctx.a, r);
    };
    return out.items;
}
fn platform(ctx: *const Ctx) ![]const u8 {
    const host = try @import("target.zig").host();
    if (std.mem.startsWith(u8, host, "linux-")) return "linux";
    var parts = std.mem.splitScalar(u8, host, '-');
    return std.fmt.allocPrint(ctx.a, "{s}-{s}", .{ parts.next().?, parts.next().? });
}
pub fn readIn(ctx: *const Ctx, parent: std.fs.Dir, path: []const u8, version: []const u8) !Meta {
    var d = try parent.openDir(path, .{ .iterate = true, .no_follow = true });
    defer d.close();
    if ((try d.stat()).kind != .directory) return error.AddonDirectoryConflict;
    const bytes = try d.readFileAlloc(ctx.a, "addon.json", 1 << 20);
    const m = try std.json.parseFromSliceLeaky(Meta, ctx.a, bytes, .{ .ignore_unknown_fields = true });
    if (!eq(u8, m.name, "office") or !eq(u8, m.version, version) or !valid(.{ .version = m.version, .tag = m.tag, .slot = m.slot, .assets = .{} }) or !eq(u8, m.kitVersion, m.slot.kitVersion) or !eq(u8, m.platform, try platform(ctx))) return error.InvalidAddonMetadata;
    return m;
}
fn openOffice(ctx: *const Ctx) !?std.fs.Dir {
    var parent = std.fs.cwd().openDir(ctx.path(&.{"addons"}), .{ .no_follow = true }) catch |err| if (err == error.FileNotFound) return null else return err;
    defer parent.close();
    if ((try parent.stat()).kind != .directory) return error.AddonDirectoryConflict;
    var dir = parent.openDir("office", .{ .iterate = true, .no_follow = true }) catch |err| if (err == error.FileNotFound) return null else return err;
    errdefer dir.close();
    if ((try dir.stat()).kind != .directory) return error.AddonDirectoryConflict;
    return dir;
}
pub fn local(ctx: *const Ctx) ![]Meta {
    var dir = try openOffice(ctx) orelse return &.{};
    defer dir.close();
    return localIn(ctx, dir);
}
fn localIn(ctx: *const Ctx, dir: std.fs.Dir) ![]Meta {
    var out: std.ArrayList(Meta) = .empty;
    var it = dir.iterate();
    while (try it.next()) |e| {
        if (eq(u8, e.name, ".DS_Store") or std.mem.startsWith(u8, e.name, "._") or std.ascii.eqlIgnoreCase(e.name, "Thumbs.db") or std.ascii.eqlIgnoreCase(e.name, "desktop.ini")) continue;
        if (!index.component(e.name) or e.kind != .directory) return error.AddonDirectoryConflict;
        try out.append(ctx.a, try readIn(ctx, dir, e.name, e.name));
    }
    std.mem.sort(Meta, out.items, {}, struct {
        fn less(_: void, a: Meta, b: Meta) bool {
            return a.seq < b.seq or (a.seq == b.seq and std.mem.order(u8, a.version, b.version) == .lt);
        }
    }.less);
    return out.items;
}
pub fn install(ctx: *Ctx, raw: []const u8, force: bool, opts: select.Options) u8 {
    const query = request(raw) catch |err| util.fatal("invalid addon: {s}", .{@errorName(err)});
    if (query != null and eq(u8, query.?, "none")) util.fatal("office:none is a launch/selection choice, not an install target", .{});
    const v = runtime(ctx, opts) catch |err| util.fatal("cannot choose runtime for addon: {s}; install/select a runtime first", .{@errorName(err)});
    const t = table(ctx, v) catch |err| util.fatal("cannot read office addon table: {s}", .{@errorName(err)});
    ctx.ensureData();
    const mutex = state.maintenance(ctx) catch |err| util.fatal("cannot acquire maintenance lock: {s}; retry", .{@errorName(err)});
    defer mutex.release();
    perform(ctx, t, query, force) catch |err| {
        if (err == error.UsageReported) return 1;
        util.fatal("office addon install failed: {s}; selection and channel unchanged", .{@errorName(err)});
    };
    return 0;
}
fn perform(ctx: *Ctx, t: Table, query: ?[]const u8, force: bool) !void {
    const endpoints = http.endpoints(ctx.a, &ctx.env);
    defer endpoints.deinit(ctx.a);
    const bytes = http.fetchSmall(ctx.a, &ctx.env, endpoints.runtime_index, 16 << 20) catch |err| blk: {
        util.warn("cannot read addon index: {s}; using embedded addon table", .{@errorName(err)});
        break :blk null;
    };
    const online = if (bytes) |b| try remote(ctx, b) else &.{};
    var chosen: ?Release = null;
    if (query) |q| {
        for (t.known) |r| if (eq(u8, r.version, q) or eq(u8, r.tag, q)) {
            chosen = r;
            break;
        };
        for (online) |r| if (eq(u8, r.version, q) or eq(u8, r.tag, q)) {
            if (chosen) |old| {
                if (!same(old, r)) return error.AddonTableConflict;
            }
            chosen = r;
            break;
        };
    } else {
        for (online) |r| if (compatible(t, r.slot) and (chosen == null or r.seq > chosen.?.seq)) {
            chosen = r;
        };
        if (chosen == null) if (t.pinned) |pin| {
            for (t.known) |r| if (eq(u8, r.version, pin)) {
                chosen = r;
                break;
            };
        };
    }
    const c = chosen orelse return error.NoAddonCandidate;
    for (t.known) |r| if (eq(u8, r.version, c.version) and !same(r, c)) return error.AddonTableConflict;
    if (!compatible(t, c.slot)) {
        util.warn("office addon {s} is incompatible with this runtime slot; --force never bypasses slot compatibility", .{c.version});
        return error.IncompatibleSlot;
    }
    const p = try platform(ctx);
    const asset = c.assets.map.get(p) orelse return error.NoAddonAsset;
    const expected = try std.fmt.allocPrint(ctx.a, "dsh-addon-office-{s}.zip", .{p});
    if (!eq(u8, asset.name, expected) or asset.size == 0 or asset.sha256.len != 64) return error.InvalidAddonAsset;
    var digest: [32]u8 = undefined;
    _ = try std.fmt.hexToBytes(&digest, asset.sha256);
    var parent = ctx.ensureDir(&.{ "addons", "office" });
    defer parent.close();
    var tmp = ctx.ensureDir(&.{"tmp"});
    defer tmp.close();
    const installer = @import("install.zig");
    const backup = try std.fmt.allocPrint(ctx.a, ".previous-addon-office-{s}", .{c.version});
    // Mirror runtime install recovery under maintenance: never discard the only validated generation.
    if (installer.existsIn(tmp, backup)) {
        _ = try readIn(ctx, tmp, backup, c.version);
        if (!installer.existsIn(parent, c.version)) try std.fs.rename(tmp, backup, parent, c.version);
    }
    const exists = installer.existsIn(parent, c.version);
    if (exists) _ = try readIn(ctx, parent, c.version, c.version);
    if (exists and !force) {
        var current = try parent.openDir(c.version, .{ .no_follow = true });
        defer current.close();
        var modules = try current.openDir("node_modules", .{ .no_follow = true });
        modules.close();
        util.print("The office addon {s} is already installed.\n", .{c.version});
        return;
    }
    if (exists) try installer.checkIdle(parent, c.version, "office addon");
    const staging = try installer.fetchTree(ctx, tmp, asset, c.tag);
    defer tmp.deleteTree(staging) catch |err| util.warn("leftover tmp/{s} could not be deleted ({s}); run `dsh manager clean`", .{ staging, @errorName(err) });
    const m = try readIn(ctx, tmp, staging, c.version);
    var d = try tmp.openDir(staging, .{ .iterate = true, .no_follow = true });
    var d_open = true;
    defer if (d_open) d.close();
    var modules = try d.openDir("node_modules", .{ .no_follow = true });
    modules.close();
    if (!eq(u8, m.tag, c.tag) or !eq(u8, m.slot.commit, c.slot.commit) or !eq(u8, m.kitVersion, c.slot.kitVersion)) return error.AddonMetadataMismatch;
    var it = d.iterate();
    while (try it.next()) |e| if (!eq(u8, e.name, "addon.json") and !eq(u8, e.name, "node_modules")) {
        return error.UnexpectedAddonRoot;
    };
    var installed = m;
    installed.seq = c.seq;
    try d.writeFile(.{ .sub_path = "addon.json", .data = try std.json.Stringify.valueAlloc(ctx.a, installed, .{}) });
    try d.writeFile(.{ .sub_path = runtimes.guard_name, .data = "" });
    d.close();
    d_open = false;
    try installer.activate(ctx, tmp, staging, parent, c.version, backup, exists);
    util.print("Installed the office addon {s}; selection unchanged.\n", .{c.version});
}
pub fn storedChoice(s: ?select.Selection) !?[]const u8 {
    if (s) |sel| {
        const v = sel.value.object.get("addons") orelse return null;
        if (v != .object) return error.InvalidAddonSelection;
        const office = v.object.get("office") orelse return null;
        if (office != .string or !index.component(office.string)) return error.InvalidAddonSelection;
        return office.string;
    }
    return null;
}
pub fn resolve(ctx: *const Ctx, v: []const u8, opts: []const []const u8, s: ?select.Selection) Launch {
    const wanted = (if (opts.len != 0) option(opts) else storedChoice(s)) catch |err| util.fatal("invalid office addon choice: {s}", .{@errorName(err)});
    if (wanted) |w| if (eq(u8, w, "none")) return .{};
    const t = table(ctx, v) catch |err| {
        util.warn("office addon unavailable ({s}); launching without it", .{@errorName(err)});
        return .{};
    };
    const installed = local(ctx) catch |err| {
        util.warn("office addon storage unavailable ({s}); launching without it", .{@errorName(err)});
        return .{};
    };
    var chosen: ?Meta = null;
    for (installed) |m| {
        if (wanted) |w| {
            if (eq(u8, w, m.version)) {
                chosen = m;
                break;
            }
        } else if (compatible(t, m.slot)) {
            chosen = m;
        }
    }
    if (chosen) |m| {
        if (compatible(t, m.slot)) return .{ .office = .{ .version = m.version, .dir = ctx.path(&.{ "addons", "office", m.version }) } };
        util.warn("office addon {s} is incompatible with runtime {s}; launching without it", .{ m.version, v });
    } else if (wanted) |w| util.warn("office addon {s} is missing; launching without it; run `dsh manager install --addon office:{s}`", .{ w, w });
    return .{};
}
pub fn validateChoice(ctx: *const Ctx, v: []const u8, choice: ?[]const u8) !void {
    const q = choice orelse return;
    if (eq(u8, q, "none")) return;
    const t = try table(ctx, v);
    for (try local(ctx)) |m| if (eq(u8, m.version, q)) {
        if (!compatible(t, m.slot)) return error.IncompatibleSlot;
        return;
    };
    return error.AddonNotInstalled;
}
pub fn uninstall(ctx: *Ctx, raw: []const u8) u8 {
    const query = request(raw) catch |err| util.fatal("invalid addon: {s}", .{@errorName(err)});
    ctx.ensureData();
    const mutex = state.maintenance(ctx) catch |err| util.fatal("cannot acquire maintenance lock: {s}; retry", .{@errorName(err)});
    defer mutex.release();
    var dir = (openOffice(ctx) catch |err| util.fatal("cannot read addon storage: {s}; nothing uninstalled", .{@errorName(err)})) orelse return 0;
    defer dir.close();
    const list = localIn(ctx, dir) catch |err| util.fatal("cannot read addon storage: {s}; nothing uninstalled", .{@errorName(err)});
    const stored = state.readSelection(ctx);
    if (stored == .invalid) util.fatal("invalid selection; reset with `dsh manager select --use latest` before uninstalling", .{});
    const pin = storedChoice(if (stored == .ok) stored.ok else null) catch |err| util.fatal("invalid addon selection: {s}", .{@errorName(err)});
    const claims = ctx.a.alloc(?lock.Lock, list.len) catch util.oom();
    @memset(claims, null);
    defer for (claims) |c| if (c) |l| l.release();
    var failures: std.ArrayList(u8) = .empty;
    for (list, claims) |m, *c| if (query == null or eq(u8, query.?, m.version)) {
        if (pin) |p| if (eq(u8, p, m.version)) failures.print(ctx.a, "office:{s} (named by selection); ", .{m.version}) catch util.oom();
        c.* = lock.tryAcquireIn(dir, util.join(ctx.a, &.{ m.version, runtimes.guard_name }), .exclusive, false) catch |err| {
            if (err != error.Missing) failures.print(ctx.a, "office:{s} ({s}); ", .{ m.version, if (err == error.Busy) "in use" else @errorName(err) }) catch util.oom();
            continue;
        };
    };
    if (failures.items.len != 0) util.fatal("cannot uninstall addons: {s}nothing uninstalled; reset selection or retry after sessions exit", .{failures.items});
    // Test-only stdin barrier matches the snapshot ancestor-swap regression.
    if (eq(u8, ctx.env.get("DSH_MANAGER_TEST") orelse "", "1") and eq(u8, ctx.env.get("DSH_MANAGER_TEST_PAUSE") orelse "", "addon-remove")) {
        util.warn("test pause: addon-remove", .{});
        util.flush();
        var byte: [1]u8 = undefined;
        if ((std.fs.File.stdin().read(&byte) catch 0) == 0) util.fatal("test pause aborted", .{});
    }
    for (list, claims) |m, *c| if (query == null or eq(u8, query.?, m.version)) {
        @import("install.zig").remove(ctx, dir, m.version, c) catch |err| {
            if (err == error.UsageReported) return 1;
            util.fatal("cannot remove office addon {s}: {s}; earlier reported removals remain removed", .{ m.version, @errorName(err) });
        };
        util.print("Uninstalled the office addon {s}.\n", .{m.version});
        util.flush(); // Keep completed removals visible if a later item fails.
    };
    return 0;
}
