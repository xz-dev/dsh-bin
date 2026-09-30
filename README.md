# dsh-bin

English | [简体中文](README.zh-CN.md)

A standalone build of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). It needs no Node.js, keeps several dsh versions installed side by side, and saves your plugins in snapshots you can roll back to.

## Why

dsh changes fast. A new release candidate comes out every few days, and a plugin that works on one version may not load on the next. The npm install gives you one version at a time, and every version uses the same plugin files. After a bad upgrade, getting back to a setup that worked means reinstalling and rebuilding your plugins by hand.

dsh-bin makes an upgrade something you can undo:

- **No Node.js.** Each version ships with its own Bun runtime and pnpm. `dsh plugin add` works on a machine with no JavaScript runtime.
- **Versions side by side.** `dsh update` adds the new version and keeps the old ones. `dsh --use <version>` starts any installed version.
- **Plugin snapshots.** Plugins are stored per version in numbered snapshots, and a new version starts from a copy of the last one. If a plugin change breaks something, remove the snapshot and you are back.
- **Same dsh.** It is built from upstream source without changes. Your profiles, credentials and settings stay as they are.

It borrows the container model (a read-only image with its own runtime, a separate writable layer, images kept side by side) without a container: one small launcher and a few directories. It also starts a little faster than the npm install: 304–321 ms against 361 ms for a warm profile boot on Linux x64.

## Install

**Linux, macOS**

```sh
curl -fsSL https://raw.githubusercontent.com/xz-dev/dsh-bin/main/install.sh | sh
```

The script picks the build for your system, checks its SHA-256, and runs the same steps as the [manual install](docs/en/install.md#manual-zip). On Alpine, run `apk add libstdc++ libgcc` first.

**Windows (Scoop)**

```powershell
$scoopRoot = (Resolve-Path (Join-Path (scoop prefix scoop) '..\..\..')).Path
git clone --branch scoop --single-branch https://github.com/xz-dev/dsh-bin.git (Join-Path $scoopRoot 'buckets\dsh-bin')
scoop install dsh-bin/dsh
```

Manual ZIP, Gentoo, and moving from the npm install: see [Install](docs/en/install.md).

## Quick start

```sh
dsh --profile tui          # start dsh
dsh update                 # install the newest version next to the current one
dsh snapshot new           # save your plugins before changing them
dsh snapshot remove <id>   # the change broke something: go back to the previous snapshot
dsh --use 0.1.7-rc.2       # run an older installed version
```

## Documentation

- [Install and uninstall](docs/en/install.md)
- [Versions and updates](docs/en/versions.md)
- [Plugin snapshots](docs/en/snapshots.md)
- [Choosing what `dsh` starts](docs/en/select.md)
- [Office addon](docs/en/office-addon.md)
- [How it works](docs/en/how-it-works.md): channels, trust model, startup, limitations

## License

The packaging (launcher, compat layer, scripts) is [MIT](LICENSE). The bundled DeepSeek Harness and its dependencies keep their own licenses; the office addon ships LibreOffice Kit under MPL-2.0.
