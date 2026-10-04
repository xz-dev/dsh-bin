// CS-FORMAT / CS-CROSS / CS-SWITCH (task 3.5): two DIFFERENT authenticated upstream release packages A → B → A
// through the real manager install/launch path, real compiled entry, assembled bundles and real upstream
// settings/credentials services. Missing inputs FAIL; this suite never silently skips.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { appendBundle, emptyIndex } from "../../scripts/index.mjs";
import { compileEntry } from "../../scripts/compile-entry.mjs";
import { localBuild } from "../../scripts/local-build.mjs";
import { splitOfficeAddon } from "../../scripts/split-addon.mjs";
import { transformApp } from "../../scripts/transform-app.mjs";

const APP_A = process.env.DSH_BIN_REAL_IO_APP_A;
const APP_B = process.env.DSH_BIN_REAL_IO_APP_B;
const PNPM = process.env.DSH_BIN_TEST_PNPM;
const ROOT = resolve(import.meta.dir, "../..");
const MANAGER_DIR = resolve(ROOT, "../dsh-manager");
const TARGET = "linux-x64-modern";
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const fileHash = (p: string) => sha256(readFileSync(p));

// Frozen authentic inputs: official upstream tags resolved by git ls-remote, built once by build-app.mjs.
const RELEASES = {
	A: { version: "0.2.0-rc.1", tag: "dsh-v0.2.0-rc.1", commit: "4878cdabd87d4041bdaff61d04c966883b9fd07a", commitTime: "2026-09-28T11:48:10.000Z",
		hashes: { "package.json": "e9af39fa893ee997b45859799d60108f0e882c1d550e9783925615bdb3f3ac4d", "lib/bin.js": "935e95d05f4dc70a8a013eea59da80028946b5c139e45c6351dcaf2810ca00a1" } },
	B: { version: "0.2.0-rc.2", tag: "dsh-v0.2.0-rc.2", commit: "639ed015397290b3745d163aafe02ffee4aa3f84", commitTime: "2026-09-29T09:21:31.000Z",
		hashes: { "package.json": "95ed7e68bbe959d37a13bf8626ff677bad7d8fcbcc4b41245ddcb2082d98d756", "lib/bin.js": "1a03dee18683483ff6a1b27b2a1e650230da6bcca9a0f55f7d81b3308c3f307f" } },
} as const;
// Upstream config services. Same bytes in both releases (recorded fact, not assumed compatibility).
const SERVICES = {
	"node_modules/@deepseek-ai/dsh-settings/lib/index.js": "9432b872597b7a31473072eb38a55979ab23375c76bd1d86d751388a692a0136",
	"node_modules/@deepseek-ai/dsh-credentials-local/lib/index.js": "1688f17801d5809abace4ef6228b771625a0153c043d7d4dba21b398ec4056eb",
	"node_modules/@deepseek-ai/dsh-app-boot/lib/index.js": "234db45e1b3f8c683b5bc1f551948b2a2ec52a6468c7b6937725a23f1c0e0d96",
	"node_modules/@deepseek-ai/dsh-config-editor/lib/index.js": "373e05c8250d25dda983ccf6e214a55e3792a211d1a7b883affcd66de47b5bf8",
	"node_modules/@deepseek-ai/dsh-hmr/lib/index.js": "75686a16199f90f5b580d96923d3d5c52a513402b399ad723d92506d00ea7676",
	"node_modules/@deepseek-ai/dsh-atomic-write/lib/index.js": "5f07978ef594a2711b2da301d5cb73a835cf1a48c1f8920ab5c6625137e12029",
};

