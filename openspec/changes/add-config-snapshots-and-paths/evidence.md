# 实施证据

## 当前结论

这是 `add-config-snapshots-and-paths` 的实施期记录，不是完整验收。首个 store 候选为 `4dfbbf1e9787598982936618f98aae7322f31459`，父进程补全安全与耦合回归修复为 `abefea6d377d909fb276a365c6fdb27a0b741fc3`。当前协议仍为 1；协议 2、真实配置／凭据 I/O、双运行保护、八类 path、原生 Windows 与真实应用门禁未完成。不能根据此记录发布、合并、同步或归档。

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
