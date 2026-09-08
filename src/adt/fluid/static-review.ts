/**
 * Offline static review of operator-supplied ABAP plugin source, run by the
 * fluid plugin loader before the first network call. This is a lint, not a
 * sandbox: a 255-character line guard plus a short list of prohibited
 * constructs in the source text. It cannot bound what a plugin does once it
 * runs with the technical user's full SAP authorisations — the real
 * controls are the SAP authorisation concept and `ABAP_ALLOW_FLUID_PLUGINS`.
 * See doc/FLUID-API/safety.md ("Static review is a lint, not a sandbox").
 */

export interface StaticReviewFinding {
  readonly object: string;
  readonly line: number;
  readonly rule: string;
  readonly text: string;
}

export const FLUID_ABAP_LINE_MAX = 255;

interface ShippedRule {
  readonly name: string;
  readonly test: (statement: string) => boolean;
}

const CALL_SYSTEM_RE = /\bCALL\s+'SYSTEM'/i;
const EXEC_SQL_RE = /\bEXEC\s+SQL\b/i;
const INSERT_REPORT_RE = /\bINSERT\s+REPORT\b/i;
const GENERATE_SUBROUTINE_POOL_RE = /\bGENERATE\s+SUBROUTINE\s+POOL\b/i;
const CALL_FUNCTION_RE = /\bCALL\s+FUNCTION\b/i;
const DESTINATION_RE = /\bDESTINATION\b/i;
const SUBMIT_RE = /\bSUBMIT\b/i;
const VIA_JOB_RE = /\bVIA\s+JOB\b/i;
const CALL_METHOD_RE = /\bCALL\s+METHOD\b/i;
const CALL_METHOD_DIRECT_DYNAMIC_RE = /\bCALL\s+METHOD\s*\(/i;
// Dynamic method name via a computed reference, e.g. `lo_ref->(lv_meth)` —
// a static call always has an identifier between the arrow and the parens.
const ARROW_PAREN_RE = /(?:->|=>)\s*\(/;

const SHIPPED_RULES: readonly ShippedRule[] = [
  { name: "call-system", test: (s) => CALL_SYSTEM_RE.test(s) },
  { name: "exec-sql", test: (s) => EXEC_SQL_RE.test(s) },
  { name: "insert-report", test: (s) => INSERT_REPORT_RE.test(s) },
  { name: "generate-subroutine-pool", test: (s) => GENERATE_SUBROUTINE_POOL_RE.test(s) },
  {
    name: "call-function-destination",
    test: (s) => CALL_FUNCTION_RE.test(s) && DESTINATION_RE.test(s),
  },
  { name: "submit-via-job", test: (s) => SUBMIT_RE.test(s) && VIA_JOB_RE.test(s) },
  {
    name: "dynamic-call-method",
    test: (s) =>
      CALL_METHOD_RE.test(s) && (CALL_METHOD_DIRECT_DYNAMIC_RE.test(s) || ARROW_PAREN_RE.test(s)),
  },
];

export const FLUID_SHIPPED_PROHIBITIONS: readonly string[] = SHIPPED_RULES.map((r) => r.name);

function escapeRegExpLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Operator phrases are literal, never regexes, so a config value can never
// introduce catastrophic backtracking; only whitespace runs stay flexible.
function buildPhraseRule(phrase: string): ShippedRule {
  const segments = phrase.split(/(\s+)/);
  const pattern = segments
    .map((seg) => (/^\s+$/.test(seg) ? "\\s+" : escapeRegExpLiteral(seg)))
    .join("");
  const leading = /^\w/.test(phrase) ? "\\b" : "";
  const trailing = /\w$/.test(phrase) ? "\\b" : "";
  const re = new RegExp(leading + pattern + trailing, "i");
  return { name: `extra:${phrase}`, test: (s) => re.test(s) };
}

function truncateText(raw: string): string {
  const t = raw.trim();
  return t.length > 120 ? `${t.slice(0, 120)}…` : t;
}

function blankCommentLine(line: string): string {
  return line.startsWith("*") ? "" : line;
}

interface LogicalStatement {
  readonly normalized: string;
  readonly startLine: number;
}

type ScanState = "normal" | "string" | "template" | "comment";

// Splits on `.` outside a `'...'` literal or a `|...|` template, and blanks
// a trailing `"..."` comment in place (so offsets stay aligned), so a
// statement spanning several lines — e.g. `CALL FUNCTION 'X'` / next line
// `DESTINATION 'Y'.` — is matched as one statement, a `.` inside a literal
// never breaks it early, and an apostrophe inside a `"` comment or a `|...|`
// template never opens a string that swallows the rest of the source.
function splitStatements(blankedLines: readonly string[]): readonly LogicalStatement[] {
  const joined = blankedLines.join("\n");
  const lineStarts: number[] = [];
  let acc = 0;
  for (const l of blankedLines) {
    lineStarts.push(acc);
    acc += l.length + 1;
  }

  const cleaned: string[] = [];
  const raws: { raw: string; startOffset: number }[] = [];
  let state: ScanState = "normal";
  let stmtStart = 0;

  for (let i = 0; i < joined.length; i++) {
    const ch = joined.charAt(i);

    if (state === "comment") {
      cleaned.push(ch === "\n" ? ch : " ");
      if (ch === "\n") state = "normal";
      continue;
    }

    if (state === "string") {
      cleaned.push(ch);
      if (ch === "'") {
        if (joined.charAt(i + 1) === "'") {
          i++;
          cleaned.push(joined.charAt(i));
          continue;
        }
        state = "normal";
      }
      continue;
    }

    if (state === "template") {
      cleaned.push(ch);
      if (ch === "\\") {
        const next = joined.charAt(i + 1);
        if (next !== "") {
          i++;
          cleaned.push(next);
        }
        continue;
      }
      if (ch === "|") state = "normal";
      continue;
    }

    // state === "normal"
    if (ch === "'") {
      state = "string";
      cleaned.push(ch);
      continue;
    }
    if (ch === "|") {
      state = "template";
      cleaned.push(ch);
      continue;
    }
    if (ch === '"') {
      state = "comment";
      cleaned.push(" ");
      continue;
    }
    if (ch === ".") {
      raws.push({ raw: cleaned.slice(stmtStart, i).join(""), startOffset: stmtStart });
      stmtStart = i + 1;
    }
    cleaned.push(ch);
  }
  const tail = cleaned.slice(stmtStart).join("");
  if (tail.trim().length > 0) {
    raws.push({ raw: tail, startOffset: stmtStart });
  }

  const statements: LogicalStatement[] = [];
  let lineCursor = 0;
  for (const { raw, startOffset } of raws) {
    const firstNonWs = raw.search(/\S/);
    if (firstNonWs < 0) continue;
    const normalized = raw.replace(/\s+/g, " ").trim();
    if (normalized.length === 0) continue;
    const target = startOffset + firstNonWs;
    while (lineCursor + 1 < lineStarts.length && (lineStarts[lineCursor + 1] ?? Infinity) <= target) {
      lineCursor++;
    }
    statements.push({ normalized, startLine: lineCursor + 1 });
  }
  return statements;
}

export function reviewFluidAbap(
  objectName: string,
  source: string,
  extraProhibitions?: readonly string[],
): readonly StaticReviewFinding[] {
  const lines = source.split(/\r\n|\r|\n/);
  const findings: StaticReviewFinding[] = [];

  lines.forEach((line, idx) => {
    if (line.length > FLUID_ABAP_LINE_MAX) {
      findings.push({
        object: objectName,
        line: idx + 1,
        rule: "line-length",
        text: truncateText(line),
      });
    }
  });

  const blankedLines = lines.map(blankCommentLine);
  const statements = splitStatements(blankedLines);
  const rules: readonly ShippedRule[] = [
    ...SHIPPED_RULES,
    ...(extraProhibitions ?? []).map(buildPhraseRule),
  ];

  for (const stmt of statements) {
    for (const rule of rules) {
      if (rule.test(stmt.normalized)) {
        findings.push({
          object: objectName,
          line: stmt.startLine,
          rule: rule.name,
          text: truncateText(stmt.normalized),
        });
      }
    }
  }

  findings.sort((a, b) => a.line - b.line);
  return findings;
}
