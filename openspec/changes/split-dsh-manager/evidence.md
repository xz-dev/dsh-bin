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
