const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.option(std.builtin.OptimizeMode, "optimize", "optimization mode") orelse .ReleaseSmall;
    const version = b.option([]const u8, "version", "manager version") orelse "0.0.0-dev";

    const options = b.addOptions();
    options.addOption([]const u8, "version", version);

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

    // `zig build test`: the pure modules, on the host.
    const test_module = b.createModule(.{ .root_source_file = b.path("src/main.zig"), .target = b.graph.host });
    test_module.addOptions("build_options", options);
    const tests = b.addTest(.{ .root_module = test_module });
    b.step("test", "run the manager unit tests").dependOn(&b.addRunArtifact(tests).step);
}
