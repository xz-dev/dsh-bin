## Purpose

使管理器和 dsh 运行包分别发布而不互相驱动版本升级，并让系统包管理器只拥有管理器程序。定义新安装的完整性保证、发布前验收，以及从旧架构切换时清除旧发布和陈旧下载入口的可核对操作边界。

## ADDED Requirements

### Requirement: 两条独立发布与发现通道

管理器与运行包 SHALL 拥有独立版本、资产及类型明确的发现索引。管理器修复发布 MUST NOT 要求生成新的 dsh 运行包版本；运行包发布 MUST NOT 携带或替换管理器。首次安装、运行包 update 和管理器 self-update SHALL 查询各自的索引，不用仓库全局 Latest 推断另一种产品的最新版本。addon 身份归运行包生态，不依赖管理器版本。

#### Scenario: DL-MANAGER-ONLY 仅发布管理器修复
- **WHEN** 只修改管理器并发布新版本
- **THEN** 管理器更新可发现它，运行包索引和已发布运行包身份不变，首次应用安装仍下载运行包而非管理器资产

### Requirement: 下载验证与激活保护可用状态

管理器、运行包和 addon 的下载 SHALL 验证可信索引中的目标身份、大小、SHA-256 及内容要求，解包必须限制在预定目标内。弱网络重试 SHALL 支持安全的断点恢复、受限重试及 Retry-After；不受支持或不一致的 Range 响应不得被误拼接为有效文件。验证完成之前 MUST NOT 激活候选；失败不得破坏已有可用内容。生产发现源不得被普通应用配置悄悄重定向。

#### Scenario: DL-CORRUPT 候选校验失败
- **WHEN** 下载内容损坏或恢复下载与声明大小不一致
- **THEN** 候选不成为已安装版本，当前可用版本不变，重试或失败结果清楚可见

#### Scenario: DL-ESCAPE 拒绝越界归档
- **WHEN** 归档包含绝对路径、路径穿越或会导致写出目标范围的链接
- **THEN** 安装拒绝，数据根之外的文件保持不变

### Requirement: Gentoo 和 Scoop 只托管管理器

Gentoo/Scoop 包 SHALL 仅安装管理器、明确的托管标记和必要的系统入口/包元数据，不把 dsh 运行包或 addon 固定为该包的组成部分。托管管理器的 self-update SHALL 拒绝修改包拥有的程序并提示对应包管理器；运行包 install/update/uninstall、选择、快照和 addon 功能 SHALL 仍可由用户使用。卸载管理器包 MUST NOT 删除用户运行包或应用数据。

#### Scenario: DL-MANAGED-UPDATE 系统安装仍能管理 dsh
- **WHEN** 非特权用户通过 Gentoo 或 Scoop 安装管理器，随后请求安装 dsh 并创建快照
- **THEN** 操作在明确的用户数据根完成，不修改包拥有的程序目录

#### Scenario: DL-MANAGED-SELF 包拥有自身更新权
- **WHEN** 托管安装执行 `dsh manager self-update`
- **THEN** 在下载或替换管理器前拒绝，并给出对应包管理器的更新方式

#### Scenario: DL-MANAGED-REMOVE 移除包保留数据
- **WHEN** Gentoo 或 Scoop 卸载管理器包
- **THEN** 用户运行包、快照、凭据和会话保持不变

### Requirement: 发布必须通过真实制品验收

公开发布 SHALL 以对应平台的构建产物通过相关 BDD/E2E 为前提，而不是仅以单元测试或构建成功为依据。保留既有 Linux glibc/musl、macOS、Windows 运行包目标覆盖；管理器和运行包各自的发布可使用已验收的对方制品进行组合验证，不要求同时重发。下载端无需安装系统 JS runtime；测试驱动器的开发依赖不属于产品运行依赖。

#### Scenario: DL-REAL-E2E 新运行包组合验收
- **WHEN** 候选运行包进入发布门禁
- **THEN** 使用真实管理器、真实运行包、隔离用户目录和受控发行源验证安装、启动、插件快照及选版，并确认被测环境无需宿主 Node/Bun

### Requirement: 按冻结清单清除全部旧发布

正式切换 SHALL 先停止旧发布流程产生新旧架构资产，枚举并记录切换前全部旧 GitHub Releases（包括旧 release/live/addon 发布及其资产）与旧发现入口。新管理器、运行包、所需 addon、索引和包清单验收通过后，SHALL 以经操作者确认的固定 release ID/资产清单删除全部旧发布，并清除当前索引、Scoop 清单和文档中的旧下载引用。MUST NOT 使用会匹配新发布的动态“全部删除”查询；不包含用户本地数据、Git 历史或 Git 标签删除。

#### Scenario: DL-CUTOVER 切换后没有旧二进制下载入口
- **WHEN** 新发布验收完成且操作者确认旧发布删除清单后执行切换清理
- **THEN** 清单内旧 release/资产已移除，当前发现入口只返回新格式产物，清单外新发布保持完整，旧资产精确下载 URL 不再成功提供文件

#### Scenario: DL-CLEANUP-BLOCKED 删除受阻不绕过保护
- **WHEN** 认证、权限、发布不可变性或平台规则阻止删除清单中的某项
- **THEN** 停止该破坏性步骤并报告已完成与未完成项，不自动更换认证、不关闭保护、不谎报全部清理完成

### Requirement: 新格式切换不提供旧安装兼容迁移

本次分发 SHALL 仅支持新格式运行包，历史上游版本需要重新构建新格式后才能安装。MUST NOT 为本次切换实现旧包转换、用户数据自动迁移或迁移指南；旧发布清理不构成修改用户本地安装、凭据或快照的授权。

#### Scenario: DL-NO-MIGRATION 新安装不接管旧数据
- **WHEN** 用户在新位置放置新管理器，机器上还存在旧安装或旧 ~/.dsh
- **THEN** 管理器不自动扫描、转换或删除旧数据；只有用户显式提供的 DSH_HOME 被作为应用 home 使用
