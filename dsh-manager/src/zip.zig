//! Runtime ZIP extraction (D5, DL-ESCAPE, DL-CORRUPT). The caller owns a private, empty
//! staging directory under its trusted data root and discards the tree on error.
//! Names and parent spellings are checked with portable ASCII case folding. Valid UTF-8
//! is preserved; native Unicode aliases fail exclusive creation, not portable normalization.
//! File bodies stream through fixed buffers; only path bookkeeping grows with archive metadata.
const std = @import("std");
const builtin = @import("builtin");

pub const Error = error{
    BadArchive,
    UnsupportedArchive,
    UnsafeEntryName,
    UnsupportedEntry,
    DuplicateEntry,
    ChecksumMismatch,
    OutOfMemory,
    AccessDenied,
    FileNotFound,
    IsDir,
    NotDir,
    PathAlreadyExists,
    SymLinkLoop,
    FileTooBig,
    NoSpaceLeft,
    ReadFailed,
    WriteFailed,
    Unexpected,
};

// A common limit on every target, rather than Windows' larger max_path_bytes.
const max_name_len = 4096;

fn unsafeName(name: []const u8) bool {
    const bare = if (std.mem.endsWith(u8, name, "/")) name[0 .. name.len - 1] else name;
    if (bare.len == 0 or name[0] == '/' or !std.unicode.utf8ValidateSlice(name)) return true;
    var chars = std.unicode.Utf8View.initUnchecked(name).iterator();
    while (chars.nextCodepoint()) |c| {
        if (c < 32 or (c >= 127 and c <= 159)) return true;
        if (c < 128 and std.mem.indexOfScalar(u8, "\\:<>\"|?*", @intCast(c)) != null) return true;
    }
    var parts = std.mem.splitScalar(u8, bare, '/');
    while (parts.next()) |part| {
        if (part.len == 0 or part[part.len - 1] == '.' or part[part.len - 1] == ' ') return true;
        const stem = std.mem.trimEnd(u8, part[0 .. std.mem.indexOfScalar(u8, part, '.') orelse part.len], " ");
        for ([_][]const u8{ "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$" }) |device| {
            if (std.ascii.eqlIgnoreCase(stem, device)) return true;
        }
        if (stem.len >= 4 and (std.ascii.eqlIgnoreCase(stem[0..3], "COM") or std.ascii.eqlIgnoreCase(stem[0..3], "LPT"))) {
            const number = stem[3..];
            if ((number.len == 1 and number[0] >= '1' and number[0] <= '9') or
                std.mem.eql(u8, number, "¹") or std.mem.eql(u8, number, "²") or std.mem.eql(u8, number, "³")) return true;
        }
    }
    return false;
}

fn ioErr(err: anyerror) Error {
    return switch (err) {
        error.OutOfMemory => error.OutOfMemory,
        error.AccessDenied, error.PermissionDenied => error.AccessDenied,
        error.FileNotFound => error.FileNotFound,
        error.IsDir => error.IsDir,
        error.NotDir => error.NotDir,
        error.PathAlreadyExists => error.PathAlreadyExists,
        error.SymLinkLoop => error.SymLinkLoop,
        error.FileTooBig, error.NameTooLong => error.FileTooBig,
        error.NoSpaceLeft => error.NoSpaceLeft,
        error.ReadFailed => error.ReadFailed,
        error.WriteFailed => error.WriteFailed,
        else => error.Unexpected,
    };
}

const Claim = struct {
    spelling: []const u8,
    kind: enum { file, implicit_dir, explicit_dir },
};

/// Claim every prefix before creating it. Never merge a differently spelled native alias.
fn claimPath(a: std.mem.Allocator, paths: *std.StringHashMap(Claim), dest: std.fs.Dir, name: []const u8, is_dir: bool) Error!void {
    const bare = if (is_dir) name[0 .. name.len - 1] else name;
    const spelling = try a.dupe(u8, bare);
    const folded = try std.ascii.allocLowerString(a, bare);
    var parts = std.mem.splitScalar(u8, spelling, '/');
    var end: usize = 0;
    while (parts.next()) |part| {
        end += part.len;
        const terminal = end == spelling.len;
        const directory = !terminal or is_dir;
        const entry = try paths.getOrPut(folded[0..end]);
        if (entry.found_existing) {
            const prior = entry.value_ptr;
            if (!std.mem.eql(u8, prior.spelling, spelling[0..end]) or prior.kind == .file or
                (terminal and (!is_dir or prior.kind == .explicit_dir))) return error.DuplicateEntry;
            if (terminal) prior.kind = .explicit_dir;
        } else {
            entry.value_ptr.* = .{
                .spelling = spelling[0..end],
                .kind = if (!directory) .file else if (terminal) .explicit_dir else .implicit_dir,
            };
            if (directory) {
                dest.makeDir(spelling[0..end]) catch |e| return switch (e) {
                    error.PathAlreadyExists => error.DuplicateEntry,
                    else => ioErr(e),
                };
                if (builtin.os.tag != .windows) {
                    var dir = dest.openDir(spelling[0..end], .{ .iterate = true, .no_follow = true }) catch |e| return ioErr(e);
                    defer dir.close();
                    dir.chmod(0o755) catch |e| return ioErr(e);
                }
            }
        }
        end += 1;
    }
}

