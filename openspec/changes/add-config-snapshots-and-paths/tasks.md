## 1. 前置门槛与可执行验收约定

- [ ] 1.1 确认 `split-dsh-manager` 已验收归档，逐块核对本 change 的 manager-control、portable-storage、runtime-bundles MODIFIED 目标及保留场景，核对启动协议、选择记录、存储锁和注册记录接口；验证交付为依赖核对记录与通过的严格 OpenSpec 校验，前置未就绪不得进入实施。
- [ ] 1.2 将本 change 的全部场景 ID 映射到现有管理器黑盒、Zig、构建适配和真实应用测试层，准备隔离 HOME/cwd/PATH、专用测试凭据和受控源；验证每个场景有明确测试入口且不依赖用户实际配置，开始每个切片时在 evidence.md 记录可解释的 red，完成后记录实际命令及 green。

## 2. 类型化快照与管理器选择

- [ ] 2.1 先增加类型必填、两类同号／同别名、前置参数边界的失败测试，再实现 snapshot plugins/config 分发、configSnapshot 引用及类型化身份；验证 CS-IDENTITY、MC-TYPED、MC-ARGS、MC-NAMESPACE 通过，未带类型不默认操作 plugins。
- [ ] 2.2 参数化复用两个 store 的自动建立、手动 new、target、empty、name、版本排序和计数逻辑；验证 CS-AUTO、CS-CREATE、CS-EMPTY、CS-GAPS、MC-SNAPSHOT 对两类均通过，来源不变、编号不复用、没有共享 home 的隐式导入。
- [ ] 2.3 实现配置内容复制、操作临时物排除、私有权限和暂存发布，给复制错误、源变化及中断加失败注入；验证 CS-CONTENT、CS-FAILURE、CS-PERMISSIONS 通过，另一类型不被修改，无可选择半成品或凭据正文输出。
- [ ] 2.4 对称扩展持久及单次选择解析，显式 use 优先、单种快照推导版本、两种不同来源需要 use 消歧，保持前置 addon 行为；验证 MC-CONFIG-SELECT、MC-AMBIGUOUS、MC-CROSS-SNAPSHOT、CS-CROSS 的真实管理器进程测试通过，单次覆盖不写持久状态。
- [ ] 2.5 将删除预检、固定引用和使用保护扩展为 kind/id，配置删除采用与插件相同的整批预检；验证 MC-PINNED-CONFIG、MC-IN-USE 通过，失败不先删除闲置项，两类相同 ID 不混淆保护对象。
- [ ] 2.6 扩展安装／重装／卸载／clean 的两类保留规则及缺失类型重试，不重新初始化已完成的另一类型；验证 MC-LAST、MC-REINSTALL、MC-CLEAN、MC-ADDON 通过，零运行包仍保留两类集合、凭据和计数，addon 管理不调用应用。

## 3. 新启动协议与真实应用 I/O 隔离

- [ ] 3.1 先建立协议 2 的入口拒绝／接受测试，再更新管理器载荷、运行包元数据、构建适配和协议支持声明；验证 RB-INDEPENDENT、RB-LEGACY、RB-CONFIG-PROTOCOL、RB-CONFIG-CONTEXT 通过，两个支持同协议的管理器无需重建同一运行包，旧协议不被降级为共享配置模式。
- [ ] 3.2 在受支持版本的构建站点表中接管 profile patch 的读写／监视、settings 读取与 `.imported` 重命名／导入，保留插件解析基准与生成的 cordis.yml；用真实运行包和真实插件验证 CS-PLUGIN-BASE、CS-FORMAT、RB-HOME、RB-PLUGIN、PS-CONTAIN、PS-OVERRIDE 通过，未覆盖的已知路径变化使构建失败。
- [ ] 3.3 接管内建本地凭据提供者的默认／显式路径、读取、更新与 watcher，在文件打开前验证配置根边界与私有权限；用真实提供者的专用测试凭据验证 CS-SWITCH、CS-EXTERNAL、CS-LOCAL-PATH、CS-PERMISSIONS 通过，外部路径及逃逸链接不会被访问或静默回退。
- [ ] 3.4 使配置映射按进程上下文传递，不改写共享插件目录中的公共配置链接；扩展 runtime 的双快照使用保护和内部重启继承；验证 CS-CONCURRENT、RB-RESTART、MC-IN-USE 通过，同一插件环境配两套配置可并发，默认选择变化及管理器父进程退出不会切换既有会话或解除保护。
- [ ] 3.5 完成 A→B 继承、B 修改设置／凭据、回切 A 的真实应用纵向验收，以及显式跨版本直用与复制后试用的对照；验证 CS-SWITCH、CS-FORMAT、CS-CROSS 通过，来源字节和共享 home 哨兵按场景保持不变，并明确区分格式改写 fixture 与真实上游服务结果。

