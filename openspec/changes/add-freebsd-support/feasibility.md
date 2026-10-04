# 既有 FreeBSD 可行性证据

这是规划前已执行的组件探针记录，不是本 change 的实施／发布验收。规划阶段没有重新运行探针，也不把以下结果标记为 tasks 已完成。

## 环境与固定输入

- 实测：FreeBSD 15.0-RELEASE-p5、amd64、root。原机没有 Bun、Zig、Node、npm、pnpm。
- 原生 Bun 1.4.2 官方 baseline 资产；SHA-256：`f01d1789358f02625300776925cc8f67cf7c232fb8a394e186f5fa59300eed2d`。
- 原生 Zig 0.15.2 官方 FreeBSD 资产；SHA-256：`5509ff57cd3f219165caed0da10221739af82742b9edfcda3f7bfaf4da7212dd`。
- 管理器工作树源码归档 SHA-256：`04bf6669b25dda4ee1629a22cd2a99a5ee36a3a5cea9e410068f5b5b4122fb32`。它只代表取样时源码，不代表另一 agent 此后的实现。
- 内嵌 pnpm 输入为固定 11.7.0 的 JS dist 副本，排除 `.node`；不是声称存在该版本官方 FreeBSD standalone 发行包。
- 所有文件仅写任务临时目录，未安装系统包、改动仓库实现或使用真实凭据。完整原始日志已经交给用户；实施期须复现并归档候选制品的证据，不依赖历史临时目录持续存在。

## 真实通过项目

| 项目 | 命令／检查 | 结果与边界 |
| --- | --- | --- |
| 原生 Bun | 平台／版本、私有文件 rename/read、spawn stdio/exit、loopback HTTP、fs.watch、Bun.Terminal | 六项通过；不是完整 dsh |
| 单文件 | `bun build --compile --target=bun-freebsd-x64-baseline --compile-executable-path=<已校验 Bun>` | 编译 exit 0；无系统 JS 的 PATH 下重复六项探针通过 |
| 内嵌 runtime | `BUN_BE_BUN=1 <测试单文件> -e ...` | exit 0；说明 shim 基础可行 |
| 原始 C flock | FreeBSD cc、Node-API v8、Bun 加载 | 构建与实际跨进程竞争／关闭后释放通过，竞争 errno 35 |
| 原始管理器 | `zig build -Dtarget=x86_64-freebsd`，manager version/help/普通 list/info | 全部 exit 0；没有加显式 libc 选项也能构建 |
| 实际链接 | `ldd <原始管理器>` | 链接系统 libc、libthr、libsys；不能称为无 libc 程序 |
| 固定 pnpm | 由测试单文件内嵌 Bun 运行 pnpm 11.7.0 | 版本查询通过 |
| 离线安装 | `pnpm install --offline --ignore-scripts --store-dir <任务目录>` | 1 个本地 file: 依赖安装，downloaded 0；随后加载夹具插件通过，不代表真实 dsh 插件服务或 lifecycle scripts 已验收 |

## 已确认失败与缺口

在仅增加 libc 声明的临时管理器副本上执行单元测试，结果为 **40 通过、2 失败、2 跳过／44 项**：

1. `target.test.FB-EMPTY ...`：FreeBSD 不在当前 host target 分支，`UnsupportedHost`。
2. `zip.test.DL-ESCAPE ...`：no-follow 打开符号链接暂存根返回 errno 31（EMLINK）；Zig 将其映射为 Unexpected，不符合安全错误分类。操作没有因此成功，不能以跟随链接或忽略错误修复。
3. 两项 Unicode 文件系统别名测试跳过，不是通过。

原始 TS flock 加载器真实调用仍返回 `ERR_FLOCK_UNSUPPORTED_PLATFORM`；C 层成功没有接通真实会话后端。`manager list --json` 失败来自当前取样构建的功能占位，普通 list 成功，因此不能将其直接归为 FreeBSD 问题。

未运行完整 dsh profile、会话／凭据、dsh 的 node-pty／进程检查器、ripgrep、Office、真实制品安装更新搬迁、普通用户、ARM64 或其他 FreeBSD 版本。本 change 的这些门禁仍全部未完成。

## 权威来源

- [Bun 原生 FreeBSD 说明](https://bun.com/blog/bun-v1.4#native-freebsd-builds)：原生 x64／aarch64，Bun 技术门槛 14.3+；不是本项目承诺支持 14.x。
- [Bun 1.4.2 官方资产](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.2)。
- [固定版本编译目标源码](https://github.com/oven-sh/bun/blob/bun-v1.4.2/src/options_types/compile_target.rs)。
- [pnpm 11.7.0 官方资产](https://github.com/pnpm/pnpm/releases/tag/v11.7.0)：缺 FreeBSD 资产不等于需要改依赖版本。
- [FreeBSD 受支持版本](https://www.freebsd.org/security/)：发布时重新核对并冻结支持清单。
- [FreeBSD VM CI](https://github.com/vmactions/freebsd-vm)：可提供不同架构的真实 guest；实现时固定版本／提交，不使用漂移标签作为发布证据。
