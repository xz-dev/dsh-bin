//! Starting a runtime (design D3/D4): resolve the runtime from the leading options and the selection,
//! build `DSH_MANAGER_LAUNCH` and the child environment, take the usage claim, and run the runtime entry
//! with the remaining arguments, returning its exit status unchanged. No fallback to another version.
const std = @import("std");
const builtin = @import("builtin");
const util = @import("util.zig");
const select = @import("select.zig");
const runtimes = @import("runtimes.zig");
const state = @import("state.zig");
const lock = @import("lock.zig");
const snapshot = @import("snapshot.zig");
const options = @import("build_options");
const Ctx = @import("context.zig").Ctx;
const is_windows = builtin.os.tag == .windows;

/// Variables the runtime must not inherit: dsh-tui's standalone self-update markers and Bun's
/// "act as bun" switch (the runtime sets that itself only for its embedded pnpm and node shims).
pub const cleared_vars = [_][]const u8{ "DSH_TUI_STANDALONE", "DSH_TUI_STANDALONE_BINARY", "BUN_BE_BUN" };

pub const Plan = struct {
    runtime: []const u8,
    entry: []const u8,
    /// Leading arguments consumed by `--use/--snapshot/--addon`.
    consumed: usize,
    payload: []const u8,
    snapshot: snapshot.Snapshot,
};

pub fn parseLeading(a: std.mem.Allocator, args: []const []const u8) select.Options {
    return switch (select.parseLeading(a, args) catch util.oom()) {
        .ok => |o| o,
        .err => |e| switch (e.kind) {
            .missing_value => util.fatal("{s} needs a value", .{e.option}),
            .repeated => util.fatal("{s} can be given only once", .{e.option}),
        },
    };
}

fn reportResolution(f: select.Failure) noreturn {
    switch (f) {
        .not_installed => |n| switch (n.source) {
            .selection => util.fatal("the selected version {s} is not installed; run `dsh manager install {s}`, or `dsh manager select --use latest`", .{ n.query, n.query }),
            .snapshot => util.fatal("version {s} of the snapshot is not installed; run `dsh manager install {s}`, or choose a version with --use", .{ n.query, n.query }),
            .use => util.fatal("version {s} is not installed; run `dsh manager install {s}`", .{ n.query, n.query }),
        },
        .ambiguous => |m| util.fatal("version {s} is ambiguous ({s}, {s}, ...); give more of the version", .{ m.query, m.candidates[0], m.candidates[1] }),
        .bad_snapshot_id => |id| util.fatal("invalid snapshot id {s}; expected <version>@<n|name>", .{id}),
        .none_installed => |c| util.fatal("no {s}-channel dsh runtime is installed; run `dsh manager update` to install one", .{c}),
        .unordered => |v| util.fatal("dsh {s} is not a runtime this manager can order; reinstall it with `dsh manager install {s} --force`, or remove it with `dsh manager uninstall {s}`", .{ v, v, v }),
    }
}

