/**
 * FQL (feed query language) builder and STRICT client-side validator for the
 * ADT runtime-dumps feed (`/sap/bc/adt/runtime/dumps`).
 *
 * Pure functions only — nothing here opens a socket. Validation happens
 * client-side, before any request is sent, because the server cannot be
 * trusted to report problems usefully. See the git history for the full
 * verification behind these three facts:
 *   1. An unrecognised query parameter is silently ignored (HTTP 200, full
 *      unfiltered feed) rather than rejected. Parameter names are hardcoded
 *      from the ABAP source of truth; a caller-supplied name is never passed
 *      through.
 *   2. `$top=0` means NO LIMIT, not zero rows — refused rather than sent or
 *      re-defaulted (same reasoning as `previewDdicEntity`'s `maxRows: 0`,
 *      `datapreview.ts:248`).
 *   3. An invalid `$query` returns a 372-byte `ExceptionInvalidData` body
 *      that is byte-identical across unknown-attribute, bad-syntax,
 *      missing-wrapper and excess-depth mistakes (empty `<properties/>`,
 *      pinned by `test/fixtures/dumps/querycheck-invalid.xml`). There is
 *      nothing in it to translate, so every violation this module can name
 *      must be named before the request is built.
 *
 * Grammar (verified against a live A4H system): top-level `and(…)`/`or(…)`
 * wrapper mandatory; depth capped at 2, enforced server-side; whitespace
 * insignificant; values unquoted; `datetime` is 14-digit `YYYYMMDDHHMMSS`;
 * `user` permits only `equals`/`notEquals`, unlike other `string` attributes.
 *
 * `src/adt/dumps-xml.ts` owns the wire-derived shape ({@link FeedExtendedData});
 * this module keeps its own narrower {@link DumpsQueryContract} and bridges
 * the two with {@link toDumpsQueryContract} (`import type` only — the parser
 * is not pulled in at runtime).
 */
import type { FeedExtendedData } from "./dumps-xml.js";
import { AbapError } from "./errors.js";

// ------------------------------------------------------------- parameters ---

/** Base path of the runtime-dumps feed. */
export const DUMPS_FEED_PATH = "/sap/bc/adt/runtime/dumps";

/**
 * The complete set of query parameters this surface recognises — six, and not
 * one more. Source-read from the live ABAP interface `IF_ADT_FEED_PROVIDER`
 * (`/oo/interfaces/if_adt_feed_provider/source/main`), not assembled from
 * OData habits.
 *
 * `$inlinecount` is recognised but INERT — it changes nothing but the
 * `rel="self"`/`rel="next"` hrefs it's echoed into; there is no total-count
 * facility on this feed, so {@link DumpsFeedRequest} does not offer it and
 * {@link buildDumpsFeedUrl} never emits it. Full detail:
 * the git history.
 */
export const DUMPS_FEED_PARAMS = Object.freeze([
  "$query",
  "from",
  "to",
  "$top",
  "$queryCheck",
  "$inlinecount",
] as const);

export type DumpsFeedParam = (typeof DUMPS_FEED_PARAMS)[number];

/** `C_MAX_DUMPS` in `CL_RABAX_ADT_RES_DUMPS` — the server's own row ceiling. */
export const DUMPS_MAX_ROWS = 1000;

/**
 * `C_SNAP_ADT_RESIDENCE_DAYS` in `CL_RABAX_ADT_RES_DUMPS`: handler selects
 * `where … datum ge sy-datum - 8 + 1`, i.e. 8 calendar days inclusive of
 * today. A constant in SAP's code, not configuration.
 */
export const DUMPS_RESIDENCE_WINDOW_DAYS = 8;

/**
 * Wire names that look like parameters but are not — each probed and found to
 * return HTTP 200 with the complete unfiltered feed. Mapped to a message
 * explaining the silent-ignore trap rather than a bare "unknown parameter".
 */
const SILENTLY_IGNORED_PARAMS: Readonly<Record<string, string>> = Object.freeze({
  query:
    "The parameter is `$query`, with the dollar sign. Sending `query=` returns HTTP 200 and the " +
    "complete unfiltered feed — this near-miss is the single costliest mistake on this surface.",
  $skip: "There is no skip/offset parameter. Page with the `rel=\"next\"` cursor (`to=`) instead.",
  $filter: "OData syntax is not understood here. The filter parameter is `$query`, in FQL.",
  $orderby: "There is no ordering parameter; the feed is returned newest-first.",
  $select: "There is no projection parameter.",
  queryString: "`queryString` is the attribute name inside `feed:queryVariant`, not a parameter.",
  variant: "Server-side variants cannot be selected by name; expand them into a `$query` yourself.",
  user: "Filter by user with `$query=and ( equals ( user , NAME ) )`, not a `user=` parameter.",
  maxHits: "The row limit is `$top`.",
  size: "The row limit is `$top`.",
  pageSize: "The row limit is `$top`.",
  client: "The client is fixed by the logon; it cannot be selected per request.",
  $inlinecount:
    "Recognised by the server but INERT: it produces no count element anywhere, so this builder " +
    "never sends it. There is no total-count facility on this feed — count `atom:entry` elements " +
    "from the response instead, bounded by C_MAX_DUMPS = 1000 and the 8-day residence window.",
});

/** True when `name` is one of the six parameters the server actually reads. */
export function isRecognisedFeedParam(name: string): name is DumpsFeedParam {
  return (DUMPS_FEED_PARAMS as readonly string[]).includes(name);
}

