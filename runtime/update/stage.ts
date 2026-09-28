// Download, verify and stage one release asset (self-update spec "Verification before activation"):
// SHA-256 and size against the index, then a validating extraction into a staging directory the caller
// owns. Nothing outside staging is touched until the caller activates.
import { join } from "node:path";
import type { AssetRef } from "../layout.ts";
import { extractZip, type ZipEntry } from "../zip.ts";
import { UserError } from "./context.ts";
import { downloadAsset } from "./index-client.ts";

export async function fetchAndExtract(tag: string, asset: AssetRef, staging: string, log: (line: string) => void) {
	const zip = join(staging, "asset.zip");
	await downloadAsset(tag, asset, zip, log);
	const tree = join(staging, "tree");
	let entries: ZipEntry[];
	try {
		entries = extractZip(zip, tree);
	} catch (error) {
		throw new UserError(`invalid archive ${asset.name}: ${(error as Error).message}`);
	}
	return { tree, entries };
}

/** Fail unless every entry lies under one of `roots` (exact file names or `dir/` prefixes). */
export function checkRoots(entries: ZipEntry[], roots: string[], what: string) {
	for (const e of entries) {
		const name = e.name.replace(/\/$/, "");
		const ok = roots.some((r) => (r.endsWith("/") ? name === r.slice(0, -1) || name.startsWith(r) : name === r));
		if (!ok) throw new UserError(`invalid ${what}: unexpected entry ${e.name}`);
	}
}

export function mismatch(what: string, field: string, expected: unknown, actual: unknown): never {
	throw new UserError(`${what} metadata does not match the index: ${field} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}
