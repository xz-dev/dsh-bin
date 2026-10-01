//! Verified, resumable downloads using std HTTP and TLS, no runtime subprocesses.
//! Timeouts bound idle socket reads/writes, including CONNECT, its TLS handshake and redirects.
//! They are not request deadlines: trickling data can extend a transfer; DNS/TCP setup and
//! std's direct TLS handshake have no deadline guaranteed by this module.
const std = @import("std");
const builtin = @import("builtin");
const util = @import("util.zig");

pub const Error = error{ BadUrl, HttpStatus, DownloadFailed, PartialTooLarge, TooLarge, HashMismatch, Network, FileSystem, UnsupportedProxy, ProxyAuthenticationRequired, ProxyRefused, TlsVerificationFailed };
const MAX_ATTEMPTS = 5;
const MAX_REDIRECTS = 5;
const MAX_RETRY_AFTER_MS: u64 = 60_000;
const Expected = struct { size: u64, sha256: [32]u8 };

fn testMode(env: *const std.process.EnvMap) bool {
    return std.mem.eql(u8, env.get("DSH_MANAGER_TEST") orelse "", "1");
}

fn tuningMs(env: *const std.process.EnvMap, key: []const u8, default: u64) u64 {
    if (testMode(env)) {
        if (env.get(key)) |v| {
            const n = decimal(v) orelse return default;
            if (n > 0) return @min(n, MAX_RETRY_AFTER_MS);
        }
    }
    return default;
}

fn retryableStatus(code: u16) bool {
    return switch (code) {
        408, 425, 429, 500, 502, 503, 504 => true,
        else => false,
    };
}

fn decimal(v: []const u8) ?u64 {
    if (v.len == 0) return null;
    for (v) |c| if (!std.ascii.isDigit(c)) return null;
    return std.fmt.parseInt(u64, v, 10) catch null;
}

// HTTP-date's IMF-fixdate, obsolete RFC 850, and asctime forms. std has no HTTP date parser.
fn httpDate(v: []const u8) ?i64 {
    var it = std.mem.tokenizeAny(u8, v, " ,:-");
    var fields: [8][]const u8 = undefined;
    var count: usize = 0;
    while (it.next()) |field| {
        if (count == fields.len) return null;
        fields[count] = field;
        count += 1;
    }
    if (count != 7 and count != 8) return null;
    const asctime = count == 7;
    if (!asctime and !std.mem.eql(u8, fields[7], "GMT")) return null;
    const day = decimal(fields[if (asctime) 2 else 1]) orelse return null;
    const month_name = fields[if (asctime) 1 else 2];
    const year_text = fields[if (asctime) 6 else 3];
    var year = decimal(year_text) orelse return null;
    if (year_text.len == 2 and !asctime) {
        const current: u64 = (std.time.epoch.EpochSeconds{ .secs = @intCast(@max(0, std.time.timestamp())) }).getEpochDay().calculateYearDay().year;
        year += current / 100 * 100;
        if (year > current + 50) year -= 100;
    } else if (year_text.len != 4) return null;
    if (year < 1601 or year > 9999) return null;
    const months = [_][]const u8{ "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" };
    const month: std.time.epoch.Month = month: {
        for (months, 1..) |name, i| if (std.mem.eql(u8, name, month_name)) break :month @enumFromInt(i);
        return null;
    };
    const y: u16 = @intCast(year);
    if (day == 0 or day > std.time.epoch.getDaysInMonth(y, month)) return null;
    const time_index: usize = if (asctime) 3 else 4;
    const hour = decimal(fields[time_index]) orelse return null;
    const minute = decimal(fields[time_index + 1]) orelse return null;
    const second = decimal(fields[time_index + 2]) orelse return null;
    if (hour > 23 or minute > 59 or second > 59) return null;
    var days: i64 = 0;
    for (@min(y, 1970)..@max(y, 1970)) |i| {
        const n: i64 = std.time.epoch.getDaysInYear(@intCast(i));
        days += if (y >= 1970) n else -n;
    }
    for (1..@intFromEnum(month)) |i| days += std.time.epoch.getDaysInMonth(y, @enumFromInt(i));
    days += @intCast(day - 1);
    return days * 86400 + @as(i64, @intCast(hour * 3600 + minute * 60 + second));
}

