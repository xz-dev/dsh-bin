// Task 4.5: real-shell completion binding survives moving binary + portable data.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { addRuntime, baseEnv, cleanup, EXE, hasZig, newInstall, run, WIN, type Install } from "./harness.ts";
afterEach(cleanup);
const psq = (s: string) => `'${s.replaceAll("'", "''")}'`;
const shq = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const fq = (s: string) => `'${s.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
const host = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^DSH_/i.test(k)));
function env(i: Install, path: string) { return { ...host, ...baseEnv(i), PATH: path, XDG_CONFIG_HOME: join(i.home, "config"), ZDOTDIR: i.home }; }
function move(i: Install, name: string): Install {
 const dir = join(i.dir, "..", name); renameSync(i.dir, dir);
 return { ...i, dir, exe: join(dir, `dsh${EXE}`), data: join(dir, "dsh-bin") };
}
function snapshot(i: Install, name: string) { mkdirSync(join(i.data, "snapshots", name), { recursive: true }); }
for (const shell of ["bash", "zsh", "fish", "pwsh", "powershell"] as const) {
 const ps = shell === "pwsh" || shell === "powershell";
 const binary = ((!ps && WIN) || (shell === "powershell" && !WIN)) ? null : Bun.which(WIN ? shell + ".exe" : shell);
 const reason = !binary ? `${shell} unavailable on this host` : !hasZig ? "zig unavailable" : "";
 function invoke(i: Install, path: string, code: string) {
  const result = spawnSync(binary!, ps ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from("$ErrorActionPreference='Stop'; " + code, "utf16le").toString("base64")] : [...(shell === "zsh" ? ["-f"] : []), "-c", code], { env: env(i, path), cwd: i.home, encoding: "utf8", timeout: 90_000 });
  if (result.status !== 0) console.error("SHELL", shell, result.stderr, result.error);
  return result;
 }
 function load(file: string) {
  return ps ? `. ${psq(file)}; ` : shell === "fish" ? `source ${fq(file)}; ` : (shell === "zsh" ? "autoload -Uz compinit; compinit -D -i; unset '_comps[dsh]'; " : "") + `source ${shq(file)}; `;
 }
 function query(words: string[], exe?: string) {
  const lineWords = (quote: (s: string) => string) => words.map((word, index) => index === words.length - 1 && /^[A-Za-z0-9_.@-]*$/.test(word) ? word : quote(word)).join(" ");
  if (ps) { const line = (exe ? "& " + psq(exe) : "dsh") + " " + lineWords(psq); return `$l=${psq(line)}; (TabExpansion2 $l $l.Length).CompletionMatches | ForEach-Object { $_.ListItemText }`; }
  if (shell === "fish") { const line = "dsh " + lineWords(fq); return `complete -C ${fq(line)}`; }
  const list = ["dsh", ...words].map(shq).join(" ");
  return shell === "bash" ? `COMP_WORDS=(${list}); COMP_CWORD=${words.length}; _dsh_manager_complete; printf '%s\\n' "\${COMPREPLY[@]}"` : `compadd() { shift; print -rl -- "$@"; }; words=(${list}); CURRENT=${words.length + 1}; _dsh_manager_complete`;
 }
 test.skipIf(!!reason)(`SC-RELOCATE / SC-VERSIONS: ${shell} PATH binding follows moved install; absolute registration refreshes${reason ? ` — SKIP: ${reason}` : ""}`, () => {
  let i = newInstall(); snapshot(i, "1.0.0@old");
  const path = `${i.dir}${delimiter}${process.env.PATH}`;
  const profile = join(i.home, "profile.ps1");
  const args = ["manager", "completion", "install", shell, ...(ps ? ["--profile", profile] : [])];
  const registered = run(i, args, { env: env(i, path) }); expect(registered.status).toBe(0);
  const file = ps ? profile : shell === "fish" ? join(i.home, "config/fish/completions/dsh.fish") : join(i.home, shell === "bash" ? ".bashrc" : ".zshrc");
  i = move(i, WIN ? "moved space ' é" : "moved space ' \" é");
  snapshot(i, "1.0.0@new");
  const movedPath = `${i.dir}${delimiter}${process.env.PATH}`;
  const result = invoke(i, movedPath, load(file) + query(["--snapshot", "1.0.0@"]));
  expect(result.status).toBe(0); expect(result.stdout).toContain("1.0.0@new");
  expect(existsSync(path.split(delimiter)[0])).toBe(false);
  expect(run(i, ["manager", "completion", "uninstall", shell, ...(ps ? ["--profile", profile] : [])], { env: env(i, movedPath) }).status).toBe(0);
  // No manager on PATH => fixed absolute binding, then re-register from moved location.
  const direct = run(i, args, { env: env(i, process.env.PATH!) }); expect(direct.status).toBe(0); expect(direct.stdout).toMatch(/re-register/i);
  i = move(i, "moved again é");
  const stale = invoke(i, process.env.PATH!, load(file) + query(["manager", "in"]));
  expect(stale.stdout).not.toContain("install");
  expect(run(i, args, { env: env(i, process.env.PATH!) }).status).toBe(0);
  const fresh = invoke(i, `${i.dir}${delimiter}${process.env.PATH}`, load(file) + query(["manager", "in"]));
  expect(fresh.stdout).toContain("install");
 }, 180_000);
 if (shell === "bash" || shell === "fish") test.skipIf(!!reason)(`SC-RELOCATE review: ${shell} cwd-dependent PATH cannot execute a shadow manager${reason ? ` — SKIP: ${reason}` : ""}`, () => {
  const i = newInstall();
  mkdirSync(join(i.dir, "bin")); symlinkSync(i.exe, join(i.dir, "bin/dsh"));
  for (const subdir of ["bin", "missing"]) mkdirSync(join(i.home, subdir));
  const canary = join(i.home, "CANARY");
  for (const file of [join(i.home, "dsh"), join(i.home, "bin/dsh"), join(i.home, "missing/dsh")]) {
   writeFileSync(file, `#!/bin/sh\nprintf bad > ${shq(canary)}\n`); chmodSync(file, 0o755);
  }
  const generated = join(i.home, "generated");
  for (const path of [`:${i.dir}`, "", `.:${i.dir}`, `bin:${i.dir}`, `missing:${i.dir}`]) {
   const script = run(i, ["manager", "completion", "script", shell], { env: env(i, path), cwd: i.dir });
   expect(script.status).toBe(0); writeFileSync(generated, script.stdout);
   const result = invoke(i, path, load(generated) + query(["manager", "in"]));
   expect(existsSync(canary)).toBe(false);
   expect(result.status).toBe(0); expect(result.stdout).toContain("install");
  }
 }, 180_000);
 test.skipIf(!!reason)(`SC-QUOTING: ${shell} special path and candidate insertion remain literal${reason ? ` — SKIP: ${reason}` : ""}`, async () => {
  let i = newInstall(); i = move(i, WIN ? "space ' é $(x) &" : "space ' \" é $(x) &");
  // Windows filenames cannot contain * or | (snapshots are directories); those stay covered on POSIX.
  const name = WIN ? "1.0.0@space $(New-Item CANARY) ` ; & [x] é '" : ps ? "1.0.0@space $(New-Item CANARY) ` ; * | & [x] é '" : "1.0.0@space $(touch CANARY) ` ; * | & [x] é '";
  snapshot(i, name);
  const generated = join(i.home, ps ? "generated.ps1" : "generated");
  const script = run(i, ["manager", "completion", "script", shell]); expect(script.status).toBe(0); writeFileSync(generated, (ps ? "\ufeff" : "") + script.stdout);
  const result = invoke(i, `${i.dir}${delimiter}${process.env.PATH}`, load(generated) + query(["--snapshot", "1.0.0@"], i.exe));
  expect(result.status).toBe(0); expect(result.stdout).toContain("CANARY"); expect(existsSync(join(i.home, "CANARY"))).toBe(false);
  let accept: string;
  if (ps) {
   const line = "& " + psq(i.exe) + " --snapshot 1.0.0@";
   accept = `$l=${psq(line)}; $c=(TabExpansion2 $l $l.Length).CompletionMatches | Where-Object ListItemText -eq ${psq(name)}; $tokens=$null; $errors=$null; $ast=[System.Management.Automation.Language.Parser]::ParseInput('dsh --snapshot '+$c.CompletionText,[ref]$tokens,[ref]$errors); $v=$ast.EndBlock.Statements[0].PipelineElements[0].CommandElements[2]; if ($v -isnot [System.Management.Automation.Language.StringConstantExpressionAst] -or $errors.Count) { throw 'candidate not literal' }; $v.Value`;
  } else if (shell === "fish") {
   // Actual interactive Tab insertion, not eval of helper output (Fish owns candidate escaping).
   const python = Bun.which("python3"); expect(python).not.toBeNull();
   const acceptedFile = join(i.home, "accepted");
   const p = spawn(python!, [join(import.meta.dir, "terminal-driver.py"), binary!, "--no-config", "--interactive"], {
    env: { ...env(i, `${i.dir}${delimiter}${process.env.PATH}`), TERM: "dumb" }, cwd: i.home, stdio: "pipe",
   });
   let output = ""; p.stdout.on("data", (bytes) => { output += bytes.toString(); });
   p.stderr.on("data", (bytes) => { output += bytes.toString(); });
   const done = new Promise<number | null>((resolve, reject) => { p.on("exit", resolve); p.on("error", reject); });
   const wait = async (ready: () => boolean) => {
    const end = Date.now() + 10_000;
    while (!ready() && p.exitCode === null && Date.now() < end) await Bun.sleep(20);
    if (!ready()) console.error("Fish terminal output:", JSON.stringify(output));
    expect(ready()).toBe(true);
   };
   try {
    p.stdin.write(`source ${fq(generated)}; function dsh; printf '%s' "$argv[2]" > ${fq(acceptedFile)}; end; printf 'FISH_READY\\n'\n`);
    await wait(() => output.includes("FISH_READY\r\n"));
    p.stdin.write("dsh --snapshot 1.0.0@\t\n");
    await wait(() => existsSync(acceptedFile));
    expect(readFileSync(acceptedFile, "utf8")).toBe(name);
    expect(existsSync(join(i.home, "CANARY"))).toBe(false);
   } finally {
    p.kill("SIGTERM"); await done;
   }
   accept = ""; // No helper-eval path: native insertion above proves exact accepted argument.
  } else if (shell === "bash") {
   accept = `COMP_WORDS=(dsh --snapshot 1.0.0@); COMP_CWORD=2; _dsh_manager_complete; eval "set -- \${COMPREPLY[0]}"; test "$#" = 1; printf '%s\\n' "$1"`;
  } else {
   accept = `compadd() { shift 2; eval "set -- $1"; print -r -- "$1"; }; words=(dsh --snapshot 1.0.0@); CURRENT=3; _dsh_manager_complete`;
  }
  if (shell !== "fish") {
   const accepted = invoke(i, `${i.dir}${delimiter}${process.env.PATH}`, load(generated) + accept);
   expect(accepted.status).toBe(0); expect(accepted.stdout.trim()).toBe(name); expect(existsSync(join(i.home, "CANARY"))).toBe(false);
  }
  const input = invoke(i, `${i.dir}${delimiter}${process.env.PATH}`, load(generated) + query(["--use", "$(touch CANARY) ` ; * | & [x] é", "manager", "in"], i.exe));
  expect(input.status).toBe(0); expect(input.stdout).toContain("install"); expect(existsSync(join(i.home, "CANARY"))).toBe(false);
 }, 180_000);
}

test.skipIf(!WIN || !hasZig)(`SC-RELOCATE review: Windows current-drive-rooted PATH stays absolute-bound${!WIN ? " — SKIP: Windows path semantics require Windows" : ""}`, () => {
 const i = newInstall();
 // Zig's isAbsolute accepts \foo, but its drive still depends on the process cwd.
 const result = run(i, ["manager", "completion", "install", "pwsh", "--profile", join(i.home, "profile.ps1"), "--dry-run"], { env: env(i, i.dir.slice(2)), cwd: i.dir });
 expect(result.status).toBe(0); expect(result.stdout).toContain("Bound to this absolute manager location");
});
