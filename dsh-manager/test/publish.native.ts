// Bounded native acceptance: run `bun test ./test/publish.native.ts` with required artifact variables.
// Not a *.test.ts file: ordinary Bun discovery does not opt into native prerequisites.
// No application, profile or flock closure claim.
import { beforeAll, expect, test } from "bun:test";
import { spawnSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeZip } from "../../dsh-bun-build/runtime/zip.ts";
import { hostTargetId } from "../../dsh-bun-build/scripts/targets.mjs";
import { baseEnv, bundleMeta, newInstall, run, tempDir, tree, type Install } from "./harness.ts";

const manager = process.env.DSH_EMLINK_MANAGER!, publisher = process.env.DSH_PUBLISH_DRIVER!, nextManager = process.env.DSH_PUBLISH_NEXT!;
const ID = "1.0.0-b1.1.gpublish", NEXT = "9.8.8", host = hostTargetId();
const managerHost = `${process.platform === "darwin" ? "darwin" : process.platform}-${process.arch}`;
// Full-system FreeBSD ARM64 TCG spends ~19-23s computing a verified self-update before pause.
// Budget only that native test path; production waits/retries and all safety assertions stay unchanged.
const nativeArm = process.platform === "freebsd" && process.arch === "arm64";
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
beforeAll(() => {
    expect(process.platform).toBe("freebsd"); expect(process.getuid!()).not.toBe(0);
    for (const f of [manager, publisher, nextManager]) expect(f && existsSync(f)).toBe(true);
});
function fixture() {
    const i = newInstall(manager), bundle = join(i.data, "bundles", ID);
    mkdirSync(bundle, { recursive: true }); writeFileSync(join(i.data, ".dsh-bin-data.json"), JSON.stringify({ kind: "dsh-manager-data", schema: 1 }));
    writeFileSync(join(bundle, "bundle.json"), JSON.stringify(bundleMeta(ID, { patch: { target: host } })));
    cpSync(manager, join(bundle, "dsh-native")); writeFileSync(join(bundle, ".usage.lock"), "");
    mkdirSync(join(i.data, "home")); writeFileSync(join(i.data, "home", "sentinel"), "PRIVATE KEEP");
    return i;
}
const snapshot = (i: Install, kind: string, ...args: string[]) => run(i, ["manager", "snapshot", kind, ...args]);
function assertResult(r: ReturnType<typeof run>, status: number, text?: string) {
    expect(r.status, r.stderr).toBe(status); if (text) expect(r.stderr + r.stdout).toContain(text);
    expect(r.stderr).not.toContain("Unexpected");
}
async function command(i: Install, origin: string, args: string[], env: Record<string, string> = {}) {
    const p = Bun.spawn([i.exe, ...args], { cwd: i.home, env: { ...baseEnv(i), DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_ORIGIN: origin, ...env }, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill("SIGKILL"), nativeArm && args[1] === "self-update" ? 60000 : 30000);
    try { const [status, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]); return { status, stdout, stderr }; }
    finally { clearTimeout(timer); if (p.exitCode === null) { p.kill("SIGKILL"); await p.exited; } }
}
async function paused(i: Install, origin: string, args: string[], stage: string, act?: (name: string) => void) {
    const p = spawn(i.exe, args, { cwd: i.home, env: { ...baseEnv(i), DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_ORIGIN: origin, DSH_MANAGER_TEST_PAUSE: stage }, stdio: "pipe" });
    let stderr = ""; p.stderr.on("data", b => { stderr += b; }); p.stdout.resume();
    const done = new Promise<number | null>((resolve, reject) => { p.on("close", resolve); p.on("error", reject); });
    const armSelfUpdate = nativeArm && args[1] === "self-update";
    const timer = setTimeout(() => p.kill("SIGKILL"), armSelfUpdate ? 60000 : 30000);
    try {
        const deadline = Date.now() + (armSelfUpdate ? 40000 : 20000);
        while (!stderr.includes(`test pause: ${stage} `) && p.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
        expect(stderr).toContain(`test pause: ${stage} `);
        if (act) { act(stderr.split(`test pause: ${stage} `)[1]!.split("\n")[0]!); p.stdin.end("continue"); } else p.kill("SIGKILL");
        return { status: await done, stderr };
    } finally { clearTimeout(timer); if (p.exitCode === null) { p.kill("SIGKILL"); await done; } }
}

test("FBSD-ATOMIC production publish: absent destination moves exact inode; existing file/directory/link never replaced", () => {
    for (const source of ["file", "directory"]) for (const dest of ["absent", "file", "directory", "link"]) {
        const i = fixture(), root = tempDir("publish-"), part = join(root, "part"), final = join(root, "final");
        if (source === "file") writeFileSync(part, "SOURCE"); else { mkdirSync(part); writeFileSync(join(part, "source"), "SOURCE"); }
        const inode = lstatSync(part).ino, outside = join(i.home, "outside"); mkdirSync(outside); writeFileSync(join(outside, "keep"), "KEEP");
        if (dest === "file") writeFileSync(final, "DEST");
        if (dest === "directory") { mkdirSync(final); writeFileSync(join(final, "keep"), "DEST"); }
        if (dest === "link") symlinkSync(outside, final);
        const targetInode = dest === "absent" ? null : lstatSync(final).ino;
        const r = spawnSync(publisher, ["publish", root, "part", "final"], { env: baseEnv(i), encoding: "utf8", timeout: 5000 });
        expect(r.status, r.stderr).toBe(dest === "absent" ? 0 : 1);
        if (dest === "absent") { expect(existsSync(part)).toBe(false); expect(lstatSync(final).ino).toBe(inode); }
        else { expect(r.stderr).toContain("PathAlreadyExists"); expect(lstatSync(part).ino).toBe(inode); expect(lstatSync(final).ino).toBe(targetInode); }
        const retained = dest === "absent" ? final : part;
        expect(readFileSync(source === "file" ? retained : join(retained, "source"), "utf8")).toBe("SOURCE");
        if (dest === "file") expect(readFileSync(final, "utf8")).toBe("DEST");
        if (dest === "directory") expect(readFileSync(join(final, "keep"), "utf8")).toBe("DEST");
        if (dest === "link") expect(lstatSync(final).isSymbolicLink()).toBe(true);
        expect(readFileSync(join(outside, "keep"), "utf8")).toBe("KEEP");
    }
}, 30000);

test("FBSD-ATOMIC production publish: moved-parent pathname link cannot redirect retained fd", () => {
    const i = fixture(), root = join(i.home, "parent"), moved = `${root}.held`, outside = join(i.home, "outside");
    mkdirSync(root); mkdirSync(join(root, "part")); writeFileSync(join(root, "part", "source"), "SOURCE");
    mkdirSync(outside); writeFileSync(join(outside, "keep"), "KEEP"); const inode = lstatSync(join(root, "part")).ino;
    const r = spawnSync(publisher, ["move-parent", root, "part", "final", moved, outside], { env: baseEnv(i), encoding: "utf8", timeout: 5000 });
    expect(r.status, r.stderr).toBe(0); expect(lstatSync(root).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(moved, "final")).ino).toBe(inode); expect(existsSync(join(moved, "part"))).toBe(false);
    expect(readFileSync(join(moved, "final", "source"), "utf8")).toBe("SOURCE"); expect(readdirSync(outside)).toEqual(["keep"]);
    expect(readFileSync(join(outside, "keep"), "utf8")).toBe("KEEP");
});

