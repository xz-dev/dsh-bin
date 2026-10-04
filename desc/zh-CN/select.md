# 选择 `dsh` 启动什么

[README](../../README.zh-CN.md) · [English](../en/select.md)

普通启动默认使用记录渠道内最新已安装运行包，分别选择该运行包最新插件快照和最新配置快照，以及最高序号的已安装兼容 office addon。已有安装的普通启动不查询远程 latest。

## 单次选择

管理器启动选项必须放在首个应用参数**之前**。以下 `<runtime>` 是已安装运行包 ID/无歧义前缀，`<snapshot>` 是完整编号或别名（如 `<runtime>@before-change`），`<addon>` 是已安装 addon 版本。

```sh
dsh --use <runtime> --profile tui
dsh --snapshot <plugin-snapshot> --profile tui
dsh --config-snapshot <config-snapshot> --profile tui
dsh --use <runtime-b> --snapshot <runtime-a>@1 --config-snapshot <runtime-a>@2 --profile tui
dsh --addon office:<addon> --profile tui
dsh --addon office:none --profile tui
```

单独指定任一种快照，都隐含其所属运行包。两种快照若属于不同运行包，必须给 `--use`，否则选择有歧义。显式 `--use` 覆盖隐含选择，可直接使用另一运行包的集合，不复制。显式运行包或快照选项覆盖保存的快照对；省略的类型采用所选运行包最新同类型集合，而不是沿用旧启动的固定项。显式目标缺失或歧义时报错，不回退。应用参数开始后，同名选项归应用处理。

## 保存默认选择

```sh
dsh manager select
dsh manager select --use <runtime>
dsh manager select --use <runtime> --snapshot <plugin-snapshot> --config-snapshot <config-snapshot>
dsh manager select --use <runtime> --addon office:<addon>
dsh manager select --use latest
```

无参数时离线显示当前选择。写入必须给 `--use`；省略某一快照选项，恢复该类型的最新项选择；省略 `--addon` 恢复默认兼容 addon 选择。选择不下载内容，引用的快照必须已存在。运行包更新保留默认选择，并提示固定状态。

一次启动固定运行包、P、C 和 addon；默认改变只影响新启动。内部重启也必须保留该上下文，但本开发分支的实际上游重启验收尚未完成，见[当前验证状态](snapshots.md#兼容性与开发状态)。不启动、不初始化即可预览相同选择：

```sh
dsh --use <runtime> --snapshot <plugin-snapshot> --config-snapshot <config-snapshot> manager path --json
```

## 帮助和应用参数

`dsh --help` / `dsh --version` 返回原生管理器信息和本地运行包状态，不启动应用、不下载。`dsh manager --help` 显示原生管理命令。带应用参数的调用，如 `dsh --profile tui --help`，透传给所选应用，遵循普通启动规则。

插件管理仍是应用命令，例如 `dsh plugin --profile tui add <package>`；固定命令以已安装上游应用帮助为准。运行包自身的 self-update 不能替换受管理映像，应使用[管理器更新命令](versions.md)。
