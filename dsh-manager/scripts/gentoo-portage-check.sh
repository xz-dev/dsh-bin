#!/bin/sh
# Opt-in real Portage lifecycle, non-root only. Never uses the system ROOT/config/VDB.
# Logs survive in a fresh private run directory under /var/tmp/dsh-74-gentoo/logs; other scratch state is removed.
# Optional real artifacts: DSH_GENTOO_MANAGER_ZIP + DSH_GENTOO_MANAGER_INDEX (amd64 ZIP/index).
# Optional second version: DSH_GENTOO_UPGRADE_ZIP + DSH_GENTOO_UPGRADE_INDEX; otherwise builds 1.0.1.
# ARM64 ZIP from the same artifact directory is verified for Manifest generation, not executed.
set -eu
[ "$(id -u)" -ne 0 ] || { echo 'run as a non-root user'; exit 1; }
for pair in manager upgrade; do
	if [ "$pair" = manager ]; then zip=${DSH_GENTOO_MANAGER_ZIP:-}; index=${DSH_GENTOO_MANAGER_INDEX:-};
	else zip=${DSH_GENTOO_UPGRADE_ZIP:-}; index=${DSH_GENTOO_UPGRADE_INDEX:-}; fi
	[ -z "$zip$index" ] || { [ -f "$zip" ] && [ -f "$index" ]; } || { echo "$pair override requires both ZIP and index files"; exit 1; }
done
base=/var/tmp/dsh-74-gentoo
[ ! -L "$base" ] && [ ! -L "$base/logs" ] || { echo 'scratch root/logs must not be links'; exit 1; }
manager=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
if [ -d "$base" ] && [ -n "$(find "$base" -mindepth 1 -maxdepth 1 ! -name logs -print -quit)" ]; then
	echo "$base has existing scratch state; inspect it before retrying"; exit 1
