// Opt-in FreeBSD CLI gate. No compiler, application launch, fake-native or ordinary test discovery.
// bun path.native.mjs <owned-root> <installed-manager> <installed-roots.json> <binding.json>
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

const [root, manager, receipt, bindingFile] = process.argv.slice(2);
const sha = p => createHash("sha256").update(readFileSync(p)).digest("hex");
const save = (name, value) => writeFileSync(join(root, name), JSON.stringify(value, null, 2) + "\n");
const scopes = ["self", "home", "runtime", "snapshot", "addon", "cache", "tmp", "completion"];
const row = (v, role) => { const r = v.records.find(r => r.role === role); assert.ok(r, role); return r; };

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

// kdump -d -t cn: retain syscall/namei only; never I/O, argv or environment content dumps.
const loaderFiles = ["/etc/libmap.conf", "/var/run/ld-elf.so.hints", "/lib/libthr.so.3", "/lib/libc.so.7", "/lib/libsys.so.7"];
function audit(text, executable) {
    const calls = []; const pending = new Map(); const opens = []; const loaderOpens = [];
    let startup = true;
    const originalOutput = new Set([1, 2]);
    for (const line of text.split("\n")) {
        const m = line.match(/^\s*(\d+)\s+\S+\s+(CALL|NAMI)\s+(.*)$/);
        if (!m) continue;
        const [, pid, type, body] = m;
        if (type === "CALL") {
            const name = body.match(/^(\w+)/)?.[1]; assert.ok(name, "unparsed syscall");
            const c = { pid, name, body, paths: [] }; calls.push(c); pending.set(pid, c);
        } else {
            const c = pending.get(pid); assert.ok(c, "namei without syscall");
            c.paths.push(JSON.parse(body));
        }
    }
    const execs = calls.filter(c => /^(execve|fexecve|execveat)$/.test(c.name));
    assert.equal(execs.length, 1, "child/extra exec attempt");
    assert.ok(execs[0].paths.includes(executable), "initial exec identity");
    for (const c of calls) {
        assert.ok(!/^(fork|vfork|rfork|pdfork|posix_spawn|socket|socketpair|connect|bind|listen|accept|accept4|sendto|sendmsg|sendmmsg|recvfrom|recvmsg|recvmmsg|sctp_peeloff|sctp_generic_sendmsg|sctp_generic_sendmsg_iov)$/.test(c.name), `process/network attempt: ${c.name}`);
        assert.ok(!/^(flock|lockf|mkdir|mkdirat|unlink|unlinkat|rename|renameat|renameat2|link|linkat|symlink|symlinkat|truncate|ftruncate|chmod|fchmod|fchmodat|chown|fchown|lchown|mknod|mknodat|mkfifo|mkfifoat|utimes|futimes|futimesat|utimensat|chflags|fchflags)$/.test(c.name), `mutation/lock: ${c.name}`);
        if (c.name === "fcntl") assert.ok(!/F_(SETLK|SETLKW|OFD_SETLK|OFD_SETLKW)/.test(c.body), "fcntl lock");
        if (c.name === "close") originalOutput.delete(Number(c.body.match(/^close\((\d+)/)?.[1]));
        if (/^dup[23]$/.test(c.name)) originalOutput.delete(Number(c.body.match(/^dup[23]\([^,]+,(\d+)/)?.[1]));
        if (c.name === "closefrom") for (const fd of originalOutput) { if (fd >= Number(c.body.match(/\((\d+)/)?.[1])) originalOutput.delete(fd); }
        if (c.name === "close_range") {
            const m = c.body.match(/\((\d+),(\d+)/); assert.ok(m, "unparsed close_range");
            for (const fd of originalOutput) if (fd >= Number(m[1]) && fd <= Number(m[2])) originalOutput.delete(fd);
        }
        if (/^(write|writev|pwrite|pwritev)$/.test(c.name)) {
            const fd = Number(c.body.match(/\((\d+),/)?.[1]);
            assert.ok(originalOutput.has(fd), "write outside original stdout/stderr");
        }
        if (/^(open|openat|openat2)$/.test(c.name)) {
            assert.ok(!/O_(WRONLY|RDWR|CREAT|TRUNC|APPEND|EXLOCK|SHLOCK)/.test(c.body), "write/lock open");
            assert.ok(c.paths.length > 0, "open missing namei coverage");
            for (const p of c.paths) {
                opens.push(p);
                // Fixed FreeBSD ELF dependencies only, before context opens its own executable.
                if (p === executable) startup = false;
                else if (startup && loaderFiles.includes(p)) loaderOpens.push(p);
                else if (!/O_DIRECTORY/.test(c.body)) assert.ok([".dsh-manager-install.json", ".dsh-bin-data.json", "bundle.json", "snapshot.json", "selection.json", "channel", "completion.json"].includes(basename(p)), `non-metadata body open: ${p}`);
                assert.ok(!/credentials|settings\.ya?ml|(?:^|\/)\.(?:bashrc|zshrc|profile)$/.test(p), "sensitive body open");
            }
        }
    }
    return { syscallCount: calls.length, pids: [...new Set(calls.map(c => c.pid))], execs: execs.length, opens, loaderOpens };
}
function selfCheck() {
    const ok = ' 1 ktrace CALL execve(0)\n 1 ktrace NAMI "/manager"\n 1 dsh CALL openat(3,0,0x100000<O_RDONLY|O_CLOEXEC>)\n 1 dsh NAMI "bundle.json"\n';
    assert.equal(audit(ok, "/manager").execs, 1);
    for (const extra of [
        ' 1 dsh CALL execve(0)\n 1 dsh NAMI "/bin/sh"\n',
        ' 1 dsh CALL fork\n', ' 1 dsh CALL socket(2,1,0)\n', ' 1 dsh CALL flock(3,2)\n',
        ' 1 dsh CALL fcntl(3,F_SETLK,0)\n', ' 1 dsh CALL write(3,0,1)\n',
        ' 1 dsh CALL openat(3,0,0x601<O_WRONLY|O_CREAT|O_TRUNC>)\n 1 dsh NAMI "new"\n',
        ' 1 dsh CALL open(0,0<O_RDONLY>)\n 1 dsh NAMI ".credentials.yaml"\n'
    ]) assert.throws(() => audit(ok + extra, "/manager"));
    assert.throws(() => audit('', '/manager'));
    audit(ok + ' 1 dsh CALL pwritev(1,0,1,0)\n 1 dsh RET pwritev -1 errno 29 Illegal seek\n 1 dsh CALL writev(1,0,1)\n 1 dsh CALL write(2,0,1)\n 1 dsh CALL pwrite(2,0,1,0)\n', '/manager');
    for (const bad of ['pwrite(3,0,1,0)', 'pwritev(3,0,1,0)', 'close(1)\n 1 dsh CALL writev(1,0,1)', 'dup2(3,2)\n 1 dsh CALL pwritev(2,0,1,0)']) assert.throws(() => audit(ok + ` 1 dsh CALL ${bad}\n`, '/manager'));
    assert.throws(() => audit(ok + ' 1 dsh CALL open(0,0<O_RDONLY>)\n 1 dsh NAMI "/etc/other.conf"\n', '/manager'));
    assert.throws(() => audit(ok + ' 1 dsh CALL open(0,0<O_RDONLY>)\n 1 dsh NAMI "/manager"\n 1 dsh CALL open(0,0<O_RDONLY>)\n 1 dsh NAMI "/etc/libmap.conf"\n', '/manager'));
}

if (root === "--audit-replay") {
    selfCheck(); console.log(JSON.stringify({ selfChecks: "PASS", replay: manager, audit: audit(readFileSync(manager, "utf8"), receipt) })); process.exit(0);
}
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
    const cases = [];
    const add = (name, exe, scope, check, status = 0, leading = []) => {
        for (const format of ["json", "human"]) cases.push({ name: `${name}-${format}`, exe, scope, check, status, leading, format, result: "NOTRUN" });
    };
    const success = v => { assert.equal(v.complete, true); assert.deepEqual(v.diagnostics, []); };
    const failure = code => v => { assert.equal(v.complete, false); assert.ok(v.diagnostics.some(d => d.code === code), code); };
    const emptyExe = join(empty, "dsh");
    for (const scope of [[], ...scopes.map(s => [s])]) add(`empty-${scope[0] ?? "overview"}`, emptyExe, scope, v => {
        success(v);
        if (!scope.length) { assert.equal(v.effective.status, "empty"); assert.equal(v.effective.reason, "no-installed-runtime"); }
        if (scope[0] === "self") assert.equal(row(v, "self.data").status, "not-created");
        if (scope[0] === "cache") assert.equal(row(v, "cache.app-default").path, join(empty, "dsh-bin/home/cache"));
    });
    for (const scope of [[], ...scopes.map(s => [s])]) add(`installed-${scope[0] ?? "overview"}`, manager, scope, v => {
        success(v);
        if (!scope.length) {
            assert.equal(v.effective.status, "resolved");
            for (const [key, id, p] of [["runtime", installed.id, installed.roots.R], ["plugins", installed.selection.snapshot, installed.roots.P], ["config", installed.selection.configSnapshot, installed.roots.C]]) {
                assert.equal(v.effective[key].id, id); assert.equal(v.effective[key].path, p);
            }
        }
        if (scope[0] === "runtime") { assert.equal(row(v, "runtime").id, installed.id); assert.equal(row(v, "runtime").path, installed.roots.R); }
        if (scope[0] === "addon") assert.equal(v.records.filter(r => r.role === "addon").length, 0);
    });
    add("runtime-exact", manager, ["runtime", installed.id], v => { success(v); assert.equal(row(v, "runtime").id, installed.id); });
    for (const kind of ["plugins", "config"]) add(`snapshot-${kind}-exact`, manager, ["snapshot", kind, installed.selection[kind === "plugins" ? "snapshot" : "configSnapshot"]], v => { success(v); assert.equal(row(v, "snapshot").kind, kind); });
    for (const [scope, code] of [[["runtime", "missing"], "target-not-found"], [["snapshot", "config", `${installed.id}@99`], "invalid-target"], [["addon", "office:missing"], "target-not-found"], [["completion", "unknown"], "invalid-target"]]) add(`invalid-${scope.join("-")}`, manager, scope, failure(code), 1);
    add("invalid-explicit-use-no-fallback", manager, [], v => { failure("not_installed")(v); assert.equal(v.effective.status, "unresolved"); assert.equal(v.effective.reason, "not_installed"); assert.equal(v.effective.runtime, null); }, 1, ["--use", "missing"]);
    add("invalid-explicit-snapshot-no-fallback", manager, [], v => { failure("invalid-snapshot-reference")(v); assert.equal(v.effective.runtime, null); }, 1, ["--config-snapshot", `${installed.id}@99`]);
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
    const negativeExe = join(negative, "dsh");
    add("copied-genuine-selection", negativeExe, [], v => { success(v); assert.equal(v.effective.status, "resolved"); assert.equal(v.effective.runtime.id, installed.id); });
    cases[cases.length - 2].prepare = setupNegative;
    add("ambiguous-runtime-inventory", negativeExe, ["runtime", "0.2"], failure("ambiguous-target"), 1);
    cases[cases.length - 2].prepare = () => {
        const target = join(data, "bundles", `${installed.id}.duplicate`); mkdirSync(target);
        for (const file of ["bundle.json", "dsh-native", ".usage.lock"]) copyFileSync(join(installed.roots.R, file), join(target, file));
        assert.equal(sha(join(target, "dsh-native")), binding.runtimeSha256);
    };
    add("ambiguous-explicit-use-no-fallback", negativeExe, [], v => { failure("ambiguous")(v); assert.equal(v.effective.reason, "ambiguous"); assert.equal(v.effective.runtime, null); }, 1, ["--use", "0.2"]);
    add("malformed-selection", negativeExe, [], v => { failure("invalid-selection")(v); assert.equal(v.effective.reason, "invalid-selection"); assert.equal(v.effective.status, "unresolved"); }, 1);
    cases[cases.length - 2].prepare = () => writeFileSync(join(data, "state/selection.json"), "broken");
    add("malformed-selection-self-still-inventory", negativeExe, ["self"], success);
    add("empty-kind-unresolved-selection", negativeExe, ["addon"], v => { success(v); assert.equal(v.effective, null); assert.equal(v.records.filter(r => r.role === "addon").length, 0); });
    add("legacy-completion-unknown-no-rc-read", negativeExe, ["completion", "bash"], v => {
        failure("completion-path-unrecorded")(v); const r = row(v, "completion.registration"); assert.equal(r.status, "unknown"); assert.equal(r.path, null); assert.equal(r.reason, "registration-path-not-recorded");
    }, 1);
    cases[cases.length - 2].prepare = () => writeFileSync(join(data, "state/completion.json"), JSON.stringify({ schema: 1, shells: { bash: { result: "registered" } } }));
    add("offline-installed-overview", manager, [], v => { success(v); assert.equal(v.effective.status, "resolved"); assert.equal(v.effective.runtime.id, installed.id); });
    cases[cases.length - 2].prepare = () => server.stop(true);
    manifest.cases = cases.map(({ name, status, format }) => ({ name, expectedStatus: status, format, result: "NOTRUN" }));
    const jsonResults = new Map();
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
        activeCase.audit = audit(decoded.stdout, c.exe);
        await Bun.sleep(5); activeCase.requestsAfter = requests; assert.equal(requests, requestsBefore, "controlled origin request");
        const after = { target: tree(dirname(c.exe)), home: tree(env.HOME), tmp: tree(env.TMPDIR), cache: tree(env.XDG_CACHE_HOME) };
        activeCase.treeBeforeSha256 = digest(before); activeCase.treeAfterSha256 = digest(after); assert.deepEqual(after, before, "query mutated managed/private roots");
        assert.equal(r.status, c.status, `${c.name} exit status`); assert.ok(!/NATIVE-PATH-PRIVATE-SENTINEL|\u001b/.test(r.stdout + r.stderr));
        if (c.format === "json") {
            const v = JSON.parse(r.stdout); assert.equal(v.schemaVersion, 1); assert.equal(v.scope, c.scope[0] ?? "overview"); assert.ok(Array.isArray(v.records)); assert.ok(Array.isArray(v.diagnostics));
            for (const item of v.records) if (item.path !== null) assert.ok(isAbsolute(item.path));
            assert.equal(r.stderr, ""); c.check(v); activeCase.json = v; jsonResults.set(c.name.replace(/-json$/, ""), v);
        } else {
            const v = jsonResults.get(c.name.replace(/-human$/, "")); assert.ok(v);
            for (const item of v.records) { assert.ok(r.stdout.includes(item.role)); assert.ok(r.stdout.includes(`[${item.status}]`)); if (item.path) assert.ok(r.stdout.includes(item.path)); }
            if (v.effective) assert.ok(r.stdout.includes(`effective: ${v.effective.status}`));
            for (const d of v.diagnostics) assert.ok(r.stderr.includes(`path ${d.code}:`));
            if (c.status === 0) assert.equal(r.stderr, "");
        }
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
