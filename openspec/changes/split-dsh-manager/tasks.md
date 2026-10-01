## 1. 独立入口与最小运行包协议

- [x] 1.1 以 MC-EMPTY、MC-NAMESPACE、RL-MANAGER-BUILD 确认首个行为切片并建立场景 ID → 黑盒测试 → red/green 证据记录；后续每个切片先确认场景、见到预期原因的失败，再做最小实现，完成标准是记录可复现命令和可观察结果，不以现有代码需要改动作为断言。
- [x] 1.2 将 launcher 起点和 Bun 构建内容分别归入 `dsh-manager/`、`dsh-bun-build/`，业务脚本随归属移动并调整构建入口；验证两边各自的最小构建能执行，管理器 `zig build` 不调用 Bun 或上游构建（RL-OWNERSHIP、RL-MANAGER-BUILD、RL-RUNTIME-BUILD）。
- [x] 1.3 实现 Zig 管理器版本/帮助、`manager` 路由及前置选择解析，移除管理命令对 bundle 启动的依赖；通过无运行包、无宿主 JS runtime 的真实进程测试和含 `manager update` 提示文本的参数透传测试（MC-EMPTY、MC-NAMESPACE、MC-ARGS）。
- [x] 1.4 在运行包项目调整 `local-build/assemble-bundle/compile-entry`，产出不含 manager 的新格式归档及 manifest；用有效、旧格式、不支持协议、缺入口的独立 fixture 验证协议识别和拒绝行为，检查编译入口不再导入管理分发（RB-CONTENTS、RB-LEGACY）。
- [x] 1.5 实现 `DSH_MANAGER_LAUNCH` 的构造与 runtime 消费，先用本地预置的新格式运行包贯通启动；验证 argv、cwd、stdio、退出码及受控进程使用锁，且两个管理器身份可启动同一份未重建运行包（RB-INDEPENDENT、MC-ARGS）。

## 2. 便携及托管存储贯通

- [x] 2.1 统一真实程序路径与数据根解析、首次状态初始化和所有权/冲突检查；用从其他 cwd、经软链接、直接放 HOME、只读目录、同名文件的进程测试证明不散写、不静默换目录（PS-SYMLINK、PS-HOME、PS-READONLY、PS-CONFLICT）。
- [x] 2.2 实现显式托管标记及 Gentoo/Scoop 用户数据根规则，未知/损坏标记失败；验证系统只读前缀不写入，包版本目录变化不改变用户数据根，并输出明确的安装模式、数据根和应用 home（PS-MANAGED、PS-SCOOP）。
- [x] 2.3 实现默认 home、显式 DSH_HOME、受控缓存/tmp 环境与必要的初始空快照准备；调整 profile 适配使共享配置不再从快照父目录推导，通过隔离 HOME 的文件变化审计及外部 home 的实际 profile 启动验证（PS-CONTAIN、PS-OVERRIDE、RB-HOME）。
- [x] 2.4 将已有管理状态的版本/快照引用改为 ID 或相对路径，在所有写操作中使用统一数据根；停止进程后移动二进制和数据根、使原路径不可访问，验证本地预置运行包仍可离线启动（PS-MOVE，真实插件的完整搬迁验收在 8.1 补齐）。

## 3. 原生安装最小闭环

- [x] 3.1 实现独立 runtime 索引读取、主机 target 检测及 release/live 候选筛选，不从已安装 bundle 推导主机身份；受控源同时发布 manager/runtime 候选时确认仅选择对应运行包，旧格式和不兼容 target 不进入安装（FB-EMPTY、RB-LEGACY）。
- [x] 3.2 用 Zig 实现下载、大小/SHA-256 验证及受限重试/断点恢复；本地 HTTP fixture 覆盖断连、Range 不一致、Retry-After、超时和坏哈希，并验证真实 HTTPS 下载，不依赖 curl、Node 或 Bun 完成被测操作（DL-CORRUPT、FB-RETRY）。
- [x] 3.3 实现安全解包、required paths/协议验证、同卷暂存和原子激活；对绝对路径、穿越、越界链接、错误入口和激活中断做故障注入，确认外部文件及原可用版本不变（DL-ESCAPE、DL-CORRUPT）。
- [x] 3.4 将最小 `manager install` 接入锁、安装元数据和初始快照准备，从只有管理器的空目录完成显式安装并启动真实运行包；损坏入口的显式强制重装也能独立完成（MC-EMPTY、MC-BROKEN）。

## 4. 补全查询与用户级注册

