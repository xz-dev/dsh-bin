import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireClaim } from "../../runtime/usage-claim.ts";

const MODULE = resolve(import.meta.dir, "../../runtime/usage-claim.ts");

function guard() {
	const path = join(mkdtempSync(join(tmpdir(), "usage-claim-")), ".usage.lock");
	writeFileSync(path, "");
	return path;
}

/** A separate process that holds the shared session claim until it is killed. */
async function holder(path: string) {
	const code = `const { holdSessionClaim } = await import(${JSON.stringify(MODULE)});
console.log(holdSessionClaim(${JSON.stringify(path)})); setInterval(() => {}, 1e6);`;
	const proc = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "inherit" });
	const reader = proc.stdout.getReader();
	const { value } = await reader.read();
	expect(new TextDecoder().decode(value).trim()).toBe("acquired");
	return proc;
}

test("a held shared claim blocks an exclusive attempt from another process, not a shared one", async () => {
	const path = guard();
	const proc = await holder(path);
	try {
		expect(acquireClaim(path, "exclusive")).toBe("busy");
		const shared = acquireClaim(path, "shared");
		expect(shared).not.toBe("busy");
		if (shared !== "busy") shared.release();
	} finally {
		proc.kill("SIGKILL");
		await proc.exited;
	}
});

test("the claim is released when the holder is killed with SIGKILL", async () => {
	const path = guard();
	const proc = await holder(path);
	proc.kill("SIGKILL");
	await proc.exited;
	const claim = acquireClaim(path, "exclusive");
	expect(claim).not.toBe("busy");
	if (claim !== "busy") claim.release();
});

test("an exclusive claim blocks a shared session claim; release frees it", () => {
	const path = guard();
	const exclusive = acquireClaim(path, "exclusive");
	if (exclusive === "busy") throw new Error("unexpected busy");
	// flock locks belong to the open file description, so a second open in this process conflicts too.
	expect(acquireClaim(path, "shared")).toBe("busy");
	exclusive.release();
	const shared = acquireClaim(path, "shared");
	expect(shared).not.toBe("busy");
	if (shared !== "busy") shared.release();
});

test("usage guard must be an ordinary file, not a directory", () => {
	const dir = mkdtempSync(join(tmpdir(), "usage-directory-"));
	expect(() => acquireClaim(dir, "shared")).toThrow(/ordinary file/);
});
