#!/usr/bin/env bash
# Append one new product release to its independent index on the `releases` branch.
# Callers serialize with `concurrency: releases-index`; a racing fast-forward push fails, never retries.
# usage: scripts/publish-index.sh manager|runtime|addon <manifest.json>
#   env: GITHUB_REPOSITORY, GITHUB_TOKEN (or a local path/URL in DSH_BIN_INDEX_REMOTE for tests)
set -euo pipefail
kind=${1:?manager|runtime|addon}
case "$kind" in manager|runtime|addon) ;; *) echo "unknown index product: $kind" >&2; exit 2 ;; esac
manifest=$(realpath "${2:?manifest.json}")
here=$(cd "$(dirname "$0")" && pwd)
remote=${DSH_BIN_INDEX_REMOTE:-"https://x-access-token:${GITHUB_TOKEN:?}@github.com/${GITHUB_REPOSITORY:?}.git"}
work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/var/tmp}}/dsh-index.XXXXXX")
trap 'rm -rf -- "$work"' EXIT
git -C "$work" init -q
git -C "$work" remote add origin "$remote"
git -C "$work" config user.name 'github-actions[bot]'
git -C "$work" config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git -C "$work" config commit.gpgsign false

name="runtime-index.json"
if [[ "$kind" == manager ]]; then name="manager-index.json"; fi
if git -C "$work" ls-remote --exit-code --heads origin releases >/dev/null; then
	git -C "$work" fetch -q origin releases
	git -C "$work" checkout -q -B releases FETCH_HEAD
else
	git -C "$work" checkout -q --orphan releases
fi
if [[ "$kind" == manager ]]; then
	bun "$here/../../dsh-manager/scripts/release.mjs" append "$work/$name" "$manifest"
elif [[ "$kind" == addon ]]; then
	bun "$here/index.mjs" append-addon "$work/$name" "$manifest"
else
	bun "$here/index.mjs" append-bundle "$work/$name" "$manifest"
fi
git -C "$work" add -- "$name"
if git -C "$work" diff --cached --quiet; then exit 0; fi
git -C "$work" commit -qm "$kind index: $(basename "$manifest")"
git -C "$work" push -q origin HEAD:releases || { echo 'index push raced; no index was overwritten, rerun explicitly' >&2; exit 1; }
