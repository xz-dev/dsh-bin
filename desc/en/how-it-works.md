# Layout, releases and development

[README](../../README.md) · [中文](../zh-CN/how-it-works.md)

## Two independent products

The Zig manager owns installation, selection, snapshots, addons, completion and self-update. It does not run JavaScript for management. The Bun runtime bundle contains upstream dsh, embedded Bun/pnpm, dependencies and runtime adaptation; it has no manager executable or management engine.

They communicate through a versioned manifest and launch context. Protocol 2 carries independent plugin and configuration roots alongside the runtime, home and addon. The runtime uses process-local path mapping; it does not switch public plugin links or a global current-config pointer. The fixed context is also the internal-restart contract; actual upstream restart acceptance is still pending in this branch.

## Portable layout

```text
installation/
  dsh                         dsh.exe on Windows
  dsh-bin/                    data root
    .dsh-bin-data.json         ownership marker
    bundles/<runtime-id>/     read-only runtime bundles
    addons/office/<addon-id>/  installed addons
    snapshots/<runtime>@<n>/  per-profile plugin runtime files (P)
    config-snapshots/<runtime>@<n>/  private configuration and local credentials (C)
    home/                     default application home; sessions and non-config state
    cache/                    downloads, Bun/transpiler/npm/pnpm caches
    state/                    selection, channel, completion choices, locks
    tmp/                      installation/update residue
```

A managed package's `.dsh-manager-install.json` beside the executable explicitly declares Portage/Scoop ownership. Without a marker the mode is portable, even in a read-only directory. Unknown/corrupt markers fail rather than selecting another location. The [managed roots and DSH_HOME override](install.md#where-data-lives) separate package content from user data.

The manager's controlled application environment directs known caches and temporary files into this root; it does not globally replace user HOME or sandbox plugins. Managed configuration and built-in local credential paths are confined to C, including explicit overrides; shared-home fallback is not allowed. Independent project `.env`, inherited environment and arbitrary plugin/workspace I/O retain upstream semantics and are outside the snapshot guarantee. Stop sessions before moving a portable installation; no cross-OS move or live move is promised.

## Release identities

Their independently generated indexes live on the `releases` branch:

| Product | Identity | Index |
|---|---|---|
| Manager | `manager-v<semver>` | `manager-index.json` |
| Release runtime | `runtime-v<upstream>-b<run>.<attempt>.g<sha8>` | `runtime-index.json`, release channel |
| Live runtime | `runtime-live-<sha7>-b<run>.<attempt>.g<sha8>` | `runtime-index.json`, live channel |
| Office addon | `addon-office-v<kit>-b<run>.<attempt>.g<sha8>` | `runtime-index.json`, office addons |

Manager assets are `manager-<os>-<arch>.zip` and each contains one executable. Runtime assets are `runtime-<target>.zip`; their roots contain `bundle.json`, `dsh-native`, `app/`, `pnpm/`, `bin/`, a fixed `completion.json` and any declared cache content, not the manager or an outer installation tree. A runtime's manifest records upstream/build identity and launch protocol, not a matching manager release version.

[Manager release CI](../../.github/workflows/manager-release.yml) builds only the manager; [runtime release CI](../../.github/workflows/runtime-release.yml) builds only runtimes. Combination gates consume a pinned counterpart artifact instead of rebuilding it. Dry-run builds do not publish; the [CI entry](../../.github/workflows/ci.yml) exposes manual `release_dry_run` calls with publication hard-coded off. Public publication waits for the release gates and a compatible addon when required. Global GitHub Latest is not a discovery protocol.

The runtime workflow checks the newest upstream release tag daily at 00:17, 06:17, 12:17 and 18:17 UTC. An already published tag needs no build; a new tag triggers only a dry-run build and combination checks, never automatic publication. Publishing requires a manual dispatch on `main` with an accepted manager index and its SHA-256. Changes under `dsh-bun-build/` or to the runtime workflow, pushed to `main`, trigger a live dry run from `master`. Manual live requests can use `channel=live` with an upstream commit or `master`; publication still requires manual dispatch on `main` and the same release gates. The scheduled check follows release tags, not the live channel. `manager update --channel live` can install a runtime only after a compatible live entry is published in the index.

## Integrity and failure boundaries

Manager downloads verify indexed identity, size and SHA-256, then archive paths, required content and launch compatibility. Links or traversal cannot authorize writes outside the managed destination. A candidate is activated only after validation; a failure does not silently select a substitute or adopt unrelated data.

Runtime construction uses exact upstream commits and the frozen lockfile. Bundled pnpm is checksum-pinned; third-party package content follows lockfile integrity. Published release assets carry build-provenance attestations. Verify them with `gh attestation verify <file> --repo xz-dev/dsh-bin`; provenance is not a substitute for local platform/combination acceptance.

Updates use same-volume staging and checked replacement. Process interruption is handled; power-loss durability is not promised. Clean preserves unknown files and valid data rather than guessing ownership. Locks fail with a clear busy/retry diagnostic instead of a background recovery service. See [versions and cleanup](versions.md).

## Application limitations

Runtime adaptation preserves upstream commands but is not an unchanged Node.js build. Node-internal hot reload (`@deepseek-ai/dsh-hmr`) is inactive. Office plugins need a compatible [office addon](office-addon.md). Plugin installation belongs to dsh and writes to the selected [snapshot](snapshots.md); the manager does not repair plugin dependencies automatically.

Completion describes fixed upstream CLI declarations, not runtime-generated plugin commands. Runtime/P/C usage claims protect selected collections; the actual upstream restart and Windows parent-exit cases remain acceptance gates, not a promise to track every isolated child. An explicit external home or arbitrary plugin external path lies outside the portable guarantee; built-in local credential paths instead must stay in C. Protocol-2 bundles are required, while valid old plugin metadata and selections without C remain readable. See [compatibility and current limitations](snapshots.md#compatibility-and-development-status).

## Development ownership

```text
repo/
  dsh-manager/    Zig source, build.zig, manager tests, release/package scripts
  dsh-bun-build/  Bun runtime adapter, upstream build scripts, runtime tests
  desc/          shared English/Chinese docs; historical implementation report
  openspec/      requirements and change plans
  .github/       CI and release workflows
```

Build the manager with Zig 0.15.2, without Bun or upstream sources:

```sh
cd dsh-manager
zig build
zig build test
```

Runtime tooling uses Bun 1.4.2 and its upstream build prerequisites; it never needs to compile the manager:

```sh
cd dsh-bun-build
bun install
bun test ./test/unit ./test/runtime
bun scripts/build-target.mjs <target> <release|live> <ref> <out> --run 1 --attempt 1 --index <runtime-index.json>
```

Use isolated HOME/data roots and actual artifacts for integration checks. Cross-compiling proves a build, not native runtime acceptance. The [implementation report](../IMPLEMENTATION-REPORT.md) is an unchanged historical record, not current installation instructions.