test("FBSD-ATOMIC actual manager plugin/config new and copy publish complete independent generations", () => {
    for (const kind of ["plugins", "config"]) {
        const i = fixture(), root = join(i.data, kind === "config" ? "config-snapshots" : "snapshots"), first = join(root, `${ID}@1`);
        assertResult(snapshot(i, kind, "new", "--use", ID, "--empty"), 0);
        const source = join(first, "profiles", "p"); mkdirSync(source); writeFileSync(join(source, "content"), "SOURCE", { mode: kind === "config" ? 0o600 : 0o644 });
        assertResult(snapshot(i, kind, "new", "--use", ID, "--target", `${ID}@1`), 0);
        const copy = join(root, `${ID}@2`, "profiles", "p", "content"); expect(readFileSync(copy, "utf8")).toBe("SOURCE");
        expect(lstatSync(copy).ino).not.toBe(lstatSync(join(source, "content")).ino); writeFileSync(copy, "CHANGED"); expect(readFileSync(join(source, "content"), "utf8")).toBe("SOURCE");
        expect(readdirSync(root).some(n => n.startsWith(".staging-"))).toBe(false);
        assertResult(snapshot(i, kind, "remove", `${ID}@2`), 0); expect(existsSync(first)).toBe(true);
        expect(readFileSync(join(i.data, "home", "sentinel"), "utf8")).toBe("PRIVATE KEEP");
    }
}, 30000);

