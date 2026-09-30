//! Safe extraction of runtime/addon zip archives (distribution-lifecycle DL-ESCAPE, DL-CORRUPT;
//! design D5). Stored and deflate entries only, no ZIP64, no encryption, no symlinks or other
//! special files, no unsafe names, no duplicate entries; CRC-32 and uncompressed size are verified.
//! `extract` never writes outside `dest`; on any error the caller discards the destination tree.
const std = @import("std");
const builtin = @import("builtin");

pub const Error = error{
    BadArchive, // not a zip / unreadable structure
    UnsupportedArchive, // zip64, encryption, multi-disk, unknown compression
    UnsafeEntryName, // empty, absolute, backslash, NUL, '..' or '.' segments
    UnsupportedEntry, // symlink, hard link or other non-regular entry
    DuplicateEntry,
    ChecksumMismatch, // CRC-32 or size mismatch
    OutOfMemory,
    // I/O on the archive or the destination
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

const sample_path = "../test/fixtures/runtime-sample.zip";

const S_IFMT: u32 = 0o170000 << 16;
const S_IFREG_U: u32 = 0o100000 << 16;
const S_IFDIR_U: u32 = 0o040000 << 16;

/// Why `name` is not a safe relative entry path, or null when it is safe.
fn unsafeName(name: []const u8) ?void {
    const bare = if (std.mem.endsWith(u8, name, "/")) name[0 .. name.len - 1] else name;
    if (bare.len == 0) return {};
    if (name[0] == '/' or (name.len >= 2 and std.ascii.isAlphabetic(name[0]) and name[1] == ':')) return {};
    if (std.mem.indexOfScalar(u8, name, '\\') != null) return {};
    if (std.mem.indexOfScalar(u8, name, 0) != null) return {};
    var it = std.mem.splitScalar(u8, bare, '/');
    while (it.next()) |part| {
        if (part.len == 0 or std.mem.eql(u8, part, ".") or std.mem.eql(u8, part, "..")) return {};
    }
    return null;
}

fn ioErr(err: anyerror) Error {
    return switch (err) {
        error.OutOfMemory => error.OutOfMemory,
        error.AccessDenied => error.AccessDenied,
        error.FileNotFound => error.FileNotFound,
        error.IsDir => error.IsDir,
        error.NotDir => error.NotDir,
        error.PathAlreadyExists => error.PathAlreadyExists,
        error.SymLinkLoop => error.SymLinkLoop,
        error.FileTooBig => error.FileTooBig,
        error.NoSpaceLeft => error.NoSpaceLeft,
        else => error.Unexpected,
    };
}

/// Extract `archive_path` into `dest_path`, an absolute directory that is created and must not
/// exist yet or be empty. On any error the caller discards `dest`; partial trees are possible and
/// are never rolled back here. Nothing is ever written outside `dest`.
pub fn extract(a: std.mem.Allocator, archive_path: []const u8, dest_path: []const u8) Error!void {
    var file = std.fs.cwd().openFile(archive_path, .{}) catch |e| return ioErr(e);
    defer file.close();
    var buf: [8192]u8 = undefined;
    var reader = file.reader(&buf);

    var it = std.zip.Iterator.init(&reader) catch |e| return switch (e) {
        error.ZipNoEndRecord, error.ZipTruncated, error.EndOfStream, error.ReadFailed,
        error.ZipBadLocatorSig, error.ZipBadEndRecord64Sig, error.ZipEndRecord64SizeTooSmall,
        error.ZipEndRecord64UnhandledExtraData,
        error.Zip64RecordCountTotalMismatch, error.Zip64CentralDirectoryOffsetMismatch,
        error.Zip64CentralDirectorySizeMismatch,
        => error.BadArchive,
        error.ZipMultiDiskUnsupported, error.ZipUnsupportedZip64DiskCount,
        error.ZipUnsupportedVersion,
        => error.UnsupportedArchive,
        else => ioErr(e),
    };

    // Refuse to populate a non-empty existing directory: dest must not exist yet or be empty.
    var dest = std.fs.cwd().openDir(dest_path, .{ .iterate = true }) catch |e| switch (e) {
        error.FileNotFound => blk: {
            std.fs.cwd().makePath(dest_path) catch |me| return ioErr(me);
            break :blk std.fs.cwd().openDir(dest_path, .{}) catch |me| return ioErr(me);
        },
        else => return ioErr(e),
    };
    defer dest.close();
    {
        var it2 = dest.iterate();
        if (it2.next() catch |e| return ioErr(e)) |_| return error.PathAlreadyExists;
    }

    var names = std.StringHashMap(void).init(a);
    defer names.deinit();
    var filename_buf: [std.fs.max_path_bytes]u8 = undefined;

    while (true) {
        const maybe_entry = it.next() catch |e| return switch (e) {
            error.ZipEncryptionUnsupported, error.ZipMultiDiskUnsupported => error.UnsupportedArchive,
            error.ZipCdOversized, error.ZipCdUndersized, error.ZipBadCdOffset,
            error.ZipBadExtraFieldSize, error.EndOfStream, error.ReadFailed => error.BadArchive,
            else => ioErr(e),
        };
        const entry = maybe_entry orelse break;
        const filename = filename_buf[0..entry.filename_len];
        {
            reader.seekTo(entry.header_zip_offset + @sizeOf(std.zip.CentralDirectoryFileHeader)) catch |e| return ioErr(e);
            reader.interface.readSliceAll(filename) catch return error.BadArchive;
        }
        const is_dir = std.mem.endsWith(u8, filename, "/");
        if (unsafeName(filename) != null) return error.UnsafeEntryName;
        const method: u16 = @intFromEnum(entry.compression_method);
        if (method != 0 and method != 8) return error.UnsupportedArchive;
        // External attributes live in the central directory record we just read.
        var unix_mode: ?u32 = null;
        {
            reader.seekTo(entry.header_zip_offset + 4) catch |e| return ioErr(e);
            const made_by = reader.interface.takeInt(u16, .little) catch return error.BadArchive;
            if ((made_by >> 8) == 3) {
                reader.seekTo(entry.header_zip_offset + 38) catch |e| return ioErr(e);
                unix_mode = reader.interface.takeInt(u32, .little) catch return error.BadArchive;
            }
        }
        if (unix_mode) |m| {
            const ty = m & S_IFMT;
            const want: u32 = if (is_dir) S_IFDIR_U else S_IFREG_U;
            if (ty != 0 and ty != want) return error.UnsupportedEntry;
        }
        const key = if (is_dir) filename[0 .. filename.len - 1] else filename;
        if (try names.fetchPut(key, {}) != null) return error.DuplicateEntry;
        if (is_dir) {
            dest.makePath(key) catch |e| return ioErr(e);
            continue;
        }
        // Extract the file body, verifying CRC-32 and size ourselves (std.zip.Entry.extract does
        // neither on POSIX).
        if (std.fs.path.dirname(filename)) |dirn| {
            dest.makePath(dirn) catch |e| return ioErr(e);
        }
        const mode: std.fs.File.Mode = if (builtin.os.tag == .windows) 0 else blk: {
            const m = unix_mode orelse 0;
            break :blk if ((m & 0o111) != 0) @as(u32, 0o755) else 0o644;
        };
        var out_file = dest.createFile(filename, .{ .exclusive = true, .mode = mode }) catch |e| return ioErr(e);
        defer out_file.close();
        var fbuf: [8192]u8 = undefined;
        var fw = out_file.writer(&fbuf);
        var hw = HashingWriter{ .w = &fw.interface };
        const local_data = localDataOffset(&reader, entry) catch |e| return switch (e) {
            error.BadArchive => error.BadArchive,
            else => ioErr(e),
        };
        reader.seekTo(local_data) catch |e| return ioErr(e);
        var written: u64 = 0;
        switch (entry.compression_method) {
            .store => {
                reader.interface.streamExact64(&hw.writer, entry.uncompressed_size) catch |e| return switch (e) {
                    error.EndOfStream => error.BadArchive,
                    error.WriteFailed => ioErr(hw.err orelse error.WriteFailed),
                    else => ioErr(e),
                };
                written = hw.count;
            },
            .deflate => {
                var flate_buf: [std.compress.flate.max_window_len]u8 = undefined;
                var decomp = std.compress.flate.Decompress.init(&reader.interface, .raw, &flate_buf);
                decomp.reader.streamExact64(&hw.writer, entry.uncompressed_size) catch |e| return switch (e) {
                    error.EndOfStream => error.BadArchive,
                    error.WriteFailed => ioErr(hw.err orelse (decomp.err orelse error.WriteFailed)),
                    else => ioErr(e),
                };
                written = hw.count;
            },
            else => return error.UnsupportedArchive,
        }
        fw.interface.flush() catch return ioErr(fw.err orelse error.WriteFailed);
        if (written != entry.uncompressed_size or hw.crc.final() != entry.crc32)
            return error.ChecksumMismatch;
    }
}

/// A Writer that CRC-32s and counts everything it writes into the inner file writer's buffer.
const HashingWriter = struct {
    w: *std.Io.Writer,
    writer: std.Io.Writer = .{ .vtable = &.{
        .drain = drain,
        .sendFile = std.Io.Writer.unimplementedSendFile,
        .flush = std.Io.Writer.noopFlush,
        .rebase = std.Io.Writer.unreachableRebase,
    }, .buffer = &.{}, .end = 0 },
    crc: std.hash.Crc32 = .init(),
    count: u64 = 0,
    err: ?anyerror = null,

    pub fn drain(w: *std.Io.Writer, data: []const []const u8, splat: usize) std.Io.Writer.Error!usize {
        const self: *HashingWriter = @fieldParentPtr("writer", w);
        if (self.err != null) return error.WriteFailed;
        const last = data[data.len - 1];
        var n: usize = 0;
        for (data[0 .. data.len - 1]) |chunk| {
            self.w.writeAll(chunk) catch |e| {
                self.err = e;
                return error.WriteFailed;
            };
            self.crc.update(chunk);
            n += chunk.len;
        }
        for (0..splat) |_| {
            self.w.writeAll(last) catch |e| {
                self.err = e;
                return error.WriteFailed;
            };
            self.crc.update(last);
            n += last.len;
        }
        self.count += n;
        return n;
    }
};

/// Offset of the file body inside the archive: past the local header, its name and its extra field.
fn localDataOffset(reader: *std.fs.File.Reader, entry: std.zip.Iterator.Entry) !u64 {
    try reader.seekTo(entry.file_offset);
    const hdr = reader.interface.takeStruct(std.zip.LocalFileHeader, .little) catch return error.BadArchive;
    if (!std.mem.eql(u8, &hdr.signature, &std.zip.local_file_header_sig)) return error.BadArchive;
    return entry.file_offset + @sizeOf(std.zip.LocalFileHeader) + hdr.filename_len + hdr.extra_len;
}

// ── in-test zip writer (stored entries; optional raw-deflate body) ──────────────────────────────────

const TestEntry = struct { name: []const u8, data: []const u8 = "", mode: ?u32 = null, deflate: bool = false, crc: ?u32 = null };

fn testZip(a: std.mem.Allocator, entries: []const TestEntry) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    var central: std.ArrayList(u8) = .empty;
    const w = out.writer(a);
    const cw = central.writer(a);
    var offset: u32 = 0;
    for (entries) |e| {
        const body = if (e.deflate) blk: {
            var inf: std.Io.Writer.Allocating = .init(a);
            var cbuf: [std.compress.flate.max_window_len]u8 = undefined;
            var comp = std.compress.flate.Compress.init(&inf.writer, &cbuf, .{ .container = .raw, .level = .best });
            comp.writer.writeAll(e.data) catch return error.OutOfMemory;
            comp.writer.flush() catch return error.OutOfMemory;
            comp.end() catch return error.OutOfMemory;
            break :blk try inf.toOwnedSlice();
        } else e.data;
        const crc = e.crc orelse std.hash.Crc32.hash(e.data);
        const mode: u32 = e.mode orelse 0;
        const made_by: u16 = if (e.mode == null) 0 else (3 << 8) | 20;
        try w.writeAll("PK\x03\x04");
        try w.writeInt(u16, 20, .little);
        try w.writeInt(u16, 0x0800, .little);
        try w.writeInt(u16, if (e.deflate) 8 else 0, .little);
        try w.writeInt(u16, 0, .little);
        try w.writeInt(u16, (1 << 5) | 1, .little);
        try w.writeInt(u32, crc, .little);
        try w.writeInt(u32, @intCast(body.len), .little);
        try w.writeInt(u32, @intCast(e.data.len), .little);
        try w.writeInt(u16, @intCast(e.name.len), .little);
        try w.writeInt(u16, 0, .little);
        try w.writeAll(e.name);
        try w.writeAll(body);
        try cw.writeAll("PK\x01\x02");
        try cw.writeInt(u16, made_by, .little);
        try cw.writeInt(u16, 20, .little);
        try cw.writeInt(u16, 0x0800, .little);
        try cw.writeInt(u16, if (e.deflate) 8 else 0, .little);
        try cw.writeInt(u16, 0, .little);
        try cw.writeInt(u16, (1 << 5) | 1, .little);
        try cw.writeInt(u32, crc, .little);
        try cw.writeInt(u32, @intCast(body.len), .little);
        try cw.writeInt(u32, @intCast(e.data.len), .little);
        try cw.writeInt(u16, @intCast(e.name.len), .little);
        try cw.writeInt(u16, 0, .little); // extra
        try cw.writeInt(u16, 0, .little); // comment
        try cw.writeInt(u16, 0, .little); // disk
        try cw.writeInt(u16, 0, .little); // internal attrs
        try cw.writeInt(u32, mode, .little);
        try cw.writeInt(u32, offset, .little);
        try cw.writeAll(e.name);
        offset += @intCast(30 + e.name.len + body.len);
    }
    const cd_off: u32 = offset;
    const cd_size: u32 = @intCast(central.items.len);
    try out.appendSlice(a, central.items);
    try w.writeAll("PK\x05\x06");
    try w.writeInt(u16, 0, .little);
    try w.writeInt(u16, 0, .little);
    try w.writeInt(u16, @intCast(entries.len), .little);
    try w.writeInt(u16, @intCast(entries.len), .little);
    try w.writeInt(u32, cd_size, .little);
    try w.writeInt(u32, cd_off, .little);
    try w.writeInt(u16, 0, .little);
    return out.items;
}

