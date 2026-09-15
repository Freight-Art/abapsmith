/**
 * `abap_read view=digest` — pure logic and rendering behind a one-page,
 * bounded summary of an ABAP object (issue #110). Everything in this module
 * is I/O-free: no `AbapConnection`, no network call, nothing async. The
 * wiring layer (`src/tools/read.ts`) fetches the source, the outline and the
 * history feed, shapes them into `DigestInput`, and hands the result to
 * `buildDigestSections`.
 *
 * Where-used is deliberately never fetched here — `abap_search`'s
 * `mode="where_used"` walks ADT's `usageReferences` endpoint, which is
 * unbounded (no limit, no paging; 20+ seconds on a wide fan-in — see
 * `src/tools/search.ts`). The digest names that call instead of running it.
 * `abap_read view="footprint"` and `abap_search mode="call_graph"`, both
 * mentioned in the issue text, do not exist in this codebase and are never
 * named below.
 */
import type { ClassMember } from "./source.js";
import { abapCodeOf } from "./source.js";
import { textTable } from "../compact.js";
// The single source of truth for the "$TMP has no released history" sentence
// — see revisions.ts. Re-declaring it here would risk drifting from the
// wording `view="history"` actually shows.
import { NO_RELEASED_HISTORY_EXPLANATION } from "./revisions.js";

// ---------------------------------------------------------------------------
// Input shapes. Filled in by the wiring layer; nothing here is fetched.
// ---------------------------------------------------------------------------

export interface DigestHeader {
  readonly type: string;
  readonly name: string;
  readonly packageName?: string;
  readonly description?: string;
  readonly responsible?: string;
  /** Already-formatted, e.g. "2026-09-01 by DEVELOPER (version 3)". */
  readonly lastChanged?: string;
  readonly lastChangedSource: "released" | "active";
  readonly activationState?: string;
}

export interface DigestPublicApi {
  readonly rows: readonly { readonly name: string; readonly kind: string; readonly detail?: string }[];
  readonly hiddenCounts: readonly { readonly visibility: string; readonly count: number }[];
  /** Rows dropped from `rows` before this digest was built; 0/undefined when none. */
  readonly truncatedRows?: number;
}

export interface DigestDependency {
  readonly name: string;
  readonly via: string;
  readonly readCall: string;
}

export interface DigestTests {
  readonly hasTestInclude: boolean;
  readonly testClassCount: number;
  readonly testCall: string;
  readonly atcCall: string;
}

export interface DigestHistoryEntry {
  readonly version: string;
  readonly date?: string;
  readonly author?: string;
  readonly note?: string;
}

export interface DigestInput {
  readonly header: DigestHeader;
  readonly publicApi: DigestPublicApi;
  readonly dependencies: readonly DigestDependency[];
  readonly tests: DigestTests;
  readonly history: readonly DigestHistoryEntry[];
  readonly nextSteps: readonly string[];
}

// ---------------------------------------------------------------------------
// Supported types.
// ---------------------------------------------------------------------------

export const DIGEST_TYPES: readonly string[] = [
  "CLAS/OC",
  "INTF/OI",
  "PROG/P",
  "FUGR/F",
  "FUGR/FF",
  "DDLS/DF",
];

/**
 * Case-insensitive, and tolerant of a bare kind ("CLAS") standing in for its
 * full type code — but only when that kind names exactly one of the six
 * digest types. "FUGR" alone is ambiguous between FUGR/F and FUGR/FF and is
 * therefore NOT accepted bare; "CLAS", "INTF", "PROG" and "DDLS" each name
 * exactly one digest type and are.
 */
export function isDigestType(type: string): boolean {
  const t = type.trim().toUpperCase();
  if (!t) return false;
  if (DIGEST_TYPES.includes(t)) return true;
  if (t.includes("/")) return false;
  const matches = DIGEST_TYPES.filter((d) => d.split("/")[0] === t);
  return matches.length === 1;
}

// ---------------------------------------------------------------------------
// Static dependency scan.
// ---------------------------------------------------------------------------

/**
 * ABAP built-in types and keywords that shadow the "next word after TYPE" a
 * naive scan would otherwise mistake for a global type name — e.g. `TYPE
 * sy-subrc` (stops at the hyphen, leaving the builtin structure name `sy`),
 * `TYPE STANDARD TABLE OF zcl_foo` (stops at `standard`), and `TYPE REF` when
 * `TO` falls on the next line so the `TYPE REF TO` lookahead below can't see
 * it (leaving the bare keyword `ref`, also listed here as a backstop).
 */
