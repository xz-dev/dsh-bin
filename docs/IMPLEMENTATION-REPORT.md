# dsh-bin implementation report (OpenSpec change `dsh-bin`)

## Status

All sections (1–10) are implemented. `openspec validate dsh-bin --strict` reports the change as
valid. `tasks.md` has 47 tasks `[x]` and 6 `[ ]`.

**Published.** The first automatic publication is `dsh-v0.1.7-rc.2-xz.7.1.g4e41a3f1`, from
upstream-poll run 36514734022:
- all 12 targets were built natively and passed the packaged E2E;
- it is attested and verified with empty gh credentials;
- the release is immutable;
- `index.json` lists it as release seq 1, next to the office addon (seq 1);
- the `scoop` branch has `bucket/dsh.json` and `bucket/dsh-office.json`.

**Your dsh is now dsh-bin (10.1).**
- `~/.local/bin/dsh` runs `~/.local/share/dsh-bin`, with `--profile tui` by default.
- The npm wrapper is kept as `~/.local/bin/dsh.npm` for rollback.
- `dsh update` updates it in place.

**The six open tasks.** Each has a check that has not been run yet:
- **8.2:** GitHub plugin install in the packaged E2E.
- **8.3:** the first live publication, which must leave Latest on the release channel.
- **8.4:** concurrent live + release appends on GitHub.
- **8.6:** the manual-dispatch no-op check.
- **9.1 / 9.4:** `scoop install` on a Windows runner.

Commits are unsigned Conventional Commits.

### How many rounds it took

Publication succeeded on the fifth push-triggered poll. Each earlier round got one step further,
then failed on the next step, none of which had run before:
- the musl builds needed `cmake` (koffi has no arm64-musl prebuild), and the container's output had
  to be chowned back to the runner;
- GitHub's implicit `success()` skipped `accept`, `aggregate` and `publish` whenever the optional
  `addon` job was skipped, so every release built all 12 targets and then published nothing;
- `build-target.mjs` never wrote its per-target release manifest;
- the packaged E2E tested the host's default target instead of the matrix target.

The second build of the same poll run, `dsh-v0.2.0-rc.1` in run 36514734022, then failed accept on
2 of the 12 targets with "index already lists dsh-v0.1.7-rc.2 … with different content". upstream-poll
calls `build.yml` once per build within a single workflow run, and artifact names are shared across
the whole run, so `target-<id>` could resolve to the earlier build's artifact. a83dab6 prefixes every
build's artifacts with `<channel>-<commit>`, including the addon's. The cancelled run's rc.1 was
never published, and poll 36521166476 rebuilds rc.1 and then live.

The index append, the scoop bucket (including `dsh-office`) and aggregation were rehearsed locally
against a copy of the real `releases` branch before the poll reached them.

### GitHub's "Latest" = the release channel (your decision, 2026-09-29)

- `publish-release.mjs` sends `make_latest=true` for release-channel bundles and `false` for live
  and addon releases.
- The poll publishes in index `seq` order, so Latest is always what
  `dsh update --channel release` would install.
- `dsh-v0.1.7-rc.2` was marked Latest explicitly. Before that, GitHub had only computed it as
  Latest because no release was marked.
- Nothing reads Latest. Discovery stays on `index.json`.
- Plain `dsh update` never changes channel: it uses the recorded channel, and only
  `--channel` switches and records a new one. The contract cases "channel switch installs the
  older-upstream live build and persists" and "failed channel switch keeps the recorded channel"
  pin this behaviour.

Publish-side files (`scripts/publish-*`, `scripts/upstream-diff.mjs`, `upstream-poll.yml`) are
now excluded from "packaging changed". Changing how releases are published does not rebuild
bundles that are already published.

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
- **Windows CI timing flakes.** On windows-2022, a heavy test sometimes goes over bun's default 5 s
  test timeout. Two cases have shown this:
  - "two concurrent updaters", which also failed on `main` in run 36535866768;
  - "assemble inventory", which took 9.3 s once and passed on the rerun.

  Each was a single failure, and a different one on each attempt. Neither goes through the launcher.
  The probable fix is an explicit per-test timeout; I will apply it with 5.4, which rewrites the updater
  contract.
