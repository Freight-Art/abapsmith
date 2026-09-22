/**
 * IMG (SPRO customizing) row write: TS-side plan validation and transcript
 * parsing for the fluid `img` tool's `preview`/`apply` actions
 * (`ZCL_ZMCP_FLUID_IMG`, `src/adt/fluid/builtin/img.ts`, dispatched via
 * `src/adt/img-write.ts`'s `runImgProbe`/`runImgApply`).
 *
 * This module used to also generate and own the ABAP delivery mechanism —
 * one `IF_OO_ADT_CLASSRUN` class regenerated per call, in two fixed shapes:
 * `ZCL_ZMCP_IMG_WPROBE` (read-only: T000 flags, the base table's DD02L/DD03L
 * shape, before-image rows for caller-supplied keys) and `ZCL_ZMCP_IMG_WAPPLY`
 * (writes: records the CTS transport key, then MODIFY/DELETEs rows, commits,
 * and re-reads the after-image). Both are now RETIRED (`src/adt/fluid/
 * retired.ts`) — the fluid `img` tool ships as one content-addressed class
 * reused across calls, generic over table/field/row arguments read at ABAP
 * runtime, rather than a class regenerated per call with those baked in.
 * `IMGW_BRIDGE_CLASS` below still names the two retired classes; nothing
 * deploys against them anymore, and it is kept only because
 * `test/img-write-bridge.test.ts` still pins its literal values. The old
 * per-call generator for `ZCL_ZMCP_IMG_WPROBE`'s body (`imgProbeSource`) has
 * been deleted outright, along with the private ABAP-fragment helpers and
 * DDIC field-name maps that existed only to feed it — `img.preview`'s live
 * body was ported into `ZCL_ZMCP_FLUID_IMG` directly (see that file's own
 * module doc comment), and the generator had no other caller left, test or
 * otherwise, once that port was done.
 *
 * The old per-call design's safety argument doesn't carry over verbatim: a
 * freshly generated, statically typed class made a wrong field or table name
 * a syntax error at activation, before a row was touched. A single reused
 * class can't do that — it has no caller-supplied table/field names to bake
 * in — so `ZCL_ZMCP_FLUID_IMG` reproduces the same guarantee dynamically
 * instead: `ASSIGN COMPONENT ... OF STRUCTURE` plus an `sy-subrc` check
 * before every field touch, refusing the row (never touching it) the moment
 * a named field doesn't exist on the described structure. What DOES carry
 * over unchanged from the retired classes: this module's plan validation
 * (`validateProbePlan`/`validateApplyPlan`, still the sole pre-dispatch
 * gate for both actions) and its transcript grammar
 * (`parseImgWriteTranscript`), which `ZCL_ZMCP_FLUID_IMG` was written to keep
 * emitting unchanged.
 *
 * Neither `img-resolve.ts` nor `img-write-policy.ts` is imported here — this
 * module only validates a plan and parses a transcript; the caller plan
 * (table, keys, rows) is expected to already be resolved and allowed by
 * those modules elsewhere.
 */

import { AbapError } from "./errors.js";
import { DDIC_ERR_PREFIX } from "./ddic-bridge.js";
import { ERR_LINE_PREFIX, parseBracketFields } from "./run.js";
import { assertAbapText } from "./enhancement-templates.js";
import { assertTrkorr } from "./transports.js";
import { assertImgLanguage } from "./img-query.js";

export const IMGW_LINE_PREFIX = "IMGW> ";

/** Fixed class names — never generated or caller-influenced. */
export const IMGW_BRIDGE_CLASS = {
  probe: "ZCL_ZMCP_IMG_WPROBE",
  apply: "ZCL_ZMCP_IMG_WAPPLY",
} as const;

export const IMGW_MAX_ROWS = 50;

/**
 * The CTS bookkeeping call this module generates. Repointing after a future
 * finding is a one-object edit: this record, nothing that calls it.
 */
