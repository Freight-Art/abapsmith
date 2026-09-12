/**
 * ATC (ABAP Test Cockpit) request building — pure functions, no socket.
 *
 * Originally derived from `abap-adt-api`'s ATC client (`atc.js`, v8.4.1) —
 * the only written-down description of this wire protocol available when
 * this module was first written. Issue #78 landed eight REAL captures from
 * an A4H appliance (`test/fixtures/live-captured/886`…`893`) that confirm or
 * correct that derivation in several places; each function below says which
 * capture backs it and which parts of the library-derived shape are still
 * unobserved guesses.
 *
 * ATC has no "check and answer" endpoint — a *worklist* (persistent
 * server-side row) is filled by a *run*, in three requests:
 *   1. `POST /atc/worklists?checkVariant={variant}` → worklist id. Creates
 *      persistent server state; deleting it answers 405 on this release, see
 *      {@link buildWorklistDeleteUrl}.
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

/**
 * `DELETE /sap/bc/adt/atc/worklists/{id}`. Always `application/xml` — this
 * request carries no worklist-specific document, so the worklist accept
 * headers used for GET/POST don't apply.
 */
export const ATC_WORKLIST_DELETE_ACCEPT = "application/xml";

/**
 * `DELETE /sap/bc/adt/atc/worklists/{id}`.
 *
 * On A4H this answers 405 `ExceptionMethodNotSupported`, "Resource
 * controller does not support method DELETE" (capture
 * `891-i78-worklist-delete-405`) — ATC worklists cannot be deleted on this
 * release. This builder exists anyway so the attempt is made and the
 * refusal reported honestly to the caller, rather than this client silently
 * pretending a worklist can be cleaned up; a release that does support
 * DELETE here would simply work through the same call.
 *
 * There is deliberately NO builder for the `?action=deleteFindings` action
 * ADT discovery advertises on the worklist resource
 * (`rel="http://www.sap.com/adt/atc/relations/actions/deleteFindings"`):
 * capture `892-i78-worklist-action-deletefindings-noop` shows it answers 200
 * with a zero-byte body and leaves the worklist's findings unchanged.
 * `CL_SATC_ADT_RES_WORKLIST->post` returns immediately for a URI carrying a
 * worklist id, and the `lcl_handler_delete_findings` implementation in its
 * CCIMP include is commented out in its entirety on this release — the
 * advertised action is a no-op, not a cleanup. Calling it would be
 * pretending to clean up.
 */
export function buildWorklistDeleteUrl(worklistId: string): string {
  assertWorklistId(worklistId);
  return `${ATC_WORKLISTS_PATH}/${encodeURIComponent(worklistId)}`;
}

// ---------------------------------------------------------- check variants ---

/** SCI/ATC check variant object type, as used in the repository quickSearch. */
export const ATC_CHECK_VARIANT_TYPE = "CHKV";

/** `Accept` header for the check-variant quickSearch — a plain repository search response. */
export const ATC_CHECK_VARIANT_SEARCH_ACCEPT = "application/xml";

/** Default `maxResults` for {@link buildCheckVariantSearchUrl}, matching what capture `886` was taken with. */
export const ATC_CHECK_VARIANT_DEFAULT_MAX = 200;

/**
 * `GET /sap/bc/adt/repository/informationsystem/search?operation=quickSearch&query=*&maxResults={n}&objectType=CHKV`.
 *
 * There is no usable `/sap/bc/adt/atc/checkvariants` collection to list from
 * on this release — a GET on it answers 400 `uriMappingError`. The
 * repository quickSearch is how a client actually enumerates check
 * variants; capture `886-i78-checkvariants-quicksearch` records this exact
 * URL (parameter order included) answering 200 with all 19 variants on that
 * appliance as `adtcore:objectReference` rows.
 *
 * A caller-supplied check variant MUST be validated against this list before
 * use: `POST /sap/bc/adt/atc/worklists?checkVariant=<nonsense>` answers 200
 * and creates a real worklist for a variant that does not exist (observed
 * live) — the server does not reject an unknown variant name at worklist
 * creation, so this client has to.
 *
 * `maxResults` is clamped to [1, 500], mirroring how {@link clampMaxVerdicts}
 * documents its own clamping.
 */
export function buildCheckVariantSearchUrl(maxResults?: number): string {
  let n = ATC_CHECK_VARIANT_DEFAULT_MAX;
  if (maxResults !== undefined && Number.isFinite(maxResults)) {
    n = Math.trunc(maxResults);
    if (n < 1) n = 1;
    if (n > 500) n = 500;
  }
  const params = new URLSearchParams();
  params.set("operation", "quickSearch");
  params.set("query", "*");
  params.set("maxResults", String(n));
  params.set("objectType", ATC_CHECK_VARIANT_TYPE);
  return `/sap/bc/adt/repository/informationsystem/search?${params.toString()}`;
}

// --------------------------------------------------------------- run body ---