- **Children do not hold the usage claims (accepted trade-off, your decision 2026-09-29).**
  - The usage claims now cover only dsh-bin's own runtime processes, and the spec says so. They prevent
    mistakes; they are not a guarantee. Plain filesystem primitives cannot track every user of a
    directory. The launcher and plugin-snapshots specs and design S3 were changed to match.
  - Design S3 used to assume that pnpm children and lifecycle scripts inherit the claim descriptor on
    POSIX, and D4 assumed the same. They do not.
  - Evidence: `~/.cache/cp-probe/inherit2.ts`. A Bun parent takes a shared flock, then starts `sleep`
    through both `child_process.spawn` and `Bun.spawn`, and is SIGKILLed. The lock was free at once,
    although both children were still running. Bun passes no extra descriptors to its children, even with
    `FD_CLOEXEC` cleared (`fdinherit.ts`).
  - The shims start `dsh-native` with `BUN_BE_BUN=1`, which never runs `runtime/app.ts`, so those
    processes take no claim of their own either.
  - Effect: while the session lives, its own claim covers everything. When only a child remains (the
    session was killed while pnpm was still installing), a `dsh snapshot remove` or `dsh uninstall`
    could delete files under it.
- **Environment inheritance.** `DSH_BIN_SNAPSHOT_DIR` reaches children started through
  `node:child_process`. No upstream package calls `Bun.spawn`, so this covers all of upstream. A plain
  `Bun.spawn` without `env` would not see runtime changes to `process.env` (probe above).

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
- **musl builds ran Bun 1.4.0 (found by the 8.9 addon probe, 2026-09-29).**
  - Symptom: the three musl accepts failed. Every plugin's `createRequire(import.meta.url)("../package.json")`
    threw `Cannot find module`, 62 plugins "failed to import" and no real profile could start.
  - Affected: the published **rc.2 and rc.1 musl assets** (linux-x64-musl-*, linux-arm64-musl).
    Earlier acceptance only ran `--help` and could not see this.
  - Root cause:
    - The pinned musl build images (inherited from xz-dev/pi) contain **Bun 1.4.0**, not the required
      1.4.2, and dsh-native embeds the Bun that compiles it.
    - Musl Bun 1.4.0's `createRequire` calls a replaced `Module._resolveFilename` with no parent
      module. dsh's installation scope replaces `_resolveFilename`, so relative requests failed.
    - Bun 1.4.2 on musl passes the parent; a direct probe on both confirmed it.
  - Fix (your decision):
    - the musl images are pinned to `oven/bun:1.4.2-alpine` by digest (same Alpine 3.22.5
      toolchain);
    - `build-target` refuses to build with any Bun other than `BUN_VERSION`;
    - no runtime shim.
    A createRequire shim was tried first and removed. Its first version passed only with a
    host-compiled binary: it bypassed Bun virtual modules and unbound `resolve.paths`, and that
    only showed in the 1.4.0 image.
  - Verified with dsh-native compiled inside the new image, as CI builds it: the probe boot reaches the
    credential check, the five warm profiles pass, and the full musl E2E (office addon cycle) passes.
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

## Your local install (10.1, done 2026-09-29)

- `~/.local/share/dsh-bin` holds the published `dsh-linux-x64-modern.zip`. Its sha256 was checked
  against the index and its attestation was verified.
- `~/.local/bin/dsh` is a small wrapper, because the launcher does not choose a profile. It runs
  `~/.local/share/dsh-bin/dsh` and, like your old wrapper:
  - adds `--profile ${DSH_PROFILE:-tui}`;
  - sets `DSH_TELEMETRY_DISABLED=1`;
  - passes `update`, `install`, `uninstall`, `list`, `plugin` and the flag commands through
    unchanged.
- `~/.local/bin/dsh.npm` is the old npm wrapper, kept for rollback. `~/.local/bin/dsh-trial` is
  untouched.
- The install itself wrote nothing under `~/.dsh`. The verification boot of your `tui` profile made
  the writes every boot makes:
  - one throwaway session under `~/.dsh/sessions/--tmp-e2e--/`, which you can delete;
  - storage and cache updates;
  - the regenerated `profiles/tui/cordis.yml`.
