// Packaged acceptance (release-distribution "Packaged acceptance before publication"): real archives, the
// real root launcher, a fixture index origin, and a PATH without any JavaScript runtime. Installs the
// previous bundle like a user unpacking the ZIP, then: headless boot (first empty snapshot), a GitHub
// plugin into that snapshot, the read-only check, a second version side by side with a copied snapshot,
// `--use`/`--snapshot` boots, a `select` pin, every addon's install/boot/uninstall/boot cycle, `clean`,
// same-version `--force`, uninstalling the running version, and a managed install (`--use` refused,
// `--snapshot` works). Asserts exit codes, directory state and recorded requests.
// usage: bun scripts/e2e.mjs <index.json> <assets-dir> [--work dir] [--keep] [--no-plugin]
//   <assets-dir> holds every indexed asset as `<tag>/<asset-name>` or `<tag>-<asset-name>`.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { degradationDetail, OFFICE_PACKAGES, officeDegradations } from "../runtime/compat/degradations.ts";
import { ADDON_NAMES } from "../runtime/layout.ts";
import { makeReadOnly, makeWritable } from "../runtime/readonly.ts";
import { extractZip } from "../runtime/zip.ts";
import { hostTargetId, target } from "./targets.mjs";

const MARKER = /DSH_BIN_LAUNCHER_VERSION=([^\0\n]+)/;

/**
 * Per addon: the plugins it provides and the declared degradation they show when it is not installed.
 * Every name in ADDON_NAMES must have a probe, so a new addon cannot ship untested (8.9).
 */
export const ADDON_PROBES = {
	office: { packages: OFFICE_PACKAGES, missing: officeDegradations("the office addon is not installed; run `dsh install --addon office`") },
};

/** `id (package): detail` lines of dsh's "did not activate" startup warning. */
export function inactiveLines(output) {
	const lines = output.split(/\r?\n/);
	const start = lines.findIndex((l) => / did not activate$/.test(l));
	if (start < 0) return [];
	const out = [];
	for (const line of lines.slice(start + 1)) {
		if (!/^\S+ \(@?[^)]+\): /.test(line)) break;
		out.push(line);
	}
	return out;
}

const pluginId = (pkg) => pkg.replace(/^@deepseek-ai\/dsh-/, "");

/** Serve `index.json` and `/download/<tag>/<name>` from `assets`, recording every request path. */
export function serveFixture(indexPath, assets) {
	const requests = [];
	const file = (tag, name) => [join(assets, tag, name), join(assets, `${tag}-${name}`)].find((p) => existsSync(p));
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			const path = decodeURIComponent(new URL(req.url).pathname);
			requests.push(path);
			if (path === "/index.json") return new Response(Bun.file(indexPath));
			const m = /^\/download\/([^/]+)\/([^/]+)$/.exec(path);
			const f = m && file(m[1], m[2]);
			return f ? new Response(Bun.file(f)) : new Response("not found", { status: 404 });
		},
	});
	return { origin: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
}

/** A PATH directory with only git and sh (POSIX) — no node, no bun. */
function noJsPath(dir) {
	mkdirSync(dir, { recursive: true });
	for (const tool of ["git", "sh"]) {
		const found = Bun.which(tool);
		if (found && !existsSync(join(dir, tool))) symlinkSync(found, join(dir, tool));
	}
	return dir;
}

/** Windows: the runner's PATH minus every directory holding a JavaScript runtime (Git's sh stays). */
const noJsWinPath = () => process.env.PATH.split(";").filter((d) => d && !["node.exe", "bun.exe", "deno.exe"].some((x) => existsSync(join(d, x)))).join(";");

/**
 * `corruptAddon`: self-test of the addon check. After install, break the installed addon's first package
 * entry point (a published addon whose hashes match but whose content is broken), so acceptance must fail.
 */
export const E2E_PLUGIN = { spec: "github:xz-dev/dsh-caveman", name: "dsh-caveman" };

