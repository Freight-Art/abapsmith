# Live-captured ADT wire bytes — A4H, 2026-07-31

These are **REAL response bytes** captured from a live SAP ABAP Platform Trial (A4H) appliance on
**2026-07-31 (UTC)**. Nothing here is hand-written, reformatted or pretty-printed: each `.xml` /
`.txt` file is the byte-exact response body, and each `NNN-<label>.meta.json` sidecar carries the
request method, URL, request headers (secrets redacted), request body, response status, response
headers, `byteLength`, `zeroByteBody`, `sha256` and `durationMs`. `ledger.tsv` is the flat index
(`n / label / method / path / status / byteLength / durationMs`) for all 96 captures.

| | |
|---|---|
| Appliance | `http://203.0.113.10:50000` (A4H ABAP Platform Trial) |
| Server / instance | `a4hsandbox_A4H_00` (from `serverName` on every `dbg:` root) |
| Client | `001` (`p3b-sap-usercontext.txt` reads `sap-client=001`; the p3 capture was a byte-identical duplicate and is not kept) |
| User | `DEVELOPER` |
| Debug target | `ZMCP_DBG_DEMO` (report, `$TMP`), driven via `ZMCP_DBG_RUN` classrun |
| Capture window | `2026-07-31T23:49Z` – `2026-08-01T00:1xZ` (main run), plus the `211-231` retry |
| Captures | 96 top-level (all have a `.meta.json`; all 96 appear in `ledger.tsv`) |
| Live requests, all runs | **127** = 96 here + 31 in `_run1-accept-bug/` (the `Accept`-header failure) |

## These supersede `test/fixtures/debugger/`

The seven files in `test/fixtures/debugger/` (`attach.xml`, `stack.xml`,
`step.xml`, `variables.xml`, `child-variables.xml`, `debuggee.xml`, `debuggee-postmortem.xml`) were
**invented** — hand-written from documentation, not captured. They are wrong in specific,
load-bearing ways listed under **CONTRADICTIONS** below. Treat the files in this directory as the
authority for any question about what SAP actually puts on the wire. The invented fixtures should
be retired or relabelled as synthetic.

Structural facts about the invented set, all of which the live bytes contradict:

- Every row-bearing invented fixture has **exactly 2 rows** (`variables.xml` 2 × `STPDA_ADT_VARIABLE`,
  `child-variables.xml` 2, `stack.xml` 2 × `stackEntry`, `debuggee.xml` 1 × `STPDA_DEBUGGEE`).
- **None is empty** and none is a zero-byte body.
- **None is large** — the biggest is `variables.xml` at 1368 B; the live set reaches 17 988 B
  (`025`) and 10 812 B (`024`).

---

## Capture table

Sizes and statuses below are taken from the `.meta.json` sidecars / `ledger.tsv` — none is guessed.

### Session bootstrap / CSRF

| File | Bytes | Status | What it proves |
|---|---:|---:|---|
| `011-csrf-fetch-a.xml` | 1084 | 200 | `GET /debugger/breakpoints/messagetypes` is a safe, cheap CSRF-token source; returns a `nameditem:namedItemList` of 6 message types. |
| `014-csrf-fetch-b.xml` | 1084 | 200 | Same body byte-for-byte on a second fetch — the endpoint is idempotent and side-effect free. |
| `051-csrf-fetch-lt.xml` | 1084 | 200 | Token re-fetch before the listener-timeout probe. |
| `061-csrf-cleanup.xml` | 1084 | 200 | Token re-fetch for the cleanup session. |
| `081-p3b-csrf.xml` | 1084 | 200 | Token for the dataPreview probe (first attempt). |
| `086-p3b-csrf.xml` | 1084 | 200 | Token for the dataPreview probe (corrected `Accept`). |
| `091-np-csrf-a.xml` | 1084 | 200 | Token for the negative-packed edit session. |
| `097-np-csrf-b.xml` | 1084 | 200 | Token for the negative-packed debug session. |
| `201-csrf-fetch.xml` | 1084 | 200 | Token for the listener-conflict probe. |

### Breakpoints

| File | Bytes | Status | What it proves |
|---|---:|---:|---|
| `012-bp-reject-comment-line.xml` | 235 | 200 | A breakpoint on a COMMENT line is **rejected in-band**: HTTP 200, `<breakpoint kind="line" clientId="bp82" errorMessage="Cannot create a breakpoint at this position" nonAbapFlavour=""/>` — no `id`, no HTTP error. Confirms `errorMessage` rows must not be dropped. |
| `013-bp-set-accepted.xml` | 839 | 200 | Two accepted line breakpoints. Child element is **bare `<breakpoint>`** under a prefixed `<dbg:breakpoints>` root, and it carries **`adtcore:uri`** (namespaced), plus `adtcore:type`, `adtcore:name`, `nonAbapFlavour`, with `xmlns:adtcore` declared **per element**. |
| `044-bp-clear-all.xml` | 100 | 200 | Successful clear-all returns the **self-closing empty root** `<dbg:breakpoints xmlns:dbg="…"/>` — 100 bytes, HTTP 200, zero child elements. |
| `098-np-bp-set.xml` | 478 | 200 | Single accepted breakpoint (line 84), same shape as `013`. |
| `105-np-bp-clear.xml` | 100 | 200 | Byte-identical to `044` — the empty-root clear response is stable. |

### Listener

| File | Bytes | Status | What it proves |
|---|---:|---:|---|
| `015-listener-hit.xml` | 1265 | 200 | A hit returns the `asx:abap` → `DATA` → `STPDA_DEBUGGEE` envelope. **`IS_ATTACH_IMPOSSIBLE` is `false` and `IS_SAME_SERVER` is `true`** — the `"true"/"false"` family, NOT `"X"`. Also carries `CAN_ADT_CROSS_SERVER`, `HOST`, `APPSERVER`, `LISTENER_CTX_ID`, `URI`, `TYPE`, `NAME`, `PARENT_URI`, `PACKAGE_NAME`, `DESCRIPTION` (none in the invented `debuggee.xml`). |
| `043-listener-stop.txt` | 0 | 200 | `DELETE /debugger/listeners` → **zero-byte 200**, `content-length: 0`, **no `content-type` header at all**. |
| `052-listener-timeout-empty.txt` | 0 | 200 | `timeout=15` expiring after 15 103 ms → **zero-byte 200**, `content-length: 0`, no `content-type`. Byte-identical to `043`. |
| `053-listener-stop-after-timeout.txt` | 0 | 200 | Stop after a timeout — again zero-byte 200, no `content-type`. |
| `099-np-listener-hit.xml` | 1265 | 200 | Second-session hit, same shape as `015`. |
| `104-np-listener-stop.txt` | 0 | 200 | Zero-byte 200. |
| `202-listener-probe-existing.xml` | 345 | 404 | `GET /debugger/listeners?checkConflict=false` with no listener held → **404** `exc:exception` / `ExceptionResourceNotFound` / `Resource   does not exist.` (note the embedded double space). |
| `203-listener-probe-conflict.txt` | 0 | 200 | `checkConflict=true` with no conflict → **zero-byte 200**, no `content-type`. |

