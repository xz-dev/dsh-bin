#!/bin/sh
# Opt-in real Portage lifecycle, non-root only. Never uses the system ROOT/config/VDB.
# Logs survive under /var/tmp/dsh-74-gentoo/logs; all other scratch state is removed.
set -eu
[ "$(id -u)" -ne 0 ] || { echo 'run as a non-root user'; exit 1; }
base=/var/tmp/dsh-74-gentoo
[ ! -L "$base" ] && [ ! -L "$base/logs" ] || { echo 'scratch root/logs must not be links'; exit 1; }
manager=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ -d "$base" ] && [ -n "$(find "$base" -mindepth 1 -maxdepth 1 ! -name logs -print -quit)" ]; then
	echo "$base has existing scratch state; inspect it before retrying"; exit 1
fi
mkdir -p "$base/logs" "$base/root" "$base/config/etc/portage/repos.conf" "$base/overlay/profiles/minimal" "$base/overlay/metadata" "$base/overlay/app-misc/dsh-bin" "$base/dist" "$base/tmp" "$base/home"
trap 'rm -rf "$base/root" "$base/config" "$base/overlay" "$base/dist" "$base/tmp" "$base/home" "$base/build1" "$base/build2"' EXIT HUP INT TERM
export TMPDIR="$base/tmp"
printf 'dsh-74-test\n' > "$base/overlay/profiles/repo_name"
printf 'masters =\nthin-manifests = true\n' > "$base/overlay/metadata/layout.conf"
cat > "$base/overlay/profiles/minimal/make.defaults" <<'EOF'
ARCH="amd64"
CHOST="x86_64-pc-linux-gnu"
IUSE_IMPLICIT="amd64 arm64"
USE="amd64"
EOF
ln -s "$base/overlay/profiles/minimal" "$base/config/etc/portage/make.profile"
cat > "$base/config/etc/portage/repos.conf/dsh.conf" <<EOF
[DEFAULT]
main-repo = dsh-74-test
[dsh-74-test]
location = $base/overlay
masters =
auto-sync = no
EOF
cat > "$base/config/etc/portage/make.conf" <<EOF
ARCH="amd64"
CHOST="x86_64-pc-linux-gnu"
ACCEPT_KEYWORDS="~amd64"
ACCEPT_LICENSE="*"
DISTDIR="$base/dist"
PORTAGE_TMPDIR="$base/tmp"
PORTAGE_DEPCACHEDIR="$base/root/var/cache/edb/dep"
PORT_LOGDIR="$base/logs"
FEATURES="-sandbox -usersandbox -userpriv -network-sandbox -ipc-sandbox -pid-sandbox -mount-sandbox -ebuild-locks unprivileged"
EOF
cd "$manager"
for number in 1 2; do
	version=1.0.0; [ "$number" = 1 ] || version=1.0.1
	zig build "-Dversion=$version" --prefix "$base/build$number" > "$base/logs/build$number.log" 2>&1
	bun --eval '
	import { writeZip } from "../dsh-bun-build/runtime/zip.ts";
	import { readFileSync, writeFileSync } from "node:fs";
	import { createHash } from "node:crypto";
	import { gentooEbuild } from "./scripts/gentoo-ebuild.mjs";
	const [base, number, version] = process.argv.slice(1);
	const tag = `manager-v${version}`, zip = `${base}/dist/${tag}-linux-x64.zip`;
	writeZip(zip, [{name: "dsh", data: readFileSync(`${base}/build${number}/bin/dsh`), mode: 0o755}]);
	// Only amd64 executes here; the unused arm64 fixture uses identical bytes for offline Manifest generation.
	writeFileSync(`${base}/dist/${tag}-linux-arm64.zip`, readFileSync(zip));
	const bytes = readFileSync(zip), asset = {name: "manager-linux-x64.zip", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex")};
	const result = gentooEbuild({schema: 1, versions: [{version, tag, launchProtocols: [1], assets: {"linux-x64": asset, "linux-arm64": asset}}]}, readFileSync("packaging/gentoo/dsh-bin-9999.ebuild.in", "utf8"));
	writeFileSync(`${base}/overlay/app-misc/dsh-bin/dsh-bin-${result.pv}.ebuild`, result.ebuild);
	' "$base" "$number" "$version"
done
env -i PATH=/usr/bin:/bin HOME="$base/home" ROOT="$base/root" PORTAGE_CONFIGROOT="$base/config" TMPDIR="$base/tmp" \
	ebuild "$base/overlay/app-misc/dsh-bin/dsh-bin-1.0.0.ebuild" manifest > "$base/logs/manifest.log" 2>&1
cp "$base/overlay/app-misc/dsh-bin/Manifest" "$base/logs/Manifest"
env -i PATH=/usr/bin:/bin HOME="$base/home" ROOT="$base/root" PORTAGE_CONFIGROOT="$base/config" TMPDIR="$base/tmp" \
	ebuild "$base/overlay/app-misc/dsh-bin/dsh-bin-1.0.0.ebuild" clean install merge > "$base/logs/install1.log" 2>&1
sh scripts/gentoo-layout-check.sh "$base/root"
DSH_GENTOO_TEST_ROOT="$base/root" bun test ./test/gentoo.test.ts > "$base/logs/real.log" 2>&1
cat "$base/logs/real.log"
