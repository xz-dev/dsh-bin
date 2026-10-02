#!/usr/bin/env bash
# Append one bundle or addon release to `releases` branch index.json (8.4). The workflow serializes
# callers with `concurrency: releases-index`; the fetch–append–push loop with --force-with-lease also
# survives a racing writer. index.mjs refuses to modify or remove existing entries.
# usage: scripts/publish-index.sh bundle|addon <manifest.json>
#   env: GITHUB_REPOSITORY, GITHUB_TOKEN (or a local path/URL in DSH_BIN_INDEX_REMOTE for tests)
set -euo pipefail
kind=${1:?bundle|addon}
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

# New independent writers use a single fast-forward push; a racing writer fails clearly.
# The legacy bundle|addon index.json path below stays until section 9.2 cutover.
if [[ "$kind" == manager || "$kind" == runtime ]]; then
	name="$kind-index.json"
	if git -C "$work" ls-remote --exit-code --heads origin releases >/dev/null; then
		git -C "$work" fetch -q origin releases
		git -C "$work" checkout -q -B releases FETCH_HEAD
	else
		git -C "$work" checkout -q --orphan releases
	fi
	if [[ "$kind" == manager ]]; then
		bun "$here/../../dsh-manager/scripts/release.mjs" append "$work/$name" "$manifest"
	else
		bun "$here/index.mjs" append-bundle "$work/$name" "$manifest"
	fi
	git -C "$work" add -- "$name"
	if git -C "$work" diff --cached --quiet; then exit 0; fi
	git -C "$work" commit -qm "$kind index: $(basename "$manifest")"
	git -C "$work" push -q origin HEAD:releases || { echo 'index push raced; no index was overwritten, rerun explicitly' >&2; exit 1; }
	exit 0
fi

for attempt in 1 2 3 4 5 6 7 8; do
	if git -C "$work" ls-remote --exit-code --heads origin releases >/dev/null; then
		git -C "$work" fetch -q origin releases
		lease=$(git -C "$work" rev-parse FETCH_HEAD)
		git -C "$work" checkout -q -B releases FETCH_HEAD
	else
		lease=""
		git -C "$work" checkout -q --orphan releases
		git -C "$work" rm -rfq . 2>/dev/null || true
	fi
	entry=$(bun "$here/index.mjs" "append-$kind" "$work/index.json" "$manifest")
	git -C "$work" add index.json
	if git -C "$work" diff --cached --quiet; then
		echo "index already lists $entry"
		exit 0
	fi
	git -C "$work" commit -qm "index: $entry"
	if git -C "$work" push -q --force-with-lease="releases:$lease" origin HEAD:releases; then
		echo "appended $entry"
		exit 0
	fi
	echo "index push raced (attempt $attempt); retrying" >&2
	sleep $((attempt * 2))
done
echo "could not append to the releases index" >&2
exit 1
