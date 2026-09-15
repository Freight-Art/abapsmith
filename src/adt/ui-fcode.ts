/**
 * Pure, offline analysis for `abap_ui mode="fcode"` — turns the raw frame
 * array the `ZCL_ZMCP_FLUID_UI` `fcode` action emits (see
 * `src/adt/fluid/builtin/ui.ts`'s `METHOD fcode`) into a structured trace of
 * which PAI module(s) handle a given function code, and what each one calls.
 *
 * No network, no ABAP generation, nothing executed — `splitFcodeFrames` only
 * buckets already-parsed JSON values by `kind`, and `analyzeFcodes` is a
 * regex/statement-splitting pass over the module source text the bridge
 * already read via `READ REPORT`. This module MUST NOT gain any capability
 * to run, submit, or otherwise execute ABAP — the "calls" it reports
 * (including `CALL TRANSACTION` and `LEAVE TO TRANSACTION`) are strings
 * found in source text, nothing more.
 *
 * The dispatch-resolution and CASE/WHEN parsing rules below are heuristics
 * derived from one real program (`SAPMSVMA`, module `ACTION`, observed
 * 2026-09-15 against system A4H — see the git history for the transcript).
 * They cover the common `ok_code`/`sy-ucomm` dispatch idiom and its usual
 * aliasing pattern, not the full ABAP grammar. Anything the heuristics can't
 * pin down is surfaced as `dispatch.kind === "unresolved"` or a
 * `UiFcodeRow.unresolved` entry rather than silently guessed at.
 */

// ---------------------------------------------------------------------------
// Raw frame model — one entry per `kind` the ABAP side emits.
// ---------------------------------------------------------------------------

export interface UiFcodeRawTcode {
  tcode: string;
  program: string;
  dynpro: string;
  cinfo: string;
  kind: string;
  bdcApplies?: boolean;
}

export interface UiFcodeRawTarget {
  program: string;
  dynpro: string;
  fcodeFilter: string;
  tcode?: UiFcodeRawTcode;
}

export interface UiFcodeRawFlow {
  index: number;
  line: string;
}

export interface UiFcodeRawPaiModule {
  index: number;
  name: string;
  atExit: boolean;
  flowLine: number;
  condition?: string;
}

export interface UiFcodeRawCuaFunction {
  code: string;
  text: string;
  type: string;
}

export interface UiFcodeRawCuaFkey {
  status: string;
  code: string;
  text: string;
  quickinfo: string;
}

export interface UiFcodeRawCua {
  statusCount?: number;
  functionsCount?: number;
  functions: readonly UiFcodeRawCuaFunction[];
  fkeysCount?: number;
  fkeys: readonly UiFcodeRawCuaFkey[];
  noCua?: { program: string; note: string };
}

export interface UiFcodeRawInclude {
  name: string;
  lines: number;
  readError?: string;
}

export interface UiFcodeRawModule {
  name: string;
  include: string;
  lineFrom: number;
  lineTo: number;
  unterminated?: boolean;
}

export interface UiFcodeRawSrc {
  include: string;
  line: number;
  text: string;
}

export interface UiFcodeRawSummary {
  program: string;
  dynpro: string;
  includes: number;
  includesFailed: number;
  modules: number;
  paiModules: number;
  srcLines: number;
  truncated: string;
}

/** Everything `splitFcodeFrames` buckets the raw `values` array into, grouped by frame `kind`. */
export interface UiFcodeRaw {
  target?: UiFcodeRawTarget;
  flow: readonly UiFcodeRawFlow[];
  paiModules: readonly UiFcodeRawPaiModule[];
  cua?: UiFcodeRawCua;
  includes: readonly UiFcodeRawInclude[];
  modules: readonly UiFcodeRawModule[];
  src: readonly UiFcodeRawSrc[];
  summary?: UiFcodeRawSummary;
  /** Frames with no recognised `kind` (or not even an object) — not an error, just uncounted. */
  unknownFrames: number;
}

