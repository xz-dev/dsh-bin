// Atomic exchange of two directory entries, for same-version replacement (`dsh update --force`, addon
// `--force`): Linux renameat2(RENAME_EXCHANGE), macOS renamex_np(RENAME_SWAP). Where unavailable (Windows,
// old kernels/libc, filesystems without support), callers fall back to quarantine + rename + restore.
import { dlopen, FFIType, ptr } from "bun:ffi";

type Exchange = (a: string, b: string) => boolean;

const AT_FDCWD = -100;
const RENAME_EXCHANGE = 2;
const RENAME_SWAP = 2;

function load(): Exchange | undefined {
	const cstr = (s: string) => Buffer.from(`${s}\0`, "utf8");
	try {
		if (process.platform === "linux") {
			const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
			for (const name of ["libc.so.6", `libc.musl-${arch}.so.1`, `/lib/ld-musl-${arch}.so.1`]) {
				try {
					const lib = dlopen(name, { renameat2: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 } });
					return (a, b) => lib.symbols.renameat2(AT_FDCWD, ptr(cstr(a)), AT_FDCWD, ptr(cstr(b)), RENAME_EXCHANGE) === 0;
				} catch {
					// Next candidate (musl < 1.2.5 has no renameat2 wrapper).
				}
			}
		}
		if (process.platform === "darwin") {
			const lib = dlopen("/usr/lib/libSystem.B.dylib", { renamex_np: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 } });
			return (a, b) => lib.symbols.renamex_np(ptr(cstr(a)), ptr(cstr(b)), RENAME_SWAP) === 0;
		}
	} catch {
		// No exchange primitive.
	}
	return undefined;
}

let cached: Exchange | null | undefined;

/** Atomically swap `a` and `b` (both must exist). False when the platform or filesystem cannot. */
export function exchange(a: string, b: string): boolean {
	if (process.env.DSH_BIN_TEST === "1" && process.env.DSH_BIN_TEST_NO_EXCHANGE === "1") return false;
	if (cached === undefined) cached = load() ?? null;
	return cached ? cached(a, b) : false;
}
