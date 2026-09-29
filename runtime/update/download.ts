// Weak-network downloads (self-update spec "Verification before activation"): progress with speed and ETA,
// connect/inactivity timeouts, retry with backoff on transient failures, and HTTP Range resume, both within
// one run and across runs (the partial file is kept under `<root>/.downloads/<sha256>.part`, keyed by the
// index digest). The finished file is still checked against the index size and SHA-256.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { AssetRef } from "../layout.ts";
import { UserError } from "./context.ts";

export const DOWNLOADS_DIR = ".downloads";
/** HTTP statuses worth another attempt (as xz-dev/pi's updater). */
export const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
/** No response headers or no body bytes for this long aborts the attempt. */
export const INACTIVITY_TIMEOUT_MS = 30_000;
/** Consecutive attempts without progress before giving up; an attempt that received bytes resets the count. */
export const MAX_FAILURES = 5;
const PROGRESS_INTERVAL_MS = 1_000;
const MAX_RETRY_AFTER_MS = 60_000;

export type NetTuning = { inactivityMs: number; retryDelayMs: number };

/** Timeouts and backoff; test mode (`DSH_BIN_TEST=1`) may shorten them so failure cases run quickly. */
export function netTuning(env = process.env): NetTuning {
	const test = env.DSH_BIN_TEST === "1";
	const num = (v: string | undefined, d: number) => (test && v && Number.isFinite(Number(v)) ? Number(v) : d);
	return { inactivityMs: num(env.DSH_BIN_TEST_INACTIVITY_MS, INACTIVITY_TIMEOUT_MS), retryDelayMs: num(env.DSH_BIN_TEST_RETRY_DELAY_MS, 1_000) };
}

