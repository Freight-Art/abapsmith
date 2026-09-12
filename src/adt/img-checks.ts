/**
 * Read-only disclosure for `abap_img_edit` writes: names the view maintenance
 * event routines that a plain MODIFY on the base table will NOT run, the
 * check tables whose foreign keys a plain MODIFY does NOT verify, and any
 * written value that is not a fixed value of its field's domain.
 *
 * This exists because `abap_img_edit` writes customizing rows with a plain
 * MODIFY on the base table (see issue #62) — none of the maintenance view's
 * own checks (the ones SM30 would run: TVIMF event routines, foreign-key
 * lookups against check tables, fixed-value validation against a domain) run
 * on that path. This module does not change that: it does not run any of
 * those checks itself and it changes no write semantics anywhere. It only
 * reads the same DDIC catalog tables a human maintaining the view through
 * SM30 would implicitly rely on, and reports, in plain language, what a
 * plain MODIFY skipped, so a caller can judge whether that gap matters for
 * this particular write before or after it happens.
 *
 * Every read here is a diagnostic side-read and must never be the reason a
 * write fails: a missing column, a malformed row or an unexpected response
 * shape is reported as a note, not thrown. A transport-level failure from
 * `dataPreviewFreestyle` itself is not tolerated here — it propagates, and
 * the caller is expected to wrap the whole `readImgChecks` call in try/catch
 * (see `ImgReadConnection`'s doc comment in `img-read.ts`).
 */
import type { ImgReadConnection } from "./img-read.js";
import {
  buildDomainFixedValuesQuery,
  buildDomainValueTextsQuery,
  buildTableFieldChecksQuery,
  buildViewMaintenanceEventsQuery,
  buildViewsOverTableQuery,
  toRecordSet,
  type PreviewRecord,
  type PreviewRecordSet,
} from "./img-query.js";
import { IMG_CATALOG, MAINTENANCE_EVENT_DOMAIN, type ImgCatalogKey } from "./img-catalog.js";

// -------------------------------------------------------------- catalog io ---

function tbl<K extends ImgCatalogKey>(key: K): string {
  return IMG_CATALOG[key].table;
}

function fld<K extends ImgCatalogKey, F extends keyof (typeof IMG_CATALOG)[K]["fields"]>(key: K, field: F): string {
  const fields = IMG_CATALOG[key].fields as Record<F, string>;
  return fields[field];
}

// ------------------------------------------------------------------ tuning ---

/** Row cap for every query this module issues — a diagnostic side-read has no business fetching more. */
const IMG_CHECKS_ROW_CAP = 200;

/** Cap on distinct names looked up in TVIMF in one call (see `readImgChecks` step 3). */
const TVIMF_LOOKUP_MAX = 20;

// -------------------------------------------------------------------- types ---

/** One TVIMF maintenance event routine that a plain MODIFY does not run. */
export interface ImgMaintenanceEvent {
  /** TVIMF-TABNAME — the maintenance view (or table) name the event is registered against. */
  readonly view: string;
  /** TVIMF-EVENT, e.g. "01". */
  readonly event: string;
  /** TVIMF-FORMNAME, e.g. "V_TB003_CHECK_DEFAULT". */
  readonly formName: string;
  /** DD07T text for domain MAINTEVENT describing what this event code means; "" when unknown. */
  readonly description: string;
}

/** One field whose foreign-key check (DD03L-CHECKTABLE) a plain MODIFY does not verify. */
export interface ImgCheckTableRef {
  readonly field: string;
  readonly checkTable: string;
}

/** One written value that does not exactly match any fixed value of its field's domain. */
export interface ImgFixedValueFinding {
  readonly field: string;
  readonly domain: string;
  readonly value: string;
  readonly allowed: readonly string[];
}

/** One row of the write this call is disclosing checks for — key columns, and value columns when the write sets values. */
export interface ImgChecksRow {
  readonly key: Readonly<Record<string, string>>;
  readonly values?: Readonly<Record<string, string>>;
}

/** What `readImgChecks` needs to know about the write it is disclosing checks for. */
export interface ImgChecksQuery {
  /** Base table the write targets, e.g. "TB003". */
  readonly table: string;
  /** The view/master name the caller passed — may equal `table` when the caller addressed the base table directly. */
  readonly view: string;
  /** Client field name, e.g. "CLIENT" — excluded from the written-field analysis. */
  readonly clientField: string;
  readonly language: string;
  /** false for a delete: no values are written, so no fixed-value analysis runs. */
  readonly checkValues: boolean;
  readonly rows: readonly ImgChecksRow[];
}

