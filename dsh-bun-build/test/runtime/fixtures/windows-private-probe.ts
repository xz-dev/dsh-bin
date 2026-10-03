import { createConfigPaths } from "../../../runtime/compat/config-paths.ts";
import { existsSync, openSync, closeSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";

const [mode, config, control] = process.argv.slice(2);
if (mode === "parent") {
	const paths = createConfigPaths(undefined, config);
	paths.check(join(config, "secret.yaml"));
	const child = Bun.spawn([process.execPath, import.meta.path, "wait", config, control], { env: process.env, stdout: "ignore", stderr: "ignore" });
	writeFileSync(join(control, "child-pid"), String(child.pid));
	writeFileSync(join(control, "parent-authenticated"), "1");
	await new Promise(() => { setInterval(() => {}, 1000); }); // test kills parent; child authenticates itself afterward
} else {
	if (mode === "wait") {
		writeFileSync(join(control, "child-waiting"), "1");
		while (!existsSync(join(control, "release"))) await Bun.sleep(20);
	}
	try {
		const paths = createConfigPaths(undefined, config);
		const path = paths.check(join(config, "secret.yaml"));
		// Instrument sensitive syscall seams, not absence of synthetic secret in stdout.
		const watchPath = paths.checkWatchPath(path);
		writeFileSync(join(control, "sensitive-watch"), "1");
		const watcher = watch(watchPath, () => {}); watcher.close();
		writeFileSync(join(control, "sensitive-open"), "1");
		const fd = openSync(paths.check(path), "r"); closeSync(fd);
		writeFileSync(join(control, "ready"), "1");
		writeFileSync(join(control, "result"), "READY");
	} catch (error) {
		writeFileSync(join(control, "result"), (error as { code?: string }).code ?? "UNKNOWN");
		process.exitCode = 1;
	}
}
