// Native metadata-only authentication. No manager/parent/env assertion substitutes for current token + ACL.
// Win32 contracts: GetSecurityInfo/GetAce, CreateDirectoryW, CreateFileW OPEN_REPARSE_POINT,
// FILE_ID_INFO and GetVolumeInformationByHandleW (Microsoft Learn). See native gated tests.
import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

const fail = (): never => { throw Object.assign(new Error("dsh: configuration path violates selected configuration boundary"), { code: "DSH_CONFIG_BOUNDARY" }); };
const wide = (s: string) => Buffer.from(`${s}\0`, "utf16le");
const pointer = (b: Buffer) => { const value = b.readBigUInt64LE(); if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail(); return Number(value); };
const memory = (p: number, size: number) => Buffer.from(toArrayBuffer(p, 0, size));
const validHandle = (h: bigint) => h !== 0n && h !== -1n && h !== 0xffffffffffffffffn;

function native() {
	if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch)) fail();
	const { ptr: p, u32, u64, i32 } = FFIType;
	const k = dlopen("kernel32.dll", {
		CreateFileW: { args: [p, u32, u32, p, u32, u32, p], returns: u64 },
		CreateDirectoryW: { args: [p, p], returns: i32 },
		CloseHandle: { args: [u64], returns: i32 },
		GetLastError: { args: [], returns: u32 },
		GetCurrentProcess: { args: [], returns: u64 },
		GetCurrentThread: { args: [], returns: u64 },
		GetFileType: { args: [u64], returns: u32 },
		GetFileInformationByHandle: { args: [u64, p], returns: i32 },
		GetFileInformationByHandleEx: { args: [u64, i32, p, u32], returns: i32 },
		GetVolumeInformationByHandleW: { args: [u64, p, u32, p, p, p, p, u32], returns: i32 },
		GetDriveTypeW: { args: [p], returns: u32 },
		LocalFree: { args: [p], returns: p },
	}).symbols;
	const a = dlopen("advapi32.dll", {
		OpenThreadToken: { args: [u64, u32, i32, p], returns: i32 },
		OpenProcessToken: { args: [u64, u32, p], returns: i32 },
		GetTokenInformation: { args: [u64, u32, p, u32, p], returns: i32 },
		IsValidSid: { args: [p], returns: i32 },
		GetLengthSid: { args: [p], returns: u32 },
		EqualSid: { args: [p, p], returns: i32 },
		ConvertSidToStringSidW: { args: [p, p], returns: i32 },
		ConvertStringSecurityDescriptorToSecurityDescriptorW: { args: [p, u32, p, p], returns: i32 },
		GetSecurityInfo: { args: [u64, u32, u32, p, p, p, p, p], returns: u32 },
		IsValidSecurityDescriptor: { args: [p], returns: i32 },
		GetSecurityDescriptorControl: { args: [p, p, p], returns: i32 },
		IsValidAcl: { args: [p], returns: i32 },
		GetAce: { args: [p, u32, p], returns: i32 },
	}).symbols;

	function tokenSid(token: bigint, kind: number) {
		const needed = Buffer.alloc(4);
		a.GetTokenInformation(token, kind, null, 0, ptr(needed));
		const size = needed.readUInt32LE();
		if (size < 16 || size > 65536) fail();
		const info = Buffer.alloc(size);
		if (!a.GetTokenInformation(token, kind, ptr(info), size, ptr(needed))) fail();
		const sid = pointer(info);
		if (!sid || !a.IsValidSid(sid)) fail();
		const length = a.GetLengthSid(sid);
		if (length < 8 || length > 68) fail();
		return Buffer.from(memory(sid, length));
	}
	function user(creation = false) {
		const out = Buffer.alloc(8);
		// Thread impersonation is authority when present. Fall back only for ERROR_NO_TOKEN.
		if (!a.OpenThreadToken(BigInt(k.GetCurrentThread()), 8, 1, ptr(out))) {
			if (k.GetLastError() !== 1008 || !a.OpenProcessToken(BigInt(k.GetCurrentProcess()), 8, ptr(out))) fail();
		}
		const token = out.readBigUInt64LE();
		if (!validHandle(token)) fail();
		try {
			const sid = tokenSid(token, 1); // TokenUser, authority for existing objects
			// wx files inherit DACL, but default owner comes from TokenOwner, not TokenUser.
			// Reads need not reject a token whose default owner differs; creation must.
			if (creation && !sid.equals(tokenSid(token, 4))) fail();
			return sid;
		} finally { k.CloseHandle(token); }
	}
	function open(path: string, missing = false): bigint | undefined {
		const name = wide(path);
		// READ_CONTROL + FILE_READ_ATTRIBUTES, never FILE_READ_DATA. No sensitive content opened.
		const h = BigInt(k.CreateFileW(ptr(name), 0x20080, 7, null, 3, 0x02200000, null));
		if (validHandle(h)) return h;
		if (missing && [2, 3].includes(k.GetLastError())) return undefined;
		return fail();
	}
	function identity(h: bigint, directory: boolean) {
		const info = Buffer.alloc(52), id = Buffer.alloc(24);
		if (k.GetFileType(h) !== 1 || !k.GetFileInformationByHandle(h, ptr(info)) ||
			(info.readUInt32LE(0) & 0x400) || Boolean(info.readUInt32LE(0) & 0x10) !== directory ||
			(!directory && info.readUInt32LE(40) !== 1) || !k.GetFileInformationByHandleEx(h, 18, ptr(id), id.length)) fail();
		// Volume serial + full 128-bit ID works on NTFS and ReFS. Unknown IDs fail closed.
		if (id.subarray(8).every(v => v === 0)) fail();
		return id.toString("hex");
	}
	function volume(h: bigint) {
		const flags = Buffer.alloc(4);
		if (!k.GetVolumeInformationByHandleW(h, null, 0, null, null, ptr(flags), null, 0) || !(flags.readUInt32LE() & 8)) fail(); // FILE_PERSISTENT_ACLS
	}
	function acl(h: bigint, sid: Buffer, directory: boolean) {
		const owner = Buffer.alloc(8), dacl = Buffer.alloc(8), sd = Buffer.alloc(8);
		if (a.GetSecurityInfo(h, 1, 5, ptr(owner), null, ptr(dacl), null, ptr(sd)) !== 0) fail();
		const descriptor = pointer(sd);
		try {
			const o = pointer(owner), d = pointer(dacl), control = Buffer.alloc(2), revision = Buffer.alloc(4);
			if (!descriptor || !a.IsValidSecurityDescriptor(descriptor) || !o || !a.IsValidSid(o) || !a.EqualSid(o, ptr(sid)) ||
				!d || !a.IsValidAcl(d) || !a.GetSecurityDescriptorControl(descriptor, ptr(control), ptr(revision))) fail();
			const bits = control.readUInt16LE();
			if (!(bits & 4) || (directory && !(bits & 0x1000))) fail(); // present, protected directories
			const header = memory(d, 8), size = header.readUInt16LE(2), count = header.readUInt16LE(4);
			if (size < 8 || !count || count > (size - 8) / 16) fail();
			let inherit = false;
			for (let i = 0; i < count; i++) {
				const out = Buffer.alloc(8);
				if (!a.GetAce(d, i, ptr(out))) fail();
				const address = pointer(out);
				if (address < d + 8 || address + 8 > d + size) fail();
				const ace = memory(address, 8), length = ace.readUInt16LE(2), mask = ace.readUInt32LE(4);
				// Only ordinary current-user allow ACEs. Reject callback/object/deny/unknown ACE semantics,
				// inherit-only/no-propagate/public future grants too; no effective-access approximation.
				if (ace[0] !== 0 || (ace[1] & ~0x13) || length < 16 || address + length > d + size || !mask || (mask & ~0x1f01ff)) fail();
				const sidHeader = memory(address + 8, 8), sidLength = 8 + 4 * sidHeader[1];
				if (sidHeader[0] !== 1 || sidHeader[1] > 15 || sidLength + 8 !== length ||
					!a.IsValidSid(address + 8) || a.GetLengthSid(address + 8) !== sidLength || !a.EqualSid(address + 8, ptr(sid))) fail();
				if ((ace[1] & 3) === 3 && (mask & 0x1f01ff) === 0x1f01ff) inherit = true;
			}
			// Every future file/lock/temp and nested directory must inherit full current-user-only access.
			if (directory && !inherit) fail();
		} finally { if (descriptor) k.LocalFree(descriptor); }
	}
	function createDirectory(path: string, sid: Buffer) {
		const text = Buffer.alloc(8), sd = Buffer.alloc(8);
		if (!a.ConvertSidToStringSidW(ptr(sid), ptr(text))) fail();
		try {
			const address = pointer(text); let length = 0;
			for (; length < 368; length += 2) if (memory(address + length, 2).readUInt16LE() === 0) break;
			if (length === 368) fail();
			const name = memory(address, length).toString("utf16le");
			const sddl = wide(`O:${name}D:P(A;OICI;FA;;;${name})`);
			if (!a.ConvertStringSecurityDescriptorToSecurityDescriptorW(ptr(sddl), 1, ptr(sd), null)) fail();
			const sa = Buffer.alloc(24); // SECURITY_ATTRIBUTES on supported 64-bit Windows targets
			sa.writeUInt32LE(24); sa.writeBigUInt64LE(sd.readBigUInt64LE(), 8);
			const pathW = wide(path);
			if (!k.CreateDirectoryW(ptr(pathW), ptr(sa))) fail(); // no repair/adoption of racing existing objects
		} finally { if (pointer(sd)) k.LocalFree(pointer(sd)); if (pointer(text)) k.LocalFree(pointer(text)); }
	}
	return { user, open, identity, volume, acl, createDirectory, close: (h: bigint) => k.CloseHandle(h), drive: (root: string) => k.GetDriveTypeW(ptr(wide(root))) };
}
let api: ReturnType<typeof native> | undefined;