const REG: u32 = 0o100000 << 16;
const DIR: u32 = 0o040000 << 16;
const LNK: u32 = 0o120000 << 16;
const FIFO: u32 = 0o010000 << 16;

var tmp_counter: u64 = 0;

/// Fresh temp dir + the archive bytes written next to it. Returns dest/archive paths and the dir.
fn stage(a: std.mem.Allocator, bytes: []const u8) !struct { dir: std.testing.TmpDir, archive: []u8, dest: []u8 } {
    var t = std.testing.tmpDir(.{});
    errdefer t.cleanup();
    var buf: [std.fs.max_path_bytes]u8 = undefined;
    const root = try t.dir.realpath(".", &buf);
    const archive = try std.fs.path.join(a, &.{ root, "a.zip" });
    const dest = try std.fs.path.join(a, &.{ root, "out" });
    try t.dir.writeFile(.{ .sub_path = "a.zip", .data = bytes });
    return .{ .dir = t, .archive = archive, .dest = dest };
}

fn outOfBounds(dest: []const u8) bool {
    // Any file ending up outside dest would land in the temp root: check it only holds a.zip/out.
    const parent = std.fs.path.dirname(dest).?;
    var d = std.fs.cwd().openDir(parent, .{ .iterate = true }) catch return true;
    defer d.close();
    var it = d.iterate();
    while (it.next() catch return true) |e| {
        if (!std.mem.eql(u8, e.name, "a.zip") and !std.mem.eql(u8, e.name, "out")) return true;
    }
    return false;
}

