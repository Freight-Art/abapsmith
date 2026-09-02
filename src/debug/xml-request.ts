/**
 * Portions derived from vibing-steampunk (pkg/adt/debugger.go: buildBreakpointRequestXML),
 * Copyright (c) 2025-2026 Alice Vinogradova and contributors, MIT.
 * See THIRD-PARTY-NOTICES.md.
 */

/**
 * Debugger request-body builders: pure `(input) => string`, no HTTP/state/I/O.
 * The XML namespace rule lives here and nowhere else — every other module
 * building a `<dbg:breakpoints>` or `<asx:abap>` body calls into here.
 *
 * Ground truth is SAP's shipped `TPDA_ADT_BREAKPOINTS_REQUEST` XSLT and
 * `CL_TPDA_ADT_RES_BREAKPOINTS`, not the reference implementation or `abap-adt-api` where they disagree.
 *
 * Two XML families, deliberately not unified behind one generic builder:
 *   - `dbg:` family (`buildBreakpointsRequestXml`) — camelCase attributes.
 *   - `asx:abap` family (`buildGetVariablesXml`, `buildGetChildVariablesXml`)
 *     — SCREAMING_SNAKE child elements, no attributes.
 */

import { AbapError } from "../adt/errors.js";
import type { Breakpoint, BreakpointsRequest } from "./types.js";

// ---------------------------------------------------------------------------
// Namespaces (owned exclusively by this file, per the module contract)
// ---------------------------------------------------------------------------

const DBG_NS = "http://www.sap.com/adt/debugger";
const ADTCORE_NS = "http://www.sap.com/adt/core";
const ASX_NS = "http://www.sap.com/abapxml";

// ---------------------------------------------------------------------------
// XML escaping — do not hand-roll a partial version. An earlier implementation didn't escape at all
// (see the git history). Single escaper, used
// for every attribute value and text node below.
// ---------------------------------------------------------------------------

const XML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/**
 * Escapes a raw string for use as an XML attribute value or text node.
 * Treats input as always-unescaped: an already-encoded `&amp;` is escaped
 * again to `&amp;amp;` — the contract is "make raw text safe", not
 * "normalise already-encoded XML".
 */
export function escapeXml(value: string): string {
  // Untyped JSON/MCP input reaches this at runtime despite the `string`
  // signature. Coercing with String() would silently produce `[object Object]`
  // as an ADT uri, so non-string throws instead; numeric callers (numAttr)
  // stringify before calling.
  const raw = value as unknown;
  if (typeof raw !== "string") {
    throw new AbapError(
      "BAD_INPUT",
      `A non-string value reached XML escaping (typeof "${typeof raw}", ${describeValue(raw)}). ` +
        `escapeXml never coerces — stringify deliberately at the call site or fix the caller.`,
      { received: raw, receivedType: typeof raw },
    );
  }
  return raw.replace(/[&<>"']/g, (ch) => XML_ESCAPE_MAP[ch] as string);
}

// ---------------------------------------------------------------------------
// Small attribute-rendering helpers (internal only)
// ---------------------------------------------------------------------------

/**
 * Omits the attribute for undefined/null/"" (mirrors the XSLT's
 * `not-initial(...)` gating). A present-but-wrong-typed value throws rather
 * than being coerced or silently omitted.
 */
function strAttr(name: string, value: string | undefined): string {
  const raw = value as unknown;
  if (raw === undefined || raw === null || raw === "") return "";
  if (typeof raw !== "string") {
    throw new AbapError("BAD_INPUT", `Attribute "${name}" must be a string when present, received ${describeValue(raw)}.`, {
      attribute: name,
      received: raw,
    });
  }
  return ` ${name}="${escapeXml(raw)}"`;
}

/**
 * Describes a rejected value for an error message — enough to tell `undefined`
 * from `null` from `""` from `42` without dumping a whole object inline.
 */
function describeValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (value === "") return "an empty string";
  if (typeof value === "string") return `"${value}"`;
  return `a ${typeof value} (${String(value)})`;
}

/**
 * Narrows a MANDATORY breakpoint field to a non-empty string, or throws
 * BAD_INPUT naming both the field and the kind. Needed because the MCP/JSON
 * boundary is untyped: a missing/null/wrongly-typed mandatory field used to
 * serialise to a well-formed but empty attribute — SAP answers 200 and
 * registers nothing.
 */
function requireStr(kind: string, field: string, value: unknown, base: string, bp: unknown): string {
  if (typeof value === "string" && value !== "") return value;
  throw new AbapError(
    "BAD_INPUT",
    `${base} Received ${describeValue(value)} for field "${field}" (kind "${kind}") — ` +
      `emitting it anyway produces XML that SAP answers 200 to while registering nothing.`,
    { breakpoint: bp },
  );
}

// ---------------------------------------------------------------------------
// Mandatory-field table, derived from the type (not hand-maintained prose).
// Previously inlined in the render switch, so a new required field in
// `Breakpoint` left validation silently stale. `satisfies` + the
// exhaustiveness witness below turn that drift into a tsc failure.
// ---------------------------------------------------------------------------

/** The keys of `T` that are genuinely required (an optional key makes `{}` assignable to its `Pick`). */
type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];

