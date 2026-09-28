// D3: Bun's `node:module` has no `stripTypeScriptTypes`, and `Bun.plugin().module()` cannot override `node:`
// builtins. The build rewrites the known importers (scripts/transform-app.mjs) to this virtual module.
export const NODE_MODULE_COMPAT_SPECIFIER = "dsh-bin:node-module-compat";

const transpiler = new Bun.Transpiler({ loader: "ts", deadCodeElimination: false, trimUnusedImports: false });

/** Type-strip `code`. Unlike Node, Bun reprints the code, so callers must not rely on column positions. */
export function stripTypeScriptTypes(code: string): string {
	return transpiler.transformSync(code);
}

export function installNodeModuleCompat(): void {
	Bun.plugin({
		name: "dsh-bin:node-module-compat",
		setup(build) {
			build.module(NODE_MODULE_COMPAT_SPECIFIER, () => ({ exports: { stripTypeScriptTypes }, loader: "object" }));
		},
	});
}
