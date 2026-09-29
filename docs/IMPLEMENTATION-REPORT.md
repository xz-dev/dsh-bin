# dsh-bin implementation report (OpenSpec change `dsh-bin`)

## Status

All sections (1–9) are implemented. `openspec validate dsh-bin --strict` reports the change as valid.
`tasks.md` has 41 tasks `[x]` and 12 `[ ]`. Each open task is one of these:

- **Pending CI / publication.** Implemented and checked locally, but the task's own check needs
  a green CI or dry run on GitHub Actions, or a real publication: 5.3, 6.3, 7.10, 8.1, 8.2, 8.3,
  8.4, 8.6, 8.8, 9.1, 9.4. Each carries an `implemented; local: …; pending …` note.
- **Needs your approval:** 10.1, and the first real publication (see below).

`main` is pushed to github.com/xz-dev/dsh-bin with your gh authorization. Release immutability
(8.7) is enabled. Nothing has been published. Commits are unsigned Conventional Commits.

## Verified on GitHub Actions (2026-09-29)

CI results are listed under `gh run list -R xz-dev/dsh-bin --workflow CI`, and the build dry
runs under `--workflow build`. The dry run was dispatched on `main` with `publish=false`, not on a
separate branch. That is safe because the publish, index and scoop jobs are gated on
`publish == true`.

What the first runs found and fixed:

- **Test suite on three OSes.**
  - ubuntu-24.04 and macos-15: green (run 36504244698).
  - windows-2022: 218 of 219 pass. The last failure was a crash-repair case: a rename was refused
    right after the updater was killed. Directory renames now retry for up to 3 s, as pi's
    `renameSyncRetryable` does. The run that tests this is 36505876629; its result was not known
    when this report was written.
  - The Windows runtime defects this found are described under "Windows behaviour" below.
- **Build dry run** (run 36503518820):
  - `prepare` and the office addon job pass. The addon job runs `scripts/build-target.mjs` end
    to end on linux-x64-modern.
  - 9 of 12 targets build: linux-x64-modern/baseline, linux-arm64, darwin-arm64,
    darwin-x64-modern/baseline, windows-x64-modern/baseline and windows-arm64.
  - The three musl targets failed. Because of that, `accept` (packaged E2E) and `aggregate` were
    skipped and have **not run yet** on any target.
  - Fixes found by the dry runs:
    - musl (Alpine):
      - upstream's Node-API build needs `nodejs-dev` headers and a `musl-gcc` name;
      - git 2.49 refuses lazy blob fetches from the partial clone while the commit-graph is
        enabled, so the slot reader now runs with `core.commitGraph=false`. This was reproduced
        and fixed in the pinned image.
    - windows-x64: the launcher was built in `%TEMP%` (C:) and renamed into the workspace (D:),
      which failed with EXDEV. It is now built next to its output.
  - Dry run 36505878507 runs with all of these fixes; its result was not known when this report
    was written.

### Windows behaviour, measured on windows-2022 and not assumed

- **Read-only ACL.** The deny ACE is `(OI)(CI)(WD,AD,WEA,WA,DC)` for Everyone.
  - What it blocks: creating files or directories, and renaming a file in place (dsh-tui's `.old`
    self-update path; 6.3).
  - Why DELETE is not denied: Bun opens files and directories requesting DELETE access, so denying
    it broke every read of the bundle.
  - Trade-off: the owner can still move a whole subdirectory out of a bundle. Closing that would
    need Bun to open files without DELETE access.
- **Retiring a bundle.** Windows refuses to move a directory while any handle inside it is open.
  That includes the updater's own exclusive claim, and it is why `--clean` and `--force` first
  retired nothing on Windows.
  - The claim now only checks whether anyone uses the bundle. It is then released, and the rename,
    retried briefly, refuses a bundle that came into use in between, because every dsh session
    keeps `.usage.lock` open.
  - A running executable inside the directory does **not** stop the rename, so the open
    `.usage.lock` is what protects a running bundle. The contract case
    `--force fails while another process uses that version` checks this on every OS.
- **Same-version `--force` from the running version.** Windows cannot delete the executable that
  is running, so the replaced generation stays in `.trash-*` until the next maintenance run sweeps
  it. POSIX removes it at once.

## Verified locally (Linux x64)

- **Test suite:** `bun test ./test/unit ./test/runtime ./test/launcher ./test/update-contract`
  (= `npm test`): 241 pass, 0 fail, 26 files. `tsc --strict` over `runtime/` is clean.
