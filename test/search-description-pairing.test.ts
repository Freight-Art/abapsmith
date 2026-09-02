/**
 * Regression tests: ADT's quickSearch zips the object list
 * (ordered by full type incl. sub-type, then name) against per-type-group
 * descriptions (ordered by name only), so a type group spanning more than
 * one sub-type hands every row another row's description. Fixtures 451/452/
 * 824/836 are raw live captures, not hand-typed, so the TABL/DS+DT and
 * PROG/I+PROG/P mis-pairings, the untouched single-sub-type DDLS/DF case,
 * and the FUGR passthrough are all wire-proven. Row assertions below pin
 * type+name+description together per rendered line (package is a wildcard
 * \S+) so a substring collision between two rows' names or descriptions
 * cannot produce a false pass.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import { repairSearchDescriptions, type SearchRef } from "../src/adt/search-descriptions.js";
import { abapSearch } from "../src/tools/search.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "live-captured");

interface WireRef extends SearchRef {
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

const T000_HITS = loadObjectReferences("451-ver-quicksearch-any.xml");
const DDLS_HITS = loadObjectReferences("452-ver-quicksearch-ddls.xml");
const ZTMC_HITS = loadObjectReferences("836-p5-quicksearch-ztmc-star.xml");
const PROG_FUGR_HITS = loadObjectReferences("824-p4-quicksearch-prog-rs-star.xml");

function searchConn(searchObject: (q: string, group?: string, max?: number) => Promise<unknown[]>): AbapConnection {
  return {
    cfg: { sid: "A4H" },
    adt: { searchObject, usageReferences: async () => [] },
  } as unknown as AbapConnection;
}

/** Matches a single rendered table row: TYPE  NAME  PACKAGE  DESCRIPTION. */
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const row = (type: string, name: string, description: string): RegExp =>
  new RegExp(`${escape(type)}\\s+${escape(name)}\\s+\\S+\\s+${escape(description)}`);

describe("abap_search repairs mis-paired descriptions within a type group", () => {
  it("pairs the four T000 TABL rows with their correct descriptions and leaves the single-sub-type DTEL row untouched", async () => {
    const r = await abapSearch(searchConn(async () => T000_HITS), { query: "T000*", max: 5 }, 20_000);
    expect(r.text).toMatch(row("DTEL/DE", "T000_DEL", "Delete entry from T000"));
    expect(r.text).toMatch(row("TABL/DT", "T000", "Clients"));
    expect(r.text).toMatch(row("TABL/DS", "T000_0001", "Screen fields T000 maintenance"));
    expect(r.text).toMatch(row("TABL/DS", "T000_0002", "Screen Fields T000 Maintenance"));
    expect(r.text).toMatch(row("TABL/DS", "T000_RFC", "T000 Subset for Comparison Tool and Remote Client Copy"));
  });

  it("keeps row order — T000 (TABL/DT) still comes out last", async () => {
    const r = await abapSearch(searchConn(async () => T000_HITS), { query: "T000*", max: 5 }, 20_000);
    const anchors = [
      row("DTEL/DE", "T000_DEL", "Delete entry from T000"),
      row("TABL/DS", "T000_0001", "Screen fields T000 maintenance"),
      row("TABL/DS", "T000_0002", "Screen Fields T000 Maintenance"),
      row("TABL/DS", "T000_RFC", "T000 Subset for Comparison Tool and Remote Client Copy"),
      row("TABL/DT", "T000", "Clients"),
    ];
    const positions = anchors.map((re) => r.text.search(re));
    for (const p of positions) expect(p).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]!);
    }
  });

  it("discloses the repair in a note naming TABL and in the header", async () => {
    const r = await abapSearch(searchConn(async () => T000_HITS), { query: "T000*", max: 5 }, 20_000);
    expect(r.text).toMatch(/DESCRIPTIONS RE-PAIRED/);
    expect(r.text).toMatch(/type group\(s\) TABL/);
    expect(r.text).toContain("descriptionsRepaired: TABL");
  });

  it('type: "TABL/DT" filter — the repair runs before the filter, so the single row is correct', async () => {
    const r = await abapSearch(
      searchConn(async () => T000_HITS),
      { query: "T000*", type: "TABL/DT", max: 5 },
      20_000,
    );
    expect(r.text).toContain("matches: 1");
    expect(r.text).toMatch(row("TABL/DT", "T000", "Clients"));
    expect(r.text).not.toContain("T000 Subset for Comparison Tool and Remote Client Copy");
  });

  it('type: "TABL/DS" filter — three rows, each with its correct description, none reading "Clients"', async () => {
    const r = await abapSearch(
      searchConn(async () => T000_HITS),
      { query: "T000*", type: "TABL/DS", max: 5 },
      20_000,
    );
    expect(r.text).toContain("matches: 3");
    expect(r.text).toMatch(row("TABL/DS", "T000_0001", "Screen fields T000 maintenance"));
    expect(r.text).toMatch(row("TABL/DS", "T000_0002", "Screen Fields T000 Maintenance"));
    expect(r.text).toMatch(row("TABL/DS", "T000_RFC", "T000 Subset for Comparison Tool and Remote Client Copy"));
    expect(r.text).not.toContain("Clients");
  });

  it("a single-sub-type group (DDLS/DF only) passes through untouched, no note, no header field", async () => {
    const r = await abapSearch(searchConn(async () => DDLS_HITS), { query: "I_*", max: 5 }, 20_000);
    expect(r.text).toMatch(row("DDLS/DF", "I_ACMUSR02", "View of user-table: USR02, used by ACM"));
    expect(r.text).toMatch(row("DDLS/DF", "I_AIVS_AI_CDSINFO", "interface view for cds info"));
    expect(r.text).toMatch(row("DDLS/DF", "I_AIVS_AI_PACKAGE", "package"));
    expect(r.text).toMatch(row("DDLS/DF", "I_AIVS_AI_REPORT_TYPE", "interface view for report types"));
    expect(r.text).toMatch(row("DDLS/DF", "I_AIVS_AI_USAGE", "interface view for cds usage"));
    expect(r.text).not.toMatch(/DESCRIPTIONS RE-PAIRED/);
    expect(r.text).not.toContain("descriptionsRepaired");
  });
});

