# 插件快照

[README](../../README.zh-CN.md) · [English](../en/snapshots.md)

快照包含各 profile 的插件运行文件：package/lock 文件、`node_modules`、`.plugin-manager` 和 `cordis.yml`。它们位于**数据根** `snapshots/<runtime>@<n>/profiles/`，不在 `DSH_HOME` 下。共享设置 `$DSH_HOME/profiles/<name>/cordis.patch.yml`、凭据和会话不复制；所有快照读取同一个应用 home。

## 创建和选择

安装新运行包时，首个快照从前一运行包最新快照复制；无来源则为空。重装保留有效快照。新快照独立复制插件文件，不执行 pnpm 修复依赖；内部相对链接保留，绝对或越界链接拒绝。

编号只增长，删除后也不复用。未固定快照时选择运行包最新快照。以下 `<runtime>`、`<snapshot>` 从本地列表取得。

```sh
dsh manager snapshot list
dsh manager snapshot list --json
dsh manager snapshot new
dsh manager snapshot new --name before-change
dsh manager snapshot new --use <runtime> --target <snapshot>
dsh manager snapshot new --use <runtime> --empty
dsh manager snapshot remove <snapshot>
```

`--target` 复制已有快照；`--empty` 创建无插件快照。别名可用字母、数字、`.`、`_`、`-`，不能全为数字；引用形式为 `<runtime>@before-change`。删除可接受多个 ID，但遇到正在使用或已持久选择的快照，会在删除任何目标之前拒绝。

## 试一次插件修改

1. 停止会使用该快照的会话。
2. 创建新快照，记下输出 ID。
3. 用应用命令修改插件。
4. 退出应用后，若修改失败，删除新快照。

```sh
dsh manager snapshot new --name experiment
dsh plugin --profile tui add <package>
dsh manager snapshot remove <runtime>@experiment
```

默认选择最新快照时，下次启动回到仍保留的前一个快照。若之前固定了快照，需显式改选；新快照不覆盖固定选择。删除快照会丢失其中插件修改，保留需要的副本。

## 跨运行包试用

```sh
dsh --snapshot <runtime-a>@1 --profile tui
dsh --use <runtime-b> --snapshot <runtime-a>@1 --profile tui
```

第一条使用快照所属运行包；第二条使用运行包 B 和 A 的现有插件文件，不复制、不修复。见[选择文档](select.md)。运行会话及应用内重启保持已解析快照，直到退出。
