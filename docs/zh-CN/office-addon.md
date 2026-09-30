# office 附加组件

[README](../../README.zh-CN.md) · [English](../en/office-addon.md)

office 插件（`office-to-pdf`、`skill-office`）需要 LibreOffice Kit。它体积很大，所以作为单独的附加组件发布，不在主压缩包里。没装的话，dsh 启动时这两个插件会显示为未启用，其他功能照常。

## 安装和删除

```sh
dsh install --addon office                   # 适合你当前 dsh 版本的默认版本
dsh install --addon office:<版本>            # 指定版本
dsh uninstall --addon office:<版本>          # 删除一个版本
dsh uninstall --addon office                 # 删除所有版本
dsh list --addon office                      # 已安装和可安装的版本
```

多个附加组件版本可以并存。`dsh uninstall --addon` 不会删除正在使用或被[选择](select.md)指定的版本。

用 Scoop 的话，改用 `scoop install dsh-bin/dsh-office`。

## 用的是哪个版本

每个附加组件版本属于一个 **slot**：上游使用的 LibreOffice Kit 版本，以及引入它的上游提交。一个 dsh 版本只和自己 slot 的附加组件配套。

- 不带参数启动时，使用已安装的、同 slot 的最新附加组件。
- `dsh install --addon office` 默认安装 release 索引里同 slot 的最新版本。索引连不上时，用构建该 dsh 版本时固定的版本。
- 每个版本都带有自己 slot 的附加组件版本列表，所以离线时也能装。

## 使用其他 slot 的附加组件

其他 slot 的附加组件不一定能用。dsh-bin 允许，但要你明确指定：

```sh
dsh install --addon office:<版本> --force
dsh --addon office:<版本> ...                 # 或者：dsh select --use latest --addon office:<版本>
```

只有指定时才会用它，每次这样启动都会打印警告。指定的版本没安装时，启动会停止并告诉你怎么装。
