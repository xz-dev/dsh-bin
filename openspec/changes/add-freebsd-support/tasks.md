## 1. 冻结集成基线与验收环境

所有任务以完整 criterion 验收；已有组件结果不代表完整任务完成。每个切片先记录行为失败／缺口，再实现并留下真实验证结果，不把历史探针、skip 或构建成功计为完整通过。2026-10-04 用户批准最低支持版本改为 15.1，保留 15.0 的失败证据但不再将其作为支持基线。

依赖关系：1 为共同起点，2 与 3.1／3.2 为平台基础；4.1／4.2、5.1、6.1／6.4 的组件构建可独立推进，其服务级测试可使用固定源码和原生 Bun。3.3／3.4 的最终闭包及 profile 验收等待这些组件就绪，4.3／4.4、5.2／5.3、6.2／6.3 的候选制品验收等待 3.4；7.1—7.3 的 addon 构建可并行准备，7.4 等待真实 runtime 和 addon。组 8 等待组 2—7 及前置接口交付，组 9 等待组 8，组 10 的最终交接等待完整矩阵。不能因组号顺序在缺组件时把构建占位算完成。

- [ ] 1.1 核对 split-dsh-manager 与 add-config-snapshots-and-paths 已交付的 CLI、协议和完整 requirement，冻结各组件版本／源码／补丁身份及随附 addon 清单；验证交付一份基线清单，两个 MODIFIED 块保留前置全部场景，配置根仍在数据根的 config-snapshots，未覆盖另一 agent 的文件。
- [ ] 1.2 准备固定版本的 FreeBSD amd64、ARM64 原生 guest 构建／普通用户验收环境及 15.1 ABI 基线镜像，冻结发布时受维护的 15.x 清单；验证 kernel/userland/架构/镜像身份、非 root 测试 UID、无 Linuxulator，并明确环境未就绪就是阻塞，不升级现有实验机。（FBSD-NATIVE、FBSD-VERSION）
- [ ] 1.3 在现有测试根内建立受控发行源、registry、模型端点及虚构配置／凭据／Office 夹具；验证真实程序驱动的 BDD 可按场景 ID 保存命令、退出码、制品哈希和结果，被测 PATH 无系统 Node/Bun、编译器和 rg，驱动器依赖不泄入产品环境。（DL-REAL-E2E）
- [ ] 1.4 在固定源码上复现 target UnsupportedHost、no-follow EMLINK 分类和真实 flock 加载器缺口；验证分别记录 red 结果和外部哨兵，单独列出跳过的 Unicode 别名场景，不重新宣称历史 40/44 全绿。（FBSD-NOFOLLOW、FBSD-SESSION）

## 2. 管理器平台与安全路径切片

- [ ] 2.1 扩展 dsh-manager/src/target.zig 的 FreeBSD 两种目标及主机／架构拒绝路径；验证 target 单测、对应 VM 的真实身份选择和错误架构负例通过，Linux/macOS/Windows 目标不变。（FBSD-NATIVE、RB-FBSD-ABI）
- [ ] 2.2 设置并记录 FreeBSD 最低 ABI 构建要求，检查实际系统库依赖而非预设 libc 补丁；验证两种架构管理器在 15.1 基线运行、在正式支持镜像运行，动态依赖满足基础系统，纯 Zig 源码不要求用户 JS runtime。（FBSD-LIBC、FBSD-VERSION）
- [ ] 2.3 修复共享描述符相对安全打开的 FreeBSD EMLINK 分类，保留 no-follow 与原始非链接错误；验证 zip、快照复制和更新的链接／穿越／竞态负例不越界，DL-ESCAPE 在 FreeBSD 全绿，普通 I/O 错误没有被统一掩盖。（FBSD-NOFOLLOW）
- [ ] 2.4 适配 FreeBSD 15.1 原生 descriptor-relative `renameat2(AT_RENAME_NOREPLACE)` 目录发布及安装、重装、self-update 的验证后替换／恢复路径；验证不存在目标可发布、已有文件／目录／链接返回已存在且不变、父路径被替换后仍操作固定句柄，以及验证后、备份后及激活边界的故障注入保留可用版本与用户数据，暂存内容不误成为已安装对象；原语不可用不降级。（FBSD-ATOMIC、FBSD-UPDATES）

## 3. 运行包目标与可信本机闭包