/** Required keys of one union member, minus the `kind` discriminant itself. */
type OwnRequired<K extends Breakpoint["kind"]> = Exclude<RequiredKeys<Extract<Breakpoint, { kind: K }>>, "kind">;

const REQUIRED_BREAKPOINT_FIELDS = {
  line: ["uri"],
  exception: ["exceptionClass"],
  statement: ["statement"],
  message: ["msgId", "msgNo", "msgTy"],
} as const satisfies { [K in Breakpoint["kind"]]: readonly OwnRequired<K>[] };

/**
 * Compile-time witness that every required field appears in the table above
 * (`satisfies` alone only proves the converse). Referenced below so the check
 * can't be deleted as dead code.
 */
type _ExhaustiveRequiredFields = {
  [K in Breakpoint["kind"]]: [OwnRequired<K>] extends [(typeof REQUIRED_BREAKPOINT_FIELDS)[K][number]]
    ? true
    : ["missing required field for kind", K];
};

/** Keeps `_ExhaustiveRequiredFields` load-bearing: only assignable when every member is `true`. */
const _REQUIRED_FIELDS_ARE_EXHAUSTIVE: _ExhaustiveRequiredFields = {
  line: true,
  exception: true,
  statement: true,
  message: true,
};
void _REQUIRED_FIELDS_ARE_EXHAUSTIVE;

/** Per-kind lead sentence for the mandatory-field error. Kept verbatim from the original inline checks. */
const REQUIRED_FIELD_ERROR_BASE: { [K in Breakpoint["kind"]]: string } = {
  line: "Line breakpoint requires a non-empty uri (use buildLineBreakpointUri).",
  exception: "Exception breakpoint requires a non-empty exceptionClass.",
  statement: "Statement breakpoint requires a non-empty statement.",
  message:
    "Message breakpoint requires non-empty msgId, msgNo AND msgTy (an earlier implementation omitted msgNo — do not repeat that).",
};

/** Omits the attribute when `value` is `undefined` — unlike `strAttr`, `0` is a meaningful, real value (`skipCount="0"` = "break every hit") and must NOT be treated as empty. */
function numAttr(name: string, value: number | undefined): string {
  if (value === undefined) return "";
  return ` ${name}="${escapeXml(String(value))}"`;
}

/**
 * Renders `name="true"` only when `value === true`. Server compares this
 * string-wise (`to_upper(...) eq 'TRUE'`) — `"X"`/`"1"` do not work, only
 * literal lowercase `"true"`. Same convention for `systemDebugging`/`deactivated`.
 */
function trueAttr(name: string, value: boolean | undefined): string {
  if (value !== true) return "";
  return ` ${name}="true"`;
}

// ---------------------------------------------------------------------------
// Line-breakpoint URI — requirement 5
// ---------------------------------------------------------------------------

/**
 * Builds the `adtcore:uri` a line breakpoint is identified by: object URI +
 * `#start=<line>`. The only valid form here — the `#start=L,C;end=L,C` form
 * used elsewhere in ADT does not work (server discards anything after a
 * comma in this fragment). Server may rewrite the line to the nearest valid
 * statement; that's the response parser's concern, not this builder's.
 */
export function buildLineBreakpointUri(objectUri: string, line: number): string {
  if (objectUri === "") {
    throw new AbapError("BAD_INPUT", "buildLineBreakpointUri requires a non-empty objectUri.");
  }
  if (objectUri.includes("#")) {
    throw new AbapError(
      "BAD_INPUT",
      `objectUri must not already carry a fragment (the #start=N fragment is added by this function): "${objectUri}"`,
      { objectUri },
    );
  }
  if (!Number.isInteger(line) || line <= 0) {
    throw new AbapError("BAD_INPUT", `Line breakpoint requires a positive integer line number, got ${line}.`, {
      line,
    });
  }
  return `${objectUri}#start=${line}`;
}

