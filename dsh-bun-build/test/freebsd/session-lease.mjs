// Service-level prerequisite, NOT installed-product acceptance. Run with native FreeBSD Bun:
// bun test/freebsd/session-lease.mjs <copied-certified-app> <empty-session-root>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL, fileURLToPath } from "node:url";

assert.equal(process.platform, "freebsd");
assert.equal(process.getuid(), 1001);
assert.equal(process.env.PATH, "");
const [app, root, childMode] = process.argv.slice(2);
const load = name => import(pathToFileURL(join(app, "node_modules/@deepseek-ai", name, "lib/index.js")).href);
const { Context } = await load("cordis");
const { default: JsonlSessionPersistence } = await load("dsh-session-persistence-jsonl");
const { SessionAlreadyOwnedError } = await load("dsh-session-persistence");
const { SESSION_FORMAT_VERSION } = await load("dsh-session");
const id = "freebsd-real-jsonl-lease";
const ctx = new Context();
await ctx.plugin(JsonlSessionPersistence, { root, compression: "none" });
const backend = ctx.sessionPersistence;

if (childMode) {
	const handle = childMode === "create"
		? await backend.create({ version: SESSION_FORMAT_VERSION, id, createdAt: 1000, cwd: root, isSeeded: false })
		: await backend.open(id, "write");
	if (childMode === "create") await handle.append([
		{ type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
		{ type: "turn/end", seq: 1, time: 2, data: { turn: 1, reason: { kind: "completed" } } },
	]);
	console.log("holding");
	for await (const command of createInterface({ input: process.stdin })) {
		if (command === "close") { await handle.close(); console.log("closed"); }
		else if (command === "exit") process.exit(0); // Deliberately no handle close/dispose.
		else throw new Error("unknown holder command");
	}
} else {
	async function holder(mode) {
		const child = spawn(process.execPath, [fileURLToPath(import.meta.url), app, root, mode], { stdio: ["pipe", "pipe", "inherit"], env: process.env });
		const exited = once(child, "exit");
		const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
		const first = await lines.next();
		assert.equal(first.value, "holding", "real backend must acquire lease before contender starts");
		return { child, exited, lines };
	}
	let expectedSeq = [0, 1];
	async function rejectedWhileLive(h) {
		await assert.rejects(backend.open(id, "write"), SessionAlreadyOwnedError);
		assert.equal(h.child.exitCode, null);
		assert.equal(h.child.signalCode, null);
		const reader = await backend.open(id, "read");
		assert.deepEqual((await reader.read()).events.map(event => event.seq), expectedSeq);
		await reader.close();
	}
	async function takeover(label) {
		const taken = await backend.open(id, "write");
		assert.deepEqual((await taken.read()).events.map(event => event.seq), expectedSeq);
		const seq = expectedSeq.length, turn = seq / 2 + 1;
		await taken.append([
			{ type: "turn/start", seq, time: seq + 1, data: { turn } },
			{ type: "turn/end", seq: seq + 1, time: seq + 2, data: { turn, reason: { kind: "completed" } } },
		]);
		expectedSeq = [...expectedSeq, seq, seq + 1];
		assert.deepEqual((await taken.read()).events.map(event => event.seq), expectedSeq);
		await taken.close();
		console.log(JSON.stringify({ check: label, result: "PASS" }));
	}
	let active;
	try {
		active = await holder("create");
		await rejectedWhileLive(active);
		active.child.stdin.write("close\n");
		assert.equal((await active.lines.next()).value, "closed");
		await takeover("live contender rejected; explicit close releases while holder remains alive");
		active.child.stdin.write("exit\n"); await active.exited;
		for (const mode of ["exit", "SIGKILL"]) {
			active = await holder("open");
			await rejectedWhileLive(active);
			if (mode === "exit") active.child.stdin.write("exit\n");
			else active.child.kill("SIGKILL");
			const [code, signal] = await active.exited;
			assert.equal(mode === "exit" ? code : signal, mode === "exit" ? 0 : "SIGKILL");
			await takeover(`${mode} releases unclosed descriptor; JSONL data consistent`);
		}
		console.log(JSON.stringify({ platform: process.platform, arch: process.arch, uid: process.getuid(), bun: process.versions.bun, service: "session-persistence-jsonl", result: "PASS", scope: "5.1 prerequisite only" }));
	} finally {
		if (active?.child.exitCode === null && active.child.signalCode === null) active.child.kill("SIGKILL");
		await ctx.fiber.dispose();
	}
}
