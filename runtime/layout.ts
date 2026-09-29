// Install-root layout (design D6/D7b/D9), shared by the compiled entry, the updater and `dsh list`:
//
//   <root>/dsh(.exe)                         root launcher; its embedded version is the active bundle
//   <root>/bundles/<v>/{dsh-native, app/, pnpm/, bin/, bundle.json, .usage.lock}
//   <root>/addons/<name>/<addon-version>/{addon.json, node_modules/}
//   <root>/addons.json                       {<name>: {version, forced}}
//   <root>/channel                           channel recorded by the last successful activation
//   <root>/update.lock                       maintenance mutex (directory)
//   <root>/.<manager>.managed.lock           package-manager ownership marker
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const ADDON_NAMES = ["office"] as const;
export type AddonName = (typeof ADDON_NAMES)[number];
export type Channel = "release" | "live";
export const CHANNELS: readonly Channel[] = ["release", "live"];

export type Slot = { commit: string; kitVersion: string };
export type AssetRef = { name: string; size: number; sha256: string };
/** One published addon release, as listed in the index and embedded in `bundle.json` (`known`). */
export type AddonRelease = { seq?: number; tag: string; version: string; slot: Slot; assets: Record<string, AssetRef> };
export type AddonTable = { slot: Slot | null; pinned: string | null; known: AddonRelease[] };

/** Launcher/bundle contract version; the launcher refuses a bundle declaring another one (design S2). */
export const LAUNCHER_PROTOCOL = 2;

/** Build position of a bundle: upstream commit time (UTC `toISOString()` form), then dsh-bin run and attempt. */
export type BuildOrder = { upstream: { commitTime: string }; run: number; attempt: number };

/** Whether `s` is a commit time in the one form bundles carry (`Date#toISOString`, so it sorts as text). */
export const isCommitTime = (s: unknown): s is string => typeof s === "string" && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString() === s;

/** Version order (version-selection spec): upstream commit time, then run, then attempt. */
export function compareVersionOrder(a: BuildOrder, b: BuildOrder): number {
	const t = a.upstream.commitTime < b.upstream.commitTime ? -1 : a.upstream.commitTime > b.upstream.commitTime ? 1 : 0;
	return t || a.run - b.run || a.attempt - b.attempt;
}

/** `bundle.json`: the bundle's identity and its embedded addon compatibility table. */
export type BundleMeta = {
	schemaVersion: 2;
	name: "dsh-bin";
	version: string;
	tag: string;
	channel: Channel;
	target: string;
	upstream: { commit: string; commitTime: string; tag?: string; version: string };
	run: number;
	attempt: number;
	launcherProtocol: number;
	launcherCommit: string;
	addons: Partial<Record<AddonName, AddonTable>>;
	requiredPaths: string[];
};

/** `addon.json` inside an installed addon version. */
export type AddonMeta = { name: AddonName; version: string; tag: string; kitVersion: string; slot: Slot; packages: string[] };
export type AddonsState = Partial<Record<AddonName, { version: string; forced: boolean }>>;

export const BUNDLE_META = "bundle.json";
export const ADDON_META = "addon.json";
export const USAGE_GUARD = ".usage.lock";
export const MANAGED_SUFFIX = ".managed.lock";
export const exeName = (base: string, platform = process.platform) => (platform === "win32" ? `${base}.exe` : base);

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

export type Install = { root: string; bundleDir: string; version: string };

/** The managed install containing `bundleDir`, or undefined when the bundle is not under `<root>/bundles/`. */
export function installOf(bundleDir: string): Install | undefined {
	const bundles = dirname(bundleDir);
	if (basename(bundles) !== "bundles") return undefined;
	return { root: dirname(bundles), bundleDir, version: basename(bundleDir) };
}

export function readBundleMeta(bundleDir: string): BundleMeta | undefined {
	const path = join(bundleDir, BUNDLE_META);
	return existsSync(path) ? readJson<BundleMeta>(path) : undefined;
}

export const addonDir = (root: string, name: AddonName, version: string) => join(root, "addons", name, version);

export function readAddonsState(root: string): AddonsState {
	const path = join(root, "addons.json");
	return existsSync(path) ? readJson<AddonsState>(path) : {};
}

export function readAddonMeta(dir: string): AddonMeta | undefined {
	const path = join(dir, ADDON_META);
	return existsSync(path) ? readJson<AddonMeta>(path) : undefined;
}

/** Recorded channel, else the running bundle's own channel. */
export function recordedChannel(root: string, fallback: Channel): Channel {
	const path = join(root, "channel");
	if (!existsSync(path)) return fallback;
	const value = readFileSync(path, "utf8").trim();
	return (CHANNELS as readonly string[]).includes(value) ? (value as Channel) : fallback;
}

/** Package manager owning this install (`.<manager>.managed.lock` in `dirs`), as pi's getChannelManager. */
export function managedBy(...dirs: string[]): string | undefined {
	for (const dir of dirs) {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.endsWith(MANAGED_SUFFIX) && entry.length > MANAGED_SUFFIX.length) {
				const manager = entry.slice(0, -MANAGED_SUFFIX.length).replace(/^\.+/, "");
				if (manager) return manager;
			}
		}
	}
	return undefined;
}

export const sameSlot = (a: Slot | null | undefined, b: Slot | null | undefined) => !!a && !!b && a.commit === b.commit;
export const slotLabel = (s: Slot | null | undefined) => (s ? `${s.commit.slice(0, 12)} (kit ${s.kitVersion})` : "none");
