# 实施证据

## 当前结论

这是 `add-config-snapshots-and-paths` 的实施期记录，不是完整验收。父固定 `c18afcc95c832d3a519e2a936a2c7b0593f9cb9b`，以认证 raw 副本组装真实 rc.1/rc.2，two-runtime/config-I/O/atomic/path 联合 **19pass/0fail/1668assert**；同批真实产品 **6pass/2skip/0fail/194assert**，Office/CI组合 skip 不抵扣。生产行为与500537c一致。原四项协议发现独立 Closed（仅 Linux transport）；Opus复审 `213b6796`、`232d391d` 两次429无报告，仍blocked，不自动重试。Windows第六轮 `37194327297` 两架构各13pass/2fail/0skip，生产managed gate仍关闭，新token launcher未整合或原生运行。用户已确认固定 rc.1/rc.2 按实际上游能力验收：无入口的内部进程重启子项标不适用而非通过，真实服务重挂载、父退出、新进程上下文和使用保护继续必验；Windows owner策略未获修改批准。56场景映射不等于全部接受。规定原生矩阵、shell/Scoop、Office/CI组合和独审仍有缺口；不具备发布、合并、同步或归档条件。下文旧结果保留为历史。

## 固定候选、真实能力及最新交付状态（2026-10-04）

- 父联合日志：`parent-gates/product-unified/logs/fresh-source-c18afcc.log`，SHA256 `76031cb0fae99a66e8a9754f6e033b4223c0fef7159c226f03bc2ed570e69f7f`；同批产品日志 `fresh-products-c18afcc.log`，SHA256 `240a3f3311fc2d48cfaccbff21c47cfcfcd115ad5f5059a17f6ff485e5699362`。前者实际覆盖同P双C并发、真实watcher、复制相对accounts路径再启动及无宿主工具PATH；后者覆盖两manager、真实插件、argv/STDIN/exit及离线搬迁，不再记作待迁移旧夹具。
- 独立搬迁凭据追加候选 `04efe85f24008536571fd494ad00bf88b2d5b3af` 尚未父整合/复跑。owner报告真实LocalCredentialProvider set/resolve、8个Linux trace、缺失文档red和6pass/1skip/0fail/656assert；不将worker报告计为父接受。现有父搬迁成功不单凭目录摘要外推凭据读写。
- 第六Windows实际TokenOwner与零字节wx owner为Administrators，而DACL仅当前用户；此按旧owner契约被拒绝。父kill后child确已退出，不能称活着等待认证，inJob不定位具体原因。新test-only `508401f7`/`3dce8ee2` 仅本地语法/Linux skip，未整合、不继续用token改造制造产品正例。普通manager另有PrivateAccessFailed，API根因尚未定位。
- rc.1 `4878cdabd87d4041bdaff61d04c966883b9fd07a`、rc.2 `639ed015397290b3745d163aafe02ffee4aa3f84` 的认证源码、raw和实际ZIP显示CLI无已识别的内部进程重启入口，Loader.exit空hook，Fiber.restart为同PID重挂载。证据 `/var/tmp/dsh-real-config-restart/logs/restart-entry-proof.json`，SHA256 `7b50e9e5e64e3907318995fa5422856f0ac9d79d1532bff0056c46e461d7b5c9`。用户已明确选择“按现有上游能力验收”；RB-RESTART仍需真实重挂载与独立父退出分项，不因适用范围澄清就整体通过。
- CI候选A `37197218229`、B `37197221512` 都固定c18afcc且整体failure。A已核对manager与12目标runtime构建/aggregate成功，组合和publish为skip；两run均有Linux/macOS/Windows test及Scoop失败，包含PowerShell snapshot候选缺失和Windows manager PrivateAccessFailed。Office `37197223893` publish=false构建success；均未公开发布，构建不是组合接受。失败日志在 `parent-gates/ci-products-c18afcc/`，A/B SHA256分别 `21eba8632b6a70aa571be472bd4b34041facad0b06d35e58ee85f3d6d89f5b9e`、`3166ed3f2e1c37dfb37f613832c2160b560ff2372deddc520385b7f947514392`。