/** Delay before attempt `failures + 1`: exponential from `base`, capped at 16×, or the server's Retry-After. */
export function backoffMs(failures: number, base: number, retryAfter?: string | null): number {
	const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
	if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
	return base * 2 ** Math.min(failures - 1, 4);
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${Math.round(bytes)} B`;
	const units = ["KiB", "MiB", "GiB"];
	let v = bytes / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function formatEta(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
	const s = Math.ceil(seconds);
	const h = Math.floor(s / 3600);
	const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
	const ss = String(s % 60).padStart(2, "0");
	return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** One progress line: `[bar] pct  done / total  speed  ETA` (the bar only on a terminal). */
export function progressLine(name: string, done: number, total: number, bytesPerSecond: number, tty: boolean): string {
	const ratio = total > 0 ? Math.min(done / total, 1) : 0;
	const pct = `${Math.floor(ratio * 100)}%`.padStart(4);
	const width = 24;
	const filled = Math.round(ratio * width);
	const bar = tty ? `[${"#".repeat(filled)}${"-".repeat(width - filled)}] ` : "";
	const eta = bytesPerSecond > 0 ? formatEta((total - done) / bytesPerSecond) : "--:--";
	return `${name} ${bar}${pct}  ${formatBytes(done)} / ${formatBytes(total)}  ${formatBytes(bytesPerSecond)}/s  ETA ${eta}`;
}

/** Progress reporter: a redrawn line on a terminal, a plain line per interval otherwise. */
export function progressReporter(name: string, total: number, opts: { tty?: boolean; write?: (s: string) => void; now?: () => number } = {}) {
	const tty = opts.tty ?? Boolean(process.stdout.isTTY);
	const write = opts.write ?? ((s: string) => void process.stdout.write(s));
	const now = opts.now ?? (() => performance.now());
	const started = now();
	let received = 0; // bytes received in this run (resumed bytes are not speed)
	// The first line waits one interval, so its speed and ETA are not skewed by connection setup.
	let last = started;
	let shown = false;
	return {
		update(done: number, delta: number, final = false) {
			received += delta;
			const t = now();
			if (!final && t - last < PROGRESS_INTERVAL_MS) return;
			last = t;
			const speed = received / Math.max((t - started) / 1000, 0.001);
			const line = progressLine(name, done, total, speed, tty);
			write(tty ? `\r\x1b[2K${line}` : `${line}\n`);
			shown = true;
		},
		/** Finish a redrawn line (once), so the next message starts on its own line. */
		end() {
			if (tty && shown) write("\n");
			shown = false;
		},
	};
}

/** A transient failure worth another attempt; `received` counts the bytes this attempt still delivered. */
class Retryable extends Error {
	received = 0;
	constructor(
		message: string,
		readonly retryAfter?: string | null,
	) {
		super(message);
	}
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type DownloadOptions = {
	url: string;
	asset: AssetRef;
	/** Install root; the partial file lives under `<root>/.downloads/`. */
	root: string;
	/** Final path of the verified file. */
	dest: string;
	/** Release tag named in the first line. */
	from?: string;
	log: (line: string) => void;
	tuning?: NetTuning;
	progress?: { tty?: boolean; write?: (s: string) => void };
	sha256File: (path: string) => Promise<string>;
};

/** Where the partial download of `asset` is kept between attempts and runs. */
export const partPath = (root: string, asset: AssetRef) => join(root, DOWNLOADS_DIR, `${asset.sha256}.part`);

/** Remove the downloads directory when nothing is left in it. */
function tidy(root: string) {
	const dir = join(root, DOWNLOADS_DIR);
	try {
		if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
	} catch {
		// Not empty or not removable now; the next run or `dsh update --clean` handles it.
	}
}

/** Remove every kept partial download (`dsh update --clean`). */
export function removePartials(root: string): number {
	const dir = join(root, DOWNLOADS_DIR);
	if (!existsSync(dir)) return 0;
	const n = readdirSync(dir).length;
	rmSync(dir, { recursive: true, force: true });
	return n;
}

/**
 * One attempt: request the rest of `part` (Range when it already has bytes) and append to it; `state.resumed`
 * records that bytes were appended to an earlier attempt's. Throws Retryable for transient failures (with the
 * bytes it still received), UserError for final ones.
 */
async function attempt(o: DownloadOptions, part: string, tuning: NetTuning, report: ReturnType<typeof progressReporter>, state: { resumed: boolean }): Promise<void> {
	const { asset, url } = o;
	let offset = existsSync(part) ? statSync(part).size : 0;
	if (offset > asset.size) {
		rmSync(part, { force: true });
		offset = 0;
	}
	if (offset === asset.size) return;
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const arm = () => {
		clearTimeout(timer);
		timer = setTimeout(() => controller.abort(new Error(`no data for ${Math.round(tuning.inactivityMs / 1000)}s`)), tuning.inactivityMs);
	};
	arm();
	let received = 0;
	try {
		let res: Response;
		try {
			res = await fetch(url, { redirect: "follow", signal: controller.signal, headers: offset > 0 ? { range: `bytes=${offset}-` } : {} });
		} catch (error) {
			throw new Retryable(controller.signal.aborted ? errText(controller.signal.reason) : errText(error));
		}
		if (res.status === 416) {
			// The kept bytes do not fit this asset: start over.
			rmSync(part, { force: true });
			throw new Retryable("HTTP 416 for the kept partial download; restarting");
		}
		if (RETRYABLE_STATUSES.has(res.status)) throw new Retryable(`HTTP ${res.status}`, res.headers.get("retry-after"));
		if (!res.ok) throw new UserError(`download failed: ${url}: HTTP ${res.status}`);
		let append = false;
		if (res.status === 206) {
			const m = /^bytes (\d+)-\d+\/(\d+|\*)$/.exec(res.headers.get("content-range") ?? "");
			if (!m || Number(m[1]) !== offset) {
				rmSync(part, { force: true });
				throw new Retryable(`unexpected Content-Range ${res.headers.get("content-range") ?? "(none)"}; restarting`);
			}
			append = true;
			state.resumed = true;
		} else if (offset > 0) {
			o.log("The server ignored the resume request; downloading from the start.");
		}
		let done = append ? offset : 0;
		const fd = openSync(part, append ? "a" : "w");
		try {
			if (!res.body) throw new Retryable("empty response body");
			const reader = res.body.getReader();
			for (;;) {
				let chunk: ReadableStreamReadResult<Uint8Array>;
				try {
					chunk = await reader.read();
				} catch (error) {
					throw new Retryable(controller.signal.aborted ? errText(controller.signal.reason) : errText(error));
				}
				if (chunk.done) break;
				arm();
				writeSync(fd, chunk.value);
				received += chunk.value.byteLength;
				done += chunk.value.byteLength;
				if (done > asset.size) throw new UserError(`download of ${asset.name} is larger than the index size ${asset.size}`);
				report.update(done, chunk.value.byteLength);
			}
		} finally {
			closeSync(fd);
		}
		if (done < asset.size) throw new Retryable(`connection closed at ${done} of ${asset.size} bytes`);
		report.update(done, 0, true);
	} catch (error) {
		if (error instanceof Retryable) error.received = received;
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Download `asset` from `url` to `dest`, resuming a kept partial file, then verify its size and SHA-256.
 * A mismatch after a resumed download is retried once from the start before it is reported; a download
 * that keeps failing leaves its partial file for the next run.
 */
export async function download(o: DownloadOptions): Promise<void> {
	const tuning = o.tuning ?? netTuning();
	const part = partPath(o.root, o.asset);
	mkdirSync(join(o.root, DOWNLOADS_DIR), { recursive: true });
	const kept = existsSync(part) ? statSync(part).size : 0;
	const size = formatBytes(o.asset.size);
	const from = o.from ? ` from ${o.from}` : "";
	o.log(kept > 0 && kept <= o.asset.size ? `Resuming ${o.asset.name} at ${formatBytes(kept)} of ${size}${from}...` : `Downloading ${o.asset.name} (${size})${from}...`);
	try {
		const state = { resumed: kept > 0 };
		for (;;) {
			const report = progressReporter(o.asset.name, o.asset.size, o.progress);
			let failures = 0;
			try {
				for (;;) {
					try {
						await attempt(o, part, tuning, report, state);
						break;
					} catch (error) {
						if (!(error instanceof Retryable)) throw error;
						report.end();
						if (error.received) failures = 0;
						failures++;
						if (failures >= MAX_FAILURES) throw new UserError(`download failed: ${o.url}: ${error.message}`, ["Run the same command again to resume the download."]);
						const wait = backoffMs(failures, tuning.retryDelayMs, error.retryAfter);
						o.log(`Download interrupted (${error.message}); retrying in ${(wait / 1000).toFixed(wait < 1000 ? 1 : 0)}s (${failures}/${MAX_FAILURES - 1})...`);
						await Bun.sleep(wait);
					}
				}
			} finally {
				report.end();
			}
			const got = statSync(part).size;
			const digest = await o.sha256File(part);
			if (digest === o.asset.sha256 && got === o.asset.size) break;
			rmSync(part, { force: true });
			if (state.resumed) {
				o.log(`The resumed download of ${o.asset.name} did not verify; downloading it again from the start.`);
				state.resumed = false;
				continue;
			}
			throw new UserError(`sha256 mismatch for ${o.asset.name}: expected ${o.asset.sha256} (${o.asset.size} bytes), got ${digest} (${got} bytes)`);
		}
		renameSync(part, o.dest);
	} finally {
		// A failure keeps a partial file for the next run; an empty downloads directory is removed.
		tidy(o.root);
	}
}
