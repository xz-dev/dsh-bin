// scripts/build-addon.mjs: one ZIP per addon platform, engine bytes checked against the lockfile sha512.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAddon, tarballUrl } from "../../scripts/build-addon.mjs";
import { extractZip } from "../../runtime/zip.ts";

const unzip = (zip: string) => {
	const dest = mkdtempSync(join(tmpdir(), "build-addon-x-"));
	const names = extractZip(zip, dest).map((e) => e.name);
	return { dest, names };
};

const KIT = "@deepseek-ai/libreoffice-kit";
const slot = { commit: "e".repeat(40), kitVersion: "0.1.1" };
const identity = { version: "0.1.1-xz.1.1.gdeadbeef", tag: "dsh-addon-office-v0.1.1-xz.1.1.gdeadbeef", slot };

async function tarball(name: string) {
	const files = { "package/package.json": JSON.stringify({ name, version: "0.1.1" }), "package/engine.bin": `engine ${name}` };
	return new Uint8Array(await new Bun.Archive(files, { compress: "gzip" }).bytes());
}
const integrity = (b: Uint8Array) => `sha512-${createHash("sha512").update(b).digest("base64")}`;

async function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "build-addon-"));
	const tree = join(dir, "tree");
	mkdirSync(join(tree, "node_modules", KIT), { recursive: true });
	mkdirSync(join(tree, "node_modules", `${KIT}-wasm`), { recursive: true });
	writeFileSync(join(tree, "node_modules", KIT, "package.json"), JSON.stringify({ name: KIT, version: "0.1.1" }));
	writeFileSync(join(tree, "node_modules", `${KIT}-wasm`, "stale"), "from deploy");
	writeFileSync(join(tree, "addon.json"), JSON.stringify({ name: "office", kitVersion: "0.1.1", packages: [`${KIT}@0.1.1`, `${KIT}-wasm@0.1.1`] }));
	const bytes: Record<string, Uint8Array> = {};
	const office: Record<string, { version: string; integrity: string }> = { [KIT]: { version: "0.1.1", integrity: "sha512-x" } };
	for (const s of ["wasm", "darwin-arm64", "darwin-x64", "win32-x64", "win32-arm64"]) {
		const name = `${KIT}-${s}`;
		bytes[tarballUrl(name, "0.1.1")] = await tarball(name);
		office[name] = { version: "0.1.1", integrity: integrity(bytes[tarballUrl(name, "0.1.1")]!) };
	}
	const fetched: string[] = [];
	const fetchBytes = async (url: string) => (fetched.push(url), bytes[url]!);
	return { dir, tree, office, bytes, fetched, fetchBytes };
}

test("five platform zips, each with exactly one engine and the release identity", async () => {
	const f = await fixture();
	const m = await buildAddon({ tree: f.tree, office: f.office, out: join(f.dir, "out"), identity, fetchBytes: f.fetchBytes });
	expect(Object.keys(m.assets).sort()).toEqual(["darwin-arm64", "darwin-x64", "linux", "windows-arm64", "windows-x64"]);
	expect(f.fetched.every((u) => u.startsWith("https://registry.npmjs.org/@deepseek-ai/libreoffice-kit-"))).toBe(true);
	const { dest, names } = unzip(join(f.dir, "out", "dsh-addon-office-windows-x64.zip"));
	expect(names).toContain(`node_modules/${KIT}-win32-x64/engine.bin`);
	expect(names.some((n) => n.includes(`${KIT}-wasm`))).toBe(false);
	const meta = JSON.parse(readFileSync(join(dest, "addon.json"), "utf8"));
	expect(meta).toMatchObject({ name: "office", version: identity.version, tag: identity.tag, slot, platform: "windows-x64" });
	expect(meta.packages).toEqual([`${KIT}-win32-x64@0.1.1`, `${KIT}@0.1.1`]);
	const linux = unzip(join(f.dir, "out", "dsh-addon-office-linux.zip")).names;
	expect(linux).toContain(`node_modules/${KIT}-wasm/engine.bin`);
	expect(linux).not.toContain(`node_modules/${KIT}-wasm/stale`);
	expect(m.assets.linux!.sha256).toBe(createHash("sha256").update(readFileSync(join(f.dir, "out", "dsh-addon-office-linux.zip"))).digest("hex"));
});

test("an engine tarball that does not match the lockfile integrity aborts the build", async () => {
	const f = await fixture();
	f.office[`${KIT}-wasm`]!.integrity = integrity(new Uint8Array([1]));
	await expect(buildAddon({ tree: f.tree, office: f.office, out: join(f.dir, "out"), identity, platforms: ["linux"], fetchBytes: f.fetchBytes })).rejects.toThrow("integrity mismatch");
});

test("a slot whose kit differs from the tree is rejected", async () => {
	const f = await fixture();
	await expect(buildAddon({ tree: f.tree, office: f.office, out: join(f.dir, "out"), identity: { ...identity, slot: { ...slot, kitVersion: "0.1.2" } }, platforms: ["linux"], fetchBytes: f.fetchBytes })).rejects.toThrow("slot kit");
});
