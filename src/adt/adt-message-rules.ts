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

export interface AdtMessageRule {
  /** Stable identifier, surfaced in details so a run can be counted by rule. */
  readonly id: string;
  readonly t100Id?: string;
  readonly t100No?: string;
  /** Prose fallback for servers that send no T100 key. */
  readonly match?: RegExp;
  /** Whether a retry could ever succeed is stated in this prose, not as a field:
   * `retryable: false` is reserved for `"UNSUPPORTED"` capability-registry
   * refusals (see `test/refusal-terminality.test.ts`). */
  readonly hint: string;
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

const CONTAINER_PARENT_MISSING_HINT =
  "The message names the CONTAINER (the function group), not the include or function module " +
  'you asked to create, and "without a package" is misleading — the package was supplied; the ' +
  'group itself does not exist yet. Create the group first: FUGR/F create with source: ' +
  '"FUNCTION-POOL <name>." — then retry the include/function-module create. Retrying it ' +
  "unchanged fails again until the group exists.";

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
];

// Fail closed at load time, not just at match time: a rule declaring neither
// match form can never fire, which would silently break the "first match
// wins" contract below into "this row is dead code".
for (const rule of ADT_MESSAGE_RULES) {
  if (rule.t100Id === undefined && rule.t100No === undefined && rule.match === undefined) {
    throw new Error(
      `adt-message-rules: rule "${rule.id}" declares neither a T100 key nor a prose match`,
    );
  }
}

/**
 * First match wins; `undefined` when nothing matches — never a guess. A rule
 * matches when its `t100Id`+`t100No` are both set and both equal the
 * response's T100 key, OR its `match` regex tests true against `message`.
 */
export function classifyAdtMessage(
  message: string,
  properties: Record<string, string>,
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
    if (t100Hit || proseHit) return rule;
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
