# Choosing what `dsh` starts

[README](../../README.md) · [中文](../zh-CN/select.md)

By default, a plain launch uses the newest installed runtime of the recorded channel, that runtime's newest snapshot and the newest installed compatible office addon. The manager never consults a remote latest on an ordinary installed launch.

## For one launch

Put manager launch options **before** the first application argument. Here `<runtime>` is an installed runtime ID/unambiguous prefix, `<snapshot>` is a full ID or alias such as `<runtime>@before-change`, and `<addon>` is an installed addon version.

```sh
dsh --use <runtime> --profile tui
dsh --snapshot <snapshot> --profile tui
dsh --use <runtime-b> --snapshot <runtime-a>@1 --profile tui
dsh --addon office:<addon> --profile tui
dsh --addon office:none --profile tui
```

A snapshot alone implies its runtime. An explicit `--use` overrides that implication, allowing another runtime to use the same snapshot without copying it. Missing or ambiguous explicit selections fail rather than falling back. Once application arguments begin, same-named options belong to the application.

## Save a default

```sh
dsh manager select
dsh manager select --use <runtime>
dsh manager select --use <runtime> --snapshot <snapshot>
dsh manager select --use <runtime> --addon office:<addon>
dsh manager select --use latest
```

No arguments shows the current selection offline. Writes require `--use`; omit `--snapshot` to restore newest-snapshot selection, and omit `--addon` to restore default compatible-addon selection. Selection does not download anything, and referenced snapshots must already exist. Runtime update preserves this choice and warns when pinned.

A running session, including in-app restarts, keeps its original runtime, snapshot and addon. Changing defaults affects only new starts.

## Help versus application arguments

`dsh --help` / `dsh --version` return native manager information and local runtime status, without starting an application or downloading one. `dsh manager --help` shows native management. A call with application arguments, such as `dsh --profile tui --help`, is passed to the selected application and follows ordinary startup rules.

Plugin management is still an application command, for example `dsh plugin --profile tui add <package>`; see the installed upstream application's help for its fixed commands. The runtime's own self-update cannot replace the managed image: use [manager updates](versions.md).
