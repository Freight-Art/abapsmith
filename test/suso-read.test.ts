/**
 * Tests for `src/adt/suso-read.ts` (issue #87) — the freestyle-preview-
 * backed render of one SAP authorization object (`SUSO/B`) from TOBJ,
 * TOBJT, TOBCT, TACTZ, TACTT, AUTHX, DD04L and DD07V.
 *
 * The full-render tests replay REAL captured bodies, in the exact call
 * order `readAuthorizationObject` itself issues them (TOBJ, TOBJT, TOBCT,
 * AUTHX, DD04L, DD07V, TACTZ, TACTT) — read from disk, never hand-typed.
 * Two deliberate exceptions, both documented at the point of use:
 *
 *  - the "domain WITH fixed values" test needs a TOBJ/AUTHX/DD04L chain
 *    that resolves to a domain DD07V actually has non-empty values for.
 *    No single committed capture set threads that whole chain end to end
 *    (the real object captures — S_TABU_NAM, S_DEVELOP — resolve to
 *    domains DD07V has zero rows for, e.g. capture 872). So that one test
 *    uses minimal, clearly-synthetic TOBJ/TOBJT/AUTHX/DD04L rows whose only
 *    job is to route to `DOMNAME = 'AS4LOCAL'` — and then plugs in the
 *    REAL, verbatim `875-i87-dd07v-domain-with-values.xml` body for the
 *    DD07V step, which is what every assertion in that test actually reads.
 *  - the "FIEL0 is the tenth slot" test needs a TOBJ row with FIEL9/FIEL0
 *    both populated and FIEL1..FIEL8 blank, a combination no capture
 *    happens to have (captures 861/870 only use the first few slots) — so
 *    it uses a small hand-built TOBJ/TOBJT/AUTHX/TACTZ chain built with the
 *    same `body()` helper `test/img-read.test.ts`/`test/index-read.test.ts`
 *    already use for this purpose.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { AbapConnection } from "../src/adt/connection.js";
import { isAbapError, type AbapError } from "../src/adt/errors.js";
import { SUSO_OBJECT_NAME_MAX, readAuthorizationObject, renderAuthorizationObject } from "../src/adt/suso-read.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "live-captured");
const read = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");

const TOBJ_S_TABU_NAM = read("861-i87-tobj-s-tabu-nam.xml");
const TOBJT_S_TABU_NAM = read("862-i87-tobjt-s-tabu-nam.xml");
const TACTZ_S_TABU_NAM = read("863-i87-tactz-s-tabu-nam.xml");
const TACTT_ACTIVITIES = read("864-i87-tactt-activities.xml");
const TOBCT_BC_A = read("867-i87-tobct-probe.xml");
const AUTHX_S_TABU_NAM_FIELDS = read("868-i87-authx-s-tabu-nam-fields.xml");
const DD04L_ROLLNAME_DOMAIN = read("869-i87-dd04l-rollname-domain.xml");
const DD07V_ACTIV_AUTH_EMPTY = read("872-i87-dd07v-fixed-values.xml");
const TOBJ_ABSENT = read("873-i87-tobj-absent.xml");
const DD07V_AS4LOCAL_VALUES = read("875-i87-dd07v-domain-with-values.xml");

// --------------------------------------------------------------- fake wire ---

function columnXml(name: string, values: readonly string[]): string {
  const data = values.map((v) => `<dataPreview:data>${v}</dataPreview:data>`).join("");
  return (
    `<dataPreview:columns><dataPreview:metadata dataPreview:name="${name}" dataPreview:type="C" dataPreview:keyAttribute="false"/>` +
    `<dataPreview:dataSet>${data}</dataPreview:dataSet></dataPreview:columns>`
  );
}

function body(cols: Record<string, readonly string[]>, totalRows?: number): string {
  const names = Object.keys(cols);
  const rowCount = names.length === 0 ? 0 : cols[names[0]!]!.length;
  for (const n of names) {
    if (cols[n]!.length !== rowCount) {
      throw new Error(`test fixture bug: column "${n}" has a different row count than "${names[0]}"`);
    }
  }
  const totalRowsXml = totalRows === undefined ? "" : `<dataPreview:totalRows>${totalRows}</dataPreview:totalRows>`;
  const colsXml = names.map((n) => columnXml(n, cols[n]!)).join("");
  return (
    '<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">' +
    `${totalRowsXml}${colsXml}</dataPreview:tableData>`
  );
}

function emptyBody(): string {
  return '<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview"></dataPreview:tableData>';
}

interface RecordedCall {
  sql: string;
  rowNumber: number;
}

/** Replays queued bodies in call order; running out is a loud test-authoring bug, never a fall-through. */
function queueConn(bodies: readonly string[]): { conn: AbapConnection; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const conn = {
    async dataPreviewFreestyle(sql: string, rowNumber: number) {
      calls.push({ sql, rowNumber });
      const b = bodies[i];
      i++;
      if (b === undefined) {
        throw new Error(`queueConn: no fixture queued for call #${i} (only ${bodies.length} queued). SQL was:\n${sql}`);
      }
      return { body: b };
    },
  } as unknown as AbapConnection;
  return { conn, calls };
}

