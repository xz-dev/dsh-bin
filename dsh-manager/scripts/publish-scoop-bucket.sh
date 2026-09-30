#!/usr/bin/env bash
# Regenerate the Scoop bucket on the `scoop` branch from the current releases index (9.1, 9.4; port of
# xz-dev/pi publish-scoop-bucket.sh). The bucket always mirrors the newest index entries, so reruns and
# out-of-order builds converge to the same content.
# usage: scripts/publish-scoop-bucket.sh
#   env: GITHUB_REPOSITORY, GITHUB_TOKEN (or DSH_BIN_BUCKET_REMOTE / DSH_BIN_INDEX_FILE for tests)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repository=${GITHUB_REPOSITORY:-xz-dev/dsh-bin}
remote=${DSH_BIN_BUCKET_REMOTE:-"https://x-access-token:${GITHUB_TOKEN:?}@github.com/${repository}.git"}
work=$(mktemp -d "${RUNNER_TEMP:-/tmp}/dsh-scoop.XXXXXX")
trap 'rm -rf -- "$work"' EXIT
index=${DSH_BIN_INDEX_FILE:-}
if [[ -z $index ]]; then
	index="$work.index.json"
	git clone -q --depth=1 --branch releases "$remote" "$work/releases"
	cp "$work/releases/index.json" "$index"
	rm -rf "$work/releases"
fi
mkdir -p "$work/bucket-new"
bun "$here/create-scoop-manifest.mjs" "$index" "$work/bucket-new" --repo "$repository"
[[ -z ${DSH_BIN_INDEX_FILE:-} ]] && rm -f "$index"

git -C "$work" init -q
git -C "$work" remote add origin "$remote"
if git -C "$work" ls-remote --exit-code --heads origin scoop >/dev/null; then
	git -C "$work" fetch -q --depth=1 origin scoop
	git -C "$work" checkout -q -B scoop FETCH_HEAD
else
	git -C "$work" checkout -q --orphan scoop
fi
rm -rf "$work/bucket"
mv "$work/bucket-new" "$work/bucket"
git -C "$work" add -A bucket
if git -C "$work" diff --cached --quiet; then
	echo 'Scoop bucket already current'
	exit 0
fi
git -C "$work" config user.name 'github-actions[bot]'
git -C "$work" config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git -C "$work" config commit.gpgsign false
git -C "$work" commit -qm "bucket: regenerate from the releases index"
git -C "$work" push -q origin HEAD:scoop
echo 'Scoop bucket updated'
