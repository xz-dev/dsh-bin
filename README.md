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

The archive contains the root launcher `dsh` (`dsh.exe`) and one read-only `bundles/<version>/`. The unpacked directory must stay writable by you, because `dsh update` and `dsh install` add versions next to the installed ones.

### Scoop (Windows)

```powershell
$scoopRoot = (Resolve-Path (Join-Path (scoop prefix scoop) '..\..\..')).Path
git clone --branch scoop --single-branch https://github.com/xz-dev/dsh-bin.git (Join-Path $scoopRoot 'buckets\dsh-bin')
scoop install dsh-bin/dsh           # release channel (dsh-bin/dsh-live for the live channel)
scoop install dsh-bin/dsh-office    # optional: LibreOffice Kit addon
```

Scoop owns this install, so `dsh update`, `dsh install` and `dsh uninstall` refuse and tell you to use `scoop update` instead. The version and addons are fixed by the package (`--use` and `--addon` are refused); snapshots work as usual.

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

## Versions, snapshots and selection

dsh-bin works like a package manager. Several dsh versions stay installed side by side, and one launcher starts any of them:

- **Versions** are installed and removed explicitly. `dsh update` installs the channel's newest version next to the others; nothing is replaced, and there is no downgrade command, because older versions are simply still installed (or `dsh install <version>` brings one back).
- **Snapshots** hold plugin runtimes. A snapshot `<version>@<n>` is a full copy of every profile's plugin runtime (`package.json`, lockfile, `node_modules/`, `.plugin-manager/`, `cordis.yml`) under `$DSH_HOME/snapshots/`. The first start of a version without one copies the previous version's newest snapshot (or starts empty). Numbers are never reused; removing the newest falls back to the one before. Your settings, `$DSH_HOME/profiles/<name>/cordis.patch.yml`, are shared by all snapshots.
- **The selection** decides what a plain `dsh` starts. It starts as `--use latest`: the newest installed version of the channel, with that version's newest snapshot and default addons.

Override it for one run with leading options, which are recognised only before the other arguments:

```sh
dsh --use 0.1.7-rc.2 --profile tui              # an older installed version (a unique prefix is enough)
dsh --snapshot 0.2.0-rc.1@1 --profile tui         # a snapshot (implies its version)
dsh --use 0.2.0 --snapshot 0.1.7-rc.2@2 ...       # try an old snapshot on a new version
dsh --addon office:0.1.2-xz.11.1.gaaaa0001 ...    # a specific addon version
```

A typical safe upgrade: `dsh update`, then `dsh snapshot new` before a risky plugin change, and `dsh snapshot remove <id>` to go back if it breaks.

## Commands

```text
dsh update [self|dsh] [--self] [--force] [--channel <live|release>]
dsh install <version> [--channel <live|release>] [--force] | dsh install --addon <name>[:<version>] [--force]
dsh uninstall <version>... | dsh uninstall --addon <name>[:<version>]
dsh list [--addon <name>] [--channel <live|release>] [--json]
dsh select [--use <version|latest> [--snapshot <id>] [--addon <name>:<version>]...]
dsh snapshot new [--target <id> | --empty] [--name <alias>] | dsh snapshot remove <id>... | dsh snapshot list [--json]
dsh clean [--update] [--snapshots] [--transpiler] [--all]
```

| command | effect |
|---|---|
| `dsh update` (also `update self`, `update dsh`, `--self`) | Install the newest version of the recorded channel next to the installed ones. It never changes the selection, and warns when the selection is pinned to another version. If no installed addon version fits the new version, it prints an install hint. |
| `dsh update --channel live` | Switch channels. The new channel is recorded only after the install succeeds. |
| `dsh update --force` | Reinstall the channel's newest version. |
| `dsh install <version>` | Install that version (an exact version, a tag, or an upstream version such as `0.1.7-rc.2`), plus its automatic snapshot. |
| `dsh uninstall <version>...` | Remove installed versions; their snapshots are kept. It refuses the last installed version, the pinned one and one in use, all or none. |
| `dsh install --addon office[:<v>] [--force]` | Install an office addon version: by default the effective version's default. Several versions can be installed side by side. |
| `dsh uninstall --addon office[:<v>]` | Remove that addon version, or every version. It refuses one in use or named by the selection. |
| `dsh list [--json]` | Show the selection, installed versions (`selected`, `latest`, `in use`), what can be installed, and addon versions. Read-only: no download, no change. |
| `dsh select` | Print the selection and what a plain `dsh` resolves it to. |
| `dsh select --use <v\|latest> [--snapshot <id>] [--addon office:<v>]` | Store a new selection. `--use` is required; omitted options go back to their defaults. Selecting never downloads anything. |
| `dsh snapshot new [--target <id> \| --empty] [--name <alias>]` | Create the next snapshot of the effective version: a copy of its newest snapshot, of `--target <id>`, or an empty one. |
| `dsh snapshot remove <id>...` | Remove snapshots; it refuses one in use or named by the selection. |
| `dsh snapshot list [--json]` | List snapshots with the `newest`, `selected` and `in use` markers. |
| `dsh clean` | Remove leftovers of interrupted runs and dsh-bin's transpiler cache: `--update` (install staging, partial downloads), `--snapshots` (snapshot staging), `--transpiler`; no option means `--all`. It never removes installed versions, addons or snapshots. |

"In use" means a dsh process started by dsh-bin (a session, `dsh plugin`, an in-app restart) is running it. This protects against mistakes; child processes are not tracked.