function neverCalledConn(): { conn: AbapConnection; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const conn = {
    async dataPreviewFreestyle(sql: string, rowNumber: number) {
      calls.push({ sql, rowNumber });
      throw new Error("dataPreviewFreestyle must not be called for this input");
    },
  } as unknown as AbapConnection;
  return { conn, calls };
}

async function expectAsyncError(p: Promise<unknown>): Promise<AbapError> {
  try {
    await p;
  } catch (e) {
    if (isAbapError(e)) return e;
    throw e;
  }
  throw new Error("expected the promise to reject");
}

// ============================================================= full render ===

describe("readAuthorizationObject — full real render of S_TABU_NAM (captures 861/862/867/868/869/872/863/864)", () => {
  // Call order: TOBJ, TOBJT, TOBCT (objectClass "BC_A" is non-blank), AUTHX
  // (fieldNames ACTVT, TABLE), DD04L (rollnames pulled from ALL of AUTHX's
  // returned rows: SEU_OBJID, TABNAME_AUTH, DEVCLASS, ACTIV_AUTH — capture
  // 868 is a combined probe for two objects' fields, so it returns rows
  // beyond just S_TABU_NAM's own two), DD07V (domains ACTIV_AUTH, DEVCLASS,
  // AS4TAB — capture 872 is a real, verbatim zero-row DD07V reply, applied
  // here to the broader 3-domain query; using a genuinely-empty capture for
  // "no fixed values found" does not misrepresent anything it asserts on),
  // TACTZ, TACTT.
  function queueFullChain() {
    return queueConn([
      TOBJ_S_TABU_NAM,
      TOBJT_S_TABU_NAM,
      TOBCT_BC_A,
      AUTHX_S_TABU_NAM_FIELDS,
      DD04L_ROLLNAME_DOMAIN,
      DD07V_ACTIV_AUTH_EMPTY,
      TACTZ_S_TABU_NAM,
      TACTT_ACTIVITIES,
    ]);
  }

  it("parses object identity: name, object class, object class text, description", async () => {
    const { conn } = queueFullChain();
    const obj = await readAuthorizationObject(conn, "S_TABU_NAM");
    expect(obj.name).toBe("S_TABU_NAM");
    expect(obj.objectClass).toBe("BC_A");
    expect(obj.objectClassText).toBe("Basis: Administration");
    expect(obj.description).toBe("Table Access by Generic Standard Tools");
  });

  it("preserves TOBJ slot order for fields (FIEL1 ACTVT, FIEL2 TABLE) and resolves each field's data element/check table/activity flag", async () => {
    const { conn } = queueFullChain();
    const obj = await readAuthorizationObject(conn, "S_TABU_NAM");
    expect(obj.fields.map((f) => f.name)).toEqual(["ACTVT", "TABLE"]);

    const actvt = obj.fields[0]!;
    expect(actvt.dataElement).toBe("ACTIV_AUTH");
    expect(actvt.checkTable).toBe("TACT");
    expect(actvt.isActivityField).toBe(true); // ACTVT_FLAG = "X" in capture 868

    const table = obj.fields[1]!;
    expect(table.dataElement).toBe("TABNAME_AUTH");
    expect(table.checkTable).toBeUndefined(); // blank CHECKTABLE for TABLE in capture 868
    expect(table.isActivityField).toBe(false);
  });

  it("tolerates a ROLLNAME with no DD04L row (TABNAME_AUTH has none in capture 869 — it only has TABNAME) rather than erroring", async () => {
    const { conn } = queueFullChain();
    const obj = await readAuthorizationObject(conn, "S_TABU_NAM");
    const table = obj.fields.find((f) => f.name === "TABLE")!;
    expect(table.domain).toBeUndefined();
    expect(table.fixedValues).toEqual([]);
    expect(obj.notes.some((n) => /No DD04L row for data element "TABNAME_AUTH"/.test(n))).toBe(true);
  });

  it("resolves ACTVT's domain (ACTIV_AUTH) but finds zero fixed values there (capture 872: a real, verbatim empty DD07V reply)", async () => {
    const { conn } = queueFullChain();
    const obj = await readAuthorizationObject(conn, "S_TABU_NAM");
    const actvt = obj.fields.find((f) => f.name === "ACTVT")!;
    expect(actvt.domain).toBe("ACTIV_AUTH");
    expect(actvt.fixedValues).toEqual([]);
  });

  it("lists activities from TACTZ, filling in TACTT text where present and tolerating a missing one (activity 08 has no TACTT row in capture 864)", async () => {
    const { conn } = queueFullChain();
    const obj = await readAuthorizationObject(conn, "S_TABU_NAM");
    expect(obj.activities).toEqual([
      { code: "02", text: "Change" },
      { code: "03", text: "Display" },
      { code: "08", text: "" },
    ]);
    expect(obj.notes.some((n) => /No TACTT text for activity "08"/.test(n))).toBe(true);
  });

  it("renders a DdicRender whose table lists both fields and whose ACTIVITIES section lists all three activities, with no FIXED VALUES section (both fields have none)", async () => {
    const { conn } = queueFullChain();
    const obj = await readAuthorizationObject(conn, "S_TABU_NAM");
    const rendered = renderAuthorizationObject(obj);
    expect(rendered.ddl).toMatch(/ACTVT\s+ACTIV_AUTH\s+TACT\s+X/);
    expect(rendered.ddl).toMatch(/TABLE\s+TABNAME_AUTH/);
    const activitiesSection = rendered.sections.find((s) => s.title === "ACTIVITIES")!;
    expect(activitiesSection.content).toMatch(/02\s+Change/);
    expect(activitiesSection.content).toMatch(/03\s+Display/);
    expect(activitiesSection.content).toMatch(/08/);
    expect(rendered.sections.some((s) => s.title.startsWith("FIXED VALUES"))).toBe(false);
    expect(rendered.meta.object_class).toBe("BC_A");
    expect(rendered.meta.object_class_text).toBe("Basis: Administration");
    expect(rendered.meta.fields).toBe(2);
    expect(rendered.meta.activities).toBe(3);
  });

  it("render notes carry the boundary statement (no AGR_*/UST* table was read, SUSO/B is not writable by abapsmith)", async () => {
    const { conn } = queueFullChain();
    const obj = await readAuthorizationObject(conn, "S_TABU_NAM");
    const rendered = renderAuthorizationObject(obj);
    const boundary = rendered.notes.find((n) => n.includes("DEFINITION of the authorization object"));
    expect(boundary).toBeDefined();
    expect(boundary).toMatch(/no AGR_\* \(role\) or UST\* \(user authorization\) table was read/);
    expect(boundary).toMatch(/SUSO\/B cannot be written by abapsmith/);
    expect(boundary).toMatch(/SU21 is the only way to edit one/);
  });

  it("issues no SQL referencing an AGR_* or UST* table — SUSO/B never reads role/user-authorization data", async () => {
    const { conn, calls } = queueFullChain();
    await readAuthorizationObject(conn, "S_TABU_NAM");
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      // The literal safety property named in issue #87: no line of any generated
      // statement may itself start with AGR_ or UST (i.e. no such table is ever
      // the FROM target — every FROM here is TOBJ/TOBJT/TOBCT/AUTHX/DD04L/DD07V/
      // TACTZ/TACTT, none of which match).
      for (const line of call.sql.split("\n")) {
        expect(line.trim()).not.toMatch(/^(AGR_|UST)/i);
      }
      expect(call.sql).not.toMatch(/\bFROM\s+(AGR_\w*|UST\w*)\b/i);
    }
  });
});