// ---------------------------------------------------------------------------
// splitFcodeFrames
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function bool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function optStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Buckets the fluid `fcode` action's output array (`res.result` when
 * `action.output.type === "array"`, i.e. `transcript.values` in
 * `fluid/dispatch.ts`) by frame `kind`. Every field read here is defensive
 * (falls back rather than throws) the same way `parseUiTranscript` is —
 * `dispatch()` already validated the array against `uiManifest`'s output
 * schema, so a genuine mismatch here means the manifest and this reader have
 * drifted, not a bad live response.
 */
export function splitFcodeFrames(values: readonly unknown[]): UiFcodeRaw {
  const raw: UiFcodeRaw = {
    flow: [],
    paiModules: [],
    includes: [],
    modules: [],
    src: [],
    unknownFrames: 0,
  };
  const flow: UiFcodeRawFlow[] = [];
  const paiModules: UiFcodeRawPaiModule[] = [];
  const includes: UiFcodeRawInclude[] = [];
  const modules: UiFcodeRawModule[] = [];
  const src: UiFcodeRawSrc[] = [];

  for (const v of values) {
    if (!isRecord(v) || typeof v.kind !== "string") {
      raw.unknownFrames++;
      continue;
    }
    switch (v.kind) {
      case "target": {
        const tcodeRaw = v.tcode;
        raw.target = {
          program: str(v.program),
          dynpro: str(v.dynpro),
          fcodeFilter: str(v.fcode_filter),
          ...(isRecord(tcodeRaw)
            ? {
                tcode: {
                  tcode: str(tcodeRaw.tcode),
                  program: str(tcodeRaw.program),
                  dynpro: str(tcodeRaw.dynpro),
                  cinfo: str(tcodeRaw.cinfo),
                  kind: str(tcodeRaw.kind),
                  ...(typeof tcodeRaw.bdcApplies === "boolean" ? { bdcApplies: tcodeRaw.bdcApplies } : {}),
                },
              }
            : {}),
        };
        break;
      }
      case "flow":
        flow.push({ index: num(v.index), line: str(v.line) });
        break;
      case "pai_module":
        paiModules.push({
          index: num(v.index),
          name: str(v.name),
          atExit: bool(v.at_exit),
          flowLine: num(v.flow_line),
          ...(optStr(v.condition) !== undefined ? { condition: optStr(v.condition) } : {}),
        });
        break;
      case "cua": {
        const functionsRaw = Array.isArray(v.functions) ? v.functions : [];
        const fkeysRaw = Array.isArray(v.fkeys) ? v.fkeys : [];
        const noCuaRaw = v.noCua;
        raw.cua = {
          ...(typeof v.statusCount === "number" ? { statusCount: v.statusCount } : {}),
          ...(typeof v.functionsCount === "number" ? { functionsCount: v.functionsCount } : {}),
          functions: functionsRaw.filter(isRecord).map((f) => ({
            code: str(f.code),
            text: str(f.text),
            type: str(f.type),
          })),
          ...(typeof v.fkeysCount === "number" ? { fkeysCount: v.fkeysCount } : {}),
          fkeys: fkeysRaw.filter(isRecord).map((f) => ({
            status: str(f.status),
            code: str(f.code),
            text: str(f.text),
            quickinfo: str(f.quickinfo),
          })),
          ...(isRecord(noCuaRaw) ? { noCua: { program: str(noCuaRaw.program), note: str(noCuaRaw.note) } } : {}),
        };
        break;
      }
      case "include":
        includes.push({
          name: str(v.name),
          lines: num(v.lines),
          ...(optStr(v.read_error) !== undefined ? { readError: optStr(v.read_error) } : {}),
        });
        break;
      case "module":
        modules.push({
          name: str(v.name),
          include: str(v.include),
          lineFrom: num(v.line_from),
          lineTo: num(v.line_to),
          ...(v.unterminated === true ? { unterminated: true } : {}),
        });
        break;
      case "src":
        src.push({ include: str(v.include), line: num(v.line), text: str(v.text) });
        break;
      case "summary":
        raw.summary = {
          program: str(v.program),
          dynpro: str(v.dynpro),
          includes: num(v.includes),
          includesFailed: num(v.includes_failed),
          modules: num(v.modules),
          paiModules: num(v.pai_modules),
          srcLines: num(v.src_lines),
          truncated: str(v.truncated),
        };
        break;
      default:
        raw.unknownFrames++;
        break;
    }
  }

  raw.flow = flow;
  raw.paiModules = paiModules;
  raw.includes = includes;
  raw.modules = modules;
  raw.src = src;
  return raw;
}

