//! Offline completion queries (D6/D10). No launch, maintenance lock, network or state writes.
const std = @import("std");
const util = @import("util.zig");
const select = @import("select.zig");
const runtimes = @import("runtimes.zig");
const state = @import("state.zig");
const Ctx = @import("context.zig").Ctx;

const Command = struct { name: []const u8, options: []const []const u8 = &.{} };
const commands = [_]Command{
    .{ .name = "install", .options = &.{ "--addon", "--channel", "--force" } },
    .{ .name = "update", .options = &.{ "--channel", "--force" } },
    .{ .name = "uninstall", .options = &.{"--addon"} },
    .{ .name = "list", .options = &.{ "--available", "--json" } },
    .{ .name = "select", .options = &.{ "--use", "--snapshot", "--addon" } },
    .{ .name = "snapshot", .options = &.{ "--target", "--empty", "--name", "--json" } },
    .{ .name = "clean" },
    .{ .name = "self-update" },
    .{ .name = "completion", .options = &.{ "--shell", "--profile", "--dry-run" } },
    .{ .name = "info" },
    .{ .name = "help" },
    .{ .name = "version" },
};

fn eq(x: []const u8, y: []const u8) bool {
    return std.mem.eql(u8, x, y);
}

fn safeWord(word: []const u8) bool {
    if (word.len == 0 or eq(word, ".") or eq(word, "..")) return false;
    for (word) |c| if (!std.ascii.isAlphanumeric(c) and std.mem.indexOfScalar(u8, "-_.+@:", c) == null) return false;
    return true;
}

fn localWord(word: []const u8) bool {
    if (word.len == 0 or eq(word, ".") or eq(word, "..")) return false;
    var view = std.unicode.Utf8View.init(word) catch return false;
    var it = view.iterator();
    while (it.nextCodepoint()) |c| if (c < 0x20 or (c >= 0x7f and c <= 0x9f) or c == '/' or c == '\\') return false;
    return true;
}

fn emit(prefix: []const u8, word: []const u8) void {
    if (safeWord(word) and std.mem.startsWith(u8, word, prefix)) util.print("{s}\n", .{word});
}

fn versions(ctx: *Ctx, prefix: []const u8, bundles: []const select.Bundle) void {
    emit(prefix, "latest");
    for (bundles) |b| {
        const m = b.meta orelse continue;
        if (m.format != .runtime_v1 or m.protocol != select.protocol or !safeWord(b.version)) continue;
        emit(prefix, b.version);
        const tag = std.fmt.allocPrint(ctx.a, "runtime-{s}{s}", .{ if (m.channel != null and eq(m.channel.?, "live")) "" else "v", b.version }) catch util.oom();
        emit(prefix, tag);
    }
}

fn localDirs(ctx: *Ctx, prefix: []const u8, parts: []const []const u8, name_prefix: []const u8) void {
    var dir = std.fs.cwd().openDir(ctx.path(parts), .{ .iterate = true, .no_follow = true }) catch return;
    defer dir.close();
    var words: std.ArrayList([]const u8) = .empty;
    var it = dir.iterate();
    while (it.next() catch null) |e| {
        if (e.kind != .directory or e.name[0] == '.' or !localWord(e.name)) continue;
        words.append(ctx.a, std.fmt.allocPrint(ctx.a, "{s}{s}", .{ name_prefix, e.name }) catch util.oom()) catch util.oom();
    }
    std.mem.sort([]const u8, words.items, {}, struct {
        fn lt(_: void, x: []const u8, y: []const u8) bool {
            return std.mem.lessThan(u8, x, y);
        }
    }.lt);
    for (words.items) |w| if (localWord(w) and std.mem.startsWith(u8, w, prefix)) util.print("{s}\n", .{w});
}

fn addons(ctx: *Ctx, prefix: []const u8) void {
    var dir = std.fs.cwd().openDir(ctx.path(&.{"addons"}), .{ .iterate = true, .no_follow = true }) catch return;
    defer dir.close();
    var it = dir.iterate();
    while (it.next() catch null) |e| {
        if (e.kind != .directory or e.name[0] == '.' or !safeWord(e.name)) continue;
        const name = ctx.a.dupe(u8, e.name) catch util.oom();
        const start = std.fmt.allocPrint(ctx.a, "{s}:", .{name}) catch util.oom();
        localDirs(ctx, prefix, &.{ "addons", name }, start);
    }
}