fn retryAfterMs(header: ?[]const u8) ?u64 {
    const v = std.mem.trim(u8, header orelse return null, " \t");
    if (v.len == 0) return null;
    const digits = for (v) |c| {
        if (!std.ascii.isDigit(c)) break false;
    } else true;
    if (digits) {
        const seconds = std.fmt.parseInt(u64, v, 10) catch return MAX_RETRY_AFTER_MS;
        return @as(u64, @min(seconds, MAX_RETRY_AFTER_MS / 1000)) * 1000;
    }
    const at = httpDate(v) orelse return null;
    const remaining = @max(0, @as(i128, at) * 1000 - std.time.milliTimestamp());
    return @intCast(@min(remaining, MAX_RETRY_AFTER_MS));
}

fn backoffMs(failures: u32, base: u64, retry_after: ?u64) u64 {
    if (retry_after) |ms| return ms;
    return @min(base *| (@as(u64, 1) << @intCast(@min(failures -| 1, 4))), MAX_RETRY_AFTER_MS);
}

pub const Endpoints = struct {
    runtime_index: []const u8,
    manager_index: []const u8,
    download_base: []const u8,
    allocated: bool = false,

    pub fn deinit(e: Endpoints, a: std.mem.Allocator) void {
        if (!e.allocated) return;
        a.free(e.runtime_index);
        a.free(e.manager_index);
        a.free(e.download_base);
    }
};

/// Only the two explicit test variables can override production discovery endpoints.
/// Caller owns the returned URLs and releases them with Endpoints.deinit(a).
pub fn endpoints(a: std.mem.Allocator, env: *const std.process.EnvMap) Endpoints {
    if (testMode(env)) {
        if (env.get("DSH_MANAGER_TEST_ORIGIN")) |origin| {
            const o = std.mem.trimRight(u8, origin, "/");
            if (o.len > 0) return .{
                .runtime_index = std.fmt.allocPrint(a, "{s}/runtime-index.json", .{o}) catch util.oom(),
                .manager_index = std.fmt.allocPrint(a, "{s}/manager-index.json", .{o}) catch util.oom(),
                .download_base = std.fmt.allocPrint(a, "{s}/download", .{o}) catch util.oom(),
                .allocated = true,
            };
        }
    }
    return .{
        .runtime_index = "https://raw.githubusercontent.com/xz-dev/dsh-bin/releases/runtime-index.json",
        .manager_index = "https://raw.githubusercontent.com/xz-dev/dsh-bin/releases/manager-index.json",
        .download_base = "https://github.com/xz-dev/dsh-bin/releases/download",
    };
}

fn networkError(e: anyerror) Error {
    return if (e == error.OutOfMemory) util.oom() else Error.Network;
}

fn proxyVariable(env: *const std.process.EnvMap) ?[]const u8 {
    for ([_][]const u8{ "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY" }) |name| {
        if (env.get(name)) |v| if (v.len > 0) return name;
    }
    return null;
}

fn noProxy(env: *const std.process.EnvMap, host: []const u8, port: u16) bool {
    const list = env.get("no_proxy") orelse env.get("NO_PROXY") orelse return false;
    var entries = std.mem.splitScalar(u8, list, ',');
    while (entries.next()) |entry| {
        var name = std.mem.trim(u8, entry, " \t");
        if (std.mem.eql(u8, name, "*")) return true;
        // Optional port restricts the match; a port-less entry matches every port.
        const colon = std.mem.lastIndexOfScalar(u8, name, ':');
        if (colon) |at| {
            if (std.mem.indexOfScalar(u8, name[0..at], ':') == null or (at > 0 and name[at - 1] == ']')) {
                if ((decimal(name[at + 1 ..]) orelse continue) != port) continue;
                name = name[0..at];
            }
        }
        name = std.mem.trim(u8, name, "[]");
        name = std.mem.trimStart(u8, name, ".");
        if (name.len == 0 or host.len < name.len) continue;
        if (!std.ascii.eqlIgnoreCase(host[host.len - name.len ..], name)) continue;
        if (host.len == name.len or host[host.len - name.len - 1] == '.') return true;
    }
    return false;
}

