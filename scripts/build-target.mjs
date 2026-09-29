// Full source-to-archive build of one target on its native runner (8.1): fetch upstream by exact commit,
// pnpm from its GitHub release, frozen build + deploy, output transforms, office split, compiled entry,
// launcher, assembly, deterministic archive. The build workflow runs exactly this per matrix entry.
// usage: bun scripts/build-target.mjs <target-id> <channel> <upstream-ref|commit> <out-dir>
//          --run N --attempt N --index index.json [--work dir] [--git-dir upstream.git]
//   Writes <out>/<tag>-<asset>, <out>/<tag>.<target>.json (release manifest) and, for the linux-x64-modern
//   builder, <out>/addon-tree/ (input of build-addon.mjs).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { addonSlot, ensureHistory } from "./addon-slot.mjs";
import { buildApp } from "./build-app.mjs";
import { fetchPnpm } from "./fetch-pnpm.mjs";
import { checkout, commitTime, resolveRef } from "./fetch-upstream.mjs";
import { localBuild } from "./local-build.mjs";
import { splitOfficeAddon } from "./split-addon.mjs";
import { BUN_VERSION, hostTargetId, target } from "./targets.mjs";
import { transformApp } from "./transform-app.mjs";

export async function buildTarget({ targetId, channel, ref, out, run, attempt, index, work, gitDir }) {
	const t = target(targetId);
	// The compiled dsh-native embeds the building Bun, so a mismatched runner or musl image ships another Bun.
	if (process.versions.bun !== BUN_VERSION) throw new Error(`build with Bun ${BUN_VERSION} (this is Bun ${process.versions.bun})`);
	if (hostTargetId().replace(/-(baseline|modern)$/, "") !== t.id.replace(/-(baseline|modern)$/, "")) {
		throw new Error(`build ${t.id} on its native runner (this host is ${hostTargetId()})`);
	}
	const upstream = /^[0-9a-f]{40}$/.test(ref) ? { commit: ref } : resolveRef(ref);
	if (channel === "release" && !upstream.tag) throw new Error("the release channel builds a dsh-v* tag");
	const upstreamVersion = channel === "release" ? upstream.tag.slice("dsh-v".length) : undefined;
	mkdirSync(work, { recursive: true });
	const src = join(work, "src");
	checkout(upstream.commit, src);
	const slot = addonSlot(ensureHistory(gitDir, upstream.commit), upstream.commit);
	const pnpmDir = join(work, `pnpm-${t.nodePlatform === "win32" ? "windows" : t.nodePlatform}-${t.arch}`);
	await fetchPnpm(src, t.id, pnpmDir);
	const app = join(work, "app");
	buildApp(src, pnpmDir, app);
	transformApp(app);
	const addon = join(work, "addon-office");
	splitOfficeAddon(app, addon);
	const r = localBuild({ out, channel, run, attempt, index, upstreamCommit: upstream.commit, upstreamCommitTime: commitTime(src, upstream.commit), upstreamVersion: upstreamVersion ?? readVersion(src), slot, work, targetId: t.id, warm: true });
	rmSync(r.root, { recursive: true, force: true });
	// The per-target release manifest, named per target: aggregate merges all 12 artifacts into one dir.
	writeFileSync(join(out, `${r.tag}.${t.id}.json`), `${JSON.stringify(r.manifest, null, 2)}\n`);
	if (t.id === "linux-x64-modern" && slot) cpSync(addon, join(out, "addon-tree"), { recursive: true });
	return { ...r, slot };
}

const readVersion = (src) => JSON.parse(readFileSync(join(src, "package.json"), "utf8")).version;

if (import.meta.main) {
	const [targetId, channel, ref, out, ...rest] = process.argv.slice(2);
	const opt = (k) => (rest.includes(k) ? rest[rest.indexOf(k) + 1] : undefined);
	if (!targetId || !channel || !ref || !out || !opt("--run")) throw new Error("usage: build-target.mjs <target> <channel> <ref> <out> --run N --attempt N --index f [--work d] [--git-dir d]");
	const r = await buildTarget({
		targetId,
		channel,
		ref,
		out: resolve(out),
		run: Number(opt("--run")),
		attempt: Number(opt("--attempt") ?? 1),
		index: opt("--index") && existsSync(opt("--index")) ? resolve(opt("--index")) : undefined,
		work: resolve(opt("--work") ?? "work"),
		gitDir: resolve(opt("--git-dir") ?? "work/upstream.git"),
	});
	console.log(JSON.stringify({ tag: r.tag, asset: r.asset, slot: r.slot }));
}
