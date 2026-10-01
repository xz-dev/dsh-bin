// Real Fish and PowerShell seams: manager mutation, shell loading and actual Tab completion.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join, normalize } from "node:path";
import { spawnSync } from "node:child_process";
import { addRuntime, baseEnv, cleanup, hasZig, newInstall, run, tree, WIN, type Install } from "./harness.ts";

afterEach(cleanup);
const words = (output: string) => output.trim().split(/\r?\n/).filter(Boolean).map((line) => line.split("\t")[0]);
const fish = WIN ? null : Bun.which("fish");
const fishReason = WIN ? "Fish POSIX harness not supported on Windows" : !fish ? "fish executable not installed" : !hasZig ? "zig executable not installed" : "";
const fishEnv = (i: Install) => ({ ...baseEnv(i), PATH: `${i.dir}${delimiter}${process.env.PATH}`, XDG_CONFIG_HOME: join(i.home, "config"), XDG_DATA_HOME: join(i.home, "data"), XDG_CACHE_HOME: join(i.home, "cache") });
const fishFile = (i: Install) => join(i.home, "config/fish/completions/dsh.fish");
const fishRun = (i: Install, command: string, args: string[] = []) => spawnSync(fish!, ["--no-config", "-c", `set -g fish_complete_path $XDG_CONFIG_HOME/fish/completions; ${command}`, ...args], { env: fishEnv(i), cwd: i.home, encoding: "utf8", timeout: 15_000 });

test.skipIf(!!fishReason)(`SC-SHELLS / SC-IDEMPOTENT / SC-CURRENT: real fish loads, queries and removes owned completion${fishReason ? ` — SKIP: ${fishReason}` : ""}`, () => {
	const i = newInstall();
	const path = fishFile(i);
	const config = join(i.home, "config/fish/config.fish");
	mkdirSync(join(config, ".."), { recursive: true });
	const original = Buffer.from("# user fish config\nset -gx KEEP yes");
	writeFileSync(config, original); chmodSync(config, 0o640);
	const script = run(i, ["manager", "completion", "script", "fish"], { env: fishEnv(i) });
	expect(script.status).toBe(0);
	expect(existsSync(path)).toBe(false);
	const generated = join(i.home, "generated.fish");
	writeFileSync(generated, script.stdout);
	const loaded = fishRun(i, "source $argv[1]; complete -C 'dsh manager in'; complete -C 'dsh manager install --channel r'", [generated]);
	if (loaded.status !== 0) console.error(loaded.stderr);
	expect(loaded.status).toBe(0);
	expect(words(loaded.stdout)).toEqual(expect.arrayContaining(["install", "info", "release"]));
	const install = run(i, ["manager", "completion", "install", "fish"], { env: fishEnv(i) });
	expect(install.status).toBe(0);
	expect(install.stdout).toContain(path);
	expect(install.stdout).toContain("source");
	expect(install.stdout).toContain("current session");
	const installed = readFileSync(path);
	expect(run(i, ["manager", "completion", "install", "--shell", "fish"], { env: fishEnv(i) }).status).toBe(0);
	expect(readFileSync(path).equals(installed)).toBe(true);
	const active = fishRun(i, "complete -C 'dsh manager in'; source $argv[1]; source $argv[1]; complete -C 'dsh manager in'", [path]);
	expect(active.status).toBe(0);
	expect(words(active.stdout).filter((word) => word === "install")).toHaveLength(2);
	expect(active.stderr).toBe("");
	addRuntime(i.data, "1.0.0");
	mkdirSync(join(i.data, "snapshots/1.0.0@1"), { recursive: true });
	const local = fishRun(i, "complete -C 'dsh --use 1'; complete -C 'dsh manager select --snapshot 1'");
	expect(words(local.stdout)).toEqual(expect.arrayContaining(["1.0.0", "1.0.0@1"]));
	const uninstall = run(i, ["manager", "completion", "uninstall", "fish"], { env: fishEnv(i) });
	expect(uninstall.status).toBe(0);
	expect(uninstall.stdout).toContain("current session");
	expect(existsSync(path)).toBe(false);
	expect(readFileSync(config).equals(original)).toBe(true);
	expect(statSync(config).mode & 0o777).toBe(0o640);
	const removed = fishRun(i, "complete -C 'dsh manager in'");
	expect(words(removed.stdout)).not.toContain("install");
	expect(run(i, ["manager", "completion", "uninstall", "fish"], { env: fishEnv(i) }).status).toBe(0);
	expect(tree(i.out)).toEqual([]);
}, 120_000);