- Because the launcher points it there, the transpiler cache is in `~/.cache/dsh-bin/transpiler`.

### First real self-update, and why you are back on rc.2

`dsh update` on your machine moved `0.1.7-rc.2` to `0.2.0-rc.1`: a 124 MiB download and
activation, 25 s in total. The self-update worked.

Your `tui` profile then failed to start on 0.2.0 (`agent-loop (required)` was missing `sessions`).
This is upstream's plugin compatibility rule, not a dsh-bin fault:
- every plugin's `peerDependencies` pins `@deepseek-ai/*` to exactly `0.1.7-rc.2`;
- dsh 0.2.0 refuses such plugins, including the core plugins the profile lock still holds at
  `0.1.7-rc.2`;
- npm dsh 0.2.0 would refuse them the same way.

I put the rc.2 launcher back in place; the rc.2 bundle was still installed. Your tui boots again.

On a copy of `~/.dsh`, `dsh plugin --profile tui update` under the 0.2.0 bundle took 12 s with no
Node, and exit 0. The earlier 900 s timeout did not reproduce. That run used a copy on a different
filesystem from your pnpm store, with a `storeDir` override, which is the likely cause; it is not
proven. The update still reports 14 of your profile plugins as incompatible:
- 13 are `dsh-tui` 0.11.1 and your own `xz-dev/dsh-*` plugins, which pin `0.1.7-rc.2`;
- the 14th, `dsh-session-search-pro`, pins `^0.1.0-rc.6`.

`@deepseek-harness-tui/dsh-tui` 0.11.2 already accepts 0.2.0-rc.1. The 12 `xz-dev/dsh-*` plugins
are yours, so you can widen their exact `0.1.7-rc.2` peer pins. Only `dsh-session-search-pro`
depends on another author, or on an exact-version exemption (`dsh plugin allow-version`). Until then,
stay on rc.2; `dsh update` will offer rc.1 each time.

`dsh update` does not check plugin compatibility (your decision, 2026-09-29). It manages only dsh and
its addons, and contacts only the release index and exact-tag downloads. Plugin compatibility belongs
to dsh itself: its startup check and `dsh plugin`. A post-update plugin warning was built and then
removed for this reason.

### rc.1 again at 15:46, and the startup log at 15:47

Your install is on rc.1 again: the launcher and channel file changed at 15:46, and your shell
history shows `dsh update --all`, so that is most likely what moved it. The startup logs at 13:02 and 15:47 are
identical, and they reproduce on a copy of `~/.dsh`.

The first line of the log (`hmr` failed) is misleading: that is dsh-bin's declared degradation,
which is only a warning on rc.2 too. The real failure is the one above.

The `tui` profile's `node_modules` (`nodeLinker: hoisted`) holds 149 `@deepseek-ai/*` packages at
`0.1.7-rc.2`, installed with dsh-tui and the plugins. On rc.1, the compatibility preflight resolves
about 25 base rows to those profile copies and disables them: `session`, the tools, and
`plugin-manager`. Nothing then provides `sessions`.

Removing only the profile's `dsh-session` on the copy makes every `sessions` error disappear. A fresh
profile boots on rc.1.

The smoke test gap:
- the accept job boots a fresh profile on every target;
- no test boots a new version over a profile that was populated on the previous version.

## Weak-network downloads and `dsh --help` (your request, 2026-09-29)

Ported from xz-dev/pi's updater (`xz-release-update.ts`) and extended with resume:
- **Progress.** A bar with bytes, speed and ETA, redrawn on a terminal. Off a terminal, one plain
  line per second. The first line waits one interval, so connection setup does not skew the speed.
- **Timeouts.** A 30 s inactivity timeout covers both the response headers and each body chunk.
- **Retry.** Network errors and 408/425/429/500/502/503/504 are retried with exponential backoff
  from 1 s, capped at 16 s. `Retry-After` is honoured, up to 60 s. A download gives up after 5
  attempts in a row with no progress; any bytes received reset the count. The index is tried 3
  times.
