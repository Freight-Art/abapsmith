/**
 * Regression tests for the description-pairing defect fixed for
 * `abap_search` (`src/adt/search-descriptions.ts`) has a second,
 * unrepaired consumer — `searchExact` in `src/adt/resolve.ts`. `resolveObject`
 * feeds `searchExact`'s hits straight to `finishFromSearch`, which lifts
 * `adtcore:description` onto `ResolvedObject.description` — the value
 * `abap_read`'s header shows as `description:`. Driven from the same live
 * capture as the abap_search suite (`812-p0-quicksearch-t000-repro.xml`, a
 * `query=T000*&maxResults=5` quickSearch — exactly what `searchExact(conn,
 * "T000")` sees, since quickSearch pattern-matches rather than matching the
 * name exactly) plus the per-object ground truth
 * (`814-p1-ddic-table-t000-source.xml`, `@EndUserText.label : 'Clients'`).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import { resolveObject, searchExact } from "../src/adt/resolve.js";
import type { SearchRef } from "../src/adt/search-descriptions.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "live-captured");

interface WireRef extends SearchRef {
  readonly "adtcore:uri"?: string;
  readonly "adtcore:packageName"?: string;
}

function loadObjectReferences(file: string): WireRef[] {
  const xml = readFileSync(join(FIXTURES, file), "utf8");
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  const doc = parser.parse(xml) as {
    "adtcore:objectReferences": { "adtcore:objectReference": Record<string, string> | Record<string, string>[] };
  };
  const raw = doc["adtcore:objectReferences"]["adtcore:objectReference"];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((entry) => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(entry)) {
      if (key.startsWith("@_")) out[key.slice(2)] = value;
    }
    return out as WireRef;
  });
}

// query=T000*&maxResults=5 — the exact shape searchExact("T000") drives, since
// quickSearch pattern-matches rather than matching the name exactly. Wire order
// carries the TABL/DT T000 row LAST, holding TABL/DS T000_RFC's description —
// ground truth (814) is "Clients".
const T000_HITS = loadObjectReferences("812-p0-quicksearch-t000-repro.xml");
const DDLS_HITS = loadObjectReferences("452-ver-quicksearch-ddls.xml");

function connWith(hits: readonly WireRef[]): AbapConnection {
  return {
    cfg: { sid: "A4H" },
    adt: { searchObject: async () => hits },
  } as unknown as AbapConnection;
}

describe("resolveObject pairs a name-resolved object with its own description", () => {
  it('resolveObject(conn, "T000") resolves TABL/DT T000 with description "Clients", not another row\'s text', async () => {
    const r = await resolveObject(connWith(T000_HITS), "T000");
    expect(r.type).toBe("TABL/DT");
    expect(r.name).toBe("T000");
    expect(r.description).toBe("Clients");
    expect(r.description).not.toBe("T000 Subset for Comparison Tool and Remote Client Copy");
  });
});

describe("searchExact repairs before the exact-name filter, not after", () => {
  it("returns T000 (TABL/DT) carrying its own description, not the mis-paired wire value", async () => {
    // After filtering to the single exact-name row, the group has only one
    // distinct type — repairSearchDescriptions' own guard (distinctTypes.size
    // < 2) would silently no-op on it. A repair applied AFTER the filter is
    // therefore indistinguishable from no repair at all here: this only
    // passes if the repair ran over the whole T000* group first.
    const results = await searchExact(connWith(T000_HITS), "T000");
    expect(results).toHaveLength(1);
    expect(results[0]?.["adtcore:type"]).toBe("TABL/DT");
    expect(results[0]?.["adtcore:description"]).toBe("Clients");
  });
});

describe("searchExact leaves a single-sub-type group untouched", () => {
  it("passes DDLS/DF rows through with their wire descriptions, no invented change", async () => {
    const results = await searchExact(connWith(DDLS_HITS), "I_AIVS_AI_PACKAGE");
    expect(results).toHaveLength(1);
    expect(results[0]?.["adtcore:type"]).toBe("DDLS/DF");
    expect(results[0]?.["adtcore:description"]).toBe("package");
  });
});
