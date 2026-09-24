/**
 * Write footprint: a static scan of an object's source for statements that
 * write to the database, commit/rollback the current LUW, or hand off to
 * something that plausibly does (CALL TRANSACTION, SUBMIT, BOPF, native
 * SQL/ADBC). Answers "what could this object write, and does it commit its
 * own work" without running anything.
 *
 * Pure scanner + renderer only — no zod, no tool registration, no MCP
 * concerns. `buildFootprint` is the one function that touches the network
 * (via `readSource`); `scanFootprint` and `renderFootprint` are pure and
 * unit-testable on fixture text alone.
 *
 * Ground truth: test/fixtures/live-captured/983-i107-source-z-i107-footprint.txt,
 * a live-captured `REPORT z_i107_footprint.` with 14 real write/commit/
 * dispatch statements and 2 commented-out writes (one a whole-line `*`
 * comment, one a trailing `"` comment) that must NOT be reported. Every
 * detection rule below is checked against that fixture; anything not
 * exercised there (EXEC SQL, ADBC, BOPF) is built from the ABAP language
 * rules alone and flagged as such — see `renderFootprint`'s fixed notes.
 */
import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import type { ResolvedObject } from "./resolve.js";
import { abapCodeOf, readSource, scanMethodBlocks, type SourceTarget } from "./source.js";
import { buildUri, CLASS_INCLUDES, specForType, type TypeSpec } from "./types.js";
import { textTable } from "../compact.js";

export const FOOTPRINT_TYPES = ["PROG/P", "CLAS/OC", "FUGR/F", "FUGR/FF"] as const;

export type FootprintKind =
  | "insert"
  | "update"
  | "modify"
  | "delete"
  | "update task"
  | "background task"
  | "commit"
  | "rollback"
  | "bopf modify"
  | "native sql"
  | "adbc"
  | "export to database"
  | "call transaction"
  | "submit";

export interface FootprintOccurrence {
  readonly kind: FootprintKind;
  readonly table?: string;
  readonly unresolved?: string;
  readonly detail?: string;
  readonly include: string;
  readonly line: number;
  readonly statement: string;
  readonly readCall: string;
}

export interface FootprintResult {
  readonly object: string;
  readonly includes: readonly string[];
  readonly occurrences: readonly FootprintOccurrence[];
  readonly linesScanned: number;
  readonly commitFound: boolean;
  readonly writesOnlyViaUpdateTask: boolean;
  readonly truncatedAt?: { readonly include: string; readonly line: number };
}

export interface FootprintOptions {
  readonly maxLines?: number;
}

const DEFAULT_MAX_LINES = 20000;

export interface RenderedFootprint {
  readonly header: Record<string, string | number | undefined>;
  readonly body: string;
  readonly notes: string[];
  readonly hints: string[];
}

// ---------------------------------------------------------------------------
// Statement tokenizer
// ---------------------------------------------------------------------------
//
// A "statement" is everything between two ABAP-terminating periods (a `.`
// followed by whitespace or end of line — a decimal point never qualifies,
// since the digit after it is not whitespace). A statement can span several
// physical lines (fixture 983 lines 22-23, 28-30).
//
// Two texts are derived per source line, both via `abapCodeOf` (source.ts) —
// this file does not write its own comment stripper:
//   - `code`: `abapCodeOf(line)` itself — comments cut, string literals
//     blanked to spaces. Used ONLY to find the safe terminating period: a
//     period inside a string literal (there isn't one in ABAP string syntax,
//     literals cannot embed an unescaped quote followed by more literal
//     content spanning a period-like structure across the mask) is blanked
//     out here, so scanning `code` for `.` never mistakes literal content for
//     a statement boundary.
//   - `raw`: `line.slice(0, abapCodeOf(line).length)`. `abapCodeOf` returns a
//     same-length string when a line has no trailing comment, and a SHORTER
//     string when it cuts at a `"` comment — so its `.length` is exactly the
//     safe cut index into the ORIGINAL line. Slicing the original line to
//     that length keeps real literal content (a table name inside quotes, an
//     FM name) intact while still dropping the trailing comment. A whole-line
//     `*` comment yields `code === ""`, so `raw === ""` too — the line
//     contributes nothing (fixture line 39).
//
// Classification runs entirely against `raw` (joined across continuation
// lines), never against the blanked `code` — `code` is discarded once the
// terminating period is found.

interface RawStatement {
  readonly include: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}

