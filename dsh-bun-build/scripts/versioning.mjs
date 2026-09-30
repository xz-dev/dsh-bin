// D10 runtime/addon identities: builder SHA, never manager version; old tag families rejected.
const SHA = /^[0-9a-f]{40}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.]+)?$/;

function buildSuffix({ run, attempt, builderCommit }) {
	if (!SHA.test(builderCommit ?? "")) throw new Error(`builder commit must be a 40-char sha: ${builderCommit}`);
	if (![run, attempt].every((n) => /^[1-9][0-9]*$/.test(String(n)))) throw new Error("run and attempt must be positive integers");
	return `b${run}.${attempt}.g${builderCommit.slice(0, 8)}`;
}

export function distribution(spec) {
	if (!SHA.test(spec.upstreamCommit ?? "")) throw new Error(`upstream commit must be a 40-char sha: ${spec.upstreamCommit}`);
	const suffix = buildSuffix(spec);
	switch (spec.channel) {
		case "release": {
			if (!VERSION.test(spec.upstreamVersion ?? "")) throw new Error(`bad upstream version: ${spec.upstreamVersion}`);
			const id = `${spec.upstreamVersion}-${suffix}`;
			return { channel: "release", id, tag: `runtime-v${id}` };
		}
		case "live": {
			const id = `live-${spec.upstreamCommit.slice(0, 7)}-${suffix}`;
			return { channel: "live", id, tag: `runtime-${id}` };
		}
		default: throw new Error(`unknown channel: ${spec.channel}`);
	}
}

export function addonDistribution(spec) {
	if (!VERSION.test(spec.kitVersion ?? "")) throw new Error(`bad kit version: ${spec.kitVersion}`);
	const version = `${spec.kitVersion}-${buildSuffix(spec)}`;
	return { name: "office", version, tag: `addon-office-v${version}` };
}

export function parseTag(tag) {
	const runtime = /^runtime-(v(.+)|live-([0-9a-f]{7}))-b(\d+)\.(\d+)\.g([0-9a-f]{8})$/.exec(tag);
	if (runtime) {
		const id = `${runtime[2] ?? `live-${runtime[3]}`}-b${runtime[4]}.${runtime[5]}.g${runtime[6]}`;
		return { channel: runtime[2] ? "release" : "live", id, ...(runtime[3] ? { upstreamSha7: runtime[3] } : {}), run: +runtime[4], attempt: +runtime[5], builderSha8: runtime[6] };
	}
	const addon = /^addon-([a-z]+)-v(.+-b(\d+)\.(\d+)\.g([0-9a-f]{8}))$/.exec(tag);
	if (addon) return { channel: "addon", addon: addon[1], version: addon[2], run: +addon[3], attempt: +addon[4], builderSha8: addon[5] };
	throw new Error(`not a dsh runtime or addon tag: ${tag}`);
}

if (import.meta.main) {
	const [channel, upstreamVersion, upstreamCommit, run, attempt, builderCommit] = process.argv.slice(2);
	console.log(JSON.stringify(distribution({ channel, upstreamVersion, upstreamCommit, run, attempt, builderCommit })));
}
