import { createConfigPaths } from "../../../runtime/compat/config-paths.ts";
import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import { appendFileSync, existsSync, openSync, closeSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";

// Read-only native diagnostics. No token adjustment, privilege elevation or ACL/authentication bypass.
function diagnostics() {
	if (process.platform !== "win32") throw new Error("native Windows diagnostics required");
	const { ptr: p, u64, u32, i32 } = FFIType;
	const k = dlopen("kernel32.dll", {
		GetCurrentProcess: { args: [], returns: u64 }, GetCurrentThread: { args: [], returns: u64 },
		GetLastError: { args: [], returns: u32 }, CloseHandle: { args: [u64], returns: i32 },
		LocalFree: { args: [p], returns: p },
		OpenProcess: { args: [u32, i32, u32], returns: u64 },
		GetExitCodeProcess: { args: [u64, p], returns: i32 },
		IsProcessInJob: { args: [u64, u64, p], returns: i32 },
	}).symbols;
	const a = dlopen("advapi32.dll", {
		OpenThreadToken: { args: [u64, u32, i32, p], returns: i32 },
		OpenProcessToken: { args: [u64, u32, p], returns: i32 },
		GetTokenInformation: { args: [u64, u32, p, u32, p], returns: i32 },
		ConvertSidToStringSidW: { args: [p, p], returns: i32 },
	}).symbols;
	return { k, a };
}
let api: ReturnType<typeof diagnostics> | undefined;
const native = () => api ??= diagnostics();
const address = (b: Buffer) => { const n = b.readBigUInt64LE(); if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("native pointer unverifiable"); return Number(n); };

/** Effective TokenUser/TokenOwner in this same Bun process, not a PowerShell/manager assertion. */
export function currentTokenDiagnostics() {
	const { k, a } = native(), token = Buffer.alloc(8); let source = "thread";
	if (!a.OpenThreadToken(BigInt(k.GetCurrentThread()), 8, 1, ptr(token))) {
		if (k.GetLastError() !== 1008) throw new Error(`OpenThreadToken failed: ${k.GetLastError()}`);
		source = "process";
		if (!a.OpenProcessToken(BigInt(k.GetCurrentProcess()), 8, ptr(token))) throw new Error(`OpenProcessToken failed: ${k.GetLastError()}`);
	}
	const handle = token.readBigUInt64LE();
	function sid(kind: number) {
		const needed = Buffer.alloc(4); a.GetTokenInformation(handle, kind, null, 0, ptr(needed));
		const length = needed.readUInt32LE(); if (length < 16 || length > 65536) throw new Error("token information size unverifiable");
		const data = Buffer.alloc(length), text = Buffer.alloc(8);
		if (!a.GetTokenInformation(handle, kind, ptr(data), length, ptr(needed)) || !a.ConvertSidToStringSidW(address(data), ptr(text))) throw new Error(`token SID query failed: ${k.GetLastError()}`);
		const pointer = address(text);
		try {
			let length = 0;
			for (; length < 368; length += 2) if (Buffer.from(toArrayBuffer(pointer + length, 0, 2)).readUInt16LE() === 0) break;
			if (length === 368) throw new Error("token SID string unverifiable");
			return Buffer.from(toArrayBuffer(pointer, 0, length)).toString("utf16le");
		} finally { k.LocalFree(pointer); }
	}
	try { return { pid: process.pid, source, user: sid(1), defaultOwner: sid(4) }; } finally { k.CloseHandle(handle); }
}

/** Retain exact process handle before parent death; exit status cannot be confused with PID reuse. */
export function observeProcess(pid: number) {
	const { k } = native(), handle = BigInt(k.OpenProcess(0x1000, 0, pid)); // QUERY_LIMITED_INFORMATION only
	if (handle === 0n) throw new Error(`OpenProcess(${pid}) failed: ${k.GetLastError()}`);
	return {
		snapshot() {
			const code = Buffer.alloc(4), job = Buffer.alloc(4);
			if (!k.GetExitCodeProcess(handle, ptr(code))) throw new Error(`GetExitCodeProcess failed: ${k.GetLastError()}`);
			const jobOK = Boolean(k.IsProcessInJob(handle, 0n, ptr(job)));
			return { pid, exitCode: code.readUInt32LE(), active: code.readUInt32LE() === 259,
				inJob: jobOK ? Boolean(job.readInt32LE()) : null, jobQueryError: jobOK ? null : k.GetLastError() };
		},
		close() { k.CloseHandle(handle); },
	};
}

async function runProbe() {
	const [mode, config, control] = process.argv.slice(2);
	const journal = (stage: string, data: object = {}) => appendFileSync(join(control, "probe-events.stages"), JSON.stringify({ time: Date.now(), pid: process.pid, mode, stage, ...data }) + "\n");
	process.on("exit", code => journal("process-exit", { code }));
	journal("process-start");
	try {
		if (mode === "parent") {
			const paths = createConfigPaths(undefined, config);
			paths.check(join(config, "secret.yaml")); journal("parent-authenticated");
			const stdout = openSync(join(control, "child.stdout"), "wx"), stderr = openSync(join(control, "child.stderr"), "wx");
			let child;
			try { child = Bun.spawn([process.execPath, import.meta.path, "wait", config, control], { env: process.env, stdin: "ignore", stdout, stderr }); }
			finally { closeSync(stdout); closeSync(stderr); }
			journal("child-spawned", { childPid: child.pid });
			void child.exited.then(code => journal("child-exited", { childPid: child.pid, code, signal: child.signalCode }));
			writeFileSync(join(control, "child-pid"), String(child.pid));
			writeFileSync(join(control, "parent-authenticated"), "1");
			await new Promise(() => { setInterval(() => {}, 1000); }); // real test kills parent, never keeps it alive to authorize child
		} else {
			if (mode === "wait") {
				writeFileSync(join(control, "child-waiting"), "1"); journal("child-waiting");
				while (!existsSync(join(control, "release"))) await Bun.sleep(20);
				journal("release-observed");
			}
			try {
				journal("authentication-started");
				const paths = createConfigPaths(undefined, config);
				const path = paths.check(join(config, "secret.yaml")); journal("authentication-passed");
				const watchPath = paths.checkWatchPath(path);
				writeFileSync(join(control, "sensitive-watch"), "1");
				const watcher = watch(watchPath, () => {}); watcher.close();
				writeFileSync(join(control, "sensitive-open"), "1");
				const fd = openSync(paths.check(path), "r"); closeSync(fd);
				writeFileSync(join(control, "ready"), "1");
				writeFileSync(join(control, "result"), "READY"); journal("result-written", { result: "READY" });
			} catch (error) {
				const code = (error as { code?: string }).code ?? "UNKNOWN";
				journal("authentication-error", { code, message: String((error as Error).message), stack: (error as Error).stack });
				writeFileSync(join(control, "result"), code); process.exitCode = 1;
			}
		}
	} catch (error) {
		journal("probe-fatal", { message: String((error as Error).message), stack: (error as Error).stack });
		throw error;
	}
}
if (import.meta.main) await runProbe();
