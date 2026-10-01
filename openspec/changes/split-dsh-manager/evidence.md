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

## 1.2 / 1.4 / 1.5 复审纵向运行路径（sol）

- 本轮读完 D1–D10、三份相关 spec、task/evidence 后重新检查 ae77681 涉及的 runtime、构建脚本与测试；92afaf2 声明替代其未复审 runtime 行为。新运行逻辑、构建适配和新增检查由 sol 编写；`build-target.mjs` 原有调用链和 `targets.mjs` 删除 manager/Zig 字段无需另造行为。没有把“源码已移动”当作完整组合验收。
- **已修复（高）RB-INDEPENDENT**：真实归档提取并启动失败，`dsh: DSH_MANAGER_LAUNCH has invalid addons`，期望退出 0、实际 1。Zig `.{} ` 被 JSON 编为 `[]`，假运行入口从未验证该字段；改为 `struct {}{}`，生产载荷现在是 `addons:{}`，对应原始 counterexample 以及 fake 环境精确断言均由 red 变 green。
- **已修复（高）RB-HOME**：本机 `work/app` 已携带旧 `snapshot/../../profiles` prelude，新 transform 原先视为已完成而不重写；运行包会忽略外部 home 的 patch。`timeout 120 bun test ./test/unit/transform-app.test.ts -t rebuilding` 在修复前 0 pass / 1 fail（外部 cordis.patch.yml 为 ENOENT，实际写错相邻 data/profiles）。现在重跑 transform 更新 prelude；local-build 对 work/app 私有副本转换、不修改输入。真实 archive 的 `--profile split-probe --dump-config` 读取外部 patch；关闭该转换的 mutation 0 pass / 1 fail（期望 `from-external-home`，实际空输出），恢复后通过并确认错误相邻 profiles 和快照内 patch 均不存在。
- **已修复（中）runtime 消费**：resolved home 覆盖继承环境，snapshot:null 清除旧 `DSH_BIN_SNAPSHOT_DIR`。`timeout 180 bun test ./test/runtime/snapshot-start.test.ts -t 'invalid launch|resolved launch'` 在实现前 1 pass / 1 fail（仍报告 stale-home/stale-snapshot）；恢复后 runtime suite 通过。存在但空的载荷不作为 standalone；空载荷旧分支 mutation 在 `runtime-contents.test.ts -t 'empty launch'` 为 0 pass / 1 fail。独立启动不调用管理引擎。
- **已修复（高）失效测试**：原 `timeout 900 bun test ./test/unit ./test/runtime` 因 e2e-addons 导入停放 layout 红灯（98 pass / 1 fail）。e2e-addons、upstream-diff 及旧 manager tests 改名 `.reference.ts` 停放，每类由 README/一行指向替代任务（release pipeline 8.3、最终移除 8.5）。现活跃 test import 检查无 parked/stale 引用；普通 `bun test` 不发现这些旧测试，CI/package.json 仅指定 ./test/unit ./test/runtime。8.3 脚本本身未伪装为已修复。

### 可执行场景与 red/green

- **RL-OWNERSHIP / RL-MANAGER-BUILD（1.2）**：manager-owned Gentoo/Scoop 业务脚本都在 dsh-manager/scripts，runtime 中没有副本；移走 gentoo-ebuild 的受控 mutation：0 pass / 1 fail，恢复：1 pass（8 断言）。manager 最小源码复制到不含 runtime 的目录，只给 Zig PATH 独立构建，Windows Zig 字符串转义反例已修；Linux 真实运行通过，Windows/macOS 待新 CI。根 docs→desc 与根旧安装入口属于 8.4，不在本切片冒充完成。
- **RL-RUNTIME-BUILD / RB-CONTENTS（1.2/1.4）**：`runtime-build.test.ts` 只复制 runtime/scripts/package.json，空 PATH、无 Zig/manager checkout，用绝对 Bun 构建内嵌入口并产出真实 ZIP。检查唯一根 bundle.json v1、entry/required paths，无 `dsh`/`dsh.exe` manager、无 bundles/ 外层。临时恢复 Zig 调用时 0 pass / 1 fail（Executable not found in $PATH: zig），恢复后通过。归档加入 manager 文件的 mutation 0 pass / 1 fail；入口改为导入 zip 的 mutation 在 Bun 实际 metafile graph 检查 0 pass / 1 fail，恢复后通过。对小文件的 binaryArch 旧实现 RangeError 0 pass / 1 fail，现返回 unknown，不使产物清单检查崩溃。
- **RB-LEGACY（1.4）**：现有真实 Zig launch fixtures 保持绿：旧 schema-2 耦合格式、不支持 protocol、缺入口和越界 entry 均拒绝不执行，valid fixture 可执行。安装/索引验证接入仍归 3.1/3.3，不声称本地 launch 验证就是完整下载安装实现。
- **RB-INDEPENDENT / MC-ARGS（1.5）**：`timeout 900 bun test ./test/real-runtime.test.ts` 从本机 work/app、work/pnpm-linux-x64、work/src-rc2 执行 `bun scripts/local-build.mjs <~/.cache/out> release 1`；每测试进程仅构建一份，未引入易失效的跨进程 cache。tiny Zig driver 用 manager 自己 ZIP extractor 安装到 tools/dsh-bin/bundles/<id>，`-Dversion=1.0.0` 与 `2.0.0` 两个 manager 共用同一份未重建归档，PATH 为空。两者均 `--version`/`--help` 退出 0；真实上游 profile boot 挂载测试插件（不替换 bin.js），检查包括 manager 文本/空参数/尾部 --use 的 argv、空格 cwd、非 ASCII stdin、stdout 和 exit 7。运行时 exclusive probe 为 busy，退出后释放；native 内容前后逐字节不变。fixture 调试时错误的 ctx.ready/ctx.cmdline API 与 Bun FileSink.end(input) 曾造成退出 0/空 stdin，修正测试驱动（write 然后 end），没有把测试驱动问题算生产 red。
- `work/app` 不存在的受控路径验证：0 pass / **2 skip** / 0 fail，名称明确输出 `requires local dsh-bun-build/work/app (absent on CI; real archive not tested)`，不静默宣称组合通过。它存在而 pnpm/src 缺失则失败，不吞掉缺输入。

### 最终验证与任务边界

- `cd dsh-manager && timeout 300 zig build test --summary all && timeout 1200 bun test ./test`：Zig **43/43**；Bun **67 pass / 0 fail**，595 次断言，6 文件；真实 archive 2 场景实际执行。
- `cd dsh-bun-build && timeout 900 bun test ./test/unit ./test/runtime`：**94 pass / 0 fail**，341 次断言，23 文件（现有真实 app 测试和新增隔离 build 均执行）。两个项目 Bun 合计 **161 pass / 0 fail**，936 次断言。
- `timeout 300 zig build -Dtarget=<target>`，以及 `timeout 300 zig test src/http.zig -target <target> -fno-emit-bin`、`timeout 300 zig test src/zip.zig -target <target> -fno-emit-bin`：x86_64-windows-gnu、aarch64-macos、aarch64-linux 全成功；这些只是交叉编译，不冒称平台运行通过。`git diff --check` 通过。
- 只勾选 **1.2、1.4、1.5**；1.1/1.3 原场景保持绿。1.5 获授权使用 snapshot:null，真实 profile 能启动；**初始快照生成/manager 快照 handoff 与缓存/tmp 收敛仍归 2.3/6.2**，不能据此宣称完整快照、重启、多版本插件搬迁已完成。共享 profile 适配已由 RB-HOME 验收，未扩大 addon/shell/release/self-update 范围。
- 8.3 独立发布 pipeline、8.4 docs→desc、8.5 reference 移除仍待做；Windows/macOS 本轮改动待新 CI、真实运行包组合在 CI 为显式 skip。TypeScript LSP 缺 Node/Bun 声明，本仓未加依赖或宣称类型检查通过。未触碰 `openspec/changes/add-config-snapshots-and-paths/`、未 push、未改历史。


- 2026-10-01 第二次 CI（ad1851a，sol 重写 http 后）：https://github.com/xz-dev/dsh-bin/actions/runs/36773857807
  - macos-15：dsh-manager 全部通过，确认 macOS 上 `timeval` 修复有效、http 黑盒测试可真实执行。
  - ubuntu-24.04 / macos-15：只剩 dsh-bun-build 的 e2e-addons 引用已停放模块这一项失败。
  - windows-2022：dsh-manager 59 pass / 4 fail，失败项为：
    - 跨主机重定向后的停滞超时约 4.4 s，超过测试上限 2 s；
    - 代理诊断中的变量名大小写与测试预期不一致；
    - 连接被拒时 Windows TCP 层的重试使测试超过 5 s；
    - RL-MANAGER-BUILD 在 Windows 上找不到 zig 路径。
  - 以上已转给正在运行的 sol 任务处理。
- 2026-10-01 第三次 CI（2342523）：https://github.com/xz-dev/dsh-bin/actions/runs/36782463054。ubuntu-24.04、macos-15、windows-2022 全部通过。说明：CI 上没有 `work/app`，真实运行包组合测试在 CI 中会明确跳过；该组合只在本机验证过（67 pass / 0 skip）。

## 2.1 PS-SYMLINK、PS-HOME、PS-READONLY、PS-CONFLICT（sol）

- 命令：`cd dsh-manager && timeout 300 bun test ./test/storage.test.ts`。实现前 **0 pass / 6 fail**：首次启动没有 `.dsh-bin-data.json`；顶层帮助/版本仍要求运行包；同名文件被误诊为 selection 不可读；非空目录、损坏所有权标记和只读目录只报“没有运行包”，未验证数据根。实现后 **6 pass / 0 fail**，60 次断言。
- 最小实现：集中解析并保存真实 executable、数据根与原 cwd 下的应用 home；首次有状态启动才声明 D10 所有权，空/不存在目录通过，未标记非空目录、同名文件和损坏标记均带路径拒绝。实际独占写探针检验可写性，不依赖 POSIX mode 位推断、不切换 HOME/XDG。帮助、版本和本地 list 不创建文件。Windows 测试以 `icacls` 拒绝当前用户写入，避免把目录 READONLY 属性误当 ACL；软链接测试明确以 Windows 非默认 symlink 权限为由跳过，真实 exe 路径仍使用 realpath。
- green 中间提交 **d692faf**：`timeout 300 zig build test --summary all` **43/43**；`timeout 1500 bun test ./test` **73 pass / 0 fail**、655 次断言（真实 archive 2 场景实际执行）；`cd ../dsh-bun-build && timeout 900 bun test ./test/unit ./test/runtime` **94 pass / 0 fail**、341 次断言。`timeout 300 zig build -Dtarget=<target>` 对 x86_64-windows-gnu、aarch64-macos、aarch64-linux 成功；交叉编译不是对应平台运行证据，新 Windows/macOS 代码待父会话 CI。
- 边界：空安装尚不下载，预期先创建所有权标记再明确报运行包缺失；安装/自动自举属于第 3/5 节。只对有状态入口检查可写性，只读命令不要求可写。

## 2.2 PS-MANAGED、PS-SCOOP、PS-OVERRIDE（sol）

- red：`cd dsh-manager && timeout 300 bun test ./test/storage.test.ts -t 'PS-MANAGED|PS-SCOOP|manager info'`：**0 pass / 4 fail**。旧代码忽略包标记，Scoop 在程序目录查找运行包、`manager info` 报尚未实现、损坏标记仍启动普通便携路径。green：同文件全量 **10 pass / 0 fail**、125 次断言。
- 提交 **8f25e14**：真实 exe 相邻 `.dsh-manager-install.json` 固定为 `{schema:1,owner:"portage"|"scoop"}`；未知 owner、格式损坏、未知 schema 明确带标记路径失败。portage 使用绝对 XDG_DATA_HOME，否则 HOME/.local/share；scoop 要求绝对 LOCALAPPDATA。只读 `manager info` 显示模式、数据根与 app home，并说明托管例外、外部 DSH_HOME 不在整目录便携保证内。测试在每个平台模拟 owner，不冒充真实包安装验收。
- 将 package prefix 设为不可写，确认只写用户数据；两个不同 Scoop package 目录启动同一用户运行包，目录内容不变。相对 XDG_DATA_HOME 走 HOME fallback；相对/缺失 LOCALAPPDATA 报错。此提交 manager 全量 **77 pass / 0 fail**、720 次断言，Zig **43/43**，三个目标交叉编译成功。实际 Gentoo/Scoop 安装、升级、卸载仍归 7.4/7.5。

## 2.3 PS-CONTAIN、PS-OVERRIDE、RB-HOME（sol）

- red：`cd dsh-manager && timeout 300 bun test ./test/storage.test.ts -t PS-CONTAIN`：**0 pass / 2 fail**。载荷仍是 snapshot:null；继承的全局缓存环境未覆盖，假运行包实际在隔离 HOME 中写出了探针。green 为真实 `<id>@1`、`.usage.lock`、snapshot.json 和空 profiles；重启新进程选择现有最高编号且保留文件。只实现初始空快照和 newest，不实现 6.2 的编号计数、复制、别名、显式快照解析、列表或删除。
- **真实 runtime 发现而非猜测**：本机 archive 内 Bun **1.4.2**、pnpm **11.7.0**。`config get store-dir/cache-dir/state-dir` 和 `store path` 实测 **npm_config_store_dir/cache_dir/state_dir 无效**（返回 undefined / 全局 store）；**pnpm_config_store_dir/cache_dir/state_dir 有效**。`timeout 900 bun test ./test/real-runtime.test.ts -t 'PS-CONTAIN|RB-HOME'` 此时 **1 pass / 1 fail**：实际 profile 读 patch 成功，store-dir 却为 undefined。改用已验证的 pnpm_config_* 后真实审计 **1 pass / 0 fail**（最终 30 次断言）。单独运行审计时，fixture 必须先经 manager 初始化 snapshot；缺初始化曾报 metadata 无效，已修复驱动，不把该驱动错误计为生产 red。
- 受控环境：BUN_INSTALL_CACHE_DIR→cache/bun，BUN_RUNTIME_TRANSPILER_CACHE_PATH→cache/transpiler，npm_config_cache→cache/npm（npm 子进程），pnpm_config_store_dir→cache/pnpm/store，pnpm_config_cache_dir→cache/pnpm/cache，pnpm_config_state_dir→state/pnpm，PNPM_HOME→cache/pnpm/home，TMPDIR/TEMP/TMP→tmp。无需改写 XDG_CACHE_HOME、HOME、USERPROFILE 或 LOCALAPPDATA。Windows 覆盖环境键先 remove 再 put，避免 EnvMap 保留旧大小写使 pnpm 无法识别。
- 真实审计复用第 1 节同一构建 archive；从真实 manager 启动真实上游 profile/plugin 记录子环境，再以同一 embedded native 的 BUN_BE_BUN 模式探测 Bun 和 pnpm。受控本地 HTTP registry 提供 tarball，实际执行两种 install，确认 node_modules、Bun 安装缓存、pnpm store/metadata cache 均有内容；大 TS 文件实际增加 `.pile` 缓存；os.tmpdir() 为 data/tmp，隔离 HOME 文件树始终为空，审计目录只有 tools/dsh 和 tools/dsh-bin 内变化。PATH 不含宿主 Node/Bun。
- 外部 DSH_HOME 的真实 `--profile split-probe --dump-config` 现在通过 **manager** 启动，使用传入的真实 snapshot/profiles 和外部 home 中 cordis.patch.yml；没有错误相邻 profiles 或快照内 patch。已完成第 1 节的 profile 转换直接复用，本轮未重复改 runtime/builder。两个 manager 版本同 archive 的真实插件启动也改用 snapshot 内插件文件；对 runtime 与 snapshot 两个 guard 的独占探针均为 busy，退出后释放。CI 的假运行包有对应文件写审计与 snapshot 锁检查；缺 work/app 时三个真实 archive 场景均在测试名明确 SKIP，不宣称实际执行。
- Windows ACL 测试使用 `icacls` 精确拒绝 WD/AD/WEA/WA（不拒绝读取/执行），snapshot staging/marker 文件关闭 handle 后同目录 rename；directory junction（Windows 无 symlink 管理员权限要求）和 POSIX link 均不能重定向数据根或缓存到外部。绿色功能提交 **25a8799**，测试复核提交 **45717de**。

## 2.4 PS-MOVE、DL-NO-MIGRATION（sol，manager 侧）

- `timeout 300 bun test ./test/storage.test.ts -t PS-MOVE`：真实 manager + 预置 runtime + 固定 selection + 插件状态和默认 home，停止后移动 executable/data，将旧目录替换为普通文件（旧子路径确实不可访问），设置不可连接的发行源/代理后仍离线启动。新载荷重新解析所有绝对路径；selection 和 snapshot metadata 只记录 ID/序号/时间/来源/构建顺序，不记录安装绝对路径。仅移动 binary 则创建新位置所有权标记并报告没有运行包，不读取原 data 或旧 ~/.dsh，旧数据不变。
- 首次 green 是既有 ID 状态与新 snapshot 写法的特征验证，没有为制造 diff 新建迁移机制。red 强度检查：临时让 snapshot.json 持久化绝对 dir 并在下次启动采用它，上述命令 **0 pass / 1 fail**（搬迁后应退出 0，实际 1，旧位置 claim 失败）。只加入绝对 dir 的独立 mutation 也使 metadata 检查 **0 pass / 2 fail**。移除全部 mutation 后通过；最终代码未保留故障注入。
- 真实插件完整搬迁属于 **8.1**；此处不宣称任意插件内部绝对链接、跨 OS 移动或运行中搬家已支持。

### 第 2 节最终验证与边界