- **Resume.**
  - Every retry sends `Range: bytes=<kept>-`, and a 206 is accepted only when its `Content-Range`
    starts at the kept offset.
  - A 200 restarts from byte 0.
  - A 416 drops the kept bytes.
  - The partial file survives a failed run as `<root>/.downloads/<sha256>.part`, keyed by the
    index digest, so the next run resumes it.
  - `dsh update --clean` removes kept partial files.
  - pi has no resume.
- **Verification is unchanged.** The file must match the index size and SHA-256. If a resumed file
  fails, it is downloaded once more from the start before `sha256 mismatch` is reported.
- **Checked against GitHub.** The 124 MiB rc.1 `linux-x64-modern` asset resumed from a kept 8 MiB
  part: the exact-tag download returned 206, and the result matched the index.
- **`dsh --help` / `-h`.** Upstream prints its launcher help, then the entry appends the dsh-bin
  commands (update, install, uninstall, list) from an exit hook. A profile's own help
  (`dsh tui --help`, `dsh --profile tui --help`) is left alone. The packaged E2E checks both parts.
- **Tests.**
  - The update contract serves resets, stalls, 503s, a Range-ignoring server and a corrupt kept
    part, and pins the exact requests.
  - Unit tests cover formatting, progress throttling, backoff and help detection.

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
  - **Seeded at first start (you approved this, 2026-09-29).** You first chose "copy at
    activation"; the copy runs on the first start of each bundle version instead. It copies only the missing entries and writes a
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

## Plugin snapshots, spike 1.1: profile path split (dsh-bin-select-snapshots S1, 2026-09-29)

`scripts/transform-app.mjs` rewrites the profile paths of the built app. Upstream is not forked.
It scans first-party code only (`lib/` and `node_modules/@deepseek-ai/`); third-party code has
look-alike `join(dir, file)` calls. The build fails if the set of sites changes. Re-running the
transform is a no-op.

Sites, identical in rc.2 (`0.1.7-rc.2`) and rc.1 (`0.2.0-rc.1`):

| File | Sites |
|---|---|
| `@deepseek-ai/dsh-app-boot/lib/index.js` | `resolveProfileDir` (dir), `createRuntimeResolution` profiles tree (root), 4 file joins: `initProfile` patch, `loadProfile` patch, patch backup, `cordis.yml` include walk |
| `@deepseek-ai/dsh-plugin-manager/lib/index.js` and `lib/types/index.js` | 1 file join each: `join(this.profile.dir, file)` config read |
| `lib/profile-boot-*.js` | 3 `cordis.yml` joins (write ×2, root config) |
| `lib/dump-config-*.js` | 1 `cordis.yml` join |

- With `DSH_BIN_SNAPSHOT_DIR=$DSH_HOME/snapshots/<id>` set, the profile directory is
  `<snapshot>/profiles/<name>`.
- `sharedProfileFile` maps only `cordis.patch.yml` to `$DSH_HOME/profiles/<name>/`; it creates that
  directory when it is missing. The shared root is derived from the snapshot dir, so there is no
  second variable.
- With the variable unset, every path is upstream's.

**Finding: `cordis.yml` cannot be shared (your decision: share only the patch).** Upstream sets the
Loader's `baseUrl`, the module-resolution root for every plugin entry, to the directory of
`cordis.yml`. With `cordis.yml` in `$DSH_HOME/profiles/tui`, all 24 profile plugins failed with
`failed to import`. `cordis.yml` holds no user state, because upstream rewrites it to `[]` on every
boot. It now stays in the snapshot. The proposal, design S1, the plugin-snapshots and
plugin-runtime specs, and task 1.1 were revised to match.

Results on a scratch `DSH_HOME`. "Only the snapshot changed" is checked with a digest of each tree
(`profiles/` and every snapshot, `node_modules` included) taken before and after.