/**
 * Upper bound on distinct object references a single {@link buildAtcRunBody}
 * call will accept. Not a documented server limit — a cost cap based on what
 * has actually been observed: a single package reference over 77 classes
 * took 134 s to run on A4H, and this client's default HTTP timeout
 * (`ABAP_TIMEOUT_MS`, `src/config.ts`, default 60 000 ms) is well under that
 * per-object rate for a large set. An object set without a bound is a
 * request that starts real server-side work and then cannot come back
 * before the client gives up on it — refusing an oversized set up front is
 * cheaper than timing out mid-run with a worklist left behind that nothing
 * here can delete (see {@link buildWorklistDeleteUrl}).
 */
export const ATC_MAX_RUN_TARGETS = 50;

/**
 * The `<atc:run>` request body: one inclusive `objectSet` carrying one
 * `adtcore:objectReference` per distinct object URI.
 *
 * The single-reference shape is byte-for-byte `abap-adt-api`'s template
 * (`atc.js:235-246`), incl. TAB indentation and no trailing newline; written
 * with explicit `\t`/`\n` so reformatting this file can't silently change
 * what goes on the wire.
 *
 * The multi-reference shape is no longer a guess: capture
 * `887-i78-run-two-packages` records a request body A4H answered 200 to for
 * one inclusive `objectSet` carrying TWO `adtcore:objectReference` package
 * URIs — proof that a single object set accepts several references, and
 * that a PACKAGE reference (`/sap/bc/adt/packages/<name>`, see
 * {@link packageObjectUri}) is accepted by this synchronous run body even
 * though the `SATC_RUN_REQ` simple transformation behind it has no package
 * field. `buildAtcRunBody([pkg1, pkg2], 100)` for the two URIs in that
 * capture reproduces its `requestBody` byte-for-byte (see
 * `test/atc-query.test.ts`).
 *
 * Still NOT observed, and not attempted here: an `exclusive` object set, the
 * `<options>` element (its simple transformation emits attributes onto a
 * single element, so it is effectively unusable as a general option carrier),
 * and `itemSets`.
 */
export function buildAtcRunBody(objectUris: readonly string[], maxVerdicts: number): string {
  if (!Array.isArray(objectUris) || objectUris.length === 0) {
    throw new AbapError(
      "BAD_INPUT",
      "An ATC run needs at least one object URI to check.",
      { objectUris },
      "Resolve the object(s) first; the run body carries their ADT URIs, not their names.",
    );
  }
  for (const objectUri of objectUris) {
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
  }
  // De-duplicate exact duplicates, preserving first-seen order: sending the
  // same reference twice would make the server check the same object twice
  // for no gain.
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const objectUri of objectUris) {
    if (seen.has(objectUri)) continue;
    seen.add(objectUri);
    deduped.push(objectUri);
  }
  if (deduped.length > ATC_MAX_RUN_TARGETS) {
    throw new AbapError(
      "BAD_INPUT",
      `An ATC run against ${deduped.length} distinct objects exceeds the ${ATC_MAX_RUN_TARGETS}-object cap this client enforces.`,
      { objectCount: deduped.length, cap: ATC_MAX_RUN_TARGETS },
      `Split the run into batches of at most ${ATC_MAX_RUN_TARGETS} objects. ` +
        "A single package reference over 77 classes took 134 s on A4H; an unbounded " +
        "object set risks a request this client's HTTP timeout cannot wait out.",
    );
  }
  const verdicts = clampMaxVerdicts(maxVerdicts);
  const references = deduped
    .map((uri) => `\t\t\t\t<adtcore:objectReference adtcore:uri="${uri}"/>\n`)
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<atc:run maximumVerdicts="${verdicts}" xmlns:atc="http://www.sap.com/adt/atc">\n` +
    '\t<objectSets xmlns:adtcore="http://www.sap.com/adt/core">\n' +
    '\t\t<objectSet kind="inclusive">\n' +
    "\t\t\t<adtcore:objectReferences>\n" +
    references +
    "\t\t\t</adtcore:objectReferences>\n" +
    "\t\t</objectSet>\n" +
    "\t</objectSets>\n" +
    "</atc:run>"
  );
}

/**
 * An ADT object reference for a whole package, as accepted by
 * {@link buildAtcRunBody}'s `objectSet`.
 *
 * Observed forms: `/sap/bc/adt/packages/z_flight_ref_prep` (capture
 * `887-i78-run-two-packages`) and `/sap/bc/adt/packages/%24abapsmith_fluid_api`
 * for the package named `$ABAPSMITH_FLUID_API` (a live run of 677 findings
 * over that package during this issue's investigation). Both confirm ADT
 * uses the LOWER-CASE object name in these URIs, not the upper-case name a
 * repository search or worklist finding shows for the same package.
 */
export function packageObjectUri(packageName: string): string {
  const trimmed = typeof packageName === "string" ? packageName.trim() : "";
  if (trimmed === "") {
    throw new AbapError(
      "BAD_INPUT",
      "An ATC run against a package needs the package's name.",
      { packageName },
      "Pass the package name, e.g. Z_MY_PACKAGE or $TMP.",
    );
  }
  return `/sap/bc/adt/packages/${encodeURIComponent(trimmed.toLowerCase())}`;
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
