// Task 4.5: real-shell completion binding survives moving binary + portable data.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
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
 test.skipIf(!!reason)(`SC-QUOTING: ${shell} special path and candidate insertion remain literal${reason ? ` — SKIP: ${reason}` : ""}`, () => {
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
   // Evaluate only the shell-escaped insertion in this isolated harness; an unescaped payload creates CANARY.
   accept = `function commandline; switch $argv[1]; case -opc; printf '%s\\n' dsh --snapshot; case -ct; printf '%s\\n' 1.0.0@; end; end; set -l insertion (_dsh_manager_complete); eval "set -l decoded $insertion; printf '%s\\\\n' \\\"\\$decoded\\\""`;
  } else if (shell === "bash") {
   accept = `COMP_WORDS=(dsh --snapshot 1.0.0@); COMP_CWORD=2; _dsh_manager_complete; eval "set -- \${COMPREPLY[0]}"; test "$#" = 1; printf '%s\\n' "$1"`;
  } else {
   accept = `compadd() { shift 2; eval "set -- $1"; print -r -- "$1"; }; words=(dsh --snapshot 1.0.0@); CURRENT=3; _dsh_manager_complete`;
  }
  const accepted = invoke(i, `${i.dir}${delimiter}${process.env.PATH}`, load(generated) + accept);
  expect(accepted.status).toBe(0); expect(accepted.stdout.trim()).toBe(name); expect(existsSync(join(i.home, "CANARY"))).toBe(false);
  const input = invoke(i, `${i.dir}${delimiter}${process.env.PATH}`, load(generated) + query(["--use", "$(touch CANARY) ` ; * | & [x] é", "manager", "in"], i.exe));
  expect(input.status).toBe(0); expect(input.stdout).toContain("install"); expect(existsSync(join(i.home, "CANARY"))).toBe(false);
 }, 180_000);
}
