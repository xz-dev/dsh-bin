# 插件与配置快照

[README](../../README.zh-CN.md) · [English](../en/snapshots.md)

每次启动可分别选择插件文件与配置：

| 类型 | 数据根下的位置 | 内容 |
|---|---|---|
| `plugins`（P） | `snapshots/<runtime>@<n>/` | 各 profile 的插件包、依赖、lockfile、`.plugin-manager` 和生成的 `cordis.yml` |
| `config`（C） | `config-snapshots/<runtime>@<n>/` | 全部 profile 用户 patch、设置文档及导入保留文档、内建本地凭据 |

C 包含存在时的 `profiles/<name>/cordis.patch.yml`、`settings.yaml`、`settings.yaml.imported` 和 `.credentials.yaml`，不含插件依赖、生成的 `cordis.yml`、addon、会话、缓存、管理器选择及操作锁。两类根都留在管理器数据根，不受 `DSH_HOME` 影响。应用 home 仍用于会话等非配置状态，但不是受管理启动的配置或凭据回退来源。

快照是可直接读写的工作集合，不是只能 restore 的不可变备份。复制保留字节、不转换 YAML；选定应用可以导入或更新自己的 C。插件解析和生成的 `cordis.yml` 仍在 P。

## 创建和删除

每种类型独立递增编号、维护别名，删除后也不复用编号。`plugins A@1` 与 `config A@1` 是不同对象。安装或启动时若缺某一类型，从前一运行包最新同类型集合复制；没有前驱来源才创建空集合。已有有效集合不重建，两类序号不强行对齐。

```sh
dsh manager snapshot plugins list
dsh manager snapshot config list --json
dsh manager snapshot plugins new --name before-plugin-change
dsh manager snapshot config new --name before-config-change
dsh manager snapshot config new --use <runtime-b> --target <runtime-a>@1
dsh manager snapshot config new --use <runtime> --empty
dsh manager snapshot config remove <runtime>@before-config-change
```

类型必填，没有 `manager snapshot new` 别名。两种类型都支持 `new`、`list`、`remove`。默认 `new` 复制目标运行包最新同类型集合，没有来源时报错，此时应显式选择 `--empty`。`--target` 与 `--empty` 互斥。别名可用字母、数字、`.`、`_`、`-`，不能全为数字。

删除支持多个 ID，但先检查整批目标；正在使用或被持久选择引用的集合不能删除。未固定选择时，删除最新项使后续启动回落到最新存留项；新建不覆盖已有固定选择。删光某类集合不会立即重建。卸载或重装运行包、`manager clean` 都不删除有效快照。

需要多文件一致视图时，复制前停止相关会话。复制不是应用全局事务：I/O 错误或已检测到的来源变化会失败，不发布半成品。配置及暂存文件保持私有，副本不共享可写硬链接；复制不会绕过链接、特殊文件、拥有权和目标检查。

## 试一次修改

```sh
dsh manager snapshot plugins new --name experiment
dsh manager snapshot config new --name config-trial
dsh --use <runtime> --snapshot <runtime>@experiment --config-snapshot <runtime>@config-trial plugin --profile tui add <package>
dsh --use <runtime> --snapshot <runtime>@experiment --config-snapshot <runtime>@config-trial --profile tui
```

安装插件包写入 P；启停设置、应用配置和凭据更新写入 C。显式选择两个副本，也能在插件命令更新设置时保护原 C，不改写共享 HOME 配置。应用退出后保留需要的副本，或用对应类型的删除命令移除失败试用。运行中的会话保持已解析的 P/C；默认选择改变只作用于后续启动。见[选择文档](select.md)。

## 跨运行包使用与本地凭据

```sh
dsh --config-snapshot <runtime-a>@1 --profile tui
dsh --use <runtime-b> --snapshot <runtime-a>@1 --config-snapshot <runtime-a>@1 --profile tui
```

单独指定快照隐含其所属运行包；显式 `--use` 可让 B 直接使用 A 的所选集合，不暗中复制或修复。**B 可能修改明确选中的 A 配置。** 试用新应用格式时，优先先建副本。管理器复制不重写绝对路径，也不转换凭据格式。

内建本地凭据的 `accounts/work.yaml` 等相对路径，以所选 C 为根而不是工作目录。绝对路径及 provider home 覆盖也必须留在 C 内。引用共享 home、另一快照、父目录穿越或逃逸链接，会在打开或监视凭据前拒绝，不回退另一文件。即使 home 有旧凭据，空 C 也只使用应用默认行为或报告缺少凭据。其他外部凭据后端及任意插件 I/O 不属于快照保证。

## 兼容性与开发状态

有效旧插件 metadata、没有 config 引用的旧选择仍可读取；共享 HOME 配置不会自动导入。受管理应用启动要求兼容的 **协议 2 运行包**；旧协议 1 运行包会在执行应用前被拒绝，不静默升级。Standalone 上游运行仍保持上游路径行为，原始 snapshot 环境变量不能授权受管理配置访问。

本分支仍在验收中，不代表已经公开发布。Windows 受管理配置启动有意保持禁用，直到原生组件和真实应用门禁通过。实际上游内部重启及完整原生／组合制品门禁仍待完成，transport 或手写 respawn 测试不能代替。当前证据和缺口见[变更记录](../../openspec/changes/add-config-snapshots-and-paths/evidence.md)。依赖 Node 内部机制的 HMR 仍禁用，见[应用限制](how-it-works.md#应用限制)。
