/**
 * Text pool (text symbols, and for PROG/P and FUGR/F also selection texts
 * and list/column headings) over the ADT textelements resource (issue #182,
 * extended #199) — a sub-resource of the object, not its source, with its
 * own lock/activate lifecycle. Three sibling collections share the same
 * media types and descriptor XML: `/sap/bc/adt/textelements/programs`
 * (PROG/P, adtcore:type PROG/PX, symbols+selections+headings),
 * `/sap/bc/adt/textelements/classes` (CLAS/OC, CLAS/OCX, symbols only) and
 * `/sap/bc/adt/textelements/functiongroups` (FUGR/F, FUGR/PX,
 * symbols+selections+headings). Live-confirmed shapes: see
 * `test/fixtures/textelements/provenance.json` and its sibling fixtures.
 * Locking/activating the object's own uri does not work for this resource —
 * both must target the textelements uri itself.
 */
import { activateObject, type ActivationOutcome } from "./activate.js";
import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import { translateAdtError } from "./session.js";
import type { ResolvedTarget } from "./write.js";
import type { AuthorizedTarget, MutatingOperation } from "../safety.js";

export type TextPoolObjectType = "PROG/P" | "CLAS/OC" | "FUGR/F";
export const TEXT_POOL_TYPES: readonly TextPoolObjectType[] = ["PROG/P", "CLAS/OC", "FUGR/F"];

interface TextPoolSpec {
  collection: string;
  resourceType: string;
  selections: boolean;
  headings: boolean;
}

const TEXT_POOL_SPECS: Record<TextPoolObjectType, TextPoolSpec> = {
  "PROG/P": {
    collection: "/sap/bc/adt/textelements/programs",
    resourceType: "PROG/PX",
    selections: true,
    headings: true,
  },
  "CLAS/OC": {
    collection: "/sap/bc/adt/textelements/classes",
    resourceType: "CLAS/OCX",
    selections: false,
    headings: false,
  },
  "FUGR/F": {
    collection: "/sap/bc/adt/textelements/functiongroups",
    resourceType: "FUGR/PX",
    selections: true,
    headings: true,
  },
};

export const TEXTELEMENTS_COLLECTION = TEXT_POOL_SPECS["PROG/P"].collection;
export const TEXTELEMENTS_ACCEPT = "application/vnd.sap.adt.textelements.v1+xml";

const SYMBOLS_MEDIA_TYPE = "application/vnd.sap.adt.textelements.symbols.v1";
const SELECTIONS_MEDIA_TYPE = "application/vnd.sap.adt.textelements.selections.v1";
const HEADINGS_MEDIA_TYPE = "application/vnd.sap.adt.textelements.headings.v1";

const SYMBOL_KEY_RE = /^[A-Z0-9]{1,3}$/;
const SELECTION_NAME_RE = /^[A-Z0-9_]{1,8}$/;

export function isTextPoolType(type: string | undefined): type is TextPoolObjectType {
  return type !== undefined && Object.hasOwn(TEXT_POOL_SPECS, type);
}

export function assertTextPoolType(
  type: string | undefined,
  details: Record<string, unknown>,
): asserts type is TextPoolObjectType {
  if (isTextPoolType(type)) return;
  throw new AbapError(
    "BAD_INPUT",
    "`text_pool` applies to PROG/P, CLAS/OC and FUGR/F only, not " + (type ?? "an unknown type") + ".",
    details,
  );
}

export function assertTextPoolShape(
  type: TextPoolObjectType,
  pool: TextPoolInput,
  details: Record<string, unknown>,
): void {
  const spec = TEXT_POOL_SPECS[type];
  if (spec.selections) return;
  if (pool.selectionTexts !== undefined) {
    throw new AbapError(
      "BAD_INPUT",
      "`text_pool.selection_texts` applies to PROG/P and FUGR/F only: a " +
        `${type} text pool has text symbols only.`,
      details,
    );
  }
  if (pool.headings !== undefined) {
    throw new AbapError(
      "BAD_INPUT",
      "`text_pool.headings` applies to PROG/P and FUGR/F only: a " +
        `${type} text pool has text symbols only.`,
      details,
    );
  }
}

export function textPoolUri(name: string, type: TextPoolObjectType = "PROG/P"): string {
  return `${TEXT_POOL_SPECS[type].collection}/${name.toLowerCase()}`;
}

export function textPoolResourceType(type: TextPoolObjectType): string {
  return TEXT_POOL_SPECS[type].resourceType;
}

export interface TextPoolHeadings {
  listHeader?: string;
  columnHeaders?: string[];
}

export interface TextPoolInput {
  symbols?: Record<string, string>;
  selectionTexts?: Record<string, string>;
  headings?: TextPoolHeadings;
}

