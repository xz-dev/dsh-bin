import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archive } from "../../scripts/archive.mjs";
import { extractZip, readZipEntries, writeZip } from "../../runtime/zip.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "dsh-zip-"));

function tree(root: string) {
	mkdirSync(join(root, "bundles/V1/bin"), { recursive: true });
	writeFileSync(join(root, "dsh"), "launcher");
	chmodSync(join(root, "dsh"), 0o700);
	writeFileSync(join(root, "bundles/V1/bin/pnpm"), "#!/bin/sh\n");
	chmodSync(join(root, "bundles/V1/bin/pnpm"), 0o755);
	writeFileSync(join(root, "bundles/V1/bundle.json"), JSON.stringify({ a: "x".repeat(4000) }));
	chmodSync(join(root, "bundles/V1/bundle.json"), 0o600);
	writeFileSync(join(root, "bundles/V1/.usage.lock"), "");
}

/** Rewrite the (same-length) name of the single-file archive's entry in both headers. */
function patchName(zip: string, from: string, to: string) {
	const buf = readFileSync(zip);
	expect(to.length).toBe(from.length);
	let at = 0;
	for (;;) {
		at = buf.indexOf(from, at);
		if (at < 0) break;
		buf.write(to, at);
	}
	writeFileSync(zip, buf);
}

function setUnixMode(zip: string, mode: number) {
	const buf = readFileSync(zip);
	const cd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
	buf.writeUInt32LE((mode << 16) >>> 0, cd + 38);
	writeFileSync(zip, buf);
}

describe("deterministic archive (6.2)", () => {
	test("two runs over the same tree are byte-identical, even after mtime/mode noise", async () => {
		const root = tmp();
		tree(root);
		const a = join(tmp(), "a.zip");
		archive(root, a);
		await Bun.sleep(1100);
		writeFileSync(join(root, "dsh"), "launcher"); // new mtime
		chmodSync(join(root, "bundles/V1/bundle.json"), 0o640); // different non-exec mode
		const b = join(tmp(), "b.zip");
		archive(root, b);
		expect(Bun.hash(readFileSync(a))).toBe(Bun.hash(readFileSync(b)));
	});

	test("round-trip restores contents with normalized modes", () => {
		const root = tmp();
		tree(root);
		const zip = join(tmp(), "t.zip");
		archive(root, zip);
		const out = join(tmp(), "x");
		extractZip(zip, out);
		expect(readFileSync(join(out, "bundles/V1/bundle.json"), "utf8")).toBe(readFileSync(join(root, "bundles/V1/bundle.json"), "utf8"));
		// Windows has no POSIX mode bits; the archives for POSIX targets are built on POSIX runners.
		if (process.platform !== "win32") {
			expect(statSync(join(out, "dsh")).mode & 0o777).toBe(0o755);
			expect(statSync(join(out, "bundles/V1/bin/pnpm")).mode & 0o777).toBe(0o755);
			expect(statSync(join(out, "bundles/V1/bundle.json")).mode & 0o777).toBe(0o644);
		}
		expect(existsSync(join(out, "bundles/V1/.usage.lock"))).toBe(true);
	});

	test("unzip(1) agrees with the reader", () => {
		const root = tmp();
		tree(root);
		const zip = join(tmp(), "t.zip");
		archive(root, zip);
		if (!Bun.which("unzip")) return;
		const r = Bun.spawnSync(["unzip", "-t", zip]);
		expect(r.exitCode).toBe(0);
	});
});

describe("validating reader (7.5 unsafe entries)", () => {
	const one = (name: string) => {
		const zip = join(tmp(), "e.zip");
		writeZip(zip, [{ name, data: Buffer.from("evil"), mode: 0o644 }]);
		return zip;
	};

	test("`../` entry is rejected before anything is written", () => {
		const zip = one("aa/evil");
		patchName(zip, "aa/evil", "../evil");
		const dest = join(tmp(), "stage");
		expect(() => extractZip(zip, dest)).toThrow("'..' segment");
		expect(existsSync(dest)).toBe(false);
		expect(existsSync(join(dest, "..", "evil"))).toBe(false);
	});

	test("absolute entry is rejected", () => {
		const zip = one("xetc/evil");
		patchName(zip, "xetc/evil", "/etc/evil");
		expect(() => readZipEntries(readFileSync(zip))).toThrow("absolute path");
	});

	test("symlink entry is rejected", () => {
		const zip = one("link");
		setUnixMode(zip, 0o120777);
		expect(() => readZipEntries(readFileSync(zip))).toThrow("symlink");
	});

	test("case-folded duplicate is rejected", () => {
		const zip = join(tmp(), "d.zip");
		writeZip(zip, [
			{ name: "a/File", data: Buffer.from("1"), mode: 0o644 },
			{ name: "a/fILE", data: Buffer.from("2"), mode: 0o644 },
		]);
		expect(() => readZipEntries(readFileSync(zip))).toThrow("duplicate");
	});

	test("corrupted data fails the checksum", () => {
		const zip = join(tmp(), "c.zip");
		writeZip(zip, [{ name: "f", data: Buffer.from("abc"), mode: 0o644 }]);
		const buf = readFileSync(zip);
		buf[31] ^= 0xff; // first data byte after the 30-byte header and 1-byte name
		writeFileSync(zip, buf);
		const dest = join(tmp(), "stage");
		expect(() => extractZip(zip, dest)).toThrow("checksum");
		expect(readdirSync(dest)).toEqual([]);
	});

	test("the writer refuses unsafe names and symlinks in the tree", () => {
		expect(() => writeZip(join(tmp(), "w.zip"), [{ name: "../x", mode: 0o644 }])).toThrow();
		const root = tmp();
		tree(root);
		if (process.platform === "win32") return; // symlink creation needs privileges on Windows
		Bun.spawnSync(["ln", "-s", "dsh", join(root, "alias")]);
		expect(() => archive(root, join(tmp(), "s.zip"))).toThrow("symlink");
	});
});
