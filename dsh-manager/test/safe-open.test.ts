// Bounded FS boundary tests: real manager + native syscall/ZIP drivers, not runtime/profile acceptance.
// Compile artifacts separately, then set DSH_EMLINK_MANAGER/ZIP/SAFE. All fixtures stay under TMPDIR.
import { beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeZip } from "../../dsh-bun-build/runtime/zip.ts";
import { hostTargetId } from "../../dsh-bun-build/scripts/targets.mjs";
import { baseEnv, bundleMeta, newInstall, run, tempDir, type Install } from "./harness.ts";

const manager = process.env.DSH_EMLINK_MANAGER!;
const zipper = process.env.DSH_EMLINK_ZIP!;
const opener = process.env.DSH_EMLINK_SAFE!;
const ID = "1.0.0-b1.1.gemlink";
const host = hostTargetId();
const directoryLinkError = process.platform === "freebsd" ? "SymLinkLoop" : "NotDir";
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
beforeAll(() => {
    expect(process.platform === "freebsd" || process.platform === "linux").toBe(true);
    expect(process.getuid!()).not.toBe(0); // Actual EACCES assertions must run as ordinary user.
    for (const file of [manager, zipper, opener]) expect(file && existsSync(file), "provide prebuilt native artifact").toBe(true);
});

