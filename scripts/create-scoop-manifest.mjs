// Scoop bucket manifests from the release index (9.1, 9.4; port of xz-dev/pi create-scoop-manifest):
//   bucket/dsh.json        newest release-channel entry
//   bucket/dsh-live.json   newest live-channel entry
//   bucket/dsh-office.json office addon pinned by the newest release entry; depends on `dsh`
// Every install drops `.scoop.managed.lock`, so `dsh update` / `install --addon` refuse and name scoop.
// `addons/` and `addons.json` are persisted, so `scoop update dsh` keeps installed addons.
// usage: bun scripts/create-scoop-manifest.mjs <index.json> <bucket-dir> [--repo owner/name]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ARCH = [
	["64bit", "windows-x64-modern"],
	["arm64", "windows-arm64"],
];
const ADDON_ARCH = [
	["64bit", "windows-x64"],
	["arm64", "windows-arm64"],
];
const HASH = /^[0-9a-f]{64}$/;
const newest = (list) => [...(list ?? [])].sort((a, b) => b.seq - a.seq)[0];
const managedLock = "New-Item -Force -ItemType File (Join-Path $dir '.scoop.managed.lock') | Out-Null";

function architecture(entry, pairs, repo) {
	return Object.fromEntries(
		pairs.map(([scoop, key]) => {
			const a = entry.assets?.[key];
			if (!a || !HASH.test(a.sha256 ?? "")) throw new Error(`${entry.tag}: no ${key} asset`);
			return [scoop, { url: `https://github.com/${repo}/releases/download/${entry.tag}/${a.name}`, hash: a.sha256 }];
		}),
	);
}

export function scoopManifests(index, repo = "xz-dev/dsh-bin") {
	const out = {};
	const common = {
		homepage: `https://github.com/${repo}`,
		license: "MIT",
		bin: "dsh.exe",
		persist: ["addons", "addons.json"],
		// Scoop creates a missing persisted file empty; the updater expects JSON.
		post_install: [managedLock, "$s = Join-Path $dir 'addons.json'; if ((Get-Item $s).Length -eq 0) { Set-Content -NoNewline -Path $s -Value '{}' }"],
	};
	for (const [name, channel] of [["dsh", "release"], ["dsh-live", "live"]]) {
		const e = newest(index.channels?.[channel]);
		if (!e) continue;
		out[name] = { version: e.version, description: `DeepSeek Harness (dsh), ${channel} channel, built from GitHub source by dsh-bin`, ...common, architecture: architecture(e, ARCH, repo) };
	}
	const rel = newest(index.channels?.release);
	const pinned = rel?.addons?.office?.pinned;
	const addon = pinned && index.addons?.office?.find((a) => a.version === pinned);
	if (addon) {
		const target = `Join-Path (appdir dsh $global) 'current\\addons\\office\\${addon.version}'`;
		out["dsh-office"] = {
			version: addon.version,
			description: "LibreOffice Kit addon for dsh (office-to-pdf, skill-office)",
			homepage: `https://github.com/${repo}`,
			license: "MPL-2.0",
			depends: "dsh",
			architecture: architecture(addon, ADDON_ARCH, repo),
			// Same end state as `dsh install --addon office`: files under addons/office/<v>, recorded in addons.json.
			post_install: [
				`$t = ${target}; if (Test-Path $t) { Remove-Item -Recurse -Force $t }; New-Item -ItemType Directory -Force $t | Out-Null`,
				"Get-ChildItem -Force $dir | Where-Object Name -NotIn @('manifest.json','install.json') | Copy-Item -Recurse -Destination $t",
				`$s = Join-Path (appdir dsh $global) 'current\\addons.json'; $j = @{}; if ((Test-Path $s) -and (Get-Item $s).Length) { (Get-Content -Raw $s | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $j[$_.Name] = $_.Value } }`,
				`$j['office'] = @{ version = '${addon.version}'; forced = $false }; $j | ConvertTo-Json | Set-Content -NoNewline -Path $s`,
			],
			pre_uninstall: [
				`$s = Join-Path (appdir dsh $global) 'current\\addons.json'; if (Test-Path $s) { $j = Get-Content -Raw $s | ConvertFrom-Json; $j.PSObject.Properties.Remove('office'); $j | ConvertTo-Json | Set-Content -NoNewline -Path $s }`,
				`$t = ${target}; if (Test-Path $t) { Remove-Item -Recurse -Force $t }`,
			],
		};
	}
	return out;
}

if (import.meta.main) {
	const [indexPath, dir, ...rest] = process.argv.slice(2);
	if (!indexPath || !dir) throw new Error("usage: create-scoop-manifest.mjs <index.json> <bucket-dir> [--repo owner/name]");
	const i = rest.indexOf("--repo");
	const m = scoopManifests(JSON.parse(readFileSync(indexPath, "utf8")), i >= 0 ? rest[i + 1] : process.env.GITHUB_REPOSITORY || undefined);
	mkdirSync(dir, { recursive: true });
	for (const [name, body] of Object.entries(m)) writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(body, null, 2)}\n`);
	console.log(Object.keys(m).join(" "));
}
