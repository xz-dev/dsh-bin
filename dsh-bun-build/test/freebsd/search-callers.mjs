// Real component authorities; caller guards only, never substitute for installed-product acceptance.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const [scriptsArg, rootArg, systemDir, systemReceipt, searchDir, searchReceipt] = process.argv.slice(2);
const scripts = resolve(scriptsArg), root = resolve(rootArg);
assert(!existsSync(root)); mkdirSync(root, { recursive: true });
const system = { directory: systemDir, expected: JSON.parse(readFileSync(systemReceipt, "utf8")) };
const search = { directory: searchDir, expected: JSON.parse(readFileSync(searchReceipt, "utf8")) };
const { localBuild } = await import(pathToFileURL(join(scripts, "local-build.mjs")));
const { assembleBundle } = await import(pathToFileURL(join(scripts, "assemble-bundle.mjs")));
for (const [i, invalid] of [undefined, { directory: searchDir }, { ...search, expected: { ...search.expected, sha256: "0".repeat(64) } }].entries()) {
  for (const entry of ["local", "assemble", "target"]) {
    const out = join(root, `${entry}-${i}`), work = `${out}-work`;
    const options = { targetId: "freebsd-x64", target: "freebsd-x64", out, work, system, search: invalid, identity: { id: "guard", tag: "guard", channel: "release" } };
    if (entry === "target") {
      const code = `import assert from 'node:assert/strict';import {existsSync} from 'node:fs';Object.defineProperty(process,'platform',{value:'freebsd'});Object.defineProperty(process,'arch',{value:'x64'});const {buildTarget}=await import(${JSON.stringify(join(scripts,"build-target.mjs"))});await assert.rejects(()=>buildTarget(${JSON.stringify(options)}),/search.*(receipt|identity)/);assert(!existsSync(${JSON.stringify(out)}));assert(!existsSync(${JSON.stringify(work)}));`;
      const p = spawnSync(process.execPath, ["-e", code], { encoding: "utf8" });
      assert.equal(p.status, 0, p.stdout + p.stderr);
    } else assert.throws(() => (entry === "local" ? localBuild : assembleBundle)(options), /search.*(receipt|identity)/);
    assert(!existsSync(out)); assert(!existsSync(work));
  }
}
// Authentic receipts must reach the next source gate without creating work or fetching upstream.
const code = `import assert from 'node:assert/strict';Object.defineProperty(process,'platform',{value:'freebsd'});Object.defineProperty(process,'arch',{value:'x64'});const {buildTarget}=await import(${JSON.stringify(join(scripts,"build-target.mjs"))});await assert.rejects(()=>buildTarget(${JSON.stringify({targetId:"freebsd-x64",ref:"1".repeat(40),expectedCommit:"2".repeat(40),system,search,work:join(root,"auth-work")})}),/upstream ref moved/);`;
const p = spawnSync(process.execPath, ["-e", code], { encoding: "utf8" }); assert.equal(p.status, 0, p.stdout + p.stderr);
// These raw links must survive until approved helper rejects them, before any transform/dereference.
for (const kind of ["metadata", "directory"]) {
  const app = join(root, `linked-${kind}`), wrapper = join(app,"node_modules/@vscode/ripgrep"), external = join(root, `external-${kind}`), out = `${app}-out`;
  mkdirSync(join(app,"node_modules/@vscode"), {recursive:true});
  if (kind === "directory") { mkdirSync(external); writeFileSync(join(external,"package.json"), "sentinel"); symlinkSync(external,wrapper); }
  else { mkdirSync(wrapper); writeFileSync(external,"sentinel"); symlinkSync(external,join(wrapper,"package.json")); }
  const marker = kind === "directory" ? join(external,"package.json") : external;
  const native = join(root,"native"); writeFileSync(native,"fixture only; never executes");
  assert.throws(()=>assembleBundle({target:"freebsd-x64",out,app,native,system,search,identity:{id:"guard",tag:"guard",channel:"release"}}),/linked/);
  assert.equal(readFileSync(marker,"utf8"),"sentinel"); assert(!existsSync(join(out,"bundle.json"))); assert(!existsSync(join(out,"app")));
}
console.log("PASS missing/invalid external search authorities reject at all callers before mutation; authentic authorities pass target source gate; raw links reject before transform");
