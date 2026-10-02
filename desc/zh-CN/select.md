# 选择 `dsh` 启动什么

[README](../../README.zh-CN.md) · [English](../en/select.md)

普通启动默认使用记录渠道内最新已安装运行包、该运行包最新快照，以及最高序号的已安装兼容 office addon。已有安装的普通启动不查询远程 latest。

## 单次选择

管理器启动选项必须放在首个应用参数**之前**。以下 `<runtime>` 是已安装运行包 ID/无歧义前缀，`<snapshot>` 是完整编号或别名（如 `<runtime>@before-change`），`<addon>` 是已安装 addon 版本。

```sh
dsh --use <runtime> --profile tui
dsh --snapshot <snapshot> --profile tui
dsh --use <runtime-b> --snapshot <runtime-a>@1 --profile tui
dsh --addon office:<addon> --profile tui
dsh --addon office:none --profile tui
```

仅指定快照隐含其运行包；显式 `--use` 覆盖该隐含选择，可以用另一运行包启动同一快照，不会复制。显式选择缺失或歧义会报错，不回退。应用参数开始后，同名选项归应用处理。

## 保存默认选择

```sh
dsh manager select
dsh manager select --use <runtime>
dsh manager select --use <runtime> --snapshot <snapshot>
dsh manager select --use <runtime> --addon office:<addon>
dsh manager select --use latest
```

无参数时离线显示当前选择。写入必须给 `--use`；省略 `--snapshot` 恢复最新快照选择，省略 `--addon` 恢复默认兼容 addon 选择。选择不下载内容，引用的快照必须已存在。运行包更新保留默认选择，并提示固定状态。

运行会话及应用内重启保持原运行包、快照和 addon；修改默认只影响新启动。

## 帮助和应用参数

`dsh --help` / `dsh --version` 返回原生管理器信息和本地运行包状态，不启动应用、不下载。`dsh manager --help` 显示原生管理命令。带应用参数的调用，如 `dsh --profile tui --help`，透传给所选应用，遵循普通启动规则。

插件管理仍是应用命令，例如 `dsh plugin --profile tui add <package>`；固定命令以已安装上游应用帮助为准。运行包自身的 self-update 不能替换受管理映像，应使用[管理器更新命令](versions.md)。
