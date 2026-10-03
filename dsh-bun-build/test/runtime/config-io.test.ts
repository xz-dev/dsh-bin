import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assembleBundle } from "../../scripts/assemble-bundle.mjs";
import { transformApp } from "../../scripts/transform-app.mjs";
import { splitOfficeAddon, KIT } from "../../scripts/split-addon.mjs";

// Authentic compiled input only. Missing inputs FAIL; this suite never silently skips real-service proof.
const APP = process.env.DSH_BIN_REAL_IO_APP;
const PNPM = process.env.DSH_BIN_TEST_PNPM;
const ROOT = resolve(import.meta.dir, "../..");
const RUNTIME = "0.2.0-rc.2";
const PROBE = `import z from '@deepseek-ai/schemastery';
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { readProfilePatches, reconcileProfilePatches } from '@deepseek-ai/dsh-app-boot';
import { dshCachePath } from '@deepseek-ai/dsh-home-paths';
import { watchConfig } from './watch-config.js';
export const inject = ['settings', 'credentials', 'profileContext', 'appReady', 'appExit'];
export const Config = z.object({ label: z.string().default('bundle-default').volatile() });
export function apply(ctx, config) {
  ctx.appReady.onReady(() => { void (async () => {
    // Loader settled, including settings' automatic legacy import.
    await ctx.root.loader.await();
    const read = async () => ({ label: ctx.settings.describe().find(r => r.ns === 'io-probe')?.value.label,
      credential: await ctx.credentials.resolve('IO_TEST_KEY'),
      homeFallback: await ctx.credentials.resolve('IO_HOME_ONLY'),
      processOnly: await ctx.credentials.resolve('IO_PROCESS_ONLY'),
      cache: dshCachePath(),
      home: ctx.profileContext.home, dir: ctx.profileContext.dir, patch: ctx.settings.documentPath,
      plugin: import.meta.url });
    const mode = ctx.cmdlineArgs.get()[0];
    if (mode === 'import' && ctx.settings.describe().find(r => r.ns === 'io-probe')?.value.label !== 'C2-imported') {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('settings import timeout')), 5000);
        ctx.on('settings/document-updated', () => {
          if (ctx.settings.describe().find(r => r.ns === 'io-probe')?.value.label === 'C2-imported') { clearTimeout(timer); resolve(); }
        });
      });
    }
    const before = await read();
    if (mode === 'update' || mode === 'private-create') {
      if (mode === 'private-create') process.umask(0);
      await ctx.settings.update('io-probe', { label: 'C2-updated' });
      await ctx.credentials.set('IO_TEST_KEY', 'synthetic-C2-updated');
    }
    if (mode === 'watch') {
      await new Promise(async (resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('credential watcher timeout')), 5000);
        ctx.on('credentials/reference-updated', async ref => {
          if (ref === 'IO_TEST_KEY' && (await ctx.credentials.resolve(ref))?.value === 'synthetic-watched') { clearTimeout(timer); resolve(); }
        });
        try { await writeFileAtomic(ctx.credentials.spec.filename, 'version: 1\\nrefs:\\n  IO_TEST_KEY: synthetic-watched\\n', { mode: 384 }); } catch(e) { reject(e); }
      });
    }
    if (mode === 'profile-watch') {
      let updated;
      const seen = new Promise(resolve => { updated = resolve; });
      const dispose = await watchConfig(ctx, ctx.settings.documentPath, { awaitWriteFinish: { stabilityThreshold: 10, pollInterval: 5 } }, async () => {
        await reconcileProfilePatches(ctx.root, readProfilePatches('dsh', ctx.profileContext), 'dsh');
        if (ctx.settings.describe().find(r => r.ns === 'io-probe')?.value.label === 'C2-profile-watched') updated();
      });
      const timer = setTimeout(() => updated(new Error('profile helper watch timeout')), 5000);
      await writeFileAtomic(ctx.settings.documentPath, '- id: io-probe\\n  config:\\n    label: C2-profile-watched\\n', { mode: 384 });
      const error = await seen; clearTimeout(timer); await dispose(); if (error) throw error;
    }
    console.log('IO_REPORT ' + JSON.stringify({ before, after: await read() }));
    ctx.appExit(0);
  })().catch(e => { console.error(e); ctx.appExit(1); }); });
}
`;
function privateFile(path: string, text: string) {
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode: 0o600 });
}

