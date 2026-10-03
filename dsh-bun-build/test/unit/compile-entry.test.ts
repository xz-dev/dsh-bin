import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileArgs, validateFreebsdBun } from "../../scripts/compile-entry.mjs";

test("FBSD-NATIVE compiler embeds matching native Bun with ESM bytecode and sealed config", () => {
	for (const [target, host] of [["bun-freebsd-x64-baseline", "bun-freebsd-x64"], ["bun-freebsd-arm64", "bun-freebsd-arm64"]]) {
		const args = compileArgs(target, "out", host, "/opt/task-build/tools/bun");
		expect(args).toContain("--compile-executable-path=/opt/task-build/tools/bun");
		expect(args).toContain("--bytecode");
		expect(args).toContain("--format=esm");
		expect(args).toContain("--compile-autoload-package-json");
		expect(args).toContain("--no-compile-autoload-dotenv");
		expect(args).toContain("--no-compile-autoload-bunfig");
	}
	expect(() => compileArgs("bun-freebsd-arm64", "out", "bun-linux-arm64")).toThrow("native FreeBSD");
	expect(() => compileArgs("bun-freebsd-x64-modern", "out", "bun-freebsd-x64")).toThrow("unsupported FreeBSD");
});

test("other targets keep native bytecode and cross-build behavior", () => {
	const native = compileArgs("bun-linux-x64-musl-modern", "out", "bun-linux-x64");
	expect(native).toContain("--bytecode");
	expect(native.some((a) => a.startsWith("--compile-executable-path"))).toBe(false);
	const cross = compileArgs("bun-windows-arm64", "out", "bun-linux-x64");
	expect(cross).not.toContain("--bytecode");
	expect(cross).toContain("--no-compile-autoload-dotenv");
});

test("FBSD-NATIVE compiler rejects foreign host and unverified executable before embedding", () => {
	const target = process.arch === "x64" ? "bun-freebsd-x64-baseline" : "bun-freebsd-arm64";
	if (process.platform !== "freebsd") {
		expect(() => validateFreebsdBun(target, process.execPath)).toThrow("native FreeBSD");
		return;
	}
	validateFreebsdBun(target, process.execPath);
	const dir = mkdtempSync(join(tmpdir(), "freebsd-compiler-"));
	try {
		const untrusted = join(dir, "bun");
		writeFileSync(untrusted, "untrusted executable must not be launched");
		expect(() => validateFreebsdBun(target, untrusted)).toThrow("SHA-256 mismatch");
		const foreign = process.arch === "x64" ? "bun-freebsd-arm64" : "bun-freebsd-x64-baseline";
		expect(() => validateFreebsdBun(foreign, process.execPath)).toThrow("native FreeBSD");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
