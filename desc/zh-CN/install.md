# 安装、数据位置和卸载

[README](../../README.zh-CN.md) · [English](../en/install.md)

## 下载单个管理器

1. 在 [Releases 页面](https://github.com/xz-dev/dsh-bin/releases)选择 `manager-v<semver>` 发布。不要用仓库全局 Latest 标签判断运行包版本。
2. 按系统和 CPU 下载资产：

   | 平台 | 管理器 ZIP |
   |---|---|
   | Linux x64 / ARM64 | `manager-linux-x64.zip` / `manager-linux-arm64.zip` |
   | macOS Intel / Apple Silicon | `manager-darwin-x64.zip` / `manager-darwin-arm64.zip` |
   | Windows x64 / ARM64 | `manager-windows-x64.zip` / `manager-windows-arm64.zip` |

3. 对照仓库 `releases` 分支的 `manager-index.json` 中对应版本、目标的大小与 SHA-256 校验 ZIP。发布同时提供 `SHA256SUMS`；需要构建来源验证时使用 `gh attestation verify <zip> --repo xz-dev/dsh-bin`。
4. 将 ZIP 中唯一的 `dsh`（Windows 为 `dsh.exe`）解压到自己拥有的目录。如果解压工具没有保留执行权限，Linux/macOS 用户需赋予执行权限。不需要 Node.js、Bun 或根安装脚本。

下载并校验 Linux x64 管理器 ZIP 后：

```sh
mkdir -p "$HOME/tools/dsh"
unzip manager-linux-x64.zip -d "$HOME/tools/dsh"
chmod +x "$HOME/tools/dsh/dsh"
export PATH="$HOME/tools/dsh:$PATH"
dsh manager info
dsh --help
```

是否永久加入 PATH 或建立稳定符号链接由你决定，管理器不会自动建立入口。Linux 管理器是静态程序；libc/AVX2 选择属于单独的运行包下载。Alpine 运行包仍需 `libstdc++` 和 `libgcc`（`apk add libstdc++ libgcc`）。

## 普通首次启动

```sh
dsh
```

交互终端中，管理器先展示 shell 补全目标并询问同意。拒绝或注册失败不阻断启动。随后检查运行包：没有固定或显式选择的空安装，会安装记录渠道的最新兼容运行包（新安装默认 release），再按原参数和工作目录启动，不替你选择 profile。

非交互启动跳过询问，stdin 留给应用，必要时仍安装运行包；下次交互启动还可询问。已有安装离线启动所选运行包；显式版本缺失或运行包损坏会给出修复说明，不下载其他版本替代。[帮助和原生管理命令](versions.md)不进入该自举流程。

## 数据放在哪里

```sh
dsh manager info
```

| 安装方式 | 数据根 |
|---|---|
| 普通单文件下载 | **真实可执行文件**旁的 `dsh-bin/` |
| Gentoo / Portage | 绝对 `$XDG_DATA_HOME/dsh-bin`，否则 `~/.local/share/dsh-bin` |
| Scoop | `%LOCALAPPDATA%\dsh-bin` |

符号链接位置和当前工作目录不改变数据根。便携目录必须可写；失败时点明路径，不改用 HOME，也不要求管理员权限。非空、无关的同名 `dsh-bin` 目录会报冲突，不自动接管。

数据根包含运行包、addon、插件和配置快照、状态、缓存、临时文件，以及默认应用 home（`dsh-bin/home`）。非空白 `DSH_HOME` 只改变应用 home 及会话等非配置状态，不移动 P/C，不导入旧 home 设置，也不授权读取 home 凭据。空值或纯空白采用默认 home；`~` 展开为用户家目录，相对值按原调用工作目录解析。运行包、两类快照和管理缓存仍在数据根。外部 `DSH_HOME` 不在整体搬迁保证内。

搬迁前停止会话，将管理器和**完整 `dsh-bin/` 目录**一起移动，目标平台必须兼容。只移动管理器会成为新的独立安装。用户指定的外部路径不会自动复制或改写。

## 不启动应用查询路径

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

省略库存目标可列出本地条目；`path snapshot` 同时列出两类。总览说明可执行文件、数据根、home、路径来源及有效运行包/P/C/addon 选择。它不创建缺失目录或快照、不自举运行包、不获取操作锁、不注册补全、不启动子进程、不联网，也不读取配置或凭据正文。独立项目 `.env` 和继承环境变量保持上游语义，查询不会枚举秘密后端。

JSON 包含 `schemaVersion: 1`、`complete`、`records`、`effective` 和 `diagnostics`。缺少默认项时，库存查询可以完整而选择未解析，不会创建快照填补空缺。显式目标不存在或歧义、非法类型、不可访问或冲突的存储，均非零退出并给诊断，不静默回退 latest。旧补全注册没有记录位置时报告 unknown，不读取 shell rc 猜测。

## 托管包

这些包只安装管理器、拥有权标记和入口/shim，**不捆绑运行包或 addon**。

### Gentoo

配置的 overlay 已提供该包时：

```sh
emerge --ask app-misc/dsh-bin
emerge --ask --update app-misc/dsh-bin
```

管理器包安装到 `/usr/lib/dsh-bin`，入口为 `/usr/bin/dsh`。用户数据采用上表中的 Gentoo 位置。[Ebuild 模板](../../dsh-manager/packaging/gentoo/dsh-bin-9999.ebuild.in)属于管理器项目。

### Scoop

bucket 位于本仓库的 `scoop` 分支：

```powershell
$scoopRoot = (Resolve-Path (Join-Path (scoop prefix scoop) '..\..\..')).Path
git clone --branch scoop --single-branch https://github.com/xz-dev/dsh-bin.git (Join-Path $scoopRoot 'buckets\dsh-bin')
scoop install dsh-bin/dsh
scoop update dsh
```

新体系没有单独的 `dsh-live` 或 `dsh-office` 包；通过管理命令选择运行包渠道、安装 addon。

两种托管模式都允许用户管理运行包安装/更新/卸载、选择、快照和 addon。`dsh manager self-update` 在**下载前**拒绝，并提示包管理器更新命令。包升级不改变用户数据根。

## 卸载

只移除运行包，见[版本文档](versions.md#移除运行包)。解除固定后可以卸载全部闲置运行包，快照和应用 home 保留。

便携安装先停止会话，按需[撤销补全](completion.md#撤销注册)，再只删除管理器文件和自己建立的 PATH 链接；相邻数据根保持不变。

托管包：

```sh
emerge --ask --unmerge app-misc/dsh-bin
```

```powershell
scoop uninstall dsh
```

两者均保留用户运行包、快照、配置、凭据和会话。补全注册是独立的用户状态，不再需要时应在删除管理器前撤销。

删除数据根是另一项破坏性操作：会删除运行包、两类快照（包括 C 内本地凭据）及**默认**应用 home 中的会话。先备份并核对路径。显式外部 `DSH_HOME` 不随数据根删除。`manager clean` 不是卸载或擦除用户数据的命令。
