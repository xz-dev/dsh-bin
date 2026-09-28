#!/bin/sh
# Gentoo-managed layout check (9.2). Run as root inside a container: installs the archive the way the
# ebuild does (root-owned /usr/lib/dsh-bin, /usr/bin/dsh symlink, .portage.managed.lock, optional
# office addon), then as an unprivileged user checks `dsh --version`, a refused `dsh update` and
# `dsh install --addon office` naming portage, and that the prefix cannot be written.
# usage: gentoo-layout-check.sh <dsh-linux-*.zip> [<dsh-addon-office-linux.zip> <addon-version>]
set -eu
zip=$1 addon=${2:-} addon_version=${3:-}
dest=/usr/lib/dsh-bin
rm -rf "$dest" /usr/bin/dsh
mkdir -p "$dest"
unzip -q "$zip" -d "$dest"
if [ -n "$addon" ]; then
	mkdir -p "$dest/addons/office/$addon_version"
	unzip -q "$addon" -d "$dest/addons/office/$addon_version"
	printf '{\n  "office": {\n    "version": "%s",\n    "forced": false\n  }\n}\n' "$addon_version" >"$dest/addons.json"
fi
touch "$dest/.portage.managed.lock"
chown -R 0:0 "$dest"
chmod -R go-w "$dest"
ln -s "$dest/dsh" /usr/bin/dsh
id dshuser >/dev/null 2>&1 || useradd -m dshuser 2>/dev/null || adduser -D dshuser
as_user() { su dshuser -s /bin/sh -c "cd && $1"; }

out=$(as_user 'dsh --version')
echo "dsh --version: $out"
set +e
out=$(as_user 'dsh update' 2>&1); code=$?
set -e
echo "dsh update -> $code: $out"
if [ "$code" -eq 0 ] || ! echo "$out" | grep -q portage; then echo "FAIL: update not refused naming portage"; exit 1; fi
set +e
out=$(as_user 'dsh install --addon office' 2>&1); code=$?
set -e
echo "dsh install --addon office -> $code: $out"
if [ "$code" -eq 0 ] || ! echo "$out" | grep -q portage; then echo "FAIL: addon install not refused naming portage"; exit 1; fi
# Offline (--network=none) there is no newer version, so list shows no hint; it still names the manager.
out=$(as_user 'dsh list' 2>&1 || true)
echo "$out" | grep -q "managed by portage" || { echo "FAIL: list does not name portage"; echo "$out"; exit 1; }
if as_user "touch $dest/x" 2>/dev/null; then echo "FAIL: prefix writable"; exit 1; fi
echo "gentoo layout: ok"
