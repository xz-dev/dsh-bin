// Assemble and archive a host-target runtime bundle from already-built inputs under work/ (app, pnpm), for
// local end-to-end runs and tests. CI uses the same steps per target (build workflow). It never builds the
// dsh manager: the archive is one runtime, installed by any manager of the same launch protocol.
// usage: bun scripts/local-build.mjs <out-dir> <channel> <run> [--index runtime-index.json] [--upstream-commit sha] [--slot slot-json] [--native f]
//   writes <out>/<tag>-<asset> and <out>/<tag>.json (runtime manifest)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sha256 } from "./fetch-pnpm.mjs";
import { archive } from "./archive.mjs";
import { assembleBundle } from "./assemble-bundle.mjs";
import { compileEntry } from "./compile-entry.mjs";
import { hostTargetId, target } from "./targets.mjs";
import { distribution } from "./versioning.mjs";
import { commitTime } from "./fetch-upstream.mjs";

const ROOT = resolve(import.meta.dir, "..");

/** Runtime asset name of a target: runtime-<target>.zip (the manager has its own assets). */
export const runtimeAsset = (t) => `runtime-${t.id}.zip`;

export function localBuild({ out, channel, run, attempt = 1, index, upstreamCommit, upstreamCommitTime, upstreamVersion = "0.1.7-rc.2", slot = null, work = join(ROOT, "work"), native, targetId = hostTargetId(), warm = false }) {
	const t = target(targetId);
	// CI passes the commit (git in the musl container refuses the runner-owned checkout as dubious).
	const builderCommit = process.env.DSH_BUILDER_COMMIT || execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	upstreamCommit ??= execFileSync("git", ["-C", join(work, "src-rc2"), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	upstreamCommitTime ??= commitTime(join(work, "src-rc2"), upstreamCommit);
	const id = distribution({ channel, upstreamVersion, upstreamCommit, run, attempt, builderCommit });
	mkdirSync(out, { recursive: true });
	const scratch = join(out, `.scratch-${id.id}`);
	rmSync(scratch, { recursive: true, force: true });
	mkdirSync(scratch, { recursive: true });
	if (!native) {
		native = join(scratch, t.executable);
		compileEntry(t.bunTarget, native);
	}
	const root = join(scratch, "root");
	const r = assembleBundle({
		target: t.id,
		out: root,
		app: join(work, "app"),
		pnpm: join(work, `pnpm-${t.nodePlatform === "win32" ? "windows" : t.nodePlatform}-${t.arch}`),
		native,
		identity: id,
		upstream: { commit: upstreamCommit, commitTime: upstreamCommitTime, ...(channel === "release" ? { tag: `dsh-v${upstreamVersion}` } : {}), version: upstreamVersion },
		run: Number(run),
		attempt: Number(attempt),
		builderCommit,
		slot,
		index,
		warm,
	});
	const zip = join(out, `${id.tag}-${runtimeAsset(t)}`);
	archive(root, zip);
	const bytes = readFileSync(zip);
	const asset = { name: runtimeAsset(t), size: statSync(zip).size, sha256: sha256(bytes) };
	const manifest = {
		kind: "dsh-runtime",
		tag: id.tag,
		id: id.id,
		channel,
		upstream: r.meta.upstream,
		run: r.meta.run,
		attempt: r.meta.attempt,
		launchProtocol: r.meta.launchProtocol,
		builderCommit,
		addons: { office: { slot: r.meta.addons.office.slot, pinned: r.meta.addons.office.pinned } },
		targets: { [t.id]: { file: asset.name, size: asset.size, sha256: asset.sha256 } },
	};
	return { ...id, target: t.id, zip, root, bundleMeta: r.meta, asset, manifest };
}

if (import.meta.main) {
	const [out, channel, run, ...rest] = process.argv.slice(2);
	if (!out || !channel || !run) throw new Error("usage: local-build.mjs <out-dir> <channel> <run> [--index f] [--native f]");
	const opt = (k) => {
		const i = rest.indexOf(k);
		return i >= 0 ? rest[i + 1] : undefined;
	};
	const r = localBuild({ out: resolve(out), channel, run: Number(run), index: opt("--index"), native: opt("--native"), upstreamCommit: opt("--upstream-commit"), slot: opt("--slot") ? JSON.parse(opt("--slot")) : null });
	if (!existsSync(r.zip)) throw new Error("no archive");
	writeFileSync(join(resolve(out), `${r.tag}.json`), `${JSON.stringify(r.manifest, null, 2)}\n`);
	console.log(JSON.stringify({ tag: r.tag, id: r.id, zip: r.zip, asset: r.asset }));
}
