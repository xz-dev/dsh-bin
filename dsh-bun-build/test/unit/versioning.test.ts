import { expect, test } from "bun:test";
import { addonDistribution, distribution, parseTag } from "../../scripts/versioning.mjs";

const up = "4878cdabd87d4041bdaff61d04c966883b9fd07a";
const bc = "abcdef1234567890abcdef1234567890abcdef12";

test("live runtime: id and tag from the upstream short sha", () => {
	const d = distribution({ channel: "live", upstreamCommit: up, run: 42, attempt: 1, builderCommit: bc });
	expect(d).toEqual({ channel: "live", id: "live-4878cda-b42.1.gabcdef12", tag: "runtime-live-4878cda-b42.1.gabcdef12" });
	expect(parseTag(d.tag)).toMatchObject({ channel: "live", id: d.id, upstreamSha7: "4878cda", run: 42 });
});

test("release runtime", () => {
	const d = distribution({ channel: "release", upstreamVersion: "0.1.7-rc.2", upstreamCommit: up, run: 7, attempt: 2, builderCommit: bc });
	expect(d.tag).toBe("runtime-v0.1.7-rc.2-b7.2.gabcdef12");
	expect(parseTag(d.tag)).toMatchObject({ channel: "release", id: "0.1.7-rc.2-b7.2.gabcdef12", run: 7, attempt: 2 });
});

test("retired and foreign tag families are rejected; bad input throws", () => {
	for (const t of ["v0.1.7", "dsh-v0.1.7-rc.2-xz.7.2.gabcdef12", "dsh-live-4878cda-xz.1.1.gabcdef12", "dsh-addon-office-v0.1.2-xz.9.1.gabcdef12", "manager-v1.0.0", "runtime-live-4878cd-b1.1.gabcdef12"])
		expect(() => parseTag(t)).toThrow();
	expect(() => distribution({ channel: "beta", upstreamCommit: up, run: 1, attempt: 1, builderCommit: bc })).toThrow();
	expect(() => distribution({ channel: "live", upstreamCommit: "4878cda", run: 1, attempt: 1, builderCommit: bc })).toThrow();
	expect(() => distribution({ channel: "live", upstreamCommit: up, run: 0, attempt: 1, builderCommit: bc })).toThrow();
});

test("addon tag", () => {
	const d = addonDistribution({ kitVersion: "0.1.2", run: 9, attempt: 1, builderCommit: bc });
	expect(d.tag).toBe("addon-office-v0.1.2-b9.1.gabcdef12");
	expect(parseTag(d.tag)).toMatchObject({ channel: "addon", addon: "office", version: "0.1.2-b9.1.gabcdef12" });
	expect(() => addonDistribution({ kitVersion: "x", run: 1, attempt: 1, builderCommit: bc })).toThrow();
});
