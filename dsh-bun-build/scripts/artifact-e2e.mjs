// RL-ARTIFACT-E2E: download/hash-check the accepted counterpart; never build it.
// acceptedIndex is an HTTPS URL or a directory containing the index and its published ZIPs.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extractZip } from "../runtime/zip.ts";
import { parseIndex } from "./index.mjs";
import { sha256, verifyZip } from "../../dsh-manager/scripts/release.mjs";

export async function checkedIndex(source, expected, product) {
	if (!/^[0-9a-f]{64}$/.test(expected ?? "")) throw new Error("accepted index SHA256 is required");
	const remote = /^https:\/\//.test(source);
	const bytes = remote ? Buffer.from(await (await fetchOK(source)).arrayBuffer()) : readFileSync(join(source, `${product}-index.json`));
	if (sha256(bytes) !== expected) throw new Error("accepted index SHA256 mismatch");
	const index = JSON.parse(bytes);
	if (index.schema !== 1) throw new Error("accepted index must be schema 1");
	if (product === "runtime") parseIndex(bytes.toString("utf8"));
	else if (!Array.isArray(index.versions)) throw new Error("accepted manager index versions must be a list");
	return index;
}
async function fetchOK(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r; }
async function assetBytes(entry, asset, source, repo) {
	if (!/^[0-9A-Za-z][0-9A-Za-z._+-]*\.zip$/.test(asset?.name ?? "") || !/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(entry.tag ?? "") || !/^[0-9a-f]{64}$/.test(asset?.sha256 ?? "")) throw new Error("invalid accepted asset identity");
	let bytes;
	if (!/^https:\/\//.test(source)) {
		const direct = join(source, asset.name), prefixed = join(source, `${entry.tag}-${asset.name}`);
		bytes = readFileSync(existsSync(direct) ? direct : prefixed);
	} else bytes = Buffer.from(await (await fetchOK(`https://github.com/${repo}/releases/download/${entry.tag}/${asset.name}`)).arrayBuffer());
	if (bytes.length !== asset.size || sha256(bytes) !== asset.sha256) throw new Error(`${asset.name}: size/SHA256 mismatch`);
	return bytes;
}
export async function artifactE2E({ product, candidate, accepted, digest, target, repo = "xz-dev/dsh-bin" }) {
	const counterpart = product === "manager" ? "runtime" : "manager";
	const index = await checkedIndex(accepted, digest, counterpart);
	const own = JSON.parse(readFileSync(join(candidate, `${product}-index.json`), "utf8"));
	const runtimeIndex = product === "runtime" ? own : index, managerIndex = product === "manager" ? own : index;
	parseIndex(JSON.stringify(runtimeIndex));
	if (!Array.isArray(managerIndex.versions)) throw new Error("manager index versions must be a list");
	const runtimeManifest = join(product === "runtime" ? candidate : accepted, "release-manifest.json");
	const exactRuntime = !/^https:\/\//.test(product === "runtime" ? candidate : accepted) && existsSync(runtimeManifest) ? JSON.parse(readFileSync(runtimeManifest, "utf8")).id : null;
	const runtime = [...runtimeIndex.channels.release, ...runtimeIndex.channels.live].filter((e) => e.assets?.[target] && (!exactRuntime || e.id === exactRuntime)).sort((a, b) => a.upstream.commitTime.localeCompare(b.upstream.commitTime) || a.run - b.run || a.attempt - b.attempt).at(-1);
	if (!runtime) throw new Error(`no accepted runtime target ${target}`);
	const managerTarget = target.replace(/-(?:musl-)?(?:baseline|modern)$/, "").replace(/-musl$/, "");
	const manager = [...managerIndex.versions].sort((a, b) => Bun.semver.order(a.version, b.version)).filter((e) => e.assets?.[managerTarget]).at(-1);
	if (!manager) throw new Error(`no accepted manager target ${managerTarget}`);
	const runtimeSource = product === "runtime" ? candidate : accepted, managerSource = product === "manager" ? candidate : accepted;
	const runtimeBytes = await assetBytes(runtime, runtime.assets[target], runtimeSource, repo);
	const managerBytes = await assetBytes(manager, manager.assets[managerTarget], managerSource, repo);
	verifyZip(managerBytes, managerTarget, manager.version);
	const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/var/tmp", "dsh-artifact-e2e-"));
	try {
		const tools = join(root, "tools"), home = join(root, "home"), empty = join(root, "empty-path");
		for (const d of [tools, home, empty]) mkdirSync(d);
		const zip = join(root, "manager.zip"); writeFileSync(zip, managerBytes, { flag: "wx" }); extractZip(zip, tools);
		const exe = join(tools, process.platform === "win32" ? "dsh.exe" : "dsh"); chmodSync(exe, 0o755);
		const data = join(tools, "dsh-bin"), bundle = join(data, "bundles", runtime.id);
		mkdirSync(bundle, { recursive: true });
		writeFileSync(join(data, ".dsh-bin-data.json"), '{"kind":"dsh-manager-data","schema":1}');
		const runtimeZip = join(root, "runtime.zip"); writeFileSync(runtimeZip, runtimeBytes, { flag: "wx" }); extractZip(runtimeZip, bundle);
		const metadata = JSON.parse(readFileSync(join(bundle, "bundle.json"), "utf8"));
		if (metadata.id !== runtime.id || metadata.target !== target || metadata.launchProtocol !== 1 || metadata.kind !== "dsh-runtime" || metadata.schemaVersion !== 1) throw new Error("runtime archive identity mismatch");
		const native = join(bundle, process.platform === "win32" ? "dsh-native.exe" : "dsh-native"), nativeBefore = readFileSync(native);
		const env = { PATH: empty, HOME: home, USERPROFILE: home, LOCALAPPDATA: home, NO_COLOR: "1", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
		async function run(args) {
			const p = Bun.spawn([exe, ...args], { cwd: home, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
			const timer = setTimeout(() => p.kill(), 90_000);
			try { const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]); if (code !== 0) throw new Error(`${args.join(" ")}: exit ${code}\n${out}\n${err}`); return out; }
			finally { clearTimeout(timer); if (p.exitCode === null) p.kill(); }
		}
		const version = await run(["--use", runtime.id, "--version"]);
		if (!version.includes(runtime.upstream.version)) throw new Error(`runtime version mismatch: ${version}`);
		const help = await run(["--use", runtime.id, "--help"]);
		if (!help.includes("dsh")) throw new Error("runtime --help missing dsh");
		if (!readFileSync(exe).equals(verifyZip(managerBytes, managerTarget, manager.version))) throw new Error("combination changed manager bytes");
		if (!readFileSync(native).equals(nativeBefore)) throw new Error("combination changed runtime executable bytes");
		console.log(`RL-ARTIFACT-E2E passed: manager ${manager.version} + runtime ${runtime.id} (${target}); counterpart ${digest}, no counterpart rebuild`);
	} finally { rmSync(root, { recursive: true, force: true }); }
}
if (import.meta.main) {
	const [product, candidate, accepted, digest, target] = process.argv.slice(2);
	if (!target) throw new Error("usage: artifact-e2e.mjs manager|runtime candidate-dir accepted-index-url|artifact-dir accepted-index-sha256 runtime-target");
	await artifactE2E({ product, candidate: resolve(candidate), accepted, digest, target, repo: process.env.GITHUB_REPOSITORY });
}
