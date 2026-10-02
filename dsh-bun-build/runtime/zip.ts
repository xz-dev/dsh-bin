// Build/test ZIP utility: deterministic writer (scripts/archive.mjs) and validating reader for
// artifact inspection and extraction. The compiled runtime entry does not import this module;
// production installation and download validation belong to the standalone Zig manager.
//
// Scope: stored/deflate entries, no ZIP64 (the writer refuses what would need it), no encryption.
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

export type ZipInput = { name: string; data?: Uint8Array; mode: number; dir?: boolean };
export type ZipEntry = { name: string; dir: boolean; mode: number; method: number; crc: number; size: number; csize: number; offset: number };

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const MADE_BY_UNIX = (3 << 8) | 20;
const DOS_DATE_1980 = (0 << 9) | (1 << 5) | 1; // 1980-01-01
const MAX16 = 0xffff;
const MAX32 = 0xffffffff;

/** Normalized mode: directories and executables 0755, other files 0644. */
export const normalizeMode = (mode: number, dir: boolean) => (dir || mode & 0o111 ? 0o755 : 0o644);

/** Why `name` is not a safe relative entry path, or undefined when it is. */
export function unsafeName(name: string): string | undefined {
	const bare = name.endsWith("/") ? name.slice(0, -1) : name;
	if (!bare) return "empty name";
	if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return "absolute path";
	if (name.includes("\\")) return "backslash in path";
	if (name.includes("\0")) return "NUL in path";
	for (const part of bare.split("/")) {
		if (part === "..") return "'..' segment";
		if (part === "" || part === ".") return "empty or '.' segment";
	}
	return undefined;
}

