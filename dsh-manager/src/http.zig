//! Downloads and index fetches for the manager (design D5/D10). HTTP Range resume, bounded
//! retries on transient failures, Retry-After honouring, inactivity timeouts, SHA-256/size
//! verification, and production endpoints gated by DSH_MANAGER_TEST/DSH_MANAGER_TEST_ORIGIN.
//! std.http.Client only; no curl/Node/Bun/PowerShell.
const std = @import("std");
const builtin = @import("builtin");
const util = @import("util.zig");

pub const Error = error{
    /// The URL was syntactically wrong or used an unsupported scheme.
    BadUrl,
    /// A non-retryable HTTP status was returned (404, 403, etc.).
    HttpStatus,
    /// After all retry attempts the download still failed.
    DownloadFailed,
    /// The .part file is larger than the expected asset size.
    PartialTooLarge,
    /// The body fetched exceeded max_bytes.
    TooLarge,
    /// The final file's SHA-256 or size does not match the index entry.
    HashMismatch,
    /// Network-level failure (connection refused, DNS, TLS, timeout, etc.).
    Network,
};

fn testMode(env: *const std.process.EnvMap) bool {
    return std.mem.eql(u8, env.get("DSH_MANAGER_TEST") orelse "", "1");
}

fn inactivityMs(env: *const std.process.EnvMap) u64 {
    if (testMode(env)) {
        if (env.get("DSH_MANAGER_TEST_INACTIVITY_MS")) |v| {
            if (std.fmt.parseInt(u64, v, 10) catch null) |n| if (n > 0) return n;
        }
    }
    return 30_000;
}

fn retryBaseMs(env: *const std.process.EnvMap) u64 {
    if (testMode(env)) {
        if (env.get("DSH_MANAGER_TEST_RETRY_MS")) |v| {
            if (std.fmt.parseInt(u64, v, 10) catch null) |n| if (n > 0) return n;
        }
    }
    return 1_000;
}

const MAX_ATTEMPTS: u32 = 5;
const MAX_RETRY_AFTER_MS: u64 = 60_000;

/// HTTP statuses worth another attempt (same as the updater's list).
fn retryableStatus(code: u16) bool {
    return switch (code) {
        408, 425, 429, 500, 502, 503, 504 => true,
        else => false,
    };
}

/// Seconds or HTTP-date Retry-After, capped at 60 s. Non-numeric values fall back to 1 s.
fn retryAfterMs(header: ?[]const u8) ?u64 {
    const v = header orelse return null;
    if (std.fmt.parseInt(u64, v, 10) catch null) |s| return @min(s * 1000, MAX_RETRY_AFTER_MS);
    return if (v.len > 0) 1_000 else null;
}

/// Exponential backoff: `base * 2^(failures-1)`, capped at 16×.
fn backoffMs(failures: u32, base: u64, retry_after: ?u64) u64 {
    if (retry_after) |ms| return ms;
    return base * (@as(u64, 1) << @intCast(@min(failures -| 1, 4)));
}

/// Where the real fetches land. `DSH_MANAGER_TEST=1` plus `DSH_MANAGER_TEST_ORIGIN` redirect
/// everything to `<origin>/...` so tests never touch the network.
pub const Endpoints = struct {
    runtime_index: []const u8,
    manager_index: []const u8,
    download_base: []const u8,
};

pub fn endpoints(env: *const std.process.EnvMap) Endpoints {
    if (testMode(env)) {
        if (env.get("DSH_MANAGER_TEST_ORIGIN")) |origin| {
            const o = std.mem.trimRight(u8, origin, "/");
            // The caller keeps `env` alive; these allocations are fine.
            return .{
                .runtime_index = std.fmt.allocPrint(std.heap.page_allocator, "{s}/runtime-index.json", .{o}) catch util.oom(),
                .manager_index = std.fmt.allocPrint(std.heap.page_allocator, "{s}/manager-index.json", .{o}) catch util.oom(),
                .download_base = std.fmt.allocPrint(std.heap.page_allocator, "{s}/download", .{o}) catch util.oom(),
            };
        }
    }
    return .{
        .runtime_index = "https://raw.githubusercontent.com/xz-dev/dsh-bin/releases/runtime-index.json",
        .manager_index = "https://raw.githubusercontent.com/xz-dev/dsh-bin/releases/manager-index.json",
        .download_base = "https://github.com/xz-dev/dsh-bin/releases/download",
    };
}