// ---------------------------------------------------------------------------
// Breakpoint request — the centrepiece
// ---------------------------------------------------------------------------

/**
 * The one error for "this kind is not on the wire" — raised both from the
 * `default:` branch of the render switch and from the up-front check that
 * `kind` is even a string, so the two cannot drift apart.
 */
function unsupportedKindError(bp: Breakpoint): AbapError {
  const received = bp as { kind?: unknown } | null | undefined;
  return new AbapError(
    "BAD_INPUT",
    `Unsupported breakpoint kind "${String(received?.kind)}". The wire protocol supports only ` +
      `line, exception, statement and message — modelling any other kind the way an earlier implementation ` +
      `did produces a silently empty <dbg:breakpoints/> that SAP accepts and ignores.`,
    { received: bp },
  );
}

/**
 * Renders one `<breakpoint .../>` element. Only four kinds are wire-real
 * (`Breakpoint` is a `line | exception | statement | message` union); the
 * `default` branch handles untyped/JSON-sourced input and throws rather than
 * falling through — an earlier implementation had no case for 4 of its 8 kinds and silently
 * produced an empty, structurally-valid `<dbg:breakpoints/>` that SAP
 * accepted and ignored.
 */
function renderBreakpointXml(bp: Breakpoint): string {
  // Settled before any attribute renders, rather than reaching escapeXml as a raw TypeError.
  if (typeof (bp as { kind?: unknown })?.kind !== "string") {
    throw unsupportedKindError(bp);
  }

  // `enabled` is dropped (never in the XSLT — an earlier check was dead code).
  // `id` is server-assigned-only and never serialised here (see
  // `BreakpointCommon.id` in types.ts).
  let attrs = "";
  attrs += strAttr("kind", bp.kind);
  attrs += strAttr("clientId", bp.clientId);
  attrs += numAttr("skipCount", bp.skipCount);
  attrs += strAttr("condition", bp.condition);
  attrs += trueAttr("validationOnly", bp.validationOnly);

  // Driven by the type-derived table so it can't drift from `Breakpoint`;
  // checked field-by-field so the error names which one was missing.
  const requiredFields: readonly string[] | undefined = REQUIRED_BREAKPOINT_FIELDS[bp.kind];
  if (requiredFields === undefined) throw unsupportedKindError(bp);
  const fieldValues = bp as unknown as Record<string, unknown>;
  for (const field of requiredFields) {
    requireStr(bp.kind, field, fieldValues[field], REQUIRED_FIELD_ERROR_BASE[bp.kind], bp);
  }

  switch (bp.kind) {
    case "line": {
      attrs += ` adtcore:uri="${escapeXml(bp.uri)}"`;
      break;
    }
    case "exception": {
      attrs += strAttr("exceptionClass", bp.exceptionClass);
      break;
    }
    case "statement": {
      attrs += strAttr("statement", bp.statement);
      break;
    }
    case "message": {
      // NB msgNo is a STRING on the wire (`"008"` keeps its leading zeros).
      attrs += strAttr("msgId", bp.msgId);
      attrs += strAttr("msgNo", bp.msgNo);
      attrs += strAttr("msgTy", bp.msgTy);
      break;
    }
    default: {
      // Runtime guard for the four kinds the wire protocol never supported
      // (an earlier implementation also declared `badi`, `enhancement`, `watchpoint`, `method`).
      throw unsupportedKindError(bp);
    }
  }

  return `  <breakpoint${attrs}/>`;
}

