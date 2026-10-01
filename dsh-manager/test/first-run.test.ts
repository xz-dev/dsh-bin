// First-run behavior at a real PTY: user consent precedes runtime checks, never consumes piped stdin.
import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addRuntime, baseEnv, cleanup, hasZig, newInstall, run, started, type Install, WIN } from "./harness.ts";

const python = Bun.which("python3");
const bash = Bun.which("bash");
const fish = Bun.which("fish");
const reason = WIN ? "real Windows console/ConPTY harness not available" : !python ? "Python stdlib PTY unavailable" : !bash ? "real Bash unavailable" : !hasZig ? "Zig unavailable" : "";
const crossShellReason = reason || (!fish ? "real Fish unavailable for per-shell choice verification" : "");
afterEach(cleanup);
const statePath = (i: Install) => join(i.data, "state/completion.json");
const state = (i: Install) => JSON.parse(readFileSync(statePath(i), "utf8"));

function terminal(i: Install, shell: "bash" | "fish" | "unknown" = "bash", env: Record<string, string> = {}, args: string[] = []) {
	const command = shell === "bash" ? [bash!, "--noprofile", "--norc", "-c", '"$@"; code=$?; exit "$code"', "pty-bash", i.exe, ...args] : shell === "fish" ? [fish!, "--no-config", "-c", '$argv; exit $status', i.exe, ...args] : [python!, "-c", "import subprocess,sys; sys.exit(subprocess.call(sys.argv[1:]))", i.exe, ...args];
	const p = spawn(python!, [join(import.meta.dir, "terminal-driver.py"), ...command], { env: { ...baseEnv(i), DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_ORIGIN: "not-a-url", SHELL: shell === "unknown" ? "/unrecognized" : shell === "fish" ? fish! : bash!, ...env }, cwd: i.home, stdio: "pipe" });
	let output = "";
	p.stdout.on("data", (b) => { output += b.toString(); });
	p.stderr.on("data", (b) => { output += b.toString(); });
	const done = new Promise<number | null>((resolve, reject) => { p.on("exit", resolve); p.on("error", reject); });
	const watchdog = setTimeout(() => p.kill("SIGTERM"), 15_000);
	done.finally(() => clearTimeout(watchdog));
	return {
		get output() { return output; },
		answer(s: string) { p.stdin.write(s); },
		async wait(text: string) {
			const end = Date.now() + 6000;
			while (!output.includes(text) && p.exitCode === null && Date.now() < end) await Bun.sleep(20);
			expect(output).toContain(text);
		},
		done,
	};
}

for (const fixture of ["empty", "installed", "broken"] as const) {
	test.skipIf(!!reason)(`FB-ORDER: real terminal ${fixture} runtime waits for completion consent before runtime check${reason ? ` — SKIP: ${reason}` : ""}`, async () => {
		const i = newInstall();
		if (fixture !== "empty") addRuntime(i.data, "1.0.0", { entry: fixture !== "broken" });
		let requests = 0;
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return new Response("unexpected", { status: 404 }); } });
		try {
			const t = terminal(i, "bash", { DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_ORIGIN: server.url.origin, ...(process.platform === "linux" ? { SHELL: fish ?? "/bin/fish" } : {}) });
			await t.wait("Register bash completion at ");
			expect(t.output).toContain(join(i.home, ".bashrc")); expect(t.output).toContain("[Y/n/o]");
			expect(started(i)).toBe(false); expect(requests).toBe(0); expect(existsSync(statePath(i))).toBe(false); expect(existsSync(join(i.data, "snapshots"))).toBe(false);
			expect(t.output).not.toMatch(/no release-channel|is incomplete/);
			t.answer("\n");
			expect(await t.done).toBe(fixture === "installed" ? 0 : 1);
			expect(state(i).shells.bash.result).toBe("registered"); expect(readFileSync(join(i.home, ".bashrc"), "utf8")).toContain("dsh-manager completion");
			if (fixture === "empty") expect(t.output).toContain("automatic runtime install failed");
			if (fixture === "broken") expect(t.output).toContain("is incomplete");
			expect(started(i)).toBe(fixture === "installed"); expect(requests).toBe(fixture === "empty" ? 1 : 0);
			const again = terminal(i); expect(await again.done).toBe(fixture === "installed" ? 0 : 1); expect(again.output).not.toContain("Register bash");
		} finally { server.stop(true); }
	}, 120_000);
}

test.skipIf(!!reason)(`FB-ORDER: runtime installed while prompt waits is discovered only after consent${reason ? ` — SKIP: ${reason}` : ""}`, async () => {
	const i = newInstall(); const t = terminal(i); await t.wait("[Y/n/o]");
	// If launch cached the available runtimes before consent it would still diagnose an empty install.
	addRuntime(i.data, "1.0.0"); t.answer("n\n"); expect(await t.done).toBe(0); expect(started(i)).toBe(true);
}, 120_000);

test.skipIf(!!crossShellReason)(`FB-DECLINE: decline retains profile, launches app and asks again in a different real shell${crossShellReason ? ` — SKIP: ${crossShellReason}` : ""}`, async () => {
	const i = newInstall(); addRuntime(i.data, "1.0.0"); writeFileSync(join(i.home, ".bashrc"), "# keep\n");
	const t = terminal(i); await t.wait("[Y/n/o]"); t.answer("n\n"); expect(await t.done).toBe(0);
	expect(state(i).shells.bash.result).toBe("declined"); expect(readFileSync(join(i.home, ".bashrc"), "utf8")).toBe("# keep\n");
	const again = terminal(i); expect(await again.done).toBe(0); expect(again.output).not.toContain("Register bash");
	if (fish) {
		const other = terminal(i, "fish"); await other.wait("Register fish completion at "); other.answer("n\n"); expect(await other.done).toBe(0);
		expect(state(i).shells.fish.result).toBe("declined"); expect(state(i).shells.bash.result).toBe("declined");
		const fishAgain = terminal(i, "fish"); expect(await fishAgain.done).toBe(0); expect(fishAgain.output).not.toContain("Register fish");
	}
}, 120_000);