/// Extra fields are not interpreted as paths or links. ZIP64 and Unix link-bearing metadata
/// are explicitly unsupported; the runtime producer emits no extra fields.
fn checkExtra(reader: *std.Io.Reader, len: u16) Error!void {
    var remaining: usize = len;
    while (remaining != 0) {
        if (remaining < 4) return error.BadArchive;
        const id = reader.takeInt(u16, .little) catch return error.BadArchive;
        const size = reader.takeInt(u16, .little) catch return error.BadArchive;
        if (size > remaining - 4) return error.BadArchive;
        if (id == 1) return error.UnsupportedArchive;
        if (id == 0x000d or id == 0x756e) return error.UnsupportedEntry;
        reader.discardAll(size) catch return error.BadArchive;
        remaining -= 4 + @as(usize, size);
    }
}

/// Destination must be absolute, with trusted ancestors, and absent or empty. No overwrite,
/// rollback or activation happens here. A no-follow root plus private staging prevents links
/// from redirecting subsequent relative writes.
pub fn extract(a: std.mem.Allocator, archive_path: []const u8, dest_path: []const u8) Error!void {
    if (!std.fs.path.isAbsolute(dest_path)) return error.UnsafeEntryName;
    std.fs.cwd().makeDir(dest_path) catch |e| if (e != error.PathAlreadyExists) return ioErr(e);
    var dest = std.fs.cwd().openDir(dest_path, .{ .iterate = true, .no_follow = true }) catch |e| return ioErr(e);
    defer dest.close();
    return extractIn(a, archive_path, dest);
}