/// Decide which runtime runs the arguments `args` (leading options included).
pub fn plan(ctx: *Ctx, args: []const []const u8) Plan {
    const opts = parseLeading(ctx.a, args);
    var bundles = runtimes.list(ctx);
    const sel = state.readSelection(ctx);
    const selection = switch (sel) {
        .none => null,
        .ok => |s| s,
        .invalid => |why| util.fatal("cannot use the selection {s} ({s}); run `dsh manager select --use latest` to reset it", .{ state.selectionPath(ctx), why }),
    };
    const stored_snapshot: ?snapshot.Snapshot = if (opts.use == null and opts.snapshot == null and selection != null) blk: {
        const id = @import("manage.zig").snapshotChoice(selection.?) orelse break :blk null;
        break :blk snapshot.existing(ctx, id) catch |err|
            util.fatal("cannot use selected snapshot {s}: {s}; run `dsh manager select --use latest` to reset it", .{ id, @errorName(err) });
    } else null;
    if (bundles.len == 0 and opts.use == null and opts.snapshot == null and
        (selection == null or std.mem.eql(u8, selection.?.use, "latest")))
    {
        @import("install.zig").bootstrap(ctx);
        bundles = runtimes.list(ctx);
    }
    const explicit_snapshot = if (opts.snapshot) |id| blk: {
        if (select.snapshotVersion(id) == null) reportResolution(.{ .bad_snapshot_id = id });
        break :blk snapshot.existing(ctx, id) catch |err| {
            // Preserve the missing-runtime diagnostic before reporting a missing snapshot.
            const preliminary = select.resolve(.{ .opts = opts, .bundles = bundles, .channel = state.channel(ctx) });
            if (preliminary == .err) reportResolution(preliminary.err);
            util.fatal("cannot use snapshot {s}: {s}; run `dsh manager snapshot list`", .{ id, @errorName(err) });
        };
    } else null;
    var effective = opts;
    if (explicit_snapshot) |s| effective.snapshot = s.id;
    const resolved = switch (select.resolve(.{
        .opts = effective,
        .bundles = bundles,
        .channel = state.channel(ctx),
        .selection_use = if (selection) |s| s.use else null,
    })) {
        .ok => |r| r,
        .err => |f| reportResolution(f),
    };
    const entry = switch (runtimes.check(ctx, bundles, resolved.version)) {
        .ok => |p| p,
        else => |p| runtimes.report(resolved.version, p),
    };
    const snap = explicit_snapshot orelse stored_snapshot orelse
        snapshot.prepare(ctx, resolved.version, runtimes.metaOf(bundles, resolved.version).?);
    const payload = std.json.Stringify.valueAlloc(ctx.a, .{
        .protocol = select.protocol,
        .runtime = resolved.version,
        .source = @tagName(resolved.source),
        .dataRoot = ctx.data,
        .home = ctx.home(),
        .snapshot = snap,
        .addons = @import("addons.zig").resolve(ctx, resolved.version, opts.addons, selection),
        .cache = ctx.path(&.{"cache"}),
        .tmp = ctx.path(&.{"tmp"}),
        .manager = options.version,
    }, .{ .emit_null_optional_fields = false }) catch util.oom();
    return .{ .runtime = resolved.version, .entry = entry, .consumed = opts.consumed, .payload = payload, .snapshot = snap };
}

fn childEnv(ctx: *Ctx, p: Plan) void {
    for (cleared_vars) |name| ctx.env.remove(name);
    ctx.env.remove("DSH_BIN_LAUNCH");
    ctx.env.put("DSH_HOME", ctx.home()) catch util.oom();
    ctx.env.put("DSH_MANAGER_LAUNCH", p.payload) catch util.oom();
    // Bun 1.4.2 and bundled pnpm honour these specific variables (real-runtime acceptance probes them).
    const paths = .{
        .{ "BUN_INSTALL_CACHE_DIR", &.{ "cache", "bun" } },
        .{ "BUN_RUNTIME_TRANSPILER_CACHE_PATH", &.{ "cache", "transpiler" } },
        .{ "npm_config_cache", &.{ "cache", "npm" } },
        .{ "pnpm_config_store_dir", &.{ "cache", "pnpm", "store" } },
        .{ "pnpm_config_cache_dir", &.{ "cache", "pnpm", "cache" } },
        .{ "pnpm_config_state_dir", &.{ "state", "pnpm" } },
        .{ "PNPM_HOME", &.{ "cache", "pnpm", "home" } },
        .{ "TMPDIR", &.{"tmp"} },
        .{ "TEMP", &.{"tmp"} },
        .{ "TMP", &.{"tmp"} },
    };
    inline for (paths) |pair| {
        var dir = ctx.ensureDir(pair[1]);
        dir.close();
        ctx.env.remove(pair[0]); // Windows EnvMap preserves spelling; canonical keys matter to pnpm.
        ctx.env.put(pair[0], ctx.path(pair[1])) catch util.oom();
    }
}

/// Shared claim on the runtime's guard; a busy guard means it is being replaced or removed.
fn claim(ctx: *Ctx, runtime: []const u8) void {
    const guard = ctx.path(&.{ "bundles", runtime, runtimes.guard_name });
    var attempt: usize = 0;
    while (attempt < 100) : (attempt += 1) {
        _ = lock.tryAcquire(guard, .shared, false) catch |err| switch (err) {
            error.Busy => {
                std.Thread.sleep(100 * std.time.ns_per_ms);
                continue;
            },
            // A runtime without its guard is not one the manager installed; run it unprotected.
            else => return,
        };
        return; // held for the process (POSIX: inherited by the exec'd runtime)
    }
    util.fatal("dsh {s} is being replaced or removed; try again", .{runtime});
}

