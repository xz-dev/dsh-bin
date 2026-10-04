## Purpose

为 FreeBSD 15.x 的 amd64 和 ARM64 用户提供无需 Linux 兼容层或系统 JavaScript runtime 的完整 dsh 产品。支持必须贯通管理器、真实应用、会话、插件、终端、搜索和 addon，并保持安全存储及既有选择规则；不能把底层探针、交叉编译或功能占位作为完整支持。

## ADDED Requirements

### Requirement: 原生双架构与系统依赖边界

管理器、运行包和所需 addon SHALL 同时支持 FreeBSD 15.x 的 amd64、ARM64，最低系统 ABI 为 15.1；正式支持范围 SHALL 仅包含发布时受维护且经过验收的 15.x 版本。运行目标 SHALL 使用明确的 FreeBSD 身份，不伪装成 Linux、glibc 或 musl。产品运行 SHALL 不要求 Linuxulator、系统 Node/Bun 或构建工具；管理器源码保持 Zig，允许使用 FreeBSD 自带系统库。构建环境的开发工具不属于用户运行依赖。

#### Scenario: FBSD-NATIVE 两种架构都原生启动
- **WHEN** 普通用户在两种架构的已声明受支持 FreeBSD 15.x 上使用对应管理器与运行包，PATH 无 Node/Bun 且未启用 Linuxulator
- **THEN** 管理器及真实 dsh profile 均能正常运行，使用的是匹配架构的 FreeBSD 目标，而不是 Linux 制品

#### Scenario: FBSD-VERSION 支持版本和最低 ABI 不混淆
- **WHEN** 用户查看平台支持信息与制品要求
- **THEN** 最低 ABI 15.1 与发布时已验收、受维护的 15.x 清单分别明确显示，15.0 的历史探针及不支持发布原语的结果不被描述为支持验收

#### Scenario: FBSD-LIBC 系统库不等于系统 JS 依赖
- **WHEN** 检查两个架构管理器和运行包的实际动态依赖并在声明的干净系统中运行
- **THEN** 所需系统库均可由声明的 FreeBSD 基础系统提供，所需其他产品依赖已包含在受校验制品内，不通过用户 PATH 借用 JS runtime 或编译器

### Requirement: 管理功能与便携行为完整保留

FreeBSD SHALL 提供完整既有管理命令，而非帮助／版本查询的占位实现。安装、首次引导、选版、运行包更新、manager self-update、快照、addon、卸载、清理、补全与 path SHALL 遵守前置能力的安全和生命周期规则。默认数据根仍由真实管理器位置决定；显式 DSH_HOME 不改变两类快照的管理器所有权。FreeBSD 平台适配 MUST NOT 重置用户选择、把配置写回共享 home，或引入新的全局数据目录。

#### Scenario: FBSD-BOOTSTRAP 首次交互启动遵守既有引导顺序
- **WHEN** 用户只下载管理器，交互式启动且没有运行包
- **THEN** 按前置规则先处理补全选择，再安装当前渠道最新兼容运行包并启动真实应用，数据归属明确；非交互与只读路径按各自既有规则处理

#### Scenario: FBSD-UPDATES 运行包和管理器更新互不绑定
- **WHEN** 用户固定 A，安装或更新 B，再 self-update 管理器
- **THEN** 更新发现和制品身份分别独立，持久选择及两类快照不被重置，失败时保留原可用程序和内容

#### Scenario: FBSD-UNINSTALL 卸载全部运行包保留用户数据
- **WHEN** 用户解除固定选择并停止会话，卸载全部运行包，再安装同一版本
- **THEN** 管理器仍可用，插件／配置快照、凭据、会话及计数保留，重装不自动覆盖已有数据

#### Scenario: FBSD-CONTEXT 双快照与外部 home 独立
- **WHEN** 用户在 FreeBSD 上组合运行包 B、插件 P、配置 C 和显式外部 DSH_HOME，并修改配置／凭据后内部重启
- **THEN** 插件使用 P，配置与凭据读写 C，home 保持其既有职责；重启保持当前组合，其他集合和共享 home 哨兵不变

#### Scenario: FBSD-PATH 八类排障查询保持只读
- **WHEN** 用户在空安装、有效组合及失效选择下执行总览和八类 path 查询及 --json
- **THEN** 输出绝对位置、来源、有效组合或失败原因，不初始化、不联网、不执行应用／shell、不读凭据正文，也不借用另一安装补齐结果