// ---------------------------------------------------------------------------
// Result model
// ---------------------------------------------------------------------------

export interface UiFcodeBranch {
  literals: readonly string[];
  lineFrom: number;
  lineTo: number;
  calls: readonly {
    kind: "PERFORM" | "CALL FUNCTION" | "CALL METHOD" | "CALL TRANSACTION" | "LEAVE TO TRANSACTION" | "SUBMIT";
    target: string;
    line: number;
    dynamic: boolean;
  }[];
  /** Suggested `abap_read` call to view this branch's own lines, e.g. `abap_read {"object":"SAPMSVMA","offset":120,"limit":4}`. */
  read: string;
}

export interface UiFcodeModuleHit {
  module: string;
  include: string;
  lineFrom: number;
  lineTo: number;
  atExit: boolean;
  condition?: string;
  flowIndex: number;
  dispatch:
    | { kind: "ok_code" | "sy_ucomm" | "alias"; expression: string; aliasAssignedFrom?: string; aliasLine?: number }
    | { kind: "none" }
    | { kind: "unresolved"; reason: string; expression?: string };
  branches: readonly UiFcodeBranch[];
  /** Suggested `abap_read` call to view the whole module body. */
  read: string;
}

export interface UiFcodeRow {
  fcode: string;
  statuses: readonly string[];
  text: string;
  modules: readonly UiFcodeModuleHit[];
  unresolved: readonly { module: string; include: string; reason: string }[];
}

export interface UiFcodeResult {
  program: string;
  dynpro: string;
  tcode?: { tcode: string; cinfo: string; kind: string };
  fcodes: readonly UiFcodeRow[];
  paiModules: readonly { name: string; include?: string; atExit: boolean; found: boolean }[];
  includes: readonly { name: string; lines: number; readError?: string }[];
  notes: readonly string[];
  truncated: string;
}

// ---------------------------------------------------------------------------
// Statement splitting — turns a module's source lines into ABAP statements
// (one per `.` outside a quoted literal), each tagged with the source line
// it started and ended on. Deliberately simple: this is a heuristic scanner
// over legacy dynpro module bodies, not an ABAP parser. It understands `'…'`
// string literals (with `''` as an escaped quote) and `"…` end-of-line
// comments / `*` full-line comments; it does NOT understand `|…|` string
// templates (rare-to-absent in this vintage of code) or chained statement
// groups (`:`), so those degrade gracefully into slightly wrong statement
// boundaries rather than a crash.
// ---------------------------------------------------------------------------

interface Stmt {
  /** Whitespace-collapsed, trailing-period-stripped, trimmed statement text — case preserved. */
  norm: string;
  startLine: number;
  endLine: number;
}

function stripAbapComment(line: string): string {
  if (/^\s*\*/.test(line)) return "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") inQuote = !inQuote;
    else if (c === '"' && !inQuote) return line.slice(0, i);
  }
  return line;
}

function splitStatements(lines: readonly { line: number; text: string }[]): Stmt[] {
  const stmts: Stmt[] = [];
  let buf = "";
  let startLine: number | null = null;
  let endLine = 0;
  let inQuote = false;

  const flush = (upto: number) => {
    const norm = buf.replace(/\s+/g, " ").trim();
    if (norm.length > 0) {
      stmts.push({ norm, startLine: startLine ?? upto, endLine: upto });
    }
    buf = "";
    startLine = null;
  };

  for (const { line, text } of lines) {
    const clean = stripAbapComment(text);
    if (clean.trim() !== "" && startLine === null) startLine = line;
    endLine = line;
    for (const c of clean) {
      if (c === "." && !inQuote) {
        flush(line);
        continue;
      }
      buf += c;
      if (c === "'") inQuote = !inQuote;
    }
    buf += " ";
  }
  // Trailing text with no closing period (truncated/malformed source) — keep
  // it rather than drop it silently; it still carries e.g. a partial CASE.
  flush(endLine);
  return stmts;
}