export interface TextPool {
  symbols: Record<string, string>;
  selectionTexts: Record<string, string>;
  headings: TextPoolHeadings;
}

/**
 * Canonical JSON snapshot of a text pool (issue #200's before/after image for
 * undo), keys uppercased and sorted so two logically-identical pools always
 * serialise identically. `undefined pool` and a `CLAS/OC` pool's absent
 * selections/headings both canonicalise to all-empty — see `TEXT_POOL_SPECS`.
 * `parseTextPoolImage()` is the inverse.
 */
export function textPoolImage(pool: TextPool | undefined, type: TextPoolObjectType): string {
  const symbols = canonicalStringRecord(pool?.symbols ?? {});
  if (!TEXT_POOL_SPECS[type].selections) {
    return JSON.stringify({ symbols });
  }
  const selectionTexts = canonicalStringRecord(pool?.selectionTexts ?? {});
  const headings = pool?.headings ?? {};
  return JSON.stringify({
    symbols,
    selectionTexts,
    headings: {
      listHeader: headings.listHeader ?? "",
      columnHeaders: headings.columnHeaders ?? [],
    },
  });
}

/** Keys uppercased, then sorted — matches `textPoolImage()`'s canonical form. */
function canonicalStringRecord(rec: Record<string, string>): Record<string, string> {
  const entries = Object.entries(rec).map(([k, v]) => [k.toUpperCase(), v] as const);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return Object.fromEntries(entries);
}

function parseStringRecord(value: unknown, field: string, type: TextPoolObjectType): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AbapError("BAD_INPUT", `Text pool image "${field}" must be an object.`, { type });
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== "string") {
      throw new AbapError("BAD_INPUT", `Text pool image "${field}.${k}" must be a string.`, { type });
    }
    out[k] = v;
  }
  return out;
}

/**
 * The inverse of `textPoolImage()`. Only ever fed abapsmith's own blobs, so a
 * malformed one means the journal was corrupted or hand-edited, not a caller
 * mistake to explain gently. Returns a complete `TextPool` — empty parts
 * filled in, not left absent.
 */
export function parseTextPoolImage(text: string, type: TextPoolObjectType): TextPool {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new AbapError("BAD_INPUT", `Text pool image is not valid JSON: ${(e as Error).message}`, { type });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AbapError("BAD_INPUT", "Text pool image must be a JSON object.", { type });
  }
  const obj = parsed as Record<string, unknown>;
  const symbols = parseStringRecord(obj.symbols, "symbols", type);

  if (!TEXT_POOL_SPECS[type].selections) {
    return { symbols, selectionTexts: {}, headings: {} };
  }

  const selectionTexts = parseStringRecord(obj.selectionTexts, "selectionTexts", type);
  const headingsRaw = obj.headings;
  if (typeof headingsRaw !== "object" || headingsRaw === null || Array.isArray(headingsRaw)) {
    throw new AbapError("BAD_INPUT", 'Text pool image "headings" must be an object.', { type });
  }
  const h = headingsRaw as Record<string, unknown>;
  if (h.listHeader !== undefined && typeof h.listHeader !== "string") {
    throw new AbapError("BAD_INPUT", 'Text pool image "headings.listHeader" must be a string.', { type });
  }
  const columnHeadersRaw = h.columnHeaders;
  if (
    columnHeadersRaw !== undefined &&
    (!Array.isArray(columnHeadersRaw) || !columnHeadersRaw.every((c) => typeof c === "string"))
  ) {
    throw new AbapError(
      "BAD_INPUT",
      'Text pool image "headings.columnHeaders" must be an array of strings.',
      { type },
    );
  }

  return {
    symbols,
    selectionTexts,
    headings: {
      listHeader: typeof h.listHeader === "string" ? h.listHeader : "",
      columnHeaders: (columnHeadersRaw as string[] | undefined) ?? [],
    },
  };
}

/** `@MaxLength:N` + `KEY=text` per entry, blank-line separated, uppercased keys. */
export function buildSymbolsBody(symbols: Record<string, string>): string {
  const entries = Object.entries(symbols).map(([rawKey, text]) => {
    const key = rawKey.toUpperCase();
    if (!SYMBOL_KEY_RE.test(key)) {
      throw new AbapError(
        "BAD_INPUT",
        `Text symbol key "${rawKey}" must be 1-3 letters/digits.`,
        { key: rawKey },
      );
    }
    if (text.length === 0 || text.length > 132) {
      throw new AbapError(
        "BAD_INPUT",
        `Text symbol ${key}: text must be 1-132 characters, got ${text.length}.`,
        { key, length: text.length },
      );
    }
    const maxLength = Math.min(Math.max(text.length, 1), 132);
    return `@MaxLength:${maxLength}\n${key}=${text}`;
  });
  return entries.join("\n\n") + "\n";
}