### Trigger (running the debuggee)

| File | Bytes | Status | What it proves |
|---|---:|---:|---|
| `016-trigger-classrun.xml` | 9993 | 500 | `POST /oo/classrun/ZMCP_DBG_RUN` returns a **`text/html` ICM "Application Server Error" page**, not XML, when the run is suspended at a breakpoint. Any XML parser fed this body fails; the `.xml` extension is a misnomer. |
| `100-np-trigger.xml` | 9993 | 500 | Byte-identical HTML page in the second session — the shape is deterministic. |

### Attach

| File | Bytes | Status | What it proves |
|---|---:|---:|---|
| `017-attach.xml` | 1526 | 200 | The real `<dbg:attach>` root: 16 attributes, all booleans as `"true"/"false"`. Children: `<dbg:reachedBreakpoints>` (one `<dbg:breakpoint>` with `unresolvableCondition=""` / `unresolvableConditionErrorOffset=""`) and `<dbg:actions>` (4 `<dbg:action>` rows, each with `link`, `value`, `disabled`). **No `<dbg:settings>` on attach.** |
| `101-np-attach.xml` | 1526 | 200 | Second session, same 1526-byte shape. |

### Stack

| File | Bytes | Status | What it proves |
|---|---:|---:|---|
| `018-stack-2frames.xml` | 597 | 200 | **1 frame** at the outer breakpoint (line 84) — the file name is wrong, see the note below. **Settles the URI spelling: `adtcore:uri`, namespaced, with `xmlns:adtcore` declared on the `stackEntry` itself.** Child element is **bare `<stackEntry>`**, not `dbg:stackEntry`. |
| `031-stack-3frames.xml` | 989 | 200 | **2 frames** inside `lcl_calc=>line_value` — the file name is wrong, see the note below. `stackPosition="2"` first, then `stackPosition="1"`, i.e. **innermost-first ordering**. |
| `036-stack-after-return.xml` | 597 | 200 | Back to 1 frame (line 93) after `stepReturn` — frame count drops as expected. |
| `039-stack-after-error-probes.xml` | 597 | 200 | Byte-identical to `036`: the session survives the out-of-range / unknown-name variable probes intact. |

> **The stack file names overstate the frame count by one.** Counting `<stackEntry ` occurrences:
> `018-stack-2frames.xml` has **1**, `031-stack-3frames.xml` has **2**, `036-stack-after-return.xml`
> has **1**, `039-stack-after-error-probes.xml` has **1**. The labels — and the `expect` note in
> `031-stack-3frames.meta.json` ("MORE THAN 2 FRAMES - the case no fixture has") — are **wrong**.
> **No capture in this set has more than 2 stack frames**, so the >2-frame case remains uncaptured
> (see NOT CAPTURED). Trust the bytes, not the file name.

### Variables

| File | Bytes | Status | What it proves |
|---|---:|---:|---|
| `019-vars-root-scopes.xml` | 339 | 200 | `getChildVariables("@ROOT")` at report level: `<VARIABLES/>` **self-closing/empty** plus one `HIERARCHIES` row (`@ROOT` → `@GLOBALS`). Scope discovery returns hierarchy only, no variable rows. |
| `020-vars-globals-scope.xml` | 9299 | 200 | `@GLOBALS` expansion, **11 rows** (`LT_CAT_TOTALS`, `LV_GRAND_TOTAL`, `LV_COUNTER`, `LV_AVERAGE`, `LV_TOP_CATEGORY`, `LV_TOP_TOTAL`, `LT_ITEMS`, `LS_ITEM`, `LV_LINE_TOTAL`, `LS_CAT_SCAN`, `LS_CAT_OUT`). Far beyond the invented 2-row shape. |
| `021-vars-table-15rows.txt` | 0 | 200 | `getChildVariables` on an internal-table node **does NOT enumerate its rows** — zero-byte 200, `content-length: 0`, no `content-type`. |
| `022-vars-table-empty.txt` | 0 | 200 | A genuinely empty (0-row) table → **the same zero-byte 200**. Indistinguishable from `021`. |
| `023-vars-row-components.xml` | 6130 | 200 | `getChildVariables("LT_ITEMS[1]")` → **7 component rows** (`CLIENT`, `ITEM_ID`, `MATERIAL`, `CATEGORY`, `QUANTITY`, `UNIT_PRICE`, `POSTING_DATE`). Row expansion works; row *enumeration* does not. |
| `024-vars-table-rows-synthesised.xml` | 10812 | 200 | **15 `STPDA_ADT_VARIABLE` rows** from a single `getVariables` with synthesised `LT_ITEMS[n]-ITEM_ID` ids — the ">2 rows" case no invented fixture has. First `LT_ITEMS[1]-ITEM_ID` = `[A001      ]`, last `LT_ITEMS[15]-ITEM_ID` = `[S005      ]` (both `LENGTH=10`, CHAR-padded to 10). |
| `025-vars-table-rows-full.xml` | 17988 | 200 | **21 rows = 3 parents × 7 components** in ONE `getChildVariables`, plus a 21-entry `HIERARCHIES` block. Largest capture in the set. |
| `026-vars-table-row-past-end.txt` | 0 | 200 | One index past the end of the table → **zero-byte 200**, no error, no `content-type`. |
| `027-vars-char-and-packed.xml` | 7156 | 200 | **10 rows** of `TECHNICAL_TYPE` C / P / I with byte-exact padding: `C` values are space-padded to `LENGTH` (`[A001      ]`, `[Laptop Sleeve                 ]`, `[ACCESSORY ]`, `[          ]`), and `P`/`I` values carry a **trailing space in the sign column** (`[12.50 ]`, `[0.00 ]`, `[0.0000 ]`, `[0 ]`). `HEX_VALUE` is UTF-16**LE** for C and BCD for P (positive sign nibble `C`) — live-verified: `LT_ITEMS[1]-ITEM_ID` (`LENGTH=10`, `VALUE=[A001      ]`) has `HEX_VALUE` starting `4100`, which is `'A'` (U+0041) only under little-endian; big-endian would read U+4100. |
| `032-vars-root-scopes-in-method.xml` | 643 | 200 | `@ROOT` **inside a method** yields three scopes: `@GLOBALS`, `@PARAMETERS`, `@LOCALS` — the scope set is frame-dependent, unlike `019`'s single `@GLOBALS`. |
| `033-vars-parameters-scope.xml` | 2484 | 200 | `@PARAMETERS` → 3 rows (`IV_QTY`, `IV_PRICE`, `RV_TOTAL`). |
| `034-vars-locals-scope.xml` | 986 | 200 | `@LOCALS` → 1 row (`LV_RAW`), `VALUE=[0.00 ]`. Proves the 1-row case, which fast-xml-parser returns as an object rather than an array. |
| `037-vars-out-of-range-row.txt` | 0 | 200 | `getVariables` with an out-of-range row index → **zero-byte 200**, no `content-type`. |
| `038-vars-unknown-name.txt` | 0 | 200 | `getVariables` with a completely unknown identifier → **zero-byte 200**, no `content-type`. Identical to `037` and to `022`. |
| `102-np-vars-negative.xml` | 1501 | 200 | Negative-packed probe, **first attempt (failed)**. Requested 4 ids; **only 2 came back** (`LV_GRAND_TOTAL`, `LT_ITEMS[1]-UNIT_PRICE`) — the two probe variables were silently dropped. Proves that unknown ids in a mixed batch are **silently omitted**, not errored. Superseded by `223`. |
| `223-np-vars-negative.xml` | 2757 | 200 | **Negative-packed probe, second attempt — SETTLES THE SIGN QUESTION.** All 4 ids returned. `LV_ZMCP_NEG` (P, len 8) = `[123.45-]` / `000000000012345D`; `LV_ZMCP_NEGI` (I, len 4) = `[42-]` / `D6FFFFFF`. **The sign is a TRAILING character**: `-` if negative, space if positive. BCD nibble `D`=neg, `C`=pos. Integer `HEX_VALUE` is **little-endian two's complement**, packed is big-endian BCD. |
| `224-np-vars-negative-children.xml` | 10832 | 200 | `@GLOBALS` scope listing (13 rows) taken at the same breakpoint; independently reproduces the `[123.45-]` / `[42-]` rendering, so `223` is not an artefact of the id-batch path. |