/**
 * Gate for anything about to become a query-parameter name. Throws rather
 * than returning a boolean: an unrecognised name doesn't fail on the wire —
 * it succeeds and silently returns everything.
 */
export function assertRecognisedFeedParam(name: string): DumpsFeedParam {
  if (isRecognisedFeedParam(name)) return name;
  const known = SILENTLY_IGNORED_PARAMS[name];
  throw new AbapError(
    "BAD_INPUT",
    `'${name}' is not a query parameter of the ABAP runtime-dumps feed.`,
    { parameter: name, recognised: [...DUMPS_FEED_PARAMS] },
    (known ? `${known} ` : "") +
      "This server silently ignores unrecognised parameters and answers HTTP 200 with the full " +
      "unfiltered feed, so an unknown name is refused here rather than sent. The six recognised " +
      `parameters are ${DUMPS_FEED_PARAMS.join(", ")}.`,
  );
}

// -------------------------------------------------------------- operators ---

/**
 * The 10 FQL operators and their operand counts, from the served
 * `feed:operators` block (`numberOfOperands`, `kind="RELATIONAL"`).
 * `between`/`notBetween` taking 2 is the only arity variation.
 */
export const FQL_OPERATORS = Object.freeze({
  equals: 1,
  notEquals: 1,
  contains: 1,
  notContains: 1,
  greater: 1,
  greaterOrEquals: 1,
  less: 1,
  lessOrEquals: 1,
  between: 2,
  notBetween: 2,
} as const);

export type FqlOperator = keyof typeof FQL_OPERATORS;

/** The two legal top-level junctions. */
export const FQL_JUNCTIONS = Object.freeze(["and", "or"] as const);
export type FqlJunction = (typeof FQL_JUNCTIONS)[number];

// --------------------------------------------------------------- contract ---

/** One `feed:attribute` from the served filter contract. */
export interface DumpsQueryAttribute {
  /** Wire id, case-sensitive as the server spells it, e.g. `objectName`. */
  id: string;
  /** `string` or `dateTime` on this feed. Drives literal validation only. */
  dataType: string;
  /**
   * Operators permitted for this attribute. Honour this list, not `dataType`
   * — `user` is `string` yet permits only `equals`/`notEquals`.
   */
  operators: readonly string[];
}

/**
 * The slice of `feed:extendedData` this validator consumes, in the shape a
 * validator wants rather than the shape the wire sends.
 *
 * Kept distinct from `FeedExtendedData`, which carries everything in the
 * document (labels, refresh interval, paging, query variants) and none of
 * what validation reads. Build one from a parsed catalog with
 * {@link toDumpsQueryContract}.
 */
export interface DumpsQueryContract {
  attributes: readonly DumpsQueryAttribute[];
  /** `feed:queryDepth` — **2** on this feed, and enforced server-side. */
  queryDepth: number;
  /**
   * True when {@link queryDepth} is not server-supplied but
   * {@link DUMPS_ASSUMED_QUERY_DEPTH} standing in for an omitted
   * `feed:queryDepth`. Lets a caller tell "server said so" apart from "this
   * client guessed" when deciding whether to trust an `EXCESS_DEPTH` refusal
   * or `$queryCheck` it instead.
   */
  queryDepthAssumed?: boolean;
  /** Operator id → operand count. Defaults to {@link FQL_OPERATORS}. */
  operators?: Readonly<Record<string, number>>;
}

const STRING_OPS: readonly string[] = ["equals", "notEquals", "contains", "notContains"];
const DATETIME_OPS: readonly string[] = [
  "equals",
  "notEquals",
  "greater",
  "greaterOrEquals",
  "less",
  "lessOrEquals",
  "between",
  "notBetween",
];

/**
 * The contract as captured from A4H on 2026-08-11
 * (`test/fixtures/dumps/feeds-catalog.xml`): 11 attributes, `queryDepth` 2.
 *
 * A fallback for callers that have not fetched `/sap/bc/adt/feeds` yet —
 * prefer the served contract whenever you have it.
 *
 * `package`/`packageHierarchy` are accepted by the server but returned 0 rows
 * for every value tried on the only system tested — allowed, never advertised
 * as working.
 */
export const DUMPS_CONTRACT_AS_CAPTURED: DumpsQueryContract = Object.freeze({
  queryDepth: 2, // served, not assumed — no `queryDepthAssumed`.
  operators: FQL_OPERATORS,
  attributes: Object.freeze([
    { id: "package", dataType: "string", operators: STRING_OPS },
    { id: "packageHierarchy", dataType: "string", operators: STRING_OPS },
    { id: "packageResponsible", dataType: "string", operators: STRING_OPS },
    { id: "objectResponsible", dataType: "string", operators: STRING_OPS },
    { id: "responsible", dataType: "string", operators: STRING_OPS },
    { id: "objectName", dataType: "string", operators: STRING_OPS },
    { id: "component", dataType: "string", operators: STRING_OPS },
    // The asymmetry: `string` dataType, but only two operators.
    { id: "user", dataType: "string", operators: Object.freeze(["equals", "notEquals"]) },
    { id: "runtimeError", dataType: "string", operators: STRING_OPS },
    { id: "exception", dataType: "string", operators: STRING_OPS },
    { id: "datetime", dataType: "dateTime", operators: DATETIME_OPS },
  ]) as readonly DumpsQueryAttribute[],
});

