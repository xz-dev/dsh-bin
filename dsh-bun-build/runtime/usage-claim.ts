// Bundle usage claims (design D4). Every process running a bundle holds a shared lock on
// `bundles/<v>/.usage.lock`; retirement (`--clean`, same-version `--force`) needs the exclusive lock, so it
// can never delete a bundle in use. POSIX: flock(2), released by the kernel when the process dies, even on
// SIGKILL. Windows: LockFileEx on a handle, released when the handle is closed at process exit.
// The launcher takes the shared claim for launcher-started processes; the runtime takes it again for
// directly started ones (flock/LockFileEx shared locks stack).
import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync, openSync } from "node:fs";

export type ClaimMode = "shared" | "exclusive";
export type Claim = { release(): void };

type Backend = { acquire(path: string, mode: ClaimMode): Claim | "busy" };

const LOCK_SH = 1;
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

function libcCandidates(): string[] {
	if (process.platform === "darwin") return ["/usr/lib/libSystem.B.dylib"];
	const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
	return ["libc.so.6", `libc.musl-${arch}.so.1`, `/lib/ld-musl-${arch}.so.1`, "libc.so"];
}

function posixBackend(): Backend {
	let lib: { symbols: { flock(fd: number, op: number): number } } | undefined;
	let lastError: unknown;
	for (const name of libcCandidates()) {
		try {
			lib = dlopen(name, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
			break;
		} catch (error) {
			lastError = error;
		}
	}
	if (!lib) throw new Error(`usage claim: cannot load libc flock (${String(lastError)})`);
	const { flock } = lib.symbols;
	return {
		acquire(path, mode) {
			const fd = openSync(path, "r");
			if (flock(fd, (mode === "shared" ? LOCK_SH : LOCK_EX) | LOCK_NB) !== 0) {
				closeSync(fd);
				return "busy";
			}
			let released = false;
			return {
				release() {
					if (released) return;
					released = true;
					flock(fd, LOCK_UN);
					closeSync(fd);
				},
			};
		},
	};
}

function windowsBackend(): Backend {
	const GENERIC_READ = 0x80000000;
	const SHARE_ALL = 0x7; // read | write | delete: the guard can be renamed into quarantine while locked
	const OPEN_EXISTING = 3;
	const LOCKFILE_FAIL_IMMEDIATELY = 1;
	const LOCKFILE_EXCLUSIVE_LOCK = 2;
	const INVALID_HANDLE = 0xffffffffffffffffn;
	const k32 = dlopen("kernel32.dll", {
		CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.u64 },
		LockFileEx: { args: [FFIType.u64, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
		UnlockFileEx: { args: [FFIType.u64, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
		CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
	}).symbols;
	return {
		acquire(path, mode) {
			const wide = Buffer.from(`${path}\0`, "utf16le");
			const handle = BigInt(k32.CreateFileW(ptr(wide), GENERIC_READ, SHARE_ALL, null, OPEN_EXISTING, 0, null));
			if (handle === INVALID_HANDLE || handle === 0n) throw new Error(`usage claim: cannot open ${path}`);
			const overlapped = new Uint8Array(32);
			const flags = LOCKFILE_FAIL_IMMEDIATELY | (mode === "exclusive" ? LOCKFILE_EXCLUSIVE_LOCK : 0);
			if (!k32.LockFileEx(handle, flags, 0, 1, 0, ptr(overlapped))) {
				k32.CloseHandle(handle);
				return "busy";
			}
			let released = false;
			return {
				release() {
					if (released) return;
					released = true;
					k32.UnlockFileEx(handle, 0, 1, 0, ptr(overlapped));
					k32.CloseHandle(handle);
				},
			};
		},
	};
}

let backend: Backend | undefined;
const getBackend = () => (backend ??= process.platform === "win32" ? windowsBackend() : posixBackend());

/** Try to take a claim without waiting. `"busy"` means a conflicting claim is held elsewhere. */
export function acquireClaim(guardPath: string, mode: ClaimMode): Claim | "busy" {
	return getBackend().acquire(guardPath, mode);
}

/** Whether a process holds a claim on `guardPath` (a probe: the exclusive claim is released at once; a missing guard is not in use). */
export function guardInUse(guardPath: string): boolean {
	let claim: Claim | "busy";
	try {
		claim = acquireClaim(guardPath, "exclusive");
	} catch {
		return false;
	}
	if (claim === "busy") return true;
	claim.release();
	return false;
}

const held = new Map<string, Claim>();

/** Hold the shared claim on a guard (this bundle, the addon version in use) for the rest of the process lifetime. */
export function holdSessionClaim(guardPath: string): "acquired" | "busy" {
	if (held.has(guardPath)) return "acquired";
	const claim = acquireClaim(guardPath, "shared");
	if (claim === "busy") return "busy";
	held.set(guardPath, claim);
	return "acquired";
}
