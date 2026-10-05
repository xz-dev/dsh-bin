## MODIFIED Requirements

### Requirement: 独立管理入口

管理器 SHALL 独立提供 `dsh manager install/update/uninstall/list/select/snapshot/path/clean/self-update/completion` 和管理器帮助、版本查询。执行管理功能 MUST NOT 要求系统存在 Node/Bun、启动已安装的 dsh 或执行其中的管理代码。运行包损坏不得使管理器帮助、本地状态和路径查询或显式修复不可用。

#### Scenario: MC-EMPTY 空安装仍能管理
- **WHEN** 用户只有管理器文件、没有任何运行包，且 PATH 上没有 Node/Bun
- **THEN** `dsh manager --version` 和帮助成功，本地安装列表为空，用户能够执行显式安装
- **AND** 不出现“必须先安装旧 dsh 才能管理”的要求，path 查询不触发首次安装

#### Scenario: MC-BROKEN 损坏运行包可被独立修复
- **WHEN** 已安装运行包缺少入口，用户执行对应版本的显式强制重装
- **THEN** 管理器不执行损坏入口即可校验和重装，失败时保留可诊断状态

### Requirement: 管理命令与应用命令分离

管理器 SHALL 仅把独立的 `manager` 命令位置解释为管理命名空间；普通应用命令及其参数 MUST 原样交给选定 dsh。前置 `--use/--snapshot/--config-snapshot/--addon` SHALL 用于单次启动选择，遇到首个应用参数后不得继续解释同名选项。`--snapshot` 仅指插件环境快照，`--config-snapshot` 仅指配置快照。旧顶层管理命令不作为新版管理别名；`update self` 不再代表两种产品的共同更新。

#### Scenario: MC-NAMESPACE 管理入口不落入应用
- **WHEN** 用户执行 `dsh manager update`，所装应用也声明了名为 update 的命令
- **THEN** 仅管理器执行运行包更新，应用命令没有被调用

#### Scenario: MC-ARGS 应用参数不被误解析
- **WHEN** 用户执行 `dsh --use 0.2.0 --profile tui -p "manager update --use latest --config-snapshot A@1"`
- **THEN** 指定版本收到 `--profile` 起的原始参数，提示文本不会成为管理命令或配置快照选择

### Requirement: 快照与 addon 生命周期保持可控

管理器 SHALL 以 `manager snapshot <plugins|config> new|list|remove` 分别管理两类快照，类型必填，不提供无类型的旧管理子命令别名。两类快照均按运行包版本编号且编号永不复用，支持列出、命名、复制、空快照和删除，分别拥有独立内容、计数和选择。首次为一个版本建立某类快照 SHALL 按既有版本顺序复制前一版本最新同类型快照，无来源时创建空快照。配置及凭据不属于插件环境快照，而属于独立配置快照；管理器 MUST NOT 自动修复依赖或转换配置／凭据格式。

持久选择 SHALL 能同时指定独立的插件和配置快照引用；没有固定引用的类型使用有效运行包版本的最新同类型快照。单次前置 `--snapshot` 或 `--config-snapshot` 单独指定时 SHALL 隐含其所属版本，显式 `--use` 可以覆盖该版本。若两个单次显式快照引用属于不同版本且没有显式 `--use`，MUST 报歧义而非给某一类型隐含优先权。单次覆盖不得改写持久选择。office addon SHALL 保留兼容 slot、默认选择和显式选择规则。

#### Scenario: MC-SNAPSHOT 新版本继承插件而不修改来源
- **WHEN** A 的最新插件快照包含已安装插件，最新配置快照包含设置与凭据，用户安装 B
- **THEN** B 获得两份内容独立的同类型副本，A 的两个来源保持不变，不读取共享应用 home 代替配置来源

#### Scenario: MC-CROSS-SNAPSHOT 显式跨版本试运行
- **WHEN** 用户同时指定运行包 B 与 A 的某个插件或配置快照
- **THEN** 启动 B 并使用该指定快照，不悄悄复制、改选或替换快照

