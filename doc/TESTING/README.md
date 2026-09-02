# Testing

## Quick start

```bash
npm run build         # tsc
npm test              # vitest — see the gotcha below before running this
npm run typecheck     # tsc --noEmit
npm run check:leaks   # asserts no secrets or live hostnames in tracked files
```

## `npm test` is offline, and `ABAP_URL` does not change that

`npm test` runs `vitest run` with no filter, but `vitest.config.ts` excludes
the six live integration suites by name from every run that is not
`VITEST_LIVE=1` — see `LIVE_INTEGRATION_TESTS` in that file for the
authoritative list. That exclusion is config-level, not a CLI flag — it holds
even if someone names an excluded file explicitly on the command line.

The switch is `VITEST_LIVE` alone. No offline test reads `process.env.ABAP_URL`,
so a repo-root `.env` with real credentials does not turn `npm test` into a
live run. `npm run test:live` (`VITEST_LIVE=1 vitest run`) is the only
command that reaches a real system — a deliberate, explicitly-named act,
never a side effect of a bare `npm test`.

To verify rather than take the config's word for it, unset both variables:

```bash
env -u VITEST_LIVE -u ABAP_URL npx vitest run
```

## Suite layout, offline

The offline suite is fakes and fixtures only — no real HTTP, no real SAP
system reachable at all unless you set `ABAP_URL` yourself. By area:

| Area | Covers |
|---|---|
| Circuit breaker | One failed logon reaches the network; every retry after that is refused locally (the failed-login user-lock threshold makes this the highest-stakes test in the repo) |
| Fuzzy resolution | Turning `class ZCL_FOO`, a bare name, or a raw URI into a resolved object without the caller supplying an ADT type code |
| Pseudo-DDL rendering | DDIC definitions (domains, data elements, structures, table types, views, search helps) rendered as short pseudo-DDL text |
| Truncation / compaction | Response-size budgeting and the marker that proves a shortened body is never silently shortened |
| The safety gate | Mode ceiling, package allowlists, productive-system lockout, and the write/undo refusal paths |
| Journal and drift detection | Write journal entries, before-images, undo, and classifying a stranded entry as succeeded / failed / ambiguous against live source |
| Debugger transport / session / render | The long-poll HTTP layer, the session state machine above it, and the variable-rendering/context-budget layer — each tested against hand-rolled fakes, never a real debuggee |
| Tool surface | Both `ABAP_TOOL_SURFACE` values: which tools each surface registers (by name, including capability-gated tools/parameters), the v2 catalogue/dispatch invariants, and coherence between shipped skills and whichever surface a server actually exposes — deliberately with no pinned schema byte total or ceiling; see `test/tools.test.ts`'s "tool surface" describe block for why |

### The load-bearing property: refusal costs zero requests

A recurring assertion across the write, undo and journal suites: a call the
safety gate refuses — an out-of-mode write, a write outside the package
allowlist, an undo of an enhancement-type entry, an undo whose target has
drifted — makes **zero** requests onto the wire. Tests pin this two ways: a
normal fake connection whose recorded call list must come back empty, and a
second run against a connection object that throws on first touch, so the
zero-request property holds even if the fake's own bookkeeping were wrong.
This is what makes the safety gate a pre-flight check, not a rollback
mechanism.

## Fixtures and cassettes

Many offline tests replay literal bytes captured from a real ABAP system —
recorded request/response exchanges (cassettes) and standalone fixture files
(DDIC XML, enhancement payloads, debugger variable dumps). Deliberate
trade-off: a fixture this literal fails the moment the real system's output
changes shape — a DDL formatter tweak, a new XML attribute — rather than a
hand-written mock quietly passing while the real wire protocol has moved on.
Cassettes carry a staleness window and need periodic re-verification against
a live system; a stale or drifted cassette is a signal to re-capture, not to
widen the test.

Re-capturing: connect to a real system with the live-capture tooling below,
perform the exact exchange again, and replace the fixture with the new bytes
plus provenance (what, when, against which system). A hand-written fixture
that merely looks plausible defeats the point — it stops being a check
against reality.

## Live tests