/** Write `inputs` (sorted by name, fixed timestamps, normalized modes) as a ZIP file. */
export function writeZip(path: string, inputs: ZipInput[]): void {
	const sorted = [...inputs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	if (sorted.length > MAX16 - 1) throw new Error(`zip: ${sorted.length} entries need ZIP64, which is not supported`);
	const fd = openSync(path, "w");
	const central: Buffer[] = [];
	let offset = 0;
	const put = (buf: Uint8Array) => {
		writeSync(fd, buf);
		offset += buf.length;
	};
	try {
		const seen = new Set<string>();
		for (const input of sorted) {
			const dir = !!input.dir;
			const name = dir && !input.name.endsWith("/") ? `${input.name}/` : input.name;
			const bad = unsafeName(name);
			if (bad) throw new Error(`zip: ${bad}: ${name}`);
			if (seen.has(name)) throw new Error(`zip: duplicate entry: ${name}`);
			seen.add(name);
			const raw = dir ? new Uint8Array() : (input.data ?? new Uint8Array());
			const deflated = raw.length ? deflateRawSync(raw, { level: 9 }) : raw;
			const method = deflated.length < raw.length ? 8 : 0;
			const body = method === 8 ? deflated : raw;
			if (raw.length > MAX32 - 1 || offset > MAX32 - 1) throw new Error("zip: archive needs ZIP64, which is not supported");
			const crc = raw.length ? crc32(raw) >>> 0 : 0;
			const nameBytes = Buffer.from(name, "utf8");
			const local = Buffer.alloc(30);
			local.writeUInt32LE(0x04034b50, 0);
			local.writeUInt16LE(20, 4);
			local.writeUInt16LE(0x0800, 6); // UTF-8 names
			local.writeUInt16LE(method, 8);
			local.writeUInt16LE(0, 10);
			local.writeUInt16LE(DOS_DATE_1980, 12);
			local.writeUInt32LE(crc, 14);
			local.writeUInt32LE(body.length, 18);
			local.writeUInt32LE(raw.length, 22);
			local.writeUInt16LE(nameBytes.length, 26);
			local.writeUInt16LE(0, 28);
			const mode = (dir ? S_IFDIR : S_IFREG) | normalizeMode(input.mode, dir);
			const cd = Buffer.alloc(46);
			cd.writeUInt32LE(0x02014b50, 0);
			cd.writeUInt16LE(MADE_BY_UNIX, 4);
			cd.writeUInt16LE(20, 6);
			cd.writeUInt16LE(0x0800, 8);
			cd.writeUInt16LE(method, 10);
			cd.writeUInt16LE(0, 12);
			cd.writeUInt16LE(DOS_DATE_1980, 14);
			cd.writeUInt32LE(crc, 16);
			cd.writeUInt32LE(body.length, 20);
			cd.writeUInt32LE(raw.length, 24);
			cd.writeUInt16LE(nameBytes.length, 28);
			cd.writeUInt32LE(((mode << 16) | (dir ? 0x10 : 0)) >>> 0, 38);
			cd.writeUInt32LE(offset, 42);
			central.push(cd, nameBytes);
			put(local);
			put(nameBytes);
			put(body);
		}
		const cdStart = offset;
		for (const part of central) put(part);
		const end = Buffer.alloc(22);
		end.writeUInt32LE(0x06054b50, 0);
		end.writeUInt16LE(sorted.length, 8);
		end.writeUInt16LE(sorted.length, 10);
		end.writeUInt32LE(offset - cdStart, 12);
		end.writeUInt32LE(cdStart, 16);
		put(end);
	} finally {
		closeSync(fd);
	}
}

/**
 * Parse and validate the central directory. Throws on unsafe artifact entries: absolute
 * paths, `..`, backslashes, duplicate (also case-folded) names, symlinks, hard links or special files,
 * encryption, ZIP64, and unknown compression methods.
 */
export function readZipEntries(buf: Buffer): ZipEntry[] {
	let eocd = -1;
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - MAX16); i--) {
		if (buf.readUInt32LE(i) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new Error("zip: end of central directory not found");
	const count = buf.readUInt16LE(eocd + 10);
	let at = buf.readUInt32LE(eocd + 16);
	if (count === MAX16 || at === MAX32) throw new Error("zip: ZIP64 archives are not supported");
	const entries: ZipEntry[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < count; i++) {
		if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw new Error("zip: corrupt central directory");
		const madeBy = buf.readUInt16LE(at + 4) >> 8;
		const flags = buf.readUInt16LE(at + 8);
		const method = buf.readUInt16LE(at + 10);
		const crc = buf.readUInt32LE(at + 16);
		const csize = buf.readUInt32LE(at + 20);
		const size = buf.readUInt32LE(at + 24);
		const nameLen = buf.readUInt16LE(at + 28);
		const extraLen = buf.readUInt16LE(at + 30);
		const commentLen = buf.readUInt16LE(at + 32);
		const external = buf.readUInt32LE(at + 38);
		const offset = buf.readUInt32LE(at + 42);
		const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
		at += 46 + nameLen + extraLen + commentLen;
		const bad = unsafeName(name);
		if (bad) throw new Error(`zip: unsafe entry (${bad}): ${name}`);
		if (flags & 1) throw new Error(`zip: encrypted entry: ${name}`);
		if (method !== 0 && method !== 8) throw new Error(`zip: unsupported compression ${method}: ${name}`);
		if (csize === MAX32 || size === MAX32 || offset === MAX32) throw new Error(`zip: ZIP64 entry: ${name}`);
		const dir = name.endsWith("/");
		let mode = dir ? 0o755 : 0o644;
		if (madeBy === 3) {
			const unix = external >>> 16;
			const type = unix & S_IFMT;
			if (type !== 0 && type !== (dir ? S_IFDIR : S_IFREG)) {
				throw new Error(`zip: ${type === 0o120000 ? "symlink" : "special file"} entry: ${name}`);
			}
			mode = normalizeMode(unix, dir);
		}
		const key = (dir ? name.slice(0, -1) : name).toLowerCase();
		if (seen.has(key)) throw new Error(`zip: duplicate entry: ${name}`);
		seen.add(key);
		entries.push({ name, dir, mode, method, crc, size, csize, offset });
	}
	return entries;
}

function entryData(buf: Buffer, e: ZipEntry): Buffer {
	if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== 0x04034b50) throw new Error(`zip: bad local header: ${e.name}`);
	const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
	const body = buf.subarray(start, start + e.csize);
	if (body.length !== e.csize) throw new Error(`zip: truncated entry: ${e.name}`);
	const data = e.method === 8 ? inflateRawSync(body) : body;
	if (data.length !== e.size || (data.length ? crc32(data) >>> 0 : 0) !== e.crc) throw new Error(`zip: checksum mismatch: ${e.name}`);
	return data;
}

/**
 * Extract `archive` under `dest`, a staging directory the caller owns and removes on failure. Every entry
 * name is validated before the first write, so nothing is ever created outside `dest`; per-entry CRCs are
 * checked as each file is written.
 */
export function extractZip(archive: string, dest: string): ZipEntry[] {
	const buf = readFileSync(archive);
	const entries = readZipEntries(buf);
	mkdirSync(dest, { recursive: true });
	for (const e of entries) {
		const target = join(dest, e.name);
		if (e.dir) {
			mkdirSync(target, { recursive: true });
			continue;
		}
		const data = entryData(buf, e);
		mkdirSync(dirname(target), { recursive: true });
		const fd = openSync(target, "wx", 0o600);
		try {
			writeSync(fd, data);
		} finally {
			closeSync(fd);
		}
		chmodSync(target, e.mode);
	}
	return entries;
}
