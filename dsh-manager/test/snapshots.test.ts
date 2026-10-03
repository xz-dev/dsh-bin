// MC-SNAPSHOT: native snapshot lifecycle, isolated homes and real manager/fake-native processes.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, closeSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireClaim } from "./claim-probe.ts";
import { addRuntime, argvOf, baseEnv, build, cleanup, hasZig, launchOf, newInstall, run, started, tree, replaceAncestor, WIN, type Install } from "./harness.ts";

beforeAll(() => { if (hasZig) build(); }, 300_000);
afterAll(cleanup);
const A = "1.0.0-b1.1.gdeadbeef", B = "1.0.0-b2.1.gdeadbeef";
const root = (i: Install) => join(i.data, "snapshots");
const dir = (i: Install, id: string) => join(root(i), id);
const command = (i: Install, args: string[], env = {}) => run(i, ["manager", "snapshot", "plugins", ...args], { env });
const rows = (i: Install) => { const r = command(i, ["list", "--json"]); expect(r.status).toBe(0); return JSON.parse(r.stdout).snapshots; };
const digest = (path: string) => tree(path).filter(p => lstatSync(join(path, p)).isFile()).map(p => [p, createHash("sha256").update(readFileSync(join(path, p))).digest("hex")]);
function install() { const i = newInstall(); addRuntime(i.data, A, { run: 1 }); addRuntime(i.data, B, { run: 2 }); return i; }

test.skipIf(!hasZig)("MC-SNAPSHOT: names, empty/copy, selection guard and all-delete numbering never reuse IDs", () => {
	const cold = newInstall(), before = tree(cold.dir);
	expect(rows(cold)).toEqual([]); expect(tree(cold.dir)).toEqual(before);
	const i = install();
	expect(command(i, ["new", "--use", A, "--empty", "--name", "base"]).status).toBe(0);
	const first = dir(i, `${A}@1`), profile = join(first, "profiles", "probe"); mkdirSync(profile);
	writeFileSync(join(profile, "plugin"), "plugin bytes");
	mkdirSync(join(i.data, "home", "profiles", "probe"), { recursive: true });
	writeFileSync(join(i.data, "home", "profiles", "probe", "cordis.patch.yml"), "shared config");
	const saved = digest(first);
	expect(command(i, ["new", "--use", A, "--name", "copy"]).status).toBe(0);
	expect(digest(first)).toEqual(saved); expect(readFileSync(join(dir(i, `${A}@2`), "profiles/probe/plugin"), "utf8")).toBe("plugin bytes");
	writeFileSync(join(dir(i, `${A}@2`), "profiles/probe/plugin"), "different"); expect(digest(first)).toEqual(saved);
	expect(command(i, ["new", "--use", B, "--target", `${A}@base`, "--name", "base"]).status).toBe(0);
	expect(existsSync(join(dir(i, `${B}@1`), "profiles/probe/cordis.patch.yml"))).toBe(false);
	const initial = rows(i); expect(initial.map((s: any) => s.id)).toEqual([`${A}@1`, `${A}@2`, `${B}@1`]);
	expect(initial.find((s: any) => s.id === `${B}@1`)).toMatchObject({ alias: "base", source: `${A}@1`, reason: "user", newest: true, bundleInstalled: true });
	for (const args of [["new", "--use", A, "--name", "copy"], ["new", "--use", A, "--name", "123"], ["new", "--use", A, "--name", "../outside"], ["new", "--use", A, "--empty", "--target", `${A}@1`], ["remove", `${A}@1`, "missing@1"]]) {
		expect(command(i, args).status).toBe(1); expect(rows(i)).toEqual(initial); expect(started(i)).toBe(false);
	}
	expect(run(i, ["manager", "select", "--use", B, "--snapshot", `${A}@1`]).status).toBe(0);
	const rejected = command(i, ["remove", `${A}@2`, `${A}@1`]); expect(rejected.status).toBe(1); expect(rejected.stderr).toContain("selection"); expect(rows(i)).toHaveLength(3);
	expect(run(i, ["manager", "select", "--use", "latest"]).status).toBe(0);
	expect(command(i, ["remove", `${A}@base`, `${A}@2`, `${A}@2`]).status).toBe(0);
	expect(command(i, ["new", "--use", A, "--empty"]).status).toBe(0); expect(rows(i).map((s: any) => s.id)).toContain(`${A}@3`);
	expect(command(i, ["remove", `${A}@3`]).status).toBe(0);
	expect(run(i, ["--use", A, "probe"]).status).toBe(0); expect(launchOf(i).snapshot.id).toBe(`${A}@4`);
	expect(command(i, ["list"]).stdout).toContain(`${A}@4`); expect(started(i)).toBe(false);
});

test.skipIf(!hasZig)("MC-SNAPSHOT: staged interruptions publish nothing and reserved numbers stay spent", () => {
	const i = install(); expect(command(i, ["new", "--use", A, "--empty"]).status).toBe(0);
	for (const [point, n] of [["snapshot-reserved", 2], ["snapshot-copied", 3]] as const) {
		const r = command(i, ["new", "--use", A], { DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_CRASH: point });
		expect(r.status).toBe(86); expect(rows(i).map((s: any) => s.id)).toEqual([`${A}@1`]); expect(existsSync(dir(i, `${A}@${n}`))).toBe(false);
	}
	expect(command(i, ["new", "--use", A]).status).toBe(0); expect(rows(i).map((s: any) => s.id)).toEqual([`${A}@1`, `${A}@4`]);
	writeFileSync(join(root(i), ".counters.json"), "not JSON");
	expect(command(i, ["new", "--use", A]).status).toBe(1); expect(rows(i)).toHaveLength(2);
});