| Check | rc.2 (`snapshots/rc2@1`, your real tui runtime) | rc.1 (`snapshots/rc1@2`, tui from the web template) |
|---|---|---|
| tui boots from the snapshot | yes; only the declared hmr degradation | yes; hmr and office (addon not installed) degradations only |
| `--dump-config` shows the shared patch | yes (7 layers labelled `$DSH_HOME/profiles/tui/cordis.patch.yml`) | yes |
| `plugin --profile tui add github:xz-dev/dsh-caveman` | only `rc2@1` changed (`remove` also checked) | only `rc1@2` changed (after `allow-version`, since dsh-caveman pins rc.2 peers) |
| plugin-manager toggle (`setPluginEnabled`, via a probe plugin) | wrote `dsh-caveman: disabled` to the shared patch; the snapshot was unchanged | same |

- rc.1 could not use your real tui runtime: dsh-tui 0.11.1 and several plugins pin rc.2 peers, and
  upstream rc.1 refuses them. rc.1 therefore used a fresh tui made from the web template. Creating
  it also showed that a new profile gets its runtime and `cordis.yml` in the snapshot and its patch
  in the shared directory.
- **Finding for task 7.2: relative `file:` specs break when a runtime moves.** Your tui
  `package.json` and lockfile reference `file:../../artifacts/vectorize-io-hindsight-coding-agents-0.7.0.tgz`.
  pnpm resolves such paths from the profile directory, and a snapshot runtime is two levels deeper,
  so the moved copy failed with ENOENT until the paths were rewritten to `../../../../artifacts/`.
  - Between snapshots the depth is the same, so snapshot-to-snapshot copies are not affected.
  - Your migration (7.2) must re-add such plugins, or rewrite the paths, or use an absolute path.
- Not a spike regression: `dsh -p` gets no model reply within 240 s on either the snapshot or your
  untouched install. This is still the open item "a model reply through `dsh -p`".

### Task 2.1: build order and schema 2

- `bundle.json` and every index entry now carry:
  - `upstream.commitTime`: the committer time of the upstream commit, in UTC `toISOString()` form so it
    sorts as text;
  - `run` and `attempt`;
  - `launcherProtocol: 2`.
- The index and `bundle.json` are schema 2. The updater rejects a schema-1 index, and assembly refuses a
  missing or non-canonical commit time.
- Version order (`compareVersionOrder` in `runtime/layout.ts`) is commit time, then run, then attempt.
  Unit tests cover the release/live and rebuild scenarios.
- Checked on a real local build: `bundle.json` in the archive, `release-manifest.json` and the appended
  index entry all carry the same four fields, and `index.mjs check` accepts the result.
- **Not pushed.** The build workflow reads the live schema-1 index, so any push that triggers a poll
  would fail until the one-time reset (7.1) empties it to schema 2. The code stays on local `main` until
  then.

### Task 3.1: one launcher for every installed version

- `launcher/src/select.zig` has no I/O, so it is unit tested (`zig build test`, 15 tests). It holds:
  - the leading-option parser;
  - version matching (exact version, tag, unique prefix; an ambiguous prefix is refused);
  - version order;
  - the `bundle.json` and `selection.json` readers (`std.json`, not a hand scan);
  - resolution;
  - the maintenance-bundle choice;
  - `DSH_BIN_LAUNCH`;
  - the Windows command-line tail.
- `launcher/src/main.zig` does the I/O, then execs (POSIX) or waits for the child (Windows).
- **`latest` follows the recorded channel.** It is the last bundle in version order whose `bundle.json`
  channel is the install root's `channel` file, falling back to the channel the launcher was built for.
  A bundle with an unreadable `bundle.json` is never skipped silently: `latest` refuses and names
  `dsh install <v> --force`.
- **Maintenance commands** (`update install uninstall list select snapshot`) run on the newest bundle
  that this launcher can start, of any channel, without a usage claim. They still run when:
  - the pinned version is missing;
  - the selection file is broken;
  - a bundle declares another protocol.

  In those cases `DSH_BIN_LAUNCH.version` is `null`. When the leading options resolve, the command gets
  that version, for example `dsh --use X snapshot new`. A broken selection is never read as `latest`.
- **`DSH_BIN_LAUNCH`** is JSON with these keys:
  - `protocol`;
  - `version` and `source` (`use`, `snapshot`, `selection` or `managed`);
  - the launch's `use`, `snapshot` and `addons`;
  - the `selection` object the launcher read.

  The runtime (4.3) resolves the snapshot and the addons from that same selection. An inherited value is
  always replaced, so a `dsh` started inside a dsh session does not inherit the parent's pin.
  `DSH_BUNDLE_VERSION` and `DSH_BUNDLE_CHANNEL` now describe the bundle that was started.