pub fn run(ctx: *Ctx, args: []const []const u8) noreturn {
    ctx.ensureData();
    @import("first_run.zig").run(ctx);
    const p = plan(ctx, args);
    claim(ctx, p.runtime);
    _ = lock.tryAcquire(util.join(ctx.a, &.{ p.snapshot.dir, ".usage.lock" }), .shared, false) catch |err|
        util.fatal("cannot claim snapshot {s}: {s}", .{ p.snapshot.id, @errorName(err) });
    childEnv(ctx, p);
    if (is_windows) runWindows(ctx, p) else runPosix(ctx, p);
}

fn runPosix(ctx: *Ctx, p: Plan) noreturn {
    util.flush();
    const envp = std.process.createNullDelimitedEnvMap(ctx.a, &ctx.env) catch util.oom();
    const raw = std.os.argv;
    const rest = raw[1 + p.consumed ..];
    const argv = ctx.a.allocSentinel(?[*:0]const u8, rest.len + 1, null) catch util.oom();
    const entry_z = ctx.a.dupeZ(u8, p.entry) catch util.oom();
    argv[0] = entry_z.ptr;
    for (rest, 1..) |arg, i| argv[i] = arg;
    const err = std.posix.execveZ(entry_z.ptr, argv.ptr, envp.ptr);
    util.fatal("could not execute {s}: {s}", .{ p.entry, @errorName(err) });
}

const win = std.os.windows;
extern "kernel32" fn GetCommandLineW() callconv(.winapi) [*:0]const u16;

/// Arguments as the C runtime splits them (Windows).
pub fn windowsArgs(a: std.mem.Allocator) []const []const u8 {
    const cmd = std.mem.span(GetCommandLineW());
    var args: std.ArrayList([]const u8) = .empty;
    var it = std.process.ArgIteratorWindows.init(a, cmd) catch util.oom();
    _ = it.skip();
    while (it.next()) |arg| args.append(a, a.dupe(u8, arg) catch util.oom()) catch util.oom();
    return args.items;
}

fn runWindows(ctx: *Ctx, p: Plan) noreturn {
    util.flush();
    const a = ctx.a;
    const cmd = std.mem.span(GetCommandLineW());
    const env_block = std.process.createWindowsEnvBlock(a, &ctx.env) catch util.oom();
    const entry_w = std.unicode.wtf8ToWtf16LeAllocZ(a, p.entry) catch util.fatal("invalid path {s}", .{p.entry});
    // The raw tail after the leading options, so the child sees the user's quoting unchanged.
    const tail = cmd[select.windowsTailOffset(a, cmd, p.consumed) catch util.oom() ..];
    var line: std.ArrayList(u16) = .empty;
    line.append(a, '"') catch util.oom();
    line.appendSlice(a, entry_w) catch util.oom();
    line.append(a, '"') catch util.oom();
    if (tail.len > 0) {
        line.append(a, ' ') catch util.oom();
        line.appendSlice(a, tail) catch util.oom();
    }
    line.append(a, 0) catch util.oom();

    var startup = std.mem.zeroes(win.STARTUPINFOW);
    startup.cb = @sizeOf(win.STARTUPINFOW);
    startup.dwFlags = win.STARTF_USESTDHANDLES;
    startup.hStdInput = win.GetStdHandle(win.STD_INPUT_HANDLE) catch null;
    startup.hStdOutput = win.GetStdHandle(win.STD_OUTPUT_HANDLE) catch null;
    startup.hStdError = win.GetStdHandle(win.STD_ERROR_HANDLE) catch null;
    var info: win.PROCESS_INFORMATION = undefined;
    win.CreateProcessW(entry_w.ptr, @ptrCast(line.items.ptr), null, null, win.TRUE, .{ .create_unicode_environment = true }, @ptrCast(env_block.ptr), null, &startup, &info) catch |err|
        util.fatal("could not execute {s}: {s}", .{ p.entry, @errorName(err) });
    win.CloseHandle(info.hThread);
    win.WaitForSingleObjectEx(info.hProcess, win.INFINITE, false) catch std.process.exit(1);
    var status: win.DWORD = 1;
    if (win.kernel32.GetExitCodeProcess(info.hProcess, &status) == 0) status = 1;
    std.process.exit(@truncate(status));
}