fn setSocketTimeout(stream_reader: std.net.Stream.Reader, ms: u64) void {
    const ms_i32: i32 = @intCast(@min(ms, std.math.maxInt(i32)));
    const stream = stream_reader.getStream();
    if (builtin.os.tag == .windows) {
        const bytes = std.mem.asBytes(&ms_i32);
        _ = std.os.windows.ws2_32.setsockopt(stream.handle, std.os.windows.ws2_32.SOL.SOCKET, std.os.windows.ws2_32.SO.RCVTIMEO, bytes.ptr, @intCast(bytes.len));
    } else {
        const sec: isize = @intCast(@divTrunc(ms_i32, 1000));
        const usec: isize = @intCast(@mod(ms_i32, 1000) * 1000);
        const tv = std.posix.timeval{ .sec = sec, .usec = usec };
        std.posix.setsockopt(stream.handle, std.posix.SOL.SOCKET, std.posix.SO.RCVTIMEO, std.mem.asBytes(&tv)) catch {};
    }
}

fn errTo(e: anyerror) Error {
    return switch (e) {
        error.OutOfMemory => util.oom(),
        else => Error.Network,
    };
}

/// Proxy env vars and TLS CA bundle (lazy rescan on first HTTPS request).
fn client(a: std.mem.Allocator, env: *const std.process.EnvMap) std.http.Client {
    _ = env;
    var c = std.http.Client{ .allocator = a };
    c.initDefaultProxies(a) catch {};
    return c;
}

/// One GET (or resumed GET): `req` is filled in and the response head is parsed; the caller owns
/// `req` (deinit) and reads the body through `out.body` while `req` is alive.
const HeadResult = struct {
    status: u16,
    retry_after: ?u64,
    content_range_start: ?u64,
    content_range_total: ?u64,
    /// Body stream; points into `req`, valid until `req.deinit()`.
    body: *std.Io.Reader,
};

fn getHead(
    c: *std.http.Client,
    req: *std.http.Client.Request,
    url: []const u8,
    extra: []const std.http.Header,
    inactivity_ms: u64,
    redirect_buf: []u8,
) Error!HeadResult {
    const uri = std.Uri.parse(url) catch return Error.BadUrl;
    req.* = c.request(.GET, uri, .{
        .extra_headers = extra,
        .redirect_behavior = @enumFromInt(5),
        // A download is verified byte-for-byte against the index, so we never take
        // transfer compression; "identity" only.
        .headers = .{ .accept_encoding = .{ .override = "identity" } },
    }) catch |e| return errTo(e);
    errdefer {
        // deinit looks at reader.state; a request that never received a head has
        // `.ready` and a null connection handled correctly.
        if (req.connection != null) req.deinit();
    }

    if (req.connection) |conn| setSocketTimeout(conn.stream_reader, inactivity_ms);
    req.sendBodiless() catch |e| {
        if (req.connection) |conn| { conn.closing = true; }
        req.deinit();
        req.connection = null;
        return errTo(e);
    };

    var res = req.receiveHead(redirect_buf) catch |e| {
        if (req.connection) |conn| { conn.closing = true; }
        req.deinit();
        req.connection = null;
        return switch (e) {
            error.ReadFailed => Error.Network, // socket timeout or disconnect
            else => errTo(e),
        };
    };

    var retry_after: ?u64 = null;
    var content_range_start: ?u64 = null;
    var content_range_total: ?u64 = null;
    var it = res.head.iterateHeaders();
    while (it.next()) |h| {
        if (std.ascii.eqlIgnoreCase(h.name, "retry-after")) retry_after = retryAfterMs(h.value);
        if (std.ascii.eqlIgnoreCase(h.name, "content-range")) {
            // "bytes START-END/TOTAL" or "bytes START-END/*"
            if (std.mem.startsWith(u8, h.value, "bytes ")) {
                const rest = h.value["bytes ".len..];
                const slash = std.mem.indexOfScalar(u8, rest, '/') orelse continue;
                const dash = std.mem.indexOfScalar(u8, rest[0..slash], '-') orelse continue;
                content_range_start = std.fmt.parseInt(u64, rest[0..dash], 10) catch null;
                content_range_total = std.fmt.parseInt(u64, rest[slash + 1 ..], 10) catch null;
            }
        }
    }

    return .{
        .status = @intFromEnum(res.head.status),
        .retry_after = retry_after,
        .content_range_start = content_range_start,
        .content_range_total = content_range_total,
        .body = res.reader(&.{}),
    };
}