### Steps

| File | Bytes | Status | What it proves |
|---|---:|---:|---|
| `028-step-over-1.xml` | 1396 | 200 | `<dbg:step>` root: 14 attributes, `isDebuggeeChanged="false"`, plus `<dbg:settings systemDebugging="false" createExceptionObject="false" backgroundRFC="false" sharedObjectDebugging="false" showDataAging="false" updateDebugging="false"/>` and `<dbg:actions>`. **No `reachedBreakpoints` element at all** when no breakpoint was hit. |
| `029-step-over-2.xml` | 1396 | 200 | Byte-identical to `028`. |
| `030-step-into.xml` | 1396 | 200 | Byte-identical to `028` — a step response does NOT tell you where you are; you must re-read the stack. |
| `035-step-return.xml` | 1676 | 200 | `stepReturn` landed on a breakpoint, so `<dbg:reachedBreakpoints>` IS present and its `<dbg:breakpoint>` carries an extra **`vitBpUri="/sap/bc/adt/debugger/breakpoints/vit/id/2"`** attribute absent from `017`. |

### Errors / terminate

| File | Bytes | Status | What it proves |
|---|---:|---:|---|
| `040-terminate-debuggee.xml` | 1300 | 500 | Successful terminate returns **HTTP 500** `exc:exception` / `AdiFailed` / `An exception was raised`, with `previous1ExceptionClassName=CX_TPDAPI_FAILURE`. 500 is the *success* shape here. |
| `041-stack-after-terminate.xml` | 1290 | 500 | Reading the stack after terminate → 500 `AdiFailed` / `An exception was raised` (`CX_TPDAPI_FAILURE`, `CL_TPDAPI_SESSION…CM00F`). |
| `042-step-after-terminate.xml` | 835 | 500 | Stepping after terminate → 500 `AdiFailed` / **`Debuggee session stopped`**, `previous1ExceptionClassName=CX_TPDAPI_DEBUGGEE_ENDED`, `T100KEY-ID=TPDAPI`, `T100KEY-NO=021`. The only error body that names the real cause. |
| `103-np-terminate.xml` | 1300 | 500 | Byte-identical to `040`. |

### Object lifecycle / lock / CSRF probes

| File | Bytes | Status | What it proves |
|---|---:|---:|---|
| `062-class-get-check.xml` | 7547 | 200 | Class read before delete (`ZCL_ZMCP_STALE_PROBE`). |
| `063-class-lock.xml` | 359 | 200 | `_action=LOCK` returns `asx:abap`/`DATA` with `LOCK_HANDLE`, `IS_LOCAL=X` (**this family DOES use `X`**), `MODIFICATION_SUPPORT=NoModification`. |
| `064-class-delete.txt` | 0 | 200 | Successful DELETE → zero-byte 200, no `content-type`. |
| `071-p1-create-with-fetch-token.txt` | 28 | 403 | `POST /programs/programs` with `x-csrf-token: fetch` → **403**, 28-byte `text/plain` body `CSRF token validation failed`, response header **`x-csrf-token: Required`** (not a token). |
| `072-p1-verify-created.xml` | 353 | 404 | `GET /programs/programs/zmcp_csrf_probe` → 404 `ExceptionResourceNotFound` / `ZMCP_CSRF_PROBE does not exist` — the create was **not** applied. |
| `092-np-source-original.txt` | 5069 | 200 | Original `ZMCP_DBG_DEMO` source. |
| `093-np-lock.xml` | 323 | 200 | Program lock handle `B86D9872…`, `IS_LOCAL=X`, `MODIFICATION_SUPPORT` empty. |
| `094-np-put-modified.txt` | 0 | 200 | Source PUT accepted → zero-byte 200. |
| `095-np-activate.xml` | 1558 | 403 | Activation **refused** — see **NOT CAPTURED**. |
| `096-np-unlock.txt` | 0 | 200 | Unlock → zero-byte 200. |
| `216-np-activate.txt` | 0 | 200 | **The correct write sequence.** Activation succeeds with a zero-byte 200 when the lock is released first: lock → PUT → **UNLOCK** → activate. Contrast `095` (403) which activated while still holding the handle. |
| `217-np-source-verify.txt` | 5169 | 200 | Post-activation source read (original is 5069 B) confirming the edit reached the **ACTIVE** version — the check whose absence made the first attempt produce a meaningless capture. |
| `231-np-activate-restore.txt` | 0 | 200 | Restore activation, same corrected ordering. `ZMCP_DBG_DEMO` verified byte-identical (5069 B) to the pre-edit source (`092-np-source-original.txt`) afterwards. |
| `106-np-relock.xml` | 323 | 200 | Re-lock for the restore, same handle. |
| `107-np-put-restore.txt` | 0 | 200 | Original source PUT back → zero-byte 200. |
| `108-np-activate-restore.xml` | 1558 | 403 | Restore activation refused for the same reason as `095` (byte-identical body). |
| `109-np-unlock-restore.txt` | 0 | 200 | Final unlock → zero-byte 200. |