/// Same extractor, retaining the caller's validated staging handle through all writes.
pub fn extractIn(a: std.mem.Allocator, archive_path: []const u8, dest: std.fs.Dir) Error!void {
    const file = std.fs.cwd().openFile(archive_path, .{}) catch |e| return ioErr(e);
    defer file.close();
    var central_buf: [8192]u8 = undefined;
    var central = file.reader(&central_buf);
    const size = central.getSize() catch |e| return ioErr(e);
    const end = std.zip.EndRecord.findFile(&central) catch return error.BadArchive;
    if (end.need_zip64()) return error.UnsupportedArchive;
    if (end.disk_number != 0 or end.central_directory_disk_number != 0 or end.record_count_disk != end.record_count_total)
        return error.UnsupportedArchive;
    const cd_end = size - @sizeOf(std.zip.EndRecord) - end.comment_len;
    const cd_start: u64 = end.central_directory_offset;
    if (cd_start + end.central_directory_size != cd_end) return error.BadArchive;
    central.seekTo(cd_start) catch return error.BadArchive;

    // Windows no_follow opens the reparse point itself; reject that handle before using it.
    if ((dest.stat() catch |e| return ioErr(e)).kind != .directory) return error.UnsafeEntryName;
    var contents = dest.iterate();
    if (contents.next() catch |e| return ioErr(e)) |_| return error.PathAlreadyExists;

    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const metadata = arena.allocator();
    var paths = std.StringHashMap(Claim).init(metadata);
    const Range = struct { start: u64, end: u64 };
    var ranges: std.ArrayList(Range) = .empty;
    var local_buf: [8192]u8 = undefined;
    var local = file.reader(&local_buf);
    var name_buf: [max_name_len]u8 = undefined;
    var local_name_buf: [max_name_len]u8 = undefined;
    var cd_at = cd_start;
    for (0..end.record_count_total) |_| {
        if (cd_end - cd_at < @sizeOf(std.zip.CentralDirectoryFileHeader)) return error.BadArchive;
        const header = central.interface.takeStruct(std.zip.CentralDirectoryFileHeader, .little) catch return error.BadArchive;
        if (!std.mem.eql(u8, &header.signature, &std.zip.central_file_header_sig)) return error.BadArchive;
        const record_len = @sizeOf(std.zip.CentralDirectoryFileHeader) + @as(u64, header.filename_len) + header.extra_len + header.comment_len;
        if (record_len > cd_end - cd_at) return error.BadArchive;
        cd_at += record_len;
        if (header.compressed_size == 0xffffffff or header.uncompressed_size == 0xffffffff or
            header.local_file_header_offset == 0xffffffff or header.version_needed_to_extract > 20 or header.disk_number != 0)
            return error.UnsupportedArchive;
        const flags: u16 = @bitCast(header.flags);
        // Only UTF-8 and DEFLATE level hints. No encryption, descriptors or patched/masked data.
        if (flags & ~@as(u16, 0x0806) != 0 or (header.compression_method != .store and header.compression_method != .deflate))
            return error.UnsupportedArchive;
        if (header.filename_len > max_name_len) return error.UnsafeEntryName;
        const name = name_buf[0..header.filename_len];
        central.interface.readSliceAll(name) catch return error.BadArchive;
        try checkExtra(&central.interface, header.extra_len);
        central.interface.discardAll(header.comment_len) catch return error.BadArchive;
        if (unsafeName(name)) return error.UnsafeEntryName;
        const is_dir = std.mem.endsWith(u8, name, "/");
        const unix_mode = header.external_file_attributes >> 16;
        const file_type = unix_mode & 0o170000;
        if ((file_type != 0 and file_type != (if (is_dir) @as(u32, 0o040000) else 0o100000)) or
            header.external_file_attributes & 0x448 != 0 or (!is_dir and header.external_file_attributes & 0x10 != 0))
            return error.UnsupportedEntry;

        const local_at: u64 = header.local_file_header_offset;
        if (local_at > cd_start or cd_start - local_at < @sizeOf(std.zip.LocalFileHeader)) return error.BadArchive;
        local.seekTo(local_at) catch return error.BadArchive;
        const lh = local.interface.takeStruct(std.zip.LocalFileHeader, .little) catch return error.BadArchive;
        if (lh.compressed_size == 0xffffffff or lh.uncompressed_size == 0xffffffff or lh.version_needed_to_extract > 20)
            return error.UnsupportedArchive;
        if (!std.mem.eql(u8, &lh.signature, &std.zip.local_file_header_sig) or
            lh.version_needed_to_extract != header.version_needed_to_extract or @as(u16, @bitCast(lh.flags)) != flags or
            lh.compression_method != header.compression_method or lh.filename_len != name.len or
            lh.crc32 != header.crc32 or lh.compressed_size != header.compressed_size or lh.uncompressed_size != header.uncompressed_size)
            return error.BadArchive;
        const data_at = local_at + @sizeOf(std.zip.LocalFileHeader) + lh.filename_len + lh.extra_len;
        if (data_at > cd_start or header.compressed_size > cd_start - data_at) return error.BadArchive;
        const local_name = local_name_buf[0..lh.filename_len];
        local.interface.readSliceAll(local_name) catch return error.BadArchive;
        if (!std.mem.eql(u8, name, local_name)) return error.BadArchive;
        try checkExtra(&local.interface, lh.extra_len);
        try ranges.append(metadata, .{ .start = local_at, .end = data_at + header.compressed_size });

        if (is_dir) {
            if (header.uncompressed_size != 0 or header.compressed_size != 0 or header.crc32 != 0) return error.BadArchive;
            try claimPath(metadata, &paths, dest, name, true);
            continue;
        }
        if (header.compression_method == .store and header.compressed_size != header.uncompressed_size) return error.ChecksumMismatch;
        try claimPath(metadata, &paths, dest, name, false);
        const output = dest.createFile(name, .{ .exclusive = true, .mode = if (builtin.os.tag == .windows) 0 else 0o600 }) catch |e| return switch (e) {
            error.PathAlreadyExists => error.DuplicateEntry,
            else => ioErr(e),
        };
        defer output.close();
        var compressed_buf: [8192]u8 = undefined;
        // Bounded compatibility tolerance: suffix bytes after raw-DEFLATE EOB are not decoded.
        var compressed = local.interface.limited(.limited(header.compressed_size), &compressed_buf);
        var flate_buf: [std.compress.flate.max_window_len]u8 = undefined;
        var inflate = std.compress.flate.Decompress.init(&compressed.interface, .raw, &flate_buf);
        const body = if (header.compression_method == .store) &compressed.interface else &inflate.reader;
        var crc = std.hash.Crc32.init();
        var count: u64 = 0;
        var chunk: [8192]u8 = undefined;
        while (true) {
            const n = body.readSliceShort(&chunk) catch return error.BadArchive;
            if (n > header.uncompressed_size - count) return error.ChecksumMismatch;
            if (n == 0) break;
            output.writeAll(chunk[0..n]) catch |e| return ioErr(e);
            crc.update(chunk[0..n]);
            count += n;
        }
        if (count != header.uncompressed_size or crc.final() != header.crc32) return error.ChecksumMismatch;
        if (builtin.os.tag != .windows) {
            const unix_host = header.version_made_by >> 8 == 3;
            output.chmod(if (unix_host and unix_mode & 0o111 != 0) 0o755 else 0o644) catch |e| return ioErr(e);
        }
    }
    if (cd_at != cd_end) return error.BadArchive;
    // Validate extents, not signature-looking bytes inside compressed suffixes. Central order
    // need not match local order; sorting also rejects overlapping or multiply claimed headers.
    std.mem.sort(Range, ranges.items, {}, struct {
        fn lessThan(_: void, lhs: Range, rhs: Range) bool {
            return lhs.start < rhs.start;
        }
    }.lessThan);
    for (ranges.items, 0..) |range, i| {
        if (i != 0 and range.start < ranges.items[i - 1].end) return error.BadArchive;
    }
}

// Test archives use independent ZIP records. The checked-in fixture comes from runtime/zip.ts.
const TestEntry = struct {
    name: []const u8,
    data: []const u8 = "",
    mode: u32 = 0o100644,
    made_by: u16 = (3 << 8) | 20,
    method: std.zip.CompressionMethod = .store,
    body: ?[]const u8 = null,
    size: ?u32 = null,
    crc: ?u32 = null,
    flags: u16 = 0x0800,
    extra: []const u8 = "",
};

