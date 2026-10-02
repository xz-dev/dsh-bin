# Shell completion

[README](../../README.md) · [中文](../zh-CN/completion.md)

Bash, Zsh, Fish, PowerShell 7 (`pwsh`) and Windows PowerShell (`powershell`) are supported. Generation/query is local, read-only and offline: Tab never starts dsh/plugins, downloads a runtime or triggers the first-run prompt. Runtime application candidates come from that runtime's fixed `completion.json`, not dynamic plugin execution.

## Generate or register

```sh
dsh manager completion script bash
dsh manager completion install bash
dsh manager completion install zsh
dsh manager completion install fish
dsh manager completion install pwsh
```

On Windows, Windows PowerShell 5.1 uses:

```powershell
dsh manager completion install powershell
```

`script` only prints a trusted shell fragment to stdout. `install` is an explicit registration request; the ordinary first interactive launch asks for consent instead. Refusal/registration failure does not prevent runtime startup. A saved choice is not asked again for that shell; use explicit install to retry.

Inspect targets without writing:

```sh
dsh manager completion install bash --dry-run
```

| Shell | Default user target |
|---|---|
| Bash | `$HOME/.bashrc` |
| Zsh | `${ZDOTDIR:-$HOME}/.zshrc` |
| Fish | `${XDG_CONFIG_HOME:-$HOME/.config}/fish/completions/dsh.fish` |
| pwsh on Unix | `${XDG_CONFIG_HOME:-$HOME/.config}/powershell/profile.ps1` |
| pwsh on Windows | user's Documents folder, `PowerShell/profile.ps1` |
| Windows PowerShell | user's Documents folder, `WindowsPowerShell/profile.ps1` |

Windows Documents is resolved from the user's known folder, including redirection. PowerShell also accepts an explicit absolute `--profile` path:

```powershell
dsh manager completion install pwsh --profile <absolute-profile-path> --dry-run
```

Registration preserves other configuration and refuses foreign completion conflicts. Repeated registration is idempotent. The command prints the actual target and how to load it in the **current** session; otherwise open a new shell that loads that profile. A child process cannot activate completion in its parent shell. Windows PowerShell execution policy may need to allow your profile according to your local policy.

## Remove registration

```sh
dsh manager completion uninstall bash
dsh manager completion uninstall zsh
dsh manager completion uninstall fish
dsh manager completion uninstall pwsh
```

```powershell
dsh manager completion uninstall powershell
```

Use the same `--profile` override if you registered one. Only unchanged, recognized owned content is removed. Modified blocks/files stay with a manual-cleanup diagnostic; unrelated profile content and parent directories remain. PowerShell has no public current-session unregister API: start a new session after removal.

## Moving an installation

When PATH's first `dsh` resolves to this manager, registration binds to that stable name. Update your own PATH link after moving the manager and data root; queries then use the new location. If registration bound an absolute executable path, run install again from the moved manager to refresh its owned registration. The manager does not scan disks to find moved installations or overwrite foreign custom completion.
