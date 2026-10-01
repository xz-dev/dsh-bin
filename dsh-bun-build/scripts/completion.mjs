// Export only reviewed, literal Commander declarations. Never import/run the app or its plugins.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function fixedCli(app) {
	const source = readFileSync(join(app, "lib/bin.js"), "utf8");
	const root = /const\s+(\w+)\s*=\s*new Command\(\)/.exec(source)?.[1];
	if (!root) throw new Error("fixed CLI: no Commander definition in app/lib/bin.js");
	const commands = [{ name: "", options: [] }];
	const owners = new Map([[root, commands[0]]]);
	for (const m of source.matchAll(/const\s+(\w+)\s*=\s*(\w+)\.command\("([^"\\]+)"\)/g)) {
		if (m[2] !== root || !/^[\w-]+$/.test(m[3])) throw new Error("fixed CLI: unsupported command declaration");
		const command = { name: m[3], options: [] };
		owners.set(m[1], command);
		commands.push(command);
	}
	let extracted = 0;
	const option = /\.(option|requiredOption)\("([^"\\]+)"|\.version\([^,;]+,\s*"([^"\\]+)"/g;
	for (const [owner, command] of owners) {
		for (const chain of source.matchAll(new RegExp(`\\b${owner}\\s*\\.[^;]+`, "g"))) {
			for (const m of chain[0].matchAll(option)) {
				const flags = m[2] ?? m[3];
				const names = flags.match(/--?[A-Za-z][\w-]*/g) ?? [];
				if (!names.length) throw new Error("fixed CLI: unsupported option declaration");
				command.options.push({ names, takesValue: /[<[]/.test(flags) });
				if (m[1]) extracted++;
			}
		}
	}
	// Upstream syntax changes must fail the build, not publish a silently incomplete description.
	if (extracted !== [...source.matchAll(/\.(?:option|requiredOption)\s*\(/g)].length || !commands[0].options.length)
		throw new Error("fixed CLI: unsupported option declaration; review the upstream CLI");
	return { schemaVersion: 1, commands };
}
