// Opt-in FreeBSD CLI gate. No compiler, application launch, fake-native or ordinary test discovery.
// bun path.native.mjs <owned-root> <installed-manager> <installed-roots.json> <binding.json>
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const sha = p => createHash("sha256").update(readFileSync(p)).digest("hex");
const scopes = ["self", "home", "runtime", "snapshot", "addon", "cache", "tmp", "completion"];

// lstat only: never read config, credentials, rc or application bodies for tree comparison.
function tree(path) {
    if (!existsSync(path)) return [];
    const out = [];
    function visit(p, name) {
        const s = lstatSync(p, { bigint: true });
        out.push([name, ...["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs"].map(k => String(s[k])), s.isSymbolicLink() ? readlinkSync(p) : null]);
        if (s.isDirectory()) for (const n of readdirSync(p).sort()) visit(join(p, n), join(name, n));
    }
    visit(path, "."); return out;
}
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Fixed FreeBSD15.1 kdump -d -t cn contract, one process, complete exec-to-exit capture.
const loaderFiles = ["/etc/libmap.conf", "/var/run/ld-elf.so.hints", "/lib/libthr.so.3", "/lib/libc.so.7", "/lib/libsys.so.7"];
export function auditIdentity(exe, installed, fixtureRoot, cwd) {
    const data = join(dirname(exe), "dsh-bin"), negative = exe === join(fixtureRoot, "negative/dsh");
    return { exe, data, cwd, runtimes: [installed.id, ...(negative ? [`${installed.id}.duplicate`] : [])], snapshots: { plugins: [installed.selection.snapshot], config: [installed.selection.configSnapshot] } };
}
export function audit(text, identity, expectedExit) {
    const { exe, data, cwd, runtimes, snapshots } = identity;
    assert.ok([exe, data, cwd].every(isAbsolute)); assert.equal(data, join(dirname(exe), "dsh-bin"));
    assert.ok([0, 1].includes(expectedExit));
    const dirs = new Set([dirname(exe), data, join(data, "state"), join(data, "bundles"), join(data, "snapshots"), join(data, "config-snapshots"), join(data, "addons"), join(data, "addons/office")]);
    const metadata = new Set([join(dirname(exe), ".dsh-manager-install.json"), join(data, ".dsh-bin-data.json"), ...["selection.json", "channel", "completion.json"].map(n => join(data, "state", n))]);
    for (const id of runtimes) { const p = join(data, "bundles", id); dirs.add(p); metadata.add(join(p, "bundle.json")); }
    for (const [kind, ids] of Object.entries(snapshots)) for (const id of ids) { const p = join(data, kind === "plugins" ? "snapshots" : "config-snapshots", id); dirs.add(p); metadata.add(join(p, "snapshot.json")); }
    const arity = { execve: 3, mmap: 6, mprotect: 3, issetugid: 0, sigfastblock: 2, open: 2, fstat: 2, read: 3, close: 1, pread: 4, munmap: 2, sysarch: 2, exterrctl: 3, readlink: 3, cpuset_getaffinity: 5, thr_self: 1, rtprio_thread: 3, sigaction: 3, sigprocmask: 3, _umtx_op: 5, thr_wake: 1, getpid: 0, getcontext: 1, __sysctl: 6, openat: 3, fcntl: 3, fstatat: 4, pwritev: 4, pwrite: 4, writev: 3, _exit: 1, lseek: 3, getdirentries: 4, faccessat: 4, write: 3 };
    const symbols = { "openat:0": "AT_FDCWD", "fstatat:0": "AT_FDCWD", "faccessat:0": "AT_FDCWD", "sysarch:0": "AMD64_SET_TLSBASE AMD64_GET_TLSBASE AMD64_GET_XFPUSTATE", "rtprio_thread:0": "RTP_LOOKUP", "sigprocmask:0": "SIG_UNBLOCK SIG_BLOCK SIG_SETMASK", "sigaction:0": "SIGPIPE SIGTHR", "lseek:2": "SEEK_SET" };
    const flagGroups = { "mmap:2": "PROT_", "mmap:3": "MAP_", "mprotect:2": "PROT_", "open:1": "O_", "openat:2": "O_", "fstatat:3": "AT_", "faccessat:2": "F_", "_umtx_op:1": "UMTX_OP_" };
    const flags = new Set("AT_SYMLINK_NOFOLLOW F_OK MAP_ANON MAP_GUARD MAP_PRIVATE MAP_FIXED MAP_NOCORE MAP_PREFAULT_READ MAP_ALIGNED_12 MAP_ALIGNED_21 O_RDONLY O_CLOEXEC O_VERIFY O_DIRECTORY O_NOFOLLOW O_NONBLOCK PROT_NONE PROT_READ PROT_EXEC PROT_WRITE UMTX_OP_WAKE".split(" "));
    assert.ok(text.endsWith("\n"), "truncated trace line");
    const lines = text.slice(0, -1).split("\n"), calls = [];
    let pending, pid, exited = false;
    for (const [i, line] of lines.entries()) {
        const m = line.match(/^\s*(\d+)\s+(ktrace|dsh)\s+(CALL|NAMI|RET)\s+(.+)$/);
        assert.ok(m, `unknown/malformed/dropped trace record: ${line}`);
        const [, p, comm, type, body] = m;
        if (i === 0) { assert.equal(comm, "ktrace"); assert.equal(type, "RET"); assert.equal(body, "ktrace 0"); pid = p; continue; }
        assert.equal(p, pid, "unexpected process"); assert.ok(!exited, "record after terminal exit");
        if (type === "CALL") {
            assert.equal(pending, undefined, "missing syscall return");
            const c = body.replace(/MAP_ALIGNED\((12|21)\)/g, "MAP_ALIGNED_$1").match(/^(\w+)(?:\(([^()]*)\))?$/); assert.ok(c, "malformed syscall");
            const [, name, args = ""] = c; assert.ok(Object.hasOwn(arity, name), `unneeded/unsafe syscall: ${name}`);
            assert.equal(comm, calls.length === 0 ? "ktrace" : "dsh");
            assert.equal(name === "execve", calls.length === 0, "initial/extra exec");
            const values = args ? args.split(",") : [];
            assert.equal(values.length, arity[name], "malformed syscall arguments");
            for (const [index, value] of values.entries()) {
                const position = `${name}:${index}`;
                if ((symbols[position] ?? "").split(" ").includes(value) || (name === "fcntl" && index === 1 && /^F_[A-Z0-9_]+$/.test(value))) continue;
                const number = value.match(/^(?:-?\d+|0x[0-9a-f]+)(?:<([A-Z0-9_|]+)>)?$/);
                assert.ok(number, "unparsed syscall argument");
                if (number[1]) for (const flag of number[1].split("|")) assert.ok(flagGroups[position] && flag.startsWith(flagGroups[position]) && flags.has(flag), "unparsed syscall flags/position");
            }
            pending = { name, body, args: values, paths: [] }; calls.push(pending);
            if (name === "_exit") { assert.equal(body, `_exit(${expectedExit})`, "terminal manager status"); exited = true; pending = undefined; }
        } else if (type === "NAMI") {
            assert.ok(pending, "orphan namei"); const path = JSON.parse(body); assert.equal(typeof path, "string");
            assert.equal(comm, pending.name === "execve" ? "ktrace" : "dsh"); pending.paths.push(path);
        } else {
            assert.equal(comm, "dsh"); assert.ok(pending, "orphan return");
            const r = body.match(/^(\w+) (JUSTRETURN|-1 errno \d+ [A-Za-z ]+|\d+(?:\/0x[0-9a-f]+)?)$/); assert.ok(r, "malformed return");
            assert.equal(r[1], pending.name, "return does not match syscall");
            const nameiCount = { execve: 2, open: 1, openat: 1, readlink: 1, __sysctl: 1, fstatat: 1, faccessat: 1 };
            assert.equal(pending.paths.length, nameiCount[pending.name] ?? 0, "missing/unexpected namei records");
            if (pending.name === "__sysctl") assert.equal(pending.paths[0], exe, "unexpected executable sysctl lookup");
            if (pending.name === "execve") { assert.equal(r[2], "JUSTRETURN"); assert.deepEqual(pending.paths, [exe, "/libexec/ld-elf.so.1"]); }
            else assert.notEqual(r[2], "JUSTRETURN", "unexpected special return");
            if (r[2].includes("/0x")) { const [decimal, hex] = r[2].split("/"); assert.equal(BigInt(decimal), BigInt(hex), "inconsistent numeric return"); }
            pending.result = r[2].startsWith("-1 ") ? -1 : Number.parseInt(r[2], 10); pending = undefined;
        }
    }
    assert.ok(exited && pending === undefined && calls.length > 1, "incomplete exec-to-exit trace");
    const fds = new Map(), originalOutput = new Set([1, 2]), opens = [], loaderOpens = [];
    let startup = true;
    const pathFor = (c, p) => {
        if (isAbsolute(p)) return resolve(p);
        const parent = c.name === "openat" ? c.args[0] : "AT_FDCWD";
        const base = parent === "AT_FDCWD" ? cwd : fds.get(Number(parent))?.directory;
        assert.ok(base, "relative open without owned parent descriptor"); return resolve(base, p);
    };
    for (const c of calls) {
        if (c.name === "fcntl") assert.match(c.body, /^fcntl\(\d+,F_KINFO,\d+\)$/, "unneeded fcntl command");
        if (c.name === "close") { const fd = Number(c.args[0]); originalOutput.delete(fd); fds.delete(fd); }
        if (/^(write|writev|pwrite|pwritev)$/.test(c.name)) assert.ok(originalOutput.has(Number(c.args[0])), "write outside original stdout/stderr");
        if (/^(open|openat)$/.test(c.name)) {
            const openFlags = c.args[c.name === "openat" ? 2 : 1];
            assert.match(openFlags, /O_RDONLY/, "unparsed readonly flags");
            assert.ok(!/O_(WRONLY|RDWR|CREAT|TRUNC|APPEND|EXLOCK|SHLOCK)/.test(openFlags), "write/lock open");
            assert.equal(c.paths.length, 1, "open namei coverage");
            const p = pathFor(c, c.paths[0]), directory = /O_DIRECTORY/.test(openFlags); opens.push(p);
            if (p === exe && !directory) startup = false;
            else if (startup && !directory && loaderFiles.includes(p)) loaderOpens.push(p);
            else if (startup && directory && p === "/usr/local/etc/libmap.d") { /* fixed loader search directory */ }
            else assert.ok(directory ? dirs.has(p) : metadata.has(p), `unowned manager ${directory ? "directory" : "metadata"}: ${p}`);
            if (c.result >= 0) { assert.ok(c.result > 2, "open rebound original output"); fds.set(c.result, { path: p, directory: directory ? p : null }); }
        }
        if (/^(read|pread|getdirentries)$/.test(c.name)) {
            const owner = fds.get(Number(c.args[0])); assert.ok(owner, "read without owned descriptor");
            if (c.name === "getdirentries") assert.ok(owner.directory, "inventory on non-directory descriptor");
        }
    }
    return { syscallCount: calls.length, pids: [pid], execs: 1, opens, loaderOpens, terminalExit: expectedExit };
}
export function selfCheck() {
    const identity = { exe: "/fixture/dsh", data: "/fixture/dsh-bin", cwd: "/fixture/home", runtimes: ["v1"], snapshots: { plugins: ["v1@1"], config: ["v1@1"] } };
    const head = ' 1 ktrace RET ktrace 0\n 1 ktrace CALL execve(0,0,0)\n 1 ktrace NAMI "/fixture/dsh"\n 1 ktrace NAMI "/libexec/ld-elf.so.1"\n 1 dsh RET execve JUSTRETURN\n';
    const end = ' 1 dsh CALL _exit(0)\n';
    assert.equal(audit(head + end, identity, 0).execs, 1);
    const output = ' 1 dsh CALL pwritev(1,0,1,0)\n 1 dsh RET pwritev -1 errno 29 Illegal seek\n 1 dsh CALL writev(1,0,1)\n 1 dsh RET writev 1\n 1 dsh CALL write(2,0,1)\n 1 dsh RET write 1\n';
    audit(head + output + end, identity, 0);
    for (const extra of ['Events dropped.\n', ' 1 dsh WHAT unknown\n', ' 1 dsh PSIG SIGTERM\n']) assert.throws(() => audit(head + extra + end, identity, 0));
    for (const body of ['fcntl(3,F_OSETLK,0)', 'fcntl(3,F_DUP2FD,1)', 'fcntl(3,F_DUP2FD_CLOEXEC,2)', 'pwritev(3,0,1,0)', 'dup2(3,2)', 'fork', 'socket(2,1,0)']) assert.throws(() => audit(head + ` 1 dsh CALL ${body}\n 1 dsh RET ${body.split('(')[0]} 0\n` + output + end, identity, 0));
    assert.throws(() => audit(head, identity, 0));
    assert.throws(() => audit(head + ' 1 dsh CALL close(1)\n 1 dsh RET close 0\n' + output + end, identity, 0));
}

