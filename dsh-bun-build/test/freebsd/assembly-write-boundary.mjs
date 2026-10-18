// Genuine assembly regression. All link/hardlink mutations stay in a new private fixture tree.
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { assembleBundle } from "../../scripts/assemble-bundle.mjs";
import { localBuild } from "../../scripts/local-build.mjs";
import { splitOfficeAddon } from "../../scripts/split-addon.mjs";
import { transformApp, TRANSFORM_WRITE_FILES } from "../../scripts/transform-app.mjs";

const [inputFile, rootArg] = process.argv.slice(2), input = JSON.parse(readFileSync(inputFile, "utf8")), root = resolve(rootArg);
assert(!existsSync(root)); mkdirSync(join(root, "work"), { recursive: true });
const app = join(root, "work/app"), external = join(root, "external"); mkdirSync(external);
cpSync(input.app, app, { recursive: true }); splitOfficeAddon(app, join(root, "office"));
const writes = [...TRANSFORM_WRITE_FILES, "node_modules/@deepseek-ai/node-addon-system/lib/flock.js", "node_modules/@deepseek-ai/node-addon-system/package.json"];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const snapshot = () => Object.fromEntries(writes.map(file => [file, hash(readFileSync(join(app, file)))]));
const raw = snapshot(), results = [];
const native = join(root, "native-fixture"); writeFileSync(native, "fixture, never executes");
let sequence = 0;
const spec = (overrides = {}) => ({ target: "freebsd-x64", out: join(root, `negative-${++sequence}`), app, native, pnpm: input.pnpm, system: input.system, search: input.search, identity: { id: "negative", tag: "negative", channel: "release" }, ...overrides });
function reject(options, label) {
  assert.throws(() => assembleBundle(options), /linked|reserved/, label);
  assert(!existsSync(options.out), `${label}: rejection must precede output creation`);
  assert.deepEqual(snapshot(), raw, `${label}: raw/external write-target bytes changed`);
  results.push(label);
}
// Every declared production transform file, both system files, and all their existing directory ancestors.
const dirs = [...new Set(writes.flatMap(file => {
  const parts = file.split("/"); return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}))];
