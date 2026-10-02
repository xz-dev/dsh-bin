// Manager-only release packaging and index writer. No runtime source/build dependency.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32 } from "node:zlib";

export const TARGETS = { "linux-x64": "x86_64-linux", "linux-arm64": "aarch64-linux", "darwin-x64": "x86_64-macos", "darwin-arm64": "aarch64-macos", "windows-x64": "x86_64-windows", "windows-arm64": "aarch64-windows" };
export const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function version(v) { if (typeof v !== "string" || !SEMVER.test(v)) throw new Error(`invalid manager SemVer: ${v}`); return v; }

function binary(bytes, target, v) {
	const [os, arch] = target.split("-");
	let valid = false;
	if (bytes.length >= 64) {
		if (os === "linux") valid = bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) && bytes[4] === 2 && bytes[5] === 1 && [2, 3].includes(bytes.readUInt16LE(16)) && bytes.readUInt16LE(18) === (arch === "x64" ? 62 : 183);
		if (os === "darwin") valid = bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(4) === (arch === "x64" ? 0x01000007 : 0x0100000c) && bytes.readUInt32LE(12) === 2;
		if (os === "windows") { const p = bytes.readUInt32LE(60); valid = bytes.toString("ascii", 0, 2) === "MZ" && p <= bytes.length - 26 && bytes.toString("ascii", p, p + 4) === "PE\0\0" && bytes.readUInt16LE(p + 4) === (arch === "x64" ? 0x8664 : 0xaa64) && bytes.readUInt16LE(p + 24) === 0x20b; }
	}
	if (!valid) throw new Error(`invalid native manager: ${target}`);
	for (const [key, value] of [["DSH_MANAGER_VERSION=", v], ["DSH_MANAGER_LAUNCH_PROTOCOL=", "1"]]) {
		const prefix = Buffer.from(key), marker = Buffer.from(`${key}${value}\0`), at = bytes.indexOf(prefix);
		if (at < 0 || bytes.indexOf(prefix, at + 1) >= 0 || !bytes.subarray(at, at + marker.length).equals(marker)) throw new Error(`invalid/ambiguous ${key}`);
	}
}

// Single stored ZIP entry: no compression, directory entries, links, timestamps or external zip tools.
export function managerZip(bytes, target, v) {
	binary(bytes, target, version(v));
	const name = Buffer.from(target.startsWith("windows-") ? "dsh.exe" : "dsh"), crc = crc32(bytes);
	const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
	local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(33, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
	central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(33, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE((0o100755 << 16) >>> 0, 38);
	end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + bytes.length, 16);
	return Buffer.concat([local, name, bytes, central, name, end]);
}
export function verifyZip(zip, target, v) {
	const name = target.startsWith("windows-") ? "dsh.exe" : "dsh";
	if (zip.length < 98 || zip.readUInt32LE(0) !== 0x04034b50) throw new Error("invalid manager ZIP");
	const n = zip.readUInt16LE(26), size = zip.readUInt32LE(22), data = zip.subarray(30 + n, 30 + n + size);
	// Re-encode to verify the complete central directory, CRC, modes and exact single-entry layout.
	if (zip.toString("utf8", 30, 30 + n) !== name || !managerZip(data, target, v).equals(zip)) throw new Error("invalid manager ZIP layout");
	return data;
}
export function emptyIndex() { return { schema: 1, versions: [] }; }
export function appendManager(index, entry) {
	if (index.schema !== 1 || !Array.isArray(index.versions)) throw new Error("invalid manager index");
	version(entry.version);
	if (entry.kind !== "dsh-manager" || entry.tag !== `manager-v${entry.version}` || JSON.stringify(entry.launchProtocols) !== "[1]") throw new Error("invalid manager identity/protocol");
	if (Object.keys(entry.assets).sort().join() !== Object.keys(TARGETS).sort().join()) throw new Error("expected all six manager targets");
	for (const [t, a] of Object.entries(entry.assets)) if (a.name !== `manager-${t}.zip` || !Number.isSafeInteger(a.size) || a.size <= 0 || !/^[0-9a-f]{64}$/.test(a.sha256)) throw new Error(`invalid manager asset: ${t}`);
	const next = { version: entry.version, tag: entry.tag, launchProtocols: entry.launchProtocols, assets: entry.assets };
	const existing = index.versions.find((e) => { version(e.version); return Bun.semver.order(e.version, entry.version) === 0; });
	if (existing) { if (JSON.stringify(existing) !== JSON.stringify(next)) throw new Error("manager version already published with different content"); return existing; }
	index.versions.push(next); return next;
}
export function aggregate(dir, v) {
	version(v);
	const assets = Object.fromEntries(Object.keys(TARGETS).map((t) => {
		const name = `manager-${t}.zip`, bytes = readFileSync(join(dir, name)); verifyZip(bytes, t, v);
		return [t, { name, size: bytes.length, sha256: sha256(bytes) }];
	}));
	const m = { kind: "dsh-manager", version: v, tag: `manager-v${v}`, launchProtocols: [1], assets };
	writeFileSync(join(dir, "manager-manifest.json"), `${JSON.stringify(m, null, 2)}\n`);
	writeFileSync(join(dir, "SHA256SUMS"), Object.values(assets).map((a) => `${a.sha256}  ${a.name}\n`).join(""));
	const index = emptyIndex(); appendManager(index, m); writeFileSync(join(dir, "manager-index.json"), `${JSON.stringify(index, null, 2)}\n`); return m;
}
if (import.meta.main) {
	const [cmd, ...args] = process.argv.slice(2);
	if (cmd === "version") console.log(version(args[0]));
	else if (cmd === "package") { const [file, target, v, out] = args; mkdirSync(out, { recursive: true }); const zip = managerZip(readFileSync(file), target, v); verifyZip(zip, target, v); writeFileSync(join(out, `manager-${target}.zip`), zip); }
	else if (cmd === "aggregate") console.log(aggregate(...args).tag);
	else if (cmd === "append") { const [path, manifest] = args; const i = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : emptyIndex(); appendManager(i, JSON.parse(readFileSync(manifest, "utf8"))); writeFileSync(path, `${JSON.stringify(i, null, 2)}\n`); }
	else throw new Error("usage: release.mjs version V | package executable target V out | aggregate dir V | append index manifest");
}