// Expectations derive only from declared fixtures and CLI contract, never query output.
export function expectedReport(c, installed, fixtureRoot) {
    const cold = c.exe === join(fixtureRoot, "empty/dsh"), copied = c.exe === join(fixtureRoot, "negative/dsh");
    const data = join(dirname(c.exe), "dsh-bin"), scope = c.scope[0] ?? "overview", overview = scope === "overview";
    const records = [], diagnostics = [];
    const add = (role, path, status, source, reason, patch = {}) => records.push({ role, path, status, source, reason, kind: null, id: null, version: null, slot: null, ...patch });
    const status = exists => exists ? "exists" : "not-created";
    const dir = (role, relative, exists, source, reason, patch) => add(role, join(data, relative), status(exists), source, reason, patch);
    const name = c.name.replace(/-(json|human)$/, "");
    const snapshotRoot = kind => kind === "plugins" ? "snapshots" : "config-snapshots";
    const snapshotId = kind => installed.selection[kind === "plugins" ? "snapshot" : "configSnapshot"];
    if (overview || scope === "self") {
        add("self.executable", c.exe, "exists", "real-executable", "resolved executable, not the invocation symlink or cwd");
        dir("self.data", "", !cold, "executable-adjacent", "portable");
        dir("self.state", "state", !cold, "manager-data", "manager state, not application configuration");
    }
    if (overview || scope === "home") dir("home", "home", false, "manager-data-default", "non-configuration application home; no configuration/credential fallback");
    if (overview) {
        dir("runtime.root", "bundles", !cold, "manager-data", "installed runtime inventory");
        for (const kind of ["config", "plugins"]) dir("snapshot.root", snapshotRoot(kind), !cold, "manager-data", "typed snapshot inventory, independent of application home", { kind });
    }
    if (overview || scope === "addon") dir("addon.root", "addons", false, "manager-data", "local addon inventory");
    if (overview || scope === "cache") {
        dir("cache.manager", "cache", !cold && !copied, "manager-data", "manager cache");
        dir("cache.app-default", "home/cache", false, "application-default", "default only; custom plugin caches are not discovered");
        for (const [id, path] of [["BUN_INSTALL_CACHE_DIR", "cache/bun"], ["BUN_RUNTIME_TRANSPILER_CACHE_PATH", "cache/transpiler"], ["PNPM_HOME", "cache/pnpm/home"], ["npm_config_cache", "cache/npm"], ["pnpm_config_cache_dir", "cache/pnpm/cache"], ["pnpm_config_store_dir", "cache/pnpm/store"]]) dir("cache.controlled", path, !cold && !copied, "launch-controlled", "controlled launch cache; no environment dump", { id });
    }
    if (overview || scope === "tmp") dir("tmp", "tmp", !cold && !copied, "manager-data", "manager work root; ongoing transactions are not enumerated or authorized for deletion");
    if (scope === "runtime") {
        dir("runtime.root", "bundles", !cold, "manager-data", "installed local runtimes");
        if (!cold && !name.startsWith("invalid-") && !name.startsWith("ambiguous-")) add("runtime", join(data, "bundles", installed.id), "exists", "local-inventory", "installed runtime", { id: installed.id, version: installed.id });
    }
    if (scope === "snapshot") for (const kind of ["config", "plugins"]) {
        if (c.scope[1] && c.scope[1] !== kind) continue;
        dir("snapshot.root", snapshotRoot(kind), !cold, "manager-data", "typed local snapshot inventory", { kind });
        if (!cold && !name.startsWith("invalid-")) add("snapshot", join(data, snapshotRoot(kind), snapshotId(kind)), "exists", "local-inventory", "snapshot remains queryable without its runtime", { kind, id: snapshotId(kind), version: installed.id });
    }
    if (scope === "completion" && !name.startsWith("invalid-")) {
        const legacy = name === "legacy-completion-unknown-no-rc-read";
        for (const shell of legacy ? ["bash"] : ["bash", "fish", "powershell", "pwsh", "zsh"]) for (const role of ["completion.registration", "completion.script"]) add(role, null, legacy ? "unknown" : "not-created", "recorded-registration", legacy ? "registration-path-not-recorded" : "not-registered", { id: shell });
    }
    const errors = {
        "invalid-runtime-missing": ["target-not-found", "runtime", "explicit runtime is not installed"],
        [`invalid-snapshot-config-${installed.id}@99`]: ["invalid-target", "snapshot", "SnapshotNotFound"],
        "invalid-addon-office:missing": ["target-not-found", "addon", "explicit addon version is not installed"],
        "invalid-completion-unknown": ["invalid-target", "completion", "unsupported completion shell"],
        "invalid-explicit-use-no-fallback": ["not_installed", "effective", "runtime intent cannot be resolved; no fallback or initialization"],
        "invalid-explicit-snapshot-no-fallback": ["invalid-snapshot-reference", "snapshot", "SnapshotNotFound"],
        "ambiguous-runtime-inventory": ["ambiguous-target", "runtime", "runtime prefix is ambiguous"],
        "ambiguous-explicit-use-no-fallback": ["ambiguous", "effective", "runtime intent cannot be resolved; no fallback or initialization"],
        "malformed-selection": ["invalid-selection", "selection", "cannot parse persistent selection; no fallback", join(data, "state/selection.json")],
        "legacy-completion-unknown-no-rc-read": ["completion-path-unrecorded", "completion.registration", "historical registration has no recorded location; not guessed"]
    };
    const error = errors[name];
    if (error) { const [code, role, message, path = null] = error; diagnostics.push({ code, role, path, message }); }
    let effective = null;
    if (overview) {
        effective = { status: error ? "unresolved" : cold ? "empty" : "resolved", runtime: null, plugins: null, config: null, addons: { office: null }, reason: error ? error[0] : cold ? "no-installed-runtime" : null };
        if (!cold && !error) {
            effective.runtime = { id: installed.id, path: join(data, "bundles", installed.id), source: "persistent-use" };
            for (const kind of ["plugins", "config"]) effective[kind] = { id: snapshotId(kind), path: join(data, snapshotRoot(kind), snapshotId(kind)), source: "persistent-snapshot" };
        }
    }
    const key = r => [r.role, r.kind ?? "", r.id ?? "", r.path ?? ""].join("\0");
    records.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
    return { schemaVersion: 1, scope, complete: !error, records, effective, diagnostics };
}
export function pathCases(installed, root, manager) {
    const cases = [], empty = join(root, "empty/dsh"), negative = join(root, "negative/dsh");
    const add = (name, exe, scope, status = 0, leading = []) => { for (const format of ["json", "human"]) cases.push({ name: `${name}-${format}`, exe, scope, status, leading, format }); };
    for (const [name, exe] of [["empty", empty], ["installed", manager]]) for (const scope of [[], ...scopes.map(s => [s])]) add(`${name}-${scope[0] ?? "overview"}`, exe, scope);
    add("runtime-exact", manager, ["runtime", installed.id]);
    for (const kind of ["plugins", "config"]) add(`snapshot-${kind}-exact`, manager, ["snapshot", kind, installed.selection[kind === "plugins" ? "snapshot" : "configSnapshot"]]);
    for (const scope of [["runtime", "missing"], ["snapshot", "config", `${installed.id}@99`], ["addon", "office:missing"], ["completion", "unknown"]]) add(`invalid-${scope.join("-")}`, manager, scope, 1);
    add("invalid-explicit-use-no-fallback", manager, [], 1, ["--use", "missing"]);
    add("invalid-explicit-snapshot-no-fallback", manager, [], 1, ["--config-snapshot", `${installed.id}@99`]);
    add("copied-genuine-selection", negative, []);
    add("ambiguous-runtime-inventory", negative, ["runtime", "0.2"], 1);
    add("ambiguous-explicit-use-no-fallback", negative, [], 1, ["--use", "0.2"]);
    add("malformed-selection", negative, [], 1);
    add("malformed-selection-self-still-inventory", negative, ["self"]);
    add("empty-kind-unresolved-selection", negative, ["addon"]);
    add("legacy-completion-unknown-no-rc-read", negative, ["completion", "bash"], 1);
    add("offline-installed-overview", manager, []);
    return cases;
}

