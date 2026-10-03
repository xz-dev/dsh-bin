## Context

动机与用户范围见 `proposal.md`。这是 `split-dsh-manager` 的后续规划，不是正在进行的拆分实施的一部分。当前主规格目录为空，前置变更尚在实施；本目录中的三组 MODIFIED 增量按前置同名规格的完整 requirement 块编写，必须在前置验收、归档后再次核对再使用，不能提前同步到主规格。

已核查的事实：

- `dsh-manager/src/context.zig` 将真实可执行文件、管理数据根与有效应用 home 分开解析；`state.zig` 使用数据根内的 `state/`。前置设计还规定了托管安装、cache、tmp 与补全注册。
- 既有 `dsh-bun-build/runtime/update/snapshot.ts` 区分自动建立与手动 new：手动默认复制有效版本的最新项，没有来源时报错；target 与 empty 是显式选择。列表具有 newest、selected、in-use 和 bundle-installed 等元数据。新 Zig 实现是实施基线，旧 TS 代码仅提供已存在行为的核查依据，不可拿来执行新管理操作。
- `dsh-bun-build/scripts/transform-app.mjs` 将插件 profile 与共享 `cordis.patch.yml` 分开；生成的 `cordis.yml` 留在插件侧，因为其目录是依赖解析基准。旧共享路径助手还会 mkdir，不能拿它实现只读查询。
- 已核查上游 `packages/settings/settings/src/index.ts`：settings 服务会将 `settings.yaml` 重命名为 `.imported` 再导入活动 profile。只改初始读取路径而漏掉 rename、导入写入或 watcher，隔离仍会失败。
- 已核查上游 `packages/credentials/credentials-local/src/index.ts`：默认 `.credentials.yaml`，支持显式 path 和 home 覆盖。仅设置 DSH_HOME 不能同时保持应用 home 和独立凭据集合。
- 上游 `home-paths` 定义应用默认 cache；会话 JSONL 后端接受配置的 root。管理器不能凭一个固定拼接式发现所有会话、日志或插件外部目录。

## Goals / Non-Goals

**Goals:**

- 以类型参数复用快照生命周期与选择规则，不复制两套管理政策；存储和内容仍独立。
- 使目录隔离落实到真实应用的读、写、导入、监视和重启，管理器不理解凭据格式。
- 将 path 做成位置不固定时的只读排障入口：解释解析依据和新启动的有效选择，不只是列库存。
- 把用户明确要求的新语义写为独立后续增量，不使另一 agent 的前置交付范围漂移。

**Non-Goals:**

- 不实现不可变备份、restore 覆盖共享目录、加密保险库、云同步或凭据格式转换器。
- 不把会话、插件依赖、缓存、addon 或管理状态一起塞进配置快照。
- 不提供旧耦合 bundle／旧无类型 snapshot 命令兼容，也不自动扫描或迁移旧共享 home。
- 不跟踪任意插件外部写入，不加载 shell/profile 来发现路径，不做 doctor 式执行探测或自动修复。
- 不在这次规划中修改代码、运行应用测试、注册 shell、发布或删除 release。

## Decisions

### D1. 独立变更与明确的规格覆盖顺序

采用独立的五个 capability 增量：新增 `configuration-snapshots`、`manager-paths`，修订前置的 `manager-control`、`portable-storage`、`runtime-bundles`。不直接编辑前置目录，也不把待归档 requirement 假装成已经发布的主规格。

| 前置约定 | 本变更后的限定 |
| --- | --- |
| 无类型 `manager snapshot new/list/remove` | 类型化 `snapshot plugins|config ...`，不增加旧别名 |
| `--snapshot` 选择插件环境 | 保留其含义，增加对等的 `--config-snapshot` |
| 受管理配置／凭据取应用 home | 改为所选配置快照；home 仍是非配置类应用数据根 |
| 运行包只接收一种 snapshot | 新协议显式接收 plugins 与 config 两个根 |
| runtime 保护一种 snapshot | 同时保护已选插件与配置快照，内部重启保留组合 |

选择此方式而非改写 `split-dsh-manager`，是为了保持并行工作的验收边界。实施前核对前置最终协议、字段和完整 requirement 块；若前置同名要求已改变，先在本 change 中调整增量并重新校验，不能在实施中悄悄裁掉前置场景。前置未验收归档，不开始本 change 的实施或规格同步。

