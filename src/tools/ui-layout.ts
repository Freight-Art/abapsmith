/**
 * Renders a monospace, design-time picture of a dynpro screen from the
 * `FIELD`/`FKEY` rows `abap_ui screen` already read (see `src/tools/ui.ts`,
 * `src/adt/ui-runtime.ts`'s `UiTranscriptResult`). Pure, zero-network — no
 * import from `./ui.js` (would cycle back here) and no extra ABAP round
 * trip: this only re-lays-out data the caller already has.
 *
 * --- Encoding facts (pinned against live A4H captures) ---------------------
 * `RPY_DYNPRO_READ`'s `fields_list` is DDIC type D021S, rendered field-by-
 * field via `|{ <fs> }|`. LINE, COLN, LENG, FLG1, FLG2, FLG3, FMB1, FMB2,
 * LANF, LBLK, LREP, AGLT, ADEZ are RAW(1) and DIDX is RAW(2), so on the wire
 * they are UPPERCASE HEXADECIMAL strings (`leng=[0C]` is 12, `line=[FF]` is
 * 255, `coln=[3D]` is 61) — parse with base 16, via {@link hex}. The
 * `header` map (RPY_DYHEAD) is different: its `lines`/`columns` are DECIMAL
 * strings (`lines=[023] columns=[091]`) — parse with base 10, via
 * {@link dec}. Only the columns this renderer actually consumes (line, coln,
 * leng, flg1, fmb2, lanf, fill, stxt, fnam, grp3) are decoded below; the rest
 * (flg2, flg3, fmb1, lblk, lrep, aglt, adez, didx, …) are RAW/DIDX-typed the
 * same way but not read here.
 *
 * `stxt` is the element's design-time screen picture: display text
 * left-justified, blanks stored as `_`, padded with `_` to `leng`. A genuine
 * underscore in a label is indistinguishable from a blank at this layer —
 * {@link decodeStxt} always reads a literal `_` as a blank, which is a real
 * ambiguity in the source data, not a bug here.
 *
 * Both the 1-based `line` and `coln` coordinates map to a 0-based grid index
 * the same way: `idx(0) === 0`, `idx(n) === n - 1` for `n >= 1` (see
 * {@link idx}). The brief that drove this file only spelled the rule out for
 * `coln`; it is applied identically to `line` here so the computed grid
 * `height` (a row COUNT) lines up with the row INDEX the top-most element
 * actually lands on — treating `line` as already-0-based would leave row 0
 * perpetually empty and push the bottom-most row off the end of the array.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One `FIELD` row as `parseUiTranscript` delivers it: lower-cased D021S column names -> string values. */
export type ScreenFieldRow = Readonly<Record<string, string>>;

/** Everything {@link renderScreenLayout} needs off one `abap_ui screen` result. */
export interface ScreenLayoutInput {
  readonly header?: Readonly<Record<string, string>> | undefined;
  readonly fields: readonly ScreenFieldRow[];
  readonly fkeys: readonly ScreenFieldRow[];
}

/**
 * Standing disclosure — always the last line of {@link renderScreenLayout}'s
 * output, and pushed onto `src/tools/ui.ts`'s response notes whenever
 * `layout: true` is requested.
 */
export const LAYOUT_FIDELITY_NOTE =
  "this is the DESIGN-TIME layout from RPY_DYNPRO_READ, not a runtime screenshot. Text filled at PBO, " +
  "dynamic MODIFY SCREEN attributes, table-control column widths, and subscreen/step-loop heights are not " +
  "in D021S. Positions are approximate: overlapping elements are shifted right to keep them visible.";

// ---------------------------------------------------------------------------
// Low-level decoders — never throw, degrade to a safe default instead.
// ---------------------------------------------------------------------------

const HEX_RE = /^[0-9A-Fa-f]{1,4}$/;
const DEC_RE = /^\d{1,4}$/;

/** A RAW(n)-typed D021S column, base-16 decoded. Malformed or missing -> 0 (never throws). */
function hex(row: ScreenFieldRow, key: string): number {
  const v = row[key];
  if (v === undefined || !HEX_RE.test(v)) return 0;
  return parseInt(v, 16);
}