const BUILTIN_TYPES = new Set([
  "i", "f", "p", "c", "n", "d", "t", "x",
  "string", "xstring", "abap_bool",
  "int1", "int2", "int4", "int8", "decfloat16", "decfloat34", "utclong",
  "any", "data", "sy", "ref",
  "standard", "sorted", "hashed", "table", "line", "of",
]);

/**
 * Local-variable naming conventions. A name matching one of these is a
 * declared local/global-in-the-narrow-sense variable, not a type or class
 * worth naming as a dependency — even though it may otherwise pass the
 * global-name shape check.
 */
const LOCAL_PREFIXES = ["lt_", "ls_", "lv_", "lo_", "lr_", "gt_", "gs_", "gv_", "go_", "ty_", "t_"];

function looksLikeLocalName(name: string): boolean {
  const n = name.toLowerCase();
  if (n === "begin" || n === "end") return true;
  return LOCAL_PREFIXES.some((p) => n.startsWith(p));
}

/** A bare name or a `/NAMESPACE/NAME` name — the shape a global repository object has. */
const GLOBAL_NAME_RE = /^(?:\/\w+\/)?[A-Za-z_][A-Za-z0-9_]*$/;

function isCandidateGlobalName(name: string): boolean {
  if (!GLOBAL_NAME_RE.test(name)) return false;
  if (BUILTIN_TYPES.has(name.toLowerCase())) return false;
  if (looksLikeLocalName(name)) return false;
  return true;
}

/** The `abap_read`/`abap_search` call that fetches one dependency's own definition. */
function readCallFor(name: string, via: string): string {
  if (via === "function module") return `abap_read {"object":"${name}","type":"FUGR/FF"}`;
  // A transaction (TSTC) is not an ADT repository object abap_read can open;
  // the only real, verified call that can say anything about it is a plain
  // object search (no `type` filter — "TRAN" is not a registered ADT type
  // in src/adt/types.ts, so passing it would be rejected).
  if (via === "transaction") return `abap_search {"query":"${name}"}`;
  // Registered ADT type codes confirmed in src/adt/types.ts: a transparent
  // table is "TABL/DT" (label "Database table"), a program include is
  // "PROG/I" (label "Include"). Passing the specific type, rather than the
  // untyped fallback below, avoids an ambiguous-name search hitting the
  // wrong object kind.
  if (via === "SELECT FROM") return `abap_read {"object":"${name}","type":"TABL/DT"}`;
  if (via === "INCLUDE") return `abap_read {"object":"${name}","type":"PROG/I"}`;
  return `abap_read {"object":"${name}"}`;
}

/**
 * True when `source` looks like CDS DDL (`DDLS/DF`) rather than Open SQL
 * ABAP. `scanDependencies` is also called for DDLS/DF sources (see
 * `readDigest` in `src/tools/read.ts`), where `select from <entity>` is DDL
 * projection syntax — not an Open SQL statement — and the entity/association
 * names after it are not table dependencies in the sense this scan means.
 * There is no `type` reaching this function (the call site passes only
 * `source`/`selfName`), so detection is content-based: every CDS source this
 * codebase targets (7.54, classic syntax only — see the `DDLS/DF` type
 * comment in `src/adt/types.ts`) opens with `DEFINE VIEW`, a keyword pair
 * that never starts an Open SQL statement.
 */
function looksLikeCdsSource(source: string): boolean {
  return source
    .replace(/\r\n/g, "\n")
    .split("\n")
    .some((raw) => /^\s*define\s+view\b/i.test(abapCodeOf(raw)));
}

/**
 * One static pass over `source` for the handful of statements issue #110
 * names as "direct dependencies". Names only — this is not a call graph, and
 * it never resolves whether a captured name actually exists. Every line is
 * scanned twice where a literal is involved: once through `abapCodeOf` (to
 * decide whether the line is live code at all, and to find non-literal
 * keywords safely), and — only for `CALL FUNCTION`/`CALL TRANSACTION`, whose
 * literal argument `abapCodeOf` blanks — a second time against the RAW line,
 * gated on the first pass having already confirmed the statement is real
 * code and not a comment.
 *
 * Also finds `SELECT ... FROM <table>` (including a joined select's `JOIN
 * <table>`) and `INCLUDE <program>.`. The `FROM`/`JOIN` target is tracked
 * across lines — a real `SELECT` commonly puts `FROM` on its own
 * continuation line — via a small `inSelect` flag that opens on a `SELECT`
 * keyword and closes on the statement-terminating `.`; every other scan in
 * this function stays single-line because its keyword and target already
 * share a line in practice (see the class comment above), but that is not
 * true for `SELECT`. The Open-SQL `FROM @<var>` host-variable escape (reading
 * from an internal table, not a database table) is filtered the same way
 * every other candidate name is: `isCandidateGlobalName` rejects the leading
 * `@`, which is not a valid identifier character. Skipped entirely for CDS
 * source (see `looksLikeCdsSource`), where `select from <entity>` is DDL
 * projection syntax, not an Open SQL read.
 */
