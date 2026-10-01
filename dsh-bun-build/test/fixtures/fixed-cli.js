// Static extraction fixture: importing this file would load application code.
throw new Error("completion export must not execute the app");
function parseDshArgs(argv, version) {
	const program = new Command();
	program.name("dsh").version(version, "-V, --version").helpOption(false).helpCommand(false)
		.option("--profile <name>", "profile").option("--patch <path>", "patch")
		.option("--dump-config", "dump").action(() => {});
	if (argv[0] === "plugin") {
		const plugin = program.command("plugin").description("plugins");
		plugin.requiredOption("--profile <name>", "profile").action(() => {});
	}
}
