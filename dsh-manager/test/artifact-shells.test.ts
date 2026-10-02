// SC-SHELLS: native acceptance uses installed hooks, runtime candidates and isolated profiles.
import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { artifactShells } from "../../dsh-bun-build/scripts/artifact-e2e.mjs";
import { addRuntime, baseEnv, cleanup, hasZig, newInstall, tree, WIN } from "./harness.ts";

afterEach(cleanup);
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
