// Assemble one target's install root (6.1, design D9):
//
//   <out>/dsh(.exe)
//   <out>/bundles/<version>/{dsh-native(.exe), app/, pnpm/, bin/, bundle.json, .usage.lock}
//
// Target native addons stay inside app/node_modules (upstream's own layout); other-platform prebuilds
// are pruned and every remaining native file must match the target. `bundle.json` carries the bundle
// identity, the required-path inventory and the embedded office compatibility table (D7b).
//
// usage: bun scripts/assemble-bundle.mjs <spec.json>
//   spec: {target, out, app, pnpm, native, launcher, identity:{version,tag,channel}, upstream:{commit,tag?,version},
//          launcherCommit, slot:{commit,kitVersion}|null, index?:<path to index.json snapshot>}
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, closeSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { binaryArch } from "./build-launcher.mjs";
import { writeShims } from "./shims.mjs";
import { target as targetById } from "./targets.mjs";

const FORMAT = { linux: "elf", darwin: "macho", windows: "pe" };
const PLATFORM_DIR = /^(linux|darwin|win32|win|windows|freebsd|android|openbsd|sunos|aix)[-_](x64|arm64|ia32|arm|x86_64|aarch64|ppc64|s390x|riscv64|loong64)(?:[-_](gnu|musl|glibc))?$/;

/**
 * Embedded office table: `known` is the index's `addons.office` list at build time; `pinned` is its
 * newest entry in `slot` (highest seq). A bundle whose slot has no addon pins nothing.
 */
export function officeTable(slot, index) {
	const known = (index?.addons?.office ?? []).map((e) => structuredClone(e));
	if (!slot) return { slot: null, pinned: null, known };
	const inSlot = known.filter((e) => e.slot?.commit === slot.commit).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
	return { slot, pinned: inSlot.at(-1)?.version ?? null, known };
}

const nodeOs = (t) => t.nodePlatform;

/**
 * Prune other-platform prebuild directories named `<os>-<arch>[-libc]` (node-pty `prebuilds/`, conpty
 * `third_party/.../win10-*`), keeping the target's own. Returns the removed paths (relative to `app`).
 */
export function prunePrebuilds(app, t) {
	const removed = [];
	const keep = (name) => {
		const m = PLATFORM_DIR.exec(name);
		if (!m) return true;
		const os = { win: "win32", windows: "win32" }[m[1]] ?? m[1];
		const arch = { x86_64: "x64", aarch64: "arm64" }[m[2]] ?? m[2];
		if (os !== nodeOs(t) || arch !== t.arch) return false;
		if (m[3] && t.os === "linux") return (m[3] === "musl") === (t.libc === "musl");
		return true;
	};
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (!lstatSync(path).isDirectory()) continue;
			if (!keep(name) || (name.startsWith("win10-") && !(t.os === "windows" && name === `win10-${t.arch}`))) {
				rmSync(path, { recursive: true, force: true });
				removed.push(relative(app, path));
			} else walk(path);
		}
	};
	walk(join(app, "node_modules"));
	return removed;
}

// pnpm's official asset ships Windows process-list helpers on every OS. They are dropped elsewhere; on
// Windows pnpm picks one by os.arch() (x86/x64, which run under WOW64 or arm64 emulation).
const PNPM_VENDOR = "pnpm/dist/vendor";
const WINDOWS_PNPM_HELPER = /^pnpm\/dist\/vendor\/fastlist-[0-9.]+-(x86|x64)\.exe$/;

/** Native executables/libraries under `dir` whose format or arch differs from `t`. */
export function foreignBinaries(dir, t) {
	const bad = [];
	const head = Buffer.alloc(4096);
	const walk = (d) => {
		for (const name of readdirSync(d)) {
			const path = join(d, name);
			const st = lstatSync(path);
			if (st.isDirectory()) walk(path);
			else if (st.isFile() && st.size >= 64) {
				const fd = openSync(path, "r");
				const n = readSync(fd, head, 0, head.length, 0);
				closeSync(fd);
				const got = binaryArch(head.subarray(0, n));
				const rel = relative(dir, path).split(sep).join("/");
				if (t.os === "windows" && WINDOWS_PNPM_HELPER.test(rel)) continue;
				if (got.format !== "unknown" && (got.format !== FORMAT[t.os] || got.arch !== t.arch)) bad.push(`${relative(dir, path)}: ${got.format}/${got.arch}`);
			}
		}
	};
	walk(dir);
	return bad;
}

