/**
 * ATC (ABAP Test Cockpit) request building — pure functions, no socket.
 *
 * Derived from `abap-adt-api`'s ATC client (`atc.js`, v8.4.1) — the only
 * written-down description of this wire protocol available here. No byte in
 * this module has been observed against a live SAP system on this branch;
 * see the git history for full rationale. Where this
 * copies the library it copies exactly, including whitespace.
 *
 * ATC has no "check and answer" endpoint — a *worklist* (persistent
 * server-side row) is filled by a *run*, in three requests:
 *   1. `POST /atc/worklists?checkVariant={variant}` → worklist id. Creates
 *      persistent server state; there is no delete (see `src/adt/atc.ts`).
 *   2. `POST /atc/runs?worklistId={id}` + `<atc:run>` body → ack + timestamp.
 *   3. `GET  /atc/worklists/{id}?timestamp=&usedObjectSet=…` → findings.
 *
 * Step 3 needs `usedObjectSet` because a worklist ACCUMULATES across runs;
 * `LAST_RUN` scopes the read to just the run just made — see
 * {@link lastRunObjectSet}.
 */

import { AbapError } from "./errors.js";
import { ECHO_LINE_MAX, truncateText } from "../truncate.js";

// ------------------------------------------------------------------ paths ---

/** Read to discover the system's default check variant (`systemCheckVariant`) — `atc.js:195-216`. */
export const ATC_CUSTOMIZING_PATH = "/sap/bc/adt/atc/customizing";

/** Worklist collection: POST creates, GET `{id}` reads — `atc.js:218-310`. */
export const ATC_WORKLISTS_PATH = "/sap/bc/adt/atc/worklists";

/** Run collection: POST starts a run against an existing worklist. */
export const ATC_RUNS_PATH = "/sap/bc/adt/atc/runs";

// ---------------------------------------------------------------- accepts ---

/** `atc.js:196-198`. */
export const ATC_CUSTOMIZING_ACCEPT =
  "application/xml, application/vnd.sap.atc.customizing-v1+xml";

/** `atc.js:219`. The worklist-creation response is a bare id, not a document. */
export const ATC_WORKLIST_CREATE_ACCEPT = "text/plain";

/** `atc.js:249-252`. */
export const ATC_RUN_ACCEPT = "application/xml";
export const ATC_RUN_CONTENT_TYPE = "application/xml";

/**
 * `atc.js:266`. Missing `vnd.sap.` (unlike {@link ATC_CUSTOMIZING_ACCEPT}) is
 * not a typo here — copied verbatim from the library, not normalised.
 */
export const ATC_WORKLIST_ACCEPT = "application/atc.worklist.v1+xml";

// --------------------------------------------------------------- verdicts ---

/** `atc.js:234` — the library's own default for `maximumVerdicts`. */
export const ATC_DEFAULT_MAX_VERDICTS = 100;

/** Upper bound this client will ask for — not a known server limit, a cap on context/appliance load per call. */
export const ATC_MAX_VERDICTS = 500;

/**
 * The customizing property naming the system's default check variant.
 * `abap-adt-api`'s own test reads exactly this name (`src/test/atc.test.ts:5-9`).
 */
export const SYSTEM_CHECK_VARIANT_PROPERTY = "systemCheckVariant";

/**
 * The object set that scopes a worklist read to the most recent run.
 * The only `kind` value seen in the library or its tests, but `kind` is typed
 * as a plain string, so other releases may use others — see {@link lastRunObjectSet}.
 */
export const ATC_LAST_RUN_KIND = "LAST_RUN";

// -------------------------------------------------------------- url build ---

/**
 * `POST /sap/bc/adt/atc/worklists?checkVariant={variant}`.
 *
 * Deliberate departure from the library: `atc.js:221` interpolates the variant
 * raw, so `&`/space breaks the URL. This encodes it; {@link assertVariantName}
 * also restricts to identifiers, so the encoding is belt-and-braces.
 */
export function buildWorklistCreateUrl(variant: string): string {
  assertVariantName(variant);
  return `${ATC_WORKLISTS_PATH}?checkVariant=${encodeURIComponent(variant)}`;
}

/**
 * `POST /sap/bc/adt/atc/runs?worklistId={id}`.
 *
 * The library names this param `variant` (`atc.js:230`), but it holds the
 * worklist id and the wire parameter is `worklistId`; named here for the wire.
 */
