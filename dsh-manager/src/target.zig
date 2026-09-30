//! Runtime host identity. Never use an installed bundle or the manager's link-time ABI.
const std = @import("std");
const builtin = @import("builtin");

pub fn host() ![]const u8 {
    const native = try std.zig.system.resolveTargetQuery(.{});
    const modern = if (builtin.cpu.arch == .x86_64)
        std.Target.x86.featureSetHasAll(native.cpu.features, .{ .avx, .avx2, .bmi, .bmi2, .fma, .sse4_2 })
    else
        false;
    return id(builtin.os.tag, builtin.cpu.arch, native.abi.isMusl(), modern);
}

fn id(os: std.Target.Os.Tag, arch: std.Target.Cpu.Arch, musl: bool, modern: bool) ![]const u8 {
    return switch (os) {
        .linux => switch (arch) {
            .x86_64 => if (musl) (if (modern) "linux-x64-musl-modern" else "linux-x64-musl-baseline") else (if (modern) "linux-x64-modern" else "linux-x64-baseline"),
            .aarch64 => if (musl) "linux-arm64-musl" else "linux-arm64",
            else => error.UnsupportedHost,
        },
        .macos => switch (arch) {
            .x86_64 => if (modern) "darwin-x64-modern" else "darwin-x64-baseline",
            .aarch64 => "darwin-arm64",
            else => error.UnsupportedHost,
        },
        .windows => switch (arch) {
            .x86_64 => if (modern) "windows-x64-modern" else "windows-x64-baseline",
            .aarch64 => "windows-arm64",
            else => error.UnsupportedHost,
        },
        else => error.UnsupportedHost,
    };
}

test "FB-EMPTY host targets cover libc and CPU independently of manager ABI" {
    const t = std.testing;
    try t.expectEqualStrings("linux-x64-modern", try id(.linux, .x86_64, false, true));
    try t.expectEqualStrings("linux-x64-baseline", try id(.linux, .x86_64, false, false));
    try t.expectEqualStrings("linux-x64-musl-modern", try id(.linux, .x86_64, true, true));
    try t.expectEqualStrings("linux-x64-musl-baseline", try id(.linux, .x86_64, true, false));
    try t.expectEqualStrings("linux-arm64-musl", try id(.linux, .aarch64, true, false));
    try t.expectEqualStrings("linux-arm64", try id(.linux, .aarch64, false, false));
    try t.expectEqualStrings("darwin-x64-baseline", try id(.macos, .x86_64, false, false));
    try t.expectEqualStrings("darwin-arm64", try id(.macos, .aarch64, false, false));
    try t.expectEqualStrings("windows-x64-modern", try id(.windows, .x86_64, false, true));
    try t.expectEqualStrings("windows-arm64", try id(.windows, .aarch64, false, false));
    try t.expectError(error.UnsupportedHost, id(.linux, .riscv64, false, true));
    _ = try host();
}
