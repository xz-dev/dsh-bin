# How it works

[README](../../README.md) · [中文](../zh-CN/how-it-works.md)

## Layout

```text
~/.local/share/dsh-bin/
  dsh                      the launcher (dsh.exe on Windows), written in Zig
  bundles/<version>/       one read-only directory per installed version: dsh, Bun, pnpm
$DSH_HOME/                 default ~/.dsh
  profiles/<name>/         your profiles and cordis.patch.yml settings
  snapshots/<version>@<n>/ plugin snapshots
  dsh-bin/selection.json   what a plain dsh starts
```

The launcher reads your options and the selection, picks a version and snapshot, and starts that version's `dsh-native` before any JavaScript runs.

This is the container model without a container:

| Container | dsh-bin |
|---|---|
| Read-only image with its runtime | `bundles/<version>/` |
| Pull by tag, check by digest | `dsh update` / `dsh install`, SHA-256 checked |
| Several images on one machine | several versions side by side |
| Writable layer, volumes | snapshots; settings kept outside and shared |
| Commit / roll back | `dsh snapshot new` / `dsh snapshot remove` |
| Optional layers | the office addon |

## Releases

| Channel | Follows | Tag |
|---|---|---|
| `release` | upstream `dsh-v*` tags, from `dsh-v0.1.7-rc.2` | `dsh-v<upstream-version>-xz.<run>.<attempt>.g<sha8>` |
| `live` | upstream `master` | `dsh-live-<sha7>-xz.<run>.<attempt>.g<sha8>` |

Publishing is automatic. The `upstream-poll` workflow checks upstream four times a day and on every push to `main`:

- a new upstream tag becomes a `release` build, and a new `master` commit becomes a `live` build;
- a push that changes packaging rebuilds the newest release tag and `master`;
- a push that changes only docs or tests builds nothing.

Running `build` or `addon` by hand is always a dry run. Each build is published as an immutable GitHub Release. The Latest release is always the newest `release` build. `dsh update` finds versions through `index.json` on the `releases` branch, not the GitHub API.

## Trust model

- dsh is built from `github.com/deepseek-ai/deepseek-harness` at an exact commit, using the upstream lockfile (`--frozen-lockfile`, lifecycle scripts off). First-party dsh code never comes from npm.
- pnpm comes from its GitHub release and is checked against a pinned SHA-256.
- Third-party packages are checked against the upstream lockfile's integrity hashes. The only packages taken from npm are the LibreOffice Kit engine packages, pinned to the lockfile `sha512`, and they ship only in the office addon.
- Release assets carry GitHub build-provenance attestations: `gh attestation verify <file> --repo xz-dev/dsh-bin`. Releases are immutable. The index is append-only.

## Startup

Measured on Linux x64 (Ryzen AI 9 365), booting the shipped `headless` profile with its plugins, best of 5–7 runs:

| Case | npm + node | dsh-bin |
|---|---|---|
| Warm profile boot | 361 ms | 304–321 ms |
| First start of a new version, empty cache | – | 497–683 ms |
| First start of a new version, shipped cache | – | 454–515 ms |

- **Shipped transpiler cache.** Each build boots its profiles on its native runner and ships the Bun transpiler cache it produced. It is copied in on the version's first start, which saves about 90–150 ms.
- **Own cache directory.** The cache lives in `$XDG_CACHE_HOME/dsh-bin/transpiler` (or `~/.cache/dsh-bin/transpiler`), `~/Library/Caches/dsh-bin/transpiler` on macOS and `%LOCALAPPDATA%\dsh-bin\cache\transpiler` on Windows, not in Bun's shared `~/.bun/install/cache`. A `BUN_RUNTIME_TRANSPILER_CACHE_PATH` you set yourself wins.
- **Compiled entry.** The entry is built with `--minify --bytecode` on each target's native runner.

## Limitations

Some upstream plugins cannot run without Node. Each is replaced by a stub; dsh's startup check lists it as inactive with the reason, and startup continues:

- `@deepseek-ai/dsh-hmr`: always. It needs Node's internal module loader.
- `@deepseek-ai/dsh-office-to-pdf` and `@deepseek-ai/dsh-skill-office`: when no installed [office addon](office-addon.md) fits the running dsh version.

upstream's own self-update never runs; the bundle is read-only.

## Development

```sh
bun install
npm test    # bun test ./test/unit ./test/runtime ./test/launcher ./test/update-contract
bun scripts/build-target.mjs <target> <live|release> <ref> <out> --run 1 --attempt 1 --index index.json
bun scripts/e2e.mjs <index.json> <assets-dir>   # packaged E2E, no JS runtime on PATH
```

Requires Bun 1.4.2 and Zig 0.15.2. Node is used only at build time.
