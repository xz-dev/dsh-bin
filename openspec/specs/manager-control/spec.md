# manager-control Specification

## Purpose

让用户无需先拥有可运行的 dsh 就能管理安装，并使管理器自身升级与 dsh 版本选择互不绑定。定义公开命令、版本与插件快照的管理行为，以及安装、更新、删除和运行过程不得破坏既有可用状态的约束。

## Requirements

### Requirement: 独立管理入口

管理器 SHALL 独立提供 `dsh manager install/update/uninstall/list/select/snapshot/clean/self-update/completion` 和管理器帮助、版本查询。执行管理功能 MUST NOT 要求系统存在 Node/Bun、启动已安装的 dsh 或执行其中的管理代码。运行包损坏不得使管理器帮助、本地状态查询或显式修复不可用。

#### Scenario: MC-EMPTY 空安装仍能管理
- **WHEN** 用户只有管理器文件、没有任何运行包，且 PATH 上没有 Node/Bun
- **THEN** `dsh manager --version` 和帮助成功，本地安装列表为空，用户能够执行显式安装
- **AND** 不出现“必须先安装旧 dsh 才能管理”的要求

#### Scenario: MC-BROKEN 损坏运行包可被独立修复
- **WHEN** 已安装运行包缺少入口，用户执行对应版本的显式强制重装
- **THEN** 管理器不执行损坏入口即可校验和重装，失败时保留可诊断状态

### Requirement: 管理命令与应用命令分离

管理器 SHALL 仅把独立的 `manager` 命令位置解释为管理命名空间；普通应用命令及其参数 MUST 原样交给选定 dsh。前置 `--use/--snapshot/--addon` SHALL 保留现有单次启动选择语义，遇到首个应用参数后不得继续解释同名选项。旧顶层管理命令不作为新版管理别名；`update self` 不再代表两种产品的共同更新。

#### Scenario: MC-NAMESPACE 管理入口不落入应用
- **WHEN** 用户执行 `dsh manager update`，所装应用也声明了名为 update 的命令
- **THEN** 仅管理器执行运行包更新，应用命令没有被调用

#### Scenario: MC-ARGS 应用参数不被误解析
- **WHEN** 用户执行 `dsh --use 0.2.0 --profile tui -p "manager update --use latest"`
- **THEN** 指定版本收到 `--profile` 起的原始参数，提示文本不会成为管理命令

### Requirement: 运行包版本与选择保持独立

管理器 SHALL 支持 release/live 渠道、多版本并存、精确版本或标签及无歧义前缀选择。`manager update` SHALL 安装当前渠道最新兼容运行包；仅显式 `--channel` 且安装成功后改变记录渠道。安装或更新 MUST NOT 重置持久选择，指定缺失或歧义版本 MUST 报错而非退回 latest。最新版本排序 SHALL 保留上游提交时间与运行包构建顺序的语义，不使用管理器版本排序。

#### Scenario: MC-PIN 更新不解除固定版本
- **WHEN** 用户固定运行包 A 后成功安装较新的 B
- **THEN** A 和 B 并存，普通启动仍选 A，管理器报告存在固定选择

#### Scenario: MC-CHANNEL 切换渠道失败
- **WHEN** 用户请求切换 live，但下载或验证失败
- **THEN** 已记录渠道和原运行包保持不变

### Requirement: 管理器更新只更新管理器

便携模式的 `dsh manager self-update` SHALL 从管理器发布线验证并更新自身，不下载、重打包或替换 dsh 运行包，不改变选择、快照或应用 home。安装旧运行包 MUST NOT 降级管理器。更新失败 MUST 保留可再次运行的管理器；不能因为启动协议号未变化就遗漏普通管理器修复。

#### Scenario: MC-SELF-ONLY 只升级管理器
- **WHEN** 管理器 M1 升级至相同启动协议的 M2，当前固定 A 和快照 S
- **THEN** 管理器报告 M2，A 的文件内容、S 的内容和持久选择保持不变

