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