/**
 * The depth cap used when a catalog entry serves no `feed:queryDepth`. 2 is
 * the smallest number at which any legal query exists (the mandatory
 * `and(…)`/`or(…)` wrapper around one predicate is itself depth 2), not a
 * generous guess. The captured catalog serves `queryDepth` 1/2/4 across
 * different feeds, so this really is a per-feed unknown — hence
 * {@link toDumpsQueryContract} flags the substitution via
 * {@link DumpsQueryContract.queryDepthAssumed} instead of defaulting silently.
 */
export const DUMPS_ASSUMED_QUERY_DEPTH = 2;

/**
 * Adapt a parsed `feed:extendedData` into the contract this validator
 * consumes — the seam between `dumps-xml.ts` (wire vocabulary) and this
 * module (validator vocabulary). Renames `dataTypeId`→`dataType` and
 * `operatorIds`→`operators`, restructures the operator table into an id →
 * arity map, and turns optional `queryDepth` into required (see
 * {@link DUMPS_ASSUMED_QUERY_DEPTH}).
 *
 * `feed:dataTypes` is dropped on purpose — it describes what each type
 * permits in general, which the per-attribute list narrows (the `user`
 * asymmetry); using it would reintroduce the mistake the attribute list
 * exists to prevent.
 */
export function toDumpsQueryContract(extendedData: FeedExtendedData): DumpsQueryContract {
  const attributes: readonly DumpsQueryAttribute[] = Object.freeze(
    extendedData.attributes.map((a) =>
      Object.freeze({
        id: a.id,
        dataType: a.dataTypeId,
        operators: Object.freeze([...a.operatorIds]) as readonly string[],
      }),
    ),
  );

  const operators: Record<string, number> = {};
  for (const op of extendedData.operators) operators[op.id] = op.numberOfOperands;
  const hasOperators = Object.keys(operators).length > 0;

  // queryDepth is optional on the wire (2 of 5 captured catalog entries carry
  // no filter contract) but required here; the substitution is recorded
  // rather than defaulted silently — see DumpsQueryContract.queryDepthAssumed.
  const served = extendedData.queryDepth;
  const queryDepthIsServed = Number.isInteger(served) && (served as number) > 0;

  return Object.freeze({
    attributes,
    queryDepth: queryDepthIsServed ? (served as number) : DUMPS_ASSUMED_QUERY_DEPTH,
    ...(queryDepthIsServed ? {} : { queryDepthAssumed: true }),
    ...(hasOperators ? { operators: Object.freeze(operators) } : {}),
  });
}

// -------------------------------------------------------------- timestamps ---

const TS14_RE = /^\d{14}$/;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;

const pad = (n: number, width: number): string => String(n).padStart(width, "0");

/**
 * True when `text` is 14 digits that name a real UTC instant — digit count
 * alone is not enough (`20261332000000` is 14 digits, not a date), and an
 * unparseable `from=` is silently ignored by the server rather than rejected.
 */
export function isValidTimestamp14(text: string): boolean {
  if (!TS14_RE.test(text)) return false;
  const y = Number(text.slice(0, 4));
  const mo = Number(text.slice(4, 6));
  const d = Number(text.slice(6, 8));
  const h = Number(text.slice(8, 10));
  const mi = Number(text.slice(10, 12));
  const s = Number(text.slice(12, 14));
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return false;
  // Round-trip through Date to reject 20260231000000 and friends.
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === mo - 1 &&
    dt.getUTCDate() === d &&
    dt.getUTCHours() === h &&
    dt.getUTCMinutes() === mi &&
    dt.getUTCSeconds() === s
  );
}

/** `Date` → the 14-digit canonical form, in UTC. */
export function timestamp14(date: Date): string {
  return (
    pad(date.getUTCFullYear(), 4) +
    pad(date.getUTCMonth() + 1, 2) +
    pad(date.getUTCDate(), 2) +
    pad(date.getUTCHours(), 2) +
    pad(date.getUTCMinutes(), 2) +
    pad(date.getUTCSeconds(), 2)
  );
}

/**
 * Normalise a caller timestamp to the 14-digit canonical form.
 *
 * Both `YYYYMMDDHHMMSS` and ISO-8601 `YYYY-MM-DDTHH:MM:SSZ` are accepted by
 * the server (proven byte-identical responses); we emit 14-digit because
 * that's what the server's own `rel="self"`/`rel="next"` cursors use.
 *
 * Only `Z` (UTC) ISO strings are accepted — a numeric offset is refused
 * rather than converted, since the mapping to the feed's `timestamp` column
 * is unverified and a silent hour-shift is worse than a refusal.
 *
 * @returns `undefined` when the input cannot be trusted; the caller turns
 * that into a `BAD_INPUT` naming the offending parameter.
 */
export function normaliseTimestamp(value: string | Date): string | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : timestamp14(value);
  }
  const text = String(value).trim();
  if (TS14_RE.test(text)) return isValidTimestamp14(text) ? text : undefined;
  const m = ISO_RE.exec(text);
  if (!m) return undefined;
  const candidate = `${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}${m[6]}`;
  return isValidTimestamp14(candidate) ? candidate : undefined;
}