const Description = struct {
    schemaVersion: u32,
    commands: []const struct {
        name: []const u8,
        options: []const struct { names: []const []const u8, takesValue: bool },
    },
};

fn runtimeWords(ctx: *Ctx, prefix: []const u8, prior: []const []const u8, opts: select.Options, bundles: []const select.Bundle) void {
    const selection_use = switch (state.readSelection(ctx)) {
        .none => null,
        .ok => |s| s.use,
        .invalid => return,
    };
    const resolved = select.resolve(.{ .opts = opts, .bundles = bundles, .channel = state.channel(ctx), .selection_use = selection_use });
    if (resolved != .ok) return;
    const meta = runtimes.metaOf(bundles, resolved.ok.version) orelse return;
    if (meta.format != .runtime_v1 or meta.protocol != select.protocol) return;
    const bytes = std.fs.cwd().readFileAlloc(ctx.a, ctx.path(&.{ "bundles", resolved.ok.version, "completion.json" }), 1 << 20) catch return;
    const desc = std.json.parseFromSliceLeaky(Description, ctx.a, bytes, .{ .ignore_unknown_fields = true }) catch return;
    if (desc.schemaVersion != 1) return;
    for (desc.commands) |c| {
        if (c.name.len > 0 and !safeWord(c.name)) return;
        for (c.options) |o| for (o.names) |n| if (!safeWord(n) or n[0] != '-') return;
    }
    var command: []const u8 = "";
    if (prior.len > 0) for (desc.commands) |c| {
        if (c.name.len > 0 and eq(prior[0], c.name)) command = c.name;
    };
    for (desc.commands) |c| {
        if (eq(c.name, command)) {
            if (prior.len > 0) for (c.options) |o| {
                if (!o.takesValue) continue;
                for (o.names) |n| if (eq(n, prior[prior.len - 1])) return;
            };
            for (c.options) |o| for (o.names) |n| emit(prefix, n);
        }
        if (command.len == 0 and prior.len == 0 and c.name.len > 0) emit(prefix, c.name);
    }
}

/// Words exclude argv[0]; the final word is the current (possibly empty) prefix.
pub fn query(ctx: *Ctx, inherited: select.Options, args: []const []const u8) u8 {
    if (args.len < 3 or !eq(args[0], "--shell")) return 1;
    const shell = std.meta.stringToEnum(Shell, args[1]) orelse return 1;
    var env_words: std.ArrayList([]const u8) = .empty;
    const words = if (args.len == 3 and eq(args[2], "--words-env") and isPowerShell(shell)) blk: {
        // Ctx EnvMap decodes Windows' UTF-16 environment, not the legacy native argv binder.
        const encoded = ctx.env.get("DSH_COMPLETE_WORDS") orelse return 0;
        if (std.mem.indexOfScalar(u8, encoded, 0) != null) return 0;
        var it = std.mem.splitScalar(u8, encoded, 0x1f);
        while (it.next()) |word| env_words.append(ctx.a, word) catch util.oom();
        break :blk env_words.items;
    } else if (eq(args[2], "--")) args[3..] else return 1;
    const prefix = if (words.len > 0) words[words.len - 1] else "";
    const prior = if (words.len > 0) words[0 .. words.len - 1] else words;
    const last = if (prior.len > 0) prior[prior.len - 1] else "";
    const bundles = runtimes.list(ctx);
    if (eq(last, "--use")) {
        versions(ctx, prefix, bundles);
        return 0;
    }
    if (eq(last, "--snapshot") or eq(last, "--target")) {
        localDirs(ctx, prefix, &.{"snapshots"}, "");
        return 0;
    }
    if (eq(last, "--addon")) {
        addons(ctx, prefix);
        return 0;
    }
    var opts = switch (select.parseLeading(ctx.a, prior) catch util.oom()) {
        .ok => |o| o,
        .err => return 0,
    };
    if (opts.use == null) opts.use = inherited.use;
    if (opts.snapshot == null) opts.snapshot = inherited.snapshot;
    const rest = prior[opts.consumed..];
    if (rest.len > 0 and eq(rest[0], "manager")) {
        if (eq(last, "--channel")) {
            emit(prefix, "release");
            emit(prefix, "live");
            return 0;
        }
        if (eq(last, "--shell")) {
            for (std.enums.values(Shell)) |candidate| emit(prefix, @tagName(candidate));
            return 0;
        }
        if (rest.len == 1) {
            for (commands) |c| emit(prefix, c.name);
        } else {
            for (commands) |c| if (eq(rest[1], c.name)) {
                for (c.options) |o| emit(prefix, o);
            };
            if (eq(rest[1], "install") or eq(rest[1], "uninstall")) versions(ctx, prefix, bundles);
            if (eq(rest[1], "snapshot")) {
                if (rest.len == 2) for ([_][]const u8{ "new", "remove", "list" }) |w| emit(prefix, w);
                if (rest.len > 2 and eq(rest[2], "remove")) localDirs(ctx, prefix, &.{"snapshots"}, "");
            }
            if (eq(rest[1], "completion")) {
                if (rest.len == 2) for ([_][]const u8{ "script", "install", "uninstall" }) |w| emit(prefix, w);
                if (rest.len == 3) for (std.enums.values(Shell)) |candidate| emit(prefix, @tagName(candidate));
            }
        }
        emit(prefix, "--help");
        emit(prefix, "--version");
    } else {
        if (rest.len == 0) for ([_][]const u8{ "manager", "--use", "--snapshot", "--addon", "--help", "--version" }) |w| emit(prefix, w);
        runtimeWords(ctx, prefix, rest, opts, bundles);
    }
    return 0;
}

