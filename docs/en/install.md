# Install and uninstall

[README](../../README.md) · [中文](../zh-CN/install.md)

## Script (Linux, macOS)

```sh
curl -fsSL https://raw.githubusercontent.com/xz-dev/dsh-bin/main/install.sh | sh
```

[`install.sh`](../../install.sh) runs exactly the [manual ZIP](#manual-zip) steps, into the same directories. On top of them it:

- picks the target for your OS, CPU and libc;
- downloads it from the Latest release (the release channel);
- checks it against that release's `SHA256SUMS`.

It stops without changing anything if `~/.local/share/dsh-bin` already holds an install or `~/.local/bin/dsh` exists. Set `DSH_BIN_TARGET=<target>` to choose the target yourself.

## Manual ZIP

Download `dsh-<target>.zip` from a [release](https://github.com/xz-dev/dsh-bin/releases) and unpack it into a directory you own. Then put its `dsh` on your `PATH`:

```sh
mkdir -p ~/.local/share/dsh-bin
unzip dsh-linux-x64-modern.zip -d ~/.local/share/dsh-bin
ln -s ~/.local/share/dsh-bin/dsh ~/.local/bin/dsh
dsh --version
```

The directory must stay writable by you, because `dsh update` and `dsh install` add versions next to the installed ones.

On Alpine and other musl systems, install `libstdc++` and `libgcc` first (`apk add libstdc++ libgcc`).

### Targets

| OS | Targets |
|---|---|
| Linux (glibc) | `linux-x64-modern`, `linux-x64-baseline`, `linux-arm64` |
| Linux (musl, e.g. Alpine) | `linux-x64-musl-modern`, `linux-x64-musl-baseline`, `linux-arm64-musl` |
| macOS | `darwin-arm64`, `darwin-x64-modern`, `darwin-x64-baseline` |
| Windows | `windows-x64-modern`, `windows-x64-baseline`, `windows-arm64` |

`modern` needs a CPU with AVX2; `baseline` runs on older x64 CPUs.

## Scoop (Windows)

```powershell
$scoopRoot = (Resolve-Path (Join-Path (scoop prefix scoop) '..\..\..')).Path
git clone --branch scoop --single-branch https://github.com/xz-dev/dsh-bin.git (Join-Path $scoopRoot 'buckets\dsh-bin')
scoop install dsh-bin/dsh           # release channel (dsh-bin/dsh-live for the live channel)
scoop install dsh-bin/dsh-office    # optional: office addon
```

Scoop owns this install:

- `dsh update`, `dsh install` and `dsh uninstall` refuse and tell you to use `scoop update`;
- the version and addons are fixed by the package, so `--use` and `--addon` are refused;
- snapshots work as usual.

## Gentoo

`packaging/gentoo/dsh-bin-9999.ebuild.in` is filled in by `scripts/gentoo-ebuild.mjs` for each release. It installs the linux archive into `/usr/lib/dsh-bin` and links `/usr/bin/dsh`. With `USE=office` it also installs the pinned office addon. Portage owns this install, the same way Scoop does.

## Moving from the npm install

1. Install dsh-bin into `~/.local/share/dsh-bin` as in [Manual ZIP](#manual-zip), but keep the old wrapper first:

   ```sh
   mv ~/.local/bin/dsh ~/.local/bin/dsh.npm
   ln -s ~/.local/share/dsh-bin/dsh ~/.local/bin/dsh
   ```

2. Credentials and `cordis.patch.yml` settings need no changes.
3. Old plugin files are not moved over. In each `$DSH_HOME/profiles/<name>/`, delete `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `node_modules/`, `.plugin-manager/` and `cordis.yml`, and keep `cordis.patch.yml`. Then add plugins again with `dsh plugin --profile <name> add …`. They go into the first snapshot.
4. The launcher does not choose a default profile. Pass `--profile tui`, or keep a small wrapper that adds it.

To go back: `ln -sf ~/.local/bin/dsh.npm ~/.local/bin/dsh`. dsh-bin never touches the npm install.

## Uninstall

Remove the install directory and the link:

```sh
rm ~/.local/bin/dsh
rm -rf ~/.local/share/dsh-bin
```

This keeps your data in `$DSH_HOME` (default `~/.dsh`): profiles, settings, snapshots (`snapshots/`) and dsh-bin's selection (`dsh-bin/`). Delete those too if you no longer need them.

With Scoop, run `scoop uninstall dsh` (and `scoop uninstall dsh-office`).

To remove single versions instead of the whole install, see [Versions and updates](versions.md#remove-a-version).
