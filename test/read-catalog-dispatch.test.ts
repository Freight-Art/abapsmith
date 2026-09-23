/**
 * Tests for `abapRead`'s catalog-route dispatch (`src/tools/read.ts`) — the
 * branch that serves `SUSO/B` (authorization object, issue #87) and
 * `TABL/DI` (table secondary index, issue #86) directly from
 * `dataPreviewFreestyle` catalog queries, entirely bypassing `resolveObject`
 * (neither type has an ADT resource/URI to resolve).
 *
 * Imports `../src/adt/capabilities.js` first, as a bare side-effecting
 * import, to force it to finish initializing before anything reaches it via
 * the real import cycle `ddic.ts` -> `index-read.ts` -> `enhancement-
 * templates.ts` -> `safety.ts` -> `capabilities.ts`. `src/tools/read.ts`
 * imports `ddic.js` as a real value (for the ordinary DDIC read branch), so
 * without this, whichever of `ddic.ts`/`capabilities.ts` initializes second
 * throws `ReferenceError: Cannot access 'DDIC_SOURCE_BASED' before
 * initialization` the moment `capabilities.ts`'s own module-top-level
 * self-check (`assertWritableTypesAreReadable()`) runs and calls back into
 * `ddic.ts` before `ddic.ts`'s own const has initialized. Reproduced
 * standalone with `npx tsx`, independent of vitest — a genuine bug in
 * `src/`, out of this test file's remit to fix (see the final report).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { AbapConnection } from "../src/adt/connection.js";
import { NON_READABLE_TYPES } from "../src/adt/capabilities.js";
import { isAbapError, type AbapError } from "../src/adt/errors.js";
import { abapRead, type ReadInput } from "../src/tools/read.js";

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

const DD12V_BDSLORE10 = read("858-i86-dd12v-select-star.xml");
const DD17S_BDSLORE10 = read("859-i86-dd17s-select-star.xml");
const DD12V_TADIR_EMPTY = read("860-i86-dd12v-no-index.xml");

/**
 * A zero-row DD17S freestyle body, in the same minimal shape
 * `test/index-read.test.ts` builds its own fake catalog bodies with —
 * `DD12V_TADIR_EMPTY` (capture 860) has no DD17S counterpart capture, so
 * this stands in for "TADIR has no index fields either".
 */
function columnXml(name: string, values: readonly string[]): string {
  const data = values.map((v) => `<dataPreview:data>${v}</dataPreview:data>`).join("");
  return (
    `<dataPreview:columns><dataPreview:metadata dataPreview:name="${name}" dataPreview:type="C" dataPreview:keyAttribute="false"/>` +
    `<dataPreview:dataSet>${data}</dataPreview:dataSet></dataPreview:columns>`
  );
}

function dd17sEmptyBody(): string {
  const cols = { SQLTAB: [], INDEXNAME: [], POSITION: [], FIELDNAME: [] } as Record<string, readonly string[]>;
  const colsXml = Object.entries(cols)
    .map(([n, v]) => columnXml(n, v))
    .join("");
  return (
    '<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">' +
    `<dataPreview:totalRows>0</dataPreview:totalRows>${colsXml}</dataPreview:tableData>`
  );
}

// --------------------------------------------------------------- fake wire ---

interface RecordedCall {
  sql: string;
  rowNumber: number;
}

/**
 * Replays queued `dataPreviewFreestyle` bodies in call order. `adt` is left
 * present but every method on it throws loudly — `readCatalogObject` must
 * never reach `resolveObject`'s dependencies (`conn.adt.searchObject`,
 * `conn.adt.objectStructure`) for a catalogRead type; if it ever does, the
 * test fails immediately instead of silently passing on a stale fixture.
 */
