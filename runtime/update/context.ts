// What every maintenance command needs to know about the running installation.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type BundleMeta, type Channel, exeName, installOf, managedBy, readBundleMeta, recordedChannel } from "../layout.ts";

/** An expected failure: printed as `error: <message>` (plus optional hint lines) and exit status `code`. */
export class UserError extends Error {
	constructor(
		message: string,
		readonly hints: string[] = [],
		readonly code = 1,
	) {
		super(message);
	}
}

export type Context = {
	root: string;
	bundleDir: string;
	running: string;
	meta: BundleMeta;
	channel: Channel;
	managed?: string;
	platform: NodeJS.Platform;
	out(line?: string): void;
	err(line: string): void;
};

export const NON_BUNDLE_GUIDANCE = [
	"this dsh is not a dsh-bin bundle installation, so `dsh update` cannot replace it.",
	"Install a bundle from https://github.com/xz-dev/dsh-bin/releases (or through Scoop or your system package manager) to get self-update.",
];

/** The install containing `execPath`, or a UserError with bundle-install guidance (spec "Non-bundle installs"). */
export function resolveContext(execPath = process.execPath, platform = process.platform): Context {
	const bundleDir = dirname(execPath);
	const install = installOf(bundleDir);
	const meta = install ? readBundleMeta(bundleDir) : undefined;
	if (!install || !meta || meta.name !== "dsh-bin" || meta.version !== install.version) {
		throw new UserError(NON_BUNDLE_GUIDANCE[0]!, [NON_BUNDLE_GUIDANCE[1]!]);
	}
	return {
		root: install.root,
		bundleDir,
		running: install.version,
		meta,
		channel: recordedChannel(install.root, meta.channel),
		managed: managedBy(install.root, bundleDir),
		platform,
		out: (line = "") => process.stdout.write(`${line}\n`),
		err: (line) => process.stderr.write(`${line}\n`),
	};
}

export const LAUNCHER_MARKER = "DSH_BIN_LAUNCHER_VERSION=";

/** Version embedded in a launcher binary (read from its bytes, never by running it). */
export function launcherVersionOf(bytes: Uint8Array): string | undefined {
	const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const at = buf.indexOf(LAUNCHER_MARKER);
	if (at < 0) return undefined;
	const start = at + LAUNCHER_MARKER.length;
	const value = /^[0-9A-Za-z.+_-]+/.exec(buf.toString("latin1", start, Math.min(buf.length, start + 128)))?.[0];
	return value || undefined;
}

export const launcherPath = (root: string, platform = process.platform) => join(root, exeName("dsh", platform));

/** Version the root launcher starts (the active version), if the launcher is readable. */
export function launcherVersion(root: string, platform = process.platform): string | undefined {
	const path = launcherPath(root, platform);
	return existsSync(path) ? launcherVersionOf(readFileSync(path)) : undefined;
}

/** `bundle.json` of the active (root launcher) bundle, falling back to the running one. */
export function activeMeta(ctx: Context): BundleMeta {
	const active = launcherVersion(ctx.root, ctx.platform);
	return (active && readBundleMeta(join(ctx.root, "bundles", active))) || ctx.meta;
}
