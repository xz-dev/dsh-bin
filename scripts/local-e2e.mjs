// Local packaged acceptance on the host target (task 6.1): two release bundles and the office addon built
// from work/ (app, pnpm, addon tree of one upstream checkout), an index written by index.mjs, then e2e.mjs.
// The two bundles share the upstream checkout and differ in run number and upstream commit time, so V2
// is newer; CI accept runs the same e2e on the real previous release and candidate.
// usage: bun scripts/local-e2e.mjs [--work dir] [--out dir] [--keep] [--reuse] [--no-plugin]
//   --reuse: run e2e again on the fixture a previous `--keep` run left in <out>.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { addonSlot, ensureHistory } from "./addon-slot.mjs";
import { buildAddon } from "./build-addon.mjs";
import { commitTime } from "./fetch-upstream.mjs";
import { appendAddon, appendBundle, emptyIndex } from "./index.mjs";
import { checkLockfile, readLockfile } from "./lockfile-guard.mjs";
import { localBuild } from "./local-build.mjs";
import { E2E_PLUGIN, e2e } from "./e2e.mjs";
import { addonPlatform } from "../runtime/update/addon-resolve.ts";
import { hostTargetId } from "./targets.mjs";
import { addonDistribution } from "./versioning.mjs";
import { execFileSync } from "node:child_process";

const ROOT = resolve(import.meta.dir, "..");
const rest = process.argv.slice(2);
const opt = (k) => (rest.includes(k) ? rest[rest.indexOf(k) + 1] : undefined);
const work = resolve(opt("--work") ?? join(ROOT, "work"));
const out = resolve(opt("--out") ?? join(process.env.HOME, ".cache", "dsh-local-e2e"));
const src = join(work, "src-rc2");
const upstreamCommit = execFileSync("git", ["-C", src, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const launcherCommit = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const slot = addonSlot(ensureHistory(join(work, "upstream.git"), upstreamCommit), upstreamCommit);
const targetId = hostTargetId();
const assets = join(out, "assets");
const indexPath = join(out, "index.json");
if (!(rest.includes("--reuse") && existsSync(indexPath))) await buildFixture();
rmSync(join(out, "run"), { recursive: true, force: true });
await e2e({ index: indexPath, assets, targetId, channel: "release", keep: rest.includes("--keep"), work: join(out, "run"), plugin: rest.includes("--no-plugin") ? null : E2E_PLUGIN });
if (!rest.includes("--keep")) rmSync(out, { recursive: true, force: true });

async function buildFixture() {
rmSync(out, { recursive: true, force: true });
mkdirSync(assets, { recursive: true });
const index = emptyIndex();
const at = (s) => new Date(Date.UTC(2026, 8, 1, 0, 0, s)).toISOString();

// The office addon of this slot, built from the addon tree and the lockfile-pinned engine for this host.
const id = addonDistribution({ kitVersion: slot.kitVersion, run: 1, attempt: 1, launcherCommit });
const addonOut = join(out, "addon");
const m = await buildAddon({ tree: join(work, "addon-office"), office: checkLockfile(readLockfile(src)).office, out: addonOut, identity: { ...id, slot }, platforms: [addonPlatform(targetId)] });
for (const a of Object.values(m.assets)) {
	mkdirSync(join(assets, m.tag), { recursive: true });
	execFileSync("mv", [join(addonOut, a.file), join(assets, m.tag, a.file)]);
}
appendAddon(index, m, at(0));
writeFileSync(indexPath, JSON.stringify(index));

// Two bundles: V2 is newer by run number and a later upstream commit time (version order).
const time = commitTime(src, upstreamCommit);
for (const [run, commitTimeOf] of [
	[1, time],
	[2, new Date(Date.parse(time) + 60_000).toISOString()],
]) {
	const r = localBuild({ out: assets, channel: "release", run, index: indexPath, upstreamCommit, upstreamCommitTime: commitTimeOf, slot, work, targetId, warm: true });
	rmSync(r.root, { recursive: true, force: true });
	appendBundle(index, r.manifest, at(run));
	writeFileSync(indexPath, JSON.stringify(index));
}
}
