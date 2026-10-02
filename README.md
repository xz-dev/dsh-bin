# dsh-bin

English | [简体中文](README.zh-CN.md)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), with a standalone Zig manager and separate Bun runtime bundles. Neither management nor the installed application needs host Node.js or Bun.

- **Independent updates.** `dsh manager update` installs a runtime; `dsh manager self-update` updates only the manager.
- **Versions side by side.** Install a new runtime without replacing old ones. Choose an installed version for one launch or save a default.
- **Plugin snapshots.** Keep plugin files per runtime in numbered snapshots. Shared configuration, credentials and sessions stay in the application home.
- **Portable by default.** Keep the manager and its adjacent `dsh-bin/` directory together. Stop sessions before moving them to a compatible system.

## Install

**Release status:** the new manager/runtime release families and manager-only Gentoo/Scoop packages are not published yet. Existing releases and bucket manifests are not the new installation described here. Use the instructions below once the new assets are published.

Download `manager-<target>.zip` from a **`manager-v<semver>`** [release](https://github.com/xz-dev/dsh-bin/releases), verify its size and SHA-256 against `manager-index.json`, then extract its single `dsh` file (`dsh.exe` on Windows) into a directory you own. Targets: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `windows-x64`, `windows-arm64`.

Put that directory on PATH, or invoke the file directly. The manager chooses the runtime's libc/CPU target; do not download a runtime ZIP as the manager. See [installation, data locations and uninstall](desc/en/install.md).

## Start and manage

```sh
dsh                              # first ordinary launch installs a runtime if needed
dsh manager --help               # native commands; no runtime needed
dsh manager info                 # install mode, data root and application home
dsh manager update               # install the current channel's newest runtime
dsh manager snapshot new --name before-change
dsh manager self-update          # portable manager only; runtimes and data stay
dsh manager clean                # offline cache/residue cleanup, not data deletion
```

First interactive launch asks about shell completion **before** checking or downloading a runtime. Accepting or declining both continue startup. Noninteractive launches skip the question without consuming application stdin. A new empty installation defaults to the release channel; installed runtimes start offline without an implicit update.

## Documentation

- [Install, data locations, managed packages and uninstall](desc/en/install.md)
- [Versions and independent updates](desc/en/versions.md)
- [Choosing a runtime, snapshot and addon](desc/en/select.md)
- [Plugin snapshots](desc/en/snapshots.md)
- [Office addon](desc/en/office-addon.md)
- [Bash, Zsh, Fish and PowerShell completion](desc/en/completion.md)
- [Layout, release identities, trust and development](desc/en/how-it-works.md)

Code and scripts belong to [dsh-manager/](dsh-manager/) or [dsh-bun-build/](dsh-bun-build/). Shared documentation lives in [desc/](desc/); planning in [openspec/](openspec/).

## License

Manager, compatibility layer and packaging scripts use [MIT](LICENSE). DeepSeek Harness and bundled dependencies retain their own licenses; the office addon includes LibreOffice Kit under MPL-2.0.
