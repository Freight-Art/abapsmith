/**
 * Declarative rule table for `translateAdtError`'s (`./session.ts`)
 * UNCLASSIFIED fallback ONLY — every named branch above it there (session
 * death, CSRF, lock conflict, invalid lock handle, not-found,
 * CX_SY_CASE_NOT_FOUND) is out of scope for this table and untouched by it.
 *
 * Same discipline as `./enhancement-refusals.ts` (read it first): `T100KEY-ID`
 * + `T100KEY-NO` is the reliable match, prose is a fallback for servers that
 * send no T100 key, and an unmatched message returns `undefined` — never a
 * guess. Unlike that module, this one does not re-derive an `AbapError`; it
 * only names a rule, so `translateAdtError` stays the single place that
 * constructs the envelope.
 */

import type { AbapErrorCode } from "./errors.js";

export interface AdtMessageRule {
  /** Stable identifier, surfaced in details so a run can be counted by rule. */
  readonly id: string;
  readonly t100Id?: string;
  readonly t100No?: string;
  /** Prose fallback for servers that send no T100 key. */
  readonly match?: RegExp;
  /** `exc:exception`'s `type` id (e.g. `"ExceptionInvalidData"`) this rule matches on, in addition to (or instead of) a T100 key / prose match. */
  readonly exceptionType?: string;
  /** A property key that must be present and non-empty for this rule to match — only meaningful together with `exceptionType`. */
  readonly property?: string;
  /** Whether a retry could ever succeed is stated in this prose, not as a field:
   * `retryable: false` is reserved for `"UNSUPPORTED"` capability-registry
   * refusals (see `test/refusal-terminality.test.ts`). A function hint is
   * given the classified message and properties, for a rule whose advice
   * depends on what the server actually sent (e.g. naming the offending
   * XML_PATH element). */
  readonly hint: string | ((message: string, properties: Record<string, string>) => string);
  /** Overrides `translateAdtError`'s default `"ADT_ERROR"` code when set. */
  readonly code?: AbapErrorCode;
  /** Extra details merged into the thrown `AbapError`, keyed off the match. */
  readonly details?: (message: string, properties: Record<string, string>) => Record<string, unknown>;
}

/**
 * `T100KEY-NO` can lose a leading zero passing through fast-xml-parser (see
 * `./enhancement-refusals.ts`'s `sameT100No` for the confirmed case) — same
 * numeric-safe comparison here, even though today's one rule ("462") has no
 * leading zero to lose, so a future rule doesn't have to rediscover this.
 */
function sameT100No(a: string, b: string): boolean {
  if (a === b) return true;
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return Number(a) === Number(b);
  return false;
}

const PACKAGE_SOFTWARE_COMPONENT_REFUSED_HINT =
  "SAP is refusing the SOFTWARE COMPONENT, not the package name. LOCAL is only accepted for a " +
  "$-named local package, so a Z* or Y* name can never be assigned to it. Pass " +
  'software_component: "HOME" (or another real software component configured on this system) ' +
  "to create the package as a transportable one — that route needs a transport request, so " +
  "supply one as `corr_nr`, or create a $-prefixed package instead if you wanted a local " +
  "one. Retrying this call unchanged cannot succeed: the refusal follows from the name and " +
  "the component, not from anything transient.";

// A4H 2026-09-04: neither refusal carried a T100 key (empty <properties/>), so
// prose is the only matcher.
const DELETE_REFUSED_STILL_REFERENCED_HINT =
  "The program/include named in the message was NOT deleted — another program still has an " +
  "INCLUDE statement for it. This is not a lock and not an authorisation refusal. Find every " +
  'referrer first with abap_search (mode: "where_used", query: "<name>"), then remove the ' +
  "INCLUDE line from each one, or delete the referencing program, and retry the delete. " +
  "Retrying unchanged fails again with the same message.";

function ctsObjectLockedHint(message: string, properties: Record<string, string>): string {
  const m = /is already locked in request (\w+) of user (\w+)/i.exec(message);
  const request = properties["T100KEY-V3"] ?? m?.[1] ?? "";
  const user = properties["T100KEY-V4"] ?? m?.[2] ?? "";
  const object = properties["T100KEY-V1"] ?? "";
  return (
    `Transport request ${request} (owner ${user}) already holds a lock on ${object}, so CTS ` +
    `will not record this change in a different request. Pass corr_nr=${request} — or a task ` +
    `of your own under it — so the write is recorded there, or have ${request} released first. ` +
    "For a function module the locked object is the group's L<GROUP>UXX include, held by the " +
    "request the group was created in: omit `package` and `corr_nr` so abapsmith derives the " +
    "module's package from its group and records the create in that request."
  );
}

