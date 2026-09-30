# 插件快照

[README](../../README.zh-CN.md) · [English](../en/snapshots.md)

快照保存你的插件。做有风险的插件改动前先存一份；改坏了，删掉它就回去了。

## 快照里有什么

快照 `<version>@<n>` 是每个 profile 插件运行时的完整副本：

- `package.json` 和 lockfile；
- `node_modules/` 和 `.plugin-manager/`；
- `cordis.yml`。

快照存放在 `$DSH_HOME/snapshots/`。你的设置 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 不在快照里，由所有快照共用。

## 快照怎么来的

- **新版本自动创建。** 某个版本第一次启动时，会复制上一个版本最新的快照，插件就跟着过来了。之前没有快照的话，从空开始。
- **你手动创建。** `dsh snapshot new` 把当前版本最新的快照复制成一个新快照。

编号只增不减，从不复用。不带参数的 `dsh` 使用该版本最新的快照。

## 命令

```sh
dsh snapshot list                    # 带 newest、selected、in use 标记；脚本用 --json
dsh snapshot new                     # 复制最新的快照
dsh snapshot new --name before-mcp   # 同时起个名字
dsh snapshot new --target 0.2.0-rc.1@1   # 复制指定的快照
dsh snapshot new --empty             # 从没有插件开始
dsh snapshot remove 0.2.0-rc.2@3     # 删除一个或多个快照
```

快照可以用编号（`0.2.0-rc.2@3`）或名字（`0.2.0-rc.2@before-mcp`）指定。名字可用字母、数字、`.`、`_` 和 `-`，不能全是数字。

`dsh snapshot remove` 不会删除正在使用的快照，也不会删除你[选择](select.md)的快照。

## 撤回一次插件改动

```sh
dsh snapshot new                     # 假设创建了 0.2.0-rc.2@3
dsh plugin --profile tui add …       # 改动进入 @3
dsh snapshot remove 0.2.0-rc.2@3     # 改坏了：@2 重新成为最新
```

## 在新版本上跑旧快照

```sh
dsh --snapshot 0.2.0-rc.1@1 --profile tui               # 快照和它自己的版本
dsh --use 0.2.0 --snapshot 0.1.7-rc.2@2 --profile tui   # 在新版本上用旧快照
```

这样能分清问题出在插件还是 dsh 本身。所有启动选项见[选择 `dsh` 启动什么](select.md)。

运行中的会话一直使用它的快照直到退出，应用内重启也一样。
