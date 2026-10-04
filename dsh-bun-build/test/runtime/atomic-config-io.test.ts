import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CONFIG_SITES, transformApp } from "../../scripts/transform-app.mjs";

const APP = process.env.DSH_BIN_REAL_IO_APP;
const atomicRel = "node_modules/@deepseek-ai/dsh-atomic-write/lib/index.js";
// Real authenticated rc.2 input mandatory when this dedicated gate runs, never generated from site table.
function transformed() {
	expect(APP, "set DSH_BIN_REAL_IO_APP to authenticated untransformed rc.2 input").toBeTruthy();
	const root = mkdtempSync(join(tmpdir(), "atomic-seams-")), app = join(root, "app");
	expect(createHash("sha256").update(readFileSync(join(APP!, atomicRel))).digest("hex")).toBe("5f07978ef594a2711b2da301d5cb73a835cf1a48c1f8920ab5c6625137e12029");
	cpSync(APP!, app, { recursive: true }); transformApp(app);
	return { root, app, atomic: join(app, atomicRel) };
}
function probe(atomic: string, config: string, control: string, body: string) {
	const helper = resolve(import.meta.dir, "../../runtime/compat/config-paths.ts");
	const source = `import {createConfigPaths} from ${JSON.stringify(helper)};
import {writeFileSync,readFileSync,chmodSync,existsSync} from 'node:fs';
const paths=createConfigPaths(undefined,${JSON.stringify(config)});
const ordinary={code:'ENOENT'};
const guarded={...paths, checkCreation(p){writeFileSync(${JSON.stringify(join(control, "creation"))},p); return paths.checkCreation(p)},
checkAuxiliary(p){writeFileSync(${JSON.stringify(join(control, "auxiliary"))},p); return paths.checkAuxiliary(p)}};
Bun.plugin({name:'atomic-test',setup(b){b.module('dsh-bin:config-paths',()=>({exports:{paths:guarded},loader:'object'}));}});
const {withFileLock,writeFileAtomic}=await import(${JSON.stringify(atomic)});
${body}`;
	return Bun.spawnSync([process.execPath, "-e", source], { env: process.env, timeout: 20_000 });
}
function privateFile(path: string, content: string) { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, content, { mode: 0o600 }); }

test("real rc.2 helper invokes wx/rename guards, preserves non-C and standalone semantics", () => {
	const { root, atomic } = transformed(), config = join(root, "C"), control = join(root, "control");
	mkdirSync(config, { mode: 0o700 }); mkdirSync(control);
	const filename = join(config, "accounts/work.yaml"), outside = join(root, "sessions/state.json");
	const result = probe(atomic, config, control, `await withFileLock(${JSON.stringify(filename)}, async()=>{await writeFileAtomic(${JSON.stringify(filename)}, 'synthetic-new', {mode:384});});
await writeFileAtomic(${JSON.stringify(outside)}, 'session-non-C', {mode:420});
console.log('DONE');`);
	expect(result.exitCode, result.stderr.toString()).toBe(0);
	expect(readFileSync(filename, "utf8")).toBe("synthetic-new"); expect(existsSync(filename + ".lock")).toBe(false);
	expect(readFileSync(outside, "utf8")).toBe("session-non-C");
	// Ordinary lock/retry/recovery behavior outside C is untouched, including private upstream failures.
	const helper = resolve(import.meta.dir, "../../runtime/compat/config-paths.ts");
	const direct = Bun.spawnSync([process.execPath, "-e", `import {createConfigPaths} from ${JSON.stringify(helper)};const p=createConfigPaths();Bun.plugin({name:'standalone-atomic',setup(b){b.module('dsh-bin:config-paths',()=>({exports:{paths:p},loader:'object'}))}});const m=await import(${JSON.stringify(atomic)});await m.writeFileAtomic(${JSON.stringify(join(root, "standalone.yaml"))},'standalone',{mode:420});`], { env: process.env, timeout: 20_000 });
	expect(direct.exitCode, direct.stderr.toString()).toBe(0); expect(readFileSync(join(root, "standalone.yaml"), "utf8")).toBe("standalone");
	expect(existsSync(join(control, "creation"))).toBe(true); expect(existsSync(join(control, "auxiliary"))).toBe(true);
}, 30_000);