fi
mkdir -p "$base/logs" "$base/root" "$base/config/etc/portage/repos.conf" "$base/overlay/profiles/minimal" "$base/overlay/metadata" "$base/overlay/app-misc/dsh-bin" "$base/dist" "$base/tmp" "$base/home"
logdir=$(mktemp -d "$base/logs/run-XXXXXX")
trap 'rm -rf "$base/root" "$base/config" "$base/overlay" "$base/dist" "$base/tmp" "$base/home" "$base/build1" "$base/build2"; printf "Gentoo logs: %s\n" "$logdir"' EXIT HUP INT TERM
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
PORT_LOGDIR="$logdir"
FEATURES="-sandbox -usersandbox -userpriv -network-sandbox -ipc-sandbox -pid-sandbox -mount-sandbox -ebuild-locks unprivileged"
EOF
cd "$manager"
for number in 1 2; do
	version=1.0.0; [ "$number" = 1 ] || version=1.0.1
	if [ "$number" = 1 ]; then zip=${DSH_GENTOO_MANAGER_ZIP:-}; index=${DSH_GENTOO_MANAGER_INDEX:-};
	else zip=${DSH_GENTOO_UPGRADE_ZIP:-}; index=${DSH_GENTOO_UPGRADE_INDEX:-}; fi
	if [ -z "$zip" ]; then zig build "-Dversion=$version" --prefix "$base/build$number" > "$logdir/build$number.log" 2>&1; fi
	# shellcheck disable=SC2016 # JavaScript template strings are evaluated by Bun.
	bun --eval '
	import { writeZip } from "../dsh-bun-build/runtime/zip.ts";
	import { readFileSync, writeFileSync } from "node:fs";
	import { dirname, join } from "node:path";
	import { createHash } from "node:crypto";
	import { gentooEbuild } from "./scripts/gentoo-ebuild.mjs";
	import { verifyZip } from "./scripts/release.mjs";
	const [base, number, version, suppliedZip, suppliedIndex] = process.argv.slice(1);
	let index;
	if (suppliedZip) {
		index = JSON.parse(readFileSync(suppliedIndex, "utf8"));
		// The generator validates identity/protocol/asset fields before any distfile is copied.
		gentooEbuild(index, readFileSync("packaging/gentoo/dsh-bin-9999.ebuild.in", "utf8"));
		const entry = [...index.versions].sort((a, b) => Bun.semver.order(b.version, a.version))[0];
		for (const target of ["linux-x64", "linux-arm64"]) {
			const asset = entry.assets[target];
			const bytes = readFileSync(target === "linux-x64" ? suppliedZip : join(dirname(suppliedZip), asset.name));
			if (bytes.length !== asset.size || createHash("sha256").update(bytes).digest("hex") !== asset.sha256.toLowerCase()) throw new Error(`${target}: supplied ZIP size/SHA256 mismatch`);
			verifyZip(bytes, target, entry.version);
			writeFileSync(`${base}/dist/${entry.tag}-${target}.zip`, bytes, { flag: "wx" });
		}
	} else {
		const tag = `manager-v${version}`, zip = `${base}/dist/${tag}-linux-x64.zip`;
		writeZip(zip, [{name: "dsh", data: readFileSync(`${base}/build${number}/bin/dsh`), mode: 0o755}]);
		// Only amd64 executes here; unused arm64 fixture shares bytes for offline Manifest generation.
		writeFileSync(`${base}/dist/${tag}-linux-arm64.zip`, readFileSync(zip), { flag: "wx" });
		const bytes = readFileSync(zip), asset = {name: "manager-linux-x64.zip", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex")};
		index = {schema: 1, versions: [{version, tag, launchProtocols: [1], assets: {"linux-x64": asset, "linux-arm64": asset}}]};
	}
	const result = gentooEbuild(index, readFileSync("packaging/gentoo/dsh-bin-9999.ebuild.in", "utf8"));
	writeFileSync(`${base}/overlay/app-misc/dsh-bin/dsh-bin-${result.pv}.ebuild`, result.ebuild, { flag: "wx" });
	writeFileSync(`${base}/tmp/version${number}.json`, JSON.stringify({version: [...index.versions].sort((a,b) => Bun.semver.order(b.version,a.version))[0].version, pv: result.pv}));
	console.log(`Gentoo candidate ${number}: ${result.pv} (${suppliedZip ? "verified external artifact" : "local build"})`);
	' "$base" "$number" "$version" "$zip" "$index"
done
# shellcheck disable=SC2016 # JavaScript template strings are evaluated by Bun.
bun --eval 'import {readFileSync} from "node:fs"; const b=process.argv[1]; const a=JSON.parse(readFileSync(`${b}/tmp/version1.json`)), c=JSON.parse(readFileSync(`${b}/tmp/version2.json`)); if (Bun.semver.order(c.version,a.version)<=0) throw new Error("Gentoo upgrade must be newer than installed version");' "$base"
pv1=$(bun --eval 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1])).pv)' "$base/tmp/version1.json")
pv2=$(bun --eval 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1])).pv)' "$base/tmp/version2.json")
version2=$(bun --eval 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1])).version)' "$base/tmp/version2.json")
cp "$base/tmp/version1.json" "$base/tmp/version2.json" "$logdir/"
env -i PATH=/usr/bin:/bin HOME="$base/home" ROOT="$base/root" PORTAGE_CONFIGROOT="$base/config" TMPDIR="$base/tmp" \
	ebuild "$base/overlay/app-misc/dsh-bin/dsh-bin-$pv1.ebuild" manifest > "$logdir/manifest.log" 2>&1
cp "$base/overlay/app-misc/dsh-bin/Manifest" "$logdir/Manifest"
env -i PATH=/usr/bin:/bin HOME="$base/home" ROOT="$base/root" PORTAGE_CONFIGROOT="$base/config" TMPDIR="$base/tmp" \
	ebuild "$base/overlay/app-misc/dsh-bin/dsh-bin-$pv1.ebuild" clean install merge > "$logdir/install1.log" 2>&1
sh scripts/gentoo-layout-check.sh "$base/root"
DSH_GENTOO_TEST_ROOT="$base/root" DSH_GENTOO_TEST_LOGS="$logdir" DSH_GENTOO_TEST_UPGRADE_PV="$pv2" DSH_GENTOO_TEST_UPGRADE_VERSION="$version2" bun test ./test/gentoo.test.ts > "$logdir/real.log" 2>&1
cat "$logdir/real.log"