export function assertResult(c, result, installed, fixtureRoot) {
    const expected = expectedReport(c, installed, fixtureRoot);
    assert.equal(result.status, expected.complete ? 0 : 1, "expected command status");
    assert.ok(!/NATIVE-PATH-PRIVATE-SENTINEL|\u001b/.test(result.stdout + result.stderr));
    if (c.format === "json") { assert.equal(result.stderr, ""); assert.deepEqual(JSON.parse(result.stdout), expected, "expected JSON fields"); }
    else {
        let stdout = expected.records.map(r => `${r.role} ${r.path ?? "unknown"} [${r.status}] source=${r.source} ${r.id ?? ""} ${r.reason}\n`).join("");
        if (expected.effective) {
            const e = expected.effective; stdout += `effective: ${e.status} ${e.reason ?? ""}\n`;
            for (const key of ["runtime", "plugins", "config"]) if (e[key]) { const r = e[key]; stdout += `  ${key}: ${r.id} ${r.path} (${r.source})\n`; }
        }
        const stderr = expected.diagnostics.map(d => `dsh: path ${d.code}: ${d.path ?? ""} ${d.message}\n`).join("");
        assert.equal(result.stdout, stdout, "expected human fields/selection explanation"); assert.equal(result.stderr, stderr, "expected human diagnostics");
    }
}

