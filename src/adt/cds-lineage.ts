/**
 * CDS view lineage: parse DDL source and walk data sources/associations to
 * build a "what feeds this view" tree, plus per-field tracing.
 *
 * Why source-parsing instead of ADT's own dependency graph: ADT exposes
 * `GET /sap/bc/adt/ddic/ddl/dependencies/graphdata?ddlsourceName=<NAME>`.
 * It looked like the obvious tool for this, so it was tried first against
 * A4H before writing a single line of parser. Captures 981 and 982
 * (test/fixtures/live-captured/) record the result: the endpoint 400s for
 * every customer CDS view tried, and even where a graph payload can be
 * coaxed out of it for a released SAP view, the payload is table/view
 * *node* dependencies only — no association edges, no field-level lineage,
 * nothing that maps an exposed field back to the column it came from. That
 * is exactly what this feature needs to answer ("where did this field come
 * from"), so the endpoint is not a shortcut here, it is a dead end. Parsing
 * the DDL text directly is slower per call (one GET per node instead of one
 * graph call) but it is the only approach that has actually produced
 * associations and field lineage against a live system.
 *
 * Three layers, no MCP concerns in this file (no zod, no tool registration —
 * that lives in src/tools/read.ts, which wires this module in):
 *   - parseDdl:     pure, total, never throws. One DDL source string in,
 *                   one ParsedDdl out. Unrecognised input yields
 *                   kind: "unknown" and empty arrays, not an exception.
 *   - buildLineage: async, walks the object graph via resolveObject/
 *                   readSource, calling parseDdl at each CDS node.
 *   - renderLineage: pure, turns a LineageResult into the indented-tree
 *                   text the read tool prints.
 */

import type { AbapConnection } from "./connection.js";
import { AbapError, describeUnknownError, isAbapError } from "./errors.js";
import { resolveObject, type ResolvedObject } from "./resolve.js";
import { readSource } from "./source.js";

// ---------------------------------------------------------------------------
// Parser types
// ---------------------------------------------------------------------------

/** The `define ...` statement kinds seen across captures 976-980, plus two
 * synthetic kinds this module needs: "unknown" for text parseDdl could not
 * classify, and "extend view" for `extend view X with Y` (no live capture
 * of this form exists; the regex below is best-effort from the documented
 * CDS grammar, not verified against a real server response). */
export type DdlKind =
  | "view"
  | "view entity"
  | "root view entity"
  | "transient view entity"
  | "table function"
  | "abstract entity"
  | "custom entity"
  | "extend view"
  | "unknown";

export type DataSourceRelation = "from" | "join" | "union";

export interface DdlDataSource {
  readonly relation: DataSourceRelation;
  /** "inner" | "left outer" | "right outer" | "cross", only set when relation is "join". */
  readonly joinKind?: string;
  readonly target: string;
  readonly alias?: string;
}

export interface DdlFieldSource {
  readonly alias?: string;
  readonly field: string;
}

export interface DdlAssociation {
  readonly name: string;
  readonly target: string;
  /** e.g. "[0..*]", "[0..1]" — kept as written, not parsed further. */
  readonly cardinality?: string;
  readonly onCondition: string;
  /**
   * True if `name` (or `Alias.name`) is referenced anywhere in the field
   * list — as a bare exposure, a qualified exposure, or buried inside an
   * expression (fixture 980's `coalesce(_session_language.desc_text, ...)`
   * is the case that rules out "only bare/qualified exposures count").
   */
  readonly selected: boolean;
}

export interface DdlField {
  /** The field expression as written, `key`/`as <alias>` included, comments
   * and annotations already stripped. Used for display, not re-parsed. */
  readonly text: string;
  readonly alias?: string;
  readonly isKey: boolean;
  /** Set when this field entry is an association exposure (bare `_Item` or
   * qualified `SalesOrder._BusinessPartner>`) rather than a scalar field. */
  readonly association?: string;
  /**
   * `alias.field` (or bare `field`) references found in the expression.
   * Best-effort — a regex scan for `IDENT.IDENT`/bare `IDENT`, not an
   * expression parser, so a function call with no dotted reference
   * (`sysuuid_x16()`) yields an empty list rather than a guess.
   */
  readonly sources: readonly DdlFieldSource[];
}

export interface ParsedDdl {
  readonly kind: DdlKind;
  readonly name?: string;
  readonly dataSources: readonly DdlDataSource[];
  readonly associations: readonly DdlAssociation[];
  /**
   * Fields of the *first* select block only. Fixture 978 (`ARS_SOFTWARE_
   * COMPONENTS_SCP_VH`) has a `union select from ...` with its own,
   * separately-braced field list; CDS requires the union branches to
   * project the same field list shape as the first branch, so the first
   * block's fields are what field-lineage tracing needs — recording a
   * second, structurally-redundant copy would just be noise.
   */
  readonly fields: readonly DdlField[];
  /** Parameter names from `with parameters ...`, if any. No capture in
   * test/fixtures/live-captured/ exercises this syntax — the regex is
   * written from the documented grammar and is not confirmed against a
   * live server response. A parameterised view is still returned with a
   * best-effort kind/name/dataSources/fields; buildLineage treats a
   * non-empty `parameters` as a reason to stop recursing rather than
   * pretend it resolved the binding. */
  readonly parameters: readonly string[];
}