/** What a plain MODIFY on `table` will not run or verify, for the write described by `ImgChecksQuery`. */
export interface ImgChecksResult {
  readonly table: string;
  /** The names the TVIMF lookup actually covered (see `readImgChecks` step 3). */
  readonly views: readonly string[];
  readonly events: readonly ImgMaintenanceEvent[];
  readonly checkTables: readonly ImgCheckTableRef[];
  readonly fixedValueFindings: readonly ImgFixedValueFinding[];
  readonly notes: readonly string[];
  readonly statementsIssued: number;
  readonly durationMs: number;
}

// ------------------------------------------------------------------- reads ---

interface Ctx {
  statementsIssued: number;
}

async function runQuery(conn: ImgReadConnection, ctx: Ctx, sql: string): Promise<PreviewRecordSet> {
  const resp = await conn.dataPreviewFreestyle(sql, IMG_CHECKS_ROW_CAP);
  ctx.statementsIssued++;
  return toRecordSet(resp.body);
}

/** In-band server messages, tagged the same way `img-read.ts`'s own (private) `serverNotes` does — small, deliberate duplication rather than exporting that helper. */
function serverNotes(rs: PreviewRecordSet): string[] {
  return rs.messages.map((m) => `[server] ${m.text}${m.severity ? ` (${m.severity})` : ""}`);
}

/**
 * Maps every record of `rs` through `fn`, defensively: a record for which
 * `fn` returns `undefined` (an expected column came back missing) is
 * dropped, not thrown on, and one summary note names how many rows of
 * `queryLabel` were unusable — see the module's tolerance requirement.
 */
function mapRows<T>(rs: PreviewRecordSet, queryLabel: string, notes: string[], fn: (r: PreviewRecord) => T | undefined): T[] {
  const out: T[] = [];
  let skipped = 0;
  for (const r of rs.records) {
    const v = fn(r);
    if (v === undefined) {
      skipped++;
      continue;
    }
    out.push(v);
  }
  if (skipped > 0) {
    notes.push(`${queryLabel} returned ${skipped} row(s) with an unusable shape (an expected column was missing) — they were skipped.`);
  }
  return out;
}

// -------------------------------------------------------------- read logic ---

/**
 * Reads the union, over `rows`, of `row.key`'s keys and — only when
 * `checkValues` is true — `row.values`'s keys, upper-cased and with
 * `clientField` removed, each in first-appearance order. `valueFields` is
 * the same union restricted to `row.values` alone (never `row.key`) — the
 * set fixed-value checking (step 6 below) cares about, since a key column
 * addresses a row rather than writing an arbitrary value into it.
 */
function collectWrittenFields(
  rows: readonly ImgChecksRow[],
  clientField: string,
  checkValues: boolean,
): { writtenFields: string[]; valueFields: string[] } {
  const clientUpper = clientField.trim().toUpperCase();
  const writtenFields: string[] = [];
  const writtenSeen = new Set<string>();
  const valueFields: string[] = [];
  const valueSeen = new Set<string>();

  const addWritten = (name: string) => {
    const u = name.toUpperCase();
    if (u === clientUpper) return;
    if (!writtenSeen.has(u)) {
      writtenSeen.add(u);
      writtenFields.push(u);
    }
  };
  const addValue = (name: string) => {
    const u = name.toUpperCase();
    if (u === clientUpper) return;
    if (!valueSeen.has(u)) {
      valueSeen.add(u);
      valueFields.push(u);
    }
  };

  for (const row of rows) {
    for (const k of Object.keys(row.key)) addWritten(k);
    if (checkValues && row.values) {
      for (const k of Object.keys(row.values)) {
        addWritten(k);
        addValue(k);
      }
    }
  }
  return { writtenFields, valueFields };
}

/** Case-insensitive lookup of `field` (already upper-cased) in `row.values`. `undefined` when the row does not carry that field at all. */
function readWrittenValue(row: ImgChecksRow, field: string): string | undefined {
  if (!row.values) return undefined;
  for (const [k, v] of Object.entries(row.values)) {
    if (k.toUpperCase() === field) return v;
  }
  return undefined;
}