pub const Shell = enum { bash, zsh, fish, pwsh, powershell };
const end_marker = "# <<< dsh-manager completion v2\n";

fn quoted(ctx: *Ctx, shell: Shell, text: []const u8) []const u8 {
    const replacement = switch (shell) {
        .bash, .zsh => "'\\''",
        .fish => "\\'",
        .pwsh, .powershell => "''",
    };
    const base = if (shell == .fish) std.mem.replaceOwned(u8, ctx.a, text, "\\", "\\\\") catch util.oom() else text;
    const escaped = std.mem.replaceOwned(u8, ctx.a, base, "'", replacement) catch util.oom();
    return std.fmt.allocPrint(ctx.a, "'{s}'", .{escaped}) catch util.oom();
}

/// The first PATH hit must be this manager, not an unrelated dsh (or a wrapper).
fn binding(ctx: *Ctx) []const u8 {
    const win = @import("context.zig").is_windows;
    var paths = std.mem.splitScalar(u8, ctx.env.get("PATH") orelse "", if (win) ';' else ':');
    while (paths.next()) |p| {
        const dir = if (p.len == 0) "." else if (win) std.mem.trim(u8, p, "\"") else p;
        // Cwd-dependent entries could shadow a later absolute hit after registration.
        if (!std.fs.path.isAbsolute(dir) or (win and std.fs.path.diskDesignatorWindows(dir).len == 0)) break;
        var extensions = std.mem.splitScalar(u8, if (win) ctx.env.get("PATHEXT") orelse ".COM;.EXE;.BAT;.CMD" else "", ';');
        while (extensions.next()) |ext| {
            const name = std.fmt.allocPrint(ctx.a, "dsh{s}", .{ext}) catch util.oom();
            const path = util.join(ctx.a, &.{ dir, name });
            const st = std.fs.cwd().statFile(path) catch continue;
            if (st.kind != .file) continue;
            if (!win) std.posix.access(path, std.posix.X_OK) catch continue;
            const real = std.fs.cwd().realpathAlloc(ctx.a, path) catch continue;
            return if (if (win) std.ascii.eqlIgnoreCase(real, ctx.exe) else eq(real, ctx.exe)) "name:dsh" else std.fmt.allocPrint(ctx.a, "abs:{s}", .{ctx.exe}) catch util.oom();
        }
    }
    return std.fmt.allocPrint(ctx.a, "abs:{s}", .{ctx.exe}) catch util.oom();
}

fn boundCommand(bound: []const u8) ?[]const u8 {
    if (eq(bound, "name:dsh")) return "dsh";
    if (!std.mem.startsWith(u8, bound, "abs:") or !std.fs.path.isAbsolute(bound[4..])) return null;
    for (bound) |c| if (c < 0x20 or c == 0x7f) return null;
    return bound[4..];
}