fn testZip(entries: []const TestEntry) ![]u8 {
    const a = std.testing.allocator;
    var out = std.Io.Writer.Allocating.init(a);
    defer out.deinit();
    var central = std.Io.Writer.Allocating.init(a);
    defer central.deinit();
    for (entries) |e| {
        const offset: u32 = @intCast(out.written().len);
        var compressed = std.Io.Writer.Allocating.init(a);
        defer compressed.deinit();
        const body = e.body orelse if (e.method == .deflate) blk: {
            // Independent RFC1951 stored blocks; Zig 0.15.2's compressor is unfinished.
            var remaining = e.data;
            while (true) {
                const len: u16 = @intCast(@min(remaining.len, 65535));
                try compressed.writer.writeByte(if (len == remaining.len) 1 else 0);
                try compressed.writer.writeInt(u16, len, .little);
                try compressed.writer.writeInt(u16, ~len, .little);
                try compressed.writer.writeAll(remaining[0..len]);
                remaining = remaining[len..];
                if (remaining.len == 0) break;
            }
            break :blk compressed.written();
        } else e.data;
        const crc = e.crc orelse std.hash.Crc32.hash(e.data);
        const size = e.size orelse @as(u32, @intCast(e.data.len));
        try out.writer.writeStruct(std.zip.LocalFileHeader{
            .signature = std.zip.local_file_header_sig,
            .version_needed_to_extract = 20,
            .flags = @bitCast(e.flags),
            .compression_method = e.method,
            .last_modification_time = 0,
            .last_modification_date = 33,
            .crc32 = crc,
            .compressed_size = @intCast(body.len),
            .uncompressed_size = size,
            .filename_len = @intCast(e.name.len),
            .extra_len = @intCast(e.extra.len),
        }, .little);
        try out.writer.writeAll(e.name);
        try out.writer.writeAll(e.extra);
        try out.writer.writeAll(body);
        try central.writer.writeStruct(std.zip.CentralDirectoryFileHeader{
            .signature = std.zip.central_file_header_sig,
            .version_made_by = e.made_by,
            .version_needed_to_extract = 20,
            .flags = @bitCast(e.flags),
            .compression_method = e.method,
            .last_modification_time = 0,
            .last_modification_date = 33,
            .crc32 = crc,
            .compressed_size = @intCast(body.len),
            .uncompressed_size = size,
            .filename_len = @intCast(e.name.len),
            .extra_len = @intCast(e.extra.len),
            .comment_len = 0,
            .disk_number = 0,
            .internal_file_attributes = 0,
            .external_file_attributes = (e.mode << 16) | (if (std.mem.endsWith(u8, e.name, "/")) @as(u32, 0x10) else 0),
            .local_file_header_offset = offset,
        }, .little);
        try central.writer.writeAll(e.name);
        try central.writer.writeAll(e.extra);
    }
    const offset: u32 = @intCast(out.written().len);
    try out.writer.writeAll(central.written());
    try out.writer.writeStruct(std.zip.EndRecord{
        .signature = std.zip.end_record_sig,
        .disk_number = 0,
        .central_directory_disk_number = 0,
        .record_count_disk = @intCast(entries.len),
        .record_count_total = @intCast(entries.len),
        .central_directory_size = @intCast(central.written().len),
        .central_directory_offset = offset,
        .comment_len = 0,
    }, .little);
    return out.toOwnedSlice();
}

const Stage = struct {
    tmp: std.testing.TmpDir,
    archive: []u8,
    dest: []u8,

    fn init(bytes: []const u8) !Stage {
        const a = std.testing.allocator;
        var tmp = std.testing.tmpDir(.{});
        errdefer tmp.cleanup();
        const root = try tmp.dir.realpathAlloc(a, ".");
        defer a.free(root);
        const archive = try std.fs.path.join(a, &.{ root, "archive.zip" });
        errdefer a.free(archive);
        const dest = try std.fs.path.join(a, &.{ root, "out" });
        errdefer a.free(dest);
        try tmp.dir.writeFile(.{ .sub_path = "archive.zip", .data = bytes });
        try tmp.dir.writeFile(.{ .sub_path = "active", .data = "installed runtime stays intact" });
        try tmp.dir.makeDir("out");
        return .{ .tmp = tmp, .archive = archive, .dest = dest };
    }

    fn deinit(s: *Stage) void {
        std.testing.allocator.free(s.archive);
        std.testing.allocator.free(s.dest);
        s.tmp.cleanup();
    }

    fn expectContent(s: *Stage, path: []const u8, expected: []const u8) !void {
        var dir = try std.fs.cwd().openDir(s.dest, .{});
        defer dir.close();
        const actual = try dir.readFileAlloc(std.testing.allocator, path, expected.len + 1);
        defer std.testing.allocator.free(actual);
        try std.testing.expectEqualStrings(expected, actual);
    }

    fn expectMode(s: *Stage, path: []const u8, expected: u32) !void {
        if (builtin.os.tag == .windows) return;
        var dir = try std.fs.cwd().openDir(s.dest, .{});
        defer dir.close();
        try std.testing.expectEqual(expected, (try dir.statFile(path)).mode & 0o7777);
    }

    fn expectContained(s: *Stage) !void {
        const active = try s.tmp.dir.readFileAlloc(std.testing.allocator, "active", 64);
        defer std.testing.allocator.free(active);
        try std.testing.expectEqualStrings("installed runtime stays intact", active);
        var dir = try s.tmp.dir.openDir(".", .{ .iterate = true });
        defer dir.close();
        var it = dir.iterate();
        while (try it.next()) |entry| {
            try std.testing.expect(std.mem.eql(u8, entry.name, "archive.zip") or
                std.mem.eql(u8, entry.name, "out") or std.mem.eql(u8, entry.name, "active"));
        }
    }
};

fn refusedBytes(bytes: []const u8, expected: Error) !void {
    var s = try Stage.init(bytes);
    defer s.deinit();
    try std.testing.expectError(expected, extract(std.testing.allocator, s.archive, s.dest));
    try s.expectContained();
}

fn refused(entries: []const TestEntry, expected: Error) !void {
    const bytes = try testZip(entries);
    defer std.testing.allocator.free(bytes);
    try refusedBytes(bytes, expected);
}

