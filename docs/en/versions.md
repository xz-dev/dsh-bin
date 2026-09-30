# Versions and updates

[README](../../README.md) · [中文](../zh-CN/versions.md)

dsh-bin keeps several dsh versions installed side by side. One launcher starts any of them.

## See what is installed

```sh
dsh list           # installed versions, what can be installed, addon versions
dsh list --json
```

Installed versions are marked `selected`, `latest` and `in use`. `dsh list` is read-only: it downloads nothing and changes nothing.

## Update

```sh
dsh update
```

This installs the newest version of your channel next to the installed ones. Nothing is replaced. `dsh update self`, `dsh update dsh` and `dsh update --self` do the same.

- It never changes what a plain `dsh` starts. If you [pinned](select.md) another version, it warns you.
- If no installed office addon fits the new version, it prints how to install one.
- `dsh update --force` reinstalls the newest version.

There is no downgrade command: older versions are still installed. Start one with `dsh --use <version>`, or [select](select.md) it.

## Channels

| Channel | Follows |
|---|---|
| `release` (default) | upstream `dsh-v*` tags |
| `live` | upstream `master` |

```sh
dsh update --channel live      # switch to live
dsh update --channel release   # switch back
```

The new channel is recorded only after the install succeeds.

## Install a specific version

```sh
dsh install 0.1.7-rc.2
dsh install 0.1.7-rc.2 --channel live
```

A version can be the exact version, the release tag, or the upstream version such as `0.1.7-rc.2`. A unique prefix is enough. The install also creates the version's first [snapshot](snapshots.md).

## Remove a version

```sh
dsh uninstall 0.1.7-rc.2
dsh uninstall 0.1.7-rc.1 0.1.7-rc.2
```

Snapshots of removed versions are kept. It refuses, for the whole list, if any of them is:

- the last installed version;
- the version you pinned with `dsh select`;
- in use.

"In use" means a dsh process started by dsh-bin is running it: a session, `dsh plugin`, or an in-app restart. Child processes are not tracked.

## Weak networks

Updates are made to survive bad connections:

- **Resume.** A retry continues where the download stopped (HTTP `Range`). An interrupted run keeps its partial file, and the next `dsh update` continues from there.
- **Retry.** Network errors and HTTP 408/425/429/5xx are retried with exponential backoff, honouring `Retry-After`.
- **Timeout.** A download that receives no data for 30 s is aborted and retried.
- **Check.** The finished file is checked against the index size and SHA-256. A resumed file that fails is downloaded once more from the start.
- **Progress.** A progress bar with speed and ETA on a terminal; one plain line per second otherwise.

The new version is activated atomically: first the bundle, then the root launcher.

## Clean up

```sh
dsh clean              # same as --all
dsh clean --update     # partial downloads and install staging
dsh clean --snapshots  # snapshot staging
dsh clean --transpiler # dsh-bin's transpiler cache
```

`dsh clean` removes only leftovers of interrupted runs and caches. It never removes installed versions, addons or snapshots.
