// Completion scenarios exercise the real manager, offline local state and real shell registrations.
import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireClaim } from "./claim-probe.ts";
import { spawnSync } from "node:child_process";
import { addRuntime, baseEnv, cleanup, EXE, hasZig, newInstall, run, tree, WIN } from "./harness.ts";

afterEach(cleanup);

test.skipIf(!hasZig)("SC-COLD: Tab on an absent data root is read-only and makes no origin request", async () => {
	const i = newInstall();
	const requests: string[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
		requests.push(req.url);
		return new Response("completion must not request the origin", { status: 500 });
	} });
	try {
		const proc = Bun.spawn([i.exe, "manager", "__complete", "--shell", "bash", "--", "manager", "in"], {
			env: { ...baseEnv(i), DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_ORIGIN: server.url.href },
			stdout: "pipe", stderr: "pipe",
		});
		const timer = setTimeout(() => proc.kill(), 5000);
		try {
			const output = await new Response(proc.stdout).text();
			const errors = await new Response(proc.stderr).text();
			expect(await proc.exited).toBe(0);
			expect(output.trim().split("\n")).toEqual(["install", "info"]);
			expect(errors).toBe("");
		} finally { clearTimeout(timer); if (proc.exitCode === null) { proc.kill(); await proc.exited; } }
		expect(requests).toEqual([]);
		expect(existsSync(i.data)).toBe(false);
		expect(tree(i.home)).toEqual([]);
		expect(tree(i.out)).toEqual([]);
	} finally { server.stop(true); }
}, 120_000);

const description = (option: string) => ({ schemaVersion: 1, commands: [
	{ name: "", options: [{ names: [option], takesValue: false }, { names: ["--profile"], takesValue: true }] },
	{ name: "plugin", options: [{ names: ["--profile"], takesValue: true }] },
] });
const candidates = (i: ReturnType<typeof newInstall>, words: string[]) => {
	const result = run(i, ["manager", "__complete", "--shell", "bash", "--", ...words], { env: { FAKE_EXIT: "91" } });
	expect(result.status).toBe(0);
	expect(result.stderr).toBe("");
	return result.stdout.trim() ? result.stdout.trim().split("\n") : [];
};

test.skipIf(!hasZig)("SC-QUOTING: typed local aliases preserve literal punctuation and Unicode", () => {
	const i = newInstall(), alias = "space $(touch CANARY) ` ; & café '";
	for (const [folder, flag] of [["snapshots", "--snapshot"], ["config-snapshots", "--config-snapshot"]]) {
		const dir = join(i.data, folder, "1.0.0@1"); mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "snapshot.json"), JSON.stringify({ id: "1.0.0@1", version: "1.0.0", n: 1, alias }));
		writeFileSync(join(dir, ".usage.lock"), "");
		expect(candidates(i, [flag, "1.0.0@space"])).toEqual([`1.0.0@${alias}`]);
	}
	expect(existsSync(join(i.home, "CANARY"))).toBe(false);
	expect(tree(i.out)).toEqual([]);
}, 120_000);

test.skipIf(!hasZig || WIN)("SC-LOCAL: linked snapshot metadata never reads or emits external credential-like content", () => {
	const i = newInstall(), secret = "never-read-external-metadata";
	const outside = join(i.home, "credential-like.json");
	writeFileSync(outside, JSON.stringify({ id: "1.0.0@1", version: "1.0.0", n: 1, alias: secret }));
	for (const [folder, flag] of [["snapshots", "--snapshot"], ["config-snapshots", "--config-snapshot"]]) {
		const dir = join(i.data, folder, "1.0.0@1"); mkdirSync(dir, { recursive: true });
		symlinkSync(outside, join(dir, "snapshot.json"));
		writeFileSync(join(dir, ".usage.lock"), "");
		expect(candidates(i, [flag, "1.0.0@"])).toEqual([]);
	}
	expect(readFileSync(outside, "utf8")).toContain(secret);
}, 120_000);

