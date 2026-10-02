## Purpose

让 Bash、Zsh、Fish 和 PowerShell 用户能够发现管理器与所选 dsh 的命令及本地版本、快照信息。将 shell 注册与纯候选查询分离，确保补全不启动应用、不触发首次安装、不覆盖用户配置，也不泄露应用凭据。

## ADDED Requirements

### Requirement: 四种 shell 有明确注册接口

管理器 SHALL 为 Bash、Zsh、Fish、PowerShell 提供 `manager completion script <shell>`、`install <shell>` 和 `uninstall <shell>`。脚本生成 SHALL 只向标准输出提供对应 shell 可加载的内容，不修改文件。注册 SHALL 采用目标 shell 的用户级机制，不要求系统级写入、管理员权限或额外 JS runtime；不支持的 shell SHALL 明确报错而非生成其他 shell 的代码。

#### Scenario: SC-SHELLS 在真实 shell 中加载
- **WHEN** 每种受支持 shell 加载管理器生成的脚本
- **THEN** 能完成 `dsh manager` 的子命令和参数候选，不需要预先安装 dsh

### Requirement: 外部配置修改必须获得同意且可撤销

普通首次启动中的注册 SHALL 仅在用户同意已展示的 shell 和目标位置后执行；用户显式执行 install 也构成对该已指明目标的注册请求。管理器 MUST 保留其他配置和自定义补全，不覆盖非本工具所有的同名文件/内容。重复 install SHALL 不产生重复注册；uninstall SHALL 仅移除可确认由本工具创建且未被用户改写的内容，不删除整个 shell profile。shell 无法可靠识别时 SHALL 请求选择或给出显式命令，不能仅凭登录 shell 变量盲写。

#### Scenario: SC-IDEMPOTENT 注册和撤销只影响自身内容
- **WHEN** 用户在含自定义配置的 profile 上连续注册两次，再撤销
- **THEN** 只有一份 dsh 注册，撤销后原配置保留；遇到用户改写的注册内容时保留并提示手工处理

#### Scenario: SC-COLLISION 不接管已有自定义补全
- **WHEN** 注册位置已有用户自行编写的 dsh 补全
- **THEN** 管理器说明冲突并保持其内容，不自动覆盖

### Requirement: 明示生效范围与搬迁限制

注册结果 SHALL 说明如何在当前 shell 加载，以及在哪些新 shell 会话中自动生效，不声称子进程已经修改父 shell 的函数。通过 PATH 稳定入口注册时 SHALL 在查询时使用当前入口，不能固定旧数据根；绑定绝对命令路径且程序被移动后 SHALL 提供重新注册方式，不扫描用户文件系统寻找移动后的程序。

#### Scenario: SC-RELOCATE 稳定入口指向搬迁后安装
- **WHEN** 用户整体移动安装并将原 PATH 入口更新为新位置
- **THEN** 新 shell 的补全从新安装获取本地候选，不访问旧数据根

#### Scenario: SC-CURRENT 当前会话需要主动加载
- **WHEN** 注册命令作为独立进程写完用户级配置
- **THEN** 输出目标文件及当前会话加载方法，不将尚未加载的父 shell 宣称为已经启用

### Requirement: 候选查询只读且不执行任意输入

每次补全候选查询 SHALL 只读取本地状态与已有描述，MUST NOT 联网、安装或更新产品、创建数据根或快照、弹出询问、执行 dsh/插件或解释候选为 shell 代码。空安装和不存在的数据根 SHALL 返回可用管理命令或空候选。含空格、引号和非 ASCII 字符的命令路径 SHALL 正确处理，候选及用户输入不得产生命令注入，也不得输出凭据或完整敏感配置。

#### Scenario: SC-COLD 空安装按 Tab
- **WHEN** 用户在尚未普通运行过的安装上查询 `dsh manager` 补全
- **THEN** 得到管理候选，没有网络请求、应用子进程、询问或文件创建

#### Scenario: SC-LOCAL 本地快照候选及时更新
- **WHEN** 用户创建或删除一个快照后再次查询快照参数候选
- **THEN** 候选反映本地当前快照，不需重新注册 shell

#### Scenario: SC-QUOTING 路径和候选作为数据
- **WHEN** 命令路径包含空格或非 ASCII 字符，输入包含 shell 元字符
- **THEN** 补全仍定位正确管理器，元字符不会被执行

### Requirement: 应用命令知识随运行包变化

管理命令候选 SHALL 属于管理器；上游固定 CLI 的补全描述 SHALL 随对应运行包提供，管理器按此次命令的有效选择读取，不把所有上游版本的命令知识硬编码成管理器发布条件。缺少或不支持描述时 SHALL 保留管理补全和安全的空候选，不启动应用探测。不承诺执行插件来发现其运行时动态命令。

#### Scenario: SC-VERSIONS 选择旧运行包后补全随之变化
- **WHEN** 两个运行包携带不同的固定 CLI 描述，用户选择旧版本或以 --use 指定它
- **THEN** 应用参数候选使用旧运行包描述，管理命令候选不变，管理器无需降级或重发
