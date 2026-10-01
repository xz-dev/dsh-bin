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
    .{ .name = "completion", .options = &.{"--shell"} },
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
        if (e.kind != .directory or e.name[0] == '.' or !safeWord(e.name)) continue;
        words.append(ctx.a, std.fmt.allocPrint(ctx.a, "{s}{s}", .{ name_prefix, e.name }) catch util.oom()) catch util.oom();
    }
    std.mem.sort([]const u8, words.items, {}, struct {
        fn lt(_: void, x: []const u8, y: []const u8) bool {
            return std.mem.lessThan(u8, x, y);
        }
    }.lt);
    for (words.items) |w| emit(prefix, w);
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
    if (args.len < 3 or !eq(args[0], "--shell") or !eq(args[2], "--")) return 1;
    if (!eq(args[1], "bash") and !eq(args[1], "zsh")) return 1;
    const words = args[3..];
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
            emit(prefix, "bash");
            emit(prefix, "zsh");
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
                if (rest.len == 3) for ([_][]const u8{ "bash", "zsh" }) |w| emit(prefix, w);
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

const Shell = enum { bash, zsh };
const end_marker = "# <<< dsh-manager completion v1\n";

fn quoted(ctx: *Ctx, text: []const u8) []const u8 {
    const escaped = std.mem.replaceOwned(u8, ctx.a, text, "'", "'\\''") catch util.oom();
    return std.fmt.allocPrint(ctx.a, "'{s}'", .{escaped}) catch util.oom();
}

fn script(ctx: *Ctx, shell: Shell) []const u8 {
    const template = switch (shell) {
        .bash => @embedFile("completion.bash"),
        .zsh => @embedFile("completion.zsh"),
    };
    return std.mem.replaceOwned(u8, ctx.a, template, "@DSH@", quoted(ctx, ctx.exe)) catch util.oom();
}

fn block(ctx: *Ctx, shell: Shell, created: bool) []const u8 {
    return std.fmt.allocPrint(ctx.a, "\n# >>> dsh-manager completion v1 {s} {s}\n{s}{s}", .{ @tagName(shell), if (created) "created" else "existing", script(ctx, shell), end_marker }) catch util.oom();
}

fn foreign(bytes: []const u8, shell: Shell) bool {
    var lines = std.mem.splitScalar(u8, bytes, '\n');
    while (lines.next()) |raw| {
        const line = std.mem.trim(u8, raw, " \t\r");
        if (line.len == 0 or line[0] == '#') continue;
        const registration = switch (shell) {
            .bash => std.mem.indexOf(u8, line, "complete"),
            .zsh => std.mem.indexOf(u8, line, "compdef"),
        };
        if (registration != null and std.mem.indexOf(u8, line, "dsh") != null) return true;
    }
    return false;
}

fn standardCollision(ctx: *Ctx, shell: Shell, home: []const u8) bool {
    const config = ctx.env.get("XDG_CONFIG_HOME") orelse util.join(ctx.a, &.{ home, ".config" });
    const data = ctx.env.get("XDG_DATA_HOME") orelse util.join(ctx.a, &.{ home, ".local", "share" });
    const paths: []const []const u8 = switch (shell) {
        .bash => &.{ util.join(ctx.a, &.{ data, "bash-completion", "completions", "dsh" }), util.join(ctx.a, &.{ home, ".bash_completion" }) },
        .zsh => &.{ util.join(ctx.a, &.{ home, ".zfunc", "_dsh" }), util.join(ctx.a, &.{ config, "zsh", "completions", "_dsh" }) },
    };
    for (paths) |p| {
        if (!util.exists(p)) continue;
        if (shell == .zsh or !std.mem.endsWith(u8, p, ".bash_completion")) return true;
        const bytes = std.fs.cwd().readFileAlloc(ctx.a, p, 1 << 20) catch return true;
        if (foreign(bytes, shell)) return true;
    }
    return false;
}

fn collision(path: []const u8) u8 {
    util.warn("completion collision or modified registration at {s}; kept unchanged, remove it manually before retrying", .{path});
    return 1;
}