- [ ] 3.1 扩展 dsh-bun-build/scripts/targets.mjs 及编译／构建入口的 freebsd-x64、freebsd-arm64、Bun baseline、Node OS 和 VM runner 映射；验证目标表测试与真实 guest hostTargetId 一致，不把 Linux 执行器当 FreeBSD，原有目标矩阵保持。（FBSD-NATIVE）
- [ ] 3.2 为 FreeBSD bundle 增加 platformRequirements.freebsd.minVersion 及管理器验证，保留前置格式和双快照启动协议；验证缺字段、错误 OS／CPU、更高 ABI 和旧协议在激活／配置加载前拒绝，正常目标可消费三类根。（RB-FBSD-ABI、RB-CONFIG-PROTOCOL）
- [ ] 3.3 扩展 assemble-bundle 的 prebuild 裁剪、原生清单与来源／依赖检查；验证两架构无外国模块，注入同 CPU Linux ELF 会失败，合法 FreeBSD 共享模块不因单一 OSABI 字节误拒，可信索引哈希对应实际验收闭包。（RB-FBSD-NATIVE、FBSD-LIBC）
- [ ] 3.4 生成两种架构的真实单文件入口与完整 app bundle，校验必要文件和内嵌子进程路径；验证 15.1 ABI 基线与受维护 guest 的真实 profile、CLI／TUI 交互和内部重启通过，而非只跑 --version。（FBSD-APP、FBSD-NATIVE）

## 4. 固定 pnpm 与真实插件生命周期

- [ ] 4.1 增加 pnpm 11.7.0 通用 JS 闭包获取／校验策略并过滤外国启动器和原生文件，保留所需 JS 依赖及许可证；验证固定版本、来源哈希、内容清单与离线夹具安装，不下载不存在的 FreeBSD standalone 资产或升级依赖。（FBSD-PLUGIN-JS）
- [ ] 4.2 接通 FreeBSD 产品内 node/pnpm shim、参数／环境／退出码和既有允许的 lifecycle scripts；验证无宿主 Node 的实际子进程及脚本行为，脚本失败可观察且不自动安装系统工具。（FBSD-PLUGIN-JS、FBSD-PLUGIN-ERROR）
- [ ] 4.3 通过真实 dsh 插件命令从受控 registry 安装带依赖 JS 插件、启用／运行、改配置、重启并移除；验证插件与配置分别写所选集合，运行包及其他集合哈希不变，两种架构均完成完整链路。（FBSD-PLUGIN-JS、FBSD-CONTEXT）
- [ ] 4.4 验收一个对应架构的 FreeBSD 原生插件／模块及一个声明不支持平台的负例；验证真实模块加载执行、错误平台／外部依赖诊断和失败后的状态保留，无用户编译产品随附模块或其他平台二进制 fallback。（FBSD-PLUGIN-NATIVE、FBSD-PLUGIN-ERROR）

## 5. 原生锁与真实持久化服务

- [ ] 5.1 对固定 app native/system 源及 package／flock 加载器补齐两架构 FreeBSD 构建、导出和打包；验证真实服务入口不再返回 ERR_FLOCK_UNSUPPORTED_PLATFORM，跨进程竞争和关闭后释放符合既有语义。（FBSD-SESSION）
- [ ] 5.2 接通真实会话持久化／租约与 runtime 使用保护；验证两个真实进程不能共同持有同一会话，正常与异常退出后恢复一致，运行中的 runtime／两类快照不能被清理。（FBSD-SESSION、FBSD-CONTEXT）
- [ ] 5.3 验证真实本地凭据服务的并发、原子写入和权限；用虚构记录验证并发更新无丢失、配置快照边界及共享 home 哨兵不变，日志不含凭据正文，不关闭文件锁。（FBSD-CREDENTIALS）

## 6. PTY、进程观察与文件搜索

- [ ] 6.1 从固定 node-pty 源构建并打包两架构 FreeBSD prebuild，接入现有 API；验证真实 dsh terminal 服务中的 sh／选择 shell、输入输出、resize、退出码通过，Bun.Terminal 独立探针不代替此测试。（FBSD-TERMINAL）
- [ ] 6.2 在现有进程检查桥接中实现 FreeBSD 本机字段查询与错误路径；验证真实前台子进程／后代观察、Ctrl-C、超时／取消和退出回收符合现有契约，观察错误不被报告为空闲或已成功取消。（FBSD-CANCEL）
- [ ] 6.3 明确 FreeBSD 可用执行能力与不支持隔离策略的拒绝路径；验证明确请求不可提供的隔离时在命令执行前失败，普通执行说明边界，未增加全新 sandbox 架构。（FBSD-POLICY）
- [ ] 6.4 从固定 ripgrep 源生成并校验本机两架构制品，接通实际 glob／grep 服务；验证匹配、无匹配、非法表达式、取消及空格／非 ASCII 文件名，不借用系统 rg 或 Linux ELF。（FBSD-SEARCH、RB-FBSD-NATIVE）

## 7. 全部随附 addon 与 Office WASM