test.skipIf(!!fishReason)(`SC-COLLISION: real fish preserves foreign file and already loaded completion${fishReason ? ` — SKIP: ${fishReason}` : ""}`, () => {
	const i = newInstall(); const path = fishFile(i);
	mkdirSync(join(path, ".."), { recursive: true });
	const original = "complete -c dsh -f -a foreign\n";
	writeFileSync(path, original);
	const active = fishRun(i, "complete -C 'dsh '");
	expect(words(active.stdout)).toContain("foreign");
	for (const verb of ["install", "uninstall"]) {
		const collision = run(i, ["manager", "completion", verb, "fish"], { env: fishEnv(i) });
		expect(collision.status).toBe(1);
		expect(collision.stderr).toMatch(/collision/i);
		expect(readFileSync(path, "utf8")).toBe(original);
	}
	const script = run(i, ["manager", "completion", "script", "fish"]);
	const generated = join(i.home, "generated.fish"); writeFileSync(generated, script.stdout);
	const loaded = fishRun(i, "complete -c dsh -f -a foreign; source $argv[1]; complete -C 'dsh '", [generated]);
	expect(loaded.status).toBe(0);
	expect(words(loaded.stdout)).toContain("foreign");
	expect(words(loaded.stdout)).not.toContain("manager");
	expect(loaded.stderr).toMatch(/collision/i);
	expect(existsSync(i.data)).toBe(false);
}, 120_000);

test.skipIf(!!fishReason)(`SC-IDEMPOTENT: fish refuses modified owned file; dry-run never writes${fishReason ? ` — SKIP: ${fishReason}` : ""}`, () => {
	const i = newInstall(); const path = fishFile(i); const env = fishEnv(i);
	const before = tree(i.home);
	const dry = run(i, ["manager", "completion", "install", "fish", "--dry-run"], { env });
	expect(dry.status).toBe(0); expect(dry.stdout).toContain(path); expect(dry.stdout).toContain("create");
	expect(tree(i.home)).toEqual(before); expect(existsSync(i.data)).toBe(false);
	expect(run(i, ["manager", "completion", "install", "fish"], { env }).status).toBe(0);
	const owned = readFileSync(path, "utf8");
	for (const modified of [owned.replace("function _dsh_manager_complete", "function _user_modified_complete"), owned.replace("# >>> dsh-manager completion v1", "# >>> dsh-manager completion changed"), owned + "# user addition\n"]) {
		writeFileSync(path, modified);
		for (const verb of ["install", "uninstall"]) {
			const result = run(i, ["manager", "completion", verb, "fish"], { env });
			expect(result.status).toBe(1); expect(result.stderr).toMatch(/modified|collision/i);
			expect(readFileSync(path, "utf8")).toBe(modified);
		}
	}
	writeFileSync(path, owned);
	const registered = tree(i.home);
	expect(run(i, ["manager", "completion", "uninstall", "fish", "--dry-run"], { env }).stdout).toContain("would-remove");
	expect(tree(i.home)).toEqual(registered); expect(readFileSync(path, "utf8")).toBe(owned);
	expect(run(i, ["manager", "completion", "uninstall", "fish"], { env }).status).toBe(0);
	expect(tree(i.home)).toEqual(before);
}, 120_000);

