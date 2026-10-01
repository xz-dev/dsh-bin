//! First ordinary interactive launch: completion consent before any runtime check (task 5.1).
const std = @import("std");
const builtin = @import("builtin");
const util = @import("util.zig");
const completion = @import("completion.zig");
const Ctx = @import("context.zig").Ctx;
const Shell = completion.Shell;
const Result = enum { registered, declined, failed };
const Entry = struct { result: Result };
const Choices = struct {
    bash: ?Entry = null,
    zsh: ?Entry = null,
    fish: ?Entry = null,
    pwsh: ?Entry = null,
    powershell: ?Entry = null,
};
const State = struct { schema: u32, shells: Choices, undetected: ?Entry = null };

fn saved(s: *const State, shell: ?Shell) bool {
    const chosen = shell orelse return s.undetected != null;
    inline for (std.meta.fields(Choices)) |field| {
        if (std.mem.eql(u8, field.name, @tagName(chosen))) return @field(s.shells, field.name) != null;
    }
    unreachable;
}

fn record(s: *State, shell: ?Shell, result: Result) void {
    const chosen = shell orelse {
        s.undetected = .{ .result = result };
        return;
    };
    inline for (std.meta.fields(Choices)) |field| {
        if (std.mem.eql(u8, field.name, @tagName(chosen))) {
            @field(s.shells, field.name) = .{ .result = result };
            return;
        }
    }
    unreachable;
}

fn readState(ctx: *Ctx) State {
    const path = ctx.path(&.{ "state", "completion.json" });
    const bytes = std.fs.cwd().readFileAlloc(ctx.a, path, 4096) catch |err| switch (err) {
        error.FileNotFound => return .{ .schema = 1, .shells = .{} },
        else => util.fatal("invalid completion state at {s}: {s}; repair it before retrying", .{ path, @errorName(err) }),
    };
    const s = std.json.parseFromSliceLeaky(State, ctx.a, bytes, .{}) catch
        util.fatal("invalid completion state at {s}; expected schema 1 shell results; repair it before retrying", .{path});
    if (s.schema != 1)
        util.fatal("invalid completion state at {s}; expected schema 1 shell results", .{path});
    return s;
}

fn save(ctx: *Ctx, s: State) void {
    var dir = ctx.ensureDir(&.{"state"});
    defer dir.close();
    const bytes = std.json.Stringify.valueAlloc(ctx.a, s, .{ .emit_null_optional_fields = false }) catch util.oom();
    var buffer: [4096]u8 = undefined;
    var file = dir.atomicFile("completion.json", .{ .mode = 0o600, .write_buffer = &buffer }) catch |err|
        util.fatal("cannot save completion choice: {s}", .{@errorName(err)});
    defer file.deinit();
    file.file_writer.interface.writeAll(bytes) catch util.fatal("cannot write completion choice", .{});
    file.finish() catch |err| util.fatal("cannot save completion choice: {s}", .{@errorName(err)});
}

fn available(shell: Shell) bool {
    return if (builtin.os.tag == .windows) shell == .pwsh or shell == .powershell else shell != .powershell;
}

fn shellName(image: []const u8) ?Shell {
    var name = std.mem.trim(u8, std.fs.path.basename(image), " \t\r\n");
    if (std.ascii.endsWithIgnoreCase(name, ".exe")) name = name[0 .. name.len - 4];
    if (name.len > 0 and name[0] == '-') name = name[1..];
    inline for (std.meta.fields(Shell)) |field| {
        if (std.ascii.eqlIgnoreCase(name, field.name)) {
            const shell: Shell = @enumFromInt(field.value);
            return if (available(shell)) shell else null;
        }
    }
    return null;
}

fn linuxShell(ctx: *Ctx) ?Shell {
    var pid = std.os.linux.getpid();
    for (0..3) |_| {
        const stat_path = std.fmt.allocPrint(ctx.a, "/proc/{d}/stat", .{pid}) catch util.oom();
        const stat = std.fs.cwd().readFileAlloc(ctx.a, stat_path, 4096) catch return null;
        // comm can itself contain spaces or ')'; state and ppid follow its final closing parenthesis.
        const end = std.mem.lastIndexOfScalar(u8, stat, ')') orelse return null;
        var fields = std.mem.tokenizeScalar(u8, stat[end + 1 ..], ' ');
        _ = fields.next() orelse return null;
        pid = std.fmt.parseInt(std.os.linux.pid_t, fields.next() orelse return null, 10) catch return null;
        if (pid <= 0) return null;
        const image_path = std.fmt.allocPrint(ctx.a, "/proc/{d}/exe", .{pid}) catch util.oom();
        var image: [std.fs.max_path_bytes]u8 = undefined;
        if (std.fs.cwd().readLink(image_path, &image)) |name| {
            if (shellName(name)) |shell| return shell;
        } else |_| {
            const comm = std.fs.cwd().readFileAlloc(ctx.a, std.fmt.allocPrint(ctx.a, "/proc/{d}/comm", .{pid}) catch util.oom(), 256) catch continue;
            if (shellName(comm)) |shell| return shell;
        }
    }
    return null;
}

const win = std.os.windows;
const ProcessEntry = extern struct {
    size: win.DWORD = @sizeOf(ProcessEntry),
    usage: win.DWORD = 0,
    pid: win.DWORD = 0,
    heap: usize = 0,
    module: win.DWORD = 0,
    threads: win.DWORD = 0,
    parent: win.DWORD = 0,
    priority: win.LONG = 0,
    flags: win.DWORD = 0,
    image: [260]u16 = @splat(0),
};
extern "kernel32" fn Process32FirstW(snapshot: win.HANDLE, entry: *ProcessEntry) callconv(.winapi) win.BOOL;
extern "kernel32" fn Process32NextW(snapshot: win.HANDLE, entry: *ProcessEntry) callconv(.winapi) win.BOOL;

