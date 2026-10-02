import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pnpmVersion, sha256, verifyDigest } from "../../scripts/fetch-pnpm.mjs";

test("digest verification rejects corrupted bytes and missing digests", () => {
	const good = new TextEncoder().encode("pnpm");
	verifyDigest(good, `sha256:${sha256(good)}`, "x");
	const bad = new TextEncoder().encode("pnpM");
	expect(() => verifyDigest(bad, `sha256:${sha256(good)}`, "x")).toThrow("sha256 mismatch");
	expect(() => verifyDigest(good, "", "x")).toThrow("no sha256 digest");
});

test("reads upstream packageManager", () => {
	const d = mkdtempSync(join(tmpdir(), "pm-"));
	writeFileSync(join(d, "package.json"), JSON.stringify({ packageManager: "pnpm@11.7.0+sha512.abc" }));
	expect(pnpmVersion(d)).toBe("11.7.0");
	writeFileSync(join(d, "package.json"), JSON.stringify({ packageManager: "yarn@4.0.0" }));
	expect(() => pnpmVersion(d)).toThrow();
});
