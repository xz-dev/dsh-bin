//! dsh launcher (design S2). One launcher starts any installed bundle: it parses the leading
//! `--use/--snapshot/--addon` options, reads the selection (`$DSH_HOME/dsh-bin/selection.json`), resolves
//! the version (`select.zig`), and runs `<launcher-dir>/bundles/<version>/dsh-native` with the remaining
//! arguments and `DSH_BIN_LAUNCH`, returning its exit status unchanged. There is no fallback version.
//! Before starting the runtime it takes the shared usage claim on `bundles/<version>/.usage.lock`: on POSIX
//! the flock'd descriptor survives execve, on Windows the launcher holds the lock while it waits for the
//! child. Maintenance commands run on the newest installed bundle without a claim.
const std = @import("std");
const builtin = @import("builtin");
const options = @import("build_options");
const select = @import("select.zig");

/// The build that shipped this launcher, and its channel (the fallback when the install root records no
/// channel). The launcher itself starts any version.
pub const version: []const u8 = options.version;
pub const channel: []const u8 = options.channel;
const is_windows = builtin.os.tag == .windows;
const native_name = if (is_windows) "dsh-native.exe" else "dsh-native";
const guard_name = ".usage.lock";
const managed_suffix = ".managed.lock";

/// Markers the updater reads from the launcher's bytes without executing it: the version of the build that
/// shipped it, and the launcher protocol it implements (a newer protocol replaces the root launcher).
/// NUL-terminated; kept alive by `doNotOptimizeAway` in main.
pub const marker = "DSH_BIN_LAUNCHER_VERSION=" ++ version ++ "\x00";
pub const protocol_marker = std.fmt.comptimePrint("DSH_BIN_LAUNCHER_PROTOCOL={d}\x00", .{select.protocol});

/// Variables the runtime must not inherit: dsh-tui's standalone self-update markers and Bun's
/// "act as bun" switch (the runtime sets that itself only for its embedded pnpm).
pub const cleared_vars = [_][]const u8{ "DSH_TUI_STANDALONE", "DSH_TUI_STANDALONE_BINARY", "BUN_BE_BUN" };

comptime {
    for (version) |c| {
        if (!(std.ascii.isAlphanumeric(c) or c == '.' or c == '-' or c == '+' or c == '_'))
            @compileError("invalid bundle version");
    }
    if (version.len == 0) @compileError("bundle version is required (-Dversion=)");
    if (!std.mem.eql(u8, channel, "release") and !std.mem.eql(u8, channel, "live"))
        @compileError("channel must be release or live (-Dchannel=)");
}

fn fatal(comptime fmt: []const u8, args: anytype) noreturn {
    var buf: [4096]u8 = undefined;
    const msg = std.fmt.bufPrint(&buf, "dsh: " ++ fmt ++ "\n", args) catch "dsh: launcher error\n";
    std.fs.File.stderr().writeAll(msg) catch {};
    std.process.exit(1);
}

fn oom() noreturn {
    fatal("out of memory", .{});
}

// ------------------------------------------------------------------------------------- install root

/// `bundles/*` with their `bundle.json` (null when unreadable or not a JSON object).
fn listBundles(a: std.mem.Allocator, root: []const u8) []select.Bundle {
    const dir_path = std.fs.path.join(a, &.{ root, "bundles" }) catch oom();
    var dir = std.fs.openDirAbsolute(dir_path, .{ .iterate = true }) catch return &.{};
    defer dir.close();
    var list: std.ArrayList(select.Bundle) = .empty;
    var it = dir.iterate();
    while (it.next() catch null) |entry| {
        if (entry.kind != .directory or entry.name[0] == '.') continue;
        const name = a.dupe(u8, entry.name) catch oom();
        const meta_path = std.fs.path.join(a, &.{ name, "bundle.json" }) catch oom();
        const bytes = dir.readFileAlloc(a, meta_path, 16 << 20) catch null;
        list.append(a, .{ .version = name, .meta = if (bytes) |b| select.parseMeta(a, b) else null }) catch oom();
    }
    return list.items;
}

/// Recorded channel (`<root>/channel`), else this launcher's channel.
fn recordedChannel(a: std.mem.Allocator, root: []const u8) []const u8 {
    const path = std.fs.path.join(a, &.{ root, "channel" }) catch oom();
    const bytes = std.fs.cwd().readFileAlloc(a, path, 64) catch return channel;
    const value = std.mem.trim(u8, bytes, " \t\r\n");
    return if (std.mem.eql(u8, value, "release") or std.mem.eql(u8, value, "live")) value else channel;
}

