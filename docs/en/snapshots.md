# Plugin snapshots

[README](../../README.md) · [中文](../zh-CN/snapshots.md)

A snapshot holds your plugins. Before a risky plugin change, save one; if the change breaks something, remove it and you are back.

## What a snapshot contains

A snapshot `<version>@<n>` is a full copy of every profile's plugin runtime:

- `package.json` and the lockfile;
- `node_modules/` and `.plugin-manager/`;
- `cordis.yml`.

Snapshots live in `$DSH_HOME/snapshots/`. Your settings, `$DSH_HOME/profiles/<name>/cordis.patch.yml`, are not in the snapshot: all snapshots share them.

## How snapshots are made

- **On a new version.** The first start of a version copies the newest snapshot of the previous version, so your plugins come along. With no earlier snapshot, it starts empty.
- **By you.** `dsh snapshot new` copies the current version's newest snapshot into a new one.

Numbers only grow and are never reused. A plain `dsh` uses the version's newest snapshot.

## Commands

```sh
dsh snapshot list                    # newest, selected and in-use markers; --json for scripts
dsh snapshot new                     # copy the newest snapshot
dsh snapshot new --name before-mcp   # also give it a name
dsh snapshot new --target 0.2.0-rc.1@1   # copy a specific snapshot
dsh snapshot new --empty             # start with no plugins
dsh snapshot remove 0.2.0-rc.2@3     # remove one or more snapshots
```

A snapshot can be named by number (`0.2.0-rc.2@3`) or by its name (`0.2.0-rc.2@before-mcp`). A name uses letters, digits, `.`, `_` and `-`, and cannot be all digits.

`dsh snapshot remove` refuses a snapshot that is in use or that you [selected](select.md).

## Undo a plugin change

```sh
dsh snapshot new                     # say this creates 0.2.0-rc.2@3
dsh plugin --profile tui add …       # the change goes into @3
dsh snapshot remove 0.2.0-rc.2@3     # it broke: @2 is the newest again
```

## Run an old snapshot on a new version

```sh
dsh --snapshot 0.2.0-rc.1@1 --profile tui          # the snapshot and its own version
dsh --use 0.2.0 --snapshot 0.1.7-rc.2@2 --profile tui   # an old snapshot on a new version
```

This tells you whether a problem comes from the plugins or from dsh itself. See [Choosing what `dsh` starts](select.md) for all launch options.

A running session keeps its snapshot until it exits, including in-app restarts.