fn script(ctx: *Ctx, shell: Shell, bound: []const u8) []const u8 {
    const template = switch (shell) {
        .bash => @embedFile("completion.bash"),
        .zsh => @embedFile("completion.zsh"),
        .fish => @embedFile("completion.fish"),
        .pwsh, .powershell => @embedFile("completion.ps1"),
    };
    return std.mem.replaceOwned(u8, ctx.a, template, "@DSH@", quoted(ctx, shell, boundCommand(bound).?)) catch util.oom();
}

fn block(ctx: *Ctx, shell: Shell, created: bool, bound: []const u8) []const u8 {
    const encoded = std.json.Stringify.valueAlloc(ctx.a, bound, .{}) catch util.oom();
    const header = std.fmt.allocPrint(ctx.a, "\n# >>> dsh-manager completion v2 {s} {s}\n", .{ @tagName(shell), if (created) "created" else "existing" }) catch util.oom();
    const body = std.fmt.allocPrint(ctx.a, "# binding: {s}\n{s}{s}", .{ encoded, script(ctx, shell, bound), end_marker }) catch util.oom();
    const bom = if (created and isPowerShell(shell)) "\xef\xbb\xbf" else "";
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(std.mem.concat(ctx.a, u8, &.{ bom, header, body }) catch util.oom(), &digest, .{});
    return std.fmt.allocPrint(ctx.a, "{s}{s}# sha256: {s}\n{s}", .{ bom, header, std.fmt.bytesToHex(digest, .lower), body }) catch util.oom();
}

fn isPowerShell(shell: Shell) bool {
    return shell == .pwsh or shell == .powershell;
}

fn foreign(ctx: *Ctx, bytes: []const u8, shell: Shell) bool {
    var lines = std.mem.splitScalar(u8, bytes, '\n');
    var ps: std.ArrayList(u8) = .empty;
    while (lines.next()) |raw| {
        const line = std.mem.trim(u8, raw, " \t\r");
        if (line.len == 0 or line[0] == '#') continue;
        if (isPowerShell(shell)) {
            ps.appendSlice(ctx.a, line) catch util.oom();
            ps.append(ctx.a, '\n') catch util.oom();
            continue;
        }
        const registration = switch (shell) {
            .bash, .fish => std.mem.indexOf(u8, line, "complete"),
            .zsh => std.mem.indexOf(u8, line, "compdef"),
            .pwsh, .powershell => unreachable,
        };
        if (registration != null and std.mem.indexOf(u8, line, "dsh") != null) return true;
    }
    // ponytail: conservative file-level PS scan covers multiline CommandName arrays;
    // use a parser if false-positive refusals become a real problem.
    const lower = std.ascii.allocLowerString(ctx.a, ps.items) catch util.oom();
    // Normalize escaped identifier letters before matching; ambiguous escaped registrations refuse.
    const identifiers = std.mem.replaceOwned(u8, ctx.a, lower, "`", "") catch util.oom();
    return std.mem.indexOf(u8, identifiers, "register-argumentcompleter") != null and (std.mem.indexOf(u8, identifiers, "dsh") != null or std.mem.indexOfScalar(u8, lower, '`') != null or std.mem.indexOfScalar(u8, lower, '$') != null or std.mem.indexOfScalar(u8, lower, '(') != null);
}

fn standardCollision(ctx: *Ctx, shell: Shell, home: []const u8) bool {
    const config = ctx.env.get("XDG_CONFIG_HOME") orelse util.join(ctx.a, &.{ home, ".config" });
    const data = ctx.env.get("XDG_DATA_HOME") orelse util.join(ctx.a, &.{ home, ".local", "share" });
    const paths: []const []const u8 = switch (shell) {
        .bash => &.{ util.join(ctx.a, &.{ data, "bash-completion", "completions", "dsh" }), util.join(ctx.a, &.{ home, ".bash_completion" }) },
        .zsh => &.{ util.join(ctx.a, &.{ home, ".zfunc", "_dsh" }), util.join(ctx.a, &.{ config, "zsh", "completions", "_dsh" }) },
        .fish, .pwsh, .powershell => return false,
    };
    for (paths) |p| {
        if (!util.exists(p)) continue;
        if (shell == .zsh or !std.mem.endsWith(u8, p, ".bash_completion")) return true;
        const bytes = std.fs.cwd().readFileAlloc(ctx.a, p, 1 << 20) catch return true;
        if (foreign(ctx, bytes, shell)) return true;
    }
    return false;
}