/// The package manager owning this install (`.<manager>.managed.lock` in the install root).
fn managedBy(a: std.mem.Allocator, root: []const u8) ?[]const u8 {
    var dir = std.fs.openDirAbsolute(root, .{ .iterate = true }) catch return null;
    defer dir.close();
    var it = dir.iterate();
    while (it.next() catch null) |entry| {
        if (!std.mem.endsWith(u8, entry.name, managed_suffix)) continue;
        const name = std.mem.trimLeft(u8, entry.name[0 .. entry.name.len - managed_suffix.len], ".");
        if (name.len > 0) return a.dupe(u8, name) catch oom();
    }
    return null;
}

// ---------------------------------------------------------------------------------------- selection

/// The harness home, as upstream resolves it: a non-blank `$DSH_HOME` (with `~` expanded), else `~/.dsh`.
fn dshHome(a: std.mem.Allocator, env: *const std.process.EnvMap) ?[]const u8 {
    const home = env.get(if (is_windows) "USERPROFILE" else "HOME");
    if (env.get("DSH_HOME")) |v| if (std.mem.trim(u8, v, " \t\r\n").len > 0) {
        var path = v;
        if (std.mem.eql(u8, v, "~") or std.mem.startsWith(u8, v, "~/") or std.mem.startsWith(u8, v, "~\\")) {
            const h = home orelse return null;
            path = if (v.len == 1) h else std.fs.path.join(a, &.{ h, v[2..] }) catch oom();
        }
        return std.fs.path.resolve(a, &.{path}) catch oom();
    };
    const h = home orelse return null;
    return std.fs.path.resolve(a, &.{ h, ".dsh" }) catch oom();
}

const SelectionFile = struct { path: ?[]const u8, parsed: ?select.ParsedSelection };

fn readSelection(a: std.mem.Allocator, env: *const std.process.EnvMap, managed: bool) SelectionFile {
    const home = dshHome(a, env) orelse return .{ .path = null, .parsed = null };
    const path = std.fs.path.join(a, &.{ home, "dsh-bin", "selection.json" }) catch oom();
    const bytes = std.fs.cwd().readFileAlloc(a, path, 1 << 20) catch |err| switch (err) {
        error.FileNotFound => return .{ .path = path, .parsed = null },
        else => return .{ .path = path, .parsed = .{ .err = .not_json_object } },
    };
    return .{ .path = path, .parsed = select.parseSelection(a, bytes, managed) };
}

// -------------------------------------------------------------------------------------- decision

const Plan = struct {
    version: []const u8,
    bundle_channel: []const u8,
    claim: bool,
    consumed: usize,
    launch: []const u8,
};

fn reportResolution(f: select.Failure, root: []const u8, chan: []const u8) noreturn {
    switch (f) {
        .not_installed => |n| switch (n.source) {
            .selection => fatal("the selected version {s} is not installed; run `dsh install {s}`, or `dsh select --use latest`", .{ n.query, n.query }),
            .snapshot => fatal("version {s} of the snapshot is not installed; run `dsh install {s}`, or choose a version with --use", .{ n.query, n.query }),
            else => fatal("version {s} is not installed; run `dsh install {s}`", .{ n.query, n.query }),
        },
        .ambiguous => |m| fatal("version {s} is ambiguous ({s}, {s}, ...); give more of the version", .{ m.query, m.candidates[0], m.candidates[1] }),
        .bad_snapshot_id => |id| fatal("invalid snapshot id {s}; expected <version>@<n|alias>", .{id}),
        .none_installed => |c| if (c) |x|
            fatal("no {s}-channel dsh version is installed in {s}; run `dsh update` to install one", .{ x, root })
        else
            fatal("no dsh version is installed in {s}; reinstall dsh-bin", .{root}),
        .unordered => |v| fatal("bundle {s} has no valid bundle.json (version order of the {s} channel); reinstall it with `dsh install {s} --force`", .{ v, chan, v }),
        .managed_option => |m| fatal("{s} is not available: the dsh version and addons are managed by {s}", .{ m.option, m.manager }),
    }
}

fn metaOf(bundles: []const select.Bundle, v: []const u8) ?select.Meta {
    for (bundles) |b| if (std.mem.eql(u8, b.version, v)) return b.meta;
    return null;
}