fn centralOffset(bytes: []const u8) usize {
    return std.mem.readInt(u32, bytes[bytes.len - 6 ..][0..4], .little);
}

fn setInt(bytes: []u8, offset: usize, comptime T: type, value: T) void {
    std.mem.writeInt(T, bytes[offset..][0..@sizeOf(T)], value, .little);
}

test "DL-CORRUPT real producer fixture extracts independently of cwd with normalized modes" {
    var s = try Stage.init(@embedFile("fixtures/runtime-sample.zip"));
    defer s.deinit();
    try extract(std.testing.allocator, s.archive, s.dest);
    try s.expectContent("bundle.json", "{\"kind\":\"dsh-runtime\",\"schemaVersion\":1}\n");
    try s.expectContent("dsh-native", "#!/fake native entry\n");
    try s.expectContent("lib/helper.sh", "echo hi\n" ** 200);
    try s.expectContent("lib/tool", "tool\n");
    try s.expectMode("dsh-native", 0o755);
    try s.expectMode("lib/tool", 0o755);
    try s.expectMode("lib/helper.sh", 0o644);
    try s.expectContained();
}

test "DL-CORRUPT create a fresh staging directory without panic" {
    const bytes = try testZip(&.{.{ .name = "bundle.json", .data = "runtime" }});
    defer std.testing.allocator.free(bytes);
    var s = try Stage.init(bytes);
    defer s.deinit();
    try s.tmp.dir.deleteDir("out");
    try extract(std.testing.allocator, s.archive, s.dest);
    try s.expectContent("bundle.json", "runtime");
    try s.expectContained();
}

test "DL-CORRUPT preserve tree content including UTF-8 and implicit then explicit parents" {
    const bytes = try testZip(&.{
        .{ .name = "app/lib/插件.txt", .data = "plugin" },
        .{ .name = "app/", .mode = 0o040755 },
        .{ .name = "app/lib/data", .data = "data" },
        .{ .name = "empty" },
        .{ .name = "noattrs", .data = "plain", .made_by = 0, .mode = 0 },
    });
    defer std.testing.allocator.free(bytes);
    var s = try Stage.init(bytes);
    defer s.deinit();
    try extract(std.testing.allocator, s.archive, s.dest);
    try s.expectContent("app/lib/插件.txt", "plugin");
    try s.expectContent("app/lib/data", "data");
    try s.expectContent("empty", "");
    try s.expectMode("app", 0o755);
    try s.expectMode("app/lib", 0o755);
    try s.expectMode("noattrs", 0o644);
    try s.expectContained();
}

test "DL-CORRUPT any Unix execute bit gives 0755 and special permission bits are dropped" {
    for ([_]u32{ 0o100, 0o010, 0o001, 0o7111 }) |bits| {
        const bytes = try testZip(&.{.{ .name = "run", .data = "executable", .mode = 0o100000 | bits }});
        defer std.testing.allocator.free(bytes);
        var s = try Stage.init(bytes);
        defer s.deinit();
        try extract(std.testing.allocator, s.archive, s.dest);
        try s.expectMode("run", 0o755);
    }
}

test "DL-ESCAPE refuse traversal and nonportable names on every host" {
    for ([_][]const u8{
        "../active",   "app/../../active", "/absolute",   "C:/active",  "C:active",    "\\\\server\\share", "app\\file",
        "",            "/",                "app//file",   "app/./file", "app/../file", "app//",             ".",
        "..",          "nul\x00file",      "control\x01", "tab\t",      "del\x7f",     "c1\xc2\x85",        "invalid\xff",
        "app:stream",  "file.",            "dir /file",   "dir./file",  "file ",       "star*",             "question?",
        "<file>",      "pipe|",            "quote\"",     "CON",        "con.txt",     "PrN",               "NUL.log",
        "AUX/file",    "con .txt",         "COM1.txt",    "lpt9",       "COM¹",       "LPT².txt",         "CONIN$",
        "CONOUT$.log",
    }) |name| {
        try refused(&.{.{ .name = name }}, error.UnsafeEntryName);
    }
}

test "DL-ESCAPE refuse oversized names without a buffer overrun" {
    try refused(&.{.{ .name = "x" ** 4097 }}, error.UnsafeEntryName);
}

test "DL-ESCAPE refuse symlinks special files and conflicting directory attributes" {
    for ([_]u32{ 0o120777, 0o010644, 0o020644, 0o060644, 0o140644, 0o040755 }) |mode| {
        try refused(&.{.{ .name = "entry", .mode = mode }}, error.UnsupportedEntry);
    }
    try refused(&.{.{ .name = "dir/", .mode = 0o100644 }}, error.UnsupportedEntry);
    const bytes = try testZip(&.{.{ .name = "entry", .made_by = 0, .mode = 0 }});
    defer std.testing.allocator.free(bytes);
    for ([_]u32{ 0x08, 0x10, 0x40, 0x400 }) |attrs| {
        setInt(bytes, centralOffset(bytes) + 38, u32, attrs);
        try refusedBytes(bytes, error.UnsupportedEntry);
    }
}

test "DL-ESCAPE retain duplicate keys after table growth" {
    try refused(&.{
        .{ .name = "aaa", .data = "one" }, .{ .name = "bbb" }, .{ .name = "ccc" },                        .{ .name = "ddd" },
        .{ .name = "eee" },                .{ .name = "fff" }, .{ .name = "ggg" },                        .{ .name = "hhh" },
        .{ .name = "iii" },                .{ .name = "jjj" }, .{ .name = "aaa", .data = "replacement" },
    }, error.DuplicateEntry);
}

