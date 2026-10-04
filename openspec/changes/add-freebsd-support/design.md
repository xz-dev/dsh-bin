## Context

动机与用户确认的首版范围见 `proposal.md`；历史实测及未测范围见 `feasibility.md`。当前管理器已有 FreeBSD 原生构建的基础，但 host target 只识别 Linux/macOS/Windows；构建 targets、pnpm 获取及发行矩阵同样未贯通 FreeBSD。应用锁加载器仍拒绝 FreeBSD，不能用 C 探针代替真实会话验收。

本变更已获后续实施授权；`split-dsh-manager` 已验收归档，`add-config-snapshots-and-paths` 仍待最终验收。以下接口沿用各前置的完整要求：

| 能力／接口 | 集成基线 | 本变更的处理 |
| --- | --- | --- |
| 独立管理器、安装／更新、受控发行、使用保护 | `split-dsh-manager` | 复用产品边界，不重写其实施或发行规则 |
| runtime-bundles 的兼容性要求 | `add-config-snapshots-and-paths` 的完整 MODIFIED 块 | 在双快照保护之上添加 FreeBSD ABI，不能用较早版本覆盖它 |
| distribution-lifecycle 的真实制品验收 | `split-dsh-manager` 的完整 requirement | 保留既有场景，增加 FreeBSD 双架构完整门禁 |
| 配置根、凭据、path、重启与启动协议 | `add-config-snapshots-and-paths` | 组合验证，不在本变更另定 API |

原生组件构建可以单独准备，但最终集成／验收须等前置接口交付。实施开始前核对实际已集成基线；如果前置改名、变更协议或增加场景，先协调更新本变更的增量和测试映射，不修改另一 agent 的文件。同步／归档顺序为 split → config/path → FreeBSD；不将 `MODIFIED` 当成空主规格的新增要求。

## Goals / Non-Goals

**Goals:**
- 在现有两个业务根目录内补齐平台分支、原生闭包和真实测试，维持独立发布、固定来源与最小适配。
- 先把已知失败变成可复现的 red-to-green 切片，再贯通真实应用；最终两种架构都执行完整产品验收。
- 同时验证平台适配与便携／双快照组合，不引入第二套数据布局、锁语义或安装器。

**Non-Goals:**
- 不改变现有 CLI 命名、snapshot 类型、八类 path、包拥有自身更新权或配置根位置。
- 不新增 pkg/ports、rc 服务、FreeBSD 14.x、任意插件兼容保证或新的隔离框架。
- 不公开发布产品、升级实验机、清理证据或旧 release；后续用户的实施／提交／CI 授权不放宽这些边界。

## Decisions

### D1：两种明确目标，共用现有产品模型

新增 `freebsd-x64` 与 `freebsd-arm64`。FreeBSD amd64 首版使用固定 Bun 1.4.2 的 baseline 发行／编译路径，不另造尚无必要的 modern 产品变体；现有平台的 baseline/modern/musl 目标不变。构建表明确记录 FreeBSD、Node 平台值 `freebsd`、架构映射、编译目标、资产来源及 VM runner 类型，不能把 Linux runner 的 uname 当作 FreeBSD 主机。

管理器与所有原生产品组件最低 ABI 设为 15.1：使用明确的 Zig FreeBSD 最小目标／相应构建系统的基线 sysroot，在 15.1 ABI 测试镜像运行。正式支持清单另按发布时受维护并已测的 15.x 冻结；最低 ABI 不等于自动支持所有未来 15.x 或主版本。

2026-10-04 用户批准从 15.0 提高至 15.1，保持目录 no-replace 安全契约。四个新建 guest 的 UID1001 原生探针确认 15.0 两架构无 `renameat2`／对应 flag，明确标注的较新 syscall 探针返回 `ENOSYS`；15.1 两架构原生 `renameat2(AT_RENAME_NOREPLACE)` 在空目标与保留父目录句柄时成功，已有文件／目录／链接返回 `EEXIST` 且字节、身份不变。证据位于 `/var/tmp/dsh-freebsd-emlink/publication/`；15.0 记录保留为不支持证据，不再计入支持矩阵。

