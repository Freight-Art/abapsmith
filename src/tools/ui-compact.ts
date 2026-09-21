/**
 * Compact renderers for `abap_ui mode=screen` (issue #150) — the default
 * `detail: "compact"` shape of the FIELDS body and the FLOW LOGIC section.
 *
 * Why: a standard report selection screen dumps every D021S component of
 * every field as `k=[v]` pairs (about 40 pairs per row, roughly 27,000
 * characters on a screen with a hundred generated `%_...` elements), and its
 * flow logic is a hundred-plus generated `%_` MODULE/FIELD lines around a
 * handful of lines a person actually wrote. Here each field becomes one
 * line — `name  type  len  pos  attrs`, with attrs holding only what is not
 * the default — and each run of generated `%_` flow-logic lines collapses
 * into one counted line. `detail: "full"` in src/tools/ui.ts bypasses this
 * module entirely and renders today's dump unchanged.
 *
 * Pure: no ABAP, no I/O, never throws on malformed rows (the decoders come
 * from src/tools/ui-layout.ts, which degrades to 0 / "" instead of
 * throwing). Classification follows ui-layout's four-way rule for
 * empty-`fill` rows so the `type` column and the LAYOUT picture never
 * disagree about what an element is.
 */
import { textTable } from "../compact.js";
import {
  decodeScreenText,
  screenHex as hex,
  screenStr as str,
  type ScreenFieldRow,
} from "./ui-layout.js";

/** One RPY_DYNPRO_READ flow-logic row as the bridge hands it over: `{ line: "<flow-logic line>" }`. */
export type ScreenFlowRow = Readonly<Record<string, string>>;

/** D021S columns rendered as their own table column, so never repeated in `attrs`. */
const OWN_COLUMNS: ReadonlySet<string> = new Set(["name", "fnam", "fill", "line", "coln", "leng", "stxt"]);

/** `flg1` bit 0x80 alone ("element present, input-capable") is the value on every plain live row; shown only when it differs. */
const FLG1_DEFAULT = "80";

const ALL_ZERO_RE = /^0+$/;
const ALL_UNDERSCORE_RE = /^_+$/;

/**
 * Element kind, one short word. Mirrors `renderEmptyFill` /
 * `renderNonEmptyFill` in src/tools/ui-layout.ts: the same row classifies
 * the same way in the LAYOUT picture and in this column.
 */
export function classifyScreenField(row: ScreenFieldRow): string {
  if (hex(row, "line") === 0xff) return "okcode";
  const fill = str(row, "fill");
  switch (fill) {
    case "":
      break;
    case "C":
      return "checkbox";
    case "A":
      return "radio";
    case "P":
      return "button";
    case "I":
      return "tabstrip";
    case "R":
      return "frame";
    case "T":
      return "table";
    case "B":
      return "subscreen";
    default:
      return `fill=${fill}`;
  }
  const flg1 = hex(row, "flg1");
  if ((flg1 & 0x80) === 0) return "text";
  const grp3 = str(row, "grp3");
  if (grp3 === "TXT" || grp3 === "COM" || grp3 === "TOT") return "label";
  const stxt = str(row, "stxt");
  if (stxt !== "" && ALL_UNDERSCORE_RE.test(stxt)) {
    return (flg1 & 0x21) === 0x01 ? "out" : "io";
  }
  return "label";
}

/**
 * Everything about the row that is neither its own column nor a default:
 * empty values, all-zero RAW columns, `flg1=80`, and an `stxt` that is only
 * an I/O mask (all `_`) are dropped; a real `stxt` is decoded and shown as
 * `text="..."`. Order is the row's own (D021S component order).
 */
export function compactFieldAttrs(row: ScreenFieldRow): string {
  const parts: string[] = [];
  const text = decodeScreenText(str(row, "stxt"));
  const rawText = str(row, "stxt");
  if (text !== "" && !ALL_UNDERSCORE_RE.test(rawText)) parts.push(`text="${text}"`);
  for (const [key, value] of Object.entries(row)) {
    if (OWN_COLUMNS.has(key)) continue;
    if (value === undefined || value === "") continue;
    if (ALL_ZERO_RE.test(value)) continue;
    if (key === "flg1" && value === FLG1_DEFAULT) continue;
    parts.push(`${key}=${value}`);
  }
  return parts.join(" ");
}

