/**
 * Customizing (type `W`) transport request creation, the counterpart to
 * `./transports.ts`'s workbench-request helpers for the one CTS shape they
 * cannot produce.
 *
 * Why a generated bridge class instead of a plain ADT call: a prior
 * discovery pass tried the two ADT routes that create transport requests
 * and neither produced a real customizing request headlessly.
 * `abap_transport create` (`kind: workbench`) always yields `tm:type="K"`.
 * Posting to `/sap/bc/adt/cts/transports` with an added
 * `<TRFUNCTION>W</TRFUNCTION>` element returned HTTP 200, but the request
 * read back afterwards still carried `tm:type="K"` — the element was
 * silently ignored, not rejected. Posting to
 * `/sap/bc/adt/cts/transportrequests` with a `tm:root
 * tm:useraction="newrequest"` body naming `tm:request tm:type="W"` threw
 * `Check of condition failed` and created nothing, and that failure did not
 * depend on the media type used for the request
 * (`transportorganizer.v1+xml` and `application/xml` both got it). So this
 * is not "ADT cannot create a customizing request" as a blanket claim —
 * it is specifically that neither shape tried got one, and the fix is the
 * same one SAP's own UIs use under the hood: the function-module pair
 * `TR_INSERT_REQUEST_WITH_TASKS` (`IV_TYPE = 'W'`) or
 * `TRINT_INSERT_NEW_COMM` (`WI_TRFUNCTION = 'W'`). This module uses the
 * former.
 *
 * Same delivery mechanism as `./img-write-bridge.ts`: a generated
 * `IF_OO_ADT_CLASSRUN` class, deployed into `HELPER_PACKAGE`
 * (`./helper-package.ts`), never `$TMP`. This module only generates the
 * class source and parses its transcript — deploying and executing it is a
 * caller concern, same division of labor as the IMG write bridge.
 */

import { AbapError } from "./errors.js";
import { ddicBridgeSource, DDIC_ERR_PREFIX } from "./ddic-bridge.js";
import { abapLiteral, assertAbapText } from "./enhancement-templates.js";
import { ERR_LINE_PREFIX } from "./run.js";

export const CUSTREQ_LINE_PREFIX = "CTSW> ";

/** Fixed class name — never generated or caller-influenced. */
export const CUSTOMIZING_REQUEST_CLASS = "ZCL_ZMCP_CTS_WREQ";

/**
 * `AS4TEXT`'s length. Confirmed elsewhere in this codebase, not re-derived
 * here: `./view-create.ts` ("`DD25V-DDTEXT` is `AS4TEXT`, CHAR60") and
 * `./session-transport.ts` ("SAP's AS4TEXT field holds 60 characters").
 * Both agree, so this is taken as verified rather than flagged unverified.
 */
export const CUSTREQ_DESCRIPTION_MAX = 60;