pub fn run(ctx: *Ctx, args: []const []const u8) u8 {
    if (args.len < 2) {
        util.warn("use `dsh manager completion script|install|uninstall <bash|zsh>`; choose a shell explicitly", .{});
        return 1;
    }
    const verb = args[0];
    const shell_name = if (args.len == 2) args[1] else if (args.len == 3 and eq(args[1], "--shell")) args[2] else {
        util.warn("expected an explicit shell, e.g. `dsh manager completion install --shell bash`", .{});
        return 1;
    };
    const shell = std.meta.stringToEnum(Shell, shell_name) orelse {
        util.warn("unsupported completion shell {s}; currently bash and zsh are supported", .{shell_name});
        return 1;
    };
    if (eq(verb, "script")) {
        util.print("{s}", .{script(ctx, shell)});
        return 0;
    }
    const installing = eq(verb, "install");
    if (!installing and !eq(verb, "uninstall")) {
        util.warn("unknown completion action {s}", .{verb});
        return 1;
    }
    const home = ctx.env.get(if (@import("context.zig").is_windows) "USERPROFILE" else "HOME") orelse {
        util.warn("HOME is required for user-level completion registration", .{});
        return 1;
    };
    const base = if (shell == .zsh) ctx.env.get("ZDOTDIR") orelse home else home;
    if (!std.fs.path.isAbsolute(base)) {
        util.warn("completion configuration directory must be absolute", .{});
        return 1;
    }
    const path = util.join(ctx.a, &.{ base, if (shell == .bash) ".bashrc" else ".zshrc" });
    var link_buf: [std.fs.max_path_bytes]u8 = undefined;
    if (std.fs.cwd().readLink(path, &link_buf)) |_| return collision(path) else |_| {}
    const existing = std.fs.cwd().readFileAlloc(ctx.a, path, 1 << 20) catch |err| switch (err) {
        error.FileNotFound => null,
        else => return collision(path),
    };
    const bytes = existing orelse "";
    var output: []const u8 = bytes;
    var remove_file = false;
    if (std.mem.indexOf(u8, bytes, "\n# >>> dsh-manager completion v1 ")) |at| {
        const tail = bytes[at..];
        const created = std.mem.startsWith(u8, tail, std.fmt.allocPrint(ctx.a, "\n# >>> dsh-manager completion v1 {s} created\n", .{@tagName(shell)}) catch util.oom());
        const owned = block(ctx, shell, created);
        if (!std.mem.startsWith(u8, tail, owned)) return collision(path);
        const rest = tail[owned.len..];
        if (std.mem.indexOf(u8, rest, "# >>> dsh-manager completion") != null) return collision(path);
        if (installing) {
            if (foreign(bytes[0..at], shell) or foreign(rest, shell) or standardCollision(ctx, shell, home)) return collision(path);
        } else {
            output = std.mem.concat(ctx.a, u8, &.{ bytes[0..at], rest }) catch util.oom();
            remove_file = created and output.len == 0;
        }
    } else if (std.mem.indexOf(u8, bytes, "# >>> dsh-manager completion") != null or std.mem.indexOf(u8, bytes, end_marker) != null) {
        return collision(path);
    } else if (installing) {
        if (foreign(bytes, shell) or standardCollision(ctx, shell, home)) return collision(path);
        output = std.mem.concat(ctx.a, u8, &.{ bytes, block(ctx, shell, existing == null) }) catch util.oom();
    }
    if (remove_file) {
        std.fs.cwd().deleteFile(path) catch |err| {
            util.warn("cannot remove completion registration {s}: {s}", .{ path, @errorName(err) });
            return 1;
        };
    } else if (!eq(output, bytes)) {
        const mode = if (std.fs.cwd().statFile(path)) |st| st.mode else |_| 0o600;
        var buffer: [4096]u8 = undefined;
        var file = std.fs.cwd().atomicFile(path, .{ .mode = mode, .write_buffer = &buffer }) catch |err| {
            util.warn("cannot write completion registration {s}: {s}", .{ path, @errorName(err) });
            return 1;
        };
        defer file.deinit();
        file.file_writer.interface.writeAll(output) catch return 1;
        file.finish() catch |err| {
            util.warn("cannot save completion registration {s}: {s}", .{ path, @errorName(err) });
            return 1;
        };
    }
    if (installing) {
        util.print("Completion registration: {s}\nNew interactive {s} sessions load it. For the current session: source {s}\n", .{ path, @tagName(shell), quoted(ctx, path) });
    } else {
        util.print("Completion registration removed from {s}. Start a new session; for the current session: {s}\n", .{ path, if (shell == .bash) "complete -r dsh" else "compdef -d dsh" });
    }
    return 0;
}
