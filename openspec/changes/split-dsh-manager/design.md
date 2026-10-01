## Context

动机见 `proposal.md`。以下是已核对的实现事实，而非新要求：

| 当前文件 | 对拆分有影响的事实 |
|---|---|
| `launcher/src/main.zig` | 已用 Zig 定位真实 executable、解析前置选择并启动进程，但管理命令仍运行最新已安装 bundle |
| `runtime/entry.ts`、`runtime/update/cli.ts` | 管理分发与安装、更新等策略被编入每份 `dsh-native` |
| `runtime/app.ts`、`runtime/snapshot/resolve.ts` | runtime 仍决定和创建快照；应用内重启继承环境并重新持有使用锁 |
| `scripts/transform-app.mjs` | 插件运行目录经过构建期适配；共享配置从快照路径向上两级推断，不能支持新的分离布局 |
| `runtime/layout.ts`、`runtime/selection.ts` | 安装、选择和应用 home 使用不同根；旧 bundle/launcher 协议为 2 |
| `scripts/local-build.mjs`、`assemble-bundle.mjs` | 每个运行包构建同时构建并携带 launcher，使用同一个发行身份 |
| `scripts/e2e.mjs`、`test/update-contract/` | 已有真实进程、隔离 HOME、本地发行源、无宿主 JS runtime 的可复用验收方法 |
| Gentoo/Scoop 模板与安装文档 | 旧包管理器拥有整个 dsh，禁止用户自行选版/更新；本次明确改为只拥有管理器 |

已确认的产品决定是：纯 Zig 独立管理器、完整默认便携、`manager` 命名空间、首次先问补全再检查/自动安装 release、两业务目录及根 `desc/openspec/`、尊重显式 DSH_HOME、新格式且不迁移、Gentoo/Scoop 只托管管理器、清除全部旧发布，以及允许卸载所有运行时而保留数据。下文的目录内名称、协议字段和验收组织是用于实现的技术选择，不冒充用户逐项指定。

## Goals / Non-Goals

**Goals:**
- 切断管理操作对任意 dsh 进程、上游源码与 Bun 构建产物的依赖。
- 用一个集中解析的安装上下文驱动路径和权限，避免各模块分别猜测 HOME 或程序位置。
- 用真实制品的行为测试验证拆分，不以代码搬家或脚本输出存在作为完成证据。

**Non-Goals:**
- 不重写上游 dsh，不承诺消除 Bun 兼容或插件路径适配。
- 不支持旧 bundle，不转换旧数据，不编写迁移指南，不操作用户当前安装。
- 不实现通用 Gherkin 引擎、插件依赖修复器、后台守护服务或所有子进程的文件占用追踪。
- 不承诺跨操作系统搬迁运行包、运行中搬家、自动追踪硬链接的“原始位置”，或重写用户插件的任意外部绝对路径。

## Decisions

### D1. 两个项目独立构建，以制品相连

```
repo/
|-- dsh-manager/       # Zig source, build.zig, tests, owned scripts/packaging
|-- dsh-bun-build/     # package.json, scripts, runtime adapter, tests
|-- desc/             # shared user/developer docs, en/ and zh-CN/
|-- openspec/
|-- .github/workflows/
|-- README.md
+-- LICENSE
```

`launcher/` 是管理器代码起点。`runtime/update/`、snapshot store/selection 等管理策略移植为 Zig，不继续让管理器调用 TypeScript 完成实际工作。运行包侧保留 `runtime/app.ts` 中必要的环境消费、Bun compat、插件加载和进程使用锁适配；移除管理命令入口和快照决策。

业务脚本分别放所属项目；包管理器的管理器包装/发布脚本属于 `dsh-manager/`，Bun 构建和 addon 脚本属于 `dsh-bun-build/`。当前根 `install.sh` 旧架构入口退役，用户入口改为下载管理器单文件；不为了延续旧脚本再保留根级脚本。`docs/` 在实施时移为 `desc/` 并修复链接。