#### Scenario: FBSD-COMPLETION 补全接入仍有所有权保护
- **WHEN** 用户在既有支持的 shell 上执行补全生成、同意注册、重复注册、Tab 查询和卸载
- **THEN** 原生格式正确、Tab 离线无副作用，注册幂等，卸载不覆盖用户修改或无关内容；缺失 shell 不导致自动安装系统包

### Requirement: 真实应用与插件安装运行贯通

FreeBSD SHALL 在交付的完整真实 profile 中提供应用 CLI 和产品随附功能，插件的安装、加载、执行、配置修改、重启和移除 SHALL 使用既有服务路径。固定 pnpm 版本 SHALL 能由运行包内嵌 runtime 执行，不因为缺少官方 FreeBSD standalone pnpm 资产而要求系统 Node 或静默切换版本。需要的随附原生模块 SHALL 提供本机匹配制品，不把缺失模块变成无功能 stub。任意第三方插件的外部服务、构建工具或平台限制仍按其声明处理，不属于无条件兼容承诺。

#### Scenario: FBSD-APP 完整 profile 不仅显示帮助
- **WHEN** 两种架构的真实 dsh 使用完整 profile、隔离数据及受控模型端点执行一次 CLI／TUI 交互并内部重启
- **THEN** 核心服务与工具实际执行，交互结果、会话状态和当前组合可观察，不依赖测试驱动器替应用完成工作

#### Scenario: FBSD-PLUGIN-JS 真实插件管理而非 pnpm 版本查询
- **WHEN** 用户通过 dsh 插件命令安装受控源中的 JS 插件及依赖，启用并调用，再重启与移除
- **THEN** 固定 pnpm 完成实际安装，插件能执行预期行为，依赖属于插件快照，配置属于配置快照；应用映像和其他集合不变

#### Scenario: FBSD-PLUGIN-NATIVE 原生插件按本机架构工作
- **WHEN** 用户安装并运行验收矩阵中的 FreeBSD 原生插件／模块
- **THEN** 对应架构的本机模块加载并执行，不从 Linux 或其他架构目录取二进制，不要求用户编译产品随附模块

#### Scenario: FBSD-PLUGIN-ERROR 外部插件限制清楚报错
- **WHEN** 第三方插件声明不兼容 FreeBSD 或缺少其声明的外部依赖
- **THEN** 安装／执行报告具体限制，既有插件、选择和数据不被破坏，不通过悄悄下载另一版本或系统 JS runtime 来掩盖问题

### Requirement: 会话与凭据锁保护实际数据

FreeBSD 的真实会话持久化、会话租约、凭据并发更新及其原生锁加载 SHALL 遵守现有跨进程互斥、原子写入、权限与退出后释放契约。C 绑定能够加载不等于应用已接通；验收 SHALL 通过真实服务而不是仅直接调用锁函数。MUST NOT 用空实现、进程内锁或关闭互斥来代替跨进程保护。

#### Scenario: FBSD-SESSION 两个进程竞争同一会话
- **WHEN** 两个真实 dsh 进程尝试同时持有同一会话，持有者随后异常退出，再由另一个进程恢复
- **THEN** 同时持有被拒绝，异常退出后保护释放，恢复得到一致数据，没有两个写入者共同修改同一会话

#### Scenario: FBSD-CREDENTIALS 并发凭据写入不丢失记录
- **WHEN** 两个真实本地凭据服务进程更新同一所选配置集合中的不同测试记录
- **THEN** 更新按既有锁策略协调，记录与原子文件完整，权限未放宽，其他配置集合和共享 home 不变，输出不泄露测试凭据

### Requirement: 本机终端子进程与取消语义完整

FreeBSD SHALL 提供真实 PTY、输入输出、窗口调整、前台进程观察、退出状态、超时和取消能力，符合既有本地 subprocess／terminal 服务契约。进程观察不得假定 Linux /proc、systemd 或 macOS 专用接口存在，不能把观察失败伪装成空闲、结束或成功取消。明确请求且无法提供的安全隔离策略 MUST 在执行前拒绝；普通本地执行的受限保证应明确说明，不冒充 Linux containment。

#### Scenario: FBSD-TERMINAL PTY 输入窗口与退出状态
- **WHEN** 用户用 FreeBSD 默认 sh 及已声明支持的选择 shell 执行交互命令、输入、调整窗口并等待退出
- **THEN** 工具通过实际 dsh 终端服务得到正确输出、PTY 属性和退出状态，不只依赖 Bun.Terminal 独立探针