const CONTAINER_PARENT_MISSING_HINT =
  "The message names the CONTAINER (the function group), not the include or function module " +
  'you asked to create, and "without a package" is misleading — the package was supplied; the ' +
  'group itself does not exist yet. Create the group first: FUGR/F create with source: ' +
  '"FUNCTION-POOL <name>." — then retry the include/function-module create. Retrying it ' +
  "unchanged fails again until the group exists.";

/**
 * `bo:*` element name (the last segment of an `XML_PATH`) -> what BOPF calls
 * it and which of that element's spec fields the server actually validates.
 * Keys are exactly what `bo:nodes(10)bo:actions(18)`'s final segment parses
 * out to (before the `(n)` index) — see `lastXmlPathSegment`.
 */
const XML_PATH_ELEMENTS: Readonly<
  Record<string, { readonly kind: string; readonly fieldsLabel: string; readonly fields: readonly string[] }>
> = {
  "bo:actions": {
    kind: "action",
    fieldsLabel: "enum-valued spec fields",
    fields: ["instanceMultiplicity", "exportingParameterCategoryType", "category"],
  },
  "bo:associations": {
    kind: "association",
    fieldsLabel: "enum-valued spec fields",
    fields: ["multiplicity", "implementationType", "targetNodeRef"],
  },
  "bo:determinations": {
    kind: "determination",
    fieldsLabel: "spec fields",
    fields: ["category", "triggers", "relations"],
  },
  "bo:validations": {
    kind: "validation",
    fieldsLabel: "spec fields",
    fields: ["category", "triggers"],
  },
  "bo:queries": {
    kind: "query",
    fieldsLabel: "enum-valued spec fields",
    fields: ["category"],
  },
  "bo:alternativeKeys": {
    kind: "alternative key",
    fieldsLabel: "enum-valued spec fields",
    fields: ["uniqueness"],
  },
  "bo:nodes": {
    kind: "node",
    fieldsLabel: "flags",
    fields: ["rootNode", "textNode", "isDependentObjectNode", "createEnabled", "updateEnabled", "deleteEnabled"],
  },
};

/**
 * An `XML_PATH` is a run of `<prefix:elementName>(<index>)` segments with no
 * separator, e.g. `bo:businessObject(1)bo:nodes(10)bo:actions(18)`. Returns
 * the last segment's name (without its `(n)` index), or `undefined` if the
 * path doesn't parse as that shape at all.
 */
function lastXmlPathSegment(xmlPath: string): string | undefined {
  const matches = [...xmlPath.matchAll(/([A-Za-z0-9_:]+)\(\d+\)/g)];
  return matches.length > 0 ? matches[matches.length - 1]![1] : undefined;
}

/**
 * Turns an `ExceptionInvalidData` response's `XML_PATH` (and, if present,
 * `XML_OFFSET`) into a hint naming the offending element and the fields on
 * it the server actually validates — so "the document was rejected" becomes
 * "check *this* field on *this* element" instead of a document-wide guess.
 * A path whose last element isn't one this module knows about (not a BOPF
 * `bo:*` element, or a `bo:*` element with no known enum fields) gets the
 * generic fallback.
 */
export function describeXmlPath(xmlPath: string, properties?: Record<string, string>): string {
  const offset = properties?.["XML_OFFSET"];
  const offsetText = offset ? ` (offset ${offset})` : "";
  const last = lastXmlPathSegment(xmlPath);
  const info = last !== undefined ? XML_PATH_ELEMENTS[last] : undefined;
  if (last !== undefined && info !== undefined) {
    return (
      `The server rejected the document at ${xmlPath}${offsetText}: the last path element is ${last}, a BOPF ` +
      `${info.kind} — the one this call added or changed. The value it refused is almost certainly in one of ` +
      `that element's ${info.fieldsLabel}: ${info.fields.join(", ")}. Fix the value and retry; retrying ` +
      `unchanged fails again.`
    );
  }
  return (
    `The server rejected the document at ${xmlPath}${offsetText}: an element or attribute value there is not ` +
    `one the object model accepts. Retrying unchanged fails again.`
  );
}