/**
 * The oldest instant the feed can reach: `sy-datum -
 * C_SNAP_ADT_RESIDENCE_DAYS + 1` at 00:00:00, i.e. today minus 7 days. No
 * parameter widens this — `from=` is ANDed with it, so an older bound just
 * returns the last 8 days with no warning about what it excluded.
 *
 * Computed from the client clock in UTC, so it's an estimate of a server-side
 * `sy-datum` we cannot read — exposed as a note, not as a filter.
 */
export function residenceWindowStart(now: Date = new Date()): string {
  const start = new Date(now.getTime());
  start.setUTCDate(start.getUTCDate() - (DUMPS_RESIDENCE_WINDOW_DAYS - 1));
  start.setUTCHours(0, 0, 0, 0);
  return timestamp14(start);
}

// ------------------------------------------------------------------- AST ----

/** A single comparison, e.g. `equals ( user , DEVELOPER )`. */
export interface FqlPredicate {
  attribute: string;
  operator: string;
  /** Unquoted values. One for most operators, **two** for between/notBetween. */
  operands: string[];
}

/**
 * A whole query: the mandatory junction wrapper plus its predicates. Nesting
 * is deliberately unrepresentable, since the server enforces `queryDepth` 2
 * (`and ( and ( and ( equals(…) ) ) )` → 400). {@link validateFqlQuery} still
 * checks depth because a query can also arrive as a string — a hand-written
 * filter or a server-supplied `queryVariant` — which can nest arbitrarily.
 */
export interface FqlQuery {
  junction: FqlJunction;
  predicates: FqlPredicate[];
}

/** Parsed form, which — unlike {@link FqlQuery} — can be illegally shaped. */
export type FqlNode = FqlPredicateNode | FqlJunctionNode;

export interface FqlPredicateNode extends FqlPredicate {
  kind: "predicate";
}

export interface FqlJunctionNode {
  kind: "junction";
  junction: FqlJunction;
  children: FqlNode[];
}

// ---------------------------------------------------------------- parsing ---

type Token =
  | { kind: "("; pos: number }
  | { kind: ")"; pos: number }
  | { kind: ","; pos: number }
  | { kind: "word"; text: string; pos: number };

const STRUCTURAL = new Set(["(", ")", ","]);

/**
 * Whitespace is insignificant in this grammar (5 spacings proven equivalent
 * against a live server), so the tokeniser drops it; the printer re-emits
 * canonical spacing.
 */
function tokenise(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (STRUCTURAL.has(ch)) {
      tokens.push({ kind: ch as "(" | ")" | ",", pos: i });
      i += 1;
      continue;
    }
    const start = i;
    while (i < text.length && !/\s/.test(text[i] as string) && !STRUCTURAL.has(text[i] as string)) {
      i += 1;
    }
    tokens.push({ kind: "word", text: text.slice(start, i), pos: start });
  }
  return tokens;
}

export interface FqlParseResult {
  node?: FqlNode;
  /** Human-readable syntax failure, with a character offset when known. */
  error?: string;
}

/**
 * Parse an FQL string into an AST **without judging it**. A bare predicate and
 * a three-deep nest both parse successfully; naming them as violations is
 * {@link validateFqlQuery}'s job, so that one call can report every problem at
 * once instead of stopping at the first.
 */
export function parseFqlQuery(text: string): FqlParseResult {
  const tokens = tokenise(text);
  if (tokens.length === 0) return { error: "the query is empty" };

  let i = 0;
  const peek = (): Token | undefined => tokens[i];
  let failure: string | undefined;

  const fail = (message: string, token?: Token): undefined => {
    failure ??= token ? `${message} at offset ${token.pos}` : message;
    return undefined;
  };

  const parseNode = (depth: number): FqlNode | undefined => {
    if (depth > 64) return fail("the query nests too deeply to parse");
    const head = peek();
    if (!head) return fail("unexpected end of query; expected an operator or `and`/`or`");
    if (head.kind !== "word") return fail(`unexpected '${head.kind}'`, head);
    i += 1;
    const open = peek();
    if (!open || open.kind !== "(") {
      return fail(`expected '(' after '${head.text}'`, open ?? head);
    }
    i += 1;

    const lower = head.text.toLowerCase();
    const isJunction = (FQL_JUNCTIONS as readonly string[]).includes(lower);

    if (isJunction) {
      const children: FqlNode[] = [];
      if (peek()?.kind === ")") {
        i += 1;
        return { kind: "junction", junction: lower as FqlJunction, children };
      }
      for (;;) {
        const child = parseNode(depth + 1);
        if (!child) return undefined;
        children.push(child);
        const next = peek();
        if (!next) return fail(`unclosed '${head.text} (' — expected ')'`);
        if (next.kind === ",") {
          i += 1;
          continue;
        }
        if (next.kind === ")") {
          i += 1;
          return { kind: "junction", junction: lower as FqlJunction, children };
        }
        return fail(`expected ',' or ')'`, next);
      }
    }

    // A predicate: operator ( attribute , operand [ , operand … ] )
    const attrToken = peek();
    if (!attrToken || attrToken.kind !== "word") {
      return fail(`expected an attribute name after '${head.text} ('`, attrToken);
    }
    i += 1;
    const operands: string[] = [];
    for (;;) {
      const next = peek();
      if (!next) return fail(`unclosed '${head.text} (' — expected ')'`);
      if (next.kind === ")") {
        i += 1;
        break;
      }
      if (next.kind !== ",") return fail(`expected ',' or ')'`, next);
      i += 1;
      // Collect the value. Multiple words here means the value contained
      // whitespace, which this grammar cannot express — there is no quoting.
      const parts: string[] = [];
      for (;;) {
        const v = peek();
        if (!v || v.kind !== "word") break;
        parts.push(v.text);
        i += 1;
      }
      operands.push(parts.join(" "));
    }
    return {
      kind: "predicate",
      operator: head.text,
      attribute: attrToken.text,
      operands,
    };
  };

  const node = parseNode(0);
  if (!node) return { error: failure ?? "the query could not be parsed" };
  const trailing = peek();
  if (trailing) {
    return {
      error:
        `unexpected trailing input at offset ${trailing.pos}` +
        ` — a query is a single top-level and(…)/or(…)`,
    };
  }
  return { node };
}

