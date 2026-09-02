# scripts/

Scripts that the build, an `npm run` script, or the test suite genuinely
depend on. Nothing here talks to a real ABAP system.

| Script | What it does | Live? | Destructive? |
|---|---|---|---|
| `check-no-leaks.mjs` | Pre-publication guard: fails if any tracked file names a routable host | No | No |
| `gen-capability-table.mjs` | Generates the writable-type table `abapsmith-orient/SKILL.md` carries, straight from `src/adt/capabilities.ts`'s REGISTRY (via `dist/`); `--check` diffs the regenerated table against the skill file's BEGIN/END block and exits 1 if stale | No — reads only local `REGISTRY`/`dist/` and the skill file | No — prints or checks; never writes the skill file |
| `lint-hint-params.mjs` | Static lint over `src/tools/**/*.ts` via the TypeScript compiler API: flags caller-facing hint/error strings that name a tool parameter in camelCase when the real zod schema field is snake_case | No — pure source-file static analysis, no network, no `dist/` build required | No — read-only, reports only |

`scripts/lib/first-line.mjs` is a small shared helper with its own regression
coverage (`test/first-line.test.ts`); it is not run standalone, which is why
it has no row above — `test/scripts-readme-index.test.ts` only indexes
top-level `scripts/*.mjs`/`*.sh` files, by design (see that test's own
comment).

This table is separate from the live **vitest** surface (`test/integration*.test.ts`
run under `VITEST_LIVE=1`). Don't transcribe that file list anywhere — it drifts.
Enumerate it yourself: `VITEST_LIVE=1 npx vitest list --filesOnly` (plain `vitest
list` prints nothing in this repo). The authority is `LIVE_INTEGRATION_TESTS` in
`vitest.config.ts`; as of this writing that's 6 files, and 4 of the 6
additionally self-gate on write access being configured (`ABAP_MODE=edit`/
`admin`, or legacy `ABAP_ALLOW_WRITE=true` — see `test/helpers/live-write-gate.ts`)
so a sweep run without it will show them collected but skipped.

`test/scripts-readme-index.test.ts` fails whenever a
`scripts/*.mjs` or `*.sh` has no row above, so this table itself can't silently
fall behind again.