### D2. 命名与命令形状

公开名称为“插件环境快照”和“配置快照”。`runtime` 留给 dsh 运行包，不再同时指插件目录。以下是本提案的接口选择，不是声称用户逐字指定或功能已实现：

```sh
dsh manager snapshot plugins new [--target <id-or-alias> | --empty] [--name <alias>]
dsh manager snapshot config new [--target <id-or-alias> | --empty] [--name <alias>]
dsh manager snapshot <plugins|config> list [--json]
dsh manager snapshot <plugins|config> remove <id-or-alias>...

dsh --use B manager snapshot config new --target A@1
dsh manager select --use B --snapshot A@2 --config-snapshot B@1
dsh --use B --snapshot A@2 --config-snapshot B@1 --profile tui
```

不采用两个冗长的顶层快照命令，也不让省略类型默认为 plugins。保留既有启动参数 `--snapshot` 的插件含义，而非再制造一个同义 `--plugin-snapshot`；新增配置参数表达第二个独立维度。

持久选择沿用前置 select 的整体设置语义，增加 `configSnapshot` 引用；未固定的类型按有效版本取其最新项。省略某一类型的固定引用不意味着复制另一类型的编号。示例用显式 `--use` 设置完整组合，不增加 restore／activate 命令。

单次选择的版本优先级为：显式 `--use` > 单次快照引用共同推导出的版本 > 持久 use/latest。两个显式快照来自不同版本而没有显式 --use 时拒绝。保持前置的单次上下文规则：提供单次运行包／快照覆盖时，未指定的快照维度按该次有效版本取最新项，不携带另一上下文的固定项；没有这些覆盖时使用持久组合。addon 规则不变。首个应用参数之后不再解析上述管理选项。

帮助和补全从同一命令声明获得类型、path 子命令和选项；候选 ID／别名按所在类型过滤，不能将 config 的候选混入 plugins。补全仍只读、离线。

### D3. 相同生命周期，两个存储实例

布局保持前置插件目录不动，只增加平行的配置存储：

```text
<管理数据根>/
  snapshots/<runtime-id>@<n>/           # 插件环境
  config-snapshots/<runtime-id>@<n>/    # 配置、内建本地凭据
    profiles/<name>/cordis.patch.yml
    settings.yaml                     # 若该应用版本仍有此文档
    settings.yaml.imported            # 若应用已经进行导入
    .credentials.yaml                 # 当前内建提供者默认文件
  state/selection.json                # 原字段 + configSnapshot
  home/                               # 默认应用 home，不是活动配置快照
  cache/
  tmp/
```

每个 store 使用前置快照存储的元数据、计数与维护锁机制；身份为 `(kind, id)`，不是单独的 id。源码中的具体元数据文件名以已验收的前置实现为准，不另造数据库。`selection.json` 的既有 `snapshot` 继续表示插件，`configSnapshot` 表示配置；缺少配置固定引用表示自动最新，不表示继续读共享 home。

| 操作 | 两类共同规则 |
| --- | --- |
| 自动建立 | 安装／启动缺少该类型快照时，按同一运行包排序找前驱最新同类型来源，无来源为空 |
| 普通 new | 复制有效版本的最新同类型项；缺失时报错，不悄悄改为 empty |
| target / empty / name | 同样的解析、互斥检查、别名校验、编号和来源记录 |
| 默认选择 | 有固定引用则使用它，否则取有效运行包版本的最新存留项 |
| 删除 | 同类型批量预检固定项与使用保护；失败不先删一部分，成功不重排或复用编号 |
| 所有项被删除 | 删除本身不生成替代项；安装／启动需要时才自动建立 |
| 卸载／重装 runtime | 两类集合、计数及凭据保留；重装不覆盖现有有效集合 |
| clean／self-update | 不移除有效集合、不改选择或配置正文 |

只复用小的 store／生命周期函数与 kind→root 映射，不设计通用插件式快照框架。配置复制使用独立文件或具有写时隔离语义的复制，不用可写硬链接。暂存、发布、计数与失败行为两类共用。

两类初始化独立提交；若一类完成而另一类失败，不启动缺少完整配置上下文的应用。重试复用已完成的一类，不为凑同号再创建一次。不得把失败的暂存目录枚举为有效快照。

