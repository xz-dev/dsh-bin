## MODIFIED Requirements

### Requirement: 发布必须通过真实制品验收

公开发布 SHALL 以对应平台的构建产物通过相关 BDD/E2E 为前提，而不是仅以单元测试或构建成功为依据。保留既有 Linux glibc/musl、macOS、Windows 运行包目标覆盖，并增加 FreeBSD 15.x 的 amd64 与 ARM64。管理器和运行包各自的发布可以使用已验收的对方制品和匹配 addon 进行组合验证，不要求同时重发。下载端无需安装系统 JS runtime；测试驱动器的开发依赖不属于产品运行依赖。

FreeBSD 首版公开支持 SHALL 以两种架构的完整管理器、真实 dsh CLI／profile、插件安装运行、会话／凭据保护、终端、搜索和 addon（含 Office）的真实 FreeBSD 普通用户验收为门槛，并验证最低 ABI 与发布时受维护的支持版本。Linux 上的交叉编译、模拟平台字符串、root 下的独立组件探针或另一架构的结果 MUST NOT 替代此门禁。FreeBSD 矩阵失败时不得发布部分功能或单一架构作为已完成的双架构支持，不得通过关闭锁、放宽路径保护或删除失败场景达标；既有其他平台继续遵守各自门禁。

#### Scenario: DL-REAL-E2E 新运行包组合验收
- **WHEN** 候选运行包进入发布门禁
- **THEN** 使用真实管理器、真实运行包、隔离用户目录和受控发行源验证安装、启动、插件快照、配置快照及选版，并确认被测环境无需宿主 Node/Bun

#### Scenario: DL-FBSD-MATRIX 双架构完整产品才能进入支持清单
- **WHEN** FreeBSD 候选管理器、运行包与 Office addon 准备公开发布
- **THEN** 两种架构均在声明的真实 FreeBSD 环境中通过普通用户完整应用与管理链路验收，证据记录实际制品身份、ABI、环境、命令和结果
- **AND** 独立的管理器修复可以消费已验收的运行包／addon，不为凑同版本强制重发它们

#### Scenario: DL-FBSD-FAIL 不发布占位功能或半个矩阵
- **WHEN** ARM64、Office、会话互斥、终端或任一必需 FreeBSD 链路未通过
- **THEN** FreeBSD 支持发布门禁失败，候选可留作测试产物但不能进入已支持发现索引；此前已验收制品与其他平台不被破坏，未执行项目不得记录为通过