test.skipIf(!!reason)(`FB-REG-FAIL: registration failure records failed, gives retry command, then continues without re-ask${reason ? ` — SKIP: ${reason}` : ""}`, async () => {
	const i = newInstall(); addRuntime(i.data, "1.0.0"); chmodSync(i.home, 0o500);
	try {
		const t = terminal(i); await t.wait("[Y/n/o]"); t.answer("yes\n"); expect(await t.done).toBe(0);
		expect(state(i).shells.bash.result).toBe("failed"); expect(t.output).toContain("completion is not registered"); expect(t.output).toContain("dsh manager completion install bash"); expect(started(i)).toBe(true); expect(existsSync(join(i.home, ".bashrc"))).toBe(false);
		const again = terminal(i); expect(await again.done).toBe(0); expect(again.output).not.toContain("Register bash");
	} finally { chmodSync(i.home, 0o700); }
}, 120_000);

test.skipIf(!!reason)(`FB-ORDER: undetected menu lists targets, choice consents and skip does not repeat${reason ? ` — SKIP: ${reason}` : ""}`, async () => {
	const i = newInstall(); addRuntime(i.data, "1.0.0");
	const t = terminal(i, "unknown"); await t.wait("Choose completion shell"); expect(t.output).toContain(join(i.home, ".bashrc")); t.answer("bash\n"); expect(await t.done).toBe(0);
	expect(state(i).shells.bash.result).toBe("registered"); expect(state(i).undetected.result).toBe("registered");
	const again = terminal(i, "unknown"); expect(await again.done).toBe(0); expect(again.output).not.toContain("Choose completion");
	const j = newInstall(); const skipped = terminal(j, "unknown"); await skipped.wait("Choose completion shell"); skipped.answer("skip\n"); expect(await skipped.done).toBe(1);
	expect(state(j).undetected.result).toBe("declined"); expect(existsSync(join(j.home, ".bashrc"))).toBe(false);
	const skipAgain = terminal(j, "unknown"); expect(await skipAgain.done).toBe(1); expect(skipAgain.output).not.toContain("Choose completion");
}, 120_000);

test.skipIf(!!crossShellReason)(`FB-ORDER: other opens target menu; EOF records nothing and next interactive launch asks${crossShellReason ? ` — SKIP: ${crossShellReason}` : ""}`, async () => {
	const i = newInstall(); const t = terminal(i); await t.wait("[Y/n/o]"); t.answer("o\n"); await t.wait("Choose completion shell"); t.answer("skip\n"); expect(await t.done).toBe(1);
	const skipAgain = terminal(i); expect(await skipAgain.done).toBe(1); expect(skipAgain.output).not.toContain("Register bash");
	if (fish) {
		const k = newInstall(); const other = terminal(k); await other.wait("[Y/n/o]"); other.answer("o\n"); await other.wait("Choose completion shell"); other.answer("fish\n"); expect(await other.done).toBe(1);
		expect(state(k).shells.bash.result).toBe("declined"); expect(state(k).shells.fish.result).toBe("registered");
		const nextBash = terminal(k); expect(await nextBash.done).toBe(1); expect(nextBash.output).not.toContain("Register bash");
	}
	const j = newInstall(); const eof = terminal(j); await eof.wait("[Y/n/o]"); eof.answer("\x04"); expect(await eof.done).toBe(1); expect(existsSync(statePath(j))).toBe(false);
	const menuEof = terminal(j, "unknown"); await menuEof.wait("Choose completion shell"); menuEof.answer("\x04"); expect(await menuEof.done).toBe(1); expect(existsSync(statePath(j))).toBe(false);
	const again = terminal(j); await again.wait("[Y/n/o]"); again.answer("n\n"); expect(await again.done).toBe(1);
}, 120_000);

test.skipIf(!!reason)(`FB-ORDER: completion answer never buffers away subsequent terminal input${reason ? ` — SKIP: ${reason}` : ""}`, async () => {
	const i = newInstall(); addRuntime(i.data, "1.0.0"); const t = terminal(i, "bash", { FAKE_STDIN: "1" });
	await t.wait("[Y/n/o]"); t.answer("n\napplication input\n\x04"); expect(await t.done).toBe(0);
	expect(readFileSync(join(i.out, "1.stdin"), "utf8")).toBe("application input\n");
}, 120_000);

test.skipIf(!!reason)(`FB-ORDER: invalid completion state refuses before app; noninteractive launch leaves stdin intact${reason ? ` — SKIP: ${reason}` : ""}`, async () => {
	const i = newInstall(); addRuntime(i.data, "1.0.0"); mkdirSync(join(i.data, "state")); writeFileSync(statePath(i), '{"schema":99,"shells":{}}');
	const t = terminal(i); expect(await t.done).toBe(1); expect(t.output).toContain("invalid completion state"); expect(started(i)).toBe(false);
	const j = newInstall(); addRuntime(j.data, "1.0.0"); const piped = run(j, [], { input: "application input", env: { FAKE_STDIN: "1" } });
	expect(piped.status).toBe(0); expect(readFileSync(join(j.out, "1.stdin"), "utf8")).toBe("application input"); expect(existsSync(statePath(j))).toBe(false);
}, 120_000);
