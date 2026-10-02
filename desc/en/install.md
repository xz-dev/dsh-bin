# Install, data locations and uninstall

[README](../../README.md) · [中文](../zh-CN/install.md)

## Release status

The new `manager-v*`, `runtime-v*` / `runtime-live-*` and `addon-office-v*` releases are not published yet. Manager-only Gentoo/Scoop packages are also pending. Existing releases and bucket manifests do not provide this new layout. The steps below describe installation after those assets are published, not a working download from an old release.

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

The root holds runtimes, addons, snapshots, state, caches, temporary files and default application home (`dsh-bin/home`). A nonblank `DSH_HOME` changes only application home: configuration, credentials, sessions and shared profile settings. Empty/whitespace-only values use the default home. `~` expands to user home; relative values resolve from the original working directory. Runtimes, snapshots and manager caches stay in the data root. An external `DSH_HOME` is outside the portable move guarantee.

Stop sessions before moving the manager **and its whole `dsh-bin/` directory** together, on a compatible platform. Moving only the manager starts a new independent installation. User-specified external paths are not copied or rewritten.

## Managed packages

Use these commands only after the manager-only packages are published. They install the manager, an ownership marker and an entry/shim, **not** a runtime or addon.

### Gentoo

With the package available in your configured overlay:

```sh
emerge --ask app-misc/dsh-bin
emerge --ask --update app-misc/dsh-bin
```

The manager package installs under `/usr/lib/dsh-bin` with `/usr/bin/dsh`. User data uses the Gentoo root above. The [ebuild template](../../dsh-manager/packaging/gentoo/dsh-bin-9999.ebuild.in) belongs to the manager project.

### Scoop

Once the new `dsh.json` is published to the `scoop` bucket branch:

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

Deleting the data root is a separate, destructive decision: it removes runtimes, snapshots and the **default** application home, including credentials and sessions. Back it up and inspect the path first. An explicit external `DSH_HOME` is not removed by deleting the data root. `manager clean` is not an uninstall or data-erasure command.