- **Managed installs:**
  - the one installed bundle starts, and the selection's `use` is ignored;
  - `--use` and `--addon` exit 1, naming the manager;
  - `--snapshot` and a snapshot-only selection work.
- **The launcher markers stay readable from the bytes.** `DSH_BIN_LAUNCHER_VERSION=<build>` is kept, so
  the updater's install check and the `--clean` keep rule keep working unchanged.
  `DSH_BIN_LAUNCHER_PROTOCOL=2` is new. Tasks 5.3 and 5.4 change the updater to replace the launcher only
  on a newer protocol, and to stop treating the launcher's build as "the active version". Those changes
  belong to their own scenarios, not to 3.1.
- **Restart.** The launcher test proves the launcher's part: a direct respawn of `dsh-native` (what
  upstream's `restartTui` does) inherits `DSH_BIN_LAUNCH` with the same version, even after the selection
  file was changed in between. That the restarted runtime reuses it is task 4.3.
- **Launcher tests** use a small Zig fake runtime, `test/launcher/fake-native.zig`, instead of a shell
  script, so the same 20 cases also run on Windows. They cover:
  - pass-through and exit status;
  - both option forms and prompt text;
  - `--use` over `--snapshot`;
  - `latest` per channel, and the rebuild order;
  - a missing bundle or pin, and a protocol mismatch;
  - a broken selection;
  - maintenance commands with a missing pin;
  - managed installs;
  - restart after a selection change;
  - the environment and `DSH_HOME` rules;
  - the claim held or not held per command.

  The tests now remove their temporary directories.
- Verified on Windows: CI run 36568881662 on the side branch `select-snapshots` (not `main`, so no
  poll). On windows-2022, all 18 Windows-eligible launcher tests pass in both attempts. The symlink and
  POSIX-cache cases are skipped by design. Ubuntu and macOS are fully green. The only red on Windows was
  one timing flake per attempt, listed under "Not verified yet".
- Verified on Linux: `zig build test` 15/15, and the full suite 298 pass / 0 fail. Cross-builds for
  Windows x64/arm64, linux-musl and macOS arm64 succeed, and both markers are present in `dsh.exe`.
  Earlier runs had filled `/tmp` with about 6 GB of leftover test directories (ENOSPC); those were
  removed.

### Task 4.1: snapshot store

- The store is `runtime/snapshot/store.ts`, laid out as design S3.
  - **Lock.** The store `.lock` is an flock / LockFileEx, not a mkdir lock, so the kernel releases it
    when its owner dies. A crashed creation never blocks the next one. Waiters retry every 50 ms.
  - **Numbers.** `n` is written to `.counters.json` before the copy starts. Allocation also takes the
    maximum with the existing directories, so a lost counters file cannot reuse a number.
  - **Commit and removal.** A new snapshot is copied into `.staging-*`, then renamed into place. A
    removal takes the exclusive claim, renames the snapshot to `.trash-*`, then deletes it. Leftovers
    are swept under the lock by the next operation, or by `sweepSnapshotLeftovers` for `--clean`.
  - **Copy.** `cpSync` with `COPYFILE_FICLONE` and `verbatimSymlinks`. strace on this machine shows one
    `ioctl(FICLONE)` per file on ZFS. pnpm's relative `.bin` links stay relative.
  - **Version order.** `snapshot.json` also records the version's build order (commit time, run,
    attempt), so snapshots of uninstalled bundles still take part in version order (needed by 4.2).
  - **Ids.** `<version>@<n|alias>` accepts any version form the selection accepts: exact, tag, or unique
    prefix. `matchVersion` and `dshHome` now live in `runtime/layout.ts`, and follow the same rules as
    the launcher.
