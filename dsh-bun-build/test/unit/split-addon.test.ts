import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitOfficeAddon } from "../../scripts/split-addon.mjs";

const pkg = (dir: string, manifest: object) => {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
};

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "split-addon-"));
	const app = join(root, "app");
	const nm = join(app, "node_modules");
	pkg(app, { name: "@deepseek-ai/dsh", dependencies: { "@deepseek-ai/dsh-skill-office": "*", shared: "*" } });
	pkg(join(nm, "@deepseek-ai/dsh-skill-office"), { name: "@deepseek-ai/dsh-skill-office", dependencies: { "@deepseek-ai/libreoffice-kit": "0.1.2" } });
	pkg(join(nm, "@deepseek-ai/libreoffice-kit"), {
		name: "@deepseek-ai/libreoffice-kit",
		version: "0.1.2",
		dependencies: { privy: "1", shared: "*" },
		optionalDependencies: { "@deepseek-ai/libreoffice-kit-wasm": "0.1.1", "@deepseek-ai/libreoffice-kit-win32-x64": "0.1.2" },
	});
	pkg(join(nm, "@deepseek-ai/libreoffice-kit-wasm"), { name: "@deepseek-ai/libreoffice-kit-wasm", version: "0.1.1" });
	pkg(join(nm, "privy"), { name: "privy", version: "1.0.0", dependencies: { deep: "*" } });
	pkg(join(nm, "privy/node_modules/deep"), { name: "deep", version: "2.0.0" });
	pkg(join(nm, "shared"), { name: "shared", version: "3.0.0" });
	return { app, addon: join(root, "addon-office") };
}

test("splitOfficeAddon moves the kit closure out and keeps shared packages in the app", () => {
	const { app, addon } = fixture();
	const meta = splitOfficeAddon(app, addon);
	expect(meta.kitVersion).toBe("0.1.2");
	expect(meta.packages).toEqual([
		"@deepseek-ai/libreoffice-kit-wasm@0.1.1",
		"@deepseek-ai/libreoffice-kit@0.1.2",
		"deep@2.0.0",
		"privy@1.0.0",
		"shared@3.0.0",
	]);
	for (const gone of ["@deepseek-ai/libreoffice-kit", "@deepseek-ai/libreoffice-kit-wasm", "privy"]) expect(existsSync(join(app, "node_modules", gone))).toBe(false);
	expect(existsSync(join(app, "node_modules/shared/package.json"))).toBe(true);
	expect(existsSync(join(addon, "node_modules/privy/node_modules/deep/package.json"))).toBe(true);
	expect(JSON.parse(readFileSync(join(addon, "addon.json"), "utf8")).kitVersion).toBe("0.1.2");
});

test("splitOfficeAddon fails when the kit is absent", () => {
	const { app, addon } = fixture();
	splitOfficeAddon(app, addon);
	expect(() => splitOfficeAddon(app, addon)).toThrow(/not in the deployed tree/);
});

test("splitOfficeAddon records the release identity and slot in addon.json", () => {
	const { app, addon } = fixture();
	const slot = { commit: "a".repeat(40), kitVersion: "0.1.2" };
	splitOfficeAddon(app, addon, { version: "0.1.2-b1.1.gabcdef12", tag: "addon-office-v0.1.2-b1.1.gabcdef12", slot });
	expect(JSON.parse(readFileSync(join(addon, "addon.json"), "utf8"))).toMatchObject({
		name: "office",
		version: "0.1.2-b1.1.gabcdef12",
		tag: "addon-office-v0.1.2-b1.1.gabcdef12",
		slot,
		kitVersion: "0.1.2",
	});
});