/** `NAME=text` per line, uppercased names. Server pads NAME to 8 chars on read; not done here. */
export function buildSelectionsBody(selectionTexts: Record<string, string>): string {
  return Object.entries(selectionTexts)
    .map(([rawName, text]) => {
      const name = rawName.toUpperCase();
      if (!SELECTION_NAME_RE.test(name)) {
        throw new AbapError(
          "BAD_INPUT",
          `Selection text name "${rawName}" must be 1-8 letters/digits/underscore.`,
          { name: rawName },
        );
      }
      if (text.length === 0 || text.length > 30) {
        throw new AbapError(
          "BAD_INPUT",
          `Selection text ${name}: text must be 1-30 characters, got ${text.length}.`,
          { name, length: text.length },
        );
      }
      return `${name}=${text}\n`;
    })
    .join("");
}

/** Always emits all five lines so the PUT replaces the whole sub-resource; absent entries are blank. */
export function buildHeadingsBody(headings: TextPoolHeadings): string {
  const listHeader = headings.listHeader ?? "";
  if (listHeader.length > 70) {
    throw new AbapError(
      "BAD_INPUT",
      `List header must be at most 70 characters, got ${listHeader.length}.`,
      { length: listHeader.length },
    );
  }
  const columnHeaders = headings.columnHeaders ?? [];
  if (columnHeaders.length > 4) {
    throw new AbapError(
      "BAD_INPUT",
      `At most 4 column headers are allowed, got ${columnHeaders.length}.`,
      { count: columnHeaders.length },
    );
  }
  const cols: string[] = [];
  for (let i = 0; i < 4; i++) {
    const text = columnHeaders[i] ?? "";
    if (text.length > 132) {
      throw new AbapError(
        "BAD_INPUT",
        `Column header ${i + 1}: text must be at most 132 characters, got ${text.length}.`,
        { index: i + 1, length: text.length },
      );
    }
    cols.push(text);
  }
  return `listHeader=${listHeader}\n\ncolumnHeader_1=${cols[0]}\ncolumnHeader_2=${cols[1]}\n` +
    `columnHeader_3=${cols[2]}\ncolumnHeader_4=${cols[3]}\n`;
}