// ---------------------------------------------------------------------------
// Dispatch + branch analysis over one module's statements.
// ---------------------------------------------------------------------------

/** True when `ident` (case-insensitive) is `sy-ucomm` or any identifier ending in `ok_code` (`ok_code`, `xyz-ok_code`, `zok_code`, …) — see the module header. */
function isOkCodeLike(ident: string): "ok_code" | "sy_ucomm" | undefined {
  const t = ident.trim().toLowerCase();
  if (t === "sy-ucomm") return "sy_ucomm";
  if (t.endsWith("ok_code")) return "ok_code";
  return undefined;
}

interface AliasAssignment {
  lhs: string;
  rhsKind: "ok_code" | "sy_ucomm";
  rhsText: string;
  line: number;
  stmtIndex: number;
}

/** Finds every `<var> = ok_code|sy-ucomm.` / `move ok_code|sy-ucomm to <var>.` assignment among `stmts[0..beforeIdx)`. Order preserved — callers want the LAST one before the CASE (a re-assignment wins), matching normal ABAP control flow read top to bottom. */
function findAliasAssignments(stmts: readonly Stmt[], beforeIdx: number): AliasAssignment[] {
  const out: AliasAssignment[] = [];
  for (let i = 0; i < beforeIdx; i++) {
    const s = stmts[i]!;
    let m = /^(\S+)\s*=\s*(\S+)$/i.exec(s.norm);
    let lhs: string | undefined;
    let rhs: string | undefined;
    if (m) {
      lhs = m[1];
      rhs = m[2];
    } else {
      m = /^move\s+(\S+)\s+to\s+(\S+)$/i.exec(s.norm);
      if (m) {
        rhs = m[1];
        lhs = m[2];
      }
    }
    if (!lhs || !rhs) continue;
    const kind = isOkCodeLike(rhs);
    if (kind) out.push({ lhs, rhsKind: kind, rhsText: rhs, line: s.startLine, stmtIndex: i });
  }
  return out;
}

/**
 * Best-effort detection of a "pre-dispatch remap" — an assignment INTO the
 * variable the CASE actually switches on (not the alias-defining assignment
 * itself) from something other than ok_code/sy-ucomm, most often a literal
 * (`ok_code = 'YES'.` right before `case ok_code.`). Real, but not chased —
 * per the design, branch literals are still matched against the caller's
 * original fcode, never the remapped value. Only the LAST such reassignment
 * before the CASE is reported; earlier ones are shadowed by it.
 */
function findPreDispatchRemap(
  stmts: readonly Stmt[],
  beforeIdx: number,
  dispatchVar: string,
  skipStmtIndex: number | undefined,
): { line: number; text: string } | undefined {
  let found: { line: number; text: string } | undefined;
  const target = dispatchVar.trim().toLowerCase();
  for (let i = 0; i < beforeIdx; i++) {
    if (i === skipStmtIndex) continue;
    const s = stmts[i]!;
    const m = /^(\S+)\s*=\s*(\S+)$/i.exec(s.norm);
    if (!m) continue;
    const lhsTok = m[1] ?? "";
    const rhsTok = m[2] ?? "";
    if (lhsTok.trim().toLowerCase() !== target) continue;
    if (isOkCodeLike(rhsTok)) continue; // that's the alias definition itself, not a remap
    found = { line: s.startLine, text: s.norm };
  }
  return found;
}

interface Call {
  kind: "PERFORM" | "CALL FUNCTION" | "CALL METHOD" | "CALL TRANSACTION" | "LEAVE TO TRANSACTION" | "SUBMIT";
  target: string;
  line: number;
  dynamic: boolean;
}