/**
 * The FM this module calls, its function group, and the parameter/exception
 * names actually used — recorded so a future reader can diff this against
 * the live system without re-deriving it, the same reason `img-write-bridge.ts`
 * keeps `CTS_INSERT_FM`, whose `confidence`/`note` shape this mirrors.
 *
 * PROVEN FROM HERE: this FM has now been called once, from this server, on
 * 2026-09-05, with no `IT_USERS` row — `sy-subrc` came back 0 and a type-`W`
 * request WAS created (later confirmed visible via `abap_transport list`),
 * so the call is accepted at all and does create a type-`W` request.
 * `ET_TASK_HEADERS` came back empty on that call, which is why `IT_USERS`
 * is now populated — see the comment at its call site in
 * `customizingRequestBody` for the full finding.
 *
 * STILL UNPROVEN FROM HERE: the `IT_USERS` variant itself (this server has
 * not yet made a call passing it), and every failure path this FM can take
 * — `INSERT_FAILED`, `ENQUEUE_FAILED`, and any authority or lock refusal —
 * none of which this server has triggered (which is exactly why
 * `EXCEPTIONS` and the `MESSAGE ... INTO lv_msg` capture below still
 * exist).
 *
 * What IS measured, read live from this system's own `FUPARAREF`/`TFDIR` on
 * 2026-09-05 (not from this repo — this codebase had, and still has, no
 * other reference to `TR_INSERT_REQUEST_WITH_TASKS` or `SAPLSTR8`): the
 * function group is `SAPLSTR8`; `IV_TYPE` (`TRFUNCTION`-typed) and `IV_TEXT`
 * (`AS4TEXT`-typed) are both mandatory; `IV_OWNER` (`AS4USER`-typed) is
 * optional and defaults to `SY-UNAME` — so omitting it below is not "no
 * owner", it is "the logon user", which is the wanted behavior, not an
 * oversight; `ES_REQUEST_HEADER`/`ET_TASK_HEADERS` are exporting parameters
 * 1 and 2, typed `TRWBO_REQUEST_HEADER`/`TRWBO_REQUEST_HEADERS`; importing
 * parameter 6, `IT_USERS`, is typed `SCTS_USERS` (its line type and table
 * kind were not measured) and is now passed with exactly one row,
 * `SY-UNAME`; the remaining six importing parameters (`IV_TARGET`,
 * `IV_TARDEVCL`, `IV_DEVCLASS`, `IV_TARLAYER`, `IV_WITH_BADI_CHECK`,
 * `IT_ATTRIBUTES`) are all optional and left unset — `IV_TARGET` in
 * particular is a deliberate choice, not an oversight: a request created
 * with no transport target is the right default for something this tool
 * creates and a verification run deletes again, and guessing a target from
 * an unproven optional parameter would be worse; `INSERT_FAILED`/
 * `ENQUEUE_FAILED` are the only two exceptions this FM raises.
 *
 * Only `AS4TEXT` = CHAR60 is independently corroborated by this repo (see
 * `CUSTREQ_DESCRIPTION_MAX` below) — everything else above is taken on the
 * strength of the live dictionary read plus the one live call recorded
 * above, not a fully-tested contract.
 */
export const CUSTOMIZING_REQUEST_FM = Object.freeze({
  fm: "TR_INSERT_REQUEST_WITH_TASKS",
  functionGroup: "SAPLSTR8",
  params: Object.freeze({
    type: "iv_type",
    text: "iv_text",
    owner: "iv_owner",
    requestHeader: "es_request_header",
    taskHeaders: "et_task_headers",
    users: "it_users",
  }),
  exceptions: Object.freeze({
    insertFailed: "insert_failed",
    enqueueFailed: "enqueue_failed",
  }),
  confidence: "high",
  note:
    "PROVEN FROM HERE: this FM has been called once, from this server, on 2026-09-05, with no " +
    "IT_USERS row — sy-subrc came back 0 and a type-W request WAS created, later confirmed " +
    "visible via abap_transport list. ET_TASK_HEADERS came back empty on that call, which is " +
    "why IT_USERS is now populated. STILL UNPROVEN FROM HERE: the IT_USERS variant itself, and " +
    "every failure path this FM can take (INSERT_FAILED, ENQUEUE_FAILED, and any authority or " +
    "lock refusal). What was read live on 2026-09-05 is FUPARAREF (parameter lists) and TFDIR " +
    "(function group). Measured shape: IV_TYPE (TRFUNCTION) and IV_TEXT (AS4TEXT) are " +
    "mandatory; IV_OWNER (AS4USER) is optional and defaults to SY-UNAME, so omitting it means " +
    "\"the logon user\", not \"no owner\"; ES_REQUEST_HEADER/ET_TASK_HEADERS are exporting " +
    "parameters 1 and 2, typed TRWBO_REQUEST_HEADER/TRWBO_REQUEST_HEADERS; importing parameter " +
    "6, IT_USERS, is typed SCTS_USERS and is now passed with exactly one row, SY-UNAME, because " +
    "the live call above created a request with no task when it was omitted. The remaining six " +
    "importing parameters (IV_TARGET, IV_TARDEVCL, IV_DEVCLASS, IV_TARLAYER, IV_WITH_BADI_CHECK, " +
    "IT_ATTRIBUTES) are optional and deliberately left unset — IV_TARGET above all: no transport " +
    "target is the right default for something this tool creates and a verification run deletes " +
    "again; INSERT_FAILED and ENQUEUE_FAILED are the only two exceptions raised.",
} as const);

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface CustomizingRequestPlan {
  readonly description: string;
  readonly owner?: string;
}