#### Scenario: MC-OLD-RUNTIME 安装旧 dsh 不回退管理器
- **WHEN** M2 安装用新格式重新构建的较旧上游 dsh
- **THEN** 该运行包可被选择，管理器仍为 M2

#### Scenario: MC-SELF-FAIL 自更新失败
- **WHEN** 候选管理器校验失败或替换步骤被中断
- **THEN** 已安装入口仍可启动旧或完整的新管理器，不留下不可执行的半成品入口

### Requirement: 快照与 addon 生命周期保持可控

管理器 SHALL 管理按运行包版本编号且编号永不复用的插件快照，支持列出、命名、复制、空快照和删除。首次为一个版本建立快照 SHALL 按现有版本顺序复制前一版本最新快照的全部插件运行文件；无来源时创建空快照。共享用户配置不属于快照；管理器 MUST NOT 自动修复依赖或代替 dsh 的插件安装。`--snapshot` 单独指定时隐含其版本，显式 `--use` 可以覆盖该版本。office addon SHALL 保留兼容 slot、默认选择和显式选择规则。

#### Scenario: MC-SNAPSHOT 新版本继承插件而不修改来源
- **WHEN** A 的最新快照包含已安装插件，用户安装 B
- **THEN** B 获得内容独立的首个快照，A 的快照不变，配置仍取同一应用 home

#### Scenario: MC-CROSS-SNAPSHOT 显式跨版本试运行
- **WHEN** 用户同时指定运行包 B 与 A 的某个快照
- **THEN** 启动 B 并使用该指定快照，不悄悄复制、改选或替换快照

#### Scenario: MC-ADDON addon 管理不需要启动应用
- **WHEN** 用户通过管理器安装或卸载 office addon
- **THEN** 管理器校验其内容与兼容元数据并更新本地可见状态，不执行 dsh 来完成管理

### Requirement: 删除与清理保护实际使用状态

卸载运行包 SHALL 仅移除目标运行包，保留管理器、快照、选择记录、配置、凭据和会话；删除请求涉及正在使用或持久选择固定的对象时 SHALL 拒绝，批量预检失败不得先删除部分对象。管理器 SHALL 支持用户解除固定选择后卸载全部运行包的零运行包状态，不得仅因为某版本是最后一个运行包而拒绝卸载。重新安装同一运行包 SHALL 继续使用仍有效的已有快照与应用数据，不自动重置它们。清理 SHALL 离线且仅移除管理器自己的可回收缓存、临时下载和中断操作残留，MUST NOT 删除已安装运行包、有效快照、共享配置或凭据。使用保护的范围是受管理的 dsh runtime 进程，不承诺跟踪所有独立子进程。

#### Scenario: MC-LAST 卸载最后一个未固定的闲置运行包
- **WHEN** 仅安装了 A，选择为 latest 且 A 未被使用，用户显式卸载 A
- **THEN** 卸载成功，快照和应用数据保留，管理器仍可管理空安装
- **AND** 下一次无显式版本选择的普通启动重新进入运行包自动安装流程

#### Scenario: MC-REINSTALL 清空运行包后重装仍使用原数据
- **WHEN** 用户将选择设为 latest、卸载全部闲置运行包，然后重新安装原版本 A
- **THEN** 管理器始终可用，原快照、配置、凭据和会话保持原样，A 可以继续使用它们
- **AND** 卸载及重装均不触发应用数据清理或快照编号重置

#### Scenario: MC-IN-USE 使用中的快照不可删除
- **WHEN** 一次 dsh 会话及其应用内重启仍使用快照 S，另一终端请求删除 S
- **THEN** 删除失败并说明在使用中，S 的内容不变

#### Scenario: MC-CLEAN 清理不等于卸载
- **WHEN** 存在运行包、有效快照和中断下载，用户执行 `dsh manager clean`
- **THEN** 可回收残留被清理，运行包、有效快照和应用数据保持不变
