// Parked: task 8.3 replaces release-pipeline E2E probes; task 8.5 deletes this reference.
// 8.9: the packaged E2E must have an acceptance probe for every addon, and must read dsh's
// "did not activate" block exactly.
import { expect, test } from "bun:test";
import { ADDON_PROBES, inactiveLines } from "../../scripts/e2e.mjs";
import { ADDON_NAMES } from "../../runtime/layout.ts";

test("every addon has an acceptance probe", () => {
	expect(Object.keys(ADDON_PROBES).sort()).toEqual([...ADDON_NAMES].sort());
	for (const name of ADDON_NAMES) {
		const probe = ADDON_PROBES[name];
		expect(probe.packages.length).toBeGreaterThan(0);
		expect(probe.missing.map((d) => d.packageName).sort()).toEqual([...probe.packages].sort());
	}
});

test("inactiveLines reads only the did-not-activate block", () => {
	const out = [
		"",
		"dsh: warning: 2 entries did not activate",
		"office-to-pdf (@deepseek-ai/dsh-office-to-pdf): DeclaredDegradation: x",
		"skill-office (@deepseek-ai/dsh-skill-office): failed to import",
		"dsh: MISSING_CREDENTIAL: llm-deepseek: no API key",
	].join("\r\n");
	expect(inactiveLines(out)).toEqual([
		"office-to-pdf (@deepseek-ai/dsh-office-to-pdf): DeclaredDegradation: x",
		"skill-office (@deepseek-ai/dsh-skill-office): failed to import",
	]);
	expect(inactiveLines("dsh: MISSING_CREDENTIAL")).toEqual([]);
});