export function scanDependencies(
  source: string,
  opts?: { readonly selfName?: string },
): DigestDependency[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const found: Array<{ name: string; via: string }> = [];
  const add = (name: string | undefined, via: string) => {
    if (!name) return;
    found.push({ name: name.toUpperCase(), via });
  };
  const namesFromCommaList = (rest: string): string[] =>
    rest
      .split(",")
      .map((seg) => /^\s*([/\w]+)/.exec(seg)?.[1])
      .filter((n): n is string => Boolean(n));

  const isCds = looksLikeCdsSource(source);
  let inSelect = false;

  for (const raw of lines) {
    const code = abapCodeOf(raw);
    if (!code.trim()) continue;

    const inheriting = /\binheriting\s+from\s+([/\w]+)/i.exec(code);
    if (inheriting?.[1]) add(inheriting[1], "superclass");

    // `INTERFACES <name>[, <name>]*.` — the implementing statement, never
    // `INTERFACE <name>.` (the definition keyword), which this word-boundary
    // pattern does not match ("interfaces" and "interface" are different
    // tokens).
    const interfaces = /\binterfaces\s*:?\s*(.+)/i.exec(code);
    if (interfaces?.[1]) {
      for (const n of namesFromCommaList(interfaces[1])) add(n, "interface");
    }

    const typeRefRe = /\btype\s+ref\s+to\s+([/\w]+)/gi;
    let m: RegExpExecArray | null;
    while ((m = typeRefRe.exec(code))) {
      if (m[1] && isCandidateGlobalName(m[1])) add(m[1], "type");
    }

    // Plain `TYPE <name>` — deliberately a single token immediately after
    // the keyword, so `TYPE STANDARD TABLE OF zcl_foo` stops at `standard`
    // (a builtin, filtered) rather than reaching `zcl_foo`. This is the
    // issue's stated rule, not an oversight — the digest is a heuristic
    // orientation aid, not a type resolver.
    const typeRe = /\btype\s+(?!ref\s+to\b)([/\w]+)/gi;
    while ((m = typeRe.exec(code))) {
      if (m[1] && isCandidateGlobalName(m[1])) add(m[1], "type");
    }

    if (/\bcall\s+function\b/i.test(code)) {
      const lit = /\bcall\s+function\s+'([^']+)'/i.exec(raw);
      if (lit?.[1]) add(lit[1], "function module");
    }

    if (/\bcall\s+transaction\b/i.test(code)) {
      const lit = /\bcall\s+transaction\s+'([^']+)'/i.exec(raw);
      if (lit?.[1]) add(lit[1], "transaction");
    }

    // `SUBMIT (lv_prog).` (a dynamic program name) does not match the
    // identifier character class and is silently skipped — it names no
    // fixed dependency to read.
    const submit = /\bsubmit\s+([/\w]+)/i.exec(code);
    if (submit?.[1]) add(submit[1], "submit");

    // `<NAME>=>` — static class/interface component access, the one operator
    // that names its target directly. `<NAME>->` is an instance reference:
    // what sits before the arrow is a variable, and its declared type is not
    // recoverable from this line alone without a symbol table — almost every
    // occurrence is a local (see LOCAL_PREFIXES), and the rest can't be told
    // apart from a local by text alone, so `->` is never turned into a
    // dependency here. `me->` and `super->` are skipped explicitly, though
    // they would also fail `isCandidateGlobalName`.
    const staticRe = /\b((?:\/\w+\/)?[A-Za-z_][A-Za-z0-9_]*)\s*=>/g;
    while ((m = staticRe.exec(code))) {
      const name = m[1];
      if (!name) continue;
      const lower = name.toLowerCase();
      if (lower === "me" || lower === "super") continue;
      if (isCandidateGlobalName(name)) add(name, "class");
    }

    // `INCLUDE <program>.` — the classic-report include statement. Only the
    // fixed-name form matches; `INCLUDE (lv_prog).` (a dynamic include) is
    // silently skipped, the same treatment `SUBMIT` gets above.
    const include = /^\s*include\s+([/\w]+)/i.exec(code);
    if (include?.[1] && isCandidateGlobalName(include[1])) add(include[1], "INCLUDE");

    if (!isCds) {
      // `(?!-)` excludes `SELECT-OPTIONS`/`SELECT-ENDSELECT`-shaped tokens —
      // `\bselect\b` alone still matches "select" inside them, since `-` is
      // a word boundary too.
      if (/\bselect\b(?!-)/i.test(code)) inSelect = true;
      if (inSelect) {
        const fromRe = /\bfrom\s+(@?[/\w]+)/gi;
        while ((m = fromRe.exec(code))) {
          if (m[1] && isCandidateGlobalName(m[1])) add(m[1], "SELECT FROM");
        }
        const joinRe = /\bjoin\s+([/\w]+)/gi;
        while ((m = joinRe.exec(code))) {
          if (m[1] && isCandidateGlobalName(m[1])) add(m[1], "SELECT FROM");
        }
      }
      // A bare `.` (outside a literal — `abapCodeOf` already blanked those)
      // ends the statement `inSelect` is tracking.
      if (code.includes(".")) inSelect = false;
    }
  }

  const selfUpper = opts?.selfName?.toUpperCase();
  const byName = new Map<string, string>();
  for (const f of found) {
    if (selfUpper && f.name === selfUpper) continue;
    if (!byName.has(f.name)) byName.set(f.name, f.via); // keep the FIRST via seen
  }

  return [...byName.entries()]
    .map(([name, via]) => ({ name, via, readCall: readCallFor(name, via) }))
    .sort((a, b) => (a.via === b.via ? a.name.localeCompare(b.name) : a.via.localeCompare(b.via)));
}

