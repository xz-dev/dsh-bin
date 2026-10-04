# 实施证据

## 当前结论

这是 `add-config-snapshots-and-paths` 的实施期记录，不是完整验收。首个 store 候选为 `4dfbbf1e9787598982936618f98aae7322f31459`，父进程补全安全与耦合回归修复为 `abefea6d377d909fb276a365c6fdb27a0b741fc3`。协议 2、真实 rc.2 配置 I/O 和八类 path 已整合为固定候选 `6ae48b28200e7b25be44af6f447795cb04ad3672`，原四项协议发现已独立定点 Closed（仅 Linux transport）。不同真实运行包 A→B→A、Windows 当前 ACL／原生平台、完整真实产品与 I/O/path 独立审查仍未验收；后一审查及 A→B→A worker 遭提供方策略拒绝，未记为批准。不能根据此记录发布、合并、同步或归档。

## 前置与保留场景核对

前置 `split-dsh-manager` 已验收并归档，main 基线为 `5b3ed0fec0cbb6832cfa1b216f0cecc11d33e791`。manager-control、portable-storage、runtime-bundles 的 11 个 MODIFIED requirement 目标均存在，19 个前置场景标题全部保留。机器核对记录：`/var/tmp/dsh-remaining/parent-gates/config-modified-retention.json`。严格校验 `openspec validate add-config-snapshots-and-paths --strict --no-interactive` exit 0，日志 `config-strict-abefea6.log`（同目录）。

已核对接口：数据所有权标记 `.dsh-bin-data.json` 为 kind=dsh-manager-data/schema=1；context 区分真实 executable、管理 data 与应用 home；选择来自 `state/selection.json`，维护锁为 `state/manager.lock`；两类 store 的 root、`.counters.json`、`.lock` 和对象 `.usage.lock` 独立。旧有效插件 metadata 不要求新增 kind 字段，旧选择缺失 configSnapshot 仍可读取。completion 前置记录未保存历史目标路径，后续查询必须报告 unknown 而非猜测。56 个增量场景的完整测试映射尚未交付，任务 1.2 不计完成。

## Store 首切片与父回归

所有父检查使用隔离 HOME `/var/tmp/dsh-remaining/parent-gates/home`、TMPDIR/TEMP/TMP `/var/tmp/dsh-remaining/parent-tmp`、Zig cache `/var/tmp/dsh-remaining/parent-zig-cache`，不使用实际用户配置。以下日志均位于 `/var/tmp/dsh-remaining/parent-gates/`。

| 检查 | 实际结果 | 日志 |
| --- | --- | --- |
| 固定 4dfbbf1 七文件 targeted | exit 0；114 pass / 5 skip / 0 fail | targeted-4dfbbf1.log |
| 固定 4dfbbf1 完整 manager suite | exit 1；240 pass / 46 skip / 25 fail | manager-full-4dfbbf1.log |
| 补全字面量与链接 metadata 新回归，修复前 | exit 1；0 pass / 2 fail，实际断言失败 | completion-regression-red.log |
| 同两项，最小修复后 | exit 0；2 pass / 0 fail | completion-regression-green.log |
| 真实 shell 搬迁／插入回归 | exit 0；9 pass / 23 skip / 0 fail | completion-shell-green.log |
| 父修复完整 `bun test dsh-manager/test` | exit 0；267 pass / 46 skip / 0 fail，313 tests / 25 files | manager-full-followup.log |
| `zig build test`（dsh-manager） | exit 0 | unit-followup.log |
| `zig fmt --check src/completion.zig src/snapshot.zig` | exit 0 | format-followup.log |
| `zig build -Dtarget=x86_64-windows --prefix /var/tmp/dsh-remaining/parent-windows-prefix` | exit 0，仅交叉编译 | windows-cross-followup.log |

首次修复后两项重跑被测试默认 5000ms 的冷编译期限中断，不计 green；随后仅给新用例同现有冷构建用例的 120000ms 期限，断言未变。首轮超时文本保存在父会话工具记录，成功复跑见上述 green 日志。

父修复迁移直接耦合正例的类型参数与有效数字 ID／metadata 夹具，保留 CANARY、真实 Tab 插入、搬迁、hash、来源独立与负例。复用已有 localWord 保留字面量；复用 manager_binary.openRegular 对补全及 store metadata 做 no-follow 读取。self-update 的保护字节集合增加实际配置快照和专用假凭据。46 个 skip 包括不可用 shell、原生 Windows DACL／映像／Scoop、缺少真实运行包／Office／组合产物等，不是这些门禁通过。

## 独立审查及未解决项

审查器 `286f16fc-c46e-4614-b481-a6da23a8dec3` 在 2400000ms 超时、报告缺失；其 worktree/index 干净，现场保存在 `/var/tmp/dsh-remaining/recovery-store-review/`。原失败不改记为批准。沿原会话恢复为 `f9e3f466-1161-44ba-843e-ede0a3e01e69` 后，审查冻结 abefea6 完成，报告 `/var/tmp/dsh-remaining/reports/store-review-abefea6.md`，结论 **changes required**。