/** Renders the optional `<syncScope>` element. Omitting `<syncScope>` entirely is legal and is the non-destructive default — this function is only ever called when the caller deliberately opted in. */
function renderSyncScopeXml(syncScope: NonNullable<BreakpointsRequest["syncScope"]>): string {
  // `mode` decides how destructive this element is, so it is never inferred
  // or defaulted — an absent/mistyped mode fails loudly instead of reaching
  // `escapeXml` as a raw TypeError.
  const mode = requireStr(
    "syncScope",
    "mode",
    syncScope.mode,
    'syncScope requires a non-empty mode ("full" or "partial").',
    syncScope,
  );
  const rawObjectUri = syncScope.objectUri as unknown;
  // objectUri stays OPTIONAL (omitted when absent), but a present-and-wrong
  // value is an error, never a silent omission.
  if (rawObjectUri !== undefined && rawObjectUri !== null && rawObjectUri !== "" && typeof rawObjectUri !== "string") {
    throw new AbapError("BAD_INPUT", `syncScope.objectUri must be a string when present, received ${describeValue(rawObjectUri)}.`, {
      syncScope,
    });
  }
  const child =
    typeof rawObjectUri === "string" && rawObjectUri !== ""
      ? `\n    <adtcore:objectReference xmlns:adtcore="${ADTCORE_NS}" adtcore:uri="${escapeXml(rawObjectUri)}"/>`
      : "";
  return `  <syncScope mode="${escapeXml(mode)}">${child}\n  </syncScope>`;
}

/**
 * Enforces exactly what `CL_TPDA_ADT_RES_BREAKPOINTS=>init_static` enforces:
 *   - `debuggingMode="terminal"` ⇒ terminalId AND ideId mandatory.
 *   - `debuggingMode="user"` ⇒ requestUser mandatory (ideId not checked).
 * Everything else is optional here. Zero breakpoints is deliberately legal:
 * `POST` with `<syncScope mode="full">` and no children is the (destructive)
 * way to enumerate existing breakpoints — there is no read-only list endpoint.
 */
function assertMandatoryFields(request: BreakpointsRequest): void {
  if (request.debuggingMode === "terminal") {
    if (!request.terminalId || !request.ideId) {
      throw new AbapError(
        "BAD_INPUT",
        'debuggingMode="terminal" requires BOTH terminalId and ideId. ' +
          'Note: SAP\'s own server-side error names only "terminalId" even when ideId was the ' +
          "one actually missing — don't be misled by that when reading a live error back.",
        { debuggingMode: request.debuggingMode, terminalId: request.terminalId, ideId: request.ideId },
      );
    }
  } else if (request.debuggingMode === "user") {
    if (!request.requestUser) {
      throw new AbapError(
        "BAD_INPUT",
        'debuggingMode="user" requires requestUser. ideId is not checked in user mode.',
        { debuggingMode: request.debuggingMode },
      );
    }
  } else {
    throw new AbapError("BAD_INPUT", `Unsupported debuggingMode "${String(request.debuggingMode)}".`, {
      debuggingMode: request.debuggingMode,
    });
  }

  // Must be an array (not just present) so a bad shape fails as BAD_INPUT
  // here rather than as a raw TypeError inside the loop below.
  if (!Array.isArray(request.breakpoints)) {
    throw new AbapError(
      "BAD_INPUT",
      `breakpoints must be an array (send [] for the deliberate zero-breakpoint case), received ${describeValue(request.breakpoints)}.`,
      { breakpoints: request.breakpoints },
    );
  }

  for (const bp of request.breakpoints) {
    if (!bp || typeof bp !== "object" || !("kind" in bp) || !bp.kind) {
      throw new AbapError("BAD_INPUT", "Every breakpoint requires a kind (the only unconditionally emitted attribute).", {
        breakpoint: bp,
      });
    }
  }
}

/**
 * Builds the `POST /sap/bc/adt/debugger/breakpoints` request body. Shape
 * verified against SAP's shipped `TPDA_ADT_BREAKPOINTS_REQUEST` XSLT and
 * `CL_TPDA_ADT_RES_BREAKPOINTS`:
 *
 * ```xml
 * <dbg:breakpoints xmlns:dbg="http://www.sap.com/adt/debugger"
 *                  xmlns:adtcore="http://www.sap.com/adt/core"
 *                  debuggingMode="user|terminal" scope="external|debugger"
 *                  requestUser="…" terminalId="…" ideId="…"
 *                  systemDebugging="true" deactivated="true">
 *   <syncScope mode="full|partial">
 *     <adtcore:objectReference xmlns:adtcore="http://www.sap.com/adt/core" adtcore:uri="…"/>
 *   </syncScope>
 *   <breakpoint kind="line" clientId="…" skipCount="0" validationOnly="true"
 *      adtcore:uri="/sap/bc/adt/programs/programs/zfoo/source/main#start=42"/>
 * </dbg:breakpoints>
 * ```
 *
 * Root is prefixed (`dbg:`); per-breakpoint children are BARE `<breakpoint>`
 * (no prefix) — getting this backwards is a known silent-failure bug: 200
 * with nothing stored.
 */
