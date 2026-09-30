# split-dsh-manager 切片证据

每个切片记录场景 ID、可复现命令、red 原因与 green 结果。命令均在所属项目目录执行。

## 基线

- `bun test ./test/unit ./test/runtime ./test/launcher ./test/update-contract`（拆分前根目录）：353 pass / 0 fail。
- 纯移动提交 827ba4f 后：`dsh-manager`（`zig build test && bun test ./test`）27 pass；`dsh-bun-build`（`bun test ./test/unit ./test/runtime ./test/update-contract`）326 pass；合计 353，与基线一致。

## 1.1 / 1.3 MC-EMPTY、MC-NAMESPACE、RL-MANAGER-BUILD

命令：`cd dsh-manager && bun test ./test/manager-control.test.ts`

- red（旧 launcher 构建）：
  - MC-EMPTY：`dsh manager --version` 退出 1，旧 launcher 把 `manager` 当作应用参数，并要求已安装 bundle。
  - MC-NAMESPACE（旧顶层词）：退出 1，旧 launcher 在 `<dir>/bundles` 查找 bundle，而不是在数据根 `dsh-bin/bundles`。
  - RL-MANAGER-BUILD：仅有 zig 时可以编译，但产物对 `manager --version` 退出 1。
  - MC-NAMESPACE（`manager …` 不启动应用）在 red 阶段因旧 launcher 找不到 bundle 而意外通过；它不能单独证明路由正确，green 阶段与其他场景一起复核。
- green（首个 Zig 管理器切片）：`bun test ./test/manager-control.test.ts` 4 pass。
  - MC-EMPTY：`dsh manager --version/--help/list` 均退出 0；list 报告“No dsh runtime is installed”；安装目录只保留 `dsh`，HOME 不变。
  - MC-NAMESPACE：`manager update/list/--help/未知子命令` 从不启动假运行包；旧顶层词 `update/install/list/select/snapshot/clean` 原样交给应用。
  - RL-MANAGER-BUILD：复制 `build.zig`/`src` 到无运行包项目的目录，PATH 只放 zig，`zig build` 成功，产物 `manager --version` 输出版本。

## 1.3 MC-ARGS 与启动契约

命令：`cd dsh-manager && zig build test && bun test ./test`（27 pass / 0 fail）

- `launch.test.ts` 取代旧 launcher 测试，覆盖以下行为：
  - MC-ARGS：`--use 0.2.0 --profile tui -p "manager update --use latest"` 原样传递，cwd 不变，退出码 3 透传；首个应用参数之后的 `manager` 属于应用参数；stdin 交给应用。
  - 选择与诊断：latest 按记录渠道和构建顺序决定；固定选择生效；缺失或歧义版本只输出一行诊断并指向 `dsh manager install`，不回退。
  - RB-LEGACY（本地部分）：旧耦合 bundle、协议 2、缺入口、`entry=../x` 均被拒绝，不执行任何内容。
  - 其他：环境载荷 `DSH_MANAGER_LAUNCH`；清理旧标记；PS-SYMLINK（软链接入口、从其他 cwd 启动时数据根取真实程序目录）；使用锁在运行期持有，管理命令不启动应用。
- red → green 过程中发现：相对 `DSH_HOME` 被当作相对管理器 cwd 之外的路径保留原字符串（`rel`）；已改为按调用 cwd 解析。
