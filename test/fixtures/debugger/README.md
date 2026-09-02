# Debugger XML fixtures

These seven fixtures are lifted verbatim from the Go test literals in
[`vibing-steampunk`](https://github.com/oisee/vibing-steampunk)'s
`pkg/adt/debugger_test.go`. They give the `debug/xml-response.ts` response
parsers a red/green loop with zero live SAP calls.

Upstream repository: <https://github.com/oisee/vibing-steampunk>
License: MIT — `Copyright (c) 2025-2026 Alice Vinogradova and contributors`.
See `/THIRD-PARTY-NOTICES.md` at the repo root for the full license text.

## Provenance

| Fixture | Source test | Source lines (as cloned, depth 1) |
|---|---|---|
| `attach.xml` | `TestParseAttachResponse` | `pkg/adt/debugger_test.go:587-612` |
| `step.xml` | `TestParseStepResponse` | `pkg/adt/debugger_test.go:654-675` |
| `stack.xml` | `TestParseStackResponse` | `pkg/adt/debugger_test.go:700-731` |
| `variables.xml` | `TestParseVariablesResponse` | `pkg/adt/debugger_test.go:771-810` |
| `child-variables.xml` | `TestParseChildVariablesResponse` | `pkg/adt/debugger_test.go:856-887` |
| `debuggee.xml` | `TestParseDebuggeeResponse` | `pkg/adt/debugger_test.go:912-937` |
| `debuggee-postmortem.xml` | `TestParseDebuggeeResponse_PostMortem` | `pkg/adt/debugger_test.go:968-990` |

Each file is the exact XML string literal from the named Go test, unindented
to be a standalone well-formed document (the Go source embeds it as a raw
string with Go-level leading tabs stripped; no XML content was altered).
The XML declaration in the Go source says `encoding="utf-8"` for these seven
though other fixtures in the same file say `UTF-8` — both are copied as-is,
byte-for-byte, from their respective test.

Note the two structural response families these fixtures cover — do not
write one generic parser for both:

- `attach.xml` / `step.xml` / `stack.xml` — the **`dbg:` family**: camelCase
  attributes, booleans as `"true"`/`"false"`. Live-verified: `dbg:`-namespaced
  attributes never carry `="X"` or `='X'` anywhere in
  `test/fixtures/live-captured/` (grep count: 0).
- `variables.xml` / `child-variables.xml` / `debuggee.xml` /
  `debuggee-postmortem.xml` — the **`asx:abap` family**: SCREAMING_SNAKE child
  elements. **Booleans are per-structure, not envelope-wide across these four
  files** — do not assume one convention covers all of them:
  - `STPDA_ADT_VARIABLE` rows (`variables.xml` / `child-variables.xml`): the
    `"X"`/self-closing-empty convention is live-verified for exactly two
    elements corpus-wide. `READ_ONLY` — 85× `<READ_ONLY/>` (false) and 2×
    `<READ_ONLY>X</READ_ONLY>` (true), both of the latter in
    `033-vars-parameters-scope.xml`. `IS_LOCAL` (lock responses only) — 5×
    `<IS_LOCAL>X</IS_LOCAL>` across `063-class-lock.xml`,
    `093-np-lock.xml`, `106-np-relock.xml`, `213-np-lock.xml`,
    `228-np-relock.xml`; no capture ever shows a self-closing `<IS_LOCAL/>`,
    so the false form for `IS_LOCAL` specifically is **not settled by any
    capture**.
  - `STPDA_DEBUGGEE` rows instead use the strings `"true"`/`"false"`,
    live-verified in `015-listener-hit.xml`, `099-np-listener-hit.xml` and
    `220-np-listener-hit.xml`: `<IS_ATTACH_IMPOSSIBLE>false</IS_ATTACH_IMPOSSIBLE>`,
    `<IS_SAME_SERVER>true</IS_SAME_SERVER>`,
    `<CAN_ADT_CROSS_SERVER>true</CAN_ADT_CROSS_SERVER>`. **`debuggee.xml`
    uses the wrong boolean family for this structure** — see "Known fixture
    vs. wire mismatches" below.
  - `IS_VALUE_INCOMPLETE` and `IS_EXCEPTION` (also `STPDA_ADT_VARIABLE`
    fields) are self-closing/empty in all 87 `STPDA_ADT_VARIABLE` rows across
    the entire live capture set — no capture ever populates either one, so
    their boolean family is **undetermined**, not merely defaulted to false.

Also note `variables.xml` (`getVariables`) nests `<DATA><STPDA_ADT_VARIABLE>`
directly, while `child-variables.xml` (`getChildVariables`) nests
`<DATA><HIERARCHIES>…</HIERARCHIES><VARIABLES><STPDA_ADT_VARIABLE>…</VARIABLES></DATA>`
— same row type, different envelope depth.

## Known fixture vs. wire mismatches

These seven fixtures are hand-lifted from a third-party Go test suite, not
captured from the wire. Cross-checking against
`test/fixtures/live-captured/` turns up several places where a fixture
disagrees with what the real server sends. Do not build new protocol
assertions on the specifics below — treat these fixtures as parser inputs
only:

- **`step.xml`** invents an empty self-closing `<dbg:reachedBreakpoints/>`
  element. No live capture ever emits that empty form: when no breakpoint is
  hit, the server omits `reachedBreakpoints` entirely (zero occurrences of
  the string in `028-step-over-1.xml`, `029-step-over-2.xml`,
  `030-step-into.xml`); when one is hit, it emits the element populated with
  a `<dbg:breakpoint>` child instead (`035-step-return.xml`).
- **`stack.xml`** has the namespace prefixes inverted versus the wire. Live
  (`018-stack-2frames.xml`) is a bare, unprefixed `<stackEntry ...>` element
  that itself carries an `adtcore:uri` attribute, e.g.
  `adtcore:uri="/sap/bc/adt/programs/programs/zmcp_dbg_demo/source/main#start=84,0"`.
  Live source-position fragments also carry a `,<column>` suffix
  (`#start=84,0`) that `stack.xml` lacks.
- **`debuggee.xml`** uses the `"X"`/`""` boolean family for `STPDA_DEBUGGEE`
  fields. Live `STPDA_DEBUGGEE` rows use `"true"`/`"false"` instead (see the
  `STPDA_DEBUGGEE` bullet above) — none of `debuggee.xml`'s booleans match a
  live capture.
- **`debuggee-postmortem.xml`** has no live counterpart at all. Every live
  capture that carries `DBGEE_KIND` (`015-listener-hit.xml`,
  `099-np-listener-hit.xml`, `220-np-listener-hit.xml`) has the value
  `DEBUGGEE`; no capture in the set has ever produced `POSTMORTEM`, so the
  post-mortem shape is unverified against the wire.
- **`variables.xml`**'s `<HEX_VALUE>0000002A</HEX_VALUE>` for `LV_COUNT`
  (`TECHNICAL_TYPE=I`, `VALUE=42`) is **big-endian**. Live `TECHNICAL_TYPE=I`
  hex is **little-endian**: `223-np-vars-negative.xml`'s `LV_ZMCP_NEGI`
  (`VALUE=42-`, i.e. −42) has `<HEX_VALUE>D6FFFFFF</HEX_VALUE>` — two's
  complement −42 (`0xFFFFFFD6`) written as 4 little-endian bytes.
  `variables.xml` also uses `<TECHNICAL_TYPE>u</TECHNICAL_TYPE>` for
  `LS_DATA`; that type code occurs in **zero** live captures (grep count:
  0), so its meaning is unverified.

## Per-file pointer header

Apply this comment to the top of any `.ts` file that ports logic derived from
vsp (the breakpoint XML builder, the response parsers, the endpoint/constant
table, the listener client, `toClassPool`). Do **not** add it to genuinely
original work (transport wrapper, MCP tool surface, session manager,
variable-inspection design) — swap the file/function name in parens as
appropriate:

```ts
/**
 * Portions derived from vibing-steampunk (pkg/adt/debugger.go),
 * Copyright (c) 2025-2026 Alice Vinogradova and contributors, MIT.
 * See THIRD-PARTY-NOTICES.md.
 */
```