export async function e2e({ index: indexPath, assets, work, keep = false, log = console.log, targetId = hostTargetId(), corruptAddon = false, channel, plugin = E2E_PLUGIN }) {
	// The matrix target, not the host default: baseline and modern x64 share a runner.
	const t = target(targetId);
	if (hostTargetId().replace(/-(baseline|modern)$/, "") !== t.id.replace(/-(baseline|modern)$/, "")) throw new Error(`e2e for ${t.id} must run on its native host (this is ${hostTargetId()})`);
	const idx = JSON.parse(readFileSync(indexPath, "utf8"));
	// The candidate's channel: guessing from the index breaks as soon as both channels have entries.
	channel ??= idx.channels.release.some((e) => e.assets[t.id]) ? "release" : "live";
	if (channel !== "release" && channel !== "live") throw new Error(`unknown channel ${channel}`);
	const list = idx.channels[channel].filter((e) => e.assets[t.id]).sort((a, b) => a.seq - b.seq);
	if (!list.length) throw new Error(`e2e needs a ${channel} bundle for ${t.id} in the index`);
	// First publication of a channel: there is no previous version, so the update step is skipped and
	// the single candidate goes through every other check.
	const single = list.length === 1;
	const [v1, v2] = single ? [list[0], list[0]] : [list.at(-2), list.at(-1)];
	work ??= mkdtempSync(join(tmpdir(), "dsh-e2e-"));
	const root = join(work, "root");
	const home = join(work, "home");
	mkdirSync(home, { recursive: true });
	const srv = serveFixture(indexPath, assets);
	const exe = join(root, t.os === "windows" ? "dsh.exe" : "dsh");
	const env = { PATH: t.os === "windows" ? noJsWinPath() : noJsPath(join(work, "path")), HOME: home, USERPROFILE: home, DSH_HOME: join(home, ".dsh"), NO_COLOR: "1", DSH_BIN_TEST: "1", DSH_BIN_TEST_ORIGIN: srv.origin };
	for (const k of ["TMPDIR", "TEMP", "TMP", "SystemRoot", "LANG"]) if (process.env[k]) env[k] = process.env[k];
	// Async spawn: the fixture server runs in this process and must keep serving meanwhile.
	const run = async (args, extra = {}) => {
		const p = Bun.spawn([exe, ...args], { cwd: home, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
		const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
		const out = `${o}${e}`;
		log(`$ dsh ${args.join(" ")}  -> ${code}\n${out.trimEnd().replace(/^/gm, "  ")}`);
		return { code, out };
	};
	const check = (cond, what) => {
		if (!cond) throw new Error(`e2e: ${what}`);
	};
	const marker = () => MARKER.exec(readFileSync(exe, "latin1"))?.[1];
	const bundles = () => readdirSync(join(root, "bundles")).filter((n) => !n.startsWith("."));
	const snapshotDir = (version, n) => join(env.DSH_HOME, "snapshots", `${version}@${n}`);
	try {
		for (const js of ["node", "bun", "deno"]) check(!Bun.which(js, { PATH: env.PATH }), `${js} must not be on the E2E PATH`);
		// Manual install of V1: unzip, read-only bundle tree.
		const v1Asset = v1.assets[t.id].name;
		const zip = [join(assets, v1.tag, v1Asset), join(assets, `${v1.tag}-${v1Asset}`)].find((p) => existsSync(p));
		extractZip(zip, root);
		makeReadOnly(join(root, "bundles", v1.version));
		check(marker() === v1.version, `fresh install launcher marker is ${marker()}`);

		let r = await run(["--version"]);
		check(r.code === 0, "--version failed");
		// The first launch of a version with no snapshot creates its first (empty) one.
		check(r.out.includes(`Created plugin snapshot ${v1.version}@1 (empty)`), "the first launch creates an empty snapshot");
		// The launcher help is upstream's, followed by the dsh-bin commands.
		r = await run(["--help"]);
		check(
			r.code === 0 &&
				r.out.includes("--profile <name>") &&
				r.out.includes("dsh-bin commands") &&
				["dsh select ", "dsh snapshot ", "dsh install <version>", "dsh install --addon", "dsh --use <version|latest>"].every((s) => r.out.includes(s)),
			"dsh --help must list upstream and dsh-bin commands (select, snapshot, install <version>, --use)",
		);
		// Headless boot of a shipped profile (plugins mounted, no Node on PATH) on that snapshot; it seeds the
		// bundle's prebuilt transpiler cache.
		const cache = join(home, "xdg-cache");
		r = await run(["--profile", "e2e", "--from-default-profile", "headless", "--help"], { XDG_CACHE_HOME: cache, LOCALAPPDATA: cache });
		check(r.code === 0 && /Answer one task/.test(r.out), "headless profile boot");
		check(existsSync(join(snapshotDir(v1.version, 1), "profiles", "e2e", "package.json")), "the headless runtime lives in the snapshot");
		check(!existsSync(join(env.DSH_HOME, "profiles", "e2e", "package.json")), "no runtime file in $DSH_HOME/profiles");
		const seeded = [join(cache, "dsh-bin", "transpiler"), join(cache, "dsh-bin", "cache", "transpiler"), join(home, "Library", "Caches", "dsh-bin", "transpiler")].find((d) => existsSync(d));
		check(seeded && readdirSync(seeded).some((n) => n.startsWith(".seeded-")) && readdirSync(seeded).length > 100, `transpiler cache seeded (${seeded})`);

		// A GitHub-hosted plugin lands in the resolved snapshot (embedded pnpm, only git and sh on PATH).
		if (plugin) {
			r = await run(["plugin", "--profile", "e2e", "add", plugin.spec]);
			// The test plugin's peer dependencies pin one dsh release line; on another, upstream rejects it and
			// prints its own risk-acceptance command. Taking that path still proves where the plugin lands.
			const allow = /run: dsh (plugin --profile e2e allow-version \S+ --dsh-version \S+ --accept-risk)/.exec(r.out)?.[1];
			if (r.code !== 0 && allow) {
				check((await run(allow.split(" "))).code === 0, `plugin ${allow}`);
				r = await run(["plugin", "--profile", "e2e", "add", plugin.spec]);
			}
			check(r.code === 0, `plugin add ${plugin.spec}`);
			check(existsSync(join(snapshotDir(v1.version, 1), "profiles", "e2e", "node_modules", plugin.name, "package.json")), "the plugin is installed in the snapshot");
			check(!existsSync(join(env.DSH_HOME, "profiles", "e2e", "node_modules")), "the plugin is not installed in $DSH_HOME/profiles");
		}

		// Read-only runtime: the running bundle cannot be written (upstream's self-updaters fail on it). Root
		// (the musl accept runs in a container as root) bypasses permission bits, so only the modes are checked.
		const bundleDir = join(root, "bundles", v1.version);
		if (process.getuid?.() === 0) {
			check((statSync(bundleDir).mode & 0o222) === 0, "the installed bundle must be read-only (mode)");
		} else {
			const probe = join(bundleDir, ".e2e-write-probe");
			let writable = true;
			try {
				writeFileSync(probe, "");
				rmSync(probe);
			} catch {
				writable = false;
			}
			check(!writable, "the installed bundle must be read-only");
		}

		r = await run(["update", "--models"]);
		check(r.code === 1 && /Unknown option --models/.test(r.out), "update --models must be rejected");
		r = await run(["update", "--clean"]);
		check(r.code === 1 && /Unknown option --clean/.test(r.out), "update --clean must be rejected");
		r = await run(["list", "--json"]);
		check(r.code === 0 && JSON.parse(r.out).channels.find((c) => c.channel === channel).newest === v2.version, "list must show the newest version");

		if (!single) {
			// A second version installs next to the first; nothing switches, the launcher marker is its own.
			const before = srv.requests.length;
			r = await run(["update"]);
			check(r.code === 0 && r.out.includes(`Updated dsh from ${v1.version} to ${v2.version}`), "update V1 -> V2");
			check(srv.requests.slice(before).every((p) => p === "/index.json" || p.startsWith(`/download/${v2.tag}/`)), "update requested something other than the index and the new asset");
			check(bundles().sort().join() === [v1.version, v2.version].sort().join(), `both versions installed (${bundles().join()})`);
			check(r.out.includes(`Created plugin snapshot ${v2.version}@1 (copy of ${v1.version}@1)`), "the new version's snapshot is copied from the first");
			if (plugin) check(existsSync(join(snapshotDir(v2.version, 1), "profiles", "e2e", "node_modules", plugin.name, "package.json")), "the copied snapshot has the plugin");
			// A plain launch now starts the newest version (`--use latest`); --use and --snapshot pick others.
			r = await run(["--profile", "e2e", "--help"]);
			check(r.code === 0 && /Answer one task/.test(r.out), "V2 boots by default");
			r = await run(["--use", v2.version, "--profile", "e2e", "--help"]);
			check(r.code === 0 && /Answer one task/.test(r.out), "--use V2 boots");
			r = await run(["--snapshot", `${v1.version}@1`, "--profile", "e2e", "--help"]);
			check(r.code === 0 && /Answer one task/.test(r.out) && !r.out.includes("Created plugin snapshot"), "--snapshot V1@1 boots V1 on its snapshot");
			// Pin V1: plain launches and maintenance see it; update never switches.
			r = await run(["select", "--use", v1.version]);
			check(r.code === 0 && r.out.includes(`Selected --use ${v1.version}.`), "select --use V1");
			r = await run(["list", "--json"]);
			const listed = JSON.parse(r.out).dsh.installed;
			check(listed.find((b) => b.version === v1.version)?.selected && listed.find((b) => b.version === v2.version)?.latest, "list marks V1 selected and V2 latest");
			r = await run(["select"]);
			check(r.code === 0 && r.out.includes(`version:  ${v1.version}`), "a plain launch now resolves to V1");
			r = await run(["select", "--use", "latest"]);
			check(r.code === 0, "select --use latest");
		}
		r = await run(["update"]);
		check(r.code === 0 && /already up to date/.test(r.out), "second update must be a no-op");
		for (const argv of [["update", "self"], ["update", "dsh"], ["update", "--self"]]) {
			r = await run(argv);
			check(r.code === 0 && /already up to date/.test(r.out), `${argv.join(" ")} must be up to date`);
		}
		r = await run(["list"]);
		check(r.code === 0 && r.out.includes(v2.version) && r.out.includes("selection: --use latest"), "list must show the installed version and the selection");
		r = await run(["update", "--help"]);
		check(r.code === 0 && r.out.includes("dsh update [self|dsh]"), "update --help");
		const other = channel === "release" ? "live" : "release";
		// Switching needs the other channel's asset in the fixture; the switch itself is covered by the
		// update contract, so only the refusal for an empty channel is checked here.
		if (!idx.channels[other].some((e) => e.assets[t.id])) {
			r = await run(["update", "--channel", other]);
			check(r.code === 1 && r.out.includes(other), `--channel ${other}`);
		}

		// 8.9: every addon in this bundle's slot is installed, proven enabled at boot, uninstalled and
		// proven degraded again. A headless task without credentials activates every plugin, then stops.
		const missingProbe = ADDON_NAMES.filter((n) => !ADDON_PROBES[n]);
		check(!missingProbe.length, `no acceptance probe for addon(s) ${missingProbe.join(", ")}`);
		let probes = 0;
		const bootInactive = async (name) => {
			// A fresh $DSH_HOME per boot: the probe profile is created from the shipped headless one in its
			// first snapshot, with the addon's plugins inserted through the shared cordis.patch.yml.
			const dshHome = join(home, `addon-${name}-${++probes}-dsh`);
			const dir = join(dshHome, "profiles", "probe");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "cordis.patch.yml"), `- insert:\n${ADDON_PROBES[name].packages.map((p) => `    - id: ${pluginId(p)}\n      name: '${p}'\n`).join("")}`);
			const b = await run(["--profile", "probe", "--from-default-profile", "headless", "hi"], { DSH_HOME: dshHome });
			check(b.code === 1 && b.out.includes("MISSING_CREDENTIAL"), `${name} probe boot must reach the credential check`);
			const ids = new Set(ADDON_PROBES[name].packages.map(pluginId));
			return inactiveLines(b.out).filter((l) => ids.has(l.split(" ")[0])).sort();
		};
		for (const name of ADDON_NAMES) {
			const table = v2.addons?.[name];
			if (!table?.slot) continue;
			check(!!table.pinned, `${name}: bundle ${v2.version} has slot ${table.slot.commit} but no addon`);
			r = await run(["install", "--addon", name]);
			const v = /Installed the \S+ addon (\S+?)\.?(?:\s|$)/.exec(r.out)?.[1];
			check(r.code === 0 && !!v && existsSync(join(root, "addons", name, v)), `${name}: install`);
			check(!existsSync(join(root, "addons.json")), `${name}: no addons.json`);
			if (corruptAddon) {
				const dir = join(root, "addons", name, v);
				makeWritable(dir);
				const scope = join(dir, "node_modules", "@deepseek-ai");
				const pkg = join(scope, readdirSync(scope).sort()[0]);
				const main = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
				const entry = typeof main.exports === "string" ? main.exports : (main.exports?.["."]?.import ?? main.exports?.["."]?.default ?? main.exports?.["."] ?? main.main ?? "index.js");
				writeFileSync(join(pkg, typeof entry === "string" ? entry : "index.js"), "throw new Error('corrupted by e2e --corrupt-addon');\n");
				log(`e2e: corrupted ${pkg}`);
			}
			const enabled = await bootInactive(name);
			check(!enabled.length, `${name}: installed addon must be enabled at boot, but: ${enabled.join(" | ")}`);
			r = await run(["install", "--addon", `${name}:${v}`]);
			check(r.code === 0 && /already installed/.test(r.out), `${name}: install ${name}:${v} again is a no-op`);
			r = await run(["list", "--addon", name, "--json"]);
			check(r.code === 0 && JSON.parse(r.out).addons[0].installed.some((a) => a.version === v), `${name}: list shows the installed version`);
			r = await run(["uninstall", "--addon", name]);
			check(r.code === 0 && !existsSync(join(root, "addons", name, v)), `${name}: uninstall`);
			const expected = ADDON_PROBES[name].missing.map((d) => `${pluginId(d.packageName)} (${d.packageName}): ${degradationDetail(d)}`).sort();
			const degraded = await bootInactive(name);
			check(JSON.stringify(degraded) === JSON.stringify(expected), `${name}: uninstalled addon must show the declared degradation, got: ${degraded.join(" | ")}`);
		}

		const offline = await run(["list"], { DSH_BIN_TEST_ORIGIN: "http://127.0.0.1:1" });
		check(offline.code === 0 && /warning: could not read the release index/.test(offline.out), "offline list must warn and exit 0");

		const cleanFrom = srv.requests.length;
		const kept = bundles().sort().join();
		r = await run(["clean"]);
		check(r.code === 0 && bundles().sort().join() === kept, `clean must keep every installed version (left ${bundles().join()})`);
		check(srv.requests.length === cleanFrom, "clean made a request");

		r = await run(["update", "--force"]);
		check(r.code === 0 && r.out.includes(`Installed dsh ${v2.version}`) && bundles().includes(v2.version), "same-version --force");
		if (!single) {
			// The version that runs the command (the newest) can be uninstalled; its snapshots are kept.
			r = await run(["uninstall", v2.version]);
			check(r.code === 0 && bundles().join() === v1.version, `uninstall the running version (left ${bundles().join()})`);
			check(existsSync(join(snapshotDir(v2.version, 1), "snapshot.json")), "uninstall keeps the snapshots");
			r = await run(["--version"]);
			check(r.code === 0, "the remaining version starts");
		}

		// Managed install: --use is refused before anything runs, --snapshot still works, update is refused.
		makeWritable(root);
		writeFileSync(join(root, ".portage.managed.lock"), "");
		const managedFrom = srv.requests.length;
		r = await run(["update"]);
		check(r.code === 1 && /managed by portage/.test(r.out) && srv.requests.length === managedFrom, "managed refusal");
		r = await run(["--use", "latest", "--version"]);
		check(r.code !== 0 && /--use is not available: the dsh version and addons are managed by portage/.test(r.out), "managed --use refusal");
		r = await run(["--snapshot", `${v1.version}@1`, "--profile", "e2e", "--help"]);
		check(r.code === 0 && /Answer one task/.test(r.out), "managed --snapshot boot");
		rmSync(join(root, ".portage.managed.lock"));
		log(`e2e: ok (${t.id}, ${channel} ${single ? `${v2.version}, first publication` : `${v1.version} -> ${v2.version}`})`);
	} finally {
		srv.stop();
		if (!keep) {
			try {
				makeWritable(work);
			} catch {}
			rmSync(work, { recursive: true, force: true });
		}
	}
}

if (import.meta.main) {
	const [index, assets, ...rest] = process.argv.slice(2);
	if (!index || !assets) throw new Error("usage: e2e.mjs <index.json> <assets-dir> [--work dir] [--target id] [--channel c] [--keep] [--corrupt-addon] [--no-plugin]");
	const opt = (k) => (rest.includes(k) ? rest[rest.indexOf(k) + 1] : undefined);
	await e2e({ index: resolve(index), assets: resolve(assets), work: opt("--work") ? resolve(opt("--work")) : undefined, keep: rest.includes("--keep"), targetId: opt("--target"), corruptAddon: rest.includes("--corrupt-addon"), channel: opt("--channel"), plugin: rest.includes("--no-plugin") ? null : E2E_PLUGIN });
}