function splitStatements(source: string, include: string): RawStatement[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out: RawStatement[] = [];
  let parts: string[] = [];
  let startLine: number | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const code = abapCodeOf(line);
    const raw = line.slice(0, code.length);
    let segStart = 0;

    if (startLine === undefined && raw.trim() !== "") startLine = i + 1;

    for (let j = 0; j < code.length; j++) {
      if (code[j] !== ".") continue;
      const next = code[j + 1];
      if (next !== undefined && !/\s/.test(next)) continue; // decimal point, not a terminator
      const segment = raw.slice(segStart, j + 1);
      parts.push(segment);
      const text = parts.join(" ").replace(/\s+/g, " ").trim();
      if (text !== "" && text !== ".") {
        out.push({ include, startLine: startLine ?? i + 1, endLine: i + 1, text });
      }
      parts = [];
      startLine = undefined;
      segStart = j + 1;
    }

    const rest = raw.slice(segStart);
    if (rest.trim() !== "" && startLine === undefined) startLine = i + 1;
    if (rest !== "") parts.push(rest);
  }
  // A trailing unterminated fragment (no closing period before EOF) is not a
  // complete statement — dropped rather than guessed at.
  return out;
}

// ---------------------------------------------------------------------------
// Statement classification
// ---------------------------------------------------------------------------

interface Classification {
  readonly kind: FootprintKind;
  readonly table?: string;
  readonly unresolved?: string;
  readonly detail?: string;
}

/** `(GV_TAB)` → unresolved (dynamic); `ZDEMO_SOH` → table (static). */
function tableOrDynamic(captured: string): { table?: string; unresolved?: string } {
  const c = captured.trim();
  if (/^\(.+\)$/.test(c)) return { unresolved: c.toUpperCase() };
  return { table: c.toUpperCase() };
}

function cleanFmName(s: string): string {
  return s.replace(/^'+|'+$/g, "").toUpperCase();
}

/**
 * Classify one already-joined, comment-stripped statement (trailing period
 * included). Order is significant in two places, both because a more
 * specific shape would otherwise be swallowed by a more general one:
 *
 *  - `EXPORT ... TO DATABASE` / `DELETE FROM DATABASE` are checked before the
 *    generic Open-SQL EXPORT-less DELETE FROM rule — fixture line 34
 *    (`EXPORT gs_soh TO DATABASE indx(zz) ID 'I107'.`) is not a database
 *    table INSERT/DELETE, and a `DELETE FROM DATABASE <tab>(<area>)` would
 *    otherwise be misparsed by the generic `DELETE FROM <tab>` rule as a
 *    delete from a table literally named "DATABASE".
 *  - CALL FUNCTION '...' IN UPDATE/BACKGROUND TASK, and the two named BAPIs,
 *    are checked before nothing else could catch them, but are listed early
 *    because they are unambiguous keyword sequences with no overlap risk.
 */