- `cd dsh-manager && timeout 300 zig build test --summary all && timeout 1500 bun test ./test`：Zig **43/43**；Bun **83 pass / 0 fail / 0 skip**、**815** 次断言、7 文件。本机真实 archive 的 **3** 场景全部实际执行；较第 1 节增加 **16** 个行为场景（storage 15 + real audit 1）。
- `cd dsh-bun-build && timeout 900 bun test ./test/unit ./test/runtime`：**94 pass / 0 fail**、**341** 次断言、23 文件。Bun 合计 **177 pass / 0 fail**、**1156** 次断言。
- `timeout 300 zig build -Dtarget=<target> --prefix /tmp/dsh-section2-<target>`：x86_64-windows-gnu、aarch64-macos、aarch64-linux 全部成功；`git diff --check` 成功。本轮 Windows/macOS 实际执行待父会话 CI，不把交叉编译当运行通过。
- 勾选 **2.1–2.4**，仅按本轮授权的 manager 存储/最小快照场景完成。初始所有权建立的并发/异常中断恢复归 5.4/6.6；完整 snapshot store/显式 --snapshot 选择归 6.2；实际包门禁归 7.4/7.5；完整真实插件搬迁归 8.1。未新增安装、更新、补全、网络策略或旧数据迁移代码；未触碰 add-config-snapshots-and-paths，未 push。
- 2026-10-01 第四次 CI（4d6c623，第 2 节完成后）：https://github.com/xz-dev/dsh-bin/actions/runs/36790090304。ubuntu-24.04、macos-15、windows-2022 全部通过。父会话在本机独立复验：Zig 43/43；dsh-manager Bun 83 pass / 0 skip；dsh-bun-build 94 pass。

## 3.1 FB-EMPTY（索引部分）、RB-LEGACY（sol）

- 本轮范围严格为 3.1–3.4：显式原生安装，不接普通启动自动下载、update、在线 list、uninstall、addon 或完整发布 CI；全部新增代码由 sol 编写。复用第 2 节 context/snapshot 和既有 zip/http，不另写解包器或下载器。
- **red**：`cd dsh-manager && timeout 300 bun test ./test/install.test.ts`，首次两个公开进程场景 **0 pass / 2 fail**；真实管理器返回 `dsh manager install is not available in this build yet`，而不是访问 runtime 索引。新增 writer 测试首次 **1 pass / 1 fail**：旧 writer 导入已停放的 runtime/update。为了分清装配错误与格式行为，临时仅把旧 writer 的 import 指向 reference 再跑 `cd dsh-bun-build && timeout 120 bun test ./test/unit/index.test.ts`：仍 **1 pass / 1 fail**，错误变为 `index release[0]: invalid entry`，旧格式要求 version/launcherProtocol，不能处理 local-build 的 id/launchProtocol；恢复新实现后 **2 pass / 0 fail**、21 次断言。
- **green**：独立 `runtime-index.json` schema 1 reader/writer；writer 从 local-build manifest 生成 kind/tag/id/channel/upstream/run/attempt/launchProtocol/builderCommit/addons.office/assets/seq。release/live 各自追加 seq，相同 tag 内容不变时幂等，改资产、构建次序或 builder commit 均拒绝；旧索引不转换。office 数组保留但本轮不追加 addon；旧 local-e2e/publish-index/聚合消费者的切换仍归 **8.3**。
- 黑盒源同时提供 runtime-index 与 manager-index，记录请求仅有 `/runtime-index.json` 与精确 runtime tag/host asset；更高版本的 manager、不兼容协议、错误 target、旧 launcherProtocol 条目均不触发资产请求或安装。release/live 均可显式安装；latest 按 `commitTime -> run -> attempt`，不会按 manager 版本、数组位置或无关 seq 决定。标签、唯一前缀和歧义错误直接复用 select.zig，歧义不下载。
- 主机识别直接复用 Zig `std.zig.system.resolveTargetQuery` 的运行时 ABI/CPU 检测，不读取 bundle、也不采用 manager 的编译 ABI。x64 根据可用 AVX/AVX2/BMI/BMI2/FMA/SSE4.2 选 modern，否则 baseline；arm64 无 CPU 后缀。纯 target 测试覆盖 Linux glibc/musl、两种 x64 CPU、macOS/Windows 与不支持主机；`timeout 90 zig test src/target.zig -target x86_64-linux-musl` **1/1 pass**。
- **反事实强度检查**：把 host 的 ABI 临时改为 builtin.abi 后，`timeout 400 bun test ./test/install.test.ts -t 'static musl'` **0 pass / 1 fail**（应安装成功，实际没有 glibc host asset）；恢复运行时检测后通过。该场景实际在本机 glibc 用户空间执行静态 musl-ABI manager，没有预置 bundle，证明检测与 manager 链接目标独立；非 Linux 有明确 ELF 执行条件 skip。

## 3.2 DL-CORRUPT、FB-RETRY（下载已贯通，HTTPS_PROXY 缺口未关闭）

- `install.zig` 直接调用既有 `http.fetchSmall` 和 `http.download`，整文件大小/SHA-256 验证通过才解包。缓存名取索引 digest，`.part` 保留在 data/cache/downloads；维护锁保证单写者，rerun 重用 Range。没有 curl/unzip/Node/Bun 产品子进程。
- 安装层源先给 **可正常解包但与索引 SHA-256 不符的 ZIP**，安装报 HashMismatch，bundles 下无候选、无候选 snapshot，原固定选择/运行包不变；源纠正后 rerun 完成。断连源每次仅发 37 字节后真实断 socket，五次失败保留 partial；恢复源后第一资产请求带 Range，完成安装且原选择不变。没有把 partial 当作已安装目录。
- 这些失败/重试测试在 route 缺失的受控基线复核中先红（见 3.3 的 19 fail），恢复后绿。**定向 mutation**：临时使既有 http.verifyFile 跳过 digest，`timeout 180 bun test ./test/install.test.ts -t 'bad hash'` **0 pass / 1 fail**（应失败，实际退出 0 并接受可解包候选）；恢复后通过。http.zig 最终与本轮前逐字节相同，没有扩大其实现。
- 原 http 黑盒场景在最终全量测试仍实际通过：Range 错位/total 不一致/416、Retry-After、idle timeout、坏 hash、真实 HTTPS 下载 pinned Zig 0.15.2 LICENSE。本轮不把 HTTP fixture 当作 HTTPS 证明。
- **明确开放缺口，3.2 不勾选**：HTTPS_PROXY/ALL_PROXY 的 secure TLS-over-CONNECT 未实现。Zig 0.15.2 标准 Client 将 CONNECT 后连接保持为 proxy protocol，缺少可小改安全升级到 origin TLS 的现成接口；本轮没有拼写自定义 TLS/HTTP 栈，继续 fail-closed。新增安装层测试以含凭据的本地 proxy + HTTPS fixture origin 验证 UnsupportedProxy、proxy 零请求、凭据不泄露、无安装。它是拒绝测试，不冒充 CONNECT 成功测试。严格 DNS/TCP/TLS 总 deadline 也仍是原 http 的已记录边界。

## 3.3 DL-ESCAPE、DL-CORRUPT（sol）

- 下载验证后，调用原 zip.zig 解到 `<data>/tmp/.install-<random>` 私有空树；tmp、bundles、cache 的祖先沿用 context 的 no-follow 检查。失败仅丢弃本次 staging；原 ZIP 大小/hash、CRC 和执行位规则直接复用，没有重新加固 zip。
- 激活前验证 bundle.json 的 kind/schemaVersion/id/target/launchProtocol/entry/requiredPaths，并核对 channel、上游 commit/version/commitTime、run/attempt、builderCommit；entry 必须为目标 `dsh-native(.exe)` 普通文件，POSIX 必须有执行位。缺 required path、unsafe required path、legacy launcherProtocol 或 bundles/ 外层均拒绝。安装元数据和 usage guard 在 staging 中完成，关闭文件与目录 handle 后才 rename。
- **red/green 与实际发现**：补充的 19 个安装层场景在临时恢复“install 不可用”的反事实基线 `timeout 300 bun test ./test/install.test.ts` 下 **0 pass / 19 fail**，每个错误为缺安装/校验/激活路由而不是 fixture 编译失败；恢复后通过。后续两项身份反例 `timeout 180 bun test ./test/install.test.ts -t mismatch` 为 **1 pass / 2 fail**：错误 upstream commit 与 builderCommit 被安装（应退出 1，实际 0），补上索引身份核对后通过。`-t unrecognized` **0 pass / 1 fail**：--force 原先接受并删除同 ID 的用户目录；现在 RuntimeDirectoryConflict、用户文件不变且不下载。
- 外部 sentinel 故障：绝对路径、`../../../escape`、指向外部 sentinel 的 Unix symlink；前两者返回 UnsafeEntryName，链接返回 UnsupportedEntry，外部文件/原 usable entry/selection 都不变。另有 wrong id/target/protocol/entry、上游或 builder mismatch、missing required path、required traversal、missing native entry、旧 bundles 外层；候选都不激活，也不执行其入口。
- 测试 crash point 仅在 `DSH_MANAGER_TEST=1` 且 `DSH_MANAGER_TEST_CRASH` 匹配时立即 exit 86，不执行 defer，模拟突然死亡。before-activation 无候选；after-activation 只出现完整验证后的候选，原固定 usable 版本仍可启动。rerun 完成/补齐初始 snapshot；同 ID force 的 before/after 两点也保持完整入口与既有 plugin state。正常 force 候选校验失败时，原 entry 与安装元数据逐字节保留。
- 新版本用同卷 rename 发布。POSIX 同 ID force 用 Linux renameat2(RENAME_EXCHANGE)/macOS renamex_np(RENAME_SWAP)，不先删除目录；交换后旧树在本次 tmp 中回收。**Windows 明确边界**：非空目录不能直接覆盖，采用已校验旧树退到 data/tmp/.previous-<id>、新树 rename、普通失败回滚；突然死在这两个内部 rename 之间时，下一次显式 install 在维护锁下恢复旧树。before/after 公共 activation 点已经覆盖，但 Windows 的内部双 rename 窗口不是连续原子交换，本机未冒称其真实运行证据；实际 Windows/macOS 仍由父会话 CI 验证。使用锁 busy 不替换，未知/损坏同名用户目录拒绝采用。
- 中断 staging 不自动全盘清理；完整 clean/残留 sweep 属 **6.6**。没有在本轮实现 readonly sealing、完整跨重启对象管理或使用竞争的全面收敛（**6.4/8.1**），不扩大任务完成含义。

## 3.4 MC-EMPTY、MC-BROKEN（sol）

- 原生 `manager install <version|tag|prefix|latest> [--channel release|live] [--force]`，维护互斥文件为 `state/manager.lock`。竞争立即明确报错可重试，索引之前已锁住。离线 `manager list` 保留；`--available` 明确尚不可用，不访问源。install 从不写 selection/channel；本轮 --channel 只用于候选过滤，成功后记录渠道的完整规则留 **6.1**。
- 每个安装写 `.dsh-install.json`（schema/kind/id/tag/host target/索引 asset/seq，无持久绝对路径）和 usage guard；快照直接复用第 2 节 prepare，已存在的最高编号和内容不重置。--force 修复 missing entry，不执行坏入口、不执行 pnpm；先前固定选择、snapshot.json、plugin state、用户凭据探针均保留。maintenance 和 runtime shared claim 的独立外部探针会阻止写操作/替换。
- CI 假归档来自真实 recording Zig executable 和现有 ZIP writer；manager-only 起点，隔离 HOME/cwd/PATH，HTTP index+asset fixture 安装，再断源离线启动原参数。源码测试不把 Bun.serve 当产品依赖；被测 manager 不调用宿主 JS。
- **真实归档 red**：`timeout 900 bun test ./test/real-runtime.test.ts -t MC-EMPTY` 首次 **0 pass / 1 fail**，新 install 报 UnsafeRequiredPath：把 ID 规则错用于 required path 的 `.usage.lock`。改为安全相对路径规则后 **1 pass / 0 fail**、15 次断言。没有删除 required-path 检查来迎合 fixture。
- **真实归档 green**：既有 local-build 真正构建 app/pnpm/embedded native，执行新 index.mjs CLI 写 runtime-index；只有 manager 的 fresh tools 目录从 Bun.serve 下载该真实 ZIP，准备 `id@1`，PATH 无 Node/Bun，运行真实 `--version` 和 `--help`。删除 native 后启动明确失败；manager --force 重装，native 前后字节一致、snapshot metadata 不变，真实应用再次启动，HOME/cwd 文件树无散写。复用同一测试进程构建的 archive，不引入跨进程易失效缓存。
- 缺少 `dsh-bun-build/work/app` 时此新场景和已有三项 real-runtime 场景都以完整原因命名 SKIP（CI 不含输入，真实 archive 未验证），不会把假归档当真制品通过；work/app 存在但其他输入缺失仍失败。临时移走 work/app 后 `timeout 120 bun test ./test/real-runtime.test.ts` 实测 **0 pass / 4 skip / 0 fail**，四个名称均包含原因；随后原样恢复输入。

### 第 3 节最终验证、提交与任务状态

- 绿色中间提交 **8a9d82e**（feat(manager): install compatible runtimes from independent index）：Zig **44/44**；manager Bun **85 pass / 0 fail**、842 次断言；builder/runtime Bun **96 pass / 0 fail**、362 次断言；四目标交叉编译通过。
- 最终功能/验收提交 **d435f11**（fix(manager): verify install identities and preserve repair state），未 push。
- `cd dsh-manager && timeout 300 zig build test --summary all && timeout 1500 bun test ./test`：Zig **44/44**；Bun **113 pass / 0 fail / 0 skip**、**1050** 次断言、8 文件。install.test.ts 独立复验 **29 pass / 0 fail**、220 次断言；真实 archive **4** 场景本机全部实际执行。
- `cd dsh-bun-build && timeout 900 bun test ./test/unit ./test/runtime`：**96 pass / 0 fail**、**362** 次断言、24 文件。两个 Bun suite 合计 **209 pass / 0 fail**、**1412** 次断言；相比本轮前增加 manager **30** 场景、builder **2** 场景和 target **1** 个 Zig 单元场景。
- `timeout 300 zig build -Dtarget=<target> --prefix /tmp/dsh-section3-final-<target>`：**x86_64-windows-gnu、aarch64-macos、aarch64-linux、x86_64-linux-musl 全通过**。`timeout 60 zig fmt --check` 和 `git diff --check` 通过。仅为交叉编译；新 Windows/macOS 安装行为未在本机实际运行，父会话继续真实 CI。
- 勾选 **3.1、3.3、3.4**（限定本次授权场景）；**3.2 留空**，TLS-over-CONNECT gap 明列。普通自举/补全（第 4/5 节）、完整管理（第 6 节）、发布 pipeline（8.3）均未实现。无 package/self-update/addon/用户安装操作，无远程 push；未触碰 `openspec/changes/add-config-snapshots-and-paths/`。
- 2026-10-01 第五次 CI（36fc55d，第 3 节 3.1/3.3/3.4 完成后）：https://github.com/xz-dev/dsh-bin/actions/runs/36797830958
  - ubuntu-24.04、macos-15、windows-2022 全部通过。
  - 父会话本机独立复验：Zig 44/44；dsh-manager Bun 113 pass / 0 skip；dsh-bun-build 96 pass；x86_64-windows-gnu、aarch64-macos、aarch64-linux、x86_64-linux-musl 交叉编译通过。
  - 3.2 仍未勾选：HTTPS_PROXY 目前 fail closed，安全的 TLS-over-CONNECT 尚未实现。

## 4.1 RB-COMPLETION、SC-VERSIONS（sol）

- 本轮仅实现 4.1–4.3；所有新增代码及测试由本 worker 编写。定位真实 `work/app/lib/bin.js` 的 Commander `parseDshArgs`：根命令 literal option/version 声明，以及条件声明的固定 `plugin` 命令。构建器静态读取部署文件，不 import 应用、不加载 profile/plugin、不执行 help 来生成描述；不能识别的 command/option 声明使构建失败，不发布不完整词典。
- **red → green**：`cd dsh-bun-build && timeout 120 bun test ./test/unit/assemble-bundle.test.ts -t RB-COMPLETION` 初次 **0 pass / 1 fail**：bundle.json.requiredPaths 没有 completion.json。实现后 fixture（顶层 throw，若 import 必失败）仍可装配；导出 `{schemaVersion:1,commands:[{name,options:[{names,takesValue}]}]}`，固定文件位于归档根并列入 requiredPaths。fixture 的变更声明产生不同选项；动态 command 反例首次 **1 pass / 1 fail**（未抛异常而返回部分描述），补齐 declaration-count 门禁后通过。
- **真实归档一致性**：复用 real-runtime.test.ts 的本机真实 local-build ZIP，经 manager ZIP extractor 安装；真实应用 `--help` 的全部根 option names 与 completion.json 精确相等、takesValue 与 help 的参数占位符一致，固定 plugin 命令出现在真实 Usage/Examples。受控 mutation 把导出改成 `--wrong-cli` 后，`cd dsh-manager && timeout 900 bun test ./test/real-runtime.test.ts -t RB-COMPLETION` **0 pass / 1 fail**（实际 1 个错误选项，期望真实 8 个根 flag）；恢复 exporter 后实际执行并通过。plugin 没有独立只读 --help（上游要求 --profile），其固定声明由不执行应用的 fixture 和 Usage 检查覆盖，不运行插件探测。
- **缺输入明确跳过**：临时移走 work/app，同一真实检查 **0 pass / 1 skip / 0 fail**，测试名完整说明 `requires local dsh-bun-build/work/app (absent on CI; real archive not tested)`；随后原样恢复。CI fixture 导出始终运行。RL-RUNTIME-BUILD 用仅 runtime/scripts/package.json 的隔离 checkout、空 PATH、绝对 Bun 产出含 completion.json 的真实 ZIP；manager 最小独立 Zig 构建场景保持通过，不导入 builder 或 CLI 数据。

## 4.2 SC-COLD、SC-LOCAL、SC-VERSIONS（sol）