test.skipIf(!hasZig || WIN)("MC-SNAPSHOT: internal pnpm-style links copy independently; escaping/absolute links refuse unpublished", () => {
	const i = install(); expect(command(i, ["new", "--use", A, "--empty"]).status).toBe(0);
	const profile = join(dir(i, `${A}@1`), "profiles/probe"), mod = join(profile, "node_modules"); mkdirSync(join(mod, ".pnpm/pkg/node_modules/pkg"), { recursive: true });
	writeFileSync(join(mod, ".pnpm/pkg/node_modules/pkg/index.js"), "original");
	symlinkSync(".pnpm/pkg/node_modules/pkg", join(mod, "pkg"));
	expect(command(i, ["new", "--use", B, "--target", `${A}@1`]).status).toBe(0);
	const copied = join(dir(i, `${B}@1`), "profiles/probe/node_modules"); expect(readlinkSync(join(copied, "pkg"))).toBe(".pnpm/pkg/node_modules/pkg");
	writeFileSync(join(copied, "pkg/index.js"), "copy changed"); expect(readFileSync(join(mod, "pkg/index.js"), "utf8")).toBe("original");
	for (const target of ["../../../../home", i.home]) {
		symlinkSync(target, join(profile, "unsafe")); const r = command(i, ["new", "--use", B, "--target", `${A}@1`]);
		expect(r.status).toBe(1); expect(r.stderr).toContain("unsafe"); expect(rows(i).filter((s: any) => s.version === B)).toHaveLength(1); rmSync(join(profile, "unsafe"));
	}
});

test.skipIf(!hasZig || WIN)("MC-SNAPSHOT review: chained relative links cannot make a copy modify its source", () => {
	const i = install(); expect(command(i, ["new", "--use", A, "--empty"]).status).toBe(0);
	const source = join(dir(i, `${A}@1`), "profiles"), plugin = join(source, "probe/plugin");
	mkdirSync(join(source, "probe")); writeFileSync(plugin, "source original");
	mkdirSync(join(source, "dir")); symlinkSync(".", join(source, "dir/alias"));
	symlinkSync(`dir/alias/alias/../../../${A}@1/profiles/probe`, join(source, "leak"));
	const copied = command(i, ["new", "--use", B, "--target", `${A}@1`]);
	if (copied.status === 0) writeFileSync(join(dir(i, `${B}@1`), "profiles/leak/plugin"), "changed through copy");
	expect(readFileSync(plugin, "utf8")).toBe("source original");
	expect(copied.status).toBe(1); expect(copied.stderr).toContain("leak"); expect(copied.stderr).toContain("nothing was published");
	expect(rows(i).map((s: any) => s.id)).toEqual([`${A}@1`]);
	expect(readdirSync(root(i)).some(p => p.startsWith(".staging-"))).toBe(false);
	expect(JSON.parse(readFileSync(join(root(i), ".counters.json"), "utf8"))[B]).toBe(1);
});