fn loadRoots(c: *std.http.Client, env: *const std.process.EnvMap) Error!void {
    if (!c.next_https_rescan_certs) return;
    c.ca_bundle.rescan(c.allocator) catch |e| return networkError(e);
    if (testMode(env)) {
        if (env.get("DSH_MANAGER_TEST_CA_FILE")) |path| {
            c.ca_bundle.addCertsFromFilePath(c.allocator, std.fs.cwd(), path) catch |e| return networkError(e);
        }
    }
    c.next_https_rescan_certs = false;
}

fn proxyFromEnv(arena: std.mem.Allocator, env: *const std.process.EnvMap, names: []const []const u8) Error!?*std.http.Client.Proxy {
    for (names) |name| {
        const value = env.get(name) orelse continue;
        if (value.len == 0) continue;
        const uri = std.Uri.parse(value) catch std.Uri.parseAfterScheme("http", value) catch return Error.UnsupportedProxy;
        const protocol = std.http.Client.Protocol.fromUri(uri) orelse {
            std.debug.print("{s}: unsupported proxy scheme; use an http:// CONNECT proxy\n", .{name});
            return Error.UnsupportedProxy;
        };
        const host = uri.getHostAlloc(arena) catch |e| return networkError(e);
        // std's Basic helper base64-encodes escaped userinfo, and uses a fixed 511-byte
        // buffer. Decode with Uri instead; credentials stay only in the CONNECT header.
        const authorization = if (uri.user != null or uri.password != null) auth: {
            const user = (uri.user orelse std.Uri.Component.empty).toRawMaybeAlloc(arena) catch util.oom();
            const password = (uri.password orelse std.Uri.Component.empty).toRawMaybeAlloc(arena) catch util.oom();
            const credentials = std.fmt.allocPrint(arena, "{s}:{s}", .{ user, password }) catch util.oom();
            break :auth std.fmt.allocPrint(arena, "Basic {b64}", .{credentials}) catch util.oom();
        } else null;
        const proxy = arena.create(std.http.Client.Proxy) catch util.oom();
        proxy.* = .{ .host = host, .port = uri.port orelse @as(u16, if (protocol == .tls) 443 else 80), .protocol = protocol, .authorization = authorization, .supports_connect = false };
        return proxy;
    }
    return null;
}

fn client(a: std.mem.Allocator, env: *const std.process.EnvMap, proxy_arena: std.mem.Allocator) Error!std.http.Client {
    var c: std.http.Client = .{ .allocator = a };
    errdefer c.deinit();
    c.http_proxy = try proxyFromEnv(proxy_arena, env, &.{ "http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY" });
    c.https_proxy = try proxyFromEnv(proxy_arena, env, &.{ "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY" });
    return c;
}

// Zig 0.15.2 uses overlapped Winsock I/O with an infinite completion wait. Socket
// timeouts do not apply there. Use synchronous I/O ONLY below std's TLS wrapper.
fn windowsRead(r: *std.Io.Reader, w: *std.Io.Writer, limit: std.Io.Limit) std.Io.Reader.StreamError!usize {
    const socket_reader: *std.net.Stream.Reader = @alignCast(@fieldParentPtr("interface_state", r));
    const dest = limit.slice(try w.writableSliceGreedy(1));
    if (dest.len == 0) return 0;
    const ws = std.os.windows.ws2_32;
    var buf: ws.WSABUF = .{ .buf = dest.ptr, .len = @intCast(@min(dest.len, std.math.maxInt(u32))) };
    var flags: u32 = 0;
    var n: u32 = 0;
    if (ws.WSARecv(socket_reader.getStream().handle, @ptrCast(&buf), 1, &n, &flags, null, null) == ws.SOCKET_ERROR) return error.ReadFailed;
    if (n == 0) return error.EndOfStream;
    w.advance(n);
    return n;
}

fn windowsWrite(w: *std.Io.Writer, data: []const []const u8, splat: usize) std.Io.Writer.Error!usize {
    const socket_writer: *std.net.Stream.Writer = @alignCast(@fieldParentPtr("interface", w));
    const bytes = bytes: {
        if (w.buffered().len > 0) break :bytes w.buffered();
        for (data[0 .. data.len - 1]) |part| if (part.len > 0) break :bytes part;
        if (splat > 0) break :bytes data[data.len - 1];
        return 0;
    };
    if (bytes.len == 0) return 0;
    const n = std.posix.send(socket_writer.getStream().handle, bytes, 0) catch return error.WriteFailed;
    if (n == 0) return error.WriteFailed;
    return w.consume(n);
}