async function nativeMain() {
    const [root, manager, receipt, bindingFile] = process.argv.slice(2);
    const save = (name, value) => writeFileSync(join(root, name), JSON.stringify(value, null, 2) + "\n");
    const manifest = { scope: "FreeBSD 15.1 amd64 ordinary manager path only; not application/service/full-8.5 acceptance", cases: [], audit: "ktrace -i -t cn; kdump -d -t cn; initial manager exec only; no content dumps", status: "NOTRUN" };
    let oldBefore, oldRoot, server, requests = 0, activeCase;
    async function child(argv, env, cwd) {
        const p = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
        const timer = setTimeout(() => { if (p.exitCode === null) p.kill("SIGKILL"); }, 20000);
        try {
            const [status, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
            assert.equal(p.signalCode, null, "timeout/signal"); return { status, stdout, stderr };
        } finally { clearTimeout(timer); }
    }
    try {
        assert.equal(process.platform, "freebsd"); assert.equal(process.arch, "x64"); assert.equal(process.getuid(), 1001);
        assert.equal(Bun.version, "1.4.2");
        for (const p of [root, manager, receipt, bindingFile]) assert.ok(p && isAbsolute(p));
        assert.ok(["/var/tmp/dsh-freebsd-native-path", "/var/tmp/dsh-freebsd-native-path/recheck", "/var/tmp/dsh-freebsd-native-path/final"].includes(root));
        assert.ok(!existsSync(join(root, "empty")), "fresh owned fixtures required; never retry over previous evidence");
        selfCheck(); manifest.selfChecks = "PASS: extra exec, fork, socket, locks, write, sensitive open, empty trace rejected";
        const installed = JSON.parse(readFileSync(receipt, "utf8")), binding = JSON.parse(readFileSync(bindingFile, "utf8"));
        assert.equal(sha(manager), binding.managerSha256);
        assert.equal(sha(join(installed.roots.R, "dsh-native")), binding.runtimeSha256);
        assert.equal(sha(join(installed.roots.R, "bundle.json")), binding.bundleMetaSha256);
        const meta = JSON.parse(readFileSync(join(installed.roots.R, "bundle.json"), "utf8"));
        assert.equal(meta.id, installed.id); assert.equal(meta.builderCommit, binding.builderCommit); assert.equal(meta.target, "freebsd-x64");
        assert.equal(meta.id, binding.id); assert.equal(meta.entry, "dsh-native"); assert.equal(meta.launchProtocol, 2);
        for (const [kind, folder, key] of [["P", "snapshots", "snapshot"], ["C", "config-snapshots", "configSnapshot"]]) {
            assert.equal(installed.roots[kind], join(installed.data, folder, installed.selection[key]));
            assert.equal(JSON.parse(readFileSync(join(installed.roots[kind], "snapshot.json"), "utf8")).id, installed.selection[key]);
        }
        assert.deepEqual(JSON.parse(readFileSync(join(installed.data, "state/selection.json"), "utf8")), installed.selection);
        oldRoot = dirname(manager); oldBefore = tree(oldRoot); save("old-before.json", oldBefore);
        assert.deepEqual(Object.keys(binding.loaderSha256).sort(), [...loaderFiles, "/libexec/ld-elf.so.1"].sort());
        for (const [p, expected] of Object.entries(binding.loaderSha256)) { assert.equal(lstatSync(p).uid, 0); assert.equal(sha(p), expected); }
        manifest.input = { manager, installed, binding, scriptSha256: sha(import.meta.path), helper: process.execPath, helperSha256: sha(process.execPath), receiptSha256: sha(receipt), bindingSha256: sha(bindingFile) };
        const env = { HOME: join(root, "home"), TMPDIR: join(root, "tmp"), XDG_CACHE_HOME: join(root, "cache"), PATH: "", NO_COLOR: "1", LC_ALL: "C" };
        for (const p of [env.HOME, env.TMPDIR, env.XDG_CACHE_HOME]) mkdirSync(p, { mode: 0o700 });
        for (const n of [".credentials.yaml", "settings.yaml", ".bashrc", ".zshrc"]) writeFileSync(join(env.HOME, n), "NATIVE-PATH-PRIVATE-SENTINEL\n", { mode: 0o600 });
        const empty = join(root, "empty"); mkdirSync(empty); copyFileSync(manager, join(empty, "dsh"));
        assert.equal(sha(join(empty, "dsh")), binding.managerSha256);
        assert.notEqual(lstatSync(join(empty, "dsh")).ino, lstatSync(manager).ino);
        server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return new Response("unexpected query request", { status: 503 }); } });
        env.DSH_MANAGER_TEST = "1"; env.DSH_MANAGER_TEST_ORIGIN = `http://127.0.0.1:${server.port}`;
        assert.ok(!Object.keys(env).some(k => k.startsWith("LD_")), "no loader redirection in product environment");
        manifest.environment = env;
        const cases = pathCases(installed, root, manager);
        const prepare = (name, fn) => { const c = cases.find(c => c.name === `${name}-json`); assert.ok(c); c.prepare = fn; };
        // Minimal independent copies of genuine metadata/native bytes, not forged launch payloads.
        const negative = join(root, "negative"), data = join(negative, "dsh-bin");
        const setupNegative = () => {
            mkdirSync(negative); copyFileSync(manager, join(negative, "dsh")); mkdirSync(data);
            copyFileSync(join(installed.data, ".dsh-bin-data.json"), join(data, ".dsh-bin-data.json"));
            for (const [source, target, files] of [[installed.roots.R, join(data, "bundles", installed.id), ["bundle.json", "dsh-native", ".usage.lock"]], [installed.roots.P, join(data, "snapshots", installed.selection.snapshot), ["snapshot.json", ".usage.lock"]], [installed.roots.C, join(data, "config-snapshots", installed.selection.configSnapshot), ["snapshot.json", ".usage.lock"]]]) {
                mkdirSync(target, { recursive: true });
                for (const file of files) { copyFileSync(join(source, file), join(target, file)); assert.equal(sha(join(source, file)), sha(join(target, file))); assert.notEqual(lstatSync(join(source, file)).ino, lstatSync(join(target, file)).ino); }
            }
            mkdirSync(join(data, "state")); copyFileSync(join(installed.data, "state/selection.json"), join(data, "state/selection.json"));
            save("negative-copy-binding.json", { source: installed.roots, copiedRuntimeSha256: sha(join(data, "bundles", installed.id, "dsh-native")) });
        };
        prepare("copied-genuine-selection", setupNegative);
        prepare("ambiguous-runtime-inventory", () => {
            const target = join(data, "bundles", `${installed.id}.duplicate`); mkdirSync(target);
            for (const file of ["bundle.json", "dsh-native", ".usage.lock"]) copyFileSync(join(installed.roots.R, file), join(target, file));
            assert.equal(sha(join(target, "dsh-native")), binding.runtimeSha256);
        });
        prepare("malformed-selection", () => writeFileSync(join(data, "state/selection.json"), "broken"));
        prepare("legacy-completion-unknown-no-rc-read", () => writeFileSync(join(data, "state/completion.json"), JSON.stringify({ schema: 1, shells: { bash: { result: "registered" } } })));
        prepare("offline-installed-overview", () => server.stop(true));
        manifest.cases = cases.map(({ name, status, format }) => ({ name, expectedStatus: status, format, result: "NOTRUN" }));
        for (let n = 0; n < cases.length; n++) {
            const c = cases[n]; activeCase = manifest.cases[n];
            c.prepare?.();
            const before = { target: tree(dirname(c.exe)), home: tree(env.HOME), tmp: tree(env.TMPDIR), cache: tree(env.XDG_CACHE_HOME) };
            const requestsBefore = requests;
            const args = [...c.leading, "manager", "path", ...c.scope, ...(c.format === "json" ? ["--json"] : [])];
            const trace = join(root, `${c.name}.ktrace`), dump = join(root, `${c.name}.kdump`);
            const argv = ["/usr/bin/ktrace", "-i", "-t", "cn", "-f", trace, c.exe, ...args];
            const r = await child(argv, env, env.HOME);
            Object.assign(activeCase, { argv, env: "manifest.environment", cwd: env.HOME, ...r, trace, dump, requestsBefore });
            const decoded = await child(["/usr/bin/kdump", "-d", "-f", trace, "-t", "cn"], { PATH: "", LC_ALL: "C" }, root);
            assert.equal(decoded.status, 0, "audit capability unavailable/failed"); assert.equal(decoded.stderr, ""); writeFileSync(dump, decoded.stdout);
            activeCase.audit = audit(decoded.stdout, auditIdentity(c.exe, installed, root, env.HOME), c.status);
            await Bun.sleep(5); activeCase.requestsAfter = requests; assert.equal(requests, requestsBefore, "controlled origin request");
            const after = { target: tree(dirname(c.exe)), home: tree(env.HOME), tmp: tree(env.TMPDIR), cache: tree(env.XDG_CACHE_HOME) };
            activeCase.treeBeforeSha256 = digest(before); activeCase.treeAfterSha256 = digest(after); assert.deepEqual(after, before, "query mutated managed/private roots");
            assertResult(c, r, installed, root);
            if (c.format === "json") activeCase.json = JSON.parse(r.stdout);
            activeCase.traceSha256 = sha(trace); activeCase.dumpSha256 = sha(dump); activeCase.result = "PASS"; save("manifest.json", manifest);
            console.log(`PASS ${c.name}`);
        }
        manifest.status = "PASS";
    } catch (error) {
        manifest.status = "FAIL"; manifest.failure = String(error); if (activeCase) activeCase.result = "FAIL";
        console.error(manifest.failure); process.exitCode = 1;
    } finally {
        server?.stop(true); manifest.controlledRequests = requests;
        if (oldBefore) {
            const after = tree(oldRoot); save("old-after.json", after);
            manifest.oldRoot = { path: oldRoot, entries: oldBefore.length, beforeSha256: digest(oldBefore), afterSha256: digest(after), unchanged: digest(oldBefore) === digest(after) };
            if (!manifest.oldRoot.unchanged) { manifest.status = "FAIL"; process.exitCode = 1; }
        }
        if (root && existsSync(root)) save("manifest.json", manifest);
        console.log(JSON.stringify({ status: manifest.status, passed: manifest.cases.filter(c => c.result === "PASS").length, failed: manifest.cases.filter(c => c.result === "FAIL").length, notRun: manifest.cases.filter(c => c.result === "NOTRUN").length, oldRoot: manifest.oldRoot }));
    }
}
if (import.meta.main) await nativeMain();
