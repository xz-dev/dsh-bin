// Native runtime claims against real manager retirement. Stub proves process/transport only, not app I/O.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { acquireClaim } from "../../dsh-bun-build/runtime/usage-claim.ts";
import { addRuntime, baseEnv, build, cleanup, EXE, hasZig, newInstall, run, tempDir, WIN } from "./harness.ts";

const VERSION = "V1";
let compiled: string;
beforeAll(() => {
	if (!hasZig) return;
	build(); compiled = join(tempDir("claim-native-"), `dsh-native${EXE}`);
	const targetOS = WIN ? "windows" : process.platform;
	execFileSync("bun", [resolve(import.meta.dir, "../../dsh-bun-build/scripts/compile-entry.mjs"), `bun-${targetOS}-${process.arch}`, compiled], { stdio: "ignore" });
}, 120_000);
afterAll(cleanup);

function fixture() {
	const i = newInstall(); addRuntime(i.data, VERSION);
	const bundle = join(i.data, "bundles", VERSION);
	cpSync(compiled, join(bundle, `dsh-native${EXE}`));
	mkdirSync(join(bundle, "app/lib"), { recursive: true }); mkdirSync(join(bundle, "app/node_modules"));
	writeFileSync(join(bundle, "app/package.json"), '{"name":"claim-stub","private":true}');
	writeFileSync(join(bundle, "app/lib/bin.js"), `export async function runCli() { console.log("APP_ENTERED " + process.env.DSH_MANAGER_LAUNCH); if (process.env.CLAIM_HOLD) await new Response(Bun.stdin.stream()).text(); }`);
	for (const kind of ["plugins", "config"]) expect(run(i, ["manager", "snapshot", kind, "new", "--use", VERSION, "--empty"]).status).toBe(0);
	const config = join(i.data, "config-snapshots", `${VERSION}@1`);
	writeFileSync(join(config, ".credentials.yaml"), "isolated-fake-credential\n");
	return { ...i, bundle, config, guard: join(config, ".usage.lock") };
}
const payload = (i: ReturnType<typeof fixture>) => JSON.stringify({ protocol: 2, runtime: VERSION, dataRoot: i.data, home: join(i.data, "home"), snapshot: { id: `${VERSION}@1`, dir: join(i.data, "snapshots", `${VERSION}@1`) }, configSnapshot: { id: `${VERSION}@1`, dir: i.config }, addons: {}, cache: join(i.data, "cache"), tmp: join(i.data, "tmp"), manager: "claim-test" });

