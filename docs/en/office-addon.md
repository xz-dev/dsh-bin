# Office addon

[README](../../README.md) · [中文](../zh-CN/office-addon.md)

The office plugins (`office-to-pdf`, `skill-office`) need LibreOffice Kit. It is large, so it ships as a separate addon, not in the main archive. Without it, those two plugins show up as inactive when dsh starts, and everything else works.

## Install and remove

```sh
dsh install --addon office                   # the default version for your dsh version
dsh install --addon office:<version>         # a specific version
dsh uninstall --addon office:<version>       # remove one version
dsh uninstall --addon office                 # remove every version
dsh list --addon office                      # installed and available versions
```

Several addon versions can be installed side by side. `dsh uninstall --addon` refuses a version that is in use or [selected](select.md).

With Scoop, use `scoop install dsh-bin/dsh-office` instead.

## Which version is used

Each addon version belongs to a **slot**: the LibreOffice Kit version that upstream uses, and the upstream commit that introduced it. A dsh version works with the addons of its own slot.

- A plain launch uses the newest installed addon of the right slot.
- The default version for `dsh install --addon office` is the newest of the right slot in the release index. When the index is unreachable, it is the version pinned when the dsh version was built.
- Each version carries the list of its slot's addon versions, so they stay installable even offline.

## Using an addon from another slot

An addon from another slot may not work. dsh-bin allows it but makes you ask for it:

```sh
dsh install --addon office:<version> --force
dsh --addon office:<version> ...              # or: dsh select --use latest --addon office:<version>
```

It is used only when named, and each such start prints a warning. If a named version is not installed, the start stops and tells you how to install it.