## 前置与保留场景核对

前置 `split-dsh-manager` 已验收并归档，main 基线为 `5b3ed0fec0cbb6832cfa1b216f0cecc11d33e791`。manager-control、portable-storage、runtime-bundles 的 11 个 MODIFIED requirement 目标均存在，19 个前置场景标题全部保留。机器核对记录：`/var/tmp/dsh-remaining/parent-gates/config-modified-retention.json`。严格校验 `openspec validate add-config-snapshots-and-paths --strict --no-interactive` exit 0，日志 `config-strict-abefea6.log`（同目录）。

已核对接口：数据所有权标记 `.dsh-bin-data.json` 为 kind=dsh-manager-data/schema=1；context 区分真实 executable、管理 data 与应用 home；选择来自 `state/selection.json`，维护锁为 `state/manager.lock`；两类 store 的 root、`.counters.json`、`.lock` 和对象 `.usage.lock` 独立。旧有效插件 metadata 不要求新增 kind 字段，旧选择缺失 configSnapshot 仍可读取。completion 前置记录未保存历史目标路径，后续查询必须报告 unknown 而非猜测。56个增量场景的逐项语义映射见末节；已核对唯一ID与实际文件，但有入口仍未完成真实／原生验证，任务1.2不计完整接受。

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

## 历史实施与提供方阻塞（已被当前结论更新）

- Windows owner 独占 `/var/tmp/dsh-remaining/windows-io`，实施实际 current token SID、owner、DACL／继承和句柄身份检查；原生 CI 由父侧调度，未执行不算通过。新 wx/atomic temp 的私有 ACL 必须 creation-before-bytes；已有锁内部读取及创建专用检查未接入的站点不许用“最终单 syscall 窗口”掩盖。
- 两真实上游运行包 owner `e3cddf8d` 于工作树 `/var/tmp/dsh-remaining/real-io` 被提供方 `session_blocked_by_cyber_policy` 权限拒绝，未产出 file-only 交付。父确认树/index 干净且仍为 `6ae48b2`；A→B→A 未通过。匿名 GitHub tags 403 的日志另明确为 rate limit，不是源码身份，TLS EOF 也不提供真实第二版本证据。
- I/O/path fresh reviewer `aff5cc75` 被提供方 `cyber_policy` 拒绝；冻结 `/var/tmp/dsh-remaining/io-path-review` 干净、仍为 `6ae48b2`，没有批准报告。workflow `b3bfc81a` 的总 receipt 明确一成功一失败。原拒绝回执和失败状态保留，不视为批准。
- 随后用户明确答复“误报罢了，换成 opus 模型”，授权两条失败 lane 使用 Opus。workflow `bc1685bd-5e32-4b30-b894-98ce6cf90d1d` 以 `openai-api-extension/claude-opus-5-5:high` 启动同角色、fresh context 的独立审查与两真实版本实施；仍走 native pi-subagents，验收／权限边界不变。Windows 原 owner 独占现有 `transform-app.mjs` 的 rc.2 atomic/lock 接入，版本 owner 先构建第二真实输入及独立测试，在站点表修改前由父串行交接，不能并发覆盖。当前尚无替代 lane 的通过证据。
- FreeBSD 独立平台基础切片在另一分支推进，原生产物／组件命令不替代本 change 的平台与真实 I/O 门禁，更不替代 FreeBSD 全产品支持。

## Windows 原生组件首轮 CI