管理器编译沿用当前 Zig 0.15.2 作为初始工具链；独立 `zig build` 不要求 Bun。测试驱动器可以复用现有 Bun 测试设施，这只是开发依赖。运行包构建不再调用 `buildLauncher`，也不导入管理器实现；不新增根 common 库把两边重新耦合。相比两边共用运行时源码，版本化数据协议更适合不同语言与独立发布。

### D2. 一次解析安装上下文

管理器在处理需要状态的命令时统一得到：程序路径、安装模式、数据根、应用 home、平台/架构、包拥有者。数据根不由任意子模块重新计算。

| 模式 | 数据根 |
|---|---|
| 普通单文件下载 | `dirname(real executable)/dsh-bin` |
| Gentoo 明确托管 | 绝对 `$XDG_DATA_HOME/dsh-bin`，否则 `~/.local/share/dsh-bin` |
| Scoop 明确托管 | `%LOCALAPPDATA%/dsh-bin` |

托管模式由包安装在真实程序目录内的只读 `.dsh-manager-install.json` 声明（格式版本与 `owner=portage|scoop`），不是由写权限失败推断。普通下载没有该文件即是便携模式；未知/损坏标记报错，不悄悄转成另一模式。包标记属于包内容，不是用户状态。

数据根内布局：

```
dsh-bin/
|-- bundles/<runtime-id>/
|-- addons/<name>/<addon-id>/
|-- snapshots/<runtime-id>@<n>/
|-- home/                         # default DSH_HOME
|-- cache/                        # downloads, transpiler, pnpm caches
|-- state/                        # selection, channel, counters, shell choices
+-- tmp/                          # staging, recoverable update/cleanup work
```

管理器在原始 cwd 下解析显式 DSH_HOME；非空值沿用现有 `~`/相对路径语义，否则取 `data-root/home`。DSH_HOME 不改变运行包、快照和管理缓存归属。默认运行时的已知 Bun/pnpm 缓存和临时文件路径由启动环境指向数据根；不全局改写用户 HOME，也不把工作区文件当缓存收走。外部 DSH_HOME 是用户明确选择的便携例外，不自动拷回内部。

管理状态只持久化 ID、相对路径与必要的外部用户设置；启动时生成的绝对路径不作为可跨搬迁复用的管理状态。锁与原子状态文件也在数据根内。禁止把未识别的同名已有目录直接当作可清理安装；拒绝冲突，避免意外采用旧数据。

### D3. 新运行包格式与启动协议

采用带产品种类的独立新格式，不兼容旧 schema-2 耦合归档：
- `bundle.json`：`kind=dsh-runtime`、`schemaVersion=1`、运行包 ID/上游版本与 commit、构建顺序、target、`launchProtocol=1`、入口、required paths、addon slot。
- 归档根只包含一个运行包的内容（`bundle.json`、`dsh-native`、`app/`、`pnpm/`、`bin/`、可选只读预热缓存和固定 CLI 描述），由管理器安装到 `bundles/<id>/`，不携带 manager 或 `bundles/` 外层安装树。
- 启动上下文继续通过一个明确带 protocol 的环境载荷传递，使用 `DSH_MANAGER_LAUNCH`，字段覆盖运行包 ID、数据根、应用 home、已解析快照、addon 路径和缓存位置。字段中的绝对路径仅服务本次进程树。
- runtime 仅验证/消费这些位置，不访问发行源、不读默认选择来改选、不创建快照。没有管理器上下文时可以作为独立应用按上游规则运行，但不享有管理器的便携与快照保证；损坏的上下文不能被当作“没有上下文”回退。

更新 `transform-app.mjs` 的 profile 适配，使共享 `cordis.patch.yml` 从明确应用 home 获取，而不是通过 `snapshot/../../profiles` 推导。`cordis.yml`、package/lock 文件、node_modules 等插件运行文件仍在快照中。当前 node/pnpm shims 已按自身相对路径找到内嵌 runtime，保留这一可重定位方式。

应用内重启继承已解析上下文，runtime 重新持有对应对象的共享使用锁，不重新运行管理策略；POSIX exec 继承与 Windows 等待/子进程保护按现有实际能力实现。保护范围保持为受管理 runtime 进程，不扩大成任意后代进程追踪。