fn setSocketTimeout(conn: *std.http.Client.Connection, ms: u64) Error!void {
    const stream = conn.stream_reader.getStream();
    if (builtin.os.tag == .windows) {
        const ws = std.os.windows.ws2_32;
        const timeout: u32 = @intCast(@min(ms, std.math.maxInt(i32)));
        const bytes = std.mem.asBytes(&timeout);
        for ([_]i32{ ws.SO.RCVTIMEO, ws.SO.SNDTIMEO }) |option| {
            if (ws.setsockopt(stream.handle, ws.SOL.SOCKET, option, bytes.ptr, @intCast(bytes.len)) == ws.SOCKET_ERROR) return Error.Network;
        }
        conn.stream_reader.interface().vtable = &.{ .stream = windowsRead };
        conn.stream_writer.interface.vtable = &.{ .drain = windowsWrite };
    } else {
        const tv: std.posix.timeval = .{ .sec = @intCast(ms / 1000), .usec = @intCast(ms % 1000 * 1000) };
        for ([_]u32{ std.posix.SO.RCVTIMEO, std.posix.SO.SNDTIMEO }) |option| {
            std.posix.setsockopt(stream.handle, std.posix.SOL.SOCKET, option, std.mem.asBytes(&tv)) catch return Error.Network;
        }
    }
}

// Zig 0.15.2 hides Connection.Tls and cannot wrap a pre-established stream. Match
// its two fields and allocation layout so std Request/Connection own TLS I/O and
// destruction after CONNECT. This version-pinned workaround must track std on upgrades.
const Tunnel = struct {
    client: std.crypto.tls.Client,
    connection: std.http.Client.Connection,
};
comptime {
    if (builtin.zig_version.order(.{ .major = 0, .minor = 15, .patch = 2 }) != .eq)
        @compileError("review TLS-over-CONNECT Connection.Tls layout for this Zig version");
}

fn connectTunnel(c: *std.http.Client, proxy: *const std.http.Client.Proxy, host: []const u8, port: u16, idle_ms: u64) Error!*std.http.Client.Connection {
    const stream = std.net.tcpConnectToHost(c.allocator, proxy.host, proxy.port) catch |e| return networkError(e);
    errdefer stream.close();
    const read_len = c.tls_buffer_size + c.read_buffer_size;
    const alloc_len = @sizeOf(Tunnel) + host.len + read_len + c.tls_buffer_size + c.write_buffer_size + c.tls_buffer_size;
    const base = c.allocator.alignedAlloc(u8, .of(Tunnel), alloc_len) catch util.oom();
    errdefer c.allocator.free(base);
    const host_buf = base[@sizeOf(Tunnel)..][0..host.len];
    @memcpy(host_buf, host);
    const tls_read = host_buf.ptr[host_buf.len..][0..read_len];
    const socket_write = tls_read.ptr[tls_read.len..][0..c.tls_buffer_size];
    const tls_write = socket_write.ptr[socket_write.len..][0..c.write_buffer_size];
    const socket_read = tls_write.ptr[tls_write.len..][0..c.tls_buffer_size];
    const tunnel: *Tunnel = @ptrCast(base);
    const conn = &tunnel.connection;
    conn.* = .{
        .client = c,
        .stream_writer = stream.writer(socket_write),
        .stream_reader = stream.reader(socket_read),
        .pool_node = .{},
        .port = port,
        .host_len = @intCast(host.len),
        .proxied = false, // Origin GET must not carry proxy credentials or an absolute URI.
        .closing = true,
        .protocol = .plain,
    };
    try setSocketTimeout(conn, idle_ms); // Before CONNECT and TLS, including Windows sync I/O.
    const proxy_headers: []const std.http.Header = if (proxy.authorization) |auth| &.{.{ .name = "proxy-authorization", .value = auth }} else &.{};
    var req = c.request(.CONNECT, .{ .scheme = "http", .host = .{ .raw = host }, .port = port }, .{
        .connection = conn,
        .redirect_behavior = .unhandled,
        .extra_headers = proxy_headers,
        .headers = .{ .accept_encoding = .omit },
    }) catch |e| return networkError(e);
    // The connection is not in std's pool until TLS succeeds. Never drain a CONNECT body.
    defer {
        req.connection = null;
        req.deinit();
    }
    req.accept_encoding = @splat(true);
    req.sendBodiless() catch |e| return networkError(e);
    const response = req.receiveHead(&.{}) catch |e| return networkError(e);
    const status: u16 = @intFromEnum(response.head.status);
    if (status < 200 or status >= 300) {
        std.debug.print("HTTP proxy CONNECT rejected (HTTP {d}){s}\n", .{ status, if (status == 407) "; check proxy credentials" else "" });
        return if (status == 407) Error.ProxyAuthenticationRequired else Error.ProxyRefused;
    }
    tunnel.client = std.crypto.tls.Client.init(conn.stream_reader.interface(), &conn.stream_writer.interface, .{
        .host = .{ .explicit = host },
        .ca = .{ .bundle = c.ca_bundle },
        .read_buffer = tls_read,
        .write_buffer = tls_write,
        .allow_truncation_attacks = true, // Same as std HTTPS; size/hash also guard downloads.
    }) catch |e| {
        if (e == error.ReadFailed or e == error.WriteFailed) return Error.Network;
        std.debug.print("HTTPS origin TLS verification/handshake failed: {s}\n", .{@errorName(e)});
        return Error.TlsVerificationFailed;
    };
    conn.protocol = .tls;
    conn.closing = true;
    c.connection_pool.addUsed(conn);
    return conn;
}