// ------------------------------------------------------------- validation ---

export type FqlViolationCode =
  /** The string could not be parsed at all. */
  | "SYNTAX"
  /** No top-level `and(…)`/`or(…)`. The commonest hand-written mistake. */
  | "MISSING_WRAPPER"
  /** Nesting exceeds `feed:queryDepth`. */
  | "EXCESS_DEPTH"
  /** The wrapper holds no predicates. */
  | "EMPTY_QUERY"
  /** Attribute not in the served contract. */
  | "UNKNOWN_ATTRIBUTE"
  /** Operator not in the FQL operator set at all. */
  | "UNKNOWN_OPERATOR"
  /** Operator exists, but not for THAT attribute (the `user` asymmetry). */
  | "OPERATOR_NOT_PERMITTED"
  /** Wrong number of operands — `between`/`notBetween` need 2. */
  | "OPERAND_COUNT"
  /** A `dateTime` operand that is not a valid 14-digit `YYYYMMDDHHMMSS`. */
  | "MALFORMED_DATETIME"
  /** A value this unquoted grammar cannot carry (empty, quoted, whitespace). */
  | "INVALID_VALUE";

export interface FqlViolation {
  code: FqlViolationCode;
  /** Actionable, and it names the offending attribute/operator by name. */
  message: string;
  attribute?: string;
  operator?: string;
}

export interface FqlValidationResult {
  ok: boolean;
  violations: FqlViolation[];
  /** The canonical `$query` string — present only when `ok`. */
  canonical?: string;
}

const quoted = (v: string): boolean =>
  v.length >= 2 &&
  ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"')));

function nodeDepth(node: FqlNode): number {
  if (node.kind === "predicate") return 1;
  if (node.children.length === 0) return 1;
  return 1 + Math.max(...node.children.map(nodeDepth));
}

function collectPredicates(node: FqlNode, out: FqlPredicateNode[]): void {
  if (node.kind === "predicate") {
    out.push(node);
    return;
  }
  for (const child of node.children) collectPredicates(child, out);
}

/** Case-insensitive lookup that returns the contract's own spelling. */
function findAttribute(
  contract: DumpsQueryContract,
  name: string,
): DumpsQueryAttribute | undefined {
  const lower = name.toLowerCase();
  return contract.attributes.find((a) => a.id.toLowerCase() === lower);
}

function findOperator(name: string): FqlOperator | undefined {
  const lower = name.toLowerCase();
  return (Object.keys(FQL_OPERATORS) as FqlOperator[]).find((o) => o.toLowerCase() === lower);
}

function validateOperands(
  attribute: DumpsQueryAttribute,
  operator: string,
  operands: readonly string[],
  violations: FqlViolation[],
): void {
  const isDateTime = attribute.dataType.toLowerCase() === "datetime";
  for (const raw of operands) {
    const value = raw.trim();
    if (value === "") {
      violations.push({
        code: "INVALID_VALUE",
        attribute: attribute.id,
        operator,
        message:
          `Empty value in ${operator}(${attribute.id}, …). FQL values are unquoted and there is ` +
          "no empty literal — omit the predicate instead.",
      });
      continue;
    }
    if (quoted(value)) {
      violations.push({
        code: "INVALID_VALUE",
        attribute: attribute.id,
        operator,
        message:
          `Value ${value} for '${attribute.id}' is quoted. FQL values are UNQUOTED — write ` +
          `${operator} ( ${attribute.id} , ${value.slice(1, -1)} ).`,
      });
      continue;
    }
    if (/[(),]/.test(value)) {
      violations.push({
        code: "INVALID_VALUE",
        attribute: attribute.id,
        operator,
        message:
          `Value '${value}' for '${attribute.id}' contains '(' , ')' or ',', which are structural ` +
          "in FQL. The grammar has no quoting or escaping, so such a value cannot be expressed.",
      });
      continue;
    }
    if (/\s/.test(value)) {
      violations.push({
        code: "INVALID_VALUE",
        attribute: attribute.id,
        operator,
        message:
          `Value '${value}' for '${attribute.id}' contains whitespace. Whitespace is insignificant ` +
          "in FQL and there is no quoting, so a value containing a space cannot be sent " +
          "unambiguously.",
      });
      continue;
    }
    if (isDateTime && !isValidTimestamp14(value)) {
      violations.push({
        code: "MALFORMED_DATETIME",
        attribute: attribute.id,
        operator,
        message:
          `'${value}' is not a valid datetime literal for '${attribute.id}'. Inside $query, ` +
          "dateTime values are 14 digits, YYYYMMDDHHMMSS, unquoted — e.g. 20260804000000. " +
          "ISO-8601 is accepted by from/to, but NOT inside $query.",
      });
    }
  }
}

