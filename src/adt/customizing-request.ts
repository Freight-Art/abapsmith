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
 * UNPROVEN FROM HERE: `TR_INSERT_REQUEST_WITH_TASKS` is an ordinary,
 * heavily-used standard SAP function module — SM30 and the rest of CTS call it
 * constantly — but this server has never itself called it, on this or any
 * system. The first real run of the generated class from here is also the
 * first evidence that this server's call is accepted at all (authority,
 * lock, or request-type refusals are all unproven territory from this
 * server's side, which is exactly why `EXCEPTIONS` and the
 * `MESSAGE ... INTO lv_msg` capture below exist).
 *
 * What IS measured, read live from this system's own `FUPARAREF`/`TFDIR` on
 * 2026-09-05 (not from this repo — this codebase had, and still has, no
 * other reference to `TR_INSERT_REQUEST_WITH_TASKS` or `SAPLSTR8`): the
 * function group is `SAPLSTR8`; `IV_TYPE` (`TRFUNCTION`-typed) and `IV_TEXT`
 * (`AS4TEXT`-typed) are both mandatory; `IV_OWNER` (`AS4USER`-typed) is
 * optional and defaults to `SY-UNAME` — so omitting it below is not "no
 * owner", it is "the logon user", which is the wanted behavior, not an
 * oversight; `ES_REQUEST_HEADER`/`ET_TASK_HEADERS` are exporting parameters
 * 1 and 2, typed `TRWBO_REQUEST_HEADER`/`TRWBO_REQUEST_HEADERS`; the
 * remaining seven importing parameters (`IV_TARGET`, `IV_TARDEVCL`,
 * `IV_DEVCLASS`, `IV_TARLAYER`, `IV_WITH_BADI_CHECK`, `IT_ATTRIBUTES`,
 * `IT_USERS`) are all optional and left unset — `IV_TARGET` in particular is
 * a deliberate choice, not an oversight: a request created with no
 * transport target is the right default for something this tool creates and
 * a verification run deletes again, and guessing a target from an unproven
 * optional parameter would be worse; `INSERT_FAILED`/`ENQUEUE_FAILED` are
 * the only two exceptions this FM raises.
 *
 * Only `AS4TEXT` = CHAR60 is independently corroborated by this repo (see
 * `CUSTREQ_DESCRIPTION_MAX` below) — everything else above is taken on the
 * strength of the live dictionary read alone.
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
  }),
  exceptions: Object.freeze({
    insertFailed: "insert_failed",
    enqueueFailed: "enqueue_failed",
  }),
  confidence: "high",
  note:
    "UNPROVEN FROM HERE: TR_INSERT_REQUEST_WITH_TASKS is an ordinary, heavily-used standard SAP " +
    "function module — SM30 and the rest of CTS call it constantly — but this server has never " +
    "itself called it, on this or any system. What was read live on 2026-09-05 is FUPARAREF " +
    "(parameter lists) and TFDIR (function group) — not a successful or failed call from here. The " +
    "parameter names and types here are read from the system's own dictionaries, not confirmed by a " +
    "call this server has made; the first time this generated code actually runs is also the first " +
    "time this server learns whether its own call is accepted. Measured shape: IV_TYPE " +
    "(TRFUNCTION) and IV_TEXT (AS4TEXT) " +
    "are mandatory; IV_OWNER (AS4USER) is optional and defaults to SY-UNAME, so omitting it " +
    "means \"the logon user\", not \"no owner\"; ES_REQUEST_HEADER/ET_TASK_HEADERS are " +
    "exporting parameters 1 and 2, typed TRWBO_REQUEST_HEADER/TRWBO_REQUEST_HEADERS; the " +
    "remaining seven importing parameters (IV_TARGET, IV_TARDEVCL, IV_DEVCLASS, IV_TARLAYER, " +
    "IV_WITH_BADI_CHECK, IT_ATTRIBUTES, IT_USERS) are optional and deliberately left unset — " +
    "IV_TARGET above all: no transport target is the right default for something this tool " +
    "creates and a verification run deletes again; INSERT_FAILED and ENQUEUE_FAILED are the " +
    "only two exceptions raised.",
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

  return [
    "DATA ls_request_header TYPE trwbo_request_header.",
    "DATA lt_task_headers TYPE trwbo_request_headers.",
    "DATA ls_task_header TYPE trwbo_request_header.",
    "DATA lv_msg TYPE string.",
    "DATA lv_exc TYPE string.",
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
    "READ TABLE lt_task_headers INTO ls_task_header INDEX 1.",
    "IF sy-subrc <> 0.",
    `  out->write( |${CUSTREQ_LINE_PREFIX}ERROR exception=[NO_TASK] len=[0] value=[]| ).`,
    "  RETURN.",
    "ENDIF.",
    "",
    `out->write( |${CUSTREQ_LINE_PREFIX}REQUEST len=[{ strlen( ls_request_header-trkorr ) }] value=[{ ls_request_header-trkorr }]| ).`,
    `out->write( |${CUSTREQ_LINE_PREFIX}TASK len=[{ strlen( ls_task_header-trkorr ) }] value=[{ ls_task_header-trkorr }]| ).`,
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
  errors: string[];
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

/**
 * Tolerant by design, same as `parseImgWriteTranscript` (`./img-write-bridge.ts`):
 * an unrecognized `CTSW> ` head, or a `CTSW> ` line whose fields don't match
 * the expected shape, is silently skipped — never thrown. Never routes a
 * `REQUEST`/`TASK` value into `errors`, and never reads a `trkorr`-shaped
 * value out of an `ERROR` line — the two tags are mutually exclusive by
 * construction in {@link customizingRequestBody} (every path either returns
 * after writing exactly one `ERROR` line, or falls through to write exactly
 * `REQUEST` then `TASK`, never both kinds).
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
  const result: CustomizingRequestTranscript = { errors: [] };

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
        case "ERROR": {
          const parsed = extractCustReqValue(remainder, CUSTREQ_ERR_RE);
          if (parsed) {
            const [exception] = parsed.fields;
            result.errors.push(`${exception}: ${parsed.value}`);
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