- [x] 4.1 在运行包构建侧导出版本化固定 CLI `completion.json`，不加载 profile/plugin 来探测；用两份不同 CLI 描述及对应真实运行包的命令/帮助验证描述一致性和无管理器构建依赖（RB-COMPLETION、SC-VERSIONS）。
- [x] 4.2 实现只读候选查询和管理器命令/本地版本/快照/addon 候选，使用有效选择读取运行包描述；通过不存在数据根、离线源、禁止启动的应用 fixture 验证无创建、无网络、无应用执行，并验证候选不泄露敏感配置（SC-COLD、SC-LOCAL）。
- [x] 4.3 实现 Bash/Zsh 脚本生成及用户级 install/uninstall，保留用户配置和已有自定义补全；在真实 shell 中验证加载、参数候选、重复注册、撤销与当前会话生效提示（SC-SHELLS、SC-IDEMPOTENT、SC-COLLISION、SC-CURRENT）。
- [x] 4.4 实现 Fish/PowerShell 对应能力，并在真实 Fish 与 Windows PowerShell 环境重复注册、撤销和冲突测试；不能仅断言生成了字符串或文件（SC-SHELLS、SC-IDEMPOTENT、SC-COLLISION、SC-CURRENT）。
- [x] 4.5 处理稳定 PATH 入口、直接路径调用与搬迁后的重新注册提示；四种 shell 覆盖空格/引号/非 ASCII 路径和元字符候选，确认不执行输入且稳定入口指向新位置后读取新数据根（SC-QUOTING、SC-RELOCATE、SC-VERSIONS）。

## 5. 首次询问与自动安装

- [x] 5.1 实现普通启动的首次交互状态和“先询问补全、再检查运行包”顺序；使用真实终端会话记录、未安装/已有/损坏运行包 fixture 和 HTTP 请求记录验证接受、拒绝、注册失败及不重复询问（FB-ORDER、FB-DECLINE、FB-REG-FAIL）。
- [x] 5.2 接入空安装自动下载最新兼容 release、验证后启动原命令的闭环；确认不会再次询问是否下载，不擅自添加 profile，参数、cwd 和退出状态不变（FB-EMPTY）。
- [x] 5.3 实现非交互跳过询问但保留应用 stdin；随后第一次交互仍询问。让管理命令、顶层只读帮助/版本和补全查询在自举前分流，以无网络、无创建、无输入消费断言验证（FB-PIPE、FB-READONLY）。
- [x] 5.4 验证已有安装离线启动、固定/显式版本缺失和损坏安装不自动回退；并发首次启动与中断重试最多激活一个完整目标，不重置选择（FB-OFFLINE、FB-MISSING、FB-CONCURRENT、FB-RETRY）。

## 6. 完整版本、快照和 addon 管理

- [x] 6.1 移植安装/更新/列出/选择的完整原生行为，保留前缀歧义、固定版本、成功后记录渠道及 --force 规则；验证更新不解除固定选择，失败不切换渠道，管理命令始终不执行应用（MC-PIN、MC-CHANNEL、MC-NAMESPACE）。
- [x] 6.2 移植快照编号、命名、复制、空快照、列表与删除，接入新版本从前一版本最新快照复制；以真实插件验证来源不变、编号不复用、共享配置不进入快照和跨版本试运行（MC-SNAPSHOT、MC-CROSS-SNAPSHOT、RB-PLUGIN）。
- [x] 6.3 移植 office addon 的下载/校验/安装/选择/卸载与兼容 slot 规则，runtime 仅消费管理器选择结果；验证 addon 安装不执行 dsh，并对真实 office 启用和缺失降级分别启动验收（MC-ADDON）。
- [x] 6.4 完成运行包和快照的占用保护、应用内重启继承上下文、批量删除预检；并发修改默认选择与重启时仍使用原版本/快照，使用中对象不能被替换或删除（MC-IN-USE、RB-RESTART）。
- [x] 6.5 移除旧“最后一个运行包不可卸载”的限制；验证解除固定后可卸载全部闲置运行包，管理器仍可用，快照/选择/home 保留，重装同版本复用原数据和编号；普通启动回装时保留已记录渠道，无记录才默认 release（MC-LAST、MC-REINSTALL、FB-RESTORE-CHANNEL）。
- [x] 6.6 实现离线 clean 与中断安装/快照的可恢复残留处理；对缓存、有效运行包、有效快照、用户配置和凭据分别断言结果，证明自动残留处理不成为用户数据清理（MC-CLEAN）。

## 7. 管理器更新与包管理集成

