// The persistent selection (design S4, version-selection "Persistent selection"):
// `$DSH_HOME/dsh-bin/selection.json` = {"schema":1,"use":"latest"|"<version>","snapshot":null|"<id>","addons":{"<name>":"<version>"}}.
// A missing file means `--use latest`. The launcher reads the same file (launcher/src/select.zig).
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./update/fsops.ts";

export type Selection = { schema: 1; use: string; snapshot: string | null; addons: Record<string, string> };

export const DEFAULT_SELECTION: Selection = { schema: 1, use: "latest", snapshot: null, addons: {} };
export const selectionPath = (home: string) => join(home, "dsh-bin", "selection.json");

export type ReadSelection = { kind: "none" } | { kind: "ok"; selection: Selection } | { kind: "invalid"; reason: string };

/** `managed`: a missing `use` is accepted (a managed install ignores it; launcher `parseSelection` agrees). */
export function readSelection(home: string, managed = false): ReadSelection {
	const path = selectionPath(home);
	if (!existsSync(path)) return { kind: "none" };
	let v: any;
	try {
		v = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return { kind: "invalid", reason: "not JSON" };
	}
	if (!v || typeof v !== "object" || Array.isArray(v)) return { kind: "invalid", reason: "not a JSON object" };
	if (v.schema !== 1) return { kind: "invalid", reason: "unsupported schema" };
	const use = typeof v.use === "string" && v.use ? v.use : managed && v.use === undefined ? "latest" : undefined;
	if (!use) return { kind: "invalid", reason: "no version" };
	const addons: Record<string, string> = {};
	if (v.addons && typeof v.addons === "object" && !Array.isArray(v.addons)) {
		for (const [k, x] of Object.entries(v.addons)) if (typeof x === "string") addons[k] = x;
	}
	return { kind: "ok", selection: { schema: 1, use, snapshot: typeof v.snapshot === "string" ? v.snapshot : null, addons } };
}

/** Replace the selection atomically (temp file and rename). */
export function writeSelection(home: string, selection: Selection) {
	const path = selectionPath(home);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileAtomic(path, `${JSON.stringify(selection, null, 2)}\n`);
}