用户已允许系统 libc。历史原样构建已链接 libc/libthr/libsys，因此不预设必须加某一行 `link_libc`；以实际产物依赖和最低系统运行证明为准。源码保持 Zig，FreeBSD 基础系统库允许动态链接；不把此前“无 libc 静态程序”的设计假设强套到 FreeBSD。

**备选：** Linuxulator、仅 amd64、先 CLI 后 Office 均不符合已确认首版范围；为统一名字重构所有旧目标无必要。

### D2：先修目标与安全错误，不放松 no-follow

在 `dsh-manager/src/target.zig` 增加 FreeBSD 两种架构及错误架构测试；主机／候选系统要求不符时在激活前拒绝，不能落到 Linux 选择。

已知 `zip.zig` 暂存根拒绝链接时出现 EMLINK→Unexpected。修复点放在现有描述符相对的安全打开层：保留 no-follow 标志和路径边界，准确获取并分类 FreeBSD errno；如果固定 Zig 包装已丢失 errno，只为此安全打开操作使用小范围本机接口适配。不能把所有 Unexpected 映射成链接错误，也不能先 lstat 再用会跟随链接的打开方式制造竞态。相同保护覆盖解包、快照复制和更新路径。

FreeBSD 的目录发布使用 15.1 原生、描述符相对的 `renameat2(AT_RENAME_NOREPLACE)`；不得使用目录 `linkat`（普通用户返回 `EPERM`）、plain rename 或 check-then-overwrite 替代。已验证文件的替换／回滚保留原有身份检查及恢复语义，不调用 Linux 专属接口。最低版本不满足或原语不可用时非零失败，不回退。测试在验证后、备份后、激活前后注入失败，证明旧状态或完整候选可恢复，临时文件不变成已安装记录。

**备选：** 移除 DL-ESCAPE、禁用安全标志或升级整个 Zig 工具链仅为绕过测试均不接受；优先保留固定版本并局部修复。

### D3：闭包可核对，不凭 ELF 魔数猜操作系统

扩展 `dsh-bun-build/scripts/targets.mjs`、构建入口和 `assemble-bundle.mjs` 的 FreeBSD 元数据／过滤。沿现有 bundle 元数据可扩展字段声明 FreeBSD 最低版本；对 FreeBSD 目标必填并在管理器激活前校验。具体字段采用 `platformRequirements.freebsd.minVersion`，不因新增 OS 另升启动协议；受管理配置隔离仍消费前置的新协议（其设计为协议 2）。缺失或不支持双快照载荷不能降级。

原生内容清单记录组件版本、源提交／归档哈希、构建目标、编译参数和动态依赖。ELF OSABI／note 作为检查信号，不作为唯一鉴别；合法共享模块可能没有可用的独立 OSABI 标记。来源证据、架构／库依赖检查和真实 FreeBSD 加载共同证明闭包。发布方在冻结 SHA-256 前验证闭包，管理器验证可信身份、哈希、元数据及所需内容，不通过运行未验证模块来“探测兼容性”。同 CPU 的 Linux ELF 测试夹具必须被拒绝。

固定 Bun、Zig、pnpm 及现有 app／native／ripgrep／Office 源身份；平台补丁随本项目构建脚本管理，记录适用提交及哈希。补丁不能静默漂移到上游 HEAD，也不能修改别的平台行为。非系统动态依赖必须随受校验制品交付，避免用户机器上临时编译或碰运气找库。

**备选：** 将 FORMAT.freebsd 简单设为 ELF 后结束检查不够；为证明来源设计新的通用包格式也无必要。

### D4：保留固定 pnpm，复用内嵌 Bun 与 node shim