test("real rc.2 existing unsafe lock rejected before recovery/read; nested catches cannot swallow boundary", () => {
	const { root, atomic } = transformed(), config = join(root, "C"), control = join(root, "control"); mkdirSync(config, { mode: 0o700 }); mkdirSync(control);
	const filename = join(config, "work.yaml"); privateFile(filename, "original"); privateFile(filename + ".lock", "synthetic-not-a-pid"); chmodSync(filename + ".lock", 0o644);
	const result = probe(atomic, config, control, `try {await withFileLock(${JSON.stringify(filename)},()=>{throw new Error('operation must not start')},{waitMs:50});throw new Error('unsafe accepted')}catch(e){console.log(e.code);if(e.code!=='DSH_CONFIG_BOUNDARY')process.exit(1)}`);
	expect(result.exitCode, result.stderr.toString()).toBe(0); expect(result.stdout.toString()).toContain("DSH_CONFIG_BOUNDARY");
	expect(readFileSync(filename, "utf8")).toBe("original"); expect(readFileSync(filename + ".lock", "utf8")).toBe("synthetic-not-a-pid");
}, 30_000);

test("real rc.2 lock re-read after takeover claim creation reauthenticates changed ACL", () => {
	const { root, atomic } = transformed(), config = join(root, "C"), control = join(root, "control"); mkdirSync(config, { mode: 0o700 }); mkdirSync(control);
	const filename = join(config, "work.yaml"); privateFile(filename, "original"); privateFile(filename + ".lock", "2147483647\n");
	// Replace test callback only: change actual lock mode when production reaches its takeover wx seam.
	// Observe the actual readFile call after argument guards; later removal rejection cannot hide a read.
	let source = readFileSync(atomic, "utf8").replace('lstat, mkdir, readFile, rename, rm, writeFile', 'lstat, mkdir, readFile as originalReadFile, rename, rm, writeFile');
	source += `\nimport {statSync,writeFileSync as markRead} from 'node:fs';
async function readFile(path,...args){if(path===${JSON.stringify(filename + ".lock")}&&(statSync(path).mode&63))markRead(${JSON.stringify(join(control, "unsafe-read"))},'1');return originalReadFile(path,...args)}\n`;
	writeFileSync(atomic, source);
	const result = probe(atomic, config, control, `const original=guarded.checkCreation; guarded.checkCreation=p=>{if(p.includes('.takeover-'))chmodSync(${JSON.stringify(filename + ".lock")},420);return original(p)};
try{await withFileLock(${JSON.stringify(filename)},()=>{throw new Error('must not run')},{waitMs:100});throw new Error('unsafe accepted')}catch(e){console.log(e.code);if(e.code!=='DSH_CONFIG_BOUNDARY')process.exit(1)}`);
	expect(result.exitCode, result.stderr.toString()).toBe(0); expect(result.stdout.toString()).toContain("DSH_CONFIG_BOUNDARY");
	expect(existsSync(join(control, "unsafe-read")), "unsafe post-claim lock read must never execute, even if later removal rejects").toBe(false);
	expect(readFileSync(filename, "utf8")).toBe("original"); expect(existsSync(filename + ".lock")).toBe(true);
}, 30_000);