// ---------------------------------------------------------------------------
// Program interface scan (PROG/P's "public API").
// ---------------------------------------------------------------------------

export interface ProgramInterface {
  parameters: string[];
  selectOptions: string[];
  forms: string[];
  hasStartOfSelection: boolean;
}

/**
 * `PARAMETERS`/`SELECT-OPTIONS`/`FORM`/`START-OF-SELECTION` — a plain
 * line-by-line scan over `abapCodeOf` output, not a statement-joining one:
 * each of these declarations conventionally opens on its own line, and a
 * report's selection screen is exactly the kind of thing worth summarising
 * loosely rather than parsing exactly.
 */
export function scanProgramInterface(source: string): ProgramInterface {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const parameters: string[] = [];
  const selectOptions: string[] = [];
  const forms: string[] = [];
  let hasStartOfSelection = false;

  const namesFrom = (rest: string): string[] =>
    rest
      .split(",")
      .map((seg) => /^\s*([/\w]+)/.exec(seg)?.[1])
      .filter((n): n is string => Boolean(n));

  for (const raw of lines) {
    const code = abapCodeOf(raw);
    if (!code.trim()) continue;

    const p = /^\s*parameters\s*:?\s*(.+)/i.exec(code);
    if (p?.[1]) parameters.push(...namesFrom(p[1]));

    const s = /^\s*select-options\s*:?\s*(.+)/i.exec(code);
    if (s?.[1]) selectOptions.push(...namesFrom(s[1]));

    const f = /^\s*form\s+([/\w]+)/i.exec(code);
    if (f?.[1]) forms.push(f[1]);

    if (/^\s*start-of-selection\b/i.test(code)) hasStartOfSelection = true;
  }

  return { parameters, selectOptions, forms, hasStartOfSelection };
}

// ---------------------------------------------------------------------------
// Test class count.
// ---------------------------------------------------------------------------

/**
 * Joins `source` into `.`-terminated statements over `abapCodeOf` output, so
 * a `FOR TESTING` addition on a continuation line still counts — a real
 * `testclasses` include commonly reads:
 *
 *   CLASS ltc_foo DEFINITION
 *     FOR TESTING
 *     RISK LEVEL HARMLESS
 *     DURATION SHORT.
 *
 * A bare `split(".")` is used rather than a real tokenizer: the only
 * statements this function cares about are `CLASS ... DEFINITION ...`
 * headers, which never carry an unquoted decimal literal, so the one case a
 * naive period-split gets wrong (a number like `1.5` outside a string) never
 * arises here.
 */