- [ ] 7.1 按冻结的随附 addon 清单扩展 FreeBSD 发行元数据／平台选择，保持版本、slot 和使用保护；验证安装、选择、运行、path、错误 slot、活动删除拒绝及卸载，两架构没有遗漏 addon 或占位成功。（FBSD-ADDON）
- [ ] 7.2 对固定 Office 源适配 FreeBSD WASM 引擎解析、资源与内嵌执行入口，不更换依赖版本；验证真实 Office 插件能加载引擎并执行基础文档操作，不依赖系统 LibreOffice／Node，WASM 资源复用不掩盖本机组件架构。（FBSD-OFFICE）
- [ ] 7.3 适配 Office 字体发现及受控缓存／临时路径；验证显式字体、标准路径、缺字体诊断和非 ASCII 工作路径，重复执行不在全局 home 散写状态，资源不逃离指定目录。（FBSD-OFFICE-PATHS）
- [ ] 7.4 在两架构完成既有 Office 功能矩阵：Word／Excel／PowerPoint 文档及 PDF／图像输出；验证真实插件结果的文本、结构、页数／单元格和关键显示属性，保存实际输出证据而非伪造文件或逐字节时间戳比较。（FBSD-OFFICE）

## 8. 普通用户完整管理生命周期

- [ ] 8.1 在仅有管理器的普通用户环境执行交互首次启动及非交互／只读负例；验证补全选择与运行包安装顺序、受控源下载、真实 profile 启动和数据根归属，path 不触发初始化。（FBSD-BOOTSTRAP、FBSD-PATH）
- [ ] 8.2 执行安装 A/B、固定选择、独立 runtime update／self-update、失败回滚及活动对象保护；验证索引和产品版本互不绑定、选择不重置、旧内容和两类快照保留。（FBSD-UPDATES、FBSD-ATOMIC）
- [ ] 8.3 验收独立插件／配置快照的新建、复制、选择、删除／清理和显式外部 DSH_HOME；验证配置／凭据仅写 C、插件仅写 P、普通启动新默认与已有会话重启的上下文不同、计数与保护符合前置。（FBSD-CONTEXT、FBSD-CREDENTIALS）
- [ ] 8.4 卸载全部运行包后重装同一版本；验证解除固定／活动限制后操作允许，管理器仍可安装，原快照、会话、凭据及计数保留，不自动清理用户数据。（FBSD-UNINSTALL）
- [ ] 8.5 在空安装、有效组合、失效选择和离线状态验收 self/home/runtime/snapshot/addon/cache/tmp/completion 总览与 JSON；验证来源／冲突诊断、无写入／提示／下载／应用或 shell 执行、无敏感正文读取。（FBSD-PATH）
- [ ] 8.6 执行既有支持 shell 的生成、同意注册、重复注册、Tab 和修改后卸载；验证补全语法、离线查询、幂等与用户内容所有权，未新增 tcsh 格式或自动系统包安装。（FBSD-COMPLETION）
- [ ] 8.7 从软链接入口运行后停止会话，整体搬迁管理器及数据并封锁旧位置／断网；验证新位置真实 profile、插件、配置／凭据及 addon 仍可用，path 无旧根且不散写系统目录。（FBSD-MOVE）

## 9. 双架构发布门禁与平台回归

- [ ] 9.1 将完整真实制品场景接入固定 FreeBSD VM 的双架构 CI，与最低 ABI 和正式支持清单对应；验证普通用户矩阵记录完整哈希／命令／结果，无 root 探针、fake-native、skip 或另一架构替代。（DL-FBSD-MATRIX、DL-REAL-E2E、FBSD-NATIVE）
- [ ] 9.2 增加发布负向门禁，分别注入 ARM64／Office／锁／路径场景失败；验证任何必需项失败均阻止 FreeBSD 支持索引提升，不能发布半矩阵；管理器修复能组合已验收 runtime/addon，无需同步重发。（DL-FBSD-FAIL、DL-FBSD-MATRIX）
- [ ] 9.3 执行既有 Linux glibc/musl、macOS、Windows 及前置协议／包托管回归；验证同一运行包配不同兼容管理器、拒绝旧格式／旧配置协议、包拥有 self-update 和原有场景均保持，不为 FreeBSD 放宽公共保护。（RB-INDEPENDENT、RB-LEGACY、RB-CONFIG-PROTOCOL、DL-REAL-E2E）

## 10. 支持文档与验收交接

- [ ] 10.1 在现有文档／下载入口列明双架构 FreeBSD、最低 ABI 与实际受维护测试清单、系统库边界及插件外部依赖限制；验证链接只指新格式对应资产，不将 Bun 的 14.3 门槛改写为本项目 14.x 支持，不加入 pkg/ports 或迁移承诺。（FBSD-VERSION、FBSD-LIBC、FBSD-PLUGIN-ERROR）
- [ ] 10.2 汇总全部场景与候选制品的验收记录，区分历史可行性与本轮完整证据；验证未知／失败／跳过项均有清单，前置基线与源身份可复查，FreeBSD 未全绿就不申请支持发布；提交、发布、旧 release 删除和实验机操作仍需其各自授权。（DL-FBSD-MATRIX、DL-FBSD-FAIL）
