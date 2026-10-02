// RL-ARTIFACT-E2E: download/hash-check the accepted counterpart; never build it.
// acceptedIndex is an HTTPS URL or a directory containing the index and its published ZIPs.
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
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
async function checkedProcess(command, cwd, env) {
	const p = Bun.spawn(command, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => p.kill(), 90_000);
	try {
		const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
		if (code !== 0) throw new Error(`${command.join(" ")}: exit ${code}\n${out}\n${err}`);
		return out;
	} finally { clearTimeout(timer); if (p.exitCode === null) p.kill(); }
}
function acceptance(record) {
	const line = `DSH_NATIVE_ACCEPTANCE ${JSON.stringify(record)}`;
	console.log(line);
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n\n`);
}
const psQuote = (text) => `'${text.replaceAll("'", "''")}'`;
export async function artifactShells({ exe, home, bundle, runtime, target, env }) {
	const description = JSON.parse(readFileSync(join(bundle, "completion.json"), "utf8"));
	const command = description.commands?.find((c) => c.name)?.name;
	if (!/^[a-z][a-z0-9-]*$/.test(command ?? "")) throw new Error("runtime completion needs a fixed command candidate");
	// Keep shell host essentials (notably Windows), but no host Node/Bun on the tested PATH.
	const host = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^DSH_|^(?:BASH_ENV|ENV)$/i.test(key)));
	const shellEnv = { ...host, ...env, PATH: `${dirname(exe)}${delimiter}${env.PATH}`, ZDOTDIR: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache") };
	for (const shell of ["bash", "zsh", "fish", "pwsh", "powershell"]) {
		const supported = process.platform === "win32" ? ["pwsh", "powershell"].includes(shell) : shell !== "powershell";
		const binary = supported ? Bun.which(process.platform === "win32" ? `${shell}.exe` : shell) : null;
		if (!binary) { acceptance({ target, shell, result: "not-run", reason: supported ? "shell not installed" : "shell seam requires another OS" }); continue; }
		const powershell = ["pwsh", "powershell"].includes(shell);
		const profile = join(home, powershell ? `${shell}-profile.ps1` : shell === "fish" ? "config/fish/completions/dsh.fish" : `.${shell}rc`);
		const settings = shell === "fish" ? join(home, "config/fish/config.fish") : profile;
		mkdirSync(join(settings, ".."), { recursive: true });
		const original = Buffer.from(`${powershell ? "\ufeff" : ""}# preserved user settings`);
		writeFileSync(settings, original, { flag: "wx" });
		const args = [shell, ...(powershell ? ["--profile", profile] : [])];
		try {
			await checkedProcess([exe, "manager", "completion", "install", ...args], home, shellEnv);
			let invocation, output = "";
			if (shell === "bash") invocation = [binary, "--noprofile", "--norc", "-c", `source "$1"
COMP_WORDS=(dsh manager in); COMP_CWORD=2; _dsh_manager_complete; printf '%s\\n' "\${COMPREPLY[@]}"
COMP_WORDS=(dsh --use "$2" "$3"); COMP_CWORD=3; _dsh_manager_complete; printf '%s\\n' "\${COMPREPLY[@]}"`, "artifact-shell", profile, runtime, command];
			else if (shell === "zsh") {
				const script = `autoload -Uz compinit; compinit -D -i; unset '_comps[dsh]'; source "$1"
compadd() { shift 2; print -rl -- "$@"; }
shift; words=(dsh "$@"); CURRENT=\${#words}; _dsh_manager_complete`;
				// Fresh sessions exercise activation for both queries, without retained completion state.
				output = await checkedProcess([binary, "-f", "-c", script, "artifact-shell", profile, "manager", "in"], home, shellEnv);
				invocation = [binary, "-f", "-c", script, "artifact-shell", profile, "--use", runtime, command];
			}
			else if (shell === "fish") invocation = [binary, "--no-config", "-c", `set -g fish_complete_path $XDG_CONFIG_HOME/fish/completions; source $argv[1]; complete -C 'dsh manager in'; complete -C "dsh --use $argv[2] $argv[3]"`, profile, runtime, command];
			else {
				const code = `$ErrorActionPreference='Stop'; . ${psQuote(profile)}; foreach ($line in @('dsh manager in', ${psQuote(`dsh --use ${runtime} ${command}`)})) { (TabExpansion2 $line $line.Length).CompletionMatches | ForEach-Object { $_.CompletionText } }`;
				invocation = [binary, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(code, "utf16le").toString("base64")];
			}
			output += await checkedProcess(invocation, home, shellEnv);
			const words = output.split(/\r?\n/).map((line) => line.split("\t")[0]);
			for (const expected of ["install", command]) if (!words.includes(expected)) throw new Error(`${shell}: missing ${expected} completion: ${output}`);
			await checkedProcess([exe, "manager", "completion", "uninstall", ...args], home, shellEnv);
			if (!readFileSync(settings).equals(original) || (shell === "fish" && existsSync(profile))) throw new Error(`${shell}: uninstall changed user settings`);
			acceptance({ target, shell, result: "passed", managerCandidate: "install", runtimeCandidate: command, profileRestored: true });
		} catch (error) { acceptance({ target, shell, result: "failed", reason: error.message }); throw error; }
	}
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
		const env = { PATH: empty, HOME: home, USERPROFILE: home, LOCALAPPDATA: home, APPDATA: home, TMPDIR: root, TMP: root, TEMP: root, NO_COLOR: "1", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
		const run = (args) => checkedProcess([exe, ...args], home, env);
		const version = await run(["--use", runtime.id, "--version"]);
		if (!version.includes(runtime.upstream.version)) throw new Error(`runtime version mismatch: ${version}`);
		const help = await run(["--use", runtime.id, "--help"]);
		if (!help.includes("dsh")) throw new Error("runtime --help missing dsh");
		if (product === "manager") await artifactShells({ exe, home, bundle, runtime: runtime.id, target, env });
		if (!readFileSync(exe).equals(verifyZip(managerBytes, managerTarget, manager.version))) throw new Error("combination changed manager bytes");
		if (!readFileSync(native).equals(nativeBefore)) throw new Error("combination changed runtime executable bytes");
		acceptance({ target, product, result: "passed", manager: manager.version, runtime: runtime.id, checks: ["version", "help"] });
		console.log(`RL-ARTIFACT-E2E passed: manager ${manager.version} + runtime ${runtime.id} (${target}); counterpart ${digest}, no counterpart rebuild`);
	} finally { rmSync(root, { recursive: true, force: true }); }
}
if (import.meta.main) {
	const [product, candidate, accepted, digest, target] = process.argv.slice(2);
	if (!target) throw new Error("usage: artifact-e2e.mjs manager|runtime candidate-dir accepted-index-url|artifact-dir accepted-index-sha256 runtime-target");
	await artifactE2E({ product, candidate: resolve(candidate), accepted, digest, target, repo: process.env.GITHUB_REPOSITORY });
}