### `adtcore:packageRef` probes

| File | Bytes | Status | What it proves |
|---|---:|---:|---|
| `073-p2-packageref-prog.xml` | 3209 | 200 | `PROG/P` (`ZMCP_DBG_DEMO`) → `<adtcore:packageRef adtcore:uri="/sap/bc/adt/packages/%24tmp" adtcore:type="DEVC/K" adtcore:name="$TMP"/>`. |
| `074-p2-packageref-clas.xml` | 7240 | 200 | `CLAS/OC` (`ZMCP_DBG_RUN`) → `adtcore:name="$TMP"`. |
| `075-p2-packageref-intf.xml` | 2289 | 200 | `INTF/OI` (`IF_OO_ADT_CLASSRUN`) → `adtcore:name="SEO_ADT"`. |
| `076-p2-packageref-tabl-t000.xml` | 2216 | 200 | `TABL/DT` (`T000`) → `adtcore:name="STRM_T000"`, plus `adtcore:description="T000 API"`. |
| `077-p2-packageref-tabl-zmcp.xml` | 2630 | 200 | `TABL/DT` (`ZMCP_DBG_ITEM`) → `adtcore:name="$TMP"`, `adtcore:description="Temporary Objects (never transported!)"`. |

### dataPreview / system-role probe

| File | Bytes | Status | What it proves |
|---|---:|---:|---|
| `078-p3-datapreview-t000.txt` | 28 | 403 | dataPreview POST without a CSRF token → 403, 28-byte `CSRF token validation failed`. |
| `082-p3b-datapreview-t000.xml` | 520 | 406 | With a valid token but `Accept: application/xml` → **406** `ExceptionResourceNotAcceptable` / `The message content is not acceptable. Accepted content types: application/vnd.sap.adt.datapreview.table.v1+xml`. The dataPreview family needs its own vendor `Accept`. |
| `087-p3b-datapreview-t000.xml` | 1581 | 200 | `SELECT mandt, cccategory, cccoractiv FROM t000` succeeded. See A8 detail below. |

Non-HTTP files: `ledger.tsv`, `p3b-sap-usercontext.txt` (`sap-client=001`). The capture harness
that produced this set also wrote `p3-sap-usercontext.txt` and `np-original-source.abap.bak`
(a copy of the pre-edit `ZMCP_DBG_DEMO` source); both were byte-identical duplicates of files kept
here (`p3b-sap-usercontext.txt` and `092-np-source-original.txt` respectively) and are not committed.

#### `087` detail — is A4H productive?

Root `<dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">`, with
`<dataPreview:totalRows>2</dataPreview:totalRows>` and three `<dataPreview:columns>` blocks, each a
`<dataPreview:metadata dataPreview:name="…" dataPreview:type="C" … dataPreview:keyAttribute="false"
dataPreview:colType="" dataPreview:isKeyFigure="false"/>` plus a `<dataPreview:dataSet>` of
`<dataPreview:data>` values (column-major, not row-major).

| MANDT | CCCATEGORY | CCCORACTIV |
|---|---|---|
| `000` | `S` | `2` |
| `001` | `C` | `1` |

The working client is `001`, whose `CCCATEGORY` is **`C` (Customizing / customer test)** — not `P`
(Production) — and whose `CCCORACTIV` is **`1`** (changes to Repository/cross-client Customizing
allowed but recorded), so **A4H client 001 is not a productive system** and a fail-closed
productive-system lockout can be driven off `T000-CCCATEGORY`.

### ICF short-dump pages ("Application Server Error"), A4H, 2026-08-11

Six real `500 text/html` ICF error pages, captured live via `abap_run` against six purpose-built
`ZCL_ZMCP_DMP_*` classrun classes, each raising a different runtime error. No `.meta.json` sidecars
(these weren't taken by the automated capture harness the `NNN-*.meta.json` files above come from —
just direct HTTP captures of the response body); each is a byte-exact, unedited response body,
`Content-Type: text/html; charset=windows-1252`, HTTP status 500.

| File | Class | What it proves |
|---|---|---|
| `701-run-zcl_zmcp_dmp_zerodiv.html` | `ZCL_ZMCP_DMP_ZERODIV` | `COMPUTE_INT_ZERODIVIDE`-style division-by-zero short dump. |
| `702-run-zcl_zmcp_dmp_msgx.html` | `ZCL_ZMCP_DMP_MSGX` | `MESSAGE … TYPE 'X'` short dump. |
| `703-run-zcl_zmcp_dmp_assert.html` | `ZCL_ZMCP_DMP_ASSERT` | Failed `ASSERT` short dump. |
| `704-run-zcl_zmcp_dmp_convt.html` | `ZCL_ZMCP_DMP_CONVT` | `CONVT_*`-style type-conversion short dump. |
| `705-run-zcl_zmcp_dmp_itab.html` | `ZCL_ZMCP_DMP_ITAB` | Internal-table access short dump (e.g. `ITAB_*`). |
| `706-run-zcl_zmcp_dmp_sql.html` | `ZCL_ZMCP_DMP_SQL` | Open SQL short dump. |

All six settle the real shape of `Server time:` on this page family: it is **never rendered
server-side**. Each page instead carries a `<script>` block —

