// Runtime build checks this format, never imports it (application code would throw).
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixedCli } from "../../scripts/completion.mjs";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const appWith = (source: string) => {
	const app = mkdtempSync(join(tmpdir(), "dsh-fixed-cli-"));
	dirs.push(app);
	mkdirSync(join(app, "lib"));
	writeFileSync(join(app, "lib/bin.js"), source);
	return app;
};
const fixture = readFileSync(join(import.meta.dir, "../fixtures/fixed-cli.js"), "utf8");

test("RB-COMPLETION: changed upstream definition changes fixed data, not dynamic plugin knowledge", () => {
	const old = fixedCli(appWith(fixture));
	const newer = fixedCli(appWith(fixture.replace('--dump-config", "dump"', '--dump-tree", "dump"')));
	expect(old.commands[0].options.flatMap((o: { names: string[] }) => o.names)).toContain("--dump-config");
	expect(newer.commands[0].options.flatMap((o: { names: string[] }) => o.names)).toContain("--dump-tree");
	expect(newer.commands[0].options.flatMap((o: { names: string[] }) => o.names)).not.toContain("--dump-config");
});

test("RB-COMPLETION: unknown upstream declaration fails build rather than publish partial CLI", () => {
	const dynamic = fixture.replace('"--dump-config"', 'DYNAMIC_OPTION');
	expect(() => fixedCli(appWith(dynamic))).toThrow(/unsupported option declaration/);
	const dynamicCommand = fixture.replace('.command("plugin")', '.command(DYNAMIC_COMMAND)').replace('.requiredOption("--profile <name>", "profile")', '.description("profile")');
	expect(() => fixedCli(appWith(dynamicCommand))).toThrow(/unsupported command declaration/);
});