/** Selected root is authenticated on construction and pinned by generation, not a cached ACL proof.
 * Each check rereads effective token, each object's ACL and opened/named IDs before returning to upstream.
 * Final path check → upstream syscall race remains; these checks do not replace upstream writer locks.
 */
export function createWindowsPrivateAccess(config: string) {
	const n = api ??= native(), root = resolve(config), drive = parse(root).root;
	// Local DOS paths only. Reject UNC/device/ADS/trailing-dot aliases before Win32 normalization.
	function parts(path: string) {
		if (!/^[a-z]:\\$/i.test(parse(path).root) || /[\0:]/.test(path.slice(2))) fail();
		const values = path.slice(parse(path).root.length).split(sep).filter(Boolean);
		if (values.some(v => /[\x00-\x1f<>"|?*]|[. ]$/.test(v) || /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(v))) fail();
		return values;
	}
	const rootParts = parts(root);
	if (!rootParts.length || ![2, 3].includes(n.drive(drive))) fail(); // no unverifiable network ACLs
	let pinned: string | undefined;
	function check(path: string, parents = false, directory = false, creation = false) {
		path = resolve(path); parts(path);
		const rel = relative(root, path);
		if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || (!rel && !directory)) fail();
		const sid = n.user(creation), chain: { path: string; h: bigint; id: string; directory: boolean; private: boolean }[] = [];
		try {
			let current = drive;
			const all = [...rootParts, ...rel.split(sep).filter(Boolean)];
			// Inspect drive and every named ancestor no-follow; outside-C ACLs need not be private.
			for (let i = -1; i < all.length; i++) {
				if (i >= 0) current = join(current, all[i]);
				const dir = i < all.length - 1 || directory, privateNode = i >= rootParts.length - 1;
				let h = n.open(current, i >= rootParts.length);
				if (h === undefined) {
					if (parents && dir) { n.createDirectory(current, sid); h = n.open(current); }
					else break; // deepest existing parent already proves creation-time inherited privacy
				}
				if (h === undefined) fail();
				const item = { path: current, h, id: "", directory: dir, private: privateNode }; chain.push(item);
				item.id = n.identity(h, dir);
				if (i === rootParts.length - 1) {
					n.volume(h);
					if (pinned !== undefined && pinned !== item.id) fail();
					pinned ??= item.id;
				}
				if (privateNode) n.acl(h, sid, dir);
			}
			// Reopen every component, including root, to reject replacement during inspection.
			for (const item of chain) {
				const h = n.open(item.path);
				if (h === undefined) fail();
				try {
					if (n.identity(h, item.directory) !== item.id) fail();
					if (item.private) n.acl(h, sid, item.directory);
				} finally { n.close(h); }
			}
			if (!sid.equals(n.user(creation))) fail();
			return path;
		} finally { for (const item of chain) n.close(item.h); }
	}
	check(root, false, true); // fail before ready, including an empty selected snapshot
	return { check: (path: string, parents = false) => check(path, parents),
		checkCreation: (path: string, parents = false) => check(path, parents, false, true) };
}