/**
 * Conservative SAP user-name shape: uppercase letters, digits and
 * underscore, 1-12 characters. Deliberately case-sensitive (not
 * case-normalized) — an `owner` that isn't already in this shape is
 * refused, not silently uppercased, since a wrong owner on a customizing
 * request is not something this module can detect after the fact.
 */
const CUSTREQ_OWNER_RE = /^[A-Z0-9_]{1,12}$/;

function assertCustomizingOwner(value: string): string {
  if (typeof value !== "string" || !CUSTREQ_OWNER_RE.test(value)) {
    throw new AbapError(
      "BAD_INPUT",
      `owner ${JSON.stringify(value)} must be 1-12 characters of uppercase letters, digits or underscore.`,
      { value },
    );
  }
  return value;
}

/**
 * `description` reaches ABAP as a string literal inside generated source —
 * every rule here follows from that. `assertAbapText` (`./enhancement-templates.ts`)
 * already rejects non-strings, over-length text and control characters
 * (newline/CR/tab/other C0/DEL); reused rather than re-implemented, per this
 * module's own rule about not writing a second copy of an existing check.
 * It does not reject the single quote (real descriptions have apostrophes)
 * — `abapLiteral` handles that by doubling it when the literal is built.
 * The one thing `assertAbapText` does not check is emptiness after
 * trimming, so that is asserted here first.
 */
export function validateCustomizingRequestPlan(p: CustomizingRequestPlan): void {
  if (typeof p.description !== "string" || p.description.trim().length === 0) {
    throw new AbapError("BAD_INPUT", "description must not be empty.", {});
  }
  assertAbapText(p.description, "description", CUSTREQ_DESCRIPTION_MAX);

  if (p.owner !== undefined) {
    assertCustomizingOwner(p.owner);
  }
}

// ---------------------------------------------------------------------------
// Source generation
// ---------------------------------------------------------------------------

