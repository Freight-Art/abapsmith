/**
 * `doc/CAPABILITIES/object-types.md` claims its object-type table is derived
 * mechanically from the write-capability registry. This recomputes every
 * cell from the registry's own exports and compares, so a registry change
 * unreflected in the doc fails the suite. The framework and non-object
 * tables (in their own sibling files under `doc/CAPABILITIES/`) cannot be
 * derived from anything; for those this only checks structure.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OUT_OF_REGISTRY_CREATE } from "../scripts/gen-capability-table.mjs";
import {
  BRIDGE_CREATABLE_TYPES,
  BRIDGE_CREATE_REFUSED_TYPES,
  BRIDGE_DELETABLE_TYPES,
  DELETABLE_TYPES,
  REGISTRY,
  VERIFIED_CREATABLE_TYPES,
} from "../src/adt/capabilities.js";
import { TYPES } from "../src/adt/types.js";
import { ddicStrategy } from "../src/adt/ddic.js";

// Enhancement delete has no registry field of any kind: `deleteEnhancementObject`
// in src/adt/enhancement-write.ts really deletes these three, but none appears in
// DELETABLE_TYPES or BRIDGE_DELETABLE_TYPES and abap_write op:"delete" refuses
// them. Hand-maintained, and the only hand-maintained input to this derivation.
const OUT_OF_REGISTRY_DELETE = new Set(["ENHO/XH", "ENHO/XHH", "ENHS/XS"]);

// The capability matrix was split into one file per topic under
// doc/CAPABILITIES/ — each table now lives in its own file rather than under
// a shared heading in one monolith.
function readDoc(name: string): string {
  return readFileSync(new URL(`../doc/CAPABILITIES/${name}`, import.meta.url), "utf8");
}
const objectTypesDoc = readDoc("object-types.md");
const legendDoc = readDoc("legend.md");
const bopfDoc = readDoc("bopf.md");
const cdsDoc = readDoc("cds.md");
const rapDoc = readDoc("rap.md");
const fpmFbiDoc = readDoc("fpm-fbi.md");
const nonObjectDoc = readDoc("non-object-capabilities.md");

const OBJECT_TYPES_PATH = "doc/CAPABILITIES/object-types.md";

const typeSpecs = new Map(TYPES.map((s) => [s.type, s]));

/** Strips one layer of surrounding backticks, the way every code-cell in the doc is written. */
function unbacktick(cell: string): string {
  return cell.replace(/^`(.*)`$/, "$1");
}

/** Splits a `| a | b |` row into trimmed cells, dropping the empty leading/trailing element. */
function parseRow(line: string): string[] {
  const cells = line.split("|").map((c) => c.trim());
  return cells.slice(1, -1);
}

/**
 * Finds the heading line in `doc`, then collects the first contiguous run of
 * `|` lines after it (skipping the `| --- |` separator), each as trimmed
 * cells. Throws if the heading is missing, so a renamed heading fails loudly
 * rather than returning an empty table that lets every test pass vacuously.
 * `docPath` is only for the error message, so a failure names the actual
 * file to fix.
 */
function tableAfter(doc: string, heading: string, docPath: string): string[][] {
  const lines = doc.split("\n");
  const start = lines.indexOf(heading);
  if (start === -1) throw new Error(`heading not found in ${docPath}: ${heading}`);
  const rows: string[][] = [];
  let i = start + 1;
  while (i < lines.length && !lines[i]!.trim().startsWith("|")) i++;
  for (; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line.startsWith("|")) break;
    if (/^\|\s*-+\s*\|/.test(line)) continue;
    rows.push(parseRow(line));
  }
  return rows;
}

type Cap = "yes" | "partial" | "no";

