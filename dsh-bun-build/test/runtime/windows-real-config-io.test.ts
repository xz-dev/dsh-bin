import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.env.DSH_WINDOWS_REAL_IO_ROOT;
const enabled = process.platform === "win32" && Boolean(root);
const nativeTest = test.skipIf(!enabled);
const fixture = join(import.meta.dir, "fixtures/windows-private-fixture.ps1");
function acl(action: string, path: string) {
	return execFileSync(join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-File", fixture, action, path], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
}
function privateDirectory(path: string) { if (existsSync(path)) return; privateDirectory(dirname(path)); acl("directory", path); }
function privateFile(path: string, content: string) { privateDirectory(dirname(path)); if (!existsSync(path)) acl("file", path); writeFileSync(path, content); }
const probe = `import z from '@deepseek-ai/schemastery';
import {writeFileAtomic} from '@deepseek-ai/dsh-atomic-write';
export const inject=['settings','credentials','profileContext','appReady','appExit'];
export const Config=z.object({label:z.string().default('default').volatile()});
export function apply(ctx){ctx.appReady.onReady(()=>{void(async()=>{await ctx.root.loader.await();
const mode=ctx.cmdlineArgs.get()[0];const read=async()=>({label:ctx.settings.describe().find(r=>r.ns==='io-probe')?.value.label, credential:await ctx.credentials.resolve('IO_TEST_KEY'), homeFallback:await ctx.credentials.resolve('IO_HOME_ONLY'), home:ctx.profileContext.home,dir:ctx.profileContext.dir,patch:ctx.settings.documentPath});
if(mode==='import'){const end=Date.now()+5000;while((await read()).label!=='C2-imported'){if(Date.now()>end)throw Error('settings import timeout');await new Promise(r=>setTimeout(r,20))}}
const before=await read();
if(mode==='update'||mode==='create'){await ctx.settings.update('io-probe',{label:'C2-updated'});await ctx.credentials.set('IO_TEST_KEY','synthetic-updated')}
if(mode==='watch'){await new Promise(async(resolve,reject)=>{const timer=setTimeout(()=>reject(Error('watch timeout')),5000);ctx.on('credentials/reference-updated',async ref=>{if(ref==='IO_TEST_KEY'&&(await ctx.credentials.resolve(ref))?.value==='synthetic-watched'){clearTimeout(timer);resolve()}});try{await writeFileAtomic(ctx.credentials.spec.filename,'version: 1\\nrefs:\\n  IO_TEST_KEY: synthetic-watched\\n',{mode:384})}catch(e){reject(e)}})}
console.log('IO_REPORT '+JSON.stringify({before,after:await read()}));ctx.appExit(0)})().catch(e=>{console.error(e);ctx.appExit(1)})})}`;

nativeTest("authentic native Windows settings/provider switch/update/import/watch/restart and external ACL refusal", async () => {
	const inputs = JSON.parse(readFileSync(join(root!, "candidate-inputs.json"), "utf8"));
	expect(inputs.expectedCommit).toBe("639ed015397290b3745d163aafe02ffee4aa3f84");
	const expected = {
		"dsh-settings": "9432b872597b7a31473072eb38a55979ab23375c76bd1d86d751388a692a0136",
		"dsh-credentials-local": "1688f17801d5809abace4ef6228b771625a0153c043d7d4dba21b398ec4056eb",
		"dsh-app-boot": "234db45e1b3f8c683b5bc1f551948b2a2ec52a6468c7b6937725a23f1c0e0d96",
		"dsh-config-editor": "373e05c8250d25dda983ccf6e214a55e3792a211d1a7b883affcd66de47b5bf8",
		"dsh-hmr": "75686a16199f90f5b580d96923d3d5c52a513402b399ad723d92506d00ea7676",
		"dsh-atomic-write": "5f07978ef594a2711b2da301d5cb73a835cf1a48c1f8920ab5c6625137e12029",
	};
	for (const [pkg, sha] of Object.entries(expected)) expect(inputs.sources[`node_modules/@deepseek-ai/${pkg}/lib/index.js`]).toBe(sha);
	expect(inputs.pnpm.version).toBe("11.7.0"); expect(inputs.pnpm.asset).toBe(`pnpm-win32-${process.arch}.zip`); expect(inputs.pnpm.sha256).toMatch(/^[0-9a-f]{64}$/);
	const home = join(root!, "service-home"), plugins = join(root!, "snapshots/0.2.0-rc.2@1"), pd = join(plugins, "profiles/io"), pkg = join(pd, "node_modules/io-bundle");
	privateFile(join(plugins, ".usage.lock"), "");
	privateFile(join(pd, "package.json"), JSON.stringify({ name: "dsh-profile-io", private: true, dependencies: { "io-bundle": "1.0.0" }, dsh: { profile: { bundles: ["io-bundle"] } } }));
	privateFile(join(pd, "pnpm-workspace.yaml"), "packages:\n  - .\nnodeLinker: hoisted\n");
	privateFile(join(pkg, "package.json"), JSON.stringify({ name: "io-bundle", version: "1.0.0", type: "module", main: "index.js", dsh: { bundle: { patch: "cordis.patch.yml" } } }));
	privateFile(join(pkg, "index.js"), probe);
	privateFile(join(pkg, "cordis.patch.yml"), "- insert:\n    - id: config-editor\n      name: '@deepseek-ai/dsh-config-editor'\n    - id: settings\n      name: '@deepseek-ai/dsh-settings'\n    - id: credentials-local\n      name: '@deepseek-ai/dsh-credentials-local'\n    - id: io-probe\n      name: io-bundle\n");
	const patch = label => `- id: io-probe\n  config:\n    label: ${label}\n`, creds = value => `version: 1\nrefs:\n  IO_TEST_KEY: ${value}\n`;
	privateFile(join(home, ".credentials.yaml"), creds("synthetic-shared-never-use")); privateFile(join(home, ".env"), "IO_HOME_ONLY=synthetic-home-only\n"); privateFile(join(home, "settings.yaml"), "io-probe:\n  label: shared-must-not-import\n");
	const configs = [1, 2, 3].map(n => join(root!, `config-snapshots/0.2.0-rc.2@${n}`));
	for (const [i, dir] of configs.entries()) { privateFile(join(dir, ".usage.lock"), ""); if (i < 2) { privateFile(join(dir, "profiles/io/cordis.patch.yml"), patch(`C${i + 1}`)); privateFile(join(dir, ".credentials.yaml"), creds(`synthetic-C${i + 1}`)); } }
	const preserved = [join(configs[0], ".credentials.yaml"), join(configs[0], "profiles/io/cordis.patch.yml"), join(home, ".env"), join(home, ".credentials.yaml"), join(home, "settings.yaml")].map(p => [p, readFileSync(p)]);
	const executable = join(root!, "bundles/0.2.0-rc.2/dsh-native.exe"); let number = 0;
	async function run(n: number, mode = "read", failure = false) {
		const launch = { protocol: 2, runtime: "0.2.0-rc.2", dataRoot: root, home, snapshot: { id: "0.2.0-rc.2@1", dir: plugins }, configSnapshot: { id: `0.2.0-rc.2@${n}`, dir: configs[n - 1] }, addons: {}, cache: join(root!, "cache"), tmp: join(root!, "tmp"), manager: "native-fixture" };
		const child = Bun.spawn([executable, "--profile", "io", mode], { cwd: home, env: { ...process.env, DSH_MANAGER_LAUNCH: JSON.stringify(launch), DSH_HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000 });
		const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		writeFileSync(join(root!, `service-${++number}-C${n}-${mode}.stdout`), stdout); writeFileSync(join(root!, `service-${number}-C${n}-${mode}.stderr`), stderr);
		if (failure) { expect(code).not.toBe(0); expect(stdout).not.toContain("IO_REPORT"); expect(stderr).toContain("DSH_CONFIG_BOUNDARY"); expect(stderr).not.toContain("synthetic-shared-never-use"); return; }
		expect(code, stderr).toBe(0); const report = stdout.split("\n").find(l => l.startsWith("IO_REPORT ")); expect(report, stdout + stderr).toBeTruthy(); return JSON.parse(report!.slice(10));
	}
	const first = await run(1); expect(first.before.label).toBe("C1"); expect(first.before.credential.value).toBe("synthetic-C1"); expect(first.before.homeFallback).toBeUndefined();
	const second = await run(2, "update"); expect(second.after.label).toBe("C2-updated"); expect(second.after.credential.value).toBe("synthetic-updated");
	expect((await run(1)).after).toEqual(first.after); // fresh process restart retains independently selected C1
	const imported = "io-probe:\n  label: C2-imported\n"; privateFile(join(configs[1], "settings.yaml"), imported);
	expect((await run(2, "import")).after.label).toBe("C2-imported"); expect(readFileSync(join(configs[1], "settings.yaml.imported"), "utf8")).toBe(imported);
	expect((await run(2, "watch")).after.credential.value).toBe("synthetic-watched");
	const created = await run(3, "create"); expect(created.after.credential.value).toBe("synthetic-updated");
	for (const p of [join(configs[2], ".credentials.yaml"), join(configs[2], "profiles/io"), join(configs[2], "profiles/io/cordis.patch.yml")]) {
		const actual = JSON.parse(acl("inspect", p)); expect(actual.owner).toBe(actual.user); expect(actual.rules.length).toBeGreaterThan(0); for (const rule of actual.rules) expect(rule.sid).toBe(actual.user);
	}
	privateFile(join(configs[1], "profiles/io/cordis.patch.yml"), `- id: credentials-local\n  config: ${JSON.stringify({ path: join(home, ".credentials.yaml") })}\n- id: io-probe\n  config:\n    label: boundary-negative\n`); await run(2, "read", true);
	privateFile(join(configs[1], "profiles/io/cordis.patch.yml"), patch("C2")); acl("everyone", join(configs[1], ".credentials.yaml")); await run(2, "read", true);
	for (const [p, bytes] of preserved) expect(readFileSync(p).equals(bytes)).toBe(true);
	expect(first.before.home).toBe(home); expect(first.before.dir).toBe(pd); expect(first.before.patch).toBe(join(configs[0], "profiles/io/cordis.patch.yml"));
	console.log(`NATIVE_REAL_SERVICE_EXECUTABLE_SHA256 ${createHash("sha256").update(readFileSync(executable)).digest("hex")}`);
}, 180_000);
