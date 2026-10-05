// Bounded DIAGNOSTIC only. Explicit invocation; never fixture/combined-artifact acceptance.
// bun windows-manager-first-use.native.ts <github-artifact.zip> <absolute zig.exe> <absolute git.exe>
// Host-only authentication: bun windows-manager-first-use.native.ts --check-inputs <github-artifact.zip>
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { extractZip, readZipEntries, writeZip } from "../../dsh-bun-build/runtime/zip.ts";
import { appendBundle, emptyIndex, serialize } from "../../dsh-bun-build/scripts/index.mjs";
import { distribution } from "../../dsh-bun-build/scripts/versioning.mjs";

const PIN = {
	run: "37197221512", artifact: "11301612298", name: "runtime-target-windows-x64-modern",
	archiveSHA: "f121fd6732e7fd38af8823819e18a173d5bc5e3602c804790ac5e83457eedcfc",
	zip: "runtime-v0.2.0-rc.2-b123.1.gc18afcc9-runtime-windows-x64-modern.zip",
	zipSHA: "c7e60511d97c60e046a48546d67590aa8e97ee50a276ee32760b12777106466d", size: 131131488,
	manifest: "runtime-v0.2.0-rc.2-b123.1.gc18afcc9.windows-x64-modern.json",
	manifestSHA: "d9b1456716dbd733066e072de6d11116468473823fa5a7af1c370aed9e158690",
	builder: "c18afcc95c832d3a519e2a936a2c7b0593f9cb9b", upstream: "639ed015397290b3745d163aafe02ffee4aa3f84",
};
const gate = '\tif (config && process.platform === "win32") {\n\t\tthrow Object.assign(new Error("dsh: configuration path violates selected configuration boundary"), { code: "DSH_CONFIG_BOUNDARY" });\n\t}\n';
const hash = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const fileHash = (p: string) => hash(readFileSync(p));
function digest(dir: string): Record<string, string> {
	const result: Record<string, string> = {};
	function walk(p: string) {
		for (const name of readdirSync(p).sort()) {
			const f = join(p, name), s = lstatSync(f), key = relative(dir, f).replaceAll("\\", "/");
			assert(!s.isSymbolicLink(), `unexpected link: ${key}`);
			result[key] = s.isDirectory() ? "directory" : fileHash(f);
			if (s.isDirectory()) walk(f);
		}
	}
	walk(dir); return result;
}
const args = process.argv.slice(2), checkOnly = args[0] === "--check-inputs";
const [input, zig, git] = checkOnly ? args.slice(1) : args;
assert(input && isAbsolute(input), "absolute GitHub artifact archive required");
if (!checkOnly) {
	assert(process.platform === "win32" && process.arch === "x64" && Bun.version === "1.4.2", "native Windows x64 Bun1.4.2 required; NOT RUN");
	assert(zig && isAbsolute(zig) && git && isAbsolute(git), "absolute pinned Zig0.15.2 and git paths required");
}
const temp = process.platform === "win32" ? process.env.RUNNER_TEMP : "/var/tmp";
assert(temp && isAbsolute(temp), "RUNNER_TEMP required on Windows");
const root = realpathSync(mkdtempSync(join(temp, "dsh-manager-first-use-")));
console.log(`WINDOWS_MANAGER_FIRST_USE_ARTIFACT ${root}`);
let stage = "input-authentication", server: ReturnType<typeof Bun.serve> | undefined;
const requests: { path: string; range: string | null }[] = [];
const repo = resolve(import.meta.dir, "../.."), source = join(repo, "dsh-bun-build");
const data = join(root, "tools/dsh-bin"), configStore = join(data, "config-snapshots");
let config: string | undefined, env: Record<string, string>, powershell: string | undefined;
function save(name: string, value: unknown) { writeFileSync(join(root, name), JSON.stringify(value, null, 2) + "\n"); }
function helper(exe: string, argv: string[], cwd = root, timeout = 120_000) {
	const r = spawnSync(exe, argv, { cwd, env, encoding: "utf8", timeout });
	writeFileSync(join(root, `${stage}.stdout`), r.stdout ?? ""); writeFileSync(join(root, `${stage}.stderr`), r.stderr ?? "");
	assert.equal(r.status, 0, `${stage} failed: exit=${r.status}, signal=${r.signal}, error=${r.error?.message ?? "none"}`);
	return r.stdout.trim();
}
// Only OS metadata. No SetOwner/SetAcl, fixture import, content reads, token or privilege edits.
const inspectPS = `param([string]$Path)
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
Microsoft.PowerShell.Core\\Import-Module "$PSHOME\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1"
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function Inspect([string]$p) {
  $item = if ([System.IO.Directory]::Exists($p)) { [System.IO.DirectoryInfo]::new($p) } else { [System.IO.FileInfo]::new($p) }
  $acl = $item.GetAccessControl([System.Security.AccessControl.AccessControlSections]'Owner, Access')
  $raw = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
  $aces = @($raw.DiscretionaryAcl | Microsoft.PowerShell.Core\\ForEach-Object {
    @{ type=$_.AceType.ToString(); flags=$_.AceFlags.ToString(); mask=$_.AccessMask; sid=$_.SecurityIdentifier.Value }
  })
  @{ path=$p; user=$user; owner=$raw.Owner.Value; protected=$acl.AreAccessRulesProtected; control=$raw.ControlFlags.ToString(); sddl=$raw.GetSddlForm([System.Security.AccessControl.AccessControlSections]'Owner, Access'); aces=$aces; allowedPrincipals=@($aces | Microsoft.PowerShell.Core\\Where-Object { $_.type -eq 'AccessAllowed' } | Microsoft.PowerShell.Core\\ForEach-Object { $_.sid }); attributes=$item.Attributes.ToString() }
  if ($item -is [System.IO.DirectoryInfo] -and -not ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    foreach ($child in $item.EnumerateFileSystemInfos()) { Inspect $child.FullName }
  }
}
$objects = if ([System.IO.Directory]::Exists($Path)) { @(Inspect $Path) } else { @() }
@{ user=$user; path=$Path; exists=[System.IO.Directory]::Exists($Path); objects=$objects } | Microsoft.PowerShell.Utility\\ConvertTo-Json -Depth 8 -Compress
`;
function inspect(label: string) {
	assert(powershell, "inspector unavailable");
	const r = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-File", join(root, "inspect-readonly.ps1"), config ?? configStore], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
	writeFileSync(join(root, `${label}.stdout`), r.stdout ?? ""); writeFileSync(join(root, `${label}.stderr`), r.stderr ?? "");
	assert.equal(r.status, 0, `read-only ACL inspection failed: ${r.status}`);
	const metadata = JSON.parse(r.stdout.replace(/^\uFEFF/, "")); save(`${label}.json`, metadata); return metadata;
}
async function command(exe: string, argv: string[], extra: Record<string, string> = {}, timeout = 60_000) {
	const label = stage, outPath = join(root, `${stage}.stdout`), errPath = join(root, `${stage}.stderr`);
	writeFileSync(outPath, ""); writeFileSync(errPath, "");
	const child = spawn(exe, argv, { cwd: root, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "", error: Error | undefined, timedOut = false;
	child.stdout.on("data", b => { stdout += b.toString(); appendFileSync(outPath, b); }); child.stderr.on("data", b => appendFileSync(errPath, b));
	child.on("error", e => { error = e; });
	const timer = setTimeout(() => {
		timedOut = true; child.kill("SIGKILL");
		// Bounded wait even if runtime descendant retains inherited pipes. No job/token changes.
		child.stdout.destroy(); child.stderr.destroy();
	}, timeout);
	const result = await new Promise<{ code: number | null; signal: string | null }>(r => child.on("close", (code, signal) => r({ code, signal })));
	clearTimeout(timer);
	save(`${label}.json`, { executable: exe, args: argv, ...result, timedOut, error: error?.message });
	assert(!timedOut && !error && result.code === 0, `${label} failed: exit=${result.code}, signal=${result.signal}, timeout=${timedOut}, error=${error?.message ?? "none"}`);
	return stdout;
}
const probe = `import z from '@deepseek-ai/schemastery';
export const inject=['settings','credentials','profileContext','appReady','appExit'];
export const Config=z.object({label:z.string().default('first-use-default').volatile()});
export function apply(ctx){ctx.appReady.onReady(()=>{void(async()=>{
console.log('FIRST_USE_STAGE loader-ready');await ctx.root.loader.await();
const read=async()=>({label:ctx.settings.describe().find(r=>r.ns==='first-use')?.value.label,credentialMissing:(await ctx.credentials.resolve('DSH_FIRST_USE_SYNTHETIC'))==null,credentialMatches:(await ctx.credentials.resolve('DSH_FIRST_USE_SYNTHETIC'))?.value==='synthetic-first-use',home:ctx.profileContext.home,dir:ctx.profileContext.dir,patch:ctx.settings.documentPath,credentialFile:ctx.credentials.spec.filename});
console.log('FIRST_USE_STAGE initial-read');const before=await read();
console.log('FIRST_USE_STAGE settings-write');await ctx.settings.update('first-use',{label:'first-use-written'});
console.log('FIRST_USE_STAGE provider-write');await ctx.credentials.set('DSH_FIRST_USE_SYNTHETIC','synthetic-first-use');
console.log('FIRST_USE_STAGE final-read');const after=await read();
console.log('FIRST_USE_REPORT '+JSON.stringify({launch:JSON.parse(process.env.DSH_MANAGER_LAUNCH),exe:process.execPath,before,after}));ctx.appExit(0)
})().catch(e=>{console.error('FIRST_USE_FAILURE '+(e.code??e.name));ctx.appExit(1)})})}
`;

try {
	assert.equal(fileHash(input), PIN.archiveSHA, "GitHub artifact hash mismatch");
	assert.deepEqual(readZipEntries(readFileSync(input)).map(e => e.name).sort(), [PIN.zip, PIN.manifest].sort());
	const ci = join(root, "ci-input"); extractZip(input, ci);
	const originalZip = join(ci, PIN.zip), manifestPath = join(ci, PIN.manifest);
	assert.equal(statSync(originalZip).size, PIN.size); assert.equal(fileHash(originalZip), PIN.zipSHA);
	assert.equal(fileHash(manifestPath), PIN.manifestSHA);
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	appendBundle(emptyIndex(), manifest);
	assert.equal(manifest.upstream.commit, PIN.upstream); assert.equal(manifest.builderCommit, PIN.builder);
	assert.equal(manifest.launchProtocol, 2); assert.equal(manifest.targets["windows-x64-modern"].sha256, PIN.zipSHA);
	const inputMembers = readZipEntries(readFileSync(originalZip));
	for (const member of ["bundle.json", "dsh-native.exe", ".usage.lock", "app/package.json", "app/lib/bin.js", "pnpm/dist/pnpm.mjs"]) assert(inputMembers.some(e => e.name === member && !e.dir), `missing archived member: ${member}`);
	save("authenticated-inputs.json", { ...PIN, githubArchive: input, members: inputMembers.length, nativeStatus: "NOT RUN", untouchedCIArtifactAcceptance: false });
	if (checkOnly) {
		console.log("INPUT_AUTHENTICATION_PASSED; native Windows product probe NOT RUN");
	} else {
		// Both build tools and product inherit only test-owned paths, never GH_TOKEN or host credentials.
		for (const p of ["home", "tmp", "cache", "tools"]) mkdirSync(join(root, p));
		env = { PATH: "", HOME: join(root, "home"), USERPROFILE: join(root, "home"), APPDATA: join(root, "home/AppData/Roaming"), LOCALAPPDATA: join(root, "home/AppData/Local"), TEMP: join(root, "tmp"), TMP: join(root, "tmp"), TMPDIR: join(root, "tmp"), XDG_CACHE_HOME: join(root, "cache"), BUN_INSTALL_CACHE_DIR: join(root, "cache/bun"), npm_config_cache: join(root, "cache/npm"), NO_COLOR: "1" };
		for (const key of ["SystemRoot", "WINDIR"]) if (process.env[key]) env[key] = process.env[key]!;
		assert(env.SystemRoot, "SystemRoot required for absolute OS inspector");
		powershell = join(env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
		env.PSModulePath = join(dirname(powershell), "Modules"); writeFileSync(join(root, "inspect-readonly.ps1"), inspectPS);
		stage = "zig-version"; assert.equal(helper(zig, ["version"]), "0.15.2");
		stage = "source-head"; const originalHead = helper(git, ["-C", repo, "rev-parse", "HEAD"]);
		stage = "source-clean"; assert.equal(helper(git, ["-C", repo, "status", "--porcelain", "--", "dsh-bun-build/runtime", "dsh-bun-build/scripts/compile-entry.mjs", "dsh-manager/src", "dsh-manager/build.zig"]), "", "product sources must match original HEAD");
		stage = "diagnostic-source";
		const candidate = join(root, "candidate-source"); mkdirSync(join(candidate, "scripts"), { recursive: true });
		cpSync(join(source, "runtime"), join(candidate, "runtime"), { recursive: true });
		cpSync(join(source, "scripts/compile-entry.mjs"), join(candidate, "scripts/compile-entry.mjs"));
		const originalSources = digest(candidate), path = "runtime/compat/config-paths.ts", original = readFileSync(join(candidate, path), "utf8");
		assert.equal(original.split(gate).length, 2, "exact Windows fail-closed block must occur once");
		writeFileSync(join(candidate, path), original.replace(gate, ""));
		const candidateSources = digest(candidate);
		assert.deepEqual(Object.keys(originalSources).filter(p => originalSources[p] !== candidateSources[p]), [path]);
		for (const p of ["app.ts", "launch.ts", "usage-claim.ts", "compat/windows-private-access.ts"]) assert.equal(fileHash(join(source, "runtime", p)), candidateSources[`runtime/${p}`]);
		const diff = spawnSync(git, ["diff", "--no-index", "--", join(source, path), join(candidate, path)], { env, encoding: "utf8", timeout: 20_000 });
		assert.equal(diff.status, 1); writeFileSync(join(root, "candidate-gate.diff"), diff.stdout);
		const provenance = { kind: "windows-manager-first-use-diagnostic", originalHead, sourceSHA: hash(JSON.stringify(originalSources)), candidateSHA: hash(JSON.stringify(candidateSources)), originalSources, candidateSources, soleDiff: path, gateDiffSHA: hash(diff.stdout), bun: Bun.version, zig: "0.15.2", ci: PIN, identityProvenance: "local diagnostic run=1 attempt=1; not a published CI build" };
		save("candidate-source.json", provenance);
		stage = "compile-diagnostic-entry";
		const native = join(root, "diagnostic-native.exe"); helper(process.execPath, [join(candidate, "scripts/compile-entry.mjs"), "bun-windows-x64-modern", native]);
		stage = "compose-diagnostic-archive";
		const bundle = join(root, "diagnostic-bundle"), entries = extractZip(originalZip, bundle);
		const before = digest(bundle), meta = JSON.parse(readFileSync(join(bundle, "bundle.json"), "utf8"));
		assert.equal(meta.id, manifest.id); assert.equal(meta.target, "windows-x64-modern"); assert.equal(meta.upstream.commit, PIN.upstream);
		assert(existsSync(join(bundle, ".usage.lock")) && existsSync(join(bundle, "pnpm/dist/pnpm.mjs")));
		const identity = distribution({ channel: manifest.channel, upstreamVersion: manifest.upstream.version, upstreamCommit: PIN.upstream, run: 1, attempt: 1, builderCommit: originalHead });
		assert.notEqual(identity.id, manifest.id, "diagnostic archive needs distinct identity");
		const nativeSHA = fileHash(native);
		cpSync(native, join(bundle, "dsh-native.exe"));
		const metadata = { ...meta, ...identity, builderCommit: originalHead, run: 1, attempt: 1, diagnostic: { kind: provenance.kind, originalHead, sourceSHA: provenance.sourceSHA, candidateSHA: provenance.candidateSHA, nativeSHA, ciArchiveSHA: PIN.archiveSHA, ciRuntimeSHA: PIN.zipSHA } };
		writeFileSync(join(bundle, "bundle.json"), JSON.stringify(metadata, null, 2) + "\n");
		const after = digest(bundle), changes = Object.keys(before).filter(p => before[p] !== after[p]);
		assert.deepEqual(Object.keys(after), Object.keys(before)); assert.deepEqual(changes.sort(), ["bundle.json", "dsh-native.exe"]);
		const composed = join(root, "diagnostic-runtime.zip");
		// Preserve original member names/types/modes. ZIP container recompressed, content changes only below.
		writeZip(composed, entries.map(e => ({ name: e.name, dir: e.dir, mode: e.mode, ...(e.dir ? {} : { data: readFileSync(join(bundle, e.name)) }) })));
		const verification = join(root, "composed-verification"), verifiedEntries = extractZip(composed, verification);
		assert.deepEqual(digest(verification), after);
		assert.deepEqual(verifiedEntries.map(e => [e.name, e.dir, e.mode]), entries.map(e => [e.name, e.dir, e.mode]));
		save("diagnostic-archive.json", { ...metadata.diagnostic, archiveSHA: fileHash(composed), size: statSync(composed).size, changedMembers: changes.map(member => ({ member, beforeSHA: before[member], afterSHA: after[member] })), unchangedMembers: Object.keys(before).length - changes.length, appPnpmBytesIdentical: true, untouchedCIArtifact: false, container: "deterministic ZIP recompression; original member names/types/modes retained; member SHA means uncompressed content" });
		const diagnosticManifest = { ...manifest, ...identity, builderCommit: originalHead, run: 1, attempt: 1, diagnostic: metadata.diagnostic, targets: { "windows-x64-modern": { file: "runtime-windows-x64-modern.zip", size: statSync(composed).size, sha256: fileHash(composed) } } };
		save("diagnostic-manifest.json", diagnosticManifest);
		const index = Object.assign(emptyIndex(), { diagnostic: { ...metadata.diagnostic, identityProvenance: provenance.identityProvenance } });
		appendBundle(index, diagnosticManifest); writeFileSync(join(root, "diagnostic-index.json"), serialize(index));
		stage = "compile-manager";
		helper(zig, ["build", "--cache-dir", join(root, "zig-cache"), "--global-cache-dir", join(root, "zig-global"), "-Dversion=0.0.0-first-use", "--prefix", join(root, "manager-build")], join(repo, "dsh-manager"), 300_000);
		const manager = join(root, "tools/dsh.exe"); cpSync(join(root, "manager-build/bin/dsh.exe"), manager);
		save("manager-input.json", { sourceHead: originalHead, sourceSHA: hash(JSON.stringify(digest(join(repo, "dsh-manager/src")))), buildSHA: fileHash(join(repo, "dsh-manager/build.zig")), managerSHA: fileHash(manager), zig: "0.15.2" });
		server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
			const path = new URL(req.url).pathname; requests.push({ path, range: req.headers.get("range") });
			if (path === "/runtime-index.json") return new Response(serialize(index), { headers: { "content-type": "application/json" } });
			if (path === `/download/${identity.tag}/runtime-windows-x64-modern.zip`) return new Response(Bun.file(composed));
			return new Response(null, { status: 404 });
		} });
		stage = "manager-install";
		await command(manager, ["manager", "install", identity.id], { DSH_MANAGER_TEST: "1", DSH_MANAGER_TEST_ORIGIN: server.url.origin }, 180_000);
		server.stop(true); server = undefined;
		stage = "manager-select";
		const selected = `${identity.id}@1`;
		await command(manager, ["manager", "select", "--use", identity.id, "--snapshot", selected, "--config-snapshot", selected]);
		stage = "manager-path"; const paths = JSON.parse(await command(manager, ["manager", "path", "--json"]));
		assert.equal(paths.effective.runtime.id, identity.id); assert.equal(paths.effective.plugins.id, selected); assert.equal(paths.effective.config.id, selected);
		config = paths.effective.config.path; const plugins = paths.effective.plugins.path;
		assert.equal(config, join(configStore, selected)); assert.equal(plugins, join(data, "snapshots", selected));
		stage = "inspect-before-first-use"; const beforeACL = inspect(stage);
		// Authored inputs only on actual manager-created P. Never write C or its metadata.
		stage = "author-profile-on-P";
		const pd = join(plugins, "profiles/first-use"), pkg = join(pd, "node_modules/first-use-probe"); mkdirSync(pkg, { recursive: true });
		writeFileSync(join(pd, "package.json"), JSON.stringify({ name: "first-use-profile", private: true, dependencies: { "first-use-probe": "1.0.0" }, dsh: { profile: { bundles: ["first-use-probe"] } } }));
		writeFileSync(join(pd, "pnpm-workspace.yaml"), "packages:\n  - .\nnodeLinker: hoisted\n");
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "first-use-probe", version: "1.0.0", type: "module", main: "index.js", dsh: { bundle: { patch: "cordis.patch.yml" } } }));
		writeFileSync(join(pkg, "index.js"), probe);
		writeFileSync(join(pkg, "cordis.patch.yml"), "- insert:\n    - id: config-editor\n      name: '@deepseek-ai/dsh-config-editor'\n    - id: settings\n      name: '@deepseek-ai/dsh-settings'\n    - id: credentials-local\n      name: '@deepseek-ai/dsh-credentials-local'\n    - id: first-use\n      name: first-use-probe\n");
		stage = "runtime-first-use"; const stdout = await command(manager, ["--profile", "first-use"], {}, 60_000);
		const line = stdout.split("\n").find(l => l.startsWith("FIRST_USE_REPORT ")); assert(line, "authentic profile report missing");
		const report = JSON.parse(line.slice("FIRST_USE_REPORT ".length));
		assert.equal(report.launch.manager, "0.0.0-first-use"); assert.equal(report.launch.protocol, 2); assert.equal(report.launch.runtime, identity.id);
		assert.equal(report.launch.dataRoot, data); assert.equal(report.launch.home, join(data, "home"));
		assert.deepEqual(report.launch.snapshot, { id: selected, dir: plugins }); assert.deepEqual(report.launch.configSnapshot, { id: selected, dir: config });
		assert.equal(report.exe, join(data, "bundles", identity.id, "dsh-native.exe"));
		assert.equal(report.before.label, "first-use-default"); assert.equal(report.before.credentialMissing, true);
		assert.equal(report.after.label, "first-use-written"); assert.equal(report.after.credentialMatches, true);
		assert.equal(report.after.patch, join(config!, "profiles/first-use/cordis.patch.yml")); assert.equal(report.after.credentialFile, join(config!, ".credentials.yaml"));
		assert.equal(report.after.home, report.launch.home); assert.equal(report.after.dir, pd);
		stage = "inspect-after-first-use"; const afterACL = inspect(stage);
		for (const p of [report.after.patch, report.after.credentialFile]) assert(afterACL.objects.some(o => o.path === p), `service output missing: ${p}`);
		assert(readFileSync(report.after.patch, "utf8").includes("first-use-written"), "settings change not persisted");
		assert(readFileSync(report.after.credentialFile, "utf8").includes("synthetic-first-use"), "synthetic provider change not persisted");
		assert.equal(fileHash(join(data, "bundles", identity.id, "dsh-native.exe")), nativeSHA);
		save("first-use-result.json", { status: "DIAGNOSTIC_FIRST_USE_PASSED", report, beforeACL, afterACL, productionWindowsManagedGate: "closed", lifecycle: "NOT RUN", combinedArtifactAcceptance: false });
		console.log("DIAGNOSTIC_FIRST_USE_PASSED; production gate closed; lifecycle NOT RUN");
	}
} catch (error) {
	const failure: Record<string, unknown> = { stage, message: (error as Error).message, nativeStatus: checkOnly ? "NOT RUN" : "FAILED", productionWindowsManagedGate: "closed", lifecycle: "NOT RUN", noRepairOrAlternateLaunch: true };
	if (!checkOnly && powershell) {
		try {
			const metadata = inspect("first-failure-acl"); failure.acl = metadata;
			const object = metadata.objects.find(o => o.path === config);
			if (stage === "runtime-first-use") {
				const stdout = readFileSync(join(root, "runtime-first-use.stdout"), "utf8"), stderr = readFileSync(join(root, "runtime-first-use.stderr"), "utf8");
				const profileStages = stdout.split("\n").filter(l => l.startsWith("FIRST_USE_STAGE ")), boundary = stderr.includes("DSH_CONFIG_BOUNDARY") || stderr.includes("configuration path violates selected configuration boundary");
				failure.refusalEvidence = { command: "actual manager --profile first-use", lastProfileStage: profileStages.at(-1) ?? "profile not reached", boundary, refusalStage: profileStages.length ? profileStages.at(-1) : boundary ? "entry startup / installConfigPaths before upstream runCli and profile boot" : "unclassified; inspect original stdout/stderr", bootstrapSite: "unchanged app.ts: installConfigPaths before upstream runCli; candidate removes only later fail-closed gate" };
				if (JSON.parse(readFileSync(join(root, "runtime-first-use.json"), "utf8")).timedOut) failure.timeoutRisk = "manager killed and pipes closed; runtime descendant may survive until runner cleanup. No alternate launcher or job changes used.";
				if (object && object.owner !== object.user) failure.ownerPolicyObservation = "C root owner differs from current SID; Windows private-access requires equality. No owner/token/ACL adjustment made. Owner mismatch is an observed policy conflict, not proof it was the only failing check.";
			}
		} catch (inspectionError) { failure.inspectionError = (inspectionError as Error).message; }
	}
	save("first-failure.json", failure); console.error(`FIRST_FAILURE ${stage}: ${(error as Error).message}`); process.exitCode = 1;
} finally {
	server?.stop(true); save("http-requests.json", requests);
}
