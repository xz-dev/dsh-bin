import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { checkLockfile, OFFICE_ALLOWLIST, readLockfile } from "../../scripts/lockfile-guard.mjs";

const sha = "sha512-vML+3Nh/159k/TWuxLfZU1O39BA0m+/jybfySu9dJaTHR2oAi+hHWud6iRhBaCie5N6ADfo4DNHajBk52pmRog==";
const base = () => ({
	lockfileVersion: "9.0",
	overrides: { "@deepseek-ai/cosmokit": "link:vendor/cosmokit" },
	importers: { "apps/cli": { dependencies: { "@deepseek-ai/dsh-core": { specifier: "workspace:*", version: "link:../../packages/core" } } } },
	packages: { "@deepseek-ai/libreoffice-kit@0.1.1": { resolution: { integrity: sha } } },
});

test("source links and a pinned kit pass", () => {
	expect(checkLockfile(base()).office).toEqual({ "@deepseek-ai/libreoffice-kit": { version: "0.1.1", integrity: sha } });
});

test("registry-resolved first-party package fails", () => {
	const l = base();
	l.importers["apps/cli"].dependencies["@deepseek-ai/x"] = { specifier: "^1.0.0", version: "1.0.0" };
	l.packages["@deepseek-ai/x@1.0.0"] = { resolution: { integrity: sha } };
	expect(() => checkLockfile(l)).toThrow("@deepseek-ai/x resolves from a registry");
});

test("allowlisted kit without integrity (or via tarball) fails", () => {
	const l = base();
	l.packages["@deepseek-ai/libreoffice-kit@0.1.1"] = { resolution: { tarball: "https://evil/x.tgz" } };
	expect(() => checkLockfile(l)).toThrow("not pinned");
	l.packages["@deepseek-ai/libreoffice-kit@0.1.1"] = { resolution: { integrity: "sha1-abc" } };
	expect(() => checkLockfile(l)).toThrow("not pinned");
});

test("non-link first-party override fails", () => {
	const l = base();
	l.overrides["@deepseek-ai/cosmokit"] = "1.2.3";
	expect(() => checkLockfile(l)).toThrow("override");
});

const real = "work/src-rc2";
test.skipIf(!existsSync(`${real}/pnpm-lock.yaml`))("real dsh-v0.1.7-rc.2 lockfile passes with exactly the kit allowlist", () => {
	const { office } = checkLockfile(readLockfile(real));
	expect(Object.keys(office).sort()).toEqual([...OFFICE_ALLOWLIST].sort());
	for (const v of Object.values(office)) expect(v.version).toBe("0.1.1");
});