export const ADT_MESSAGE_RULES: readonly AdtMessageRule[] = [
  {
    id: "package-software-component-refused",
    t100Id: "TR",
    t100No: "462",
    match: /may not be assigned to software component/i,
    hint: PACKAGE_SOFTWARE_COMPONENT_REFUSED_HINT,
  },
  {
    id: "delete-refused-still-referenced",
    match: /is referenced in other programs/i,
    hint: DELETE_REFUSED_STILL_REFERENCED_HINT,
  },
  {
    id: "container-parent-missing",
    match: /cannot be created without a package/i,
    hint: CONTAINER_PARENT_MISSING_HINT,
  },
  {
    id: "invalid-data-xml-path",
    exceptionType: "ExceptionInvalidData",
    property: "XML_PATH",
    hint: (_message, properties) => describeXmlPath(properties["XML_PATH"] ?? "", properties),
  },
  {
    id: "cts-object-locked-in-other-request",
    t100Id: "CTS_WBO_API",
    t100No: "019",
    match: /is already locked in request (\w+) of user (\w+)/i,
    hint: ctsObjectLockedHint,
    code: "TRANSPORT_LOCKED",
    details: (message, properties) => {
      const m = /is already locked in request (\w+) of user (\w+)/i.exec(message);
      const holdingRequest = properties["T100KEY-V3"] ?? m?.[1];
      const holdingUser = properties["T100KEY-V4"] ?? m?.[2];
      const lockedObject = properties["T100KEY-V1"];
      return {
        ...(holdingRequest !== undefined ? { holdingRequest } : {}),
        ...(holdingUser !== undefined ? { holdingUser } : {}),
        ...(lockedObject !== undefined ? { lockedObject } : {}),
      };
    },
  },
];

// Fail closed at load time, not just at match time: a rule declaring none of
// a T100 key, a prose match, or an exception-type match can never fire,
// which would silently break the "first match wins" contract below into
// "this row is dead code".
for (const rule of ADT_MESSAGE_RULES) {
  if (rule.t100Id === undefined && rule.t100No === undefined && rule.match === undefined && rule.exceptionType === undefined) {
    throw new Error(
      `adt-message-rules: rule "${rule.id}" declares neither a T100 key, a prose match, nor an exception type`,
    );
  }
}

/**
 * First match wins; `undefined` when nothing matches — never a guess. A rule
 * matches when its `t100Id`+`t100No` are both set and both equal the
 * response's T100 key, OR its `match` regex tests true against `message`,
 * OR its `exceptionType` equals the given `exceptionType` AND (if `property`
 * is set) that property is present and non-empty on `properties`.
 */
export function classifyAdtMessage(
  message: string,
  properties: Record<string, string>,
  exceptionType?: string,
): AdtMessageRule | undefined {
  const id = properties["T100KEY-ID"];
  const no = properties["T100KEY-NO"];
  for (const rule of ADT_MESSAGE_RULES) {
    const t100Hit =
      rule.t100Id !== undefined &&
      rule.t100No !== undefined &&
      id === rule.t100Id &&
      no !== undefined &&
      sameT100No(no, rule.t100No);
    const proseHit = rule.match !== undefined && rule.match.test(message);
    const exceptionHit =
      rule.exceptionType !== undefined &&
      exceptionType === rule.exceptionType &&
      (rule.property === undefined || !!properties[rule.property]);
    if (t100Hit || proseHit || exceptionHit) return rule;
  }
  return undefined;
}

/**
 * Counting/grouping key for the UNCLASSIFIED tail's instrumentation — e.g.
 * `"TR/462"` when the response carried a T100 key, `"none"` when it didn't.
 * Independent of whether any rule above matched; this is what turns "how
 * often does the unrecognised branch fire, and on which messages" into
 * something countable across a run's recorded tool output.
 */
export function unclassifiedMessageKey(properties: Record<string, string>): string {
  const id = properties["T100KEY-ID"];
  const no = properties["T100KEY-NO"];
  return id && no ? `${id}/${no}` : "none";
}