无任何同类型前驱时配置集合为空，即使共享 home 已有旧配置也不自动导入。应用在所选空集合中自行生成默认配置或要求凭据；这避免保留一个暗中的全局配置来源。

### D4. DSH_HOME 与配置根分离，应用适配覆盖全部 I/O

用户明确选择配置快照归管理器所有，因此拒绝“放在应用 home/config-snapshots”的方案。路径为 `<管理数据根>/config-snapshots/`，固定不受 DSH_HOME 影响。

不把整个 DSH_HOME 指向配置快照：那会把会话和应用缓存一并切换，破坏独立集合的边界。薄适配只改变受支持的配置与凭据路径：

- profile 的插件目录、package.json、lockfile、node_modules、生成的 cordis.yml 仍在插件快照；用户 patch 读写／监视位置切换到配置快照。该映射是进程上下文，不通过改写插件快照里的公共配置链接或全局 current-config 指针实现；同一插件快照可被两个进程配合不同配置集合使用。
- settings 的旧文档读取、`.imported` 重命名、导入的后续 profile 写入均在所选配置集合。不能只改 readFile 而保留旧 rename 目标。
- 本地凭据的读取、原子写入、刷新与 watcher 使用配置根，权限及提供者本身的写锁保持有效。操作锁、临时写入文件不作为配置正文复制。
- 内建本地提供者的相对 path 在受管理模式下以配置根为基准；绝对 path 或显式 home 覆盖只有最终路径位于所选集合内才可使用。使用平台路径与现有祖先的规范化验证包含关系，不能只做字符串前缀比较；逃逸链接和其他快照根同样拒绝。
- 路径边界检查发生在凭据文件打开和 watcher 建立之前；拒绝时不读外部文件、不回退、不自动改写用户配置值。独立运行应用而没有管理器上下文时保持上游语义。

配置 store 是专门的配置树，不是对整个应用 home 做 glob 复制。当前已核查的配置与凭据文件及应用在该根内生成的后续配置文件属于集合；其他 profile 也必须包含。构建路径适配延续 `transform-app.mjs` 的受支持版本／站点核对方法，对新增或变化的已知配置路径失败关闭，不能发布只接管了一半读写点的运行包。

选择显式跨版本直用时，应用会真正操作那个被指定的集合，可能改变它的格式；管理器不悄悄复制。默认新版本自动继承得到的副本才提供“B 修改而 A 原集合保持不变”的保护。需要保留来源的显式跨版本试验使用 new --target，再选择新副本。

### D5. 用新启动协议表达真实能力

技术选择为将前置 `launchProtocol=1` 扩展为支持两个根的协议 2，而不是给协议 1 塞一个旧运行包会忽略的可选字段。运行包封装格式仍遵循前置的新格式，管理器版本仍与 dsh 上游版本解耦。

`DSH_MANAGER_LAUNCH` 协议 2 的关键部分：

```text
{
  protocol: 2,
  runtime, dataRoot, home,
  snapshot: { id, dir },        // 插件，保留原字段含义
  configSnapshot: { id, dir },  // 配置与内建本地凭据
  addons, cache, tmp, manager
}
```

数据根和 home 来自同一个管理器上下文；snapshot 身份与其路径必须匹配该类型的存储根。运行包薄适配验证载荷后，将两个根分别交给已核查的路径适配代码。环境桥接若需要，使用独立的 `DSH_BIN_CONFIG_SNAPSHOT_DIR`，由已验证的载荷设置，不允许原始环境变量绕过载荷验证。应用启动前选定位置，内部重启和受管理子上下文继承同一组合，不在运行包内实现快照选择策略。

管理器与 runtime 都拒绝不支持的协议或不完整载荷；旧协议运行包不能降级到共享配置后继续运行。path 和本地清单仍能报告它的位置／不兼容原因，不执行其入口。支持协议 2 后普通管理器修复仍无需重打包应用；仅不具备配置分离能力的旧适配需要重新构建。管理器发布索引的协议声明与构建矩阵需同步此能力，不以产品发行版本号相等做门禁。

运行时使用保护同时覆盖 runtime、插件快照与配置快照，保护键包含类型；持久引用保护和活动进程保护都必须覆盖 config。Windows 上不能依赖仍活着的管理器父进程代替 runtime 自身持有保护。

### D6. path 是只读位置解析与排障，不是启动准备