固定 CLI 描述采用版本化 `completion.json` 数据。构建侧从该上游版本的固定命令声明导出，并与对应制品的命令/帮助做一致性检查；不在 manager 中维护各版本的大型硬编码词典，也不在按 Tab 时启动应用。仅描述固定 CLI，不加载 profile/plugin 来发现动态命令。

### D4. 命令路由先于自举

先解析前置运行选择，再区分以下入口：
1. `manager …`：原生管理路径；不需要运行包，也不进入首次启动询问。
2. 顶层只读帮助/版本：从管理器和已安装运行包元数据提供信息；没有应用时明确显示未安装，不自动下载。`--profile … --help` 是应用调用，不混同顶层帮助。
3. 补全生成/私有候选查询：严格只读、离线，不创建数据根或启动应用。
4. 普通应用调用：执行补全询问、自举判断、选择解析和启动。

普通交互的顺序为：确保本安装可以保存必要状态 → 读取本安装补全选择 → 如未选择则展示 shell/目标位置并询问 → 完成注册尝试或记录拒绝 → 检查运行包 → 真正空安装且无显式/固定选择时安装已记录渠道的最新兼容版本（无记录时默认 release） → 解析/准备快照 → 启动。

非交互不消费 stdin、不记录为拒绝，空安装仍自动下载；之后第一次交互仍能询问。注册失败记录为失败而非已启用，给显式修复入口但不阻断安装。一次完成的选择不在每次启动重复询问。用户输入是 shell 选择与注册同意，不是再次询问是否下载。

5.1 经用户确认的实现选择：仅 stdin 与 stderr 都为 TTY 时询问；Linux/Windows 最多向上查三个祖先进程识别 bash/zsh/fish/pwsh/powershell（Windows 去掉 .exe），POSIX 可用 `$SHELL` 作待确认提示，macOS 本轮不做祖先查询。识别到 shell 时展示原有 resolver 的目标并询问 `[Y/n/o]`（Enter/y/yes 同意，n/no 拒绝，o 打开列出平台可用 shell 与目标的菜单）；未识别时直接菜单，选 shell 即同意已展示目标，空输入/skip 拒绝。`state/completion.json` 为 `{schema:1,shells:{<shell>:{result:registered|declined|failed}},undetected?:{result:...}}`，每个 shell 只问一次；未识别菜单还记录 undetected；已识别 X 改选 Y 时保存 Y 的结果并记 X 为 declined，skip 只记 X declined。EOF 不存选择；无效状态报错，不悄悄覆盖；原子写入，不在等待用户时持锁；失败给显式补全安装重试命令，继续原运行包检查。

旧限制不能自动继承。用户已确认零运行包是正常状态，因此删除“最后一个运行包”数量限制；保留正在使用、固定选择和批量预检保护。解除固定选择后可以卸载全部运行包；只删除 runtime 目录，不清理快照、home 或管理状态。重新安装原版本复用有效快照与数据；下一次无固定选择的普通启动也可以自举。

### D5. 原生管理操作与失败边界

将现有版本匹配、渠道、快照计数/复制/删除、addon slot、下载重试、归档校验、更新锁和 cleanup 行为移入管理器。采用 Zig 标准库和必要 OS API；不通过 Bun、Node、curl、unzip 或 PowerShell 代替管理实现。

从 host OS/arch/libc/CPU 选择运行包 target，不依赖“正在运行 bundle”的元数据。下载先落数据根缓存/临时区，验证索引身份、大小、SHA-256、required paths、协议与归档边界后激活；安全处理 Range、Retry-After、中断和并发。候选路径、链接和删除目标都限制在所属存储内。使用中对象拒绝替换，不把忽略锁错误当作成功。

运行包和 addon 更新使用同卷暂存与原子激活；选择与渠道状态原子写入，失败不先切换。创建快照完成后再发布其元数据，编号计数不能因删除而回退。重装已存在版本不重置已有快照，管理器不运行 pnpm 自动修复它们。清理仅针对本工具可识别且可独占的残留与缓存，不自动删除有效用户数据。