Six suites are live-only — `LIVE_INTEGRATION_TESTS` in `vitest.config.ts` is
the authoritative list (`grep LIVE_INTEGRATION_TESTS -A7 vitest.config.ts`):
a real logon-and-read/write/activate/run round trip, a live debugger attach,
an undo against a real journal entry, a locking scenario against a real FPM
screen, a write into a class's CCAU include, and a lock-handle validity
check. All six require `ABAP_URL` to collect at all; four of them (undo,
FPM-lock, class-includes, lock-handle) also need write access configured —
`ABAP_MODE=edit` or `admin`, or the legacy `ABAP_ALLOW_WRITE=true` when
`ABAP_MODE` is unset — without which they collect and skip rather than run
(`test/helpers/live-write-gate.ts`). The lock-handle suite's own
runtime check (`withStatefulSession` refuses with `READ_ONLY` when
`readOnly`) resolves from that same `ABAP_MODE`/`ABAP_ALLOW_WRITE` logic, so
the collection gate and the runtime check now always agree. Excluded from
every offline run by name — the only way to run them is `npm run test:live`
(`VITEST_LIVE=1`).

Requirements: an ABAP system with ADT enabled (`/sap/bc/adt/*` reachable over
HTTP), a user with `S_DEVELOP` (a dedicated technical user is recommended)
with `$TMP` writable — the only package the write-capable live tests target
— and `ABAP_MODE=edit` or `admin` for anything beyond the read-only checks.

**These tests write to, activate, run, and debug against a real system.**
The server does not confine writes to `$TMP` unless you set
`ABAP_ALLOW_PACKAGES`, so these tests are not sandboxed at all beyond what
you configure. Do not point `ABAP_URL` at a productive system, and do not run
`test:live` against any system you are not prepared to see mutated. The
suites also serialize (one connection, no parallel logons): a shared sandbox
has a small, finite pool of dialog work processes and a finite failed-login
budget before the technical user locks. That serialisation covers this test
run against the sandbox only; for several `abapsmith` *processes* sharing one
appliance, see [doc/CONCURRENCY § Several agents, one
sandbox](../CONCURRENCY/several-agents-one-sandbox.md).

### Appliance-state outcomes

`test/live-appliance-state.ts` gives the live suites a third, greppable
outcome alongside pass/fail: anything prefixed `APPLIANCE STATE:` — grep a
sweep log for it. A **skip** with that prefix means "we could not run this"
(a fixture never deployed, a stranded debug session found on arrival). A
**failure** with that prefix means the test ran and hit a failure shape that
is itself appliance state — system down, breaker tripped, a request that
timed out — and is still red; `underApplianceStateWatch` classifies but never
converts a real problem into a green skip. Anything without the prefix is a
candidate regression. Free dialog work processes are not measurable over
ADT — there is no SM50-class data reachable this way — so
`classifyApplianceStateFailure` recognises the failure shapes contention
produces (a timed-out request, a tripped breaker) rather than pretending to
count work processes; `integration.test.ts` and `integration-debug.test.ts`
are wired, `integration-undo`, `integration-fpm-lock`,
`integration-class-includes` and `integration-lock-handle` are not yet.

## Scripts

`scripts/` holds the few helpers the build, an `npm run` script, or the suite
itself depends on. Nothing there talks to a real system.
**[scripts/README.md](../../scripts/README.md)** indexes them, and
`test/scripts-readme-index.test.ts` fails if that index falls behind.

| Script | What it does |
|---|---|
| `check-no-leaks.mjs` | Behind `npm run check:leaks`; scans every git-tracked file for a routable IPv4 or real SAP hostname pattern. Never reads `.env`, and does not itself embed the value it guards against |
| `lint-hint-params.mjs` | Behind `npm run lint:hints`; flags caller-facing hint and error strings that name a tool parameter in camelCase where the zod schema field is snake_case |
| `gen-capability-table.mjs` | Regenerates the writable-type table in `skills/abapsmith-orient/SKILL.md` from the capability registry; `--check` fails when the shipped table is stale |
| `lib/first-line.mjs` | Shared helper, covered by `test/first-line.test.ts`; not run standalone |
