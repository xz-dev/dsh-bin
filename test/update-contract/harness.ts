// Golden update-contract harness (self-update spec "Update behaviour contract tests"). Runs the real compiled
// entry (`bundles/<v>/dsh-native`, exactly what the launcher executes) against a fixture index and fixture
// release assets served locally, recording every request. Fixture bundles carry a hostile upstream
// `app/lib/bin.js` with its own `update` command, which must never run for maintenance commands.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddonRelease, AddonTable, BundleMeta, Channel, Slot } from "../../runtime/layout.ts";
import { makeReadOnly, makeWritable } from "../../runtime/readonly.ts";
import { addonPlatform } from "../../runtime/update/addon-resolve.ts";
import { hostTargetId } from "../../scripts/targets.mjs";
import { extractZip, type ZipInput, writeZip } from "../../runtime/zip.ts";

export const ROOT = resolve(import.meta.dir, "../..");
export const TARGET: string = hostTargetId();
const EXE = process.platform === "win32" ? ".exe" : "";
export const ADDON_PLATFORM = addonPlatform(TARGET);

export const SLOT_A: Slot = { commit: "a".repeat(40), kitVersion: "0.1.2" };
export const SLOT_B: Slot = { commit: "b".repeat(40), kitVersion: "0.1.3" };

/** Upstream stand-in with its own `update` command: prints which bundle ran it, exits 97. */
export const HOSTILE_BIN_JS = `export async function runCli() {\n\tconsole.log("UPSTREAM-DSH " + import.meta.dir + " " + process.argv.slice(2).join(" "));\n\tprocess.exit(97);\n}\n`;

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Compile the real entry once per test process. */
let nativeCache: string | undefined;
export function compiledNative(): string {
	if (nativeCache) return nativeCache;
	const dir = mkdtempSync(join(tmpdir(), "dsh-contract-native-"));
	const out = join(dir, `dsh-native${EXE}`);
	execFileSync("bun", [join(ROOT, "scripts/compile-entry.mjs"), `bun-${process.platform}-${process.arch}`, out], { stdio: "ignore" });
	nativeCache = out;
	return out;
}

export type AssetFile = { tag: string; name: string; bytes: Uint8Array };
export type BundleSpec = { version: string; seq: number; channel: Channel; slot?: Slot | null; pinned?: string | null; known?: AddonRelease[]; launcherVersion?: string; tamper?: (inputs: ZipInput[]) => void; metaPatch?: Partial<BundleMeta> };
export type AddonSpec = { version: string; seq: number; slot: Slot };

export const tagOf = (channel: Channel, version: string) => (channel === "live" ? `dsh-live-${version}` : `dsh-v${version}`);
export const addonTag = (version: string) => `dsh-addon-office-v${version}`;

export function launcherScript(version: string) {
	return `#!/bin/sh\n# DSH_BIN_LAUNCHER_VERSION=${version}\nexec "$(dirname "$0")/bundles/${version}/dsh-native" "$@"\n`;
}