/**
 * Validate a query — as a string or as a built {@link FqlQuery} — against the
 * served contract, reporting **every** violation with a message that names
 * the offending attribute and operator. This is the module's reason to
 * exist: the server's own rejection is an opaque, byte-identical 400 for any
 * cause (see module header), so whatever this function doesn't say, nobody
 * will.
 *
 * Never throws — see {@link assertValidFqlQuery} / {@link buildFqlQuery} for
 * the throwing forms.
 */
export function validateFqlQuery(
  query: string | FqlQuery,
  contract: DumpsQueryContract = DUMPS_CONTRACT_AS_CAPTURED,
): FqlValidationResult {
  const violations: FqlViolation[] = [];
  let root: FqlNode | undefined;

  if (typeof query === "string") {
    const parsed = parseFqlQuery(query);
    if (!parsed.node) {
      return {
        ok: false,
        violations: [
          {
            code: "SYNTAX",
            message:
              `The query could not be parsed: ${parsed.error}. Expected the canonical form ` +
              "`and ( equals ( user , DEVELOPER ) )` — junction wrapper, then one or more " +
              "`operator ( attribute , value )` predicates.",
          },
        ],
      };
    }
    root = parsed.node;
  } else {
    root = {
      kind: "junction",
      junction: query.junction,
      children: query.predicates.map((p) => ({ kind: "predicate" as const, ...p })),
    };
    if (!(FQL_JUNCTIONS as readonly string[]).includes(query.junction)) {
      violations.push({
        code: "MISSING_WRAPPER",
        message:
          `'${String(query.junction)}' is not a junction. The top-level wrapper must be ` +
          "`and` or `or`.",
      });
    }
  }

  if (root.kind !== "junction") {
    violations.push({
      code: "MISSING_WRAPPER",
      ...(root.attribute ? { attribute: root.attribute } : {}),
      operator: root.operator,
      message:
        `The query is a bare '${root.operator}' predicate. A top-level and(…)/or(…) wrapper is ` +
        "MANDATORY on this feed, even for a single predicate — wrap it as " +
        `and ( ${root.operator} ( ${root.attribute} , … ) ). Without the wrapper the server ` +
        "answers 400 with a body that says nothing about why.",
    });
  } else if (root.children.length === 0) {
    violations.push({
      code: "EMPTY_QUERY",
      message:
        `'${root.junction} ( )' has no predicates. Omit $query entirely to read the unfiltered ` +
        "feed — but note the 8-day residence window still applies.",
    });
  }

  const maxDepth = Number.isInteger(contract.queryDepth)
    ? contract.queryDepth
    : DUMPS_ASSUMED_QUERY_DEPTH;
  const depth = nodeDepth(root);
  if (depth > maxDepth) {
    violations.push({
      code: "EXCESS_DEPTH",
      message:
        `The query nests ${depth} levels deep; ` +
        (contract.queryDepthAssumed === true
          ? `this feed served no queryDepth, so ${maxDepth} was ASSUMED — the smallest depth at ` +
            "which a legal query exists. The limit above is this client's, not the server's."
          : `this feed advertises queryDepth ${maxDepth} and ENFORCES it (a third level is ` +
            "HTTP 400).") +
        " One junction wrapper plus its predicates is depth 2 — flatten the nested junctions " +
        "into a single and(…)/or(…).",
    });
  }

  const predicates: FqlPredicateNode[] = [];
  collectPredicates(root, predicates);

  const operatorArity = contract.operators ?? (FQL_OPERATORS as Readonly<Record<string, number>>);

  for (const p of predicates) {
    const attribute = findAttribute(contract, p.attribute);
    if (!attribute) {
      violations.push({
        code: "UNKNOWN_ATTRIBUTE",
        attribute: p.attribute,
        operator: p.operator,
        message:
          `'${p.attribute}' is not a filterable attribute of this feed. The ${contract.attributes.length} ` +
          `it serves are: ${contract.attributes.map((a) => a.id).join(", ")}.`,
      });
      continue;
    }

    const operator = findOperator(p.operator);
    if (!operator) {
      violations.push({
        code: "UNKNOWN_OPERATOR",
        attribute: attribute.id,
        operator: p.operator,
        message:
          `'${p.operator}' is not an FQL operator. The 10 operators are: ` +
          `${Object.keys(FQL_OPERATORS).join(", ")}.`,
      });
      continue;
    }

    const permitted = attribute.operators.some((o) => o.toLowerCase() === operator.toLowerCase());
    if (!permitted) {
      const asymmetry =
        attribute.id === "user"
          ? " 'user' is a string attribute that nonetheless permits only equals/notEquals — this " +
            "asymmetry is served in the contract and is not derivable from the dataType."
          : "";
      violations.push({
        code: "OPERATOR_NOT_PERMITTED",
        attribute: attribute.id,
        operator,
        message:
          `Operator '${operator}' is not permitted for attribute '${attribute.id}'. ` +
          `The feed permits ${attribute.operators.join(", ")} for it.${asymmetry}`,
      });
      continue;
    }

    const expected = operatorArity[operator] ?? FQL_OPERATORS[operator];
    if (p.operands.length !== expected) {
      violations.push({
        code: "OPERAND_COUNT",
        attribute: attribute.id,
        operator,
        message:
          `Operator '${operator}' takes ${expected} operand${expected === 1 ? "" : "s"}, but ` +
          `${p.operands.length} ${p.operands.length === 1 ? "was" : "were"} given for ` +
          `'${attribute.id}'. Write ` +
          (expected === 2
            ? `${operator} ( ${attribute.id} , <low> , <high> ).`
            : `${operator} ( ${attribute.id} , <value> ).`),
      });
      continue;
    }

    validateOperands(attribute, operator, p.operands, violations);
  }

  if (violations.length > 0) return { ok: false, violations };

  // Re-emit from the contract's own spellings, never from the caller's text:
  // a query that leaves this function is one we assembled.
  const junction = (root as FqlJunctionNode).junction;
  const canonicalQuery: FqlQuery = {
    junction,
    predicates: predicates.map((p) => ({
      attribute: (findAttribute(contract, p.attribute) as DumpsQueryAttribute).id,
      operator: findOperator(p.operator) as FqlOperator,
      operands: p.operands.map((o) => o.trim()),
    })),
  };
  return { ok: true, violations: [], canonical: formatFqlQuery(canonicalQuery) };
}