/** Extracts up to 10 outgoing calls from `stmts[fromIdx..toIdx)`, source order. */
function extractCalls(stmts: readonly Stmt[], fromIdx: number, toIdx: number): Call[] {
  const calls: Call[] = [];
  for (let i = fromIdx; i < toIdx && calls.length < 10; i++) {
    const s = stmts[i]!;
    const n = s.norm;
    let m: RegExpExecArray | null;

    if ((m = /^perform\s+\(([^)]+)\)/i.exec(n))) {
      calls.push({ kind: "PERFORM", target: (m[1] ?? "").trim(), line: s.startLine, dynamic: true });
    } else if ((m = /^perform\s+(\S+)/i.exec(n))) {
      calls.push({ kind: "PERFORM", target: m[1] ?? "", line: s.startLine, dynamic: false });
    } else if ((m = /^call\s+function\s+'([^']*)'/i.exec(n))) {
      calls.push({ kind: "CALL FUNCTION", target: m[1] ?? "", line: s.startLine, dynamic: false });
    } else if ((m = /^call\s+function\s+(\S+)/i.exec(n))) {
      calls.push({ kind: "CALL FUNCTION", target: m[1] ?? "", line: s.startLine, dynamic: true });
    } else if ((m = /^call\s+transaction\s+'([^']*)'/i.exec(n))) {
      calls.push({ kind: "CALL TRANSACTION", target: m[1] ?? "", line: s.startLine, dynamic: false });
    } else if ((m = /^call\s+transaction\s+(\S+)/i.exec(n))) {
      calls.push({ kind: "CALL TRANSACTION", target: m[1] ?? "", line: s.startLine, dynamic: true });
    } else if ((m = /^leave\s+to\s+transaction\s+'([^']*)'/i.exec(n))) {
      calls.push({ kind: "LEAVE TO TRANSACTION", target: m[1] ?? "", line: s.startLine, dynamic: false });
    } else if ((m = /^leave\s+to\s+transaction\s+(\S+)/i.exec(n))) {
      calls.push({ kind: "LEAVE TO TRANSACTION", target: m[1] ?? "", line: s.startLine, dynamic: true });
    } else if ((m = /^call\s+method\s+\(([^)]+)\)/i.exec(n))) {
      calls.push({ kind: "CALL METHOD", target: (m[1] ?? "").trim(), line: s.startLine, dynamic: true });
    } else if ((m = /^call\s+method\s+(\S+)/i.exec(n))) {
      calls.push({ kind: "CALL METHOD", target: m[1] ?? "", line: s.startLine, dynamic: false });
    } else if ((m = /^submit\s+\(([^)]+)\)/i.exec(n))) {
      calls.push({ kind: "SUBMIT", target: (m[1] ?? "").trim(), line: s.startLine, dynamic: true });
    } else if ((m = /^submit\s+(\S+)/i.exec(n))) {
      calls.push({ kind: "SUBMIT", target: m[1] ?? "", line: s.startLine, dynamic: false });
    } else if ((m = /([\w~]+)->(\w+)\(/i.exec(n))) {
      // Functional/instance call not written as `CALL METHOD` — `obj->meth( ... )`.
      calls.push({ kind: "CALL METHOD", target: `${m[1] ?? ""}->${m[2] ?? ""}`, line: s.startLine, dynamic: false });
    }
  }
  return calls;
}

function buildRead(object: string, program: string, lineFrom: number, lineTo: number): string {
  const obj = object.trim().toUpperCase() === program.trim().toUpperCase() ? program : object;
  const limit = Math.max(1, lineTo - lineFrom + 1);
  return `abap_read {"object":"${obj}","offset":${lineFrom},"limit":${limit}}`;
}

/** Parses `when 'A' or 'B'.` / `when others.` into its literal list (raw, unescaped, un-trimmed — callers compare trimmed/uppercased copies). */
function parseWhenLiterals(whenNorm: string): string[] {
  const body = whenNorm.replace(/^when\s+/i, "");
  const quoted = [...body.matchAll(/'([^']*)'/g)].map((m) => m[1] ?? "");
  if (quoted.length > 0) return quoted;
  if (/^others\b/i.test(body.trim())) return ["OTHERS"];
  return [];
}

