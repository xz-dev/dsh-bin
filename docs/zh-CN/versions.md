# 版本和更新

[README](../../README.zh-CN.md) · [English](../en/versions.md)

dsh-bin 可以同时装多个 dsh 版本，由同一个启动器启动其中任意一个。

## 查看已安装的版本

```sh
dsh list           # 已安装版本、可安装版本、附加组件版本
dsh list --json
```

已安装版本会带 `selected`、`latest` 和 `in use` 标记。`dsh list` 只读：不下载，也不做任何改动。

## 更新

```sh
dsh update
```

它把你所在通道的最新版本装在已有版本旁边，不替换任何东西。`dsh update self`、`dsh update dsh` 和 `dsh update --self` 效果相同。

- 它从不改变不带参数的 `dsh` 启动什么。如果你[固定](select.md)了别的版本，它会提醒你。
- 如果没有已安装的 office 附加组件适配新版本，它会告诉你怎么装。
- `dsh update --force` 重新安装最新版本。

没有降级命令：旧版本还装着。用 `dsh --use <版本>` 启动它，或者[选择](select.md)它。

## 通道

| 通道 | 跟随 |
|---|---|
| `release`（默认） | 上游 `dsh-v*` tag |
| `live` | 上游 `master` |

```sh
dsh update --channel live      # 切到 live
dsh update --channel release   # 切回来
```

安装成功后才会记录新通道。

## 安装指定版本

```sh
dsh install 0.1.7-rc.2
dsh install 0.1.7-rc.2 --channel live
```

版本可以写精确版本、release tag，或者 `0.1.7-rc.2` 这样的上游版本号，写出唯一前缀即可。安装时还会创建该版本的第一个[快照](snapshots.md)。

## 删除版本

```sh
dsh uninstall 0.1.7-rc.2
dsh uninstall 0.1.7-rc.1 0.1.7-rc.2
```

被删除版本的快照会保留。列表里只要有一个版本属于下面的情况，整条命令都会被拒绝：

- 最后一个已安装的版本；
- 你用 `dsh select` 固定的版本；
- 正在使用的版本。

"正在使用"指有一个由 dsh-bin 启动的 dsh 进程在运行它：会话、`dsh plugin` 或应用内重启。不跟踪子进程。

## 弱网

更新针对差网络做了处理：

- **续传。** 重试从下载中断的地方继续（HTTP `Range`）。中断的运行会留下未完成的文件，下次 `dsh update` 从那里接着下。
- **重试。** 网络错误和 HTTP 408/425/429/5xx 按指数退避重试，遵守 `Retry-After`。
- **超时。** 30 秒收不到数据就中止并重试。
- **校验。** 下载完的文件按索引里的大小和 SHA-256 校验。续传得到的文件校验失败时，会从头再下一次。
- **进度。** 在终端上显示带速度和剩余时间的进度条；否则每秒输出一行。

新版本原子激活：先 bundle，后根启动器。

## 清理

```sh
dsh clean              # 等于 --all
dsh clean --update     # 未下完的文件和安装暂存
dsh clean --snapshots  # 快照暂存
dsh clean --transpiler # dsh-bin 的转译缓存
```

`dsh clean` 只清理中断运行的残留和缓存，从不删除已安装的版本、附加组件或快照。