function customizingRequestBody(p: CustomizingRequestPlan): string[] {
  const P = CUSTOMIZING_REQUEST_FM.params;
  const X = CUSTOMIZING_REQUEST_FM.exceptions;
  const textLit = abapLiteral(p.description);

  const exportingLines = [`    ${P.type} = 'W'`, `    ${P.text} = ${textLit}`];
  if (p.owner !== undefined) {
    exportingLines.push(`    ${P.owner} = ${abapLiteral(p.owner)}`);
  }
  // IT_USERS: live on 2026-09-05, calling this FM from this server with no user row at
  // all, sy-subrc came back 0 and a type-W request WAS created, but ET_TASK_HEADERS came
  // back empty — the generated code as it existed then read no task and RETURNed before
  // ever printing the request number, so the request was created and its number thrown
  // away, orphaned. The fix tried next — a single `INSERT sy-uname INTO TABLE lt_users.`
  // — failed to *activate* on 2026-09-06 with:
  //   E line 26 col 31  "SY-UNAME" and the row type of "LT_USERS" are incompatible.
  // which falsifies the earlier "line type and table kind of SCTS_USERS were not
  // measured" note on both counts. Now measured live from this system's own DD40L/DD03L:
  // SCTS_USERS (TTYP/DA, package SCTS_REQ) is DD40L ROWTYPE SCTS_USER, ROWKIND S
  // (structured row type), ACCESSMODE T (standard table), KEYDEF D / KEYKIND N
  // (non-unique default key); SCTS_USER's DD03L rows are exactly two fields — USER
  // (position 0001, rollname TR_AS4USER, CHAR) and TYPE (position 0002, rollname
  // TRFUNCTION, CHAR). So the row is built field-by-field below (`ls_user-user` /
  // `ls_user-type`) instead of assigning SY-UNAME straight into the table line.
  // `INSERT ... INTO TABLE` (below) is still used rather than `APPEND`: valid for
  // standard, sorted and hashed tables alike, so the table kind was never what broke —
  // it was always the row's structure. `ls_user-type = 'Q'` assumes 'Q' (customizing
  // task, TRFUNCTION's value for a task under a type-W request) is the task type this FM
  // wants for IT_USERS-TYPE; that is still UNPROVEN from here — DD40L/DD03L say what the
  // field is called and typed, not what value the FM expects there. A wrong guess on the
  // field names above still fails at *activation*, before the FM is ever called, so it
  // still can never create an orphaned request; a wrong guess on 'Q' itself would only
  // surface on a live call, which is exactly what a round-3 read-back of TASKTYPE (see
  // the out->write below) is for.
  exportingLines.push(`    ${P.users} = lt_users`);

  return [
    "DATA ls_request_header TYPE trwbo_request_header.",
    "DATA lt_task_headers TYPE trwbo_request_headers.",
    "DATA ls_task_header TYPE trwbo_request_header.",
    "DATA lt_users TYPE scts_users.",
    "DATA ls_user TYPE scts_user.",
    "DATA lv_msg TYPE string.",
    "DATA lv_exc TYPE string.",
    "",
    "ls_user-user = sy-uname.",
    "ls_user-type = 'Q'.",
    "INSERT ls_user INTO TABLE lt_users.",
    "",
    `CALL FUNCTION '${CUSTOMIZING_REQUEST_FM.fm}'`,
    "  EXPORTING",
    ...exportingLines,
    "  IMPORTING",
    `    ${P.requestHeader} = ls_request_header`,
    `    ${P.taskHeaders}   = lt_task_headers`,
    "  EXCEPTIONS",
    `    ${X.insertFailed}  = 1`,
    `    ${X.enqueueFailed} = 2`,
    "    OTHERS = 3.",
    "IF sy-subrc <> 0.",
    "  CASE sy-subrc.",
    "    WHEN 1.",
    `      lv_exc = '${X.insertFailed.toUpperCase()}'.`,
    "    WHEN 2.",
    `      lv_exc = '${X.enqueueFailed.toUpperCase()}'.`,
    "    WHEN OTHERS.",
    "      lv_exc = 'OTHERS'.",
    "  ENDCASE.",
    // CTS FMs report the real reason via sy-msg*, not the exception name — see the
    // module header and img-write-bridge.ts's CTS_INSERT_FM note for the same finding.
    "  MESSAGE ID sy-msgid TYPE sy-msgty NUMBER sy-msgno",
    "    WITH sy-msgv1 sy-msgv2 sy-msgv3 sy-msgv4 INTO lv_msg.",
    `  out->write( |${CUSTREQ_LINE_PREFIX}ERROR exception=[{ lv_exc }] len=[{ strlen( lv_msg ) }] value=[{ lv_msg }]| ).`,
    "  RETURN.",
    "ENDIF.",
    "",
    "IF ls_request_header-trkorr IS INITIAL.",
    `  out->write( |${CUSTREQ_LINE_PREFIX}ERROR exception=[NO_REQUEST] len=[0] value=[]| ).`,
    "  RETURN.",
    "ENDIF.",
    "",
    `out->write( |${CUSTREQ_LINE_PREFIX}REQUEST len=[{ strlen( ls_request_header-trkorr ) }] value=[{ ls_request_header-trkorr }]| ).`,
    "",
    "READ TABLE lt_task_headers INTO ls_task_header INDEX 1.",
    "IF sy-subrc <> 0.",
    // Row-recording decision: corr_nr is still passed straight through to
    // TR_OBJECTS_CHECK/TR_OBJECTS_INSERT unchanged by the row-recording path; that path
    // itself performs no task-less check. Whether CTS accepts rows recorded against a
    // request with no task under it is unknown from here — a further reason the
    // task-less condition is instead reported loudly here, carrying the request number,
    // so the caller can add a task or delete the request. Refusing at row-recording time
    // would mean recognising "this number names a task-less request", which requires
    // reading CTS state that path does not read.
    `  out->write( |${CUSTREQ_LINE_PREFIX}WARN code=[NO_TASK] len=[{ strlen( ls_request_header-trkorr ) }] value=[{ ls_request_header-trkorr }]| ).`,
    "ELSE.",
    `  out->write( |${CUSTREQ_LINE_PREFIX}TASK len=[{ strlen( ls_task_header-trkorr ) }] value=[{ ls_task_header-trkorr }]| ).`,
    // TRWBO_REQUEST_HEADER-TRFUNCTION is NOT measured from this system — only SCTS_USER's
    // USER/TYPE fields were (see the IT_USERS comment above). Emitted so a live round-3
    // read-back can prove or disprove the 'Q' guess passed as IT_USERS-TYPE above; a wrong
    // field name here fails activation before the FM ever runs, the same cheap failure
    // mode as a wrong SCTS_USER field name. Its own `out->write`/`CTSW>` line, not extra
    // fields tacked onto the TASK line above: every other line here (REQUEST, TASK, WARN,
    // ERROR) is `head len=[n] value=[v]`, and `extractCustReqValue`/the CUSTREQ_*_RE
    // patterns are all built on exactly one `len=[n] value=[v]` pair per line — a combined
    // `TASK <number> TYPE <x>` line would need its own bespoke two-value regex instead of
    // reusing that shape, for one field that is genuinely a second, independent value.
    `  out->write( |${CUSTREQ_LINE_PREFIX}TASKTYPE len=[{ strlen( ls_task_header-trfunction ) }] value=[{ ls_task_header-trfunction }]| ).`,
    "ENDIF.",
  ];
}