function splitStatements(source: string): string[] {
  const joined = source
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(abapCodeOf)
    .join("\n");
  return joined
    .split(".")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

const CLASS_DEFINITION_FOR_TESTING_RE = /\bclass\s+[/\w]+\s+definition\b[\s\S]*\bfor\s+testing\b/i;

/** How many `CLASS ... DEFINITION ... FOR TESTING` classes a testclasses include declares. */
export function countTestClasses(testIncludeSource: string): number {
  return splitStatements(testIncludeSource).filter((s) => CLASS_DEFINITION_FOR_TESTING_RE.test(s))
    .length;
}

// ---------------------------------------------------------------------------
// Public API summary from an outline.
// ---------------------------------------------------------------------------

/**
 * `classComponents` (via `flattenComponents`) returns every sub-object ADT
 * tracks, including declarative kinds like a `TYPES` statement — real ADT
 * type code `CLAS/OT` (confirmed against a live class; see
 * test/fixtures/live-captured/954-i91-elementinfo-type.xml, which carries
 * the same code for a local type). `renderOutline` (src/adt/source.ts) never
 * shows these to a human — it lists only `CLAS/OM`/`INTF/OM`/`CLAS/OA` — so a
 * private `TYPES` declaration was inflating `hiddenCounts` past what
 * `abap_read {outline:true}` shows as private (issue #108 defect 6: a class
 * with one private method and one private `TYPES` line reported "2 private
 * component(s) not listed" where outline shows exactly one). Excluded here
 * for the same reason a member with no visibility is excluded below: not
 * part of the API surface a human reading the digest would recognise.
 */
const NON_API_COMPONENT_KINDS = new Set(["CLAS/OT", "INTF/OT"]);

/**
 * Public components become listed rows; private/protected components are
 * counted, not named, per issue #110 — a digest is a bounded page, and a
 * large class's private section is exactly the kind of detail a one-page
 * summary must not spend rows on.
 */
export function summarisePublicApi(members: readonly ClassMember[]): DigestPublicApi {
  const rows: Array<{ name: string; kind: string; detail?: string }> = [];
  const hidden = new Map<string, number>();

  for (const m of members) {
    if (NON_API_COMPONENT_KINDS.has(m.type)) continue;
    const visibility = (m.visibility ?? "").toLowerCase();
    if (visibility === "public") {
      const detailParts = [m.level, m.redefinition ? "redefinition" : undefined].filter(
        (v): v is string => Boolean(v),
      );
      rows.push({
        name: m.name,
        kind: m.type,
        ...(detailParts.length ? { detail: detailParts.join(" ") } : {}),
      });
    } else if (visibility) {
      hidden.set(visibility, (hidden.get(visibility) ?? 0) + 1);
    }
    // A member with no recorded visibility (rare — some component kinds
    // carry none) is neither listed nor counted: it is not known to be
    // public, so listing it would overstate the API surface.
  }

  return {
    rows,
    hiddenCounts: [...hidden.entries()].map(([visibility, count]) => ({ visibility, count })),
  };
}

// ---------------------------------------------------------------------------
// Function module signature (FUGR/FF's "public API") and CDS field list
// (DDLS/DF's "public API") — issue #110 names both explicitly, and neither
// is covered by `classMembers`/`summarisePublicApi` above (outline-based,
// CLAS/INTF only) or `scanProgramInterface` (PROG/P selection-screen only).
// Both read the source ADT already returned for the dependency scan — no
// extra call.
// ---------------------------------------------------------------------------

export interface FunctionParameter {
  readonly kind: "IMPORTING" | "EXPORTING" | "CHANGING" | "TABLES" | "EXCEPTIONS";
  readonly name: string;
  readonly typing: string; // "TYPE ZKEY", "STRUCTURE ZROW", "" for an exception
  readonly optional: boolean; // true when the line carries DEFAULT or OPTIONAL
}

/** `IMPORTING`/`EXPORTING`/`CHANGING`/`TABLES`/`EXCEPTIONS`, alone on its own comment line. */
const FM_SECTION_KEYWORD_RE = /^(IMPORTING|EXPORTING|CHANGING|TABLES|EXCEPTIONS)\s*$/i;

/**
 * The header line ADT's function-module source carries above the parameter
 * list, in the two forms actually seen: a single `*"` prefix ("Local
 * Interface:") or the doubled `*"*"` prefix ADT's own generator produces
 * ("Local interface:", note the different casing convention across sources —
 * matched case-insensitively here for that reason).
 */
const FM_INTERFACE_HEADER_RE = /^\*"(?:\*")?\s*local\s+interface\s*:?\s*$/i;

/** A line's content is the closing `*"----...----` rule that ends the block. */
const FM_RULE_RE = /^-+$/;

/**
 * One parameter/exception line's content (the comment prefix already
 * stripped) into a name/typing/optional triple, or `undefined` when the line
 * doesn't have the expected shape. Handles both the `VALUE(...)`/
 * `REFERENCE(...)`-wrapped form IMPORTING/EXPORTING/CHANGING carry and the
 * bare-name form TABLES/EXCEPTIONS carry.
 */
function parseFmParamLine(content: string): { name: string; typing: string; optional: boolean } | undefined {
  const wrapped = /^(?:VALUE|REFERENCE)\(([^)]+)\)\s*(.*)$/i.exec(content);
  const bare = wrapped ? undefined : /^([/\w]+)\s*(.*)$/.exec(content);
  const name = (wrapped?.[1] ?? bare?.[1])?.trim();
  const rest = wrapped?.[2] ?? bare?.[2] ?? "";
  if (!name) return undefined;

  const optional = /\b(default|optional)\b/i.test(rest);
  const typing = rest
    .replace(/\bdefault\b.*$/i, "")
    .replace(/\boptional\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return { name, typing, optional };
}