const ContentRange = struct { start: u64, end: u64, total: u64 };
fn contentRange(v: []const u8) ?ContentRange {
    if (!std.mem.startsWith(u8, v, "bytes ")) return null;
    const rest = v[6..];
    const dash = std.mem.indexOfScalar(u8, rest, '-') orelse return null;
    const slash = std.mem.indexOfScalarPos(u8, rest, dash + 1, '/') orelse return null;
    const start = decimal(rest[0..dash]) orelse return null;
    const end = decimal(rest[dash + 1 .. slash]) orelse return null;
    const total = decimal(rest[slash + 1 ..]) orelse return null;
    if (end < start or end >= total) return null;
    return .{ .start = start, .end = end, .total = total };
}

const Head = struct { status: u16, retry_after: ?u64, range: ?ContentRange, length: ?u64, body: *std.Io.Reader };

// On success the caller owns req; on error this function releases it. Each redirect
// releases the old response without draining a potentially stalled/unbounded body.
fn getHead(c: *std.http.Client, env: *const std.process.EnvMap, req: *std.http.Client.Request, url: []const u8, headers: []const std.http.Header, idle_ms: u64, redirect_buffer: []u8) Error!Head {
    var uri = std.Uri.parse(url) catch return Error.BadUrl;
    var aux = redirect_buffer;
    var redirects: usize = 0;
    while (true) {
        const protocol = std.http.Client.Protocol.fromUri(uri) orelse return Error.BadUrl;
        var host_buffer: [std.Uri.host_name_max]u8 = undefined;
        const host = uri.getHost(&host_buffer) catch return Error.BadUrl;
        const port = uri.port orelse @as(u16, if (protocol == .tls) 443 else 80);
        const bypass = noProxy(env, host, port);
        var connection: ?*std.http.Client.Connection = null;
        if (protocol == .tls) {
            const variable = if (bypass) null else proxyVariable(env);
            if (variable != null and (c.https_proxy == null or c.https_proxy.?.protocol != .plain)) {
                std.debug.print("{s}: https:// proxy transport (TLS to proxy) or proxy scheme unsupported; use an http:// CONNECT proxy\n", .{variable.?});
                return Error.UnsupportedProxy;
            }
            try loadRoots(c, env);
            if (variable != null) connection = try connectTunnel(c, c.https_proxy.?, host, port, idle_ms);
        }
        const saved_http_proxy = c.http_proxy;
        const saved_https_proxy = c.https_proxy;
        c.https_proxy = null; // Never call std's unsafe HTTPS proxy fallback.
        if (bypass) c.http_proxy = null;
        defer {
            c.http_proxy = saved_http_proxy;
            c.https_proxy = saved_https_proxy;
        }
        req.* = c.request(.GET, uri, .{
            .connection = connection,
            .extra_headers = headers, // Only Range / cache-control, never credentials.
            .redirect_behavior = .unhandled,
            .keep_alive = false,
            .headers = .{ .accept_encoding = .{ .override = "identity" } },
        }) catch |e| {
            if (connection) |conn| c.connection_pool.release(conn);
            return networkError(e);
        };
        // Also covers failures before receiveHead changes the connection's closing flag.
        req.connection.?.closing = true;
        errdefer req.deinit();
        // Inspect status before enforcing identity on a body we will consume.
        // Encoded error/redirect bodies are discarded, not decompressed.
        req.accept_encoding = @splat(true);
        try setSocketTimeout(req.connection.?, idle_ms);
        req.sendBodiless() catch |e| return networkError(e);
        var response = req.receiveHead(&.{}) catch |e| return switch (e) {
            error.HttpContentEncodingUnsupported => Error.HttpStatus,
            else => networkError(e),
        };
        const status: u16 = @intFromEnum(response.head.status);
        switch (status) {
            301, 302, 303, 307, 308 => {
                if (redirects == MAX_REDIRECTS) return Error.HttpStatus;
                const location = response.head.location orelse return Error.BadUrl;
                if (location.len > aux.len) return Error.BadUrl;
                @memcpy(aux[0..location.len], location);
                uri = uri.resolveInPlace(location.len, &aux) catch return Error.BadUrl;
                redirects += 1;
                req.deinit();
                continue;
            },
            else => {},
        }
        if ((status == 200 or status == 206) and response.head.content_encoding != .identity) return Error.HttpStatus;
        var retry_after: ?u64 = null;
        var range: ?ContentRange = null;
        var range_count: usize = 0;
        var it = response.head.iterateHeaders();
        while (it.next()) |h| {
            if (std.ascii.eqlIgnoreCase(h.name, "retry-after")) retry_after = retryAfterMs(h.value);
            if (std.ascii.eqlIgnoreCase(h.name, "content-range")) {
                range_count += 1;
                range = contentRange(h.value);
            }
        }
        if (range_count != 1) range = null;
        const length = response.head.content_length;
        return .{ .status = status, .retry_after = retry_after, .range = range, .length = length, .body = response.reader(&.{}) };
    }
}

