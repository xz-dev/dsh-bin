# dsh-bin

[English](README.md) | 简体中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的独立打包版，由 Zig 管理器和单独发布的 Bun 运行包组成。管理功能和已安装应用均不需要宿主 Node.js 或 Bun。

- **各自更新。** `dsh manager update` 安装运行包；`dsh manager self-update` 只更新管理器。
- **多版本并存。** 装新运行包不替换旧版本，可以单次选版，也可以保存默认选择。
- **插件快照。** 插件运行文件按运行包存入编号快照；共享配置、凭据和会话留在应用 home。
- **默认便携。** 管理器和相邻的 `dsh-bin/` 一起保存。停止会话后，可整体移到兼容平台上的新位置。

## 安装

**发布状态：** 新 manager/runtime 发布家族和仅含管理器的 Gentoo/Scoop 包尚未发布。现有 Releases 和 bucket 清单不是本文描述的新安装。以下步骤用于新制品发布后。

从 **`manager-v<semver>`** [发布](https://github.com/xz-dev/dsh-bin/releases)下载 `manager-<target>.zip`，对照 `manager-index.json` 校验大小和 SHA-256，再把其中唯一的 `dsh` 文件（Windows 为 `dsh.exe`）解压到自己拥有的目录。目标包括：`linux-x64`、`linux-arm64`、`darwin-x64`、`darwin-arm64`、`windows-x64`、`windows-arm64`。

将该目录加入 PATH，或直接调用文件。运行包的 libc/CPU 目标由管理器检测；不要把运行包 ZIP 当管理器下载。详见[安装、数据位置和卸载](desc/zh-CN/install.md)。

## 启动和管理

```sh
dsh                              # 普通首次启动在需要时自动安装运行包
dsh manager --help               # 原生管理命令，不需要先有运行包
dsh manager info                 # 安装模式、数据根和应用 home
dsh manager update               # 安装当前渠道最新运行包
dsh manager snapshot new --name before-change
dsh manager self-update          # 仅便携管理器；运行包和数据不变
dsh manager clean                # 离线清理缓存和残留，不删除用户数据
```

首次交互启动先询问 shell 补全，再检查或下载运行包；接受、拒绝都继续启动。非交互启动跳过询问，不消费应用 stdin。全新空安装默认使用 release 渠道；已有运行包可离线启动，不会隐式升级。

## 文档

- [安装、数据位置、托管包和卸载](desc/zh-CN/install.md)
- [版本和独立更新](desc/zh-CN/versions.md)
- [选择运行包、快照和 addon](desc/zh-CN/select.md)
- [插件快照](desc/zh-CN/snapshots.md)
- [Office addon](desc/zh-CN/office-addon.md)
- [Bash、Zsh、Fish 和 PowerShell 补全](desc/zh-CN/completion.md)
- [布局、发布身份、信任和开发](desc/zh-CN/how-it-works.md)

代码和脚本分别属于 [dsh-manager/](dsh-manager/) 或 [dsh-bun-build/](dsh-bun-build/)；共享文档放在 [desc/](desc/)，规划放在 [openspec/](openspec/)。

## 许可证

管理器、兼容层和打包脚本采用 [MIT](LICENSE)。DeepSeek Harness 和内嵌依赖保持各自许可证；office addon 包含 MPL-2.0 许可的 LibreOffice Kit。
