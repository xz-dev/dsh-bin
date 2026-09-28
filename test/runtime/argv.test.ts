import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dshArgv, userArgs } from "../../runtime/argv.ts";

const bin = "/b/app/lib/bin.js";

test("userArgs drops the compiled entry path and the restart marker", () => {
	expect(userArgs(["dsh-native", "/$bunfs/root/entry", "--profile", "tui"], bin)).toEqual(["--profile", "tui"]);
	expect(userArgs(["dsh-native", "/$bunfs/root/entry", bin, "--profile", "tui"], bin)).toEqual(["--profile", "tui"]);
	expect(userArgs(["bun", "/src/entry.ts", "-c"], bin)).toEqual(["-c"]);
	// Only a leading marker is dropped; a user argument equal to it later on stays.
	expect(userArgs(["x", "e", "a", bin], bin)).toEqual(["a", bin]);
	expect(dshArgv(["x", "/$bunfs/root/entry", bin, "a"], "/e", bin)).toEqual(["/e", bin, "a"]);
});

test("a compiled respawn with [...execArgv, ...argv.slice(1)] sees exactly the original user arguments", () => {
	const out = join(mkdtempSync(join(tmpdir(), "dsh-bin-argv-")), "probe");
	const build = Bun.spawnSync([process.execPath, "build", "--compile", join(import.meta.dir, "fixtures/restart-probe.ts"), "--outfile", out], { stdout: "pipe", stderr: "pipe" });
	expect(build.exitCode).toBe(0);
	const user = ["--profile", "tui", "--resume", "a b", "", "-"];
	const r = Bun.spawnSync([out, ...user], { stdout: "pipe", stderr: "inherit" });
	const seen = JSON.parse(r.stdout.toString());
	expect(seen.user).toEqual(user);
	expect(seen.argv).toEqual(user);
});