const PROBE = `import z from '@deepseek-ai/schemastery';
export const inject = ['settings', 'credentials', 'profileContext', 'appReady', 'appExit'];
export const Config = z.object({ label: z.string().default('bundle-default').volatile() });
export function apply(ctx, config) {
  ctx.appReady.onReady(() => { void (async () => {
    await ctx.root.loader.await();
    const label = () => ctx.settings.describe().find(r => r.ns === 'io-probe')?.value.label;
    const read = async () => ({ label: label(), credential: await ctx.credentials.resolve('IO_TEST_KEY'),
      home: ctx.profileContext.home, dir: ctx.profileContext.dir, patch: ctx.settings.documentPath,
      credentialFile: ctx.credentials.spec?.filename, plugin: import.meta.url });
    const mode = ctx.cmdlineArgs.get()[0];
    if (mode === 'import' && label() !== 'B-imported') {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('settings import timeout')), 5000);
        ctx.on('settings/document-updated', () => { if (label() === 'B-imported') { clearTimeout(timer); resolve(); } });
      });
    }
    const before = await read();
    if (mode === 'update') {
      await ctx.settings.update('io-probe', { label: 'B-updated' });
      await ctx.credentials.set('IO_TEST_KEY', 'synthetic-B-updated');
    }
    const launch = JSON.parse(process.env.DSH_MANAGER_LAUNCH);
    console.log('TWO_RUNTIME_REPORT ' + JSON.stringify({ runtime: launch.runtime, configSnapshot: launch.configSnapshot, snapshot: launch.snapshot, exe: process.execPath, before, after: await read() }));
    ctx.appExit(0);
  })().catch(e => { console.error(e); ctx.appExit(1); }); });
}
`;

function privateFile(path: string, text: string) {
	mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
	writeFileSync(path, text, { mode: 0o600 });
}
function walk(dir: string, base = dir): string[] {
	return readdirSync(dir).flatMap((name) => {
		const p = join(dir, name), s = lstatSync(p);
		return s.isDirectory() && !s.isSymbolicLink() ? [relative(base, p), ...walk(p, base)] : [relative(base, p)];
	}).sort();
}
/** Byte digest of every path; .usage.lock is a zero-byte claim file and stays included. */
function digest(dir: string): Record<string, string> {
	return Object.fromEntries(walk(dir).map((p) => {
		const f = join(dir, p), s = lstatSync(f);
		return [p, s.isSymbolicLink() ? `link:${readlinkSync(f)}` : s.isFile() ? fileHash(f) : "dir"];
	}));
}
const content = (d: Record<string, string>) => Object.fromEntries(Object.entries(d).filter(([p]) => p !== "snapshot.json" && p !== ".usage.lock"));

