# Office addon

[README](../../README.md) · [中文](../zh-CN/office-addon.md)

The `office-to-pdf` and `skill-office` plugins need LibreOffice Kit. It ships as a separate addon; without a compatible installed addon those plugins are inactive and other application functions remain available.

## Install, inspect and remove

Install/select a runtime first, so the manager can read its office compatibility slot.

```sh
dsh manager install --addon office
dsh manager install --addon office:<addon>
dsh manager list
dsh manager list --available
dsh manager uninstall --addon office:<addon>
dsh manager uninstall --addon office
```

Several versions can coexist under data-root `addons/office/`. Installation checks the addon without running dsh. Removal refuses in-use or persistently selected versions. The same commands work under Gentoo and Scoop; no separate office system package is needed.

## Compatibility and defaults

The runtime declares a slot identifying its upstream LibreOffice Kit dependency. Without an explicit selection, startup uses the highest-sequence installed addon of that slot, entirely offline.

`install --addon office` chooses the newest compatible index entry, or the runtime's embedded pinned entry if the index is unavailable. Embedded metadata does not make an undownloaded ZIP available offline: installation still needs the archive in verified cache or a reachable source. A runtime with no published matching addon reports no candidate.

`--force` reinstalls an addon but **never** bypasses its slot. Missing/incompatible explicit or saved launch choices produce a diagnostic and degrade to no office addon, not another version.

## Select or disable

```sh
dsh --addon office:<addon> --profile tui
dsh --addon office:none --profile tui
dsh manager select --use <runtime> --addon office:<addon>
dsh manager select --use latest --addon office:none
```

Saved addon selection requires `--use`. Omitting `--addon` when saving a selection clears the addon override. For repeated launch addon choices, the last wins. See [selection](select.md).