const EMPTY_PARSED_DDL: ParsedDdl = {
  kind: "unknown",
  dataSources: [],
  associations: [],
  fields: [],
  parameters: [],
};

// ---------------------------------------------------------------------------
// Parser: comment and annotation stripping
// ---------------------------------------------------------------------------

/**
 * Strip a trailing `//` or `--` line comment from one already-normalised
 * (no `\r`) source line, honouring single-quoted string literals so a `--`
 * or `//` inside a value (none observed, but CDS allows arbitrary text in
 * a quoted literal) does not truncate real code.
 *
 * This is a line-local heuristic, not a CDS tokenizer: it tracks exactly
 * one state (inside a `'...'` string, with `''` as the escape for a literal
 * quote — the same convention `abapCodeOf` in source.ts uses for ABAP) and
 * has no notion of any other quoting. Blind spot: a `//` or `--` appearing
 * inside a bracketed literal like `#relc_type.'C'` is still fine (that's a
 * single-quoted string, handled), but nothing here understands `` ` ``
 * strings or nested comments. Safe for every comment position seen in
 * captures 976-980; not a guarantee for CDS source in general.
 */
function stripLineComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'") {
      if (inString && line[i + 1] === "'") {
        i++; // doubled-quote escape inside a string literal
        continue;
      }
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "/" && line[i + 1] === "/") return line.slice(0, i);
    if (ch === "-" && line[i + 1] === "-") return line.slice(0, i);
  }
  return line;
}

/** Strip `/* ... *\/` block comments, including ones spanning several
 * physical lines (fixture 976's `/* Composition and cross BO associations  *\/`
 * is single-line; the pattern is written non-greedy/dot-all to also cover a
 * multi-line block, which is legal CDS even though no capture has one). */
function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ");
}

/**
 * Strip `@Annotation: value` and `@Annotation: { ...balanced... }` blocks.
 * Must run on already block-comment-stripped text so a `{` inside a stray
 * comment can't unbalance the brace scan. Single-line annotations are cut
 * to end of line; brace-valued annotations (fixture 976/977's
 * `@ObjectModel: { ... }`, which itself contains `--` prose bullets) are
 * removed as a whole balanced unit so those internal `--` lines never reach
 * stripLineComment and get mistaken for real trailing comments on code.
 */
function stripAnnotations(lines: string[]): string[] {
  const out: string[] = [];
  let braceDepth = 0;
  let inAnnotationHead = false; // between "@name:" and its value starting
  for (let line of lines) {
    if (braceDepth > 0) {
      // Inside a multi-line brace-valued annotation: consume until balanced.
      let consumed = "";
      let i = 0;
      for (; i < line.length && braceDepth > 0; i++) {
        const ch = line[i];
        if (ch === "{") braceDepth++;
        else if (ch === "}") braceDepth--;
      }
      consumed = line.slice(0, i);
      line = line.slice(i);
      void consumed;
      if (braceDepth > 0) continue; // whole line was inside the annotation
    }
    // Strip zero or more `@...: ...` occurrences on the remainder of this line.
    let rest = line;
    let output = "";
    for (;;) {
      const m = /@[A-Za-z][\w.]*\s*:/.exec(rest);
      if (!m) {
        output += rest;
        break;
      }
      output += rest.slice(0, m.index);
      const afterColon = rest.slice(m.index + m[0].length);
      const valueStart = /^\s*/.exec(afterColon)![0].length;
      if (afterColon[valueStart] === "{") {
        // Balanced brace scan starting at the opening brace.
        let depth = 0;
        let i = valueStart;
        for (; i < afterColon.length; i++) {
          const ch = afterColon[i];
          if (ch === "{") depth++;
          else if (ch === "}") {
            depth--;
            if (depth === 0) {
              i++;
              break;
            }
          }
        }
        if (depth > 0) {
          // Annotation value continues past this physical line.
          braceDepth = depth;
          rest = "";
          break;
        }
        rest = afterColon.slice(i);
      } else {
        // Single-line annotation value: rest of the physical line is annotation.
        rest = "";
      }
    }
    void inAnnotationHead;
    out.push(output);
  }
  return out;
}

/**
 * Reduce raw DDL source to a single normalised line of "code": comments and
 * annotations removed, all remaining whitespace (including the newlines
 * that used to separate a multi-line ON-condition, e.g. fixtures 979/980)
 * collapsed to single spaces. Every downstream regex operates on this
 * string, so line numbers are gone by design — this module never reports
 * a line number, only object/field names.
 */