test.skipIf(!hasZig)("SC-VERSIONS: --use, default selection and channel choose runtime CLI data, never the app", () => {
	const i = newInstall();
	addRuntime(i.data, "1.0.0", { completion: description("--old-cli") });
	addRuntime(i.data, "2.0.0", { run: 2, completion: description("--new-cli") });
	addRuntime(i.data, "3.0.0", { channel: "live", completion: description("--live-cli") });
	mkdirSync(join(i.data, "state"));
	const selection = join(i.data, "state/selection.json");
	writeFileSync(selection, JSON.stringify({ schema: 1, use: "1.0.0", snapshot: null, addons: {} }));
	expect(candidates(i, ["--"])).toContain("--old-cli");
	expect(candidates(i, ["--"])).not.toContain("--new-cli");
	expect(candidates(i, ["--use", "2.0.0", "--"])).toContain("--new-cli");
	expect(candidates(i, ["--use", "runtime-v1.0.0", "plugin", "--p"])).toEqual(["--profile"]);
	expect(candidates(i, ["--profile", "plugin", "--"])).toContain("--old-cli");
	expect(candidates(i, ["--snapshot", "1.0.0@1", "--"])).toContain("--old-cli");
	expect(candidates(i, ["--use", "missing", "--"])).not.toContain("--old-cli");
	writeFileSync(selection, JSON.stringify({ schema: 1, use: "latest", addons: {} }));
	expect(candidates(i, ["--"])).toContain("--new-cli");
	writeFileSync(join(i.data, "state/channel"), "live\n");
	expect(candidates(i, ["--"])).toContain("--live-cli");
	writeFileSync(join(i.data, "bundles/3.0.0/completion.json"), JSON.stringify({ ...description("--unsupported"), schemaVersion: 99 }));
	expect(candidates(i, ["--"])).not.toContain("--unsupported");
	expect(candidates(i, ["manager", "in"])).toEqual(["install", "info"]);
	expect(tree(i.out)).toEqual([]); // fake entry would write markers and exit 91 if invoked
});

test.skipIf(!hasZig)("SC-LOCAL: local versions/tags, snapshots and addons stay fresh; locks and secrets are untouched", () => {
	const i = newInstall();
	addRuntime(i.data, "1.0.0", { completion: description("--local-cli") });
	mkdirSync(join(i.data, "snapshots/1.0.0@1"), { recursive: true });
	writeFileSync(join(i.data, "snapshots/1.0.0@1/snapshot.json"), JSON.stringify({ id: "1.0.0@1", version: "1.0.0", n: 1, alias: null }));
	mkdirSync(join(i.data, "addons/office/0.2.0"), { recursive: true });
	mkdirSync(join(i.data, "state"));
	writeFileSync(join(i.data, "state/manager.lock"), "");
	mkdirSync(join(i.data, "home/profiles/probe"), { recursive: true });
	writeFileSync(join(i.data, "home/profiles/probe/cordis.patch.yml"), "token: never-print-this-secret\n");
	const guard = join(i.data, "bundles/1.0.0/.usage.lock");
	const locks = [join(i.data, "state/manager.lock"), guard].map((p) => acquireClaim(p, "exclusive"));
	const before = tree(i.data);
	const entry = readFileSync(join(i.data, `bundles/1.0.0/dsh-native${EXE}`));
	try {
		for (const lock of locks) expect(lock).not.toBe("busy");
		expect(candidates(i, ["--use", ""])).toEqual(expect.arrayContaining(["latest", "1.0.0", "runtime-v1.0.0"]));
		expect(candidates(i, ["manager", "install", "1"])).toEqual(["1.0.0"]);
		expect(candidates(i, ["manager", "install", "--channel", ""])).toEqual(["release", "live"]);
		expect(candidates(i, ["manager", "select", "--s"])).toEqual(["--snapshot"]);
		expect(candidates(i, ["manager", "snapshot", ""])).toContain("plugins");
		expect(candidates(i, ["manager", "snapshot", "plugins", ""])).toContain("new");
		expect(candidates(i, ["manager", "select", "--snapshot", ""])).toEqual(["1.0.0@1"]);
		expect(candidates(i, ["--addon", ""])).toEqual(["office:0.2.0"]);
		expect(candidates(i, ["manager", "uninstall", "--addon", "office:"])).toEqual(["office:0.2.0"]);
		expect(candidates(i, ["--"])).toContain("--local-cli");
		expect(candidates(i, [""]).join("\n")).not.toContain("never-print-this-secret");
		expect(tree(i.data)).toEqual(before);
		expect(readFileSync(join(i.data, `bundles/1.0.0/dsh-native${EXE}`)).equals(entry)).toBe(true);
		expect(tree(i.out)).toEqual([]);
		mkdirSync(join(i.data, "snapshots/1.0.0@2"));
		writeFileSync(join(i.data, "snapshots/1.0.0@2/snapshot.json"), JSON.stringify({ id: "1.0.0@2", version: "1.0.0", n: 2, alias: null }));
		expect(candidates(i, ["--snapshot", ""])).toEqual(["1.0.0@1", "1.0.0@2"]);
		rmSync(join(i.data, "snapshots/1.0.0@1"), { recursive: true });
		expect(candidates(i, ["--snapshot", ""])).toEqual(["1.0.0@2"]);
	} finally { for (const lock of locks) if (lock !== "busy") lock.release(); }
});

