#!/bin/sh
# Check an already-installed manager-only Gentoo image, without touching system paths or real HOME.
# usage: gentoo-layout-check.sh <installed-root>
set -eu
root=$(realpath "$1")
entry="$root/usr/bin/dsh"
prefix="$root/usr/lib/dsh-bin"
[ -x "$entry" ] && [ -L "$entry" ] || { echo 'missing package entry'; exit 1; }
[ "$(find "$prefix" -mindepth 1 -maxdepth 1 | wc -l)" -eq 2 ] || { echo 'package must contain only manager and marker'; exit 1; }
[ -f "$prefix/.dsh-manager-install.json" ] || exit 1
home=$(mktemp -d "${TMPDIR:-/var/tmp}/dsh-gentoo-layout-XXXXXX")
trap 'rm -rf "$home"' EXIT HUP INT TERM
run() { env -i PATH=/usr/bin:/bin HOME="$home" XDG_DATA_HOME="$home/xdg" "$entry" "$@"; }
info=$(run manager info)
printf '%s\n' "$info" | grep -q 'mode: portage'
printf '%s\n' "$info" | grep -Fq "$home/xdg/dsh-bin"
if out=$(run manager self-update 2>&1); then echo 'managed self-update unexpectedly succeeded'; exit 1; fi
printf '%s\n' "$out" | grep -q 'emerge'
[ ! -e "$home/xdg" ] || { echo 'read-only queries created user data'; exit 1; }
printf '%s\n' 'gentoo manager-only layout: ok'
