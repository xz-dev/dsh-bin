# Choosing what `dsh` starts

[README](../../README.md) · [中文](../zh-CN/select.md)

A plain `dsh` starts the **selection**: a version, a snapshot and addon versions. By default it is `latest`: the newest installed version of your channel, with that version's newest snapshot and default addons.

## For one run

Put these options before any other argument:

```sh
dsh --use 0.1.7-rc.2 --profile tui                  # an installed version (a unique prefix is enough)
dsh --snapshot 0.2.0-rc.1@1 --profile tui           # a snapshot (implies its version)
dsh --use 0.2.0 --snapshot 0.1.7-rc.2@2 ...         # an old snapshot on a new version
dsh --addon office:0.1.2-xz.11.1.gaaaa0001 ...      # a specific addon version
```

## Change the default

```sh
dsh select                                          # show the selection and what it resolves to
dsh select --use 0.1.7-rc.2                         # pin a version
dsh select --use 0.1.7-rc.2 --snapshot 0.1.7-rc.2@2 # pin a version and snapshot
dsh select --use latest                             # back to the default
```

- `--use` is required. Options you leave out go back to their defaults.
- Selecting never downloads anything; the version must already be installed.
- `dsh update` does not change the selection. While a version is pinned, it warns you after installing a newer one.

## Running sessions

A running session keeps its version and snapshot until it exits, including in-app restarts. Changing the selection affects only new starts.

## Help

`dsh --help` shows upstream's help followed by the dsh-bin options and commands. `dsh plugin --profile <name> …` manages plugins as upstream designed. upstream's own `dsh update` never runs; use dsh-bin's [`dsh update`](versions.md#update).
