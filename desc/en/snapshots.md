# Plugin snapshots

[README](../../README.md) · [中文](../zh-CN/snapshots.md)

Snapshots hold per-profile plugin runtime files: package/lock files, `node_modules`, `.plugin-manager` and `cordis.yml`. They live in **data-root** `snapshots/<runtime>@<n>/profiles/`, not under `DSH_HOME`. Shared settings at `$DSH_HOME/profiles/<name>/cordis.patch.yml`, credentials and sessions are not copied; every snapshot reads the same application home.

## Creation and selection

Installing a new runtime prepares its first snapshot from the previous runtime's newest snapshot; with no source it starts empty. Reinstalling keeps valid existing snapshots. New snapshots copy plugin files independently and never run pnpm to repair them. Internal relative links are preserved; absolute or escaping links are refused.

Numbers only increase and are never reused, even after deletion. An unpinned snapshot choice uses the runtime's newest snapshot. `<runtime>` and `<snapshot>` below are identities from the local lists.

```sh
dsh manager snapshot list
dsh manager snapshot list --json
dsh manager snapshot new
dsh manager snapshot new --name before-change
dsh manager snapshot new --use <runtime> --target <snapshot>
dsh manager snapshot new --use <runtime> --empty
dsh manager snapshot remove <snapshot>
```

`--target` copies an existing snapshot; `--empty` creates one without plugins. Alias characters are letters, digits, `.`, `_`, `-`; an alias cannot be all digits. Address an alias as `<runtime>@before-change`. Removal accepts several IDs but refuses any in-use or persistently selected snapshot before deleting any requested one.

## Try a plugin change

1. Stop sessions that will use the snapshot.
2. Create a new snapshot; note its printed ID.
3. Make the plugin change using the application command.
4. After exiting the application, remove the new snapshot if the change failed.

```sh
dsh manager snapshot new --name experiment
dsh plugin --profile tui add <package>
dsh manager snapshot remove <runtime>@experiment
```

With the default newest-snapshot selection, the next launch uses the remaining previous snapshot. If you had a saved snapshot choice, explicitly select the intended one instead; new snapshots do not override a pin. Removing a snapshot loses plugin changes inside it, so keep a copy you need.

## Cross-runtime trial

```sh
dsh --snapshot <runtime-a>@1 --profile tui
dsh --use <runtime-b> --snapshot <runtime-a>@1 --profile tui
```

The first uses the snapshot's runtime; the second uses runtime B with A's existing plugin files. Nothing is copied or repaired. See [selection](select.md). A session and its application restarts keep the resolved snapshot until exit.