// readSliceShort fills its entire buffer before returning, losing bytes on a later
// error. readVec commits each available chunk, preserving even small stalled prefixes.
fn readChunk(reader: *std.Io.Reader, buf: []u8) Error!?usize {
    while (true) {
        var data: [1][]u8 = .{buf};
        const n = reader.readVec(&data) catch |e| return switch (e) {
            error.EndOfStream => null,
            error.ReadFailed => Error.Network,
        };
        if (n > 0) return n;
    }
}

fn readAll(a: std.mem.Allocator, head: Head, max: usize) Error![]u8 {
    if (head.length) |len| if (len > max) return Error.TooLarge;
    var list: std.ArrayList(u8) = .empty;
    defer list.deinit(a);
    var buf: [8192]u8 = undefined;
    while (try readChunk(head.body, buf[0..@min(buf.len, max - list.items.len +| 1)])) |n| {
        if (n > max - list.items.len) return Error.TooLarge;
        list.appendSlice(a, buf[0..n]) catch util.oom();
    }
    if (head.length) |len| if (list.items.len != len) return Error.Network;
    return list.toOwnedSlice(a) catch util.oom();
}

pub fn fetchSmall(a: std.mem.Allocator, env: *const std.process.EnvMap, url: []const u8, max_bytes: usize) Error![]u8 {
    var proxy_arena = std.heap.ArenaAllocator.init(a);
    defer proxy_arena.deinit();
    var c = try client(a, env, proxy_arena.allocator());
    defer c.deinit();
    const idle = tuningMs(env, "DSH_MANAGER_TEST_INACTIVITY_MS", 30_000);
    const base = tuningMs(env, "DSH_MANAGER_TEST_RETRY_MS", 1000);
    var redirect_buffer: [8192]u8 = undefined;
    var last_error: Error = Error.Network;
    for (0..MAX_ATTEMPTS) |attempt| {
        var retry_after: ?u64 = null;
        retry: {
            var req: std.http.Client.Request = undefined;
            const head = getHead(&c, env, &req, url, &.{.{ .name = "cache-control", .value = "no-cache" }}, idle, &redirect_buffer) catch |e| {
                if (e != Error.Network) return e;
                last_error = e;
                break :retry;
            };
            defer req.deinit();
            if (retryableStatus(head.status)) {
                last_error = Error.HttpStatus;
                retry_after = head.retry_after;
                break :retry;
            }
            if (head.status != 200) return Error.HttpStatus;
            return readAll(a, head, max_bytes) catch |e| {
                if (e != Error.Network) return e;
                last_error = e;
                break :retry;
            };
        }
        if (attempt + 1 < MAX_ATTEMPTS) std.Thread.sleep(backoffMs(@intCast(attempt + 1), base, retry_after) * std.time.ns_per_ms);
    }
    return last_error;
}