/**
 * The whole generated class source for creating one customizing request.
 * `ddicBridgeSource` (`./ddic-bridge.ts`) is where the 255-char-per-line
 * ceiling is actually enforced (it walks every generated line and throws
 * `CHECK_FAILED` on the first one over `ABAP_SOURCE_LINE_MAX`) — this
 * function does not duplicate that check, it relies on going through
 * `ddicBridgeSource` for every line it emits, same as `imgProbeSource`/
 * `imgApplySource` in `./img-write-bridge.ts`. Because `description` is
 * caller-supplied and gets embedded as a quoted literal on the `iv_text`
 * line, that reliance is the thing actually being pinned by this module's
 * "stays within the line ceiling" test.
 */
export function customizingRequestSource(p: CustomizingRequestPlan): string {
  validateCustomizingRequestPlan(p);
  return ddicBridgeSource(CUSTOMIZING_REQUEST_CLASS, [], customizingRequestBody(p));
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export interface CustomizingRequestTranscript {
  request?: string;
  task?: string;
  taskType?: string;
  errors: string[];
  warnings: string[];
}

/**
 * `len=[n]` before `value=[...]`, same reasoning and same recovery fallback
 * as `img-write-bridge.ts`'s `extractLenPrefixedValue`: a value can itself
 * contain `]` (an error's `sy-msgv*`-built text, in particular), and
 * trailing blanks between the ABAP `out->write` and this parser might get
 * stripped. Reimplemented locally rather than imported — that function is
 * not exported from `img-write-bridge.ts`, which this module does not
 * modify.
 */
function extractCustReqValue(
  afterHead: string,
  fieldsRe: RegExp,
): { fields: string[]; value: string } | null {
  const m = fieldsRe.exec(afterHead);
  if (!m) return null;
  const len = Number(m[m.length - 1]);
  if (!Number.isFinite(len) || len < 0) return null;
  const rest = afterHead.slice(m[0].length);
  let raw: string;
  if (rest.length > len && rest[len] === "]") {
    raw = rest.slice(0, len);
  } else {
    const lastBracket = rest.lastIndexOf("]");
    if (lastBracket === -1) return null;
    raw = rest.slice(0, lastBracket).padEnd(len, " ");
  }
  return { fields: m.slice(1), value: raw };
}

const CUSTREQ_VAL_RE = /^len=\[(\d+)\] value=\[/;
const CUSTREQ_ERR_RE = /^exception=\[([A-Za-z0-9_]{1,30})\] len=\[(\d+)\] value=\[/;
const CUSTREQ_WARN_RE = /^code=\[([A-Za-z0-9_]{1,30})\] len=\[(\d+)\] value=\[/;

/**
 * Tolerant by design, same as `parseImgWriteTranscript` (`./img-write-bridge.ts`):
 * an unrecognized `CTSW> ` head, or a `CTSW> ` line whose fields don't match
 * the expected shape, is silently skipped — never thrown. Never routes a
 * `REQUEST`/`TASK` value into `errors`, and never reads a `trkorr`-shaped
 * value out of an `ERROR` line — `ERROR` and `REQUEST` are still mutually
 * exclusive by construction in {@link customizingRequestBody} (every path
 * either returns after writing exactly one `ERROR` line, or falls through
 * to write `REQUEST`). What follows a `REQUEST` line is no longer fixed,
 * though: it is followed by *either* a `TASK` line immediately followed by
 * a `TASKTYPE` line (a task was found — `TASKTYPE` carries
 * `TRWBO_REQUEST_HEADER-TRFUNCTION` for that same task) *or* a
 * `WARN code=[NO_TASK]` line (the request was created with no task) — never
 * both, and never neither. `taskType` without `task` is not a shape this
 * bridge produces.
 *
 * A line missing the `CTSW> ` prefix is not automatically ignored, though:
 * a failure inside the `TRY`/`CATCH` scaffold `ddicBridgeSource` wraps every
 * generated class in (an uncaught exception, a `cx_root` the scaffold's own
 * `CATCH` reports) never gets a `CTSW> ` line at all — it comes back on the
 * scaffold's own prefixes, `DDIC_ERR_PREFIX` (`./ddic-bridge.ts`) or
 * `ERR_LINE_PREFIX` (`./run.ts`), reused here rather than re-declared, the
 * same two constants `parseImgWriteTranscript` routes into its own `errors`.
 * Treating those as just more unrecognized non-`CTSW> ` lines — silently
 * ignored — would turn a real scaffold failure into an empty, error-free
 * result indistinguishable from a clean run that produced nothing, which is
 * the worst outcome for a write path. So they are routed into `errors` here
 * too; every other non-`CTSW> ` line is still ignored.
 */
export function parseCustomizingRequestTranscript(text: string): CustomizingRequestTranscript {
  const result: CustomizingRequestTranscript = { errors: [], warnings: [] };

  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith(CUSTREQ_LINE_PREFIX)) {
      const rest = line.slice(CUSTREQ_LINE_PREFIX.length);
      const spaceIdx = rest.indexOf(" ");
      const head = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
      const remainder = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1);

      switch (head) {
        case "REQUEST": {
          const parsed = extractCustReqValue(remainder, CUSTREQ_VAL_RE);
          if (parsed) result.request = parsed.value;
          break;
        }
        case "TASK": {
          const parsed = extractCustReqValue(remainder, CUSTREQ_VAL_RE);
          if (parsed) result.task = parsed.value;
          break;
        }
        case "TASKTYPE": {
          const parsed = extractCustReqValue(remainder, CUSTREQ_VAL_RE);
          if (parsed) result.taskType = parsed.value;
          break;
        }
        case "ERROR": {
          const parsed = extractCustReqValue(remainder, CUSTREQ_ERR_RE);
          if (parsed) {
            const [exception] = parsed.fields;
            result.errors.push(`${exception}: ${parsed.value}`);
          }
          break;
        }
        case "WARN": {
          const parsed = extractCustReqValue(remainder, CUSTREQ_WARN_RE);
          if (parsed) {
            const [code] = parsed.fields;
            result.warnings.push(`${code}: ${parsed.value}`);
          }
          break;
        }
        default:
          // unknown tag — ignored, not an error.
          break;
      }
    } else if (line.startsWith(DDIC_ERR_PREFIX)) {
      result.errors.push(line.slice(DDIC_ERR_PREFIX.length).trim());
    } else if (line.startsWith(ERR_LINE_PREFIX)) {
      result.errors.push(line.slice(ERR_LINE_PREFIX.length).trim());
    }
  }

  return result;
}