test("CS-SWITCH: authentic settings/provider C1 → C2 update → C1, plugin base and HOME unchanged", async () => {
  expect(APP, "set DSH_BIN_REAL_IO_APP to authentic pre-transform built app").toBeTruthy();
  expect(PNPM, "set DSH_BIN_TEST_PNPM to authenticated pnpm closure").toBeTruthy();
  expect(Bun.version).toBe("1.4.2");
  expect(createHash("sha256").update(readFileSync(join(PNPM!, "dist/pnpm.mjs"))).digest("hex")).toBe("d3a7f4bde2f32c5acc5f012d1edc24c24ea247c2f6c8823146f8cd69ed70b22f");
  expect(JSON.parse(readFileSync(join(PNPM!, "pnpm-source.json"), "utf8"))).toEqual({ version: "11.7.0", asset: "pnpm-linux-x64.tar.gz", sha256: "752e31654c6f24bc945db784d12831b80b29f533b43105575ce30dd3c8658609" });
  const sourceHashes = {
    "node_modules/@deepseek-ai/dsh-settings/lib/index.js": "9432b872597b7a31473072eb38a55979ab23375c76bd1d86d751388a692a0136",
    "node_modules/@deepseek-ai/dsh-credentials-local/lib/index.js": "1688f17801d5809abace4ef6228b771625a0153c043d7d4dba21b398ec4056eb",
    "node_modules/@deepseek-ai/dsh-app-boot/lib/index.js": "234db45e1b3f8c683b5bc1f551948b2a2ec52a6468c7b6937725a23f1c0e0d96",
    "node_modules/@deepseek-ai/dsh-config-editor/lib/index.js": "373e05c8250d25dda983ccf6e214a55e3792a211d1a7b883affcd66de47b5bf8",
    "node_modules/@deepseek-ai/dsh-hmr/lib/index.js": "75686a16199f90f5b580d96923d3d5c52a513402b399ad723d92506d00ea7676",
  };
  for (const [file, hash] of Object.entries(sourceHashes)) expect(createHash("sha256").update(readFileSync(join(APP!, file))).digest("hex"), `authenticated service bytes ${file}`).toBe(hash);
  const root = mkdtempSync(join(tmpdir(), "real-config-io-"));
  writeFileSync(join(root, "source-hashes.json"), JSON.stringify(sourceHashes, null, 2));
  console.log(`REAL_IO_ARTIFACT ${root}`);
  const app = join(root, "app-input"); cpSync(APP!, app, { recursive: true });
  transformApp(app);
  if (existsSync(join(app, "node_modules", KIT))) splitOfficeAddon(app, join(root, "office"));
  const native = join(root, "dsh-native");
  execFileSync("bun", [join(ROOT, "scripts/compile-entry.mjs"), "bun-linux-x64", native], { timeout: 120_000 });
  const bundle = join(root, "bundles", RUNTIME);
  assembleBundle({ target: "linux-x64-modern", out: bundle, app, pnpm: PNPM, native,
    identity: { id: RUNTIME, tag: "dsh-v0.2.0-rc.2", channel: "rc" },
    upstream: { commit: "639ed015397290b3745d163aafe02ffee4aa3f84", commitTime: "2026-09-29T09:21:31.000Z", version: RUNTIME },
    run: 1, attempt: 1, builderCommit: "10a6a9fd7993f61b32f1194e4b65ae10bd7e18a4" });
  const home = join(root, "home"), plugins = join(root, "snapshots", `${RUNTIME}@1`);
  const pd = join(plugins, "profiles/io"), pkg = join(pd, "node_modules/io-bundle");
  privateFile(join(plugins, ".usage.lock"), "");
  privateFile(join(pd, "package.json"), JSON.stringify({ name: "dsh-profile-io", private: true, dependencies: { "io-bundle": "1.0.0" }, dsh: { profile: { bundles: ["io-bundle"] } } }));
  privateFile(join(pd, "pnpm-workspace.yaml"), "packages:\n  - .\nnodeLinker: hoisted\n");
  privateFile(join(pkg, "package.json"), JSON.stringify({ name: "io-bundle", version: "1.0.0", type: "module", main: "index.js", dsh: { bundle: { patch: "cordis.patch.yml" } } }));
  privateFile(join(pkg, "index.js"), PROBE);
  // Test-only extraction: raw helper SHA above; adapted helper below adds same production boundary guard.
  // Not exported by rc.2. Normal HMR stays degraded; helper + actual reconciliation proof only.
  const hmr = readFileSync(join(APP!, "node_modules/@deepseek-ai/dsh-hmr/lib/index.js"), "utf8");
  const start = hmr.indexOf("const registrations ="), end = hmr.indexOf("//#endregion", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const watchSource = hmr.slice(start, end);
  console.log(`REAL_HMR_HELPER_SHA256 ${createHash("sha256").update(watchSource).digest("hex")}`);
  const helperFile = join(bundle, "app/node_modules/@deepseek-ai/dsh-hmr/lib/index.js");
  const mappedHmr = readFileSync(helperFile, "utf8");
  const mappedStart = mappedHmr.indexOf("const registrations ="), mappedEnd = mappedHmr.indexOf("//#endregion", mappedStart);
  privateFile(join(pkg, "watch-config.js"), 'import { paths as __dshBinPaths } from "dsh-bin:config-paths";\nimport { dirname, resolve, relative } from "node:path";\nimport { stat, realpath } from "node:fs/promises";\nimport { watch } from ' + JSON.stringify(join(bundle, 'app/node_modules/chokidar/esm/index.js')) + ';\n' + mappedHmr.slice(mappedStart, mappedEnd) + '\nexport { watchConfig };\n');
  privateFile(join(pkg, "cordis.patch.yml"), `- insert:\n    - id: config-editor\n      name: '@deepseek-ai/dsh-config-editor'\n    - id: settings\n      name: '@deepseek-ai/dsh-settings'\n    - id: credentials-local\n      name: '@deepseek-ai/dsh-credentials-local'\n    - id: io-probe\n      name: io-bundle\n`);
  const creds = (label: string) => `# independent source bytes ${label}\nversion: 1\nrefs:\n  IO_TEST_KEY: synthetic-${label}\n`;
  const patch = (label: string) => `# independent source bytes ${label}\n- id: io-probe\n  config:\n    label: ${label}\n`;
  privateFile(join(home, "profiles/io/cordis.patch.yml"), patch("shared-HOME"));
  privateFile(join(home, ".credentials.yaml"), creds("shared-HOME"));
  privateFile(join(home, ".env"), "IO_HOME_ONLY=synthetic-shared-HOME-fallback\n");
  privateFile(join(home, "settings.yaml"), "io-probe:\n  label: shared-import-must-not-run\n");
  privateFile(join(home, "cordis.patch.yml"), "[]\n");
  privateFile(join(home, "sentinel"), "non-config application home stays here\n");
  privateFile(join(home, "sessions/sentinel.jsonl"), '{"test":"non-config session remains shared HOME"}\n');
  privateFile(join(home, "cache/sentinel"), "non-config cache remains shared HOME\n");
  const configs = [1, 2].map(n => {
    const dir = join(root, "config-snapshots", `${RUNTIME}@${n}`);
    privateFile(join(dir, ".usage.lock"), "");
    privateFile(join(dir, "profiles/io/cordis.patch.yml"), patch(`C${n}`));
    privateFile(join(dir, ".credentials.yaml"), creds(`C${n}`));
    return dir;
  });
  const originals = [join(configs[0], "profiles/io/cordis.patch.yml"), join(configs[0], ".credentials.yaml"), join(home, "profiles/io/cordis.patch.yml"), join(home, ".credentials.yaml"), join(home, ".env"), join(home, "settings.yaml"), join(home, "cordis.patch.yml"), join(home, "sentinel"), join(home, "sessions/sentinel.jsonl"), join(home, "cache/sentinel"), join(pd, "package.json"), join(pd, "pnpm-workspace.yaml"), join(pkg, "index.js"), join(pkg, "watch-config.js"), join(pkg, "cordis.patch.yml")].map(path => [path, readFileSync(path)] as const);
  let runCount = 0;
  async function run(n: number, mode = "read", cwd = home, failure = false) {
    const launch = { protocol: 2, runtime: RUNTIME, dataRoot: root, home, snapshot: { id: `${RUNTIME}@1`, dir: plugins }, configSnapshot: { id: `${RUNTIME}@${n}`, dir: configs[n - 1] }, addons: {}, cache: join(root, "cache"), tmp: join(root, "tmp"), manager: "test" };
    const stem = `run-${++runCount}-C${n}-${mode}`, audit = join(root, `${stem}.audit`);
    // Kernel audit, not absence-of-secret output: include failed opens and native watcher registrations.
    const proc = Bun.spawn(["timeout", "--kill-after=2s", "30s", "strace", "-f", "-qq", "-e", "trace=open,openat,rename,renameat,renameat2,inotify_add_watch", "-o", audit, join(bundle, "dsh-native"), "--profile", "io", mode], {
      cwd, env: { PATH: process.env.PATH!, HOME: home, DSH_HOME: home, TMPDIR: root, XDG_CACHE_HOME: join(root, "cache"), DSH_MANAGER_LAUNCH: JSON.stringify(launch), IO_PROCESS_ONLY: "synthetic-inherited-process", NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });

    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    writeFileSync(join(root, `${stem}.log`), stdout + stderr);
    expect(code, "timeout is failure: " + stderr).not.toBe(124); expect(code).not.toBe(137);
    const accesses = readFileSync(audit, "utf8");
    for (const path of [join(home, ".env"), join(home, ".credentials.yaml"), join(home, "settings.yaml"), join(home, "settings.yaml.imported"), join(home, "cordis.patch.yml"), join(home, "profiles/io/cordis.patch.yml")]) expect(accesses, `forbidden sensitive open: ${path}`).not.toContain(`"${path}"`);
    if (failure) { expect(code, stdout + stderr).not.toBe(0); expect(stdout).not.toContain("IO_REPORT "); return { stderr, accesses }; }
    expect(code, stdout + stderr).toBe(0);
    const line = stdout.split("\n").find(l => l.startsWith("IO_REPORT "));
    expect(line, stdout + stderr).toBeTruthy();
    const report = JSON.parse(line!.slice(10));
    if (existsSync(report.before.patch)) expect(accesses.includes(`"${report.before.patch}"`), `profile read ${report.before.patch}`).toBe(true);
    return { ...report, accesses };
  }
  const first = await run(1);
  expect(first.before.label).toBe("C1"); expect(first.before.credential).toEqual({ value: "synthetic-C1", source: "file" });
  expect(first.before.homeFallback).toBeUndefined();
  expect(first.before.processOnly).toEqual({ value: "synthetic-inherited-process", source: "env" });
  expect(first.before.cache).toBe(join(home, "cache"));
  const second = await run(2, "update");
  expect(second.before.label).toBe("C2"); expect(second.before.credential.value).toBe("synthetic-C2");
  expect(second.after.label).toBe("C2-updated"); expect(second.after.credential.value).toBe("synthetic-C2-updated");
  const again = await run(1); expect(again.before).toEqual(first.before); expect(again.after).toEqual(first.after);
  expect(second.accesses).toContain("inotify_add_watch");
  const alias = join(root, "home-alias"); symlinkSync(home, alias);
  expect((await run(1, "read", alias)).before).toEqual(first.before);
  const importedBytes = "# authentic legacy settings service, not format mock\nio-probe:\n  label: C2-imported\n";
  privateFile(join(configs[1], "settings.yaml"), importedBytes);
  const imported = await run(2, "import");
  expect(imported.after.label).toBe("C2-imported");
  expect(existsSync(join(configs[1], "settings.yaml"))).toBe(false);
  expect(readFileSync(join(configs[1], "settings.yaml.imported"), "utf8")).toBe(importedBytes);
  expect(imported.accesses).toMatch(/rename\(.*settings.yaml.*settings.yaml.imported/);
  const watched = await run(2, "watch"); expect(watched.after.credential.value).toBe("synthetic-watched");
  expect(watched.accesses).toContain("inotify_add_watch");
  const profileWatched = await run(2, "profile-watch"); expect(profileWatched.after.label).toBe("C2-profile-watched");
  expect(profileWatched.accesses).toContain("inotify_add_watch");
  expect(statSync(join(configs[1], ".credentials.yaml")).mode & 0o077).toBe(0);
  const bundlePatch = readFileSync(join(pkg, "cordis.patch.yml"), "utf8");
  const providerConfig = (value: object) => privateFile(join(configs[1], "profiles/io/cordis.patch.yml"), `- id: credentials-local\n  config: ${JSON.stringify(value)}\n- id: io-probe\n  config:\n    label: custom-C2\n`);
  for (const value of [{ path: "accounts/work.yaml" }, { path: join(configs[1], "accounts/work.yaml") }, { dshHome: join(configs[1], "accounts") }]) {
    const filename = "dshHome" in value ? join(configs[1], "accounts/.credentials.yaml") : join(configs[1], "accounts/work.yaml");
    privateFile(filename, creds("custom-C2")); providerConfig(value);
    const custom = await run(2, "update"); expect(custom.before.credential.value).toBe("synthetic-custom-C2");
    expect(custom.after.credential.value).toBe("synthetic-C2-updated");
    expect(readFileSync(filename, "utf8")).toContain("synthetic-C2-updated");
    expect(custom.accesses).toContain(`"${filename}"`);
    expect(statSync(filename).mode & 0o077).toBe(0);
  }
  const external = join(root, "outside.yaml"); privateFile(external, creds("outside-must-not-open"));
  symlinkSync(external, join(configs[1], "escape.yaml"));
  symlinkSync(root, join(configs[1], "escape-parent"));
  for (const value of [{ path: external }, { path: join(home, ".credentials.yaml") }, { path: join(configs[0], ".credentials.yaml") }, { path: "../outside.yaml" }, { path: "escape.yaml" }, { path: "escape-parent/outside.yaml" }, { dshHome: home }]) {
    providerConfig(value); const refused = await run(2, "read", home, true);
    expect(refused.stderr).toContain("configuration path violates selected configuration boundary");
    expect(refused.accesses).not.toContain(`"${external}"`);
    expect(refused.accesses).not.toContain(`"${join(configs[0], ".credentials.yaml")}"`);
    expect(refused.accesses).not.toContain("inotify_add_watch");
    expect(refused.stderr).not.toContain("outside-must-not-open");
  }
  const loose = join(configs[1], "loose.yaml"); privateFile(loose, creds("loose-must-not-read")); chmodSync(loose, 0o644);
  const hard = join(configs[1], "hard.yaml"); linkSync(external, hard);
  for (const path of [loose, hard]) {
    providerConfig({ path }); const refused = await run(2, "read", home, true);
    expect(refused.stderr).toContain("DSH_CONFIG_BOUNDARY");
    expect(refused.accesses).not.toMatch(new RegExp('"' + path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '", O_RDONLY(?![^\\n]*O_PATH)'));
    expect(refused.accesses).not.toContain("inotify_add_watch");
  }
  chmodSync(configs[1], 0o755); const looseRoot = await run(2, "read", home, true); chmodSync(configs[1], 0o700);
  expect(looseRoot.stderr).toContain("DSH_CONFIG_BOUNDARY"); expect(looseRoot.accesses).not.toContain("inotify_add_watch");
  privateFile(join(configs[1], "profiles/io/cordis.patch.yml"), patch("C2"));
  const empty = join(root, "config-snapshots", `${RUNTIME}@3`); configs.push(empty); privateFile(join(empty, ".usage.lock"), "");
  const emptyRun = await run(3); expect(emptyRun.before.credential).toBeUndefined(); expect(emptyRun.before.homeFallback).toBeUndefined(); expect(emptyRun.before.label).toBe("bundle-default");
  // Process and independent project layers still upstream, not snapshot-owned store.
  const project = join(root, "project"); privateFile(join(project, ".env"), "IO_TEST_KEY=synthetic-project\n");
  expect((await run(3, "read", project)).before.credential).toEqual({ value: "synthetic-project", source: "project-env" });
  privateFile(join(empty, ".env"), "IO_HOME_ONLY=synthetic-selected-C-env\n");
  expect((await run(3)).before.homeFallback).toEqual({ value: "synthetic-selected-C-env", source: "user-env" });
  const created = await run(3, "private-create");
  expect(created.after.credential.value).toBe("synthetic-C2-updated");
  expect(statSync(join(empty, ".credentials.yaml")).mode & 0o077).toBe(0);
  expect(statSync(join(empty, "profiles/io")).mode & 0o077).toBe(0);
  expect(statSync(join(empty, "profiles/io/cordis.patch.yml")).mode & 0o077).toBe(0);
  expect(created.accesses).toMatch(/\.credentials.yaml[^\n]*O_WRONLY[^\n]*0600|O_WRONLY[^\n]*\.credentials.yaml/);
  expect(readFileSync(join(pkg, "cordis.patch.yml"), "utf8")).toBe(bundlePatch);
  for (const [path, bytes] of originals) expect(readFileSync(path).equals(bytes), path).toBe(true);
  expect(first.before.home).toBe(home); expect(first.before.dir).toBe(pd);
  expect(first.before.patch).toBe(join(configs[0], "profiles/io/cordis.patch.yml"));
  expect(first.before.plugin).toContain(pkg);
  expect(existsSync(join(pd, "cordis.yml"))).toBe(true);
  expect(existsSync(join(configs[0], "profiles/io/cordis.yml"))).toBe(false);
  const standalone = join(root, "standalone-home");
  cpSync(join(plugins, "profiles"), join(standalone, "profiles"), { recursive: true });
  privateFile(join(standalone, "profiles/io/cordis.patch.yml"), patch("standalone"));
  privateFile(join(standalone, ".credentials.yaml"), creds("standalone"));
  privateFile(join(standalone, ".env"), "IO_HOME_ONLY=synthetic-standalone-home-fallback\n");
  const direct = Bun.spawnSync(["timeout", "--kill-after=2s", "30s", join(bundle, "dsh-native"), "--profile", "io", "update"], { cwd: standalone,
    env: { PATH: process.env.PATH!, HOME: standalone, DSH_HOME: standalone, DSH_BIN_CONFIG_SNAPSHOT_DIR: configs[0], TMPDIR: root, XDG_CACHE_HOME: join(root, "cache"), NO_COLOR: "1" } });
  writeFileSync(join(root, "standalone.log"), direct.stdout.toString() + direct.stderr.toString());
  expect(direct.exitCode, direct.stderr.toString()).toBe(0);
  const directReport = JSON.parse(direct.stdout.toString().split("\n").find(l => l.startsWith("IO_REPORT "))!.slice(10));
  expect(directReport.before.label).toBe("standalone"); expect(directReport.before.credential.value).toBe("synthetic-standalone");
  expect(directReport.before.homeFallback.value).toBe("synthetic-standalone-home-fallback");
  expect(directReport.after.credential.value).toBe("synthetic-C2-updated");
  expect(directReport.before.patch).toBe(join(standalone, "profiles/io/cordis.patch.yml"));
  for (const [path, bytes] of originals) expect(readFileSync(path).equals(bytes), `standalone must not touch ${path}`).toBe(true);
}, 180_000);
