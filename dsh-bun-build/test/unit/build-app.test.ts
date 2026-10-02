import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreClosure } from "../../scripts/build-app.mjs";

const pkg = (dir: string, manifest: object) => {
	mkdirSync(join(dir, "lib"), { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
	writeFileSync(join(dir, "lib/index.js"), "export {}\n");
};

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "build-app-"));
	const src = join(root, "src");
	const out = join(root, "out");
	writeFileSync(
		join(mkdirSync(src, { recursive: true }) ?? src, "pnpm-lock.yaml"),
		"lockfileVersion: '9.0'\nimporters:\n  apps/cli: {}\n  packages/a: {}\n  packages/peer: {}\n  packages/linux-only: {}\n",
	);
	pkg(join(src, "packages/a"), { name: "@x/a", dependencies: { "@x/peer-dep-of-a": "workspace:*" }, peerDependencies: { "@x/peer": "*" } });
	pkg(join(src, "packages/peer"), { name: "@x/peer" });
	pkg(join(src, "packages/linux-only"), { name: "@x/native", os: ["sunos"] });
	mkdirSync(join(src, "packages/a/node_modules/junk"), { recursive: true });
	pkg(out, { name: "@x/root", dependencies: { "@x/a": "workspace:*", third: "1" }, optionalDependencies: { "@x/native": "*" } });
	pkg(join(out, "node_modules/third"), { name: "third" });
	return { src, out };
}

test("restoreClosure copies omitted workspace deps and peers, skipping foreign-platform optionals", () => {
	const { src, out } = fixture();
	// @x/peer-dep-of-a is neither deployed nor a workspace package: a hard failure.
	expect(() => restoreClosure(src, out)).toThrow(/@x\/peer-dep-of-a \(of @x\/a\)/);
});

test("restoreClosure restores the full transitive closure", () => {
	const { src, out } = fixture();
	pkg(join(out, "node_modules/@x/peer-dep-of-a"), { name: "@x/peer-dep-of-a" });
	expect(restoreClosure(src, out).sort()).toEqual(["@x/a", "@x/peer"]);
	expect(existsSync(join(out, "node_modules/@x/a/lib/index.js"))).toBe(true);
	expect(existsSync(join(out, "node_modules/@x/a/node_modules"))).toBe(false);
	expect(existsSync(join(out, "node_modules/@x/native"))).toBe(false);
	expect(restoreClosure(src, out)).toEqual([]);
});
