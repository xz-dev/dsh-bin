// Packaged end-to-end check (8.2, port of pi's e2e-binary-self-update): real archives, the real root
// launcher, a fixture index origin, and a PATH without any JavaScript runtime. Installs the oldest
// listed bundle like a user unpacking the ZIP, then exercises update / list / addon / --clean / --force
// / managed refusal and asserts exit codes, launcher marker, directory state and recorded requests.
// usage: bun scripts/e2e.mjs <index.json> <assets-dir> [--work dir] [--keep]
//   <assets-dir> holds every indexed asset as `<tag>/<asset-name>` or `<tag>-<asset-name>`.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeReadOnly, makeWritable } from "../runtime/readonly.ts";
import { extractZip } from "../runtime/zip.ts";
import { hostTargetId, target } from "./targets.mjs";

const MARKER = /DSH_BIN_LAUNCHER_VERSION=([^\0\n]+)/;

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

export async function e2e({ index: indexPath, assets, work, keep = false, log = console.log }) {
	const t = target(hostTargetId());
	const idx = JSON.parse(readFileSync(indexPath, "utf8"));
	const channel = idx.channels.release.some((e) => e.assets[t.id]) ? "release" : "live";
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
		r = await run(["update", "--channel", other]);
		check(idx.channels[other].some((e) => e.assets[t.id]) ? r.code === 0 : r.code === 1 && r.out.includes(other), `--channel ${other}`);

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
	if (!index || !assets) throw new Error("usage: e2e.mjs <index.json> <assets-dir> [--work dir] [--keep]");
	const w = rest.indexOf("--work");
	await e2e({ index: resolve(index), assets: resolve(assets), work: w >= 0 ? resolve(rest[w + 1]) : undefined, keep: rest.includes("--keep") });
}
