# dsh-bin

Self-contained, self-updating builds of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

- **No Node.js needed.** Each bundle carries its own Bun runtime (`BUN_BE_BUN`) and an embedded pnpm, so `dsh`, `dsh plugin … add` and plugin lifecycle scripts run on machines with no JavaScript runtime installed.
- **Built from GitHub source only.** First-party dsh code is never taken from npm; see [Trust model](#trust-model).
- **Launcher only, not a fork.** Upstream source is built unmodified. The compat layer, build step, output transforms and the Zig launcher live here.
- **12 targets:** linux x64 (baseline/modern), linux arm64, linux musl x64 (baseline/modern), linux musl arm64, darwin x64 (baseline/modern), darwin arm64, windows x64 (baseline/modern), windows arm64.

## Install

### Manual ZIP

Download `dsh-<target>.zip` from a [release](https://github.com/xz-dev/dsh-bin/releases) and unpack it into a directory you own, for example `~/.local/share/dsh-bin`. Then put its `dsh` on your `PATH`:

```sh
mkdir -p ~/.local/share/dsh-bin
unzip dsh-linux-x64-modern.zip -d ~/.local/share/dsh-bin
ln -s ~/.local/share/dsh-bin/dsh ~/.local/bin/dsh
dsh --version
```

The archive contains the root launcher `dsh` (`dsh.exe`) and one read-only `bundles/<version>/`. The unpacked directory must stay writable by you, because `dsh update` adds new bundles next to the old one.

### Scoop (Windows)

```powershell
$scoopRoot = (Resolve-Path (Join-Path (scoop prefix scoop) '..\..\..')).Path
git clone --branch scoop --single-branch https://github.com/xz-dev/dsh-bin.git (Join-Path $scoopRoot 'buckets\dsh-bin')
scoop install dsh-bin/dsh           # release channel (dsh-bin/dsh-live for the live channel)
scoop install dsh-bin/dsh-office    # optional: LibreOffice Kit addon
```

Scoop owns this install, so `dsh update` and `dsh install --addon` refuse and tell you to use `scoop update` instead.

### Gentoo (emerge layout)

`packaging/gentoo/dsh-bin-9999.ebuild.in` is filled in by `scripts/gentoo-ebuild.mjs` for each release. It installs the linux archive verbatim into `/usr/lib/dsh-bin`, links `/usr/bin/dsh`, adds `.portage.managed.lock`, and with `USE=office` also installs the pinned office addon. `scripts/gentoo-layout-check.sh` checks this layout in a container as an unprivileged user.

## Channels

| channel | follows | tag |
|---|---|---|
| `release` (default) | upstream `dsh-v*` tags, starting at `dsh-v0.1.7-rc.2` | `dsh-v<upstream-version>-xz.<run>.<attempt>.g<sha8>` |
| `live` | upstream `master` | `dsh-live-<sha7>-xz.<run>.<attempt>.g<sha8>` |

Publishing is fully automatic. `upstream-poll` checks upstream four times a day and on every push to `main`, and it is the only workflow that publishes:

- a new upstream tag becomes a `release` build, and a moved `master` becomes a `live` build;
- a push that changes packaging rebuilds the newest release tag and `master`;
- a push that changes only docs or tests builds nothing.

Running `build` or `addon` by hand is always a dry run. Every build is published as an immutable GitHub Release that never becomes "Latest". The updater finds releases through `index.json` on the `releases` branch, not the GitHub API.

## Commands

```text
dsh update [self|dsh] [--self | --all | --addon <name> [--version <v>]] [--force] [--channel <live|release>] | dsh update --clean
dsh install --addon <name> [--version <v>] [--force]
dsh uninstall --addon <name>
dsh list [--addon <name>] [--channel <live|release>] [--json]
```

| command | effect |
|---|---|
| `dsh update` (also `update self`, `update dsh`, `--self`) | Update the binary to the newest bundle of the recorded channel. If an installed addon should move too, it prints a hint. |
| `dsh update --channel live` | Switch channels. The new channel is recorded only after the update succeeds. |
| `dsh update --all` | Update the binary, then every installed addon to its default version. |
| `dsh update --addon office [--version <v>]` | Move the addon to its default version, or to `<v>`. |
| `dsh update --force` | Reinstall the current version. |
| `dsh update --clean` | Remove bundles and addon versions that are no longer in use. Works offline. |
| `dsh install --addon office [--version <v>] [--force]` | Install and enable the office addon. |
| `dsh uninstall --addon office` | Disable the addon and remove its unused files. |
| `dsh list [--json]` | Show installed and installable versions. Read-only: no lock, no download. |

Updates download one asset by its exact tag, check its SHA-256 against the index, unpack it safely, and activate it atomically: first the bundle, then the root launcher. Running sessions keep their old bundle until they exit. `dsh plugin --profile <name> …` still manages plugins as upstream designed. upstream's own `dsh update` never runs, and the bundle is read-only, so its self-update cannot write.

### The office addon and slots

LibreOffice Kit (`office-to-pdf`, `skill-office`) ships as a separate addon. It is not in the main archive. Each addon version belongs to a **slot**, `{upstream commit that introduced the kit version, kit version}`, taken from upstream first-parent history. A bundle accepts only addons from its own slot:

- **Default version:** for a release bundle, the version pinned at build time. For a live bundle, the newest in-slot version in the index, or the pin when there is none.
- **Other versions:** `--version <v>` picks another in-slot version. An out-of-slot version needs `--force`, is recorded as forced, and prints a warning at every startup. `dsh update --addon office` (without `--version`) and `dsh update --all` bring a forced addon back to the default.
- **Offline fallback:** every `bundle.json` embeds the table `{slot, pinned, known[]}`, so versions stay installable even after they leave the index.

## Declared degradations

Some upstream plugins cannot work in this runtime. Each one is swapped for a stub that throws a named `DeclaredDegradation`. dsh's startup audit lists it as inactive, with the reason, and startup continues:

- `@deepseek-ai/dsh-hmr`: always. It needs Node's internal module loader.
- `@deepseek-ai/dsh-office-to-pdf` and `@deepseek-ai/dsh-skill-office`: when the office addon is missing or out of slot. The reason names `dsh install --addon office` (or `dsh update --addon office`).

## Trust model

- dsh itself is built from `github.com/deepseek-ai/deepseek-harness` at an exact commit, using the upstream lockfile (`--frozen-lockfile`, lifecycle scripts off). pnpm comes from its GitHub release and is checked against a pinned SHA-256.
- Third-party packages come from the upstream lockfile's integrity hashes. The only npm-hosted exception is the LibreOffice Kit engine packages: they are pinned to the lockfile `sha512` and ship only in the office addon.
- Release assets carry GitHub build-provenance attestations, which you can check with `gh attestation verify <file> --repo xz-dev/dsh-bin`. Releases are immutable. The index is append-only: entries are never edited or removed.

## Migrating from the npm wrapper

1. Unpack a release into `~/.local/share/dsh-bin` as shown above.
2. Keep the old wrapper for rollback with `mv ~/.local/bin/dsh ~/.local/bin/dsh.npm`, then run `ln -s ~/.local/share/dsh-bin/dsh ~/.local/bin/dsh`.
3. `$DSH_HOME` (profiles, credentials) needs no changes. The launcher does not choose a default profile, so pass `--profile tui`, or keep a small wrapper that adds it.
4. To roll back, run `ln -sf ~/.local/bin/dsh.npm ~/.local/bin/dsh`. Bundles never touch the npm install.

## Development

```sh
bun install
npm test    # bun test ./test/unit ./test/runtime ./test/launcher ./test/update-contract
bun scripts/build-target.mjs <target> <live|release> <ref> <out> --run 1 --attempt 1 --index index.json
bun scripts/e2e.mjs <index.json> <assets-dir>   # packaged E2E, no JS runtime on PATH
```

Requires Bun 1.4.2 and Zig 0.15.2 (Node is used only at build time).