function fixture() {
    const i = newInstall(manager);
    mkdirSync(join(i.data, "bundles", ID), { recursive: true });
    writeFileSync(join(i.data, ".dsh-bin-data.json"), JSON.stringify({ kind: "dsh-manager-data", schema: 1 }));
    writeFileSync(join(i.data, "bundles", ID, "bundle.json"), JSON.stringify(bundleMeta(ID, { patch: { target: host } })));
    // Opaque genuine native manager bytes satisfy storage's required-file fixture; never launch as app.
    cpSync(manager, join(i.data, "bundles", ID, "dsh-native"));
    writeFileSync(join(i.data, "bundles", ID, ".usage.lock"), "");
    return i;
}
const snapshot = (i: Install, kind: string, ...args: string[]) => run(i, ["manager", "snapshot", kind, ...args]);
const snap = (i: Install, kind: string, n: number) => join(i.data, kind === "config" ? "config-snapshots" : "snapshots", `${ID}@${n}`);
function seedSnapshot(i: Install, kind: string, n = 1) {
    // Store fixture only: FreeBSD directory publication is a separately tracked gate.
    const dir = snap(i, kind, n), store = join(dir, "..");
    mkdirSync(join(dir, "profiles"), { recursive: true, mode: kind === "config" ? 0o700 : 0o755 });
    if (kind === "config") { chmodSync(dir, 0o700); chmodSync(store, 0o700); }
    writeFileSync(join(dir, "snapshot.json"), JSON.stringify({ id: `${ID}@${n}`, version: ID, n, source: "empty", reason: "fixture" }), { mode: kind === "config" ? 0o600 : 0o644 });
    writeFileSync(join(dir, ".usage.lock"), "", { mode: kind === "config" ? 0o600 : 0o644 });
    writeFileSync(join(store, ".counters.json"), JSON.stringify({ [ID]: n }), { mode: kind === "config" ? 0o600 : 0o644 });
}
function result(r: ReturnType<typeof run>, status: number, diagnostic?: string) {
    expect(r.status, r.stderr).toBe(status);
    if (diagnostic) expect(r.stderr).toContain(diagnostic);
    expect(r.stderr).not.toContain("Unexpected");
}
function direct(i: Install, exe: string, args: string[]) {
    return spawnSync(exe, args, { env: baseEnv(i), cwd: i.home, encoding: "utf8", timeout: 5000 });
}
async function paused(i: Install, args: string[], stage: string, mutate: () => void) {
    const p = spawn(i.exe, args, { cwd: i.home, env: { ...baseEnv(i), DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_PAUSE: stage }, stdio: "pipe" });
    let stderr = "", stdout = "";
    p.stderr.on("data", b => { stderr += b; }); p.stdout.on("data", b => { stdout += b; });
    const done = new Promise<number | null>((resolve, reject) => { p.on("close", resolve); p.on("error", reject); });
    const timer = setTimeout(() => p.kill("SIGKILL"), 15000);
    try {
        const deadline = Date.now() + 10000;
        while (!stderr.includes(`test pause: ${stage}`) && p.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
        expect(stderr).toContain(`test pause: ${stage}`);
        mutate(); p.stdin.end("continue");
        return { status: await done, stderr, stdout };
    } finally {
        clearTimeout(timer);
        if (p.exitCode === null) { p.kill("SIGKILL"); await done; }
    }
}

test("FBSD-NOFOLLOW ordinary errno/type matrix: links do not become data, missing/denied are not links", () => {
    const i = fixture(), sentinel = join(i.home, "sentinel"); writeFileSync(sentinel, "outside KEEP");
    const parent = tempDir("emlink-open-"); mkdirSync(join(parent, "directory"));
    writeFileSync(join(parent, "file"), "regular");
    symlinkSync(sentinel, join(parent, "linked")); symlinkSync("missing", join(parent, "dangling")); symlinkSync("loop", join(parent, "loop"));
    symlinkSync("directory", join(parent, "linked-directory"));
    for (const name of ["linked", "dangling", "loop"]) result(direct(i, opener, ["file", parent, name]), 1, "SymLinkLoop");
    result(direct(i, opener, ["directory", parent, "linked-directory"]), 1, process.platform === "freebsd" ? "SymLinkLoop" : "NotDir");
    result(direct(i, opener, ["file", parent, "missing"]), 1, "FileNotFound");
    result(direct(i, opener, ["directory", parent, "missing"]), 1, "FileNotFound");
    result(direct(i, opener, ["file", parent, "file/child"]), 1, "NotDir");
    result(direct(i, opener, ["file", parent, "x".repeat(256)]), 1, "NameTooLong");
    result(direct(i, opener, ["directory", parent, "file"]), 1, "NotDir");
    result(direct(i, opener, ["file", parent, "file"]), 0);
    result(direct(i, opener, ["directory", parent, "directory"]), 0);
    writeFileSync(join(parent, "denied"), "private", { mode: 0o000 }); mkdirSync(join(parent, "denied-dir"), { mode: 0o000 });
    try {
        result(direct(i, opener, ["file", parent, "denied"]), 1, "AccessDenied");
        result(direct(i, opener, ["directory", parent, "denied-dir"]), 1, "AccessDenied");
    } finally { chmodSync(join(parent, "denied"), 0o600); chmodSync(join(parent, "denied-dir"), 0o700); }
    const fifo = join(parent, "fifo");
    expect(spawnSync("/usr/bin/mkfifo", [fifo]).status).toBe(0);
    result(direct(i, opener, ["file", parent, "fifo"]), 1, "InvalidFile"); // NONBLOCK, not a hanging pipe read.
    expect(readFileSync(sentinel, "utf8")).toBe("outside KEEP");
});

test("FBSD-NOFOLLOW ZIP standalone rejects linked staging, traversal/link entries and wrong root type", () => {
    const i = fixture(), archive = join(i.home, "good.zip"), external = join(i.home, "external");
    mkdirSync(external); writeFileSync(join(external, "sentinel"), "KEEP"); const before = sha(join(external, "sentinel"));
    writeZip(archive, [{ name: "safe", data: Buffer.from("new"), mode: 0o644 }]);
    const linked = join(i.home, "linked-stage"); symlinkSync(external, linked);
    result(direct(i, zipper, [archive, linked]), 1, process.platform === "freebsd" ? "SymLinkLoop" : "NotDir");
    expect(readdirSync(external)).toEqual(["sentinel"]); expect(sha(join(external, "sentinel"))).toBe(before);
    const plain = join(i.home, "plain"); writeFileSync(plain, "plain"); result(direct(i, zipper, [archive, plain]), 1, "NotDir");
    result(direct(i, zipper, [join(i.home, "absent.zip"), join(i.home, "missing-stage")]), 1, "FileNotFound");
    const good = join(i.home, "good-stage"); result(direct(i, zipper, [archive, good]), 0); expect(readFileSync(join(good, "safe"), "utf8")).toBe("new");
    for (const fault of ["traversal", "link"]) {
        const bad = join(i.home, `${fault}.zip`), name = "../external/sentinel", placeholder = "x".repeat(name.length);
        writeZip(bad, [{ name: placeholder, data: Buffer.from("overwrite"), mode: 0o644 }]); let bytes = readFileSync(bad);
        if (fault === "traversal") bytes = Buffer.from(bytes.toString("latin1").replaceAll(placeholder, name), "latin1");
        else for (let at = 0; at < bytes.length - 46; at++) if (bytes.readUInt32LE(at) === 0x02014b50) bytes.writeUInt32LE((0o120777 << 16) >>> 0, at + 38);
        writeFileSync(bad, bytes); result(direct(i, zipper, [bad, join(i.home, `${fault}-stage`)]), 1, fault === "traversal" ? "UnsafeEntryName" : "UnsupportedEntry");
        expect(sha(join(external, "sentinel"))).toBe(before);
    }
});

test("FBSD-NOFOLLOW seeded store: linked metadata/store, actual copy and failures stay unpublished", () => {
    const i = fixture(), outside = join(i.home, "outside"); mkdirSync(outside); const sentinel = join(outside, "sentinel"); writeFileSync(sentinel, "KEEP");
    symlinkSync(sentinel, join(i.dir, ".dsh-manager-install.json")); result(run(i, ["--version"]), 1, "SymLinkLoop"); rmSync(join(i.dir, ".dsh-manager-install.json"));
    const marker = join(i.dir, ".dsh-manager-install.json");
    mkdirSync(marker); result(run(i, ["--version"]), 1, "InvalidManagerFile"); rmSync(marker, { recursive: true });
    expect(spawnSync("/usr/bin/mkfifo", [marker]).status).toBe(0); result(run(i, ["--version"]), 1, "InvalidManagerFile"); rmSync(marker);
    linkSync(sentinel, marker); result(run(i, ["--version"]), 1, "InvalidManagerFile"); rmSync(marker);
    writeFileSync(marker, "denied", { mode: 0o000 }); result(run(i, ["--version"]), 1, "AccessDenied"); chmodSync(marker, 0o600); rmSync(marker);
    for (const kind of ["plugins", "config"]) {
        seedSnapshot(i, kind);
        const store = join(i.data, kind === "config" ? "config-snapshots" : "snapshots"), saved = `${store}.saved`;
        renameSync(store, saved); symlinkSync(outside, store);
        result(snapshot(i, kind, "list"), 1, directoryLinkError); rmSync(store); renameSync(saved, store);
        const first = snap(i, kind, 1), file = join(first, "profiles", "p", "content"); mkdirSync(join(first, "profiles", "p")); writeFileSync(file, "source");
        const copy = run(i, ["manager", "snapshot", kind, "new", "--use", ID], { env: { DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_CRASH: "snapshot-copied" } });
        result(copy, 86);
        const retained = readdirSync(store).filter(x => x.startsWith(".staging-")); expect(retained).toHaveLength(1);
        const copied = join(store, retained[0]!, "profiles", "p", "content");
        expect(readFileSync(copied, "utf8")).toBe("source"); expect(lstatSync(copied).ino).not.toBe(lstatSync(file).ino);
        writeFileSync(copied, "changed"); expect(readFileSync(file, "utf8")).toBe("source");
        expect(existsSync(snap(i, kind, 2))).toBe(false); // Real copy before publication, not successful publication proof.
        symlinkSync(sentinel, join(first, "profiles", "p", "leak")); result(snapshot(i, kind, "new", "--use", ID, "--target", `${ID}@1`), 1, kind === "plugins" ? "escapes profiles" : "UnsafeSnapshotFile");
        expect(existsSync(snap(i, kind, 3))).toBe(false); expect(readdirSync(store).filter(x => x.startsWith(".staging-"))).toEqual(retained);
        expect(readFileSync(sentinel, "utf8")).toBe("KEEP"); rmSync(join(first, "profiles", "p", "leak"));
        const failed = run(i, ["manager", "snapshot", kind, "new", "--use", ID], { env: { DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_FAIL: "snapshot-copy" } });
        result(failed, 1, "TestCopyFailed"); expect(existsSync(snap(i, kind, 4))).toBe(false);
        seedSnapshot(i, kind, 5);
        result(snapshot(i, kind, "remove", `${ID}@5`), 0); expect(existsSync(snap(i, kind, 5))).toBe(false); expect(existsSync(snap(i, kind, 1))).toBe(true);
    }
});

test("FBSD-NOFOLLOW removal/copy generation barriers retain outside sentinels", async () => {
    for (const kind of ["plugins", "config"]) {
        const i = fixture(); seedSnapshot(i, kind);
        const first = snap(i, kind, 1), file = join(first, "profiles", "p", "content"); mkdirSync(join(first, "profiles", "p")); writeFileSync(file, "source");
        const outside = join(i.home, "outside"); mkdirSync(outside); const sentinel = join(outside, "content"); writeFileSync(sentinel, "KEEP");
        const copy = await paused(i, ["manager", "snapshot", kind, "new", "--use", ID], "snapshot-file-copied", () => { renameSync(file, `${file}.held`); symlinkSync(sentinel, file); });
        expect(copy.status, copy.stderr).toBe(1); expect(copy.stderr).toContain("SnapshotChanged"); expect(existsSync(snap(i, kind, 2))).toBe(false); expect(readFileSync(sentinel, "utf8")).toBe("KEEP");
        rmSync(file); renameSync(`${file}.held`, file);
        const remove = await paused(i, ["manager", "snapshot", kind, "remove", `${ID}@1`], "snapshot-remove", () => { renameSync(first, `${first}.held`); symlinkSync(outside, first); });
        expect(remove.status, remove.stderr).toBe(1); expect(remove.stderr).toContain("SnapshotChanged"); expect(readFileSync(sentinel, "utf8")).toBe("KEEP"); expect(existsSync(join(`${first}.held`, "snapshot.json"))).toBe(true);
    }
});

test("FBSD-NOFOLLOW cleanup linked root keeps outside data with honest link error", () => {
    const i = fixture(), outside = join(i.home, "outside"); mkdirSync(outside); writeFileSync(join(outside, "sentinel"), "KEEP");
    renameSync(i.data, `${i.data}.held`); symlinkSync(outside, i.data);
    result(run(i, ["manager", "clean"]), 1, directoryLinkError); expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("KEEP");
});

test("FBSD-NOFOLLOW update linked tmp refuses; FBSD-PUBLISH recovery gate remains explicit", async () => {
    const i = fixture(), outside = join(i.home, "outside"); mkdirSync(outside); writeFileSync(join(outside, "sentinel"), "KEEP");
    symlinkSync(outside, join(i.data, "tmp"));
    const NEXT = "1.0.0-b2.1.gemlink", meta = bundleMeta(NEXT, { patch: { target: host } });
    const archive = join(i.home, "update.zip");
    writeZip(archive, [{ name: "bundle.json", data: Buffer.from(JSON.stringify(meta)), mode: 0o644 }, { name: "dsh-native", data: readFileSync(manager), mode: 0o755 }]);
    const bytes = readFileSync(archive);
    const entry = { kind: "dsh-runtime", tag: `runtime-v${NEXT}`, id: NEXT, channel: "release", upstream: meta.upstream, run: meta.run, attempt: meta.attempt, launchProtocol: 2, builderCommit: meta.builderCommit, addons: { office: { slot: null, pinned: null } }, assets: { [host]: { name: `runtime-${host}.zip`, size: bytes.length, sha256: sha(archive) } }, seq: 1 };
    let downloads = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
        if (new URL(req.url).pathname === "/runtime-index.json") return Response.json({ schema: 1, channels: { release: [entry], live: [] }, addons: { office: [] } });
        downloads++; return new Response(bytes);
    } });
    try {
        const p = Bun.spawn([i.exe, "manager", "update"], { cwd: i.home, env: { ...baseEnv(i), DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_ORIGIN: `http://127.0.0.1:${server.port}` }, stdout: "pipe", stderr: "pipe" });
        const timer = setTimeout(() => p.kill("SIGKILL"), 15000);
        try {
            const [status, stderr] = await Promise.all([p.exited, new Response(p.stderr).text(), new Response(p.stdout).text()]);
            expect(status, stderr).toBe(1); expect(stderr).toContain(directoryLinkError); expect(stderr).not.toContain("Unexpected");
        } finally { clearTimeout(timer); if (p.exitCode === null) { p.kill("SIGKILL"); await p.exited; } }
        expect(downloads).toBe(0); expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("KEEP"); expect(existsSync(join(i.data, "bundles", NEXT))).toBe(false);
        // Removing only test's obstruction restores ordinary update behavior; native file bytes remain opaque, never launched.
        rmSync(join(i.data, "tmp"));
        const next = Bun.spawn([i.exe, "manager", "update"], { cwd: i.home, env: { ...baseEnv(i), DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_ORIGIN: `http://127.0.0.1:${server.port}` }, stdout: "pipe", stderr: "pipe" });
        const nextTimer = setTimeout(() => next.kill("SIGKILL"), 15000);
        try {
            const [code, diagnostic] = await Promise.all([next.exited, new Response(next.stderr).text(), new Response(next.stdout).text()]);
            expect(code, diagnostic).toBe(0);
        } finally { clearTimeout(nextTimer); if (next.exitCode === null) { next.kill("SIGKILL"); await next.exited; } }
        expect(downloads).toBe(1); expect(sha(join(i.data, "bundles", NEXT, "dsh-native"))).toBe(sha(manager));
        expect(existsSync(join(i.data, "bundles", ID))).toBe(true); expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("KEEP");
    } finally { server.stop(true); }
});

test("FBSD-NOFOLLOW candidate deletion pins file generation and refuses replacement bytes", async () => {
    const name = ".dsh-manager-candidate-9.9.9.part-abcd";
    const ordinary = fixture(); cpSync(manager, join(ordinary.dir, name));
    result(run(ordinary, ["manager", "clean"]), 0); expect(existsSync(join(ordinary.dir, name))).toBe(false);
    const i = fixture(), candidate = join(i.dir, name); cpSync(manager, candidate);
    const changed = await paused(i, ["manager", "clean"], "candidate-clean-delete", () => {
        renameSync(candidate, `${candidate}.held`); cpSync(manager, candidate);
    });
    expect(changed.status, changed.stderr).toBe(0); expect(changed.stderr).toContain("identity changed");
    expect(sha(candidate)).toBe(sha(manager)); expect(sha(`${candidate}.held`)).toBe(sha(manager));
});