/** A decimal RPY_DYHEAD column, base-10 decoded. Malformed or missing -> undefined (caller supplies the fallback). */
function dec(v: string | undefined): number | undefined {
  if (v === undefined || !DEC_RE.test(v)) return undefined;
  return parseInt(v, 10);
}

/** A plain string D021S column. Missing -> "" (never undefined downstream). */
function str(row: ScreenFieldRow, key: string): string {
  return row[key] ?? "";
}

/** 1-based screen coordinate -> 0-based grid index. See the module header for why `line` gets the same treatment as `coln`. */
function idx(oneBased: number): number {
  return oneBased === 0 ? 0 : oneBased - 1;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Decodes a D021S `stxt` design-time screen picture into display text:
 * (a) an `@...@` prefix is an icon/quickinfo marker, dropped whole
 *     (e.g. `@\Qbis_zu_40_Zeichen_(groß/klein)@Kennwort__________`);
 * (b) trailing `_` padding is stripped;
 * (c) remaining `_` (word-gap blanks) become spaces;
 * (d) the result is right-trimmed.
 * See the module header on why a genuine underscore can't be told apart
 * from a blank here.
 */
function decodeStxt(raw: string): string {
  let s = raw;
  if (s.startsWith("@")) {
    const closing = s.indexOf("@", 1);
    if (closing !== -1) s = s.slice(closing + 1);
  }
  s = s.replace(/_+$/, "");
  s = s.replace(/_/g, " ");
  return s.trimEnd();
}

// ---------------------------------------------------------------------------
// Grid primitives
// ---------------------------------------------------------------------------

type Grid = string[][];

function buildGrid(width: number, height: number): Grid {
  return Array.from({ length: Math.max(0, height) }, () => new Array<string>(width).fill(" "));
}

/**
 * Writes `text` into `grid` at (`row`, `col`), clipping to `width` and
 * marking the clip with `>` in the last visible column — never throws, rows
 * or columns outside the grid are silently dropped (that's the documented
 * degrade, not a bug).
 */
function writeSpan(grid: Grid, row: number, col: number, text: string, width: number): void {
  if (row < 0 || row >= grid.length) return;
  const line = grid[row];
  if (!line) return;
  let c = col;
  for (let i = 0; i < text.length; i++) {
    if (c >= width) {
      const last = width - 1;
      if (last >= 0 && last < line.length) line[last] = ">";
      return;
    }
    if (c >= 0) line[c] = text[i] ?? " ";
    c++;
  }
}

function markOccupied(occ: Set<number>, col: number, len: number, width: number): void {
  for (let c = Math.max(0, col); c < col + len && c < width; c++) occ.add(c);
}

// ---------------------------------------------------------------------------
// Classification — empty-fill elements (STATIC TEXT / selection label / I/O field / TEXT LABEL)
// ---------------------------------------------------------------------------

/**
 * Renders an empty-`fill` row per the four-way priority order pinned live:
 * (1) `flg1` bit `0x80` clear -> STATIC TEXT (design-time literal, e.g.
 *     SAPMSYST's `RSYST-MANDT` label, `flg1=20`);
 * (2) else `grp3` in {TXT, COM, TOT} -> selection-screen label whose real
 *     text is filled at PBO from the text pool, not present in D021S;
 * (3) else `stxt` present and all `_` -> I/O FIELD, a mask `leng` wide;
 * (4) else -> TEXT LABEL (design-time literal).
 * STATIC TEXT / selection label / TEXT LABEL all fall back to `?<fnam>?`
 * when the decoded text is empty — the "never dropped" convention.
 */
function renderEmptyFill(row: ScreenFieldRow, fnam: string): string {
  const stxt = str(row, "stxt");
  const flg1 = hex(row, "flg1");

  if ((flg1 & 0x80) === 0) {
    return decodeStxt(stxt) || `?${fnam}?`;
  }

  const grp3 = str(row, "grp3");
  if (grp3 === "TXT" || grp3 === "COM" || grp3 === "TOT") {
    return decodeStxt(stxt) || `?${fnam}?`;
  }

  if (stxt !== "" && /^_+$/.test(stxt)) {
    const width = Math.max(hex(row, "leng"), 1);
    // flg1 bit 0x20 set + bit 0x01 clear ("output-only, input clear") -> a display-only mask; anything else -> an editable one.
    const ch = (flg1 & 0x21) === 0x01 ? "." : "_";
    return ch.repeat(width);
  }

  return decodeStxt(stxt) || `?${fnam}?`;
}

/**
 * Renders a non-empty-`fill` single-line element (checkbox/radio/pushbutton/
 * tabstrip/unknown). Checkbox and radio button append their decoded `stxt`
 * label after the marker (`[ ] <label>` / `( ) <label>`), same as pushbutton
 * appends its label inside the brackets — falling back to `fnam` when the
 * decoded text is empty so the element is never anonymous. Frame (`R`),
 * table control (`T`) and subscreen (`B`) are multi-line boxes handled
 * separately.
 */
function renderNonEmptyFill(row: ScreenFieldRow, fnam: string, fill: string): string {
  switch (fill) {
    case "C": {
      const t = decodeStxt(str(row, "stxt"));
      return `[ ] ${t || fnam}`;
    }
    case "A": {
      const t = decodeStxt(str(row, "stxt"));
      return `( ) ${t || fnam}`;
    }
    case "P": {
      const t = decodeStxt(str(row, "stxt"));
      return `[ ${t || fnam} ]`;
    }
    case "I":
      return `[tabstrip: ${fnam}]`;
    default:
      // UNKNOWN kind — anything not R/C/A/P/B/I/T/empty.
      return `?${fnam}?`;
  }
}

// ---------------------------------------------------------------------------
// Boxes — frame (R), table control (T), subscreen area (B)
// ---------------------------------------------------------------------------

interface BoxRow {
  readonly line: number;
  readonly col: number;
  readonly text: string;
}

/** `+- <title> ---+` top edge, all dashes when `title` is empty. */
function frameTopEdge(width: number, title: string): string {
  if (title === "") return "+" + "-".repeat(Math.max(0, width - 2)) + "+";
  const prefix = `+- ${title} `;
  const dashes = "-".repeat(Math.max(0, width - prefix.length - 1));
  return prefix + dashes + "+";
}

/**
 * Frame (`fill=R`) box rows. `bottomLine` is the already-resolved bottom
 * edge (1-based line space, see {@link resolveFrameBottom}) — this function
 * only converts to grid rows and draws.
 */
function frameBox(row: ScreenFieldRow, bottomLine: number): BoxRow[] {
  const topLine = hex(row, "line");
  const colHex = hex(row, "coln");
  const width = hex(row, "leng");
  const col = idx(colHex);
  const fnam = str(row, "fnam");
  const title = decodeStxt(str(row, "stxt")) || fnam;

  const rows: BoxRow[] = [{ line: idx(topLine), col, text: frameTopEdge(width, title) }];
  for (let l = topLine + 1; l < bottomLine; l++) {
    rows.push({ line: idx(l), col, text: "|" });
    rows.push({ line: idx(l), col: col + width - 1, text: "|" });
  }
  rows.push({ line: idx(bottomLine), col, text: "+" + "-".repeat(Math.max(0, width - 2)) + "+" });
  return rows;
}

/**
 * A frame at 1-based `line` L extends to (the line of the next `fill=R` row
 * with a strictly greater line) minus 1, or — when there is no later frame —
 * to the max `hex(line)` over every top-level drawn row; clamped to at
 * least L+1 so a frame is always at least a top+bottom edge.
 */
function resolveFrameBottom(topLine: number, allFrameLines: readonly number[], maxDrawnLine: number): number {
  let next = Infinity;
  for (const l of allFrameLines) {
    if (l > topLine && l < next) next = l;
  }
  const bottom = Number.isFinite(next) ? next - 1 : maxDrawnLine;
  return Math.max(bottom, topLine + 1);
}

/**
 * Table control (`fill=T`) box: title (a `%`-prefixed member with
 * `fmb2=0x40`) and column headers (`%`-prefixed members with `fmb2=0x80`,
 * ordered by `coln`), 4 fixed rows. Non-`%` members are cells and
 * contribute nothing — see the module header on why member rows aren't
 * drawn at top level at all.
 */
function tableControlBox(anchor: ScreenFieldRow, members: readonly ScreenFieldRow[]): BoxRow[] {
  const fnam = str(anchor, "fnam");
  const line = idx(hex(anchor, "line"));
  const col = idx(hex(anchor, "coln"));
  const width = Math.max(hex(anchor, "leng"), 12);

  const titleMember = members.find((m) => str(m, "fnam").startsWith("%") && hex(m, "fmb2") === 0x40);
  const title = titleMember ? decodeStxt(str(titleMember, "stxt")) : "";

  const headers = members
    .filter((m) => str(m, "fnam").startsWith("%") && hex(m, "fmb2") === 0x80)
    .slice() // avoid mutating the caller's array with sort()
    .sort((a, b) => hex(a, "coln") - hex(b, "coln"))
    .map((m) => decodeStxt(str(m, "stxt")));

  const row1Body = `+- table control: ${fnam}` + (title ? ` "${title}"` : "") + " ";
  const row1 = row1Body + "-".repeat(Math.max(0, width - row1Body.length - 1)) + "+";

  const row2Body = "| " + headers.join(" | ");
  const row2 = row2Body + " ".repeat(Math.max(0, width - row2Body.length - 1)) + "|";

  const row3 = "|" + " ".repeat(Math.max(0, width - 2)) + "|";
  const row4 = "+" + "-".repeat(Math.max(0, width - 2)) + "+";

  return [row1, row2, row3, row4].map((text, i) => ({ line: line + i, col, text }));
}

/** Subscreen area (`fill=B`) box: 3 fixed rows. D021S carries no HEIGHT for a subscreen — only `leng` (width); no height is invented here. */
function subscreenBox(row: ScreenFieldRow): BoxRow[] {
  const fnam = str(row, "fnam");
  const line = idx(hex(row, "line"));
  const col = idx(hex(row, "coln"));
  const lengHex = hex(row, "leng");
  const width = Math.max(lengHex, 20);

  const row1Body = `+- subscreen: ${fnam} (${lengHex} cols) `;
  const row1 = row1Body + "-".repeat(Math.max(0, width - row1Body.length - 1)) + "+";
  const row2 = "|" + " ".repeat(Math.max(0, width - 2)) + "|";
  const row3 = "+" + "-".repeat(Math.max(0, width - 2)) + "+";

  return [row1, row2, row3].map((text, i) => ({ line: line + i, col, text }));
}

// ---------------------------------------------------------------------------
// Draw items — everything that is not a frame background
// ---------------------------------------------------------------------------

interface LineItem {
  readonly kind: "line";
  readonly lineHex: number;
  readonly colHex: number;
  readonly col: number;
  readonly fnam: string;
  readonly text: string;
}

interface BoxItem {
  readonly kind: "box";
  readonly lineHex: number;
  readonly colHex: number;
  readonly fnam: string;
  readonly rows: readonly BoxRow[];
}

type DrawItem = LineItem | BoxItem;

function compareDrawItems(a: DrawItem, b: DrawItem): number {
  if (a.lineHex !== b.lineHex) return a.lineHex - b.lineHex;
  if (a.colHex !== b.colHex) return a.colHex - b.colHex;
  return a.fnam < b.fnam ? -1 : a.fnam > b.fnam ? 1 : 0;
}

/**
 * A row belongs to a table control iff its `lanf` is non-zero and some
 * `fill=T` row shares it. The control's own `fill=T` anchor row is
 * deliberately excluded (`fill === "T"` short-circuits to `false`) so it is
 * classified as the control itself, not absorbed as one of its own members.
 */
function isTableMember(row: ScreenFieldRow, anchorLanfs: ReadonlySet<number>): boolean {
  const lanf = hex(row, "lanf");
  if (lanf === 0) return false;
  if (str(row, "fill") === "T") return false;
  return anchorLanfs.has(lanf);
}

/**
 * Builds every non-frame draw item: single-line contributions plus
 * table-control/subscreen boxes. Table-control member rows are looked up
 * from `drawable` (the full skip-filtered set), not `topLevel`, since
 * members were excluded from `topLevel` precisely so they aren't drawn on
 * their own.
 *
 * Deviation from a literal reading of the brief: the "shift right while the
 * FIRST target cell is occupied" rule is applied only to single-line
 * contributions here, not to table-control/subscreen boxes. The box
 * sections each specify an exact, fixed top-left with no mention of
 * shifting, and shifting a multi-row box one column at a time would corrupt
 * its own geometry (header separators, title quoting) for no stated
 * benefit — so boxes are placed at their literal D021S position instead.
 */
function buildDrawItems(
  topLevel: readonly ScreenFieldRow[],
  drawable: readonly ScreenFieldRow[],
  anchorLanfs: ReadonlySet<number>,
): DrawItem[] {
  const items: DrawItem[] = [];
  for (const row of topLevel) {
    const fill = str(row, "fill");
    if (fill === "R") continue; // frames are backgrounds, drawn separately

    const fnam = str(row, "fnam");
    const lineHex = hex(row, "line");
    const colHex = hex(row, "coln");

    if (fill === "T") {
      const lanf = hex(row, "lanf");
      const members = drawable.filter((r) => isTableMember(r, anchorLanfs) && hex(r, "lanf") === lanf);
      items.push({ kind: "box", lineHex, colHex, fnam, rows: tableControlBox(row, members) });
      continue;
    }
    if (fill === "B") {
      items.push({ kind: "box", lineHex, colHex, fnam, rows: subscreenBox(row) });
      continue;
    }

    const text = fill === "" ? renderEmptyFill(row, fnam) : renderNonEmptyFill(row, fnam, fill);
    items.push({ kind: "line", lineHex, colHex, col: idx(colHex), fnam, text });
  }
  return items;
}

function placeDrawItems(grid: Grid, items: readonly DrawItem[], width: number): void {
  const occupiedByLine = new Map<number, Set<number>>();
  const occFor = (line: number): Set<number> => {
    let occ = occupiedByLine.get(line);
    if (!occ) {
      occ = new Set<number>();
      occupiedByLine.set(line, occ);
    }
    return occ;
  };

  for (const item of items) {
    if (item.kind === "line") {
      const rowIdx = idx(item.lineHex);
      const occ = occFor(rowIdx);
      let c = item.col;
      while (occ.has(c)) c++;
      writeSpan(grid, rowIdx, c, item.text, width);
      markOccupied(occ, c, item.text.length, width);
    } else {
      for (const r of item.rows) {
        writeSpan(grid, r.line, r.col, r.text, width);
        markOccupied(occFor(r.line), r.col, r.text.length, width);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Grid assembly
// ---------------------------------------------------------------------------

/**
 * Hard cap on rendered grid rows — a runaway RPY_DYHEAD "lines" value
 * degrades rather than allocating unbounded rows; disclosed via a
 * "(grid cut to 300 rows; RPY_DYHEAD reports N)" line directly under the
 * grid whenever it actually cuts something (see `buildGridLines` below).
 */
const GRID_MAX_ROWS = 300;

function buildGridLines(header: Readonly<Record<string, string>> | undefined, fields: readonly ScreenFieldRow[]): string[] {
  const width = clamp(dec(header?.columns) ?? 132, 40, 255);

  const drawable = fields.filter((r) => hex(r, "line") !== 255); // OK-code pseudo-field (ltyp=O), never drawn

  const anchorLanfs = new Set(
    drawable.filter((r) => str(r, "fill") === "T").map((r) => hex(r, "lanf")),
  );
  const topLevel = drawable.filter((r) => !isTableMember(r, anchorLanfs));

  const maxDrawnLine = topLevel.reduce((m, r) => Math.max(m, hex(r, "line")), 0);
  const headerLines = dec(header?.lines);
  const rawHeight = headerLines === undefined || headerLines === 0 ? maxDrawnLine : headerLines;
  const height = Math.min(rawHeight, GRID_MAX_ROWS);
  const cutNote =
    headerLines !== undefined && headerLines > GRID_MAX_ROWS
      ? `(grid cut to ${GRID_MAX_ROWS} rows; RPY_DYHEAD reports ${headerLines})`
      : undefined;

  const grid = buildGrid(width, height);

  // Frame backgrounds first, ascending (line, coln) — contained elements draw over them.
  const frameRows = topLevel
    .filter((r) => str(r, "fill") === "R")
    .slice()
    .sort((a, b) => hex(a, "line") - hex(b, "line") || hex(a, "coln") - hex(b, "coln"));
  const frameLines = frameRows.map((r) => hex(r, "line"));
  for (const frame of frameRows) {
    const topLine = hex(frame, "line");
    const bottom = resolveFrameBottom(topLine, frameLines, maxDrawnLine);
    for (const r of frameBox(frame, bottom)) writeSpan(grid, r.line, r.col, r.text, width);
  }

  // Everything else, ascending (line, coln, fnam).
  const items = buildDrawItems(topLevel, drawable, anchorLanfs).sort(compareDrawItems);
  placeDrawItems(grid, items, width);

  const lines = grid.map((row) => row.join("").replace(/[ \t]+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  return cutNote ? [...lines, cutNote] : lines;
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

/** One line per GUI status, first-seen order; buttons deduped by code within a status, first-seen order. Rows with an empty code are skipped. */
function renderButtons(fkeys: readonly ScreenFieldRow[]): string {
  const statusOrder: string[] = [];
  const byStatus = new Map<string, Map<string, string>>();

  for (const row of fkeys) {
    const code = str(row, "code");
    if (code === "") continue;
    const status = str(row, "status");
    let codes = byStatus.get(status);
    if (!codes) {
      codes = new Map<string, string>();
      byStatus.set(status, codes);
      statusOrder.push(status);
    }
    if (!codes.has(code)) codes.set(code, str(row, "text"));
  }

  if (statusOrder.length === 0) return "Buttons: (no GUI status buttons)";

  return statusOrder
    .map((status) => {
      const codes = byStatus.get(status);
      const parts = codes
        ? Array.from(codes.entries()).map(([code, text]) => (text ? `${text} (${code})` : `(${code})`))
        : [];
      return `Buttons (${status}): ${parts.join(", ")}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function renderScreenLayoutInner(input: ScreenLayoutInput): string {
  const gridLines = buildGridLines(input.header, input.fields ?? []);
  const buttons = renderButtons(input.fkeys ?? []);
  return [...gridLines, "", buttons, "", `NOTE: ${LAYOUT_FIDELITY_NOTE}`].join("\n");
}

/**
 * Renders the whole LAYOUT section body for `abap_ui screen ... layout:
 * true`: the grid, a blank line, the `Buttons ...` line(s), a blank line,
 * then the standing fidelity note. Pure and total — every helper above
 * degrades on malformed input (missing columns, non-hex/non-decimal
 * values, out-of-range coordinates) rather than throwing; this wrapper is a
 * last-resort net so a genuinely unexpected shape still degrades instead of
 * taking the whole `abap_ui screen` response down with it.
 */
export function renderScreenLayout(input: ScreenLayoutInput): string {
  try {
    return renderScreenLayoutInner(input);
  } catch {
    return `(layout render failed on malformed input)\n\nNOTE: ${LAYOUT_FIDELITY_NOTE}`;
  }
}

// Shared with src/tools/ui-compact.ts (issue #150) so the compact FIELDS
// renderer classifies rows with exactly the decoders the layout renderer
// uses. Exporting them changes nothing about the layout output.
export { hex as screenHex, str as screenStr, decodeStxt as decodeScreenText };