export function buildRunUrl(worklistId: string): string {
  assertWorklistId(worklistId);
  return `${ATC_RUNS_PATH}?worklistId=${encodeURIComponent(worklistId)}`;
}

/** Query parameters for a worklist read. All three are optional on the wire. */
export interface WorklistReadOptions {
  /**
   * Seconds since the epoch, from {@link atcTimestampSeconds}. Send only
   * alongside `usedObjectSet` — the library never sends one without the
   * other (`atc.js:265-275`), and an unscoped read doesn't need it.
   */
  readonly timestamp?: number;
  /** Object set name, normally the one whose `kind` is `LAST_RUN`. */
  readonly usedObjectSet?: string;
  /** Default false, matching `atc.js:270`. Always sent, also matching it. */
  readonly includeExempted?: boolean;
}

/**
 * `GET /sap/bc/adt/atc/worklists/{id}[?…]`.
 * Sends `includeExemptedFindings` unconditionally, matching the library
 * (axios drops `undefined` params but not `false`).
 */
export function buildWorklistReadUrl(
  worklistId: string,
  opts: WorklistReadOptions = {},
): string {
  assertWorklistId(worklistId);
  const params = new URLSearchParams();
  if (opts.timestamp !== undefined && Number.isFinite(opts.timestamp)) {
    params.set("timestamp", String(opts.timestamp));
  }
  if (opts.usedObjectSet !== undefined && opts.usedObjectSet !== "") {
    params.set("usedObjectSet", opts.usedObjectSet);
  }
  params.set("includeExemptedFindings", String(opts.includeExempted === true));
  return `${ATC_WORKLISTS_PATH}/${encodeURIComponent(worklistId)}?${params.toString()}`;
}

// --------------------------------------------------------------- run body ---

/**
 * The `<atc:run>` request body.
 *
 * Byte-for-byte the library's template (`atc.js:235-246`), incl. TAB
 * indentation and no trailing newline; written with explicit `\t`/`\n` so
 * reformatting this file can't silently change what goes on the wire.
 *
 * Emits exactly one `objectSet`/`objectReference` even though the schema
 * allows several — an unobserved multi-object body is a guess that would
 * start server-side work on N objects; not the place to guess.
 */
