// Distribution version / tag identities (spec: source-build "Channel version identities").
const SHA = /^[0-9a-f]{40}$/;
const UINT = /^[1-9][0-9]*$/;

export function distribution({ channel, upstreamVersion, upstreamCommit, run, attempt, launcherCommit }) {
	if (!SHA.test(upstreamCommit ?? "")) throw new Error(`upstream commit must be a 40-char sha: ${upstreamCommit}`);
	if (!SHA.test(launcherCommit ?? "")) throw new Error(`launcher commit must be a 40-char sha: ${launcherCommit}`);
	if (!UINT.test(String(run)) || !UINT.test(String(attempt))) throw new Error("run and attempt must be positive integers");
	const suffix = `xz.${run}.${attempt}.g${launcherCommit.slice(0, 8)}`;
	if (channel === "release") {
		if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/.test(upstreamVersion ?? "")) throw new Error(`bad upstream version: ${upstreamVersion}`);
		const version = `${upstreamVersion}-${suffix}`;
		return { channel, version, tag: `dsh-v${version}` };
	}
	if (channel === "live") {
		const short = upstreamCommit.slice(0, 7);
		return { channel, version: `live.${short}-${suffix}`, tag: `dsh-live-${short}-${suffix}` };
	}
	throw new Error(`unknown channel: ${channel}`);
}

/** Parse a tag this project created; throws for any other tag family. */
export function parseTag(tag) {
	let m = /^dsh-v(.+-xz\.(\d+)\.(\d+)\.g([0-9a-f]{8}))$/.exec(tag);
	if (m) return { channel: "release", version: m[1], run: +m[2], attempt: +m[3], launcherSha8: m[4] };
	m = /^dsh-live-([0-9a-f]{7})-(xz\.(\d+)\.(\d+)\.g([0-9a-f]{8}))$/.exec(tag);
	if (m) return { channel: "live", version: `live.${m[1]}-${m[2]}`, upstreamSha7: m[1], run: +m[3], attempt: +m[4], launcherSha8: m[5] };
	throw new Error(`not a dsh-bin tag: ${tag}`);
}

if (import.meta.main) {
	const [channel, upstreamVersion, upstreamCommit, run, attempt, launcherCommit] = process.argv.slice(2);
	console.log(JSON.stringify(distribution({ channel, upstreamVersion, upstreamCommit, run, attempt, launcherCommit })));
}
