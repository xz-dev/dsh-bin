# dsh-bin

[English](README.md) | 简体中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的独立打包版。不需要 Node.js，可以同时装多个 dsh 版本，插件存在快照里，随时能退回去。

## 为什么做这个

dsh 变化很快，几天就出一个 RC，这个版本能用的插件，到下个版本可能就加载不了。npm 安装一次只能有一个版本，所有版本还共用同一份插件文件。升级出了问题，想回到之前能用的状态，只能重装、再手动把插件装一遍。

dsh-bin 让升级可以撤回：

- **不需要 Node.js。** 每个版本自带 Bun 运行时和 pnpm，没装任何 JavaScript 运行时的机器上也能 `dsh plugin add`。
- **多版本并存。** `dsh update` 装新版本，旧版本留着。`dsh --use <版本>` 可以启动任意已安装的版本。
- **插件快照。** 插件按版本存在编号快照里，新版本从上一个快照复制一份开始。改插件改坏了，删掉这个快照就回去了。
- **还是原来的 dsh。** 直接用上游源码构建，不做修改。profile、凭据和设置都不用动。

思路借用了容器（只读镜像自带运行时、可写层单独放、多个镜像并存），但不需要容器，只是一个小启动器加几个目录。启动也比 npm 安装稍快：Linux x64 上 profile 热启动 304–321 ms，npm 版是 361 ms。

## 安装

**Linux、macOS**

```sh
curl -fsSL https://raw.githubusercontent.com/xz-dev/dsh-bin/main/install.sh | sh
```

脚本会选好适合你系统的构建，校验 SHA-256，然后执行和[手动安装](docs/zh-CN/install.md#手动解压-zip)完全一样的步骤。Alpine 上先运行 `apk add libstdc++ libgcc`。

**Windows（Scoop）**

```powershell
$scoopRoot = (Resolve-Path (Join-Path (scoop prefix scoop) '..\..\..')).Path
git clone --branch scoop --single-branch https://github.com/xz-dev/dsh-bin.git (Join-Path $scoopRoot 'buckets\dsh-bin')
scoop install dsh-bin/dsh
```

手动解压、Gentoo、从 npm 安装迁移：见[安装](docs/zh-CN/install.md)。

## 快速上手

```sh
dsh --profile tui          # 启动 dsh
dsh update                 # 把最新版本装在当前版本旁边
dsh snapshot new           # 改插件之前先存一份
dsh snapshot remove <id>   # 改坏了：退回上一个快照
dsh --use 0.1.7-rc.2       # 运行已安装的旧版本
```

## 文档

- [安装和卸载](docs/zh-CN/install.md)
- [版本和更新](docs/zh-CN/versions.md)
- [插件快照](docs/zh-CN/snapshots.md)
- [选择 `dsh` 启动什么](docs/zh-CN/select.md)
- [office 附加组件](docs/zh-CN/office-addon.md)
- [工作原理](docs/zh-CN/how-it-works.md)：通道、信任模型、启动、限制

## 许可证

打包部分（启动器、兼容层、脚本）采用 [MIT](LICENSE)。打包进来的 DeepSeek Harness 及其依赖保持各自的许可证；office 附加组件附带的 LibreOffice Kit 采用 MPL-2.0。
