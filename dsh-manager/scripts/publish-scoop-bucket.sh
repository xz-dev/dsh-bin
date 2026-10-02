#!/usr/bin/env bash
# Publish the manager-only Scoop bucket from manager-index.json. Legacy runtime/live/addon manifests
# leave this generated bucket; production invocation belongs to the authorized release cutover.
# usage: scripts/publish-scoop-bucket.sh
#   env: GITHUB_REPOSITORY, GITHUB_TOKEN (or DSH_BIN_BUCKET_REMOTE / DSH_BIN_INDEX_FILE for tests)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repository=${GITHUB_REPOSITORY:-xz-dev/dsh-bin}
remote=${DSH_BIN_BUCKET_REMOTE:-"https://x-access-token:${GITHUB_TOKEN:?}@github.com/${repository}.git"}
work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/var/tmp}}/dsh-scoop.XXXXXX")
trap 'rm -rf -- "$work"' EXIT
index=${DSH_BIN_INDEX_FILE:-}
if [[ -z $index ]]; then
	index="$work/manager-index.json"
	git clone -q --depth=1 --branch releases "$remote" "$work/releases"
	cp "$work/releases/manager-index.json" "$index"
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
rm -f "$work/dsh.json" "$work/dsh-live.json" "$work/dsh-office.json"
mv "$work/bucket-new" "$work/bucket"
git -C "$work" add -A -- bucket
# Some old buckets used root-level manifests rather than bucket/. Stage their removals if tracked.
for name in dsh.json dsh-live.json dsh-office.json; do
	if git -C "$work" ls-files --error-unmatch "$name" >/dev/null 2>&1; then git -C "$work" add -u -- "$name"; fi
done
if git -C "$work" diff --cached --quiet; then
	echo 'Scoop bucket already current'
	exit 0
fi
git -C "$work" config user.name 'github-actions[bot]'
git -C "$work" config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git -C "$work" config commit.gpgsign false
git -C "$work" commit -qm "bucket: regenerate manager manifest from manager-index"
git -C "$work" push -q origin HEAD:scoop
echo 'Scoop bucket updated'
