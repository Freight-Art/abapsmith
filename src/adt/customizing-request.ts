/**
 * Customizing (type `W`) transport request creation, the counterpart to
 * `./transports.ts`'s workbench-request helpers for the one CTS shape they
 * cannot produce.
 *
 * Why ABAP run on the system instead of a plain ADT call: a prior
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
 * The ABAP that makes that call is the `create_request` action of the fluid
 * `img` tool (`ZCL_ZMCP_FLUID_IMG`, `./fluid/builtin/img.ts`), reached
 * through `dispatch()` by `runCreateCustomizingRequest` in `./img-write.ts`.
 * This module only validates the plan and parses the `CTSW>` transcript the
 * action writes — the same division of labor `./img-write-bridge.ts` keeps
 * for the probe and apply actions.
 */

import { AbapError } from "./errors.js";
import { DDIC_ERR_PREFIX } from "./ddic-bridge.js";
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
 * PROVEN FROM HERE: this FM has now been called twice, from this server.
 * The first call, on 2026-09-05, passed no `IT_USERS` row — `sy-subrc` came
 * back 0 and a type-`W` request WAS created (later confirmed visible via
 * `abap_transport list`), so the call is accepted at all and does create a
 * type-`W` request. `ET_TASK_HEADERS` came back empty on that call, which
 * is why `IT_USERS` is now populated — see the comment at its call site in
 * `ZCL_ZMCP_FLUID_IMG`'s `create_request` method (`src/adt/fluid/builtin/img.ts`)
 * for the full finding. The second call, on
 * 2026-09-06, ran the current code, passing `IT_USERS` with exactly one
 * `SY-UNAME` row, and also succeeded: `sy-subrc` came back 0, and a
 * type-`W` request was created together with a type-`Q` task. That
 * establishes the `IT_USERS` variant is accepted and does create a request
 * with a task — it does NOT establish that `IT_USERS` is what produced the
 * task: a type-`W` request gets a `'Q'` task by default regardless of
 * `IT_USERS`, so this one call cannot distinguish "the task came from
 * `IT_USERS`" from "the task came from the request type alone".
 *
 * STILL UNPROVEN FROM HERE: every failure path this FM can take —
 * `INSERT_FAILED`, `ENQUEUE_FAILED`, and any authority or lock refusal —
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
    "PROVEN FROM HERE: this FM has now been called twice, from this server. The first call, on " +
    "2026-09-05, passed no IT_USERS row — sy-subrc came back 0 and a type-W request WAS " +
    "created, later confirmed visible via abap_transport list. ET_TASK_HEADERS came back empty " +
    "on that call, which is why IT_USERS is now populated. The second call, on 2026-09-06, ran " +
    "the current code, passing IT_USERS with exactly one SY-UNAME row, and also succeeded: " +
    "sy-subrc came back 0, and a type-W request was created together with a type-Q task. That " +
    "establishes the IT_USERS variant is accepted and does create a request with a task; it " +
    "does not establish that IT_USERS is what produced the task, because a type-W request gets " +
    "a 'Q' task by default regardless of IT_USERS, so this call cannot distinguish the two. " +
    "STILL UNPROVEN FROM HERE: every failure path this FM can take (INSERT_FAILED, " +
    "ENQUEUE_FAILED, and any authority or lock refusal). What was read live on 2026-09-05 is " +
    "FUPARAREF (parameter lists) and TFDIR (function group). Measured shape: IV_TYPE " +
    "(TRFUNCTION) and IV_TEXT (AS4TEXT) are mandatory; IV_OWNER (AS4USER) is optional and " +
    "defaults to SY-UNAME, so omitting it means \"the logon user\", not \"no owner\"; " +
    "ES_REQUEST_HEADER/ET_TASK_HEADERS are exporting parameters 1 and 2, typed " +
    "TRWBO_REQUEST_HEADER/TRWBO_REQUEST_HEADERS; importing parameter 6, IT_USERS, is typed " +
    "SCTS_USERS and is now passed with exactly one row, SY-UNAME, because the live call above " +
    "created a request with no task when it was omitted. The remaining six importing " +
    "parameters (IV_TARGET, IV_TARDEVCL, IV_DEVCLASS, IV_TARLAYER, IV_WITH_BADI_CHECK, " +
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
  /** "W" (customizing, task type Q, default) or "K" (workbench, task type S). */
  readonly requestType?: "W" | "K";
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

  if (p.requestType !== undefined && p.requestType !== "W" && p.requestType !== "K") {
    throw new AbapError("BAD_INPUT", `request type must be "W" or "K", got ${JSON.stringify(p.requestType)}.`, {
      value: p.requestType,
    });
  }
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export interface CustomizingRequestTranscript {
  request?: string;
  task?: string;
  taskType?: string;
  requestType?: string;
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
 * exclusive by construction in `ZCL_ZMCP_FLUID_IMG`'s `create_request` method
 * (`src/adt/fluid/builtin/img.ts`) (every path either returns after writing
 * exactly one `ERROR` line, or falls through
 * to write `REQUEST`). What follows a `REQUEST` line is no longer fixed,
 * though: it is followed by *either* a `TASK` line immediately followed by
 * a `TASKTYPE` line (a task was found — `TASKTYPE` carries
 * `TRWBO_REQUEST_HEADER-TRFUNCTION` for that same task) *or* a
 * `WARN code=[NO_TASK]` line (the request was created with no task) — never
 * both, and never neither. `taskType` without `task` is not a shape this
 * bridge produces.
 *
 * A line missing the `CTSW> ` prefix is not automatically ignored, though.
 * An exception the fluid body class does not catch itself is reported by
 * the fluid runtime as an `ERR` frame, which `dispatch()` turns into a
 * thrown error before this parser ever sees the transcript. The two
 * transcript-level error prefixes the body class's sibling actions use,
 * `DDIC_ERR_PREFIX` (`./ddic-bridge.ts`) and `ERR_LINE_PREFIX` (`./run.ts`),
 * are still routed into `errors` here — reused rather than re-declared, the
 * same two constants `parseImgWriteTranscript` routes into its own `errors`
 * — so that a failure reported on either of them can never come back as an
 * empty, error-free result indistinguishable from a clean run that produced
 * nothing, which is the worst outcome for a write path. Every other
 * non-`CTSW> ` line is still ignored.
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
        case "REQTYPE": {
          const parsed = extractCustReqValue(remainder, CUSTREQ_VAL_RE);
          if (parsed) result.requestType = parsed.value;
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