for (const [kind, paths] of [["file", writes], ["directory", dirs]]) for (const [i, relative] of paths.entries()) {
  const path = join(app, relative), moved = join(external, `${kind}-${i}`); renameSync(path, moved); symlinkSync(moved, path);
  const sentinel = kind === "directory" ? join(moved, ".write-boundary-sentinel") : moved;
  if (kind === "directory") writeFileSync(sentinel, "must remain unchanged");
  const before = readFileSync(sentinel);
  reject(spec(), `${kind}: ${relative}`);
  assert.deepEqual(readFileSync(sentinel), before);
  if (kind === "directory") unlinkSync(sentinel);
  unlinkSync(path); renameSync(moved, path);
}
// A reserved installer destination must not hide a directory or dangling link.
const reserved = join(app, "node_modules/@deepseek-ai/node-addon-system-freebsd-x64");
for (const dangling of [false, true]) {
  const target = join(external, dangling ? "absent-system" : "existing-system");
  if (!dangling) mkdirSync(target);
  symlinkSync(target, reserved); reject(spec(), `reserved system ${dangling ? "dangling" : "directory"} link`); unlinkSync(reserved);
}
mkdirSync(reserved); reject(spec(), "reserved regular system directory");
// Remove only our empty fixture directory, never an input/component directory.
execFileSync("/bin/rmdir", [reserved]);
// Installer writes loader-provenance after copying its component: protect component-root and final-file aliases too.
const component = join(root, "system-component"); cpSync(input.system.directory, component, { recursive: true });
const componentLink = join(root, "system-component-link"); symlinkSync(component, componentLink);
for (const directory of [componentLink, `${componentLink}/`, `${componentLink}/.`]) reject(spec({ system: { ...input.system, directory } }), `linked component directory: ${directory}`);
assert(!existsSync(join(component, "loader-provenance.json")));
const provenance = join(component, "loader-provenance.json");
for (const kind of ["file", "directory", "dangling"]) {
  const target = join(external, `provenance-${kind}`);
  if (kind === "file") writeFileSync(target, "component source must remain unchanged");
  if (kind === "directory") mkdirSync(target);
  symlinkSync(target, provenance);
  reject(spec({ system: { ...input.system, directory: component } }), `linked component provenance ${kind}`);
  if (kind === "file") assert.equal(readFileSync(target, "utf8"), "component source must remain unchanged");
  unlinkSync(provenance);
}
assert.deepEqual(snapshot(), raw);
// Bind the exported production write-set to the actual strict transform, including idempotence.
const transformCopy = join(root, "transform-copy"); cpSync(app, transformCopy, { recursive: true });
assert.deepEqual(transformApp(transformCopy), TRANSFORM_WRITE_FILES);
const transformed = Object.fromEntries(TRANSFORM_WRITE_FILES.map(file => [file, hash(readFileSync(join(transformCopy, file)))]));
transformApp(transformCopy);
for (const [file, sha] of Object.entries(transformed)) assert.equal(hash(readFileSync(join(transformCopy, file))), sha);
// All real write targets are read-only source hardlinks; source permissions/bytes must remain intact.
for (const [i, file] of writes.entries()) {
  const source = join(app, file), target = join(external, `hardlink-${i}`);
  cpSync(source, target); unlinkSync(source); linkSync(target, source); chmodSync(source, 0o444);
}
const nativeSource = join(root, "native-readonly"), nativeLink = join(root, "native-link");
cpSync(input.native, nativeSource); chmodSync(nativeSource, 0o444); symlinkSync(nativeSource, nativeLink);
const pruneSource = join(app, "node_modules/@vscode/ripgrep-linux-x64"), pruneSentinel = join(external, "prune-sentinel.txt");
writeFileSync(pruneSentinel, "pruning must not follow copied links");
symlinkSync(pruneSentinel, join(pruneSource, "prune-link.txt"));
const pnpm = join(root, "work/pnpm-freebsd-x64"); cpSync(input.pnpm, pnpm, { recursive: true });
const repo = resolve(import.meta.dir, "../../.."), builderCommit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert(!process.env.DSH_BUILDER_COMMIT, "do not override real builder identity");
const result = localBuild({ out: join(root, "out"), work: join(root, "work"), targetId: "freebsd-x64", channel: "release", run: 9024, attempt: 1, upstreamCommit: input.upstreamCommit, upstreamCommitTime: input.upstreamCommitTime, upstreamVersion: "0.2.0-rc.2", native: nativeLink, system: input.system, search: input.search, slot: null });
assert.equal(result.manifest.builderCommit, builderCommit);
assert.deepEqual(snapshot(), raw);
for (const file of writes) {
  assert.equal(lstatSync(join(app, file)).mode & 0o777, 0o444);
  assert.notEqual(lstatSync(join(app, file)).ino, lstatSync(join(result.root, "app", file)).ino);
}
assert.equal(lstatSync(nativeSource).mode & 0o777, 0o444);
assert.equal(readFileSync(pruneSentinel, "utf8"), "pruning must not follow copied links");
assert(lstatSync(join(pruneSource, "prune-link.txt")).isSymbolicLink());
assert(!existsSync(join(result.root, "app/node_modules/@vscode/ripgrep-linux-x64")));
assert.equal(hash(readFileSync(nativeSource)), hash(readFileSync(join(result.root, "dsh-native"))));
for (const [file, sha] of Object.entries(transformed)) assert.equal(hash(readFileSync(join(result.root, "app", file))), sha);
writeFileSync(join(root, "result.json"), JSON.stringify({ results, writes, rawSourceHashes: raw, builderCommit, result, nativeSourceUnchanged: true, readOnlyHardlinksUnchanged: true }, null, 2) + "\n");
console.log(JSON.stringify({ negativeCases: results.length, writeFiles: writes.length, builderCommit, zip: result.zip, root: result.root, sha256: result.asset.sha256, size: result.asset.size }));