审查独立探针 `/var/tmp/dsh-store-independent-review/review-probes-abefea6.py` 与日志 `logs/independent-probes-abefea6.log` 确认：

1. P1：config 删除预检后同名目录被替换，未核对目标目录身份，替换目录及哨兵被删除。
2. P1：较早文件完成单文件 hash 检查后，在后续复制暂停时被篡改，最终发布成功且来源保持不变；不是已接受的最终检查到单 syscall 窗口。
3. P2：递归 basename 排除将 `profiles/cache/cordis.patch.yml` 等合法 profile 一并丢弃。

后继修复 `99ced445ea971d3a3712d4a5e2d8d05658454ee7` 只改 snapshot.zig／snapshots.test.ts。baseline 新回归实际 0 pass / 9 fail；最终 11 pass / 0 fail。父完整 manager suite exit0（325 tests）与 Zig 50/50；日志 `store-safety-99ced445/`。原 reviewer 定点复审运行 `6acf9476` 逐项重跑原复现及11个回归、10个交互，三项均 Closed，无该范围剩余 P0/P1/P2。报告 `/var/tmp/dsh-remaining/reports/store-rereview-99ced445.md`，结论 approved with explicit residual risks，仅针对三项修复。原生 Windows及整体 change 门禁仍待完成。

最终 identity-check-to-single-syscall 窗口、断电持久性与已经 hash 认证输入的前置边界保持不变；不引入全局业务事务或快照冻结框架。

## 双选择与协议 2 的整合检查

独立协议 worktree 从48c0557交付 `2652273936c93aeaf5c5c879f81fd006dee777a2`；父 cherry-pick 与修复联合为 `041bd977253b435ed1fc0063b87b094b284a46d5`，仅 snapshots.test.ts 机械重叠自动合并，安全回归保留。协议原 red 实际证明 config-only 选择错误、协议2被拒绝／协议1被接受、双配置载荷缺失，原日志 `/var/tmp/dsh-protocol-run/logs/red-{zig,runtime,manager}.log`。

父对联合源码运行 `bun test dsh-manager/test`：exit0，282 pass / 46 skip / 0 fail（328 tests）；`bun test dsh-bun-build/test/unit dsh-bun-build/test/runtime`：exit0，105 pass / 18 skip / 0 fail（123 tests）；`zig build test --summary all` exit0。日志 `/var/tmp/dsh-remaining/parent-gates/combined-041bd977/`。共同纯 intent/resolve、双载荷及 runtime claims 是传输／进程证据，不证明实际 settings/profile/local-credential 服务消费根。协议独立审查和真实 I/O 仍待完成，不发布此候选。

## 固定真实应用输入

独立 `/var/tmp/dsh-remaining/real-io-inputs/` 已按现有 fetch-upstream／fetch-pnpm／build-app 入口构建真实上游 `dsh-v0.2.0-rc.2`，commit `639ed015397290b3745d163aafe02ffee4aa3f84`，pnpm11.7.0官方资产SHA校验、frozen lockfile guard均成功；raw app闭包构建exit0并补齐27个workspace包、完成flat无symlink检查。原始service及文件hash、完整命令输出在 `HANDOFF.md`、`input-SHA256SUMS` 和 `logs/`。HOME/TMP/cache隔离，无全局依赖安装或用户实际凭据。此为后继真实 I/O 输入，不是协议2适配运行包／产品验收。

## 联合候选与四项协议复审

父侧 path 提交 `816fc9033791f421fec0dd1607ddd239dbc5ed22` 与协议修复 `1119958`、真实 I/O 的 `1a09eb5`／`09cfae3`／`f7b4c09` 整合为 `6ae48b2`。真实 I/O 版本站点表仅认证上游 rc.2；同一运行包 C1→C2→C1 不等于不同运行包 A→B→A。Windows managed I/O 此基线仍明确 fail-closed，HMR helper 验证不等于正常挂载 HMR 已恢复。

父全套使用 `/var/tmp/dsh-remaining/parent-gates/combined-6ae48b2/{home,tmp,cache}` 及前述真实 app／pnpm 输入，所有日志保留于该目录：

| 检查 | 实际结果 | 日志 |
| --- | --- | --- |
| `bun test dsh-manager/test` | exit0；299 pass / 46 skip / 0 fail，345 tests / 27 files | `manager-full.log` |
| `zig build test --summary all` | exit0；53/53 | `zig-unit.log` |
| `zig fmt --check src` | exit0 | `zig-format.log` |
| 初次完整 runtime/unit | exit1；122 pass / 6 skip / 1 fail | `runtime-unit-full.log` |
| 原 pnpm reader 直接导入重现 | exit1；缺 `dsh-bin:config-paths`，绕过实际应用 bootstrap | `pnpm-probe-red.log` |
| 真实 compiled entry 挂载 pluginManager 服务探针 | 实际应用 exit0，自定义命令返回 synthetic registry，原命令参数记录保留 | `custom-real-entry-probe.log` |
| 改为真实入口后的 pnpm 相关回归 | exit0；4 pass / 1 offline skip / 0 fail | `pnpm-real-entry-green.log` |
| 改后完整 runtime/unit | exit0；123 pass / 6 skip / 0 fail，129 tests / 30 files | `runtime-unit-real-entry-green.log` |
| 固定 raw 输入 SHA 复算 | exit0，六项均未变 | `input-verify-parent.log` |

