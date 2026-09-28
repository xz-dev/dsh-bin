// The fixture release world for the update contract matrix. Defects (bad digests, malformed or trimmed
// indexes, unreachable hosts) are injected at serve time, so one world serves every case.
import type { Slot } from "../../runtime/layout.ts";
import { SLOT_A, SLOT_B, World } from "./harness.ts";

/** Upstream switched the kit back to 0.1.2: a new slot with the same kit version as A. */
export const SLOT_A2: Slot = { commit: "e".repeat(40), kitVersion: "0.1.2" };

export const V = {
	R1: "0.1.7-rc.2-xz.1.1.g11111111",
	R2: "0.1.7-rc.2-xz.2.1.g22222222",
	R3: "0.1.8-xz.3.1.g33333333",
	EVIL: "0.1.9-xz.9.1.g99999999",
	L1: "0.1.7-rc.1-xz.4.1.g44444444",
	P1: "0.1.2-xz.11.1.gaaaa0001",
	Q: "0.1.2-xz.12.1.gaaaa0002",
	B1: "0.1.3-xz.13.1.gbbbb0003",
	P3: "0.1.2-xz.14.1.geeee0004",
} as const;

/** The bytes `zzzzz/evil` become `../../evil`: same length, so the ZIP stays well-formed. */
const EVIL_NAME = "zzzzz/evil";
function makeEvil(bytes: Uint8Array): Uint8Array {
	const buf = Buffer.from(bytes);
	for (let at = buf.indexOf(EVIL_NAME); at >= 0; at = buf.indexOf(EVIL_NAME, at + 1)) buf.write("../../evil", at, "latin1");
	return buf;
}

/**
 * Release channel: R1 → R2 (slot A, pinned P1) → R3 (kit switch-back slot A2, pinned P3).
 * Live channel: L1 (slot A, pinned P1; older upstream than R1).
 * Office addons: P1, Q (slot A), B1 (slot B), P3 (slot A2).
 * EVIL (release, not indexed by default) contains a `../../evil` entry.
 */
export function buildWorld() {
	const w = new World();
	const P1 = w.addonRelease({ version: V.P1, seq: 1, slot: SLOT_A });
	const Q = w.addonRelease({ version: V.Q, seq: 2, slot: SLOT_A });
	const B1 = w.addonRelease({ version: V.B1, seq: 3, slot: SLOT_B });
	const P3 = w.addonRelease({ version: V.P3, seq: 4, slot: SLOT_A2 });
	w.bundle({ version: V.R1, seq: 1, channel: "release", slot: SLOT_A, pinned: V.P1, known: [P1] });
	w.bundle({ version: V.R2, seq: 2, channel: "release", slot: SLOT_A, pinned: V.P1, known: [P1] });
	w.bundle({ version: V.R3, seq: 3, channel: "release", slot: SLOT_A2, pinned: V.P3, known: [P1, Q, B1, P3] });
	w.bundle({ version: V.L1, seq: 1, channel: "live", slot: SLOT_A, pinned: V.P1, known: [P1] });
	const evil = w.bundle(
		{
			version: V.EVIL,
			seq: 9,
			channel: "release",
			tamper: (inputs) => inputs.push({ name: EVIL_NAME, data: new TextEncoder().encode("x"), mode: 0o644 }),
		},
		{ inIndex: false, postZip: makeEvil },
	);
	return { world: w, evil };
}