/**
 * Canonical printer — `and ( equals ( user , DEVELOPER ) )`, matching the
 * spacing the server itself uses in `feed:queryVariant` strings. Buys
 * nothing on the wire (whitespace is insignificant there) but makes logs and
 * diffs comparable by eye.
 *
 * Not exported: an unvalidated printer is a way to build a query that only
 * the opaque 400 will judge. Go through {@link buildFqlQuery}.
 */
function formatFqlQuery(query: FqlQuery): string {
  const predicates = query.predicates.map(
    (p) => `${p.operator} ( ${[p.attribute, ...p.operands.map((o) => o.trim())].join(" , ")} )`,
  );
  return `${query.junction} ( ${predicates.join(" , ")} )`;
}

/**
 * Throwing form of {@link validateFqlQuery}. Every violation is reported at
 * once in `details.violations`, because a caller that fixes one problem per
 * round trip against a server that describes none is a caller that gives up.
 */
export function assertValidFqlQuery(
  query: string | FqlQuery,
  contract: DumpsQueryContract = DUMPS_CONTRACT_AS_CAPTURED,
): string {
  const result = validateFqlQuery(query, contract);
  if (result.ok && result.canonical !== undefined) return result.canonical;
  const messages = result.violations.map((v) => v.message);
  throw new AbapError(
    "BAD_INPUT",
    `The dump filter is not a valid query for this feed: ${messages.join(" ")}`,
    {
      violations: result.violations,
      query: typeof query === "string" ? query : { ...query },
    },
    "This was refused before sending. The server rejects an invalid $query with a 372-byte " +
      "ExceptionInvalidData body that is byte-identical for an unknown attribute, a syntax error, " +
      "a missing wrapper and excess depth — so the reason above is the only one available.",
  );
}

/**
 * Build the canonical `$query` string from a structured query, validating it
 * first. Throws `BAD_INPUT` on any violation.
 */
export function buildFqlQuery(
  query: FqlQuery,
  contract: DumpsQueryContract = DUMPS_CONTRACT_AS_CAPTURED,
): string {
  return assertValidFqlQuery(query, contract);
}

// ------------------------------------------------------------------- URLs ---

/**
 * A request to the dumps feed, keyed by the **wire parameter names**
 * (`$query`, not `query`; `$top`, not `maxRows`) so near-misses are rejected
 * by the same guard that protects the wire. `$inlinecount` is absent on
 * purpose: recognised but inert (see {@link DUMPS_FEED_PARAMS}).
 */
export interface DumpsFeedRequest {
  /** FQL filter. A string is validated and re-emitted canonically. */
  $query?: string | FqlQuery;
  /** Inclusive lower bound (`timestamp ge`). 14-digit, ISO-8601 Z, or Date. */
  from?: string | Date;
  /** Inclusive upper bound (`timestamp le`). 14-digit, ISO-8601 Z, or Date. */
  to?: string | Date;
  /** Page size. A positive integer — `0` means UNLIMITED and is refused. */
  $top?: number;
  /** Pre-flight only: validate the query server-side, read no rows. */
  $queryCheck?: boolean;
}

export interface DumpsFeedUrl {
  /** Path plus percent-encoded query string, ready to GET. */
  url: string;
  /** The pairs actually sent, in canonical order, **before** encoding. */
  params: ReadonlyArray<readonly [DumpsFeedParam, string]>;
  /**
   * Facts the caller must be told but which are not errors — chiefly that a
   * `from` older than the residence window will be silently narrowed. The tool
   * layer is expected to surface these verbatim.
   */
  notes: string[];
  /** The oldest instant this feed can reach, for the caller to quote. */
  residenceWindowStart: string;
}

const REQUEST_KEYS: readonly string[] = ["$query", "from", "to", "$top", "$queryCheck"];