```html
<p class="detailText"> <span id="msgText">Server time:
<script>
var d = "20260811";
var t = "123441";
document.write(d.slice(0,4)+"-"+d.slice(4,6)+"-"+d.slice(6,8)+" "+t.slice(0,2)+":"+t.slice(2,4)+":"+t.slice(4,6));
</script>
</span> </p>
```

— that a browser composes into `2026-08-11 12:34:41` client-side via `document.write`. Nothing in
this server executes JS, so `extractDumpServerTime` (`src/adt/session.ts`) parses the `var d` /
`var t` literals directly instead of looking for an already-rendered date string. Prior to this
capture, the extractor looked for a rendered `Server time: YYYY-MM-DD HH:MM:SS` string that these
real pages never contain — dead code on every real capture. See `test/session.test.ts` for the
regression test asserting the exact composed `serverTime` for all six files.

---

## CONTRADICTIONS

Every item below is a place where the real bytes disagree with the current code or the invented
fixtures. Paths are absolute; line numbers are as of this capture.

1. **Stack URI attribute is namespaced.**
   Wire sends `adtcore:uri="/sap/bc/adt/programs/programs/zmcp_dbg_demo/source/main#start=84,0"`
   with `xmlns:adtcore="http://www.sap.com/adt/core"` declared **on the `stackEntry` element
   itself**, not on the root
   (`test/fixtures/live-captured/018-stack-2frames.xml:1`).
   The fixture writes a bare `uri="…"` with no `adtcore` namespace anywhere, at
   `test/fixtures/debugger/stack.xml:19`.
   **The real wire contradicts the fixture.** The parser at
   `src/debug/xml-response.ts:323` reads `e.uri`, which happens to survive only
   because `removeNSPrefix: true` (`xml-response.ts:95`) collapses `adtcore:uri` → `uri`. Verified
   by parsing `018` with the module's own parser options. Any consumer that does NOT go through
   fast-xml-parser (regex, XPath, a hand-rolled serializer, documentation) will look for the wrong
   name.

2. **Stack child element is bare, not prefixed.**
   Wire sends `<stackEntry …/>` (`018`, `031`, `036`); fixture sends `<dbg:stackEntry …/>` at
   `test/fixtures/debugger/stack.xml:7` and `:20`. Same `removeNSPrefix`
   accident makes both parse identically, but the fixture documents a shape the server never sends.
   The identical inversion applies to breakpoints: the wire's `<dbg:breakpoints>` root holds bare
   `<breakpoint>` children (`013-bp-set-accepted.xml`), which the doc comment at
   `src/debug/xml-response.ts:337` already predicted — that prediction is now
   **confirmed**, and `013` also shows the breakpoint's URI is `adtcore:uri`, not bare `uri`, so the
   `str(row.uri)` read at `xml-response.ts:380` is another `removeNSPrefix`-only survival.

3. **`STPDA_DEBUGGEE` booleans are `"true"/"false"`, not `XBool`.**
   Wire sends `<IS_ATTACH_IMPOSSIBLE>false</IS_ATTACH_IMPOSSIBLE>` and
   `<IS_SAME_SERVER>true</IS_SAME_SERVER>`
   (`test/fixtures/live-captured/015-listener-hit.xml:1`, identically in `099`).
   Code applies the `X` family: `isAttachable: !xBool(row.IS_ATTACH_IMPOSSIBLE)` at
   `src/debug/xml-response.ts:542` and `isSameServer: xBool(row.IS_SAME_SERVER)`
   at `:543`, where `xBool` (`:116-118`) returns `value === "X"`.
   **Consequences, both wrong:** `isSameServer` is computed as `false` although the wire says
   `true`; and if the server ever sends `IS_ATTACH_IMPOSSIBLE` as `true`, `xBool("true")` is `false`
   so `isAttachable` becomes `true` — the exact sign inversion the doc comment at `:507-508` warns
   about, arrived at from the opposite direction. The invented `debuggee.xml:20-21` cements the
   wrong convention with `<IS_ATTACH_IMPOSSIBLE></IS_ATTACH_IMPOSSIBLE>` / `<IS_SAME_SERVER>X</IS_SAME_SERVER>`.
   Note the `X` family is **not** dead — the lock responses do use it
   (`093-np-lock.xml`, `063-class-lock.xml`: `<IS_LOCAL>X</IS_LOCAL>`). The convention is
   per-structure, so it must be decided per field against a capture, never assumed.

4. **`trimValues: true` destroys ABAP fixed-width semantics.**
   Wire sends `<VALUE>A001      </VALUE>` with `<LENGTH>10</LENGTH>` and
   `<VALUE>12.50 </VALUE>`, `<VALUE>0.00 </VALUE>`, `<VALUE>0 </VALUE>`, and a
   `LENGTH=10` all-blank `<VALUE>          </VALUE>`
   (`test/fixtures/live-captured/027-vars-char-and-packed.xml:1`,
   `024-vars-table-rows-synthesised.xml:1`).
   Code sets `trimValues: true` at `src/debug/xml-response.ts:98` and stores the
   result verbatim at `value: str(row.VALUE)` (`:404`).
   **Verified by running the module's own parser over `024`: `VALUE` arrives as `"A001"`, not
   `"A001      "`, while `LENGTH` still reads `10`.** So a CHAR(10) holding all blanks becomes `""`
   and is indistinguishable from an initial/unset variable; and the trailing space that is the
   **packed sign column** (`"0.00 "`, `"12.50 "`) is deleted — which is precisely the column a
   negative packed value uses.
   **Now proven end-to-end** by `223-np-vars-negative.xml`: negatives arrive as `"123.45-"` and
   `"42-"` (trailing minus), positives as `"12.50 "` (trailing space). `trimValues` strips the space
   but keeps the minus, and `parseFloat("123.45-")` returns **`123.45`** — the positive magnitude.
   Sign loss is silent. See the RESOLVED section under NOT CAPTURED for the full table.

5. **A zero-byte 200 body makes the variable parsers throw.**
   Wire returns `content-length: 0`, a genuinely zero-byte body, **and no `content-type` header at
   all** for `021`, `022`, `026`, `037`, `038` (all `zeroByteBody: true`, HTTP 200).
   Code calls `parseVariablesResponse(raw.body)` at
   `src/debug/client.ts:670` and `parseChildVariablesResponse(raw.body)` at
   `:737` with no empty-body guard. fast-xml-parser returns `{}` for `""` (verified), so
   `parsed.abap` is `undefined` and both throw `DebugXmlParseError` —
   `src/debug/xml-response.ts:430` and `:460`.
   **An empty result is reported to callers as a parse failure.** Contrast the listener path, which
   *does* guard (`client.ts` `parseListenResult`: `if (raw.body.trim() === "") return { kind: "empty" }`).

