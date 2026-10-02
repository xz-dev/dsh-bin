import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gentooEbuild, gentooVersion } from "../scripts/gentoo-ebuild.mjs";

const TPL = readFileSync(join(import.meta.dir, "../packaging/gentoo/dsh-bin-9999.ebuild.in"), "utf8");
const asset = (name: string, c: string) => ({ name, size: 7, sha256: c.repeat(64) });
const entry = (version: string) => ({ version, tag: `manager-v${version}`, launchProtocols: [1], assets: {
	"linux-x64": asset("manager-linux-x64.zip", "1"), "linux-arm64": asset("manager-linux-arm64.zip", "2"),
} });

test("7.4: manager SemVer maps to Gentoo PV independently of runtime builds", () => {
	expect(gentooVersion("1.2.0-rc.2")).toBe("1.2.0_rc2");
	expect(gentooVersion("1.10.0+repair")).toBe("1.10.0");
	expect(() => gentooVersion("1.0.0-xz.9.1.gabcdef12")).toThrow();
	expect(() => gentooVersion("01.0.0")).toThrow();
});

test("PS-MANAGED / DL-MANAGED-UPDATE: Gentoo package owns only newest manager, marker and entry", () => {
	const r = gentooEbuild({ schema: 1, versions: [entry("1.9.0"), entry("1.10.0-rc.1"), entry("1.10.0")] }, TPL);
	expect(r.pv).toBe("1.10.0"); expect(r.ebuild).toContain('MY_TAG="manager-v1.10.0"');
	expect(r.ebuild).toContain(".dsh-manager-install.json"); expect(r.ebuild).toContain('"owner":"portage"');
	expect(r.ebuild).toContain("doexe root/dsh"); expect(r.ebuild).toContain("dosym -r /usr/lib/dsh-bin/dsh /usr/bin/dsh");
	for (const old of ["OFFICE", ".portage.managed.lock", "linux-x64-baseline", 'IUSE="office"', "cp -a root/."]) expect(r.ebuild).not.toContain(old);
	expect(r.ebuild).not.toContain("@");
	const srcNames = [...r.ebuild.matchAll(/-> (\S+)/g)].map(m => m[1].replace("${MY_TAG}", "manager-v1.10.0"));
	expect(r.manifest.trim().split("\n").map(l => l.split(" ")[1]).sort()).toEqual(srcNames.sort());
	expect(r.manifest.trim().split("\n")).toHaveLength(2);
});

test("7.4: invalid manager identity or missing Linux asset refuses packaging", () => {
	for (const e of [{ ...entry("1.0.0"), tag: "../bad" }, { ...entry("1.0.0"), launchProtocols: [2] }, { ...entry("1.0.0"), assets: {} },
		{ ...entry("1.0.0"), assets: { "linux-x64": asset("$(touch bad).zip", "1"), "linux-arm64": asset("ok.zip", "2") } }]) {
		expect(() => gentooEbuild({ schema: 1, versions: [e] }, TPL)).toThrow();
	}
});