fn discardPartial(path: []const u8) Error!void {
    std.fs.cwd().deleteFile(path) catch |e| switch (e) {
        error.FileNotFound => {},
        else => return Error.FileSystem,
    };
}

fn verifyFile(file: std.fs.File, expect: Expected) Error!bool {
    if ((file.stat() catch return Error.FileSystem).size != expect.size) return false;
    file.seekTo(0) catch return Error.FileSystem;
    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    var buf: [8192]u8 = undefined;
    while (true) {
        const n = file.read(&buf) catch return Error.FileSystem;
        if (n == 0) break;
        hasher.update(buf[0..n]);
    }
    const digest = hasher.finalResult();
    return std.mem.eql(u8, &digest, &expect.sha256);
}

fn saveBody(head: Head, part: []const u8, offset: u64, expect: Expected, progress: ?*const fn (u64, u64) void) Error!void {
    const file = std.fs.cwd().createFile(part, .{ .read = true, .truncate = offset == 0 }) catch return Error.FileSystem;
    defer file.close();
    file.seekTo(offset) catch return Error.FileSystem;
    var done = offset;
    if (progress) |cb| cb(done, expect.size);
    var buf: [8192]u8 = undefined;
    while (try readChunk(head.body, &buf)) |n| {
        if (n > expect.size - done) return Error.PartialTooLarge;
        file.writeAll(buf[0..n]) catch return Error.FileSystem;
        done += n;
        if (progress) |cb| cb(done, expect.size);
    }
    if (done != expect.size) return Error.DownloadFailed;
    if (!try verifyFile(file, expect)) return Error.HashMismatch;
}

/// The private, adjacent .part must have trusted ancestors and a single writer.
/// Failed transfers retain resumable bytes; only matching size + whole-file SHA-256
/// allows rename. No failure deletes or changes an existing verified destination.
pub fn download(a: std.mem.Allocator, env: *const std.process.EnvMap, url: []const u8, dest_path: []const u8, expect: Expected, progress: ?*const fn (done: u64, total: u64) void) Error!void {
    const part = std.fmt.allocPrint(a, "{s}.part", .{dest_path}) catch util.oom();
    defer a.free(part);
    var proxy_arena = std.heap.ArenaAllocator.init(a);
    defer proxy_arena.deinit();
    var c = try client(a, env, proxy_arena.allocator());
    defer c.deinit();
    const idle = tuningMs(env, "DSH_MANAGER_TEST_INACTIVITY_MS", 30_000);
    const base = tuningMs(env, "DSH_MANAGER_TEST_RETRY_MS", 1000);
    var redirect_buffer: [8192]u8 = undefined;
    var restarted_hash = false;
    var last_error: Error = Error.DownloadFailed;
    for (0..MAX_ATTEMPTS) |attempt| {
        var retry_after: ?u64 = null;
        retry: {
            const stat = std.fs.cwd().statFile(part) catch |e| switch (e) {
                error.FileNotFound => null,
                else => return Error.FileSystem,
            };
            var offset = if (stat) |s| s.size else 0;
            if (offset > expect.size) return Error.PartialTooLarge;
            var range_buf: [64]u8 = undefined;
            const range = if (offset > 0) std.fmt.bufPrint(&range_buf, "bytes={d}-", .{offset}) catch unreachable else null;
            const headers: []const std.http.Header = if (range) |r| &.{.{ .name = "range", .value = r }} else &.{};
            var req: std.http.Client.Request = undefined;
            const head = getHead(&c, env, &req, url, headers, idle, &redirect_buffer) catch |e| {
                if (e != Error.Network) return e;
                last_error = e;
                break :retry;
            };
            defer req.deinit();
            if (retryableStatus(head.status)) {
                last_error = Error.HttpStatus;
                retry_after = head.retry_after;
                break :retry;
            }
            if (head.status == 416 or (head.status == 206 and (head.range == null or head.range.?.start != offset or head.range.?.total != expect.size))) {
                try discardPartial(part);
                last_error = Error.DownloadFailed;
                break :retry;
            }
            if (head.status != 200 and head.status != 206) return Error.HttpStatus;
            if (head.status == 200) offset = 0;
            saveBody(head, part, offset, expect, progress) catch |e| {
                switch (e) {
                    Error.HashMismatch => {
                        try discardPartial(part); // saveBody has already closed it (Windows).
                        if (offset == 0 or restarted_hash) return e;
                        restarted_hash = true;
                    },
                    Error.PartialTooLarge => {
                        try discardPartial(part);
                        return e;
                    },
                    Error.Network, Error.DownloadFailed => {},
                    else => return e,
                }
                last_error = e;
                break :retry;
            };
            std.fs.cwd().rename(part, dest_path) catch return Error.FileSystem;
            return;
        }
        if (attempt + 1 < MAX_ATTEMPTS) std.Thread.sleep(backoffMs(@intCast(attempt + 1), base, retry_after) * std.time.ns_per_ms);
    }
    return last_error;
}