fn plan(a: std.mem.Allocator, root: []const u8, args: []const []const u8, env: *const std.process.EnvMap) Plan {
    const opts = switch (select.parseLeading(a, args) catch oom()) {
        .ok => |o| o,
        .err => |e| switch (e.kind) {
            .missing_value => fatal("{s} needs a value", .{e.option}),
            .repeated => fatal("{s} can be given only once", .{e.option}),
        },
    };
    const maintenance = select.isMaintenance(if (opts.consumed < args.len) args[opts.consumed] else null);
    const bundles = listBundles(a, root);
    const chan = recordedChannel(a, root);
    const managed = managedBy(a, root);
    const sel = readSelection(a, env, managed != null);
    const selection: ?select.Selection = if (sel.parsed) |p| switch (p) {
        .ok => |s| s,
        .err => |e| if (maintenance) null else switch (e) {
            .not_json_object => fatal("cannot read the selection {s}; run `dsh select --use latest` to reset it", .{sel.path.?}),
            .bad_schema => fatal("unsupported selection {s}; run `dsh select --use latest` to reset it", .{sel.path.?}),
            .bad_use => fatal("invalid selection {s}: no version; run `dsh select --use latest` to reset it", .{sel.path.?}),
        },
    } else null;

    const resolution = select.resolve(.{
        .opts = opts,
        .bundles = bundles,
        .channel = chan,
        .managed = managed,
        .selection_use = if (selection) |s| s.use else null,
    });
    // A maintenance command still runs when its effective version does not resolve (it may be the fix);
    // `version: null` tells the runtime. A broken selection is never read as `latest`.
    const selection_broken = sel.parsed != null and sel.parsed.? == .err;
    const guessed = selection_broken and managed == null and opts.use == null and opts.snapshot == null;
    const resolved: ?select.Resolved = switch (resolution) {
        .ok => |r| if (guessed) null else r,
        .err => |f| if (maintenance and f != .managed_option) null else reportResolution(f, root, chan),
    };
    const launch = select.launchJson(a, opts, resolved, if (selection) |s| s.value else null) catch oom();

    const run_version = if (maintenance)
        select.maintenanceBundle(bundles) orelse fatal("no dsh version this launcher can start is installed in {s}; reinstall dsh-bin", .{root})
    else
        resolved.?.version;
    const native = std.fs.path.join(a, &.{ root, "bundles", run_version, native_name }) catch oom();
    std.fs.accessAbsolute(native, .{}) catch
        fatal("dsh {s} is not installed ({s} is missing); run `dsh install {s}`", .{ run_version, native, run_version });
    const meta = metaOf(bundles, run_version);
    const declared = if (meta) |m| m.protocol else null;
    if (declared != select.protocol) {
        if (declared) |p|
            fatal("dsh {s} needs launcher protocol {d}, but this launcher implements {d}; reinstall it with `dsh install {s} --force`", .{ run_version, p, select.protocol, run_version })
        else
            fatal("dsh {s} declares no launcher protocol (this launcher implements {d}); reinstall it with `dsh install {s} --force`", .{ run_version, select.protocol, run_version });
    }
    return .{
        .version = run_version,
        .bundle_channel = meta.?.channel orelse chan,
        .claim = !maintenance,
        .consumed = opts.consumed,
        .launch = launch,
    };
}

// ------------------------------------------------------------------------------------- environment

/// Per-user cache root of dsh-bin: %LOCALAPPDATA%\dsh-bin\cache (Windows), ~/Library/Caches/dsh-bin
/// (macOS), $XDG_CACHE_HOME/dsh-bin or ~/.cache/dsh-bin (elsewhere). Null when no base is known.
fn cacheRoot(allocator: std.mem.Allocator, env: *const std.process.EnvMap) !?[]const u8 {
    const set = struct {
        fn abs(e: *const std.process.EnvMap, name: []const u8) ?[]const u8 {
            const v = e.get(name) orelse return null;
            return if (v.len > 0 and std.fs.path.isAbsolute(v)) v else null;
        }
    };
    if (is_windows) {
        const base = set.abs(env, "LOCALAPPDATA") orelse return null;
        return try std.fs.path.join(allocator, &.{ base, "dsh-bin", "cache" });
    }
    if (builtin.os.tag != .macos) {
        if (set.abs(env, "XDG_CACHE_HOME")) |x| return try std.fs.path.join(allocator, &.{ x, "dsh-bin" });
    }
    const home = set.abs(env, "HOME") orelse return null;
    if (builtin.os.tag == .macos) return try std.fs.path.join(allocator, &.{ home, "Library", "Caches", "dsh-bin" });
    return try std.fs.path.join(allocator, &.{ home, ".cache", "dsh-bin" });
}

