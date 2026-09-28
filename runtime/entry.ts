// Compiled entry (D1). Maintenance commands (`dsh update|install|uninstall|list`) are dispatched first,
// before any usage claim, app resolution or compat layer (self-update spec "Launcher owns the update
// command"): they never load upstream code, so an upstream `update` command cannot take them over.
import { isMaintenance } from "./update/args.ts";

const user = process.argv.slice(2);
if (isMaintenance(user)) {
	const { main } = await import("./update/cli.ts");
	process.exit(await main(user));
}
await import("./app.ts");
