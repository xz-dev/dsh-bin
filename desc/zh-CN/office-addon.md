# Office addon

[README](../../README.zh-CN.md) · [English](../en/office-addon.md)

`office-to-pdf` 和 `skill-office` 插件需要 LibreOffice Kit，它作为单独 addon 发布。没有兼容的已安装 addon 时，这两个插件不可用，其他应用功能仍可用。

## 安装、查看和卸载

先安装/选择运行包，管理器才能读取其 office 兼容 slot。

```sh
dsh manager install --addon office
dsh manager install --addon office:<addon>
dsh manager list
dsh manager list --available
dsh manager uninstall --addon office:<addon>
dsh manager uninstall --addon office
```

多个版本可并存于数据根 `addons/office/`。安装校验 addon，但不运行 dsh。卸载拒绝正在使用或已持久选择的版本。Gentoo、Scoop 下使用同样命令，不需要单独 office 系统包。

## 兼容性和默认值

运行包声明 slot，标识上游 LibreOffice Kit 依赖。没有显式选择时，启动完全离线，使用已安装同 slot 的最高序号 addon。

`install --addon office` 选择索引中最新兼容项；索引不可用时使用运行包内嵌 pinned 项。内嵌元数据不让尚未下载的 ZIP 离线可用：安装仍需已验证缓存或可访问源。没有已发布兼容 addon 的运行包会报告无候选。

`--force` 可重装 addon，但**绝不**绕过 slot。显式或已存启动选择缺失/不兼容时给出诊断，降级为不启用 office addon，不改用其他版本。

## 选择或禁用

```sh
dsh --addon office:<addon> --profile tui
dsh --addon office:none --profile tui
dsh manager select --use <runtime> --addon office:<addon>
dsh manager select --use latest --addon office:none
```

保存 addon 选择需要 `--use`；保存时省略 `--addon` 清除 addon 覆盖。单次启动重复指定 addon 时最后一项生效。见[选择文档](select.md)。