describe("abap_search repairs a real 34-row ZTMC_* response (fixture 836)", () => {
  it("repairs the mis-paired TABL/DS+DT rows to match per-object ground truth and leaves the rest of the group alone", async () => {
    const r = await abapSearch(searchConn(async () => ZTMC_HITS), { query: "ZTMC*", max: 50 }, 200_000);
    // ground truth: 837 ZTMC_S_CARRIER, 838 ZTMC_S_R_CARRID, 839 ZTMC_CARRIER, 840 ZTMC_CARRIER_T
    expect(r.text).toMatch(row("TABL/DT", "ZTMC_CARRIER", "Carrier master"));
    expect(r.text).toMatch(row("TABL/DT", "ZTMC_CARRIER_T", "Carrier text table"));
    expect(r.text).toMatch(row("TABL/DS", "ZTMC_S_CARRIER", "Carrier (flat view with description)"));
    expect(r.text).toMatch(row("TABL/DS", "ZTMC_S_R_CARRID", "Range structure for carrier ID"));
    // ground truth: 841 ZTMC_TOPARAM, 842 ZTMC_TORDER, 843 ZTMC_TORDER_I — already correct, unchanged
    expect(r.text).toMatch(row("TABL/DT", "ZTMC_TOPARAM", "Transport order customizing parameters"));
    expect(r.text).toMatch(row("TABL/DT", "ZTMC_TORDER", "Transport order header"));
    expect(r.text).toMatch(row("TABL/DT", "ZTMC_TORDER_I", "Transport order item"));
    expect(r.text).toMatch(/DESCRIPTIONS RE-PAIRED/);
    expect(r.text).toMatch(/type group\(s\) TABL/);
    expect(r.text).toContain("descriptionsRepaired: TABL");
  });
});