- 隐藏入口沿用 D10：`dsh manager __complete --shell bash|zsh -- <words...>`。words 不含 executable，最后一词是光标前缀（可为空）；只输出逐行候选。管理器候选、本地 runtime ID/tag/latest、snapshot 目录和 addon:name/version 查询；runtime CLI 使用现有 select.resolve 的 --use → --snapshot → selection/channel 优先级，描述不支持/缺失时只有安全本地管理候选。
- **red → green**：`timeout 180 bun test ./test/completion.test.ts` 初次 SC-COLD **0 pass / 1 fail**：__complete 未路由，退出 1。最小路由后空安装 **1 pass**，Bun.serve 记录 **零请求**，数据根不存在且 HOME/out 无新文件。随后 `-t 'SC-VERSIONS|SC-LOCAL'` **0 pass / 2 fail**：缺旧运行包 CLI 与本地 --use 候选；实现读取描述/目录后通过。补充 profile 值恰为 plugin 的反例先 **0 pass / 1 fail**（错误切到 plugin CLI），限定第一命令词匹配后通过。
- 两个 release 描述 `--old-cli` / `--new-cli`、一个 live 描述 `--live-cli`：固定默认、显式 --use（含 tag）、snapshot 版本和 latest/channel 均读取正确版本；missing/unknown schema 不回退应用探测，管理候选不变。fake-native 设置退出 91，若启动会写 marker；全程 out 为空。维护锁/runtime 锁由独立 probe 独占持有，query 仍返回，不获取阻塞锁。快照目录增加/删除后立即反映；文件树、入口字节不变，实际 home/profile 凭据探针不输出。

## 4.3 SC-SHELLS、SC-IDEMPOTENT、SC-COLLISION、SC-CURRENT（Bash/Zsh，sol）

- `manager completion script|install|uninstall <bash|zsh>`，install/uninstall 也接受 --shell。Bash 用户 .bashrc、Zsh `${ZDOTDIR:-$HOME}/.zshrc` 标记块；script 只输出。模板只调用原生 query，数组/逐行读数据，不 eval 候选。注册使用同目录原子文件，保留现有字节与 mode；标记记录 rc 原存在/新建，uninstall 还原原字节或删除仅由注册创建的空 rc。修改过的块、已有 user completion/标准位置 dsh completion 文件拒绝并保持内容，当前 shell 提示 source / complete -r / compdef -d。
- **Bash red → green**：`timeout 180 bun test ./test/completion.test.ts -t 'SC-SHELLS|SC-IDEMPOTENT|SC-COLLISION'` 首次 **0 pass / 3 fail / 3 skip**：completion 尚不可用，无脚本/冲突诊断。实现后真实 Bash **5.3.20** 加载注册，COMP_WORDS 调用补全函数得到 install/info/release；重复 install 与 source 无重复，uninstall 对无末尾换行的原 rc 字节相等。新增“foreign 函数恰好同名”和“用户改开头标记”反例先 **1 pass / 2 fail**，修复后 foreign 函数不被重定义，改写块不报成功移除。
- **Zsh 真正执行，不把 skip 当通过**：宿主 PATH 无 Zsh，普通 suite 明确 **4 skip**。本轮在 `/tmp/dsh-section4-zsh-o94gVp` 克隆 zsh-users/zsh 的 zsh-5.9、使用隔离 prefix 构建；第一次 build 因当前 ncurses 的 boolcodes 声明冲突失败，临时构建禁用 termcap 模块（未修改仓库/用户 shell），保留真实 compinit/compdef/compadd 完成系统，得到 **Zsh 5.9**。临时 PATH 加该 bin 后真实 shell 测试实际执行。
- **真实 Zsh 发现**：stock Zsh 自带另一个 Distributed Shell 的 `_dsh`，首次 clean harness **9 pass / 2 fail**，模板正确保留其 foreign mapping；没有削弱产品冲突检查。clean fixture 在已经 compinit 的测试会话中显式 unset 该映射；另用真实 compinit/compaudit/compdump/compinstall 的私有 fpath 验证未初始化路径。foreign fixture 则保留用户 compdef，断言不覆盖。非 ZLE harness 只替换最终 compadd 输出，真实 compinit/compdef 注册与 query 函数执行均保留。
- Zsh 旧路由反事实：临时让 completion 返回本轮前 not available，`PATH=/tmp/dsh-section4-zsh-o94gVp/install/bin:$PATH timeout 240 bun test ./test/completion.test.ts -t zsh` **0 pass / 4 fail**（缺 script/install/collision 能力，非解析错误）；恢复后整个 completion suite **11 pass / 0 skip / 0 fail**、**189** 断言，Bash/Zsh 各四个 shell 场景实际运行：生成/加载/候选、注册与重复/撤销、foreign 同名碰撞、改写保护、新建 rc 删除、标准 completion 文件碰撞、compinit 不重跑。
- CI Ubuntu 增加 apt 安装 zsh，macOS 显式验证 preinstalled zsh；Windows Bash/Zsh 名称带 `Windows shell harness not supported` 原因跳过。跨平台真实 CI 尚待父会话发起，本机 Zsh 已实际执行，所以按用户标准勾选 4.3。生成脚本遇到 stock `_dsh` 会保持它并提示 collision；需要用户显式处理既有 completion，不能偷偷接管。

### 第 4 节最终验证、提交与边界

- 绿色中间提交 **f20fece**（feat(completion): export runtime CLI and query offline Bash and Zsh candidates）：Zig **44/44**，manager **120 pass / 3 skip / 0 fail**、1174 断言；builder/runtime **97 pass / 0 fail**、370 断言，三个指定目标交叉编译成功。没有等所有 shell 证据才留下绿色提交。
- 后续 **55ae1b9**（fix(completion): preserve foreign hooks and reject partial CLI descriptions）与 **26deb9e**（test(completion): exercise real Zsh without adopting stock dsh hook），未 push。
- 最终命令（临时 PATH 加 isolated Zsh bin）：`cd dsh-manager && timeout 300 zig build test --summary all && timeout 1500 bun test ./test`：Zig **44/44**；Bun **125 pass / 0 skip / 0 fail**、**1251** 断言、9 文件，五个真实 archive 场景均实际运行。`cd dsh-bun-build && timeout 900 bun test ./test/unit ./test/runtime`：**99 pass / 0 skip / 0 fail**、**375** 断言、25 文件。合计 Bun **224 pass**、**1626** 断言；新增 manager **12** 场景（11 completion + 1 real archive）、builder **3** 场景。
- 无临时 Zsh PATH 的 full manager suite：**121 pass / 4 skip / 0 fail**、**1195** 断言；只跳过四项明确缺 zsh 的 shell 检查，其余真实 archive 和 Bash 均实际执行。
- `timeout 300 zig build -Dtarget=<target> --prefix /tmp/dsh-section4-final-<target>`：**x86_64-windows-gnu、aarch64-macos、x86_64-linux-musl 全成功**。`timeout 60 zig fmt --check src/completion.zig src/manager.zig`、`timeout 15 git diff --check` 成功。交叉编译不是 Windows/macOS 运行证据。
- 勾选 **4.1、4.2、4.3**；3.2 HTTPS_PROXY 缺口保持不变。
- TODO 4.4：Fish/PowerShell 留下一切未实现；不生成其他 shell 冒充支持。
- TODO 4.5：稳定 PATH/搬迁、完整空格引号非 ASCII 与元字符门禁仍未做；本轮仅固定绝对入口与安全 literal 词，不宣称全部 quoting/relocation 场景完成。
- 未触碰 `openspec/changes/add-config-snapshots-and-paths/`；其既有 untracked 目录未 stage/commit，无用户安装、包注册或远程 push 操作。
- 2026-10-01 第六次 CI（aeae6c7，4.1–4.3 完成后）：https://github.com/xz-dev/dsh-bin/actions/runs/36804179918
  - ubuntu-24.04、macos-15、windows-2022 全部通过。
  - 真实 zsh 测试在 ubuntu（apt 安装的 zsh）和 macos（系统自带 zsh）上实际执行并通过，真实 bash 测试在两个平台上同样通过；4.3 的勾选以此为依据。本机没有 zsh，这 4 项在本机明确标记为跳过。
  - windows 上 bash/zsh 的注册测试明确标记为跳过，原因已写明。
  - 父会话本机复验：Zig 44/44；dsh-manager 121 pass / 4 skip（均为 zsh）；dsh-bun-build 99 pass。

## 3.2 HTTPS 代理（TLS-over-CONNECT）

- **范围与根因**：只关闭 3.2 的 HTTP 代理承载 HTTPS 缺口，全部新增实现和测试由本 worker（gpt-6.1-sol）编写；不修改安装激活、zip、runtime、shell 或其他 change。Zig 0.15.2 `connectProxied` 在 CONNECT 后仍返回 proxy protocol 的连接，没有 origin TLS；禁止调用其 HTTPS fallback。本实现用标准 HTTP Request 发送 CONNECT，用 `std.crypto.tls.Client.init` 验证同一 socket 上的 origin，并仍用标准 HTTP Request 发送 GET/读取 body。`Connection.Tls` 私有，内部两字段与分配布局按 0.15.2 精确匹配；编译期版本锁阻止未经复核的工具链升级，没有自行实现 TLS/HTTP parser。
- **安全边界**：HTTPS_PROXY/https_proxy/ALL_PROXY/all_proxy 的 HTTP URL 支持 Basic userinfo；userinfo 先用 std.Uri 解码，凭据只进入 CONNECT、不进入 origin GET 或错误日志。只有 2xx 建立隧道（fixture 使用 201），SNI 与 hostname 为 origin，CA 使用系统 Bundle；附加 `DSH_MANAGER_TEST_CA_FILE` 仅在 `DSH_MANAGER_TEST=1` 生效。不可信 CA、hostname mismatch、生产模式下该变量均 fail-closed，origin 零 HTTP 请求、无 `.part` body、原 destination 保留；403/407 各 API 只发一次 CONNECT，不重试、不直连，407 提示检查代理凭据。`https://` 代理传输仍明确 UnsupportedProxy，proxy 零请求；这是 TLS 到代理自身的独立边界，不再把普通 HTTP CONNECT 代理称为不支持。
- **代理策略与超时**：NO_PROXY/no_proxy 覆盖逗号列表、域名边界后缀、`*`、无端口匹配、指定端口和 localhost；部分 label/错误 port 反例仍走代理。手动 redirect 在 proxied → NO_PROXY → proxied 三跳重算，Range 保留，只有两次 CONNECT，origin 没有 Proxy-Authorization。CONNECT 前设置 RCVTIMEO/SNDTIMEO，Windows 同步 adapter 从 CONNECT 到 TLS 握手/body 都复用；CONNECT 后不发 ServerHello 的 fixture 两 API 均在 3 秒内停止、各五次尝试，每条隧道首字节 `16 03`，没有明文 GET。DNS/TCP 和直连 TLS 无严格总 deadline 的原边界未扩大。

### red / green（真实进程与 socket）

- 首个纵向 red：`cd dsh-manager && timeout 180 bun test ./test/download.test.ts -t 'verified HTTPS download uses authenticated CONNECT'`：**0 pass / 1 fail**；期望下载成功退出 0，旧实现为 UnsupportedProxy/退出 1。实现后 **1 pass / 0 fail**、11 断言，实际 SHA-256、destination/part 和 CONNECT 认证/TLS 首字节均检查。
- 旧实现反事实基线：暂时恢复本轮前 http.zig（之后原样恢复），`timeout 300 bun test ./test/download.test.ts ./test/install.test.ts -t 'CONNECT|NO_PROXY|wrong hostname|https:// proxy transport|HTTPS redirect'`：**1 pass / 1 skip / 11 fail**。失败是旧实现拒绝所有 HTTPS 代理，包含 install 成功、证书验证、403/407、策略/redirect、timeout；https:// 代理场景原有拒绝能力不算新 red，额外失败仅为新清晰诊断断言。保留原 HTTP→HTTPS redirect 拒绝场景通过的事实，不把它冒充新功能证据。
- **实测追加反例**：userinfo `private%40user:s%3Ae%40cret` 经 std 原 Basic helper 得到 escaped 文本的 base64，而不是 `private@user:s:e@cret`。`timeout 180 bun test ./test/download.test.ts -t 'percent-encoded proxy userinfo'`：**0 pass / 1 fail**；改为 std.Uri 解码后通过。排查实现时一次 `.empty` 类型推断编译错误，已改显式 Component.empty；不将编译错误算行为 red。
- **证书断言强度**：分别临时关闭 CA 与 hostname 验证，`timeout 180 bun test ./test/download.test.ts -t 'untrusted CA, wrong hostname'` 各 **0 pass / 1 fail**，应拒绝却退出 0；所有 mutation 已移除。最终定向命令 `timeout 240 bun test ./test/download.test.ts ./test/install.test.ts -t 'CONNECT|NO_PROXY|wrong hostname|https:// proxy transport|HTTPS redirect'`：**13 pass / 1 skip / 0 fail**、**189** 断言。唯一 skip 名称明确为 `DSH_MANAGER_REAL_PROXY not set; real proxy not tested`；CI 不要求真实外网代理。
- **安装级闭环**：复用 install.test.ts 的 ZIP/index/fake-native fixture，从只有 manager 的新目录，通过本地 TLS origin 和带认证的 CONNECT relay 下载 runtime-index 与精确 archive，验证文件、初始化 snapshot 后激活；两次 CONNECT、两次 TLS ClientHello，安装过程不执行 runtime。停止 origin/proxy 后从该安装离线启动 recording runtime。它是安装级代理验收，不冒充通过代理下载真实上游制品。

### 最终验证、提交与边界

- `cd dsh-manager && timeout 300 zig build test --summary all && timeout 1500 bun test ./test`：Zig **44/44**；Bun **131 pass / 5 skip / 0 fail**、**1328** 断言、9 文件。5 skip = 既有本机缺 zsh 四项 + 新可选真实代理一项；既有 pinned Zig 0.15.2 LICENSE 真实系统根 HTTPS 下载、五个本机真实 archive 场景均实际执行。
- `cd dsh-bun-build && timeout 900 bun test ./test/unit ./test/runtime`：**99 pass / 0 fail**、**375** 断言、25 文件。两项目 Bun 合计 **230 pass / 5 skip / 0 fail**、**1703** 断言。
- 所有命令使用 timeout：`timeout 300 zig build -Dtarget=<target> --prefix <isolated-prefix>` 对 **x86_64-windows-gnu、aarch64-macos、aarch64-linux、x86_64-linux-musl 全成功**；`timeout 300 zig build-exe -target <target> -fsingle-threaded --dep http -Mroot=<download-driver.zig> -Mhttp=<src/http.zig> -femit-bin=<output>` 对 **x86_64-windows-gnu、aarch64-macos** 下载驱动全成功，避免 main-only 漏 http。`timeout 60 zig fmt --check src/http.zig`、`timeout 15 git diff --check` 成功。
- 第二次 full suite 的日志写入曾遇到 `/tmp` zram 的 ENOSPC（未获得有效完整结果，不计通过）；保持产品不变，将测试驱动 TMPDIR/TMP/TEMP 与日志放入 `/home/xz/.cache/dsh-proxy-validation` 后重新执行上述最终全部命令，均成功。最终日志在该目录的 logs/；red 初次记录在 /tmp/dsh-proxy-*.log。
- 绿色中间提交 **e0da27a**（feat(manager): verify origin TLS over HTTP proxy CONNECT）：Zig 44/44、manager 130 pass / 5 skip、runtime 99 pass，四目标与两个 driver 成功后提交；后续修正 **ae380ee**（fix(manager): decode HTTP proxy authentication userinfo）。无 push。
- **3.2 已勾选**，只关闭此授权 gap；Windows/macOS 本轮 CONNECT 运行仍待父会话真实 CI，交叉编译不充当运行证据。`https://` 代理传输、严格总 deadline 和工具链升级 layout 复核为明确残余边界；可选真实代理因未配置未执行。不触碰 add-config-snapshots-and-paths 或其他既有 untracked change，不操作用户真实安装/凭据。

## 4.4 SC-SHELLS、SC-IDEMPOTENT、SC-COLLISION、SC-CURRENT（Fish/PowerShell）

- **实现者与中断**：主体由 worker（gpt-6.1-sol:max，run f60044b8）编写，30 分钟超时退出时工作区未提交且无法编译：`completion.zig` 两处 `|shell|` capture 与外层 const 同名。父会话只把这两处改名为 `candidate`，并补写一个 transport 测试，其余实现均为 worker 产物。worker 的 red 运行记录未随超时输出保存，所以本节**不声称有 red→green**，只记录父会话复现的 green 以及 mutation 结果。
- **经父会话批准的设计决定（已向用户列出，等待最终认可）**：
  - shell 名为 `fish`、`pwsh`、`powershell`。
  - Fish 写入 `${XDG_CONFIG_HOME:-~/.config}/fish/completions/dsh.fish`，整个文件归 dsh 所有。
  - PowerShell 默认目标为 CurrentUserAllHosts：Windows 用 `SHGetKnownFolderPath(Documents)` 定位，非 Windows 的 pwsh 用 `$XDG_CONFIG_HOME/powershell/profile.ps1`；另有可选的 `--profile <绝对路径>`。
  - 四种 shell 都支持 `--dry-run`，只显示目标和将执行的动作，零写入。
  - 不反射 PowerShell 私有的 completer 表，只检测目标 profile 内的冲突。
  - PowerShell 候选改用 `DSH_COMPLETE_WORDS` 环境变量（U+001F 分隔）加 `--words-env` 传递，见 design.md。
