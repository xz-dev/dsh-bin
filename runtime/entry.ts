// Compiled entry (D1). Maintenance commands (`dsh update|install|uninstall|list`) are dispatched first,
// before any usage claim, app resolution or compat layer (self-update spec "Launcher owns the update
// command"): they never load upstream code, so an upstream `update` command cannot take them over.
import { writeSync } from "node:fs";
import { isMaintenance, isTopLevelHelp, MAINTENANCE_HELP } from "./update/args.ts";

const user = process.argv.slice(2);
if (isMaintenance(user)) {
	const { main } = await import("./update/cli.ts");
	process.exit(await main(user));
}
if (isTopLevelHelp(user)) {
	// Upstream prints the launcher help and exits 0; the dsh-bin commands follow it.
	process.on("exit", (code) => {
		if (code !== 0) return;
		try {
			writeSync(1, MAINTENANCE_HELP);
		} catch {
			// stdout closed early (for example `dsh --help | head`).
		}
	});
}
await import("./app.ts");