fn windowsShell(ctx: *Ctx) ?Shell {
    const snapshot = win.kernel32.CreateToolhelp32Snapshot(win.TH32CS_SNAPPROCESS, 0);
    if (snapshot == win.INVALID_HANDLE_VALUE) return null;
    defer win.CloseHandle(snapshot);
    var pid = win.GetCurrentProcessId();
    var parent: win.DWORD = 0;
    // Snapshot is immutable while walking. First find our parent, then examine up to three ancestors.
    for (0..4) |depth| {
        var entry: ProcessEntry = .{};
        var found = false;
        var valid = Process32FirstW(snapshot, &entry);
        while (valid != 0) : (valid = Process32NextW(snapshot, &entry)) {
            if (entry.pid != pid) continue;
            parent = entry.parent;
            found = true;
            if (depth > 0) {
                const length = std.mem.indexOfScalar(u16, &entry.image, 0) orelse entry.image.len;
                const name = std.unicode.utf16LeToUtf8Alloc(ctx.a, entry.image[0..length]) catch return null;
                if (shellName(name)) |shell| return shell;
            }
            break;
        }
        if (!found or parent == 0 or parent == pid) return null;
        pid = parent;
    }
    return null;
}

fn detect(ctx: *Ctx) ?Shell {
    if (builtin.os.tag == .windows) return windowsShell(ctx);
    if (builtin.os.tag == .linux) if (linuxShell(ctx)) |shell| return shell;
    // macOS ancestor lookup is intentionally omitted; this is only a hint, always confirmed by user.
    return shellName(ctx.env.get("SHELL") orelse "");
}

fn prompt(comptime fmt: []const u8, args: anytype) void {
    var buffer: [8192]u8 = undefined;
    const text = std.fmt.bufPrint(&buffer, fmt, args) catch return;
    std.fs.File.stderr().writeAll(text) catch {};
}

fn answer() ?[]const u8 {
    const Local = struct {
        var bytes: [128]u8 = undefined;
    };
    var length: usize = 0;
    var overflow = false;
    // Never buffer ahead: the runtime must receive every byte after the completion answer.
    while (true) {
        var byte: [1]u8 = undefined;
        if ((std.fs.File.stdin().read(&byte) catch return null) == 0) return null;
        if (byte[0] == '\n') {
            if (overflow) return "invalid";
            return std.mem.trim(u8, Local.bytes[0..length], " \t\r");
        }
        if (length == Local.bytes.len) overflow = true else {
            Local.bytes[length] = std.ascii.toLower(byte[0]);
            length += 1;
        }
    }
}

const Choice = struct { shell: ?Shell, register: bool };
fn menu(ctx: *Ctx) ?Choice {
    prompt("Choose completion shell (the listed target will be modified only if chosen):\n", .{});
    var offered: [std.meta.fields(Shell).len]bool = @splat(false);
    for (std.enums.values(Shell)) |shell| {
        if (!available(shell)) continue;
        const path = completion.registrationPath(ctx, shell, null) catch continue;
        offered[@intFromEnum(shell)] = true;
        prompt("  {s}: {s}\n", .{ @tagName(shell), path });
    }
    while (true) {
        prompt("Shell [bash/zsh/fish/pwsh/powershell/skip; Enter skips]: ", .{});
        const value = answer() orelse return null;
        if (value.len == 0 or std.mem.eql(u8, value, "skip")) return .{ .shell = null, .register = false };
        if (std.meta.stringToEnum(Shell, value)) |shell| {
            if (offered[@intFromEnum(shell)]) return .{ .shell = shell, .register = true };
        }
        prompt("Choose a shell listed above or skip.\n", .{});
    }
}

pub fn run(ctx: *Ctx) void {
    if (!std.fs.File.stdin().isTty() or !std.fs.File.stderr().isTty()) return;
    var s = readState(ctx);
    const detected = detect(ctx);
    if (saved(&s, detected)) return;
    const choice: Choice = if (detected) |shell| blk: {
        const path = completion.registrationPath(ctx, shell, null) catch break :blk menu(ctx) orelse return;
        while (true) {
            prompt("Register {s} completion at {s}? [Y/n/o] ", .{ @tagName(shell), path });
            const value = answer() orelse return;
            if (value.len == 0 or std.mem.eql(u8, value, "y") or std.mem.eql(u8, value, "yes")) break :blk .{ .shell = shell, .register = true };
            if (std.mem.eql(u8, value, "n") or std.mem.eql(u8, value, "no")) break :blk .{ .shell = shell, .register = false };
            if (std.mem.eql(u8, value, "o") or std.mem.eql(u8, value, "other")) break :blk menu(ctx) orelse return;
            prompt("Answer y, n, or o for another shell.\n", .{});
        }
    } else menu(ctx) orelse return;
    var result: Result = .declined;
    if (choice.register) {
        const shell = choice.shell.?;
        result = if (completion.run(ctx, &.{ "install", @tagName(shell) }) == 0) .registered else .failed;
        if (result == .failed) util.warn("completion is not registered; retry with `dsh manager completion install {s}`; continuing runtime check", .{@tagName(shell)});
    }
    if (choice.shell) |shell| record(&s, shell, result);
    if (detected) |shell| {
        if (choice.shell != shell) record(&s, shell, .declined);
    } else record(&s, null, result);
    save(ctx, s);
    util.flush();
}
