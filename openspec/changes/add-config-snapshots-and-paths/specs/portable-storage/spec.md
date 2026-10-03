## MODIFIED Requirements

### Requirement: 默认应用数据与管理数据集中存放

默认情况下，管理器 SHALL 将运行包、addon、两类快照、选择、操作状态、受控缓存和临时文件放入数据根，并向受管理应用提供数据根内的 home。插件环境快照 SHALL 存于 `snapshots/`，配置与凭据快照 SHALL 存于 `config-snapshots/`，两者不是应用 home 的共享目录。管理器自有写入 MUST NOT 借用全局 Bun/pnpm 缓存或系统临时目录；经用户同意的 shell 注册是单独列明的外部集成例外。用户让应用修改的工作区文件、插件自行指定的外部文件不属于隔离保证。

#### Scenario: PS-CONTAIN 默认运行不散写应用状态
- **WHEN** 用户未设置 DSH_HOME，在隔离 HOME 中完成首次启动、插件安装、创建两类快照和再次启动
- **THEN** 管理器及受控运行路径产生的状态、两类快照、默认应用数据、缓存和下载残留均位于数据根，没有新建全局 `~/.dsh` 或 Bun/pnpm 数据目录
- **AND** 未同意 shell 注册时不修改 shell 配置

### Requirement: 显式应用 home 不改变管理数据根

非空显式 `DSH_HOME` SHALL 决定应用 home，沿用 tilde 展开及相对调用工作目录的解析语义；空白值 SHALL 使用默认 home。受管理启动中，被配置快照接管的配置与内建本地凭据 SHALL 读写管理器选定的配置根，MUST NOT 因 DSH_HOME 存在而改回共享文件。这一规则取代前置方案中 DSH_HOME 直接决定受管理配置、凭据及共享 profile 配置位置的规则。运行包、两类快照、addon、管理状态和管理缓存 SHALL 始终属于管理器数据根；非配置类应用数据仍使用应用 home 及应用自身允许的设置。路径查询 SHALL 区分这两个根与活动配置快照，并说明外部 home 不在整目录便携保证内。

#### Scenario: PS-OVERRIDE 使用外部应用 home
- **WHEN** 管理器位于 `/tools/dsh`，用户设置 `DSH_HOME=/data/my-dsh` 并选择配置快照 C
- **THEN** 应用 home 为 `/data/my-dsh`，插件环境及配置快照仍分别属于 `/tools/dsh-bin/snapshots/` 和 `/tools/dsh-bin/config-snapshots/`
- **AND** 应用配置和内建本地凭据使用 C；外部 home 中同名配置与凭据不被读取、导入、重命名或修改

### Requirement: 停止运行后可整体搬迁

未使用外部 home 的便携安装 SHALL 支持在兼容的平台上停止会话后，将管理器和其 `dsh-bin/` 一起移动，并在原位置不可访问时继续使用已有版本、选择、两类快照、插件和默认应用数据。管理器 MUST NOT 依赖旧位置的持久绝对路径。只移动二进制不带数据目录 SHALL 视为新的独立位置，不扫描并自动采用其他安装或旧 `~/.dsh`。用户显式配置的外部资源不自动迁移；内建本地凭据的显式路径仍必须满足配置快照的隔离边界。

#### Scenario: PS-MOVE 带插件的安装离线搬家
- **WHEN** 用户安装两个运行包和真实插件、保存并选择两类快照后停止会话，将整套内容从 `~/.config/dsh/` 移至 `~/.local/share/dsh/`，原位置不可访问且网络断开
- **THEN** 从新位置能够使用原选择、插件、配置、内建凭据和默认 home，path 查询返回新位置，管理器不读取或重建旧安装路径
