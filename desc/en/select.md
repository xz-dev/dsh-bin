# Choosing what `dsh` starts

[README](../../README.md) · [中文](../zh-CN/select.md)

By default, a plain launch uses the newest installed runtime of the recorded channel, that runtime's newest plugin snapshot and newest configuration snapshot independently, and the newest installed compatible office addon. The manager never consults a remote latest on an ordinary installed launch.

## For one launch

Put manager launch options **before** the first application argument. Here `<runtime>` is an installed runtime ID/unambiguous prefix, `<snapshot>` is a full ID or alias such as `<runtime>@before-change`, and `<addon>` is an installed addon version.

```sh
dsh --use <runtime> --profile tui
dsh --snapshot <plugin-snapshot> --profile tui
dsh --config-snapshot <config-snapshot> --profile tui
dsh --use <runtime-b> --snapshot <runtime-a>@1 --config-snapshot <runtime-a>@2 --profile tui
dsh --addon office:<addon> --profile tui
dsh --addon office:none --profile tui
```

Either snapshot alone implies its runtime. If both snapshot options identify different runtime owners, supply `--use`; otherwise the choice is ambiguous. An explicit `--use` overrides that implication and can use another runtime's collections without copying. An explicit runtime or snapshot choice overrides the saved snapshot pair; an omitted kind uses the chosen runtime's newest collection of that kind, not a saved pin from another launch. Missing or ambiguous explicit selections fail rather than falling back. Once application arguments begin, same-named options belong to the application.

## Save a default

```sh
dsh manager select
dsh manager select --use <runtime>
dsh manager select --use <runtime> --snapshot <plugin-snapshot> --config-snapshot <config-snapshot>
dsh manager select --use <runtime> --addon office:<addon>
dsh manager select --use latest
```

No arguments shows the current selection offline. Writes require `--use`; omit either snapshot option to restore that kind's newest selection, and omit `--addon` to restore default compatible-addon selection. Selection does not download anything, and referenced snapshots must already exist. Runtime update preserves this choice and warns when pinned.

A launch fixes its runtime, P, C and addon; changing defaults affects new starts. Internal restarts must retain that context too, but actual upstream restart acceptance is still pending in this development branch; see [current validation status](snapshots.md#compatibility-and-development-status). Preview the same choices without launching or initializing anything:

```sh
dsh --use <runtime> --snapshot <plugin-snapshot> --config-snapshot <config-snapshot> manager path --json
```

## Help versus application arguments

`dsh --help` / `dsh --version` return native manager information and local runtime status, without starting an application or downloading one. `dsh manager --help` shows native management. A call with application arguments, such as `dsh --profile tui --help`, is passed to the selected application and follows ordinary startup rules.

Plugin management is still an application command, for example `dsh plugin --profile tui add <package>`; see the installed upstream application's help for its fixed commands. The runtime's own self-update cannot replace the managed image: use [manager updates](versions.md).