- [x] 7.1 实现 manager 独立索引、版本比较和候选验证；相同启动协议的管理器修复必须可更新，安装旧 dsh 不降级管理器，并用文件哈希/选择/快照前后对比验证只升级管理器（MC-SELF-ONLY、MC-OLD-RUNTIME）。
- [x] 7.2 完成 POSIX 管理器同卷安全替换与故障恢复；在下载、验证、替换边界中断，验证旧或完整新入口仍可运行且应用数据不变（MC-SELF-FAIL）。
- [ ] 7.3 完成 Windows 同程序 helper 的交接、原安装上下文传递、替换结果与残留回收；真实 Windows 验证映像占用、父进程退出、helper 中断及入口完整性，不将“已交接”误报为“已升级”（MC-SELF-FAIL）。
- [ ] 7.4 将 Gentoo 包改为仅安装管理器和托管标记/入口；在非特权用户下验证 runtime 安装与选版可用、self-update 在下载前拒绝，包升级/卸载不删除用户数据（PS-MANAGED、DL-MANAGED-UPDATE、DL-MANAGED-SELF、DL-MANAGED-REMOVE）。
- [ ] 7.5 将 Scoop 管理器清单与升级/卸载行为改为相同拥有权模型；真实 Windows 执行安装、包版本升级及卸载，验证数据根稳定且 runtime/addon 管理仍可用，并准备退出旧 dsh-live/dsh-office 入口（PS-SCOOP、DL-MANAGED-UPDATE、DL-MANAGED-SELF、DL-MANAGED-REMOVE）。

## 8. 组合门禁、文档与源码收尾

- [ ] 8.1 用至少两个新格式真实运行包、两个管理器版本及真实插件完成组合 E2E：空安装、版本/快照、卸载全部后重装、重启、只升级管理器，以及原路径不可访问且断网的完整搬迁；被测 PATH 无宿主 Node/Bun（PS-MOVE、PS-CONTAIN、RB-INDEPENDENT、MC-REINSTALL、DL-REAL-E2E）。
- [ ] 8.2 为既有 Linux glibc/musl、macOS、Windows 运行包 target 与管理器目标设置对应原生验收；验证四种 shell 和 Gentoo/Scoop 门禁都有实际执行记录，未运行的平台不计为通过（DL-REAL-E2E、SC-SHELLS）。
- [ ] 8.3 拆开 manager/runtime 的版本身份、索引生成和发布 CI，组合测试显式消费已验收的对方资产；用仅 manager 改动及仅 runtime 改动的试运行确认不会重建/重发另一产品（DL-MANAGER-ONLY、RL-ARTIFACT-E2E）。
- [ ] 8.4 将根 docs 归入 desc，更新中英文 README 与安装、数据位置、补全、命令、托管模式和卸载说明；验证链接与命令示例，移除旧根 install.sh 下载入口，不添加迁移指南（RL-OWNERSHIP、DL-NO-MIGRATION）。
- [ ] 8.5 移除已被 Zig 替代的 TS 管理入口与旧构建耦合，清理根业务脚本和失效测试引用；结合源码依赖检查、运行包产物清单与独立构建记录，证明没有继续隐藏调用旧管理器（RB-CONTENTS、RL-MANAGER-BUILD、RL-RUNTIME-BUILD）。
- [ ] 8.6 对各功能切片的实际变更进行独立审查并处理有效发现；运行最终场景/需求映射检查，确认每条规格有可执行测试或明确的真实平台验收证据，不以 OpenSpec 校验代替软件测试。

## 9. 新发布切换与全部旧发布清理

- [ ] 9.1 在发布 API fixture 或隔离测试仓库演练冻结清单、仅删除旧 ID、部分失败继续记录及保护新制品；验证认证/不可变性受阻时停止、不降低保护、不使用动态全集误删新发布（DL-CUTOVER、DL-CLEANUP-BLOCKED）。
- [ ] 9.2 取得发布切换授权后暂停旧自动发布路径，枚举并冻结全部旧 release/live/addon Releases、资产和索引/包清单引用；交付精确 ID、URL、数量及可核对的清单，验证冻结后不会继续产生旧格式资产。
- [ ] 9.3 发布已验收的新管理器、运行包和所需 addon，再发布独立索引与新 Gentoo/Scoop 清单；验证新体系不引用待删除资产，实际首次下载和两种包管理安装可成功（DL-REAL-E2E、DL-MANAGED-UPDATE）。
- [ ] 9.4 向操作者展示冻结删除清单和不可逆后果，获得明确执行确认后按 ID 删除全部旧 Releases/资产并移除当前旧下载入口；逐项保存结果，验证未删除任何清单外新发布、Git 标签/历史或用户本地数据（DL-CUTOVER）。
- [ ] 9.5 验证旧清单资产的精确下载 URL 已不再提供文件、新索引/包清单仅提供新制品，以及新安装/更新仍可用；对权限或不可变规则阻塞的项单独报告，清单未清空不能标记本任务完成（DL-CUTOVER、DL-CLEANUP-BLOCKED）。
- [ ] 9.6 向用户交付实现范围、逐切片 red/green、跨平台/真实包安装记录、新发布地址和旧发布清理结果，确认实际验收；残余风险与未执行检查明确列出，不把通过测试当作替用户作最终接受决定。
