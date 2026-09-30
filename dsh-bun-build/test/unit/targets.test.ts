import { expect, test } from "bun:test";
import { TARGETS, target } from "../../scripts/targets.mjs";

test("exactly the 12 spec targets, no duplicates", () => {
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
	]);
	expect(new Set(ids).size).toBe(12);
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