6. **The empty-breakpoints response also makes its parser throw.**
   Wire returns `<dbg:breakpoints xmlns:dbg="http://www.sap.com/adt/debugger"/>` — a self-closing
   root, 100 bytes, HTTP 200 — for a successful clear-all
   (`test/fixtures/live-captured/044-bp-clear-all.xml:1`, identically `105`).
   fast-xml-parser collapses that to the string `""` (verified), so the
   `!root || typeof root !== "object"` guard at
   `src/debug/xml-response.ts:347` fires and
   `parseBreakpointsResponse` throws `DebugXmlParseError` at `:348`.
   **A successful clear-all is reported as a parse error.**

7. **`<dbg:action>` does carry `link` / `value` / `disabled`.**
   Wire sends
   `<dbg:action name="updateDebugging" style="check" group="setting" title="Update Debugging (Off)" link="/sap/bc/adt/debugger/actions?action=updateDebugging&amp;value=true" value="false" disabled="false"/>`
   on every action in both `017-attach.xml` and `028-step-over-1.xml`.
   The comment at `src/debug/xml-response.ts:161-162` says these are "not
   present on either `attach.xml` or `step.xml`… needs live confirmation" — because the invented
   fixtures omit them (`test/fixtures/debugger/attach.xml:20-21`,
   `step.xml:19`). **Now confirmed present; the "needs live confirmation" note can be retired.**
   The wire also sends **4** actions (`updateDebugging`, `garbageCollector`, `commitWork`,
   `rollbackWork`), none of which are the `stepInto`/`stepOver` the fixtures invented.

8. **`vitBpUri` on a reached breakpoint is dropped.**
   Wire sends `<dbg:breakpoint id="…LINE_NR=93" kind="line" vitBpUri="/sap/bc/adt/debugger/breakpoints/vit/id/2" unresolvableCondition="" unresolvableConditionErrorOffset=""/>`
   (`test/fixtures/live-captured/035-step-return.xml:1`).
   `parseReachedBreakpoint` at `src/debug/xml-response.ts:169-176` reads only
   `id`, `kind`, `unresolvableCondition`, `unresolvableConditionErrorOffset` — `vitBpUri` is
   silently discarded.

9. **`<dbg:step>` omits `isPostMortem`, `debuggeeSessionId` and `guiEditorGuid`; the rest are present.**
   Wire step roots (`028`, `029`, `030`, `035`) carry 14 attributes and **do** include
   `isUserAuthorizedForChanges`, `abapTraceState`, `canAdvancedTableFeatures`, `isNonExclusive`,
   `isNonExclusiveToggled` and `sessionTitle`, but **not** `isPostMortem`, `debuggeeSessionId` or
   `guiEditorGuid`. The comment at `src/debug/xml-response.ts:288-293` lists all
   nine as absent. Six of the nine are wrong; three are right. The defensive defaults happen to
   produce correct output, but the documented model of the response is not what the server sends.

10. **`<dbg:attach>` has no `<dbg:settings>`; `<dbg:step>` does.**
    `017-attach.xml` contains only `<dbg:reachedBreakpoints>` and `<dbg:actions>`; `028-step-over-1.xml`
    contains `<dbg:settings>` + `<dbg:actions>` (and `<dbg:reachedBreakpoints>` only when one was
    actually hit — `035`, not `028`). Neither invented fixture reflects this asymmetry:
    `test/fixtures/debugger/step.xml:21` invents an empty
    `<dbg:reachedBreakpoints/>` that the real server simply omits.

11. **Fixture shapes are unrepresentative across the board.**
    Every row-bearing invented fixture has **exactly 2 rows**, **none is empty**, and **none is
    large**: `variables.xml` (1368 B, 2 rows), `child-variables.xml` (996 B, 2 rows), `stack.xml`
    (944 B, 2 frames), `debuggee.xml` (883 B, 1 row).
    The wire routinely produces **1 row** (`034`, which fast-xml-parser returns as an *object*, not
    an array), **0 rows** (`019`'s `<VARIABLES/>`, `022`'s zero-byte body), **11 rows** (`020`),
    **15 rows** (`024`, 10 812 B) and **21 rows** (`025`, 17 988 B). The 2-row case is the one
    arity that exercises neither the singleton-object branch nor any size limit.
    **Caveat:** for the *stack* specifically the live set does **not** improve on the fixture — the
    deepest captured stack is 2 frames (`031`), the same as `stack.xml`. See the frame-count note
    in the Stack section.

12. **`serverName` casing and `debugCursorStackIndex` value.**
    Wire sends `serverName="a4hsandbox_A4H_00"` (lower-case host, instance `00`) and
    `debugCursorStackIndex="0"` on every `dbg:` root. The fixtures invent
    `serverName="A4HSANDBOX_A4H_01"` and `debugCursorStackIndex="1"`
    (`test/fixtures/debugger/stack.xml:5-6`). Any test asserting on those
    literals is asserting on fiction.

13. **`STPDA_DEBUGGEE` carries fields no fixture knows about.**
    Wire (`015-listener-hit.xml`) includes `CAN_ADT_CROSS_SERVER`, `APPSERVER`, `HOST`,
    `LISTENER_CTX_ID`, `DUMPID`/`DUMPDATE`/`DUMPTIME`/`DUMPHOST`/`DUMPMODNO` (the un-underscored
    duplicates), `URI`, `TYPE`, `NAME`, `PARENT_URI`, `PACKAGE_NAME`, `DESCRIPTION` — none present
    in `test/fixtures/debugger/debuggee.xml`. Note also
    `<NAME>ZMCP_DBG_DEMO                           ZMCP_DBG_DEMO</NAME>`: a padded
    concatenation, another value `trimValues` mangles at the edges.

14. **The trigger response is HTML, not XML.**
    `POST /sap/bc/adt/oo/classrun/…` returns a 9993-byte `text/html` ICM error page with HTTP 500
    when the run suspends at a breakpoint (`016-trigger-classrun.xml`, `100-np-trigger.xml` —
    both mis-named `.xml`). Any code path that assumes an XML or `exc:exception` body on this call
    will fail on the *normal* success case.