test "Retry-After accepts HTTP dates and ignores invalid hints" {
    try std.testing.expectEqual(@as(?u64, 60_000), retryAfterMs("Thu, 01 Jan 2099 00:00:00 GMT"));
    try std.testing.expectEqual(@as(?u64, 0), retryAfterMs("Sun, 06 Nov 1994 08:49:37 GMT"));
    try std.testing.expectEqual(@as(?u64, 0), retryAfterMs("Sunday, 06-Nov-94 08:49:37 GMT"));
    try std.testing.expectEqual(@as(?u64, 0), retryAfterMs("Sun Nov  6 08:49:37 1994"));
    try std.testing.expectEqual(@as(?u64, null), retryAfterMs("not a date"));
    try std.testing.expectEqual(@as(?u64, null), retryAfterMs("Sun, 31 Feb 2099 08:49:37 GMT"));
}

test "Retry-After caps seconds before multiplication" {
    try std.testing.expectEqual(@as(?u64, 60_000), retryAfterMs("18446744073709551615"));
    try std.testing.expectEqual(@as(?u64, 60_000), retryAfterMs("184467440737095516150000"));
    try std.testing.expectEqual(@as(?u64, 0), retryAfterMs("0"));
    try std.testing.expectEqual(@as(?u64, 1000), retryAfterMs(" 1\t"));
    try std.testing.expectEqual(@as(?u64, null), retryAfterMs("-1"));
    try std.testing.expectEqual(@as(?u64, null), retryAfterMs("1.5"));
    try std.testing.expectEqual(@as(u64, 60_000), backoffMs(5, std.math.maxInt(u64), null));
}

test "endpoints allocations belong to the caller, tuning is test-only" {
    const a = std.testing.allocator;
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    try env.put("DSH_MANAGER_TEST_ORIGIN", "http://fixture.example/");
    const production = endpoints(a, &env);
    defer production.deinit(a);
    try std.testing.expect(std.mem.startsWith(u8, production.runtime_index, "https://raw.githubusercontent.com/"));
    try env.put("DSH_MANAGER_TEST_INACTIVITY_MS", "2");
    try std.testing.expectEqual(@as(u64, 30_000), tuningMs(&env, "DSH_MANAGER_TEST_INACTIVITY_MS", 30_000));
    try env.put("DSH_MANAGER_TEST", "1");
    const overridden = endpoints(a, &env);
    defer overridden.deinit(a);
    try std.testing.expectEqualStrings("http://fixture.example/manager-index.json", overridden.manager_index);
    try std.testing.expectEqual(@as(u64, 2), tuningMs(&env, "DSH_MANAGER_TEST_INACTIVITY_MS", 30_000));
}