补全 path 初次全套三个失败保留在 `parent-gates/path/manager-full-first.log`：搬迁夹具需声明合法 manager data root，显式实际注册会保存 location/binding。只迁移正向夹具和旧“注册无状态”断言，另增外来非空数据根拒绝且 rc 原字节不变的负例，不放宽生产归属检查。定点组合 exit0；42 pass / 27 skip / 0 fail，`path/coupled-green.log`。skip 未被算作 shell/native 验收。

原 reviewer 沿同会话 `f0e52375` 对冻结 `6ae48b2` 独立重建 manager/runtime，原 guard 换代竞态、canonical owner prefix、XDG transport、两类 completion canonicalization 四项均 Closed，无该 Linux 范围剩余 P0/P1/P2。实际竞态 runtime exit1、未进入应用、所有 claims 释放、凭据与 metadata 不变；正常 live runtime 删除拒绝，退出后显式删除允许。报告 `/var/tmp/dsh-remaining/reports/protocol-rereview-6ae48b2.md`，命令 receipt 与二进制 SHA 位于 `/var/tmp/dsh-protocol-rereview-6ae48b2/logs/`。它不批准真实 I/O／XDG 配置访问、Windows native 或整个 change。

## 正在实施的门禁与提供方阻塞

- Windows owner 独占 `/var/tmp/dsh-remaining/windows-io`，实施实际 current token SID、owner、DACL／继承和句柄身份检查；原生 CI 由父侧调度，未执行不算通过。新 wx/atomic temp 的私有 ACL 必须 creation-before-bytes；已有锁内部读取及创建专用检查未接入的站点不许用“最终单 syscall 窗口”掩盖。
- 两真实上游运行包 owner `e3cddf8d` 于工作树 `/var/tmp/dsh-remaining/real-io` 被提供方 `session_blocked_by_cyber_policy` 权限拒绝，未产出 file-only 交付。父确认树/index 干净且仍为 `6ae48b2`；A→B→A 未通过。匿名 GitHub tags 403 的日志另明确为 rate limit，不是源码身份，TLS EOF 也不提供真实第二版本证据。
- I/O/path fresh reviewer `aff5cc75` 被提供方 `cyber_policy` 拒绝；冻结 `/var/tmp/dsh-remaining/io-path-review` 干净、仍为 `6ae48b2`，没有批准报告。workflow `b3bfc81a` 的总 receipt 明确一成功一失败。原拒绝回执和失败状态保留，不视为批准。
- 随后用户明确答复“误报罢了，换成 opus 模型”，授权两条失败 lane 使用 Opus。workflow `bc1685bd-5e32-4b30-b894-98ce6cf90d1d` 以 `openai-api-extension/claude-opus-5-5:high` 启动同角色、fresh context 的独立审查与两真实版本实施；仍走 native pi-subagents，验收／权限边界不变。Windows 原 owner 独占现有 `transform-app.mjs` 的 rc.2 atomic/lock 接入，版本 owner 先构建第二真实输入及独立测试，在站点表修改前由父串行交接，不能并发覆盖。当前尚无替代 lane 的通过证据。
- FreeBSD 独立平台基础切片在另一分支推进，原生产物／组件命令不替代本 change 的平台与真实 I/O 门禁，更不替代 FreeBSD 全产品支持。

## Windows 原生组件首轮 CI

Windows 安全组件 `6a49d69aa4cbac94a06b8258a2b9633c2967a458` 已整合为 `e456f8e`，创建专用检查及 native runner 已存在，但实际应用的 inner atomic/lock 站点接入未完成，managed install 仍 fail-closed。父新增原生专用手动 CI 后候选为 `30a70d728ce75f64de44e8bc802de986b186d6ea`，已推送配置分支并派发 [run 37156417848](https://github.com/xz-dev/dsh-bin/actions/runs/37156417848)。仅 Windows x64 (`windows-2022`) 与 ARM (`windows-11-arm`) 运行 15 项组件门禁；release 路径明确排除，无产品发布。

**两架构均 failure**：PowerShell ACL 夹具 `execFileSync powershell.exe` 多次 `ETIMEDOUT`，不是 ACL 验证通过；240s 外层 runner 结束，未运行的用例也不算通过。失败原日志 `/var/tmp/dsh-remaining/parent-gates/windows-private-37156417848/failed.log`。原 Windows owner 已接回冻结 `30a70d7` 的修复与精确 atomic/lock 接入任务，父收到限定提交后重新整合／派 CI。不得用增加 timeout、Linux mocks 或 skip 代替真实执行。组件 native 通过之后仍需要真实 settings/provider/profile/restart 的 Windows 应用门禁。

所有任务按完整 criterion 再更新；当前 OpenSpec 仍仅 1.1 checked，56 场景完整映射及各原生／产品门禁尚未完成。