function normalise(source: string): string {
  const noCr = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const noBlockComments = stripBlockComments(noCr);
  const lines = noBlockComments.split("\n").map(stripLineComment);
  const noAnnotations = stripAnnotations(lines);
  return noAnnotations.join(" ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Parser: kind/name, parameters, data sources, associations, fields
// ---------------------------------------------------------------------------

const KIND_PATTERNS: ReadonlyArray<{ re: RegExp; kind: DdlKind }> = [
  { re: /\bdefine\s+root\s+view\s+entity\s+([\w/]+)/i, kind: "root view entity" },
  { re: /\bdefine\s+transient\s+view\s+entity\s+([\w/]+)/i, kind: "transient view entity" },
  { re: /\bdefine\s+view\s+entity\s+([\w/]+)/i, kind: "view entity" },
  { re: /\bdefine\s+table\s+function\s+([\w/]+)/i, kind: "table function" },
  { re: /\bdefine\s+abstract\s+entity\s+([\w/]+)/i, kind: "abstract entity" },
  { re: /\bdefine\s+custom\s+entity\s+([\w/]+)/i, kind: "custom entity" },
  { re: /\bdefine\s+view\s+([\w/]+)/i, kind: "view" },
];

/** `extend view <original> with <extension>` — the DDL's own subject is the
 * view being extended, so that is what `name` captures. Unverified against
 * a live capture; see the ParsedDdl.parameters doc comment for the same
 * caveat pattern applied here. */
const EXTEND_VIEW_RE = /\bextend\s+view\s+([\w/]+)\s+with\s+([\w/]+)/i;

function detectKindAndName(code: string): { kind: DdlKind; name?: string } {
  const extend = EXTEND_VIEW_RE.exec(code);
  if (extend) return { kind: "extend view", name: extend[1] };
  for (const { re, kind } of KIND_PATTERNS) {
    const m = re.exec(code);
    if (m) return { kind, name: m[1] };
  }
  return { kind: "unknown" };
}

/** `with parameters p1 : type1, p2 : abap.char(10) as select from ...` —
 * best-effort, see ParsedDdl.parameters. Stops at the first `as select`/
 * `as projection` so it never swallows the data source. */
function parseParameters(code: string): string[] {
  const m = /\bwith\s+parameters\s+([\s\S]*?)\s+as\s+(?:select|projection)\b/i.exec(code);
  if (!m) return [];
  const body = m[1]!;
  return splitTopLevel(body, ",")
    .map((p) => /^\s*([\w]+)\s*:/.exec(p)?.[1])
    .filter((p): p is string => Boolean(p));
}

/** Split `text` on `sep` at paren-depth 0 only — the nested-parens-aware
 * splitter fixture 980's `coalesce(a, coalesce(b, c)) as x` requires: a
 * naive split on every comma would cut that single field into three. */
function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

const DATA_SOURCE_RE =
  /\bunion\s+(?:all\s+)?select\s+from\s+([\w/]+)(?:\s+as\s+(\w+))?|\b(inner\s+join|left\s+outer\s+join|right\s+outer\s+join|cross\s+join|join)\s+([\w/]+)(?:\s+as\s+(\w+))?\s+on\b|\bas\s+select\s+from\s+([\w/]+)(?:\s+as\s+(\w+))?|\bas\s+projection\s+on\s+([\w/]+)(?:\s+as\s+(\w+))?/gi;

function parseDataSources(code: string): DdlDataSource[] {
  const out: DdlDataSource[] = [];
  for (const m of code.matchAll(DATA_SOURCE_RE)) {
    if (m[1] !== undefined) {
      out.push({ relation: "union", target: m[1], alias: m[2] });
    } else if (m[4] !== undefined) {
      out.push({ relation: "join", joinKind: m[3]!.replace(/\s+join$/i, "").trim().toLowerCase(), target: m[4], alias: m[5] });
    } else if (m[6] !== undefined) {
      out.push({ relation: "from", target: m[6], alias: m[7] });
    } else if (m[8] !== undefined) {
      out.push({ relation: "from", target: m[8], alias: m[9] });
    }
  }
  return out;
}

/** `association [0..*] to <target> as <name> on <condition>`. The ON
 * condition runs non-greedily up to the next `association` keyword or the
 * field list's opening `{` — both fixture 979/980's multi-line ON clauses
 * (already collapsed to single spaces by normalise()) and fixture 977's
 * `$projection.` form parse the same way, since neither is anchored to
 * line boundaries. */
const ASSOCIATION_RE =
  /\bassociation\s*(\[[^\]]*\])?\s*to\s+([\w/]+)\s+as\s+(\w+)\s+on\s+(.*?)(?=\bassociation\s*(?:\[[^\]]*\])?\s*to\b|\{)/gis;

function parseAssociationsRaw(code: string): Array<Omit<DdlAssociation, "selected">> {
  const out: Array<Omit<DdlAssociation, "selected">> = [];
  for (const m of code.matchAll(ASSOCIATION_RE)) {
    out.push({
      cardinality: m[1]?.replace(/\s+/g, ""),
      target: m[2]!,
      name: m[3]!,
      onCondition: m[4]!.trim(),
    });
  }
  return out;
}

/** Locate the first top-level `{...}` block after comment/annotation
 * stripping. Because stripAnnotations() already removed every brace that
 * belonged to a `@Foo: { ... }` value, the first remaining `{` is the field
 * list's opening brace in every capture seen (976-980) — there is nothing
 * else left in the code that uses braces. */
function firstBraceBlock(code: string): string | undefined {
  const start = code.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    const ch = code[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return code.slice(start + 1, i);
    }
  }
  return undefined; // unbalanced — caller treats "no field list found"
}

