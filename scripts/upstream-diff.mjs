// upstream-poll detection (release-distribution "Upstream tracking", D7): compare `git ls-remote` of
// upstream `refs/heads/master` + `refs/tags/dsh-v*` with the `releases` branch index.json — the only
// state. Returns the builds to dispatch: every unpublished tag from dsh-v0.1.7-rc.2 onward in version
// order, then one live build for the observed master if the newest live entry is on another commit.
// Office addon builds (D7b) are dispatched first for any build whose slot has no addon entry.
// usage: git ls-remote <upstream> refs/heads/master 'refs/tags/dsh-v*' | bun scripts/upstream-diff.mjs <index.json> [--git-dir d]
import { existsSync, readFileSync } from "node:fs";

export const FIRST_RELEASE = "0.1.7-rc.2";

/** Parse `git ls-remote` output: peeled `^{}` lines win for annotated tags. */
export function parseLsRemote(text) {
	const tags = new Map();
	let master;
	for (const line of text.split("\n")) {
		const [sha, ref] = line.trim().split(/\s+/);
		if (!sha || !ref) continue;
		if (ref === "refs/heads/master") master = sha;
		const m = /^refs\/tags\/(dsh-v[^^]+)(\^\{\})?$/.exec(ref);
		if (m && (m[2] || !tags.has(m[1]))) tags.set(m[1], sha);
	}
	return { master, tags };
}

const parseVer = (v) => {
	const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v);
	return m ? { core: [+m[1], +m[2], +m[3]], pre: m[4]?.split(".") ?? [] } : undefined;
};

/** SemVer 2 precedence (build metadata not used by upstream tags). */
export function compareVersions(a, b) {
	const x = parseVer(a);
	const y = parseVer(b);
	if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
	for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
	if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
	for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
		const [p, q] = [x.pre[i], y.pre[i]];
		if (p === undefined) return -1;
		if (q === undefined) return 1;
		if (p === q) continue;
		const [np, nq] = [/^\d+$/.test(p), /^\d+$/.test(q)];
		if (np && nq) return +p - +q;
		if (np !== nq) return np ? -1 : 1;
		return p < q ? -1 : 1;
	}
	return 0;
}

/**
 * @param {{lsRemote: string, index: object, slotOf?: (commit: string) => ({commit,kitVersion}|null)}} input
 * @returns {{builds: {channel, commit, tag?, upstreamVersion?}[], addons: {slot, for: string}[], notices: string[]}}
 * @throws when a tag already in the index now points to a different commit
 */
export function upstreamDiff({ lsRemote, index, slotOf }) {
	const { master, tags } = parseLsRemote(lsRemote);
	const notices = [];
	const published = new Map();
	for (const e of index.channels?.release ?? []) if (e.upstream?.tag) published.set(e.upstream.tag, e.upstream.commit);

	const moved = [];
	for (const [tag, commit] of published) {
		if (!tags.has(tag)) notices.push(`upstream tag ${tag} was deleted; its release and index entry are kept`);
		else if (tags.get(tag) !== commit) moved.push(`upstream tag ${tag} moved from ${commit} to ${tags.get(tag)}; it is never rebuilt`);
	}
	if (moved.length) throw new Error(moved.join("\n"));

	const builds = [];
	const candidates = [...tags]
		.map(([tag, commit]) => ({ tag, commit, upstreamVersion: tag.slice("dsh-v".length) }))
		.filter((t) => parseVer(t.upstreamVersion) && compareVersions(t.upstreamVersion, FIRST_RELEASE) >= 0 && !published.has(t.tag))
		.sort((a, b) => compareVersions(a.upstreamVersion, b.upstreamVersion));
	for (const t of candidates) builds.push({ channel: "release", ...t });

	const live = [...(index.channels?.live ?? [])].sort((a, b) => b.seq - a.seq)[0];
	if (!master) notices.push("upstream master was not listed; no live build");
	else if (live?.upstream?.commit !== master) builds.push({ channel: "live", commit: master });

	const addons = [];
	if (slotOf) {
		const indexed = new Set((index.addons?.office ?? []).map((e) => e.slot?.commit));
		for (const b of builds) {
			const slot = slotOf(b.commit);
			b.slot = slot;
			if (slot && !indexed.has(slot.commit)) {
				indexed.add(slot.commit);
				addons.push({ slot, for: b.commit });
			}
		}
	}
	return { builds, addons, notices };
}

if (import.meta.main) {
	const [indexPath, ...rest] = process.argv.slice(2);
	if (!indexPath) throw new Error("usage: upstream-diff.mjs <index.json> [--git-dir d] < ls-remote.txt");
	const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : { channels: { release: [], live: [] }, addons: { office: [] } };
	const g = rest.indexOf("--git-dir");
	let slotOf;
	if (g >= 0) {
		const { addonSlot, ensureHistory } = await import("./addon-slot.mjs");
		const gitDir = rest[g + 1];
		slotOf = (commit) => addonSlot(ensureHistory(gitDir, commit), commit);
	}
	const r = upstreamDiff({ lsRemote: readFileSync(0, "utf8"), index, slotOf });
	for (const n of r.notices) console.error(`::notice::${n}`);
	console.log(JSON.stringify(r));
}