fn statMode(dest: []const u8, sub: []const u8) !u32 {
    var d = try std.fs.cwd().openDir(dest, .{});
    defer d.close();
    const st = try d.statFile(sub);
    return @intCast(st.mode & 0o777);
}

// ── tests ────────────────────────────────────────────────────────────────────────────────────────────

test "extract a valid tree with an exec file and nested dirs" {
    const a = std.testing.allocator;
    const zip = try testZip(a, &.{
        .{ .name = "dir/", .mode = DIR | (0o755 << 16) },
        .{ .name = "dir/sub/file.txt", .data = "hello", .mode = REG | (0o644 << 16) },
        .{ .name = "run", .data = "#!/bin/sh\n", .mode = REG | (0o755 << 16) },
        .{ .name = "deflated.txt", .data = "repeat me " ** 10, .mode = REG | (0o644 << 16), .deflate = true },
        .{ .name = "noattrs.txt", .data = "x" }, // no unix attrs -> regular file 0644
    });
    defer a.free(zip);
    var s = try stage(a, zip);
    defer s.dir.cleanup();
    try extract(a, s.archive, s.dest);
    if (builtin.os.tag != .windows) {
        try std.testing.expectEqual(@as(u32, 0o755), try statMode(s.dest, "run"));
        try std.testing.expectEqual(@as(u32, 0o644), try statMode(s.dest, "dir/sub/file.txt"));
        try std.testing.expectEqual(@as(u32, 0o644), try statMode(s.dest, "noattrs.txt"));
    }
    var d = try std.fs.cwd().openDir(s.dest, .{});
    defer d.close();
    try std.testing.expectEqualStrings("repeat me " ** 10, try d.readFileAlloc(a, "deflated.txt", 1 << 20));
    try std.testing.expect(!outOfBounds(s.dest));
}