/// Read the body into a buffer, refusing bodies over `max`.
fn readAll(a: std.mem.Allocator, reader: *std.Io.Reader, max: usize) Error![]u8 {
    var list = std.ArrayList(u8).empty;
    var buf: [8192]u8 = undefined;
    // A short read means the body is over; calling the reader again would assert.
    while (true) {
        const n = reader.readSliceShort(&buf) catch |e| return errTo(e);
        if (list.items.len + n > max) return Error.TooLarge;
        list.appendSlice(a, buf[0..n]) catch util.oom();
        if (n < buf.len) break;
    }
    return list.toOwnedSlice(a) catch util.oom();
}

/// A small GET (index, metadata) with the same retry rules; the body may not exceed `max_bytes`.
pub fn fetchSmall(
    a: std.mem.Allocator,
    env: *const std.process.EnvMap,
    url: []const u8,
    max_bytes: usize,
) Error![]u8 {
    const tuning = .{ .inactivity = inactivityMs(env), .retry = retryBaseMs(env) };
    var c = client(a, env);
    defer c.deinit();
    var redirect_buf: [8192]u8 = undefined;
    var failures: u32 = 0;
    while (true) {
        var req: std.http.Client.Request = undefined;
        const hr = getHead(&c, &req, url, &.{ .{ .name = "cache-control", .value = "no-cache" } }, tuning.inactivity, &redirect_buf) catch |e| {
            if (e == Error.BadUrl) return e;
            failures += 1;
            if (failures >= MAX_ATTEMPTS) return e;
            std.Thread.sleep(backoffMs(failures, tuning.retry, null) * std.time.ns_per_ms);
            continue;
        };
        defer if (req.connection != null) req.deinit();

        if (retryableStatus(hr.status)) {
            req.deinit();
            req.connection = null;
            failures += 1;
            if (failures >= MAX_ATTEMPTS) return Error.HttpStatus;
            std.Thread.sleep(backoffMs(failures, tuning.retry, hr.retry_after) * std.time.ns_per_ms);
            continue;
        }
        if (hr.status != 200) return Error.HttpStatus;

        return readAll(a, hr.body, max_bytes) catch |e| {
            if (e == Error.Network) {
                failures += 1;
                if (failures >= MAX_ATTEMPTS) return e;
                std.Thread.sleep(backoffMs(failures, tuning.retry, null) * std.time.ns_per_ms);
                continue;
            }
            return e;
        };
    }
}