test "DL-ESCAPE refuse ASCII case aliases in leaves and parents" {
    try refused(&.{ .{ .name = "app.txt" }, .{ .name = "APP.TXT" } }, error.DuplicateEntry);
    try refused(&.{ .{ .name = "app/first" }, .{ .name = "APP/second" } }, error.DuplicateEntry);
    try refused(&.{ .{ .name = "app/", .mode = 0o040755 }, .{ .name = "APP/second" } }, error.DuplicateEntry);
}

test "DL-ESCAPE refuse explicit duplicate directories and file directory conflicts" {
    try refused(&.{ .{ .name = "app/", .mode = 0o040755 }, .{ .name = "app/", .mode = 0o040755 } }, error.DuplicateEntry);
    try refused(&.{ .{ .name = "app/", .mode = 0o040755 }, .{ .name = "app" } }, error.DuplicateEntry);
    try refused(&.{ .{ .name = "app" }, .{ .name = "app/file" } }, error.DuplicateEntry);
    try refused(&.{ .{ .name = "app/file" }, .{ .name = "app" } }, error.DuplicateEntry);
}

// Detect actual FS aliases; Linux case-sensitive filesystems normally skip these two scenarios.
fn nativeAlias(directory: bool) ![2][]const u8 {
    for ([_][2][]const u8{ .{ "é", "e\xcc\x81" }, .{ "Ä", "ä" } }) |pair| {
        var tmp = std.testing.tmpDir(.{});
        defer tmp.cleanup();
        if (directory) {
            try tmp.dir.makeDir(pair[0]);
            tmp.dir.makeDir(pair[1]) catch |e| switch (e) {
                error.PathAlreadyExists => return pair,
                else => return e,
            };
        } else {
            const first = try tmp.dir.createFile(pair[0], .{ .exclusive = true });
            first.close();
            const second = tmp.dir.createFile(pair[1], .{ .exclusive = true }) catch |e| switch (e) {
                error.PathAlreadyExists => return pair,
                else => return e,
            };
            second.close();
        }
    }
    std.debug.print("native Unicode {s} aliases not supported by test filesystem; skipped\n", .{if (directory) "parent" else "leaf"});
    return error.SkipZigTest;
}

test "DL-ESCAPE native Unicode leaf aliases fail closed when filesystem aliases them" {
    const pair = try nativeAlias(false);
    const bytes = try testZip(&.{ .{ .name = pair[0], .data = "one" }, .{ .name = pair[1], .data = "two" } });
    defer std.testing.allocator.free(bytes);
    var s = try Stage.init(bytes);
    defer s.deinit();
    try std.testing.expectError(error.DuplicateEntry, extract(std.testing.allocator, s.archive, s.dest));
    try s.expectContent(pair[0], "one");
    try s.expectContained();
}

test "DL-ESCAPE native Unicode parent aliases fail closed instead of merging" {
    const pair = try nativeAlias(true);
    const a = std.testing.allocator;
    const first = try std.fmt.allocPrint(a, "{s}/first", .{pair[0]});
    defer a.free(first);
    const second = try std.fmt.allocPrint(a, "{s}/second", .{pair[1]});
    defer a.free(second);
    const bytes = try testZip(&.{ .{ .name = first, .data = "one" }, .{ .name = second, .data = "two" } });
    defer a.free(bytes);
    var s = try Stage.init(bytes);
    defer s.deinit();
    try std.testing.expectError(error.DuplicateEntry, extract(a, s.archive, s.dest));
    try s.expectContent(first, "one");
    try s.expectContained();
}

test "DL-CORRUPT refuse CRC and output size mismatches for stored and deflated files" {
    for ([_]std.zip.CompressionMethod{ .store, .deflate }) |method| {
        try refused(&.{.{ .name = "file", .data = "hello", .method = method, .crc = 0xdeadbeef }}, error.ChecksumMismatch);
        try refused(&.{.{ .name = "file", .data = "hello", .method = method, .size = 3, .crc = 0xe50bf11b }}, error.ChecksumMismatch);
        try refused(&.{.{ .name = "file", .data = "hello", .method = method, .size = 9 }}, error.ChecksumMismatch);
    }
}

test "DL-CORRUPT deflate must terminate within declared compressed body" {
    // RFC1951 stored block holding hello, deliberately missing its final byte.
    try refused(&.{.{ .name = "file", .data = "hello", .method = .deflate, .body = "\x01\x05\x00\xfa\xffhell" }}, error.BadArchive);
    // Last block flag cleared: declared output is complete, but DEFLATE stream is not.
    try refused(&.{.{ .name = "file", .data = "hello", .method = .deflate, .body = "\x00\x05\x00\xfa\xffhello" }}, error.BadArchive);
    // A shorter advertised output and matching prefix CRC must not hide more decoded data.
    try refused(&.{.{ .name = "file", .data = "hello", .method = .deflate, .size = 3, .crc = 0xe50bf11b }}, error.ChecksumMismatch);
}