export const CTS_INSERT_FM = Object.freeze({
  checkFm: "TR_OBJECTS_CHECK",
  insertFm: "TRINT_OBJECTS_CHECK_AND_INSERT",
  params: Object.freeze({
    order: "iv_order",
    noStandardEditor: "iv_no_standard_editor",
    noShowOption: "iv_no_show_option",
    withDialog: "iv_with_dialog",
    objects: "ct_ko200",
    keys: "ct_e071k",
    /**
     * `TRINT_OBJECTS_CHECK_AND_INSERT`-only exports (`TRKORR`-typed): CTS may
     * record the object into a *task* beneath the requested order rather
     * than the order itself, so `weOrder`/`weTask` are what was actually
     * chosen, not necessarily what `order` (`iv_order`) above asked for. Not
     * present on `TR_OBJECTS_CHECK` — that FM never files anything, so it
     * has nothing to report back.
     */
    weOrder: "ev_order",
    weTask: "ev_task",
  }),
  exceptions: Object.freeze({
    cancelEditOtherError: "cancel_edit_other_error",
    showOnlyOtherError: "show_only_other_error",
  }),
  confidence: "high",
  note:
    "TR_OBJECTS_CHECK proven 2026-09-06; TR_OBJECTS_INSERT hard-codes iv_with_dialog='X' and " +
    "popped SAPLSTRD dynpros 0300/0352 in a classrun on 2026-09-22 (CX_SY_SEND_DYNPRO_NO_RECEIVER); " +
    "TRINT_OBJECTS_CHECK_AND_INSERT with 'D' proven 2026-09-22 (E071 R3TR TABU BALOBJ OBJFUNC K on " +
    "task A4HK900351 with one E071K row per key); space is check-only and writes nothing; a " +
    "customizing (W) request refuses a client-independent table entry with TK599. Still unproven: " +
    "the FM's failure paths.",
} as const);

// ---------------------------------------------------------------------------
// Plan types
// ---------------------------------------------------------------------------

export interface ImgWriteField {
  readonly field: string;
  readonly key: boolean;
  readonly dataType: string;
}

export interface ImgWriteRow {
  readonly key: Readonly<Record<string, string>>;
  readonly values: Readonly<Record<string, string>>;
}

export interface ImgProbePlan {
  readonly table: string;
  readonly clientField: string;
  readonly keyFields: readonly string[];
  readonly rows: readonly ImgWriteRow[];
  readonly language: string;
}