/// Download `url` to `dest_path` with resume and verification (design D5).
/// Writes to `dest_path ++ ".part"`; renames on success. `progress` receives (done, total).
/// `expect` carries the index entry's claimed size and sha256.
pub fn download(
    a: std.mem.Allocator,
    env: *const std.process.EnvMap,
    url: []const u8,
    dest_path: []const u8,
    expect: struct { size: u64, sha256: [32]u8 },
    progress: ?*const fn (done: u64, total: u64) void,
) Error!void {
    const part_path = std.fmt.allocPrint(a, "{s}.part", .{dest_path}) catch util.oom();
    const tuning = .{ .inactivity = inactivityMs(env), .retry = retryBaseMs(env) };

    const part_stat = std.fs.cwd().statFile(part_path) catch |e| switch (e) {
        error.FileNotFound => null,
        else => return Error.Network,
    };
    var offset: u64 = if (part_stat) |s| s.size else 0;
    if (offset > expect.size) return Error.PartialTooLarge;

    var c = client(a, env);
    defer c.deinit();
    var redirect_buf: [8192]u8 = undefined;

    var failures: u32 = 0;
    var resumed_once = offset > 0;
    while (true) {
        const range_hdr: ?[]const u8 = if (offset > 0)
            std.fmt.allocPrint(a, "bytes={d}-", .{offset}) catch util.oom()
        else
            null;
        const headers: []const std.http.Header = if (range_hdr) |r|
            &.{.{ .name = "range", .value = r }}
        else
            &.{};

        var req: std.http.Client.Request = undefined;
        const hr = getHead(&c, &req, url, headers, tuning.inactivity, &redirect_buf) catch |e| {
            failures += 1;
            if (failures >= MAX_ATTEMPTS) return e;
            std.Thread.sleep(backoffMs(failures, tuning.retry, null) * std.time.ns_per_ms);
            continue;
        };
        defer if (req.connection != null) req.deinit();

        if (hr.status == 416) {
            // The kept partial does not fit; restart.
            req.deinit();
            req.connection = null;
            std.fs.cwd().deleteFile(part_path) catch {};
            offset = 0;
            resumed_once = false;
            failures += 1;
            if (failures >= MAX_ATTEMPTS) return Error.DownloadFailed;
            continue;
        }
        if (retryableStatus(hr.status)) {
            req.deinit();
            req.connection = null;
            failures += 1;
            if (failures >= MAX_ATTEMPTS) return Error.HttpStatus;
            std.Thread.sleep(backoffMs(failures, tuning.retry, hr.retry_after) * std.time.ns_per_ms);
            continue;
        }
        if (hr.status != 200 and hr.status != 206) {
            return Error.HttpStatus;
        }

        var append = false;
        if (hr.status == 206) {
            const start_ok = hr.content_range_start orelse 0;
            const total_ok = hr.content_range_total orelse 0;
            if (start_ok != offset or total_ok != expect.size) {
                // Do not splice; restart.
                req.deinit();
                req.connection = null;
                std.fs.cwd().deleteFile(part_path) catch {};
                offset = 0;
                resumed_once = false;
                failures += 1;
                if (failures >= MAX_ATTEMPTS) return Error.DownloadFailed;
                continue;
            }
            append = true;
            resumed_once = true;
        } else {
            // 200 while we asked for a Range: the server ignored it; restart.
            offset = 0;
            resumed_once = false;
        }

        const mode: std.fs.File.CreateFlags = .{ .truncate = !append };
        var file = std.fs.cwd().createFile(part_path, mode) catch |e| return errTo(e);
        var file_open = true;
        defer if (file_open) file.close();

        var hasher = std.crypto.hash.sha2.Sha256.init(.{});
        var done: u64 = offset;
        var body_buf: [8192]u8 = undefined;
        var body_failed = false;

        while (true) {
            const n = hr.body.readSliceShort(&body_buf) catch {
                body_failed = true;
                break;
            };
            if (n == 0) break;
            const chunk = body_buf[0..n];
            file.writeAll(chunk) catch |e| return errTo(e);
            hasher.update(chunk);
            done += n;
            if (progress) |cb| cb(done, expect.size);
            if (done > expect.size) {
                file.close();
                file_open = false;
                std.fs.cwd().deleteFile(part_path) catch {};
                return Error.PartialTooLarge;
            }
            if (n < body_buf.len) break; // a short read ended the body
        }

        if (body_failed or done < expect.size) {
            failures += 1;
            if (failures >= MAX_ATTEMPTS) return Error.DownloadFailed;
            std.Thread.sleep(backoffMs(failures, tuning.retry, null) * std.time.ns_per_ms);
            offset = (std.fs.cwd().statFile(part_path) catch |e| return errTo(e)).size;
            continue;
        }

        // Final verification.
        const digest = hasher.finalResult();
        if (!std.mem.eql(u8, &digest, &expect.sha256) or done != expect.size) {
            std.fs.cwd().deleteFile(part_path) catch {};
            if (resumed_once) {
                // One more try from zero when the resumed bytes were bad (the kept partial may be stale).
                resumed_once = false;
                offset = 0;
                failures += 1;
                if (failures >= MAX_ATTEMPTS) return Error.HashMismatch;
                continue;
            }
            return Error.HashMismatch;
        }

        file.close();
        file_open = false;
        std.fs.cwd().rename(part_path, dest_path) catch |e| return errTo(e);
        return;
    }
}

test {
    _ = @This();
}
