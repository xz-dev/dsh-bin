// Publish one immutable GitHub Release (8.3), ported from xz-dev/pi publish-github-release.mjs:
// create or resume a draft → upload only missing assets → re-hash every asset → publish → poll until
// GitHub reports `immutable: true`. GitHub's Latest is the release channel: a release-channel bundle is
// published with make_latest=true (the poll publishes in index `seq` order, so Latest is what
// `dsh update --channel release` installs); live and addon releases use make_latest=false. Discovery
// still reads only the index, never Latest. An already-published release with identical assets is a no-op.
// Publishing-side only: the updater never calls the GitHub API.
// usage: bun scripts/publish-release.mjs <manifest.json>   (release-manifest.json or addon-manifest.json)
//   env: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const API_VERSION = "2022-11-28";
const fail = (m) => {
	throw new Error(m);
};

/** Asset file paths of a bundle release manifest (`targets`) or addon manifest (`assets`), plus metadata files. */
export function assetPaths(manifestPath, manifest) {
	const dir = dirname(manifestPath);
	const files = Object.values(manifest.targets ?? manifest.assets ?? {}).map((a) => a.file);
	if (!files.length) fail("manifest lists no assets");
	const extra = manifest.targets ? ["release-manifest.json", "SHA256SUMS"] : ["addon-manifest.json"];
	return [...files, ...extra].map((f) => join(dir, f));
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

export async function publishRelease(manifestPath, env = process.env, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
	const token = env.GITHUB_TOKEN || env.GH_TOKEN || fail("GITHUB_TOKEN is required");
	const repository = env.GITHUB_REPOSITORY || fail("GITHUB_REPOSITORY is required");
	const commit = (env.GITHUB_SHA || fail("GITHUB_SHA is required")).toLowerCase();
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (!/^dsh-(v|live-|addon-office-v)/.test(manifest.tag ?? "")) fail(`not a dsh-bin tag: ${manifest.tag}`);
	const paths = assetPaths(manifestPath, manifest);
	const expected = new Map(paths.map((p) => [basename(p), sha256(readFileSync(p))]));
	const api = `https://api.github.com/repos/${repository}`;
	const headers = (extra = {}) => ({ Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "dsh-bin-release", "X-GitHub-Api-Version": API_VERSION, ...extra });
	const req = async (url, opts, ok = [200]) => {
		const r = await fetchImpl(url, { ...opts, headers: headers(opts?.headers) });
		if (!ok.includes(r.status)) fail(`GitHub API ${opts?.method ?? "GET"} ${url} failed (${r.status}): ${(await r.text()).slice(0, 2000)}`);
		return r;
	};
	const json = async (url, opts, ok) => (await req(url, opts, ok)).json();

	const findRelease = async () => {
		const byTag = await fetchImpl(`${api}/releases/tags/${encodeURIComponent(manifest.tag)}`, { headers: headers() });
		if (byTag.ok) return byTag.json();
		if (byTag.status !== 404) fail(`release lookup failed (${byTag.status})`);
		// Drafts are not returned by the tag endpoint; list to resume an interrupted draft.
		for (let page = 1; page <= 100; page++) {
			const list = await json(`${api}/releases?per_page=100&page=${page}`);
			const hit = list.find((r) => r.tag_name === manifest.tag);
			if (hit) return hit;
			if (list.length < 100) return undefined;
		}
	};
	const checkAssets = async (release, allowSubset) => {
		const names = new Set();
		for (const a of release.assets ?? []) {
			if (!expected.has(a.name)) fail(`release ${manifest.tag} has unexpected asset ${a.name}`);
			const digest = a.digest?.startsWith("sha256:") ? a.digest.slice(7) : sha256(Buffer.from(await (await req(a.url, { headers: { Accept: "application/octet-stream" } })).arrayBuffer()));
			if (digest !== expected.get(a.name)) fail(`release asset ${a.name} sha256 mismatch`);
			names.add(a.name);
		}
		if (!allowSubset && names.size !== expected.size) fail(`release ${manifest.tag} has an incomplete asset set`);
		return names;
	};
	const assertIdentity = (r) => {
		if (r.tag_name !== manifest.tag) fail(`release tag ${r.tag_name} is not ${manifest.tag}`);
		if (r.target_commitish !== commit) fail(`release ${manifest.tag} targets ${r.target_commitish}, expected ${commit}`);
	};

	// Refuse before any mutation when the repository would publish a mutable release. A 403/404 (token
	// cannot read the setting) falls through to the post-publish `immutable` poll.
	const setting = await fetchImpl(`${api}/immutable-releases`, { headers: headers() });
	if (setting.ok && (await setting.json()).enabled === false) fail(`release immutability is disabled for ${repository}; refusing to publish ${manifest.tag}`);
	let release = await findRelease();
	if (release && !release.draft) {
		assertIdentity(release);
		await checkAssets(release, false);
		if (!release.immutable) fail(`published release ${manifest.tag} is not immutable; enable release immutability for ${repository}`);
		console.log(`${manifest.tag} is already published with identical assets`);
		return { published: false, release };
	}
	release ??= await json(`${api}/releases`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tag_name: manifest.tag, target_commitish: commit, name: manifest.tag, body: `dsh-bin ${manifest.version}. Verify with SHA256SUMS and GitHub artifact attestations.`, draft: true, prerelease: false }) }, [201]);
	assertIdentity(release);
	const present = await checkAssets(release, true);
	for (const p of paths) {
		if (present.has(basename(p))) continue;
		await req(`${release.upload_url.replace(/\{.*$/, "")}?name=${encodeURIComponent(basename(p))}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: readFileSync(p) }, [201]);
	}
	release = await json(`${api}/releases/${release.id}`);
	if (!release.draft) fail(`release ${manifest.tag} is no longer a draft before publication`);
	await checkAssets(release, false);
	release = await json(`${api}/releases/${release.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draft: false, prerelease: false, make_latest: String(manifest.channel === "release") }) });
	for (let i = 0; i < 60 && !release.immutable; i++) {
		await sleep(5000);
		release = await json(`${api}/releases/${release.id}`);
	}
	if (!release.immutable) fail(`release ${manifest.tag} did not become immutable; is release immutability enabled for ${repository}?`);
	await checkAssets(release, false);
	console.log(`Published ${manifest.tag} (immutable, ${manifest.channel === "release" ? "latest" : "not latest"})`);
	return { published: true, release };
}

if (import.meta.main) {
	const [manifest] = process.argv.slice(2);
	if (!manifest) throw new Error("usage: publish-release.mjs <manifest.json>");
	await publishRelease(resolve(manifest));
}