interface ModuleAnalysis {
  dispatch: UiFcodeModuleHit["dispatch"];
  branches: (UiFcodeBranch & { literalsUpper: string[] })[];
  remapNote?: string;
}

/**
 * The core per-module analysis: finds the (first) dispatch CASE, resolves
 * what it switches on, and slices out every top-level WHEN branch with its
 * literals and outgoing calls. Independent of any one fcode — run once per
 * module, reused for every row.
 */
function analyzeModuleBody(
  moduleName: string,
  include: string,
  program: string,
  lineFrom: number,
  lineTo: number,
  stmts: readonly Stmt[],
): ModuleAnalysis {
  const caseIdx = stmts.findIndex((s) => /^case\s+/i.test(s.norm));

  if (caseIdx === -1) {
    // No CASE at all — not an error, just a module that always runs.
    return {
      dispatch: { kind: "none" },
      branches: [
        {
          literals: [],
          literalsUpper: [],
          lineFrom,
          lineTo,
          calls: extractCalls(stmts, 0, stmts.length),
          read: buildRead(include, program, lineFrom, lineTo),
        },
      ],
    };
  }

  const caseExpr = stmts[caseIdx]!.norm.replace(/^case\s+/i, "").trim();
  const aliases = findAliasAssignments(stmts, caseIdx);
  const lastAlias = aliases.length > 0 ? aliases[aliases.length - 1] : undefined;

  let dispatch: UiFcodeModuleHit["dispatch"];
  const direct = isOkCodeLike(caseExpr);
  if (direct) {
    dispatch = { kind: direct, expression: caseExpr };
  } else {
    const aliasHit = [...aliases].reverse().find((a) => a.lhs.trim().toLowerCase() === caseExpr.toLowerCase());
    if (aliasHit) {
      dispatch = {
        kind: "alias",
        expression: caseExpr,
        aliasAssignedFrom: aliasHit.rhsText,
        aliasLine: aliasHit.line,
      };
    } else {
      dispatch = {
        kind: "unresolved",
        expression: caseExpr,
        reason: `CASE on "${caseExpr}", which is not ok_code/sy-ucomm and was not assigned from one inside this module`,
      };
    }
  }

  // Pre-dispatch remap: whatever the CASE actually names, reassigned from a
  // non-ok_code/sy-ucomm source before the CASE runs (skip the alias
  // definition statement itself, if that's what resolved `dispatch`).
  const remap = findPreDispatchRemap(stmts, caseIdx, caseExpr, lastAlias?.stmtIndex);
  const remapNote = remap
    ? `Module ${moduleName} reassigns "${caseExpr}" before dispatch (line ${remap.line}: "${remap.text}") — ` +
      "not followed; branch literals below are still matched against the ORIGINAL fcode, not this remapped value."
    : undefined;

  // Walk from just after the CASE, tracking nested-CASE depth so an inner
  // CASE's own WHEN/ENDCASE never closes our branches.
  let depth = 1;
  let endcaseIdx = stmts.length;
  const whenIdx: number[] = [];
  for (let i = caseIdx + 1; i < stmts.length; i++) {
    const n = stmts[i]!.norm;
    if (/^case\s+/i.test(n)) {
      depth++;
    } else if (/^endcase\b/i.test(n)) {
      depth--;
      if (depth === 0) {
        endcaseIdx = i;
        break;
      }
    } else if (depth === 1 && /^when\s+/i.test(n)) {
      whenIdx.push(i);
    }
  }

  const branches: (UiFcodeBranch & { literalsUpper: string[] })[] = whenIdx.map((wi, k) => {
    const bodyFrom = wi + 1;
    const bodyTo = k + 1 < whenIdx.length ? whenIdx[k + 1]! : endcaseIdx;
    const literals = parseWhenLiterals(stmts[wi]!.norm);
    const lastStmtIdx = bodyTo > bodyFrom ? bodyTo - 1 : wi;
    const lineFrom = stmts[wi]!.startLine;
    const lineTo = stmts[lastStmtIdx]!.endLine;
    return {
      literals,
      literalsUpper: literals.map((l) => l.trim().toUpperCase()),
      lineFrom,
      lineTo,
      calls: extractCalls(stmts, bodyFrom, bodyTo),
      read: buildRead(include, program, lineFrom, lineTo),
    };
  });

  return { dispatch, branches, ...(remapNote ? { remapNote } : {}) };
}

