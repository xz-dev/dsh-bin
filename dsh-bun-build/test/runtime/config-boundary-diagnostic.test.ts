import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("compiled boundary retains stable diagnostic through Error cause; never quotes caught content", () => {
	const root = mkdtempSync(join(tmpdir(), "compiled-boundary-")), config = join(root, "C"); mkdirSync(config, { mode: 0o700 });
	const entry = join(root, "entry.ts"), executable = join(root, process.platform === "win32" ? "probe.exe" : "probe");
	writeFileSync(entry, `import {createConfigPaths} from ${JSON.stringify(resolve(import.meta.dir, "../../runtime/compat/config-paths.ts"))};
try {createConfigPaths(undefined,${JSON.stringify(config)}).assertStartup([{outcome:{kind:'failed',error:{code:'DSH_CONFIG_BOUNDARY',message:'synthetic-secret-never-quote'}}}]); console.log('READY')}catch(e){console.error(new Error('startup failed',{cause:e}));process.exit(1)}`);
	const build = Bun.spawnSync([process.execPath, "build", "--compile", "--minify", "--bytecode", "--format=esm", entry, "--outfile", executable], { env: process.env, timeout: 120_000 });
	expect(build.exitCode, build.stderr.toString()).toBe(0);
	for (let i = 0; i < 10; i++) {
		const result = Bun.spawnSync([executable], { env: process.env, timeout: 10_000 });
		expect(result.exitCode).not.toBe(0); expect(result.stdout.toString()).not.toContain("READY");
		expect(result.stderr.toString()).toContain("DSH_CONFIG_BOUNDARY");
		expect(result.stderr.toString()).toContain("configuration path violates selected configuration boundary");
		expect(result.stderr.toString()).not.toContain("synthetic-secret-never-quote");
	}
}, 150_000);