fn refused(a: std.mem.Allocator, entries: []const TestEntry, expected: Error) !void {
    const zip = try testZip(a, entries);
    defer a.free(zip);
    var s = try stage(a, zip);
    defer s.dir.cleanup();
    try std.testing.expectError(expected, extract(a, s.archive, s.dest));
    try std.testing.expect(!outOfBounds(s.dest));
}

test "refuse absolute paths, traversal, backslash, empty and dot segments" {
    const a = std.testing.allocator;
    try refused(a, &.{.{ .name = "/abs.txt" }}, error.UnsafeEntryName);
    try refused(a, &.{.{ .name = "C:/evil.txt" }}, error.UnsafeEntryName);
    try refused(a, &.{.{ .name = "../up.txt" }}, error.UnsafeEntryName);
    try refused(a, &.{.{ .name = "a/../../up.txt" }}, error.UnsafeEntryName);
    try refused(a, &.{.{ .name = "a\\b.txt" }}, error.UnsafeEntryName);
    try refused(a, &.{.{ .name = "a//b.txt" }}, error.UnsafeEntryName);
    try refused(a, &.{.{ .name = "a/./b.txt" }}, error.UnsafeEntryName);
    try refused(a, &.{.{ .name = "" }}, error.UnsafeEntryName);
}