/**
 * Scans ADT's generated function-module interface comment block —
 * `*"*"Local Interface:` through the closing `*"----...` rule — for its
 * IMPORTING/EXPORTING/CHANGING/TABLES/EXCEPTIONS parameters, in source
 * order. Returns `[]` when `source` carries no such block; that is a normal
 * outcome (a malformed or hand-edited FM source, or a non-FM source passed
 * in by mistake), not an error worth throwing over.
 */
export function scanFunctionInterface(source: string): readonly FunctionParameter[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const startIdx = lines.findIndex((l) => FM_INTERFACE_HEADER_RE.test(l.trim()));
  if (startIdx === -1) return [];

  const params: FunctionParameter[] = [];
  let currentKind: FunctionParameter["kind"] | undefined;

  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.startsWith('*"')) break; // left the comment block entirely
    const content = line.slice(2).trim();
    if (FM_RULE_RE.test(content)) break; // the closing rule

    const kindMatch = FM_SECTION_KEYWORD_RE.exec(content);
    if (kindMatch) {
      currentKind = kindMatch[1]!.toUpperCase() as FunctionParameter["kind"];
      continue;
    }
    if (!content || !currentKind) continue; // blank filler line, or text before the first section keyword

    const parsed = parseFmParamLine(content);
    if (!parsed) continue;
    params.push({ kind: currentKind, name: parsed.name, typing: parsed.typing, optional: parsed.optional });
  }

  return params;
}

/** Strip one leading `@Annotation.path: value` clause or `key` keyword from a CDS select-list entry. */
function stripCdsEntryPrefixes(entry: string): string {
  let e = entry.trim();
  for (;;) {
    const ann = /^@[\w.]+\s*:\s*(?:'[^']*'|[^\s]+)\s*/i.exec(e);
    if (ann) {
      e = e.slice(ann[0].length).trim();
      continue;
    }
    const key = /^key\b\s*/i.exec(e);
    if (key) {
      e = e.slice(key[0].length).trim();
      continue;
    }
    return e;
  }
}

/**
 * `source` with `--`-to-end-of-line CDS comments cut, outside quotes. Does
 * NOT handle CDS block comments (slash-star ... star-slash) — deliberately:
 * no fixture this digest targets uses one, and a partial handler would be
 * worse than none.
 */
function stripCdsLineComments(source: string): string {
  return source
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      let out = "";
      let inString = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i] as string;
        if (inString) {
          out += ch;
          if (ch === "'") inString = false;
          continue;
        }
        if (ch === "'") {
          inString = true;
          out += ch;
          continue;
        }
        if (ch === "-" && line[i + 1] === "-") break;
        out += ch;
      }
      return out;
    })
    .join("\n");
}

