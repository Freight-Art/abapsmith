# Contributing

Thanks for looking at abapsmith. This is an MCP server that gives an agent a
gated set of actions against a live SAP ABAP system over ADT. Most of the
value here is in getting the safety boundaries and the ABAP/ADT wire protocol
exactly right, so contributions that touch `src/safety.ts`, the mode ladder,
or anything that turns into an HTTP request against a real system get read
carefully and slowly. That is not a discouragement — it is the shape of the
project.

## Setup

- Node >= 20.
- `npm ci` — installs from the committed lockfile. Use this, not
  `npm install`, unless you are deliberately changing a dependency.
- `npm run build` — compiles `src/` to `dist/` via `tsc`.

There is no separate lint or format tool configured (no ESLint/Prettier
config in the repo) — `npm run typecheck` and the existing code are the style
guide. See "Code style" below.

## Running the test suite

```bash
npm run build
npm test              # vitest run — see the gotcha below
npm run typecheck
npm run check:leaks   # asserts no secrets or live hostnames in tracked files
npm run lint:guard    # node --check on bin/abap-guard
npm run check:cassettes
```

### `npm test` is offline

`npm test` runs `vitest run` with no filter — everything under `test/`. Five
files (`test/integration.test.ts`, `test/integration-debug.test.ts`,
`test/integration-undo.test.ts`, `test/integration-fpm-lock.test.ts`,
`test/integration-class-includes.test.ts`) are live integration suites, and
`vitest.config.ts` excludes them by name from every run that is not
`VITEST_LIVE=1` — `LIVE_INTEGRATION_TESTS` in that file is the authoritative
list, so `grep LIVE_INTEGRATION_TESTS -A6 vitest.config.ts` always answers
"which ones" without relying on this paragraph staying in sync. The exclusion
is config-level rather than a CLI flag, so it also holds if you name one of
those files explicitly.

`VITEST_LIVE` is the only switch. A repo-root `.env` left over from
configuring a real connection does not change this — no offline test reads
`process.env.ABAP_URL`. If you would rather prove it than trust it:

```bash
env -u VITEST_LIVE -u ABAP_URL npx vitest run
```

The offline suite is fakes and fixtures only — no real HTTP happens unless
you set `ABAP_URL` yourself. It covers the circuit breaker, fuzzy object
resolution, pseudo-DDL rendering, response truncation, the safety gate, the
write journal and drift detection, the debugger's transport/session/render
layers, and the tool surface (both `ABAP_TOOL_SURFACE` values). Full layout:
[doc/TESTING/README.md](doc/TESTING/README.md).

### Live tests need a real SAP system

`npm run test:live` (`VITEST_LIVE=1 vitest run`) runs the six live suites
above. **You almost certainly cannot run these** unless you have your own
ABAP system with ADT enabled (`/sap/bc/adt/*` reachable over HTTP) and a
technical user with `S_DEVELOP` and a writable `$TMP` package. They perform
real logons, writes, activations, runs, and a live debugger attach against
that system. All six collect under `ABAP_URL` alone, but four
(`integration-undo`, `integration-fpm-lock`, `integration-class-includes`,
`integration-lock-handle`) additionally need write access configured —
`ABAP_MODE=edit` or `admin`, or (only when `ABAP_MODE` is unset) the legacy
`ABAP_ALLOW_WRITE=true` — or they collect and skip; see
`LIVE_INTEGRATION_TESTS` in `vitest.config.ts` for exactly which. Do not
point `ABAP_URL` at anything productive, and do not run `test:live` against a
system you are not prepared to see mutated — the server does not confine
writes to `$TMP` unless you set `ABAP_ALLOW_PACKAGES`, so the live suites are
not sandboxed at all beyond what you configure, and they serialize (one
connection, no parallel logons) because a shared sandbox has a finite
failed-login budget before the technical user locks.

If you don't have an SAP appliance to test against, that's fine — most
contributions are reviewable and testable through the offline suite alone.
Say so in the PR description rather than trying to fake a live result.

### Fixtures and cassettes

Many offline tests replay literal bytes captured from a real ABAP system:
recorded request/response exchanges ("cassettes", under `test/cassettes/`)
and standalone fixture files (DDIC XML, enhancement payloads, debugger
variable dumps). This is deliberate — a fixture this literal fails the
moment the real system's output changes shape (a DDL formatter tweak, a new
XML attribute), rather than a hand-written mock quietly passing while the
real wire protocol has moved on.

If you don't have live access, don't hand-write a fixture that merely looks
plausible — that defeats the point, since it stops being a check against
reality. If a fixture needs to change and you can't re-capture it yourself,
flag that in the PR and describe what you believe changed and why; a
maintainer with live access can re-capture it. `npm run check:cassettes`
type-checks and runs the cassette suite in isolation.

## Code style

There's no linter config, so match what's already there:

- TypeScript throughout, `strict: true`, plus
  `noUncheckedIndexedAccess`/`noImplicitOverride`/`noFallthroughCasesInSwitch`
  (see `tsconfig.json`). Keep new code passing under those, don't relax them.
- ESM (`"type": "module"` in `package.json`), Node16 module resolution.
- Mutating call sites are typed, not just checked at runtime — see
  `AuthorizedTarget<Op>` in `src/safety.ts`. If you add a new mutating
  operation, it should go through the same pattern rather than taking an
  optional gate parameter that's easy to forget.
- Source lives in `src/`, organized by feature (`src/adt/`, `src/debug/`,
  `src/tools/`). Tests live in `test/`, one `*.test.ts` file per concern,
  named after what it covers rather than after the source file 1:1.
- Prose in docs and code comments is direct and specific: state what a
  thing does and does not guarantee, name the exact config variable or
  test that backs a claim, and avoid marketing language ("robust",
  "powerful", "seamless"). Read `README.md` and `doc/SAFETY/README.md` for the
  tone this project expects.

## Before you open a PR

1. `npm run build && npm run typecheck` — must be clean.
2. `env -u VITEST_LIVE -u ABAP_URL npx vitest run` — must pass offline.
3. `npm run check:leaks` — must pass; this scans every tracked file for a
   routable IPv4 or real SAP hostname pattern before it can leak into
   history.
4. If you touched anything under `src/safety.ts`, the mode ladder, or an
   allowlist, read [doc/SAFETY/safety-gate.md](doc/SAFETY/safety-gate.md) first and explain in the
   PR description which check in the gate your change affects and why it's
   still fail-closed.
5. Keep the PR scoped to one change. This repo's history (see commit
   messages on `master`) favors small, named, single-purpose commits over
   large mixed ones — match that.

## PR process

- Open the PR against `master` with a description of what changed and why,
  not just what. If you validated something against a live system, say
  which system class (e.g. "on a personal A4H trial") and what you saw —
  don't claim live verification you didn't actually perform.
- CI-equivalent expectations are the four commands under "Before you open a
  PR" above; there's no separate CI config to read, so if those pass
  locally you're in good shape.
- Be explicit about anything you could not test (most commonly: the live
  suites, or a live-capture re-verification). A reviewer with SAP access
  can pick that up.
- Expect review focused on the safety gate, the mode ladder, and anything
  that changes what reaches the wire — that's the part of this project
  that has to stay correct even when a caller (human or model) gets it
  wrong.
