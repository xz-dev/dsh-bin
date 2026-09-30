#!/bin/sh
# Install dsh-bin for Linux and macOS. It runs the README's manual ZIP install:
#   mkdir -p ~/.local/share/dsh-bin
#   unzip dsh-<target>.zip -d ~/.local/share/dsh-bin
#   ln -s ~/.local/share/dsh-bin/dsh ~/.local/bin/dsh
#   dsh --version
# and adds only what the manual steps leave to you: picking <target>, downloading the zip from the
# Latest release (the release channel) and checking it against that release's SHA256SUMS.
# Usage: curl -fsSL https://raw.githubusercontent.com/xz-dev/dsh-bin/main/install.sh | sh
# DSH_BIN_TARGET=<target> overrides the detected target, for example linux-x64-baseline.
set -eu

REPO=xz-dev/dsh-bin
DIR="$HOME/.local/share/dsh-bin"
BIN="$HOME/.local/bin"

die() { printf 'dsh-bin install: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required"; }

detect() {
	os=$(uname -s)
	arch=$(uname -m)
	case "$arch" in
		x86_64 | amd64) arch=x64 ;;
		aarch64 | arm64) arch=arm64 ;;
		*) die "unsupported CPU: $arch" ;;
	esac
	case "$os" in
		Linux)
			libc=
			if ls /lib/ld-musl-* >/dev/null 2>&1 || ldd --version 2>&1 | grep -qi musl; then libc=-musl; fi
			if [ "$arch" = arm64 ]; then echo "linux-arm64$libc"; return; fi
			if grep -qw avx2 /proc/cpuinfo 2>/dev/null; then cpu=modern; else cpu=baseline; fi
			echo "linux-x64$libc-$cpu"
			;;
		Darwin)
			# An x64 shell under Rosetta on Apple silicon still gets the native arm64 build.
			if [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then arch=arm64; fi
			if [ "$arch" = arm64 ]; then echo darwin-arm64; return; fi
			if sysctl -n machdep.cpu.leaf7_features 2>/dev/null | grep -qw AVX2; then cpu=modern; else cpu=baseline; fi
			echo "darwin-x64-$cpu"
			;;
		*) die "unsupported OS: $os (on Windows, use Scoop)" ;;
	esac
}

sha256() {
	if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

need curl
need unzip
command -v sha256sum >/dev/null 2>&1 || need shasum

target=${DSH_BIN_TARGET:-$(detect)}
zip="dsh-$target.zip"
case "$target" in
	# Bun's musl build links libstdc++ and libgcc_s, which Alpine does not install by default.
	*-musl*) [ -e /usr/lib/libstdc++.so.6 ] && [ -e /usr/lib/libgcc_s.so.1 ] \
		|| die "musl builds need libstdc++ and libgcc (Alpine: apk add libstdc++ libgcc)" ;;
esac

# The manual steps would stop here too: unzip into a used directory prompts, ln -s onto a file fails.
[ -e "$DIR/dsh" ] && die "$DIR already holds an install; run 'dsh update' instead"
[ -e "$BIN/dsh" ] || [ -L "$BIN/dsh" ] && die "$BIN/dsh already exists; move it away first (see 'Migrating from the npm wrapper')"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

echo "Downloading $zip"
curl -fL --retry 3 -o "$tmp/$zip" "https://github.com/$REPO/releases/latest/download/$zip"
curl -fsSL --retry 3 -o "$tmp/SHA256SUMS" "https://github.com/$REPO/releases/latest/download/SHA256SUMS"
want=$(awk -v f="$zip" '$2 == f { print $1 }' "$tmp/SHA256SUMS")
[ -n "$want" ] || die "$zip is not in the release's SHA256SUMS"
[ "$(sha256 "$tmp/$zip")" = "$want" ] || die "$zip does not match its SHA-256"

mkdir -p "$BIN"
mkdir -p "$DIR"
unzip -q "$tmp/$zip" -d "$DIR"
ln -s "$DIR/dsh" "$BIN/dsh"
"$BIN/dsh" --version

case ":$PATH:" in
	*":$BIN:"*) ;;
	*) echo "Add $BIN to your PATH to run dsh." ;;
esac
