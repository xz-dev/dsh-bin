# Shell 补全

[README](../../README.zh-CN.md) · [English](../en/completion.md)

支持 Bash、Zsh、Fish、PowerShell 7（`pwsh`）和 Windows PowerShell（`powershell`）。生成/查询本地、只读、离线；Tab 不启动 dsh/插件、不下载运行包、不触发首次询问。应用候选来自该运行包固定 `completion.json`，不是动态执行插件探测。

## 生成或注册

```sh
dsh manager completion script bash
dsh manager completion install bash
dsh manager completion install zsh
dsh manager completion install fish
dsh manager completion install pwsh
```

Windows PowerShell 5.1 使用：

```powershell
dsh manager completion install powershell
```

`script` 只向 stdout 输出受信 shell 片段。`install` 是显式注册请求；普通首次交互启动则先询问同意。拒绝/注册失败不阻断运行包启动；该 shell 已存选择不会重复询问，重试使用显式 install。

不写文件，先查看目标：

```sh
dsh manager completion install bash --dry-run
```

| Shell | 默认用户目标 |
|---|---|
| Bash | `$HOME/.bashrc` |
| Zsh | `${ZDOTDIR:-$HOME}/.zshrc` |
| Fish | `${XDG_CONFIG_HOME:-$HOME/.config}/fish/completions/dsh.fish` |
| Unix pwsh | `${XDG_CONFIG_HOME:-$HOME/.config}/powershell/profile.ps1` |
| Windows pwsh | 用户 Documents 目录下 `PowerShell/profile.ps1` |
| Windows PowerShell | 用户 Documents 目录下 `WindowsPowerShell/profile.ps1` |

Windows Documents 按用户 known folder 解析，包括重定向。PowerShell 可显式指定绝对 `--profile` 路径：

```powershell
dsh manager completion install pwsh --profile <absolute-profile-path> --dry-run
```

注册保留其他配置，拒绝 foreign completion 冲突；重复注册幂等。命令输出实际目标及**当前**会话加载方法，也可以启动会加载该 profile 的新 shell。子进程不能替父 shell 激活补全。Windows PowerShell 的执行策略应按本地政策允许加载 profile。

快照补全按类型分开：`manager snapshot plugins ...` 与 `manager snapshot config ...` 使用各自库存，`--snapshot` 和 `--config-snapshot` 只补全对应类型。路径查询补全同样本地执行，不初始化缺失集合。

不读取 shell rc 正文即可查看已记录的注册位置：

```sh
dsh manager path completion
dsh manager path completion pwsh --json
```

新注册记录实际位置与绑定方式；旧记录缺少位置时报告 unknown，不根据当前环境猜测。

## 撤销注册

```sh
dsh manager completion uninstall bash
dsh manager completion uninstall zsh
dsh manager completion uninstall fish
dsh manager completion uninstall pwsh
```

```powershell
dsh manager completion uninstall powershell
```

若注册时指定 `--profile`，撤销时使用同一路径。只删除未修改、可确认归本工具所有的内容；用户修改过的块/文件保留并提示手动处理，其他 profile 内容和父目录保留。PowerShell 没有公开的当前会话撤销 API，撤销后开启新会话。

## 搬迁安装

PATH 中首个 `dsh` 指向当前管理器时，注册绑定稳定名称；移动管理器和数据根后，更新自己建立的 PATH 链接，查询便使用新位置。若绑定了绝对可执行文件路径，在新位置再次 install 刷新所属注册。管理器不扫描磁盘寻找搬迁位置，也不覆盖外部自定义补全。
