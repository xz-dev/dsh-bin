## Why

现有 Zig launcher 仍必须启动某个 dsh bundle 内的 TypeScript 管理代码，管理器修复与运行包重新发布绑定，甚至无法在没有可用 dsh 时安装或修复 dsh。下载版本、快照、应用数据和缓存又分散在不同位置，无法满足用户只下载一个管理器、按自身目录存放数据、整体搬迁的需求。

## What Changes

- **BREAKING**：拆为独立版本与发布产物的纯 Zig 管理器 `dsh-manager/` 和 Bun 运行包构建项目 `dsh-bun-build/`。根保留 `desc/`、`openspec/`、仓库入口文档及 `.github/`；不保留根级通用 `scripts/` 或安装脚本。
- **BREAKING**：管理命令归入 `dsh manager …`；`manager update` 更新 dsh，`manager self-update` 只更新管理器。保留现有前置 `--use/--snapshot/--addon` 的单次运行选择语义，应用参数继续交给 dsh。
- 管理器无需任何 dsh、Node 或 Bun 即可管理安装。运行包只保留上游应用、内嵌 Bun/pnpm、必要适配和启动协议，不含管理器及管理引擎。
- 允许解除固定选择后卸载全部闲置 dsh 运行包；保留管理器、快照、选择记录、配置、凭据与会话，重装后继续使用已有数据，不自动清理用户数据。
- **BREAKING**：普通下载的管理器以真实可执行文件所在目录的 `dsh-bin/` 为数据根，集中运行包、快照、addon、默认应用配置/凭据/会话、缓存和临时文件。尊重用户显式 `DSH_HOME`，但不承诺外部应用数据随安装目录搬迁。
- 首次普通交互启动先询问是否注册 shell 补全，再检查已安装运行包；全新空安装自动下载最新 release 并启动。非交互不等待询问；已有安装不隐式升级。
- 提供 Bash、Zsh、Fish、PowerShell 补全生成与用户级注册/撤销。Tab 查询只读、离线、不引导安装、不执行应用或插件。
- **BREAKING**：Gentoo/Scoop 仅托管管理器。托管模式采用明确的用户数据根，禁用管理器自更新，但保留用户对 dsh、addon、快照的管理能力。
- **BREAKING**：只支持新格式运行包；需要历史 dsh 时重新构建对应上游版本。不实现旧 bundle 兼容、数据自动迁移或迁移指南，不修改用户现有安装与凭据。
- 新制品验收通过后执行一次旧发布清理：清除确认清单中的全部旧 GitHub Releases 及资产，替换旧发现索引与包清单，避免继续引导用户下载旧架构；不因此删除 Git 历史、标签或用户本地数据。
- 使用 BDD 明确外部行为，以真实管理器进程、真实 shell、受控发行源和真实 Bun 运行包的 E2E 驱动纵向实现。

## Capabilities

### New Capabilities

当前本地 `openspec/specs/` 没有可复用的主规格；以下是新规划根下的能力定义，不表示所有行为均首次实现。

- `manager-control`: 独立管理命令、自更新、版本选择、快照和 addon 生命周期、运行状态保护。
- `portable-storage`: 自定位便携数据、显式应用 home、托管安装数据根与整目录搬迁。
- `first-run-bootstrap`: 补全询问顺序、空安装自动下载 release、非交互及恢复行为。
- `shell-completion`: 四种 shell 的安全只读候选查询、用户级注册和撤销。
- `runtime-bundles`: 无管理引擎的 Bun 运行包、版本化启动协议、应用路径与重启适配。
- `distribution-lifecycle`: 两条独立发布线、完整性验证、Gentoo/Scoop 管理器包及旧发布切换清理。
- `repository-layout`: 两个可独立构建的业务目录、根文档与 OpenSpec、按归属放置脚本和验收测试。

### Modified Capabilities

无。本地规划根刚建立；历史报告中提到的外部归档当前不可用，不伪造已有主规格或对它们生成 MODIFIED delta。

## Impact

- 当前 `launcher/src/{main,select}.zig` 是管理器基础；`runtime/update/`、`runtime/snapshot/`、`runtime/selection.ts`、存储/下载/锁逻辑中的管理策略迁入 Zig。
- 当前 `runtime/app.ts`、`runtime/compat/`、`scripts/transform-app.mjs` 保留必要运行适配但移除选择、创建快照及更新策略；修正共享配置路径对旧目录层级的依赖。
- `scripts/local-build.mjs`、`assemble-bundle.mjs`、`compile-entry.mjs`、版本身份、索引、发布、上游轮询和 CI 必须拆开，运行包不能再携带或替换 launcher。
- `install.sh`、Gentoo 模板、Scoop 生成器与历史包清单调整到新的管理器分发方式；当前 Linux/macOS/Windows 和运行包 target 覆盖不因拆分静默缩减。
- 文档移至根 `desc/`，README 保留入口；现有 launcher、runtime、update-contract、packaged E2E 的有意义行为迁移至所属项目。
- 本变更当前只创建规划文件。实际目录重组、代码、构建、shell 注册、发布及不可逆清理均等待 apply 阶段；远程破坏性操作在精确清单确认后执行。