Windows 安全组件 `6a49d69aa4cbac94a06b8258a2b9633c2967a458` 已整合为 `e456f8e`，创建专用检查及 native runner 已存在，但实际应用的 inner atomic/lock 站点接入未完成，managed install 仍 fail-closed。父新增原生专用手动 CI 后候选为 `30a70d728ce75f64de44e8bc802de986b186d6ea`，已推送配置分支并派发 [run 37156417848](https://github.com/xz-dev/dsh-bin/actions/runs/37156417848)。仅 Windows x64 (`windows-2022`) 与 ARM (`windows-11-arm`) 运行 15 项组件门禁；release 路径明确排除，无产品发布。

**两架构均 failure**：PowerShell ACL 夹具 `execFileSync powershell.exe` 多次 `ETIMEDOUT`，不是 ACL 验证通过；240s 外层 runner 结束，未运行的用例也不算通过。失败原日志 `/var/tmp/dsh-remaining/parent-gates/windows-private-37156417848/failed.log`。原 Windows owner 已接回冻结 `30a70d7` 的修复与精确 atomic/lock 接入任务，父收到限定提交后重新整合／派 CI。不得用增加 timeout、Linux mocks 或 skip 代替真实执行。组件 native 通过之后仍需要真实 settings/provider/profile/restart 的 Windows 应用门禁。

所有任务按完整 criterion 再更新；此历史节点仅1.1 checked。后续56场景映射已交付，原生／产品门禁仍须分别闭合。

## 固定候选 500537c：真实两版本与 Opus 发现修复

真实 rc.1 输入为 tag `dsh-v0.2.0-rc.1`、commit `4878cdabd87d4041bdaff61d04c966883b9fd07a`，rc.2 为 `639ed015397290b3745d163aafe02ffee4aa3f84`；raw app 各构建一次、固定 pnpm11.7.0，来源清单分别位于 `/var/tmp/dsh-opus-two-runtime/input-SHA256SUMS` 与 `/var/tmp/dsh-remaining/real-io-inputs/input-SHA256SUMS`，只复制字节到 scratch，不改 raw。rc.1／rc.2 bin.js 及大量应用路径不同；配置服务字节相同已经逐项验证，不是改标签的同一包。父最初 rc.1 未认证时实际 red，授权站点表后曾在未提交源码上 green；该历史不代替以下固定提交复跑。

以下日志在 `/var/tmp/dsh-remaining/parent-gates/two-runtime-current/`；HOME/TMP/cache 均位于该专用根，产品 PATH 与驱动器分离：

| 命令／边界 | 实际结果 | 日志 |
| --- | --- | --- |
| config-io + path 新复现，修复前 | exit1；10 pass /3 fail：真实 linked-root、合法空 kind、rc 类型诊断 | `review-findings-red.log` |
| 同项修复及清理夹具纠正后 | exit0；13 pass /0 fail | `review-findings-green-final.log` |
| 真实 profile helper 权限在映射后变化，修复前 | exit1；插件启停两份实现、optional/overlay loader 发生 unsafe read；sanitize 已错误移动文件 | `profile-seams-red.log` |
| atomic/config + transform 最小修复后 | exit0；17 pass /0 fail；检查参数求值后真正进入 read 的标记，不用后续 atomic 拒绝掩盖先前读 | `profile-seams-green.log` |
| 干净固定500537c：`bun test dsh-bun-build/test/runtime/two-runtime-config.test.ts dsh-bun-build/test/runtime/config-io.test.ts dsh-bun-build/test/runtime/atomic-config-io.test.ts dsh-manager/test/path.test.ts` | exit0；19 pass /0 fail，113.97s | `frozen-source-500537c.txt`、`frozen-500537c.log` |

固定运行的 builder 身份为 `0.2.0-rc.1-b1.1.g500537c4` 和 `0.2.0-rc.2-b1.1.g500537c4`；实际 manager install／launch、settings/provider/import 更新、回切来源字节不变及直用／复制对照产物位于 `tmp/two-runtime-config-9ySYfi/`。真实单版本 I/O 位于 `tmp/real-config-io-AkoGsa/`，包括合法 linked data ancestor。

首轮 Opus `02097f30` 冻结6ae48b2，P1-1 linked ancestor、P2-1 属性 I/O、P2-2 合法缺省 snapshot kind、P2-3 rc 类型诊断未关闭前 verdict BLOCK。父补丁复用 bootstrap 已验证物理根与既有 boundary helpers，不新建锁／事务；dump-config 的 `loaded.patchPath` 本身只用于存在性和已加载数据的标签，实际 optional／overlay helper 的读点已加入当前 C 路径检查及稳定错误重抛。`213b6796` 及同会话有界恢复 `232d391d` 对500537c复审均因提供方429 cooldown失败，第二次仍缺必需报告，不再自动循环或换路由。原有partial日志保留但不是批准；必须实际复跑并给逐项 disposition 后才记独立 Closed。

## Windows 原生第二、三轮与第四轮采证

第二轮 `37185833975` 在 PowerShell 日志格式调用处失败，第三轮 `37186974141` 修正格式后仍两架构失败；后者 x64 有实际 null-DACL 负例 pass 与17–19s夹具 END，ARM 仍出现20s超时，不能概括为全部未执行，也不能把 stdin 假说写作根因已修复。失败证据保留在 `parent-gates/windows-private-<run>/`。

inner atomic/lock 的 read、复读、wx、rename、remove 检查已整合（`a070474`），真实 native service candidate runner 已整合（`48f161d`），但尚未通过 Windows 应用门禁。`b2ea0f1`／`b8d521b` 仅增加单调阶段时间、spawn前文件描述符输出持久化和 task-owned RUNNER_TEMP／PowerShell cache；不增加20s/240s限时、不减少15项断言、不修改生产 gate。第四轮 `37190005445` 对 `b8d521b73cb685e581705d412842ce3c08cad860` 两架构均failure，24份 `.stages` 最后均为 `directory-new-object-before`，token/rights阶段约23–40ms，尚未进入SetOwner/CreateDirectory。仅据此不能区分cmdlet发现与CLR构造器。

第五轮 `37192195212` 固定 `0629c8bf8677e0a676cf2c66302c5fc23fe7c072`：原New-Object对照两架构20s超时；直接CLR构造337/338ms成功；显式系统模块导入后原New-Object以及Get-Acl/Set-Acl/Add-Type/JSON全部成功（3348/2722ms）。这支持自动发现／加载路径阻塞，而非CLR构造器本身；diagnostic exit0只表示采样完成。必需15项组件门禁两架构均13pass/2fail/0skip；实际失败为checkCreation正例拒绝和父退出后等待child result超时。根因尚未据此定案，原owner恢复为 `e22d6ccf` 继续，不放宽ACL或增超时。证据目录 `parent-gates/windows-private-37192195212/{artifacts,failed.log}`。组件、真实service和最终生产源码均通过之前，Windows managed install 不开放。

## 新产品切片整合（待父统一候选复跑）

- 文档 `ae8b497`：双语12文件，92个本地链接／锚点通过；隔离环境下path/launch/snapshots/completion 72pass/5skip/0fail，`parent-gates/docs-contract-0629c8b/cli.log`。无类型snapshot命令和共享HOME配置旧契约已纠正，历史实现报告原样保留。
- 并发owner `7564868`、`c11d7fc` 整合为 `5ece699`、`d47afad`：同P的两个真实settings/provider会话、实际manager复制相对accounts/work.yaml、双向真实watcher、默认变化和live P/C删除保护。worker最终1pass/0fail/369断言，且错误C2→C1启动映射对照确实失败。`/var/tmp/dsh-real-config-concurrency/`保留初次watch文件/目录误判、red/green及hash；不声称实际上游restart或CI通过。
- 产物夹具owner `922165c` 整合为 `7a28b5b`：两真实版本、两manager、实际pnpm安装插件、旧HOME哨兵、P/C复制及真实离线搬迁；worker 6pass/2skip/0fail/194断言，`/var/tmp/dsh-real-product-fixtures/`。Office和CI组合仍skip，手写respawn明确不是upstream restart。LOCAL预构建产物不替代CI验证。
- 父 `b724763` 隔离config-io产品PATH并去掉旧硬编码builder：新增真实PATH断言先red（实际继承/usr/bin:/bin），修正为绝对驱动工具与空产品PATH后1pass/0fail/505断言。中间关于assemble-only夹具必有node shim的过强断言失败也保留，现允许无node或仅bundle内node，仍拒绝宿主Node/Bun/compiler。日志 `parent-gates/product-unified/logs/path-{red,green,green-final}.log`。后续将用同一clean HEAD新建两runtime，再将其原始manifest/hash送入真实安装/搬迁suite；此节不是已完成该联合复跑。

## 56 场景语义映射（固定 500537c 生产源码；b8d521b 回归）

这是一份可执行入口与缺口清单，不是56项已接受的声明。`M/` 表示 `dsh-manager/test/`，`R/` 表示 `dsh-bun-build/test/runtime/`，`U/` 表示 `dsh-bun-build/test/unit/`。表中“管理器层”使用真实 Zig 管理器与受控库存／fake-native 夹具，只证明管理行为；“真实应用”使用认证 rc.1/rc.2、实际 compiled entry、settings/provider，不能与前者互换。

运行入口：`bun test <对应文件>`。真实 I/O 需 `DSH_BIN_REAL_IO_APP`、`DSH_BIN_TEST_PNPM`；两版本需另设 `DSH_BIN_REAL_IO_APP_A/B`。当前来源、命令和结果见上节 `frozen-500537c.log`（19/0）及 `full-b8d521b.log`（421 pass /80 skip /0 fail）。后者完整命令为 `bun test dsh-manager/test dsh-bun-build/test/unit dsh-bun-build/test/runtime`。这些是 Linux x64 结果，不外推 Windows x64/ARM、macOS 或其余支持目标；原生权限、使用保护及产品验证须在各规定平台执行。Windows 当前仍失败。所有测试入口须在专用 HOME/TMP/XDG/cache 下执行，不能使用真实凭据；两版本产品 PATH 已隔离，单版本 config-io 的产品 PATH 仍继承驱动 PATH，此运行环境缺口另列，不当作无宿主工具证明。

| 场景 | 实际入口与被验证行为 | 当前证据／剩余缺口 |
| --- | --- | --- |
| CS-IDENTITY | `M/snapshots.test.ts`：两类同ID／daily、独立计数、旧metadata及旧selection | Linux管理器层通过；不是应用I/O证据 |
| CS-AUTO | `M/versions.test.ts`：install/update/bootstrap逐类型继承；`R/two-runtime-config.test.ts`：真实B安装继承A的P/C | 两层Linux通过；规定原生矩阵待补 |
| CS-CREATE | `M/snapshots.test.ts`：default/target/empty/name与来源字节；`R/two-runtime-config.test.ts`：真实跨版本复制试用 | Linux通过；原生矩阵待补 |
| CS-EMPTY | `R/config-io.test.ts`：C3仅guard，真实provider无凭据、bundle默认、HOME哨兵不读 | 实际有断言，非字面ID匹配；Linux通过，Windows等待补 |
| CS-GAPS | `M/snapshots.test.ts`：删除2/3回落1、新建4；`M/path.test.ts`：合法缺省类型不初始化 | 管理器层通过；全生命周期原生待补 |
| CS-CONTENT | `M/snapshots.test.ts`：多profile/settings.imported/accounts独立复制、依赖/session等排除及合法basename回归 | 管理器文件层通过；不是完整应用服务验证 |
| CS-PLUGIN-BASE | `R/config-io.test.ts`：真实插件URL在P、patch在C、生成cordis.yml只在P；`U/transform-app.test.ts` | 真实Linux通过；HMR仅已披露helper范围 |
| CS-SWITCH | `R/config-io.test.ts`：同P的C1/C2更新/回切、provider watcher及来源字节 | 真实Linux串行通过；不能替代并发 |
| CS-CONCURRENT | `R/two-runtime-config.test.ts` 的新并发切片待交付：同P两live C、默认选择变化、真实watcher | 固定候选没有专用并发证据；不得用串行C1→C2→C1抵扣 |
| CS-FORMAT | `R/two-runtime-config.test.ts`：真实rc.1→rc.2导入/更新→rc.1原字节；两输入不同commit/bin.js | 固定500537c通过；原生平台与独立复审待完成 |
| CS-CROSS | `R/two-runtime-config.test.ts`：B写A副本对比B显式直用A，编号/selection不暗改 | 固定500537c真实Linux通过 |
| CS-EXTERNAL | `R/config-io.test.ts`：HOME、另一C、外部绝对路径、traversal、escaping link/dshHome；strace拒绝敏感open/watch | 实际断言通过，非仅“输出不含秘密”；Windows等尚缺 |
| CS-LOCAL-PATH | `R/config-io.test.ts`：相对/绝对集合内path和dshHome；`R/two-runtime-config.test.ts`：真实accounts/work.yaml；`M/snapshots.test.ts`复制accounts | 已验证单C实际读写及存储复制；自定义相对路径复制后再启动新C的完整对照待补 |
| CS-FAILURE | `M/snapshots.test.ts`：copy失败/中断/源变化/已复制文件篡改/目标换代/no-replace/外链硬链special | Linux管理器层通过；原store独审三项Closed，原生矩阵仍待补 |
| CS-PERMISSIONS | `M/snapshots.test.ts`宽umask/暂存；`R/config-io.test.ts`私有创建/loose/hardlink；`R/atomic-config-io.test.ts`实际read/wx/rename入口；`R/windows-private-config.test.ts` | POSIX通过；Windows组件native失败，真实服务和最终gate移除均未接受 |
| MC-EMPTY | `M/manager-control.test.ts`无JS PATH、只管理不写；`M/install.test.ts`与`M/path.test.ts`冷状态 | Linux管理器层通过；真实安装组合另有产物门禁 |
| MC-BROKEN | `M/install.test.ts`损坏条目/force修复；`M/real-runtime.test.ts`真实归档修复入口 | 管理器层通过；真实归档suite此前skip且夹具需迁移，不能计通过 |
| MC-NAMESPACE | `M/manager-control.test.ts`管理命令不进app；`M/launch.test.ts`、`M/snapshots.test.ts`leading边界 | Linux管理器层通过；实际argv/STDIN真实归档回归待补 |
| MC-ARGS | `M/launch.test.ts`prompt/空参/manager词保留；`M/snapshots.test.ts`config单次参数；`M/real-runtime.test.ts`真实插件argv/STDIN/exit | transport通过；真实归档入口当前skip，不能以fake-native代替 |
| MC-SNAPSHOT | `M/versions.test.ts`按版本顺序继承；`R/two-runtime-config.test.ts`真实安装继承P/C | Linux管理器及真实两版本通过；完整插件安装生命周期待补 |
| MC-CROSS-SNAPSHOT | `M/launch.test.ts`显式use优先；`M/versions.test.ts`跨来源；`M/real-runtime.test.ts`真实插件跨用 | 管理器层通过；真实plugin-service跨用/原生组合待补 |
| MC-ADDON | `M/addons.test.ts`管理不启动app；`M/real-runtime.test.ts`、`M/artifact-e2e-combined.test.ts`真实Office | 管理器层通过；真实addon/CI组合本轮skip |
| MC-TYPED | `M/snapshots.test.ts`类型必填、legacy、按类型补全；`M/launch.test.ts`双pins；`M/completion*.test.ts` | Linux现有shell/管理器层通过；缺失shell及Windows原生仍skip |
| MC-CONFIG-SELECT | `M/launch.test.ts`dual intent/alias/单次不写状态；`M/path.test.ts`effective与launch一致 | Linuxtransport通过；真实组合/平台待补 |
| MC-AMBIGUOUS | `M/launch.test.ts`不同版本来源需use、canonical owner不重做prefix | 原Linux协议复审Closed；其他平台仍有门禁 |
| MC-LAST | `M/versions.test.ts`unpin后全卸载保留两集合；`M/artifact-e2e-combined.test.ts`真实生命周期 | 管理器层通过；组合fixture漏C保留断言正迁移，CI结果待补 |
| MC-REINSTALL | `M/versions.test.ts`force/全卸载重装保留counter/selection/内容；CI组合入口同上 | 管理器层通过；真实CI组合不可用本地产物替代 |
| MC-IN-USE | `M/in-use.test.ts`双store整批保护；`M/versions.test.ts`guard换代；`R/snapshot-start.test.ts`runtime三claims；新真实并发切片 | guard原复现已Closed但stub进程不能抵扣真实应用与Windows父退出门禁 |
| MC-CLEAN | `M/clean.test.ts`／`M/versions.test.ts`／`M/self-update.test.ts`受控残留与不卸载；`M/addons.test.ts` | Linux管理器层通过；Windows原生self-update/组合待补 |
| MC-PINNED-CONFIG | `M/snapshots.test.ts`类型身份用例中固定C1、批删C2+C1拒绝且C2保留；`M/in-use.test.ts`双类型live整批保护 | 实际断言存在；固定与live区分，Windows/真实应用不能由fake填补 |
| PATH-OVERVIEW | `M/path.test.ts`cold八scope、人类/JSON、effective/三职责 | Linux通过；不初始化；其他原生待补 |
| PATH-EXPLAIN | `M/path.test.ts`真实symlink/离线移动/managed roots复用context | Linux通过；包装夹具和Windows原生待补 |
| PATH-CURRENT | `M/path.test.ts`库存、双C override、真实manager launch载荷逐项对照 | manager+fake entry对照通过；实际profile组合path对照仍需最终验收 |
| PATH-CONFLICT | `M/path.test.ts`foreign非空、wrong-type、坏metadata、rc变directory | Linux通过；无接管/修复；native矩阵待补 |
| PATH-RUNTIME | `M/path.test.ts`并存库存、精确目标与坏metadata | Linux通过；未下载/执行 |
| PATH-SNAPSHOTS | `M/path.test.ts`两类同ID、alias、卸载后的孤立snapshot | Linux通过；typed库存不合并 |
| PATH-ADDONS | `M/path.test.ts`具体addon identity与slot | Linux通过；实际Office运行不属于此只读用例 |
| PATH-TARGET-ERROR | `M/path.test.ts`missing/歧义/非法kind/非法addon或shell不回退 | Linux通过；合法缺省类型另按PATH-MISSING |
| PATH-CACHES | `M/path.test.ts`管理cache与显式外部HOME默认应用cache | Linux通过；不称外部cache为snapshot配置 |
| PATH-COMPLETION | `M/path.test.ts`实际注册路径、missing/legacy unknown/unregistered、wrong-type rc原因 | Linux13项定点已通过；native shell注册矩阵待补 |
| PATH-MISSING | `M/path.test.ts`全冷布局、runtime已存在但某kind未建立，complete=true/selection unresolved | Linux通过，目录/state/计数不创建 |
| PATH-UNREADABLE | `M/path.test.ts`inaccessible目录、坏selection，不当成空集合 | Linux普通用户通过；Windows语义需native |
| PATH-READONLY | `M/path.test.ts`八类audit、pending self-update/locks不变、损坏选择不引导 | Linuxstrace/目录前后通过；其他平台不能由strace替代 |
| PATH-SECRET | `M/path.test.ts`敏感sentinel未open、无子进程/网络 | Linux内核审计通过；Windows需实际对应证据 |
| PATH-MODES | `M/path.test.ts`portable/managed/移动；`M/gentoo.test.ts`、`M/scoop.test.ts`、completion relocate | Linux相关夹具通过；Scoop/native/真实配置搬家仍缺 |
| PATH-JSON | `M/path.test.ts`schemaVersion/records/diagnostics与人类输出、无ANSI、完整性/exit | Linux通过；最终native一致性待补 |
| PS-CONTAIN | `M/storage.test.ts`管理路径与fake审计；`R/config-io.test.ts`实际HOME非配置边界；`M/real-runtime.test.ts`真实Bun/pnpm全文件审计 | 管理器层与局部I/O通过；真实pnpm+插件+两snapshot全状态审计fixture待迁移执行 |
| PS-OVERRIDE | `M/storage.test.ts`外部home解释；`M/launch.test.ts`transport；`M/real-runtime.test.ts`外部HOME真实profile | transport通过；旧真实fixture错误期待读HOME配置，正按新契约迁移，不算通过 |
| PS-MOVE | `M/storage.test.ts`fake-native离线搬移；`M/artifact-e2e-combined.test.ts`双CI包/真实plugin/Office/源不可访问 | 管理器层通过；实际C/credentials/path离线搬家及CI组合尚缺 |
| RB-INDEPENDENT | `M/real-runtime.test.ts`同一真实archive两manager；`M/artifact-e2e-combined.test.ts`CI两manager | 当前入口skip/旧fixture待改；前置历史成功不替代新C协议真实验收 |
| RB-LEGACY | `M/install.test.ts`拒旧混合归档；`M/launch.test.ts`协议/必需项错误不执行 | Linuxmanager负例通过；规定native待补 |
| RB-CONFIG-PROTOCOL | `U/launch.test.ts`新字段必需；`M/launch.test.ts`、`M/snapshots.test.ts`旧协议拒绝 | unit/manager通过；真实当前包协议2有两版本证据，native矩阵仍待补 |
| RB-HOME | `R/config-io.test.ts`真实P/C/home分工；`U/transform-app.test.ts`standalone；`M/real-runtime.test.ts`显式外部home | 默认home实际通过；外部home真实归档fixture迁移中 |
| RB-CONFIG-CONTEXT | `R/snapshot-start.test.ts`缺失/错根/busy/无guard拒app；`R/config-io.test.ts`真实escaping/loose根拒ready | Linux组件及真实I/O通过；正常linked ancestor已修复且已定点通过；独审与Windows待补 |
| RB-RESTART | 认证源码/raw/ZIP的`restart-entry-proof.json`；已有`M/in-use.test.ts`、`R/snapshot-start.test.ts`仍仅transport | 用户批准固定rc.1/rc.2的内部进程重启子项不适用（非通过）；真实公开配置入口驱动的同PID重挂载待补，真实父退出/新进程验证/三claims不豁免 |
| RB-PLUGIN | `M/real-runtime.test.ts`真实插件安装/跨snapshot；`R/plugin-runtime.test.ts`实际pluginManager入口；`R/atomic-config-io.test.ts`启停helper读写 | 启停helper实际已通过；pluginManager真实入口的历史定点证据见前节，本轮plugin-runtime仍因work/app缺失skip。真实安装→开关/config→其他C不变的完整组合待迁移/执行 |

当前关键缺口：RB-RESTART 的真实服务重挂载与Windows父退出、规定原生平台、shell/Scoop失败、Office/CI组合、独审；固定rc.1/rc.2内部进程重启按用户确认标不适用，不以同PID或手写respawn冒充通过。CS-CONCURRENT与CS-LOCAL-PATH已由父c18afcc真实联合通过；真实产品夹具迁移及P/C离线搬迁已父复跑，凭据搬迁追加候选仍待父验证。当前有全部56行定位，但任务1.2不勾选：计划入口不冒充可执行测试，ID数量不是覆盖率。历史表中未更新行由本节和顶部最新实际结果补充，不外推完整criterion。
