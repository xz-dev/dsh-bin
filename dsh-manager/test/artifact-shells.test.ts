// SC-SHELLS: native acceptance uses installed hooks, runtime candidates and isolated profiles.
import { afterEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { artifactShells, checkedProcess } from "../../dsh-bun-build/scripts/artifact-e2e.mjs";
import { addRuntime, baseEnv, cleanup, hasZig, newInstall, tempDir, tree, WIN } from "./harness.ts";

afterEach(cleanup);
for (const [name, script] of [
	["descendant keeps output pipes open", "sleep 1 & exit 0"],
	["SIGTERM handler exits successfully", "trap 'exit 0' TERM; while :; do :; done"],
]) {
	test.skipIf(WIN)(`RL-ARTIFACT-E2E: deadline rejects when ${name}`, async () => {
		const start = performance.now();
		await expect(checkedProcess(["/bin/sh", "-c", script], import.meta.dir, process.env, 200)).rejects.toThrow(/timed out after 0\.2s:/);
		expect(performance.now() - start).toBeLessThan(800);
		if (name.startsWith("descendant")) {
			// Rejected pipe reads must not keep the test runner itself alive until the descendant exits.
			const code = `import { checkedProcess } from ${JSON.stringify(join(import.meta.dir, "../../dsh-bun-build/scripts/artifact-e2e.mjs"))}; try { await checkedProcess(["/bin/sh", "-c", ${JSON.stringify(script)}], ${JSON.stringify(import.meta.dir)}, process.env, 200); } catch {}`;
			const began = performance.now(), child = spawnSync(process.execPath, ["-e", code], { timeout: 800 });
			expect(child.status).toBe(0);
			expect(performance.now() - began).toBeLessThan(800);
		}
	}, 2_000);
}

test("SC-SHELLS: every shell caller gets isolated profile/cache variables and an unambiguous PATH", async () => {
	const home = tempDir("dsh-shell-env-"), empty = join(home, "empty-path");
	mkdirSync(empty);
	writeFileSync(join(home, "completion.json"), JSON.stringify({ commands: [{ name: "plugin" }] }));
	// Bun runs this stub as `manager`: record the environment at the real child-process seam.
	writeFileSync(join(home, "manager"), `await Bun.write("env.json", JSON.stringify(process.env)); console.error("environment recorded"); process.exit(1);`);
	const logging = spyOn(console, "log").mockImplementation(() => {});
	try {
		await expect(artifactShells({ exe: process.execPath, home, bundle: home, runtime: "1.0.0", target: "env-probe", env: {
			PATH: empty, Path: "must-not-shadow-PATH", HOME: "host-home", USERPROFILE: "host-userprofile",
			APPDATA: "host-roaming", LOCALAPPDATA: "host-local", TMP: "host-tmp", TEMP: "host-temp", TMPDIR: "host-tmpdir",
		} })).rejects.toThrow(/environment recorded/);
	} finally { logging.mockRestore(); }
	const child = JSON.parse(readFileSync(join(home, "env.json"), "utf8"));
	for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TMP", "TEMP", "TMPDIR"]) expect(child[key]).toBe(home);
	// `bun manager` prepends script-runner node_modules/.bin entries, but must retain the caller PATH.
	expect(child.PATH.endsWith(`${dirname(process.execPath)}${delimiter}${empty}`)).toBe(true);
	expect(child[WIN ? "PSMODULEANALYSISCACHEPATH" : "PSModuleAnalysisCachePath"]).toBe(join(home, "powershell-analysis-cache"));
	if (WIN) expect(Object.keys(child).filter(key => key.toUpperCase() === "PATH")).toEqual(["PATH"]);
});

test.skipIf(!hasZig)("SC-SHELLS: artifact acceptance loads installed native hooks and restores profiles without launching runtime", async () => {
	const i = newInstall(), runtime = "1.0.0";
	addRuntime(i.data, runtime, { completion: { schemaVersion: 1, commands: [{ name: "", options: [] }, { name: "plugin", options: [] }] } });
	await artifactShells({ exe: i.exe, home: i.home, bundle: join(i.data, "bundles", runtime), runtime, target: `${process.platform}-${process.arch}`, env: baseEnv(i) });
	const shells = WIN ? ["pwsh", "powershell"] : ["bash", "zsh", "fish", "pwsh"];
	let executed = 0;
	for (const shell of shells) {
		if (!Bun.which(WIN ? `${shell}.exe` : shell)) continue;
		executed++;
		const path = join(i.home, ["pwsh", "powershell"].includes(shell) ? `${shell}-profile.ps1` : shell === "fish" ? "config/fish/config.fish" : `.${shell}rc`);
		expect(readFileSync(path, "utf8")).toBe(`${["pwsh", "powershell"].includes(shell) ? "\ufeff" : ""}# preserved user settings`);
	}
	expect(executed).toBeGreaterThan(0);
	expect(existsSync(join(i.home, "config/fish/completions/dsh.fish"))).toBe(false);
	expect(tree(i.out)).toEqual([]);
}, 180_000);