function classifyStatement(t: string): Classification | undefined {
  // ---- EXPORT/DELETE ... TO/FROM DATABASE — before generic Open SQL ----
  let m = /^EXPORT\b.*\bTO\s+DATABASE\s+([A-Za-z0-9_]+(?:\([A-Za-z0-9_]+\))?)/i.exec(t);
  if (m) {
    const captured = m[1] as string;
    return { kind: "export to database", ...tableOrDynamic(captured.replace(/\(.*\)$/, "")), detail: captured };
  }
  m = /^DELETE\s+FROM\s+DATABASE\s+([A-Za-z0-9_]+(?:\([A-Za-z0-9_]+\))?)/i.exec(t);
  if (m) {
    const captured = m[1] as string;
    return { kind: "export to database", ...tableOrDynamic(captured.replace(/\(.*\)$/, "")), detail: captured };
  }

  // ---- CALL FUNCTION ... IN UPDATE/BACKGROUND TASK ----
  m = /^CALL\s+FUNCTION\s+(\S+)\s+IN\s+UPDATE\s+TASK\b/i.exec(t);
  if (m) return { kind: "update task", detail: cleanFmName(m[1] as string) };
  m = /^CALL\s+FUNCTION\s+(\S+)\s+IN\s+BACKGROUND\s+TASK\b/i.exec(t);
  if (m) return { kind: "background task", detail: cleanFmName(m[1] as string) };

  // ---- named commit/rollback BAPIs. A trailing `\b` right after an optional
  // closing quote is a bug: `'?NAME'?\b` fails when the quote is present,
  // because both the consumed `'` and the following space are non-word
  // characters, so no boundary exists there. A negative lookahead for a
  // following identifier character does the same disambiguation without
  // that trap. ----
  if (/^CALL\s+FUNCTION\s+'?BAPI_TRANSACTION_COMMIT'?(?![A-Za-z0-9_])/i.test(t)) {
    return { kind: "commit", detail: "BAPI_TRANSACTION_COMMIT" };
  }
  if (/^CALL\s+FUNCTION\s+'?BAPI_TRANSACTION_ROLLBACK'?(?![A-Za-z0-9_])/i.test(t)) {
    return { kind: "rollback", detail: "BAPI_TRANSACTION_ROLLBACK" };
  }

  // ---- COMMIT WORK / ROLLBACK WORK ----
  if (/^COMMIT\s+WORK\b/i.test(t)) return { kind: "commit" };
  if (/^ROLLBACK\s+WORK\b/i.test(t)) return { kind: "rollback" };

  // ---- BOPF. No live-captured fixture exercises this — built from the
  // documented /BOBF/IF_TRA_SERVICE_MANAGER API shape alone, not verified
  // against a real BOPF object. Always disclosed (renderFootprint's notes). ----
  if (/\/BOBF\/IF_TRA_SERVICE_MANAGER\S*->\s*MODIFY\s*\(/i.test(t)) {
    return { kind: "bopf modify", detail: "/BOBF/IF_TRA_SERVICE_MANAGER->MODIFY (no live ground truth)" };
  }

  // ---- EXEC SQL ... ENDEXEC. Native SQL has no ABAP-terminating period
  // inside the block (it terminates with `;`, not `.`), so `splitStatements`
  // naturally joins the whole block into one statement ending at `ENDEXEC.`
  // — no separate block scan needed. Not exercised by fixture 983. ----
  if (/^EXEC\s+SQL\b/i.test(t)) {
    const insM = /\bINSERT\s+INTO\s+([A-Za-z0-9_.$]+)/i.exec(t);
    const updM = /\bUPDATE\s+([A-Za-z0-9_.$]+)/i.exec(t);
    const fromM = /\bFROM\s+([A-Za-z0-9_.$]+)/i.exec(t);
    const intoM = /\bINTO\s+([A-Za-z0-9_.$]+)/i.exec(t);
    const cap = insM?.[1] ?? updM?.[1] ?? fromM?.[1] ?? intoM?.[1];
    return cap
      ? { kind: "native sql", table: cap.toUpperCase() }
      : { kind: "native sql", unresolved: "table not statically resolved from EXEC SQL block" };
  }

  // ---- ADBC: cl_sql_statement / cl_sql_connection. Not exercised by fixture
  // 983 — built from the documented API shape alone. ----
  if (/\bCL_SQL_(STATEMENT|CONNECTION)\S*->\s*EXECUTE_(QUERY|UPDATE|DDL)\s*\(/i.test(t)) {
    const tabM = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([A-Za-z0-9_.$]+)/i.exec(t);
    return tabM
      ? { kind: "adbc", table: (tabM[1] as string).toUpperCase() }
      : { kind: "adbc", unresolved: "table not statically resolved from embedded SQL string" };
  }

  // ---- CALL TRANSACTION / SUBMIT — may write; this scanner cannot know
  // whether the target actually does without executing it. ----
  m = /^CALL\s+TRANSACTION\s+'?([A-Za-z0-9_]+)'?/i.exec(t);
  if (m) return { kind: "call transaction", detail: (m[1] as string).toUpperCase() };
  m = /^SUBMIT\s+(\(?[A-Za-z0-9_]+\)?)/i.exec(t);
  if (m) {
    const rep = m[1] as string;
    return /^\(/.test(rep)
      ? { kind: "submit", unresolved: rep.toUpperCase() }
      : { kind: "submit", detail: rep.toUpperCase() };
  }

  // ---- Open SQL database writes vs. internal-table operations ----
  //
  // ABAP genuinely overloads INSERT/MODIFY/DELETE between database tables
  // and internal tables with different argument shapes for the same verb —
  // a text scanner has no type information (it doesn't know whether `gt_soh`
  // is a database table or a DATA declaration) to disambiguate by anything
  // but keyword POSITION. This is a heuristic, not a parse, checked against
  // fixture 983's shapes only:
  //   - `INSERT <tab> FROM <wa|TABLE itab>.`      -> DB write
  //   - `INSERT INTO <tab> VALUES ...`            -> DB write
  //   - `UPDATE <tab|(dyn)> ...` (not `UPDATE TASK`) -> DB write
  //   - `INSERT INITIAL LINE INTO ...` / `INSERT LINES OF ...` -> itab, excluded
  //   - `INSERT <wa> INTO [TABLE] <itab>.`        -> itab, excluded (INTO
  //     immediately follows the inserted item, not the table name)
  //   - `MODIFY TABLE <itab> FROM <wa>.`          -> itab, excluded (TABLE
  //     immediately after MODIFY)
  //   - `MODIFY <itab> FROM <wa> INDEX ...` / `... TRANSPORTING ...` -> itab, excluded
  //   - `MODIFY <tab> FROM <wa|TABLE itab>.`      -> DB write (no INDEX/TRANSPORTING)
  //   - `DELETE FROM <tab> WHERE ...` / `DELETE <tab> FROM <wa|TABLE itab>.` -> DB write
  //   - `DELETE TABLE <itab> FROM <wa>.` / `DELETE ADJACENT DUPLICATES ...` /
  //     `DELETE <itab> INDEX ...` / `DELETE <itab> WHERE ...` (no FROM)     -> itab, excluded
  // A DELETE shaped some other way is left unclassified rather than guessed
  // at — silence, not a wrong answer.

  m = /^INSERT\s+INTO\s+(\([^()\s]+\)|[A-Za-z0-9_/]+)\s+VALUES\b/i.exec(t);
  if (m) return { kind: "insert", ...tableOrDynamic(m[1] as string) };
  if (/^INSERT\s+(INITIAL\s+LINE|LINES\s+OF)\b/i.test(t)) return undefined;
  m = /^INSERT\s+(\([^()\s]+\)|[A-Za-z0-9_/]+)\s+FROM\b/i.exec(t);
  if (m) return { kind: "insert", ...tableOrDynamic(m[1] as string) };
  if (/^INSERT\s+\S+\s+INTO\b/i.test(t)) return undefined;

  if (!/^UPDATE\s+TASK\b/i.test(t)) {
    m = /^UPDATE\s+(\([^()\s]+\)|[A-Za-z0-9_/]+)(?![A-Za-z0-9_/])/i.exec(t);
    if (m) return { kind: "update", ...tableOrDynamic(m[1] as string) };
  }

  if (/^MODIFY\s+TABLE\s+/i.test(t)) return undefined;
  if (/^MODIFY\b/i.test(t) && /\b(INDEX|TRANSPORTING)\b/i.test(t)) return undefined;
  m = /^MODIFY\s+(\([^()\s]+\)|[A-Za-z0-9_/]+)\s+FROM\b/i.exec(t);
  if (m) return { kind: "modify", ...tableOrDynamic(m[1] as string) };

  m = /^DELETE\s+FROM\s+(\([^()\s]+\)|[A-Za-z0-9_/]+)(?![A-Za-z0-9_/])/i.exec(t);
  if (m) return { kind: "delete", ...tableOrDynamic(m[1] as string) };
  if (/^DELETE\s+TABLE\s+/i.test(t)) return undefined;
  if (/^DELETE\s+ADJACENT\s+DUPLICATES\b/i.test(t)) return undefined;
  m = /^DELETE\s+(\([^()\s]+\)|[A-Za-z0-9_/]+)\s+FROM\b/i.exec(t);
  if (m) return { kind: "delete", ...tableOrDynamic(m[1] as string) };
  if (/^DELETE\s+\S+\s+(INDEX|WHERE)\b/i.test(t)) return undefined;

  return undefined;
}

// ---------------------------------------------------------------------------
// readCall synthesis
// ---------------------------------------------------------------------------
//
// `scanFootprint`'s signature is fixed at `(source, include, objectRef)` —
// `objectRef` carries only `{name, type}`, no parent. For every include
// EXCEPT a FUGR/FF's borrowed group-TOP include, that's enough: `objectRef`
// IS (or names the container of) the include being scanned. The one case
// that doesn't fit — a function MODULE's own objectRef cannot name its
// GROUP — is handled by `buildFootprint` pre-qualifying that one include tag
// as `"GROUP/NAME"` before calling `scanFootprint`; this function treats any
// include containing `/` as already a complete FUGR/I object name.

function buildReadCall(objectRef: { name: string; type: string }, include: string): string {
  if (include === "main") {
    return JSON.stringify({ object: objectRef.name, type: objectRef.type });
  }
  if (objectRef.type === "CLAS/OC" && (CLASS_INCLUDES as readonly string[]).includes(include)) {
    return JSON.stringify({ object: objectRef.name, type: objectRef.type, include });
  }
  if (include.includes("/")) {
    return JSON.stringify({ object: include, type: "FUGR/I" });
  }
  if (objectRef.type === "PROG/P" || objectRef.type === "PROG/I") {
    return JSON.stringify({ object: include, type: "PROG/I" });
  }
  if (objectRef.type === "FUGR/F") {
    return JSON.stringify({ object: `${objectRef.name}/${include}`, type: "FUGR/I" });
  }
  // FUGR/FF: its own include is read via `main` above; any other tag reaching
  // here should already have been pre-qualified with a `/` by buildFootprint.
  // Kept as a labelled fallback rather than a crash if that assumption ever
  // slips.
  return JSON.stringify({ object: include, type: "FUGR/I" });
}

// ---------------------------------------------------------------------------
// Pure scan entry point
// ---------------------------------------------------------------------------

export function scanFootprint(
  source: string,
  include: string,
  objectRef: { name: string; type: string },
): FootprintOccurrence[] {
  const statements = splitStatements(source, include);
  const readCall = buildReadCall(objectRef, include);
  const out: FootprintOccurrence[] = [];
  for (const stmt of statements) {
    const hit = classifyStatement(stmt.text);
    if (!hit) continue;
    out.push({
      kind: hit.kind,
      ...(hit.table !== undefined ? { table: hit.table } : {}),
      ...(hit.unresolved !== undefined ? { unresolved: hit.unresolved } : {}),
      ...(hit.detail !== undefined ? { detail: hit.detail } : {}),
      include,
      line: stmt.startLine,
      statement: stmt.text,
      readCall,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Include resolution (buildFootprint)
// ---------------------------------------------------------------------------

interface IncludeEntry {
  /** Tag passed to `scanFootprint`/`buildReadCall` — may be `"GROUP/NAME"`. */
  readonly include: string;
  /** What appears in `FootprintResult.includes` — annotated when unreadable. */
  readonly label: string;
  /** Present only when the include was read successfully. */
  readonly source?: string;
}

function subTarget(spec: TypeSpec, name: string, system: string, parent?: string): SourceTarget {
  const uri = buildUri(spec, name, parent);
  return {
    system,
    type: spec.type,
    kind: spec.kind,
    label: spec.label,
    name,
    uri,
    sourceUri: `${uri}/source/main`,
    ...(parent !== undefined ? { parent } : {}),
    mode: spec.mode,
    activation: "unknown",
    spec,
  };
}

/**
 * `INCLUDE <name>.` statements in a source text, comment-stripped via the
 * same `abapCodeOf` cut-length invariant `splitStatements` uses (see its
 * header comment) — not a second comment stripper. Generic to any
 * INCLUDE-bearing source (PROG/P, FUGR/F, FUGR/I); write.ts's
 * `assertFunctionGroupImplementationInclude` documents the FUGR/F-specific
 * TOP/UXX/U01/U02 structure this feeds into for `resolveFunctionGroupIncludes`.
 */
function findIncludeNames(source: string): string[] {
  const names: string[] = [];
  const re = /\bINCLUDE\s+([A-Za-z0-9_/]+)/gi;
  for (const line of source.replace(/\r\n/g, "\n").split("\n")) {
    const raw = line.slice(0, abapCodeOf(line).length);
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) names.push((m[1] as string).toUpperCase());
  }
  return names;
}

async function resolveClassIncludes(conn: AbapConnection, obj: ResolvedObject): Promise<IncludeEntry[]> {
  const out: IncludeEntry[] = [];
  for (const inc of CLASS_INCLUDES) {
    try {
      const { source } = await readSource(conn, obj, inc);
      out.push({ include: inc, label: inc, source });
    } catch {
      // A missing include (no test class, no macros) is normal for a class —
      // readSource still throws NOT_FOUND for it (source.ts's inc!=="main"
      // 404 handling) — so it's not an error here, just absent.
      out.push({ include: inc, label: `${inc} (not found)` });
    }
  }
  return out;
}

/**
 * PROG/P: main source plus every `INCLUDE` it names, resolved ONE level
 * (an include's own includes are not followed). One level is enough to cover
 * the common "one screen of includes" shape and keeps the read count bounded
 * without a full recursive crawl; a program whose includes themselves
 * INCLUDE further programs will show those nested names as plain (unscanned)
 * text inside the level-1 include's source instead of as their own entry.
 */
async function resolveProgramIncludes(conn: AbapConnection, obj: ResolvedObject): Promise<IncludeEntry[]> {
  const out: IncludeEntry[] = [];
  const { source: mainSource } = await readSource(conn, obj);
  out.push({ include: "main", label: "main", source: mainSource });

  const spec = specForType("PROG/I") as TypeSpec;
  for (const name of findIncludeNames(mainSource)) {
    try {
      const { source } = await readSource(conn, subTarget(spec, name, obj.system));
      out.push({ include: name, label: name, source });
    } catch {
      out.push({ include: name, label: `${name} (unreadable)` });
    }
  }
  return out;
}

/**
 * FUGR/F: the group's own `/source/main` (an include LIST, not ABAP code —
 * see write.ts's `assertFunctionGroupImplementationInclude`), plus a 2-level
 * BFS over its INCLUDE statements. SE37 generates `INCLUDE L<GROUP>TOP.`
 * then `INCLUDE L<GROUP>UXX.`; UXX is itself the SAP-generated include that
 * pulls in the per-module implementation includes (`L<GROUP>U01`, `U02`, …)
 * — one level would miss every function module body, so this goes one level
 * deeper than `resolveProgramIncludes`. Two levels is where that document
 * says the chain bottoms out; not followed further.
 */
async function resolveFunctionGroupIncludes(conn: AbapConnection, obj: ResolvedObject): Promise<IncludeEntry[]> {
  const out: IncludeEntry[] = [];
  const { source: mainSource } = await readSource(conn, obj);
  out.push({ include: "main", label: "main", source: mainSource });

  const spec = specForType("FUGR/I") as TypeSpec;
  const seen = new Set<string>();
  const level1Sources: string[] = [];
  for (const name of findIncludeNames(mainSource)) {
    seen.add(name);
    try {
      const { source } = await readSource(conn, subTarget(spec, name, obj.system, obj.name));
      out.push({ include: name, label: name, source });
      level1Sources.push(source);
    } catch {
      out.push({ include: name, label: `${name} (unreadable)` });
    }
  }

  for (const src of level1Sources) {
    for (const name of findIncludeNames(src)) {
      if (seen.has(name)) continue;
      seen.add(name);
      try {
        const { source } = await readSource(conn, subTarget(spec, name, obj.system, obj.name));
        out.push({ include: name, label: name, source });
      } catch {
        out.push({ include: name, label: `${name} (unreadable)` });
      }
    }
  }
  return out;
}

/**
 * FUGR/FF: the function module's own body (its `/source/main`, read as
 * `obj` directly — the module IS the object here, not a sub-include) plus
 * its group's TOP include (global data/constants the module's statements may
 * reference). Not the group's full include tree — a single module has no
 * need to scan every OTHER module's implementation include. The TOP
 * include's tag is pre-qualified as `"GROUP/NAME"` (see `buildReadCall`'s
 * comment) since `objectRef` passed to `scanFootprint` names the MODULE, not
 * the group, and cannot otherwise carry the group needed to read it back.
 */
async function resolveFunctionModuleIncludes(conn: AbapConnection, obj: ResolvedObject): Promise<IncludeEntry[]> {
  const out: IncludeEntry[] = [];
  const { source: ownSource } = await readSource(conn, obj);
  out.push({ include: "main", label: "main", source: ownSource });

  const group = obj.parent;
  if (!group) {
    out.push({
      include: "group-top",
      label: "group's TOP include (unreadable: object has no parent group)",
    });
    return out;
  }

  const fugrSpec = specForType("FUGR/F") as TypeSpec;
  try {
    const { source: groupMain } = await readSource(conn, subTarget(fugrSpec, group, obj.system));
    const topName = findIncludeNames(groupMain).find((n) => n.endsWith("TOP"));
    if (topName) {
      const qualified = `${group}/${topName}`;
      try {
        const incSpec = specForType("FUGR/I") as TypeSpec;
        const { source } = await readSource(conn, subTarget(incSpec, topName, obj.system, group));
        out.push({ include: qualified, label: qualified, source });
      } catch {
        out.push({ include: qualified, label: `${qualified} (unreadable)` });
      }
    }
  } catch {
    out.push({
      include: "group-top",
      label: "group's TOP include (unreadable: could not read group main source)",
    });
  }
  return out;
}

async function resolveIncludesFor(conn: AbapConnection, obj: ResolvedObject): Promise<IncludeEntry[]> {
  switch (obj.type) {
    case "CLAS/OC":
      return resolveClassIncludes(conn, obj);
    case "PROG/P":
      return resolveProgramIncludes(conn, obj);
    case "FUGR/F":
      return resolveFunctionGroupIncludes(conn, obj);
    case "FUGR/FF":
      return resolveFunctionModuleIncludes(conn, obj);
    default:
      // Unreachable given buildFootprint's FOOTPRINT_TYPES guard above every
      // call site — kept as a named refusal rather than an assertion so a
      // future FOOTPRINT_TYPES addition without a matching case here fails
      // loudly instead of falling through silently (G-08).
      throw new AbapError(
        "UNSUPPORTED",
        `Footprint analysis supports ${FOOTPRINT_TYPES.join(", ")} — ${obj.type} is not one of them.`,
        { type: obj.type, supported: [...FOOTPRINT_TYPES] },
      );
  }
}

// ---------------------------------------------------------------------------
// writesOnlyViaUpdateTask heuristic
// ---------------------------------------------------------------------------

const WRITE_KINDS: readonly FootprintKind[] = [
  "insert",
  "update",
  "modify",
  "delete",
  "export to database",
  "bopf modify",
  "native sql",
  "adbc",
];

function isWriteKind(k: FootprintKind): boolean {
  return (WRITE_KINDS as readonly string[]).includes(k);
}

const FORM_OPEN_RE = /^\s*form\s+\S/i;
const ENDFORM_RE = /^\s*endform\s*\./i;

/** FORM/METHOD block line ranges in one include's source (1-based, inclusive). */
function findBlockRanges(source: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const b of scanMethodBlocks(source).blocks) {
    ranges.push({ start: b.startLine, end: b.endLine });
  }

  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let openForm: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const code = abapCodeOf(lines[i] ?? "");
    if (FORM_OPEN_RE.test(code)) {
      if (openForm === undefined) openForm = i + 1;
      continue;
    }
    if (ENDFORM_RE.test(code) && openForm !== undefined) {
      ranges.push({ start: openForm, end: i + 1 });
      openForm = undefined;
    }
  }
  return ranges;
}

/**
 * A conservative, honestly-approximate heuristic — NOT a call graph. `true`
 * means "every direct write found sits inside a FORM/METHOD block, and the
 * object also calls CALL FUNCTION ... IN UPDATE/BACKGROUND TASK somewhere" —
 * consistent with writes only happening inside the update task, but not
 * proof of it: a FORM can equally be called synchronously from mainline
 * code. Verified by hand against fixture 983: its writes (lines 11-14) sit
 * directly in START-OF-SELECTION, not inside any FORM/METHOD, so this
 * correctly returns `false` even though the object ALSO calls
 * `CALL FUNCTION 'RFC_SYSTEM_INFO' IN UPDATE TASK` (line 21).
 */
function computeWritesOnlyViaUpdateTask(
  occurrences: readonly FootprintOccurrence[],
  includeList: readonly IncludeEntry[],
): boolean {
  const hasTaskCall = occurrences.some((o) => o.kind === "update task" || o.kind === "background task");
  if (!hasTaskCall) return false;

  const writes = occurrences.filter((o) => isWriteKind(o.kind));
  if (writes.length === 0) return true;

  const blocksByInclude = new Map<string, Array<{ start: number; end: number }>>();
  for (const entry of includeList) {
    if (entry.source !== undefined) blocksByInclude.set(entry.include, findBlockRanges(entry.source));
  }

  return writes.every((w) => {
    const ranges = blocksByInclude.get(w.include) ?? [];
    return ranges.some((r) => w.line >= r.start && w.line <= r.end);
  });
}

// ---------------------------------------------------------------------------
// buildFootprint
// ---------------------------------------------------------------------------

export async function buildFootprint(
  conn: AbapConnection,
  obj: ResolvedObject,
  opts: FootprintOptions = {},
): Promise<FootprintResult> {
  if (!(FOOTPRINT_TYPES as readonly string[]).includes(obj.type)) {
    throw new AbapError(
      "UNSUPPORTED",
      `Footprint analysis supports ${FOOTPRINT_TYPES.join(", ")} — ${obj.type} is not one of them.`,
      { type: obj.type, supported: [...FOOTPRINT_TYPES] },
      "Read the object directly instead of asking for its write footprint. This is NOT silently " +
        "answered by scanning a different, related object.",
    );
  }
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;

  const objectRef = { name: obj.name, type: obj.type };
  const includeList = await resolveIncludesFor(conn, obj);

  const includes: string[] = [];
  const occurrences: FootprintOccurrence[] = [];
  let linesScanned = 0;
  let truncatedAt: FootprintResult["truncatedAt"];

  for (const entry of includeList) {
    includes.push(entry.label);
    if (truncatedAt) continue; // budget already exhausted — record the marker, scan nothing further
    if (entry.source === undefined) continue; // unreadable — already marked in `includes`

    const entryLines = entry.source.replace(/\r\n/g, "\n").split("\n");
    if (linesScanned + entryLines.length > maxLines) {
      const remaining = Math.max(0, maxLines - linesScanned);
      const partial = entryLines.slice(0, remaining).join("\n");
      occurrences.push(...scanFootprint(partial, entry.include, objectRef));
      linesScanned = maxLines;
      truncatedAt = { include: entry.include, line: remaining + 1 };
      continue;
    }
    occurrences.push(...scanFootprint(entry.source, entry.include, objectRef));
    linesScanned += entryLines.length;
  }

  const commitFound = occurrences.some((o) => o.kind === "commit" || o.kind === "rollback");
  const writesOnlyViaUpdateTask = computeWritesOnlyViaUpdateTask(occurrences, includeList);

  return {
    object: `${obj.type} ${obj.name}`,
    includes,
    occurrences,
    linesScanned,
    commitFound,
    writesOnlyViaUpdateTask,
    ...(truncatedAt ? { truncatedAt } : {}),
  };
}

// ---------------------------------------------------------------------------
// renderFootprint
// ---------------------------------------------------------------------------

function occurrenceLine(o: FootprintOccurrence): string {
  const loc = `${o.include}:${o.line}`;
  const extra = o.unresolved !== undefined
    ? ` [unresolved: ${o.unresolved}]`
    : o.detail !== undefined
      ? ` (${o.detail})`
      : "";
  return `    [${o.kind}] ${loc}  ${o.statement}${extra}`;
}

function summarySentence(result: FootprintResult): string {
  if (result.occurrences.length === 0) {
    return "No write, commit, or write-adjacent statement was found in the scanned includes.";
  }
  if (result.writesOnlyViaUpdateTask) {
    return (
      "Every direct write found sits inside a FORM or METHOD block, and the object also calls " +
      "CALL FUNCTION ... IN UPDATE/BACKGROUND TASK — consistent with (but not proof of) writes " +
      "going through an update task rather than executing inline."
    );
  }
  if (result.commitFound) {
    return (
      "This object both writes and issues its own COMMIT WORK / BAPI_TRANSACTION_COMMIT — it does " +
      "not rely on a caller to commit its writes."
    );
  }
  return (
    "This object writes directly (not exclusively via update task) and does not itself commit — " +
    "a caller's COMMIT WORK governs when those writes take effect."
  );
}

export function renderFootprint(result: FootprintResult): RenderedFootprint {
  const header: Record<string, string | number | undefined> = {
    object: result.object,
    includes: result.includes.join(", "),
    linesScanned: result.linesScanned,
    occurrences: result.occurrences.length,
    commitFound: result.commitFound ? "yes" : "no",
    writesOnlyViaUpdateTask: result.writesOnlyViaUpdateTask ? "yes" : "no",
    ...(result.truncatedAt
      ? { truncated: `${result.truncatedAt.include}:${result.truncatedAt.line}` }
      : {}),
  };

  const bodyParts: string[] = [];

  const byTable = new Map<string, number>();
  for (const o of result.occurrences) {
    const key = o.table ?? (o.unresolved !== undefined ? `(unresolved) ${o.unresolved}` : "(n/a)");
    byTable.set(key, (byTable.get(key) ?? 0) + 1);
  }
  if (byTable.size > 0) {
    const rows = [...byTable.entries()]
      .sort(([a], [b]) => {
        if (a === "(n/a)") return 1;
        if (b === "(n/a)") return -1;
        return a.localeCompare(b);
      })
      .map(([table, count]) => ({ table, occurrences: String(count) }));
    bodyParts.push("Per-table summary:");
    bodyParts.push(textTable(rows, ["table", "occurrences"]));
    bodyParts.push("");
  }

  const grouped = new Map<string, FootprintOccurrence[]>();
  const unresolvedRows: FootprintOccurrence[] = [];
  for (const o of result.occurrences) {
    if (o.table === undefined) {
      unresolvedRows.push(o);
      continue;
    }
    const list = grouped.get(o.table) ?? [];
    list.push(o);
    grouped.set(o.table, list);
  }

  bodyParts.push("Occurrences:");
  if (result.occurrences.length === 0) {
    bodyParts.push("  (none found in the scanned includes)");
  }
  for (const table of [...grouped.keys()].sort()) {
    bodyParts.push(`  ${table}:`);
    for (const o of grouped.get(table) as FootprintOccurrence[]) bodyParts.push(occurrenceLine(o));
  }
  if (unresolvedRows.length > 0) {
    bodyParts.push("  (unresolved / non-table):");
    for (const o of unresolvedRows) bodyParts.push(occurrenceLine(o));
  }

  bodyParts.push("");
  bodyParts.push(summarySentence(result));

  if (result.truncatedAt) {
    bodyParts.push("");
    bodyParts.push(
      `--- TRUNCATED --- scan stopped at ${result.truncatedAt.include}:${result.truncatedAt.line} ` +
        `(maxLines budget reached). Resume by reading ${result.truncatedAt.include} from that line, ` +
        "or re-run with a higher maxLines.",
    );
  }

  // Fixed disclosure set — present on EVERY response, not conditional on
  // what was found, so a caller cannot mistake silence for a stronger
  // guarantee than this scanner makes.
  const notes = [
    "Detection is static pattern matching over statement text, not a compiler or a call graph — it " +
      "can miss a write reached through a macro, dynamic dispatch, or generated code, and it cannot " +
      "prove a write is unreachable.",
    "INSERT/MODIFY/DELETE share syntax between database tables and internal tables; telling a " +
      "database write from an internal-table operation is a keyword-position heuristic (TABLE/INDEX/ " +
      "TRANSPORTING keyword placement), not type information.",
    "CALL TRANSACTION and SUBMIT are reported because the target MAY write — this scanner cannot " +
      "know whether it actually does without executing it.",
    "BOPF modify (/BOBF/IF_TRA_SERVICE_MANAGER->MODIFY) is detected by call-site text pattern only; " +
      "unlike every other kind here, there is no live-captured fixture confirming it against a real " +
      "BOPF object.",
  ];

  const hints: string[] = [];
  if (result.truncatedAt) {
    hints.push(
      `Scan stopped at ${result.truncatedAt.include}:${result.truncatedAt.line} (maxLines budget). ` +
        "Re-run with a higher maxLines, or read the include directly past that point.",
    );
  }
  for (const label of result.includes) {
    if (label.includes("(unreadable") || label.includes("(not found)")) {
      hints.push(`Include "${label}" was not scanned — its statements (if any) are not reflected here.`);
    }
  }

  return { header, body: bodyParts.join("\n"), notes, hints };
}
