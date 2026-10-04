## Why

Bun 1.4.2 已有原生 FreeBSD 发行资产，真实 FreeBSD 15.0/amd64 探针也证明单文件运行、内嵌 pnpm 和文件锁基础可用；但当前 dsh 的平台选择、会话锁加载器、终端检查及发行闭包还没有贯通。需要独立的完整支持变更，避免把“能编译／显示版本”误报为可用产品。

## What Changes

- 为 FreeBSD 15.x 的 amd64、ARM64 同时交付原生 Zig 管理器、dsh 运行包和所需 addon，使用明确的 `freebsd-x64`、`freebsd-arm64` 目标，不依赖 Linuxulator。
- 两种架构首版均覆盖完整管理命令与应用 CLI、真实 profile、会话保存／恢复、终端执行与取消、文件搜索、插件安装／运行，以及 Office addon。不得把 ARM64、Office 或插件功能留成首版占位。
- 保留纯 Zig 管理器源码，允许链接 FreeBSD 自带系统库；用户侧不需要系统 Node/Bun、构建工具或第三方 JS runtime。最低 ABI 设为 FreeBSD 15.1，正式支持以发布时受维护且已验收的 15.x 为准，14.x／其他架构不在本变更范围。
- 适配 FreeBSD 原生 flock 包、PTY 和进程检查、ripgrep、固定版本 pnpm 的 JS 闭包及 Office WASM 平台解析。保持已固定依赖版本和源代码身份，不因缺少 FreeBSD 发行包擅自升级依赖。
- 修正已实测的 host target 缺口及 no-follow `EMLINK` 错误分类，继续保护解包、快照、凭据与活动对象，不能通过禁用锁、跟随链接或移除测试来通过验收。
- 保持既有便携布局、显式 DSH_HOME、两类独立快照、八类只读 path、shell 补全和独立 self-update；FreeBSD 平台差异不得改变这些产品规则。
- 将两种架构的真实 FreeBSD、普通用户、受控源和完整真实制品 E2E 纳入发布门禁，保留既有 Linux/macOS/Windows 覆盖；失败不得发布部分功能的 FreeBSD 资产或伪造兼容索引。

## Capabilities

### New Capabilities

- `freebsd-support`：FreeBSD 15.x 双架构原生支持、完整产品链路、原生依赖与系统库边界、安全路径错误处理以及普通用户验收。

### Modified Capabilities

`split-dsh-manager` 已验收归档，其主规格可作为核对来源；以下增量仍依赖 `add-config-snapshots-and-paths` 的最终交付。实施／同步前必须逐块核对已归档或已接受的完整基线，不能用 FreeBSD 扩展覆盖双快照要求。

- `runtime-bundles`：以 `add-config-snapshots-and-paths` 对前置要求的完整修订为基线，扩展 FreeBSD 最低 ABI、目标身份和原生依赖校验，不丢失双快照协议保护。
- `distribution-lifecycle`：以前置 `split-dsh-manager` 的同名规格为基线，将 FreeBSD 双架构及 addon／插件完整链路加入真实制品发布门禁。

## Impact

- 依赖：`split-dsh-manager` 的独立产品、索引、安装与保护体系，以及 `add-config-snapshots-and-paths` 的双快照／path 契约。`split-dsh-manager` 已归档，config/path 仍在实施／待最终验收；本变更不修改它们的文件。最终集成与发布验收须以前置交付为基础，不能用 FreeBSD 适配覆盖其要求。
- 管理器：`dsh-manager/src/target.zig`、`zip.zig` 及共享安全路径层，平台 ABI 检查、安装／self-update 和 FreeBSD 黑盒测试。
- 构建与运行适配：`dsh-bun-build/scripts/` 的 targets、compile-entry、fetch-pnpm、build-app、assemble-bundle、addon 和发行流程；runtime 薄适配；固定上游源码的可审核平台补丁与原生 package 构建。
- CI／文档：真实 FreeBSD VM 双架构构建与普通用户验收、下载入口、平台支持说明和与既有目标的回归。
- 历史实测依据见 `feasibility.md`，只覆盖 FreeBSD 15.0/amd64 初步探针，不替代实施期 evidence。2026-10-04 的双架构普通用户原生调查确认：15.0 缺少目录 no-replace 发布原语，15.1 的 `renameat2(AT_RENAME_NOREPLACE)` 正负例通过；用户据此批准最低版本改为 15.1，完整产品门禁仍未完成。
- 不包括新增 pkg/ports 包、系统服务、FreeBSD 14.x、Linuxulator 路线、任意第三方插件的无条件兼容承诺、全新 sandbox 架构，以及公开发布产品、旧 release 删除或测试机升级／清理。后续用户已单独授权实施、提交、推送和 CI；这些授权不等于公开发布许可。
