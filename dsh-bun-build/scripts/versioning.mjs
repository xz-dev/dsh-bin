// Runtime and addon identities (split-dsh-manager D10). The tag families are new, so they never collide with
// the retired `dsh-v*` / `dsh-live-*` / `dsh-addon-*` tags, which stay in Git history.
//   release runtime  runtime-v<upstream>-b<run>.<attempt>.g<sha8>        id <upstream>-b<run>.<attempt>.g<sha8>
//   live runtime     runtime-live-<sha7>-b<run>.<attempt>.g<sha8>        id live-<sha7>-b<run>.<attempt>.g<sha8>
//   office addon     addon-office-v<kit>-b<run>.<attempt>.g<sha8>        version <kit>-b<run>.<attempt>.g<sha8>
// <sha8> is the builder commit (this repository), not a manager version.
const SHA = /^[0-9a-f]{40}$/;
const UINT = /^[1-9][0-9]*$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/;

function suffix({ run, attempt, builderCommit }) {
	if (!SHA.test(builderCommit ?? "")) throw new Error(`builder commit must be a 40-char sha: ${builderCommit}`);
	if (!UINT.test(String(run)) || !UINT.test(String(attempt))) throw new Error("run and attempt must be positive integers");
	return `b${run}.${attempt}.g${builderCommit.slice(0, 8)}`;
}

export function distribution({ channel, upstreamVersion, upstreamCommit, run, attempt, builderCommit }) {
	if (!SHA.test(upstreamCommit ?? "")) throw new Error(`upstream commit must be a 40-char sha: ${upstreamCommit}`);
	const s = suffix({ run, attempt, builderCommit });
	if (channel === "release") {
		if (!SEMVER.test(upstreamVersion ?? "")) throw new Error(`bad upstream version: ${upstreamVersion}`);
		const id = `${upstreamVersion}-${s}`;
		return { channel, id, tag: `runtime-v${id}` };
	}
	if (channel === "live") {
		const id = `live-${upstreamCommit.slice(0, 7)}-${s}`;
		return { channel, id, tag: `runtime-${id}` };
	}
	throw new Error(`unknown channel: ${channel}`);
}

export function addonDistribution({ kitVersion, run, attempt, builderCommit }) {
	if (!SEMVER.test(kitVersion ?? "")) throw new Error(`bad kit version: ${kitVersion}`);
	const version = `${kitVersion}-${suffix({ run, attempt, builderCommit })}`;
	return { name: "office", version, tag: `addon-office-v${version}` };
}

/** Parse a tag of the runtime ecosystem; throws for any other tag family (retired ones included). */
export function parseTag(tag) {
	let m = /^runtime-v(.+-b(\d+)\.(\d+)\.g([0-9a-f]{8}))$/.exec(tag);
	if (m) return { channel: "release", id: m[1], run: +m[2], attempt: +m[3], builderSha8: m[4] };
	m = /^runtime-(live-([0-9a-f]{7})-b(\d+)\.(\d+)\.g([0-9a-f]{8}))$/.exec(tag);
	if (m) return { channel: "live", id: m[1], upstreamSha7: m[2], run: +m[3], attempt: +m[4], builderSha8: m[5] };
	m = /^addon-([a-z]+)-v(.+-b(\d+)\.(\d+)\.g([0-9a-f]{8}))$/.exec(tag);
	if (m) return { channel: "addon", addon: m[1], version: m[2], run: +m[3], attempt: +m[4], builderSha8: m[5] };
	throw new Error(`not a dsh runtime or addon tag: ${tag}`);
}

if (import.meta.main) {
	const [channel, upstreamVersion, upstreamCommit, run, attempt, builderCommit] = process.argv.slice(2);
	console.log(JSON.stringify(distribution({ channel, upstreamVersion, upstreamCommit, run, attempt, builderCommit })));
}
