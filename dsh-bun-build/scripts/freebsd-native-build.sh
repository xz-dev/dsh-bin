#!/bin/sh
# Run only inside an owned full-system FreeBSD 15.1 guest, after verified inputs
# and frozen-source.tar.gz/candidate-files.tar have been staged in /opt/task-build.
set -eu
cd /opt/task-build
case "$1" in
  x64) zig_arch=x86_64; bun_dir=bun-freebsd-x64-baseline; bun_target=bun-freebsd-x64-baseline ;;
  arm64) zig_arch=aarch64; bun_dir=bun-freebsd-aarch64; bun_target=bun-freebsd-arm64 ;;
  *) echo 'usage: freebsd-native-build.sh x64|arm64' >&2; exit 2 ;;
esac
[ "$(uname -s)" = FreeBSD ]
[ "$(freebsd-version -u)" = 15.1-RELEASE ]
# Zig 0.15.2's bundled FreeBSD libc stubs predate renameat2@FBSD_1.9.
# Native 15.1 headers/libraries, not a newer host or a generated cross-libc stub.
[ "$(uname -m)" = "$(case "$1" in x64) echo amd64;; arm64) echo arm64;; esac)" ]
mkdir -p tools frozen candidate artifacts logs
# SHA-256 checks also run before extraction on guest (manifest from authenticated inputs).
(cd inputs && while read -r digest filename; do [ "$(sha256 -q "$filename")" = "$digest" ]; done < SHA256SUMS)
tar -xf "inputs/zig-$zig_arch-freebsd-0.15.2.tar.xz" -C tools
tar -xf "inputs/$bun_dir.zip" -C tools
tar -xf inputs/frozen-source.tar.gz -C frozen
cp -R frozen/. candidate/
tar -xf inputs/candidate-files.tar -C candidate
ZIG="/opt/task-build/tools/zig-$zig_arch-freebsd-0.15.2/zig"
BUN="/opt/task-build/tools/$bun_dir/bun"
export HOME=/opt/task-build
export ZIG_GLOBAL_CACHE_DIR=/opt/task-build/zig-cache
export BUN_INSTALL_CACHE_DIR=/opt/task-build/bun-cache
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
record() {
  label=$1; shift
  printf '\nCOMMAND:'
  printf ' %s' "$@"
  printf '\n'
  set +e
  "$@" > "/opt/task-build/logs/$label.log" 2>&1
  result=$?
  set -e
  cat "/opt/task-build/logs/$label.log"
  printf '\nEXIT=%s\n' "$result"
  printf '%s\n' "$result" > "/opt/task-build/logs/$label.exit"
}
uname -a
freebsd-version -kru
"$ZIG" version
"$BUN" -e 'console.log(JSON.stringify({platform:process.platform,arch:process.arch,bun:process.versions.bun}))'
sha256 "$ZIG" "$BUN" inputs/frozen-source.tar.gz inputs/candidate-files.tar
cd frozen/dsh-manager
record frozen-target "$ZIG" test src/target.zig
record frozen-suite "$ZIG" build test -j1
libc_dir=$(mktemp -d /var/tmp/dsh-freebsd-emlink-libc.XXXXXXXX)
libc_file="$libc_dir/libc.conf"
"$ZIG" libc > "$libc_file"
sha256 "$libc_file"
cd /opt/task-build/candidate/dsh-manager
record target "$ZIG" test src/target.zig
record manager "$ZIG" build -j1 --libc "$libc_file" "-Dtarget=$zig_arch-freebsd.15.1" -Dcpu=baseline -Dversion=0.0.0-freebsd-task
[ "$(cat /opt/task-build/logs/manager.exit)" = 0 ]
cp zig-out/bin/dsh /opt/task-build/artifacts/dsh
cd /opt/task-build/candidate/dsh-bun-build
record targets "$BUN" scripts/targets.mjs --host
record compiler-tests "$BUN" test test/unit/targets.test.ts test/unit/compile-entry.test.ts
record entry "$BUN" scripts/compile-entry.mjs "$bun_target" /opt/task-build/artifacts/dsh-native --compile-executable-path "$BUN"
[ "$(cat /opt/task-build/logs/entry.exit)" = 0 ]
cd /opt/task-build
sha256 artifacts/dsh artifacts/dsh-native
file artifacts/dsh artifacts/dsh-native
ldd artifacts/dsh
ldd artifacts/dsh-native
readelf -n artifacts/dsh
readelf -n artifacts/dsh-native
