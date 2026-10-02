// Read-only upstream tracking: scheduled runs build the newest tag; only humans publish on main.
// usage: bun scripts/upstream-check.mjs; env GITHUB_REPOSITORY, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { UPSTREAM } from "./fetch-upstream.mjs";
import { emptyIndex, parseIndex } from "./index.mjs";

export async function upstreamCheck(refs, repository, fetchImpl = fetch) {
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) throw new Error("GITHUB_REPOSITORY must be owner/name");
	const tags = new Map();
	for (const line of refs.trim().split("\n")) {
		const [sha, ref] = line.trim().split(/\s+/);
		const match = /^refs\/tags\/(dsh-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(\^\{\})?$/.exec(ref ?? "");
		if (!match) continue;
		if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`invalid upstream commit for ${ref}`);
		if (match[2] || !tags.has(match[1])) tags.set(match[1], sha);
	}
	const upstream = [...tags.keys()].sort((a, b) => Bun.semver.order(a.slice(5), b.slice(5))).at(-1);
	if (!upstream) throw new Error("upstream has no dsh-v* release tags");
	const base = `https://raw.githubusercontent.com/${repository}/releases`;
	const read = async (name) => {
		const response = await fetchImpl(`${base}/${name}`, { redirect: "error", signal: AbortSignal.timeout(30_000) });
		if (response.status === 404) return null;
		if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
		return response.text();
	};
	const runtimeText = await read("runtime-index.json");
	const index = runtimeText === null ? emptyIndex() : parseIndex(runtimeText);
	// Published upstream tags are immutable. Refuse moved tags rather than silently rebuilding them.
	for (const entry of index.channels.release) {
		if (tags.has(entry.upstream.tag) && tags.get(entry.upstream.tag) !== entry.upstream.commit) throw new Error(`published upstream tag moved: ${entry.upstream.tag}`);
	}
	const latest = index.channels.release.at(-1);
	if (latest?.upstream.tag === upstream && latest.upstream.commit === tags.get(upstream)) return { build: false, channel: "release", upstream, index: "", digest: "" };
	const managerText = await read("manager-index.json");
	let manager = null;
	if (managerText !== null) {
		manager = JSON.parse(managerText);
		if (manager?.schema !== 1 || !Array.isArray(manager.versions) || !manager.versions.length) throw new Error("published manager index must contain accepted versions");
	}
	return { build: true, channel: "release", upstream, index: manager ? `${base}/manager-index.json` : "", digest: manager ? createHash("sha256").update(managerText).digest("hex") : "" };
}

if (import.meta.main) {
	const refs = execFileSync("git", ["ls-remote", UPSTREAM, "refs/tags/dsh-v*"], { encoding: "utf8", timeout: 30_000 });
	const plan = await upstreamCheck(refs, process.env.GITHUB_REPOSITORY);
	console.log(JSON.stringify(plan));
	if (process.env.GITHUB_OUTPUT) for (const [key, value] of Object.entries(plan)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
	const command = `gh workflow run runtime-release.yml --ref main -f channel=release -f upstream=${plan.upstream} -f publish=true -f prerelease=false${plan.index ? ` -f accepted_index=${plan.index} -f accepted_sha256=${plan.digest}` : ""}`;
	const summary = plan.build
		? `Upstream ${plan.upstream} needs a runtime dry run. No scheduled publication. After build and combination checks pass, publish manually:\n\n\`${command}\`\n\n${plan.index ? "Accepted manager index is pinned by SHA256; publish any required new addon first." : "Bootstrap: combination is skipped until an accepted manager is published. Add accepted manager inputs before publishing."}\n`
		: `Upstream ${plan.upstream} is already in runtime-index.json; no build or publication.\n`;
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}