test("CS-FORMAT / CS-CROSS: real rc.1 → rc.2 auto inheritance, rc.2 settings/provider/import writes, back to rc.1 original bytes, copy vs direct cross use", async () => {
	expect(APP_A, "set DSH_BIN_REAL_IO_APP_A to authentic pre-transform dsh-v0.2.0-rc.1 app").toBeTruthy();
	expect(APP_B, "set DSH_BIN_REAL_IO_APP_B to authentic pre-transform dsh-v0.2.0-rc.2 app").toBeTruthy();
	expect(PNPM, "set DSH_BIN_TEST_PNPM to authenticated pnpm closure").toBeTruthy();
	expect(Bun.version).toBe("1.4.2");
	for (const tool of ["zig", "strace", "timeout"]) expect(Bun.which(tool), tool).toBeTruthy();
	expect(fileHash(join(PNPM!, "dist/pnpm.mjs"))).toBe("d3a7f4bde2f32c5acc5f012d1edc24c24ea247c2f6c8823146f8cd69ed70b22f");
	const apps = { A: APP_A!, B: APP_B! };
	for (const key of ["A", "B"] as const) {
		const r = RELEASES[key];
		expect(JSON.parse(readFileSync(join(apps[key], "package.json"), "utf8")).version).toBe(r.version);
		for (const [file, hash] of Object.entries(r.hashes)) expect(fileHash(join(apps[key], file)), `${key} ${file}`).toBe(hash);
		for (const [file, hash] of Object.entries(SERVICES)) expect(fileHash(join(apps[key], file)), `${key} service ${file}`).toBe(hash);
	}
	expect(RELEASES.A.hashes["lib/bin.js"]).not.toBe(RELEASES.B.hashes["lib/bin.js"]); // different packages, not relabels

	const root = realpathSync(mkdtempSync(join(tmpdir(), "two-runtime-config-")));
	console.log(`TWO_RUNTIME_ARTIFACT ${root}`);
	// Standard path: transform → office split → one compiled entry → localBuild assemble/archive → runtime index.
	const native = join(root, "dsh-native");
	compileEntry("bun-linux-x64", native);
	const index = emptyIndex(), assets = new Map<string, string>(), ids: Record<"A" | "B", string> = { A: "", B: "" };
	for (const key of ["A", "B"] as const) {
		const r = RELEASES[key], work = join(root, `work-${key}`);
		cpSync(apps[key], join(work, "app"), { recursive: true });
		transformApp(join(work, "app"));
		splitOfficeAddon(join(work, "app"), join(work, "addon-office"));
		symlinkSync(PNPM!, join(work, "pnpm-linux-x64"));
		const built = localBuild({ out: join(root, "out"), channel: "release", run: 1, attempt: 1, upstreamCommit: r.commit, upstreamCommitTime: r.commitTime, upstreamVersion: r.version, work, native, targetId: TARGET });
		writeFileSync(join(root, "out", `${built.tag}.json`), `${JSON.stringify(built.manifest, null, 2)}\n`);
		appendBundle(index, built.manifest);
		assets.set(`/download/${built.tag}/${built.asset.name}`, built.zip);
		ids[key] = built.id;
		console.log(`TWO_RUNTIME_BUNDLE ${JSON.stringify({ key, id: built.id, zip: built.zip, sha256: built.asset.sha256, size: built.asset.size })}`);
	}
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
		const path = new URL(req.url).pathname;
		if (path === "/runtime-index.json") return Response.json(index);
		const file = assets.get(path);
		return file ? new Response(Bun.file(file)) : new Response(null, { status: 404 });
	} });
	try {
		const prefix = join(root, "manager-build");
		execFileSync("zig", ["build", "-Dversion=1.0.0-two-runtime", "--prefix", prefix], { cwd: MANAGER_DIR, stdio: "inherit", timeout: 300_000 });
		const install = join(root, "install"), exe = join(install, "dsh"), data = join(install, "dsh-bin"), userHome = join(root, "user-home");
		for (const d of [install, userHome, join(root, "tmp")]) mkdirSync(d, { recursive: true });
		cpSync(join(prefix, "bin/dsh"), exe);
		const env = { PATH: install, HOME: userHome, TMPDIR: join(root, "tmp"), NO_COLOR: "1", DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_ORIGIN: server.url.origin };
		let count = 0;
		async function dsh(args: string[], label: string) {
			const stem = `${String(++count).padStart(2, "0")}-${label}`, audit = join(root, `${stem}.audit`);
			// Driver tools use absolute paths; the product cannot resolve host Node/Bun/compilers.
			const proc = Bun.spawn([Bun.which("timeout")!, "--kill-after=2s", "120s", Bun.which("strace")!, "-f", "-qq", "-e", "trace=open,openat,rename,renameat,renameat2,inotify_add_watch", "-o", audit, exe, ...args],
				{ cwd: userHome, env, stdout: "pipe", stderr: "pipe" });
			const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
			const code = await proc.exited;
			writeFileSync(join(root, `${stem}.log`), `$ dsh ${args.join(" ")}\nexit ${code}\n${stdout}${stderr}`);
			expect(code, `${stem}: ${stdout}${stderr}`).toBe(0);
			return { stdout, stderr, accesses: readFileSync(audit, "utf8") };
		}
		const home = join(data, "home"), config = (id: string) => join(data, "config-snapshots", id), plugins = (id: string) => join(data, "snapshots", id);
		const sensitiveHome = [".env", ".credentials.yaml", "settings.yaml", "settings.yaml.imported", "cordis.patch.yml", "profiles/io/cordis.patch.yml"].map((p) => join(home, p));
		async function app(runtime: string, mode: string, configSnapshot?: string) {
			const r = await dsh(["--use", runtime, ...(configSnapshot ? ["--config-snapshot", configSnapshot] : []), "--profile", "io", mode], `${runtime.split("-b")[0]}-${configSnapshot ?? "default"}-${mode}`);
			for (const p of sensitiveHome) expect(r.accesses, `forbidden shared-home open ${p}`).not.toContain(`"${p}"`);
			const line = r.stdout.split("\n").find((l) => l.startsWith("TWO_RUNTIME_REPORT "));
			expect(line, r.stdout + r.stderr).toBeTruthy();
			return { ...JSON.parse(line!.slice(19)), accesses: r.accesses };
		}

		// A installed and given user data through its real plugin snapshot and config snapshot.
		await dsh(["manager", "install", ids.A], "install-A");
		const A1 = `${ids.A}@1`, B1 = `${ids.B}@1`, B2 = `${ids.B}@2`;
		expect(JSON.parse(readFileSync(join(config(A1), "snapshot.json"), "utf8")).source).toBe("empty");
		const pd = join(plugins(A1), "profiles/io"), pkg = join(pd, "node_modules/io-bundle");
		privateFile(join(pd, "package.json"), JSON.stringify({ name: "dsh-profile-io", private: true, dependencies: { "io-bundle": "1.0.0" }, dsh: { profile: { bundles: ["io-bundle"] } } }));
		privateFile(join(pd, "pnpm-workspace.yaml"), "packages:\n  - .\nnodeLinker: hoisted\n");
		privateFile(join(pkg, "package.json"), JSON.stringify({ name: "io-bundle", version: "1.0.0", type: "module", main: "index.js", dsh: { bundle: { patch: "cordis.patch.yml" } } }));
		privateFile(join(pkg, "index.js"), PROBE);
		privateFile(join(pkg, "cordis.patch.yml"), "- insert:\n    - id: config-editor\n      name: '@deepseek-ai/dsh-config-editor'\n    - id: settings\n      name: '@deepseek-ai/dsh-settings'\n    - id: credentials-local\n      name: '@deepseek-ai/dsh-credentials-local'\n    - id: io-probe\n      name: io-bundle\n");
		const creds = (label: string) => `# independent source bytes ${label}\nversion: 1\nrefs:\n  IO_TEST_KEY: synthetic-${label}\n`;
		const patch = (label: string) => `# independent source bytes ${label}\n- id: io-probe\n  config:\n    label: ${label}\n`;
		privateFile(join(config(A1), "profiles/io/cordis.patch.yml"), patch("A-original"));
		privateFile(join(config(A1), ".credentials.yaml"), creds("A-original"));
		privateFile(join(home, "profiles/io/cordis.patch.yml"), patch("shared-HOME"));
		privateFile(join(home, ".credentials.yaml"), creds("shared-HOME"));
		privateFile(join(home, ".env"), "IO_TEST_KEY=synthetic-shared-HOME-env\n");
		privateFile(join(home, "settings.yaml"), "io-probe:\n  label: shared-import-must-not-run\n");
		privateFile(join(home, "cordis.patch.yml"), "[]\n");
		privateFile(join(home, "sentinel"), "non-config application home stays here\n");
		privateFile(join(home, "sessions/sentinel.jsonl"), '{"test":"non-config session remains shared HOME"}\n');
		const homeBytes = digest(home), bundleFile = (key: "A" | "B") => join(data, "bundles", ids[key], "dsh-native");
		const installedRelease = (key: "A" | "B") => {
			const app = join(data, "bundles", ids[key], "app");
			expect(JSON.parse(readFileSync(join(app, "package.json"), "utf8")).version).toBe(RELEASES[key].version);
			expect(fileHash(join(app, "lib/bin.js")), `installed ${key} upstream entry`).toBe(RELEASES[key].hashes["lib/bin.js"]);
			expect(JSON.parse(readFileSync(join(data, "bundles", ids[key], "bundle.json"), "utf8")).upstream).toMatchObject({ commit: RELEASES[key].commit, version: RELEASES[key].version });
		};
		installedRelease("A");

		const firstA = await app(ids.A, "read");
		expect(firstA.runtime).toBe(ids.A); expect(firstA.configSnapshot.id).toBe(A1); expect(firstA.exe).toBe(bundleFile("A"));
		expect(firstA.before.label).toBe("A-original"); expect(firstA.before.credential).toEqual({ value: "synthetic-A-original", source: "file" });
		expect(firstA.before.patch).toBe(join(config(A1), "profiles/io/cordis.patch.yml"));
		expect(firstA.before.plugin).toContain(join(plugins(A1), "profiles/io/node_modules/io-bundle"));
		expect(firstA.accesses).toContain(`"${join(config(A1), ".credentials.yaml")}"`);
		const aOriginal = digest(config(A1)), pluginOriginal = Object.fromEntries(["package.json", "index.js", "cordis.patch.yml"].map((f) => [f, fileHash(join(pkg, f))]));
		const aContent = (path: string) => [".credentials.yaml", "profiles/io/cordis.patch.yml", "settings.yaml"].map((p) => `"${join(path, p)}`);

		// B installed: the manager inherits A's newest config (and plugins) automatically; A unchanged.
		await dsh(["manager", "install", ids.B], "install-B");
		installedRelease("B");
		expect(JSON.parse(readFileSync(join(config(B1), "snapshot.json"), "utf8")).source).toBe(A1);
		expect(JSON.parse(readFileSync(join(plugins(B1), "snapshot.json"), "utf8")).source).toBe(A1);
		expect(content(digest(config(B1)))).toEqual(content(aOriginal));
		expect(digest(config(A1))).toEqual(aOriginal);
		const inherited = await app(ids.B, "read");
		expect(inherited.runtime).toBe(ids.B); expect(inherited.configSnapshot.id).toBe(B1); expect(inherited.exe).toBe(bundleFile("B"));
		expect(inherited.before.label).toBe("A-original"); expect(inherited.before.credential).toEqual({ value: "synthetic-A-original", source: "file" });
		expect(inherited.before.patch).toBe(join(config(B1), "profiles/io/cordis.patch.yml"));
		expect(inherited.before.plugin).toContain(join(plugins(B1), "profiles/io/node_modules/io-bundle"));
		for (const p of aContent(config(A1))) expect(inherited.accesses).not.toContain(p);

		// B real settings update, local provider update, legacy settings import and explicit provider path.
		const updated = await app(ids.B, "update");
		expect(updated.after.label).toBe("B-updated"); expect(updated.after.credential.value).toBe("synthetic-B-updated");
		expect(readFileSync(join(config(B1), ".credentials.yaml"), "utf8")).toContain("synthetic-B-updated");
		expect(readFileSync(join(config(B1), "profiles/io/cordis.patch.yml"), "utf8")).toContain("B-updated");
		const legacy = "# authentic legacy settings service, not format mock\nio-probe:\n  label: B-imported\n";
		privateFile(join(config(B1), "settings.yaml"), legacy);
		const imported = await app(ids.B, "import");
		expect(imported.after.label).toBe("B-imported");
		expect(existsSync(join(config(B1), "settings.yaml"))).toBe(false);
		expect(readFileSync(join(config(B1), "settings.yaml.imported"), "utf8")).toBe(legacy);
		expect(imported.accesses).toMatch(new RegExp(`rename\\("${config(B1)}/settings\\.yaml", "${config(B1)}/settings\\.yaml\\.imported"`));
		privateFile(join(config(B1), "accounts/work.yaml"), creds("B-custom"));
		privateFile(join(config(B1), "profiles/io/cordis.patch.yml"), `- id: credentials-local\n  config: {"path":"accounts/work.yaml"}\n- id: io-probe\n  config:\n    label: B-custom\n`);
		const custom = await app(ids.B, "update");
		expect(custom.before.credential.value).toBe("synthetic-B-custom"); expect(custom.after.credential.value).toBe("synthetic-B-updated");
		expect(readFileSync(join(config(B1), "accounts/work.yaml"), "utf8")).toContain("synthetic-B-updated");
		for (const run of [updated, imported, custom]) for (const p of aContent(config(A1))) expect(run.accesses).not.toContain(p);
		expect(digest(config(A1))).toEqual(aOriginal);

		// Back to A: original values and bytes.
		const backA = await app(ids.A, "read");
		expect(backA.configSnapshot.id).toBe(A1); expect(backA.exe).toBe(bundleFile("A"));
		expect(backA.before).toEqual(firstA.before); expect(backA.after).toEqual(firstA.after);
		expect(digest(config(A1))).toEqual(aOriginal);

		// Explicit cross-version trial on a copy: new --target A@1 under B, then B writes only the copy.
		await dsh(["manager", "snapshot", "config", "new", "--use", ids.B, "--target", A1], "copy-A1-to-B");
		expect(JSON.parse(readFileSync(join(config(B2), "snapshot.json"), "utf8")).source).toBe(A1);
		expect(content(digest(config(B2)))).toEqual(content(aOriginal));
		const onCopy = await app(ids.B, "update", B2);
		expect(onCopy.configSnapshot.id).toBe(B2); expect(onCopy.before.label).toBe("A-original"); expect(onCopy.after.credential.value).toBe("synthetic-B-updated");
		expect(readFileSync(join(config(B2), ".credentials.yaml"), "utf8")).toContain("synthetic-B-updated");
		for (const p of aContent(config(A1))) expect(onCopy.accesses).not.toContain(p);
		expect(digest(config(A1))).toEqual(aOriginal);

		// Explicit direct cross use: B really operates A@1; no hidden copy, no selection or snapshot count change.
		const storesBefore = readdirSync(join(data, "config-snapshots")).sort(), selectionBefore = existsSync(join(data, "state/selection.json")) ? readFileSync(join(data, "state/selection.json"), "utf8") : null;
		const direct = await app(ids.B, "update", A1);
		expect(direct.runtime).toBe(ids.B); expect(direct.configSnapshot.id).toBe(A1); expect(direct.exe).toBe(bundleFile("B"));
		expect(direct.before.label).toBe("A-original"); expect(direct.before.credential.value).toBe("synthetic-A-original");
		expect(direct.after.label).toBe("B-updated"); expect(direct.after.credential.value).toBe("synthetic-B-updated");
		expect(readFileSync(join(config(A1), ".credentials.yaml"), "utf8")).toContain("synthetic-B-updated");
		expect(readdirSync(join(data, "config-snapshots")).sort()).toEqual(storesBefore);
		expect(existsSync(join(data, "state/selection.json")) ? readFileSync(join(data, "state/selection.json"), "utf8") : null).toBe(selectionBefore);
		const afterDirect = await app(ids.A, "read");
		expect(afterDirect.before.label).toBe("B-updated"); expect(afterDirect.before.credential.value).toBe("synthetic-B-updated");

		expect(digest(home)).toEqual(homeBytes);
		for (const [f, hash] of Object.entries(pluginOriginal)) expect(fileHash(join(pkg, f)), `plugin ${f}`).toBe(hash);
		writeFileSync(join(root, "summary.json"), JSON.stringify({ ids, aOriginal, homeBytes, pluginOriginal }, null, 2));
	} finally {
		server.stop(true);
	}
}, 1_800_000);
