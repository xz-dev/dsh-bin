import { expect, test } from "bun:test";
import { libcCandidates } from "../../runtime/usage-claim";

test("FreeBSD libc loader uses system absolute path; existing platforms retain candidates", () => {
	for (const arch of ["x64", "arm64"] as const) expect(libcCandidates("freebsd", arch)).toEqual(["/lib/libc.so.7"]);
	expect(libcCandidates("darwin", "arm64")).toEqual(["/usr/lib/libSystem.B.dylib"]);
	expect(libcCandidates("linux", "x64")).toEqual(["libc.so.6", "libc.musl-x86_64.so.1", "/lib/ld-musl-x86_64.so.1", "libc.so"]);
	expect(libcCandidates("linux", "arm64")).toEqual(["libc.so.6", "libc.musl-aarch64.so.1", "/lib/ld-musl-aarch64.so.1", "libc.so"]);
});
