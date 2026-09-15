/**
 * Static call-site extraction, one ABAP source include at a time. Backs
 * `mode="call_graph", direction="callees"` in `src/tools/search.ts`/
 * `call-graph.ts` — there is no ADT endpoint that answers "what does this
 * object call" (the where-used endpoint only answers the reverse, callers,
 * see `element-info.ts`), so callees are found by pattern-matching the
 * object's own source.
 *
 * Ground truth: captures `974-i105-source-zcl-i105-a` (`CALL FUNCTION
 * 'RFC_SYSTEM_INFO'.`, `zcl_i105_b=>run( ).`, `SUBMIT zi105_rep AND
 * RETURN.`, `zcl_i105_leaf=>calc( )`) and `975-i105-source-zcl-i105-b`
 * (`PERFORM dummy IN PROGRAM zi105_form IF FOUND.`, `zcl_i105_a=>run( ).`).
 * Every recognised form below is exercised by one of those two lines except
 * `CALL TRANSACTION` and the dynamic variants, which are not present in any
 * fixture and are implemented from the issue text alone.
 *
 * One statement per SOURCE LINE, not per logical ABAP statement: a
 * `CALL FUNCTION` whose parameter list continues onto following lines is
 * not recognised (its keyword + target already are, on the opening line —
 * only a target split across lines, e.g. `CALL FUNCTION\n  'X'.`, would be
 * missed, and no fixture exhibits that). This matches every fixture line
 * above, all of which are complete statements on one line, and keeps
 * `CallSite.line`/`.statement` unambiguous (one line in, one line out).
 */
import { abapCodeOf } from "./source.js";

export type CallKind = "function module" | "method" | "form" | "report" | "transaction";

export interface CallSite {
  readonly kind: CallKind;
  /** Static target name, uppercased. `undefined` when the statement's target is dynamic. */
  readonly target?: string;
  /** Raw target text as written, for a dynamic target: "lv_fm", "(gv_prog)". */
  readonly rawTarget: string;
  readonly line: number; // 1-based, within `include`
  readonly include: string; // "main", "testclasses", … or a program include name
  readonly statement: string; // the matched source line, trimmed
}

const IDENT = "[A-Za-z_][A-Za-z0-9_]*";

// `CALL FUNCTION 'X'` (static) | `CALL FUNCTION (lv_name)` | `CALL FUNCTION lv_name` (both dynamic).
// Tried in this order (literal first) so a quoted name is never mistaken for the bare-identifier form.
const CALL_FUNCTION_RE = new RegExp(
  `\\bCALL\\s+FUNCTION\\s+(?:'([^']*)'|\\(\\s*(${IDENT})\\s*\\)|(${IDENT}))`,
  "i",
);

// `CALL METHOD zcl_foo=>bar` — keyword form, no trailing "(" required (parameters usually
// follow as EXPORTING/RECEIVING clauses on later lines, outside this line-local parser's scope).
const CALL_METHOD_KEYWORD_RE = new RegExp(`\\bCALL\\s+METHOD\\s+(${IDENT})\\s*(=>|->)\\s*${IDENT}`, "i");

// `zcl_foo=>bar( )` / `lo_ref->bar( )` — functional call syntax. The trailing "(" is what tells
// this apart from a plain attribute/constant reference such as `lv = zcl_foo=>max_rows.`, which
// is not a call and must not become an edge.
const FUNCTIONAL_METHOD_RE = new RegExp(`\\b(${IDENT})\\s*(=>|->)\\s*${IDENT}\\s*\\(`, "i");

// `PERFORM <form> IN PROGRAM <prog>` (static) | `PERFORM (lv_form) IN PROGRAM (lv_prog)` (dynamic).
// A bare `PERFORM <form>` with no `IN PROGRAM` never matches this — it calls a form in the SAME
// program, not another object, so it is not a call-graph edge and is silently not an edge (not a
// silently-dropped match: nothing here claims to find it).
const PERFORM_IN_PROGRAM_RE = new RegExp(
  `\\bPERFORM\\s+\\(?\\s*${IDENT}\\s*\\)?\\s+IN\\s+PROGRAM\\s+(?:\\(\\s*(${IDENT})\\s*\\)|(${IDENT}))`,
  "i",
);

// `SUBMIT <report>` / `SUBMIT <report> AND RETURN` (static) | `SUBMIT (lv_prog)` (dynamic).
const SUBMIT_RE = new RegExp(`\\bSUBMIT\\s+(?:\\(\\s*(${IDENT})\\s*\\)|(${IDENT}))`, "i");

