// Runtime usage claims (runtime-bundles "重启保持当前运行上下文"). Managed runtime processes hold
// shared locks on the resolved runtime, both typed snapshots and addon guards; manager retirement needs exclusive
// locks. POSIX flock(2) and Windows LockFileEx release claims when their handles close, including process
// exit. The runtime reacquires shared claims on application restart; it does not choose or delete objects.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";

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
			const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			let locked = false, keep = false;
			try {
				if (!fstatSync(fd).isFile()) throw new Error(`usage claim: guard is not an ordinary file: ${path}`);
				if (flock(fd, (mode === "shared" ? LOCK_SH : LOCK_EX) | LOCK_NB) !== 0) return "busy";
				locked = true;
				// Retirement can replace the named guard between open and flock. Protect only its current generation.
				const opened = fstatSync(fd, { bigint: true });
				let current;
				try { current = lstatSync(path, { bigint: true }); } catch { return "busy"; }
				if (!current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino) return "busy";
				keep = true;
				let released = false;
				return {
					release() {
						if (released) return;
						released = true;
						flock(fd, LOCK_UN);
						closeSync(fd);
					},
				};
			} finally {
				if (!keep) { if (locked) flock(fd, LOCK_UN); closeSync(fd); }
			}
		},
	};
}

function windowsBackend(): Backend {
	const GENERIC_READ = 0x80000000;
	const SHARE_ALL = 0x7; // read | write | delete: the guard can be renamed into quarantine while locked
	const OPEN_EXISTING = 3;
	const OPEN_REPARSE_POINT = 0x00200000;
	const BACKUP_SEMANTICS = 0x02000000;
	const DIRECTORY_OR_REPARSE = 0x10 | 0x400;
	const FILE_TYPE_DISK = 1;
	const LOCKFILE_FAIL_IMMEDIATELY = 1;
	const LOCKFILE_EXCLUSIVE_LOCK = 2;
	const INVALID_HANDLE = 0xffffffffffffffffn;
	const k32 = dlopen("kernel32.dll", {
		CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.u64 },
		LockFileEx: { args: [FFIType.u64, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
		UnlockFileEx: { args: [FFIType.u64, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
		CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
		GetFileType: { args: [FFIType.u64], returns: FFIType.u32 },
		GetFileInformationByHandle: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
	}).symbols;
	const open = (path: string) => {
		const wide = Buffer.from(`${path}\0`, "utf16le");
		const handle = BigInt(k32.CreateFileW(ptr(wide), GENERIC_READ, SHARE_ALL, null, OPEN_EXISTING, OPEN_REPARSE_POINT | BACKUP_SEMANTICS, null));
		if (handle === INVALID_HANDLE || handle === -1n || handle === 0n) throw new Error(`usage claim: cannot open ${path}`);
		return handle;
	};
	const identity = (handle: bigint, path: string) => {
		const info = Buffer.alloc(52); // BY_HANDLE_FILE_INFORMATION: attributes, volume serial, file index high/low.
		if (k32.GetFileType(handle) !== FILE_TYPE_DISK || !k32.GetFileInformationByHandle(handle, ptr(info)) || (info.readUInt32LE(0) & DIRECTORY_OR_REPARSE)) throw new Error(`usage claim: guard is not an ordinary file: ${path}`);
		return [info.readUInt32LE(28), info.readUInt32LE(44), info.readUInt32LE(48)];
	};
	return {
		acquire(path, mode) {
			const handle = open(path), overlapped = new Uint8Array(32);
			let locked = false, keep = false;
			try {
				identity(handle, path);
				const flags = LOCKFILE_FAIL_IMMEDIATELY | (mode === "exclusive" ? LOCKFILE_EXCLUSIVE_LOCK : 0);
				if (!k32.LockFileEx(handle, flags, 0, 1, 0, ptr(overlapped))) return "busy";
				locked = true;
				const opened = identity(handle, path);
				let named: bigint | undefined;
				try {
					named = open(path);
					const current = identity(named, path);
					if (opened.some((v, i) => v !== current[i])) return "busy";
				} catch { return "busy"; }
				finally { if (named !== undefined) k32.CloseHandle(named); }
				keep = true;
				let released = false;
				return {
					release() {
						if (released) return;
						released = true;
						k32.UnlockFileEx(handle, 0, 1, 0, ptr(overlapped));
						k32.CloseHandle(handle);
					},
				};
			} finally {
				if (!keep) { if (locked) k32.UnlockFileEx(handle, 0, 1, 0, ptr(overlapped)); k32.CloseHandle(handle); }
			}
		},
	};
}

let backend: Backend | undefined;
const getBackend = () => (backend ??= process.platform === "win32" ? windowsBackend() : posixBackend());

/** Try to take a claim without waiting. `"busy"` means a conflicting claim is held elsewhere. */
export function acquireClaim(guardPath: string, mode: ClaimMode): Claim | "busy" {
	return getBackend().acquire(guardPath, mode);
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
