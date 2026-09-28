// Resolve a channel input to an exact upstream commit and check it out (GitHub only).
// usage: bun scripts/fetch-upstream.mjs <dsh-v*-tag|master> <dest-dir>
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const UPSTREAM = "https://github.com/deepseek-ai/deepseek-harness";

const git = (args, opts = {}) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts }).trim();

/** Resolve `master` or a `dsh-v*` tag to {commit, tag?} via git ls-remote (no REST API). */
export function resolveRef(ref, url = UPSTREAM) {
	if (ref === "master") {
		const out = git(["ls-remote", url, "refs/heads/master"]);
		const commit = out.split(/\s+/)[0];
		if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`cannot resolve master: ${out}`);
		return { commit };
	}
	if (!/^dsh-v[0-9A-Za-z.+-]+$/.test(ref)) throw new Error(`channel input must be master or a dsh-v* tag: ${ref}`);
	// Peeled (^{}) line gives the commit for annotated tags.
	const lines = git(["ls-remote", url, `refs/tags/${ref}`, `refs/tags/${ref}^{}`]).split("\n").filter(Boolean);
	const map = Object.fromEntries(lines.map((l) => l.split(/\s+/).reverse()));
	const commit = map[`refs/tags/${ref}^{}`] ?? map[`refs/tags/${ref}`];
	if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error(`tag not found upstream: ${ref}`);
	return { commit, tag: ref };
}

/** Shallow-fetch exactly `commit` into dest and verify HEAD. */
export function checkout(commit, dest, url = UPSTREAM) {
	if (!existsSync(join(dest, ".git"))) {
		mkdirSync(dest, { recursive: true });
		git(["init", "-q", dest]);
	}
	git(["-C", dest, "fetch", "-q", "--depth=1", url, commit]);
	git(["-C", dest, "-c", "advice.detachedHead=false", "checkout", "-q", "--force", "FETCH_HEAD"]);
	const head = git(["-C", dest, "rev-parse", "HEAD"]);
	if (head !== commit) throw new Error(`checkout mismatch: ${head} != ${commit}`);
	return head;
}

if (import.meta.main) {
	const [ref, dest] = process.argv.slice(2);
	if (!ref) throw new Error("usage: fetch-upstream.mjs <dsh-v*-tag|master> [dest]");
	const resolved = resolveRef(ref);
	if (dest) {
		checkout(resolved.commit, dest);
		writeFileSync(join(dest, ".dsh-bin-upstream.json"), `${JSON.stringify(resolved)}\n`);
	}
	console.log(JSON.stringify(resolved));
}
