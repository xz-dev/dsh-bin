import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLE_CACHE_DIR, CACHE_VAR, seedTranspilerCache } from "../../runtime/transpiler-cache.ts";

const tmp = mkdtempSync(join(tmpdir(), "dsh-tcache-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function bundle(files: Record<string, string>) {
	const dir = mkdtempSync(join(tmp, "b-"));
	mkdirSync(join(dir, BUNDLE_CACHE_DIR));
	for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, BUNDLE_CACHE_DIR, n), c);
	return dir;
}

test("seeds missing entries once per version and keeps existing ones", () => {
	const b = bundle({ "a.pile": "A", "b.pile": "B" });
	const dest = join(tmp, "cache1");
	mkdirSync(dest);
	writeFileSync(join(dest, "a.pile"), "user");
	expect(seedTranspilerCache(b, "1.0", { [CACHE_VAR]: dest })).toBe("seeded");
	expect(readFileSync(join(dest, "a.pile"), "utf8")).toBe("user");
	expect(readFileSync(join(dest, "b.pile"), "utf8")).toBe("B");
	rmSync(join(dest, "b.pile"));
	expect(seedTranspilerCache(b, "1.0", { [CACHE_VAR]: dest })).toBe("skipped");
	expect(existsSync(join(dest, "b.pile"))).toBe(false);
	expect(seedTranspilerCache(b, "1.1", { [CACHE_VAR]: dest })).toBe("seeded");
	expect(existsSync(join(dest, "b.pile"))).toBe(true);
});

test("creates the cache directory", () => {
	const dest = join(tmp, "deep", "cache");
	expect(seedTranspilerCache(bundle({ "x.pile": "X" }), "1", { [CACHE_VAR]: dest })).toBe("seeded");
	expect(readdirSync(dest).sort()).toEqual([".seeded-1", "x.pile"]);
});

test("disabled, relative or unset cache and bundles without a cache are skipped", () => {
	const b = bundle({ "x.pile": "X" });
	for (const v of [undefined, "", "0", "rel/dir"]) expect(seedTranspilerCache(b, "1", { [CACHE_VAR]: v })).toBe("skipped");
	expect(seedTranspilerCache(mkdtempSync(join(tmp, "nocache-")), "1", { [CACHE_VAR]: join(tmp, "c2") })).toBe("skipped");
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("an unwritable cache only skips", () => {
	const dest = join(tmp, "ro");
	mkdirSync(dest, { mode: 0o555 });
	expect(seedTranspilerCache(bundle({ "x.pile": "X" }), "1", { [CACHE_VAR]: dest })).toBe("skipped");
});