test "refuse symlink and special entries" {
    const a = std.testing.allocator;
    try refused(a, &.{.{ .name = "link", .data = "target", .mode = LNK | (0o777 << 16) }}, error.UnsupportedEntry);
    try refused(a, &.{.{ .name = "fifo", .mode = FIFO | (0o644 << 16) }}, error.UnsupportedEntry);
    // a unix dir attribute on a non-'/'-suffixed name is also not a regular file
    try refused(a, &.{.{ .name = "weird", .mode = DIR | (0o755 << 16) }}, error.UnsupportedEntry);
}

test "refuse duplicate entries" {
    const a = std.testing.allocator;
    try refused(a, &.{ .{ .name = "x.txt", .data = "1" }, .{ .name = "x.txt", .data = "2" } }, error.DuplicateEntry);
    try refused(a, &.{ .{ .name = "d/" }, .{ .name = "d", .data = "x" } }, error.DuplicateEntry);
}

test "refuse bad CRC" {
    const a = std.testing.allocator;
    try refused(a, &.{.{ .name = "x.txt", .data = "data", .crc = 0xdeadbeef }}, error.ChecksumMismatch);
}

test "refuse a truncated archive" {
    const a = std.testing.allocator;
    const zip = try testZip(a, &.{.{ .name = "x.txt", .data = "some data" }});
    defer a.free(zip);
    var s = try stage(a, zip[0 .. zip.len - 10]);
    defer s.dir.cleanup();
    try std.testing.expectError(error.BadArchive, extract(a, s.archive, s.dest));
}

