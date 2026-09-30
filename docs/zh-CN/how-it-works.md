# 工作原理

[README](../../README.zh-CN.md) · [English](../en/how-it-works.md)

## 目录结构

```text
~/.local/share/dsh-bin/
  dsh                      启动器（Windows 上是 dsh.exe），用 Zig 写
  bundles/<version>/       每个已安装版本一个只读目录：dsh、Bun、pnpm
$DSH_HOME/                 默认 ~/.dsh
  profiles/<name>/         你的 profile 和 cordis.patch.yml 设置
  snapshots/<version>@<n>/ 插件快照
  dsh-bin/selection.json   不带参数的 dsh 启动什么
```

启动器读取你的选项和选择，选出版本和快照，然后启动该版本的 `dsh-native`，这一步还没有运行任何 JavaScript。

这就是不需要容器的容器模型：

| 容器 | dsh-bin |
|---|---|
| 自带运行时的只读镜像 | `bundles/<version>/` |
| 按 tag 拉取，按 digest 校验 | `dsh update` / `dsh install`，校验 SHA-256 |
| 一台机器上多个镜像 | 多个版本并存 |
| 可写层、volume | 快照；设置放在外面，共用 |
| 提交 / 回滚 | `dsh snapshot new` / `dsh snapshot remove` |
| 可选层 | office 附加组件 |

## 发布

| 通道 | 跟随 | tag |
|---|---|---|
| `release` | 上游 `dsh-v*` tag，从 `dsh-v0.1.7-rc.2` 开始 | `dsh-v<upstream-version>-xz.<run>.<attempt>.g<sha8>` |
| `live` | 上游 `master` | `dsh-live-<sha7>-xz.<run>.<attempt>.g<sha8>` |

发布是自动的。`upstream-poll` workflow 每天检查上游四次，每次推送到 `main` 时也会检查：

- 上游出了新 tag，就构建一个 `release`；`master` 有新提交，就构建一个 `live`；
- 改了打包相关内容的推送，会重新构建最新的 release tag 和 `master`；
- 只改文档或测试的推送不构建任何东西。

手动运行 `build` 或 `addon` 永远是空跑。每次构建都发布为不可变的 GitHub Release。Latest release 始终是最新的 `release` 构建。`dsh update` 通过 `releases` 分支上的 `index.json` 查找版本，不走 GitHub API。

## 信任模型

- dsh 从 `github.com/deepseek-ai/deepseek-harness` 的确定提交构建，使用上游 lockfile（`--frozen-lockfile`，关闭生命周期脚本）。dsh 自身的代码从不取自 npm。
- pnpm 取自它的 GitHub release，并按固定的 SHA-256 校验。
- 第三方包按上游 lockfile 的 integrity 哈希校验。唯一取自 npm 的是 LibreOffice Kit 引擎包，固定到 lockfile 的 `sha512`，而且只随 office 附加组件发布。
- release 产物带 GitHub 构建来源证明：`gh attestation verify <file> --repo xz-dev/dsh-bin`。release 不可变。索引只追加。

## 启动

在 Linux x64（Ryzen AI 9 365）上测量，启动自带的 `headless` profile 并加载其插件，取 5–7 次运行的最好成绩：

| 情况 | npm + node | dsh-bin |
|---|---|---|
| profile 热启动 | 361 ms | 304–321 ms |
| 新版本首次启动，空缓存 | – | 497–683 ms |
| 新版本首次启动，使用随包缓存 | – | 454–515 ms |

- **随包转译缓存。** 每次构建都在对应平台的原生 runner 上启动各个 profile，把生成的 Bun 转译缓存一起发布。该版本首次启动时复制进去，大约省 90–150 ms。
- **独立缓存目录。** 缓存放在 `$XDG_CACHE_HOME/dsh-bin/transpiler`（或 `~/.cache/dsh-bin/transpiler`），macOS 上是 `~/Library/Caches/dsh-bin/transpiler`，Windows 上是 `%LOCALAPPDATA%\dsh-bin\cache\transpiler`，不和 Bun 共用 `~/.bun/install/cache`。你自己设置的 `BUN_RUNTIME_TRANSPILER_CACHE_PATH` 优先。
- **编译后的入口。** 入口在每个目标的原生 runner 上用 `--minify --bytecode` 构建。

## 限制

有些上游插件离开 Node 就跑不了。每个都被替换成桩；dsh 启动自检会把它列为未启用并给出原因，启动继续：

- `@deepseek-ai/dsh-hmr`：始终如此。它依赖 Node 内部的模块加载器。
- `@deepseek-ai/dsh-office-to-pdf` 和 `@deepseek-ai/dsh-skill-office`：没有已安装的 [office 附加组件](office-addon.md)适配当前 dsh 版本时。

上游自带的自更新永远不会运行；bundle 是只读的。

## 开发

```sh
bun install
npm test    # bun test ./test/unit ./test/runtime ./test/launcher ./test/update-contract
bun scripts/build-target.mjs <target> <live|release> <ref> <out> --run 1 --attempt 1 --index index.json
bun scripts/e2e.mjs <index.json> <assets-dir>   # 打包后的 E2E，PATH 上没有 JS 运行时
```

需要 Bun 1.4.2 和 Zig 0.15.2。Node 只在构建时使用。
