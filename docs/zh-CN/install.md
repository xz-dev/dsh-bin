# 安装和卸载

[README](../../README.zh-CN.md) · [English](../en/install.md)

## 脚本（Linux、macOS）

```sh
curl -fsSL https://raw.githubusercontent.com/xz-dev/dsh-bin/main/install.sh | sh
```

[`install.sh`](../../install.sh) 执行的就是[手动解压 ZIP](#手动解压-zip) 的步骤，装到相同的目录。它额外做三件事：

- 按你的系统、CPU 和 libc 选好目标；
- 从 Latest release（release 通道）下载；
- 用该 release 的 `SHA256SUMS` 校验。

如果 `~/.local/share/dsh-bin` 里已经有安装，或者 `~/.local/bin/dsh` 已存在，它会直接停止，不做任何改动。想自己指定目标，设置 `DSH_BIN_TARGET=<target>`。

## 手动解压 ZIP

从 [release](https://github.com/xz-dev/dsh-bin/releases) 下载 `dsh-<target>.zip`，解压到你自己有写权限的目录，再把其中的 `dsh` 放进 `PATH`：

```sh
mkdir -p ~/.local/share/dsh-bin
unzip dsh-linux-x64-modern.zip -d ~/.local/share/dsh-bin
ln -s ~/.local/share/dsh-bin/dsh ~/.local/bin/dsh
dsh --version
```

这个目录必须保持可写，因为 `dsh update` 和 `dsh install` 会把新版本装在已有版本旁边。

在 Alpine 等 musl 系统上，先安装 `libstdc++` 和 `libgcc`（`apk add libstdc++ libgcc`）。

### 目标

| 系统 | 目标 |
|---|---|
| Linux（glibc） | `linux-x64-modern`、`linux-x64-baseline`、`linux-arm64` |
| Linux（musl，如 Alpine） | `linux-x64-musl-modern`、`linux-x64-musl-baseline`、`linux-arm64-musl` |
| macOS | `darwin-arm64`、`darwin-x64-modern`、`darwin-x64-baseline` |
| Windows | `windows-x64-modern`、`windows-x64-baseline`、`windows-arm64` |

`modern` 需要支持 AVX2 的 CPU；`baseline` 可以在较老的 x64 CPU 上运行。

## Scoop（Windows）

```powershell
$scoopRoot = (Resolve-Path (Join-Path (scoop prefix scoop) '..\..\..')).Path
git clone --branch scoop --single-branch https://github.com/xz-dev/dsh-bin.git (Join-Path $scoopRoot 'buckets\dsh-bin')
scoop install dsh-bin/dsh           # release 通道（live 通道用 dsh-bin/dsh-live）
scoop install dsh-bin/dsh-office    # 可选：office 附加组件
```

这种安装由 Scoop 管理：

- `dsh update`、`dsh install` 和 `dsh uninstall` 会拒绝执行，并提示改用 `scoop update`；
- 版本和附加组件由包固定，所以 `--use` 和 `--addon` 会被拒绝；
- 快照照常可用。

## Gentoo

`scripts/gentoo-ebuild.mjs` 会为每个 release 填写 `packaging/gentoo/dsh-bin-9999.ebuild.in`。它把 linux 压缩包装到 `/usr/lib/dsh-bin`，并链接 `/usr/bin/dsh`。开启 `USE=office` 时还会安装固定版本的 office 附加组件。这种安装和 Scoop 一样，由 Portage 管理。

## 从 npm 安装迁移

1. 按[手动解压 ZIP](#手动解压-zip) 把 dsh-bin 装到 `~/.local/share/dsh-bin`，但先保留旧的包装器：

   ```sh
   mv ~/.local/bin/dsh ~/.local/bin/dsh.npm
   ln -s ~/.local/share/dsh-bin/dsh ~/.local/bin/dsh
   ```

2. 凭据和 `cordis.patch.yml` 设置不用改。
3. 旧的插件文件不会迁移过来。在每个 `$DSH_HOME/profiles/<name>/` 里删除 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`node_modules/`、`.plugin-manager/` 和 `cordis.yml`，保留 `cordis.patch.yml`。然后用 `dsh plugin --profile <name> add …` 重新添加插件，它们会进入第一个快照。
4. 启动器不会选择默认 profile。要传 `--profile tui`，或者保留一个自动加上它的小包装脚本。

想退回去：`ln -sf ~/.local/bin/dsh.npm ~/.local/bin/dsh`。dsh-bin 从不碰 npm 安装。

## 卸载

删除安装目录和链接：

```sh
rm ~/.local/bin/dsh
rm -rf ~/.local/share/dsh-bin
```

这样会保留你在 `$DSH_HOME`（默认 `~/.dsh`）里的数据：profile、设置、快照（`snapshots/`）和 dsh-bin 的选择（`dsh-bin/`）。不再需要的话也可以删掉。

用 Scoop 安装的，运行 `scoop uninstall dsh`（以及 `scoop uninstall dsh-office`）。

只想删除某几个版本而不是整个安装，见[版本和更新](versions.md#删除版本)。