function queueConn(bodies: readonly string[]): { conn: AbapConnection; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const conn = {
    cfg: { sid: "A4H" },
    adt: {
      searchObject: async () => {
        throw new Error("resolveObject must not be reached for a catalogRead type (searchObject called)");
      },
      objectStructure: async () => {
        throw new Error("resolveObject must not be reached for a catalogRead type (objectStructure called)");
      },
    },
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
    cfg: { sid: "A4H" },
    adt: {
      searchObject: async () => {
        throw new Error("resolveObject must not be reached for a catalogRead type (searchObject called)");
      },
      objectStructure: async () => {
        throw new Error("resolveObject must not be reached for a catalogRead type (objectStructure called)");
      },
    },
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

function baseInput(overrides: Partial<ReadInput>): ReadInput {
  return { object: "", ...overrides } as ReadInput;
}

const MAX_CHARS = 100_000;

// ============================================================ SUSO/B route ===

describe("abapRead — SUSO/B catalog dispatch bypasses resolveObject", () => {
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

  it("renders S_TABU_NAM entirely from dataPreviewFreestyle, never touching conn.adt", async () => {
    const { conn, calls } = queueFullChain();
    const result = await abapRead(conn, baseInput({ object: "S_TABU_NAM", type: "SUSO/B" }), MAX_CHARS);
    expect(calls.length).toBe(8);
    // The header is rendered as `key: value` lines at the top of `.text` —
    // there is no structured `.header` field on `BuiltResponse` (see
    // `renderHeader`/`buildResponse` in `src/compact.ts`).
    expect(result.text).toContain("mode: catalog");
    expect(result.text).toContain("system: A4H");
    expect(result.text).toContain("object: SUSO/B S_TABU_NAM");
  });

  it("never emits a uri line on a catalog-read response (unlike an ordinary resolveObject-backed read)", async () => {
    const { conn } = queueFullChain();
    const result = await abapRead(conn, baseInput({ object: "S_TABU_NAM", type: "SUSO/B" }), MAX_CHARS);
    expect(result.text).not.toMatch(/^uri:/m);
  });

  it.each(["method", "outline", "enhancements", "version", "view", "from", "to", "context", "include", "types", "depth", "format"])(
    'refuses irrelevant parameter "%s" with BAD_INPUT before issuing any request',
    async (param) => {
      const { conn, calls } = neverCalledConn();
      const input = baseInput({ object: "S_TABU_NAM", type: "SUSO/B", [param]: irrelevantValueFor(param) }) as ReadInput;
      const err = await expectAsyncError(abapRead(conn, input, MAX_CHARS));
      expect(err.code).toBe("BAD_INPUT");
      expect(err.message).toContain(param);
      expect(err.message).toContain("Authorization object");
      expect(err.message).toContain("SUSO/B");
      expect(err.message).toContain("TOBJ, TOBJT, TOBCT, TACTZ, TACTT, AUTHX, DD04L, DD07V");
      expect(calls.length).toBe(0);
    },
  );
});

// ============================================================ TABL/DI route ==

describe("abapRead — TABL/DI catalog dispatch bypasses resolveObject", () => {
  it("renders BDSLORE10/REL entirely from dataPreviewFreestyle, never touching conn.adt", async () => {
    const { conn, calls } = queueConn([DD12V_BDSLORE10, DD17S_BDSLORE10]);
    const result = await abapRead(conn, baseInput({ object: "BDSLORE10/REL", type: "TABL/DI" }), MAX_CHARS);
    expect(calls.length).toBe(2);
    expect(result.text).toContain("mode: catalog");
    expect(result.text).toContain("system: A4H");
    expect(result.text).toContain("object: TABL/DI BDSLORE10/REL");
    expect(result.text).not.toMatch(/^uri:/m);
  });

  it.each(["BDSLORE10/", "/REL", "BDSLORE10/REL/EXTRA", "ZTAB/Z01/", ""])(
    'refuses a malformed TABL/DI name "%s" with BAD_INPUT before issuing any request',
    async (name) => {
      const { conn, calls } = neverCalledConn();
      const err = await expectAsyncError(abapRead(conn, baseInput({ object: name, type: "TABL/DI" }), MAX_CHARS));
      expect(err.code).toBe("BAD_INPUT");
      expect(err.message).toContain("is not a valid TABL/DI name");
      expect(err.message).toContain("<TABLE>/<INDEX>");
      expect(calls.length).toBe(0);
    },
  );

  it("lists every secondary index of BDSLORE10 for a bare table name (captures 858/859)", async () => {
    const { conn, calls } = queueConn([DD12V_BDSLORE10, DD17S_BDSLORE10]);
    const result = await abapRead(conn, baseInput({ object: "BDSLORE10", type: "TABL/DI" }), MAX_CHARS);
    expect(calls.length).toBe(2);
    expect(result.text).toContain("object: TABL/DI BDSLORE10");
    expect(result.text).toContain("mode: catalog");
    expect(result.text).toContain("indexes: 2");
    expect(result.text).toContain("--- SECONDARY INDEXES ---");
    expect(result.text).toContain("P2");
    expect(result.text).toContain("REL");
    expect(result.text).toContain("REP2_ID");
    expect(result.text).toContain("REIO_ID");
    expect(result.text).toContain("define index p2 on bdslore10");
    expect(result.text).toContain("define index rel on bdslore10");
    expect(result.text).not.toMatch(/^uri:/m);
  });

  it("lists nothing, without an error, for a table with no secondary index (capture 860)", async () => {
    const { conn, calls } = queueConn([DD12V_TADIR_EMPTY, dd17sEmptyBody()]);
    const result = await abapRead(conn, baseInput({ object: "TADIR", type: "TABL/DI" }), MAX_CHARS);
    expect(calls.length).toBe(2); // DD17S is still queried even when DD12V comes back empty
    expect(result.text).toContain("object: TABL/DI TADIR");
    expect(result.text).toContain("indexes: 0");
    expect(result.text).toContain("--- SECONDARY INDEXES ---");
    expect(result.text).toMatch(/no secondary index/);
  });

  it("NOT_FOUND for an unknown index id names the existing ids", async () => {
    const { conn } = queueConn([DD12V_BDSLORE10, DD17S_BDSLORE10]);
    const err = await expectAsyncError(abapRead(conn, baseInput({ object: "BDSLORE10/Z09", type: "TABL/DI" }), MAX_CHARS));
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toContain("Z09");
    expect(err.message).toContain("its secondary indexes are P2, REL");
    expect((err.details as { existing: string[] }).existing).toEqual(["P2", "REL"]);
    expect(err.hint).toContain('"object":"BDSLORE10","type":"TABL/DI"');
  });

  it("NOT_FOUND on a table with no index at all says so", async () => {
    const { conn } = queueConn([DD12V_TADIR_EMPTY, dd17sEmptyBody()]);
    const err = await expectAsyncError(abapRead(conn, baseInput({ object: "TADIR/Z01", type: "TABL/DI" }), MAX_CHARS));
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toContain("it has no secondary index at all");
    expect((err.details as { existing: string[] }).existing).toEqual([]);
  });

  it.each(["method", "outline", "enhancements", "version", "view", "from", "to", "context", "include", "types", "depth", "format"])(
    'refuses irrelevant parameter "%s" with BAD_INPUT before issuing any request',
    async (param) => {
      const { conn, calls } = neverCalledConn();
      const input = baseInput({ object: "BDSLORE10/REL", type: "TABL/DI", [param]: irrelevantValueFor(param) }) as ReadInput;
      const err = await expectAsyncError(abapRead(conn, input, MAX_CHARS));
      expect(err.code).toBe("BAD_INPUT");
      expect(err.message).toContain(param);
      expect(err.message).toContain("Table secondary index");
      expect(err.message).toContain("TABL/DI");
      expect(err.message).toContain("DD12V, DD17S");
      expect(calls.length).toBe(0);
    },
  );

  it.each(["method", "outline", "enhancements", "version", "view", "from", "to", "context", "include", "types", "depth", "format"])(
    'refuses irrelevant parameter "%s" with BAD_INPUT before issuing any request (bare-table list route)',
    async (param) => {
      const { conn, calls } = neverCalledConn();
      const input = baseInput({ object: "BDSLORE10", type: "TABL/DI", [param]: irrelevantValueFor(param) }) as ReadInput;
      const err = await expectAsyncError(abapRead(conn, input, MAX_CHARS));
      expect(err.code).toBe("BAD_INPUT");
      expect(err.message).toContain(param);
      expect(err.message).toContain("Table secondary index");
      expect(err.message).toContain("TABL/DI");
      expect(err.message).toContain("DD12V, DD17S");
      expect(calls.length).toBe(0);
    },
  );
});

// ==================================================== NON_READABLE_TYPES ===

describe("NON_READABLE_TYPES no longer lists the two catalogRead types", () => {
  it("does not contain SUSO/B", () => {
    expect(NON_READABLE_TYPES).not.toContain("SUSO/B");
  });

  it("does not contain TABL/DI", () => {
    expect(NON_READABLE_TYPES).not.toContain("TABL/DI");
  });
});

/**
 * A schema-shaped, obviously-wrong value for each irrelevant param, just
 * concrete enough that `input[param] !== undefined` is true — the exact
 * value never matters since `readCatalogObject` refuses on presence alone,
 * before ever inspecting it.
 */
function irrelevantValueFor(param: string): unknown {
  switch (param) {
    case "types":
      return ["CLAS/OC"];
    case "depth":
      return 1;
    case "version":
      return "active";
    case "view":
      return "history";
    case "include":
      return "definitions";
    default:
      return "x";
  }
}
