import { expect, test } from "bun:test";
import { distribution, parseTag } from "../../scripts/versioning.mjs";

const up = "4878cdabd87d4041bdaff61d04c966883b9fd07a";
const lc = "abcdef1234567890abcdef1234567890abcdef12";

test("live tag uses upstream short sha", () => {
	const d = distribution({ channel: "live", upstreamCommit: up, run: 42, attempt: 1, launcherCommit: lc });
	expect(d.tag).toBe("dsh-live-4878cda-xz.42.1.gabcdef12");
	expect(d.version).toBe("live.4878cda-xz.42.1.gabcdef12");
	expect(parseTag(d.tag)).toMatchObject({ channel: "live", version: d.version, upstreamSha7: "4878cda" });
});

test("release tag", () => {
	const d = distribution({ channel: "release", upstreamVersion: "0.1.7-rc.2", upstreamCommit: up, run: 7, attempt: 2, launcherCommit: lc });
	expect(d.tag).toBe("dsh-v0.1.7-rc.2-xz.7.2.gabcdef12");
	expect(parseTag(d.tag)).toMatchObject({ channel: "release", version: "0.1.7-rc.2-xz.7.2.gabcdef12", run: 7, attempt: 2 });
});

test("rejects other tag families and bad input", () => {
	for (const t of ["v0.1.7", "dsh-v0.1.7-rc.2", "dsh-nightly-4878cda-xz.1.1.gabcdef12", "dsh-live-4878cd-xz.1.1.gabcdef12"])
		expect(() => parseTag(t)).toThrow();
	expect(() => distribution({ channel: "beta", upstreamCommit: up, run: 1, attempt: 1, launcherCommit: lc })).toThrow();
	expect(() => distribution({ channel: "live", upstreamCommit: "4878cda", run: 1, attempt: 1, launcherCommit: lc })).toThrow();
	expect(() => distribution({ channel: "live", upstreamCommit: up, run: 0, attempt: 1, launcherCommit: lc })).toThrow();
});