test("FBSD-UPDATES actual manager install/reinstall: digest refusal, validated/backup/activation crashes recover complete generation", async () => {
    const file = join(tempDir("runtime-zip-"), "runtime.zip"), meta = bundleMeta(ID, { patch: { target: host } });
    writeZip(file, [{ name: "bundle.json", data: Buffer.from(JSON.stringify(meta)) }, { name: "dsh-native", data: readFileSync(manager), mode: 0o755 }]);
    const bytes = readFileSync(file); let bad = false;
    const entry = { ...meta, tag: `runtime-v${ID}`, seq: 1, assets: { [host]: { name: "runtime.zip", size: bytes.length, sha256: sha(file) } } };
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
        if (new URL(req.url).pathname === "/runtime-index.json") return Response.json({ schema: 1, channels: { release: [{ ...entry, assets: { [host]: { ...entry.assets[host], sha256: bad ? "a".repeat(64) : sha(file) } } }], live: [] }, addons: { office: [] } });
        return new Response(bytes);
    } });
    const origin = `http://127.0.0.1:${server.port}`;
    try {
        const refused = newInstall(manager); bad = true; const r = await command(refused, origin, ["manager", "install", ID]);
        expect(r.status).toBe(1); expect(existsSync(join(refused.data, "bundles", ID))).toBe(false); bad = false;
        const stages = process.platform === "freebsd" ? ["before-activation", "after-retire", "after-activation"] : ["before-activation", "after-activation"];
        for (const stage of stages) {
            const i = fixture(), installed = join(i.data, "bundles", ID); writeFileSync(join(installed, "old-generation"), "OLD");
            const r = await command(i, origin, ["manager", "install", ID, "--force"], { DSH_MANAGER_TEST_CRASH: stage }); expect(r.status, r.stderr).toBe(86);
            const backup = join(i.data, "tmp", `.previous-${ID}`);
            if (stage === "after-retire") { expect(existsSync(installed)).toBe(false); expect(readFileSync(join(backup, "old-generation"), "utf8")).toBe("OLD"); }
            else expect(sha(join(installed, "dsh-native"))).toBe(sha(manager));
            expect(readFileSync(join(i.data, "home", "sentinel"), "utf8")).toBe("PRIVATE KEEP");
            expect((await command(i, origin, ["manager", "install", ID, "--force"])).status).toBe(0);
            expect(sha(join(installed, "dsh-native"))).toBe(sha(manager)); expect(existsSync(backup)).toBe(false);
            for (const root of ["snapshots", "config-snapshots"]) expect(existsSync(join(i.data, root, `${ID}@1`, "snapshot.json"))).toBe(true);
            expect(existsSync(join(i.data, "state", "selection.json"))).toBe(false);
        }
        if (process.platform === "freebsd") for (const kind of ["file", "directory", "link"]) {
            const fresh = newInstall(manager), installed = join(fresh.data, "bundles", ID), outside = join(fresh.home, "outside");
            mkdirSync(outside); writeFileSync(join(outside, "keep"), "KEEP");
            const collision = await paused(fresh, origin, ["manager", "install", ID], "install-before-activation", () => {
                if (kind === "file") writeFileSync(installed, "USER KEEP");
                if (kind === "directory") { mkdirSync(installed); writeFileSync(join(installed, "keep"), "USER KEEP"); }
                if (kind === "link") symlinkSync(outside, installed);
            });
            expect(collision.status, collision.stderr).toBe(1); expect(collision.stderr).toContain("PathAlreadyExists");
            if (kind === "file") expect(readFileSync(installed, "utf8")).toBe("USER KEEP");
            if (kind === "directory") expect(readFileSync(join(installed, "keep"), "utf8")).toBe("USER KEEP");
            if (kind === "link") expect(lstatSync(installed).isSymbolicLink()).toBe(true);
            expect(readFileSync(join(outside, "keep"), "utf8")).toBe("KEEP");
            expect(existsSync(join(fresh.data, "state", "selection.json"))).toBe(false);
            rmSync(installed, { recursive: kind === "directory" });
            const retry = await command(fresh, origin, ["manager", "install", ID]); expect(retry.status, retry.stderr).toBe(0);
            expect(sha(join(installed, "dsh-native"))).toBe(sha(manager));
        }
        if (process.platform === "freebsd") for (const kind of ["file", "directory", "link"]) {
            const i = fixture(), installed = join(i.data, "bundles", ID), outside = join(i.home, "outside");
            writeFileSync(join(installed, "old-generation"), "OLD"); mkdirSync(outside); writeFileSync(join(outside, "keep"), "KEEP");
            const collision = await paused(i, origin, ["manager", "install", ID, "--force"], "install-after-retire", () => {
                if (kind === "file") writeFileSync(installed, "USER KEEP");
                if (kind === "directory") { mkdirSync(installed); writeFileSync(join(installed, "keep"), "USER KEEP"); }
                if (kind === "link") symlinkSync(outside, installed);
            });
            expect(collision.status, collision.stderr).toBe(1); expect(collision.stderr).toContain("RestoreFailed");
            if (kind === "file") expect(readFileSync(installed, "utf8")).toBe("USER KEEP");
            if (kind === "directory") expect(readFileSync(join(installed, "keep"), "utf8")).toBe("USER KEEP");
            if (kind === "link") expect(lstatSync(installed).isSymbolicLink()).toBe(true);
            expect(readFileSync(join(i.data, "tmp", `.previous-${ID}`, "old-generation"), "utf8")).toBe("OLD");
            expect(readFileSync(join(outside, "keep"), "utf8")).toBe("KEEP");
            rmSync(installed, { recursive: kind === "directory" });
            const retry = await command(i, origin, ["manager", "install", ID, "--force"]); expect(retry.status, retry.stderr).toBe(0);
            expect(sha(join(installed, "dsh-native"))).toBe(sha(manager));
        }
    } finally { server.stop(true); }
}, 120000);