6.6 经 supervisor 确认：clean 在任何维护锁/快照锁/会话 claim 忙时整次拒绝、零删除；`.previous-*` 仅在对应公开 generation 完整有效时可回收，否则保留并提示显式 install 恢复，显式 addon install 同 runtime 一样先恢复已校验的中断退役副本。

HTTPS 下载支持 `HTTPS_PROXY/https_proxy`（以及 `ALL_PROXY/all_proxy`）指向 HTTP 代理：先发送 `CONNECT <origin-host>:<port> HTTP/1.1`，有 URL userinfo 时仅在 CONNECT 中携带解码后的 Basic 代理认证；只有 2xx 才在同一 socket 上用 Zig 标准 TLS Client 验证 origin 的证书链、主机名与 SNI，再发送 GET。`NO_PROXY/no_proxy` 按逗号列表、域名边界后缀、`*` 和可选端口匹配（无端口时匹配全部端口，支持 localhost）；每个手动重定向重新判断。CONNECT 前即设置读写 inactivity timeout，Windows 同步 socket adapter 覆盖 CONNECT、隧道 TLS 握手和 body。403/407 为不重试的代理拒绝，认证/证书错误不会退回直连；`https://` 代理 URL（TLS 到代理自身）仍明确拒绝，不静默直连。Zig 0.15.2 的 `Connection.Tls` 不公开且 CONNECT 不升级 TLS，因此内部连接复制其两个字段及分配布局，交由标准 HTTP Request/TLS 负责读写和销毁；编译期锁定 0.15.2，工具链升级必须复核布局。此 inactivity 约束不是 DNS/TCP 建连或直连 TLS 的总 deadline。

管理器自更新走独立索引，按自身版本比较，而不是仅按启动协议号决定是否换文件。POSIX 使用校验后的同卷替换；Windows 使用同一 Zig 程序的一次性临时 helper 等待旧进程释放映像后替换，helper 带原安装上下文，不能按自身临时位置建立另一个数据根。交接不等于升级成功；只有替换完成才报告成功。临时 helper 不成为第二个分发产品，所有残留可在数据根内恢复/清理。若目标文件系统无法保证完整入口则停止，不使用先删除入口再复制的降级方案。

### D6. 补全是本地查询，注册是外部集成

公开接口固定为 `manager completion script|install|uninstall <shell>`（install/uninstall 也接受 `--shell <shell>`）；shell 的薄钩子调用管理器私有候选接口，输入命令词和光标位置均作为数据。当前 Bash/Zsh 通过 `manager __complete --shell <shell> -- <words...>` 查询：words 不含命令路径，截到光标所在词且保留末尾空词；不解释输入。候选来自管理命令声明、安装/快照/addon 状态及有效运行包的 `completion.json`。未知描述或缺少运行包只减少应用候选，不触发修复/联网。

Bash 注册为 `$HOME/.bashrc` 标记块，Zsh 注册为 `${ZDOTDIR:-$HOME}/.zshrc` 标记块；Zsh 仅在 compdef 尚不存在时运行 `compinit -D -i`，已初始化时不重跑。块记录目标文件原先是否存在，撤销恢复原字节或删除仅由注册创建的空 rc；标记/内容被修改则保留并提示手工处理。片段加载时也检查已注册的 foreign completion。注册/生成时以 Zig 查询 PATH 的首个 dsh（Windows 用 PATHEXT）并解析 realpath：与当前真实 exe 相同时绑定 name:dsh，否则绑定 abs:<path>；v2 所有权标记保存绑定与 existing/created，并以 SHA-256 检查整块精确模板（含 ownership/binding，不含 checksum 自己）未被改写后才可搬迁后刷新或撤销；创建的空文件可撤销，父目录一律保留，绝对绑定提示重新注册，查询缺入口时静默无候选，不扫描文件系统。

