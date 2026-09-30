// Embedded pnpm and node shims (design D5). They live in the read-only `bundles/<v>/bin/`, which the
// runtime puts first on PATH for its own process tree. Each shim re-executes the bundle's own dsh-native
// as plain Bun (`BUN_BE_BUN=1`), located relative to the shim, so no Node.js or other runtime is needed and
// processes started without the launcher (in-app restarts, MCP servers) find the same bundle.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const posix = (args) => `#!/bin/sh
# dsh-bin shim: run with the bundle's embedded Bun runtime. Shell builtins only (PATH may hold no tools).
case $0 in */*) dir=\${0%/*} ;; *) dir=. ;; esac
bundle=$(cd "$dir/.." && pwd -P) || exit 1
BUN_BE_BUN=1
export BUN_BE_BUN
exec "$bundle/dsh-native" ${args}"$@"
`;

const cmd = (args) => `@echo off\r
rem dsh-bin shim: run with the bundle's embedded Bun runtime.\r
setlocal\r
set "BUN_BE_BUN=1"\r
"%~dp0..\\dsh-native.exe" ${args}%*\r
exit /b %ERRORLEVEL%\r
`;

// The embedded pnpm is replaced only by `dsh update`; its own "update available" notice would suggest
// `pnpm add -g pnpm`. A user's explicit setting still wins.
const PNPM_ENV_POSIX = 'export BUN_BE_BUN\n: "${npm_config_update_notifier:=false}"\nexport npm_config_update_notifier\n';
const PNPM_ENV_CMD = 'if not defined npm_config_update_notifier set "npm_config_update_notifier=false"\r\n';

/** Shim file name → contents for one OS. */
export function shimFiles(os) {
	if (os === "windows") {
		return {
			"node.cmd": cmd(""),
			"pnpm.cmd": cmd('"%~dp0..\\pnpm\\dist\\pnpm.mjs" ').replace('set "BUN_BE_BUN=1"\r\n', `set "BUN_BE_BUN=1"\r\n${PNPM_ENV_CMD}`),
		};
	}
	return { node: posix(""), pnpm: posix('"$bundle/pnpm/dist/pnpm.mjs" ').replace("export BUN_BE_BUN\n", PNPM_ENV_POSIX) };
}

export function writeShims(bundleDir, os) {
	const dir = join(bundleDir, "bin");
	mkdirSync(dir, { recursive: true });
	for (const [name, text] of Object.entries(shimFiles(os))) {
		writeFileSync(join(dir, name), text);
		chmodSync(join(dir, name), 0o755);
	}
	return dir;
}
