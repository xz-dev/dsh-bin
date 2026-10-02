# 版本和独立更新

[README](../../README.zh-CN.md) · [English](../en/versions.md)

原生管理不启动 dsh，不需要宿主 JS 运行时。应用命令不在 `manager` 命名空间内。

## 查看状态

```sh
dsh manager --help
dsh manager --version
dsh manager info
dsh manager list
dsh manager list --json
dsh manager list --available
```

本地列表只读、离线，包含已安装运行包和 office addon，以及 selected/latest/in-use/startable 信息。只有 `--available` 请求运行包索引，追加兼容的远程运行包和当前所选运行包的 office addon。

## 更新运行包

```sh
dsh manager update
dsh manager update --channel live
dsh manager update --channel release
dsh manager update --force
```

`release` 跟随上游发布标签；`live` 跟随上游 master。新安装默认 release。显式切换渠道仅在安装成功后记录；失败保留原渠道。

更新把最新兼容运行包装在旧版本旁边，保留已存选择；固定版本时会提示。`--force` 重装目标运行包，不绕过兼容性或占用保护。已有安装的普通启动不隐式更新。

## 安装指定版本

```sh
dsh manager install <version>
dsh manager install <version> --channel live
dsh manager install <version> --force
```

从 `list --available` 复制完整 ID/tag，或使用无歧义前缀、上游版本。多个构建匹配时会报错，需给出更长身份。安装校验运行包并准备首个[快照](snapshots.md)。重装运行包保留有效的已有快照和 home。

## 移除运行包

```sh
dsh manager select --use latest
dsh manager uninstall <version>
dsh manager uninstall <version-a> <version-b>
```

解除固定后可以卸载**全部**闲置运行包。请求包含缺失、歧义、固定或正在使用的运行包时，预检失败，不删除本次任何目标。快照、选择、home 和管理器保留。重装同一运行包复用已有数据；普通空安装启动可以按记录渠道回装。

占用保护覆盖受管理 runtime 进程及其应用内重启，不追踪所有独立后代进程。

## 只更新管理器

```sh
dsh manager self-update
dsh manager self-update --force
```

便携 self-update 使用 `manager-index.json`，不查运行包索引。版本按严格 SemVer 比较（build metadata 不参与排序），永不降级，同版本通常不下载；`--force` 允许同版本修复。运行包、快照、选择、配置和凭据保持不变。

POSIX 将已验证候选原子替换真实可执行文件，入口符号链接保持不变。Windows 使用同一程序的临时副本，等待父进程退出后替换。**已交接不等于已更新**：下次调用报告 helper 结果。映像占用或文件系统限制可能拒绝替换并保留旧入口；退出其他管理器调用后显式重试。

Gentoo/Scoop 在下载前拒绝 self-update，改用 `emerge --ask --update app-misc/dsh-bin` 或 `scoop update dsh`。安装旧运行包不会降级管理器。

## 下载和清理

下载在激活前验证目标身份、大小、SHA-256、required paths 和启动协议。服务器 Range 响应一致时可恢复中断下载；重试有上限并遵守 Retry-After。错误字节不激活，失败不切换选择或渠道。

```sh
dsh manager clean
```

Clean 离线，仅删除已识别的缓存和中断操作残留，保留有效运行包、addon、快照、home、凭据和未知文件。相关会话或操作忙时整次拒绝，零删除。公开 generation 缺失或无效时，唯一可恢复副本保留，并提示显式 install 恢复。不提供按类别清理的 flags。