Bash 使用 complete，Zsh 使用 compdef/fpath 并尊重现有 compinit 顺序，Fish 使用用户 completion 目录，PowerShell 使用用户 profile 的原生 completer。注册前列出目标，不仅凭 `$SHELL` 猜测；不确定时让用户选择。保留用户自定义补全，不覆盖非本工具内容。生成片段带所有权标记；重复 install 幂等，uninstall 仅移除仍可确认归本工具所有且未被用户修改的内容。

稳定 PATH 名称或软链接在查询时解析，不保存旧数据根。无稳定入口而按绝对路径注册的用户，移动后需要显式重新注册；不做全盘搜寻。注册命令不能修改父 shell 函数，必须说明新会话生效及当前会话加载方式。默认安装不偷偷建立 PATH 链接，这仍是用户选择。

候选和 bundle 描述不能成为 eval 的输入；元字符、引号、空格、非 ASCII 路径做真实 shell 测试。脚本由本地管理器的受信模板生成，不直接执行下载的任意 shell 代码。

### D7. 托管只限制管理器自身

Gentoo/Scoop 安装与普通下载相同的管理器产物，附加托管标记和包入口；不捆绑 dsh，不固定用户 runtime 版本。托管 self-update 在下载前拒绝并提示包更新命令，其余管理功能可用。包升级/卸载不清理用户数据根，Scoop 版本目录变化不能改变该用户的数据根。

现有 Gentoo ebuild/Scoop dsh 清单改为管理器包；旧 dsh-live/dsh-office 分发入口退出新体系，由 `manager update --channel live` 和 addon 命令承担对应运行内容管理。不会保留旧“包管理器拥有 runtime 所以禁止 --use/安装”的规则。

### D8. 独立发布与清理旧体系

管理器使用自身版本及独立 tag 家族，运行包使用上游身份加运行包构建修订，元数据记录 builder commit 而非“管理器版本”。发布分为 `manager-index.json` 和 `runtime-index.json`；后者包含 release/live 及 addon 引用。各索引独立更新且发布先验证资产完整性；全局 GitHub Latest 只用于展示，运行包发现不依赖它。

CI 分开筛选 manager 与 build/runtime 变更。组合测试显式选已验收的对方制品；一次 manager 修复不能触发全量上游重建，一次 runtime 构建不能重新编译 manager 来掩盖协议不兼容。沿用发布完整性/构建证明措施，不以拆分为理由降低信任要求。

用户要求清除旧发布，而不是做旧版兼容。清理集合来自停用旧自动发布之后的冻结 release ID/资产清单，包含旧 release/live/addon。新体系不能引用即将删除的旧 addon URL，所需 addon 要有新发布。切换清理不删除 Git 标签/历史或用户本地文件；不可逆删除前再次展示精确范围并取得执行确认。

### D9. BDD 先于每个纵向切片，E2E 验证真实入口

每个切片先确认规格中的具体场景，通过公开进程/文件结果/HTTP 请求/真实 shell 展示预期原因的 red，再实现最小 green。场景 ID 进入测试名称和验收记录；不强制引入 Cucumber，不自造 Gherkin 解析器。

- 快速层：Zig 的解析、选择、路径和格式测试；测试数据不直接复用生产实现计算期望结果。
- 管理器黑盒层：借用现有 update-contract 的受控源和失败注入思路，运行真实 Zig 二进制，使用隔离 HOME、cwd、PATH 与数据根；不调用旧 TS updater 替被测程序完成操作。
- 应用组合层：真实 Bun 运行包与真实插件，验证配置/快照分离、复制、重启和离线搬家；原路径需实际不可访问，不能只比较拼接字符串。
- shell 层：真实 Bash/Zsh/Fish/PowerShell 加载和候选查询，验证首次询问顺序、重复注册、拒绝/失败、卸载保护和注入边界。
- 分发层：原目标矩阵、非特权 Gentoo 安装及 Windows Scoop 安装/升级/卸载；发布清理先在隔离测试仓库或发布 API fixture 验证，最终对精确生产清单操作。

### D10. 实施契约（技术选择）

以下是实现时固定的格式与名称，供两边项目与测试共同引用；它们不新增用户可见需求。