#### Scenario: MC-ADDON addon 管理不需要启动应用
- **WHEN** 用户通过管理器安装或卸载 office addon
- **THEN** 管理器校验其内容与兼容元数据并更新本地可见状态，不执行 dsh 来完成管理

#### Scenario: MC-TYPED 快照类型和选择不靠编号猜测
- **WHEN** 用户分别创建 plugins A@1 与 config A@1，并以两种独立参数选择它们
- **THEN** 两个引用解析到各自类型；新建其中一类不重置另一类的持久选择
- **AND** 缺少类型的 manager snapshot new 被拒绝并给出正确语法，不默认为某一类

#### Scenario: MC-CONFIG-SELECT 配置快照采用相同版本推导规则
- **WHEN** 用户仅以前置 --config-snapshot 指定属于 A 的 C，随后又用显式 --use B 与 C 组合启动
- **THEN** 第一次选择 A/C，第二次选择 B/C，未显式指定的插件快照按各自有效版本及单次选择规则解析，持久状态均不变

#### Scenario: MC-AMBIGUOUS 两个版本来源必须消歧
- **WHEN** 用户单次同时指定属于 A 的插件快照及属于 B 的配置快照，且没有显式 --use
- **THEN** 在启动应用前拒绝并提示指定运行包版本；明确 --use 后才采用该跨版本组合

### Requirement: 删除与清理保护实际使用状态

卸载运行包 SHALL 仅移除目标运行包，保留管理器、两类快照、选择记录、配置、凭据和会话；删除请求涉及正在使用或持久选择固定的对象时 SHALL 拒绝，批量预检失败不得先删除部分对象。管理器 SHALL 支持用户解除固定选择后卸载全部运行包的零运行包状态，不得仅因为某版本是最后一个运行包而拒绝卸载。重新安装同一运行包 SHALL 继续使用仍有效的已有两类快照与应用数据，不自动重置它们。清理 SHALL 离线且仅移除管理器自己的可回收缓存、临时下载和中断操作残留，MUST NOT 删除已安装运行包、任一类型的有效快照、配置或凭据。使用保护的范围是受管理的 dsh runtime 进程，不承诺跟踪所有独立子进程。

#### Scenario: MC-LAST 卸载最后一个未固定的闲置运行包
- **WHEN** 仅安装了 A，选择为 latest 且 A 未被使用，用户显式卸载 A
- **THEN** 卸载成功，两类快照和应用数据保留，管理器仍可管理空安装
- **AND** 下一次无显式版本选择的普通启动重新进入运行包自动安装流程

#### Scenario: MC-REINSTALL 清空运行包后重装仍使用原数据
- **WHEN** 用户将选择设为 latest、卸载全部闲置运行包，然后重新安装原版本 A
- **THEN** 管理器始终可用，原插件快照、配置快照、凭据和会话保持原样，A 可以继续使用它们
- **AND** 卸载及重装均不触发应用数据清理或任一类型快照的编号重置

#### Scenario: MC-IN-USE 使用中的快照不可删除
- **WHEN** 一次 dsh 会话及其实际支持的服务重挂载或内部进程重启仍使用插件快照 P 和配置快照 C，另一终端请求删除任一个
- **THEN** 删除失败并说明在使用中，P 和 C 的内容不因删除请求而改变

#### Scenario: MC-CLEAN 清理不等于卸载
- **WHEN** 存在运行包、两类有效快照和中断下载，用户执行 `dsh manager clean`
- **THEN** 可回收残留被清理，运行包、两类有效快照、凭据和应用数据保持不变

#### Scenario: MC-PINNED-CONFIG 配置固定项与批量删除受相同保护
- **WHEN** 某个配置快照被持久选择固定或被运行中的应用使用，用户批量删除它及另一个闲置配置快照
- **THEN** 整批删除在预检时拒绝，不先删除闲置项；解除保护后才可显式删除
