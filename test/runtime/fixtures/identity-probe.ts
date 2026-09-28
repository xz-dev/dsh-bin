// Runs under `bun` with the compat layer installed against a real app tree (argv[2]), then imports
// host packages from a profile-local plugin that ships its own copies of them.
import { installHostPackages, withInvocationAccessor } from "../../../runtime/compat/host-packages.ts";

const [appDir, pluginEntry] = process.argv.slice(2) as [string, string];
const counts = installHostPackages(appDir);
const plugin = await import(pluginEntry);
const host = {
	cordis: await import(Bun.resolveSync("@deepseek-ai/cordis", appDir)),
	invariant: await import(Bun.resolveSync("@deepseek-ai/dsh-credentials/invariant", appDir)),
	providers: await import(Bun.resolveSync("@earendil-works/pi-ai/providers/all", appDir)),
};
const root = new plugin.cordis.Context();
console.log(
	JSON.stringify({
		counts,
		service: plugin.cordis.Service === host.cordis.Service,
		subpath: plugin.invariant.apply === host.invariant.apply,
		wildcard: Object.keys(plugin.providers).length > 0 && Object.keys(plugin.providers).every((k) => plugin.providers[k] === host.providers[k]),
		localShadowed: [plugin.cordis, plugin.invariant, plugin.providers].every((ns) => !("localMarker" in ns)),
		manifest: plugin.cordisManifest,
		invocation: Object.hasOwn(root.reflect.props, "invocation") && root.invocation === undefined,
		wrappedIsContext: root instanceof host.cordis.Context && withInvocationAccessor(host.cordis.Context) !== host.cordis.Context,
	}),
);