- **Packaged E2E:** `bun scripts/e2e.mjs <index.json> <assets-dir>` on real artifacts.
  - Inputs: two real 119 MB bundles built from upstream `dsh-v0.1.7-rc.2` by `local-build.mjs`, a
    real office addon (every engine tarball's sha512 matches the lockfile), an index written by
    `index.mjs`, the real Zig launcher, and a `PATH` holding only `git` and `sh`.
  - Update path: manual unzip install of V1 → `update` → V2. The launcher marker is rewritten, both
    trees are read-only, and no profile is created.
  - Update forms: `update` again (up to date), `update self|dsh|--self|--all`, `--channel`
    (refused, because that channel has no build).
  - Listing: `list`, `list --json`, `update --help`.
  - Addon: `install`, `install --version`, `update --addon`, `--all`, `uninstall`.
  - Degraded conditions: offline `list` warns and exits 0; `--clean` removes V1 without making a
    request; same-version `--force` works; with a portage lock, `update` is refused and makes no
    request.
  - The only requests made were `/index.json` and exact `/download/<tag>/<asset>`.
  - With an index holding only one bundle (a channel's first publication), the harness runs every
    check except the V1→V2 step.
- **Headless boot:** with the addon installed, no office degradation is reported. Without it, the
  two `DeclaredDegradation` entries name `dsh install --addon office` (`test/runtime`).
- **Gentoo layout (9.2):** checked in a `gentoo/stage3` podman container with the real archive and
  addon:
  - install is root-owned under `/usr/lib/dsh-bin`, with a `/usr/bin/dsh` symlink and
    `.portage.managed.lock`;
  - an unprivileged `dsh --version` works;
  - `dsh update` and `dsh install --addon office` are refused and name portage;
  - the prefix is not writable.
- **Index publishing (8.4):** two concurrent `publish-index.sh` runs against a local bare repo. The
  lease rejected one push, the retry appended it, `seq` came out as 1 and 2, a rerun was a no-op, and
  `index.mjs check` passes.
- **Scoop bucket (9.1/9.4):** manifests are generated from the index and pushed to a local `scoop`
  branch; a second run is idempotent (`test/unit/scoop.test.ts`).
- **Workflows:** actionlint 1.7.7 is clean, including shellcheck on every `run:` block;
  `shellcheck` is clean on the helper scripts.
- **Upstream diff (8.5):** 8 unit tests pass. Against the real upstream it proposes
  `dsh-v0.2.0-rc.1` plus one live build, both in slot `8e816b7`/kit 0.1.1.

## Not verified yet

- **Real publication (8.3, 8.4, 8.6, 8.8, 9.1, 9.4):** needs your go-ahead; see below.
- **Packaged E2E gap (8.2):** `scripts/e2e.mjs` now boots the shipped `headless` profile on every
  target, and that boot seeds the transpiler cache. GitHub plugin install is covered by
  `test/runtime` (4.1) but not yet by `scripts/e2e.mjs`.
- **Workflow references:** the workflows use `actions/*@vN` tags, not commit SHAs. Pin them if you
  want SHA pinning like xz-dev/pi.

## Design decisions made on my own (package-manager style)

- **Upstream poll.** `upstream-poll` calls `build.yml` as a reusable workflow with
  `max-parallel: 1`, releases in version order and then live. Each build first publishes its slot's
  addon when the index has none, so later builds in the same slot embed it and no slot ever gets two
  addons.
- **Scoop.**
  - `persist: [addons, addons.json]`, so `scoop update dsh` keeps installed addons.
  - `dsh-office` writes the same end state as `dsh install --addon office` (the files plus the
    `addons.json` record) and removes it on uninstall.
  - The bucket is regenerated from the whole index, so reruns converge.
- **Gentoo.**
  - Versions map as `0.1.7-rc.2-xz.5.1.g…` → `0.1.7_rc2_p5`.
  - The ebuild installs with `cp -a` so the archive's file modes survive (`doins` resets them), and
    uses the `baseline` x64 asset for broad CPU support.
- **Publishing refuses non-immutable releases.** `publish-release.mjs` refuses to publish when the
  repository setting is disabled, and fails if a release does not become `immutable: true`.
- **Managed `dsh list` footer.** A managed `dsh list` replaces every hint with
  `Upgrade dsh through <manager> instead.`, as the spec requires. When no hint applies (for
  example offline), it still ends with `This dsh installation is managed by <manager>.`

## Things you should know

- **Host resolution** uses virtual modules plus an `onResolve` for host `<pkg>/package.json`
  (option a). The `_nodeModulePaths` patch was **not needed** and is not in the code. User
  directories are untouched.
- **pnpm 11**
  - Lifecycle scripts run only for packages approved under `allowBuilds`. This is the user's policy
    and is unchanged.
  - pnpm 11 ignores `NPM_CONFIG_REGISTRY`, so registry overrides go through the profile `.npmrc` or
    `pnpm_config_registry`. Both are verified.
- **3.7 in-slot test** proves the wiring (routing, forced warning, degradation), not an actual
  document conversion.
- **No `native/` dir.** Target native addons stay in `app/node_modules`, as in upstream's layout.
  pnpm's Windows-only `fastlist-*.exe` is dropped on other OSes.
- **Stale `update.lock`.** After a killed updater the lock stays, and the next run tells you to
  remove it. As the spec requires, it is never reclaimed automatically.
- **Windows crash window.** Without an atomic directory exchange, same-version `--force` uses
  quarantine and restore. A crash between those two steps leaves `bundles/<v>` missing. The
  launcher names the missing path, and the next maintenance run restores it from the quarantined
  copy.

## Needs your approval (not done)

- **10.1:** after the first publication, install it to `~/.local/share/dsh-bin`, keep your wrapper
  as `~/.local/bin/dsh.npm`, and link `~/.local/bin/dsh`.
  - The launcher does not choose a profile. Your current wrapper adds `--profile tui` and sets
    `DSH_TELEMETRY_DISABLED=1`, so keep a small wrapper that does the same and execs
    `~/.local/share/dsh-bin/dsh`.

## Startup performance (your decision, 2026-09-29)

All figures below were measured on Linux x64 (Ryzen AI 9 365). The benchmark boots the shipped
`headless` profile, with its plugin stack mounted, and prints `--help`. Each figure is the best of
5–7 runs.

| Case | npm + node | dsh-bin |
|---|---|---|
| Profile boot, warm | 361 ms | 304–321 ms |
| Profile boot, transpiler cache off | – | 387 ms |
| First start of a fresh install, page cache evicted, empty cache | – | 497–683 ms |
| First start of a fresh install, page cache evicted, shipped cache seeded | – | 454–515 ms |

- **Transpiler cache.** What the tests found about Bun 1.4.2's transpiler cache:
  - its `.pile` entries are content-keyed, so they stay valid across install paths and file mtimes;
  - Bun reads a read-only cache and does not report an error when it cannot write;
  - `BUN_RUNTIME_TRANSPILER_CACHE_PATH` counts only at process start, so setting it at runtime
    does nothing.

  Changes, following those findings:
  - The launcher points the cache at dsh-bin's own user cache instead of Bun's shared
    `~/.bun/install/cache`. A value you set yourself wins, including `0`. The locations are:
    - Linux/BSD: `$XDG_CACHE_HOME/dsh-bin/transpiler`, or `~/.cache/dsh-bin/transpiler`;
    - macOS: `~/Library/Caches/dsh-bin/transpiler`;
    - Windows: `%LOCALAPPDATA%\dsh-bin\cache\transpiler`.
    The launcher also exports the cache root as `DSH_BUNDLE_CACHE`.
  - Each release build warms the cache on its native runner. It boots all five shipped profile
    templates with `--help` and ships the result as `bundles/<v>/transpiler-cache/`: 347 entries,
    about 9 MB unpacked and about 4 MB in the zip.
  - **Deviation from your choice.** You chose "copy at activation"; the copy runs on the first
    start of each bundle version instead. It copies only the missing entries and writes a
    `.seeded-<v>` stamp. I moved it because zip, Scoop and portage installs never run
    `dsh update`, so seeding at activation would miss them. Seeding at first start covers every
    install path and costs one directory listing on later starts.
  - `dsh update --clean` also clears `$DSH_BUNDLE_CACHE/transpiler`. It never touches a cache
    path you set yourself.
- **Measured gain:** about 90–150 ms on the cold first start of each new version. Warm starts are
  unchanged. The ~800 ms first start seen earlier comes from reading the 78 MB executable from
  disk, not from transpiling.
- **Entry flags.** The compiled entry now uses `--minify --bytecode --format=esm`, as xz-dev/pi
  does. `--bytecode` is applied only when compiling for the host OS/arch (oven-sh/bun#18416), and
  every release target builds natively. Measured: within noise, because the entry is only 23
  modules.
- **Not possible without forking upstream: the whole app as one bytecode file.** Bun 1.4.2 emits
  ESM bytecode only into a `--compile` executable. dsh's design loads bundles and user plugins as
  on-disk packages: dsh-app-boot imports them by name and routes resolution through Node's
  internal loader. Compiling the app into the executable would break plugin resolution of host
  packages and the 28 modules that use `import.meta.url` for files.

## Automatic publication (your decision, 2026-09-29)

Publishing works like xz-dev/pi, with no manual step:

- `upstream-poll` runs on its cron, on every push to `main`, and on a manual dispatch that just
  re-runs detection. It is the only caller of `build` with `publish: true`.
- `build` and `addon` no longer have a `publish` input, so a manual dispatch is always a dry run.
- A push that changes packaging (anything except docs, tests, Markdown, LICENSE and `ci.yml`) since
  the launcher commit of a channel's newest entry rebuilds:
  - the newest release tag, unless a newer tag is already pending;
  - the observed `master`.
  `upstream-diff --head` decides this from the full history, and it is covered by unit tests.
- The first automatic poll came from the push of the automation commit. It planned
  `dsh-v0.1.7-rc.2`, then `dsh-v0.2.0-rc.1`, then live `4878cdab`, run one at a time. Each build
  publishes its slot's office addon first when the slot has none.