/** Files every installed bundle of target `t` must have (checked by acceptance and by the updater). */
export function requiredPaths(t, version) {
	const b = `bundles/${version}`;
	const shims = t.os === "windows" ? ["bin/node.cmd", "bin/pnpm.cmd"] : ["bin/node", "bin/pnpm"];
	return [
		t.launcher,
		`${b}/${t.executable}`,
		`${b}/bundle.json`,
		`${b}/.usage.lock`,
		`${b}/app/package.json`,
		`${b}/app/lib/bin.js`,
		`${b}/pnpm/dist/pnpm.mjs`,
		...shims.map((s) => `${b}/${s}`),
	];
}

export function assembleBundle(spec) {
	const t = targetById(spec.target);
	const { version, tag, channel } = spec.identity;
	const out = spec.out;
	if (existsSync(out)) throw new Error(`output exists: ${out}`);
	const bundle = join(out, "bundles", version);
	mkdirSync(bundle, { recursive: true });

	cpSync(spec.launcher, join(out, t.launcher));
	chmodSync(join(out, t.launcher), 0o755);
	cpSync(spec.native, join(bundle, t.executable));
	chmodSync(join(bundle, t.executable), 0o755);
	cpSync(spec.app, join(bundle, "app"), { recursive: true, dereference: true });
	if (existsSync(join(bundle, "app/node_modules/@deepseek-ai/libreoffice-kit"))) throw new Error("app tree still contains the office kit; run split-addon first");
	cpSync(join(spec.pnpm, "dist"), join(bundle, "pnpm", "dist"), { recursive: true, dereference: true });
	if (t.os !== "windows") rmSync(join(bundle, PNPM_VENDOR), { recursive: true, force: true });
	writeShims(bundle, t.os);
	writeFileSync(join(bundle, ".usage.lock"), "");

	const pruned = prunePrebuilds(join(bundle, "app"), t);
	// Reviewed upstream postinstall that deploy --ignore-scripts skips: node-pty's macOS spawn-helper mode.
	if (t.os === "darwin") {
		const helper = join(bundle, "app/node_modules/node-pty/prebuilds", `darwin-${t.arch}`, "spawn-helper");
		if (existsSync(helper)) chmodSync(helper, 0o755);
	}
	const foreign = foreignBinaries(bundle, t);
	if (foreign.length) throw new Error(`native files for another target in ${t.id}:\n  ${foreign.join("\n  ")}`);

	const index = spec.index ? JSON.parse(readFileSync(spec.index, "utf8")) : { addons: { office: [] } };
	const required = requiredPaths(t, version);
	const meta = {
		schemaVersion: 1,
		name: "dsh-bin",
		version,
		tag,
		channel,
		target: t.id,
		upstream: spec.upstream,
		launcherCommit: spec.launcherCommit,
		addons: { office: officeTable(spec.slot ?? null, index) },
		requiredPaths: required,
	};
	writeFileSync(join(bundle, "bundle.json"), `${JSON.stringify(meta, null, 2)}\n`);
	const missing = required.filter((p) => !existsSync(join(out, p)));
	if (missing.length) throw new Error(`assembled bundle misses required paths: ${missing.join(", ")}`);
	return { out, bundle, meta, pruned: pruned.map((p) => p.split(sep).join("/")) };
}

if (import.meta.main) {
	const [specPath] = process.argv.slice(2);
	if (!specPath) throw new Error("usage: assemble-bundle.mjs <spec.json>");
	const r = assembleBundle(JSON.parse(readFileSync(specPath, "utf8")));
	console.log(JSON.stringify({ out: r.out, version: r.meta.version, pruned: r.pruned.length, requiredPaths: r.meta.requiredPaths.length }));
}
