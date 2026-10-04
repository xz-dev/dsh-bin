# Install, data locations and uninstall

[README](../../README.md) · [中文](../zh-CN/install.md)

## Download the single manager

1. Choose a `manager-v<semver>` release on the [Releases page](https://github.com/xz-dev/dsh-bin/releases). Do not use the repository-wide Latest label to identify a runtime.
2. Download the asset for your OS and CPU:

   | Platform | Manager ZIP |
   |---|---|
   | Linux x64 / ARM64 | `manager-linux-x64.zip` / `manager-linux-arm64.zip` |
   | macOS Intel / Apple Silicon | `manager-darwin-x64.zip` / `manager-darwin-arm64.zip` |
   | Windows x64 / ARM64 | `manager-windows-x64.zip` / `manager-windows-arm64.zip` |

3. Check the ZIP's size and SHA-256 against the matching version/target in `manager-index.json` on the repository's `releases` branch. The release also supplies `SHA256SUMS`; verify build provenance with `gh attestation verify <zip> --repo xz-dev/dsh-bin` when needed.
4. Extract the single `dsh` (`dsh.exe` on Windows) into a directory you own. Linux/macOS users must give it execute permission if the extractor did not preserve it. No Node.js, Bun or root installer is needed.

Example after downloading and verifying the Linux x64 manager ZIP:

```sh
mkdir -p "$HOME/tools/dsh"
unzip manager-linux-x64.zip -d "$HOME/tools/dsh"
chmod +x "$HOME/tools/dsh/dsh"
export PATH="$HOME/tools/dsh:$PATH"
dsh manager info
dsh --help
```

You choose whether to add the directory permanently to PATH or create a stable symlink. The manager does not add a PATH entry itself. Its Linux binary is static; libc/AVX2 selection belongs to the separate runtime download. Alpine runtimes still need `libstdc++` and `libgcc` (`apk add libstdc++ libgcc`).

## First ordinary launch

```sh
dsh
```

In an interactive terminal, the manager first shows the shell completion target and asks for consent. Refusing or a failed registration does not block startup. It then checks runtimes: an empty installation with no fixed/explicit selection installs the latest compatible runtime from its recorded channel (release for a new installation) and starts it with your original arguments and working directory. It does not choose a profile for you.

Noninteractive launch skips the question, keeps stdin for the application and still installs a runtime if needed. The next interactive launch can ask. Existing installations start their selected runtime offline; missing explicit versions and damaged runtimes fail with a repair instruction rather than downloading a substitute. [Help and native commands](versions.md) do not enter this bootstrap.

## Where data lives

```sh
dsh manager info
```

| Installation | Data root |
|---|---|
| Ordinary single-file download | `dsh-bin/` beside the **real executable** |
| Gentoo / Portage | absolute `$XDG_DATA_HOME/dsh-bin`, otherwise `~/.local/share/dsh-bin` |
| Scoop | `%LOCALAPPDATA%\dsh-bin` |

A symlink or a different working directory does not change the root. A portable directory must be writable: failure reports the path, without falling back to HOME or requesting administrator rights. A nonempty unrelated `dsh-bin` directory is a conflict, not adopted automatically.

The root holds runtimes, addons, plugin and configuration snapshots, state, caches, temporary files and default application home (`dsh-bin/home`). A nonblank `DSH_HOME` changes only application home and non-configuration state such as sessions: it does not move P or C, import old home settings, or grant access to home credentials. Empty/whitespace-only values use the default home. `~` expands to user home; relative values resolve from the original working directory. Runtimes, both snapshot kinds and manager caches stay in the data root. An external `DSH_HOME` is outside the portable move guarantee.

Stop sessions before moving the manager **and its whole `dsh-bin/` directory** together, on a compatible platform. Moving only the manager starts a new independent installation. User-specified external paths are not copied or rewritten.

## Inspect paths without starting the application

```sh
dsh manager path
dsh manager path --json
dsh manager path self
dsh manager path home
dsh manager path runtime <runtime>
dsh manager path snapshot plugins <snapshot>
dsh manager path snapshot config <snapshot>
dsh manager path addon office:<addon>
dsh manager path cache
dsh manager path tmp
dsh manager path completion powershell
```

Omit an inventory target to list local entries; `path snapshot` lists both kinds. The overview explains the executable, data root, home, path sources and effective runtime/P/C/addon choices. It does not create missing directories or snapshots, bootstrap a runtime, acquire operation locks, register completion, start subprocesses, use the network or read configuration/credential bodies. Independent project `.env` and inherited environment retain upstream semantics; this query does not enumerate secret backends.

JSON has `schemaVersion: 1`, `complete`, `records`, `effective` and `diagnostics`. Missing defaults may leave selection unresolved while the inventory query remains complete; no snapshot is created to fill the gap. Missing or ambiguous explicit targets, invalid kinds, inaccessible or conflicting storage return a nonzero exit with diagnostics, not a silent latest fallback. A legacy completion registration without a recorded location reports unknown; the query never reads shell rc content to guess it.

## Managed packages

These packages install the manager, an ownership marker and an entry/shim, **not** a runtime or addon.

### Gentoo

With the package available in your configured overlay:

```sh
emerge --ask app-misc/dsh-bin
emerge --ask --update app-misc/dsh-bin
```

The manager package installs under `/usr/lib/dsh-bin` with `/usr/bin/dsh`. User data uses the Gentoo root above. The [ebuild template](../../dsh-manager/packaging/gentoo/dsh-bin-9999.ebuild.in) belongs to the manager project.

### Scoop

The bucket lives on the `scoop` branch of this repository:

```powershell
$scoopRoot = (Resolve-Path (Join-Path (scoop prefix scoop) '..\..\..')).Path
git clone --branch scoop --single-branch https://github.com/xz-dev/dsh-bin.git (Join-Path $scoopRoot 'buckets\dsh-bin')
scoop install dsh-bin/dsh
scoop update dsh
```

There are no separate new `dsh-live` or `dsh-office` packages: select a runtime channel or install an addon with manager commands.

In either managed mode, runtime install/update/uninstall, selection, snapshots and addons remain user-controlled. `dsh manager self-update` refuses **before downloading** and names the package update command. Package upgrades keep the same user data root.

## Uninstall

To remove only runtimes, see [Versions](versions.md#remove-runtimes). All unused runtimes can be removed after unpinning; snapshots and application home remain.

For a portable installation, stop sessions, [unregister completion](completion.md#remove-registration) if installed, then delete only the manager file and any PATH link you created. This leaves the adjacent data root intact.

For packages:

```sh
emerge --ask --unmerge app-misc/dsh-bin
```

```powershell
scoop uninstall dsh
```

Both preserve user runtimes, snapshots, configuration, credentials and sessions. Completion registration is separate user state; remove it before deleting the manager if no longer needed.

Deleting the data root is a separate, destructive decision: it removes runtimes, both snapshot kinds (including C's local credentials) and the **default** application home with its sessions. Back it up and inspect the path first. An explicit external `DSH_HOME` is not removed by deleting the data root. `manager clean` is not an uninstall or data-erasure command.