采用八个明确查询，不继续为每个内部文件扩展命令：

| 查询 | 返回范围 |
| --- | --- |
| 无参数 | 主要根目录、来源、安装模式，以及可只读解析的新启动有效组合 |
| self | 真实 executable、管理 data root、管理器配置／状态目录；state 不是 dsh 配置 |
| home | 有效应用 home、来源及显式相对值的 cwd 解析依据；不冒充活动配置根 |
| runtime [版本] | 所有已安装或匹配的本地运行包目录／身份 |
| snapshot [plugins\|config] [id-or-alias] | 两类存储根及匹配对象；指定对象必须先指定类型 |
| addon [名称[:版本]] | 本地名称、版本、slot 及目录 |
| cache | 管理器 cache、由有效应用 home 得到的应用默认 cache，以及上下文已确定的受控子路径 |
| tmp | 管理器临时工作根；不递归列出瞬时暂存内容或宣称均可删除 |
| completion [shell] | 注册记录中的脚本／接入文件与存在状态；未登记则未注册，不推测手工接入 |

新增路径查询调用共同的纯路径计算、本地元数据读取及只读选择解析，不调用 ensure/prepare/bootstrap，不打开会创建的维护锁，不调用旧 TS 路径助手，更不通过执行 dsh 获取信息。前置的可执行文件定位、托管标记和 DSH_HOME 解析只能有一份权威算法。把“解析已有状态”与“创建缺失对象”分开，使启动消费前者后再进入写入阶段，path 只使用前者。

总览的 effective 表示“这组参数下的新启动会采用什么”，不是“所有已运行会话正在使用什么”。既有会话仍保留冻结组合。支持以前置选择参数检查单次意图；版本或快照缺失时只说明无法形成组合，不预留下一个 ID、不输出尚未创建快照的假路径。

诊断区别包括：正常位置、尚未创建、无法读取、无效元数据、所有权／目录类型冲突，以及选择引用失效。普通空安装不视为损坏；明确目标不存在、冲突或必要查询不完整则非零退出。即使有效选择失败，静态根目录也可供排障，但输出标明不完整，不能换到 latest 或另一个根掩盖问题。所有权冲突的根不作为有效对象库存扫描来源。

人类输出默认带角色、绝对路径、状态和简短来源说明。JSON 使用一个结构（下列是字段契约，不是输出中的注释）：

```text
{
  schemaVersion: 1,
  scope,
  complete,
  records: [{ role, path, status, source, reason, kind?, id?, version?, slot? }],
  effective?: { status, runtime?, plugins?, config?, addons?, reason? },
  diagnostics: [{ code, role?, path?, message }]
}
```

无参数总览包含 effective；不需要选择上下文的 self/home 等查询不额外读取选择记录来制造无关错误。已知但未创建的静态根仍有绝对 path；确实无法确定的位置为 null，而不是猜测路径。状态值采用 `exists/not-created/missing/unreadable/invalid/conflict/unknown`；历史登记的文件消失用 missing，不能描述成从未创建。effective 区分 `resolved/empty/unresolved`。JSON 保持确定排序；非结构化诊断只写 stderr，结构化原因保留在 diagnostics 字段，stdout 不混杂提示或 ANSI。具体对象有独立身份，不能因为 plugins/config 同号而合并记录。

path 不读取配置／凭据或 shell rc 的正文；completion 仅查询登记记录和 stat，不能声称文件存在就证明当前 shell 已加载。若前置注册记录未保留具体目标，由本 change 的实施补齐后续注册记录；旧的路径不完整记录标为未知，不执行 shell 补全它。记录中的历史接入位置与搬家后计算出的管理器位置不一致时分别标注，不能把当前文件位置冒充当时注册的绑定。仅使用路径相关的必要输入，不转储所有环境变量。应用默认 cache 必须标为默认值；会话 root、插件日志、自定义凭据后端和手工 shell 接入无法从管理元数据确认时不报告成“实际已发现路径”。

### D7. 隐私、失败与共享行为验收

POSIX 的新配置根／暂存目录使用当前用户私有权限，敏感文件避免 group/other 访问；Windows 使用等效的当前用户受限访问控制。权限在写入凭据字节之前建立，失败则拒绝发布，不通过宽松权限继续。不能将敏感副本放入系统临时目录、异常正文或诊断 JSON。