// `CALL TRANSACTION 'X'` (static) | `CALL TRANSACTION lv_t` (dynamic — a real tcode is always quoted).
const CALL_TRANSACTION_RE = new RegExp(`\\bCALL\\s+TRANSACTION\\s+(?:'([^']*)'|(${IDENT}))`, "i");

/**
 * The ABAP-visible prefix of `line`, WITH string-literal contents intact —
 * unlike `abapCodeOf(line)` itself, which blanks them to spaces. That
 * blanking is right for comment/keyword scanning but wrong here: the target
 * of `CALL FUNCTION 'RFC_SYSTEM_INFO'` and `CALL TRANSACTION 'X'` lives
 * inside the quotes this function must not erase.
 *
 * `abapCodeOf`'s doc comment guarantees column positions are preserved (a
 * blanked character becomes exactly one space, a doubled quote becomes
 * exactly two), so `abapCodeOf(line).length` is the number of characters of
 * `line` that are ABAP-visible: everything up to a trailing `"` comment, or
 * the whole line when there is none, or zero for a full-line `*` comment.
 * Slicing the ORIGINAL line to that length recovers the real code —
 * including string contents — with any trailing comment cut away, exactly
 * the text `abapCodeOf` would have kept had it not needed to blank strings
 * for its own (different) purpose.
 */
function codeSlice(line: string): string {
  return line.slice(0, abapCodeOf(line).length);
}

export function parseCallSites(source: string, include: string): CallSite[] {
  const rawLines = source.split(/\r\n|\r|\n/);
  const sites: CallSite[] = [];

  for (let i = 0; i < rawLines.length; i++) {
    const rawLine = rawLines[i] ?? "";
    const code = codeSlice(rawLine);
    if (code.trim() === "") continue;
    const lineNo = i + 1;
    const statement = rawLine.trim();

    const fn = CALL_FUNCTION_RE.exec(code);
    if (fn) {
      if (fn[1] !== undefined) {
        sites.push({ kind: "function module", target: fn[1].toUpperCase(), rawTarget: fn[1], line: lineNo, include, statement });
      } else if (fn[2] !== undefined) {
        sites.push({ kind: "function module", rawTarget: `(${fn[2]})`, line: lineNo, include, statement });
      } else if (fn[3] !== undefined) {
        sites.push({ kind: "function module", rawTarget: fn[3], line: lineNo, include, statement });
      }
    }

    const callMethod = CALL_METHOD_KEYWORD_RE.exec(code);
    const method = callMethod ?? FUNCTIONAL_METHOD_RE.exec(code);
    if (method) {
      const receiver = method[1] as string;
      const arrow = method[2] as string;
      if (arrow === "=>") {
        sites.push({ kind: "method", target: receiver.toUpperCase(), rawTarget: receiver, line: lineNo, include, statement });
      } else {
        // `->` — the receiver is a variable, not a class name, so the target class cannot be
        // known from this line alone. Every `->` call is dynamic, even when the variable's
        // static type could in principle be traced elsewhere.
        sites.push({ kind: "method", rawTarget: receiver, line: lineNo, include, statement });
      }
    }

    const perform = PERFORM_IN_PROGRAM_RE.exec(code);
    if (perform) {
      if (perform[1] !== undefined) {
        sites.push({ kind: "form", rawTarget: `(${perform[1]})`, line: lineNo, include, statement });
      } else if (perform[2] !== undefined) {
        sites.push({ kind: "form", target: perform[2].toUpperCase(), rawTarget: perform[2], line: lineNo, include, statement });
      }
    }

    const submit = SUBMIT_RE.exec(code);
    if (submit) {
      if (submit[1] !== undefined) {
        sites.push({ kind: "report", rawTarget: `(${submit[1]})`, line: lineNo, include, statement });
      } else if (submit[2] !== undefined) {
        sites.push({ kind: "report", target: submit[2].toUpperCase(), rawTarget: submit[2], line: lineNo, include, statement });
      }
    }

    const tran = CALL_TRANSACTION_RE.exec(code);
    if (tran) {
      if (tran[1] !== undefined) {
        sites.push({ kind: "transaction", target: tran[1].toUpperCase(), rawTarget: tran[1], line: lineNo, include, statement });
      } else if (tran[2] !== undefined) {
        sites.push({ kind: "transaction", rawTarget: tran[2], line: lineNo, include, statement });
      }
    }
  }

  return sites;
}
