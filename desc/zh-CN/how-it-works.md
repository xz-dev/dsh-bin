# 布局、发布和开发

[README](../../README.zh-CN.md) · [English](../en/how-it-works.md)

## 两个独立产品

Zig 管理器拥有安装、选择、快照、addon、补全和 self-update，管理操作不运行 JavaScript。Bun 运行包包含上游 dsh、内嵌 Bun/pnpm、依赖和运行适配，不含管理器可执行文件或管理引擎。

两者通过版本化 manifest 和启动上下文配合。管理器启动前解析运行包、快照、home、addon；运行包只消费这些位置，应用内重启保留原上下文，不读取后来修改的默认选择。

## 便携布局

```text
installation/
  dsh                         Windows 为 dsh.exe
  dsh-bin/                    数据根
    .dsh-bin-data.json         拥有权标记
    bundles/<runtime-id>/     只读运行包
    addons/office/<addon-id>/  已安装 addon
    snapshots/<runtime>@<n>/  各 profile 插件运行文件
    home/                     默认应用 home
    cache/                    下载、Bun/transpiler/npm/pnpm 缓存
    state/                    选择、渠道、补全选择、锁
    tmp/                      安装/更新残留
```

托管包在可执行文件旁用 `.dsh-manager-install.json` 明确声明 Portage/Scoop 拥有权。没有标记就是便携模式，即使目录只读；未知或损坏标记会失败，不另选位置。[托管数据根与 DSH_HOME](install.md#数据放在哪里)将包内容和用户数据分开。

受控应用环境将已知缓存和临时文件指向数据根，不全局替换用户 HOME，也不是插件沙箱。工作区修改和用户配置的外部路径仍由用户负责。搬迁前停止会话，不承诺跨系统搬迁或运行中搬迁。

## 发布身份

独立生成的索引位于 `releases` 分支：

| 产品 | 身份 | 索引 |
|---|---|---|
| 管理器 | `manager-v<semver>` | `manager-index.json` |
| Release 运行包 | `runtime-v<upstream>-b<run>.<attempt>.g<sha8>` | `runtime-index.json` 的 release 渠道 |
| Live 运行包 | `runtime-live-<sha7>-b<run>.<attempt>.g<sha8>` | `runtime-index.json` 的 live 渠道 |
| Office addon | `addon-office-v<kit>-b<run>.<attempt>.g<sha8>` | `runtime-index.json` 的 office addons |

管理器资产为 `manager-<os>-<arch>.zip`，仅含一个可执行文件。运行包资产为 `runtime-<target>.zip`，归档根含 `bundle.json`、`dsh-native`、`app/`、`pnpm/`、`bin/`、固定 `completion.json` 和声明的缓存内容，不含管理器或外层安装树。Manifest 记录上游/构建身份及启动协议，不要求匹配管理器发行版本。

[管理器发布 CI](../../.github/workflows/manager-release.yml)只构建管理器；[运行包发布 CI](../../.github/workflows/runtime-release.yml)只构建运行包。组合门禁消费固定的另一方制品，不重编它。Dry-run 不发布；[CI 入口](../../.github/workflows/ci.yml)提供手动 `release_dry_run` 调用，硬编码关闭发布。公开发布等待发布门禁，以及需要时兼容 addon 就绪。GitHub 全局 Latest 不是发现协议。

## 完整性和失败边界

管理器下载校验索引身份、大小、SHA-256，再验证归档路径、required content 和启动兼容性。链接或穿越不能授权写出所属目标范围。验证完成后才激活候选；失败不静默改选、不接管无关数据。

运行包由精确上游 commit 和 frozen lockfile 构建，内嵌 pnpm 校验值固定，第三方内容遵循 lockfile integrity。公开发布资产带构建来源证明，可用 `gh attestation verify <file> --repo xz-dev/dsh-bin` 校验；来源证明不能替代原生平台和组合验收。

更新使用同卷暂存和核对后的替换；处理进程中断，不承诺断电持久性。Clean 保留未知文件和有效数据，不猜测拥有权。锁竞争给明确 busy/retry 诊断，不启动后台恢复服务。见[版本和清理](versions.md)。

## 应用限制

运行适配保留上游命令，但不是完全未修改的 Node.js 构建。依赖 Node 内部机制的 hot reload（`@deepseek-ai/dsh-hmr`）不可用；office 插件需要兼容 [office addon](office-addon.md)。插件安装归应用，在所选[快照](snapshots.md)中写入；管理器不自动修复依赖。

补全描述固定上游 CLI，不含运行时动态插件命令。占用保护覆盖受管理 runtime 及重启，不追踪全部孤立子进程。显式外部 home 或插件外部路径不在便携保证内。仅接受新格式、受支持启动协议的运行包。

## 开发归属

```text
repo/
  dsh-manager/    Zig 源码、build.zig、管理器测试、发布/包脚本
  dsh-bun-build/  Bun 运行适配、上游构建脚本、运行包测试
  desc/          中英文共享文档、历史实现报告
  openspec/      需求和变更计划
  .github/       CI 和发布流程
```

管理器使用 Zig 0.15.2，不需要 Bun 或上游源码：

```sh
cd dsh-manager
zig build
zig build test
```

运行包工具使用 Bun 1.4.2 和上游构建前置依赖，不需要编译管理器：

```sh
cd dsh-bun-build
bun install
bun test ./test/unit ./test/runtime
bun scripts/build-target.mjs <target> <release|live> <ref> <out> --run 1 --attempt 1 --index <runtime-index.json>
```

组合验证使用隔离 HOME/数据根和实际制品；交叉编译证明能构建，不等于原生运行验收。[实现报告](../IMPLEMENTATION-REPORT.md)原样保留历史，不是当前安装说明。
