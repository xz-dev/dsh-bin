#!/usr/bin/env python3
"""Acquire only pinned native FreeBSD build inputs into a caller-owned directory."""
import hashlib
from pathlib import Path
import sys
import urllib.request

INPUTS = {
    'bun-freebsd-x64-baseline.zip': ('https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/', 'f01d1789358f02625300776925cc8f67cf7c232fb8a394e186f5fa59300eed2d'),
    'bun-freebsd-aarch64.zip': ('https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/', 'a554958e5691c5036e576da78efb4114665da354c882cb0ca059bbd4a896b44a'),
    'zig-x86_64-freebsd-0.15.2.tar.xz': ('https://ziglang.org/download/0.15.2/', '5509ff57cd3f219165caed0da10221739af82742b9edfcda3f7bfaf4da7212dd'),
    'zig-aarch64-freebsd-0.15.2.tar.xz': ('https://ziglang.org/download/0.15.2/', 'c62efd319f86663eb7747709dfca259205edba8eaee98efc96a51ce40a9437de'),
}


def acquire(directory):
    directory.mkdir(parents=True, exist_ok=True)
    for name, (prefix, digest) in INPUTS.items():
        path = directory / name
        if not path.exists():
            partial = directory / (name + '.partial')
            request = urllib.request.Request(prefix + name, headers={'User-Agent': 'dsh-freebsd-native'})
            with urllib.request.urlopen(request, timeout=120) as response, partial.open('wb') as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
            if hashlib.sha256(partial.read_bytes()).hexdigest() != digest:
                raise ValueError(f'{name}: SHA-256 mismatch')
            partial.rename(path)
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError(f'{name}: SHA-256 mismatch')
        print(f'{digest}  {path}  source={prefix + name}', flush=True)


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('usage: freebsd-native-acquire.py <task-owned-input-directory>')
    acquire(Path(sys.argv[1]).resolve())