const transpiler_cache_var = "BUN_RUNTIME_TRANSPILER_CACHE_PATH";

/// The runtime's environment: the parent's, minus `cleared_vars`, plus the DSH_BUNDLE_* contract and
/// `DSH_BIN_LAUNCH`. Bun's transpiler cache moves from its shared default (~/.bun/install/cache) into
/// dsh-bin's own user cache, which the runtime seeds from the bundle and `dsh update --clean` clears. A
/// value the user set wins. Set here because Bun reads it only at process start.
fn runtimeEnv(a: std.mem.Allocator, env: *std.process.EnvMap, root: []const u8, launcher: []const u8, p: Plan) !void {
    for (cleared_vars) |name| env.remove(name);
    try env.put("DSH_BUNDLE_ROOT", root);
    try env.put("DSH_BUNDLE_VERSION", p.version);
    try env.put("DSH_BUNDLE_LAUNCHER", launcher);
    try env.put("DSH_BUNDLE_CHANNEL", p.bundle_channel);
    try env.put("DSH_BIN_LAUNCH", p.launch);
    if (try cacheRoot(a, env)) |cache| {
        try env.put("DSH_BUNDLE_CACHE", cache);
        if (env.get(transpiler_cache_var) == null)
            try env.put(transpiler_cache_var, try std.fs.path.join(a, &.{ cache, "transpiler" }));
    }
}

// ---------------------------------------------------------------------------------------------- POSIX

/// Shared flock on the guard, inherited across execve (no O_CLOEXEC). A missing guard means the
/// bundle is incomplete; cleanup never retires a bundle it cannot validate, so run without a claim.
/// A busy guard means the version is being replaced or removed: wait briefly, reopening each try.
fn posixClaim(guard: []const u8, v: []const u8) void {
    var attempt: usize = 0;
    while (attempt < 100) : (attempt += 1) {
        const fd = std.posix.open(guard, .{ .ACCMODE = .RDONLY }, 0) catch return;
        std.posix.flock(fd, std.posix.LOCK.SH | std.posix.LOCK.NB) catch |err| switch (err) {
            error.WouldBlock => {
                std.posix.close(fd);
                std.Thread.sleep(100 * std.time.ns_per_ms);
                continue;
            },
            else => {
                std.posix.close(fd);
                return;
            },
        };
        return; // keep fd open: the claim lives as long as the exec'd runtime
    }
    fatal("dsh {s} is being replaced or removed; try again", .{v});
}

fn runPosix(a: std.mem.Allocator, root: []const u8, launcher: []const u8) noreturn {
    const raw = std.os.argv;
    const args = a.alloc([]const u8, raw.len - 1) catch oom();
    for (raw[1..], args) |arg, *out| out.* = std.mem.span(arg);
    var env = std.process.getEnvMap(a) catch oom();
    const p = plan(a, root, args, &env);

    const native = std.fs.path.join(a, &.{ root, "bundles", p.version, native_name }) catch oom();
    if (p.claim) posixClaim(std.fs.path.join(a, &.{ root, "bundles", p.version, guard_name }) catch oom(), p.version);
    runtimeEnv(a, &env, root, launcher, p) catch oom();
    const envp = std.process.createNullDelimitedEnvMap(a, &env) catch oom();

    const rest = raw[1 + p.consumed ..];
    const argv = a.allocSentinel(?[*:0]const u8, rest.len + 1, null) catch oom();
    const native_z = a.dupeZ(u8, native) catch oom();
    argv[0] = native_z.ptr;
    for (rest, 1..) |arg, i| argv[i] = arg;

    const err = std.posix.execveZ(native_z.ptr, argv.ptr, envp.ptr);
    fatal("could not execute {s}: {s}", .{ native, @errorName(err) });
}

// -------------------------------------------------------------------------------------------- Windows

const win = std.os.windows;
extern "kernel32" fn LockFileEx(h: win.HANDLE, flags: win.DWORD, reserved: win.DWORD, low: win.DWORD, high: win.DWORD, ov: *win.OVERLAPPED) callconv(.winapi) win.BOOL;
extern "kernel32" fn GetCommandLineW() callconv(.winapi) [*:0]const u16;