- Tests: `test/unit/snapshot-store.test.ts`, 10 cases, all passing. They cover:
  - numbers never reused, including after every snapshot is removed;
  - remove-middle;
  - the alias rules;
  - a full copy with symlinks, an independent copy, and source/reason recorded;
  - four concurrent processes producing exactly one snapshot;
  - removal of a held snapshot refused, and SIGKILL releasing the claim;
  - stacked shared claims;
  - a crash after the copy leaving no snapshot, with the staging swept and `n` not reused;
  - unreadable directories ignored.
- Full suite: 308 pass / 0 fail.

### Task 4.2: automatic snapshots

- `runtime/snapshot/auto.ts` provides `previousSource` and `ensureSnapshot`.
  - The previous version is the nearest earlier version in version order, read from `snapshot.json`, that
    has a snapshot. The source is that version's newest snapshot; with no earlier version, the new
    snapshot is empty.
  - A later version is never a source.
  - Creation takes the store lock; if the version already has a snapshot by then, nothing is created.
- **At start.** `runtime/app.ts` calls it before the compat layer and `bin.js`, unless the launch names a
  snapshot. A snapshot is named by the launch's `--snapshot`, or by the selection's when the version
  comes from the selection or a managed install. `runtime/snapshot/launch.ts` reads that from
  `DSH_BIN_LAUNCH`. The notice goes to stderr. A failed copy stops the launch with status 1.
- **After install.** `updateSelf` calls it after activation, except for managed installs. A failed copy
  only warns, because the install has succeeded and the next start retries.
- Tests:
  - `test/unit/snapshot-auto.test.ts`, 5 cases: Tumbleweed-style update, all removed, first install,
    nearest previous version (not a later one), and a source whose bundle is uninstalled.
  - `test/runtime/snapshot-start.test.ts`, 3 cases, run against the compiled entry with a stub `bin.js`:
    the snapshot exists before `bin.js` runs; a start after an update copies the previous version's
    snapshot; a named snapshot creates nothing.
  - Contract changes: update with no profiles now shows `Created plugin snapshot <v>@1 (empty).` and
    creates no `profiles/`. The first `--help` launch creates the snapshot, and the second leaves
    everything unchanged.
- Full suite: 316 pass / 0 fail. Leaked `dsh-*` test directories were removed from `/tmp`.

### Task 4.3: runtime wiring

- `runtime/snapshot/resolve.ts` resolves the snapshot in this order:
  1. the snapshot already resolved (a restart);
  2. the launch's `--snapshot`;
  3. the selection's snapshot, but only when the version came from the selection or a managed install;
  4. otherwise the newest snapshot, created automatically when there is none.
- **Claim.** It takes the shared claim, then re-checks that the snapshot still exists, closing the race
  with removal. The claim is held for the life of the process.
- **Missing or ambiguous snapshot.** The launch fails with one diagnostic that names
  `dsh snapshot list`. When the snapshot came from the selection, it also names
  `dsh select --use latest`.
- **`runtime/app.ts`** does four things:
  - sets `DSH_BIN_SNAPSHOT_DIR`;
  - writes `resolved.snapshot` into `DSH_BIN_LAUNCH`, so a restart reuses it even after the selection
    changes (a fresh launcher start always replaces the variable);
  - strips leading `--use/--snapshot/--addon` on direct `dsh-native` starts. This uses the same parser as
    the launcher, and a direct start refuses an option that names another version;
  - skips all of this for a bare app tree with no bundle.json build order, so the old startup and
    plugin-runtime tests keep upstream paths.
- `test/runtime/snapshot-start.test.ts`, 7 cases, all passing:
  - a restart after a selection change stays on the same snapshot with the same arguments, and the
    `node` shim sees the same `DSH_BIN_SNAPSHOT_DIR`;
  - the selection's snapshot is used only when the version came from the selection;
  - a stale or missing snapshot fails with its diagnostic;
  - a running session makes `removeSnapshot` return busy, and after SIGKILL the removal succeeds;
  - on a direct start, leading options are stripped, `-p "--use 1"` is passed on unchanged, and another
    version is refused.
- Addon resolution from the launch (`--addon`) belongs to 5.5, which replaces `officeWiring`'s enabled
  record. The launch record already carries the addons.
- Full suite: 320 pass / 0 fail.
- The claim covers the runtime processes (the session, `dsh plugin`, restarts), as the revised spec
  requires. Children are out of scope by decision; see "Not verified yet".