describe("repairSearchDescriptions — fixture 824 (100-row PROG/FUGR response)", () => {
  it("repairs the 14-row PROG/I+PROG/P group to match per-object ground truth (fixtures 829-831)", () => {
    const { refs: out, repairedGroups } = repairSearchDescriptions(PROG_FUGR_HITS);
    const descOf = (name: string) => out.find((r) => r["adtcore:name"] === name)?.["adtcore:description"];
    expect(descOf("RS005ADDRS")).toBe("Program RS005ADDRS");
    expect(descOf("RS2HANA_ASSIGN_PRIVILEGES_CL")).toBe("Include RS2HANA_ASSIGN_PRIVILEGES_CL");
    expect(descOf("RS2HANA_AUTH_RUN_CL")).toBe("Include RS2HANA_AUTH_RUN_CL");
    expect(repairedGroups).toContain("PROG");
  });

  // 825's FUGR group has rows with no description at all, which trips the module's
  // own "every row has a description" guard for the wrong reason; 824's 8-row
  // FUGR/F+FUGR/FF group is fully described and would be "repaired" by the
  // ordering rule, so only KNOWN_CLEAN_GROUPS protects it — the real regression guard.
  it("leaves the 8-row FUGR/F+FUGR/FF group byte-identical and reports it neither repaired nor suspect", () => {
    // keyed by type+name: RS00 also exists as TRAN/T "Start menu" in this fixture
    const before = new Map(PROG_FUGR_HITS.map((r) => [`${r["adtcore:type"]}/${r["adtcore:name"]}`, r["adtcore:description"]]));
    const { refs: out, repairedGroups, suspectGroups } = repairSearchDescriptions(PROG_FUGR_HITS);
    const fugrRows = out.filter((r) => (r["adtcore:type"] ?? "").startsWith("FUGR"));
    expect(fugrRows).toHaveLength(8);
    for (const r of fugrRows) {
      expect(r["adtcore:description"]).toBe(before.get(`${r["adtcore:type"]}/${r["adtcore:name"]}`));
    }
    // wire values confirmed correct by per-object reads 832-834 (see search-descriptions.ts)
    expect(fugrRows.find((r) => r["adtcore:name"] === "RS2HANA")?.["adtcore:description"]).toBe(
      "BW Models in SAP HANA",
    );
    expect(fugrRows.find((r) => r["adtcore:name"] === "RS2HANA_AUTH_RUN")?.["adtcore:description"]).toBe(
      "Execute privilege generation",
    );
    expect(repairedGroups).not.toContain("FUGR");
    expect(suspectGroups).not.toContain("FUGR");
  });
});

describe("repairSearchDescriptions — unit-level guards", () => {
  it("refuses to repair a mixed-sub-type group where one row has no description", () => {
    const refs: SearchRef[] = [
      { "adtcore:type": "TABL/DS", "adtcore:name": "T000_0001", "adtcore:description": "Clients" },
      { "adtcore:type": "TABL/DS", "adtcore:name": "T000_0002", "adtcore:description": undefined },
      { "adtcore:type": "TABL/DT", "adtcore:name": "T000", "adtcore:description": "Something" },
    ];
    const { refs: out, repairedGroups } = repairSearchDescriptions(refs);
    expect(out).toEqual(refs);
    expect(repairedGroups).toEqual([]);
  });

  it("a mixed group whose wire order is already name-ascending is left unchanged (identity permutation)", () => {
    const refs: SearchRef[] = [
      { "adtcore:type": "TABL/DT", "adtcore:name": "T000", "adtcore:description": "Clients" },
      { "adtcore:type": "TABL/DS", "adtcore:name": "T000_0001", "adtcore:description": "Screen fields" },
      { "adtcore:type": "TABL/DS", "adtcore:name": "T000_0002", "adtcore:description": "Screen Fields" },
    ];
    const { refs: out, repairedGroups } = repairSearchDescriptions(refs);
    expect(out).toEqual(refs);
    expect(repairedGroups).toEqual([]);
  });

  it("a mixed group with a TABL/DT row ahead of TABL/DS rows (sub-type order violated) is left untouched", () => {
    const refs: SearchRef[] = [
      { "adtcore:type": "TABL/DT", "adtcore:name": "T000", "adtcore:description": "Clients" },
      { "adtcore:type": "TABL/DS", "adtcore:name": "T000_0002", "adtcore:description": "Screen Fields T000 maintenance" },
      { "adtcore:type": "TABL/DS", "adtcore:name": "T000_0001", "adtcore:description": "Screen fields T000 maintenance" },
    ];
    const { refs: out, repairedGroups } = repairSearchDescriptions(refs);
    expect(out).toEqual(refs);
    expect(repairedGroups).toEqual([]);
  });

  it("a mixed group with two TABL/DS rows in descending name order (name order violated) is left untouched", () => {
    const refs: SearchRef[] = [
      { "adtcore:type": "TABL/DS", "adtcore:name": "T000_0002", "adtcore:description": "Screen Fields T000 maintenance" },
      { "adtcore:type": "TABL/DS", "adtcore:name": "T000_0001", "adtcore:description": "Screen fields T000 maintenance" },
      { "adtcore:type": "TABL/DT", "adtcore:name": "T000", "adtcore:description": "Clients" },
    ];
    const { refs: out, repairedGroups } = repairSearchDescriptions(refs);
    expect(out).toEqual(refs);
    expect(repairedGroups).toEqual([]);
  });
});