/** The FIELDS body in compact form: one row per field, `name  type  len  pos  attrs`. `(none)` when empty, same as the full renderer. */
export function renderCompactFields(rows: readonly ScreenFieldRow[]): string {
  if (!rows.length) return "(none)";
  const table = rows.map((row) => ({
    name: str(row, "fnam") || str(row, "name"),
    type: classifyScreenField(row),
    len: String(hex(row, "leng")),
    pos: `${hex(row, "line")},${hex(row, "coln")}`,
    attrs: compactFieldAttrs(row),
  }));
  return textTable(table, ["name", "type", "len", "pos", "attrs"]);
}

/** A flow-logic line the screen painter generated: it names a `%_...` object (selection-screen modules, `%_SUBSCREEN_...`, `%_PBO`/`%_PAI` and friends). */
const GENERATED_RE = /%_/;
const CHAIN_RE = /^\s*CHAIN\s*\.?\s*$/i;
const ENDCHAIN_RE = /^\s*ENDCHAIN\s*\.?\s*$/i;

function flowLineText(row: ScreenFlowRow): string {
  const line = row.line;
  if (line !== undefined) return line;
  return Object.entries(row)
    .map(([k, v]) => `${k}=[${v}]`)
    .join(" ");
}

export interface CompactFlow {
  readonly text: string;
  /** Generated lines folded away — 0 means the section equals the full dump line for line. */
  readonly omitted: number;
}

/**
 * FLOW LOGIC in compact form. Lines are kept verbatim except that every
 * maximal run of generated `%_` lines becomes one
 * `(N generated %_ flow-logic lines omitted)` line, indented like the first
 * line it replaces. A `CHAIN.`/`ENDCHAIN.` pair whose whole body is
 * generated folds into the run with it — a bare CHAIN around nothing would
 * say nothing. User-written lines (`MODULE user_command_1000.`, `FIELD
 * p_x MODULE check_x.`) are never folded, and `PROCESS ...` headers stay.
 */
export function renderCompactFlow(rows: readonly ScreenFlowRow[]): CompactFlow {
  if (!rows.length) return { text: "(none)", omitted: 0 };
  const lines = rows.map(flowLineText);
  const generated = lines.map((l) => GENERATED_RE.test(l));

  for (let i = 0; i < lines.length; i++) {
    if (!CHAIN_RE.test(lines[i] ?? "")) continue;
    let j = i + 1;
    while (j < lines.length && !ENDCHAIN_RE.test(lines[j] ?? "")) j++;
    if (j >= lines.length) break;
    const body = generated.slice(i + 1, j);
    if (body.length > 0 && body.every(Boolean)) {
      generated[i] = true;
      generated[j] = true;
    }
    i = j;
  }

  const out: string[] = [];
  let omitted = 0;
  for (let i = 0; i < lines.length; ) {
    if (!generated[i]) {
      out.push(lines[i] ?? "");
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && generated[j]) j++;
    const run = j - i;
    const indent = /^\s*/.exec(lines[i] ?? "")?.[0] ?? "";
    out.push(`${indent}(${run} generated %_ flow-logic line${run === 1 ? "" : "s"} omitted)`);
    omitted += run;
    i = j;
  }
  return { text: out.join("\n"), omitted };
}

/** Appended to every compact screen response so the shape change is disclosed and the way back is named. */
export function compactScreenNote(flowOmitted: number): string {
  const flow =
    flowOmitted > 0
      ? `${flowOmitted} generated %_ flow-logic line${flowOmitted === 1 ? "" : "s"} collapsed into counted markers`
      : "no generated %_ flow-logic lines to collapse";
  return (
    `Compact output (detail:"compact", the default): FIELDS is one line per element ` +
    `(name  type  len  pos  attrs — len/pos decimal, attrs only where they differ from the plain ` +
    `element: no empty or zero columns, no flg1=80, no I/O mask stxt); ${flow}. ` +
    `detail:"full" restores the raw key=[value] dump of every D021S column and every flow line.`
  );
}
