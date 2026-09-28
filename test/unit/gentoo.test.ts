import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gentooEbuild, gentooVersion } from "../../scripts/gentoo-ebuild.mjs";

const TPL = readFileSync(join(import.meta.dir, "../../packaging/gentoo/dsh-bin-9999.ebuild.in"), "utf8");
const a = (name: string, c: string) => ({ name, size: 7, sha256: c.repeat(64) });

test("9.2: release versions map to ordered Gentoo versions", () => {
	expect(gentooVersion("0.1.7-rc.2-xz.5.1.gabcdef12")).toBe("0.1.7_rc2_p5");
	expect(gentooVersion("0.2.0-xz.9.2.gabcdef12")).toBe("0.2.0_p9");
	expect(() => gentooVersion("live.4878cda-xz.1.1.gabcdef12")).toThrow();
});

test("9.2: ebuild pins the newest release and its pinned office addon; Manifest lists every SRC_URI file", () => {
	const index = {
		channels: {
			release: [
				{ seq: 1, tag: "dsh-v0.1.7-rc.2-xz.1.1.g00000001", version: "0.1.7-rc.2-xz.1.1.g00000001", addons: { office: { pinned: "0.1.1-xz.1.1.g00000001" } }, assets: {} },
				{ seq: 2, tag: "dsh-v0.1.7-rc.2-xz.4.1.g00000004", version: "0.1.7-rc.2-xz.4.1.g00000004", addons: { office: { pinned: "0.1.1-xz.1.1.g00000001" } }, assets: { "linux-x64-baseline": a("dsh-linux-x64-baseline.zip", "1"), "linux-arm64": a("dsh-linux-arm64.zip", "2") } },
			],
			live: [],
		},
		addons: { office: [{ seq: 1, tag: "dsh-addon-office-v0.1.1-xz.1.1.g00000001", version: "0.1.1-xz.1.1.g00000001", assets: { linux: a("dsh-addon-office-linux.zip", "3") } }] },
	};
	const r = gentooEbuild(index, TPL);
	expect(r.pv).toBe("0.1.7_rc2_p4");
	expect(r.ebuild).toContain('MY_TAG="dsh-v0.1.7-rc.2-xz.4.1.g00000004"');
	expect(r.ebuild).toContain('OFFICE_VERSION="0.1.1-xz.1.1.g00000001"');
	expect(r.ebuild).toContain("IUSE=\"office\"");
	expect(r.ebuild).toContain(".portage.managed.lock");
	expect(r.ebuild).not.toContain("@");
	const srcNames = [...r.ebuild.matchAll(/-> (\S+)/g)].map((m) => m[1].replace("${MY_TAG}", "dsh-v0.1.7-rc.2-xz.4.1.g00000004").replace("${OFFICE_TAG}", "dsh-addon-office-v0.1.1-xz.1.1.g00000001"));
	const distNames = r.manifest.trim().split("\n").map((l) => l.split(" ")[1]);
	expect(distNames.sort()).toEqual(srcNames.sort());
	expect(r.manifest).toContain(`SHA256 ${"3".repeat(64)}`);
});