export function buildAtcRunBody(objectUri: string, maxVerdicts: number): string {
  if (typeof objectUri !== "string" || objectUri.trim() === "") {
    throw new AbapError(
      "BAD_INPUT",
      "An ATC run needs an object URI to check.",
      { objectUri },
      "Resolve the object first; the run body carries its ADT URI, not its name.",
    );
  }
  if (objectUri.includes('"') || objectUri.includes("<") || objectUri.includes("&")) {
    // Library interpolates this unescaped into an XML attribute; refuse
    // rather than add escaping the server may not accept.
    throw new AbapError(
      "BAD_INPUT",
      "That object URI contains characters that cannot go into the ATC run request.",
      { objectUri },
      "ADT object URIs are plain paths. Pass the object by name and let this server resolve it.",
    );
  }
  const verdicts = clampMaxVerdicts(maxVerdicts);
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<atc:run maximumVerdicts="${verdicts}" xmlns:atc="http://www.sap.com/adt/atc">\n` +
    '\t<objectSets xmlns:adtcore="http://www.sap.com/adt/core">\n' +
    '\t\t<objectSet kind="inclusive">\n' +
    "\t\t\t<adtcore:objectReferences>\n" +
    `\t\t\t\t<adtcore:objectReference adtcore:uri="${objectUri}"/>\n` +
    "\t\t\t</adtcore:objectReferences>\n" +
    "\t\t</objectSet>\n" +
    "\t</objectSets>\n" +
    "</atc:run>"
  );
}

/** Bounds `maximumVerdicts` into [1, {@link ATC_MAX_VERDICTS}]. */
export function clampMaxVerdicts(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return ATC_DEFAULT_MAX_VERDICTS;
  const n = Math.trunc(requested);
  if (n < 1) return 1;
  if (n > ATC_MAX_VERDICTS) return ATC_MAX_VERDICTS;
  return n;
}

// ------------------------------------------------------------- validation ---

// Leading `/` allowed (customer/partner namespace, e.g. `/NAMESPACE/VARIANT`); leading digit is not.
const VARIANT_RE = /^[A-Za-z_/][A-Za-z0-9_/-]{0,29}$/;

/** Check variant names are SCI repository object names; refusing anything else stops a caller-supplied variant from reshaping downstream URLs. */
export function assertVariantName(variant: string): void {
  if (typeof variant === "string" && VARIANT_RE.test(variant)) return;
  throw new AbapError(
    "BAD_INPUT",
    `"${variant}" is not a usable ATC check variant name.`,
    { variant },
    "Check variant names look like ABAP identifiers (e.g. DEFAULT, ABAP_CLOUD_READINESS). " +
      "Omit the parameter to use the system default from ATC customizing.",
  );
}

/**
 * The id the server hands back for a worklist. The library's own test asserts
 * a hex token (`/^[0-9A-F]+$/i`), but this accepts a wider identifier set —
 * one test against one appliance doesn't pin the format across releases —
 * while still rejecting anything that could reshape the URL it's spliced into.
 */
export function assertWorklistId(id: string): void {
  if (typeof id === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(id)) return;
  throw new AbapError(
    "ADT_ERROR",
    "The server's ATC worklist id is not in a form this client will use.",
    {
      // Bounded via truncateText (shows "n of m chars shown") rather than a
      // silent .slice(), since a whole document can land here instead of an id.
      worklistId: typeof id === "string" ? truncateText(id, ECHO_LINE_MAX) : typeof id,
    },
    "This is a server response, not caller input — the worklist create call answered " +
      "something other than a plain id. The run was not started.",
  );
}

// -------------------------------------------------------------- selection ---

/** An object set as it appears on a worklist. */
export interface AtcObjectSetRef {
  readonly name: string;
  readonly kind: string;
  readonly title?: string;
}

/**
 * The object set scoping a read to the most recent run, or `undefined` when
 * the worklist declares none. `undefined` is a real answer, not an error —
 * the caller must say so rather than silently presenting an accumulated
 * worklist as one run's result.
 */
export function lastRunObjectSet(
  sets: readonly AtcObjectSetRef[] | undefined,
): AtcObjectSetRef | undefined {
  return (sets ?? []).find((s) => s.kind === ATC_LAST_RUN_KIND);
}

/**
 * `new Date(x).getTime() / 1000` — the conversion the library applies to both
 * timestamp fields (`atc.js:261`, `atc.js:306`) and feeds back as the
 * `timestamp` query param. Reproduced, not verified: that the server accepts
 * back whole seconds round-tripped through `Date` is an assumption inherited
 * from the library. Returns `undefined` for unparseable input so the caller
 * omits the param instead of sending `NaN`.
 */
export function atcTimestampSeconds(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const ms = new Date(raw).getTime();
  if (!Number.isFinite(ms)) return undefined;
  return ms / 1000;
}

// --------------------------------------------------------------- location ---

/** A source position pulled out of a finding's `location` URI. */
export interface AtcLocation {
  /** The path part, with the fragment removed. */
  readonly uri: string;
  readonly line?: number;
  readonly column?: number;
}

/**
 * Split a finding's `location` into a path and a line/column. ADT encodes
 * positions in the fragment (`…/source/main#start=17,4;end=17,9`); only
 * `start` is read. No parsable `start` yields just the path — a wrong line
 * number is worse than none.
 */
export function parseAtcLocation(location: string | undefined): AtcLocation {
  const raw = location ?? "";
  const hash = raw.indexOf("#");
  if (hash < 0) return { uri: raw };
  const uri = raw.slice(0, hash);
  const fragment = raw.slice(hash + 1);
  for (const part of fragment.split(";")) {
    const [key, value] = part.split("=", 2);
    if (key !== "start" || value === undefined) continue;
    const [lineText, colText] = value.split(",", 2);
    const line = Number.parseInt(lineText ?? "", 10);
    if (!Number.isFinite(line)) break;
    const column = Number.parseInt(colText ?? "", 10);
    return Number.isFinite(column) ? { uri, line, column } : { uri, line };
  }
  return { uri };
}

/** ATC priorities are 1 (error) .. 3 (info); an unknown value is passed through with a neutral label rather than dropped. */
export function priorityLabel(priority: number): string {
  if (priority === 1) return "error";
  if (priority === 2) return "warning";
  if (priority === 3) return "info";
  return `prio ${priority}`;
}