function session(argv: string[], env: Record<string, string>) {
	const child = spawn(argv[0]!, argv.slice(1), { env, stdio: "pipe" });
	let stdout = "", stderr = "";
	child.stdout.on("data", b => { stdout += b.toString(); }); child.stderr.on("data", b => { stderr += b.toString(); });
	const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
	const done = new Promise<number | null>((resolve, reject) => { child.on("close", code => { clearTimeout(timer); resolve(code); }); child.on("error", error => { clearTimeout(timer); reject(error); }); });
	return { child, done, stdout: () => stdout, stderr: () => stderr };
}
async function entered(s: ReturnType<typeof session>) {
	const deadline = Date.now() + 5000;
	while (!s.stdout().includes("APP_ENTERED") && s.child.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
	expect(s.stdout(), s.stderr()).toContain("APP_ENTERED");
}

// Windows file symlinks require privileges; native reparse behavior remains a separately executed gate there.
test.skipIf(!hasZig || WIN)("RB-CLAIM: final config guard symlink fails before app entry without touching outside bytes", () => {
	const i = fixture(), outside = join(i.home, "outside-guard"), saved = readFileSync(join(i.config, ".credentials.yaml"));
	writeFileSync(outside, "outside sentinel"); renameSync(i.guard, join(i.config, "retired-guard")); symlinkSync(outside, i.guard);
	const r = spawnSync(join(i.bundle, `dsh-native${EXE}`), ["probe"], { env: { ...baseEnv(i), DSH_MANAGER_LAUNCH: payload(i) }, encoding: "utf8", timeout: 10000 });
	expect(r.status).toBe(1); expect(r.stdout).not.toContain("APP_ENTERED"); expect(r.stderr).toContain("claim");
	expect(readFileSync(outside, "utf8")).toBe("outside sentinel"); expect(readFileSync(join(i.config, ".credentials.yaml"))).toEqual(saved);
	const released = acquireClaim(join(i.bundle, ".usage.lock"), "exclusive"); expect(released).not.toBe("busy"); if (released !== "busy") released.release();
});

test.skipIf(!hasZig)("RB-CLAIM: ordinary parent-independent runtime protects all current guards until exit", async () => {
	const i = fixture(), s = session([join(i.bundle, `dsh-native${EXE}`)], { ...baseEnv(i), DSH_MANAGER_LAUNCH: payload(i), CLAIM_HOLD: "1" });
	try {
		await entered(s);
		for (const g of [join(i.bundle, ".usage.lock"), join(i.data, "snapshots", `${VERSION}@1`, ".usage.lock"), i.guard]) expect(acquireClaim(g, "exclusive")).toBe("busy");
		const removal = run(i, ["manager", "snapshot", "config", "remove", `${VERSION}@1`]);
		expect(removal.status).toBe(1); expect(removal.stderr).toContain("in use"); expect(existsSync(i.config)).toBe(true);
	} finally { s.child.stdin.end(); await s.done; }
	expect(await s.done, s.stderr()).toBe(0);
	expect(run(i, ["manager", "snapshot", "config", "remove", `${VERSION}@1`]).status).toBe(0);
});

test.skipIf(!hasZig || process.platform !== "linux" || !Bun.which("strace"))("RB-CLAIM: opened config guard replaced before flock fails closed, releases retired claims", async () => {
	const i = fixture(), saved = readFileSync(join(i.config, ".credentials.yaml")), meta = readFileSync(join(i.config, "snapshot.json"));
	const trace = join(tempDir("claim-trace-"), "race.strace"), retired = join(i.config, "retired-guard");
	const s = session([Bun.which("strace")!, "-f", "-o", trace, "-e", "trace=flock,openat", "-e", "inject=flock:delay_enter=3s:when=3", join(i.bundle, `dsh-native${EXE}`)], { ...baseEnv(i), DSH_MANAGER_LAUNCH: payload(i), CLAIM_HOLD: "1" });
	let swapped = false;
	try {
		const deadline = Date.now() + 6000;
		while (!swapped && s.child.exitCode === null && Date.now() < deadline) {
			try {
				const pid = readFileSync(`/proc/${s.child.pid}/task/${s.child.pid}/children`, "utf8").trim().split(/\s+/)[0];
				if (pid) for (const fd of readdirSync(`/proc/${pid}/fd`)) if (readlinkSync(`/proc/${pid}/fd/${fd}`) === i.guard) {
					renameSync(i.guard, retired); writeFileSync(i.guard, ""); swapped = true; break;
				}
			} catch { /* /proc entries can disappear while observing child startup. */ }
			if (!swapped) await Bun.sleep(10);
		}
		expect(swapped).toBe(true);
		const deadlineExit = Date.now() + 6000;
		while (!s.stdout().includes("APP_ENTERED") && s.child.exitCode === null && Date.now() < deadlineExit) await Bun.sleep(10);
	} finally { s.child.stdin.end(); }
	const code = await s.done;
	console.info(JSON.stringify({ swapped, appEntered: s.stdout().includes("APP_ENTERED"), runtimeExit: code }));
	expect(code).toBe(1); expect(s.stdout()).not.toContain("APP_ENTERED"); expect(s.stderr()).toContain("is being removed");
	expect(readFileSync(join(i.config, ".credentials.yaml"))).toEqual(saved); expect(readFileSync(join(i.config, "snapshot.json"))).toEqual(meta);
	for (const guard of [i.guard, retired, join(i.bundle, ".usage.lock"), join(i.data, "snapshots", `${VERSION}@1`, ".usage.lock")]) {
		const c = acquireClaim(guard, "exclusive"); expect(c).not.toBe("busy"); if (c !== "busy") c.release();
	}
	// No app entered. Once aborted runtime exits, a later explicit removal is safe, not permanently busy.
	expect(run(i, ["manager", "snapshot", "config", "remove", `${VERSION}@1`]).status).toBe(0);
}, 20_000);

test.skipIf(!hasZig || WIN)("RB-ROOT: manager XDG linked ancestor agrees with runtime physical identity", () => {
	const i = fixture(), link = join(tempDir("claim-xdg-"), "logical-root"); symlinkSync(i.dir, link);
	writeFileSync(join(i.dir, ".dsh-manager-install.json"), '{"schema":1,"owner":"portage"}');
	const before = { config: readFileSync(join(i.config, ".credentials.yaml")), metadata: readFileSync(join(i.config, "snapshot.json")) };
	const r = run(i, ["probe"], { env: { XDG_DATA_HOME: link } });
	expect(r.status, r.stderr).toBe(0); expect(r.stdout).toContain("APP_ENTERED");
	expect(readFileSync(join(i.config, ".credentials.yaml"))).toEqual(before.config); expect(readFileSync(join(i.config, "snapshot.json"))).toEqual(before.metadata);
	const launch = JSON.parse(r.stdout.trim().slice("APP_ENTERED ".length));
	expect(launch.dataRoot).toBe(join(link, "dsh-bin")); expect(launch.snapshot.dir).toBe(join(link, "dsh-bin/snapshots", `${VERSION}@1`)); expect(launch.configSnapshot.dir).toBe(join(link, "dsh-bin/config-snapshots", `${VERSION}@1`));
});