test "refuse zip64 end record" {
    const a = std.testing.allocator;
    // End record with 0xffff/0xffffffff fields and no usable locator -> unsupported.
    var bytes: std.ArrayList(u8) = .empty;
    const w = bytes.writer(a);
    try w.writeAll("PK\x05\x06");
    try w.writeInt(u16, 0, .little);
    try w.writeInt(u16, 0, .little);
    try w.writeInt(u16, 0xffff, .little);
    try w.writeInt(u16, 0xffff, .little);
    try w.writeInt(u32, 0xffffffff, .little);
    try w.writeInt(u32, 0xffffffff, .little);
    try w.writeInt(u16, 0, .little);
    var s = try stage(a, bytes.items);
    defer s.dir.cleanup();
    try std.testing.expectError(error.UnsupportedArchive, extract(a, s.archive, s.dest));
}

test "refuse unknown compression method" {
    const a = std.testing.allocator;
    var bytes: std.ArrayList(u8) = .empty;
    const w = bytes.writer(a);
    var central: std.ArrayList(u8) = .empty;
    const cw = central.writer(a);
    try w.writeAll("PK\x03\x04");
    try w.writeInt(u16, 20, .little);
    try w.writeInt(u16, 0, .little);
    try w.writeInt(u16, 99, .little); // unknown method
    try w.writeInt(u16, 0, .little);
    try w.writeInt(u16, (1 << 5) | 1, .little);
    try w.writeInt(u32, 0, .little);
    try w.writeInt(u32, 0, .little);
    try w.writeInt(u32, 0, .little);
    try w.writeInt(u16, 5, .little);
    try w.writeInt(u16, 0, .little);
    try w.writeAll("x.txt");
    try cw.writeAll("PK\x01\x02");
    try cw.writeInt(u16, 20, .little);
    try cw.writeInt(u16, 20, .little);
    try cw.writeInt(u16, 0, .little);
    try cw.writeInt(u16, 99, .little);
    try cw.writeInt(u16, 0, .little);
    try cw.writeInt(u16, (1 << 5) | 1, .little);
    try cw.writeInt(u32, 0, .little);
    try cw.writeInt(u32, 0, .little);
    try cw.writeInt(u32, 0, .little);
    try cw.writeInt(u16, 5, .little);
    try cw.writeInt(u16, 0, .little);
    try cw.writeInt(u16, 0, .little);
    try cw.writeInt(u16, 0, .little);
    try cw.writeInt(u16, 0, .little);
    try cw.writeInt(u32, 0, .little);
    try cw.writeInt(u32, 0, .little);
    try cw.writeAll("x.txt");
    try bytes.appendSlice(a, central.items);
    try w.writeAll("PK\x05\x06");
    try w.writeInt(u16, 0, .little);
    try w.writeInt(u16, 0, .little);
    try w.writeInt(u16, 1, .little);
    try w.writeInt(u16, 1, .little);
    try w.writeInt(u32, @intCast(central.items.len), .little);
    try w.writeInt(u32, 35, .little);
    try w.writeInt(u16, 0, .little);
    var s = try stage(a, bytes.items);
    defer s.dir.cleanup();
    try std.testing.expectError(error.UnsupportedArchive, extract(a, s.archive, s.dest));
}

test "real writer fixture extracts with modes preserved" {
    const a = std.testing.allocator;
    const sample_bytes = try std.fs.cwd().readFileAlloc(a, sample_path, 1 << 20);
    defer a.free(sample_bytes);
    var s = try stage(a, sample_bytes);
    defer s.dir.cleanup();
    try extract(a, s.archive, s.dest);
    var d = try std.fs.cwd().openDir(s.dest, .{});
    defer d.close();
    try std.testing.expectEqualStrings("#!/fake native entry\n", try d.readFileAlloc(a, "dsh-native", 1 << 20));
    try std.testing.expectEqualStrings("echo hi\n" ** 200, try d.readFileAlloc(a, "lib/helper.sh", 1 << 20));
    if (builtin.os.tag != .windows) {
        try std.testing.expectEqual(@as(u32, 0o755), try statMode(s.dest, "dsh-native"));
        try std.testing.expectEqual(@as(u32, 0o755), try statMode(s.dest, "lib/tool"));
        try std.testing.expectEqual(@as(u32, 0o644), try statMode(s.dest, "lib/helper.sh"));
    }
    try std.testing.expect(!outOfBounds(s.dest));
}
