// Assemble and archive a host-target bundle from already-built inputs under work/ (app, pnpm, addon),
// for local end-to-end runs and tests. CI uses the same steps per target (build workflow).
// usage: bun scripts/local-build.mjs <out-dir> <channel> <run> [--index index.json] [--upstream-commit sha] [--upstream-version v]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sha256 } from "./fetch-pnpm.mjs";
import { archive } from "./archive.mjs";
import { assembleBundle } from "./assemble-bundle.mjs";
import { buildLauncher } from "./build-launcher.mjs";
import { compileEntry } from "./compile-entry.mjs";
import { hostTargetId, target } from "./targets.mjs";
import { distribution } from "./versioning.mjs";

const ROOT = resolve(import.meta.dir, "..");

export function localBuild({ out, channel, run, attempt = 1, index, upstreamCommit, upstreamVersion = "0.1.7-rc.2", slot = null, work = join(ROOT, "work"), native }) {
	const t = target(hostTargetId());
	const launcherCommit = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	upstreamCommit ??= execFileSync("git", ["-C", join(work, "src-rc2"), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	const id = distribution({ channel, upstreamVersion, upstreamCommit, run, attempt, launcherCommit });
	mkdirSync(out, { recursive: true });
	const scratch = join(out, `.scratch-${id.version}`);
	rmSync(scratch, { recursive: true, force: true });
	mkdirSync(scratch, { recursive: true });
	if (!native) {
		native = join(scratch, t.executable);
		compileEntry(t.bunTarget, native);
	}
	const launcher = buildLauncher(t, { version: id.version, channel, out: scratch });
	const root = join(scratch, "root");
	const r = assembleBundle({
		target: t.id,
		out: root,
		app: join(work, "app"),
		pnpm: join(work, `pnpm-${t.nodePlatform === "win32" ? "windows" : t.nodePlatform}-${t.arch}`),
		native,
		launcher,
		identity: id,
		upstream: { commit: upstreamCommit, ...(channel === "release" ? { tag: `dsh-v${upstreamVersion}` } : {}), version: upstreamVersion },
		launcherCommit,
		slot,
		index,
	});
	const zip = join(out, `${id.tag}-${t.archive}`);
	archive(root, zip);
	const bytes = readFileSync(zip);
	return { ...id, target: t.id, zip, root, bundleMeta: r.meta, asset: { name: t.archive, size: statSync(zip).size, sha256: sha256(bytes) } };
}

if (import.meta.main) {
	const [out, channel, run, ...rest] = process.argv.slice(2);
	if (!out || !channel || !run) throw new Error("usage: local-build.mjs <out-dir> <channel> <run> [--index f] [--native f]");
	const opt = (k) => {
		const i = rest.indexOf(k);
		return i >= 0 ? rest[i + 1] : undefined;
	};
	const r = localBuild({ out: resolve(out), channel, run: Number(run), index: opt("--index"), native: opt("--native"), upstreamCommit: opt("--upstream-commit") });
	if (!existsSync(r.zip)) throw new Error("no archive");
	writeFileSync(join(resolve(out), `${r.tag}.json`), `${JSON.stringify({ ...r, root: undefined }, null, 2)}\n`);
	console.log(JSON.stringify({ tag: r.tag, zip: r.zip, asset: r.asset }));
}
