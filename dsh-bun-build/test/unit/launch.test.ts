import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { readManagerLaunch } from "../../runtime/launch.ts";

const dataRoot = resolve("/var/tmp/dsh-launch-unit");
const runtime = "A";
const payload = () => ({ protocol: 2, runtime, dataRoot, home: join(dataRoot, "home"), snapshot: { id: "A@1", dir: join(dataRoot, "snapshots", "A@1") }, configSnapshot: { id: "B@2", dir: join(dataRoot, "config-snapshots", "B@2") }, addons: {}, cache: join(dataRoot, "cache"), tmp: join(dataRoot, "tmp"), manager: "1.0.0" });
const read = (v: unknown) => readManagerLaunch({ DSH_MANAGER_LAUNCH: JSON.stringify(v) });

test("RB-CONFIG-CONTEXT: protocol 2 consumes independent explicit roots", () => {
	expect(read(payload())).toEqual(payload());
	expect(readManagerLaunch({ DSH_BIN_CONFIG_SNAPSHOT_DIR: "/untrusted" })).toBeUndefined();
});

test("RB-CONFIG-PROTOCOL: old, incomplete or mismatched payloads never become standalone", () => {
	for (const patch of [
		{ protocol: 1 }, { snapshot: null }, { configSnapshot: null }, { configSnapshot: undefined },
		{ configSnapshot: { id: "B@2", dir: join(dataRoot, "snapshots", "B@2") } },
		{ configSnapshot: { id: "B@2", dir: join(dataRoot, "config-snapshots", "A@1") } },
		{ snapshot: { id: "A@1", dir: join(dataRoot, "config-snapshots", "A@1") } },
		{ snapshot: { id: "../A@1", dir: join(dataRoot, "snapshots", "A@1") } },
		{ runtime: "../A" }, { cache: null }, { tmp: "relative" }, { manager: "" },
	]) expect(() => read({ ...payload(), ...patch })).toThrow(/DSH_MANAGER_LAUNCH/);
});