export function bundleInputs(spec: BundleSpec, native: string): { inputs: ZipInput[]; meta: BundleMeta } {
	const v = spec.version;
	const b = `bundles/${v}`;
	const required = [`dsh${EXE}`, `${b}/dsh-native${EXE}`, `${b}/bundle.json`, `${b}/.usage.lock`, `${b}/app/package.json`, `${b}/app/lib/bin.js`, `${b}/pnpm/dist/pnpm.mjs`, `${b}/bin/node`, `${b}/bin/pnpm`];
	const table: AddonTable = { slot: spec.slot === undefined ? SLOT_A : spec.slot, pinned: spec.pinned ?? null, known: spec.known ?? [] };
	const meta: BundleMeta = {
		schemaVersion: 1,
		name: "dsh-bin",
		version: v,
		tag: tagOf(spec.channel, v),
		channel: spec.channel,
		target: TARGET,
		upstream: { commit: "c".repeat(40), version: "0.1.7-rc.2" },
		launcherCommit: "d".repeat(40),
		addons: { office: table },
		requiredPaths: required,
		...spec.metaPatch,
	};
	const text = (s: string) => new TextEncoder().encode(s);
	const inputs: ZipInput[] = [
		{ name: `dsh${EXE}`, data: text(launcherScript(spec.launcherVersion ?? v)), mode: 0o755 },
		{ name: "bundles", dir: true, mode: 0o755 },
		{ name: b, dir: true, mode: 0o755 },
		{ name: `${b}/dsh-native${EXE}`, data: readFileSync(native), mode: 0o755 },
		{ name: `${b}/bundle.json`, data: text(`${JSON.stringify(meta, null, 2)}\n`), mode: 0o644 },
		{ name: `${b}/.usage.lock`, data: new Uint8Array(), mode: 0o644 },
		{ name: `${b}/app`, dir: true, mode: 0o755 },
		{ name: `${b}/app/package.json`, data: text('{"name":"@deepseek-ai/dsh","type":"module","version":"0.1.7-rc.2"}\n'), mode: 0o644 },
		{ name: `${b}/app/lib`, dir: true, mode: 0o755 },
		{ name: `${b}/app/lib/bin.js`, data: text(HOSTILE_BIN_JS), mode: 0o644 },
		{ name: `${b}/pnpm`, dir: true, mode: 0o755 },
		{ name: `${b}/pnpm/dist`, dir: true, mode: 0o755 },
		{ name: `${b}/pnpm/dist/pnpm.mjs`, data: text("export {};\n"), mode: 0o644 },
		{ name: `${b}/bin`, dir: true, mode: 0o755 },
		{ name: `${b}/bin/node`, data: text("#!/bin/sh\n"), mode: 0o755 },
		{ name: `${b}/bin/pnpm`, data: text("#!/bin/sh\n"), mode: 0o755 },
	];
	spec.tamper?.(inputs);
	return { inputs, meta };
}

export function addonInputs(spec: AddonSpec, patch: Record<string, unknown> = {}): ZipInput[] {
	const text = (s: string) => new TextEncoder().encode(s);
	const meta = { name: "office", version: spec.version, tag: addonTag(spec.version), kitVersion: spec.slot.kitVersion, slot: spec.slot, packages: [`@deepseek-ai/libreoffice-kit@${spec.slot.kitVersion}`], ...patch };
	const kit = "node_modules/@deepseek-ai/libreoffice-kit";
	return [
		{ name: "addon.json", data: text(`${JSON.stringify(meta, null, 2)}\n`), mode: 0o644 },
		{ name: "node_modules", dir: true, mode: 0o755 },
		{ name: "node_modules/@deepseek-ai", dir: true, mode: 0o755 },
		{ name: kit, dir: true, mode: 0o755 },
		{ name: `${kit}/package.json`, data: text(`{"name":"@deepseek-ai/libreoffice-kit","version":"${spec.slot.kitVersion}","main":"index.js"}\n`), mode: 0o644 },
		{ name: `${kit}/index.js`, data: text(`module.exports = { addon: ${JSON.stringify(spec.version)} };\n`), mode: 0o644 },
	];
}

function zipBytes(dir: string, inputs: ZipInput[]): Uint8Array {
	const path = join(dir, `z-${Math.random().toString(36).slice(2)}.zip`);
	writeZip(path, inputs);
	const bytes = readFileSync(path);
	rmSync(path);
	return bytes;
}

/** A fixture release world: bundle/addon assets plus an index that references them. */
export class World {
	readonly dir = mkdtempSync(join(tmpdir(), "dsh-contract-world-"));
	readonly assets = new Map<string, AssetFile>();
	readonly index = { schemaVersion: 1, channels: { release: [] as any[], live: [] as any[] }, addons: { office: [] as any[] } };
	readonly zips = new Map<string, string>();
	readonly metas = new Map<string, BundleMeta>();

