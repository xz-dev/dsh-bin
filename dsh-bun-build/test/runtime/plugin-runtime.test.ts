// Embedded pnpm and plugin runtime (4.1–4.3) through the compiled entry, with only git and sh on PATH.
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { appBuilt, type Fixture, makeBundle, pnpmFetched, toolsOnlyPath } from "./bundle-fixture.ts";

const online = !process.env.DSH_BIN_OFFLINE;
let fx: Fixture;

async function dsh(args: string[], home: string, extraEnv: Record<string, string> = {}) {
	const proc = Bun.spawn([fx.native, ...args], {
		cwd: home,
		env: { PATH: toolsOnlyPath(fx.root), HOME: home, DSH_HOME: home, NO_COLOR: "1", ...extraEnv },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => proc.kill(), 240_000);
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	clearTimeout(timer);
	return { code: await proc.exited, stdout, stderr };
}

describe.skipIf(!appBuilt || !pnpmFetched)("embedded pnpm", () => {
	beforeAll(() => {
		fx = makeBundle();
	});

	test.skipIf(!online)("4.1: plugin add from GitHub with only git and sh on PATH", async () => {
		const home = mkdtempSync(join(fx.root, "home-"));
		const r = await dsh(["plugin", "--profile", "t", "add", "github:xz-dev/dsh-caveman"], home);
		expect(r.stderr).not.toContain("pnpm was not found");
		expect(r.code).toBe(0);
		expect(JSON.parse(readFileSync(join(home, "profiles/t/package.json"), "utf8")).dependencies["dsh-caveman"]).toBe("github:xz-dev/dsh-caveman");
		expect(existsSync(join(home, "profiles/t/node_modules/dsh-caveman/package.json"))).toBe(true);
	}, 300_000);

	test("4.2: a lifecycle script calling `node -e` runs on the bundle runtime", async () => {
		const home = mkdtempSync(join(fx.root, "home-"));
		const pkg = join(fx.root, "lifecycle-probe");
		mkdirSync(pkg, { recursive: true });
		writeFileSync(
			join(pkg, "package.json"),
			JSON.stringify({
				name: "lifecycle-probe",
				version: "1.0.0",
				scripts: { postinstall: "node -e \"require('fs').writeFileSync('ran', 'bun ' + process.versions.bun)\"" },
			}),
		);
		// pnpm 11 runs build scripts only for approved packages (the user's policy): the first add records the
		// package under allowBuilds and stops; the user approves it and installs again.
		const first = await dsh(["plugin", "--profile", "t", "add", `file:${pkg}`], home);
		expect(first.stdout + first.stderr).toContain("Ignored build scripts");
		const workspace = join(home, "profiles/t/pnpm-workspace.yaml");
		writeFileSync(workspace, readFileSync(workspace, "utf8").replace(": set this to true or false", ": true"));
		const r = await dsh(["plugin", "--profile", "t", "install"], home);
		if (r.code !== 0) console.error(r.stdout, r.stderr);
		expect(r.code).toBe(0);
		expect(readFileSync(join(home, "profiles/t/node_modules/lifecycle-probe/ran"), "utf8")).toStartWith("bun ");
	}, 300_000);

	// pnpm 11 (upstream's packageManager) reads registry settings from `.npmrc` and `pnpm_config_*`
	// variables; it ignores `npm_config_registry`. The bundle keeps that behaviour unchanged.
	for (const via of ["profile .npmrc", "pnpm_config_registry"] as const) {
		test(`4.3: a registry set through ${via} reaches the embedded pnpm`, async () => {
			const seen: string[] = [];
			const server = Bun.serve({
				port: 0,
				fetch(req) {
					seen.push(new URL(req.url).pathname);
					return new Response("{}", { status: 404 });
				},
			});
			try {
				const home = mkdtempSync(join(fx.root, "home-"));
				const registry = `http://127.0.0.1:${server.port}/`;
				let env: Record<string, string> = { pnpm_config_fetch_retries: "0" };
				if (via === "profile .npmrc") {
					mkdirSync(join(home, "profiles/t"), { recursive: true });
					await dsh(["plugin", "--profile", "t", "--version"], home);
					writeFileSync(join(home, "profiles/t/.npmrc"), `registry=${registry}\n`);
				} else env = { ...env, pnpm_config_registry: registry };
				const r = await dsh(["plugin", "--profile", "t", "add", "dsh-bin-registry-probe"], home, env);
				if (!seen.length) console.error(r.stdout, r.stderr);
				expect(r.code).not.toBe(0); // the fixture registry knows no packages
				expect(seen.some((p) => p.includes("dsh-bin-registry-probe"))).toBe(true);
			} finally {
				server.stop(true);
			}
		}, 300_000);
	}

	test("4.3: an explicit pnpm command wins over the bundle's pnpm shim on PATH", async () => {
		// The transformed app requires its validated bootstrap. Exercise the actual mounted service,
		// not an internal-module import from a plain Bun process with no application context.
		const marker = join(fx.root, "custom-pnpm-ran");
		const custom = join(fx.root, "custom-pnpm");
		writeFileSync(custom, `#!/bin/sh\necho "$@" > "${marker}"\necho https://custom.example/\n`, { mode: 0o755 });
		const home = mkdtempSync(join(fx.root, "home-"));
		const dir = join(home, "profiles/custom"), pkg = join(dir, "node_modules/custom-probe");
		mkdirSync(pkg, { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "custom-profile", private: true, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "custom-probe"] } } }));
		writeFileSync(join(dir, "cordis.patch.yml"), `- id: plugin-manager\n  config:\n    pnpmCommand: ${JSON.stringify(custom)}\n`);
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "custom-probe", version: "1.0.0", type: "module", main: "index.js", dsh: { bundle: { patch: "cordis.patch.yml" } } }));
		writeFileSync(join(pkg, "cordis.patch.yml"), "- insert:\n    - id: custom-probe\n      name: custom-probe\n");
		writeFileSync(join(pkg, "index.js"), `export const inject = ['pluginManager', 'appReady', 'appExit'];
export function apply(ctx) {
  ctx.appReady.onReady(() => {
    void ctx.pluginManager.registries().then(result => {
      console.log('CUSTOM_REGISTRY ' + result.resolved); ctx.appExit(0);
    }).catch(error => { console.error(error); ctx.appExit(1); });
  });
}`);
		const result = await dsh(["--profile", "custom"], home);
		if (result.code !== 0) console.error(result.stdout, result.stderr);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("CUSTOM_REGISTRY https://custom.example/");
		expect(readFileSync(marker, "utf8")).toContain("config get registry");
	});
});