pnpm 11.7.0 没有官方 FreeBSD standalone 资产；已验证该版本 JS dist 在内嵌 Bun 下可运行。FreeBSD 获取策略从该固定版本受校验来源提取通用 JS 闭包，排除另一平台的启动器／原生 `.node` 文件，保留必要 JS 依赖与许可证。不要仅重命名 Linux pnpm 二进制；不要升级到带 FreeBSD 资产的较新 pnpm。

FreeBSD shim 沿用产品内嵌 Bun／`BUN_BE_BUN=1` 路径，验证子进程、脚本执行、参数和退出码。历史 `--ignore-scripts` 本地 fixture 只证明窄路径；实施期还要从受控 registry 通过真实插件服务安装、加载、运行、重启、移除，并覆盖既有允许的 lifecycle 行为。第三方依赖需额外系统工具时清楚报错，不自动安装工具或借用系统 Node。

**备选：** 要求用户安装 Node/pnpm 不符合运行依赖边界；自己实现包管理器会增加无谓复杂度。

### D5：接通现有原生模块和服务，不替换锁模型

对固定 app 源的 native/system 构建、package 选择及 flock TS 加载器补齐 FreeBSD。遵守现有 package 命名／导出约定，为两种架构生成原生模块并进入闭包，允许加载现有 C flock 实现；不只在探针中直接 require `.node`。

保留跨进程 flock、描述符生命周期、原子写入和权限。真实 session 与 credential service 测试覆盖并发争用、正常释放、异常退出后恢复及同集合中的并发更新。runtime 生存期保护继续覆盖运行包与两类快照，不能因为管理器等待进程变化失去使用保护。测试只用虚构凭据，不读取真实账户。

**备选：** 空锁、进程内 mutex、移除会话租约均不能替代既有语义；为 FreeBSD 新建整套持久化层没有必要。

### D6：保留 node-pty 契约，适配本机进程观察与 rg

优先按固定 node-pty 源构建 FreeBSD prebuild 并保留现有调用 API；Bun.Terminal 探针成功不是替换整个终端实现的理由。通过真实 terminal/subprocess 服务测试默认 `/bin/sh`、既有支持的选择 shell、输入输出、resize、退出、超时和取消。

FreeBSD 进程观察不得套 Linux /proc 或 macOS 参数。复用可用 BSD 分支；缺少所需前台／进程字段时在现有 native/system 桥接中查询本机接口，不建立新的通用调度框架。取消限定在既有被管理任务契约内，检查进程归属／状态，不能通过观察失败返回空列表假称成功。Linux 专属隔离策略在执行前拒绝，普通本地执行不宣称有该隔离保证；不顺带实现 jail/Capsicum 框架。

ripgrep 按现有固定版本／源码在两种架构构建并打包；即使没有现成 upstream FreeBSD 资产也不换版本或下载 Linux 文件。实际 glob/grep 工具测试匹配、无匹配、非法表达式、取消、空格／非 ASCII 路径，不从用户 PATH 偷用 rg。

**备选：** 吞掉进程观察错误、假造空闲状态或把平台包装替换成大型服务都不合适。

### D7：Office WASM 是平台适配，不是延后交付

逐项冻结当前随产品交付的 addon 清单并纳入 FreeBSD；Office 使用已固定引擎的 WASM 路线，适配目前仅 Linux 允许 fallback 的平台解析、资源路径和执行入口。补 FreeBSD addon 元数据、两种架构的 runtime 集成及兼容 slot，维持 addon 自己的身份／发现和使用保护。纯 WASM 资源允许复用同一资产，但任何本机组件仍须对应架构。

从真实 Office 插件调用完整引擎，使用无真实业务数据的 Word／Excel／PowerPoint、PDF／图像夹具验证既有声明功能。比较结构、文本、页数／单元格及关键显示属性，不按含时间戳的输出逐字节比较。字体发现覆盖 FreeBSD 标准目录与显式选择，缓存／临时目录使用启动上下文；缺字体有诊断，不偷偷安装系统字体或依赖系统 LibreOffice。

**备选：** 单独加载 `.wasm`、打印版本、绕过平台判断但不转换文档均不是验收；改上游依赖版本需要另行决定。

