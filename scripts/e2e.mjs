// Packaged end-to-end check (8.2, port of pi's e2e-binary-self-update): real archives, the real root
// launcher, a fixture index origin, and a PATH without any JavaScript runtime. Installs the oldest
// listed bundle like a user unpacking the ZIP, then exercises update / list / addon / --clean / --force
// / managed refusal and asserts exit codes, launcher marker, directory state and recorded requests.
// usage: bun scripts/e2e.mjs <index.json> <assets-dir> [--work dir] [--keep]
//   <assets-dir> holds every indexed asset as `<tag>/<asset-name>` or `<tag>-<asset-name>`.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

/**
 * `corruptAddon`: self-test of the addon check. After install, break the installed addon's first package
 * entry point (a published addon whose hashes match but whose content is broken), so acceptance must fail.
 */
export async function e2e({ index: indexPath, assets, work, keep = false, log = console.log, targetId = hostTargetId(), corruptAddon = false, channel }) {
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
	const env = { PATH: t.os === "windows" ? process.env.PATH : noJsPath(join(work, "path")), HOME: home, USERPROFILE: home, DSH_HOME: join(home, ".dsh"), NO_COLOR: "1", DSH_BIN_TEST: "1", DSH_BIN_TEST_ORIGIN: srv.origin };
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
	try {
		// Manual install of V1: unzip, read-only bundle tree.
		const v1Asset = v1.assets[t.id].name;
		const zip = [join(assets, v1.tag, v1Asset), join(assets, `${v1.tag}-${v1Asset}`)].find((p) => existsSync(p));
		extractZip(zip, root);
		makeReadOnly(join(root, "bundles", v1.version));
		check(marker() === v1.version, `fresh install launcher marker is ${marker()}`);

		let r = await run(["--version"]);
		check(r.code === 0, "--version failed");
		// The launcher help is upstream's, followed by the dsh-bin commands.
		r = await run(["--help"]);
		check(r.code === 0 && r.out.includes("--profile <name>") && r.out.includes("dsh-bin commands") && r.out.includes("dsh install --addon"), "dsh --help must list upstream and dsh-bin commands");
		// Headless boot of a shipped profile (plugins mounted, no Node on PATH); the first start seeds the
		// bundle's prebuilt transpiler cache into the launcher-chosen user cache.
		const cache = join(home, "xdg-cache");
		r = await run(["--profile", "e2e", "--from-default-profile", "headless", "--help"], { XDG_CACHE_HOME: cache, LOCALAPPDATA: cache, DSH_HOME: join(home, "boot-dsh") });
		check(r.code === 0 && /Answer one task/.test(r.out), "headless profile boot");
		const seeded = [join(cache, "dsh-bin", "transpiler"), join(cache, "dsh-bin", "cache", "transpiler"), join(home, "Library", "Caches", "dsh-bin", "transpiler")].find((d) => existsSync(d));
		check(seeded && readdirSync(seeded).some((n) => n.startsWith(".seeded-")) && readdirSync(seeded).length > 100, `transpiler cache seeded (${seeded})`);
		r = await run(["update", "--models"]);
		check(r.code === 1 && /Unknown option --models/.test(r.out), "update --models must be rejected");
		r = await run(["list", "--json"]);
		check(r.code === 0 && JSON.parse(r.out).channels.find((c) => c.channel === channel).newest === v2.version, "list must show the newest version");

		if (!single) {
			const before = srv.requests.length;
			r = await run(["update"]);
			check(r.code === 0 && r.out.includes(`Updated dsh from ${v1.version} to ${v2.version}`), "update V1 -> V2");
			check(marker() === v2.version, `launcher marker after update is ${marker()}`);
			check(srv.requests.slice(before).every((p) => p === "/index.json" || p.startsWith(`/download/${v2.tag}/`)), "update requested something other than the index and the new asset");
			check(!existsSync(env.DSH_HOME), "update created a profile directory");
			r = await run(["--version"]);
			check(r.code === 0, "the updated bundle does not start");
		}
		r = await run(["update"]);
		check(r.code === 0 && /already up to date/.test(r.out), "second update must be a no-op");
		for (const argv of [["update", "self"], ["update", "dsh"], ["update", "--self"], ["update", "--all"]]) {
			r = await run(argv);
			check(r.code === 0 && /already up to date/.test(r.out), `${argv.join(" ")} must be up to date`);
		}
		r = await run(["list"]);
		check(r.code === 0 && r.out.includes(v2.version), "list must show the installed version");
		r = await run(["update", "--help"]);
		check(r.code === 0 && r.out.includes("dsh update --clean"), "update --help");
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
		const bootInactive = async (name) => {
			const dshHome = join(home, `addon-${name}-dsh`);
			const dir = join(dshHome, "profiles", "probe");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "probe", private: true, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } } }));
			writeFileSync(join(dir, "cordis.patch.yml"), `- insert:\n${ADDON_PROBES[name].packages.map((p) => `    - id: ${pluginId(p)}\n      name: '${p}'\n`).join("")}`);
			const b = await run(["--profile", "probe", "hi"], { DSH_HOME: dshHome });
			check(b.code === 1 && b.out.includes("MISSING_CREDENTIAL"), `${name} probe boot must reach the credential check`);
			const ids = new Set(ADDON_PROBES[name].packages.map(pluginId));
			return inactiveLines(b.out).filter((l) => ids.has(l.split(" ")[0])).sort();
		};
		for (const name of ADDON_NAMES) {
			const table = v2.addons?.[name];
			if (!table?.slot) continue;
			check(!!table.pinned, `${name}: bundle ${v2.version} has slot ${table.slot.commit} but no addon`);
			const v = table.pinned;
			r = await run(["install", "--addon", name]);
			check(r.code === 0 && existsSync(join(root, "addons", name, v)), `${name}: install`);
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
			r = await run(["uninstall", "--addon", name]);
			check(r.code === 0 && !JSON.parse(readFileSync(join(root, "addons.json"), "utf8"))[name], `${name}: uninstall`);
			const expected = ADDON_PROBES[name].missing.map((d) => `${pluginId(d.packageName)} (${d.packageName}): ${degradationDetail(d)}`).sort();
			const degraded = await bootInactive(name);
			check(JSON.stringify(degraded) === JSON.stringify(expected), `${name}: uninstalled addon must show the declared degradation, got: ${degraded.join(" | ")}`);
		}

		const office = idx.addons?.office?.length && v2.addons?.office?.pinned;
		if (office) {
			r = await run(["install", "--addon", "office"]);
			check(r.code === 0 && existsSync(join(root, "addons", "office", office)), "addon install");
			r = await run(["list", "--addon", "office", "--json"]);
			check(r.code === 0 && JSON.parse(r.out).addons[0].installed?.version === office, "list must show the installed addon");
			r = await run(["install", "--addon", "office", "--version", office]);
			check(r.code === 0, "install --addon office --version <pinned>");
			r = await run(["update", "--addon", "office"]);
			check(r.code === 0 && existsSync(join(root, "addons", "office", office)), "update --addon office");
			r = await run(["update", "--all"]);
			check(r.code === 0, "update --all with an addon");
			r = await run(["uninstall", "--addon", "office"]);
			check(r.code === 0 && !JSON.parse(readFileSync(join(root, "addons.json"), "utf8")).office, "addon uninstall");
		}

		const offline = await run(["list"], { DSH_BIN_TEST_ORIGIN: "http://127.0.0.1:1" });
		check(offline.code === 0 && /warning: could not read the release index/.test(offline.out), "offline list must warn and exit 0");

		const cleanFrom = srv.requests.length;
		r = await run(["update", "--clean"]);
		check(r.code === 0 && bundles().join() === v2.version, `--clean left ${bundles().join()}`);
		check(srv.requests.length === cleanFrom, "--clean made a request");

		r = await run(["update", "--force"]);
		check(r.code === 0 && marker() === v2.version && bundles().join() === v2.version, "same-version --force");

		makeWritable(root);
		writeFileSync(join(root, ".portage.managed.lock"), "");
		const managedFrom = srv.requests.length;
		r = await run(["update"]);
		check(r.code === 1 && /managed by portage/.test(r.out) && srv.requests.length === managedFrom, "managed refusal");
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
	if (!index || !assets) throw new Error("usage: e2e.mjs <index.json> <assets-dir> [--work dir] [--target id] [--channel c] [--keep] [--corrupt-addon]");
	const opt = (k) => (rest.includes(k) ? rest[rest.indexOf(k) + 1] : undefined);
	await e2e({ index: resolve(index), assets: resolve(assets), work: opt("--work") ? resolve(opt("--work")) : undefined, keep: rest.includes("--keep"), targetId: opt("--target"), corruptAddon: rest.includes("--corrupt-addon"), channel: opt("--channel") });
}