test "DL-CORRUPT bounded deflate suffix compatibility decodes only first stream" {
    const hello = "\x01\x05\x00\xfa\xffhello";
    const second = "\x01\x05\x00\xfa\xffworld";
    for ([_][]const u8{ hello ++ "junk", hello ++ second }) |body| {
        const bytes = try testZip(&.{.{ .name = "file", .data = "hello", .method = .deflate, .body = body }});
        defer std.testing.allocator.free(bytes);
        var s = try Stage.init(bytes);
        defer s.deinit();
        try extract(std.testing.allocator, s.archive, s.dest);
        try s.expectContent("file", "hello");
        try s.expectContained();
    }
    const bytes = try testZip(&.{.{ .name = "empty", .method = .deflate, .body = "\x03\x00" ++ second }});
    defer std.testing.allocator.free(bytes);
    var s = try Stage.init(bytes);
    defer s.deinit();
    try extract(std.testing.allocator, s.archive, s.dest);
    try s.expectContent("empty", "");
    try s.expectContained();
}

test "DL-CORRUPT empty output and late decoder errors still require genuine stream completion" {
    try refused(&.{.{ .name = "empty", .method = .deflate, .body = "" }}, error.BadArchive);
    try refused(&.{.{ .name = "empty", .method = .deflate, .body = "\x00\x00\x00\xff\xff" }}, error.BadArchive);
    try refused(&.{.{ .name = "empty", .method = .deflate, .body = "\x03" }}, error.BadArchive);
    try refused(&.{.{ .name = "empty", .method = .deflate, .body = "\x03\x00", .crc = 1 }}, error.ChecksumMismatch);
    try refused(&.{.{ .name = "empty", .method = .deflate, .body = "\x03\x00", .size = 1 }}, error.ChecksumMismatch);
    try refused(&.{.{ .name = "empty", .method = .deflate, .body = "\x01\x05\x00\xfa\xffhello", .crc = 0 }}, error.ChecksumMismatch);
    try refused(&.{.{ .name = "file", .data = "hello", .method = .deflate, .body = "\x00\x05\x00\xfa\xffhello\x07" }}, error.BadArchive);
    // EOF must still be requested after an exact output-buffer-sized block.
    try refused(&.{.{ .name = "file", .data = "x" ** 8192, .method = .deflate, .body = "\x00\x00\x20\xff\xdf" ++ "x" ** 8192 }}, error.BadArchive);
}

test "DL-CORRUPT a deflate suffix cannot cover another registered entry" {
    const bytes = try testZip(&.{
        .{ .name = "one", .data = "hello", .method = .deflate, .body = "\x01\x05\x00\xfa\xffhello" },
        .{ .name = "two", .data = "world" },
    });
    defer std.testing.allocator.free(bytes);
    const cd = centralOffset(bytes);
    const extent: u32 = @intCast(cd - 33);
    setInt(bytes, 18, u32, extent);
    setInt(bytes, cd + 20, u32, extent);
    try refusedBytes(bytes, error.BadArchive);
}

test "DL-CORRUPT refuse local header name flags method CRC and size disagreement" {
    for ([_]usize{ 6, 8, 14, 18, 22, 26, 30 }) |offset| {
        const bytes = try testZip(&.{.{ .name = "file", .data = "hello" }});
        defer std.testing.allocator.free(bytes);
        bytes[offset] ^= 1;
        try refusedBytes(bytes, error.BadArchive);
    }
}

test "DL-CORRUPT refuse ZIP64 requested only by a local header" {
    const bytes = try testZip(&.{.{ .name = "file", .data = "hello" }});
    defer std.testing.allocator.free(bytes);
    setInt(bytes, 22, u32, 0xffffffff);
    try refusedBytes(bytes, error.UnsupportedArchive);
}

test "DL-CORRUPT refuse bodies and central records extending beyond archive boundaries" {
    const bytes = try testZip(&.{.{ .name = "file", .data = "hello" }});
    defer std.testing.allocator.free(bytes);
    const cd = centralOffset(bytes);
    setInt(bytes, 18, u32, 1000);
    setInt(bytes, cd + 20, u32, 1000);
    try refusedBytes(bytes, error.BadArchive);
    setInt(bytes, 18, u32, 5);
    setInt(bytes, cd + 20, u32, 5);
    setInt(bytes, cd + 28, u16, 4000);
    try refusedBytes(bytes, error.BadArchive);
    try refusedBytes(bytes[0 .. bytes.len - 5], error.BadArchive);
}

test "DL-CORRUPT accept empty archives and ZIP comments but refuse trailing data" {
    const a = std.testing.allocator;
    const empty = try testZip(&.{});
    defer a.free(empty);
    var s = try Stage.init(empty);
    defer s.deinit();
    try extract(a, s.archive, s.dest);
    try s.expectContained();
    const bytes = try testZip(&.{.{ .name = "file", .data = "hello" }});
    defer a.free(bytes);
    const commented = try a.alloc(u8, bytes.len + 4);
    defer a.free(commented);
    @memcpy(commented[0..bytes.len], bytes);
    @memcpy(commented[bytes.len..], "note");
    setInt(commented, bytes.len - 2, u16, 4);
    var c = try Stage.init(commented);
    defer c.deinit();
    try extract(a, c.archive, c.dest);
    try c.expectContent("file", "hello");
    setInt(commented, bytes.len - 2, u16, 0);
    try refusedBytes(commented, error.BadArchive);
    const junk = try a.dupe(u8, empty);
    defer a.free(junk);
    setInt(junk, junk.len - 10, u32, 1);
    try refusedBytes(junk, error.BadArchive);
}