	addonRelease(spec: AddonSpec, opts: { patch?: Record<string, unknown>; inIndex?: boolean } = {}): AddonRelease {
		const bytes = zipBytes(this.dir, addonInputs(spec, opts.patch));
		const name = `dsh-addon-office-${ADDON_PLATFORM}.zip`;
		const tag = addonTag(spec.version);
		this.assets.set(`${tag}/${name}`, { tag, name, bytes });
		const entry: AddonRelease = { seq: spec.seq, tag, version: spec.version, slot: spec.slot, assets: { [ADDON_PLATFORM]: { name, size: bytes.length, sha256: sha(bytes) } } };
		if (opts.inIndex !== false) this.index.addons.office.push(entry);
		return entry;
	}

	bundle(spec: BundleSpec, opts: { inIndex?: boolean; indexPatch?: (e: any) => void; postZip?: (b: Uint8Array) => Uint8Array } = {}) {
		const { inputs, meta } = bundleInputs(spec, compiledNative());
		const raw = zipBytes(this.dir, inputs);
		const bytes = opts.postZip ? opts.postZip(raw) : raw;
		const name = `dsh-${TARGET}.zip`;
		const tag = tagOf(spec.channel, spec.version);
		this.assets.set(`${tag}/${name}`, { tag, name, bytes });
		const zip = join(this.dir, `${tag}.zip`);
		writeFileSync(zip, bytes);
		this.zips.set(spec.version, zip);
		this.metas.set(spec.version, meta);
		const entry = {
			seq: spec.seq,
			tag,
			version: spec.version,
			channel: spec.channel,
			upstream: meta.upstream,
			addons: { office: { slot: meta.addons.office!.slot, pinned: meta.addons.office!.pinned } },
			assets: { [TARGET]: { name, size: bytes.length, sha256: sha(bytes) } },
		};
		opts.indexPatch?.(entry);
		if (opts.inIndex !== false) this.index.channels[spec.channel].push(entry);
		return entry;
	}

	dispose() {
		rmSync(this.dir, { recursive: true, force: true });
		if (nativeCache) rmSync(join(nativeCache, ".."), { recursive: true, force: true });
		nativeCache = undefined;
	}
}

export type Request = { method: string; path: string };

/** Serve a world: `/index.json` and `/download/<tag>/<asset>`; records every request. */
export type ServeOptions = {
	indexStatus?: number;
	index?: (index: any) => any;
	indexBody?: string;
	indexDelayMs?: number;
	assetBytes?: (a: AssetFile) => Uint8Array;
};

export function serve(world: World, opts: ServeOptions = {}) {
	const requests: Request[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			requests.push({ method: req.method, path: decodeURIComponent(url.pathname) });
			if (url.pathname === "/index.json") {
				if (opts.indexDelayMs) await Bun.sleep(opts.indexDelayMs);
				if (opts.indexStatus) return new Response("unavailable", { status: opts.indexStatus });
				const body = opts.indexBody ?? JSON.stringify(opts.index ? opts.index(structuredClone(world.index)) : world.index);
				return new Response(body, { headers: { "content-type": "application/json" } });
			}
			const m = /^\/download\/([^/]+)\/([^/]+)$/.exec(url.pathname);
			const asset = m && world.assets.get(`${decodeURIComponent(m[1]!)}/${decodeURIComponent(m[2]!)}`);
			if (asset) return new Response(opts.assetBytes?.(asset) ?? asset.bytes);
			return new Response("not found", { status: 404 });
		},
	});
	return { origin: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
}

