// Genuine-component regression. All mutations stay in a NEW caller-owned scratch root.
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stageFreebsdSearch, verifyFreebsdSearchPackage } from "../../scripts/freebsd-search.mjs";

const [component, authority, certifiedApp, scratchArg] = process.argv.slice(2);
const scratch = resolve(scratchArg), expected = JSON.parse(readFileSync(authority, "utf8"));
assert.equal(existsSync(scratch), false);
mkdirSync(scratch);
verifyFreebsdSearchPackage(component, "x64", expected);
const altered = join(scratch, "altered-license");
cpSync(component, altered, { recursive: true });
writeFileSync(join(altered, "LICENSE"), "license deleted");
assert.throws(() => verifyFreebsdSearchPackage(altered, "x64", expected), /license|notice/);
console.log("PASS altered required LICENSE rejected against independent authority");
for (const name of ["THIRD_PARTY_NOTICES", "LICENSE"]) {
  const removed = join(scratch, `removed-${name}`), changed = join(scratch, `changed-${name}`);
  cpSync(component, removed, { recursive: true }); unlinkSync(join(removed, name));
  cpSync(component, changed, { recursive: true }); writeFileSync(join(changed, name), "altered");
  for (const dir of [removed, changed]) {
    const output = `${dir}-output`;
    assert.throws(() => stageFreebsdSearch(certifiedApp, output, "x64", dir, expected));
    assert.equal(existsSync(output), false);
  }
}
const forged = join(scratch, "self-rehashed"); cpSync(component, forged, { recursive: true });
const receipt = JSON.parse(readFileSync(join(forged, "build-receipt.json"), "utf8"));
receipt.notices.inventory = []; writeFileSync(join(forged, "build-receipt.json"), JSON.stringify(receipt));
assert.throws(() => verifyFreebsdSearchPackage(forged, "x64", expected), /trusted artifact identity/);
console.log("PASS removed/changed notices and altered inventory refused before staging");

function app(name) {
  const source = join(scratch, name), wrapper = join(source, "node_modules/@vscode/ripgrep");
  mkdirSync(join(source, "node_modules/@vscode"), { recursive: true });
  cpSync(join(certifiedApp, "node_modules/@vscode/ripgrep"), wrapper, { recursive: true });
  writeFileSync(join(source, "foreign-prebuild"), "other OS bytes unchanged");
  return { source, wrapper };
}
for (const name of ["node_modules", "node_modules/@vscode", "node_modules/@vscode/ripgrep", "node_modules/@vscode/ripgrep/package.json", "node_modules/@vscode/ripgrep-freebsd-x64"]) {
  const { source } = app(`linked-${name.replaceAll("/", "_")}`), target = join(source, name), external = `${source}-external`;
  if (existsSync(target)) { cpSync(target, external, { recursive: true }); rmSync(target, { recursive: true }); }
  else mkdirSync(external);
  const metadata = name.endsWith("package.json") ? external : join(external, "sentinel");
  if (!name.endsWith("package.json")) writeFileSync(metadata, "external unchanged");
  const before = readFileSync(metadata);
  symlinkSync(external, target);
  const sourceMetadata = join(source, "node_modules/@vscode/ripgrep/package.json"), sourceBefore = readFileSync(sourceMetadata);
  const output = `${source}-output`;
  assert.throws(() => stageFreebsdSearch(source, output, "x64", component, expected), /linked|reserved/);
  assert.deepEqual(readFileSync(metadata), before);
  assert.deepEqual(readFileSync(sourceMetadata), sourceBefore);
  assert.equal(existsSync(output), false);
}
const { source, wrapper } = app("hardlink-source");
const metadata = join(wrapper, "package.json"), external = join(scratch, "hardlink-external.json");
cpSync(metadata, external); unlinkSync(metadata); linkSync(external, metadata); chmodSync(metadata, 0o444);
const before = readFileSync(external), output = join(scratch, "staged-hardlink");
stageFreebsdSearch(source, output, "x64", component, expected);
assert.deepEqual(readFileSync(external), before);
assert.deepEqual(readFileSync(metadata), before);
assert.equal(lstatSync(metadata).mode & 0o777, 0o444);
assert.equal(lstatSync(external).mode & 0o777, 0o444);
assert.notEqual(lstatSync(join(output, "node_modules/@vscode/ripgrep/package.json")).ino, lstatSync(metadata).ino);
assert.deepEqual(readFileSync(join(output, "node_modules/@vscode/ripgrep/lib/index.js")), readFileSync(join(wrapper, "lib/index.js")));
assert.equal(readFileSync(join(output, "foreign-prebuild"), "utf8"), "other OS bytes unchanged");
verifyFreebsdSearchPackage(join(output, "node_modules/@vscode/ripgrep-freebsd-x64"), "x64", expected);
console.log("PASS all linked write-path reds leave sentinels/output untouched; regular/hardlink staging stays independent");
