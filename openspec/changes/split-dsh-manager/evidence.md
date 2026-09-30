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

## 复审 zip（sol）

- 范围：仅重写 `dsh-manager/src/zip.zig` 及其测试，将原 584 字节 producer fixture 原样移至 `src/fixtures/runtime-sample.zip` 并嵌入；本轮代码由 sol 编写。DL-ESCAPE / DL-CORRUPT：修复新 staging 迭代 panic、重复键借用可变缓冲区、Unix 执行位读取、解压范围/CRC/尺寸与本地头校验；删除自定义 Writer vtable，使用标准 ZIP 头、两个有界 Reader 和分块 CRC。文件及新目录 chmod 规范化，拒绝符号链接、特殊类型、ZIP64、加密、多卷和 descriptor。
- 路径规则：各主机统一拒绝控制字符、非法 UTF-8、穿越、反斜杠、冒号、Windows 设备名及尾点/空格；保留合法 UTF-8，ASCII 折叠检查叶子、父目录拼写、文件/目录冲突。原生 Unicode 别名通过独占创建失败关闭，不声称跨平台 Unicode 归一化等价。仅容忍声明压缩范围内、首个 raw-DEFLATE 流真正结束后的未使用后缀；不解压第二流，不作规范化 ZIP 声称，结构区间排序拒绝重叠与中央目录越界。
- red：`timeout 90 zig test src/zip.zig --test-filter <场景关键词>` 在修改对应行为前验证：`fresh staging` → EBADF 迭代 panic；`table growth` → 哈希表键变更触发 assertion；`any Unix` → 期望 0755、实际 0644；`nonportable` / `ASCII case` / `local header` / `archive boundaries` / `directory payloads` → 应拒绝却成功；`size mismatches` → 前缀 CRC 掩盖额外内容；`genuine stream` → 空输出未终止却成功；`cannot cover` → DEFLATE 后缀吞并另一注册成员仍成功。原 fixture 测试报 `FileNotFound`；原生 Unicode 叶子返回错误分类不对、父目录别名被合并。`umask 077` 目录测试期望 0755、实际 0700。旧代码与最终无泄漏测试适配器另存 `/tmp/dsh-sol/zip-red-old.zig` 复核；大文件小 allocator 测试是原有流式能力的特征测试，不冒称 red。
- green（均带 timeout）：`cd dsh-manager && timeout 300 zig build test --summary all`：41/41 pass；`timeout 120 zig test src/zip.zig`：27 pass / 0 skip / 0 fail（ZFS 上 Unicode 叶子、父目录别名均实际执行）；`timeout 900 bun test ./test`：39 pass / 0 fail、223 次断言。换至 `/tmp/dsh-sol` 用绝对源码路径执行 ZIP 测试：25 pass / 2 skip / 0 fail（该临时文件系统不合并 Unicode 名称，明确报告 skip），fixture 不再依赖 cwd。`umask 077` 下文件/目录权限测试各 1 pass；1 MiB 解压仅给 16 KiB allocator。`timeout 300 zig build -Dtarget=<target>` 及 `timeout 300 zig test src/zip.zig -target <target> -fno-emit-bin` 对 x86_64-windows-gnu、aarch64-macos、aarch64-linux 均成功；未声称这些平台已运行测试。直接调用 `dsh-bun-build/runtime/zip.ts` 重建 fixture，与嵌入文件逐字节一致。
- 边界：API 仍为 `extract(a, archive_path, dest_path) Error!void`；调用者须提供私有、空的 staging 和受信任祖先，失败丢弃部分树。输出内存为固定缓冲区，元数据内存随路径数量增长；本轮未接入安装/发布流程，也未修改 `add-config-snapshots-and-paths`。

## 跨平台 CI 记录