Startup cache: the launcher sends Bun's transpiler cache to dsh-bin's own user cache instead of `~/.bun/install/cache`. The locations are `$XDG_CACHE_HOME/dsh-bin/transpiler` (or `~/.cache/dsh-bin/transpiler`), `~/Library/Caches/dsh-bin/transpiler` on macOS, and `%LOCALAPPDATA%\dsh-bin\cache\transpiler` on Windows. A `BUN_RUNTIME_TRANSPILER_CACHE_PATH` you set yourself wins. Each bundle ships a cache prebuilt at build time, and it is copied in on that version's first start, so a new version starts warm.

Updates download one asset by its exact tag, check its SHA-256 against the index, unpack it safely, and activate it atomically: first the bundle, then the root launcher.

Downloads are built for weak networks:
- **Progress:** a progress bar with bytes, speed and ETA on a terminal; one plain line per second otherwise.
- **Timeout:** a download that receives no data for 30 s is aborted and retried.
- **Retry:** network errors and HTTP 408/425/429/5xx are retried with exponential backoff (honouring `Retry-After`). The index is tried up to 3 times.
- **Resume:** each retry resumes with an HTTP `Range` request. An interrupted run keeps its partial file in `<root>/.downloads/<sha256>.part`, and the next `dsh update` continues from there. `dsh clean --update` removes it.
- **Verification:** the finished file is checked against the index size and SHA-256. A resumed file that fails the check is downloaded once more from the start.

`dsh --help` shows upstream's launcher help followed by the dsh-bin launch options and commands. Running sessions keep their version and snapshot until they exit, including in-app restarts. `dsh plugin --profile <name> …` still manages plugins as upstream designed. upstream's own `dsh update` never runs, and the bundle is read-only, so its self-update cannot write.

### The office addon and slots

LibreOffice Kit (`office-to-pdf`, `skill-office`) ships as a separate addon. It is not in the main archive. Each addon version belongs to a **slot**, `{upstream commit that introduced the kit version, kit version}`, taken from upstream first-parent history. A bundle accepts only addons from its own slot:

- **Default version:** the newest in-slot version in the index, or the version pinned at build time when the index is unreachable. A launch uses the newest installed in-slot version unless a version is named.
- **Other versions:** `dsh install --addon office:<v>` installs another version next to the others. An out-of-slot version needs `--force`. It is used only when named (`dsh select --addon office:<v>` or `dsh --addon office:<v>`), and every such launch prints an out-of-slot warning. A named version that is not installed stops the launch with an install hint.
- **Offline fallback:** every `bundle.json` embeds the table `{slot, pinned, known[]}`, so versions stay installable even after they leave the index.

## Declared degradations

Some upstream plugins cannot work in this runtime. Each one is swapped for a stub that throws a named `DeclaredDegradation`. dsh's startup audit lists it as inactive, with the reason, and startup continues:

- `@deepseek-ai/dsh-hmr`: always. It needs Node's internal module loader.
- `@deepseek-ai/dsh-office-to-pdf` and `@deepseek-ai/dsh-skill-office`: when no installed office version fits the running dsh version. The reason names `dsh install --addon office`.

## Trust model

- dsh itself is built from `github.com/deepseek-ai/deepseek-harness` at an exact commit, using the upstream lockfile (`--frozen-lockfile`, lifecycle scripts off). pnpm comes from its GitHub release and is checked against a pinned SHA-256.
- Third-party packages come from the upstream lockfile's integrity hashes. The only npm-hosted exception is the LibreOffice Kit engine packages: they are pinned to the lockfile `sha512` and ship only in the office addon.
- Release assets carry GitHub build-provenance attestations, which you can check with `gh attestation verify <file> --repo xz-dev/dsh-bin`. Releases are immutable. The index is append-only: entries are never edited or removed.

## Migrating from the npm wrapper

1. Unpack a release into `~/.local/share/dsh-bin` as shown above.
2. Keep the old wrapper for rollback with `mv ~/.local/bin/dsh ~/.local/bin/dsh.npm`, then run `ln -s ~/.local/share/dsh-bin/dsh ~/.local/bin/dsh`.
3. Credentials and `cordis.patch.yml` settings need no changes. Old plugin runtimes are not migrated: delete `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `node_modules/`, `.plugin-manager/` and `cordis.yml` from each `$DSH_HOME/profiles/<name>/`, keep `cordis.patch.yml`, and add plugins again with `dsh plugin --profile <name> add …`. They go into the first (empty) snapshot.
4. The launcher does not choose a default profile, so pass `--profile tui`, or keep a small wrapper that adds it.
5. To roll back, run `ln -sf ~/.local/bin/dsh.npm ~/.local/bin/dsh`. Bundles never touch the npm install.

## Development

```sh
bun install
npm test    # bun test ./test/unit ./test/runtime ./test/launcher ./test/update-contract
bun scripts/build-target.mjs <target> <live|release> <ref> <out> --run 1 --attempt 1 --index index.json
bun scripts/e2e.mjs <index.json> <assets-dir>   # packaged E2E, no JS runtime on PATH
```

Requires Bun 1.4.2 and Zig 0.15.2 (Node is used only at build time).

## License

The packaging (launcher, compat layer, scripts) is [MIT](LICENSE). The bundled DeepSeek Harness and its dependencies keep their own licenses; the office addon ships LibreOffice Kit under MPL-2.0.
