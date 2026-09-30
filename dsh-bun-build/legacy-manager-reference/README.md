# Porting reference only

Old TypeScript manager and `.reference.ts` tests are not executable suites; task 8.5 removes this directory after Zig replacements. Version/selection/addon tests belong to 6.1–6.3, downloads to 3.2, and update-contract coverage to 3–8.

`release-pipeline/` parks stale release-script tests; task 8.3 replaces them with independent manager/runtime release tests. Scripts `e2e.mjs`, `local-e2e.mjs`, `index.mjs` and `upstream-diff.mjs` remain release-pipeline work, not `bun test` dependencies.
