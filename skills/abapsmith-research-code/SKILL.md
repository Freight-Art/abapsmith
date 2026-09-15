---
name: abapsmith-research-code
description: Traces where an ABAP object is used, and what a toolbar button or function code actually runs, from static analysis only — abap_search where_used/source, abap_ui mode=fcode, abap_fpm_read mode=events. Use when asked "where is X used?" or "what does this button do?".
---

# Researching code

Two questions, two procedures. Both are static: nothing here executes ABAP
business logic. Procedure A walks outward from an object to its callers.
Procedure B walks from a UI entry point down to the code a button fires.

## Procedure A — find every usage of an object

1. `abap_search {"mode":"objects","query":"<pattern>","type":"<TYPE>"}` to
   locate the object and the packages in play. If the package is already
   known instead, `abap_read {"object":"<PKG>","type":"DEVC/K"}` lists its
   direct contents without a search at all.
   - Fallback when this returns nothing: widen the query pattern (drop a
     prefix segment) before assuming the object does not exist — `abap_search`
     truncates broad sweeps and marks that it did, it does not silently
     narrow one that was already narrow.
2. `abap_search {"mode":"where_used","query":"<OBJECT>","type":"<TYPE>"}`,
   narrowed by `type`. **Where-used is a static index: it lists registered
   references only.** Quote the note the tool itself prints — dynamic calls
   (`CALL FUNCTION lv_name`, `PERFORM (lv_form)`, `SUBMIT (lv_prog)`) do not
   appear, and those are blind spots, not absences.
   - Refusal to expect: none outright, but a wide target can take many
     seconds and still come back empty — the cost tracks the target's fan-in,
     not the `max` you pass. A fast zero on a widely-referenced name is a
     reason to double-check the type filter, not proof of no use.
   - Fallback when this returns nothing: proceed to step 3 regardless — an
     empty where-used never substitutes for a source search, because the two
     find different things.
3. Source-text search: `abap_search {"mode":"source","query":"<literal>","packages":["<PKG>"],"include_subpackages":true}`
   (or `"objects":"ZCL_MY_*"` — an object-name pattern with `*` wildcards,
   not a list — instead of, or in addition to, `packages`) to catch what
   where-used cannot: dynamic `CALL FUNCTION lv_name`, `SUBMIT (lv_prog)`,
   `PERFORM (lv_form) IN PROGRAM`, message numbers, and plain literals.
   **A hit inside a comment or a string literal is not a call** — the tool
   prints that caveat itself, and it must be respected, not glossed over.
   Also remember a source scan of a program does not follow its `INCLUDE`
   statements: includes are separate objects (`PROG/I`), found through
   `D010INC`, not through scanning the main program (see the live transcript
   below).
   - Refusal to expect: absent entirely under `ABAP_MODE=read` (it deploys
     an ABAP class to run the scan) — see Gates below.
   - Fallback when this returns nothing: broaden from `objects` to
     `packages`+`include_subpackages`, or check the literal is not
     blank-padded / split across a line continuation.
4. `abap_read {"view":"definition","object":"<OBJ>","line":N,"column":M}`
   (element info) to confirm the declaring class for a method-level hit, so
   an inherited or redefined method is not attributed to the wrong class.
   - Refusal to expect: a `line`/`column` that does not point at an
     identifier returns nothing useful — fall back to the class's own
     outline (`abap_read {"object":"<OBJ>","outline":true}`) and its line
     ranges instead of guessing coordinates.
5. Report per hit: object, include, line, and the exact `abap_read` call
   that opens it. **Keep "registered references" (step 2) and "text hits"
   (step 3) in separate lists and never merge them** — they are different
   kinds of evidence, and a reader needs to know which kind backs each line.

**How to prove it**: every reported usage carries an `abap_read` call that
was actually issued and a line range that was actually read back — not an
inference from a search snippet.

## Procedure B — what does this button do

1. Classify the entry point first:
   - classic dynpro → `abap_ui {"mode":"screen","tcode":"<TCODE>"}` — it
     reads `TSTC-CINFO`, which tells you whether it is a dialog or a report
     transaction before you go any further.
   - FPM / Web Dynpro → `abap_fpm_read {"mode":"find","query":"<pattern>"}`
   - Fiori / OData → `abap_service`
   - Fallback when the classification guess is wrong: `mode=find` returning
     zero configs, or `mode=screen` returning nothing for a `tcode`, means
     try the other family — a transaction code can front either kind of UI.
