// Office addon slot (D7b): the upstream first-parent commit that introduced the LibreOffice Kit
// version locked at a given commit. Builds share a slot until the next kit change (a switch back
// to an earlier version opens a new slot). Needs history, not blobs of every file: blob-less clone.
// usage: bun scripts/addon-slot.mjs <git-dir> <commit>
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { UPSTREAM } from "./fetch-upstream.mjs";

const LOCK = "pnpm-lock.yaml";
// `packages:` key; lockfile v6 prefixes keys with `/`.
const KIT_KEY = /^ {2}'?\/?@deepseek-ai\/libreoffice-kit@([^'():\s]+)'?:/m;
// Blobs are fetched lazily from the promisor remote. With the commit-graph enabled, git 2.49 (the pinned
// Alpine images) refuses that fetch as "in the commit graph file but not in the object database".
const GIT = (gitDir) => ["-c", "core.commitGraph=false", "--git-dir", gitDir];

const git = (gitDir, args, input) =>
	execFileSync("git", [...GIT(gitDir), ...args], { encoding: "utf8", input, maxBuffer: 1 << 30, stdio: ["pipe", "pipe", "inherit"] });

/** Kit version in a lockfile text (the `packages:` key), or null when the kit is not locked. */
export const kitVersionOf = (lockText) => lockText.match(KIT_KEY)?.[1] ?? null;

/** Lockfile kit versions for `commits`, read in one `cat-file --batch` pass. */
function kitVersions(gitDir, commits) {
	const out = execFileSync("git", [...GIT(gitDir), "cat-file", "--batch"], {
		input: commits.map((c) => `${c}:${LOCK}\n`).join(""),
		maxBuffer: 2 ** 32,
	});
	const versions = [];
	let at = 0;
	for (const _ of commits) {
		const nl = out.indexOf(10, at);
		const header = out.toString("utf8", at, nl);
		if (header.endsWith(" missing")) {
			versions.push(null);
			at = nl + 1;
			continue;
		}
		const size = Number(header.split(" ")[2]);
		versions.push(kitVersionOf(out.toString("utf8", nl + 1, nl + 1 + size)));
		at = nl + 1 + size + 1;
	}
	return versions;
}

/**
 * @returns {{commit: string, kitVersion: string} | null} the slot of `commit`, or null when no kit is locked there
 */
export function addonSlot(gitDir, commit, batch = 256) {
	const history = git(gitDir, ["log", "--first-parent", "--format=%H", commit, "--", LOCK]).split("\n").filter(Boolean);
	const [kitVersion] = kitVersions(gitDir, [commit]);
	if (kitVersion === null) return null;
	let slot = history[0];
	for (let i = 0; i < history.length; i += batch) {
		const chunk = history.slice(i, i + batch);
		const versions = kitVersions(gitDir, chunk);
		const stop = versions.findIndex((v) => v !== kitVersion);
		if (stop >= 0) return { commit: stop === 0 ? slot : chunk[stop - 1], kitVersion };
		slot = chunk.at(-1);
	}
	return { commit: slot, kitVersion };
}

/** Blob-less bare clone of upstream (created or refreshed) that contains `commit`. */
export function ensureHistory(gitDir, commit, url = UPSTREAM) {
	if (!existsSync(gitDir)) execFileSync("git", ["clone", "-q", "--bare", "--filter=blob:none", url, gitDir], { stdio: "inherit" });
	try {
		git(gitDir, ["cat-file", "-e", `${commit}^{commit}`]);
	} catch {
		git(gitDir, ["fetch", "-q", "--filter=blob:none", url, commit]);
	}
	return gitDir;
}

if (import.meta.main) {
	const [gitDir, commit] = process.argv.slice(2);
	if (!gitDir || !commit) throw new Error("usage: addon-slot.mjs <git-dir> <commit>");
	console.log(JSON.stringify(addonSlot(ensureHistory(gitDir, commit), commit)));
}
