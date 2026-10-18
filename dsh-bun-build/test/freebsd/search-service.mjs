// Run with authenticated native Bun against an independent rc.2 app COPY.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [appArg, mode, expectedSha] = process.argv.slice(2);
const app = resolve(appArg);
assert.equal(process.platform, "freebsd");
assert.equal(process.arch, "x64");
assert.equal(process.getuid(), 1001);
assert.equal(process.env.PATH, "");
for (const key of ["HOME", "TMPDIR", "XDG_CACHE_HOME"]) assert.ok(process.env[key]?.startsWith("/var/tmp/dsh-freebsd-search/"));
assert.ok(process.cwd().startsWith("/var/tmp/dsh-freebsd-search/"));
const load = name => import(pathToFileURL(join(app, "node_modules/@deepseek-ai", name, "lib/index.js")).href);
const { Context } = await load("cordis");
const { default: SystemPrompt } = await load("dsh-system-prompt");
const { default: Tools } = await load("dsh-tools");
const { default: Subprocess } = await load("dsh-subprocess-local");
const Search = await load("dsh-tool-fs-search");
const ctx = new Context();
await ctx.plugin(SystemPrompt);
await ctx.plugin(Tools);
await ctx.plugin(Subprocess);
await ctx.plugin(Search, { sampleOverCapGlobResults: true });
const cwd = join(process.cwd(), `fixture-${process.pid}`);
mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, "space 文件.txt"), "needle 世界\n");
let counter = 0;
const call = (name, args, signal = new AbortController().signal) => ctx.tools.execute({
  callId: `native-search-${++counter}`, name, arguments: args, signal,
  agent: { session: { header: { id: "native-search", cwd } } },
});
const text = result => result.content.filter(block => block.type === "text").map(block => block.text).join("");
const results = [];
try {
  if (mode === "red") {
    const result = await call("grep", { pattern: "needle" });
    assert.equal(result.isError, true);
    assert.equal(result.error?.info?.code, "SEARCH_FAILED");
    assert.match(text(result), /could not start/);
    console.log(JSON.stringify({ mode, result }));
  } else {
    assert.equal(mode, "green");
    const binary = await Search.resolveRgPath();
    assert.equal(binary, join(app, "node_modules/@vscode/ripgrep-freebsd-x64/bin/rg"));
    assert.equal(createHash("sha256").update(readFileSync(binary)).digest("hex"), expectedSha);
    for (const [name, args, output, code] of [
      ["glob", { pattern: "*.txt" }, "space 文件.txt"],
      ["glob", { pattern: "*.absent" }, "No files found"],
      ["glob", { pattern: "[" }, undefined, "SEARCH_INVALID_PATTERN"],
      ["grep", { pattern: "needle" }, "space 文件.txt\nLine 1: needle 世界"],
      ["grep", { pattern: "absent" }, "No matches found"],
      ["grep", { pattern: "(unclosed" }, undefined, "SEARCH_INVALID_PATTERN"],
    ]) {
      const result = await call(name, args);
      assert.equal(result.isError, !!code, JSON.stringify(result));
      if (code) assert.equal(result.error?.info?.code, code);
      else assert.ok(text(result).includes(output), text(result));
      results.push({ name, args, result });
    }
    // A real FIFO keeps rg running; ps observes only this task's exact binary.
    const fifo = join(cwd, "cancel fifo");
    assert.equal(spawnSync("/usr/bin/mkfifo", [fifo]).status, 0);
    const controller = new AbortController();
    let earlyResult;
    const pending = call("grep", { pattern: "needle", path: fifo }, controller.signal).then(result => { earlyResult = result; return result; });
    let pid, lastPs = "";
    try {
      for (let n = 0; n < 200 && !pid; n++) {
        await new Promise(resolve => setTimeout(resolve, 10));
        const ps = spawnSync("/bin/ps", ["-axww", "-o", "pid,args"], { encoding: "utf8" });
        assert.equal(ps.status, 0);
        lastPs = ps.stdout.split("\n").filter(line => line.includes("/var/tmp/dsh-freebsd-search/")).join("\n");
        const row = ps.stdout.split("\n").find(line => line.includes(binary) && line.includes(fifo));
        if (row) pid = Number(row.trim().split(/\s+/)[0]);
      }
      assert.ok(pid, `real rg did not reach running FIFO search: ${JSON.stringify(earlyResult)}; ${lastPs}`);
    } finally { controller.abort(); }
    const result = await pending;
    assert.equal(result.error?.info?.code, "SEARCH_ABORTED", JSON.stringify(result));
    for (let n = 0; n < 100; n++) {
      try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") break; throw error; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.throws(() => process.kill(pid, 0), error => error.code === "ESRCH");
    assert.throws(() => process.kill(-pid, 0), error => error.code === "ESRCH");
    results.push({ name: "in-flight cancellation", pid, result });
    // Cancellation must not poison later service calls.
    assert.equal(text(await call("grep", { pattern: "absent", path: "space 文件.txt" })), "No matches found");
    console.log(JSON.stringify({ mode, uid: process.getuid(), bun: process.versions.bun, binary, expectedSha, results }));
  }
} finally { await ctx.fiber.dispose(); }