---

## NOT CAPTURED (and what was recovered on retry)

Things attempted that did not produce the intended evidence on the first pass. **Two of the three
were subsequently resolved** by fixing the activation ordering (captures `211-231`); they are kept
here, with their failures intact, because the failure modes are themselves findings. The one
genuinely uncaptured item is the deep stack, at the end.

### Negative packed / negative integer rendering — **RESOLVED (second attempt, captures 211-231)**

The first attempt (captures 091-108) failed and is described at the end of this section. The
retry succeeded once the activation ordering was corrected to **lock → PUT → UNLOCK → activate**
(the 403 was a self-inflicted lock conflict, not an authorisation problem — see below).

- `216-np-activate.txt` — HTTP **200**, zero-byte body. Activation clean.
- `217-np-source-verify.txt` — 5169 B (vs. 5069 B original), `lv_zmcp_neg` present in the **ACTIVE**
  source. The probe variables genuinely existed in the running program this time.
- `223-np-vars-negative.xml` (2757 B) and `224-np-vars-negative-children.xml` (10832 B, the
  `@GLOBALS` scope listing) — **both agree**:

  | NAME | TECHNICAL_TYPE | LENGTH | VALUE (brackets = exact bytes) | HEX_VALUE |
  |---|---|---:|---|---|
  | `LV_ZMCP_NEG` | `P` | 8 | `[123.45-]` | `000000000012345D` |
  | `LV_ZMCP_NEGI` | `I` | 4 | `[42-]` | `D6FFFFFF` |
  | `LV_GRAND_TOTAL` | `P` | 8 | `[0.00 ]` | `000000000000000C` |
  | `LT_ITEMS[1]-UNIT_PRICE` | `P` | 5 | `[12.50 ]` | `000001250C` |

**The sign is a TRAILING character in a fixed sign column: `-` when negative, a SPACE when
positive.** There is no leading minus anywhere on the wire. This holds for packed (`P`) and for
plain integers (`I`) alike, so it is a rendering convention of the debugger, not a property of the
BCD encoding.

Corollaries proven by these bytes:

- **BCD sign nibble**: `D` = negative, `C` = positive (last nibble of `HEX_VALUE`), confirming the
  hypothesis that was previously only inferred from positive samples.
- **`HEX_VALUE` endianness differs by type.** Packed is big-endian BCD (`…12345D`). A 4-byte
  integer is **little-endian two's complement**: `D6FFFFFF` is `-42`, not `0xD6FFFFFF`. Any code
  that decodes `HEX_VALUE` uniformly across types will be wrong for `I`.
- **This is the most dangerous defect in the set.** `trimValues: true` strips the trailing space
  from positives but leaves the trailing `-` on negatives, producing an asymmetric mess:

  | wire bytes | after `trimValues` | `Number()` | `parseFloat()` |
  |---|---|---|---|
  | `12.50 ` | `12.50` | `12.5` | `12.5` |
  | `123.45-` | `123.45-` | `NaN` | **`123.45`** |
  | `42-` | `42-` | `NaN` | **`42`** |

  `parseFloat` stops at the trailing minus and **silently returns the POSITIVE magnitude for a
  negative number**. A debugger that reports `-123.45` as `123.45` is worse than one that crashes.
  Any numeric conversion must strip and re-apply the trailing sign *before* parsing.

#### First attempt (superseded, kept as evidence)

`094-np-put-modified.txt` was accepted (200), but `095-np-activate.xml` returned **403** because
the object was still locked, so the probe variables were never compiled in. `102-np-vars-negative.xml`
therefore returned **only 2 of the 4 requested ids** — `LV_ZMCP_NEG` and `LV_ZMCP_NEGI` were absent
entirely, with no element, no empty element and no error. That failure is itself a durable finding:
**`getVariables` silently omits unknown ids from a mixed batch rather than erroring**, so a caller
cannot assume the response array is positionally aligned with the request array.

### Activation — **HTTP 403 was a lock-ordering bug; RESOLVED**

`095-np-activate.xml` (1558 B, HTTP 403) and its byte-identical twin `108-np-activate-restore.xml`:

- Root: `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">`
- `<namespace id="com.sap.adt"/>`
- Type id: `<type id="ExceptionResourceNoAccess"/>`
- Message, verbatim: **`User DEVELOPER is currently editing ZMCP_DBG_DEMO`**
  (identical `<localizedMessage lang="EN">`)
- `properties`: `T100KEY-ID=EU`, `T100KEY-NO=510`, `T100KEY-V1=DEVELOPER`,
  `T100KEY-V2=ZMCP_DBG_DEMO`, `URI=/sap/bc/adt/programs/programs/zmcp_dbg_demo`, and a `LONGTEXT`
  HTML blob whose Diagnosis reads *"This object is currently being edited by another user and is
  therefore locked (by an ENQUEUE lock)"* with the Procedure *"Wait until the other user has
  finished… you can delete the lock using Transaction SM12."*

**Why it was refused: an ENQUEUE lock, i.e. a lock/concurrency problem — not authorisation and not
CSRF.** The 403 is a misleading status code for it. Evidence it is not CSRF: the request carried a
valid `X-CSRF-Token: vGjVjD6Yj4yRPuQ7IhKclQ==` (`095-np-activate.meta.json`), the same token the
adjacent PUT (`094`, HTTP 200) and UNLOCK (`096`, HTTP 200) used successfully. Evidence it is not a
missing authorisation: the same user with the same session had already been granted a MODIFY lock
(`093-np-lock.xml`, HTTP 200) and had its source PUT accepted. The activation request is issued
**while the caller still holds its own lock handle**, and the activation service refuses to activate
an object locked by *anyone*, including the requester's own session.

**CONFIRMED FIXED.** Re-running with the order **lock → PUT → UNLOCK → activate** returned HTTP
**200** on both the forward activation (`216-np-activate.txt`) and the restore activation
(`231-np-activate-restore.txt`). The hypothesis above is now a captured fact: this 403 is purely a
sequencing error, and the correct ADT write sequence releases the lock *before* activating. Any
client that activates while holding its own lock handle will hit this 403 every time.

### CSRF on a mutating verb — cannot be fetched in-band

- `071-p1-create-with-fetch-token.txt`, body verbatim (28 bytes, `text/plain; charset=utf-8`):
  **`CSRF token validation failed`**
- Response header: **`x-csrf-token: Required`** — the literal string `Required`, **not a usable
  token**. The server did *not* issue one on the POST.