**数据根布局与所有权**：数据根内 `.dsh-bin-data.json`（`{"kind":"dsh-manager-data","schema":1}`）是所有权标记。首次写入时，数据根不存在或为空目录才会创建并写标记；已有非空目录而无标记、或同名为文件，均报冲突。管理状态放在 `state/`：`selection.json`（`{schema:1,use,snapshot,addons}`，与旧格式同形）、`channel`、`completion.json`（每个 shell 的选择及结果）、`manager.lock`（维护互斥）。快照计数与快照锁在 `snapshots/.counters.json`、`snapshots/.lock`。

首次写入未初始化数据根时，FB-CONCURRENT 允许后到进程明确报初始化竞争/中断并退出、提示重试；按用户决定不新增锁、等待或自动修复，非空无标记目录仍不接管。

**运行包 `bundle.json` v1**：`kind="dsh-runtime"`、`schemaVersion=1`、`id`、`channel`、`target`、`upstream{commit,commitTime,tag?,version}`、`run`、`attempt`、`builderCommit`、`launchProtocol=1`、`entry`（相对路径，如 `dsh-native`）、`requiredPaths`（相对运行包根）、`addons.office{slot,pinned,known}`。归档根就是运行包根。管理器以 `commitTime`→`run`→`attempt` 排序。任何缺 `kind`/`schemaVersion`，或含 `launcherProtocol`/`bundles/` 外层的归档都视为旧格式。

**`completion.json` v1**：运行包根固定路径，列入 bundle.json.requiredPaths；`{schemaVersion:1,commands:[{name:"",options:[{names:["-V","--version"],takesValue:false},...]},{name:"plugin",options:[...]}]}`。空 name 是根命令，其余为固定子命令；数据不含 help 文本、profile/plugin 内容或 shell 代码。构建器静态读取已部署的 `app/lib/bin.js` 中 literal Commander command/option/version 声明，不能识别的声明使构建失败；不导入应用。管理器仅接受 v1，按既有 `select.resolve` 的 `--use` → `--snapshot` → 默认 selection/channel 规则读取对应描述。

**`DSH_MANAGER_LAUNCH`**：JSON `{protocol:1, runtime, dataRoot, home, snapshot:{id,dir}, addons:{office?:{version,dir}}, cache, tmp, manager}`。管理器同时导出 `DSH_HOME=<home>`，并将 Bun/pnpm 缓存与 `TMPDIR`/`TEMP`/`TMP` 指向数据根。runtime 把 `snapshot.dir` 作为插件运行目录；共享 `cordis.patch.yml` 取 `$DSH_HOME/profiles/<name>`。应用内重启继承同一载荷。载荷缺失时按上游规则独立运行；载荷存在但无效时报错退出。

**发布身份**：运行包 tag 为 `runtime-v<upstream>-b<run>.<attempt>.g<sha8>`（release）和 `runtime-live-<sha7>-b<run>.<attempt>.g<sha8>`（live）；运行包 ID 去掉 `runtime-v`/`runtime-` 前缀。addon tag 为 `addon-office-v<kit>-b<run>.<attempt>.g<sha8>`，管理器 tag 为 `manager-v<semver>`。新 tag 家族与旧 `dsh-v*`/`dsh-live-*`/`dsh-addon-*` 不重叠，旧 Git 标签得以保留。索引位于 `releases` 分支：`runtime-index.json`（`{schema:1, channels:{release,live}, addons:{office}}`）和 `manager-index.json`（`{schema:1, versions:[{version,tag,launchProtocols,assets}]}`）。受控测试源仅在 `DSH_MANAGER_TEST=1` 与 `DSH_MANAGER_TEST_ORIGIN` 同时存在时生效，沿用旧 updater 的约束。`DSH_MANAGER_TEST_CA_FILE` 仅在 `DSH_MANAGER_TEST=1` 时把指定 PEM CA 加入本 client 已扫描的系统根，用于本地 HTTPS/CONNECT fixture；生产忽略此变量，始终验证系统 CA 与 origin 主机名，不提供跳过证书校验选项。

