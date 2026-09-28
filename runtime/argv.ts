// D3 restart normalization. dsh reads user arguments from `process.argv.slice(2)`, so the entry presents
// `[execPath, <app>/lib/bin.js, ...user]`. In-app restarts respawn `execPath` with
// `[...execArgv, ...argv.slice(1)]`, which makes the child's first argument that same bin.js path; the
// child treats it as the internal entry marker and drops it.

/** User arguments, given the raw `process.argv` (argv[1] is the entry script) and the dsh bin.js path. */
export function userArgs(argv: readonly string[], binJs: string): string[] {
	const rest = argv.slice(2);
	if (rest[0] === binJs) rest.shift();
	return rest;
}

export function dshArgv(argv: readonly string[], execPath: string, binJs: string): string[] {
	return [execPath, binJs, ...userArgs(argv, binJs)];
}