/** Recomputes the seven derived cells for one registry entry, per doc/CAPABILITIES/object-types.md's "How the object rows are derived". */
function expectedRow(code: string, cap: (typeof REGISTRY)[string]) {
  // A refused bridge create outranks `BRIDGE_CREATABLE_TYPES`: the bridge is
  // implemented but never run, so "partial" would overstate it.
  const create: Cap = VERIFIED_CREATABLE_TYPES.includes(code)
    ? "yes"
    : BRIDGE_CREATE_REFUSED_TYPES.includes(code)
      ? "no"
      : BRIDGE_CREATABLE_TYPES.includes(code)
        ? "partial"
        : Object.prototype.hasOwnProperty.call(OUT_OF_REGISTRY_CREATE, code)
          ? "partial"
          : "no";

  const spec = typeSpecs.get(code);
  const read: Cap = !spec
    ? "no"
    : spec.mode === "source"
      ? "yes"
      : spec.mode === "ddic" && ddicStrategy(spec.kind) !== "unsupported"
        ? "yes"
        : "partial";

  const update: "yes" | "no" = cap.write !== undefined ? "yes" : "no";

  const del: Cap = DELETABLE_TYPES.includes(code)
    ? "yes"
    : BRIDGE_DELETABLE_TYPES.includes(code)
      ? "partial"
      : OUT_OF_REGISTRY_DELETE.has(code)
        ? "partial"
        : "no";

  const activate: "yes" | "n/a" | "no" = cap.activate === true ? "yes" : cap.activate === false ? "n/a" : "no";

  // A `verified: false` or `delete: false` is itself live evidence — the
  // registry uses `false` to mean "tried live and does not reliably work",
  // not "no attempt was made".
  const evidence: "live" | "unverified" | "tests" =
    cap.create?.verified === true || cap.create?.verified === false || cap.delete === true || cap.delete === false
      ? "live"
      : cap.create || cap.bridgeCreate || cap.write
        ? "unverified"
        : "tests";

  return { type: code, label: cap.label, create, read, update, del, activate, evidence };
}

const OBJECT_TABLE_HEADER = ["Type", "Object", "Create", "Read", "Update", "Delete", "Activate", "Evidence"];
const EIGHT_COL_HEADER = ["Entity", "Create", "Read", "Update", "Delete", "Activate", "Evidence", "Notes"];

describe("object table is derived from the registry", () => {
  const rows = tableAfter(objectTypesDoc, "## Object types", OBJECT_TYPES_PATH);
  const header = rows[0]!;
  const body = rows.slice(1);

  it("every registry type has a row, and the row's cells match the derivation", () => {
    for (const [code, cap] of Object.entries(REGISTRY)) {
      const row = body.find((r) => unbacktick(r[0]!) === code);
      expect(row, `${OBJECT_TYPES_PATH}: no Object types row for ${code}`).toBeDefined();
      const expected = expectedRow(code, cap);
      const [, label, create, read, update, del, activate, evidence] = row!;
      expect(label, `${code}: Object`).toBe(expected.label);
      expect(create, `${code}: Create`).toBe(expected.create);
      expect(read, `${code}: Read`).toBe(expected.read);
      expect(update, `${code}: Update`).toBe(expected.update);
      expect(del, `${code}: Delete`).toBe(expected.del);
      expect(activate, `${code}: Activate`).toBe(expected.activate);
      expect(evidence, `${code}: Evidence`).toBe(expected.evidence);
    }
  });

  it("no row in the doc names a type the registry does not have", () => {
    for (const row of body) {
      const code = unbacktick(row[0]!);
      expect(
        Object.prototype.hasOwnProperty.call(REGISTRY, code),
        `${OBJECT_TYPES_PATH}: row for ${code} is stale and should be removed`,
      ).toBe(true);
    }
  });

  it("row count equals registry size", () => {
    expect(body.length).toBe(Object.keys(REGISTRY).length);
  });

  it("non-vacuity: the table parsed at least one row, with the expected header", () => {
    expect(body.length).toBeGreaterThan(0);
    expect(header).toEqual(OBJECT_TABLE_HEADER);
  });
});