test("FBSD-UPDATES actual self-update: occupied candidate and interrupted verified replacement retain old/complete new plus data", async () => {
    const file = join(tempDir("manager-zip-"), "manager.zip"); writeZip(file, [{ name: "dsh", data: readFileSync(nextManager), mode: 0o755 }]);
    const bytes = readFileSync(file), entry = { version: NEXT, tag: `manager-v${NEXT}`, launchProtocols: [2], assets: { [managerHost]: { name: "manager.zip", size: bytes.length, sha256: sha(file) } } };
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { return new URL(req.url).pathname === "/manager-index.json" ? Response.json({ schema: 1, versions: [entry] }) : new Response(bytes); } });
    const origin = `http://127.0.0.1:${server.port}`;
    try {
        const conflict = fixture(), dest = join(conflict.dir, `.dsh-manager-candidate-${NEXT}`), before = sha(conflict.exe);
        const r = await paused(conflict, origin, ["manager", "self-update"], "candidate-publish", () => writeFileSync(dest, "USER KEEP"));
        expect(r.status, r.stderr).toBe(1); expect(r.stderr).toContain("PathAlreadyExists"); expect(readFileSync(dest, "utf8")).toBe("USER KEEP"); expect(sha(conflict.exe)).toBe(before);
        for (const stage of ["self-update-verify", "self-update-before-replace", "self-update-after-replace"]) {
            const i = fixture(), old = sha(i.exe); const r = await paused(i, origin, ["manager", "self-update"], stage); expect(r.status).not.toBe(0);
            expect(sha(i.exe)).toBe(stage === "self-update-after-replace" ? sha(nextManager) : old);
            expect(readFileSync(join(i.data, "home", "sentinel"), "utf8")).toBe("PRIVATE KEEP");
            const retry = await command(i, origin, ["manager", "self-update"]); expect(retry.status, retry.stderr).toBe(0);
            expect(sha(i.exe)).toBe(sha(nextManager)); expect(run(i, ["manager", "--version"]).stdout).toContain(NEXT);
            expect(readdirSync(i.dir).some(n => n.startsWith(".dsh-manager-candidate-"))).toBe(false);
            expect(existsSync(join(i.data, "state", "selection.json"))).toBe(false);
            expect(readFileSync(join(i.data, "home", "sentinel"), "utf8")).toBe("PRIVATE KEEP");
        }
        if (process.platform === "freebsd") for (const fault of ["os-note", "machine", "class", "endian", "type"]) {
            const bad = Buffer.from(readFileSync(nextManager));
            if (fault === "os-note") {
                for (let at = bad.indexOf("FreeBSD\0"); at !== -1; at = bad.indexOf("FreeBSD\0", at + 8)) bad[at] = 76; // No FreeBSD ELF identity; same machine/SystemV OSABI alone is insufficient.
            }
            if (fault === "machine") bad.writeUInt16LE(process.arch === "x64" ? 183 : 62, 18);
            if (fault === "class") bad[4] = 1;
            if (fault === "endian") bad[5] = 2;
            if (fault === "type") bad.writeUInt16LE(1, 16);
            const i = fixture(), candidate = join(i.dir, `.dsh-manager-candidate-${NEXT}`), old = sha(i.exe);
            writeFileSync(candidate, bad, { mode: 0o755 });
            const refused = await command(i, origin, ["manager", "self-update"]); expect(refused.status).toBe(1); expect(refused.stderr).toContain("WrongManagerTarget");
            expect(sha(i.exe)).toBe(old); expect(sha(candidate)).toBe(createHash("sha256").update(bad).digest("hex"));
        }
    } finally { server.stop(true); }
}, nativeArm ? 240000 : 120000);