2. Dynpro path: `abap_ui {"mode":"fcode","tcode":"<TCODE>","fcode":"<FCODE>"}`
   (or `program`+`dynpro` instead of `tcode`) to get GUI status → PAI module
   (in flow-logic order, `AT EXIT-COMMAND` flagged) → include and line range
   → the `WHEN` branch whose literal matches, with its outgoing calls
   (`PERFORM`, `CALL FUNCTION`, `CALL METHOD`/`->`, `CALL TRANSACTION`,
   `LEAVE TO TRANSACTION`, `SUBMIT`). Then `abap_read` that exact line range.
   - Refusal to expect: a `CASE` on something other than the OK-code field,
     or a lookup-table / dynamic dispatch, is reported as `unresolved`,
     naming the module and include — it never silently falls through.
   - Fallback when `fcode` is unresolved, or absent under `ABAP_MODE=read`:
     fall back to `abap_ui mode="screen"` for the flow logic, resolve the
     real includes by hand through `D010INC` (filtering out generated
     entries), and `abap_read` the module directly — remembering the
     dispatch variable is often an alias for the OK-code field, `WHEN`
     literals are blank-padded, one `WHEN` can carry several literals, and a
     pre-dispatch remap can rewrite the function code before the real
     `CASE` (see the live transcript below).
3. FPM path: `abap_fpm_read {"mode":"events","config_id":"<ID>","uibb":"<UIBB>"}`,
   then `abap_bopf` for a `bopf` handler, or `abap_read` of the feeder's
   `PROCESS_EVENT` for a `feeder` handler. **Reproduce these four coverage
   limits verbatim, every time — a reader must see them even if they never
   run the tool:**
   - an application-controller override can intercept or replace any event
     listed
   - personalisation can rebind toolbar elements at run time
   - context-based adaptation (CBA) and configuration deltas are not
     resolved
   - nothing is executed, so no run-time event is observed
   Also: a toolbar `TEXT` value is often a bare number — a key into
   `WDY_CONFIG_DATT`/`WDY_CONFIG_APPT` — and `mode=events` does not resolve
   it and says so.
   - Refusal to expect: absent under `ABAP_MODE=read`; refuses
     `FLUID_API_DISABLED` if `ABAP_FLUID_API=false`.
   - Fallback: if `mode=app` reports a configuration does not exist, retry
     with `mode=outline` on the same key before concluding anything (see the
     live transcript below) — this is a known quirk, not proof the config is
     missing.
4. When static tracing stops, name the dynamic option and its cost — never
   reach for these first:
   - `abap_debug` — sets a breakpoint and steps; needs a debuggee and is
     slow, but it answers what actually runs when nothing else can.
   - `abap_ui {"mode":"press", ...}` — **commits business data and cannot be
     rolled back**; needs `ABAP_MODE=admin` **and** `ABAP_ALLOW_UI_PRESS=true`
     **and** `confirm:true`. Never the first move, and never a substitute
     for reading the code.
5. Report the chain button → code, one hop per line, each hop carrying the
   tool call that proved it.

**How to prove it**: the chain is proven when every hop names the tool call
that produced it and the final hop is a line range actually read with
`abap_read` — not a plausible guess at what a button "probably" does.

## Both procedures: the gates

`ABAP_MODE=read` removes every fluid-backed step: `abap_search mode="source"`,
`abap_ui mode="fcode"` and `abap_fpm_read mode="events"` all deploy an ABAP
class into `$ABAPSMITH_FLUID_API` in order to read, so they are absent under
`read` mode. `abap_search mode="where_used"`, `abap_read` (including
`view="definition"`) and `abap_data_preview` still work under `read`. When a
mode blocks a step, fall back to where-used plus `abap_read` of the module
source located by hand — slower and more manual, but it does not need write
capability.

## Live transcript (A4H, 2026-09-15)

Everything below was actually observed on that date, but **with the tools
already shipped at the time** — `abap_ui mode="screen"`, `abap_read`,
`abap_search mode="source"`, `abap_data_preview`, `abap_fpm_read
mode="outline"`. Neither `abap_ui mode="fcode"` nor `abap_fpm_read
mode="events"` has ever run against a live system: both are **unverified**,
built in this same change as this skill.

- `abap_ui {"mode":"screen","program":"SAPMSVMA","dynpro":"100"}` returned
  `fieldsCount 28, flowCount 23, statusCount 3, functionsCount 16,
  fkeysCount 34`. Flow logic included `MODULE EXIT_COMMAND AT
  EXIT-COMMAND.`, a `CHAIN.`/`ENDCHAIN.` block, `MODULE CHECK_VARIANT ON
  CHAIN-REQUEST.` and `MODULE ACTION.`. GUI statuses `100`, `200`, `ERROR`.
  The system's language is German, so button texts came back German
  (`BACK` / `Zurück`).