- `072-p1-verify-created.xml` (HTTP 404): `ExceptionResourceNotFound` /
  `ZMCP_CSRF_PROBE does not exist` — **the create was NOT applied**, so the 403 is fail-closed.

**Verdict: no. On this system a CSRF token cannot be fetched in-band on a mutating verb.**
`x-csrf-token: fetch` on a POST is rejected outright and only echoes `Required`; the token must be
obtained from a prior safe GET (as `011` / `014` / `081` / `086` / `091` / `097` / `201` do) and
replayed on the mutating request.

### Other gaps

- **Internal-table row enumeration** — `getChildVariables` on a table node does not enumerate rows
  (`021`, zero-byte 200). Row access had to be **synthesised** by constructing `LT_ITEMS[n]-…` ids
  client-side (`024`, `025`). No server-side enumeration call was found.
- **A stack with more than 2 frames** — **not captured.** Despite the file names
  `018-stack-2frames` / `031-stack-3frames` and `031`'s `expect` note claiming "MORE THAN 2 FRAMES",
  the actual `<stackEntry>` counts are 1 and 2. The deepest stack captured is 2 frames — the same
  arity as the invented `stack.xml`. The ">2 frames" gap the run intended to close is **still open**
  for the stack; it was closed only for variable rows (`024` = 15 rows, `025` = 21 rows).
  **Why:** `ZMCP_DBG_DEMO`'s maximum call depth is 2 (`START-OF-SELECTION` → `lcl_calc=>line_value`),
  so no breakpoint anywhere in the existing program can produce a third frame. It is **now known to
  be achievable** — the activation 403 that originally blocked source changes was a lock-ordering
  bug and is fixed (`216`) — but closing it requires adding a nested method *call*, which shifts the
  line numbers that the captured breakpoints (84, 93) and `RUNBOOK-DEBUG-LIVE.md` depend on. That
  was judged not worth destabilising a shared fixture program for; it needs a **separate,
  purpose-built** `ZMCP_DBG_DEEP` report with 3+ nesting levels.
- **`setStackPosition` cursor movement** — not captured in this run; whether the call actually moves
  the debug cursor remains open (see the caveat at `src/debug/client.ts:640-645`).
- **A system/kernel stack frame** — all captured frames are ABAP user frames of `ZMCP_DBG_DEMO`, each
  carrying `adtcore:uri`. The "frame with no URI" case that `xml-response.ts:321-323` defends
  against is still unobserved on the wire.
- **`dbg:` string values containing a literal `dbg:`** — the naive-namespace-strip corruption case at
  `xml-response.ts:85-91` was not exercised live.
- **Exception / statement / message breakpoint kinds** — only `kind="line"` was captured.

---

## `_run1-accept-bug/` — superseded, kept only as evidence

`_run1-accept-bug/` holds a **superseded first run** (31 captures). It is retained for exactly one
reason: it demonstrates that the `dbg:` response family requires **`Accept: application/xml`**.

Run 1's capture client sent `Accept: application/vnd.sap.as+xml` on the `dbg:`-family calls. Seven
of them came back **406** — `017-attach`, `018-stack-2frames`, `025-step-over-1`, `026-step-over-2`,
`027-step-into`, `028-stack-3frames`, `033-stack-after-error-probes` — each with the body:

```
<type id="ExceptionResourceNotAcceptable"/>
<message lang="EN">The message content is not acceptable. Accepted content types: application/xml</message>
```

**Those 406s were a client bug, not a server behaviour.** The server named the correct type in the
error; run 2 sent `Accept: application/xml` and every one of those calls returned 200. Do not treat
run 1's 406s as wire findings, and do not use `_run1-accept-bug/` files as fixtures. (The production
code already gets this right — `DBG_XML_ACCEPT = "application/xml"` at
`src/debug/client.ts:179`.)

The same failure mode, independently, is `082-p3b-datapreview-t000.xml` in the top-level directory:
`Accept: application/xml` was wrong *there*, and the server again named the right one
(`application/vnd.sap.adt.datapreview.table.v1+xml`), which `087` then used successfully. The
lesson generalises: **each ADT resource family has its own `Accept`, and a 406 body tells you
exactly what it is.**

## 2026-08-20 — quickSearch description pairing (`812`-`843`)

Same A4H appliance, client `001`, user `DEVELOPER`. 32 captures added confirming ADT's
`quickSearch` mis-pairs `adtcore:description` within a type group — the descriptions arrive in
the group's name-ascending order, but the `<adtcore:objectReference>` rows themselves are emitted
in (sub-type, name) order, so a description meant for one object lands on another. Confirmed
against per-object ground-truth reads for **TABL** and **PROG** (`829`-`831`, `837`-`843`). **FUGR**
was also tested and arrives **correct** — `832`-`834` match the wire values — so the defect is not
universal across type groups.

## 2026-08-28 — DTEL and DOMA descriptor captures (844-845)

Same A4H appliance. Two captures added: `GET /sap/bc/adt/ddic/dataelements/s_carr_id` and
`GET /sap/bc/adt/ddic/domains/s_carr_id`, for the data element and domain `S_CARR_ID` (package
`SAPBC_DATAMODEL`).

These were taken through the MCP `abap_read` tool (`format:"raw"`), not the HTTP-layer capture
harness that produced the 2026-07-31 set. The response **bodies** are byte-exact. The response
**status and headers are not** — `abap_read` does not surface the status line or header block, so
`responseStatus` in each sidecar is inferred from tool success and `responseHeaders` is empty
because nothing was observed, not because nothing was sent. That is why their `ledger.tsv` status
column reads `200-inferred` rather than `200`.

`844` establishes that the data element descriptor's root element is `<blue:wbobj>`
(`xmlns:blue="http://www.sap.com/wbobj/dictionary/dtel"`), wrapping an inner
`<dtel:dataElement xmlns:dtel="http://www.sap.com/adt/dictionary/dataelements">`. The four label
groups (short, medium, long, heading) are child elements, each in Label/Length/MaxLength order.
Numeric values are zero-padded on the wire: `<dtel:shortFieldLength>07</dtel:shortFieldLength>`,
`<dtel:dataTypeLength>000003</dtel:dataTypeLength>`.

Caveat: the `*FieldMaxLength` values in this capture are 10/20/40/55, but that is a single object.
One data element does not establish those as system-wide constants rather than values specific to
`S_CARR_ID`.