### D8：真实双架构 VM、普通用户和受控源是发布门禁

在现有 CI 加真实 FreeBSD guest 的独立执行路径，固定镜像、VM action／工具版本。amd64、ARM64（包括真实系统全机模拟 guest）均实际执行本机程序；Linux 上的用户态模拟／改平台字符串不算。至少包括 15.1 最低 ABI 的组件运行检查，以及每个对外声明的受维护 15.x 版本的普通用户完整 E2E。版本清单在实施时按官方安全页冻结，并记录 kernel/userland；不得仅跑漂移的 latest。

构建可以有 Node、编译器与开发工具，但最终验收环境把这些从产品可见 PATH／解析路径移除，检查被测 UID 非 root，禁止 Linuxulator；确认实际用到的是候选内的 shim、rg、原生模块和 Office。驱动器的绝对路径依赖与被测产品环境分开。外部发行源、registry、模型服务用受控端点，应用、管理器、插件服务和文档引擎必须是真的。

每一场景记录环境、源码身份、制品 SHA-256、命令、退出码和必要输出；red、skip、未执行分别呈现。缺 ARM64 环境或任一完整链路失败就是 FreeBSD 发布阻塞，不缩掉矩阵。管理器修复可与已验收 runtime/addon 配对，不要求重发所有产品；FreeBSD 矩阵失败不破坏其他平台既有可用版本。

### D9：BDD 切片与组合回归

任务按“行为场景 → 当前失败／缺口 → 最小实现 → 真实验收”顺序推进，映射见 `tasks.md`。先目标／安全和本机闭包，再会话、终端、插件、Office，最后完整普通用户生命周期和发行负向门禁。既有 Linux/macOS/Windows、双快照协议、包拥有管理器更新权、全运行包可卸载及只读 path 均为组合回归，不因 FreeBSD 调整而重定义。

## Risks / Trade-offs

- [原始 amd64/root 探针被误当全平台成功] → 单独保存可行性证据，ARM64／普通用户／完整应用均有未完成任务，发布看正式矩阵。
- [在较新 userland 构建却标成 15.1 ABI] → 基线 sysroot与最低系统运行检查；不只修改元数据。
- [ELF 同格式而混入 Linux 库] → 固定来源清单、动态依赖检查与真实加载，注入同 CPU 的 Linux 负例。
- [EMLINK 修复掩盖其他 I/O 错误或产生竞态] → 局部 errno 保留、描述符相对 no-follow、越界哨兵及非链接错误回归。
- [pnpm 最小安装成功但真实插件失败] → registry、lifecycle、原生模块和实际插件执行全覆盖，固定版本不漂移。
- [FreeBSD WASM／字体／PTY 可编译但完整服务不可用] → 双架构真实工具和文档夹具；失败保留候选，不以占位功能发布。
- [前置正在实施导致协议和安全层冲突] → 先冻结集成基线和协调变更，保持前置文件只读；最终回归不得用旧基线覆盖新要求。
- [CI 环境未就绪] → 明确阻塞与所需镜像／架构，不借用现有 root 实验机结果替代，不未经授权升级该机器。

## Migration Plan

1. 在实施授权后核对已集成前置与固定依赖清单，建立隔离 FreeBSD 双架构构建／普通用户环境；先留下已知失败的证据。
2. 完成平台与原生依赖切片，再打包真实 runtime／addon，在受控索引下执行完整场景和既有平台回归。
3. 验收通过后准备独立产品的 FreeBSD 资产、发现索引与支持文档；公开发布仍需发布操作授权，不能由本规划触发。
4. 门禁失败不提升索引；已发布版本回退按独立产品选择／更新规则处理，保留数据与快照，不自动降级配置格式。首版没有已验收 FreeBSD 版本时就是不发布，而非回退 Linuxulator。
5. 仅支持新格式，无旧安装迁移；旧发布删除、测试机升级和临时证据清理保持原有独立确认边界。
