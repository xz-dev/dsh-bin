import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEARCH_SOURCE, SEARCH_BUILD_INPUTS, buildFreebsdSearch, stageFreebsdSearch, verifyFreebsdSearchPackage } from "../../scripts/freebsd-search.mjs";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
function fixture(directory: string, bytes: Buffer) {
  mkdirSync(join(directory, "bin"));
  writeFileSync(join(directory, "bin/rg"), bytes);
  writeFileSync(join(directory, "LICENSE"), "test fixture\n");
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "@vscode/ripgrep-freebsd-x64", version: "1.18.0", os: ["freebsd"], cpu: ["x64"], license: "MIT", files: ["bin/", "build-receipt.json", "LICENSE"] }));
  const receipt = JSON.stringify({ source: SEARCH_SOURCE, inputs: SEARCH_BUILD_INPUTS, platform: "freebsd-x64", sha256: hash(bytes), compiler: "/usr/bin/cc", freebsdVersion: "15.1-RELEASE", dependencies: ["libc.so.7", "libgcc_s.so.1", "libthr.so.3"] });
  writeFileSync(join(directory, "build-receipt.json"), receipt);
  return { platform: "freebsd-x64", sha256: hash(bytes), receiptSha256: hash(receipt) };
}

for (const [name, osabi, machine] of [["fake FreeBSD ELF", 9, 62], ["same-CPU Linux ELF", 3, 62], ["wrong architecture", 9, 183]] as const) {
  test(`search rejects ${name} despite caller-pinned hashes and metadata`, () => {
    const directory = mkdtempSync(join(tmpdir(), "search-negative-"));
    try {
      const bytes = Buffer.alloc(256);
      bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, osabi]);
      bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(machine, 18);
      const expected = fixture(directory, bytes);
      expect(() => verifyFreebsdSearchPackage(directory, "x64", expected)).toThrow(/ELF|structure/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

test("search requires external identity and refuses changed bytes before staging", () => {
  const directory = mkdtempSync(join(tmpdir(), "search-trust-"));
  try {
    const expected = fixture(directory, Buffer.alloc(256));
    expect(() => verifyFreebsdSearchPackage(directory, "x64")).toThrow(/trusted search build receipt/);
    expect(() => verifyFreebsdSearchPackage(directory, "arm64", expected)).toThrow(/trusted search build receipt/);
    writeFileSync(join(directory, "bin/rg"), "changed payload");
    expect(() => verifyFreebsdSearchPackage(directory, "x64", expected)).toThrow(/trusted artifact identity mismatch/);
    const before = readFileSync(join(directory, "package.json"));
    expect(() => stageFreebsdSearch(directory, directory, "x64", directory, expected)).toThrow(/trusted artifact identity mismatch/);
    expect(readFileSync(join(directory, "package.json"))).toEqual(before);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("search refuses resolver redirects and symlinked payloads before ELF consumption", () => {
  const directory = mkdtempSync(join(tmpdir(), "search-resolver-"));
  try {
    const expected = fixture(directory, Buffer.alloc(256));
    const file = join(directory, "package.json"), original = readFileSync(file, "utf8");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(original), exports: { "./bin/rg": "./unverified" } }));
    expect(() => verifyFreebsdSearchPackage(directory, "x64", expected)).toThrow(/resolver metadata/);
    writeFileSync(file, original);
    unlinkSync(join(directory, "bin/rg"));
    symlinkSync("../LICENSE", join(directory, "bin/rg"));
    expect(() => verifyFreebsdSearchPackage(directory, "x64", expected)).toThrow(/regular files/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("search freezes real upstream version and rejects unsupported native build hosts", () => {
  expect(SEARCH_SOURCE.version).toBe("15.0.0");
  expect(SEARCH_SOURCE.prebuiltTag).toBe("v15.0.1");
  expect(SEARCH_SOURCE.packageVersion).toBe("1.18.0");
  expect(Object.keys(SEARCH_BUILD_INPUTS)).toHaveLength(4);
  if (process.platform !== "freebsd" || process.arch !== "x64") expect(() => buildFreebsdSearch("/missing", "/missing")).toThrow(/ARM64 toolchain is blocked/);
});