// Explicit ./test/publish.native.ts only: Bun ordinary *.test.ts discovery excludes native prerequisites.
function repairSource() {
    const zip = join(tempDir("repair-zip-"), "runtime.zip"), meta = bundleMeta(ID, { patch: { target: host } });
    writeZip(zip, [{ name: "bundle.json", data: Buffer.from(JSON.stringify(meta)) }, { name: "dsh-native", data: readFileSync(manager), mode: 0o755 }]);
    const bytes = readFileSync(zip), entry = { ...meta, tag: `runtime-v${ID}`, seq: 1, assets: { [host]: { name: "runtime.zip", size: bytes.length, sha256: sha(zip) } } };
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { return new URL(req.url).pathname === "/runtime-index.json" ? Response.json({ schema: 1, channels: { release: [entry], live: [] }, addons: { office: [] } }) : new Response(bytes); } });
    return { origin: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
for (const attack of ["target", "staging", "backup"] as const) test(`FBSD-REPAIR ${attack} substitution preserves user object and retained generation`, async () => {
    expect(process.platform).toBe("freebsd");
    const i = fixture(), s = repairSource(), installed = join(i.data, "bundles", ID);
    writeFileSync(join(installed, "old-generation"), "OLD");
    let replaced = "", held = "", staged = "";
    try {
        const r = await paused(i, s.origin, ["manager", "install", ID, "--force"], attack === "backup" ? "install-after-retire" : "install-before-activation", name => {
            if (attack === "backup") replaced = join(i.data, "tmp", name);
            else { staged = join(i.data, "tmp", name); replaced = attack === "target" ? installed : staged; }
            held = `${replaced}.held`;
            renameSync(replaced, held); mkdirSync(replaced); writeFileSync(join(replaced, "USERKEEP"), "USER KEEP");
        });
        console.info(JSON.stringify({ attack, status: r.status, stderr: r.stderr, userPresent: existsSync(join(replaced, "USERKEEP")), heldPresent: existsSync(held), stagedPresent: staged ? existsSync(staged) : null }));
        expect(r.status, r.stderr).toBe(1); expect(r.stderr).toContain("RuntimeDirectoryConflict");
        expect(readFileSync(join(replaced, "USERKEEP"), "utf8")).toBe("USER KEEP");
        expect(existsSync(held)).toBe(true);
        if (attack === "staging") expect(sha(join(held, "dsh-native"))).toBe(sha(manager));
        else expect(readFileSync(join(held, "old-generation"), "utf8")).toBe("OLD");
        if (attack === "target") expect(existsSync(join(staged, "dsh-native"))).toBe(true);
        if (attack === "backup") expect(existsSync(installed)).toBe(false);
        expect(readFileSync(join(i.data, "home", "sentinel"), "utf8")).toBe("PRIVATE KEEP");
        expect(existsSync(join(i.data, "state", "selection.json"))).toBe(false);
    } finally { s.stop(); }
}, 60000);