- **本地真实 shell**：Fish 4.x（/usr/bin/fish）、pwsh 7.4（task-scoped 放在 `/var/tmp/dsh-section4.4-validation/pwsh`，未做系统安装）。`TMPDIR=/var/tmp/dsh-44 PATH=<pwsh>:$PATH bun test ./test/completion.test.ts ./test/completion-shells.test.ts`：**14 pass / 8 skip / 0 fail**。Fish 三项、pwsh 四项实际执行；powershell(5.1) 四项和 zsh 四项因本机没有对应 shell 而明确 skip。
- **transport 测试（父会话补写）**：`-t transport` 覆盖 `dsh manager `（空前缀）、`--channel `、`--use 'a b'`、`--use 'q"x'`、`--snapshot 'é ü'`，pwsh **1 pass**。mutation：把 Zig 的分隔符改成 0x20 后该项 **0 pass / 1 fail**，恢复后通过。本机无法运行 5.1，由 Windows CI 实际执行。
- **全量**：`zig build test` 通过；`bun test ./test` **139 pass / 9 skip / 0 fail**（skip 均为本机缺 zsh 或 5.1）。`zig fmt --check`、`git diff --check` 通过；x86_64-windows-gnu、aarch64-macos、x86_64-linux-musl 交叉编译成功（不作为运行证据）。
- **残余风险**：
  - 由其他模块或另一个 profile 在运行时注册的 dsh completer，用公开 API 检测不到，后注册的那个生效。
  - Fish 只拥有 completions/dsh.fish；config.fish 或 conf.d 中用户自己写的 `complete -c dsh` 不做扫描。
- **Windows CI 首轮（36812154908）**：powershell/pwsh 的 collision、dry-run 及默认 `$PROFILE.CurrentUserAllHosts` 比对通过，但 load/transport 共 4 项失败。在临时分支 diag/ps-completion 上跑诊断 CI（36812651256、36812811596）：5.1.20348 与 pwsh 7.6 不论直接运行、经 bun spawnSync 运行还是在完整环境下运行，`--words-env`、`--` 和 TabExpansion2 都返回正确候选，**产品本身没有问题**。失败的根因在测试 harness 的精简环境：① powershell.exe 冷启动 module 准备耗时 23–30 秒，超过 psRun 的 20 秒 timeout，进程被 kill 后 status=null；② 精简环境下 shell 内的原生调用无输出，TabExpansion2 于是回落到文件名补全。没有逐一定位到具体是哪个变量，因为用户真实环境不会剥掉系统变量。
- **修正（eb4b9f2）**：psRun 改为以真实进程环境为基础（滤掉 `DSH_*`），只覆盖 HOME/USERPROFILE/XDG/FAKE_OUT/PATH；profile 仍通过 -NoProfile/--profile 隔离；timeout 调到 90 秒。
- **CI 36813128417 三平台全绿**：windows-2022 上 powershell 5.1 与 pwsh 共 **10 项实际执行全部通过**（load/候选/重复注册/逐字节还原、words-env 的空前缀/空格/引号/非 ASCII、foreign completer 拒绝、改写块保护与 dry-run 零写入、默认路径与真实 `$PROFILE.CurrentUserAllHosts` 一致）；ubuntu-24.04 与 macos-15 的 Fish 三项实际执行通过。Windows 上 Fish/Bash/Zsh 写明原因 skip。
- **勾选 4.4**。4.5（稳定 PATH、搬迁、四种 shell 的完整 quoting 矩阵）未做。

## 4.5 SC-RELOCATE / SC-QUOTING

- 用户通过 supervisor 批准：注册时 Zig 查询 PATH 的第一个 dsh 命中并解析 realpath；只有它与当前 exe 相同才绑定 `name:dsh`，否则 `abs:<path>`。绑定写入所有权标记，验证原模板后允许移动后重新注册/撤销。无 `--command` 或 argv[0] 猜测。允许本地候选的可打印 UTF-8 名字（拒绝控制字符与路径分隔符），严格 CLI command/flag 校验不变；各 shell 对插入文本转义。
- 首轮 red：`TMPDIR=/var/tmp/dsh-45 PATH=/var/tmp/dsh-section4.4-validation/pwsh:$PATH timeout 300 bun test ./test/completion-relocate.test.ts`：**0 pass / 4 skip / 6 fail**。Bash/Fish/pwsh 的 PATH 绑定仍固定旧绝对 exe，移动后读不到新 snapshot；特殊字符 snapshot 被 safeWord 过滤而没有候选。Zsh、Windows PowerShell 缺宿主而明确 skip。日志 `/var/tmp/dsh-45/red.log`，失败发生于缺目标候选而非 harness 解析错误。
- 第一阶段 green：相同 `completion-relocate.test.ts` 命令 **6 pass / 4 skip / 0 fail**，Bash/Fish/pwsh 实际覆盖 PATH 更新后移动数据根、旧目录不存在、旧绝对绑定无候选、从新位置刷新/撤销，以及带空格/单引号/双引号/非 ASCII 的 exe 路径。Windows 文件名不能含双引号，Windows 样本明确省略该非法字符。候选含 `$()`、backtick、`;`、`*`、空格、非 ASCII、单引号；Bash/Fish 接受插入文本、pwsh 静态解析 CompletionText 都还原精确 literal，canary 不存在。测试 harness 的 eval 仅用于模拟用户接受转义后的插入词，产品无 eval。
- `completion.test.ts completion-shells.test.ts` **15 pass / 9 skip / 0 fail**；`zig build test --summary all` **44/44**。Zsh/Windows 真实运行留给 CI，4.5 未勾选。尝试先前孤立 Zsh binary 时出现本地 `sigsuspend` 等待（连既有 4.3 load 场景也挂起），未作为 green；没有修改生产逻辑规避此宿主行为。

### 4.4 独立复审（随 4.5 修复）

- 独立 reviewer 报告两项 P1（可编辑 ownership/count 导致删除用户父目录；PowerShell `"d`sh"` 绕过 foreign 检查）及 P2（自定义 profile 被错误宣称新会话自动加载）。父会话授权本 worker 同轮修复并单独提交。
- 复审 regression red：`TMPDIR=/var/tmp/dsh-45 PATH=/var/tmp/dsh-section4.4-validation/pwsh:$PATH timeout 200 bun test ./test/completion-shells.test.ts -t review`：**0 pass / 3 skip / 3 fail**。失败分别是 existing→created 改写被接受、真实 pwsh escaped foreign 补全被接管、自定义 profile hint 宣称 autoload；5.1 本机明确 skip。
- 用户批准统一 v2 block integrity：只允许 existing/created，不接受 created:N；SHA-256 行覆盖带 ownership/binding 的精确模板正文（不含 checksum 自己），改任何一字节则拒绝；从不删除父目录，文件仅在 created 且移除 block 后字节为空时删除，创建的 PS BOM 属 block。checksum 是修改探测，不是防恶意重算的认证。4.4 从未发布，不加 legacy fixture/migration，旧/未知 marker 拒绝并保持字节不变。
- PowerShell foreign scan 保守拒绝有 Register-ArgumentCompleter 且含 dsh/backtick/$/括号的代码；这会拒绝部分无关动态 completer，换取不覆盖无法排除的 foreign dsh。hint 统一为 sessions that load <file>，保留当前会话 dot-source。
- green：同环境 `bun test ./test/completion-shells.test.ts` **11 pass / 8 skip / 0 fail**，三个新增真实 pwsh review 场景实际通过，5.1 留给 CI。测试改为断言 parent directories 保留。
- **worker 超时后的接手（父会话）**：sol:high worker 跑满 60 分钟超时，此前已提交 8217a5e（4.5 主体）和 3dd1820（复审修复）。剩余未提交的是：PowerShell 绝对绑定改为先检查文件存在再调用、`completion-integrity.test.ts`（Bash/Zsh/Fish 篡改标记的回归测试）、元字符样本加入 `|`、`&`、`[x]`、PS 生成脚本加 BOM。父会话复跑通过后单独提交。
- **父会话手工复现三项复审问题**（自建 manager，隔离 HOME）：① 已有的空 profile 安装后，把标记 `existing` 改成 `created`，uninstall 返回 1，文件和用户目录都保留；② ``-CommandName "d`sh"`` 的 foreign 注册让 install 返回 1，profile 逐字节不变；③ 自定义 `--profile` 的提示为 "activates in pwsh sessions that load '<file>'"。
- **本地全量**：`zig build test` 通过；`bun test ./test` **151 pass / 17 skip / 0 fail**；completion 四个测试文件 **27 pass / 16 skip / 0 fail**（Bash/Fish/pwsh 的 relocate、quoting 和 review 场景都实际执行；skip 为本机缺 zsh 与 Windows PowerShell 5.1）。`zig fmt --check`、`git diff --check`、windows/macos 交叉编译成功。4.5 要等 CI 上 zsh 和 Windows PowerShell 真实跑过才勾选。
- **CI 36818715586**：ubuntu 和 macOS 全绿，其中 zsh 的 relocate、quoting 和 review 场景都实际通过。Windows 上 SC-QUOTING 失败两项，原因是测试里的快照名含 `*` 和 `|`，这两个字符在 Windows 目录名里不合法（mkdir ENOENT），与产品无关。修正（917ccd6）：Windows 样本去掉这两个字符，POSIX 样本保留它们继续覆盖。
- **CI 36819033894 三平台全绿**：
  - windows-2022：powershell 5.1 与 pwsh 的 SC-RELOCATE、SC-QUOTING、三个 review 场景以及 4.4 原有场景全部实际通过。
  - ubuntu-24.04 与 macos-15：Bash、Zsh、Fish 的 relocate、quoting 和 review 场景全部实际通过。
  - 每个场景都在对应 shell 上真实执行过；skip 只出现在不适用的平台（Windows 上的 POSIX shell、非 Windows 上的 5.1）。
- **勾选 4.5**。残余风险：
  - PowerShell foreign 冲突扫描偏保守：含 dsh、反引号、`$` 或括号的无关动态 completer 也会被拒绝。
  - checksum 用来发现误改，不能防有人故意重算。
  - 运行时由其他模块注册的 completer 用公开 API 检测不到。
  - 本机孤立构建的 zsh 曾出现 sigsuspend 挂起，zsh 的证据以 CI 为准。

## 5.1 FB-ORDER / FB-DECLINE / FB-REG-FAIL（首次交互补全选择）

- **范围与批准**：只做 5.1，`launch.run` 的 ensureData 后、plan 前处理补全；没有 5.2 自动下载。用户通过 supervisor 批准识别后确认、按 shell 问一次、`[Y/n/o]` 默认同意及目标菜单、state/completion.json 结果格式；EOF 不写、无效状态明确拒绝、失败给重试命令后继续运行包检查。supervisor 后续确认：已识别 X 经 o 改选 Y 时记录 X declined、Y 注册结果，skip 记录 X declined。见 design D4。
- **真实终端 red**：`TMPDIR=/var/tmp/dsh-51 timeout 150 bun test ./dsh-manager/test/first-run.test.ts -t 'real terminal empty'`：**0 pass / 1 fail**，期望 `Register bash completion at`，旧程序立即输出 `no release-channel dsh runtime is installed`，没有等待同意；`/var/tmp/dsh-51/red.log`。最初 driver 名 pty.py 遮蔽 Python 标准库而报 AttributeError，改名 terminal-driver.py 后得到上述行为 red；不把 harness 错误算 red。
- **green**：`cd dsh-manager && TMPDIR=/var/tmp/dsh-51 timeout 180 bun test ./test/first-run.test.ts`：**8 pass / 0 fail，104 断言**。Python stdlib pty.openpty/setsid/TIOCSCTTY 提供真实终端，真实 Bash 与 Fish 保留为管理器父进程；测试驱动读到询问后才写答案。空/已有/损坏 runtime 都先询问，等待时 HTTP recorder **0 请求**、应用未启动、快照不存在、choice state 不存在；接受后才到启动或原空/损坏诊断。拒绝保留原 profile、注册失败用只读 HOME 实测 AccessDenied 后写 failed、给重试命令并继续启动；三类结果再次同 shell 都不询问，换真实 Fish 再问。未识别菜单列出目标、菜单接受/skip 不重问、Bash→o→Fish 后 Bash 不重问、EOF 不记选择及下次重问、损坏 state 拒绝均实际通过。
- **必要的 5.3 最小部分**：TTY 门禁，非 TTY 不读取答案；现有 fake runtime 的 stdin 原样通过，未记录为拒绝。未实现 5.3 空安装非交互自动下载；现有 manager/help/query 分流不变。
- **独立构建**：`zig build test --summary all` **44/44**；x86_64-windows-gnu 与 aarch64-macos 交叉编译成功。交叉编译不是实际平台运行。Windows real-console/ConPTY harness 未提供，first-run.test.ts 每条测试名称明确说明 skip 原因；macOS 采用 `$SHELL` 提示后确认（按批准不查祖先），真实 macOS PTY 运行待父会话 CI。
- **状态**：5.1 暂不勾选，等待父会话 CI 的 macOS 真终端结果；Windows 真实控制台未验收不冒充通过。HTTP 场景本片只证明零请求与询问顺序，不宣称接受/拒绝后自动下载（5.2 后补）。
- **追加顺序/输入反例与最终 green**：增加“等待询问时安装一个 runtime，回答后必须启动这个新 runtime”（不能在询问前缓存空目录）、Linux 父进程 Bash 优先于故意设成 Fish 的 `$SHELL`、EOF 中断菜单也不记选择，以及连续写入 `n\napplication input\nEOF` 后应用收到精确 `application input\n`（不缓冲吞掉应用输入）。10 个 PTY 场景最终 **10 pass / 0 fail，113 断言**。反事实 mutation 将 first_run 放到 plan 之后，`-t 'runtime installed while'` **0 pass / 1 fail**（旧空安装诊断先退出、没有询问），恢复后通过；日志 `/var/tmp/dsh-51/mutation.log`，所有 mutation 已移除。
- **最终全量验证**：`TMPDIR=/var/tmp/dsh-51 PATH=/var/tmp/dsh-section4.4-validation/pwsh:$PATH timeout 1800 bun test ./test` **161 pass / 17 skip / 0 fail，1718 断言，13 文件**；`zig build test --summary all` **44/44**；`zig fmt --check src/first_run.zig src/launch.zig`、`git diff --check` 通过；`zig build -Dtarget=x86_64-windows-gnu` 与 `-Dtarget=aarch64-macos`（prefix 均 /var/tmp/dsh-51 下）成功。本地全量的 17 skip 为缺 zsh、Windows PowerShell 5.1 或未配置可选真实代理，不把它们算执行通过。

### 4.5 独立复审（P1-a / P1-b / P2 修复）

