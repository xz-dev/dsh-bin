// HOST ONLY: replay authenticated records. Imports declarations only; never nativeMain/prepare/product.
// /absolute/pinned/bun path.native.replay.mjs /var/tmp/dsh-freebsd-native-path /new/repair/scratch
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { audit, auditIdentity, assertResult, expectedReport, pathCases, selfCheck } from "./path.native.mjs";
const [evidence, output] = process.argv.slice(2);
assert.equal(process.platform, "linux"); assert.equal(Bun.version, "1.4.2");
assert.equal(evidence, "/var/tmp/dsh-freebsd-native-path"); assert.equal(output, "/var/tmp/dsh-freebsd-native-path-repair");
const sha = p => createHash("sha256").update(readFileSync(p)).digest("hex");
const json = p => JSON.parse(readFileSync(p, "utf8"));
const original = "c6a73b193d327e4cc6ddc38375d06a1acc7135f6a56d4f7383b44679864a81fa";
const manifestPath = join(evidence, "final/manifest.json"), m = json(manifestPath);
assert.equal(sha(manifestPath), "0fb915799e4e4f1b50a38b20c7f964d614d25e1f7e6b0f109d9502fee723cea3");
assert.equal(sha(join(evidence, "final/path.native.mjs")), original); assert.equal(m.input.scriptSha256, original);
assert.equal(m.input.binding.sourceSha256["dsh-manager/test/path.native.mjs"], original);
const source = readFileSync(join(import.meta.dir, "path.native.mjs"), "utf8");
const hashText = text => createHash("sha256").update(text).digest("hex");
const receipt = { mode: "HOST UNIT/REPLAY ONLY; repaired source NOT executed natively", helper: process.execPath, helperSha256: sha(process.execPath), originalCommit: "0fdcf641300491d22d2888f732b3fc4b3a6f61ca", originalScriptSha256: original, repairedScriptSha256: sha(join(import.meta.dir, "path.native.mjs")), repairedAuditSha256: hashText(source.slice(source.indexOf("// Fixed FreeBSD15.1"), source.indexOf("// Expectations derive"))), replayScriptSha256: sha(import.meta.path), nativeInput: m.input, originalManifestSha256: sha(manifestPath), captures: [], controls: [], outputControls: [] };
selfCheck(); receipt.selfCheck = "PASS";
function spec(c, fixtureRoot = join(evidence, "final"), installed = m.input.installed) {
    const declared = pathCases(installed, fixtureRoot, m.input.manager).find(expected => expected.name === c.name);
    assert.ok(declared, "undeclared query case");
    assert.deepEqual(c.argv, ["/usr/bin/ktrace", "-i", "-t", "cn", "-f", c.trace, declared.exe, ...declared.leading, "manager", "path", ...declared.scope, ...(declared.format === "json" ? ["--json"] : [])], "declared command/target identity");
    assert.equal(c.status, declared.status); return declared;
}
const captures = [];
for (const c of m.cases) {
    assert.equal(c.result, "PASS"); assert.equal(sha(c.trace), c.traceSha256); assert.equal(sha(c.dump), c.dumpSha256);
    captures.push({ c, trace: c.trace, dump: c.dump, root: join(evidence, "final"), installed: m.input.installed, origin: manifestPath });
}
for (const attempt of ["first-run", "recheck"]) {
    const path = join(evidence, attempt, "manifest.json"), old = json(path), c = old.cases[0];
    assert.equal(c.result, "FAIL"); assert.equal(old.cases.filter(c => c.result === "NOTRUN").length, 69);
    assert.equal(sha(join(evidence, attempt, "path.native.mjs")), old.input.scriptSha256, "original attempt source identity");
    assert.equal(old.input.binding.managerSha256, m.input.binding.managerSha256); assert.equal(old.input.binding.runtimeSha256, m.input.binding.runtimeSha256);
    captures.push({ c, trace: join(evidence, attempt, "empty-overview-json.ktrace"), dump: join(evidence, attempt, "empty-overview-json.kdump"), root: dirname(c.cwd), installed: old.input.installed, origin: path });
}
assert.equal(captures.length, 72);
for (const { c, trace, dump, root, installed, origin } of captures) {
    const declared = spec(c, root, installed), identity = auditIdentity(declared.exe, installed, root, c.cwd);
    const value = audit(readFileSync(dump, "utf8"), identity, c.status); assertResult(declared, c, installed, root);
    if (c.audit) { assert.equal(value.syscallCount, c.audit.syscallCount); assert.equal(value.execs, c.audit.execs); }
    receipt.captures.push({ name: c.name, origin, nativeScriptSha256: json(origin).input.scriptSha256, manifestSha256: sha(origin), traceSha256: sha(trace), dumpSha256: sha(dump), outputSha256: createHash("sha256").update(c.stdout + "\0" + c.stderr).digest("hex"), status: c.status, syscallCount: value.syscallCount, result: "PASS" });
}
const c = m.cases[0], base = readFileSync(c.dump, "utf8"), identity = auditIdentity(c.argv[6], m.input.installed, join(evidence, "final"), c.cwd), pid = c.audit.pids[0];
const call = (body, ret = "0", paths = []) => ` ${pid} dsh CALL ${body}\n` + paths.map(p => ` ${pid} dsh NAMI ${JSON.stringify(p)}\n`).join("") + ` ${pid} dsh RET ${body.split("(")[0]} ${ret}\n`;
const insert = text => base.replace(/(?=^.*CALL\s+_exit\()/m, text);
function control(name, text, accept = false) {
    let error; try { audit(text, identity, 0); } catch (e) { error = e.message; }
    assert.equal(!error, accept, `${name}: ${error ?? "false accept"}`); receipt.controls.push({ name, expected: accept ? "accept" : "reject", result: "PASS", error });
}
control("saved complete trace", base, true);
control("original stdout pwritev ESPIPE then writev and stderr", insert(call("pwritev(1,0,1,0)", "-1 errno 29 Illegal seek") + call("writev(1,0,1)", "1") + call("write(2,0,1)", "1")), true);
control("truncated after initial exec", base.split("\n").slice(0, 5).join("\n") + "\n");
control("truncated missing terminal exit", base.replace(/^.*CALL\s+_exit\(.*\)\n/m, ""));
control("truncated partial tail", base.slice(0, -3));
control("Events dropped", base + ` ${pid} dsh Events dropped.\n`);
control("Events dropped before exit", insert(` ${pid} dsh Events dropped.\n`));
control("unknown record", insert(` ${pid} dsh UNKNOWN stuff\n`));
control("unknown syscall", insert(call("unknown_call(0)")));
control("malformed syscall", insert(call("mmap(0)")));
control("unparsed argument", insert(call("close(GARBAGE)")));
control("symbol at wrong argument position", insert(call("close(SIGPIPE)")));
control("directory flag at pointer position", insert(call("open(0<O_DIRECTORY>,0<O_RDONLY>)", "4", [identity.data])));
control("unknown flag", insert(call("open(0,0<UNKNOWN_FLAG>)", "4", [identity.exe])));
control("inconsistent numeric return", base.replace(/RET   mmap \d+\/0x[0-9a-f]+/, "RET   mmap 1/0x2"));
control("unexpected process", insert(` 999999 dsh CALL getpid\n 999999 dsh RET getpid 999999\n`));
control("orphan namei", insert(` ${pid} dsh NAMI \"bundle.json\"\n`));
control("record after exit", base + ` ${pid} dsh CALL getpid\n ${pid} dsh RET getpid ${pid}\n`);
control("malformed return", base.replace("RET   mmap ", "RET   mmap GARBAGE "));
control("orphan return", insert(` ${pid} dsh RET read 0\n`));
control("namei on non-path syscall", insert(call("getpid", pid, ["bundle.json"])));
control("missing namei material", base.replace(/^.*NAMI\s+\"\/etc\/libmap.conf\"\n/m, ""));
control("unmatched return", base.replace("RET   mmap ", "RET   read "));
control("unexpected signal", insert(` ${pid} dsh PSIG SIGTERM\n`));
control("wrong exit status", base.replace("_exit(0)", "_exit(1)"));
for (const command of ["F_OSETLK", "F_SETLK", "F_DUP2FD", "F_DUP2FD_CLOEXEC", "F_GETFD"]) control(command, insert(call(`fcntl(3,${command},1)`, "1") + call("pwritev(1,0,1,0)", "1")));
control("legacy lock exact review control", insert(call("fcntl(3,F_OSETLK,0)")));
control("CLOEXEC rebound stderr exact review control", insert(call("fcntl(3,F_DUP2FD_CLOEXEC,2)", "2") + call("writev(2,0,1)", "1")));
for (const body of ["pwrite(3,0,1,0)", "pwritev(3,0,1,0)", "fork", "socket(2,1,0)", "connect(3,0,0)", "flock(3,2)", "dup2(3,2)"]) control(body, insert(call(body)));
control("closed stdout", insert(call("close(1)") + call("writev(1,0,1)", "1")));
control("metadata basename external", insert(call("open(0,0<O_RDONLY>)", "4", ["/tmp/application-config/bundle.json"])));
control("metadata basename application root", insert(call("open(0,0<O_RDONLY>)", "4", [join(identity.data, "bundles", m.input.installed.id, "app/bundle.json")])));
control("relative metadata unowned parent fd", insert(call("openat(88,0,0<O_RDONLY>)", "4", ["bundle.json"])));
control("relative metadata calling home", insert(call("openat(AT_FDCWD,0,0<O_RDONLY>)", "4", ["bundle.json"])));
control("relative traversal escapes owned parent", insert(call("open(0,0x120000<O_RDONLY|O_DIRECTORY>)", "4", [identity.data]) + call("openat(4,0,0<O_RDONLY>)", "5", ["../home/selection.json"])));
control("same basename under config snapshot", insert(call("open(0,0<O_RDONLY>)", "4", [join(identity.data, "config-snapshots", m.input.installed.selection.configSnapshot, "bundle.json")])));
control("sensitive body", insert(call("open(0,0<O_RDONLY>)", "4", ["/tmp/settings.yaml"])));
control("unbound loader", base.replace('"/etc/libmap.conf"', '"/etc/other.conf"'));
control("loader after self open", insert(call("open(0,0<O_RDONLY>)", "4", ["/etc/libmap.conf"])));
control("write-open", insert(call("open(0,0x2<O_RDWR>)", "4", [join(identity.data, "state/selection.json")])));
control("owned relative metadata", insert(call("open(0,0x120000<O_RDONLY|O_DIRECTORY>)", "4", [identity.data]) + call("openat(4,0,0<O_RDONLY>)", "5", [".dsh-bin-data.json"]) + call("close(5)") + call("close(4)")), true);
control("open rebinds output", insert(call("open(0,0<O_RDONLY>)", "1", [join(identity.data, "state/selection.json")]) + call("writev(1,0,1)", "1")));
const target = m.cases.find(c => c.name === "snapshot-config-exact-json"), changedTarget = { ...target, argv: [...target.argv] };
changedTarget.argv[11] = "OTHER@1"; assert.throws(() => spec(changedTarget), undefined, "requested target substitution");
receipt.outputControls.push({ name: "requested target substitution", case: target.name, result: "PASS" });
function rejectedOutput(name, original, changed) {
    assert.throws(() => assertResult(spec(original), changed, m.input.installed, join(evidence, "final")), undefined, name);
    receipt.outputControls.push({ name, case: original.name, result: "PASS" });
}
for (const original of m.cases) {
    const declared = spec(original), expected = expectedReport(declared, m.input.installed, join(evidence, "final"));
    rejectedOutput("wrong exit status", original, { ...original, status: 1 - original.status });
    if (declared.format === "json") {
        const change = (name, fn) => { const value = JSON.parse(original.stdout); fn(value); rejectedOutput(name, original, { ...original, stdout: JSON.stringify(value) }); };
        if (expected.records.length) {
            change("missing required records", v => v.records = []);
            for (const field of ["role", "source", "status", "path", "id", "kind"]) change(`wrong record ${field}`, v => v.records[0][field] = "WRONG");
        }
        if (expected.effective) {
            change("wrong effective reason", v => v.effective.reason = "WRONG");
            for (const key of ["runtime", "plugins", "config"]) if (expected.effective[key]) for (const field of ["id", "path", "source"]) change(`wrong effective ${key}.${field}`, v => v.effective[key][field] = "WRONG");
        }
        if (expected.diagnostics.length) change("wrong diagnostic reason", v => v.diagnostics[0].code = "WRONG");
    } else {
        if (original.stdout) rejectedOutput("missing human fields", original, { ...original, stdout: "" });
        else rejectedOutput("missing human diagnostics", original, { ...original, stderr: "" });
        if (original.stdout.includes("source=")) rejectedOutput("wrong human source", original, { ...original, stdout: original.stdout.replace(/source=\S+/, "source=WRONG") });
        if (original.stdout.includes("effective:")) rejectedOutput("wrong human selection explanation", original, { ...original, stdout: original.stdout.replace(/effective:[^\n]*/, "effective: WRONG") });
        if (original.stdout.includes("(persistent-use)")) rejectedOutput("wrong human effective source", original, { ...original, stdout: original.stdout.replace("(persistent-use)", "(default-latest)") });
    }
}
receipt.result = "PASS";
writeFileSync(join(output, "revalidation.json"), JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify({ mode: receipt.mode, replays: receipt.captures.length, controls: receipt.controls.length, outputControls: receipt.outputControls.length, result: receipt.result, repairedScriptSha256: receipt.repairedScriptSha256 }));