describe("markers come from the legend", () => {
  const capabilityMarkers = new Set(
    tableAfter(legendDoc, "### Capability markers", "doc/CAPABILITIES/legend.md").map((r) => unbacktick(r[0]!)),
  );
  const evidenceMarkers = new Set(
    tableAfter(legendDoc, "### Evidence markers", "doc/CAPABILITIES/legend.md").map((r) => unbacktick(r[0]!)),
  );

  it("both legend tables parse to a non-empty marker set", () => {
    expect(capabilityMarkers.size).toBeGreaterThan(0);
    expect(evidenceMarkers.size).toBeGreaterThan(0);
  });

  // Column positions differ: the object table has a leading `Type, Object`
  // pair the framework/non-object tables don't, so "Create"..."Activate" and
  // "Evidence" are looked up by header name rather than a fixed index.
  const namedTables: Array<[string, string[][]]> = [
    ["Object types", tableAfter(objectTypesDoc, "## Object types", OBJECT_TYPES_PATH)],
    ["BOPF", tableAfter(bopfDoc, "## BOPF", "doc/CAPABILITIES/bopf.md")],
    ["CDS", tableAfter(cdsDoc, "## CDS", "doc/CAPABILITIES/cds.md")],
    ["RAP", tableAfter(rapDoc, "## RAP", "doc/CAPABILITIES/rap.md")],
    ["FPM and FBI", tableAfter(fpmFbiDoc, "## FPM and FBI", "doc/CAPABILITIES/fpm-fbi.md")],
    [
      "Non-object capabilities",
      tableAfter(nonObjectDoc, "## Non-object capabilities", "doc/CAPABILITIES/non-object-capabilities.md"),
    ],
  ];

  it("every capability cell in every table uses a legend marker", () => {
    for (const [name, rows] of namedTables) {
      const header = rows[0]!;
      const start = header.indexOf("Create");
      const stop = header.indexOf("Activate");
      for (const row of rows.slice(1)) {
        for (const value of row.slice(start, stop + 1)) {
          expect(capabilityMarkers.has(value), `${name} table, row "${row[0]}": "${value}" is not a legend marker`).toBe(
            true,
          );
        }
      }
    }
  });

  it("every evidence cell in every table uses a legend marker", () => {
    for (const [name, rows] of namedTables) {
      const evidenceCol = rows[0]!.indexOf("Evidence");
      for (const row of rows.slice(1)) {
        const value = row[evidenceCol]!;
        expect(
          evidenceMarkers.has(value),
          `${name} table, row "${row[0]}": Evidence "${value}" is not a legend marker`,
        ).toBe(true);
      }
    }
  });
});

describe("framework and non-object tables are well formed", () => {
  const tables: Array<[string, string[][]]> = [
    ["BOPF", tableAfter(bopfDoc, "## BOPF", "doc/CAPABILITIES/bopf.md")],
    ["CDS", tableAfter(cdsDoc, "## CDS", "doc/CAPABILITIES/cds.md")],
    ["RAP", tableAfter(rapDoc, "## RAP", "doc/CAPABILITIES/rap.md")],
    ["FPM and FBI", tableAfter(fpmFbiDoc, "## FPM and FBI", "doc/CAPABILITIES/fpm-fbi.md")],
    [
      "Non-object capabilities",
      tableAfter(nonObjectDoc, "## Non-object capabilities", "doc/CAPABILITIES/non-object-capabilities.md"),
    ],
  ];

  it("every table has the expected header and every row fills every column", () => {
    for (const [name, rows] of tables) {
      expect(rows[0], `${name} table header`).toEqual(EIGHT_COL_HEADER);
      for (const row of rows.slice(1)) {
        expect(row.length, `${name} table, row "${row[0]}": expected 8 cells`).toBe(8);
        for (const [i, cell] of row.entries()) {
          expect(cell.length, `${name} table, row "${row[0]}", column ${EIGHT_COL_HEADER[i]}: empty cell`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("non-vacuity: each table has at least one body row", () => {
    for (const [name, rows] of tables) {
      expect(rows.length - 1, `${name} table: no body rows found`).toBeGreaterThan(0);
    }
  });
});
