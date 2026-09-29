// Child process for the snapshot store tests: `bun snapshot-child.ts <home> <op> [args...]`.
//   create <version> <time>   automatic creation (ifNone, copy of the previous version's newest); prints the id
//   hold <id>                 take the shared claim, print "held", then sleep
import { claimSnapshot, createSnapshot, type SnapshotMeta } from "../../runtime/snapshot/store.ts";

const [home, op, a, b] = process.argv.slice(2) as [string, string, string, string];
if (op === "create") {
	const order = { upstream: { commitTime: b }, run: 1, attempt: 1 };
	const r = createSnapshot(home, { version: a, order, reason: "start", ifNone: true, source: (list: readonly SnapshotMeta[]) => list.at(-1) ?? null });
	process.stdout.write(`${r.snapshot.id} ${r.created}\n`);
} else if (op === "hold") {
	const claim = claimSnapshot(home, a);
	if (typeof claim === "string") process.exit(2);
	process.stdout.write("held\n");
	await Bun.sleep(30_000);
}
