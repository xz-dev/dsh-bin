const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.option(std.builtin.OptimizeMode, "optimize", "optimization mode") orelse .ReleaseSmall;
    const version = b.option([]const u8, "version", "bundle version this launcher starts") orelse "0.0.0-dev";
    const channel = b.option([]const u8, "channel", "release or live") orelse "release";

    const options = b.addOptions();
    options.addOption([]const u8, "version", version);
    options.addOption([]const u8, "channel", channel);

    const module = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .strip = optimize != .Debug,
        .single_threaded = true,
    });
    module.addOptions("build_options", options);
    const exe = b.addExecutable(.{ .name = "dsh", .root_module = module });
    b.installArtifact(exe);

    // `zig build test`: parser, resolver and Windows command-line tail (src/select.zig), on the host.
    const tests = b.addTest(.{ .root_module = b.createModule(.{
        .root_source_file = b.path("src/select.zig"),
        .target = b.graph.host,
    }) });
    b.step("test", "run the launcher unit tests").dependOn(&b.addRunArtifact(tests).step);
}
