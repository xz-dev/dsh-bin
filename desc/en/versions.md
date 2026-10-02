# Versions and independent updates

[README](../../README.md) · [中文](../zh-CN/versions.md)

Native management never starts dsh and needs no host JS runtime. Application commands remain outside the `manager` namespace.

## Inspect

```sh
dsh manager --help
dsh manager --version
dsh manager info
dsh manager list
dsh manager list --json
dsh manager list --available
```

Local listing is read-only and offline. It includes installed runtimes and office addons, with selected/latest/in-use/startable information. Only `--available` requests the runtime index, adding compatible remote runtimes and office addons for the selected runtime.

## Update a runtime

```sh
dsh manager update
dsh manager update --channel live
dsh manager update --channel release
dsh manager update --force
```

`release` follows upstream release tags; `live` follows upstream master. A new installation defaults to release. A successful explicit channel change is recorded; a failed install leaves the channel unchanged.

An update adds the newest compatible runtime beside older ones, preserves saved selection and warns if a version is pinned. `--force` reinstalls the chosen runtime; it does not bypass compatibility or in-use protection. Ordinary launches do not implicitly update an existing installation.

## Install a version

```sh
dsh manager install <version>
dsh manager install <version> --channel live
dsh manager install <version> --force
```

Copy the full ID/tag from `list --available`, or use an unambiguous prefix/upstream version. More than one matching build is an error; give a longer identity. Installation verifies the bundle and prepares its first [snapshot](snapshots.md). Reinstalling a runtime keeps valid existing snapshots and home.

## Remove runtimes

```sh
dsh manager select --use latest
dsh manager uninstall <version>
dsh manager uninstall <version-a> <version-b>
```

You can remove **all** unused runtimes after unpinning. A request containing a missing, ambiguous, pinned or in-use runtime fails its preflight without deleting any requested runtime. Snapshots, saved selection, home and manager remain. Reinstalling the same runtime reuses retained data; ordinary empty startup can reinstall from the recorded channel.

Usage protection covers managed runtime processes and their application restarts, not every independent descendant process.

## Update only the manager

```sh
dsh manager self-update
dsh manager self-update --force
```

Portable self-update uses `manager-index.json`, not the runtime index. It compares strict SemVer (build metadata does not affect order), never downgrades, and normally skips the same version. `--force` permits same-version repair. Runtimes, snapshots, selection, configuration and credentials stay unchanged.

On POSIX the verified candidate atomically replaces the real executable; an entry symlink stays a symlink. On Windows a temporary copy of the same program waits for the parent to exit, then performs replacement. **Handed off is not updated**: the next invocation reports the helper's result. Image/file-system restrictions may refuse replacement while keeping the old entry; exit other manager invocations and retry explicitly.

Gentoo/Scoop installations refuse self-update before download: use `emerge --ask --update app-misc/dsh-bin` or `scoop update dsh` instead. Installing an older runtime never downgrades the manager.

## Downloads and cleanup

Downloads validate target identity, size, SHA-256, required paths and launch protocol before activation. Interrupted downloads can resume when the server's Range response is consistent; retries are bounded and honour Retry-After. Invalid bytes are not activated. Failures keep selection/channel unchanged.

```sh
dsh manager clean
```

Clean is offline and removes only recognized caches and interrupted-operation residue. It keeps valid runtimes, addons, snapshots, home, credentials and unknown files. If a relevant session or operation is busy, the entire clean refuses with zero deletions. A sole recovery copy is kept when the public generation is missing/invalid, with an explicit install recovery hint. There are no per-category clean flags.