const ASSOCIATION_NAME_RE = /^(?:[\w/]+\.)?(_\w+)$/;
const DOTTED_REF_RE = /\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)\b/g;

function parseField(raw: string): DdlField {
  const text = raw.trim();
  let rest = text;
  const isKey = /^key\s+/i.test(rest);
  if (isKey) rest = rest.replace(/^key\s+/i, "");

  const aliasMatch = /^([\s\S]*?)\s+as\s+(\w+)\s*$/i.exec(rest);
  // Destructuring a regex match array still yields `string | undefined` per
  // element under noUncheckedIndexedAccess (RegExpExecArray is just
  // `Array<string>` to the type checker, which does not know group 1 is
  // non-optional in this pattern) — `?? rest`/`?? undefined` are real
  // fallbacks for that, not an assertion that the value is present.
  const [, exprGroup, aliasGroup] = aliasMatch ?? [];
  const expr = (aliasMatch ? (exprGroup ?? "") : rest).trim();
  const alias = aliasGroup;

  let association: string | undefined;
  if (!alias) {
    const assocMatch = ASSOCIATION_NAME_RE.exec(expr);
    if (assocMatch) association = assocMatch[1];
  }

  const sources: DdlFieldSource[] = [];
  let sawDotted = false;
  for (const m of expr.matchAll(DOTTED_REF_RE)) {
    sawDotted = true;
    sources.push({ alias: m[1], field: m[2]! });
  }
  if (!sawDotted && /^\w+$/.test(expr)) {
    sources.push({ field: expr });
  }

  return { text, alias, isKey, association, sources };
}