describe("repairSearchDescriptions — unverified groups (allowlist)", () => {
  // VIEW is on neither VERIFIED_GROUPS nor KNOWN_CLEAN_GROUPS. VIEW/DV < VIEW/DW,
  // so wire order (this array's order) is non-decreasing by (type, name);
  // sorting by name alone reverses the two rows, so the would-be permutation
  // swaps their descriptions — a non-identity repair with no wire evidence
  // behind it.
  const DETAIL_VIEW: SearchRef = {
    "adtcore:type": "VIEW/DV",
    "adtcore:name": "ZMCP_TEST_DETAIL",
    "adtcore:description": "Detail view",
  };
  const MAIN_VIEW: SearchRef = {
    "adtcore:type": "VIEW/DW",
    "adtcore:name": "ZMCP_MAIN",
    "adtcore:description": "Main view",
  };

  it("an unverified mixed group (VIEW/DV + VIEW/DW) with a non-identity would-be permutation is left untouched and reported as suspect", () => {
    const refs = [DETAIL_VIEW, MAIN_VIEW];
    const { refs: out, repairedGroups, suspectGroups } = repairSearchDescriptions(refs);
    expect(out).toEqual(refs);
    expect(repairedGroups).toEqual([]);
    expect(suspectGroups).toEqual(["VIEW"]);
  });

  it("the suspect note and descriptionsSuspect header field surface through abap_search, with rows unchanged", async () => {
    const refs = [
      { ...DETAIL_VIEW, "adtcore:packageName": "$TMP" },
      { ...MAIN_VIEW, "adtcore:packageName": "$TMP" },
    ];
    const r = await abapSearch(searchConn(async () => refs), { query: "ZMCP_*", max: 5 }, 20_000);
    expect(r.text).toMatch(/DESCRIPTIONS MAY BE MIS-PAIRED/);
    expect(r.text).toMatch(/type group\(s\) VIEW/);
    expect(r.text).toContain("descriptionsSuspect: VIEW");
    expect(r.text).not.toMatch(/DESCRIPTIONS RE-PAIRED/);
    expect(r.text).toMatch(row("VIEW/DV", "ZMCP_TEST_DETAIL", "Detail view"));
    expect(r.text).toMatch(row("VIEW/DW", "ZMCP_MAIN", "Main view"));
  });

  it("a suspect group whose would-be permutation is the identity produces no note and no suspect entry", async () => {
    const refs: SearchRef[] = [
      { "adtcore:type": "VIEW/DV", "adtcore:name": "AAA_TOP", "adtcore:description": "Detail view" },
      { "adtcore:type": "VIEW/DW", "adtcore:name": "ZZZ_MAIN", "adtcore:description": "Main view" },
    ];
    const { suspectGroups } = repairSearchDescriptions(refs);
    expect(suspectGroups).toEqual([]);

    const r = await abapSearch(
      searchConn(async () => refs.map((ref) => ({ ...ref, "adtcore:packageName": "$TMP" }))),
      { query: "*_TOP", max: 5 },
      20_000,
    );
    expect(r.text).not.toMatch(/DESCRIPTIONS MAY BE MIS-PAIRED/);
    expect(r.text).not.toContain("descriptionsSuspect");
  });
});