export function buildBreakpointsRequestXml(request: BreakpointsRequest): string {
  assertMandatoryFields(request);

  let rootAttrs = "";
  rootAttrs += strAttr("debuggingMode", request.debuggingMode);
  rootAttrs += strAttr("scope", request.scope);
  rootAttrs += strAttr("requestUser", request.requestUser);
  rootAttrs += strAttr("terminalId", request.terminalId);
  rootAttrs += strAttr("ideId", request.ideId);
  rootAttrs += trueAttr("systemDebugging", request.systemDebugging);
  rootAttrs += trueAttr("deactivated", request.deactivated);

  const syncScopeXml = request.syncScope ? renderSyncScopeXml(request.syncScope) : "";
  const breakpointsXml = request.breakpoints.map(renderBreakpointXml).join("\n");

  const body = [
    `<dbg:breakpoints xmlns:dbg="${DBG_NS}" xmlns:adtcore="${ADTCORE_NS}"${rootAttrs}>`,
    syncScopeXml,
    breakpointsXml,
    `</dbg:breakpoints>`,
  ]
    .filter((part) => part !== "")
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
}

// ---------------------------------------------------------------------------
// asx:abap request bodies — variable calls. SCREAMING_SNAKE child elements,
// no attributes (see file header).
// ---------------------------------------------------------------------------

/**
 * Builds the `POST /sap/bc/adt/debugger?method=getVariables` body — one
 * `<STPDA_ADT_VARIABLE>` row per variable ID (ABAP paths like `SY-SUBRC`,
 * `LT_ITEMS[3]-MATNR`, or pseudo-scopes `@ROOT`/`@DATAAGING`):
 *
 * ```xml
 * <?xml version="1.0" encoding="UTF-8"?>
 * <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA>
 *   <STPDA_ADT_VARIABLE><ID>SY-SUBRC</ID></STPDA_ADT_VARIABLE>
 * </DATA></asx:values></asx:abap>
 * ```
 *
 * Flat `<DATA><STPDA_ADT_VARIABLE>` envelope — one level shallower than
 * `buildGetChildVariablesXml`'s response counterpart; getting request/response
 * envelope depth confused is a parser-side risk, not this builder's.
 */
export function buildGetVariablesXml(variableIds: readonly string[]): string {
  if (variableIds.length === 0) {
    throw new AbapError("BAD_INPUT", "buildGetVariablesXml requires at least one variable id.");
  }
  const rows = variableIds
    .map((id) => `  <STPDA_ADT_VARIABLE><ID>${escapeXml(id)}</ID></STPDA_ADT_VARIABLE>`)
    .join("\n");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<asx:abap xmlns:asx="${ASX_NS}" version="1.0"><asx:values><DATA>\n` +
    `${rows}\n` +
    `</DATA></asx:values></asx:abap>`
  );
}

/**
 * Builds the `POST /sap/bc/adt/debugger?method=getChildVariables` body — one
 * `<STPDA_ADT_VARIABLE_HIERARCHY>` row per parent ID to expand:
 *
 * ```xml
 * <?xml version="1.0" encoding="UTF-8"?>
 * <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA><HIERARCHIES>
 *   <STPDA_ADT_VARIABLE_HIERARCHY><PARENT_ID>@ROOT</PARENT_ID></STPDA_ADT_VARIABLE_HIERARCHY>
 * </HIERARCHIES></DATA></asx:values></asx:abap>
 * ```
 *
 * Batching N parents keeps subtree expansion to a few round trips instead of
 * one per node; the response's `HIERARCHIES` list re-attributes the flat
 * `VARIABLES` array to its parents.
 */
export function buildGetChildVariablesXml(parentIds: readonly string[]): string {
  if (parentIds.length === 0) {
    throw new AbapError("BAD_INPUT", "buildGetChildVariablesXml requires at least one parent id.");
  }
  const rows = parentIds
    .map((id) => `    <STPDA_ADT_VARIABLE_HIERARCHY><PARENT_ID>${escapeXml(id)}</PARENT_ID></STPDA_ADT_VARIABLE_HIERARCHY>`)
    .join("\n");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<asx:abap xmlns:asx="${ASX_NS}" version="1.0"><asx:values><DATA><HIERARCHIES>\n` +
    `${rows}\n` +
    `</HIERARCHIES></DATA></asx:values></asx:abap>`
  );
}
