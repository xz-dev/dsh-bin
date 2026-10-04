# Plugin and configuration snapshots

[README](../../README.md) · [中文](../zh-CN/snapshots.md)

Choose plugin files and configuration independently for each launch:

| Kind | Location under the data root | Contents |
|---|---|---|
| `plugins` (P) | `snapshots/<runtime>@<n>/` | Per-profile packages, dependencies, lockfiles, `.plugin-manager` and generated `cordis.yml` |
| `config` (C) | `config-snapshots/<runtime>@<n>/` | All profile user patches, settings documents and retained imports, built-in local credentials |

C includes `profiles/<name>/cordis.patch.yml`, `settings.yaml`, `settings.yaml.imported` and `.credentials.yaml` when present. It does not include plugin dependencies, generated `cordis.yml`, addons, sessions, caches, manager selection or operation locks. Both roots stay under the manager data root, regardless of `DSH_HOME`. Application home still holds non-configuration state such as sessions; it is not a fallback configuration or credential store for managed launches.

These are writable working collections, not immutable restore-only backups. Copying preserves bytes rather than converting YAML; the selected application may import or update its own C. Plugin resolution and generated `cordis.yml` remain in P.

## Create and remove

Each kind has its own increasing, never-reused sequence and aliases. `plugins A@1` and `config A@1` are different objects. Installing or starting a runtime missing one kind copies the previous runtime's newest collection of that kind, or creates it empty when no predecessor exists. Valid existing collections are retained; the two sequences are not synchronized.

```sh
dsh manager snapshot plugins list
dsh manager snapshot config list --json
dsh manager snapshot plugins new --name before-plugin-change
dsh manager snapshot config new --name before-config-change
dsh manager snapshot config new --use <runtime-b> --target <runtime-a>@1
dsh manager snapshot config new --use <runtime> --empty
dsh manager snapshot config remove <runtime>@before-config-change
```

The kind is required: there is no `manager snapshot new` alias. The same `new`, `list` and `remove` operations work for either kind. Default `new` copies that runtime's newest collection of the same kind and fails if it has no source; choose `--empty` explicitly in that case. `--target` and `--empty` are mutually exclusive. Aliases use letters, digits, `.`, `_`, `-` and cannot consist only of digits.

Removal accepts multiple IDs but checks the entire requested batch first. In-use or persistently selected collections cannot be removed. With no pin, deleting the newest collection makes a later launch use the newest remaining one; creation never overrides a saved pin. Removing all collections does not immediately create another. Runtime uninstall, reinstall and `manager clean` do not erase valid snapshots.

Stop sessions before copying if you need a consistent multi-file view. Copying is not an application-wide transaction: an I/O error or detected source change fails rather than publishing a partial collection. Configuration files and staging remain private; copies do not share writable hardlinks. Link, special-file, ownership and destination checks are not bypassed by copying.

## Try a change

```sh
dsh manager snapshot plugins new --name experiment
dsh manager snapshot config new --name config-trial
dsh --use <runtime> --snapshot <runtime>@experiment --config-snapshot <runtime>@config-trial plugin --profile tui add <package>
dsh --use <runtime> --snapshot <runtime>@experiment --config-snapshot <runtime>@config-trial --profile tui
```

Package installation changes P; plugin enablement, configuration and credential updates use C. Selecting both copies explicitly also protects the original C when a plugin command updates its settings. Neither operation rewrites shared HOME configuration. After the application exits, retain the copies you need or remove the failed trial with the corresponding typed command. A running session keeps its resolved P/C; changing defaults affects subsequent launches. See [selection](select.md).

## Cross-runtime use and local credentials

```sh
dsh --config-snapshot <runtime-a>@1 --profile tui
dsh --use <runtime-b> --snapshot <runtime-a>@1 --config-snapshot <runtime-a>@1 --profile tui
```

A snapshot alone implies its runtime; an explicit `--use` can run B directly against A's selected collections. Nothing is secretly copied or repaired. **B may change the explicitly selected A configuration.** Prefer creating a copy first when testing a new application's format. Manager copying does not rewrite absolute paths or convert credentials.

Built-in local credential paths such as `accounts/work.yaml` resolve under the selected C, not the working directory. Absolute paths and provider home overrides must remain inside C. References to shared home, another snapshot, parent traversal or escaping links are rejected before opening or watching credentials; there is no fallback to another file. An empty C uses application defaults or reports missing credentials, even when old credentials exist in home. Other external credential backends and arbitrary plugin I/O are outside this snapshot guarantee.

## Compatibility and development status

Valid old plugin metadata and saved selections without a config reference remain readable. Shared HOME configuration is not automatically imported. Managed application launch requires a compatible **protocol-2 runtime**; older protocol-1 runtime bundles are rejected before application execution, not silently upgraded. Standalone upstream operation retains upstream path behavior; raw snapshot environment variables do not grant managed configuration access.

This branch is still under acceptance, not a newly published release. Windows managed configuration startup remains deliberately disabled until native component and real-application gates pass. Actual upstream internal-restart and the complete native/combined-artifact gates are still pending; transport or hand-written respawn tests are not substitutes. Current evidence and remaining gaps are in the [change record](../../openspec/changes/add-config-snapshots-and-paths/evidence.md). Node-internal HMR remains disabled as described in [application limitations](how-it-works.md#application-limitations).