// ============================================================= domain with fixed values ===

describe("readAuthorizationObject — a domain WITH fixed values (real capture 875, minimal synthetic routing)", () => {
  it("sorts DD07V rows by VALPOS and carries value/text through to the field's fixedValues, verbatim from capture 875", async () => {
    const tobj = body(
      {
        OBJCT: ["ZTESTOBJ"],
        FIEL1: ["TSTFLD"],
        FIEL2: [""],
        FIEL3: [""],
        FIEL4: [""],
        FIEL5: [""],
        FIEL6: [""],
        FIEL7: [""],
        FIEL8: [""],
        FIEL9: [""],
        FIEL0: [""],
        OCLSS: [""], // blank -> TOBCT step is skipped
        BNAME: ["SAP"],
      },
      1,
    );
    const tobjt = body({ LANGU: ["E"], OBJECT: ["ZTESTOBJ"], TTEXT: ["Test object"] }, 1);
    const authx = body(
      { FIELDNAME: ["TSTFLD"], ROLLNAME: ["ZAS4LOC_TYP"], CHECKTABLE: [""], EXIT_FB: [""], ACTVT_FLAG: [""] },
      1,
    );
    const dd04l = body({ ROLLNAME: ["ZAS4LOC_TYP"], DOMNAME: ["AS4LOCAL"], DATATYPE: ["CHAR"], LENG: ["000001"] }, 1);
    const tactzEmpty = body({ BROBJ: [], ACTVT: [] }, 0);

    const { conn } = queueConn([tobj, tobjt, authx, dd04l, DD07V_AS4LOCAL_VALUES, tactzEmpty]);
    const obj = await readAuthorizationObject(conn, "ZTESTOBJ");

    const field = obj.fields[0]!;
    expect(field.domain).toBe("AS4LOCAL");
    expect(field.fixedValues).toEqual([
      { value: "A", text: "Entry was activated or generated in this form" },
      { value: "L", text: "Lock entry (first N version)" },
      { value: "N", text: "Entry was edited, but not activated" },
      { value: "S", text: "Previously active entry, backup copy" },
      { value: "T", text: "Temporary version when editing" },
    ]);

    const rendered = renderAuthorizationObject(obj);
    const section = rendered.sections.find((s) => s.title === "FIXED VALUES — TSTFLD");
    expect(section).toBeDefined();
    expect(section!.content).toMatch(/A\s+Entry was activated or generated in this form/);
    expect(section!.content).toMatch(/T\s+Temporary version when editing/);
  });
});