function encodePair(name: string, value: string): string {
  // '$'→%24, ' '→%20, ','→%2C — matches the server's own href encoding.
  return `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
}

function normaliseBound(
  which: "from" | "to",
  value: string | Date,
  notes: string[],
): string {
  const normalised = normaliseTimestamp(value);
  if (normalised === undefined) {
    throw new AbapError(
      "BAD_INPUT",
      `'${which}' is not a valid timestamp: ${String(value instanceof Date ? value.toString() : value)}.`,
      { [which]: value instanceof Date ? value.toISOString() : String(value) },
      "Pass 14 digits (YYYYMMDDHHMMSS), an ISO-8601 UTC instant (YYYY-MM-DDTHH:MM:SSZ), or a " +
        "Date. An unparseable bound is not an error on this server — it is SILENTLY IGNORED and " +
        "answered with the full unfiltered feed, so it is refused here instead of sent.",
    );
  }
  if (value instanceof Date === false && String(value).trim() !== normalised) {
    notes.push(`'${which}' was normalised to the canonical 14-digit form ${normalised}.`);
  }
  return normalised;
}

/**
 * Assemble a dumps-feed URL from a typed request. Refuses, before building
 * anything: an unusable key (only `$inlinecount` is recognised-but-unoffered);
 * `$top` that isn't a positive integer (`0` means unlimited here, so it's
 * refused rather than forwarded or re-defaulted); a `from`/`to` that won't
 * parse (an unparseable bound is answered with the entire feed, not an
 * error); or a `$query` with any grammar or contract violation.
 */
export function buildDumpsFeedUrl(
  request: DumpsFeedRequest,
  options: { contract?: DumpsQueryContract; basePath?: string; now?: Date } = {},
): DumpsFeedUrl {
  const contract = options.contract ?? DUMPS_CONTRACT_AS_CAPTURED;
  const basePath = options.basePath ?? DUMPS_FEED_PATH;
  const now = options.now ?? new Date();
  const notes: string[] = [];

  for (const key of Object.keys(request)) {
    if (REQUEST_KEYS.includes(key)) continue;
    // Same guard as the wire path — object key or string, same hazard.
    assertRecognisedFeedParam(key);
    // Recognised but not offered — only `$inlinecount` reaches here.
    throw new AbapError(
      "BAD_INPUT",
      `'${key}' is recognised by the server but is not offered by this client.`,
      { parameter: key },
      SILENTLY_IGNORED_PARAMS[key] ?? "",
    );
  }

  const params: Array<readonly [DumpsFeedParam, string]> = [];

  if (request.$query !== undefined) {
    params.push(["$query", assertValidFqlQuery(request.$query, contract)]);
  }

  let fromTs: string | undefined;
  let toTs: string | undefined;
  if (request.from !== undefined) {
    fromTs = normaliseBound("from", request.from, notes);
    params.push(["from", fromTs]);
  }
  if (request.to !== undefined) {
    toTs = normaliseBound("to", request.to, notes);
    params.push(["to", toTs]);
  }

  if (request.$top !== undefined) {
    const top = request.$top;
    if (!Number.isInteger(top) || top < 1) {
      throw new AbapError(
        "BAD_INPUT",
        `$top must be a positive integer, got ${String(top)}.`,
        { $top: top },
        "0 is not 'no rows' on this endpoint — it means UNLIMITED and is silently accepted, so " +
          "it is refused rather than sent. A non-integer such as 'abc' is the one parameter " +
          "mistake this server actually reports (HTTP 400); every other bad parameter returns " +
          "200 with the complete feed.",
      );
    }
    if (top > DUMPS_MAX_ROWS) {
      notes.push(
        `$top=${top} exceeds the server's own ceiling C_MAX_DUMPS = ${DUMPS_MAX_ROWS}; at most ` +
          `${DUMPS_MAX_ROWS} dumps can be returned however large $top is.`,
      );
    }
    params.push(["$top", String(top)]);
  }

  if (request.$queryCheck === true) params.push(["$queryCheck", "true"]);

  const windowStart = residenceWindowStart(now);
  if (fromTs !== undefined && fromTs < windowStart) {
    notes.push(
      `from=${fromTs} predates the dump residence window. The handler ANDs your bound with ` +
        `'datum ge sy-datum - ${DUMPS_RESIDENCE_WINDOW_DAYS} + 1', so it does NOT widen the ` +
        `window: only dumps from about ${windowStart} onwards are visible over ADT, and the ` +
        "server gives no warning that the rest exist. Older dumps must be read from SNAP by " +
        "other means.",
    );
  }
  if (toTs !== undefined && toTs < windowStart) {
    notes.push(
      `to=${toTs} predates the dump residence window (about ${windowStart}); this range lies ` +
        "entirely outside what ADT can see and will return an empty feed.",
    );
  }
  if (fromTs !== undefined && toTs !== undefined && fromTs > toTs) {
    notes.push(
      `from=${fromTs} is later than to=${toTs}. The bounds are an inclusive range ` +
        "(timestamp ge from AND timestamp le to), so this can only return an empty feed.",
    );
  }

  const qs = params.map(([name, value]) => encodePair(name, value)).join("&");
  return {
    url: qs ? `${basePath}?${qs}` : basePath,
    params,
    notes,
    residenceWindowStart: windowStart,
  };
}

/**
 * The `$queryCheck=true` pre-flight variant of a filter — validates
 * server-side and reads no rows (91 bytes, 64-91ms for a self-closing
 * `<atom:feed/>` on success; same 372-byte 400 on failure). Worth doing for
 * anything user-supplied, on top of — never instead of — {@link
 * validateFqlQuery}, since a 400 here still cannot say why.
 *
 * Only `$query`/`$queryCheck` are sent: no rows are read, so `$top`/`from`/
 * `to` would change nothing about the answer.
 */
export function buildQueryCheckUrl(
  query: string | FqlQuery,
  options: { contract?: DumpsQueryContract; basePath?: string; now?: Date } = {},
): DumpsFeedUrl {
  return buildDumpsFeedUrl({ $query: query, $queryCheck: true }, options);
}