**管理器目标**：管理器是不链接 libc 的静态 Zig 程序，发布 `linux-x64`、`linux-arm64`、`darwin-x64`、`darwin-arm64`、`windows-x64`、`windows-arm64` 六个资产。运行包 target（glibc/musl、baseline/modern）由管理器在运行时检测，不由管理器资产名决定。

**`dsh manager` 命令面**：`--help|--version|help|version`、`info`、`install <version>|--addon office[:v] [--channel] [--force]`、`update [--channel] [--force]`、`uninstall <version>...|--addon office[:v]`、`list [--available] [--json]`（默认只读本地，`--available` 才访问索引）、`select [--use] [--snapshot] [--addon]`、`snapshot new|remove|list`、`clean`、`self-update`、`completion script|install|uninstall <shell>`；私有候选接口为 `manager __complete`。

选择状态移植（6.1，经 supervisor 确认）：`manager select` 无参数只读显示，写入必须给 `--use <version|latest>`，可选 `--snapshot` 仅解析已有编号或 `snapshot.json.alias` 名称并在保存前校验，省略则重置为 null；普通启动消费已存快照，前置 `--use/--snapshot` 覆盖默认、已存快照缺失明确失败，`use=latest` 加已存跨版本快照不固定运行包且卸载全部后仍按记录渠道回装并复用该快照。

快照移植（6.2，经 supervisor 确认）：`snapshot new [--use <version>] [--target <snapshot>|--empty] [--name <alias>]` 只保留既有 `--target` 拼写；复制仅限 `profiles`，文件独立复制、内部相对符号链接原样保留，绝对或越界链接明确拒绝并丢弃暂存，不执行 pnpm 修复。已发布快照的普通启动不取存储互斥；只有首次创建和管理变更取 fail-fast 锁，首次创建竞争可给明确 Busy/retry 诊断，不新增等待或恢复机制。

Office addon 移植（6.3，经 supervisor 确认）：无选择时离线使用最高 seq 的已安装同 slot 版本，显式/已存不兼容或缺失版本降级并给一次 stderr 提示；`--force` 仅替换、不越过 slot，`select` 仍需 `--use`，`office:none` 禁用，省略 `--addon` 重置为空（有意收紧旧版越 slot 行为）。

**PowerShell 候选传输**：模板把命令词（最后一项为可空光标前缀）以 U+001F 分隔存入仅本次调用的进程环境 `DSH_COMPLETE_WORDS`，调用 `manager __complete --shell pwsh --words-env` 后在 finally 恢复环境和 UTF-8 输出编码；Windows 经 std.process.EnvMap 的 UTF-16 环境读取，模板拒绝 NUL/U+001F 词，避免 5.1 legacy argv 对空词、空格及引号的破坏，不执行 AST 表达式。

**证据**：每个切片的场景 ID、命令、red 原因和 green 结果都记录在变更目录的 `evidence.md`。

## Risks / Trade-offs

- [默认全部随安装移动与系统只读安装不相容] → 仅明确托管标记启用用户数据目录例外，普通便携模式不因写入失败换地方。
- [插件与 pnpm 可能留下绝对链接、缓存或外部路径] → 使用真实插件和隔离 HOME 做写入审计、原路径不可访问的搬迁 E2E；用户明确配置的外部资源不自动迁移。
- [Windows 映像占用与异常中断可能破坏自更新] → 同程序 helper、完整候选验证、替换边界故障注入；门禁失败不得宣称该平台支持完成。
- [旧 TypeScript 管理策略残留在新 bundle] → 审查入口依赖并用不会容忍被调用的应用 fixture 验证所有管理命令；真实 bundle 也检验不含管理入口。
- [上游固定 CLI 声明或 profile 路径变化] → 构建侧有限适配与制品一致性门禁，变化时失败而非发布失配描述或错误路径。
- [任意插件写外部文件、孤立子进程继续用文件] → 明确不是沙箱或全面进程追踪；保留受管理 runtime 使用保护，不扩张为通用容器系统。
- [旧发布删除不可逆、不可变策略/权限可能阻止删除] → 先准备并验收替代制品、固定清单确认、逐项记录结果；认证/保护受阻时停止，不切换凭据或降低保护绕过。

