// Weak-network download helpers (runtime/update/download.ts) and the launcher-help detection. The download
// behaviour itself (retry, resume, timeout, verification) is pinned by the update contract.
import { describe, expect, test } from "bun:test";
import { isTopLevelHelp, MAINTENANCE_HELP, USAGE } from "../../runtime/update/args.ts";
import { backoffMs, formatBytes, formatEta, netTuning, progressLine, progressReporter } from "../../runtime/update/download.ts";

describe("formatting", () => {
	test("bytes", () => {
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(1536)).toBe("1.5 KiB");
		expect(formatBytes(80 * 1048576)).toBe("80 MiB");
		expect(formatBytes(3 * 1073741824)).toBe("3.0 GiB");
	});
	test("eta", () => {
		expect(formatEta(5.2)).toBe("00:06");
		expect(formatEta(3725)).toBe("1:02:05");
		expect(formatEta(Number.POSITIVE_INFINITY)).toBe("--:--");
	});
	test("a terminal line has a bar; a plain line does not", () => {
		const tty = progressLine("dsh.zip", 40 * 1048576, 80 * 1048576, 2 * 1048576, true);
		expect(tty).toBe("dsh.zip [############------------]  50%  40 MiB / 80 MiB  2.0 MiB/s  ETA 00:20");
		expect(progressLine("dsh.zip", 0, 80 * 1048576, 0, false)).toBe("dsh.zip   0%  0 B / 80 MiB  0 B/s  ETA --:--");
	});
});

describe("progress reporter", () => {
	const run = (tty: boolean) => {
		const out: string[] = [];
		let t = 0;
		const r = progressReporter("a.zip", 3000, { tty, write: (s) => out.push(s), now: () => t });
		r.update(500, 500); // before the first interval: suppressed
		t = 1000;
		r.update(1000, 500); // shown
		t = 1500;
		r.update(2000, 1000); // within the interval: suppressed
		t = 1600;
		r.update(3000, 1000, true); // the final line is always shown
		r.end();
		r.end();
		return out;
	};
	test("terminal: redrawn in place, one newline at the end", () => {
		const out = run(true);
		expect(out.length).toBe(3);
		expect(out.slice(0, 2).every((s) => s.startsWith("\r\x1b[2K"))).toBe(true);
		expect(out[2]).toBe("\n");
	});
	test("not a terminal: one plain line per interval", () => {
		const out = run(false);
		expect(out.length).toBe(2);
		expect(out.every((s) => s.endsWith("\n") && !s.includes("\r"))).toBe(true);
		expect(out[1]).toContain("100%");
	});
});

describe("retry policy", () => {
	test("exponential backoff, capped", () => {
		expect([1, 2, 3, 4, 5, 9].map((n) => backoffMs(n, 1000))).toEqual([1000, 2000, 4000, 8000, 16000, 16000]);
	});
	test("Retry-After wins, capped at a minute", () => {
		expect(backoffMs(1, 1000, "3")).toBe(3000);
		expect(backoffMs(1, 1000, "600")).toBe(60000);
		expect(backoffMs(2, 1000, "soon")).toBe(2000);
	});
	test("test-only tuning is ignored outside test mode", () => {
		expect(netTuning({ DSH_BIN_TEST_RETRY_DELAY_MS: "1", DSH_BIN_TEST_INACTIVITY_MS: "1" })).toEqual({ inactivityMs: 30000, retryDelayMs: 1000 });
		expect(netTuning({ DSH_BIN_TEST: "1", DSH_BIN_TEST_RETRY_DELAY_MS: "1", DSH_BIN_TEST_INACTIVITY_MS: "5" })).toEqual({ inactivityMs: 5, retryDelayMs: 1 });
	});
});

describe("launcher help", () => {
	test.each([["--help"], ["-h"], ["--help", "extra"]])("%p is the launcher help", (...argv) => expect(isTopLevelHelp(argv)).toBe(true));
	test.each([[], ["tui", "--help"], ["--profile", "tui", "--help"], ["--help", "--profile", "tui"], ["--help", "--profile=tui"], ["plugin", "--help"]])("%p is not", (...argv) =>
		expect(isTopLevelHelp(argv)).toBe(false),
	);
	test("the section lists every dsh-bin command's usage", () => {
		for (const usage of Object.values(USAGE)) expect(MAINTENANCE_HELP).toContain(usage);
	});
});