#### Scenario: FBSD-CANCEL 前台进程与后代处理可观察
- **WHEN** 命令启动前台子进程并触发中断、超时或取消
- **THEN** 现有契约内的进程处理实际发生，结果与退出状态一致，观察不可用时明确报错，不留下被误报为已结束的受管理任务

#### Scenario: FBSD-POLICY 不可用隔离不能静默降级
- **WHEN** 用户明确请求 FreeBSD 无法实现的隔离策略后执行命令
- **THEN** 请求在命令执行前失败，诊断说明能力边界，不把 Linux 专用策略名称解释为已经隔离

### Requirement: 本机搜索工具随产品交付

FreeBSD 的 glob／grep 文件搜索 SHALL 使用受校验的本机 ripgrep 制品并符合现有搜索输出、错误和取消契约，不要求用户额外安装 rg。原生依赖缺失或架构不符 MUST 明确失败，不使用同格式／同架构的 Linux ELF 或从任意 PATH 捡取另一工具。

#### Scenario: FBSD-SEARCH 普通用户真实搜索与错误路径
- **WHEN** 用户在包含空格和非 ASCII 文件名的夹具中通过实际 dsh 工具执行匹配、无匹配、非法表达式及取消
- **THEN** 各结果与现有搜索契约一致，执行的是产品内本机 rg，无匹配不误报工具失败，非法输入与取消不破坏会话

### Requirement: addon 与 Office 同批完整支持

FreeBSD 双架构 SHALL 保留 addon 的安装、选版、兼容 slot、使用保护、卸载及查路径行为，并提供可实际执行的 Office WASM 引擎。Office SHALL 通过完整插件链路处理声明支持的文档能力，字体、缓存、临时文件和内嵌子进程符合既有受控路径规则。MUST NOT 仅发布 WASM 文件或跳过平台检查后宣称 Office 已可用，不依赖系统 LibreOffice 或 Node。

#### Scenario: FBSD-ADDON addon 管理与 slot 保护
- **WHEN** 用户安装、选择、运行、查询并卸载 Office addon，且尝试错误 slot 或删除正在使用的版本
- **THEN** 兼容对象能实际运行，错误 slot／使用中的删除按既有规则拒绝，其他运行包和数据不变

#### Scenario: FBSD-OFFICE 两种架构真实文档能力
- **WHEN** 完整 dsh Office 插件在两种架构处理验收矩阵中的 Word／Excel／PowerPoint 文档以及 PDF／图像输出
- **THEN** 转换／读取／渲染的结构、内容与关键显示属性符合既有功能契约，实际使用受校验 WASM 引擎，不是假输出或仅帮助成功

#### Scenario: FBSD-OFFICE-PATHS Office 不散写全局状态
- **WHEN** Office 处理带非 ASCII 路径和字体要求的夹具，产生缓存及临时工作并再次执行
- **THEN** 受控缓存和临时写入保持在管理器提供的范围，字体缺失有可解释结果，不在用户 home 平铺目录或修改真实凭据

### Requirement: FreeBSD 路径差异不削弱安全与便携性

解包、复制、快照与更新 SHALL 保持已有路径穿越、链接逃逸、所有权和使用保护。FreeBSD 的 no-follow 拒绝（包括 EMLINK） SHALL 被明确归为对应安全路径错误，不能跟随链接、忽略错误或通过检查后重新开放的不安全窗口绕过保护。普通用户 SHALL 无需 root 即可使用便携安装，并在停止后整体搬迁管理器与数据目录；失败不得隐式改用系统目录或扩大敏感文件访问权限。

#### Scenario: FBSD-NOFOLLOW 符号链接目标拒绝且有正确分类
- **WHEN** 解包暂存根或受控路径被替换为逃逸链接，FreeBSD 的原生打开拒绝该路径
- **THEN** 操作失败并报告链接／越界安全原因，目标外哨兵不变，不把 EMLINK 当普通成功、忽略或恢复为跟随链接

#### Scenario: FBSD-ATOMIC 激活失败不破坏旧版本
- **WHEN** 安装、重装或 self-update 在 FreeBSD 的验证／替换边界失败或中断
- **THEN** 原程序或完整已验证候选仍可使用，已安装版本、两类快照和选择不出现半成品覆盖，不套用不可用的 Linux rename 接口

#### Scenario: FBSD-MOVE 普通用户离线搬家
- **WHEN** 普通用户从软链接入口运行，停止真实会话后把管理器和全部数据一起搬迁，原位置不可访问且断网
- **THEN** 新位置可运行真实 profile、已有插件、配置／凭据和 addon，path 指向新根，程序不访问旧安装或在系统目录另建数据