fn collision(path: []const u8) u8 {
    util.warn("completion collision or modified registration at {s}; kept unchanged, remove it manually before retrying", .{path});
    return 1;
}

extern "shell32" fn SHGetKnownFolderPath(id: *const std.os.windows.GUID, flags: u32, token: ?std.os.windows.HANDLE, path: *?[*:0]u16) callconv(.winapi) i32;
extern "ole32" fn CoTaskMemFree(memory: ?*anyopaque) callconv(.winapi) void;

fn documents(ctx: *Ctx) ![]const u8 {
    // Windows user token, not USERPROFILE: follows redirected Documents (including OneDrive).
    const id: std.os.windows.GUID = .{ .Data1 = 0xfdd39ad0, .Data2 = 0x238f, .Data3 = 0x46af, .Data4 = .{ 0xad, 0xb4, 0x6c, 0x85, 0x48, 0x03, 0x69, 0xc7 } };
    var path: ?[*:0]u16 = null;
    // KF_FLAG_DONT_VERIFY resolves without creating or testing the directory.
    const result = SHGetKnownFolderPath(&id, 0x4000, null, &path);
    defer if (path) |p| CoTaskMemFree(p);
    if (result < 0 or path == null) return error.DocumentsUnavailable;
    return std.unicode.utf16LeToUtf8Alloc(ctx.a, std.mem.span(path.?));
}

/// Shared read-only resolver; also usable by the later first-run prompt.
pub fn registrationPath(ctx: *Ctx, shell: Shell, override: ?[]const u8) ![]const u8 {
    if (shell == .powershell and !@import("context.zig").is_windows) return error.WindowsPowerShellRequiresWindows;
    const path = if (override) |p| p else if (isPowerShell(shell) and @import("context.zig").is_windows)
        util.join(ctx.a, &.{ try documents(ctx), if (shell == .pwsh) "PowerShell" else "WindowsPowerShell", "profile.ps1" })
    else blk: {
        const home = ctx.env.get(if (@import("context.zig").is_windows) "USERPROFILE" else "HOME") orelse return error.HomeRequired;
        if (!std.fs.path.isAbsolute(home)) return error.AbsolutePathRequired;
        const config = ctx.env.get("XDG_CONFIG_HOME") orelse util.join(ctx.a, &.{ home, ".config" });
        break :blk switch (shell) {
            .bash => util.join(ctx.a, &.{ home, ".bashrc" }),
            .zsh => util.join(ctx.a, &.{ ctx.env.get("ZDOTDIR") orelse home, ".zshrc" }),
            .fish => util.join(ctx.a, &.{ config, "fish", "completions", "dsh.fish" }),
            .pwsh => util.join(ctx.a, &.{ config, "powershell", "profile.ps1" }),
            .powershell => unreachable,
        };
    };
    if (!std.fs.path.isAbsolute(path)) return error.AbsolutePathRequired;
    return path;
}

fn decodeProfile(ctx: *Ctx, bytes: []const u8) ![]const u8 {
    if (!std.mem.startsWith(u8, bytes, "\xff\xfe")) {
        if (std.mem.startsWith(u8, bytes, "\xfe\xff") or std.mem.indexOfScalar(u8, bytes, 0) != null) return error.InvalidEncoding;
        return bytes;
    }
    if (bytes.len % 2 != 0) return error.InvalidEncoding;
    const units = try ctx.a.alloc(u16, bytes.len / 2);
    for (units, 0..) |*unit, i| unit.* = std.mem.readInt(u16, bytes[i * 2 ..][0..2], .little);
    return std.unicode.utf16LeToUtf8Alloc(ctx.a, units);
}

fn encodeProfile(ctx: *Ctx, bytes: []const u8, utf16: bool) ![]const u8 {
    if (!utf16) return bytes;
    const units = try std.unicode.utf8ToUtf16LeAlloc(ctx.a, bytes);
    return std.mem.sliceAsBytes(units);
}

