// Deterministic ZIP of an assembled install root (6.2): entries sorted by path, fixed timestamps,
// modes normalized to 0755/0644, no symlinks or special files. Two runs over the same tree give
// byte-identical archives on every OS, so no 7z central-directory normalization is needed.
// usage: bun scripts/archive.mjs <root-dir> <out.zip>
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { writeZip } from "../runtime/zip.ts";

/** Every directory and file under `root` as ZIP inputs; throws on symlinks and special files. */
export function collect(root) {
	const out = [];
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			const rel = relative(root, path).split(sep).join("/");
			const st = lstatSync(path);
			if (st.isSymbolicLink()) throw new Error(`archive: symlink not allowed: ${rel}`);
			if (st.isDirectory()) {
				out.push({ name: rel, dir: true, mode: 0o755 });
				walk(path);
			} else if (st.isFile()) out.push({ name: rel, data: readFileSync(path), mode: st.mode });
			else throw new Error(`archive: special file not allowed: ${rel}`);
		}
	};
	walk(root);
	return out;
}

export function archive(root, outFile) {
	const inputs = collect(root);
	writeZip(outFile, inputs);
	return inputs.length;
}

if (import.meta.main) {
	const [root, out] = process.argv.slice(2);
	if (!root || !out) throw new Error("usage: archive.mjs <root-dir> <out.zip>");
	console.log(`${out}: ${archive(root, out)} entries`);
}