test "DL-CORRUPT preserve registered extents with central records in different local order" {
    const bytes = try testZip(&.{ .{ .name = "one", .data = "first" }, .{ .name = "two", .data = "second" } });
    defer std.testing.allocator.free(bytes);
    const cd = centralOffset(bytes);
    var saved: [49]u8 = undefined;
    @memcpy(&saved, bytes[cd..][0..49]);
    @memcpy(bytes[cd..][0..49], bytes[cd + 49 ..][0..49]);
    @memcpy(bytes[cd + 49 ..][0..49], &saved);
    var s = try Stage.init(bytes);
    defer s.deinit();
    try extract(std.testing.allocator, s.archive, s.dest);
    try s.expectContent("one", "first");
    try s.expectContent("two", "second");
    try s.expectContained();
}

test "DL-CORRUPT refuse encrypted unsupported ZIP64 and multi-disk archives" {
    try refused(&.{.{ .name = "file", .flags = 0x0808 }}, error.UnsupportedArchive);
    try refused(&.{.{ .name = "file", .flags = 0x0801 }}, error.UnsupportedArchive);
    try refused(&.{.{ .name = "file", .flags = 0x0840 }}, error.UnsupportedArchive);
    try refused(&.{.{ .name = "file", .method = @enumFromInt(99) }}, error.UnsupportedArchive);
    try refused(&.{.{ .name = "file", .extra = "\x01\x00\x00\x00" }}, error.UnsupportedArchive);
    for ([_]usize{ 8, 10, 12, 16 }) |field| {
        const bytes = try testZip(&.{.{ .name = "file" }});
        defer std.testing.allocator.free(bytes);
        const end = bytes.len - 22;
        if (field < 12) setInt(bytes, end + field, u16, 0xffff) else setInt(bytes, end + field, u32, 0xffffffff);
        try refusedBytes(bytes, error.UnsupportedArchive);
    }
    for ([_]usize{ 20, 24, 42 }) |field| {
        const bytes = try testZip(&.{.{ .name = "file" }});
        defer std.testing.allocator.free(bytes);
        setInt(bytes, centralOffset(bytes) + field, u32, 0xffffffff);
        try refusedBytes(bytes, error.UnsupportedArchive);
    }
    for ([_]usize{ 4, 6, 8 }) |field| {
        const bytes = try testZip(&.{.{ .name = "file" }});
        defer std.testing.allocator.free(bytes);
        setInt(bytes, bytes.len - 22 + field, u16, if (field == 8) 0 else 1);
        try refusedBytes(bytes, error.UnsupportedArchive);
    }
    const bytes = try testZip(&.{.{ .name = "file" }});
    defer std.testing.allocator.free(bytes);
    setInt(bytes, centralOffset(bytes) + 34, u16, 1);
    try refusedBytes(bytes, error.UnsupportedArchive);
}

test "DL-CORRUPT refuse directory payloads and invalid extra metadata" {
    try refused(&.{.{ .name = "dir/", .mode = 0o040755, .data = "hidden" }}, error.BadArchive);
    try refused(&.{.{ .name = "dir/", .mode = 0o040755, .crc = 1 }}, error.BadArchive);
    try refused(&.{.{ .name = "file", .extra = "\x02\x00\x02\x00x" }}, error.BadArchive);
    try refused(&.{.{ .name = "file", .extra = "x" }}, error.BadArchive);
    try refused(&.{.{ .name = "file", .extra = "\x0d\x00\x00\x00" }}, error.UnsupportedEntry);
}

test "DL-CORRUPT large deflated file streams with small allocator budget" {
    const data = "runtime content\n" ** 65536;
    const bytes = try testZip(&.{.{ .name = "large", .data = data, .method = .deflate }});
    defer std.testing.allocator.free(bytes);
    var s = try Stage.init(bytes);
    defer s.deinit();
    var memory: [16384]u8 = undefined;
    var bounded = std.heap.FixedBufferAllocator.init(&memory);
    try extract(bounded.allocator(), s.archive, s.dest);
    try s.expectContent("large", data);
    try s.expectContained();
}

test "DL-ESCAPE refuse nonempty destinations without changing existing content" {
    const bytes = try testZip(&.{.{ .name = "file", .data = "replacement" }});
    defer std.testing.allocator.free(bytes);
    var s = try Stage.init(bytes);
    defer s.deinit();
    try s.tmp.dir.writeFile(.{ .sub_path = "out/file", .data = "existing" });
    try std.testing.expectError(error.PathAlreadyExists, extract(std.testing.allocator, s.archive, s.dest));
    try s.expectContent("file", "existing");
    try s.expectContained();
}

test "DL-ESCAPE refuse a symlink staging root without writing through it" {
    const bytes = try testZip(&.{.{ .name = "file", .data = "unsafe" }});
    defer std.testing.allocator.free(bytes);
    var s = try Stage.init(bytes);
    defer s.deinit();
    try s.tmp.dir.deleteDir("out");
    try s.tmp.dir.makeDir("outside");
    s.tmp.dir.symLink("outside", "out", .{ .is_directory = true }) catch |e| switch (e) {
        error.AccessDenied => return error.SkipZigTest,
        else => return e,
    };
    if (extract(std.testing.allocator, s.archive, s.dest)) |_| {
        return error.TestExpectedError;
    } else |e| {
        try std.testing.expect(e == error.NotDir or e == error.SymLinkLoop or e == error.UnsafeEntryName);
    }
    try std.testing.expectError(error.FileNotFound, s.tmp.dir.access("outside/file", .{}));
}