## Migration Plan

本节仅描述发布切换与失败回退，不是旧安装迁移方案；不创建迁移命令、转换器或用户迁移指南。

1. 在本地/CI 完成纵向切片与新格式真实制品验收；不影响当前线上发布。
2. 停止旧轮询/发布路径，读取并冻结全部旧 release/资产及当前索引、Scoop/Gentoo 下载引用清单。
3. 生成并验证新 manager、至少两个用于多版本验收的新格式运行包及所需 addon；先验证精确资产，再发布新类型索引和包清单，确保首次下载及两种包管理安装可用。
4. 展示旧 release ID、资产数量、索引改动和不可逆后果；获得执行确认后按清单清除全部旧发布/资产和当前旧下载引用，不使用清理时重新查询出的动态全集。
5. 复查新入口、校验值、托管更新和所有清单内旧资产 URL；报告每项删除结果与任何未完成项。只有清单全部完成才能声称旧发布已清理。
6. 删除前新体系验收失败则不进入删除。删除后不恢复被用户要求退出的旧架构；发生新故障时暂停继续发布，修复或回退到已验收的新体系版本，保留用户数据。无法执行某项删除时明确阻塞，不把本规划授权当作关闭不可变保护的授权。

7.1 经 supervisor 确认的实施边界：本切片 `self-update` 只准备已验证候选并明确输出 `prepared, not installed`，完整替换分别由 7.2/7.3 验收。管理器版本采用严格 SemVer（build metadata 不参与排序），相同版本默认不下载，`--force` 允许同版本修复但不降级。manager 索引资产复用 `{name,size,sha256}`；ZIP 仅包含本机 `dsh(.exe)`，核验原生文件类型及由同一源码常量生成的版本/协议标记，不执行候选。候选为管理器真实目录内 `.dsh-manager-candidate-<version>`，同名重新准备替换而不累积；portable clean 在维护锁下仅回收严格名字、regular/no-follow 且有效标记的候选文件，托管模式不枚举该目录。候选准备只允许修改该文件、已验下载缓存、锁文件及空 tmp，不改变运行包、选择、快照、addon、配置、home 或凭据。

7.1 supervisor 补充：仅保留一个有效候选，发布新候选后在维护锁下回收其他 exact/valid 候选，坏文件/链接保留；强杀留下的 `.dsh-manager-candidate-<strict semver>.part-<1..16 hex>` 仅按 regular/no-follow 文件回收，不要求尚未写完的内容有完整标记。

7.1 独立复审修正（父会话批准）：候选发布使用 handle-relative no-replace；复制时计算二进制 SHA-256，发布后从最终 no-follow 句柄重算并比较，不一致只报错保留、不宣称 prepared。清理与单候选回收保留校验句柄、在 deleteFile 前核对 inode/file-index，绝不递归删除候选名。版本及协议 marker 各要求恰好一条；可信索引的归档 SHA-256 提供真实性，marker 只检查一致性，按批准保留现有浅层 native header 检查，不扩展 executable table 解析。身份检查到 unlink 的极小同用户竞争窗口按简单原则作为明确残余风险保留。

7.2（父会话固定边界）：POSIX `self-update` 在维护锁内从 no-follow 句柄重新校验候选的 native header、唯一 version/protocol marker 与本次可信归档复制时记录的二进制 SHA-256；保留已校验当前入口句柄及 mode/owner，经 inode 核对后以同一个 ctx.dir 句柄原子 rename 候选到 resolved executable basename，成功后才输出 updated。启动链接不替换，不执行候选做验证，不采用先删入口再复制；readonly/身份变化明确拒绝。候选 hash 仅本次调用保存，不增加持久状态，中断后重跑重新校验下载；Windows 仍 prepared、不安装，helper 留给 7.3。进程中断只可能留下完整旧或新入口；最终校验到 rename 的微小同用户竞争窗口按既定简单原则保留，不宣称断电 durability。
