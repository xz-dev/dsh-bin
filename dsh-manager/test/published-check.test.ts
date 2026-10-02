// Published first-download seam: run the workflow itself, with fixture downloads and jq.exe EOLs.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeZip } from "../../dsh-bun-build/runtime/zip.ts";

const root = mkdtempSync(join(tmpdir(), "dsh-published-check-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const bashPath = (p: string) => process.platform === "win32" ? p.replaceAll("\\", "/").replace(/^([A-Za-z]):\//, (_, drive) => `/${drive.toLowerCase()}/`) : p;
const workflow = Bun.YAML.parse(readFileSync(resolve(import.meta.dir, "../../.github/workflows/published-check.yml"), "utf8")) as any;
const script = workflow.jobs["first-download"].steps[0].run;
const newest = "0.2.0-rc.2-b4.1.g243621d7";

function check(eol: "LF" | "CRLF", fault = "", olderJq = false, backslashTemp = false) {
	// Linux uses a literal backslash filename; Windows keeps native RUNNER_TEMP separators.
	const dir = mkdtempSync(join(root, backslashTemp && process.platform !== "win32" ? "case\\-" : "case-")), archive = join(dir, "manager-windows-x64.zip");
	mkdirSync(join(dir, "initial-home"));
	// Shell stand-in records calls only; this is not native Windows manager/runtime proof.
	writeZip(archive, [{ name: "dsh", mode: 0o755, data: Buffer.from(`#!/usr/bin/env bash
set -euo pipefail
[[ "$HOME" -ef "$RUNNER_TEMP/first-download/home" && "$USERPROFILE" -ef "$HOME" ]]
printf '%s\\n' "$*" >> "$FIXTURE/calls"
case "$*" in
  'manager --version') echo 'dsh manager 1.0.0' ;;
  'plugin --profile first --help') mkdir -p "$(dirname "$0")/dsh-bin/bundles/${newest}"; echo 'plugin help' ;;
  'manager list') test -d "$(dirname "$0")/dsh-bin/bundles/${newest}"; echo '${newest}' ;;
  '--use ${newest} --version') echo '0.2.0-rc.2' ;;
  *) echo 'unexpected manager invocation' >&2; exit 1 ;;
esac
`) }]);
	const bytes = readFileSync(archive), sha = createHash("sha256").update(bytes).digest("hex");
	writeFileSync(join(dir, "manager-index.json"), JSON.stringify({ schema: 1, versions: [{ tag: "manager-v1.0.0", assets: { "windows-x64": { name: "manager-windows-x64.zip", size: bytes.length + (fault === "size" ? 1 : 0), sha256: fault === "sha" ? "0".repeat(64) : sha } } }] }));
	writeFileSync(join(dir, "runtime-index.json"), JSON.stringify({ schema: 1, channels: { release: [{ id: newest }] } }));
	const prelude = `
curl() {
  local url='' out='' src
  while (($#)); do
    case "$1" in -o) out=$2; shift 2 ;; -*) shift ;; *) url=$1; shift ;; esac
  done
  case "$url" in
    */manager-index.json) src="$FIXTURE/manager-index.json" ;;
    */runtime-index.json) src="$FIXTURE/runtime-index.json" ;;
    */manager-v1.0.0/manager-windows-x64.zip) src="$FIXTURE/manager-windows-x64.zip" ;;
    *) echo 'unexpected download URL' >&2; return 1 ;;
  esac
  if [[ -n "$out" ]]; then command cp "$src" "$out"; else command cat "$src"; fi
}
jq() {
  local output arg binary=0
  for arg in "$@"; do
    if [[ "$arg" = --binary || "$arg" =~ ^-[^-]*b ]]; then
      [[ "$OLDER_JQ" = 0 ]] || { echo 'jq: Unknown option --binary' >&2; return 2; }
      binary=1
    fi
  done
  output=$(command jq "$@" | tr -d '\\r') || return $?
  # Even a producer that emitted metadata must not hide its nonzero exit behind read.
  if [[ "$FAULT" = jq ]]; then printf '%s\\n' "$output"; return 7; fi
  # Native jq.exe translates LF to CRLF unless --binary/-b was requested.
  if [[ "$EOL" = CRLF && "$binary" = 0 ]]; then printf '%s\\r\\n' "$output"; else printf '%s\\n' "$output"; fi
}
`;
	const env: Record<string, string> = { PATH: process.env.PATH!, FIXTURE: bashPath(dir), FAULT: fault, EOL: eol, OLDER_JQ: olderJq ? "1" : "0", TARGET: "windows-x64", EXE: "dsh", RUNNER_TEMP: backslashTemp && process.platform === "win32" ? dir : bashPath(dir), GITHUB_REPOSITORY: "fixture/repo", GITHUB_STEP_SUMMARY: bashPath(join(dir, "summary")), HOME: bashPath(join(dir, "initial-home")), USERPROFILE: bashPath(join(dir, "initial-home")), TMPDIR: bashPath(dir), TMP: dir, TEMP: dir };
	for (const key of ["SystemRoot", "SYSTEMROOT", "windir"]) if (process.env[key]) env[key] = process.env[key]!;
	const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", prelude + script], { cwd: dir, env, encoding: "utf8", timeout: 10_000 });
	return { ...result, dir };
}

for (const [label, eol, olderJq, backslashTemp] of [["LF", "LF", false, false], ["CRLF", "CRLF", false, false], ["older jq + CRLF", "CRLF", true, false], ["backslash RUNNER_TEMP + CRLF", "CRLF", false, true]] as const) test(`published first-download: ${label} reaches application launch and newest runtime selection`, () => {
	const r = check(eol, "", olderJq, backslashTemp);
	expect(r.status, r.stderr).toBe(0);
	expect(readFileSync(join(r.dir, "calls"), "utf8").split("\n").filter(Boolean)).toEqual(["manager --version", "plugin --profile first --help", "manager list", `--use ${newest} --version`]);
	expect(readFileSync(join(r.dir, "summary"), "utf8")).toContain(`first download installed ${newest} with manager-v1.0.0 (windows-x64)`);
});

for (const [fault, stage, status] of [["size", "manager archive size check", 1], ["sha", "manager archive SHA256 check", 1], ["jq", "manager asset metadata", 7]] as const) test(`published first-download: ${fault} failure refuses launch with diagnostics`, () => {
	const r = check("CRLF", fault);
	expect(r.status).toBe(status);
	expect(r.stderr).toContain("::error::Published first-download (windows-x64) failed during " + stage);
	expect(r.stderr).not.toContain("unexpected");
	expect(() => readFileSync(join(r.dir, "calls"))).toThrow();
});