复用同一参数化场景矩阵分别运行 plugins/config，验证编号、别名、来源排序、empty、target、latest 回落、保护、失败和重装。配置额外验收内容与权限，但不能因额外内容写出另一套生命周期政策。复制的原子可见性不等于应用多文件业务事务一致性；不引入在线全局冻结。检测到源变化或 I/O 失败时同样拒绝发布，严格时间点备份需要停止源应用写入。

BDD 分层：

1. Zig 纯选择、kind 身份和路径解析测试，测试期望不调用生产解析器生成。
2. 真实管理器进程 + 前置受控运行包／发行源 fixture，参数化两类生命周期、使用保护与失败注入；fake-native 只能证明协议及进程行为。
3. 真实新协议 Bun 运行包 + 真实插件、settings 服务和内建本地凭据提供者，写入专用测试数据并切换／回切。检查实际读写、settings 导入、凭据更新、插件解析和重启，不只检查环境变量或文件夹。
4. 可控格式改写 fixture 用于验证不同格式字节不相互覆盖；真实应用的 settings 导入及凭据服务读写另行验收，不把 fixture 声称为已经发现的上游凭据格式变更。
5. 对八类 path 使用隔离 HOME/cwd/PATH、禁网、不可执行的应用入口和子进程观察；比较前后目录、内容、计数及选择，忽略正常读取的 atime。敏感文件打开通过测试插桩／平台访问观察验证，不能只凭输出没有秘密就断言没读文件。
6. 比较只读 effective 与随后同参数真实启动的组合；覆盖真实软链接、原位置不可访问的搬家、外部／相对 DSH_HOME、Gentoo/Scoop 以及支持的系统路径语义。补全在四种真实 shell 的既有测试体系中验证，path completion 自身绝不启动 shell。

每个纵向切片先记录对应规格场景的真实 red 原因，再写最小实现获得 green。证据记录在本 change 的实施期 evidence.md；本次规划不生成虚假的 red/green 记录。

## Risks / Trade-offs

- [目录分开但读取仍走共享 home] → 覆盖读取、写入、导入 rename、watcher 与重启；真实提供者 E2E 配合共享 home 哨兵，协议不支持时拒绝启动。
- [默认继承保留旧版本，但显式跨版本直用会修改所选旧集合] → 帮助明确这一区别；不违反与插件快照相同的直用语义，也不暗中替用户复制。
- [凭据副本增加保留的敏感材料] → 私有权限、无正文诊断、显式删除与使用保护；不承诺磁盘加密、安全擦除或清理外部备份。
- [绝对自定义凭据路径在复制／搬家后失效] → 不改写用户配置；集合外路径明确拒绝，默认路径和集合内相对路径可随集合移动。
- [动态目录的查询被误当作文件搜集或修复命令] → 报告角色、来源和已知状态，未知不猜；不执行插件、shell、联网或初始化，缓存／tmp 查询不授权删除。
- [只读观测期间其他进程在修改库存] → 不建立写锁；对消失对象或不一致元数据返回明确的不完整诊断，不保证跨并发变更的全局事务视图。
- [前置变更还会演进] → 实施前核对已归档的完整 requirement、协议与接口；当前严格规划校验不能代替前置实施验收或证明增量已经可以归档。

## Migration Plan

这里是后续交付顺序，不是旧安装迁移指南；不增加迁移命令或兼容层。

1. 先完成并验收、归档 `split-dsh-manager`，校对本 change 的 MODIFIED 目标、全部保留场景及接口依赖，再重新严格校验本 change。
2. 用户明确启动本 change 的 apply 后，按 tasks 的 BDD 切片实施；在隔离布局构建支持协议 2 的真实运行包和管理器，不操作用户实际凭据。
3. 既有插件 store 不挪动；增加独立 config store。已有选择记录缺少 configSnapshot 时表示该类型自动最新；无来源时按统一规则为空，不把旧共享 home 当隐式来源或自动迁移。
4. 通过真实应用组合、保护、只读路径排障及平台测试后，更新帮助和文档。任何实际发布仍需单独授权，本变更不继承旧 release 删除授权。
5. 协议或验收失败时停止激活候选；保留已有运行包、快照与记录。不能回退到忽略配置根的旧协议继续使用相同数据，也不能删除配置副本来“修复”失败。