### Task 5.1: `dsh select`

- `runtime/selection.ts` reads and writes `$DSH_HOME/dsh-bin/selection.json` (schema 1, `{use, snapshot, addons}`;
  missing = `--use latest`), written atomically with `writeFileAtomic`. The launcher reads the same file.
- `runtime/update/select.ts`:
  - `--use` is required on an unmanaged install; the version is an exact version, tag or unique prefix of an
    installed bundle, otherwise status 1 naming `dsh install <v>` (ambiguous prefixes are named too);
  - `--snapshot` goes through `requireSnapshot` (id or alias, any version); `--addon name:ver` must name an
    installed `addons/<name>/<ver>/`; any refusal leaves the file untouched;
  - omitted options are stored as default (`snapshot: null`, no addon entry);
  - with no options it prints the selection and the resolved version, snapshot (newest when default) and
    each addon (default = newest installed in-slot version);
  - managed: `--use`/`--addon` exit 1 naming the manager; `--snapshot` alone updates only the snapshot and
    keeps a user install's `use`/`addons` in the shared `$DSH_HOME`;
  - an unreadable selection is reported; only `--use` (unmanaged) replaces it.
- `layout.ts` gains `installedBundles`, `latestOf`, `installedAddons`, `defaultAddon` (reused by 5.3/5.5/5.6).
  Addon ordering by index `seq` needs `seq` in `addon.json`, which 5.5 writes; until then ties sort by version.
- `--help` gains the `select` line (the full section rewrite is 5.7).
- Coverage of the version-selection scenarios:
  - contract (11 new cases): initial state after update, pin by prefix/tag and back to latest, missing `--use`,
    version not installed / ambiguous, missing snapshot or addon, forced addon selection, unreadable file,
    managed refusals and managed `--snapshot`, update while pinned keeps the selection;
  - launch resolution, leading options, pinned version removed, managed pin ignored and version order are
    covered by `test/launcher/launcher.test.ts`, `launcher/src/select.zig` tests (3.1) and
    `test/runtime/snapshot-start.test.ts` (4.3);
  - the pinned warning printed by `dsh update` is 5.4, and the out-of-slot launch warning is 5.5.
- Full suite: 331 pass / 0 fail; `zig build test` passes.

### Task 5.2: `dsh snapshot new/remove/list`

- `runtime/update/snapshot.ts`, dispatched as a maintenance command (works in managed installs):
  - `new [--target <id> | --empty] [--name <alias>]` creates a snapshot of the **effective version**
    (`effectiveBundle` in select.ts: the launcher's `DSH_BIN_LAUNCH` version, else a leading `--use`/`--snapshot`
    on a direct start, else the selection; managed installs refuse `--use`/`--addon`). Default source is the
    effective version's newest; no source fails naming `--empty`. Prints `Created plugin snapshot <id> (...)`.
  - `remove <id>...` resolves every id first, refuses one named by the selection (naming `dsh select`), then
    `removeSnapshots` takes every exclusive claim under the store lock; any in use -> status 1, nothing removed.
  - `list [--json]` marks newest / selected / in use (exclusive-claim probe) / bundle not installed.
- Leading `--use/--snapshot/--addon` before a maintenance command on a direct `dsh-native` start are parsed
  and recorded in `DSH_BIN_LAUNCH` (the launcher already strips them).
- Spec fix (your decision, 2026-09-29): the "Snapshot before a risky change" scenario contradicted
  "a new snapshot becomes the newest". It now reads: `snapshot new` creates `@n+1`, the plugin breaks it,
  `snapshot remove @n+1` goes back to `@n`, the runtime as it was before the change.
- Contract: 8 new cases (migrate with `--use ... snapshot new --target`, numbering/alias/`--empty`, risky
  change and middle removal, in-use / selection-named / all-or-none refusal, argument errors, no-source
  and bundle-not-installed marking, managed install, empty list). The `dsh uninstall <version>` half of
  "Uninstall keeps snapshots" is added with the command in 5.3.
- Full suite: 339 pass / 0 fail; `zig build test` passes.