/// Shared LockFileEx on the guard, held by the launcher for the child's lifetime. The runtime takes its
/// own shared claim as well, so the bundle stays protected even if the launcher is killed.
fn windowsClaim(guard: []const u8, v: []const u8) void {
    var attempt: usize = 0;
    while (attempt < 100) : (attempt += 1) {
        const file = std.fs.openFileAbsolute(guard, .{}) catch return;
        var ov = std.mem.zeroes(win.OVERLAPPED);
        const LOCKFILE_FAIL_IMMEDIATELY: win.DWORD = 1;
        if (LockFileEx(file.handle, LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &ov) != 0) return; // handle stays open
        file.close();
        std.Thread.sleep(100 * std.time.ns_per_ms);
    }
    fatal("dsh {s} is being replaced or removed; try again", .{v});
}

fn runWindows(a: std.mem.Allocator, root: []const u8, launcher: []const u8) noreturn {
    const cmd = std.mem.span(GetCommandLineW());
    var args: std.ArrayList([]const u8) = .empty;
    var it = std.process.ArgIteratorWindows.init(a, cmd) catch oom();
    _ = it.skip();
    while (it.next()) |arg| args.append(a, a.dupe(u8, arg) catch oom()) catch oom();
    var env = std.process.getEnvMap(a) catch oom();
    const p = plan(a, root, args.items, &env);

    const native = std.fs.path.join(a, &.{ root, "bundles", p.version, native_name }) catch oom();
    if (p.claim) windowsClaim(std.fs.path.join(a, &.{ root, "bundles", p.version, guard_name }) catch oom(), p.version);
    runtimeEnv(a, &env, root, launcher, p) catch oom();
    const env_block = std.process.createWindowsEnvBlock(a, &env) catch oom();
    const native_w = std.unicode.wtf8ToWtf16LeAllocZ(a, native) catch fatal("invalid path {s}", .{native});
    // The raw tail after the leading options, so the child sees the user's quoting unchanged.
    const tail = cmd[select.windowsTailOffset(a, cmd, p.consumed) catch oom() ..];
    var line: std.ArrayList(u16) = .empty;
    line.append(a, '"') catch oom();
    line.appendSlice(a, native_w) catch oom();
    line.append(a, '"') catch oom();
    if (tail.len > 0) {
        line.append(a, ' ') catch oom();
        line.appendSlice(a, tail) catch oom();
    }
    line.append(a, 0) catch oom();

    var startup = std.mem.zeroes(win.STARTUPINFOW);
    startup.cb = @sizeOf(win.STARTUPINFOW);
    startup.dwFlags = win.STARTF_USESTDHANDLES;
    startup.hStdInput = win.GetStdHandle(win.STD_INPUT_HANDLE) catch null;
    startup.hStdOutput = win.GetStdHandle(win.STD_OUTPUT_HANDLE) catch null;
    startup.hStdError = win.GetStdHandle(win.STD_ERROR_HANDLE) catch null;
    var info: win.PROCESS_INFORMATION = undefined;
    win.CreateProcessW(
        native_w.ptr,
        @ptrCast(line.items.ptr),
        null,
        null,
        win.TRUE,
        .{ .create_unicode_environment = true },
        @ptrCast(env_block.ptr),
        null,
        &startup,
        &info,
    ) catch |err| fatal("could not execute {s}: {s}", .{ native, @errorName(err) });
    win.CloseHandle(info.hThread);
    win.WaitForSingleObjectEx(info.hProcess, win.INFINITE, false) catch std.process.exit(1);
    var status: win.DWORD = 1;
    if (win.kernel32.GetExitCodeProcess(info.hProcess, &status) == 0) status = 1;
    std.process.exit(@truncate(status));
}

pub fn main() void {
    std.mem.doNotOptimizeAway(marker.ptr);
    std.mem.doNotOptimizeAway(protocol_marker.ptr);
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    const a = arena.allocator();
    // selfExePath resolves /proc/self/exe (Linux) or _NSGetExecutablePath + realpath (macOS), so a
    // `/usr/bin/dsh -> /usr/lib/dsh-bin/dsh` symlink finds the real install root.
    const launcher = std.fs.selfExePathAlloc(a) catch |err| fatal("cannot resolve the launcher path: {s}", .{@errorName(err)});
    const root = std.fs.path.dirname(launcher) orelse fatal("cannot resolve the launcher directory", .{});
    if (is_windows) runWindows(a, root, launcher) else runPosix(a, root, launcher);
}

test {
    _ = select;
}