- `abap_search {"mode":"source","query":"MODULE action.","objects":"SAPMSVMA","types":["PROG"]}`
  returned 1 hit at `SAPMSVMA` line 117, with `includesScanned: 1` — **a
  source scan of a module pool does not follow its `INCLUDE` statements**.
  Includes are separate objects (`PROG/I`), and `abap_search
  {"query":"MSVMA*","type":"PROG"}` returns 0 rows because the `PROG` filter
  means `PROG/P`. To reach a program's includes, read `D010INC`
  (`abap_data_preview {"table":"D010INC","where":[{"field":"MASTER","op":"eq","value":"SAPMSVMA"}]}`)
  — 13 rows for SAPMSVMA, of which only `MSVMAF01` and `MSVMAO01` are real
  includes; the rest are generated entries (`%_CABAP`, `<SYSINI>`,
  `CX_ROOT=======================CU`).
- `abap_read {"object":"SAPMSVMA","offset":100,"limit":80}` showed module
  `ACTION` at line 117 starting `function = ok_code.` and then `case
  function.` — **the dispatch variable is usually an alias, not `ok_code`
  itself**. `WHEN` literals are blank-padded (`when 'UPD '.`), a `WHEN` can
  carry several literals (`when 'ENDE' or 'BACK'.`), statements sit on the
  same line as the `WHEN`, and the module contains a pre-dispatch remap
  (`case function. when 'UPD '. move 'UPDL' to function.`) that rewrites the
  function code before the real dispatch. Module `EXIT_COMMAND` at line 453
  has no `CASE` at all — its whole body (`set screen 0. leave screen.`) runs
  for every function code.
- The FBI view action mapping lives in the view's own configuration XML,
  under `Node Name="CONFIGURATION_CONTEXT"` → `Node Name="ACTIONS"`
  (`ACTIONID`, `ACTION_IMPL`, `ACTION_CONF`, `TEXT`, `TOOLTIP`), with the BO
  and node under `Node Name="HEADER"` (`BO`, `NODE`). The DDIC table
  `/BOFU/IFBIV_A` exists but is **empty on A4H (0 rows)**, so the table
  route is unverified there.
- BOPF design-time names on this release: `/BOBF/OBM_NODE` (BO nodes) and
  `/BOBF/ACT_LIST` (BO actions); active rows carry `VERSION = '00000'`. Note
  that `/BOBF/OBM_ACTION` and `/BOBF/NOD_LIST` do **not** exist — both were
  tried and returned `ADT_ERROR ... Cannot find`.
- Toolbar element type codes come from two DDIC domains: `FPM_BUTTON_TYPE`
  (`BU` button, `TB` toggle button, `BC` button choice, `LA` link to action)
  and `FPMGB_DISPLAY_TYPE` (28 values; `BT` button, `TB` toggle button, `BC`
  button choice, `SE` separator).
- An FPM button that maps to a BO action carries `ACT_CONF_KEY` in its event
  parameters — observed in `/BOFU/CL_FBI_GUIBB_LIST`'s
  `IF_FPM_GUIBB_LIST~PROCESS_EVENT`, which reads
  `/bofu/if_fbi_runtime_c=>sc_event_parameters-common_params-act_conf_key`
  and comments "The action is a BO action".
- Open question, not resolved: `abap_fpm_read
  {"mode":"app","config_id":"/BOFU/TEST_FBI_SALES_ORDER_OVP","config_type":"00"}`
  failed with `FLUID_ACTION_FAILED` and the frame `{kind:"exception",
  step:"load_configuration", text:"Configuration
  /BOFU/TEST_FBI_SALES_ORDER_OVP does not exist"}`, even though `mode=find`
  lists exactly that ID under `config_type=00`. `mode=outline` on the same
  key succeeded. Practical advice: if `mode=app` reports a configuration
  does not exist, retry with `mode=outline` before concluding anything.

## Worked runs still owed

The following live runs are outstanding — none of them has been done yet:

- A function module reached only through a dynamic caller.
- A message number traced from source back to its raising statement.
- A classic dynpro button, end to end, through `abap_ui mode="fcode"`.
- An FBI view button mapped all the way to a BOPF action.
- A freestyle feeder button, end to end, through `abap_fpm_read
  mode="events"`.

## Surface note

This skill's steps use v1 names throughout: `abap_search`, `abap_ui`,
`abap_fpm_read`, `abap_bopf`, `abap_read`. On `ABAP_TOOL_SURFACE=v2` — the
shipped default is `v1`; `v2` is deprecated and removed in 0.6.0 — the same
ground is covered by `abap_find` (search, in place of `abap_search`) and
`abap_do` (everything else in this skill: fcode/events tracing, BOPF
lookups, and the debug/press escape hatches), called as actions of those two
tools rather than as separate tool names. Check `tools/list` rather than
assuming which surface is live.

## Not this skill

A general survey of an unfamiliar package is `abapsmith-explore-a-package`.
Diagnosing an actual runtime failure (a dump, an exception, a wrong value)
is `abapsmith-debug-a-failing-run` — this skill stops at static tracing and
only names the dynamic tools, it does not drive them.
