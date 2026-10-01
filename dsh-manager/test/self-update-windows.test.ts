// Native Windows evidence only: real image mapping, inherited handles and TerminateProcess.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { writeZip } from "../../dsh-bun-build/runtime/zip.ts";
import { addRuntime, baseEnv, build, cleanup, EXE, hasZig, MANAGER_VERSION, newInstall, run, tempDir, tree, WIN, type Install } from "./harness.ts";

const NEXT = "9.8.8", A = "1.0.0-b1.1.gdeadbeef", reason = " — SKIP: Windows image mapping and handle inheritance require windows-2022 (7.3)";
const native = test.skipIf(!hasZig || !WIN);
const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
let next: string;
beforeAll(() => { if (hasZig) { build(); if (WIN) next = build(NEXT).manager; } }, 300_000);
afterAll(cleanup);
function fixture() {
    const i = newInstall(); addRuntime(i.data, A);
    expect(run(i, ["manager", "snapshot", "new", "--use", A, "--empty"]).status).toBe(0);
    expect(run(i, ["manager", "select", "--use", A, "--snapshot", `${A}@1`]).status).toBe(0);
    for (const p of ["home/credential", "home/profiles/config", `snapshots/${A}@1/profiles/plugin`, "addons/keep"]) {
        mkdirSync(join(i.data, p, ".."), { recursive: true }); writeFileSync(join(i.data, p), "KEEP");
    }
    return i;
}
function protectedState(i: Install) {
    const paths = ["bundles", "snapshots", "home", "addons", "state"];
    return Object.fromEntries(paths.flatMap(folder => tree(join(i.data, folder)).filter(p => !p.endsWith("manager.lock")).map(p => {
        const path = `${folder}/${p}`;
        try { return [path, hash(readFileSync(join(i.data, path)))]; } catch { return [path, "directory"]; }
    })));
}
function source() {
    const path = join(tempDir("dsh-windows-zip-"), "manager.zip");
    writeZip(path, [{ name: "dsh.exe", data: readFileSync(next), mode: 0o755 }]);
    const bytes = readFileSync(path);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
        if (new URL(req.url).pathname === "/manager-index.json") return Response.json({ schema: 1, versions: [{ version: NEXT, tag: `manager-v${NEXT}`, launchProtocols: [1], assets: { "windows-x64": { name: "manager-windows-x64.zip", size: bytes.length, sha256: hash(bytes) } } }] });
        return new Response(bytes);
    } });
    return { origin: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
async function until(check: () => boolean, description: string, ms = 20_000) {
    const deadline = Date.now() + ms;
    while (!check() && Date.now() < deadline) await Bun.sleep(10);
    if (!check()) throw new Error(`timeout: ${description}`);
}
function update(i: Install, s: ReturnType<typeof source>, control: string, stage = "", extra: Record<string, string> = {}) {
    const p = spawn(i.exe, ["manager", "self-update"], { cwd: i.home, env: { ...baseEnv(i), DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_ORIGIN: s.origin, DSH_MANAGER_TEST_HELPER_CONTROL: control, DSH_MANAGER_TEST_HELPER_PAUSE: stage, ...extra }, stdio: "pipe" });
    let stdout = "", stderr = ""; p.stdout!.on("data", b => stdout += b); p.stderr!.on("data", b => stderr += b);
    const done = new Promise<number | null>((resolve, reject) => { p.on("close", resolve); p.on("error", reject); });
    const timer = setTimeout(() => p.kill("SIGKILL"), 25_000); done.finally(() => clearTimeout(timer));
    return { p, done, output: () => ({ stdout, stderr }) };
}
const resultPath = (i: Install) => join(i.data, "tmp/self-update-result.txt");
async function result(i: Install) { await until(() => existsSync(resultPath(i)), "helper result"); return readFileSync(resultPath(i), "utf8"); }
async function ready(control: string, stage: string) {
    const path = join(control, `${stage}.ready`); await until(() => existsSync(path) && readFileSync(path, "utf8").length > 0, `${stage} readiness`);
    return Number(readFileSync(path, "utf8"));
}
// Node's SIGKILL on Windows uses TerminateProcess, not a POSIX signal simulation.
function terminate(pid: number) { process.kill(pid, "SIGKILL"); }
async function finish(u: ReturnType<typeof update>) { if (u.p.exitCode === null) u.p.kill("SIGKILL"); await u.done; }

native(`MC-SELF-ONLY / MC-SELF-FAIL Windows: handoff is not success; next entry consumes result once; helper keeps original context${WIN ? "" : reason}`, async () => {
    const i = fixture(), before = protectedState(i), s = source(), control = tempDir("helper-control-"), u = update(i, s, control);
    try {
        expect(await u.done).toBe(0); expect(u.output().stderr).toBe(""); expect(u.output().stdout).toContain("handed off to helper"); expect(u.output().stdout).not.toContain("updated");
        expect(await result(i)).toBe(`updated ${MANAGER_VERSION} -> ${NEXT}\n`);
        expect(hash(readFileSync(i.exe))).toBe(hash(readFileSync(next))); expect(protectedState(i)).toEqual(before);
        const r = run(i, ["manager", "--version"]); expect(r.status).toBe(0); expect(r.stdout).toContain(NEXT); expect(r.stderr).toContain("self-update result: updated");
        expect(existsSync(resultPath(i))).toBe(false); expect(run(i, ["manager", "--version"]).stderr).not.toContain("self-update result");
        expect(readdirSync(i.dir).filter(n => n.startsWith(".dsh-manager-helper-")).length).toBe(1);
        expect(tree(i.home)).toEqual([]); expect(readdirSync(i.dir).filter(n => n.includes("helper") && n.endsWith("dsh-bin"))).toEqual([]);
        await Bun.sleep(100); expect(run(i, ["manager", "clean"]).status).toBe(0);
        expect(readdirSync(i.dir).some(n => n.startsWith(".dsh-manager-helper-") || n.startsWith(".dsh-manager-candidate-"))).toBe(false);
    } finally { s.stop(); await finish(u); }
}, 60_000);

native(`MC-SELF-FAIL Windows: mapped parent image remains old while helper waits; timeout reports failure without replacement${WIN ? "" : reason}`, async () => {
    const i = fixture(), old = hash(readFileSync(i.exe)), before = protectedState(i), s = source(), control = tempDir("helper-control-"), u = update(i, s, control, "helper-parent", { DSH_MANAGER_TEST_HELPER_TIMEOUT_MS: "200" });
    try {
        await ready(control, "helper-parent"); expect(u.p.exitCode).toBeNull();
        expect(await result(i)).toContain("failed: WaitTimeOut"); expect(hash(readFileSync(i.exe))).toBe(old); expect(protectedState(i)).toEqual(before);
        expect(u.output().stdout).toContain("handed off"); expect(u.output().stdout).not.toContain("updated");
        writeFileSync(join(control, "helper-parent.go"), "go"); expect(await u.done).toBe(0);
        expect(run(i, ["manager", "--version"]).stdout).toContain(MANAGER_VERSION);
    } finally { s.stop(); await finish(u); }
}, 60_000);

native(`MC-SELF-FAIL Windows: TerminateProcess before wait/before move/after move leaves complete old or new entry${WIN ? "" : reason}`, async () => {
    const s = source();
    try { for (const stage of ["helper-before-wait", "helper-before-move", "helper-after-move"]) {
        const i = fixture(), old = hash(readFileSync(i.exe)), before = protectedState(i), control = tempDir("helper-control-"), u = update(i, s, control, stage);
        try {
            const pid = await ready(control, stage); expect(await u.done).toBe(0);
            terminate(pid); await Bun.sleep(150);
            const changed = stage === "helper-after-move";
            expect(hash(readFileSync(i.exe))).toBe(changed ? hash(readFileSync(next)) : old);
            expect(run(i, ["manager", "--version"]).stdout).toContain(changed ? NEXT : MANAGER_VERSION);
            expect(protectedState(i)).toEqual(before); expect(existsSync(resultPath(i))).toBe(false);
            expect(existsSync(join(i.dir, `.dsh-manager-candidate-${NEXT}`))).toBe(!changed);
        } finally { await finish(u); }
    } } finally { s.stop(); }
}, 120_000);

native(`MC-SELF-FAIL Windows: candidate denies tampering through handoff; another mapped entry makes one replacement attempt fail${WIN ? "" : reason}`, async () => {
    const i = fixture(), s = source(), control = tempDir("helper-control-"), u = update(i, s, control, "helper-before-move");
    let mapped: ReturnType<typeof spawn> | undefined, before: ReturnType<typeof protectedState> | undefined;
    try {
        await ready(control, "helper-before-move"); expect(await u.done).toBe(0);
        const candidate = join(i.dir, `.dsh-manager-candidate-${NEXT}`), bytes = hash(readFileSync(candidate));
        expect(() => writeFileSync(candidate, "unverified bytes")).toThrow(); expect(hash(readFileSync(candidate))).toBe(bytes);
        // Ordinary runtime hold retains the old manager image without needing the maintenance lock.
        mapped = spawn(i.exe, ["--use", A], { cwd: i.home, env: { ...baseEnv(i), FAKE_HOLD_STDIN: "1" }, stdio: "pipe" });
        await until(() => existsSync(join(i.out, "1.ready")), "mapped manager runtime");
        // The holding launch itself legitimately creates launch-environment state (e.g. state/pnpm); baseline after it.
        before = protectedState(i);
        writeFileSync(join(control, "helper-before-move.go"), "go");
        expect(await result(i)).toContain("failed: ManagerReplacementRefused"); expect(run(i, ["manager", "--version"]).stdout).toContain(MANAGER_VERSION);
        expect(protectedState(i)).toEqual(before); expect(existsSync(candidate)).toBe(true);
    } finally { mapped?.stdin?.end("x"); s.stop(); await finish(u); }
}, 60_000);

test.skipIf(!hasZig)("MC-CLEAN: helper exact valid files reclaim; helper-named user files and junctions survive", () => {
    const i = fixture(), helper = join(i.dir, ".dsh-manager-helper-ab12.exe"), unknown = join(i.dir, ".dsh-manager-helper-cd34.exe"), linked = join(i.dir, ".dsh-manager-helper-ef56.exe");
    cpSync(build().manager, helper); writeFileSync(unknown, "USER FILE");
    const resultPart = join(i.data, "tmp/.self-update-result-ab12.tmp"); mkdirSync(join(i.data, "tmp"), { recursive: true }); writeFileSync(resultPart, "interrupted result");
    const external = join(i.home, "external"); mkdirSync(external); writeFileSync(join(external, "credential"), "KEEP"); symlinkSync(external, linked, WIN ? "junction" : "dir");
    expect(run(i, ["manager", "clean"]).status).toBe(0); expect(existsSync(resultPart)).toBe(false); expect(existsSync(helper)).toBe(false); expect(readFileSync(unknown, "utf8")).toBe("USER FILE"); expect(readFileSync(join(linked, "credential"), "utf8")).toBe("KEEP");
}, 60_000);

native(`MC-SELF-FAIL Windows: tampered candidate before handle handoff refuses without installing or claiming success${WIN ? "" : reason}`, async () => {
    const i = fixture(), old = hash(readFileSync(i.exe)), before = protectedState(i), s = source();
    const p = spawn(i.exe, ["manager", "self-update"], { cwd: i.home, env: { ...baseEnv(i), DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_ORIGIN: s.origin, DSH_MANAGER_TEST_PAUSE: "self-update-before-handoff" }, stdio: "pipe" });
    let stderr = "", stdout = ""; p.stderr!.on("data", b => stderr += b); p.stdout!.on("data", b => stdout += b);
    const done = new Promise<number | null>((resolve, reject) => { p.on("close", resolve); p.on("error", reject); });
    const timer = setTimeout(() => p.kill("SIGKILL"), 25_000);
    try {
        await until(() => stderr.includes("test pause: self-update-before-handoff"), "pre-handoff barrier");
        writeFileSync(join(i.dir, `.dsh-manager-candidate-${NEXT}`), "unverified bytes"); p.stdin!.end("go");
        expect(await done).toBe(1); expect(stdout).not.toContain("handed off"); expect(stdout).not.toContain("updated");
        expect(hash(readFileSync(i.exe))).toBe(old); expect(protectedState(i)).toEqual(before); expect(existsSync(resultPath(i))).toBe(false);
    } finally { clearTimeout(timer); if (p.exitCode === null) { p.kill("SIGKILL"); await done; } s.stop(); }
}, 60_000);
