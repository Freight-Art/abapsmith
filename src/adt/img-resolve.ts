/**
 * Pure joins over a parsed `ImgTranscript` — no connection, no gate, no I/O.
 *
 * `img-bridge.ts` emits flat, denormalised rows (`ImgObjectRow`, `ImgTableRow`,
 * `ImgFieldRow`, ...); both the read renderer (`src/tools/img.ts`) and the
 * write surface being built on top of `abap_img` need the same joined shape —
 * activity -> maintenance object -> base table(s) -> key fields, with
 * delivery class and client dependence attached. This module is that shape,
 * computed once so the two callers can't drift apart on how the join is done.
 *
 * An activity behind several maintenance objects, or an object spanning
 * several base tables, is ordinary in the standard IMG — not an error. This
 * module never picks one on the caller's behalf: `primary`/`primaryTable`
 * are set only when the join is unambiguous, and `ambiguity` explains why
 * when it is not, in words a consultant reading the tool output can use.
 */

import type { ImgFieldRow, ImgObjectKind, ImgObjectRow, ImgTableRow, ImgTranscript } from "./img-bridge.js";

/**
 * Same member set as `ImgObjectKind` (`img-bridge.ts`) — aliased rather than
 * redeclared so the two can never drift apart on which kinds exist.
 */
export type ImgTargetKind = ImgObjectKind;

export type DeliveryClass = "A" | "C" | "E" | "G" | "L" | "S" | "W" | "unknown";

const DELIVERY_CLASSES: ReadonlySet<string> = new Set(["A", "C", "E", "G", "L", "S", "W"]);

/** An unrecognised or empty letter maps to "unknown" — never to a plausible-looking default. */
export function parseDeliveryClass(raw: string): DeliveryClass {
  const v = raw.trim().toUpperCase();
  return (DELIVERY_CLASSES.has(v) ? v : "unknown") as DeliveryClass;
}

export interface ResolvedField {
  readonly table: string;
  readonly field: string;
  readonly key: boolean;
  readonly position: number;
  readonly dataType: string;
  readonly length: string;
  readonly dataElement: string;
}

export interface ResolvedTable {
  readonly table: string;
  readonly clientDependent: boolean;
  readonly deliveryClass: DeliveryClass;
  readonly via: string;
  readonly fields: readonly ResolvedField[];
  /** KEYFLAG = X, in POSITION order. Includes MANDT when the bridge fetched it as a key field. */
  readonly keyFields: readonly ResolvedField[];
  readonly title: string;
}

export interface ResolvedObject {
  readonly name: string;
  readonly kind: ImgTargetKind;
  readonly objectType: string;
  readonly tables: readonly ResolvedTable[];
  readonly title: string;
}

export interface ImgPathStep {
  readonly node: string;
  readonly title: string;
}

export interface ResolvedActivity {
  readonly activity: string;
  readonly title: string;
  /** Sorted by APATH position. */
  readonly path: readonly ImgPathStep[];
  readonly objects: readonly ResolvedObject[];
  readonly doc?: { readonly docClass: string; readonly docName: string };
  /** Set only when exactly one object resolves. */
  readonly primary?: ResolvedObject;
  /** Set only when `primary` has exactly one table. */
  readonly primaryTable?: ResolvedTable;
  /** Why `primary`/`primaryTable` are absent, in the caller's words. Unset when there is no ambiguity. */
  readonly ambiguity?: string;
}

function toResolvedField(f: ImgFieldRow): ResolvedField {
  return {
    table: f.table,
    field: f.field,
    key: f.key,
    position: f.position,
    dataType: f.dataType,
    length: f.length,
    dataElement: f.dataElement,
  };
}

function buildResolvedTable(row: ImgTableRow, allFields: readonly ImgFieldRow[]): ResolvedTable {
  const fields = allFields
    .filter((f) => f.table === row.table)
    .map(toResolvedField)
    .sort((a, b) => a.position - b.position);
  const keyFields = fields.filter((f) => f.key);
  return {
    table: row.table,
    clientDependent: row.clientDependent,
    deliveryClass: parseDeliveryClass(row.deliveryClass),
    via: row.via,
    fields,
    keyFields,
    title: row.title,
  };
}

function buildResolvedObject(obj: ImgObjectRow, t: ImgTranscript): ResolvedObject {
  const tables = t.tables.filter((r) => r.object === obj.name).map((r) => buildResolvedTable(r, t.fields));
  return {
    name: obj.name,
    kind: obj.kind,
    objectType: obj.objectType,
    tables,
    title: obj.title,
  };
}

function objectsAmbiguity(objects: readonly ResolvedObject[]): string {
  const names = objects.map((o) => `${o.name} (${o.kind})`).join(", ");
  return (
    `this activity maintains ${objects.length} distinct objects — ${names} — abap_img shows all of ` +
    "them; a write must name one explicitly."
  );
}

function tablesAmbiguity(obj: ResolvedObject): string {
  const names = obj.tables.map((r) => r.table).join(", ");
  return (
    `object "${obj.name}" spans ${obj.tables.length} base tables — ${names} — a write must name one ` +
    "explicitly."
  );
}

/** Pure function over a "show" transcript: never throws, empty transcript in gives empty-but-valid value out. */
export function resolveActivity(t: ImgTranscript): ResolvedActivity {
  const activity = t.activities[0]?.activity ?? t.path[0]?.activity ?? t.objects[0]?.activity ?? t.docs[0]?.activity ?? "";
  const matches = (a: string): boolean => activity === "" || a === activity;

  const title = t.activities.find((a) => matches(a.activity))?.title ?? "";

  const path: ImgPathStep[] = t.path
    .filter((p) => matches(p.activity))
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((p) => ({ node: p.node, title: p.title }));

  const objects = t.objects.filter((o) => matches(o.activity)).map((o) => buildResolvedObject(o, t));

  const docRow = t.docs.find((d) => matches(d.activity));
  const doc = docRow ? { docClass: docRow.docClass, docName: docRow.docName } : undefined;

  let primary: ResolvedObject | undefined;
  let primaryTable: ResolvedTable | undefined;
  let ambiguity: string | undefined;

  if (objects.length === 1) {
    primary = objects[0];
  } else if (objects.length > 1) {
    ambiguity = objectsAmbiguity(objects);
  }

  if (primary) {
    if (primary.tables.length === 1) {
      primaryTable = primary.tables[0];
    } else if (primary.tables.length > 1) {
      ambiguity = tablesAmbiguity(primary);
    }
  }

  return { activity, title, path, objects, doc, primary, primaryTable, ambiguity };
}

/** Pure function over an "objects" transcript: the one object it describes, joined with its tables/fields. */
export function resolveObject(t: ImgTranscript): ResolvedObject | undefined {
  const obj = t.objects[0];
  if (!obj) return undefined;
  return buildResolvedObject(obj, t);
}
