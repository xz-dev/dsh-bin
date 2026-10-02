// Compiled like the real entry. The first run respawns itself exactly as dsh-tui's restartTui does;
// the replacement prints the user arguments it sees.
import { dshArgv, userArgs } from "../../../runtime/argv.ts";

const binJs = "/bundle/app/lib/bin.js";
const raw = [...process.argv];
process.argv = dshArgv(process.argv, process.execPath, binJs);
if (process.env.RESTART_PROBE_CHILD) {
	console.log(JSON.stringify({ raw, user: userArgs(raw, binJs), argv: process.argv.slice(2) }));
} else {
	const child = Bun.spawnSync([process.execPath, ...process.execArgv, ...process.argv.slice(1)], {
		env: { ...process.env, RESTART_PROBE_CHILD: "1" },
		stdout: "pipe",
	});
	process.stdout.write(child.stdout);
}