## 4. 八类只读路径排障

- [ ] 4.1 将已有路径计算和选择解析与初始化阶段分离，实现 path 总览、self、home 及来源说明；验证 PATH-OVERVIEW、PATH-EXPLAIN、PATH-CURRENT 通过，当前有效组合可解释，失效引用不改选 latest，home 不被误报为活动配置根。
- [ ] 4.2 实现 runtime、snapshot、addon 的本地库存、过滤及明确目标错误；验证 PATH-RUNTIME、PATH-SNAPSHOTS、PATH-ADDONS、PATH-TARGET-ERROR 通过，已卸载运行包的快照仍可见，两类同号条目分开，查询不下载缺失对象。
- [ ] 4.3 实现 cache、tmp 查询并区分管理缓存与应用默认缓存，空布局仅计算根路径；验证 PATH-CACHES、PATH-MISSING 通过，没有创建目录、分配快照编号或把临时事务列为可随意删除。
- [ ] 4.4 实现 completion 查询，消费注册路径与结果记录；如前置记录缺少目标路径，只补齐本 change 实施后实际注册的记录，对旧缺失信息报未知；验证 PATH-COMPLETION 通过，已删除文件、未注册和未记录位置区分清楚，不读 rc 正文或启动 shell。
- [ ] 4.5 统一八类查询的人类／JSON 输出、确定排序、问题码、完整性与退出状态；验证 PATH-UNREADABLE、PATH-CONFLICT、PATH-JSON 通过，目录类型／所有权冲突可诊断但不修复，未知不能假装不存在，JSON stdout 不混入日志。
- [ ] 4.6 对八类查询运行无副作用和敏感文件打开审计，覆盖无运行包、损坏选择、损坏入口、只读目录、无 Node/Bun 与禁网环境；验证 PATH-READONLY、PATH-SECRET、MC-EMPTY、MC-BROKEN 通过，前后目录内容／计数／状态无主动写入，没有子进程、网络请求或首次询问。

## 5. 跨组件与平台验收

- [ ] 5.1 运行真实程序软链接入口与原位置不可访问的离线搬家测试，包含真实插件、配置和凭据；验证 PS-MOVE、PATH-MODES 通过，移动后 path 与真实启动均使用新根，不恢复旧路径，也不改写用户外部资源。
- [ ] 5.2 在 Gentoo／Scoop 前置测试夹具及支持的平台矩阵中复验路径、原生权限、选择与双快照保护，特别验证 Windows runtime 不依赖父管理器存活；验证 PATH-MODES、CS-PERMISSIONS、RB-RESTART、MC-IN-USE 通过，不能用 POSIX 权限模拟声称 Windows ACL 已验收。
- [ ] 5.3 将同参数 path effective 与随后真实启动的组合逐项对比，再跑两类共享生命周期矩阵及真实应用组合回归；验证 PATH-CURRENT、CS-AUTO、CS-CREATE、CS-GAPS、CS-CONTENT、CS-CONCURRENT 和前置未被本增量替换的行为均通过，不用 fake-native 代替真实配置／凭据服务验收。

## 6. 帮助补全文档与交付核验

- [ ] 6.1 更新同一管理命令声明、帮助、四种 shell 的补全候选及项目说明，解释两类命名、选择示例、DSH_HOME 新边界、显式跨版本直用风险、path 来源／状态和八类范围；验证真实 shell 候选按类型过滤且离线无写入，并能按文档复现 MC-TYPED、CS-CROSS、PATH-OVERVIEW、PATH-CURRENT、PATH-COMPLETION、PATH-JSON 的结果。
- [ ] 6.2 复核全部场景与测试／证据映射，执行管理器、构建适配、真实运行包 E2E 和严格 OpenSpec 校验，检查候选运行包不携带管理引擎；验证 evidence.md 提供真实命令、退出码、平台与覆盖结果，任何未运行或失败项目仍保持未完成，不提前发布、同步归档或删除旧 release。