/** A select-list entry that is confidently a plain (possibly qualified, possibly aliased) field reference. */
const CDS_FIELD_ENTRY_RE = /^([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?(?:\s+as\s+([A-Za-z_]\w*))?$/i;

/**
 * Extracts the projected field list from a `DDLS/DF` (CDS view) source: the
 * identifiers in the top-level select list between the `{` after `select
 * from` and its matching `}`, with `as <alias>` resolved to the alias and
 * `key`/`@Annotation` prefixes stripped.
 *
 * Deliberately narrow — a wrong field list is worse than an empty one — so
 * this gives up (returns `[]` for the WHOLE view, not just the one entry) as
 * soon as it meets anything it isn't confident about:
 *   - no `select from` or no balanced `{...}` after it: not recognisable as
 *     a projection list at all;
 *   - an association reference exposed bare in the list (by the near-universal
 *     ABAP CDS convention, a leading `_`, e.g. `_Text`) rather than navigated
 *     through (`_text.description`): a whole association, not a scalar field,
 *     and this function only names fields;
 *   - any entry that isn't a plain `[table.]field[ as alias]` shape — a cast,
 *     a function call, a sub-select, a parameterised/filtered association
 *     (`_Assoc[1: x = 1]`), string concatenation, and similar computed
 *     expressions all fall here and are NOT resolved.
 * Nested `{}`/`()`/`[]` are still depth-tracked while splitting entries (so
 * an annotation's own `{...}` value or a function call's `(a, b)` doesn't
 * fracture the split), even though the entries that contain them are then
 * rejected by the shape check above.
 */
export function scanCdsFields(source: string): readonly string[] {
  const cleaned = stripCdsLineComments(source);
  const fromIdx = cleaned.search(/\bfrom\b/i);
  if (fromIdx === -1) return [];
  const braceStart = cleaned.indexOf("{", fromIdx);
  if (braceStart === -1) return [];

  let depth = 0;
  let braceEnd = -1;
  for (let i = braceStart; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        braceEnd = i;
        break;
      }
    }
  }
  if (braceEnd === -1) return [];

  const body = cleaned.slice(braceStart + 1, braceEnd);
  const entries: string[] = [];
  let cur = "";
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  for (const ch of body) {
    if (ch === "{") braceDepth++;
    else if (ch === "}") braceDepth--;
    else if (ch === "(") parenDepth++;
    else if (ch === ")") parenDepth--;
    else if (ch === "[") bracketDepth++;
    else if (ch === "]") bracketDepth--;
    if (ch === "," && braceDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
      entries.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) entries.push(cur);

  const fields: string[] = [];
  for (const raw of entries) {
    const normalised = raw.replace(/\s+/g, " ").trim();
    if (!normalised) continue;
    const stripped = stripCdsEntryPrefixes(normalised);
    if (!stripped) return [];

    const m = CDS_FIELD_ENTRY_RE.exec(stripped);
    if (!m) return [];
    const base = m[1] ?? "";
    if (base.startsWith("_")) return []; // bare association reference, not a field
    const qualified = m[2];
    const alias = m[3];
    fields.push((alias ?? qualified ?? base).toUpperCase());
  }

  return fields;
}

// ---------------------------------------------------------------------------
// Section renderer.
// ---------------------------------------------------------------------------

export const DIGEST_MAX_ROWS_PER_SECTION = 25;

const SECTION_TITLES = {
  header: "HEADER",
  publicApi: "PUBLIC API",
  dependencies: "DIRECT DEPENDENCIES",
  tests: "TESTS AND CHECKS",
  history: "RECENT HISTORY",
  nextSteps: "WHERE TO GO NEXT",
} as const;

interface RenderedTable {
  content: string;
  /** Set when rows were cut; the note pushed for this section reuses it. */
  truncation?: { shown: number; total: number };
}

/**
 * Renders one tabular section, cutting to `maxRows` and appending the
 * `--- TRUNCATED ---` marker (the same convention `compact.ts`'s
 * `buildResponse` uses) when the section itself — not the whole response —
 * overflows its row budget.
 */
function renderTable(
  rows: Array<Record<string, string>>,
  columns: string[],
  opts: { maxRows: number; sectionTitle: string; fullCallLine: string; emptyText: string },
): RenderedTable {
  if (rows.length === 0) return { content: opts.emptyText };
  if (rows.length <= opts.maxRows) return { content: textTable(rows, columns) };

  const shown = rows.slice(0, opts.maxRows);
  const marker =
    `--- TRUNCATED --- ${opts.sectionTitle} cut after ${opts.maxRows} of ${rows.length} rows; ` +
    opts.fullCallLine;
  return {
    content: `${textTable(shown, columns)}\n${marker}`,
    truncation: { shown: opts.maxRows, total: rows.length },
  };
}

/** De-duplicate consecutive same-version entries, the way `readHistory` (`src/tools/read.ts`) does for the raw feed. */
function dedupeConsecutiveVersions(
  history: readonly DigestHistoryEntry[],
): DigestHistoryEntry[] {
  const out: DigestHistoryEntry[] = [];
  for (const h of history) {
    const prev = out[out.length - 1];
    if (prev && prev.version === h.version) continue;
    out.push(h);
  }
  return out;
}

export function buildDigestSections(
  input: DigestInput,
  opts: { readonly maxRowsPerSection: number },
): { sections: Array<{ title: string; content: string }>; notes: string[] } {
  const notes: string[] = [];
  const name = input.header.name;

  // ---- HEADER --------------------------------------------------------
  const headerLines = [
    `type: ${input.header.type}`,
    `name: ${input.header.name}`,
    input.header.packageName !== undefined ? `package: ${input.header.packageName}` : undefined,
    input.header.description !== undefined ? `description: ${input.header.description}` : undefined,
    input.header.responsible !== undefined ? `responsible: ${input.header.responsible}` : undefined,
    input.header.lastChanged !== undefined
      ? `last changed: ${input.header.lastChanged} (source: ${input.header.lastChangedSource})`
      : undefined,
    input.header.activationState !== undefined
      ? `activation: ${input.header.activationState}`
      : undefined,
  ].filter((l): l is string => l !== undefined);

  if (input.header.lastChangedSource === "active") {
    notes.push(`${input.header.type} ${input.header.name} ${NO_RELEASED_HISTORY_EXPLANATION}`);
  }

  // ---- PUBLIC API ------------------------------------------------------
  const apiRows = input.publicApi.rows.map((r) => ({
    name: r.name,
    kind: r.kind,
    detail: r.detail ?? "",
  }));
  const apiRendered = renderTable(apiRows, ["name", "kind", "detail"], {
    maxRows: opts.maxRowsPerSection,
    sectionTitle: SECTION_TITLES.publicApi,
    fullCallLine: `abap_read {"object":"${name}","outline":true}`,
    emptyText: "(no public components found by the outline scan)",
  });
  const hiddenLines = input.publicApi.hiddenCounts.map(
    (h) => `${h.count} ${h.visibility} component(s) not listed`,
  );
  const apiContent = [apiRendered.content, ...hiddenLines].filter(Boolean).join("\n");
  if (apiRendered.truncation) {
    notes.push(
      `${SECTION_TITLES.publicApi}: showed ${apiRendered.truncation.shown} of ` +
        `${apiRendered.truncation.total} public rows; abap_read {"object":"${name}","outline":true} ` +
        "has the rest.",
    );
  }
  if (input.publicApi.truncatedRows) {
    notes.push(
      `${SECTION_TITLES.publicApi}: ${input.publicApi.truncatedRows} row(s) were already dropped ` +
        "before this digest was built.",
    );
  }

  // ---- DIRECT DEPENDENCIES ----------------------------------------------
  const depRows = input.dependencies.map((d) => ({
    name: d.name,
    via: d.via,
    "read call": d.readCall,
  }));
  const depRendered = renderTable(depRows, ["name", "via", "read call"], {
    maxRows: opts.maxRowsPerSection,
    sectionTitle: SECTION_TITLES.dependencies,
    // No single call returns the full dependency list — it is derived here
    // by a static scan, not served by any ADT endpoint. Naming the object's
    // own source read is the closest thing to "get the rest".
    fullCallLine: `no single call returns the full list; abap_read {"object":"${name}"} reads the ` +
      "full source to check the rest by hand",
    emptyText: "(no direct dependencies found by the static scan)",
  });
  if (depRendered.truncation) {
    notes.push(
      `${SECTION_TITLES.dependencies}: showed ${depRendered.truncation.shown} of ` +
        `${depRendered.truncation.total} rows; no single call returns the rest — read the full ` +
        `source with abap_read {"object":"${name}"}.`,
    );
  }

  // ---- TESTS AND CHECKS ---------------------------------------------
  const testsLines = [
    `test include: ${input.tests.hasTestInclude ? "present" : "absent"}`,
    `FOR TESTING classes declared: ${input.tests.testClassCount}`,
    "Tests are not run in this session.",
    `run tests: ${input.tests.testCall}`,
    `run ATC checks: ${input.tests.atcCall}`,
  ];

  // ---- RECENT HISTORY --------------------------------------------------
  const dedupedHistory = dedupeConsecutiveVersions(input.history).slice(0, 3);
  const histRows = dedupedHistory.map((h) => ({
    version: h.version,
    date: h.date ?? "",
    author: h.author ?? "",
    note: h.note ?? "",
  }));
  const histRendered = renderTable(histRows, ["version", "date", "author", "note"], {
    maxRows: opts.maxRowsPerSection,
    sectionTitle: SECTION_TITLES.history,
    fullCallLine: `abap_read {"object":"${name}","view":"history"}`,
    emptyText: "(no history entries)",
  });
  if (histRendered.truncation) {
    notes.push(
      `${SECTION_TITLES.history}: showed ${histRendered.truncation.shown} of ` +
        `${histRendered.truncation.total} rows; abap_read {"object":"${name}","view":"history"} ` +
        "has the rest.",
    );
  }

  // ---- WHERE TO GO NEXT -------------------------------------------------
  const nextStepsContent = input.nextSteps.map((s) => `- ${s}`).join("\n");

  // Where-used is never fetched by the digest — see the module comment for
  // why. Named here once, regardless of which section a caller might expect it in.
  notes.push(
    `Where-used is not fetched: ADT's usageReferences endpoint is unbounded and can take 20+ ` +
      `seconds on wide fan-in. Run it explicitly with abap_search {"query":"${name}","mode":"where_used"}.`,
  );

  return {
    sections: [
      { title: SECTION_TITLES.header, content: headerLines.join("\n") },
      { title: SECTION_TITLES.publicApi, content: apiContent },
      { title: SECTION_TITLES.dependencies, content: depRendered.content },
      { title: SECTION_TITLES.tests, content: testsLines.join("\n") },
      { title: SECTION_TITLES.history, content: histRendered.content },
      { title: SECTION_TITLES.nextSteps, content: nextStepsContent },
    ],
    notes,
  };
}