const psQuote = (text: string) => `'${text.replaceAll("'", "''")}'`;
for (const shell of ["powershell", "pwsh"] as const) {
	const binary = shell === "powershell" && !WIN ? null : Bun.which(WIN ? `${shell}.exe` : shell);
	const reason = shell === "powershell" && !WIN ? "Windows PowerShell 5.1 requires Windows" : !binary ? `${shell} executable not installed` : !hasZig ? "zig executable not installed" : "";
	const env = (i: Install) => ({ ...baseEnv(i), PATH: `${i.dir}${delimiter}${process.env.PATH}`, XDG_CONFIG_HOME: join(i.home, "config"), XDG_DATA_HOME: join(i.home, "data"), XDG_CACHE_HOME: join(i.home, "cache") });
	// The shell host gets the real process environment (CI run 36812811596: a stripped Windows env makes
	// in-shell native calls return nothing and cold 5.1 module setup exceed 20 s). Profiles stay isolated
	// via -NoProfile/--profile; dsh state stays isolated via HOME/USERPROFILE/XDG overrides.
	const hostEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^DSH_/i.test(k))) as Record<string, string>;
	const psEnv = (i: Install) => ({ ...hostEnv, ...env(i) });
	const psRun = (i: Install, code: string) => spawnSync(binary!, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(`$ErrorActionPreference='Stop'; ${code}`, "utf16le").toString("base64")], { env: psEnv(i), cwd: i.home, encoding: "utf8", timeout: 90_000 });
	const tabs = (line: string) => `$line=${psQuote(line)}; (TabExpansion2 $line $line.Length).CompletionMatches | ForEach-Object { $_.CompletionText }`;
	const profile = (i: Install) => join(i.home, "isolated-profile/profile.ps1");
	const args = (i: Install, verb: string) => ["manager", "completion", verb, shell, "--profile", profile(i)];

	test.skipIf(!!reason)(`SC-SHELLS / SC-IDEMPOTENT / SC-CURRENT: real ${shell} native TabExpansion2, repeat load and byte-exact restore${reason ? ` — SKIP: ${reason}` : ""}`, () => {
		const i = newInstall(); const path = profile(i);
		mkdirSync(join(path, ".."), { recursive: true });
		// UTF-8 BOM and CRLF must survive, including Windows PowerShell's default script encoding.
		const original = Buffer.from("\ufeff# user's settings\r\n$env:COMPLETION_PRESERVED='yes'", "utf8");
		writeFileSync(path, original); if (!WIN) chmodSync(path, 0o640);
		const script = run(i, ["manager", "completion", "script", shell]);
		expect(script.status).toBe(0); expect(readFileSync(path).equals(original)).toBe(true); expect(existsSync(i.data)).toBe(false);
		const generated = join(i.home, "generated.ps1"); writeFileSync(generated, script.stdout);
		const loaded = psRun(i, `. ${psQuote(generated)}; ${tabs("dsh manager in")}; ${tabs("dsh manager install --channel r")}`);
		if (loaded.status !== 0) console.error(loaded.stdout, loaded.stderr);
		expect(loaded.status).toBe(0);
		expect(words(loaded.stdout)).toEqual(expect.arrayContaining(["install", "info", "release"]));
		const install = run(i, args(i, "install"));
		expect(install.status).toBe(0); expect(install.stdout).toContain(path); expect(install.stdout).toContain("current session"); expect(install.stdout).toContain(". '");
		const installed = readFileSync(path);
		expect(installed.subarray(0, original.length).equals(original)).toBe(true);
		expect(run(i, args(i, "install")).status).toBe(0); expect(readFileSync(path).equals(installed)).toBe(true);
		const active = psRun(i, `. ${psQuote(path)}; . ${psQuote(path)}; ${tabs("dsh manager in")}; ${tabs("dsh.exe manager in")}`);
		expect(active.status).toBe(0); expect(words(active.stdout).filter((word) => word === "install")).toHaveLength(2); expect(active.stderr).toBe("");
		addRuntime(i.data, "1.0.0"); mkdirSync(join(i.data, "snapshots/1.0.0@1"), { recursive: true });
		const local = psRun(i, `. ${psQuote(path)}; ${tabs("dsh --use 1")}; ${tabs("dsh manager select --snapshot 1")}`);
		expect(local.status).toBe(0); expect(words(local.stdout)).toEqual(expect.arrayContaining(["1.0.0", "1.0.0@1"]));
		const uninstall = run(i, args(i, "uninstall"));
		expect(uninstall.status).toBe(0); expect(uninstall.stdout).toContain("new session");
		expect(readFileSync(path).equals(original)).toBe(true); if (!WIN) expect(statSync(path).mode & 0o777).toBe(0o640);
		expect(run(i, args(i, "uninstall")).status).toBe(0); expect(readFileSync(path).equals(original)).toBe(true);
		const removed = psRun(i, `. ${psQuote(path)}; ${tabs("dsh manager in")}`);
		expect(words(removed.stdout)).not.toContain("install"); expect(tree(i.out)).toEqual([]);
	}, 120_000);

	test.skipIf(!!reason)(`SC-SHELLS: ${shell} words-env transport keeps empty prefix, spaces, quotes and non-ASCII${reason ? ` — SKIP: ${reason}` : ""}`, () => {
		// Windows PowerShell 5.1 legacy native argv drops empty words and mangles quotes; words travel via env instead.
		const i = newInstall(); const generated = join(i.home, "generated.ps1");
		writeFileSync(generated, run(i, ["manager", "completion", "script", shell]).stdout);
		const lines = ["dsh manager ", "dsh manager install --channel ", "dsh --use 'a b' manager in", "dsh --use 'q\"x' manager in", "dsh --snapshot 'é ü' manager in"];
		const result = psRun(i, `. ${psQuote(generated)}; ${lines.map((line) => `${tabs(line)} | ForEach-Object { 'C' + $_ }; 'END'`).join("; ")}`);
		if (result.status !== 0) console.error(result.stdout, result.stderr);
		expect(result.status).toBe(0);
		const groups = result.stdout.split(/\r?\nEND\r?\n?/).map((group) => group.split(/\r?\n/).filter((l) => l.startsWith("C")).map((l) => l.slice(1)));
		expect(groups[0]).toEqual(expect.arrayContaining(["install", "completion", "info"]));
		expect(groups[1]).toEqual(expect.arrayContaining(["release", "live"]));
		for (const group of groups.slice(2, 5)) expect(group).toEqual(expect.arrayContaining(["install", "info"]));
		expect(existsSync(i.data)).toBe(false); expect(tree(i.out)).toEqual([]);
	}, 120_000);

	test.skipIf(!!reason)(`SC-COLLISION: real ${shell} keeps foreign completer including CommandName arrays${reason ? ` — SKIP: ${reason}` : ""}`, () => {
		const i = newInstall(); const path = profile(i); mkdirSync(join(path, ".."), { recursive: true });
		const originals = [
			"Register-ArgumentCompleter -Native -CommandName dsh -ScriptBlock { 'foreign' }\n",
			"Register-ArgumentCompleter -Native `\n -CommandName @('other', 'dsh.exe') `\n -ScriptBlock { 'foreign' }\n",
		];
		for (const original of originals) {
			writeFileSync(path, original);
			const active = psRun(i, `. ${psQuote(path)}; ${tabs(original.includes("dsh.exe") ? "dsh.exe f" : "dsh f")}`);
			expect(active.status).toBe(0); expect(words(active.stdout)).toContain("foreign");
			const install = run(i, args(i, "install"));
			expect(install.status).toBe(1); expect(install.stderr).toMatch(/collision/i); expect(readFileSync(path, "utf8")).toBe(original);
			const kept = psRun(i, `. ${psQuote(path)}; ${tabs(original.includes("dsh.exe") ? "dsh.exe f" : "dsh f")}`);
			expect(words(kept.stdout)).toContain("foreign");
		}
		expect(existsSync(i.data)).toBe(false);
	}, 120_000);

	test.skipIf(!!reason)(`SC-IDEMPOTENT: ${shell} protects modified block, removes created profile; dry-run no writes${reason ? ` — SKIP: ${reason}` : ""}`, () => {
		const i = newInstall(); const path = profile(i); const before = tree(i.home);
		const dry = run(i, [...args(i, "install"), "--dry-run"]);
		expect(dry.status).toBe(0); expect(dry.stdout).toContain(path); expect(dry.stdout).toContain("create");
		expect(tree(i.home)).toEqual(before); expect(existsSync(i.data)).toBe(false);
		expect(run(i, args(i, "install")).status).toBe(0);
		const owned = readFileSync(path, "utf8");
		for (const modified of [owned.replace("Register-ArgumentCompleter", "Register-UserCompleter"), owned.replace("# >>> dsh-manager completion v1", "# >>> dsh-manager completion changed")]) {
			writeFileSync(path, modified);
			for (const verb of ["install", "uninstall"]) {
				const result = run(i, args(i, verb));
				expect(result.status).toBe(1); expect(result.stderr).toMatch(/collision|modified/i); expect(readFileSync(path, "utf8")).toBe(modified);
			}
		}
		writeFileSync(path, owned);
		const registered = tree(i.home);
		expect(run(i, [...args(i, "uninstall"), "--dry-run"]).stdout).toContain("would-remove");
		expect(tree(i.home)).toEqual(registered); expect(readFileSync(path, "utf8")).toBe(owned);
		expect(run(i, args(i, "uninstall")).status).toBe(0); expect(tree(i.home)).toEqual(before);
	}, 120_000);

	test.skipIf(!!reason)(`SC-CURRENT: ${shell} resolves default CurrentUserAllHosts without modifying real profile${reason ? ` — SKIP: ${reason}` : ""}`, () => {
		const i = newInstall();
		const actual = psRun(i, "$PROFILE.CurrentUserAllHosts");
		expect(actual.status).toBe(0);
		const path = actual.stdout.trim();
		const before = existsSync(path) ? readFileSync(path) : null;
		const dry = run(i, ["manager", "completion", "install", shell, "--dry-run"], { env: env(i) });
		// A runner's pre-existing custom completion is a legitimate refusal, but target must be exact.
		const normalized = (s: string) => WIN ? normalize(s).toLowerCase() : normalize(s);
		expect(normalized(dry.stdout + dry.stderr)).toContain(normalized(path));
		expect(existsSync(path)).toBe(before !== null); if (before) expect(readFileSync(path).equals(before)).toBe(true);
		expect(existsSync(i.data)).toBe(false);
		const invalid = run(i, ["manager", "completion", "install", shell, "--profile", "relative.ps1"]);
		expect(invalid.status).toBe(1); expect(invalid.stderr).toMatch(/absolute/i);
		if (!WIN) {
			expect(path).toBe(join(i.home, "config/powershell/profile.ps1"));
			expect(dry.status).toBe(0);
			expect(run(i, ["manager", "completion", "install", shell], { env: env(i) }).status).toBe(0);
			const loaded = psRun(i, `. ${psQuote(path)}; ${tabs("dsh manager in")}`);
			expect(loaded.status).toBe(0); expect(words(loaded.stdout)).toContain("install");
			expect(run(i, ["manager", "completion", "uninstall", shell], { env: env(i) }).status).toBe(0); expect(existsSync(path)).toBe(false);
		}
	}, 120_000);
}