test.skipIf(!hasZig).each(["plugins", "config"])("MC-SNAPSHOT review: replacing the %s snapshots ancestor never deletes external user files", async kind => {
	const i = install(), id = `${A}@1`, store = join(i.data, kind === "config" ? "config-snapshots" : "snapshots");
	expect(typed(i, kind, ["new", "--use", A, "--empty"]).status).toBe(0);
	const external = join(i.home, "external"), sentinel = join(external, id, "unrelated-user-file");
	mkdirSync(join(external, id), { recursive: true }); writeFileSync(sentinel, "KEEP");
	const p = spawn(i.exe, ["manager", "snapshot", kind, "remove", id], { cwd: i.home, env: { ...baseEnv(i), DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_PAUSE: "snapshot-remove" }, stdio: "pipe" });
	let stderr = ""; p.stderr.on("data", b => { stderr += b.toString(); }); p.stdout.resume();
	const done = new Promise<number | null>((resolve, reject) => { p.on("close", resolve); p.on("error", reject); });
	const watchdog = setTimeout(() => p.kill("SIGKILL"), 15_000);
	try {
		const deadline = Date.now() + 5000;
		while (!stderr.includes("test pause: snapshot-remove") && p.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
		expect(stderr).toContain("test pause: snapshot-remove");
		const claim = acquireClaim(join(store, id, ".usage.lock"), "shared");
		try { expect(claim).toBe("busy"); } finally { if (claim !== "busy") claim.release(); }
		const original = replaceAncestor(store, external);
		p.stdin.end("continue"); const code = await done;
		expect(existsSync(sentinel)).toBe(true); expect(readFileSync(sentinel, "utf8")).toBe("KEEP");
		expect(code).toBe(0); expect(existsSync(join(original, id))).toBe(false); expect(started(i)).toBe(false);
	} finally { clearTimeout(watchdog); if (p.exitCode === null) { p.kill("SIGKILL"); await done; } }
}, 30_000);

test.skipIf(!hasZig)("MC-IN-USE: a post-preflight removal failure reports the already removed snapshot without rollback", async () => {
	const i = install();
	for (let n = 0; n < 2; n++) expect(command(i, ["new", "--use", A, "--empty"]).status).toBe(0);
	const first = `${A}@1`, second = `${A}@2`, saved = join(i.out, "second-preserved");
	const p = spawn(i.exe, ["manager", "snapshot", "plugins", "remove", first, second], { cwd: i.home, env: { ...baseEnv(i), DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_PAUSE: "snapshot-remove" }, stdio: "pipe" });
	let stderr = "", stdout = ""; p.stderr.on("data", b => { stderr += b.toString(); }); p.stdout.on("data", b => { stdout += b.toString(); });
	const done = new Promise<number | null>((resolve, reject) => { p.on("close", resolve); p.on("error", reject); });
	const timer = setTimeout(() => p.kill("SIGKILL"), 15_000);
	let blocker: number | undefined, preserved = saved;
	try {
		const deadline = Date.now() + 5000;
		while (!stderr.includes("test pause: snapshot-remove") && p.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
		expect(stderr).toContain("test pause: snapshot-remove");
		try { renameSync(dir(i, second), saved); }
		catch (err) {
			if (!WIN || (err as NodeJS.ErrnoException).code !== "EPERM") throw err;
			// Our preflight guard blocks the test's rename too. A separate open descendant
			// keeps the second item busy after the manager releases its own Windows claim.
			preserved = dir(i, second); blocker = openSync(join(preserved, "snapshot.json"), "r");
		}
		p.stdin.end("x");
		expect(await done).toBe(1); expect(stdout).toContain(`Removed snapshot ${first}`); expect(stdout).not.toContain(`Removed snapshot ${second}`);
		expect(stderr).toContain(second);
		if (blocker === undefined) expect(stderr).toContain("earlier reported removals remain removed");
		else { expect(stderr).toContain("in use"); expect(stderr).toContain("object unchanged"); expect(stderr).toContain("retry"); }
		expect(existsSync(dir(i, first))).toBe(false); expect(existsSync(join(preserved, "snapshot.json"))).toBe(true);
	} finally { clearTimeout(timer); if (p.exitCode === null) { p.kill("SIGKILL"); await done; } if (blocker !== undefined) closeSync(blocker); }
});

test.skipIf(!hasZig)("MC-SNAPSHOT: concurrent starts reuse prepared snapshots without taking the busy store locks", async () => {
	const i = install(); expect(command(i, ["new", "--use", A, "--empty"]).status).toBe(0);
	expect(typed(i, "config", ["new", "--use", A, "--empty"]).status).toBe(0);
	const held = acquireClaim(join(root(i), ".lock"), "exclusive"); expect(held).not.toBe("busy");
	// Each fake child owns its recorder files; test concurrent manager starts, not recorder writes.
	const start = async (gen: string) => {
		const p = Bun.spawn([i.exe, "--use", A, "probe"], { cwd: i.home, env: { ...baseEnv(i), FAKE_GEN: gen }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		const timer = setTimeout(() => p.kill("SIGKILL"), 30_000);
		try { const [code, stderr] = await Promise.all([p.exited, new Response(p.stderr).text(), new Response(p.stdout).text()]); return { code, stderr }; }
		finally { clearTimeout(timer); if (p.exitCode === null) { p.kill("SIGKILL"); await p.exited; } }
	};
	try {
		// Drain both children before assertions, including when one failed, so cleanup cannot race the other.
		const results = await Promise.all([start("1"), start("2")]);
		for (const { code, stderr } of results) { expect(code, `concurrent snapshot launch stderr:\n${stderr}`).toBe(0); expect(stderr).not.toContain("Busy"); }
		for (const gen of ["1", "2"]) expect(launchOf(i, gen).snapshot.id).toBe(`${A}@1`);
		expect(rows(i).map((s: any) => s.id)).toEqual([`${A}@1`]);
	} finally { if (held !== "busy") held.release(); }
});

// Store boundary only: these fixtures are not real settings/credential services.
const typed = (i: Install, kind: string, args: string[], env = {}) => run(i, ["manager", "snapshot", kind, ...args], { env });
const typedRows = (i: Install, kind: string) => { const r = typed(i, kind, ["list", "--json"]); expect(r.status, r.stderr).toBe(0); return JSON.parse(r.stdout).snapshots; };
const configDir = (i: Install, id: string) => join(i.data, "config-snapshots", id);

test.skipIf(!hasZig)("MC-TYPED / CS-IDENTITY: type required; same ID/alias independent; configSnapshot persists separately", () => {
	const cold = newInstall(), before = tree(cold.dir);
	for (const args of [["new"], ["list"], ["remove", `${A}@1`], ["other", "list"]]) {
		const r = run(cold, ["manager", "snapshot", ...args]); expect(r.status).toBe(1); expect(r.stderr).toContain("plugins|config");
		expect(tree(cold.dir)).toEqual(before);
	}
	const i = install();
	for (const kind of ["plugins", "config"]) {
		expect(typed(i, kind, ["new", "--use", A, "--empty", "--name", "daily"]).status).toBe(0);
		expect(typedRows(i, kind)).toHaveLength(1);
		expect(typedRows(i, kind)[0]).toMatchObject({ kind, id: `${A}@1`, alias: "daily", source: "empty" });
	}
	expect(run(i, ["manager", "select", "--use", A, "--snapshot", `${A}@daily`, "--config-snapshot", `${A}@daily`]).status).toBe(0);
	const selection = join(i.data, "state/selection.json"), saved = readFileSync(selection, "utf8");
	expect(JSON.parse(saved)).toMatchObject({ snapshot: `${A}@1`, configSnapshot: `${A}@1` });
	expect(typed(i, "config", ["new", "--use", A]).status).toBe(0); expect(readFileSync(selection, "utf8")).toBe(saved);
	expect(typedRows(i, "plugins")).toHaveLength(1);
	expect(typed(i, "config", ["remove", `${A}@2`, `${A}@1`]).status).toBe(1); expect(typedRows(i, "config")).toHaveLength(2);
});

test.skipIf(!hasZig).each(["plugins", "config"])("CS-CREATE / CS-GAPS: %s default/target/empty policy and monotonic counters", kind => {
	const i = install(), path = kind === "config" ? configDir : dir;
	expect(typed(i, kind, ["new", "--use", A]).status).toBe(1);
	expect(typed(i, kind, ["new", "--use", A, "--empty", "--name", "base"]).status).toBe(0);
	mkdirSync(join(path(i, `${A}@1`), "profiles/p")); writeFileSync(join(path(i, `${A}@1`), "profiles/p/cordis.patch.yml"), "original\n");
	const saved = digest(path(i, `${A}@1`));
	expect(typed(i, kind, ["new", "--use", A, "--name", "copy"]).status).toBe(0);
	expect(typed(i, kind, ["new", "--use", B, "--target", `${A}@base`]).status).toBe(0);
	expect(typedRows(i, kind).find((s: any) => s.id === `${B}@1`)).toMatchObject({ source: `${A}@1` });
	writeFileSync(join(path(i, `${B}@1`), "profiles/p/cordis.patch.yml"), "changed"); expect(digest(path(i, `${A}@1`))).toEqual(saved);
	for (const args of [["new", "--use", A, "--name", "copy"], ["new", "--use", A, "--empty", "--target", `${A}@1`], ["new", "--use", A, "--target", "missing@1"]]) expect(typed(i, kind, args).status).toBe(1);
	expect(typed(i, kind, ["new", "--use", A]).status).toBe(0);
	expect(typed(i, kind, ["remove", `${A}@2`, `${A}@3`]).status).toBe(0);
	expect(typedRows(i, kind).find((s: any) => s.id === `${A}@1`).newest).toBe(true);
	expect(typed(i, kind, ["new", "--use", A]).status).toBe(0);
	expect(typedRows(i, kind).map((s: any) => s.id)).toEqual([`${A}@1`, `${A}@4`, `${B}@1`]); expect(started(i)).toBe(false);
});

test.skipIf(!hasZig)("MC-ARGS / MC-NAMESPACE: config option leading boundary; old protocol still refused", () => {
	const i = install();
	expect(run(i, ["--use", A, "--profile", "tui", "-p", "manager update --use latest --config-snapshot A@1"]).status).toBe(0);
	expect(argvOf(i)).toEqual(["--profile", "tui", "-p", "manager update --use latest --config-snapshot A@1"]);
	const r = run(i, ["--config-snapshot", `${A}@1`, "probe"]); expect(r.status).toBe(0); expect(launchOf(i).configSnapshot.id).toBe(`${A}@1`);
	addRuntime(i.data, B, { patch: { launchProtocol: 1 } });
	const legacy = run(i, ["--use", B, "--config-snapshot", `${A}@1`]); expect(legacy.status).toBe(1); expect(legacy.stderr).toContain("protocol 1"); expect(started(i)).toBe(false);
	expect(run(i, ["--use", A, "manager", "snapshot", "config", "new", "--empty"]).status).toBe(0); expect(started(i)).toBe(false);
});

test.skipIf(!hasZig)("CS-CONTENT / CS-PERMISSIONS: config copies all profiles/settings/local paths independently, excluding non-content", () => {
	const i = install(); expect(typed(i, "config", ["new", "--use", A, "--empty"]).status).toBe(0);
	const source = configDir(i, `${A}@1`);
	const contents = { "profiles/one/cordis.patch.yml": "one: yes\n", "profiles/two/cordis.patch.yml": "two: yes\n", "settings.yaml": "settings\n", "settings.yaml.imported": "imported\n", ".credentials.yaml": "test-secret-do-not-print\n", "accounts/work.yaml": "private-work-test\n", "future.conf": "future-format-opaque\n" };
	for (const [name, bytes] of Object.entries(contents)) { mkdirSync(join(source, name, ".."), { recursive: true }); writeFileSync(join(source, name), bytes); }
	const excluded = ["profiles/one/node_modules/pkg/index.js", "profiles/one/package.json", "profiles/one/pnpm-lock.yaml", "profiles/one/cordis.yml", "sessions/chat.jsonl", "addons/office/file", "bundles/file", "cache/file", "state/selection.json", ".credentials.yaml.lock", ".credentials.yaml.tmp-123", ".tmp-test/secret"];
	for (const name of excluded) { mkdirSync(join(source, name, ".."), { recursive: true }); writeFileSync(join(source, name), "excluded-test"); }
	const saved = digest(source);
	const mask = WIN ? null : process.umask(0);
	let r: ReturnType<typeof typed>;
	try { r = typed(i, "config", ["new", "--use", A], { DSH_HOME: i.home }); } finally { if (mask !== null) process.umask(mask); }
	expect(r.status, r.stderr).toBe(0);
	const dest = configDir(i, `${A}@2`);
	for (const [name, bytes] of Object.entries(contents)) {
		expect(readFileSync(join(dest, name), "utf8")).toBe(bytes);
		if (!WIN) { expect(lstatSync(join(dest, name)).ino).not.toBe(lstatSync(join(source, name)).ino); expect(lstatSync(join(dest, name)).mode & 0o077).toBe(0); }
	}
	for (const name of excluded) expect(existsSync(join(dest, name))).toBe(false);
	writeFileSync(join(dest, ".credentials.yaml"), "changed"); writeFileSync(join(dest, "profiles/one/cordis.patch.yml"), "changed"); expect(digest(source)).toEqual(saved);
	if (!WIN) for (const name of [join(i.data, "config-snapshots"), dest, join(dest, "profiles/one"), join(dest, "accounts")]) expect(lstatSync(name).mode & 0o077).toBe(0);
	expect(r.stdout + r.stderr + JSON.stringify(typedRows(i, "config"))).not.toContain("test-secret-do-not-print");
	expect(typedRows(i, "plugins")).toEqual([]); expect(started(i)).toBe(false);
});

test.skipIf(!hasZig)("CS-CONTENT review: profile names and nested local paths are not storage roles", () => {
	const i = install(); expect(typed(i, "config", ["new", "--use", A, "--empty"]).status).toBe(0);
	const source = configDir(i, `${A}@1`);
	const names = ["cache", "state", "tmp", "session", "sessions", "addons", "bundles", "node_modules", "package.json", "cordis.yml", "snapshot.json", ".usage.lock", ".staging-profile", "profile.tmp", "profile.lock", "profile.jsonl"];
	const contents = Object.fromEntries(names.map(name => [`profiles/${name}/cordis.patch.yml`, `profile: ${name}\n`]));
	Object.assign(contents, { "accounts/cache/work.yaml": "nested-cache-config\n", "accounts/state/work.yaml": "nested-state-config\n", "accounts/tmp/work.yaml": "nested-tmp-config\n" });
	for (const [name, bytes] of Object.entries(contents)) { mkdirSync(join(source, name, ".."), { recursive: true }); writeFileSync(join(source, name), bytes); }
	const excluded = names.flatMap(name => ["node_modules/pkg/index.js", "cordis.yml", "package.json", "pnpm-lock.yaml", ".credentials.yaml.tmp-123"].map(file => `profiles/${name}/${file}`));
	for (const name of excluded) { mkdirSync(join(source, name, ".."), { recursive: true }); writeFileSync(join(source, name), "excluded"); }
	const saved = digest(source), pluginsBefore = tree(root(i));
	const r = typed(i, "config", ["new", "--use", A]); expect(r.status, r.stderr).toBe(0);
	const dest = configDir(i, `${A}@2`);
	for (const [name, bytes] of Object.entries(contents)) expect(readFileSync(join(dest, name), "utf8")).toBe(bytes);
	for (const name of excluded) expect(existsSync(join(dest, name))).toBe(false);
	writeFileSync(join(dest, "profiles/cache/cordis.patch.yml"), "copy changed"); expect(digest(source)).toEqual(saved);
	expect(tree(root(i))).toEqual(pluginsBefore); expect(started(i)).toBe(false);
});

test.skipIf(!hasZig).each(["plugins", "config"])("CS-FAILURE review: %s removal rejects a replacement target after preflight", async kind => {
	const i = install(), id = `${A}@1`, path = kind === "config" ? configDir : dir;
	expect(typed(i, kind, ["new", "--use", A, "--empty"]).status).toBe(0);
	const saved = join(i.out, "original"), replacement = join(i.out, "replacement"), sentinel = "unrelated-user-file";
	mkdirSync(replacement); writeFileSync(join(replacement, sentinel), "KEEP");
	const before = digest(path(i, id));
	const p = spawn(i.exe, ["manager", "snapshot", kind, "remove", id], { cwd: i.home, env: { ...baseEnv(i), DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_PAUSE: "snapshot-remove" }, stdio: "pipe" });
	let stderr = "", stdout = ""; p.stderr.on("data", b => { stderr += b.toString(); }); p.stdout.on("data", b => { stdout += b.toString(); });
	const done = new Promise<number | null>((resolve, reject) => { p.on("close", resolve); p.on("error", reject); }); const timer = setTimeout(() => p.kill("SIGKILL"), 15000);
	let swapped = false;
	try {
		const deadline = Date.now() + 5000; while (!stderr.includes("test pause: snapshot-remove") && p.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
		expect(stderr).toContain("test pause: snapshot-remove");
		try { renameSync(path(i, id), saved); swapped = true; }
		catch (err) { if (!WIN || (err as NodeJS.ErrnoException).code !== "EPERM") throw err; }
		if (swapped) renameSync(replacement, path(i, id));
		p.stdin.end("x"); const code = await done;
		if (swapped) {
			expect(code).toBe(1); expect(stderr).toContain("SnapshotChanged"); expect(stdout).not.toContain("Removed snapshot");
			expect(readFileSync(join(path(i, id), sentinel), "utf8")).toBe("KEEP"); expect(digest(saved)).toEqual(before);
		} else { expect(code).toBe(0); expect(existsSync(path(i, id))).toBe(false); expect(readFileSync(join(replacement, sentinel), "utf8")).toBe("KEEP"); }
		expect(started(i)).toBe(false);
	} finally { clearTimeout(timer); if (p.exitCode === null) { p.kill("SIGKILL"); await done; } }
});

test.skipIf(!hasZig).each(["plugins", "config"].flatMap(kind => ["changed", "replaced", "added", "missing"].map(change => [kind, change])))
("CS-FAILURE review: %s publication rejects %s earlier staged content", async (kind, change) => {
	const i = install(), path = kind === "config" ? configDir : dir;
	expect(typed(i, kind, ["new", "--use", A, "--empty"]).status).toBe(0);
	const source = path(i, `${A}@1`), content = kind === "config" ? source : join(source, "profiles/probe");
	mkdirSync(content, { recursive: true });
	writeFileSync(join(content, ".credentials.yaml"), "original-synthetic-credential\n"); writeFileSync(join(content, "settings.yaml"), "original-settings\n");
	expect(run(i, ["manager", "select", "--use", A, kind === "config" ? "--config-snapshot" : "--snapshot", `${A}@1`]).status).toBe(0);
	const saved = digest(source), pin = readFileSync(join(i.data, "state/selection.json"), "utf8"), other = kind === "config" ? "snapshots" : "config-snapshots", otherBefore = digest(join(i.data, other));
	const p = spawn(i.exe, ["manager", "snapshot", kind, "new", "--use", A], { cwd: i.home, env: { ...baseEnv(i), DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_PAUSE: "snapshot-file-copied" }, stdio: "pipe" });
	let stderr = "", stdout = ""; p.stderr.on("data", b => { stderr += b.toString(); }); p.stdout.on("data", b => { stdout += b.toString(); });
	const done = new Promise<number | null>((resolve, reject) => { p.on("close", resolve); p.on("error", reject); }); const timer = setTimeout(() => p.kill("SIGKILL"), 15000);
	const pauses = () => [...stderr.matchAll(/test pause: snapshot-file-copied ([^\r\n]+)/g)].map(m => m[1]);
	try {
		for (let n = 1; n <= 2; n++) {
			const deadline = Date.now() + 5000; while (pauses().length < n && p.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
			expect(pauses()).toHaveLength(n); if (n === 1) p.stdin.write("x");
		}
		const store = join(i.data, kind === "config" ? "config-snapshots" : "snapshots"), staging = readdirSync(store).filter(name => name.startsWith(".staging-")); expect(staging).toHaveLength(1);
		const staged = join(store, staging[0]), copied = kind === "config" ? staged : join(staged, "profiles/probe"), first = join(copied, pauses()[0]);
		if (kind === "config" && !WIN) for (const name of [staged, ...tree(staged).map(name => join(staged, name))]) expect(lstatSync(name).mode & 0o077).toBe(0);
		if (change === "changed") writeFileSync(first, Buffer.alloc(readFileSync(first).length, 0x78));
		else if (change === "replaced") { const replacement = join(i.out, "replacement"); writeFileSync(replacement, readFileSync(first)); renameSync(replacement, first); }
		else if (change === "missing") rmSync(first);
		else writeFileSync(join(copied, "unexpected.yaml"), "untrusted-added-content\n");
		p.stdin.end("x"); expect(await done).toBe(1); expect(stderr).toContain("SnapshotChanged"); expect(stdout).not.toContain("Created"); expect(stdout + stderr).not.toContain("original-synthetic-credential");
		expect(typedRows(i, kind).map((s: any) => s.id)).toEqual([`${A}@1`]); expect(existsSync(path(i, `${A}@2`))).toBe(false);
		expect(digest(source)).toEqual(saved); expect(readFileSync(join(i.data, "state/selection.json"), "utf8")).toBe(pin); expect(digest(join(i.data, other))).toEqual(otherBefore);
		expect(readdirSync(store).some(name => name.startsWith(".staging-"))).toBe(false);
		expect(JSON.parse(readFileSync(join(store, ".counters.json"), "utf8"))[A]).toBe(2);
		expect(typed(i, kind, ["new", "--use", A]).status).toBe(0); expect(typedRows(i, kind).map((s: any) => s.id)).toEqual([`${A}@1`, `${A}@3`]); expect(started(i)).toBe(false);
	} finally { clearTimeout(timer); if (p.exitCode === null) { p.kill("SIGKILL"); await done; } }
});

test.skipIf(!hasZig)("CS-FAILURE: injected I/O failure and interruption keep selection/source and private unpublished residues", () => {
	const i = install(); expect(typed(i, "config", ["new", "--use", A, "--empty"]).status).toBe(0);
	writeFileSync(join(configDir(i, `${A}@1`), ".credentials.yaml"), "failure-test-secret");
	expect(run(i, ["manager", "select", "--use", A, "--config-snapshot", `${A}@1`]).status).toBe(0);
	const pin = readFileSync(join(i.data, "state/selection.json"), "utf8"), saved = digest(configDir(i, `${A}@1`));
	for (const [extra, exit] of [[{ DSH_MANAGER_TEST_FAIL: "snapshot-copy" }, 1], [{ DSH_MANAGER_TEST_CRASH: "snapshot-copied" }, 86]] as const) {
		const r = typed(i, "config", ["new", "--use", A], { DSH_MANAGER_TEST: "1", ...extra }); expect(r.status).toBe(exit);
		expect(r.stdout + r.stderr).not.toContain("failure-test-secret"); expect(typedRows(i, "config").map((s: any) => s.id)).toEqual([`${A}@1`]);
		expect(readFileSync(join(i.data, "state/selection.json"), "utf8")).toBe(pin); expect(digest(configDir(i, `${A}@1`))).toEqual(saved);
	}
	if (!WIN) for (const name of readdirSync(join(i.data, "config-snapshots")).filter(p => p.startsWith(".staging-"))) {
		const path = join(i.data, "config-snapshots", name); expect(lstatSync(path).mode & 0o077).toBe(0);
		for (const p of tree(path)) expect(lstatSync(join(path, p)).mode & 0o077).toBe(0);
	}
	expect(typed(i, "config", ["new", "--use", A]).status).toBe(0); expect(typedRows(i, "config").map((s: any) => s.id)).toEqual([`${A}@1`, `${A}@4`]);
	expect(run(i, ["manager", "clean"]).status).toBe(0); expect(readdirSync(join(i.data, "config-snapshots")).some(p => p.startsWith(".staging-"))).toBe(false);
});

test.skipIf(!hasZig)("CS-FAILURE: detected source mutation refuses publication without exposing credential body", async () => {
	const i = install(); expect(typed(i, "config", ["new", "--use", A, "--empty"]).status).toBe(0);
	const secret = join(configDir(i, `${A}@1`), ".credentials.yaml"); writeFileSync(secret, "original-secret-test");
	const p = spawn(i.exe, ["manager", "snapshot", "config", "new", "--use", A], { cwd: i.home, env: { ...baseEnv(i), DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_PAUSE: "snapshot-file-copied" }, stdio: "pipe" });
	let stderr = "", stdout = ""; p.stderr.on("data", b => { stderr += b.toString(); }); p.stdout.on("data", b => { stdout += b.toString(); });
	const done = new Promise<number | null>((resolve, reject) => { p.on("close", resolve); p.on("error", reject); }); const timer = setTimeout(() => p.kill("SIGKILL"), 15000);
	try {
		const deadline = Date.now() + 5000; while (!stderr.includes("test pause: snapshot-file-copied .credentials.yaml") && p.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
		expect(stderr).toContain("test pause: snapshot-file-copied .credentials.yaml"); writeFileSync(secret, "modified-by-test-not-manager"); p.stdin.end("x");
		expect(await done).toBe(1); expect(stderr).toContain("SnapshotChanged"); expect(stdout + stderr).not.toContain("original-secret-test");
		expect(typedRows(i, "config").map((s: any) => s.id)).toEqual([`${A}@1`]); expect(readFileSync(secret, "utf8")).toBe("modified-by-test-not-manager");
	} finally { clearTimeout(timer); if (p.exitCode === null) { p.kill("SIGKILL"); await done; } }
});

test.skipIf(!hasZig)("CS-FAILURE: publication cannot replace an existing empty directory", async () => {
	const i = install(); expect(typed(i, "config", ["new", "--use", A, "--empty"]).status).toBe(0);
	const p = spawn(i.exe, ["manager", "snapshot", "config", "new", "--use", A], { cwd: i.home, env: { ...baseEnv(i), DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_PAUSE: "snapshot-copy" }, stdio: "pipe" });
	let stderr = ""; p.stderr.on("data", b => { stderr += b.toString(); }); p.stdout.resume(); const done = new Promise<number | null>((resolve, reject) => { p.on("close", resolve); p.on("error", reject); }); const timer = setTimeout(() => p.kill("SIGKILL"), 15000);
	try {
		const deadline = Date.now() + 5000; while (!stderr.includes("test pause: snapshot-copy") && p.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
		expect(stderr).toContain("test pause: snapshot-copy"); mkdirSync(configDir(i, `${A}@2`)); p.stdin.end("x"); expect(await done).toBe(1);
		expect(tree(configDir(i, `${A}@2`))).toEqual([]); expect(existsSync(join(configDir(i, `${A}@1`), "snapshot.json"))).toBe(true);
	} finally { clearTimeout(timer); if (p.exitCode === null) { p.kill("SIGKILL"); await done; } }
});

test.skipIf(!hasZig || WIN)("CS-FAILURE: config source symlink/hardlink/special files rejected without external read/write", () => {
	const i = install(); expect(typed(i, "config", ["new", "--use", A, "--empty"]).status).toBe(0);
	const outside = join(i.home, "outside-secret"), target = join(configDir(i, `${A}@1`), ".credentials.yaml"); writeFileSync(outside, "outside-test-secret");
	symlinkSync(outside, target); const r = typed(i, "config", ["new", "--use", A]); expect(r.status).toBe(1); expect(r.stdout + r.stderr).not.toContain("outside-test-secret"); expect(typedRows(i, "config")).toHaveLength(1); rmSync(target);
	linkSync(outside, target); expect(typed(i, "config", ["new", "--use", A]).status).toBe(1); rmSync(target);
	execFileSync("mkfifo", [target]); expect(typed(i, "config", ["new", "--use", A]).status).toBe(1); rmSync(target);
	expect(readFileSync(outside, "utf8")).toBe("outside-test-secret"); expect(typedRows(i, "config")).toHaveLength(1);
});

test.skipIf(!hasZig)("CS-IDENTITY / MC-TYPED: valid legacy plugin metadata/selection without kind/config field remains usable", () => {
	const i = install(), legacy = dir(i, `${A}@5`);
	mkdirSync(join(legacy, "profiles/p"), { recursive: true });
	writeFileSync(join(legacy, "profiles/p/plugin"), "legacy-plugin-bytes");
	writeFileSync(join(legacy, "snapshot.json"), JSON.stringify({ id: `${A}@5`, version: A, n: 5, alias: "legacy" }));
	writeFileSync(join(legacy, ".usage.lock"), "");
	mkdirSync(join(i.data, "state"));
	const selection = join(i.data, "state/selection.json"), original = JSON.stringify({ schema: 1, use: A, snapshot: `${A}@5`, addons: {} });
	writeFileSync(selection, original);
	expect(typedRows(i, "plugins")[0]).toMatchObject({ id: `${A}@5`, kind: "plugins", selected: true });
	expect(run(i, ["probe"]).status).toBe(0); expect(launchOf(i).snapshot.id).toBe(`${A}@5`);
	expect(readFileSync(selection, "utf8")).toBe(original);
	expect(typed(i, "plugins", ["new", "--use", A, "--target", `${A}@legacy`]).status).toBe(0);
	expect(readFileSync(join(dir(i, `${A}@6`), "profiles/p/plugin"), "utf8")).toBe("legacy-plugin-bytes");
});

test.skipIf(!hasZig)("MC-TYPED: completion types/aliases never cross stores and stay offline/read-only", () => {
	const i = install();
	expect(typed(i, "plugins", ["new", "--use", A, "--empty", "--name", "plugin-only"]).status).toBe(0);
	expect(typed(i, "config", ["new", "--use", A, "--empty", "--name", "config-only"]).status).toBe(0);
	const before = tree(i.data), counters = ["snapshots", "config-snapshots"].map(s => readFileSync(join(i.data, s, ".counters.json"), "utf8"));
	const query = (words: string[]) => { const r = run(i, ["manager", "__complete", "--shell", "bash", "--", ...words]); expect(r.status).toBe(0); expect(r.stderr).toBe(""); return r.stdout.trim().split("\n"); };
	expect(query(["manager", "snapshot", ""])).toEqual(expect.arrayContaining(["plugins", "config"]));
	expect(query(["--snapshot", ""])).toContain(`${A}@plugin-only`); expect(query(["--snapshot", ""])).not.toContain(`${A}@config-only`);
	for (const words of [["--config-snapshot", ""], ["manager", "snapshot", "config", "new", "--target", ""], ["manager", "snapshot", "config", "remove", ""]]) {
		expect(query(words)).toContain(`${A}@config-only`); expect(query(words)).not.toContain(`${A}@plugin-only`);
	}
	expect(tree(i.data)).toEqual(before); expect(["snapshots", "config-snapshots"].map(s => readFileSync(join(i.data, s, ".counters.json"), "utf8"))).toEqual(counters); expect(started(i)).toBe(false);
});

test.skipIf(!hasZig || !WIN)("CS-PERMISSIONS: native Windows DACL grants config/staging access only to current user", () => {
	// Native-only observer. A Linux cross-build cannot run or satisfy this gate.
	const i = install(); expect(typed(i, "config", ["new", "--use", A, "--empty"]).status).toBe(0);
	writeFileSync(join(configDir(i, `${A}@1`), ".credentials.yaml"), "windows-private-test-secret");
	expect(typed(i, "config", ["new", "--use", A], { DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_CRASH: "snapshot-copied" }).status).toBe(86);
	const powershell = Bun.which("pwsh") ?? join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe");
	const script = `$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $root=$env:ACL_ROOT; $paths=@((Get-Item -LiteralPath $root))+@(Get-ChildItem -LiteralPath $root -Recurse -Force); foreach($item in $paths) { $acl=Get-Acl -LiteralPath $item.FullName; if($item.FullName -eq $root -and -not $acl.AreAccessRulesProtected){ throw 'root DACL not protected' }; $allow=@($acl.Access | Where-Object { $_.AccessControlType -eq 'Allow' }); if($allow.Count -eq 0){ throw 'no user allow entry' }; foreach($ace in $allow) { $who=$ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; if($who -ne $sid){ throw 'unexpected allowed principal' } } }; Write-Output 'private-current-user-DACL'`;
	const r = execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { cwd: i.home, env: { ...baseEnv(i), ACL_ROOT: join(i.data, "config-snapshots") }, encoding: "utf8", timeout: 30000 });
	expect(r.trim()).toBe("private-current-user-DACL");
});