export interface ImgApplyPlan extends ImgProbePlan {
  readonly op: "upsert" | "delete";
  readonly fields: readonly ImgWriteField[];
  readonly corrNr?: string;
  /**
   * DD02L-CONTFLAG / CLIDEP as read at probe time. Generation rule 6
   * ("abort if the delivery class or client dependence changed since the
   * probe") needs something from the probe to compare the apply-time re-read
   * against, and nothing else in this plan carries it. Which classes are
   * actually writable (C/G/E) is `img-write-policy.ts`'s call, made before
   * this plan is ever built; this module only detects DRIFT from what that
   * decision was made against.
   */
  readonly expectedDeliveryClass: string;
  readonly expectedClientDependent: boolean;
  /**
   * The maintenance view recording this write in the CTS: the `KO200`
   * header row's `OBJ_NAME` and the `E071K` row's `MASTERNAME`/`VIEWNAME`
   * (see {@link CTS_INSERT_FM}). Required — there is no other name to put
   * there for an SM30-style customizing write.
   */
  readonly view: string;
  /**
   * `KO200`/`E071K`'s `OBJECT`/`MASTERTYPE`: `VDAT` for a maintenance view
   * (the common case — `V_TB001` in the measured evidence), `CDAT` for a
   * customizing object recorded directly (`/AIF/ACTIONS` in the measured
   * evidence).
   */
  readonly masterType: "VDAT" | "CDAT" | "TABU";
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const DDIC_IDENTIFIER_RE = /^[A-Za-z0-9_/]{1,30}$/;

function assertDdicIdentifier(value: string, what: string): string {
  if (typeof value !== "string" || !DDIC_IDENTIFIER_RE.test(value)) {
    throw new AbapError(
      "BAD_INPUT",
      `${what} ${JSON.stringify(value)} must be 1-30 characters of letters, digits, underscore or "/".`,
      { what, value },
    );
  }
  return value;
}

/**
 * `ZCL_ZMCP_FLUID_IMG` receives row key/value strings as fluid action
 * arguments (JSON, parsed at ABAP runtime), not baked into generated ABAP
 * source — this module's retired per-call generator used to embed them as
 * ABAP string literals instead, where a raw control character (a literal
 * newline) could break the line the assignment sat on, since ABAP has no
 * escape for it inside `'...'`. That specific corruption path is gone with
 * the generator, but the same values still flow into other ABAP-side
 * contexts this module doesn't control end to end (comparisons, transport
 * text, transcript output), so the check stays as a general well-formedness
 * gate rather than one tied to a since-deleted embedding mechanism.
 * {@link assertAbapText} is `enhancement-templates.ts`'s existing check for
 * exactly this, reused rather than re-implemented; the length cap here is
 * this module's own, not that function's default.
 */
function assertRowValue(value: string, what: string): string {
  return assertAbapText(value, what, 200);
}

function assertSingleCharCode(value: string, what: string): string {
  const v = (value ?? "").trim();
  if (!/^[A-Za-z0-9]{0,4}$/.test(v)) {
    throw new AbapError("BAD_INPUT", `${what} ${JSON.stringify(value)} is not a plain DDIC code.`, { what, value });
  }
  return v;
}

export function validateProbePlan(p: ImgProbePlan): void {
  assertDdicIdentifier(p.table, "table");
  const clientField = assertDdicIdentifier(p.clientField, "clientField").toUpperCase();
  assertImgLanguage(p.language);

  if (p.keyFields.length < 1) {
    throw new AbapError("BAD_INPUT", `${p.table} needs at least one key field.`, { table: p.table });
  }
  const keyFieldsUpper = p.keyFields.map((f) => assertDdicIdentifier(f, "keyField").toUpperCase());
  if (keyFieldsUpper.includes(clientField)) {
    throw new AbapError(
      "BAD_INPUT",
      `key_fields must not include the client field ${p.clientField} — it always comes from sy-mandt, never from the caller.`,
      { clientField: p.clientField },
    );
  }
  const dupKey = keyFieldsUpper.find((f, i) => keyFieldsUpper.indexOf(f) !== i);
  if (dupKey) {
    throw new AbapError("BAD_INPUT", `key_fields lists ${dupKey} more than once.`, { field: dupKey });
  }

  if (p.rows.length < 1) {
    throw new AbapError("BAD_INPUT", "at least one row is required.", {});
  }
  if (p.rows.length > IMGW_MAX_ROWS) {
    throw new AbapError(
      "BAD_INPUT",
      `${p.rows.length} rows exceeds the ${IMGW_MAX_ROWS}-row limit for one call.`,
      { count: p.rows.length },
    );
  }

  p.rows.forEach((row, i) => {
    const keyNames = Object.keys(row.key).map((k) => k.toUpperCase());
    for (const kf of keyFieldsUpper) {
      if (!keyNames.includes(kf)) {
        throw new AbapError(
          "BAD_INPUT",
          `row ${i} does not supply key field ${kf} — every key field must be named, a delete can never widen its own key.`,
          { row: i, field: kf },
        );
      }
    }
    for (const name of Object.keys(row.key)) {
      const upper = name.toUpperCase();
      if (upper === clientField) {
        throw new AbapError(
          "BAD_INPUT",
          `row ${i} supplies a value for the client field ${name} — it always comes from sy-mandt, never from the caller.`,
          { row: i, field: name },
        );
      }
      if (!keyFieldsUpper.includes(upper)) {
        throw new AbapError(
          "BAD_INPUT",
          `row ${i} names key field ${name}, which is not one of this plan's key_fields.`,
          { row: i, field: name },
        );
      }
      assertRowValue(row.key[name]!, `row ${i} key ${name}`);
    }
  });
}

export function validateApplyPlan(p: ImgApplyPlan): void {
  validateProbePlan(p);
  const clientField = assertDdicIdentifier(p.clientField, "clientField").toUpperCase();

  if (p.op !== "upsert" && p.op !== "delete") {
    throw new AbapError("BAD_INPUT", `op must be "upsert" or "delete".`, { op: p.op });
  }

  assertSingleCharCode(p.expectedDeliveryClass, "expectedDeliveryClass");
  if (typeof p.expectedClientDependent !== "boolean") {
    throw new AbapError("BAD_INPUT", "expectedClientDependent must be a boolean.", {});
  }

  assertDdicIdentifier(p.view, "view");
  if (p.masterType !== "VDAT" && p.masterType !== "CDAT" && p.masterType !== "TABU") {
    throw new AbapError("BAD_INPUT", `master_type must be "VDAT", "CDAT" or "TABU".`, { masterType: p.masterType });
  }

  const fieldNamesUpper = new Set<string>();
  for (const f of p.fields) {
    const name = assertDdicIdentifier(f.field, "field").toUpperCase();
    if (name === clientField) {
      throw new AbapError(
        "BAD_INPUT",
        `field ${f.field} is the client field — it always comes from sy-mandt, and cannot be declared as a writable field.`,
        { field: f.field },
      );
    }
    fieldNamesUpper.add(name);
  }

  if (p.corrNr !== undefined) {
    assertTrkorr(p.corrNr, "imgApplyPlan");
  }

  // Value columns this plan can actually write — everything in p.fields that isn't a key. Computed
  // once, outside the per-row loop below, purely to name them in a refusal: the plan's field list
  // does not change row to row.
  const valueCols = p.fields.filter((f) => !f.key).map((f) => f.field);

  p.rows.forEach((row, i) => {
    const valueNames = Object.keys(row.values);
    // A zero-value-field upsert row is legal: SM30 itself accepts a key-only row on a table whose
    // every non-key column is optional (e.g. TB004, key BPKIND, seven optional FELDSTLSTn lists) —
    // if the row is absent it is inserted with just the key (and client) set and everything else
    // left initial; if it is already present, upserting it with no values is a no-op. There is
    // nothing here for this validator to reject.
    for (const name of valueNames) {
      const upper = name.toUpperCase();
      if (upper === clientField) {
        throw new AbapError(
          "BAD_INPUT",
          `row ${i} supplies a value for the client field ${name} — it always comes from sy-mandt, never from the caller.`,
          { row: i, field: name },
        );
      }
      if (!fieldNamesUpper.has(upper)) {
        const tail =
          valueCols.length > 0
            ? `Columns this plan can write: ${valueCols.join(", ")}.`
            : "The probe reported no non-key columns for this table.";
        throw new AbapError(
          "BAD_INPUT",
          `row ${i} names value field ${name}, which is not a column of ${p.table}. ${tail}`,
          { row: i, field: name, valueFields: valueCols },
        );
      }
      assertRowValue(row.values[name]!, `row ${i} value ${name}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export interface ImgWriteClientRow {
  mandt: string;
  cccategory: string;
  cccoractiv: string;
}

export interface ImgWriteTableRow {
  table: string;
  deliveryClass: string;
  clientDependent: boolean;
}

export interface ImgWriteFieldRow {
  table: string;
  field: string;
  key: boolean;
  dataType: string;
  length: string;
  dataElement: string;
}

export interface ImgWriteValueRow {
  row: number;
  field: string;
  len: number;
  value: string;
}

export interface ImgWriteAbsentRow {
  row: number;
}

export interface ImgWriteTrKeyRow {
  row: number;
  trkorr: string;
  len: number;
  value: string;
  /**
   * `WE_ORDER`/`WE_TASK` as `TR_OBJECTS_INSERT` actually reported them —
   * absent on an older-shaped line (before these two fields existed) or on
   * any line the generated ABAP happened to emit without them. Not the same
   * as `trkorr` above: CTS may have filed the object under a task beneath
   * the requested order rather than the order itself, so a caller comparing
   * `trkorr` against `recordedOrder`/`recordedTask` is how that divergence
   * is meant to be noticed.
   */
  recordedOrder?: string;
  recordedTask?: string;
}

export interface ImgWriteTranscript {
  client: ImgWriteClientRow | null;
  table: ImgWriteTableRow | null;
  fields: ImgWriteFieldRow[];
  before: ImgWriteValueRow[];
  beforeAbsent: ImgWriteAbsentRow[];
  trkeys: ImgWriteTrKeyRow[];
  after: ImgWriteValueRow[];
  afterAbsent: ImgWriteAbsentRow[];
  notes: string[];
  errors: string[];
  /**
   * Row numbers (1-based, same convention as every other row number in this
   * file) for which the generated ABAP's own `MODIFY`/`DELETE` returned
   * `sy-subrc 0` — i.e. an `IMGW> WROTE row=[n]` line was seen. This is NOT
   * proof the batch committed: `COMMIT WORK AND WAIT` runs only after every
   * row in the plan reaches its own `WROTE`, and the `APPLIED` marker is
   * emitted only after that commit. A caller that sees `wrote` entries but
   * no `applied` knows some row's write plausibly went through — via a
   * `sy-subrc 0` MODIFY/DELETE — even though the overall apply failed
   * somewhere after that (a later row, the commit, or the after-image read);
   * it does not know whether that write survived the commit or a rollback.
   */
  wrote: number[];
  droppedLines: number;
  probed: boolean;
  applied: number | null;
  raw: string;
}

/**
 * `len=[N]` before `value=[...]` on every row-carrying tag (BVAL/AVAL/TRKEY/
 * ERROR): a customizing field value — or an ABAP exception's `get_text( )` —
 * can itself contain `]`, which would otherwise confuse the lazy
 * `parseBracketFields` bracket match, and can carry significant trailing
 * blanks that a transport layer between the ABAP `out->write` and this
 * parser might strip.
 *
 * Deviation from a literal "slice exactly N characters after `value=[`": if
 * trailing blanks were in fact stripped upstream, that naive slice would
 * run past the real value and eat the closing `]` as data. This checks
 * whether the character at the declared length is the expected `]` first;
 * if not, it falls back to the last `]` on the line and right-pads to `len`
 * with spaces, recovering the stripped blanks instead of corrupting the
 * value. Confirmed against both a clean and a stripped-trailing-blanks case
 * in this module's own tests.
 *
 * Also returns `rest`: whatever follows the consumed `len=[...] value=[...]`
 * block. TRKEY chains this to pull further `len=[...] value=[...]`-shaped
 * fields (`order_len=`/`order=`, `task_len=`/`task=`) off the front of the
 * line before the final (and, unlike those two, mandatory) `value=[...]` —
 * ordered that way so the line's last field stays the one this function's
 * own trailing-blank fallback above already knows how to recover.
 */
function extractLenPrefixedValue(
  afterHead: string,
  fieldsRe: RegExp,
): { fields: string[]; value: string; rest: string } | null {
  const m = fieldsRe.exec(afterHead);
  if (!m) return null;
  const len = Number(m[m.length - 1]);
  if (Number.isNaN(len) || len < 0) return null;
  const tail = afterHead.slice(m[0].length);
  let raw: string;
  let consumed: number;
  if (tail.length > len && tail[len] === "]") {
    raw = tail.slice(0, len);
    consumed = len + 1;
  } else {
    const lastBracket = tail.lastIndexOf("]");
    if (lastBracket === -1) return null;
    raw = tail.slice(0, lastBracket).padEnd(len, " ");
    consumed = lastBracket + 1;
  }
  return { fields: m.slice(1), value: raw, rest: tail.slice(consumed) };
}

const VAL_RE = /^row=\[(\d+)\] field=\[([A-Za-z0-9_/]{1,30})\] len=\[(\d+)\] value=\[/;
const TRKEY_HEAD_RE = /^row=\[(\d+)\] trkorr=\[([A-Za-z0-9]{1,12})\] /;
const TRKEY_ORDER_RE = /^order_len=\[(\d+)\] order=\[/;
const TRKEY_TASK_RE = /^task_len=\[(\d+)\] task=\[/;
const TRKEY_VALUE_RE = /^len=\[(\d+)\] value=\[/;
const ABSENT_RE = /^row=\[(\d+)\]$/;
/** `get_relative_name( )`'s own charset: ABAP class/interface names, letters/digits/underscore/slash (a namespace) up to 60 chars — deliberately wider than this file's 30-char DDIC_IDENTIFIER_RE cap, since a standard exception class name is not a DDIC identifier this module generated. */
const ERROR_RE = /^class=\[([A-Za-z0-9_/]{1,60})\] len=\[(\d+)\] value=\[/;

export function parseImgWriteTranscript(text: string): ImgWriteTranscript {
  const result: ImgWriteTranscript = {
    client: null,
    table: null,
    fields: [],
    before: [],
    beforeAbsent: [],
    trkeys: [],
    after: [],
    afterAbsent: [],
    notes: [],
    errors: [],
    wrote: [],
    droppedLines: 0,
    probed: false,
    applied: null,
    raw: text,
  };

  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith(IMGW_LINE_PREFIX)) {
      const rest = line.slice(IMGW_LINE_PREFIX.length);
      const spaceIdx = rest.indexOf(" ");
      const head = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
      const remainder = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1);

      switch (head) {
        case "CLIENT": {
          const fields = parseBracketFields(remainder);
          if (fields.mandt === undefined || fields.cccategory === undefined || fields.cccoractiv === undefined) {
            result.droppedLines++;
            break;
          }
          result.client = { mandt: fields.mandt, cccategory: fields.cccategory, cccoractiv: fields.cccoractiv };
          break;
        }
        case "TABLE": {
          const fields = parseBracketFields(remainder);
          if (fields.table === undefined || fields.delclass === undefined || fields.clidep === undefined) {
            result.droppedLines++;
            break;
          }
          result.table = { table: fields.table, deliveryClass: fields.delclass, clientDependent: fields.clidep === "X" };
          break;
        }
        case "FLD": {
          const fields = parseBracketFields(remainder);
          if (
            fields.table === undefined ||
            fields.field === undefined ||
            fields.key === undefined ||
            fields.type === undefined ||
            fields.len === undefined ||
            fields.rollname === undefined
          ) {
            result.droppedLines++;
            break;
          }
          result.fields.push({
            table: fields.table,
            field: fields.field,
            key: fields.key === "X",
            dataType: fields.type,
            length: fields.len,
            dataElement: fields.rollname,
          });
          break;
        }
        case "BVAL":
        case "AVAL": {
          const parsed = extractLenPrefixedValue(remainder, VAL_RE);
          if (!parsed) {
            result.droppedLines++;
            break;
          }
          const [rowRaw, field, lenRaw] = parsed.fields;
          const row = Number(rowRaw);
          const len = Number(lenRaw);
          const entry: ImgWriteValueRow = { row, field: field!, len, value: parsed.value };
          (head === "BVAL" ? result.before : result.after).push(entry);
          break;
        }
        case "BABSENT":
        case "AABSENT": {
          const m = ABSENT_RE.exec(remainder);
          if (!m) {
            result.droppedLines++;
            break;
          }
          const entry: ImgWriteAbsentRow = { row: Number(m[1]) };
          (head === "BABSENT" ? result.beforeAbsent : result.afterAbsent).push(entry);
          break;
        }
        case "WROTE": {
          const m = ABSENT_RE.exec(remainder);
          if (!m) {
            result.droppedLines++;
            break;
          }
          result.wrote.push(Number(m[1]));
          break;
        }
        case "ERROR": {
          const parsed = extractLenPrefixedValue(remainder, ERROR_RE);
          if (!parsed) {
            result.droppedLines++;
            break;
          }
          const [exClass] = parsed.fields;
          result.errors.push(`${exClass}: ${parsed.value}`);
          break;
        }
        case "TRKEY": {
          const headM = TRKEY_HEAD_RE.exec(remainder);
          if (!headM) {
            result.droppedLines++;
            break;
          }
          const row = Number(headM[1]);
          const trkorr = headM[2]!;
          let rest = remainder.slice(headM[0].length);

          // Optional order/task pair — an older-shaped line, or one missing
          // these two fields, simply skips straight to the mandatory
          // len=[...] value=[...] below.
          let recordedOrder: string | undefined;
          let recordedTask: string | undefined;
          const orderParsed = extractLenPrefixedValue(rest, TRKEY_ORDER_RE);
          if (orderParsed) {
            recordedOrder = orderParsed.value;
            rest = orderParsed.rest.replace(/^ /, "");
            const taskParsed = extractLenPrefixedValue(rest, TRKEY_TASK_RE);
            if (taskParsed) {
              recordedTask = taskParsed.value;
              rest = taskParsed.rest.replace(/^ /, "");
            }
          }

          const valParsed = extractLenPrefixedValue(rest, TRKEY_VALUE_RE);
          if (!valParsed) {
            result.droppedLines++;
            break;
          }
          const entry: ImgWriteTrKeyRow = {
            row,
            trkorr,
            len: Number(valParsed.fields[0]),
            value: valParsed.value,
          };
          if (recordedOrder !== undefined) entry.recordedOrder = recordedOrder;
          if (recordedTask !== undefined) entry.recordedTask = recordedTask;
          result.trkeys.push(entry);
          break;
        }
        case "NOTE": {
          const fields = parseBracketFields(remainder);
          if (fields.text === undefined) {
            result.droppedLines++;
            break;
          }
          result.notes.push(fields.text);
          break;
        }
        case "PROBED": {
          const fields = parseBracketFields(remainder);
          if (fields.rows === undefined || Number.isNaN(Number(fields.rows))) {
            result.droppedLines++;
            break;
          }
          result.probed = true;
          break;
        }
        case "APPLIED": {
          const fields = parseBracketFields(remainder);
          const n = Number(fields.rows);
          if (fields.rows === undefined || Number.isNaN(n)) {
            result.droppedLines++;
            break;
          }
          result.applied = n;
          break;
        }
        default:
          result.droppedLines++;
      }
    } else if (line.startsWith(DDIC_ERR_PREFIX)) {
      result.errors.push(line.slice(DDIC_ERR_PREFIX.length).trim());
    } else if (line.startsWith(ERR_LINE_PREFIX)) {
      result.errors.push(line.slice(ERR_LINE_PREFIX.length).trim());
    } else if (line.trim() === "") {
      // blank — ignored
    } else {
      result.droppedLines++;
    }
  }

  return result;
}