/**
 * Discloses, for one `abap_img_edit` write, what a plain MODIFY on the base
 * table will not run or verify: TVIMF maintenance event routines, DD03L
 * check-table foreign keys, and DD07L fixed values. Read-only — issues a
 * bounded, small number of SELECTs (one per step below, each skipped when
 * its own input list would be empty) and never writes anything.
 *
 * Steps (each one SELECT):
 *  1. Determine the written fields (and, of those, the written value fields)
 *     from `q.rows` — see `collectWrittenFields`.
 *  2. `buildViewsOverTableQuery([q.table])` — candidate maintenance views
 *     whose root base table (DD26S TABPOS 0001) is `q.table`.
 *  3. Build the TVIMF lookup set — `q.view`, `q.table`, then the candidate
 *     views from step 2, deduplicated and upper-cased, capped at
 *     `TVIMF_LOOKUP_MAX` names — and look up their maintenance events.
 *     `result.views` is exactly this lookup set.
 *  4. Only if step 3 found events: look up DD07T text for the MAINTEVENT
 *     domain's codes, in `q.language`, to describe each event.
 *  5. `buildTableFieldChecksQuery([q.table])` — DD03L's CHECKTABLE/DOMNAME
 *     per field. `checkTables` reports every written field with a non-blank
 *     CHECKTABLE; the DOMNAME half feeds step 6.
 *  6. Only when `q.checkValues` and at least one written *value* field has a
 *     non-blank domain: look up that domain's DD07L fixed values and compare
 *     every written value against them.
 */