for (const shell of ["bash", "zsh"] as const) {
	const binary = WIN ? null : Bun.which(shell);
	const reason = WIN ? "Windows shell harness not supported" : !binary ? `${shell} executable not installed` : !hasZig ? "zig executable not installed" : "";
	const shellRun = (i: ReturnType<typeof newInstall>, script: string, args: string[] = []) => spawnSync(binary!, ["-c", script, "completion-test", ...args], {
		env: { ...baseEnv(i), PATH: `${i.dir}:${process.env.PATH}`, ZDOTDIR: i.home }, encoding: "utf8", timeout: 15_000,
	});
	const rcName = shell === "bash" ? ".bashrc" : ".zshrc";
	// Stock Zsh also completes an unrelated Distributed Shell named dsh. Clean-fixture
	// cases explicitly remove only that mapping; collision cases keep foreign registrations.
	const cleanZsh = "autoload -Uz compinit; compinit -D -i; unset '_comps[dsh]'\n";
	const harness = shell === "bash" ? `source "$1"
complete -p dsh
COMP_WORDS=(dsh manager in); COMP_CWORD=2
_dsh_manager_complete
printf '%s\\n' "\${COMPREPLY[@]}"
COMP_WORDS=(dsh manager install --channel r); COMP_CWORD=4
_dsh_manager_complete
printf '%s\\n' "\${COMPREPLY[@]}"` : `${cleanZsh}source "$1"
print -r -- "\${_comps[dsh]}"
compadd() { shift; print -rl -- "$@"; }
words=(dsh manager in); CURRENT=3
_dsh_manager_complete
words=(dsh manager install --channel r); CURRENT=5
_dsh_manager_complete`;

	test.skipIf(!!reason)(`SC-SHELLS / SC-IDEMPOTENT / SC-CURRENT: real ${shell} loads script, completes and restores user rc${reason ? ` — SKIP: ${reason}` : ""}`, () => {
		const i = newInstall();
		const rc = join(i.home, rcName);
		const original = "# user's existing settings\nexport COMPLETION_PRESERVED='yes'"; // no final newline
		writeFileSync(rc, original);
		const script = run(i, ["manager", "completion", "script", shell]);
		expect(script.status).toBe(0);
		expect(readFileSync(rc, "utf8")).toBe(original);
		expect(existsSync(i.data)).toBe(false);
		const generated = join(i.home, "generated-completion");
		writeFileSync(generated, script.stdout);
		const loaded = shellRun(i, harness, [generated]);
		if (loaded.status !== 0) console.error(loaded.stdout, loaded.stderr);
		expect(loaded.status).toBe(0);
		expect(loaded.stdout).toContain("_dsh_manager_complete");
		for (const word of ["install", "info", "release"]) expect(loaded.stdout.split("\n")).toContain(word);
		const cleanFunctions = join(i.home, "clean-zsh-functions");
		if (shell === "zsh") {
			const location = shellRun(i, 'for p in $fpath; do if [[ -f "$p/compinit" ]]; then print -r -- "$p"; break; fi; done');
			expect(location.status).toBe(0);
			mkdirSync(cleanFunctions);
			for (const functionName of ["compinit", "compaudit", "compdump", "compinstall"]) cpSync(join(location.stdout.trim(), functionName), join(cleanFunctions, functionName));
		}
		const initialized = shellRun(i, shell === "bash" ? 'source "$1"; complete -p dsh' : 'fpath=("$2"); source "$1"; print -r -- "${_comps[dsh]}"', [generated, cleanFunctions]);
		expect(initialized.status).toBe(0);
		expect(initialized.stdout).toContain("_dsh_manager_complete");
		const install = run(i, ["manager", "completion", "install", "--shell", shell], { env: { ZDOTDIR: i.home } });
		expect(install.status).toBe(0);
		expect(install.stdout).toContain(rc);
		expect(install.stdout).toContain("source");
		expect(install.stdout).toContain("current session");
		const installed = readFileSync(rc, "utf8");
		expect(installed.startsWith(original)).toBe(true);
		expect(run(i, ["manager", "completion", "install", shell], { env: { ZDOTDIR: i.home } }).status).toBe(0);
		expect(readFileSync(rc, "utf8")).toBe(installed);
		const active = shellRun(i, harness, [rc]);
		expect(active.status).toBe(0);
		expect(active.stdout.split("\n")).toContain("install");
		expect(existsSync(i.data)).toBe(false);
		const uninstall = run(i, ["manager", "completion", "uninstall", shell], { env: { ZDOTDIR: i.home } });
		expect(uninstall.status).toBe(0);
		expect(uninstall.stdout).toContain("current session");
		expect(readFileSync(rc, "utf8")).toBe(original);
		expect(run(i, ["manager", "completion", "uninstall", shell], { env: { ZDOTDIR: i.home } }).status).toBe(0);
		expect(readFileSync(rc, "utf8")).toBe(original);
	}, 120_000);

	test.skipIf(!!reason)(`SC-COLLISION: real ${shell} preserves foreign dsh completion and reports install collision${reason ? ` — SKIP: ${reason}` : ""}`, () => {
		const i = newInstall();
		const rc = join(i.home, rcName);
		const original = shell === "bash" ? "user_dsh() { COMPREPLY=(foreign); }\ncomplete -F user_dsh dsh\n" : "autoload -Uz compinit; compinit -D -i\nuser_dsh() { compadd foreign; }\ncompdef user_dsh dsh\n";
		writeFileSync(rc, original);
		const install = run(i, ["manager", "completion", "install", shell], { env: { ZDOTDIR: i.home } });
		expect(install.status).toBe(1);
		expect(install.stderr).toMatch(/collision/i);
		expect(readFileSync(rc, "utf8")).toBe(original);
		const script = run(i, ["manager", "completion", "script", shell]);
		expect(script.status).toBe(0);
		const generated = join(i.home, "generated-completion");
		writeFileSync(generated, script.stdout);
		const active = shellRun(i, shell === "bash" ? 'source "$1"; source "$2"; complete -p dsh' : 'source "$1"; source "$2"; print -r -- "${_comps[dsh]}"', [rc, generated]);
		expect(active.status).toBe(0);
		expect(active.stdout).toContain("user_dsh");
		expect(active.stderr).toMatch(/collision/i);
		const sameName = original.replaceAll("user_dsh", "_dsh_manager_complete");
		writeFileSync(rc, sameName);
		const same = shellRun(i, shell === "bash" ? 'source "$1"; source "$2"; _dsh_manager_complete; printf "%s\\n" "${COMPREPLY[@]}"' : 'source "$1"; source "$2"; compadd() { print -rl -- "$@"; }; _dsh_manager_complete', [rc, generated]);
		expect(same.status).toBe(0);
		expect(same.stdout).toContain("foreign");
		expect(same.stderr).toMatch(/collision/i);
		expect(existsSync(i.data)).toBe(false);
	}, 120_000);

	test.skipIf(!!reason)(`SC-IDEMPOTENT: ${shell} keeps user-modified owned registration on uninstall${reason ? ` — SKIP: ${reason}` : ""}`, () => {
		const i = newInstall();
		const rc = join(i.home, rcName);
		writeFileSync(rc, "# keep me\n");
		expect(run(i, ["manager", "completion", "install", shell], { env: { ZDOTDIR: i.home } }).status).toBe(0);
		const owned = readFileSync(rc, "utf8");
		for (const modified of [owned.replace("_dsh_manager_complete()", "_user_modified_complete()"), owned.replace("# >>> dsh-manager completion v2", "# >>> dsh-manager completion changed")]) {
			writeFileSync(rc, modified);
			const uninstall = run(i, ["manager", "completion", "uninstall", shell], { env: { ZDOTDIR: i.home } });
			expect(uninstall.status).toBe(1);
			expect(uninstall.stderr).toMatch(/modified|collision/i);
			expect(readFileSync(rc, "utf8")).toBe(modified);
		}
	}, 120_000);
	test.skipIf(!!reason)(`SC-IDEMPOTENT / SC-COLLISION: ${shell} removes created rc, preserves completion files and initializes once${reason ? ` — SKIP: ${reason}` : ""}`, () => {
		const i = newInstall();
		const rc = join(i.home, rcName);
		const options = { env: { ZDOTDIR: i.home } };
		expect(run(i, ["manager", "completion", "install", shell], options).status).toBe(0);
		const loaded = shellRun(i, shell === "bash" ? 'source "$1"; source "$1"; complete -p dsh' : `${cleanZsh}source "$1"; compinit() { print -ru2 -- "compinit must not run twice"; return 1; }; source "$1"; print -r -- "\${_comps[dsh]}"`, [rc]);
		expect(loaded.status).toBe(0);
		expect(loaded.stdout).toContain("_dsh_manager_complete");
		expect(loaded.stderr).toBe("");
		expect(run(i, ["manager", "completion", "uninstall", shell], options).status).toBe(0);
		expect(existsSync(rc)).toBe(false);
		const foreign = shell === "bash" ? join(i.home, ".local/share/bash-completion/completions/dsh") : join(i.home, ".zfunc/_dsh");
		const original = shell === "bash" ? "complete -W foreign dsh\n" : "#compdef dsh\ncompadd foreign\n";
		mkdirSync(join(foreign, ".."), { recursive: true });
		writeFileSync(foreign, original);
		const install = run(i, ["manager", "completion", "install", shell], options);
		expect(install.status).toBe(1);
		expect(install.stderr).toMatch(/collision/i);
		expect(readFileSync(foreign, "utf8")).toBe(original);
		expect(existsSync(rc)).toBe(false);
	}, 120_000);
}