test("real profile helpers recheck cached paths at read and sanitize rename, before touching unsafe config", () => {
	const bootRel = "node_modules/@deepseek-ai/dsh-app-boot/lib/index.js";
	const pluginRel = "node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js";
	const typesRel = "node_modules/@deepseek-ai/dsh-plugin-manager/lib/types/patch.js";
	for (const [file, hash] of [[bootRel, "234db45e1b3f8c683b5bc1f551948b2a2ec52a6468c7b6937725a23f1c0e0d96"], [pluginRel, "f46a48b3422927eea5605a70b78502e06ef9ceaa29d7a73f4a7f742361ff51c8"], [typesRel, "cc014a3a09880220026a22792d49628e484edfe99ba4e03658b64891816adfb5"]]) {
		expect(createHash("sha256").update(readFileSync(join(APP!, file!))).digest("hex")).toBe(hash!);
	}
	const { root, app } = transformed(), marker = join(root, "unsafe-read");
	// Test-only observation at the actual read call, after its argument guards. A later
	// atomic-write rejection must not conceal an earlier secret read. No global fs patching.
	for (const [file, from, to] of [
		[bootRel, "mkdirSync, readFileSync, readdirSync", "mkdirSync, readFileSync as observedReadFileSync, readdirSync"],
		[pluginRel, "open, readFile, rm", "open, readFile as observedReadFile, rm"],
		[typesRel, "import { readFile }", "import { readFile as observedReadFile }"],
	]) {
		const filename = join(app, file!), original = readFileSync(filename, "utf8");
		expect(original.split(from!).length).toBe(2);
		const sync = file === bootRel, name = sync ? "readFileSync" : "readFile";
		writeFileSync(filename, original.replace(from!, to!) + `
import {statSync as observedStat,writeFileSync as observedMark} from 'node:fs';
${sync ? "" : "async "}function ${name}(path,...args){
  if(String(path).endsWith('cordis.patch.yml')&&(observedStat(path).mode&63))observedMark(${JSON.stringify(marker)},'unsafe-read');
  return ${sync ? "observedReadFileSync" : "observedReadFile"}(path,...args);
}
${file === pluginRel ? "export {writePluginEnabled};" : ""}
`);
	}
	const helper = resolve(import.meta.dir, "../../runtime/compat/config-paths.ts"), results = [];
	for (const operation of ["plugin", "types", "optional", "overlay", "sanitize"]) {
		const config = join(root, operation, "C"), plugins = join(root, operation, "P"), profile = join(plugins, "profiles/tui"), filename = join(config, "profiles/tui/cordis.patch.yml");
		mkdirSync(config, { recursive: true, mode: 0o700 }); mkdirSync(profile, { recursive: true });
		privateFile(filename, "# retained comment\n[]\n");
		const source = `import {createConfigPaths} from ${JSON.stringify(helper)};
import {chmodSync,existsSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
const p=${JSON.stringify(filename)}, profile=${JSON.stringify(profile)}, marker=${JSON.stringify(marker)};
const paths=createConfigPaths(${JSON.stringify(plugins)},${JSON.stringify(config)}); let invalidate=false;
const guarded={...paths,profileFile(...args){const path=paths.profileFile(...args); if(invalidate)chmodSync(path,420); return path}};
Bun.plugin({name:'profile-io-test',setup(b){b.module('dsh-bin:config-paths',()=>({exports:{paths:guarded},loader:'object'}))}});
const boot=await import(${JSON.stringify(join(app, bootRel))});
const plugin=await import(${JSON.stringify(join(app, operation === "types" ? typesRel : pluginRel))});
const action=()=>${operation === "sanitize" ? "boot.sanitizeProfile('dsh',profile,[])" : operation === "optional" ? "boot.loadOptionalPatches('dsh',p)" : operation === "overlay" ? "boot.loadOverlayPatches('dsh',p)" : "plugin.writePluginEnabled(p,'probe','probe',false)"};
await action(); // Real legal operation first, not only a refusal probe.
writeFileSync(p,'# retained comment\\n[]\\n',{mode:384}); chmodSync(p,384);
if(existsSync(marker))rmSync(marker);
${operation === "sanitize" ? "invalidate=true;" : "paths.check(p); chmodSync(p,420);"}
let code; try{await action()}catch(e){code=e.code}
console.log(JSON.stringify({code:code??null,unsafeRead:existsSync(marker),exists:existsSync(p),unchanged:existsSync(p)&&readFileSync(p,'utf8')==='# retained comment\\n[]\\n'}));`;
		const result = Bun.spawnSync([process.execPath, "-e", source], { env: process.env, timeout: 20_000 });
		expect(result.exitCode, `${operation}: ${result.stderr.toString()}`).toBe(0);
		results.push({ operation, ...JSON.parse(result.stdout.toString().trim()) });
	}
	expect(results).toEqual(["plugin", "types", "optional", "overlay", "sanitize"].map(operation => ({ operation, code: "DSH_CONFIG_BOUNDARY", unsafeRead: false, exists: true, unchanged: true })));
}, 60_000);

test("real rc.2 unknown atomic syscall/alias fails before any transformed file published", () => {
	const { app, atomic } = transformed();
	for (const changed of ['await readFile(other, "utf8");', 'await rm(newPath, { force:true });']) {
		const original = readFileSync(atomic, "utf8"); writeFileSync(atomic, original + "\n" + changed);
		expect(() => transformApp(app)).toThrow(/unknown atomic configuration I\/O site/);
		expect(readFileSync(atomic, "utf8")).toBe(original + "\n" + changed); writeFileSync(atomic, original);
	}
	const original = readFileSync(atomic, "utf8"); writeFileSync(atomic, original.replace('lstat, mkdir, readFile, rename, rm, writeFile', 'lstat, mkdir, readFile as readAlias, rename, rm, writeFile'));
	expect(() => transformApp(app)).toThrow(/configuration path site changed/);
}, 30_000);