export async function readImgChecks(conn: ImgReadConnection, q: ImgChecksQuery): Promise<ImgChecksResult> {
  const started = Date.now();
  const ctx: Ctx = { statementsIssued: 0 };
  const notes: string[] = [];

  // Step 1.
  const { writtenFields, valueFields } = collectWrittenFields(q.rows, q.clientField, q.checkValues);

  // Step 2.
  const viewsRs = await runQuery(conn, ctx, buildViewsOverTableQuery([q.table]));
  notes.push(...serverNotes(viewsRs));
  const candidateViews = mapRows(viewsRs, tbl("viewBaseTable"), notes, (r) => r[fld("viewBaseTable", "view")]);

  // Step 3.
  const lookupOrder = [q.view, q.table, ...candidateViews];
  const seen = new Set<string>();
  const lookupSet: string[] = [];
  for (const raw of lookupOrder) {
    const v = raw.trim().toUpperCase();
    if (v === "" || seen.has(v)) continue;
    seen.add(v);
    lookupSet.push(v);
  }
  const truncated = lookupSet.length > TVIMF_LOOKUP_MAX;
  const views = truncated ? lookupSet.slice(0, TVIMF_LOOKUP_MAX) : lookupSet;
  if (truncated) {
    notes.push(
      `The ${tbl("viewMaintenanceEvent")} lookup covers ${views.length} of ${lookupSet.length} candidate view/table names — the rest were dropped.`,
    );
  }

  let events: ImgMaintenanceEvent[] = [];
  if (views.length > 0) {
    const eventsRs = await runQuery(conn, ctx, buildViewMaintenanceEventsQuery(views));
    notes.push(...serverNotes(eventsRs));
    events = mapRows(eventsRs, tbl("viewMaintenanceEvent"), notes, (r) => {
      const view = r[fld("viewMaintenanceEvent", "view")];
      const event = r[fld("viewMaintenanceEvent", "event")];
      const formName = r[fld("viewMaintenanceEvent", "formName")];
      if (view === undefined || event === undefined || formName === undefined) return undefined;
      return { view, event, formName, description: "" };
    });
  }

  // Step 4.
  if (events.length > 0) {
    const codeToText = new Map<string, string>();
    const textsRs = await runQuery(conn, ctx, buildDomainValueTextsQuery([MAINTENANCE_EVENT_DOMAIN], q.language));
    notes.push(...serverNotes(textsRs));
    mapRows(textsRs, tbl("domainValueText"), notes, (r) => {
      const code = r[fld("domainValueText", "valueLow")];
      const text = r[fld("domainValueText", "text")];
      if (code === undefined || text === undefined) return undefined;
      codeToText.set(code, text);
      return true;
    });
    const missingCodes = new Set<string>();
    events = events.map((e) => {
      const description = codeToText.get(e.event);
      if (description === undefined) missingCodes.add(e.event);
      return { ...e, description: description ?? "" };
    });
    for (const code of missingCodes) {
      notes.push(`No ${tbl("domainValueText")} text for maintenance event code "${code}" (domain ${MAINTENANCE_EVENT_DOMAIN}, language "${q.language}").`);
    }
  }

  // Step 5.
  const checkTables: ImgCheckTableRef[] = [];
  const domainByField = new Map<string, string>();
  const fieldChecksRs = await runQuery(conn, ctx, buildTableFieldChecksQuery([q.table]));
  notes.push(...serverNotes(fieldChecksRs));
  const fieldInfo = new Map<string, { checkTable: string; domain: string }>();
  mapRows(fieldChecksRs, tbl("ddicField"), notes, (r) => {
    const field = r[fld("ddicField", "field")];
    const checkTable = r[fld("ddicField", "checkTable")];
    const domain = r[fld("ddicField", "domainName")];
    if (field === undefined || checkTable === undefined || domain === undefined) return undefined;
    fieldInfo.set(field.toUpperCase(), { checkTable, domain });
    return true;
  });
  for (const field of writtenFields) {
    const info = fieldInfo.get(field);
    if (info === undefined) continue;
    if (info.checkTable.trim() !== "") checkTables.push({ field, checkTable: info.checkTable.trim() });
    if (info.domain.trim() !== "") domainByField.set(field, info.domain.trim());
  }

  // Step 6.
  const fixedValueFindings: ImgFixedValueFinding[] = [];
  const valueFieldsWithDomain = valueFields.filter((f) => domainByField.has(f));
  if (q.checkValues && valueFieldsWithDomain.length > 0) {
    const domains = [...new Set(valueFieldsWithDomain.map((f) => domainByField.get(f)!))];
    const domainRowsMap = new Map<string, { valueLow: string; valueHigh: string }[]>();
    const domainValuesRs = await runQuery(conn, ctx, buildDomainFixedValuesQuery(domains));
    notes.push(...serverNotes(domainValuesRs));
    mapRows(domainValuesRs, tbl("domainValue"), notes, (r) => {
      const domain = r[fld("domainValue", "domain")];
      const valueLow = r[fld("domainValue", "valueLow")];
      const valueHigh = r[fld("domainValue", "valueHigh")];
      if (domain === undefined || valueLow === undefined || valueHigh === undefined) return undefined;
      const list = domainRowsMap.get(domain);
      if (list) list.push({ valueLow, valueHigh });
      else domainRowsMap.set(domain, [{ valueLow, valueHigh }]);
      return true;
    });

    for (const field of valueFieldsWithDomain) {
      const domain = domainByField.get(field)!;
      const domainRows = domainRowsMap.get(domain);
      if (domainRows === undefined || domainRows.length === 0) continue; // no fixed values defined — nothing to check
      const isRange = domainRows.some((r) => r.valueHigh.trim() !== "");
      if (isRange) {
        notes.push(
          `Field "${field}"'s domain "${domain}" defines a value range (${tbl("domainValue")}.${fld("domainValue", "valueHigh")} is set on at least one row) — its written value was not checked against fixed values.`,
        );
        continue;
      }
      const allowed = domainRows.map((r) => r.valueLow);
      const emitted = new Set<string>();
      for (const row of q.rows) {
        const raw = readWrittenValue(row, field);
        if (raw === undefined) continue;
        const trimmed = raw.trim();
        if (trimmed === "") continue; // blank normally means "not set" — not a fixed-value violation
        // Case-insensitive: on a live system, a field whose domain has no LOWERCASE flag is
        // upper-cased by the ABAP layer before it is ever compared against DOMVALUE_L, so a
        // caller writing e.g. "x" into an XFELD field would otherwise be flagged as violating
        // fixed value "X" — a false positive. This module deliberately under-reports rather
        // than raise one.
        if (allowed.some((a) => a.trim().toUpperCase() === trimmed.toUpperCase())) continue;
        if (emitted.has(trimmed)) continue;
        emitted.add(trimmed);
        fixedValueFindings.push({ field, domain, value: trimmed, allowed });
      }
    }
  }

  return {
    table: q.table,
    views,
    events,
    checkTables,
    fixedValueFindings,
    notes,
    statementsIssued: ctx.statementsIssued,
    durationMs: Date.now() - started,
  };
}