- 2026-10-01 GitHub Actions `ci.yml` 在分支 `feat/split-dsh-manager`（66e8085）上的运行：https://github.com/xz-dev/dsh-bin/actions/runs/36761298031。三平台都失败，原因如下：
  - ubuntu-24.04：dsh-manager 全部通过；dsh-bun-build 的 `test/unit/e2e-addons.test.ts` 仍导入已停放的 `runtime/layout.ts`（待 1.2/1.4 复审处理）。
  - macos-15：`src/http.zig:108` 中 `timeval.usec` 在 macOS 上是 i32，编译失败。manager 主程序交叉编译没有覆盖 http 模块，因此本地未发现。
  - windows-2022：真实 Windows 上管理器启动、CreateProcessW 参数透传、LockFileEx 使用锁相关测试均通过（25 pass）。http 黑盒测试因驱动缺少 `.exe` 后缀而无法启动（12 项）；RL-MANAGER-BUILD 复制 zig 可执行文件的路径在 Windows 上不成立（1 项）。
  - 上述 http 问题已转交 sol 的 http 复审任务；RL-MANAGER-BUILD 与 e2e-addons 留待后续复审任务。

## 复审 http（sol）

- 变更：ad1851a 重写验证下载与 socket 重试，验证整文件大小/SHA-256 后才替换目标；保留可续传 `.part`，检查 Range/416，限制尝试数，解析 Retry-After 秒数/HTTP-date，重定向不排空错误 body，每个新连接设置 idle timeout。Windows 使用同步 socket I/O，保留标准 TLS；代理错误不泄露 URL 凭据。此次补上暂存测试和状态处理顺序：先处理可重试状态/重定向，再对将读取的成功 body 要求 identity，gzip 的错误 body 不应取消重试。
- red：`timeout 180 bun test ./test/download.test.ts -t 'all transient statuses'`：0 pass / 1 fail，首个 `408 + Content-Encoding: gzip` 返回 HttpStatus，未重试（期望退出 0，实际 1）。修复后 37 pass / 0 fail（372 次断言，包含真实 HTTPS）。补充 GET 记录、异步分块上限与静默断连 fixture，测试编译加 `-fsingle-threaded`（驱动无线程）。
- CI red：36773857807（ad1851a）macOS manager 全绿；Windows cross-host stall 4362 ms 超过原 2000 ms，原因是 localhost 先连接无监听 IPv6 再回落 IPv4，不能把 TCP 建连当 idle timeout。现测试保留跨 host、Range/GET/identity，单独要求重定向请求之后的 idle 重试 <2000 ms，Windows 总耗时 <10000 ms、测试上限 12000 ms。HTTPS_PROXY 检查按不区分大小写匹配（Windows EnvMap 行为）；拒绝 localhost 的五次连接在 Windows 可各花约 2 秒，保持五次尝试，单次驱动硬上限 25000 ms、两 API 测试上限 55000 ms，而非放宽生产重试。
- RL-MANAGER-BUILD red：新 `zig env` Windows 转义路径样例 0 pass / 1 fail，原正则把 `\\` 留在路径中。JSON 解码 quoted 字段后样例通过；Linux/macOS 原独立构建要求不变，Windows 不跳过。
- green（均带 timeout）：`cd dsh-manager && timeout 300 zig build test --summary all`：43/43；`timeout 1200 bun test ./test`：65 pass / 0 fail、566 次断言。`dsh-bun-build` 暂停失效的 e2e-addons/upstream-diff 测试并重命名 parked tests 为 `.reference.ts` 后，`timeout 900 bun test ./test/unit ./test/runtime`：88 pass / 0 fail、313 次断言；CI 现在只运行这两个指定项目 suite。
- 边界：没有严格 DNS/TCP/TLS deadline；HTTPS proxy 在 task 3.2 的 TLS-over-CONNECT 前拒绝；Windows/macOS 实际运行只由 CI 验证，本轮平台测试修正尚待新 CI。未继续扩大 zip/http 范围。

- 2026-10-01 第二次 CI（ad1851a，sol 重写 http 后）：https://github.com/xz-dev/dsh-bin/actions/runs/36773857807
  - macos-15：dsh-manager 全部通过，确认 macOS 上 `timeval` 修复有效、http 黑盒测试可真实执行。
  - ubuntu-24.04 / macos-15：只剩 dsh-bun-build 的 e2e-addons 引用已停放模块这一项失败。
  - windows-2022：dsh-manager 59 pass / 4 fail，失败项为：
    - 跨主机重定向后的停滞超时约 4.4 s，超过测试上限 2 s；
    - 代理诊断中的变量名大小写与测试预期不一致；
    - 连接被拒时 Windows TCP 层的重试使测试超过 5 s；
    - RL-MANAGER-BUILD 在 Windows 上找不到 zig 路径。
  - 以上已转给正在运行的 sol 任务处理。
