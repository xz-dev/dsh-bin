import { expect, test } from "bun:test";
import { TARGETS, githubMatrix, hostTargetId, target } from "../../scripts/targets.mjs";

test("12 existing targets plus two native FreeBSD targets, no duplicates", () => {
	const ids = TARGETS.map((x) => x.id);
	expect(ids).toEqual([
		"linux-x64-baseline",
		"linux-x64-modern",
		"linux-arm64",
		"linux-x64-musl-baseline",
		"linux-x64-musl-modern",
		"linux-arm64-musl",
		"darwin-x64-baseline",
		"darwin-x64-modern",
		"darwin-arm64",
		"windows-x64-baseline",
		"windows-x64-modern",
		"windows-arm64",
		"freebsd-x64",
		"freebsd-arm64",
	]);
	expect(new Set(ids).size).toBe(14);
	// The runtime build compiles no Zig and ships no manager.
	for (const t of TARGETS) expect(Object.keys(t).filter((k) => /zig|launcher|archive/i.test(k))).toEqual([]);
});

test("RL-RUNTIME-BUILD: derived toolchain names; no manager or Zig fields", () => {
	expect(target("linux-x64-musl-baseline")).toMatchObject({
		bunTarget: "bun-linux-x64-musl-baseline",
		pnpmAsset: "pnpm-linux-x64-musl.tar.gz",
	});
	expect(target("windows-arm64")).toMatchObject({
		bunTarget: "bun-windows-arm64",
		pnpmAsset: "pnpm-win32-arm64.zip",
		executable: "dsh-native.exe",
	});
	expect(target("darwin-x64-modern")).toMatchObject({
		pnpmAsset: "pnpm-darwin-arm64.tar.gz",
		reflinkAsset: "reflink.darwin-x64.node",
	});
	expect(() => target("linux-riscv64")).toThrow();
});

test("FBSD-NATIVE native guest targets, not Linux runners or invented pnpm assets", () => {
	for (const arch of ["x64", "arm64"]) {
		const t = target(`freebsd-${arch}`);
		expect(t).toMatchObject({
			os: "freebsd",
			nodePlatform: "freebsd",
			arch,
			bunTarget: arch === "x64" ? "bun-freebsd-x64-baseline" : "bun-freebsd-arm64",
			bunAsset: arch === "x64" ? "bun-freebsd-x64-baseline.zip" : "bun-freebsd-aarch64.zip",
			runnerKind: "freebsd-vm",
			minVersion: "15.0",
			pnpmStrategy: "universal-js",
		});
		expect(t.pnpmAsset).toBeUndefined();
		expect(hostTargetId("freebsd", arch)).toBe(t.id);
	}
	expect(() => hostTargetId("freebsd", "riscv64")).toThrow("unsupported host");
	expect(hostTargetId("linux", "arm64")).not.toStartWith("freebsd-");
	// No CI support claim until dedicated VM execution and whole-product gates exist.
	expect(githubMatrix().include).toHaveLength(12);
	expect(githubMatrix().include.some((t) => t.id.startsWith("freebsd-"))).toBe(false);
});