fn resultHint(ctx: *Ctx, shell: Shell, path: []const u8, installing: bool, dry: bool, action: []const u8) void {
    if (std.mem.startsWith(u8, binding(ctx), "abs:")) util.print("Bound to this absolute manager location. After a move, re-register with the new manager: manager completion install {s}\n", .{@tagName(shell)});
    util.print("Completion registration: {s}\n{s}{s}\n", .{ path, if (dry) "Dry run: " else "Action: ", action });
    if (installing) {
        util.print("Completion activates in {s} sessions that load {s}. For the current session: {s} {s}\n", .{ @tagName(shell), quoted(ctx, shell, path), if (isPowerShell(shell)) "." else "source", quoted(ctx, shell, path) });
    } else if (isPowerShell(shell)) {
        util.print("Start a new session; PowerShell has no public unregister API for the current session.\n", .{});
    } else {
        util.print("Start a new session; for the current session: {s}\n", .{switch (shell) {
            .bash => "complete -r dsh",
            .zsh => "compdef -d dsh",
            .fish => "complete -e -c dsh; functions -e _dsh_manager_complete; set -e _dsh_manager_completion_owner; set -e _dsh_manager_completion_registration",
            .pwsh, .powershell => unreachable,
        }});
    }
}

pub fn run(ctx: *Ctx, args: []const []const u8) u8 {
    if (args.len < 2) {
        util.warn("use `dsh manager completion script|install|uninstall <bash|zsh|fish|pwsh|powershell>`; choose a shell explicitly", .{});
        return 1;
    }
    const verb = args[0];
    var at: usize = 1;
    if (eq(args[at], "--shell")) at += 1;
    if (at == args.len) return 1;
    const shell = std.meta.stringToEnum(Shell, args[at]) orelse {
        util.warn("unsupported completion shell {s}; supported: bash, zsh, fish, pwsh, powershell", .{args[at]});
        return 1;
    };
    at += 1;
    var profile: ?[]const u8 = null;
    var dry = false;
    while (at < args.len) : (at += 1) {
        if (eq(args[at], "--dry-run") and !dry) {
            dry = true;
        } else if (eq(args[at], "--profile") and isPowerShell(shell) and profile == null and at + 1 < args.len) {
            at += 1;
            profile = args[at];
        } else {
            util.warn("expected an explicit shell, optional PowerShell --profile <absolute-path>, or --dry-run", .{});
            return 1;
        }
    }
    const bound = binding(ctx);
    if (boundCommand(bound) == null) {
        util.warn("completion requires a manager path without control characters", .{});
        return 1;
    }
    if (eq(verb, "script")) {
        if (profile != null or dry) return 1;
        util.print("{s}", .{script(ctx, shell, bound)});
        return 0;
    }
    const installing = eq(verb, "install");
    if (!installing and !eq(verb, "uninstall")) {
        util.warn("unknown completion action {s}", .{verb});
        return 1;
    }
    const path = registrationPath(ctx, shell, profile) catch |err| {
        util.warn("cannot resolve completion target: {s}; an absolute profile/configuration path is required", .{@errorName(err)});
        return 1;
    };
    var link_buf: [std.fs.max_path_bytes]u8 = undefined;
    if (std.fs.cwd().readLink(path, &link_buf)) |_| return collision(path) else |_| {}
    const existing = std.fs.cwd().readFileAlloc(ctx.a, path, 1 << 20) catch |err| switch (err) {
        error.FileNotFound => null,
        else => return collision(path),
    };
    const raw = existing orelse "";
    const utf16 = isPowerShell(shell) and std.mem.startsWith(u8, raw, "\xff\xfe");
    const bytes = if (isPowerShell(shell)) decodeProfile(ctx, raw) catch return collision(path) else raw;
    var output: []const u8 = bytes;
    var remove_file = false;
    var action: []const u8 = if (installing) "already-registered" else "nothing-to-remove";
    const home = ctx.env.get(if (@import("context.zig").is_windows) "USERPROFILE" else "HOME") orelse "";
    if (std.mem.indexOf(u8, bytes, "\n# >>> dsh-manager completion v2 ")) |start| {
        const tail = bytes[start..];
        const line_end = std.mem.indexOfScalarPos(u8, tail, 1, '\n') orelse return collision(path);
        const line = tail[1..line_end];
        const token = line[(std.mem.lastIndexOfScalar(u8, line, ' ') orelse return collision(path)) + 1 ..];
        if (!eq(token, "created") and !eq(token, "existing")) return collision(path);
        const created = eq(token, "created");
        const integrity_end = std.mem.indexOfScalarPos(u8, tail, line_end + 1, '\n') orelse return collision(path);
        const binding_start = integrity_end + 1;
        const binding_end = std.mem.indexOfScalarPos(u8, tail, binding_start, '\n') orelse return collision(path);
        const binding_line = tail[binding_start..binding_end];
        if (!std.mem.startsWith(u8, binding_line, "# binding: ")) return collision(path);
        const stored = std.json.parseFromSliceLeaky([]const u8, ctx.a, binding_line[11..], .{}) catch return collision(path);
        if (boundCommand(stored) == null) return collision(path);
        const remove_start = if (created and isPowerShell(shell) and start == 3 and std.mem.startsWith(u8, bytes, "\xef\xbb\xbf")) 0 else start;
        const owned = block(ctx, shell, created, stored);
        const owned_tail = bytes[remove_start..];
        if (!std.mem.startsWith(u8, owned_tail, owned)) return collision(path);
        const rest = owned_tail[owned.len..];
        if (std.mem.indexOf(u8, rest, "# >>> dsh-manager completion") != null) return collision(path);
        if (shell == .fish and (start != 0 or rest.len != 0)) return collision(path);
        if (installing) {
            if (foreign(ctx, bytes[0..start], shell) or foreign(ctx, rest, shell) or standardCollision(ctx, shell, home)) return collision(path);
            if (!eq(stored, bound)) {
                output = std.mem.concat(ctx.a, u8, &.{ bytes[0..remove_start], block(ctx, shell, created, bound), rest }) catch util.oom();
                action = "refresh";
            }
        } else {
            output = std.mem.concat(ctx.a, u8, &.{ bytes[0..remove_start], rest }) catch util.oom();
            remove_file = created and output.len == 0;
            action = "would-remove";
        }
    } else if (std.mem.indexOf(u8, bytes, "# >>> dsh-manager completion") != null or std.mem.indexOf(u8, bytes, end_marker) != null or (shell == .fish and existing != null)) {
        return collision(path);
    } else if (installing) {
        if (foreign(ctx, bytes, shell) or standardCollision(ctx, shell, home)) return collision(path);
        output = std.mem.concat(ctx.a, u8, &.{ bytes, block(ctx, shell, existing == null, bound) }) catch util.oom();
        action = if (existing == null) "create" else "append";
    }
    if (dry) {
        resultHint(ctx, shell, path, installing, true, action);
        return 0;
    }
    if (remove_file) {
        std.fs.cwd().deleteFile(path) catch |err| {
            util.warn("cannot remove completion registration {s}: {s}", .{ path, @errorName(err) });
            return 1;
        };
        // Retain parent directories: editable profile metadata must never authorize ancestor deletion.
    } else if (!eq(output, bytes)) {
        if (existing == null) std.fs.cwd().makePath(std.fs.path.dirname(path) orelse return 1) catch |err| {
            util.warn("cannot create completion parent for {s}: {s}", .{ path, @errorName(err) });
            return 1;
        };
        const mode = if (std.fs.cwd().statFile(path)) |st| st.mode else |_| 0o600;
        var buffer: [4096]u8 = undefined;
        var file = std.fs.cwd().atomicFile(path, .{ .mode = mode, .write_buffer = &buffer }) catch |err| {
            util.warn("cannot write completion registration {s}: {s}", .{ path, @errorName(err) });
            return 1;
        };
        defer file.deinit();
        const encoded = encodeProfile(ctx, output, utf16) catch return collision(path);
        file.file_writer.interface.writeAll(encoded) catch return 1;
        file.finish() catch |err| {
            util.warn("cannot save completion registration {s}: {s}", .{ path, @errorName(err) });
            return 1;
        };
    }
    resultHint(ctx, shell, path, installing, false, action);
    return 0;
}