/** Ignores `@MaxLength:` and blank lines; tolerates CRLF; splits at the first `=`. */
export function parseSymbols(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split(/\r\n|\r|\n/)) {
    if (line.trim() === "" || line.startsWith("@MaxLength:")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

/** Skips entries whose text is exactly `?...` (untexted parameter marker). */
export function parseSelections(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split(/\r\n|\r|\n/)) {
    if (line.trim() === "") continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const name = line.slice(0, idx).trimEnd();
    const text = line.slice(idx + 1);
    if (text === "?...") continue;
    out[name] = text;
  }
  return out;
}

/** Tolerates CRLF/CR/LF and blank lines; trailing empty column headers are trimmed off. */
export function parseHeadings(body: string): TextPoolHeadings {
  let listHeader: string | undefined;
  const columns: string[] = ["", "", "", ""];
  for (const line of body.split(/\r\n|\r|\n/)) {
    if (line.trim() === "") continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const key = line.slice(0, idx);
    const text = line.slice(idx + 1);
    if (key === "listHeader") {
      if (text !== "") listHeader = text;
      continue;
    }
    const m = /^columnHeader_([1-4])$/.exec(key);
    if (m && m[1] !== undefined) columns[Number(m[1]) - 1] = text;
  }
  while (columns.length > 0 && columns[columns.length - 1] === "") columns.pop();
  const out: TextPoolHeadings = {};
  if (listHeader !== undefined) out.listHeader = listHeader;
  if (columns.length > 0) out.columnHeaders = columns;
  return out;
}

export function countHeadings(h: TextPoolHeadings): number {
  const listCount = h.listHeader !== undefined && h.listHeader !== "" ? 1 : 0;
  const colCount = (h.columnHeaders ?? []).filter((c) => c !== "").length;
  return listCount + colCount;
}

export interface TextPoolWriteResult {
  type: TextPoolObjectType;
  symbols: number;
  selectionTexts: number;
  headings?: number;
  language: string;
  activation?: ActivationOutcome;
}

/**
 * Reads the descriptor for `adtcore:masterLanguage`, then locks the
 * textelements uri (NOT the object's own uri — see module doc), PUTs
 * whichever of symbols/selections/headings were given, unlocks, and — only
 * once the session has fully closed, since activating under your own lock
 * is a 403 — optionally activates the textelements uri itself.
 */
export async function writeTextPool(
  conn: AbapConnection,
  authorized: AuthorizedTarget<MutatingOperation, ResolvedTarget>,
  pool: TextPoolInput,
  opts: { activate: boolean; corrNr?: string },
): Promise<TextPoolWriteResult> {
  if (authorized.op !== "write") {
    throw new AbapError("BAD_INPUT", `Text pool write needs a write authorization, got "${authorized.op}".`);
  }
  const name = authorized.target.name;
  const type = authorized.target.type;
  assertTextPoolType(type, { type, name });
  assertTextPoolShape(type, pool, { type, name });
  const uri = textPoolUri(name, type);

  let masterLanguage = "EN";
  try {
    const descriptor = await conn.get(uri, { headers: { Accept: TEXTELEMENTS_ACCEPT } });
    const m = /adtcore:masterLanguage="([^"]*)"/.exec(descriptor.body);
    if (m && m[1] !== undefined) masterLanguage = m[1];
  } catch (e) {
    throw translateAdtError(e, { operation: "write", uri, name, type });
  }
  const language = masterLanguage || "EN";

  const symbolsBody = pool.symbols ? buildSymbolsBody(pool.symbols) : undefined;
  const selectionsBody = pool.selectionTexts ? buildSelectionsBody(pool.selectionTexts) : undefined;
  const headingsBody = pool.headings ? buildHeadingsBody(pool.headings) : undefined;

  await conn.withStatefulSession(async (session) => {
    const lock = await session.lock(uri);
    const corrNr = opts.corrNr ?? lock.corrNr;
    try {
      if (symbolsBody !== undefined) {
        await conn.put(`${uri}/source/symbols`, {
          headers: { "Content-Type": SYMBOLS_MEDIA_TYPE, Accept: SYMBOLS_MEDIA_TYPE },
          qs: { lockHandle: lock.handle, ...(corrNr ? { corrNr } : {}) },
          body: symbolsBody,
        });
      }
      if (selectionsBody !== undefined) {
        await conn.put(`${uri}/source/selections`, {
          headers: { "Content-Type": SELECTIONS_MEDIA_TYPE, Accept: SELECTIONS_MEDIA_TYPE },
          qs: { lockHandle: lock.handle, ...(corrNr ? { corrNr } : {}) },
          body: selectionsBody,
        });
      }
      if (headingsBody !== undefined) {
        await conn.put(`${uri}/source/headings`, {
          headers: { "Content-Type": HEADINGS_MEDIA_TYPE, Accept: HEADINGS_MEDIA_TYPE },
          qs: { lockHandle: lock.handle, ...(corrNr ? { corrNr } : {}) },
          body: headingsBody,
        });
      }
    } catch (e) {
      throw translateAdtError(e, { operation: "write", uri, name, type });
    } finally {
      await session.unlock(uri);
    }
  });

  let activation: ActivationOutcome | undefined;
  if (opts.activate) {
    activation = await activateObject(conn, { name, uri, type: textPoolResourceType(type) });
  }

  return {
    type,
    symbols: pool.symbols ? Object.keys(pool.symbols).length : 0,
    selectionTexts: pool.selectionTexts ? Object.keys(pool.selectionTexts).length : 0,
    ...(pool.headings ? { headings: countHeadings(pool.headings) } : {}),
    language,
    activation,
  };
}

export function textPoolWriteSummary(r: TextPoolWriteResult): string {
  if (r.type === "CLAS/OC") return `symbols ${r.symbols} (${r.language})`;
  const headingsPart = r.headings !== undefined ? `, headings ${r.headings}` : "";
  return `symbols ${r.symbols}, selection_texts ${r.selectionTexts}${headingsPart} (${r.language})`;
}

/**
 * GETs symbols always; selections and headings only for a type whose spec
 * has them. `undefined` when everything comes back empty. Errors propagate.
 */
export async function readTextPool(
  conn: AbapConnection,
  name: string,
  type: TextPoolObjectType = "PROG/P",
): Promise<TextPool | undefined> {
  const spec = TEXT_POOL_SPECS[type];
  const uri = textPoolUri(name, type);
  const symbolsRes = await conn.get(`${uri}/source/symbols`, { headers: { Accept: SYMBOLS_MEDIA_TYPE } });
  const symbols = parseSymbols(symbolsRes.body);

  let selectionTexts: Record<string, string> = {};
  if (spec.selections) {
    const selectionsRes = await conn.get(`${uri}/source/selections`, { headers: { Accept: SELECTIONS_MEDIA_TYPE } });
    selectionTexts = parseSelections(selectionsRes.body);
  }

  let headings: TextPoolHeadings = {};
  if (spec.headings) {
    const headingsRes = await conn.get(`${uri}/source/headings`, { headers: { Accept: HEADINGS_MEDIA_TYPE } });
    headings = parseHeadings(headingsRes.body);
  }

  if (Object.keys(symbols).length === 0 && Object.keys(selectionTexts).length === 0 && countHeadings(headings) === 0) {
    return undefined;
  }
  return { symbols, selectionTexts, headings };
}