// ============================================================= FIEL0 is the tenth slot ===

describe('readAuthorizationObject — FIEL0 is the TENTH field slot, not "FIEL10"', () => {
  it("a TOBJ row with only FIEL9 and FIEL0 populated yields fields in [ninth, tenth] order", async () => {
    const tobj = body(
      {
        OBJCT: ["ZTENTH"],
        FIEL1: [""],
        FIEL2: [""],
        FIEL3: [""],
        FIEL4: [""],
        FIEL5: [""],
        FIEL6: [""],
        FIEL7: [""],
        FIEL8: [""],
        FIEL9: ["NINTH"],
        FIEL0: ["TENTH"],
        OCLSS: [""],
        BNAME: ["SAP"],
      },
      1,
    );
    const tobjt = emptyBody();
    const authx = emptyBody();
    const tactzEmpty = body({ BROBJ: [], ACTVT: [] }, 0);

    const { conn, calls } = queueConn([tobj, tobjt, authx, tactzEmpty]);
    const obj = await readAuthorizationObject(conn, "ZTENTH");

    expect(obj.fields.map((f) => f.name)).toEqual(["NINTH", "TENTH"]);
    // Confirms no query ever asks for a column literally named FIEL10.
    for (const call of calls) {
      expect(call.sql).not.toMatch(/FIEL10/i);
    }
  });
});

// ============================================================= absence / refusal ===

describe("readAuthorizationObject — absence and client-side refusal", () => {
  it("throws NOT_FOUND when TOBJ has no row (real capture 873: Z_I87_NOPE, HTTP 200, 0 rows)", async () => {
    const { conn, calls } = queueConn([TOBJ_ABSENT]);
    const err = await expectAsyncError(readAuthorizationObject(conn, "Z_I87_NOPE"));
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toMatch(/definitive empty result \(HTTP 200, 0 rows\), not a refused read/);
    expect(calls).toHaveLength(1); // no further queries are issued once TOBJ comes back empty
  });

  it(`refuses an object name over ${SUSO_OBJECT_NAME_MAX} characters BEFORE any request (fake never called)`, async () => {
    const { conn, calls } = neverCalledConn();
    const overLong = "A".repeat(SUSO_OBJECT_NAME_MAX + 1);
    const err = await expectAsyncError(readAuthorizationObject(conn, overLong));
    expect(err.code).toBe("BAD_INPUT");
    expect(calls).toHaveLength(0);
  });
});