/** An install root with `version` installed from its fixture archive (as a user unzip would) and made read-only. */
export function installRoot(world: World, version: string, opts: { channelFile?: Channel; managed?: string } = {}): string {
	const root = mkdtempSync(join(tmpdir(), "dsh-contract-root-"));
	addBundle(world, root, version, true);
	if (opts.channelFile) writeFileSync(join(root, "channel"), `${opts.channelFile}\n`);
	if (opts.managed) writeFileSync(join(root, `.${opts.managed}.managed.lock`), "");
	return root;
}

/** Add another bundle version to an install root (optionally making its launcher the root launcher). */
export function addBundle(world: World, root: string, version: string, launcher = false) {
	const tmp = mkdtempSync(join(tmpdir(), "dsh-contract-x-"));
	extractZip(world.zips.get(version)!, tmp);
	mkdirSync(join(root, "bundles"), { recursive: true });
	execFileSync("mv", [join(tmp, "bundles", version), join(root, "bundles", version)]);
	if (launcher) copyFileSync(join(tmp, `dsh${EXE}`), join(root, `dsh${EXE}`));
	rmSync(tmp, { recursive: true, force: true });
	makeReadOnly(join(root, "bundles", version));
}

/** Install an addon version directly into a root (pre-existing state), with its addons.json record. */
export function addAddon(world: World, root: string, spec: AddonSpec, enabled?: { forced: boolean }) {
	const dir = join(root, "addons", "office", spec.version);
	mkdirSync(dir, { recursive: true });
	const zip = join(world.dir, `a-${spec.version}.zip`);
	writeZip(zip, addonInputs(spec));
	extractZip(zip, dir);
	writeFileSync(join(dir, ".usage.lock"), "");
	makeReadOnly(dir);
	if (enabled) writeFileSync(join(root, "addons.json"), `${JSON.stringify({ office: { version: spec.version, forced: enabled.forced } }, null, 2)}\n`);
}

export type RunResult = { code: number; stdout: string; stderr: string };

/** Run `dsh <args>` through the given bundle's compiled entry (what the root launcher execs). */
export async function dsh(root: string, version: string, args: string[], origin: string, extraEnv: Record<string, string> = {}, exe?: string): Promise<RunResult> {
	const home = join(root, "..", `${root.split("/").pop()}-home`);
	mkdirSync(home, { recursive: true });
	const proc = Bun.spawn([exe ?? join(root, "bundles", version, `dsh-native${EXE}`), ...args], {
		env: { PATH: process.env.PATH ?? "", HOME: home, DSH_HOME: join(home, ".dsh"), DSH_BIN_TEST: "1", DSH_BIN_TEST_ORIGIN: origin, ...extraEnv },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { code, stdout, stderr };
}

/** Run the root launcher script (shell fixture launcher). */
export async function launch(root: string, args: string[], origin: string): Promise<RunResult> {
	const proc = Bun.spawn(["sh", join(root, "dsh"), ...args], { env: { PATH: process.env.PATH ?? "", DSH_BIN_TEST: "1", DSH_BIN_TEST_ORIGIN: origin, HOME: root }, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { code, stdout, stderr };
}

/** Relative paths and content digests of every file under `root` (the observable filesystem state). */
export function snapshot(root: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (dir: string, rel: string) => {
		for (const name of readdirSync(dir, { withFileTypes: true })) {
			const r = rel ? `${rel}/${name.name}` : name.name;
			if (name.isDirectory()) {
				out[`${r}/`] = "dir";
				walk(join(dir, name.name), r);
			} else out[r] = r.endsWith("dsh-native") || r.endsWith("dsh-native.exe") ? "native" : sha(readFileSync(join(dir, name.name))).slice(0, 12);
		}
	};
	walk(root, "");
	return out;
}

export function removeRoot(root: string) {
	if (!existsSync(root)) return;
	makeWritable(root);
	rmSync(root, { recursive: true, force: true });
	rmSync(`${root}-home`, { recursive: true, force: true });
}

export const read = (p: string) => readFileSync(p, "utf8");
export const exists = existsSync;
export { linkSync };
