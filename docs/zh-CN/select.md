# 选择 `dsh` 启动什么

[README](../../README.zh-CN.md) · [English](../en/select.md)

不带参数的 `dsh` 启动的是**选择**：一个版本、一个快照和附加组件版本。默认是 `latest`：你所在通道已安装的最新版本，配上该版本最新的快照和默认附加组件。

## 只用一次

把这些选项放在其他参数前面：

```sh
dsh --use 0.1.7-rc.2 --profile tui                  # 已安装的版本（写出唯一前缀即可）
dsh --snapshot 0.2.0-rc.1@1 --profile tui           # 指定快照（隐含其版本）
dsh --use 0.2.0 --snapshot 0.1.7-rc.2@2 ...         # 在新版本上用旧快照
dsh --addon office:0.1.2-xz.11.1.gaaaa0001 ...      # 指定附加组件版本
```

## 修改默认

```sh
dsh select                                          # 显示选择以及它解析成什么
dsh select --use 0.1.7-rc.2                         # 固定版本
dsh select --use 0.1.7-rc.2 --snapshot 0.1.7-rc.2@2 # 固定版本和快照
dsh select --use latest                             # 恢复默认
```

- `--use` 必填。没写的选项恢复默认。
- 选择从不下载任何东西；版本必须已经装好。
- `dsh update` 不会改变选择。固定了某个版本时，装了更新的版本后它会提醒你。

## 运行中的会话

运行中的会话一直使用它的版本和快照直到退出，应用内重启也一样。改选择只影响之后的新启动。

## 帮助

`dsh --help` 先显示上游的帮助，后面是 dsh-bin 的选项和命令。`dsh plugin --profile <name> …` 按上游的设计管理插件。上游自带的 `dsh update` 永远不会运行；请用 dsh-bin 的 [`dsh update`](versions.md#更新)。