function parseFields(fieldListBody: string): DdlField[] {
  return splitTopLevel(fieldListBody, ",").map(parseField);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse one CDS DDL source into its shape: kind, data sources, associations
 * and top-level fields. Pure and total — never throws. Unrecognised input
 * (wrong object type read as source, truncated capture, syntax this module
 * has not seen) degrades to `kind: "unknown"` with empty arrays rather than
 * an exception, because buildLineage needs to keep walking siblings when
 * one node's source does not parse; per G-08 that degraded shape is never
 * silently reported as if it were a real "view has no associations" — the
 * caller must check `kind === "unknown"` and say so.
 */
export function parseDdl(source: string): ParsedDdl {
  if (typeof source !== "string" || source.trim().length === 0) return EMPTY_PARSED_DDL;

  const code = normalise(source);
  const { kind, name } = detectKindAndName(code);
  if (kind === "unknown") return EMPTY_PARSED_DDL;

  const dataSources = parseDataSources(code);
  const rawAssociations = parseAssociationsRaw(code);
  const fieldListBody = firstBraceBlock(code);
  const fields = fieldListBody !== undefined ? parseFields(fieldListBody) : [];
  const parameters = parseParameters(code);

  const associations: DdlAssociation[] = rawAssociations.map((a) => ({
    ...a,
    selected: fieldListBody !== undefined && new RegExp(`\\b${escapeRegExp(a.name)}\\b`).test(fieldListBody),
  }));

  return { kind, name, dataSources, associations, fields, parameters };
}

// ---------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------

/** Matches TYPES's DDLS/DF entry in types.ts — recursion only follows this
 * exact type string; every other resolved type (TABL/DT, a structure, a
 * table function's parameter type, anything resolveObject hands back) is a
 * leaf, because only a DDLS/DF source is CDS text this module can parse. */
const CDS_SOURCE_TYPE = "DDLS/DF";

/** Kinds whose recursion stops even though the object is a DDLS/DF source:
 * a table function has no `from`/`association` clauses this parser
 * understands (its body is a method call, not a select), and abstract/
 * custom entities and extend-view fragments have no SQL data source of
 * their own to walk into. */
const NON_RECURSING_KINDS: ReadonlySet<DdlKind> = new Set([
  "table function",
  "abstract entity",
  "custom entity",
  "extend view",
  "unknown",
]);

export const LINEAGE_DEFAULT_DEPTH = 5;
export const LINEAGE_MAX_DEPTH = 10;
/** Hard cap on nodes visited in one buildLineage call, independent of
 * depth — a shallow view that fans out to hundreds of siblings (a wide
 * union, or many associations reused at every level) can still blow up
 * node count at a depth of 2 or 3. Chosen as a round number generous
 * enough for the five-node graphs in captures 976-980 with headroom for a
 * real customer view; there is no measured basis for a tighter number. */
export const LINEAGE_DEFAULT_NODE_BUDGET = 200;

export interface LineageNode {
  readonly name: string;
  readonly type: string;
  readonly kind: DdlKind | "table";
  readonly depth: number;
  readonly relation?: DataSourceRelation;
  readonly alias?: string;
  readonly joinKind?: string;
  /** Set when this node was reached by following an association rather
   * than a `from`/`join`/`union` data source. */
  readonly associationName?: string;
  readonly children: readonly LineageNode[];
  readonly leaf: boolean;
  readonly leafReason?: string;
  /** True when `name` had already been visited elsewhere in this walk —
   * see buildLineage's doc comment for why that check is global, not
   * per-ancestor-path. */
  readonly cycle: boolean;
  readonly fields?: readonly DdlField[];
  readonly associations?: readonly DdlAssociation[];
}

export interface LineageOptions {
  /** 1..LINEAGE_MAX_DEPTH. Refused (not clamped) outside that range — G-08. */
  readonly depth?: number;
  /** Trace this one field's lineage instead of rendering the whole tree. */
  readonly field?: string;
  readonly nodeBudget?: number;
}

export interface FieldLineageStep {
  readonly nodeName: string;
  readonly nodeType: string;
  readonly fieldText: string;
  readonly alias?: string;
  readonly sources: readonly DdlFieldSource[];
  /** True when the chain stops here: a base table, an unresolved alias, a
   * field with more than one source reference (ambiguous — e.g. fixture
   * 980's `coalesce(...)` field, which has three), or a resolve/read
   * failure. */
  readonly terminal: boolean;
  readonly terminalReason?: string;
}

export interface LineageResult {
  readonly root: LineageNode;
  readonly requestedDepth: number;
  readonly nodeCount: number;
  readonly baseTables: readonly string[];
  readonly sourceReads: number;
  readonly truncated: boolean;
  readonly continueFrom?: string;
  readonly fieldChain?: readonly FieldLineageStep[];
}

function availableFieldNames(fields: readonly DdlField[]): string[] {
  return fields.map((f) => f.alias ?? f.association ?? f.sources[0]?.field ?? f.text).filter((n) => n.length > 0);
}

function findField(fields: readonly DdlField[], name: string): DdlField | undefined {
  const want = name.toUpperCase();
  return fields.find((f) => {
    if (f.alias && f.alias.toUpperCase() === want) return true;
    if (f.association && f.association.toUpperCase() === want) return true;
    if (!f.alias && f.sources.length === 1 && f.sources[0]!.field.toUpperCase() === want) return true;
    return false;
  });
}

function toAbapError(e: unknown, fallbackMessage: string): AbapError {
  if (isAbapError(e)) return e;
  return new AbapError("ADT_ERROR", `${fallbackMessage}: ${describeUnknownError(e)}`);
}

/**
 * Walk a CDS view's data sources and associations, resolving and parsing
 * each DDLS/DF node in turn, to build a lineage tree rooted at `root`.
 *
 * Cycle handling is a single global "already visited" set of uppercased
 * object names, not a per-branch ancestor check. That means a genuine
 * diamond — two sibling associations pointing at the same target, as
 * fixture 980's `_session_language` and `_english` both do at `cvers_ref`
 * — renders its second occurrence as "(cycle -> seen above)" too, even
 * though nothing actually cycles. That is a deliberate over-approximation:
 * it bounds node count for the common case (many views selecting from the
 * same handful of base tables) without having to tell a true cycle apart
 * from a wide diamond, which would need tracking the full path, not just a
 * set membership test.
 */
export async function buildLineage(
  conn: AbapConnection,
  root: ResolvedObject,
  opts: LineageOptions = {},
): Promise<LineageResult> {
  const requestedDepth = opts.depth ?? LINEAGE_DEFAULT_DEPTH;
  if (!Number.isInteger(requestedDepth) || requestedDepth < 1 || requestedDepth > LINEAGE_MAX_DEPTH) {
    throw new AbapError(
      "BAD_INPUT",
      `depth must be an integer between 1 and ${LINEAGE_MAX_DEPTH} (got ${JSON.stringify(opts.depth)}).`,
      { depth: opts.depth },
      `Pass depth between 1 and ${LINEAGE_MAX_DEPTH}, or omit it for the default of ${LINEAGE_DEFAULT_DEPTH}.`,
    );
  }
  const nodeBudget = opts.nodeBudget ?? LINEAGE_DEFAULT_NODE_BUDGET;
  if (!Number.isInteger(nodeBudget) || nodeBudget < 1) {
    throw new AbapError(
      "BAD_INPUT",
      `nodeBudget must be a positive integer (got ${JSON.stringify(opts.nodeBudget)}).`,
      { nodeBudget: opts.nodeBudget },
    );
  }
  if (root.type !== CDS_SOURCE_TYPE) {
    throw new AbapError(
      "UNSUPPORTED",
      `${root.name} is a ${root.type}, not a CDS view (${CDS_SOURCE_TYPE}). Lineage only traces CDS source — point it at a DDLS/DF object.`,
      { type: root.type, name: root.name },
    );
  }

  const seen = new Set<string>([root.name.toUpperCase()]);
  const baseTables = new Set<string>();
  let nodeCount = 1;
  let sourceReads = 0;
  let truncated = false;
  let continueFrom: string | undefined;

  async function expand(
    obj: ResolvedObject,
    depth: number,
    relation?: DataSourceRelation,
    alias?: string,
    joinKind?: string,
    associationName?: string,
  ): Promise<{ node: LineageNode; parsed?: ParsedDdl }> {
    if (obj.type !== CDS_SOURCE_TYPE) {
      baseTables.add(obj.name);
      return {
        node: {
          name: obj.name,
          type: obj.type,
          kind: "table",
          depth,
          relation,
          alias,
          joinKind,
          associationName,
          children: [],
          leaf: true,
          leafReason: `${obj.type} is not CDS source — lineage stops here`,
          cycle: false,
        },
      };
    }

    let parsed: ParsedDdl;
    try {
      const src = await readSource(conn, obj, undefined, undefined);
      sourceReads++;
      parsed = parseDdl(src.source);
    } catch (e) {
      const err = toAbapError(e, "reading source");
      return {
        node: {
          name: obj.name,
          type: obj.type,
          kind: "unknown",
          depth,
          relation,
          alias,
          joinKind,
          associationName,
          children: [],
          leaf: true,
          leafReason: `not found: ${err.message}`,
          cycle: false,
        },
      };
    }

    const stopReason = NON_RECURSING_KINDS.has(parsed.kind)
      ? `${parsed.kind} — not further decomposed`
      : parsed.parameters.length > 0
        ? "parameterised view — lineage does not resolve parameter bindings"
        : depth >= requestedDepth
          ? `depth limit (${requestedDepth}) reached`
          : undefined;

    if (stopReason) {
      return {
        node: {
          name: obj.name,
          type: obj.type,
          kind: parsed.kind,
          depth,
          relation,
          alias,
          joinKind,
          associationName,
          children: [],
          leaf: true,
          leafReason: stopReason,
          cycle: false,
          fields: parsed.fields,
          associations: parsed.associations,
        },
        parsed,
      };
    }

    const children: LineageNode[] = [];
    for (const ds of parsed.dataSources) {
      children.push(await visitRef(ds.target, depth + 1, ds.relation, ds.alias, ds.joinKind, undefined));
    }
    for (const assoc of parsed.associations) {
      if (!assoc.selected) {
        children.push({
          name: assoc.target,
          type: "unknown",
          kind: "unknown",
          depth: depth + 1,
          associationName: assoc.name,
          children: [],
          leaf: true,
          leafReason: "not selected",
          cycle: false,
        });
        continue;
      }
      children.push(await visitRef(assoc.target, depth + 1, undefined, undefined, undefined, assoc.name));
    }

    return {
      node: {
        name: obj.name,
        type: obj.type,
        kind: parsed.kind,
        depth,
        relation,
        alias,
        joinKind,
        associationName,
        children,
        leaf: false,
        cycle: false,
        fields: parsed.fields,
        associations: parsed.associations,
      },
      parsed,
    };
  }

  async function visitRef(
    ref: string,
    depth: number,
    relation?: DataSourceRelation,
    alias?: string,
    joinKind?: string,
    associationName?: string,
  ): Promise<LineageNode> {
    nodeCount++;
    if (nodeCount > nodeBudget) {
      truncated = true;
      continueFrom ??= ref;
      return {
        name: ref,
        type: "unknown",
        kind: "unknown",
        depth,
        relation,
        alias,
        joinKind,
        associationName,
        children: [],
        leaf: true,
        leafReason: "node budget exceeded",
        cycle: false,
      };
    }

    let obj: ResolvedObject;
    try {
      obj = await resolveObject(conn, ref, {});
    } catch (e) {
      const err = toAbapError(e, "resolving reference");
      return {
        name: ref,
        type: "unknown",
        kind: "unknown",
        depth,
        relation,
        alias,
        joinKind,
        associationName,
        children: [],
        leaf: true,
        leafReason: `not found: ${err.message}`,
        cycle: false,
      };
    }

    const key = obj.name.toUpperCase();
    if (seen.has(key)) {
      return {
        name: obj.name,
        type: obj.type,
        kind: "unknown",
        depth,
        relation,
        alias,
        joinKind,
        associationName,
        children: [],
        leaf: true,
        cycle: true,
      };
    }
    seen.add(key);

    const { node } = await expand(obj, depth, relation, alias, joinKind, associationName);
    return node;
  }

  const { node: rootNode, parsed: rootParsed } = await expand(root, 1);

  let fieldChain: FieldLineageStep[] | undefined;
  if (opts.field !== undefined) {
    const rootFields = rootParsed?.fields ?? [];
    if (findField(rootFields, opts.field) === undefined) {
      const names = availableFieldNames(rootFields);
      const shown = names.slice(0, 40);
      const suffix = names.length > shown.length ? `, ... and ${names.length - shown.length} more` : "";
      throw new AbapError(
        "BAD_INPUT",
        `${root.name} has no field "${opts.field}". Known fields: ${shown.join(", ")}${suffix}.`,
        { field: opts.field, knownFields: names },
        `Pass one of the listed field names (case-insensitive), matched against its exposed alias.`,
      );
    }
    fieldChain = await traceField(root, rootParsed!, opts.field, requestedDepth);
  }

  return {
    root: rootNode,
    requestedDepth,
    nodeCount,
    baseTables: [...baseTables],
    sourceReads,
    truncated,
    continueFrom,
    fieldChain,
  };

  async function traceField(
    startObj: ResolvedObject,
    startParsed: ParsedDdl,
    startField: string,
    maxSteps: number,
  ): Promise<FieldLineageStep[]> {
    const steps: FieldLineageStep[] = [];
    let currentObj = startObj;
    let currentParsed = startParsed;
    let currentField = startField;
    const chainSeen = new Set<string>();

    for (let i = 0; i < maxSteps; i++) {
      const chainKey = `${currentObj.name.toUpperCase()}.${currentField.toUpperCase()}`;
      if (chainSeen.has(chainKey)) {
        steps.push({
          nodeName: currentObj.name,
          nodeType: currentObj.type,
          fieldText: currentField,
          sources: [],
          terminal: true,
          terminalReason: "cycle -> seen above",
        });
        break;
      }
      chainSeen.add(chainKey);

      const field = findField(currentParsed.fields, currentField);
      if (!field) {
        steps.push({
          nodeName: currentObj.name,
          nodeType: currentObj.type,
          fieldText: currentField,
          sources: [],
          terminal: true,
          terminalReason: `${currentObj.name} has no field "${currentField}"`,
        });
        break;
      }

      if (field.sources.length !== 1) {
        steps.push({
          nodeName: currentObj.name,
          nodeType: currentObj.type,
          fieldText: field.text,
          alias: field.alias,
          sources: field.sources,
          terminal: true,
          terminalReason:
            field.sources.length === 0
              ? "expression has no traceable source reference"
              : `expression combines ${field.sources.length} source references — chain stops here`,
        });
        break;
      }

      const only = field.sources[0]!;
      const ds = currentParsed.dataSources.find((d) => (d.alias ?? d.target).toUpperCase() === (only.alias ?? "").toUpperCase());
      const assoc = currentParsed.associations.find((a) => a.name.toUpperCase() === (only.alias ?? "").toUpperCase());
      const targetRef = ds?.target ?? assoc?.target;

      if (only.alias === undefined || targetRef === undefined) {
        // Either a bare column with no alias (nothing further to resolve —
        // it belongs to this node's single data source), or an alias this
        // parser could not match to a data source/association. Either way
        // this is where a linear chain has to stop; the tree render still
        // shows the rest of the graph.
        steps.push({
          nodeName: currentObj.name,
          nodeType: currentObj.type,
          fieldText: field.text,
          alias: field.alias,
          sources: field.sources,
          terminal: true,
          terminalReason:
            only.alias === undefined
              ? "column of this node's own data source — not itself an alias to follow"
              : `alias "${only.alias}" does not match a known data source or association here`,
        });
        break;
      }

      steps.push({
        nodeName: currentObj.name,
        nodeType: currentObj.type,
        fieldText: field.text,
        alias: field.alias,
        sources: field.sources,
        terminal: false,
      });

      let nextObj: ResolvedObject;
      try {
        nextObj = await resolveObject(conn, targetRef, {});
      } catch (e) {
        const err = toAbapError(e, "resolving reference");
        steps.push({
          nodeName: targetRef,
          nodeType: "unknown",
          fieldText: only.field,
          sources: [],
          terminal: true,
          terminalReason: `not found: ${err.message}`,
        });
        break;
      }

      if (nextObj.type !== CDS_SOURCE_TYPE) {
        steps.push({
          nodeName: nextObj.name,
          nodeType: nextObj.type,
          fieldText: only.field,
          sources: [],
          terminal: true,
          terminalReason: `${nextObj.type} is not CDS source — base column`,
        });
        break;
      }

      let nextParsed: ParsedDdl;
      try {
        const src = await readSource(conn, nextObj, undefined, undefined);
        sourceReads++;
        nextParsed = parseDdl(src.source);
      } catch (e) {
        const err = toAbapError(e, "reading source");
        steps.push({
          nodeName: nextObj.name,
          nodeType: nextObj.type,
          fieldText: only.field,
          sources: [],
          terminal: true,
          terminalReason: `not found: ${err.message}`,
        });
        break;
      }

      currentObj = nextObj;
      currentParsed = nextParsed;
      currentField = only.field;
    }

    return steps;
  }
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export interface RenderedLineage {
  readonly header: Record<string, string>;
  readonly body: string;
  readonly notes: readonly string[];
  readonly hints: readonly string[];
}

/** Collapse whitespace and cap an ON-condition/association blurb to ~80
 * chars so a multi-line condition (fixtures 979/980) doesn't blow out the
 * tree render into unreadable width. */
function abbreviate(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function nodeLabel(n: LineageNode): string {
  const parts: string[] = [];
  if (n.associationName) {
    parts.push(`-> ${n.associationName} to ${n.name}`);
  } else if (n.relation === "join") {
    parts.push(`${n.joinKind ? `${n.joinKind} ` : ""}join ${n.name}`);
  } else if (n.relation === "union") {
    parts.push(`union ${n.name}`);
  } else if (n.relation === "from") {
    parts.push(`from ${n.name}`);
  } else {
    parts.push(n.name); // root
  }
  if (n.alias) parts.push(`as ${n.alias}`);
  parts.push(`(${n.kind})`);
  if (n.cycle) parts.push("(cycle -> seen above)");
  else if (n.leafReason === "node budget exceeded") {
    // handled by the caller as a distinct "--- TRUNCATED ---" line
  } else if (n.leafReason) {
    parts.push(`(${n.leafReason})`);
  }
  return parts.join(" ");
}

function renderTree(node: LineageNode, indent: string, lines: string[]): void {
  if (node.leafReason === "node budget exceeded") {
    lines.push(`${indent}--- TRUNCATED --- (continue from "${node.name}")`);
    return;
  }
  lines.push(`${indent}${nodeLabel(node)}`);
  const childIndent = `${indent}  `;
  for (const child of node.children) renderTree(child, childIndent, lines);
}

function renderFieldChain(chain: readonly FieldLineageStep[], root: LineageNode, field: string): string {
  const lines: string[] = [`${root.name}.${field}`];
  let indent = "  ";
  for (const step of chain) {
    const srcText = step.sources.length ? ` <- ${step.sources.map((s) => (s.alias ? `${s.alias}.${s.field}` : s.field)).join(", ")}` : "";
    lines.push(`${indent}${step.fieldText}${srcText}`);
    if (step.terminal && step.terminalReason) {
      lines.push(`${indent}  (${step.terminalReason})`);
    }
    indent += "  ";
  }
  return lines.join("\n");
}

/**
 * Render a LineageResult into the header/body/notes/hints shape read.ts
 * feeds into buildResponse (src/compact.ts) — this function itself returns
 * plain strings, not a BuiltResponse; response assembly (token budgeting,
 * etag, disclosure) is read.ts's job, not this module's.
 */
export function renderLineage(result: LineageResult, opts: { readonly field?: string } = {}): RenderedLineage {
  const header: Record<string, string> = {
    view: result.root.name,
    object: `${result.root.name} (${result.root.type})`,
    depth: String(result.requestedDepth),
    nodes: String(result.nodeCount),
    baseTables: String(result.baseTables.length),
    sourceReads: String(result.sourceReads),
  };
  if (opts.field !== undefined) header.field = opts.field;
  if (result.truncated) header.truncatedNodes = String(result.nodeCount);

  const notes: string[] = [
    "Lineage is derived by parsing CDS DDL source text, not from ADT's dependency-graph endpoint " +
      "(that endpoint returns no association edges and no field lineage — see this file's top comment).",
    `Only associations referenced somewhere in the field list are followed ("(not selected)" marks the rest).`,
    `A name repeated anywhere earlier in this walk is shown once and marked "(cycle -> seen above)" on later ` +
      `occurrences, even for a legitimate diamond (the same base table reached two different ways) — this is a ` +
      `global visited-set, not a strict cycle check.`,
    `Depth ${result.requestedDepth} of max ${LINEAGE_MAX_DEPTH}; nodes at the limit are leaves even if the ` +
      `underlying view has further data sources.`,
  ];

  const hints: string[] = [];
  if (result.truncated) {
    hints.push(`Node budget reached — re-run with a smaller depth or scope to see past "${String(result.continueFrom)}".`);
  }
  if (result.baseTables.length > 0) {
    hints.push(`Base (non-CDS) tables reached: ${result.baseTables.join(", ")}.`);
  }

  let body: string;
  if (opts.field !== undefined && result.fieldChain) {
    body = renderFieldChain(result.fieldChain, result.root, opts.field);
  } else {
    const lines: string[] = [];
    renderTree(result.root, "", lines);
    body = lines.join("\n");
  }

  return { header, body, notes, hints };
}