- 仅修复 reviewer `96185f43` 的三项发现。P1-a：PATH 遇到首个空/相对目录立即选择绝对绑定，即使该目录当前没有 dsh 也不信任其后的绝对命中，防止换 cwd 后出现新 shadow manager。P1-b：PowerShell 文件级保守扫描先移除 backtick 再匹配注册标识符，escaped cmdlet 与 escaped CommandName 都拒绝。P2：Fish 返回原始候选，由 Fish 自身负责插入转义，不再 `string escape` 二次转义。
- **P1 red**：以 `088398b` 的原始 completion.zig 运行新增回归（随后原样恢复），`TMPDIR=/var/tmp/dsh-review-fix PATH=/var/tmp/dsh-section4.4-validation/pwsh:$PATH timeout 300 bun test ./test/completion-relocate.test.ts ./test/completion-shells.test.ts -t 'cwd-dependent|backtick-escaped'`：**0 pass / 1 skip / 3 fail**。真实 Bash/Fish 在 cwd 改变后执行了 canary dsh，真实 pwsh 对 ``Re`gister-ArgumentCompleter`` install 返回 0 而非预期拒绝。测试覆盖空 PATH、空 segment、`.`、`bin`、当前不存在但之后可 shadow 的相对目录；所有 canary 都在隔离 HOME。
- **Fish red**：`timeout 180 bun test ./test/completion-relocate.test.ts -t 'SC-QUOTING: fish'`：**0 pass / 1 fail**，真实交互 Fish 4.9.3 的 Tab 插入把候选的 quote/escape 字节带进最终参数（received 含 literal quotes），不是预期原始 snapshot 名。PTY 使用现有 Python stdlib terminal-driver.py、TERM=dumb（避免无终端应答时 Fish 启动查询等待）；先前 TERM=xterm 的 harness 超时不计行为 red。
- **green**：同环境 `timeout 300 bun test ./test/completion-relocate.test.ts ./test/completion-shells.test.ts -t 'cwd-dependent|SC-QUOTING: fish|backtick-escaped'`：**4 pass / 1 skip / 0 fail**，真实 Bash/Fish/pwsh 执行；唯一 skip 为 Windows PowerShell 5.1 需 Windows。Fish 测试启动真实 interactive shell，发送 Tab+Enter，把最终 `$argv[2]` 写文件并与含空格、`$()`、backtick、`;`、`*`、`|`、`&`、单引号、非 ASCII 的原始名字逐字节比较，canary 不存在；已删除 helper-eval 假验收。
- **最终本地验证**：`timeout 300 zig build test --summary all` **44/44**；`timeout 1500 bun test ./test` **163 pass / 18 skip / 0 fail**，181 场景/13 文件。skip 为缺本地 Zsh、Windows PowerShell 5.1、Windows drive-rooted PATH 原生语义检查，以及原有可选 real-proxy 检查。`zig fmt --check src/*.zig`、`git diff --check` 成功；`zig build -Dtarget=x86_64-windows-gnu`、`zig build -Dtarget=aarch64-macos` 成功（不是原生执行证据）。本机 pwsh 7.4.13。
- 实现提交：`8ec4dca`（P1-a/P1-b）；`b5a603d`（Fish 原始候选与真实插入、PATH canary 回归）。没有 push/CI 调用，没有改动 first_run.zig、tasks.md、其他 change 或真实用户配置；父会话需发起跨平台 CI 和复审，4.5 checkbox 本 worker 未变更。日志 `/var/tmp/dsh-review-fix/{red-p1,red-fish,green,full,zig}.log`。

- P1-a 同类 Windows 边界：Zig `isAbsolute` 会把 `\foo` 判为 absolute，但它依赖当前 drive；因此也要求 Windows PATH segment 含 disk designator。`076e0b7` 加入该 guard 和仅 Windows 运行的 dry-run 回归（从 manager 所在 drive/cwd 以 `\...` PATH 注册仍须绝对绑定），本机明确 skip，windows cross-build 成功。最终 full suite 为上述 **163 pass / 18 skip / 0 fail**。

### 4.5 复审修复的父会话验收

- 独立复审（run 96185f43）给出 BLOCK：P1 cwd 相关的 PATH 段会被绑定为 `name:dsh`，Tab 时会执行当前目录下的 `dsh`；P1 ``Re`gister-ArgumentCompleter`` 绕过冲突扫描；P2 Fish 用 `string escape` 导致两次转义。4.5 因此一度重新打开，修复后恢复勾选。
- 父会话手工复现（e39cc17，隔离 HOME）：在 `PATH=':/usr/bin:/bin'`、`''`、`'.:...'`、`'bin:...'` 下生成的脚本都绑定绝对路径，切到放有假 `dsh` 的目录按 Tab，canary 没有被创建；PATH 为绝对目录时仍绑定 `command 'dsh'`。转义 cmdlet 的 foreign 注册让 install 返回 1，profile 逐字节不变。修复前同一组命令能复现 canary 被执行和 profile 被覆盖。
- **CI 36823946979（e39cc17）三平台全绿**：ubuntu 164 pass、macOS 163 pass、windows 140 pass，均 0 fail。cwd shadow 回归在 Bash 和 Fish 上实际执行；Windows 当前盘根相对 PATH 场景执行；powershell 5.1 与 pwsh 的转义 cmdlet 回归执行；Fish 真实 Tab 插入（SC-QUOTING）在 ubuntu 和 macOS 上执行。
- 4.5 维持勾选。

## 5.1 父会话验收

- 4 个 worker 提交（40d15f1、c706182、f9f76e1、088398b）。按用户的决定：先推测 shell 再确认，每种 shell 各问一次；从推测出的 shell 按 `o` 改选或跳过时，把该 shell 记为 declined（父会话按用户规则推导，已告知用户）。
- 本地 `bun test ./test/first-run.test.ts` **10 pass / 0 fail**。**CI 36822121395 三平台全绿**：ubuntu-24.04 与 macos-15 上真实 PTY 的 10 个 FB 场景全部实际通过（顺序 × 未安装/已安装/损坏、等待期间安装、拒绝后在另一个 shell 再问、注册失败、检测不到时的菜单、`o` 与 EOF、终端输入不丢、状态无效时拒绝及非交互保持 stdin）。
- **Windows 的 10 个场景全部 skip**（windows-2022 上没有真实控制台/ConPTY 测试框架），Windows 的父进程 shell 检测和询问流程尚无运行证据。任务 5.1 没有点名 Windows，按此勾选；Windows 的真实控制台验收归入 8.2，作为明确的残余风险。
- 勾选 **5.1**。

## 5.2 FB-EMPTY（实施中）

- 本 worker 仅接通普通空安装的自动下载；复用 3.x 原生 installer，不添加下载确认，不改变固定/显式选择或损坏安装的拒绝规则。
- 首轮 red：`cd dsh-manager && TMPDIR=/var/tmp/dsh-52 timeout 300 bun test ./test/install.test.ts -t 'FB-EMPTY: ordinary|FB-EMPTY: automatic|FB-EMPTY: explicit'`：**1 pass / 2 fail**。普通空启动仍返回旧的 `no release-channel dsh runtime is installed`，退出 1 而不是 fake-runtime 的 37；坏哈希场景没有进入下载，因此未出现 HashMismatch。显式/固定缺失及损坏安装原有拒绝场景通过，不冒充新增 red。日志 `/var/tmp/dsh-52/red.log`。
- **green 与提交**：7639b61 `feat(manager): install compatible runtime on ordinary empty launch`。`TMPDIR=/var/tmp/dsh-52 timeout 300 bun test ./test/install.test.ts -t 'FB-EMPTY:|FB-EMPTY / FB-ORDER'` **7 pass / 0 fail**（含原有 host-libc 场景；新增六项）。空安装从运行包索引选择最新兼容 release，忽略同索引内 manager 身份、live、旧 release、协议/target 不兼容候选；仅请求 runtime-index 和所选 archive。原 argv（含 headless 参数，另测无参数不加 profile）、cwd、stdin、退出码 37 都保留，stdout 无管理输出；坏哈希不激活、不启动应用；显式/固定缺失与损坏运行包不联网。PTY 场景在补全询问阶段零请求，拒绝后才请求 index/archive，并以原 argv 启动、传播退出码 23，没有下载确认。
- **共享安装实现**：新增薄 `install.bootstrap` 复用维护锁、`perform` 的下载/校验/解包/激活；自动调用只向 stderr 报告，显式 install stdout 行为不变。锁内重查已安装目录，所以初始化过的空数据根并发启动两次都成功、仅一组 index/archive 请求。`state.channel` 已存在，直接沿用，不新增渠道记账；live+latest fixture 回装后渠道与选择字节不变，不冒充 6.5 卸载全部运行包的完整验收。
- **测试行为更新**：原 5.1 空 fixture 从“答完立即报缺 runtime”改成“答完才请求受控失败源”；storage-only 的空安装 fixture 使用同时开启测试 gate 的无效 URL，仍验证初次状态/自定位但禁止访问生产源。未弱化固定/损坏对象拒绝断言。
- **mutation**：暂时禁用 launch 的 bootstrap 条件，`-t 'FB-EMPTY: ordinary'` **0 pass / 1 fail**（预期退出 37，实际 1）；随后恢复源码。日志 `/var/tmp/dsh-52/mutation.log`。
- **边界发现，留给 5.4**：未初始化的数据根的两次同时首次启动可能在 installer 锁之前触发已有的所有权初始化竞争，第二个报 `data root conflict`。未改 context.zig。5.2 的并发测试明确初始化数据根、只验安装互斥；不能宣称完整 FB-CONCURRENT 已完成。

### 5.1 独立复审（5.2 同轮授权修复）

- reviewer（2228d76f）报告两项 P1：自动补全注册把管理消息写入应用 stdout；两个 PTY 的 stale completion state 互相覆盖，造成某 shell 下次再次询问。父会话授权本 worker 修复，各自单独提交，不改显式 completion 命令的 stdout 行为。
- **stdout red/green**：真实 PTY 只连接 stdin/stderr，shell 把 dsh stdout 重定向到隔离文件。确认注册后 stdout 必须精确为 fake runtime 的 `application stdout\n`，目标/action/current-session hint 必须在 stderr。`TMPDIR=/var/tmp/dsh-52 timeout 180 bun test ./test/first-run.test.ts -t 'writes hints only'` 首次 **0 pass / 1 fail**（hint 不在 stderr，而在重定向 stdout）；1f09338 `fix(manager): keep first-run completion output off stdout` 后 **1 pass / 0 fail**。复用 reporting flag，不复制注册逻辑；显式 install/uninstall/script 仍输出 stdout，原 shell suite 继续通过。
- **lost-update red/green**：并发真实 Bash/Fish PTY 同时到达提示（证明未跨提示持锁）；Bash 先拒绝，Fish 后拒绝。两项状态都必须保留，随后 Bash 不再询问。`-t 'concurrent Bash'` 首次 **0 pass / 1 fail**（Fish 的 stale 写入后 bash 键消失）；fbc9ba4 `fix(manager): merge first-run consent under a short state lock` 后与 stdout test 合跑 **2 pass / 0 fail**。答完才获取 `state/completion.lock`，重读并只合并本次涉及的 shell/origin/undetected 键，原子保存后释放；同键以最新回答为准，无效重读状态仍失败。
- **最终全量**：`TMPDIR=/var/tmp/dsh-52 PATH=/var/tmp/dsh-section4.4-validation/pwsh:$PATH timeout 300 zig build test --summary all` **44/44**；`timeout 1800 bun test ./test` **171 pass / 18 skip / 0 fail**，189 项、13 文件。新增六项 bootstrap + 两项 review 场景实际通过；18 skip 为缺 Zsh、Windows PowerShell 5.1、Windows 特定路径语义和未配置的真实代理，不计通过。`zig fmt --check src/completion.zig src/first_run.zig src/launch.zig src/install.zig test/fake-native.zig`、`git diff --check` 通过。x86_64-windows-gnu、aarch64-macos 交叉构建成功；它们不是运行证据。最终日志 `/var/tmp/dsh-52/final-*.log`。
- **任务状态**：5.2 暂不勾选，父会话下一步触发真实三平台 CI 后决定。5.1 原勾选由父会话处理；本 worker 不擅自更新。Windows 控制台/ConPTY 询问仍未实测，已有明确 skip；新非交互 bootstrap 场景在 Windows CI 应真实执行。未 push、未触发 workflow、未修改两个并行 change、未操作真实用户配置/安装。

## 5.1 复审修复与 5.2 父会话验收

- **5.1 独立复审（run 2228d76f）BLOCK，两项 P1**：① 两个终端同时首次启动，后答的那个会用旧状态整体覆盖先答的（实测 bash 答 n、fish 答 n 后状态里只剩 fish）；② 自动注册的提示写到了 stdout，污染应用输出。修复期间 5.1 视为重新打开，修复后恢复勾选。修复由 5.2 worker 单独提交：1f09338（stdout）、fbc9ba4（答完才加短锁、重读、合并）。
- **父会话手工复现**（918a8ea，自建 manager，真实 PTY）：
  - bash 和 fish 两个提示同时打开后都答 n，`completion.json` 得到 `{"bash":declined,"fish":declined}`，两项都保留。
  - stdin/stderr 接 PTY、stdout 重定向到文件，答 y：注册提示和自动安装信息都在 stderr，stdout 文件为空（fixture 没有可下载源，安装按预期失败，并给出重试命令）。
- 本地：`zig build test` 通过；`bun test ./test` **171 pass / 18 skip / 0 fail**；first-run 12 项与 install 的 FB-EMPTY 8 项全部通过。
- **CI 36830987643（918a8ea）三平台全绿**：
  - ubuntu 与 macOS：FB-EMPTY 各场景（最新兼容 release、argv/cwd/stdin/退出码、下载失败不激活且不启动、显式或固定版本缺失不自动安装、并发只激活一个、已记录的渠道保留、PTY 中先询问补全再下载）以及两项 5.1 复审回归都实际通过。
  - windows-2022：非交互 FB-EMPTY 6 项实际通过。PTY 相关场景因没有 ConPTY 测试框架而写明原因 skip。
- 勾选 **5.2**；5.1 维持勾选。残余风险：
  - 数据根尚未初始化时，并发首次启动存在 ownership 初始化竞争（worker 报告），归 5.4。
  - Windows 控制台交互仍无运行证据，归 8.2。

## 5.3 / 5.4

### 场景映射与最小实现

| 场景 | 已有入口/测试 | 本轮补足的外部断言 |
|---|---|---|
| FB-PIPE | `first_run.run` 的 stdin+stderr TTY 门禁；5.2 普通空启动保留 argv/cwd/stdin/exit | install.test.ts `FB-PIPE: empty noninteractive…` 用含 NUL 的 1 MiB 输入，由真实 Zig fake-runtime 流式 SHA-256，与测试侧摘要比较；不存 completion 选择。first-run.test.ts `FB-PIPE: noninteractive skip…` 验证下一次真实 Bash PTY 仍询问。 |
| FB-READONLY | main.zig 在 launch 前分流 manager 和仅一个顶层 help/version；completion.query 不启动应用；storage.test.ts 原有无创建断言 | install.test.ts `FB-READONLY: cold helper queries…` 覆盖 manager --help/--version/info/list、顶层 --help/--version/-h/-V、__complete、completion script；记录源零请求、无数据根/用户文件、无应用启动，共享继承 stdin 文件偏移仍在首字节；顶层和 list 明确显示未安装。未改变路由，`--profile … --help` 仍是应用调用。 |
| FB-OFFLINE | `launch.plan` 仅空目录自举；3.4 显式安装后停源启动；storage PS-MOVE | install.test.ts `FB-OFFLINE: installed pinned…` 固定版本带记录源启动零请求，停源后再次启动成功，selection 字节不变。 |
| FB-MISSING | launch.test.ts 缺失/歧义/固定选择/旧格式/协议/缺入口诊断；5.2 无网络 no-fallback | 加强既有 install.test.ts `FB-MISSING: explicit/pinned…` 为显式版本、快照、固定版本、缺入口、旧格式、不兼容协议六种；均不下载、不启动并提供具体修复入口。另加下述 5.2 复审存储损坏回归。 |
| FB-CONCURRENT | 5.2 已初始化数据根 install mutex 单激活；first-run 两种 shell 短锁合并 | 新 fresh-root 测试重复 24 轮双进程：两者成功或一成功另一明确初始化 retry；每轮只有一组 index/archive 请求、一个完整 bundle、marker 有效、不写/重置 selection，重跑成功。storage.test.ts 残留 temp/空或部分 marker 只报 retry，无接管/额外写入。 |
| FB-RETRY | 3.2/3.3 install.test.ts 断连 Range、坏哈希、激活前后 crash、选择不变 | 新 `FB-RETRY: interrupted automatic…` 从无 runtime、latest 选择开始，自动下载断连失败不激活/不启动/无快照；再次启动带 Range 完成验证，启动目标，selection 字节不变。不重复显式安装 crash 矩阵。 |

- **用户决定**（supervisor 转述的明确最终决定）：未初始化根的竞争无需工程化串行化；可预测错误优先。不新增锁、等待循环或自动修复，识别自身初始化 temp 或空/部分 marker 时只报清楚 retry 及安全恢复提示。保留 ensureData 原写入状态机。该过程可能两者均成功，也可能后到者非零退出；不会把非空无标记根自动接管。恢复提示明确禁止删除含用户数据的根。记录在 design.md D10。
- **生产改动**：context.zig 识别 `.dsh-data-<1..16 hex>.tmp` 和未完成的 marker 字节前缀，读取无 marker 后若另一进程刚发布 marker也按竞争诊断，不修改失败方的根。未增加依赖。
- **5.2 独立复审带入的 P1**（review run 9cbd750f，父会话本轮明确批准）：runtimes.list 原先忽略普通文件/悬空链接及目录打开/遍历错误，可误当空安装。单独提交 `a5c7294 fix(manager): refuse damaged runtime storage before auto-install`：只把不存在的 bundles/ 或真正无条目的目录视为空；bundles/ 链接/文件、非目录条目、隐藏未知条目、打开/遍历错误均带具体路径和 install --force/clean 指引拒绝。暂存实际在 tmp/，无需忽略 bundles/ 内任何隐藏名。回归覆盖普通文件条目、悬空链接、bundles/ 文件及隐藏未知条目，零请求、无激活/应用执行且树不变。Windows 跳过悬空链接子例（不假定权限），其余子例保留。

### Red / green

均在仓库根，`TMPDIR=/var/tmp/dsh-534`，真实本机 Zig 管理器/隔离 HOME/受控 origin，无宿主 JS runtime 位于被测 PATH。日志 `/var/tmp/dsh-534/`。

1. `timeout 180 bun test dsh-manager/test/install.test.ts dsh-manager/test/storage.test.ts -t 'FB-PIPE|FB-READONLY|FB-OFFLINE|FB-CONCURRENT: fresh|initialization residue|FB-RETRY: interrupted automatic'`：**3 pass / 3 fail** (`red.log`)。fresh-root 在实际并发中得到旧 foreign-conflict 而不是 retry；残留 temp 同因失败；binary 哈希缺少 fake 观测入口（这是测试探针缺口，不冒充生产 stdin bug）。补探针和 retry 诊断后，加 first-run 同过滤器 **7 pass / 0 fail** (`green.log`)。
2. 反事实输入消费检查：临时在 main 的 context.init 前读一字节 stdin，`timeout 180 bun test dsh-manager/test/install.test.ts -t 'FB-PIPE: empty|FB-READONLY'`：**0 pass / 2 fail** (`consume-counterfactual.log`)。二进制摘要不同；共享输入剩 `nread\x00sentinel` 而非 `unread\x00sentinel`。恢复原 main 后 `-t 'FB-PIPE: empty|FB-READONLY|FB-MISSING|FB-CONCURRENT: fresh'` **4 pass / 0 fail** (`green-focused.log`)。反事实修改未提交。
3. 5.2 review 回归 `timeout 180 bun test dsh-manager/test/install.test.ts -t 'FB-MISSING review'`：**0 pass / 1 fail**，旧实现进入自动安装并给 RuntimeDirectoryConflict 而非在联网前拒绝 (`damaged-red.log`)；修改后 **1 pass / 0 fail / 25 expect** (`damaged-green.log`)。
4. 初次 green 中错误把合法 JSON（无尾换行）识别成部分 marker，造成 3 fail；已修正为 trim 后比较严格不完整前缀。此是本轮实现错误，不算原缺陷的 red。

### 验证与剩余门禁

- `cd dsh-manager && zig build test --summary all`：**4/4 steps，44/44 tests passed**。
- `cd dsh-manager && bun test ./test`（PATH 前置 `/var/tmp/dsh-section4.4-validation/pwsh`）：**179 pass / 18 skip / 0 fail** (`suite.log`)。本轮新增 8 个场景测试全跑；fresh-root 24 轮（48 次并发启动 + 24 次复跑）完成。
- `zig fmt --check src test/fake-native.zig`、`zig build -Dtarget=x86_64-windows-gnu --prefix /var/tmp/dsh-534/windows`、`zig build -Dtarget=aarch64-macos --prefix /var/tmp/dsh-534/macos` 通过。交叉编译不当作原生执行证据。
- 本机 skip：Windows PowerShell 5.1/Windows PATH 语义、缺 Zsh、本轮无 real-proxy 环境；Windows PTY/ConPTY 仍需 8.2 原生证据。本轮 5.3/5.4 任务保持未勾选，等父会话三平台 CI/独立验收；不存在 Windows 交互 green 主张。
- 初始化 crash 残留只提供安全重试/人工恢复指引，不自动删除/修复，是用户批准的简化；损坏存储明确失败，clean 的具体实现仍属 6.6。不改用户真实 HOME/安装、不碰并行 change、不 push/dispatch。

### 5.2 复审与 5.3 / 5.4 父会话验收

- **5.2 独立复审（run 9cbd750f）BLOCK，P1**：损坏的安装被当成空安装。`bundles/` 里有普通文件或悬空软链接，或 `bundles` 本身是个文件时，普通启动仍会自动下载并启动应用。修复期间 5.2 视为重新打开；修复为 a5c7294：只有 `bundles/` 不存在或为空目录才算空安装，其他情况在任何网络请求之前给出一条明确诊断并退出，不加锁内复查，也不加修复逻辑。
- **用户决定（简单优先）**：并发首次初始化同一个空数据根时，后到的进程报错退出，提示重试（66542c0）。不加锁，不加等待或恢复机制，行为可预测即可。初始化留下的残余需要手动处理，诊断信息会说明。
- **父会话手工复现**（4e0ab50，复审 reproducer 指向当前工作区）：bundles 是文件、bundles 是软链接、运行包是普通文件、运行包是悬空软链接，这 4 种都退出 1，origin 请求数为 0，没有激活，stdout 为空；真正的空安装按预期请求 index 和 archive、激活并启动。
- **CI 36835396760（4e0ab50）三平台全绿**：ubuntu 180 pass、macOS 179 pass、windows 152 pass，均 0 fail。FB-PIPE（1 MiB 二进制 stdin 原样传递、跳过询问不记录选择）、FB-READONLY、FB-OFFLINE、FB-MISSING（含复审回归）、FB-CONCURRENT（24 轮全新数据根）、FB-RETRY 在三个平台都实际通过。只有「非交互之后的第一次交互仍会询问」这一项在 Windows 上因没有 ConPTY 而 skip，ubuntu 和 macOS 上已实际通过。
- 勾选 **5.3、5.4**；5.2 维持勾选。第 5 节全部完成。

### 5.3 / 5.4 独立复审

- 独立复审（run 0c9d9b9f）BLOCK，P1：新加的损坏存储检查把 `bundles/.DS_Store` 和 AppleDouble `._<name>` 也当成损坏，导致完整安装在 macOS 上无法启动、list 和 `--version` 都失败，属于 FB-OFFLINE 回归。修复 e111b37：检查前跳过 `.DS_Store`、`._*`、`Thumbs.db`、`desktop.ini`，其他情况仍严格拒绝；加了正向回归测试（带上述元数据文件的完整安装可以离线启动，list 和 `--version` 正常）。复审确认用户决定的初始化重试报错不算缺陷。

## 6.1 / 6.5

- **实现**（worker gpt-6.1-sol:xhigh）：fb0246e 新增原生 update、select、list（默认只读本地，`--available` 才读索引且只列运行包候选）以及运行包 uninstall；8d2837e 修正快照别名和 latest 的启动选择；d068660 补充 `--force` 与跨版本快照回装的测试。`uninstall --addon` 和 addon 选择归 6.3，目前明确报未支持。
- **supervisor 决定**（父会话按 spec 和旧行为判断，已写入 design.md）：
  - `select` 无参数时只显示当前选择；写入必须带 `--use`，`--snapshot` 只接受已存在的编号或别名，保存前先校验，省略则重置为 null；普通启动使用已存快照，命令行前置的选项会覆盖它，已存快照缺失时明确失败。
  - `use=latest` 加上已存的跨版本快照不算固定运行包。卸载全部运行包后，普通启动按记录的渠道回装并继续用该快照；命令行显式给 `--use` 或 `--snapshot` 时仍阻止自动安装。
- **场景与测试**（`test/versions.test.ts`）：MC-PIN / MC-NAMESPACE（update 不解除固定，普通启动仍用固定版本）；MC-CHANNEL（live update 失败时渠道、运行包和选择都不变，成功后记录 live）；MC-NAMESPACE（list 离线只读，`--available` 不列管理器）；MC-PIN（选择器歧义或缺失时拒绝且状态不变）；MC-REINSTALL（`--force` 替换损坏的运行包，快照文件、编号和选择都保留）；MC-LAST / MC-REINSTALL（解除固定后卸载全部运行包，数据保留，重装后复用原快照）；FB-RESTORE-CHANNEL（卸载最后一个 live 后普通启动回装 live，全新安装默认 release）。所有场景都用 fake-native 证明管理命令从不启动应用。
- **red 记录缺失**：worker 跑满 60 分钟超时，此前已有 4 个提交，但没有把 red 运行写进 evidence。这里不补一个没人跑过的 red→green，只记录父会话复跑的 green。
- **父会话复跑**：`zig build test` **44/44**；`bun test ./test` **187 pass / 18 skip / 0 fail**；versions 与 launch 共 **24 pass**；`zig fmt --check`、`git diff --check`、windows 和 macOS 交叉编译成功。
- **CI 36843683851（f3fcf1c）三平台全绿**：MC-PIN、MC-CHANNEL、MC-NAMESPACE、MC-REINSTALL、MC-LAST、FB-RESTORE-CHANNEL 和元数据回归在 ubuntu、macOS、windows 都实际通过。勾选 **6.1、6.5**；独立复审随 6.2 一起进行，如果不通过就重新打开。

## 6.2

- **red 已运行**：`cd dsh-manager && TMPDIR=/var/tmp bun test ./test/snapshots.test.ts` → **0 pass / 3 fail**（日志 `/var/tmp/dsh-62-red.log`）；原生 `manager snapshot list/new` 尚未实现，进程返回 1 而场景要求 0，覆盖命名/复制/空快照/编号、创建中断和 pnpm 型内部链接复制。
- **supervisor 确认**：只保留既有 `--target`（brief 中 `--from` 为命名笔误，不加别名），`snapshot new` 接受 `--use`；只复制 `profiles`，内部相对符号链接原样复制，绝对或越界链接明确拒绝并丢弃暂存，不修复 pnpm，不共享源文件。
- **首个 green**：同一命令 `TMPDIR=/var/tmp bun test ./test/snapshots.test.ts` → **3 pass / 0 fail / 75 assertions**；复制只遍历 profiles，文件独立复制，编号在复制前原子保留，中断后空缺不回收；相对内部链接和越界/绝对链接拒绝场景在本机 Linux 实际执行，Windows 此链接专项显式 skip（普通复制仍执行）。
- **MC-SNAPSHOT / MC-CROSS-SNAPSHOT 真实进程**：新增 `versions.test.ts` 场景使 fake-native 真正在所选 profiles 写插件标记；安装 B 继承 A 的最新 @2、更新 live 继承 B、卸载及删除全部 live 快照后自举按持久 counter 建 @2；跨版本试运行明确消费 A@2 且不复制/替换快照。`TMPDIR=/var/tmp bun test ./test/snapshots.test.ts ./test/versions.test.ts ./test/storage.test.ts ./test/launch.test.ts` → **44 pass / 0 fail**。
- **RB-PLUGIN 本机真实插件已运行**：`TMPDIR=/var/tmp bun test ./test/real-runtime.test.ts -t 'RB-PLUGIN / MC-SNAPSHOT'` → **1 pass / 0 fail / 24 assertions**，本机存在 work/app；以本地 `.tgz` 经真实 `dsh --use A plugin --profile snapshot-probe add <tgz> --offline --ignore-scripts` 安装并真正挂载插件，embedded pnpm，不要求宿主 Node/Bun；用发布脚本构建第二份真实归档并经原生 install 下载/校验，继承后在 B 真正挂载同一插件，跨版本试运行 B+A@1；源快照、共享配置、两份 runtime 的完整文件 SHA-256 和 manager 字节不变，修改副本不影响源。所有 HOME/workspace/data 都隔离。CI 若无 work/app，此门明确 skip，不用 fake 通过冒充真实插件。
- **mutation 证明**：临时把自动创建的 `previous(...)` 改为 null；fake 场景与上述真实插件场景各 **0 pass / 1 fail**，都因 B 没继承插件而 `ENOENT`（日志 `/var/tmp/dsh-62-mutation-{fake,real}.log`）；已撤销 mutation。
- **整套首跑发现并修复**：初次全套 **188 pass / 18 skip / 4 fail**；三个既有 completion-integrity 场景把首次冷编译算入默认 5s（supervisor 要求独立提交 `137d8dc test(completion): allow cold build time`，显式 300s）；一个 FB-CONCURRENT 仅允许初始化重试而没允许首次创建快照的 Busy/retry。supervisor 确认：已发布快照普通启动必须不取 store 锁；只有首次创建 fail-fast，允许命名的初始化或 snapshot Busy/retry 后有效重跑。已实现无锁复用，并新增持有独占 store 锁时两个并发普通启动均成功的测试。
- **最终本机验证**：`TMPDIR=/var/tmp PATH=/var/tmp/dsh-section4.4-validation/pwsh:$PATH bun test ./test` → **193 pass / 18 skip / 0 fail**（真实插件场景实际执行，日志 `/var/tmp/dsh-62-all-final.log`）；Zig **44/44**，format 检查与 Windows/macOS 交叉编译成功。交叉编译不是 runtime 验证；无 Zsh、Windows PowerShell/ConPTY、未配置真实代理的既有 skip 保留，Windows symlink 专项不声称已跑。首次创建中断只留 staging/已占编号，需要显式管理，不做自动恢复；使用中删除保护仍归 6.4。
- 最后收尾后再跑 `bun test ./test/snapshots.test.ts ./test/versions.test.ts ./test/install.test.ts ./test/completion-integrity.test.ts` → **57 pass / 0 fail**，Zig 44/44、format 和两份交叉编译再次通过；勾选 6.2 表示以上本机场景完成，独立复审及父会话三平台 CI 集成仍待执行。

### 6.1 / 6.5 独立复审

- 独立复审 `deb271af` 的两个 P1 本轮单独修复，不修改 6.1/6.5 勾选状态；最终验收及 CI 由父会话决定。所有测试使用隔离 HOME/数据根，`TMPDIR=/var/tmp/dsh-fix61`，本机真实 Zig 管理器、fake-native 与记录请求的本地发行源。
- **P1-a red 已运行**：`cd dsh-manager && TMPDIR=/var/tmp/dsh-fix61 bun test ./test/versions.test.ts -t 'FB-MISSING review'` → **0 pass / 1 fail / 8 filtered**（`/var/tmp/dsh-fix61/snapshot-red.log`）。准备 latest + A@1、卸载 A、删除 A@1，再普通启动：6.2 的持久计数已经避免重新生成 A@1，进程最终退出 1；但仍先请求 `/runtime-index.json` 和 A 的 archive，激活 A 并创建其他编号快照。回归在「必须零网络请求」处按预期失败，证明仍需在自举前校验已存快照。
- **P1-a 最小修复与 green**：`launch.plan` 在任何 bootstrap 调用前解析实际适用的持久快照，并保留该已解析对象供启动使用；显式前置 `--use`/`--snapshot` 仍覆盖持久默认。缺失时沿用单条 selected-snapshot 诊断，不联网、不激活、不创建快照、不执行应用，selection/counter 字节不变。`TMPDIR=/var/tmp/dsh-fix61 bun test ./test/versions.test.ts -t 'FB-MISSING review|MC-LAST / MC-REINSTALL|FB-RESTORE-CHANNEL|ambiguous/missing selectors'` → **4 pass / 0 fail / 5 filtered**（`snapshot-green.log`），包含 latest + 已存在跨版本快照按记录 live 渠道回装复用的原有场景；`bun test ./test/launch.test.ts` → **17 pass / 0 fail**（`launch-green.log`）；`zig fmt --check src/launch.zig` 通过。
- **P1-b red 已运行**：`cd dsh-manager && TMPDIR=/var/tmp/dsh-fix61 bun test ./test/versions.test.ts -t 'MC-CHANNEL review'` → **0 pass / 1 fail / 9 filtered**（`warning-red.log`）。固定 A、记录 release、添加 `bundles/stray-file` 后执行 `manager update --channel live`，收到退出 1 而非已完成安装应有的成功；失败发生在更新结束后的 pin 提示读取 `runtimes.list`，按预期命中复审缺陷。
- **P1-b 最小修复与 green**：pin 提示不再枚举所有运行包；只以已有持久选择的具体安全 ID 与刚安装的 ID 读取两份元数据，无法读取/解析则跳过提示，不调用 fatal 列表路径。陌生 sibling 不会把已提交的更新变成失败，正常更新仍报告固定版本。`TMPDIR=/var/tmp/dsh-fix61 bun test ./test/versions.test.ts -t 'MC-CHANNEL review|MC-PIN / MC-NAMESPACE|MC-CHANNEL:'` → **3 pass / 0 fail / 7 filtered**（`warning-green.log`），回归验证首次安装与已安装复用均诚实成功，渠道为 live，selection 不变，陌生文件不被删除，应用不执行；完整 `versions.test.ts` → **10 pass / 0 fail**（`versions-green.log`）；两份改动 Zig 文件的 format 检查通过。
- **独立复审原始 reproducer 复跑**：读取 `/var/tmp/dsh-review-61-tmp/probe.ts`，仅把 disposable worktree 的绝对 import 根替换为当前工作区，以 `TMPDIR=/var/tmp/dsh-fix61 bun --eval <probe>` 执行 → **退出 0，两项断言通过**（`reviewer-probe-green.log`）。缺失已存快照：退出 1、stdout 空、SnapshotNotFound 单条诊断、origin 零请求、bundles 空、未启动应用；pin 提示场景：退出 0、安装成功 stdout、记录渠道 live、固定选择保留、陌生 sibling 保留、未启动应用。
- **最终验证**：`cd dsh-manager && TMPDIR=/var/tmp/dsh-fix61 zig build test --summary all` → **4/4 steps，44/44 tests passed**（`zig-test.log`）；`TMPDIR=/var/tmp/dsh-fix61 PATH=/var/tmp/dsh-section4.4-validation/pwsh:$PATH bun test ./test` → **195 pass / 18 skip / 0 fail**（`suite.log`），真实插件继承场景实际执行。`zig fmt --check src test/fake-native.zig`、`zig build -Dtarget=x86_64-windows-gnu --prefix /var/tmp/dsh-fix61/windows`、`zig build -Dtarget=aarch64-macos --prefix /var/tmp/dsh-fix61/macos`、`git diff --check` 全通过。
- **剩余门禁与简化**：本轮没有 Windows/macOS 原生运行，也未 push/dispatch；父会话需做三平台 CI/独立复核。18 项 skip 为既有缺 Zsh、Windows PowerShell 5.1/Windows PATH 平台差异及未配置 real-proxy；交叉编译不算原生运行证据，Windows 控制台交互仍待 8.2。pin 警告只读已知具体 ID；元数据或 selection 无效时跳过提示，不因提示失败改变已完成安装的退出状态。没有新增等待/锁/恢复流程，不改并行 change 或任务勾选。

### 6.1 / 6.5 复审修复的父会话验收

- 用复审 reproducer（指向当前工作区）复跑 43c4d66：已存快照被删后，普通启动退出 1、请求数为 0、不启动应用；`bundles/stray-file` 存在时，`update --channel live` 退出 0 并如实报告成功，渠道为 live，固定版本的提示只写在 stderr。
- **CI 36851770783（43c4d66）三平台全绿**：两项复审回归在 ubuntu、macOS、windows 都实际通过。6.1、6.5 维持勾选。
- **6.2 勾选撤回，待复审**：6.2 的勾选是 worker 自己打的（297e723），不符合「复审通过（或问题修复）且 CI 全绿后由父会话勾选」的规则。CI 36848465930 已全绿，RB-PLUGIN 也由父会话在干净 worktree 上用真实应用跑过（1 pass、24 断言），但第一次独立复审 30 分钟超时、没有出报告，所以先撤回勾选，复审重新进行中。

## 6.3 — native office addons (work in progress)

- **RED (before product edits)**: `cd dsh-manager && TMPDIR=/var/tmp bun test ./test/addons.test.ts` → **0 pass / 3 fail**. Expected unmet MC-ADDON reason: install returns 1, stderr `addon management is not available in this build yet`; digest assertion receives that unsupported diagnostic instead of HashMismatch. Native lifecycle, slot/degrade and integrity cases recorded before implementation.
- **First GREEN**: `cd dsh-manager && TMPDIR=/var/tmp bun test ./test/addons.test.ts` → **3 pass / 0 fail / 72 assertions**; `TMPDIR=/var/tmp zig build test --summary all` → **44/44**. Download/extract/activation reuse runtime helpers; management never executes app. Real-office acceptance and whole-suite validation still pending at this checkpoint.
- **Supervisor decision**: automatic launch uses newest installed in-slot (seq); explicit/stored incompatible selection degrades, never runs out of slot; force cannot bypass slot; select still requires use, office:none disables and omission resets {}. Recorded in design.md. Runtime already consumes manager-selected office directory; no runtime policy edits needed.
- **REAL MC-ADDON GREEN**: `cd dsh-manager && TMPDIR=/var/tmp bun test ./test/real-runtime.test.ts -t 'MC-ADDON: real managed'` → **1 pass / 0 fail / 23 assertions**. Real work/addon-office kit JS + Linux WASM engine closure locally archived with new addon identity; real slotted runtime separately built, both installed via Zig over local fixture. Manager installation/select never boot application. Upstream office-to-pdf and skill-office activate without degradation; deleting selected addon then starting same profile shows both declared office degradations, one manager missing note, MISSING_CREDENTIAL (normal credential-free termination), zero extra HTTP, unchanged manager/runtime bytes and empty isolated HOME/workspace.
- **REAL mutation RED**: temporarily replace manager addon payload resolver with empty Launch; same command → **0 pass / 1 fail / 11 assertions**, actual enabled launch emits both `DeclaredDegradation` lines and fails expected not-to-contain assertion. Restored resolver immediately. Real fixture absent/non-Linux hosts explicitly skip; no pass claimed there. Changed real-runtime harness scratch location from real HOME/.cache to TMPDIR to preserve isolation.
- **Whole-suite first run**: `TMPDIR=/var/tmp PATH=/var/tmp/dsh-section4.4-validation/pwsh:$PATH bun test ./test` → **198 pass / 18 skip / 2 fail**. Existing launch contract expected repeated office tokens last-wins; now every token validates then final value wins (supervisor approved). Larger real fixtures made afterAll exceed default 5s; explicit 60s cleanup timeout approved. Focused launch/addon rerun → **20 pass / 0 fail / 199 assertions**.
- Additional archive-metadata/root cases and disable-with-no-runtime paths: `TMPDIR=/var/tmp bun test ./test/addons.test.ts` → **4 pass / 0 fail / 89 assertions**. Correct hashes do not bypass slot/tag/root validation; `--force` failure preserves old generation. Available addon candidates require host asset and slot; disabling addon does not require an installed runtime.
- **Final full GREEN**: `cd dsh-manager && TMPDIR=/var/tmp PATH=/var/tmp/dsh-section4.4-validation/pwsh:$PATH bun test ./test` → **200 pass / 18 skip / 0 fail / 2605 assertions**. All five MC-ADDON scenarios actually ran, including real upstream office enabled/missing launches. Log: `/var/tmp/dsh-63-suite-green.log`. Local skips: Windows PowerShell/drive-relative cases need Windows; zsh unavailable; env-gated external real CONNECT proxy fixture. No skipped scenario counted as pass.
- **Validation**: `TMPDIR=/var/tmp zig build test --summary all` → **44/44**; `zig fmt --check src/*.zig`, `git diff --check`, `zig build -Dtarget=x86_64-windows-gnu --prefix /var/tmp/dsh-63-windows`, `zig build -Dtarget=aarch64-macos --prefix /var/tmp/dsh-63-macos` all exit 0. Cross-build is compile evidence only, not native runtime evidence. No build/runtime source edited; dsh-bun-build suite not required by this slice.
- **Post-audit focused GREEN**: `TMPDIR=/var/tmp bun test ./test/addons.test.ts ./test/versions.test.ts ./test/launch.test.ts` → **31 pass / 0 fail**; empty addon-tag suffix rejected and read-only select displays stored office choice. Parent independent review and Windows/macOS native CI still required; task checkbox untouched.
- **Final committed-product rerun (1d3806c)**: same full-suite command → **200 pass / 18 skip / 0 fail / 2608 assertions**, `/var/tmp/dsh-63-suite-final.log`; confirms post-audit changes, not only earlier checkpoint.

### 6.2 独立复审

- 本轮只修复独立复审 `d98d010f` 的两个数据损失 P1，不修改任务勾选；所有 fixture/HOME/数据根均隔离，TMPDIR=/var/tmp/dsh-fix62。
- **P1-a red 已运行**：`cd dsh-manager && TMPDIR=/var/tmp/dsh-fix62 bun test ./test/snapshots.test.ts -t 'MC-SNAPSHOT review: chained'` → **0 pass / 1 fail / 4 filtered**（`/var/tmp/dsh-fix62/link-red.log`）。`dir/alias -> .` 与 `dir/alias/alias/../../../<A>@1/profiles/probe` 链接通过旧词法检查，复制成功后经副本写入把来源的 `source original` 改成 `changed through copy`；独立性断言按预期失败。
- **P1-a 规则选择与 green**：采用 brief 选项 (2)：复制完成后，用标准库 `Dir.realpathAlloc` 在完整暂存 profiles 树解析每个链接，解析失败或真实目标越界时给命名诊断、丢弃 staging、不发布；保留原词法拒绝检查。没有自行实现链接展开器，也不禁止可正常解析的内部链接链；完整副本存在后再检查，不依赖迭代顺序。`TMPDIR=/var/tmp/dsh-fix62 bun test ./test/snapshots.test.ts` → **5 pass / 0 fail / 91 assertions**（`link-green.log`），含 pnpm 结构正例、链式链接来源独立性、无发布/无 staging 残留且已占编号保留。`TMPDIR=/var/tmp/dsh-fix62 bun test ./test/real-runtime.test.ts -t RB-PLUGIN` → **1 pass / 0 fail / 24 assertions**（`plugin-link-green.log`），真实插件安装与跨版本继承实际执行。`zig fmt --check src/snapshot.zig`、`git diff --check` 通过，产品与测试先提交。
- **P1-b red 已运行**：`cd dsh-manager && TMPDIR=/var/tmp/dsh-fix62 bun test ./test/snapshots.test.ts -t 'MC-SNAPSHOT review: replacing'` → **0 pass / 1 fail / 5 filtered**（`remove-red.log`）。测试先保留供列表校验的 snapshots 根句柄，但删除仍使用旧绝对路径；双重 test-only 环境开关启用校验后 stdin barrier，外部测试进程把 snapshots 改名并换成隔离外部目录链接后再放行。旧删除退出 0，外部 sentinel 已消失，断言按预期失败。无 strace 依赖；Windows 用 junction，场景不按平台 skip。
- **P1-b green**：列表元数据校验与删除沿用同一个 snapshots 根句柄，删除只传已校验的单个 basename 给 `Dir.deleteTree`；祖先被替换后仍删除原受管目录，外部文件不碰，不增加等待/重试/恢复。测试 barrier 只在 `DSH_MANAGER_TEST=1` 且 `DSH_MANAGER_TEST_PAUSE=snapshot-remove` 时读取 stdin，正常生产路径不读输入、不暂停。`TMPDIR=/var/tmp/dsh-fix62 bun test ./test/snapshots.test.ts` → **6 pass / 0 fail / 98 assertions**（`remove-green.log`），外部 sentinel 完整保留，原快照删除、退出 0、应用不执行；`zig fmt --check src/snapshot.zig`、`git diff --check` 通过，产品与测试先提交。
- **复审原始 probes 复跑**：仅把 `/var/tmp/dsh-review-62b-runs/{probe,remove-race}.ts` 的 harness import 改为当前工作区，分别以 `TMPDIR=/var/tmp/dsh-fix62 bun /var/tmp/dsh-fix62/{probe,remove-race}.ts` 执行 → **均退出 0**（`reviewer-probe-green.log`、`reviewer-remove-race-green.log`）。链式越界复制退出 1，`leak` 单条命名诊断，来源字节不变；静态 snapshot symlink 与 FIFO 拒绝，正常删除不跟随内部外部 symlink。strace 原始祖先替换探针确实完成替换，删除退出 0，外部 sentinel 存在、原快照已删除。
- **最终本机验证**：`cd dsh-manager && TMPDIR=/var/tmp/dsh-fix62 zig build test --summary all` → **4/4 steps，44/44 tests passed**（`zig-test.log`）；`TMPDIR=/var/tmp/dsh-fix62 PATH=/var/tmp/dsh-section4.4-validation/pwsh:$PATH bun test ./test` → **202 pass / 18 skip / 0 fail / 2627 assertions**（`suite.log`）。两个复审回归、真实 RB-PLUGIN 与真实 office 启用/缺失场景全部实际执行。`zig fmt --check src test/fake-native.zig`、`zig build -Dtarget=x86_64-windows-gnu --prefix /var/tmp/dsh-fix62/windows`、`zig build -Dtarget=aarch64-macos --prefix /var/tmp/dsh-fix62/macos`、`git diff --check` 均通过。
- **剩余门禁**：本轮只有 Linux 原生运行；Windows/macOS 交叉编译不算原生验收，父会话需运行三平台 CI 与独立复核。祖先替换回归计划在 Windows 使用 junction 且不 skip，但本轮没有 Windows runtime 证据；链式 symlink 与既有 pnpm symlink 专项沿用 Windows skip，待原生平台验收。18 个本机 skip 为缺 Zsh、Windows PowerShell 5.1/Windows 路径语义及未配置真实外部 CONNECT 代理；不算通过。使用中保护仍属 6.4，本轮没有扩张成对任意同用户进程后续篡改文件系统的沙箱/恢复机制；编号空缺仍不回收。未 push/dispatch，未碰并行 change、addon 产品代码或任务勾选。

### 6.3 独立复审

- 本轮只修独立复审 `197150d6` 的两个数据损失 P1；不修改任务勾选，不 push/dispatch。所有 HOME、发行源与数据根隔离，`TMPDIR=/var/tmp/dsh-fix63`。
- **P1-a red 已运行**：`cd dsh-manager && TMPDIR=/var/tmp/dsh-fix63 bun test ./test/addons.test.ts -t 'MC-ADDON review: uninstall'` → **0 pass / 1 fail / 3 assertions**（`remove-red.log`）。先保留 no-follow office 根句柄供元数据校验，但删除仍用旧绝对路径；`DSH_MANAGER_TEST=1` 且 `DSH_MANAGER_TEST_PAUSE=addon-remove` 启用校验后 stdin barrier，测试把 addons 改名并换成隔离外部目录链接（Windows 为 junction）后放行。旧删除退出 0，外部 sentinel 被删除，预期存在断言收到 false，按预期命中缺陷。
- **P1-a green**：元数据读取、枚举与删除沿用同一 no-follow office 根句柄；仅传已校验的 basename 给 `Dir.deleteTree`，没有重建删除路径。`TMPDIR=/var/tmp/dsh-fix63 bun test ./test/addons.test.ts` → **5 pass / 0 fail / 98 assertions**（`remove-green.log`），外部 sentinel 字节完整、原受管 addon 已删、应用不执行；`zig fmt --check src/addons.zig` 通过。产品与回归先独立提交。
- **P1-b red 已运行**：`TMPDIR=/var/tmp/dsh-fix63 bun test ./test/addons.test.ts -t 'MC-ADDON review: force install'` → **0 pass / 1 fail / 3 assertions**（`install-red.log`）。已安装 A、准备同名外部 sentinel；清空下载缓存，本地 archive handler 在下载期间把 addons 换成外部链接。旧 `--force` 返回 0，exchange 把外部目录移入 staging 并由 defer 清掉；sentinel 断言收到 false，按预期命中数据损失。
- **P1-b green**：共享 installer 保留 validated destination-parent 与 tmp 句柄，staging/backup 只传 basename；Linux `renameat2(..., RENAME_EXCHANGE)`、macOS `renameatx_np(..., RENAME_SWAP)` 使用两个真实 dirfd，Windows 沿用既有 retirement/rollback，但全部改为 `std.fs.rename` 的源/目标句柄。guard 也相对已打开目标目录获取；staging 解包、读取/写入、defer 清理与 backup 恢复/清理不重建绝对路径。ZIP 复用同一 extractor，仅增加接收现有 staging handle 的入口，不新增解析器或恢复机制。runtime 安装共用此修复路径。
- `TMPDIR=/var/tmp/dsh-fix63 bun test ./test/addons.test.ts ./test/install.test.ts ./test/versions.test.ts` → **59 pass / 0 fail / 931 assertions**（`activation-green.log`）；addon 下载期 ancestor swap 保留外部 sentinel、不在外部激活新 addon、原受管目录成功更新且 staging 清净；runtime 正例同时换 bundles 与 tmp 两个祖先，外部两树完整、原受管 runtime 更新、插件快照不变、应用不执行。既有 force/usage-lock/crash/hash/size/ZIP 边界场景仍通过。产品与测试独立提交，平台原生门禁待后续。
- **复审原始 probes 复跑**：仅把 `/var/tmp/dsh-review-63-runs/{remove-race,install-race}.ts` 的 import 根替换为当前工作区，执行 `TMPDIR=/var/tmp/dsh-fix63 bun /var/tmp/dsh-fix63/reviewer-{remove-race,install-race}.ts` → **均退出 0**（`reviewer-remove-race-green.log`、`reviewer-install-race-green.log`）。strace 删除探针完成真实祖先替换：退出 0，外部 sentinel 在、原受管 addon 已删；下载期 force 探针完成替换：退出 0，外部 sentinel 在、外部没有新 addon、原受管 addon 更新，应用未启动。
- **最终本机验证**：`cd dsh-manager && TMPDIR=/var/tmp/dsh-fix63 zig build test --summary all` → **4/4 steps，44/44 tests passed**（`zig-test.log`）；`TMPDIR=/var/tmp/dsh-fix63 PATH=/var/tmp/dsh-section4.4-validation/pwsh:$PATH bun test ./test` → **205 pass / 18 skip / 0 fail / 2654 assertions**（`suite.log`，241.28s）。两个 addon 复审回归、runtime 双祖先回归、真实 RB-PLUGIN 与真实 office 启用/缺失场景均实际执行。另按指定命令 `bun test ./test/real-runtime.test.ts -t 'MC-ADDON'` → **1 pass / 0 fail / 23 assertions**（`office-green.log`）。`zig fmt --check src test/fake-native.zig`、`zig build -Dtarget=x86_64-windows-gnu --prefix /var/tmp/dsh-fix63/windows`、`zig build -Dtarget=aarch64-macos --prefix /var/tmp/dsh-fix63/macos`、`git diff --check` 均通过。
- **平台与剩余边界**：本轮仅 Linux 原生运行；Windows/macOS 交叉编译只证明编译/链接，不冒充 runtime 验收。Windows rename 使用 Zig std 的 NT handle-relative RootDirectory，保留原 retirement/rollback；macOS swap 改用 dirfd 版本但本轮未原生运行；父会话仍需三平台 CI/独立复核。ancestor 回归在 Windows 使用 junction，不按平台 skip。18 个本机 skip 是既有 Zsh 缺失、Windows PowerShell/路径语义与未配置外部 real CONNECT proxy；不算通过。未新增锁/等待/恢复机制，生产路径不暂停、不读取测试输入；只沿用已授权的 test-only 双开关 stdin barrier。6.4 的 addon 使用中保护、6.6 的残留处理不扩张到本轮；不声称为任意同用户持续篡改文件系统提供完整沙箱。
- **父会话追加授权的 Windows 测试修正**：父会话报告 CI 36860115905 在 Windows 的 snapshot ancestor 改名步骤抛出 EPERM（目录句柄仍打开，攻击本身被 OS 阻止）。本轮仅改测试，统一 `harness.replaceAncestor`：只有 Windows 且 rename 抛出 EPERM 时输出 `ancestor swap blocked by Windows EPERM for open validated directory`，返回未移动的根；其他异常继续抛出，POSIX 仍完整执行改名/替换。snapshot/addon 删除测试都会放行 barrier 并断言退出 0、原对象已删、外部 sentinel 完整；addon/runtime 下载期回归也使用同一 helper，必须尝试 swap，继续检查更新及外部树不变。四个 ancestor 场景仅按 hasZig gate，Windows 不 skip。独立 test-only commit，没有改变产品语义或把失败冒充 skip。
- `TMPDIR=/var/tmp/dsh-fix63 bun test ./test/addons.test.ts ./test/install.test.ts ./test/snapshots.test.ts` → **55 pass / 0 fail / 803 assertions**（`windows-test-adjustment-green.log`）；本机实际执行 POSIX swaps，Windows EPERM 分支待父会话 windows-2022 原生 CI，不声称本机验证。
- **测试修正后最终整套复跑**：`TMPDIR=/var/tmp/dsh-fix63 PATH=/var/tmp/dsh-section4.4-validation/pwsh:$PATH bun test ./test` → **205 pass / 18 skip / 0 fail / 2657 assertions**（`suite-final.log`，182.57s）。四个 ancestor 回归和真实 RB-PLUGIN、office 启用/缺失都实际执行；committed diff 与 working diff 的 `git diff --check` 通过，staging 空，只有两个既有并行 change 未跟踪目录。

### 6.2 / 6.3 复审修复的父会话验收

- **6.2 复审（run d98d010f）BLOCK，两项数据丢失 P1**：链式相对软链接可以让复制出的快照写回源快照；删除时替换 `snapshots` 祖先目录可以删到数据根外的文件。修复 e09ba81（发布前在 staging 树内用 realpath 校验每个链接）、d67e4a2（通过已校验的目录句柄删除）。
- **6.3 复审（run 197150d6）BLOCK，两项数据丢失 P1**：addon 卸载和 `--force` 安装在下载期间替换祖先目录时，会删除或写入数据根外的目录。修复 cebb807、f0d788f；运行包安装共用同一激活路径，一并改为相对已校验的句柄操作。
- 136d3b6：Windows 上目录被打开时拒绝重命名（EPERM），祖先替换攻击本身无法成立；测试把它记为「无法替换」，并仍断言外部文件完好。CI 36860115905 曾在这里失败，属于测试问题而非产品问题。
- **父会话复跑复审 probe**（当前工作区，ff824a1）：
  - 6.2：链式链接复制被拒绝（"resolved target escapes profiles; nothing was published"），源文件保持 "SOURCE ORIGINAL"；删除时的祖先替换后外部文件仍在。
  - 6.3：卸载和 `--force` 安装时的祖先替换后外部文件仍在，新 addon 没有写到外部，原 addon 保留。
  - 真实应用测试由父会话在干净 worktree 跑过：RB-PLUGIN 1 pass / 24 断言（297e723），MC-ADDON 1 pass / 23 断言（a3a9369）。修复后 worker 又各复跑一次，都通过。
- **CI 36865069757（ff824a1）三平台全绿**：ubuntu 204 pass、macOS 203 pass、windows 174 pass，均 0 fail。快照和 addon 的祖先替换回归在 Windows 也实际执行，不是 skip。软链接相关场景因 Windows 没有符号链接权限而 skip，在 ubuntu 和 macOS 上已实际通过。
- 勾选 **6.2、6.3**。

## 6.4

### 既有路径 → 场景映射与缺口

- MC-IN-USE：`launch.run` 已持运行包与快照 shared claim；`launch.test.ts` 的 `the running runtime holds the shared claim until it exits`、`storage.test.ts` 的 `RB-HOME: initial snapshot usage claim stays held until runtime exits` 已测基础。运行包卸载已有全量 claim 预检，force 激活已有 exclusive claim，但启动会等待/忽略错误，force 的诊断没对象 ID，Windows 激活提前解锁。
- 缺口：快照删除与 addon 卸载根本未检查 claim；manager 启动未持 addon claim；批量缺失/固定/占用诊断遇到第一项即返回，没有列出全部失败目标。
- RB-RESTART：`dsh-bun-build/runtime/app.ts` 重新持运行包/快照 claim，`compat/addons.ts` 重新持 addon claim；既有 `dsh-bun-build/test/runtime/snapshot-start.test.ts` 的 `RB-RESTART: an in-app restart keeps the launch, the snapshot and its claim` 和 `a running session holds the runtime's and the snapshot's claims until it exits` 验证消费同一载荷。6.4 新黑盒由另一 manager 进程改默认 B 后才触发 fake-native 内部重启，验证 A/S/addon 及 claims 不变；新普通启动才使用 B。
- Supervisor 批准：Windows 文件句柄默认 share-delete，保留 exclusive claim 至删除/替换完成，删除错误注释；运行包缺 guard 视为损坏、启动明确拒绝并提示 force/uninstall，但仍可卸载/force 修复；addon 缺 guard 按 6.3 已批准的损坏 addon 规则降级（一次 stderr 提示），不拒绝整个应用。

### Red（修改产品代码之前）

- `TMPDIR=/var/tmp/dsh-64 bun test ./test/in-use.test.ts ./test/versions.test.ts ./test/addons.test.ts -t 'MC-IN-USE|RB-RESTART'` → **0 pass / 6 fail / 43 断言**，日志 `/var/tmp/dsh-64/red.log`。
- 预期原因：使用中快照删除、addon 替换成功（应拒绝）；重启后的快照删除仍成功；批量卸载仅报第一个 missing，没有固定/占用项；busy 启动等待导致默认 5 秒测试超时；force runtime 仅报 `RuntimeInUse` 而没 ID，且下载已发生。

### 最小 Green checkpoint

- 同一 targeted 命令 → **6 pass / 0 fail / 110 断言**（`/var/tmp/dsh-64/green.log`）；`zig build test --summary all` → **44/44**。
- 使用中 runtime/snapshot/addon 的删除、force 替换均明确拒绝；退出后同命令成功。批量预检汇总所有 missing、selection、in-use 项，预检失败整个集合不删除。持 exclusive claim 至退出公开位置，普通启动占用时 fail-fast，不等待。
- Supervisor 补充批准：不提高 Windows 最低版本；删除统一为「相对已验证 parent handle rename 至同卷 data/tmp/.remove-* → release claim → delete」，避免 Windows delete-pending 阻止整树删除；force 替换持 claim 至新 generation active 再释放。最后删除失败仍报告对象已移除/新 generation 已激活，stderr 点名 tmp 残留并提示 6.6 clean，不重试。

### 启动 guard 完整性核对（父会话要求）

- 原生 `install.run`、`install.update`、`--force` 修复以及 `install.bootstrap` 均调用同一个 `install.perform`；staging 完成验证后、任何 `activate` 之前写入 `.dsh-install.json` 与 `.usage.lock`。故新装/更新/修复/首次自举不会发布一个无 guard 的健康运行包。`versions.test.ts` 对删除 guard 后 force 修复断言 guard 重建。
- 非 force 的 already-installed 分支不会替损坏包偷偷补 guard；无 guard 已有包仍按损坏状态明确要求 `--force`，不放宽启动拒绝。force 能修复、uninstall 能移除。
- 制品侧 `dsh-bun-build/scripts/assemble-bundle.mjs:requiredPaths/assembleBundle` 在 zip 之前写 guard，并把它列入 requiredPaths；真实制品 fixture `real-runtime.test.ts` 从此 zip 解包，后续 audit/copy 保留整个树，因此 guard 随树保留。
- 托管数据根测试：`storage.test.ts` 的 portage/Scoop 预置运行包（包括只读两个 Scoop manager 版本）统一使用 `harness.addRuntime`；它在复制 fake-native 前写 `.usage.lock`。`first-run`、`launch`、`manager-control`、`completion`、`completion-shells`、`completion-relocate`、`snapshots`、`addons`、`in-use` 的手造运行包同样全部走此函数；`install`/`versions` 的 archive fixture 没有自行发布目录，走真实 `install.perform`。
- 现有 Gentoo/Scoop 脚本仍是旧耦合发布的模板，6.4 没有声称它们的新托管集成已完成（7.4/7.5 未验收）；它们只解压完整制品或复制已有树，没有另造无 guard 的新格式 runtime 路径。新增托管入口的实现留给 7.4/7.5。未运行真实包管理器，也未触及用户安装。
- 实际整套运行包含真实运行包、普通/自动安装、force 修复及手造/托管 fixture；未出现健康安装的 guard-missing 拒绝。

### 强化回归与验证

- 下载期间才启动新 session 的 runtime/addon 两场景，证明 activation 必须重新检查，不能只靠下载前 probe。临时去掉 activation claim：`TMPDIR=/var/tmp/dsh-64 bun test ./test/versions.test.ts ./test/addons.test.ts -t 'activation rechecks'` → **0 pass / 2 fail / 8 断言**，两项都因替换竟成功而失败（`recheck-mutation.log`）；代码已恢复。
- 既有快照/addon 祖先替换 hook 的测试同时 probe shared lock，断言已通过预检的对象在实际退役前仍被 exclusive claim 保护。Linux/macOS/Windows 都执行，不新增 Windows skip。
- post-preflight 注入第二目标消失：第一项确已移除、stdout 仍报告该项；第二项明确失败并说明先前移除不回滚。`bun test ./test/snapshots.test.ts -t 'post-preflight'` → **1 pass / 0 fail / 10 断言**（`partial.log`）。每项成功后 flush，避免后续 fatal 丢掉已成功清单。
- 定向组合：`TMPDIR=/var/tmp/dsh-64 bun test ./test/in-use.test.ts ./test/versions.test.ts ./test/addons.test.ts ./test/snapshots.test.ts ./test/install.test.ts ./test/launch.test.ts ./test/storage.test.ts` → **106 pass / 0 fail / 1492 断言**（post-preflight 测试加入前）。
- 整套：`TMPDIR=/var/tmp/dsh-64 PATH=/var/tmp/dsh-section4.4-validation/pwsh:$PATH bun test ./test` → **213 pass / 18 skip / 0 fail / 2787 断言**（post-preflight 测试加入前，`full-final.log`）。18 skip 为本机 zsh 缺失、Windows/PowerShell 5.1 特有场景、未配置真实 HTTPS proxy；6.4 全部场景实际执行。真实应用/office 测试也在本机完整 suite 中执行，CI 因 work/app 缺失照既有规则 skip。
- `TMPDIR=/var/tmp/dsh-64 zig build test --summary all` → **44/44**；`zig fmt --check src test/fake-native.zig`、`git diff --check` 均通过。
- `TMPDIR=/var/tmp/dsh-64 zig build -Dtarget=x86_64-windows-gnu --prefix /var/tmp/dsh-64/windows` 与 `-Dtarget=aarch64-macos --prefix /var/tmp/dsh-64/macos` 均编译通过。本机未声称 Windows/macOS 原生执行通过：交由父会话三平台 CI。

### 后续边界

- 6.6 clean 尚未实现；此次仅增加退役残留 `.remove-<id>-<random>` 及明确提示。清理失败不回滚已移除对象/已激活 generation，也不重试；6.6 需识别此类残留。运行包/快照/addon 公开位置仍按相对已验证目录 handle 操作，祖先替换回归保持通过。
- 全量 exclusive preflight claims 一直持至逐项退出公开位置，故遵守 claim 的新 session 无法插入「预检 → 删除」间隙；不额外加事务、等待队列或后代追踪。未知外部程序不遵守 advisory claim 的任意文件系统破坏不在受管理会话保证内。
- 未改 tasks.md checkboxes；未 push、未触发 CI、未创建分支；待独立复审及父会话 CI 才验收 6.4。

### 最终工作树复跑（980403c）

- `TMPDIR=/var/tmp/dsh-64 PATH=/var/tmp/dsh-section4.4-validation/pwsh:$PATH bun test ./test` → **214 pass / 18 skip / 0 fail / 2793 断言**，232 tests / 17 files，237.38s（`full-release.log`）。上述 skip 原因不变；6.4 的九项新增场景、两个既有 ancestor-swap/claim probe 场景均实际通过。
- 同时再次 `zig build test --summary all` **44/44**、`zig fmt --check src test/fake-native.zig`、两 target cross-build、`git diff --check` 全通过。

### Guard generation 身份检查（supervisor 批准，续跑）

- Supervisor 批准在唯一入口 `lock.tryAcquireIn` 成功获锁后比较 opened handle 的 `File.Stat.inode` 与当前 guard 路径的 inode；缺失或不一致即 release 并返回 Busy，调用方点名对象、要求 retry，不新增等待。Windows 的 inode 是 file index，使用同一比较；原生可靠性仍由 Windows CI 验证。
- 单一 deterministic 回归：`versions.test.ts` 的 `MC-IN-USE: a guard retired between open and lock refuses the stale launch`，在 shared guard 的 open 与 flock/LockFileEx 之间用 test-only stdin barrier 暂停，另一 manager force 替换，恢复后必须明确拒绝而不启动应用；新普通启动仍成功。hook 仅在 `DSH_MANAGER_TEST=1` 且 `DSH_MANAGER_TEST_CLAIM_PAUSE` 匹配此 guard 时生效。
- Red 已运行：临时绕过 `checked` 身份比较，`TMPDIR=/var/tmp/dsh-64 bun test ./test/versions.test.ts -t 'guard retired'` → **0 pass / 1 fail / 4 断言**（`identity-red.log`）。预期原因：stale launch 返回 0 而非 1；mutation 已恢复，续跑仅收尾此批准范围。
- Green 同命令 → **1 pass / 0 fail / 10 断言**（`identity-green.log`）；复核恢复的产品代码后提交 **5ff2713 `fix(manager): refuse a claim on a retired guard generation`**。
- 续跑要求的全量验证仅跑一次：`TMPDIR=/var/tmp/dsh-64 PATH=/var/tmp/dsh-section4.4-validation/pwsh:$PATH zig build test --summary all && bun test ./test` → Zig **44/44**、Bun **215 pass / 18 skip / 0 fail / 2805 断言**，233 tests / 17 files，227.07s（`units.log`、`full-resume.log`）。
- 随后 `zig fmt --check src test/fake-native.zig`、`zig build -Dtarget=x86_64-windows-gnu --prefix /var/tmp/dsh-64/windows`、`zig build -Dtarget=aarch64-macos --prefix /var/tmp/dsh-64/macos`、`git diff --check 452440c` 均 **exit 0**（`*-resume.log`）。guard-path audit 已在上方「启动 guard 完整性核对」完整列出，无新增遗漏路径。
- 18 skip：本机无 zsh、Windows/PowerShell 5.1 特有测试、未配置真实 HTTPS proxy。新 guard identity 回归与既有 6.4 场景全实际执行；Windows/macOS 此次仅 cross-compile，不计原生验收。Windows file-index 比较的原生可靠性仍须三平台 CI；未启用平台豁免或新机制。

### 6.4 场景 → 回归索引（最终）

| 场景 | 回归文件与关键名称 |
|---|---|
| MC-IN-USE：会话持 runtime/snapshot/addon，删除拒绝、字节不变、退出后成功 | `in-use.test.ts`：`runtime, snapshot and addon batch removal refuse busy objects unchanged, succeed after exit` |
| MC-IN-USE：全量 missing/selection/busy 预检失败零删除 | `in-use.test.ts`：`runtime and snapshot preflight reports every missing, pinned/selected and busy target before any delete` |
| RB-RESTART：默认改 B，原会话重启仍 A/S/addon、claims 保留，新启动才 B | `in-use.test.ts`：`changing default during a session does not change restarted A/S/addon or release its claims` |
| MC-IN-USE：启动 fail-fast、缺 runtime guard 拒绝且可修复、缺 addon guard 降级 | `in-use.test.ts`：`a busy runtime launch fails fast; missing runtime guard refuses, missing addon guard degrades`；`versions.test.ts` force 重建 guard 断言 |
| MC-IN-USE：force 在下载前拒绝占用对象，字节不变、退出后修复 | `versions.test.ts` / `addons.test.ts`：`force runtime/addon replacement refuses ... before download` |
| MC-IN-USE：下载过程中出现会话，激活再次检查并拒绝 | `versions.test.ts` / `addons.test.ts`：`force runtime/addon activation rechecks a session that starts during download` |
| MC-IN-USE：open→lock 间 guard generation 被替换，拒绝 stale launch | `versions.test.ts`：`a guard retired between open and lock refuses the stale launch` |
| 已验证目录 handle 不重新解析、预检 claim 持至退役 | `snapshots.test.ts` / `addons.test.ts` 既有 ancestor-swap 回归新增 shared probe 必为 busy；`install.test.ts` runtime swap 回归保持通过 |
| 删除预检通过后真实文件系统竞争导致后续失败，报告已移除项、不回滚 | `snapshots.test.ts`：`a post-preflight removal failure reports the already removed snapshot without rollback` |

### Windows 退役顺序修复（CI 36879404161）

- **Red：父会话 CI 36879404161，85c3b36**。ubuntu/macOS 通过，Windows **161 pass / 49 skip / 23 fail**。读取保存日志 `/var/tmp/ci-36879404161.log`：22 项在闲置对象删除、force 替换成功断言收到 status 1；另 1 项是测试在 snapshot 预检暂停时重命名第二目标，直接抛 EPERM。没有将这组产品失败当作环境豁免。
- 根因核对：runtime/snapshot/addon 的移除都走 `install.remove`，force runtime/addon 都走 `install.activate`。二者在 Windows rename 时仍持目标内部 `.usage.lock` 的 open handle。Zig 0.15.2 默认 Windows min=win10 的 `posix.renameatW` 用非 POSIX 的 `FileRenameInformation` fallback；share-delete 并不允许重命名含打开子文件的目录。CI 中预检暂停期间的祖先/第二目标 rename EPERM 也印证此限制。当前主机不能原生 Windows 执行，因此最终修复是否有效仍必须由父会话下一轮 Windows CI 证明。
- **采用父会话批准的最小修复**：共享 `retire` helper 在 Windows 先释放自己的 exclusive guard handle，再通过已验证 parent/tmp handles rename；如果别的 session 恰在间隙打开 guard，Windows rename 拒绝，输出一条点名对象的 `in use or access denied; object unchanged, retry after sessions exit` 并返回非零。不等待、不重试、不新增锁。POSIX 仍在 claim 下 rename，退出公开位置后才释放，Linux/macOS exchange 不变。缺 guard 的损坏对象仍可移除/修复。
- `remove` 与 Windows `activate` 共用此顺序；三类删除调用方识别已报告错误，避免打印第二条泛化错误。所有路径仍相对保留的已验证目录 handles，无绝对路径回退。较早关于 Windows claim 保持到 rename/activation 完成的记录由本节更正。
- 回归没有新增 skip：guard open→lock 场景在 POSIX 仍要求 force 成功后 stale launch 拒绝；Windows 要求已打开的子文件阻止 force rename、旧对象不变、恢复后原 launch 成功，退出后 force 才成功。snapshot post-preflight 场景保留 POSIX 移走第二目标断言；Windows 如果测试自己的 rename EPERM，则打开第二目标的 `snapshot.json`，使 manager 释放自己的 guard 后仍被 Windows 拒绝，第一项仍删除并明确报告，第二项留原处。两项均验证真实操作，而非平台 skip。
- 本机定向 `TMPDIR=/var/tmp/dsh-64w PATH=/var/tmp/dsh-section4.4-validation/pwsh:$PATH bun test ./test/in-use.test.ts ./test/versions.test.ts ./test/addons.test.ts ./test/snapshots.test.ts ./test/install.test.ts` → **75 pass / 0 fail / 1178 断言**（`/var/tmp/dsh-64w/targeted.log`），包括所有 POSIX ancestor-swap 回归。
- 完整本机验证（**f2f6295**）：`zig build test --summary all` → **44/44**；`bun test ./test` → **215 pass / 18 skip / 0 fail / 2802 断言**，233 tests / 17 files，213.22s（`/var/tmp/dsh-64w/{units,full}.log`）。18 skip 原因不变：本机缺 zsh、Windows/PowerShell 5.1 专属场景、未配置真实 HTTPS proxy；真实应用与 office 测试本机实际执行通过。
- `zig fmt --check src test/fake-native.zig`、Windows x64 `zig build -Dtarget=x86_64-windows-gnu --prefix /var/tmp/dsh-64w/windows`、macOS arm64 `zig build -Dtarget=aarch64-macos --prefix /var/tmp/dsh-64w/macos` 均 exit 0。首次 `git diff --check` 发现本证据文件 EOF 多一个空行，删除后复跑通过。
- **尚未声称 Windows 原生 green**：本机只能 cross-build。Windows 开放后代 handle 阻止 rename、释放自身 guard 后闲置目录能退役、post-preflight 失败报告、未加锁 guard-open 场景的 Windows 分支，都待父会话原生 CI 证明。未 push、未运行 gh、未新建分支、未勾选任务；另两个 change 未触碰。