// ---------------------------------------------------------------------------
// analyzeFcodes
// ---------------------------------------------------------------------------

const MAX_FCODES = 60;

function normFcode(v: string): string {
  return v.trim().toUpperCase();
}

/**
 * Turns `splitFcodeFrames`'s output into the per-fcode trace. Module bodies
 * are analyzed once (via {@link analyzeModuleBody}) and reused across every
 * fcode row — the dispatch/branch structure doesn't depend on which fcode is
 * being asked about, only which branch(es) match it.
 */
export function analyzeFcodes(raw: UiFcodeRaw, opts: { fcode?: string }): UiFcodeResult {
  const program = raw.target?.program ?? raw.summary?.program ?? "";
  const dynpro = raw.target?.dynpro ?? raw.summary?.dynpro ?? "";
  const notes: string[] = [];

  // --- index src lines per include, and module frames by lowercased name ---
  const srcByInclude = new Map<string, Map<number, string>>();
  for (const s of raw.src) {
    let m = srcByInclude.get(s.include);
    if (!m) {
      m = new Map();
      srcByInclude.set(s.include, m);
    }
    m.set(s.line, s.text);
  }
  const moduleFrameByName = new Map<string, UiFcodeRawModule>();
  for (const m of raw.modules) {
    // First occurrence wins — a repeated MODULE name across includes would be
    // a program bug, not something to silently pick the "best" of.
    const key = m.name.trim().toLowerCase();
    if (!moduleFrameByName.has(key)) moduleFrameByName.set(key, m);
  }

  // --- analyze every PAI module's body once ---
  interface Resolved {
    pai: UiFcodeRawPaiModule;
    frame: UiFcodeRawModule;
    analysis: ModuleAnalysis;
  }
  const resolved: Resolved[] = [];
  const paiModulesSummary: { name: string; include?: string; atExit: boolean; found: boolean }[] = [];

  for (const pai of raw.paiModules) {
    const frame = moduleFrameByName.get(pai.name.trim().toLowerCase());
    if (!frame) {
      paiModulesSummary.push({ name: pai.name, atExit: pai.atExit, found: false });
      continue;
    }
    paiModulesSummary.push({ name: pai.name, include: frame.include, atExit: pai.atExit, found: true });
    const lines: { line: number; text: string }[] = [];
    const byLine = srcByInclude.get(frame.include);
    if (byLine) {
      for (let ln = frame.lineFrom; ln <= frame.lineTo; ln++) {
        const t = byLine.get(ln);
        if (t !== undefined) lines.push({ line: ln, text: t });
      }
    }
    const stmts = splitStatements(lines);
    const analysis = analyzeModuleBody(pai.name, frame.include, program, frame.lineFrom, frame.lineTo, stmts);
    if (analysis.remapNote) notes.push(analysis.remapNote);
    resolved.push({ pai, frame, analysis });
  }

  // --- which fcodes to report ---
  let fcodeList: string[];
  let fcodesTruncated = false;
  if (opts.fcode !== undefined && opts.fcode.trim() !== "") {
    fcodeList = [normFcode(opts.fcode)];
  } else if (raw.cua?.noCua) {
    notes.push(
      `No GUI status defined for program ${raw.cua.noCua.program} — cannot enumerate function codes. ` +
        'Pass fcode explicitly (e.g. from the tcode\'s known transaction commands) to trace one anyway.',
    );
    fcodeList = [];
  } else if (!raw.cua) {
    notes.push("No CUA frame was received from the bridge — cannot enumerate function codes without fcode set explicitly.");
    fcodeList = [];
  } else {
    const set = new Set<string>();
    for (const f of raw.cua.functions) if (f.code.trim() !== "") set.add(normFcode(f.code));
    for (const f of raw.cua.fkeys) if (f.code.trim() !== "") set.add(normFcode(f.code));
    const all = [...set].sort();
    fcodesTruncated = all.length > MAX_FCODES;
    fcodeList = all.slice(0, MAX_FCODES);
    if (fcodesTruncated) {
      notes.push(
        `${all.length} distinct function codes found across the GUI status(es); only the first ${MAX_FCODES} ` +
          "(sorted) are reported. Pass fcode explicitly to trace one outside this list.",
      );
    }
  }

  // --- build one row per fcode ---
  const fcodes: UiFcodeRow[] = fcodeList.map((fcode) => {
    const matchingFunctions = (raw.cua?.functions ?? []).filter((f) => normFcode(f.code) === fcode);
    const matchingFkeys = (raw.cua?.fkeys ?? []).filter((f) => normFcode(f.code) === fcode);
    const statuses = [...new Set(matchingFkeys.map((f) => f.status).filter((s) => s.trim() !== ""))];
    const text = matchingFunctions[0]?.text ?? matchingFkeys[0]?.text ?? "";

    if (opts.fcode !== undefined && matchingFunctions.length === 0 && matchingFkeys.length === 0) {
      notes.push(
        `fcode "${fcode}" is not listed in any GUI status or program-wide function list for ${program} — ` +
          "tracing it anyway because it was explicitly requested.",
      );
    }

    const rowUnresolved: { module: string; include: string; reason: string }[] = [];
    const modules: UiFcodeModuleHit[] = [];

    for (const { pai, frame, analysis } of resolved) {
      let branches = analysis.branches.filter((b) => b.literalsUpper.includes(fcode));
      if (branches.length === 0) {
        const others = analysis.branches.filter((b) => b.literalsUpper.includes("OTHERS"));
        if (others.length > 0) {
          branches = others;
          notes.push(`fcode "${fcode}" in module ${pai.name} matched only via WHEN OTHERS (no explicit literal).`);
        }
      }

      modules.push({
        module: pai.name,
        include: frame.include,
        lineFrom: frame.lineFrom,
        lineTo: frame.lineTo,
        atExit: pai.atExit,
        ...(pai.condition !== undefined ? { condition: pai.condition } : {}),
        flowIndex: pai.flowLine,
        dispatch: analysis.dispatch,
        branches: branches.map(({ literalsUpper: _literalsUpper, ...b }) => b),
        read: buildRead(frame.include, program, frame.lineFrom, frame.lineTo),
      });

      if (analysis.dispatch.kind === "unresolved") {
        rowUnresolved.push({ module: pai.name, include: frame.include, reason: analysis.dispatch.reason });
      }
      if (branches.length === 0) {
        rowUnresolved.push({
          module: pai.name,
          include: frame.include,
          reason: `no WHEN branch (including WHEN OTHERS) in module ${pai.name} matches fcode "${fcode}"`,
        });
      }
    }

    for (const pai of raw.paiModules) {
      if (!moduleFrameByName.has(pai.name.trim().toLowerCase())) {
        rowUnresolved.push({
          module: pai.name,
          include: "",
          reason: `module ${pai.name} (named in the PAI flow logic) was not found in any scanned include`,
        });
      }
    }

    return { fcode, statuses, text, modules, unresolved: rowUnresolved };
  });

  const truncatedParts: string[] = [];
  if (raw.summary?.truncated) truncatedParts.push(raw.summary.truncated);
  if (fcodesTruncated) truncatedParts.push("fcodes");

  return {
    program,
    dynpro,
    ...(raw.target?.tcode
      ? { tcode: { tcode: raw.target.tcode.tcode, cinfo: raw.target.tcode.cinfo, kind: raw.target.tcode.kind } }
      : {}),
    fcodes,
    paiModules: paiModulesSummary,
    includes: raw.includes.map((i) => ({ name: i.name, lines: i.lines, ...(i.readError ? { readError: i.readError } : {}) })),
    notes,
    truncated: truncatedParts.join(","),
  };
}
