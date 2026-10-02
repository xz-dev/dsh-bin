// manager-index.json → one manager-only Scoop manifest; runtime/live/addon choices belong to dsh manager.
// usage: bun scripts/create-scoop-manifest.mjs <manager-index.json> <bucket-dir> [--repo owner/name]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const semver = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function scoopManifests(index, repo = "xz-dev/dsh-bin") {
	if (index.schema !== 1 || !Array.isArray(index.versions) || !index.versions.length) throw new Error("no manager-index schema 1 versions");
	for (const e of index.versions) {
		if (!semver.test(e.version) || e.tag !== `manager-v${e.version}`) throw new Error("invalid manager identity");
	}
	const entries = [...index.versions].sort((a, b) => Bun.semver.order(b.version, a.version));
	for (let i = 1; i < entries.length; i++) if (Bun.semver.order(entries[i - 1].version, entries[i].version) === 0) throw new Error("ambiguous manager version");
	const manager = entries[0];
	if (!manager.launchProtocols?.includes(1)) throw new Error("incompatible manager protocol");
	const architecture = Object.fromEntries([["64bit", "windows-x64"], ["arm64", "windows-arm64"]].map(([arch, target]) => {
		const a = manager.assets?.[target];
		if (!a || !/^[0-9A-Za-z][0-9A-Za-z._+-]*\.zip$/.test(a.name) || !Number.isSafeInteger(a.size) || a.size <= 0 || !/^[0-9a-fA-F]{64}$/.test(a.sha256)) throw new Error(`${target}: invalid manager asset`);
		return [arch, { url: `https://github.com/${repo}/releases/download/${manager.tag}/${a.name}`, hash: a.sha256 }];
	}));
	return { dsh: {
		version: manager.version,
		description: "Independent dsh manager; runtimes and addons are managed per user",
		homepage: `https://github.com/${repo}`,
		license: "MIT",
		bin: "dsh.exe",
		architecture,
		post_install: [
			`[System.IO.File]::WriteAllText((Join-Path $dir '.dsh-manager-install.json'), '{"schema":1,"owner":"scoop"}', [System.Text.UTF8Encoding]::new($false))`,
			`(Get-Item (Join-Path $dir '.dsh-manager-install.json')).IsReadOnly = $true`,
		],
	} };
}

if (import.meta.main) {
	const [indexPath, dir, ...rest] = process.argv.slice(2);
	if (!indexPath || !dir) throw new Error("usage: create-scoop-manifest.mjs <manager-index.json> <bucket-dir> [--repo owner/name]");
	const i = rest.indexOf("--repo");
	const m = scoopManifests(JSON.parse(readFileSync(indexPath, "utf8")), i >= 0 ? rest[i + 1] : process.env.GITHUB_REPOSITORY || undefined);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "dsh.json"), `${JSON.stringify(m.dsh, null, 2)}\n`);
	console.log("dsh");
}
