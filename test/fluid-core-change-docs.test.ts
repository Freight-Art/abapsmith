/**
 * Pure unit tests for `src/adt/change-docs.ts`, the TypeScript side of
 * `abap_fluid run tool:"core" action:"change_docs"` (issue #114): pre-network
 * argument validation, row mapping, the deny-list/row-cap policy pass
 * (`applyPositionPolicy`), text rendering, and the audit line. No
 * AbapConnection, no dispatch(), no fluid runtime — every row below is
 * constructed by hand against the wire contract
 * `src/adt/fluid/builtin/core/abap-change-docs.ts`'s header comment
 * documents, mirroring `test/bal-log.test.ts`'s approach for the sibling
 * `log.read` action.
 */
import { describe, expect, it } from "vitest";
import {
  assertChangeDocsArgs,
  mapChangeDocRows,
  applyPositionPolicy,
  renderChangeDocs,
  auditChangeDocs,
  type ChangeDocResult,
  type ChangeDocHeader,
  type ChangeDocPosition,
  type ChangeDocSummary,
} from "../src/adt/change-docs.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";

function expectBadInput(fn: () => void): AbapError {
  try {
    fn();
  } catch (e) {
    expect(isAbapError(e)).toBe(true);
    const err = e as AbapError;
    expect(err.code).toBe("BAD_INPUT");
    return err;
  }
  throw new Error("expected assertChangeDocsArgs to throw, but it did not");
}

// ---------------------------------------------------------------------------
// assertChangeDocsArgs
// ---------------------------------------------------------------------------

describe("assertChangeDocsArgs", () => {
  it("requires objectclass", () => {
    const err = expectBadInput(() => assertChangeDocsArgs({}));
    expect(err.message).toContain("objectclass");
  });

  it("rejects an empty-string objectclass the same as a missing one", () => {
    expectBadInput(() => assertChangeDocsArgs({ objectclass: "   " }));
  });

  it("rejects a since that is not 14 digits", () => {
    const err = expectBadInput(() =>
      assertChangeDocsArgs({ objectclass: "MATERIAL", since: "2026091512" }),
    );
    // The message IS the point here: it must name the field and the
    // expected shape, not just say "bad input".
    expect(err.message).toContain("since");
    expect(err.message).toContain("14 digits");
  });

  it("rejects a until that is not 14 digits", () => {
    const err = expectBadInput(() =>
      assertChangeDocsArgs({ objectclass: "MATERIAL", until: "not-a-date" }),
    );
    expect(err.message).toContain("until");
    expect(err.message).toContain("14 digits");
  });

  it("rejects since after until", () => {
    expectBadInput(() =>
      assertChangeDocsArgs({
        objectclass: "MATERIAL",
        since: "20260915120000",
        until: "20260914120000",
      }),
    );
  });

  it("rejects a negative max", () => {
    expectBadInput(() => assertChangeDocsArgs({ objectclass: "MATERIAL", max: -1 }));
  });

  it("passes a valid, fully-populated argument set", () => {
    expect(() =>
      assertChangeDocsArgs({
        objectclass: "MATERIAL",
        objectid: "M-4711",
        user: "DEVELOPER",
        since: "20260914120000",
        until: "20260915120000",
        tcode: "MM02",
        max: 50,
      }),
    ).not.toThrow();
  });

  it("passes objectclass alone with every other field omitted", () => {
    expect(() => assertChangeDocsArgs({ objectclass: "KNA1" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// mapChangeDocRows fixtures — literal wire shape `do_change_docs` emits.
// ---------------------------------------------------------------------------

function headerRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    kind: "header",
    objectclas: "MATERIAL",
    objectid: "M-0001",
    changenr: "0000000001",
    username: "DEVELOPER",
    udate: "20260910",
    utime: "091500",
    tcode: "MM02",
    change_ind: "U",
    ...overrides,
  };
}

function posRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    kind: "pos",
    changenr: "0000000001",
    tabname: "MARA",
    tabkey: "M-0001",
    fname: "MTART",
    chngind: "U",
    value_old: "FERT",
    value_new: "HALB",
    ...overrides,
  };
}

function summaryRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    kind: "summary",
    changes_returned: 2,
    positions_returned: 3,
    truncated: false,
    objectclass: "MATERIAL",
    objectid: "%",
    user: "%",
    tcode: "%",
    since: "20260909091500",
    until: "20260910091500",
    max: 20,
    server_time: "20260910091530",
    ...overrides,
  };
}

describe("mapChangeDocRows", () => {
  it("keeps header fields and attaches positions to the header that scopes them", () => {
    const rows = [
      headerRow({ changenr: "0000000001" }),
      posRow({ changenr: "0000000001", tabname: "MARA", fname: "MTART" }),
      posRow({ changenr: "0000000001", tabname: "MARA", fname: "MATKL" }),
      headerRow({ changenr: "0000000002", username: "OTHERUSR", tcode: "MM01", change_ind: "I" }),
      posRow({ changenr: "0000000002", tabname: "MARC", fname: "WERKS" }),
      summaryRow(),
    ];

    const result = mapChangeDocRows(rows);

    expect(result.changes).toHaveLength(2);

    const first = result.changes[0]!;
    const second = result.changes[1]!;
    expect(first.changenr).toBe("0000000001");
    expect(first.username).toBe("DEVELOPER");
    expect(first.udate).toBe("20260910");
    expect(first.utime).toBe("091500");
    expect(first.tcode).toBe("MM02");
    expect(first.change_ind).toBe("U");
    expect(first.positions).toHaveLength(2);
    expect(first.positions.map((p) => p.fname)).toEqual(["MTART", "MATKL"]);

    expect(second.changenr).toBe("0000000002");
    expect(second.username).toBe("OTHERUSR");
    expect(second.tcode).toBe("MM01");
    expect(second.change_ind).toBe("I");
    expect(second.positions).toHaveLength(1);
    expect(second.positions[0]?.tabname).toBe("MARC");

    expect(result.summary.changes_returned).toBe(2);
  });

  it("accounts for a header with zero positions rather than dropping it", () => {
    const rows = [headerRow({ changenr: "0000000009" }), summaryRow({ changes_returned: 1 })];
    const result = mapChangeDocRows(rows);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]?.positions).toEqual([]);
  });

  // Divergence from the task brief: the brief describes a `pos` row whose
  // header is absent as something `mapChangeDocRows` "does not crash" over
  // and "accounts for". The actual source (src/adt/change-docs.ts, the
  // `r["kind"] === "pos"` branch) explicitly calls `fail(...)` — a
  // structured `AbapError("FLUID_PROTOCOL_ERROR", ...)` throw — when
  // `currentHeader` is `undefined`. That is a deliberate protocol-violation
  // guard (mirrors bal-log.ts's identical shape), not an accident, so this
  // test asserts the real behavior rather than the brief's expectation.
  it("throws FLUID_PROTOCOL_ERROR for a pos row before any header row (diverges from a non-throwing 'accounted for' reading)", () => {
    const rows = [posRow({ changenr: "0000000001" }), summaryRow()];
    expect(() => mapChangeDocRows(rows)).toThrow(AbapError);
    try {
      mapChangeDocRows(rows);
      throw new Error("expected a throw");
    } catch (e) {
      expect(isAbapError(e)).toBe(true);
      expect((e as AbapError).code).toBe("FLUID_PROTOCOL_ERROR");
      expect((e as AbapError).message).toContain("pos row before any header row");
    }
  });

  it("throws FLUID_PROTOCOL_ERROR when a pos row's changenr does not match the open header", () => {
    const rows = [
      headerRow({ changenr: "0000000001" }),
      posRow({ changenr: "0000000002" }),
      summaryRow(),
    ];
    expect(() => mapChangeDocRows(rows)).toThrow(AbapError);
  });

  it("throws FLUID_PROTOCOL_ERROR when no summary row is present", () => {
    const rows = [headerRow()];
    expect(() => mapChangeDocRows(rows)).toThrow(AbapError);
  });
});

// ---------------------------------------------------------------------------
// applyPositionPolicy
// ---------------------------------------------------------------------------

function makePos(overrides: Partial<ChangeDocPosition>): ChangeDocPosition {
  return {
    changenr: "0000000001",
    tabname: "MARA",
    tabkey: "M-0001",
    fname: "MTART",
    chngind: "U",
    value_old: "FERT",
    value_new: "HALB",
    ...overrides,
  };
}

function makeHeader(overrides: Partial<ChangeDocHeader>): ChangeDocHeader {
  return {
    objectclas: "MATERIAL",
    objectid: "M-0001",
    changenr: "0000000001",
    username: "DEVELOPER",
    udate: "20260910",
    utime: "091500",
    tcode: "MM02",
    change_ind: "U",
    positions: [],
    ...overrides,
  };
}

function makeSummary(overrides: Partial<ChangeDocSummary> = {}): ChangeDocSummary {
  return {
    changes_returned: 2,
    positions_returned: 4,
    truncated: false,
    objectclass: "MATERIAL",
    objectid: "%",
    user: "%",
    tcode: "%",
    since: "20260909091500",
    until: "20260910091500",
    max: 20,
    server_time: "20260910091530",
    ...overrides,
  };
}

const DENIED_TABLE = "PA0008";

/** Throws for exactly one table name, and only that one — a fake standing
 * in for `SafetyGate.assertDataPreview`. */
function denyOnly(deniedTable: string, reason = `Table ${deniedTable} is on the deny-list.`) {
  return (table: string): void => {
    if (table === deniedTable) throw new Error(reason);
  };
}

describe("applyPositionPolicy", () => {
  it("drops a deny-listed table's positions and counts them, never silently omitting them", () => {
    const posAllowed1 = makePos({ tabname: "MARA", fname: "MTART" });
    const posDenied1 = makePos({ tabname: DENIED_TABLE, fname: "BEGDA" });
    const posAllowed2 = makePos({ tabname: "MARA", fname: "MATKL" });
    const posDeniedOnlyDoc = makePos({ changenr: "0000000002", tabname: DENIED_TABLE, fname: "ENDDA" });

    const result: ChangeDocResult = {
      changes: [
        makeHeader({ changenr: "0000000001", positions: [posAllowed1, posDenied1, posAllowed2] }),
        // Every position on this document is denied — it must still appear,
        // just with an empty positions array (see the next test too).
        makeHeader({ changenr: "0000000002", positions: [posDeniedOnlyDoc] }),
      ],
      summary: makeSummary(),
    };

    const reason = `Table ${DENIED_TABLE} is on the data-preview deny-list.`;
    const policy = applyPositionPolicy(result, {
      assertDataPreview: denyOnly(DENIED_TABLE, reason),
      maxRows: 100,
    });

    expect(policy.denied).toHaveLength(1);
    expect(policy.denied[0]?.table).toBe(DENIED_TABLE);
    expect(policy.denied[0]?.reason).toBe(reason);
    // Two denied positions total, across both documents — counted, not lost.
    expect(policy.denied[0]?.rows).toBe(2);

    expect(policy.positionsTotal).toBe(4);
    expect(policy.positionsAllowed).toBe(2);
    expect(policy.positionsShown).toBe(2);
    expect(policy.clamped).toBe(false);

    expect(policy.result.changes[0]?.positions.map((p) => p.fname)).toEqual(["MTART", "MATKL"]);
  });

  it("keeps a change document all of whose positions were dropped, with an empty positions array", () => {
    const result: ChangeDocResult = {
      changes: [
        makeHeader({
          changenr: "0000000002",
          positions: [makePos({ changenr: "0000000002", tabname: DENIED_TABLE })],
        }),
      ],
      summary: makeSummary({ changes_returned: 1 }),
    };

    const policy = applyPositionPolicy(result, {
      assertDataPreview: denyOnly(DENIED_TABLE),
      maxRows: 100,
    });

    expect(policy.result.changes).toHaveLength(1);
    expect(policy.result.changes[0]?.positions).toEqual([]);
    expect(policy.denied[0]?.rows).toBe(1);
  });

  it("clamps the total position count across all documents and reports the exact shown/allowed numbers", () => {
    const posA = makePos({ changenr: "0000000001", tabname: "MARA", fname: "MTART" });
    const posB = makePos({ changenr: "0000000001", tabname: DENIED_TABLE, fname: "BEGDA" });
    const posC = makePos({ changenr: "0000000001", tabname: "MARA", fname: "MATKL" });
    const posD = makePos({ changenr: "0000000002", tabname: DENIED_TABLE, fname: "ENDDA" });

    const result: ChangeDocResult = {
      changes: [
        makeHeader({ changenr: "0000000001", positions: [posA, posB, posC] }),
        makeHeader({ changenr: "0000000002", positions: [posD] }),
      ],
      summary: makeSummary(),
    };

    const policy = applyPositionPolicy(result, {
      assertDataPreview: denyOnly(DENIED_TABLE),
      // Only 2 positions (posA, posC) survive the deny-list; clamp to 1.
      maxRows: 1,
    });

    expect(policy.positionsAllowed).toBe(2);
    expect(policy.positionsShown).toBe(1);
    expect(policy.maxRows).toBe(1);
    expect(policy.clamped).toBe(true);

    // Walked in return order: posA (doc 1) is kept, posC is cut by the clamp.
    expect(policy.result.changes[0]?.positions.map((p) => p.fname)).toEqual(["MTART"]);
    expect(policy.result.changes[1]?.positions).toEqual([]);

    // Denial counting is unaffected by the clamp — both denied rows still counted.
    expect(policy.denied[0]?.rows).toBe(2);
  });

  it("does not clamp when every allowed position fits under maxRows", () => {
    const result: ChangeDocResult = {
      changes: [makeHeader({ positions: [makePos({}), makePos({ fname: "MATKL" })] })],
      summary: makeSummary(),
    };
    const policy = applyPositionPolicy(result, { assertDataPreview: () => {}, maxRows: 50 });
    expect(policy.clamped).toBe(false);
    expect(policy.positionsShown).toBe(2);
    expect(policy.positionsAllowed).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// renderChangeDocs
// ---------------------------------------------------------------------------

describe("renderChangeDocs", () => {
  const renderOpts = { maxChars: 20_000 };

  it("names the dropped-table count and reason when a denial happened", () => {
    const result: ChangeDocResult = {
      changes: [
        makeHeader({
          positions: [makePos({ tabname: "MARA" }), makePos({ tabname: DENIED_TABLE, fname: "BEGDA" })],
        }),
      ],
      summary: makeSummary(),
    };
    const policy = applyPositionPolicy(result, {
      assertDataPreview: denyOnly(DENIED_TABLE, "Table PA0008 is on the deny-list."),
      maxRows: 100,
    });

    const { text } = renderChangeDocs(policy, renderOpts);
    expect(text).toContain("DENIED");
    expect(text).toContain(DENIED_TABLE);
    expect(text).toContain("Table PA0008 is on the deny-list.");
    expect(text).not.toContain("CLAMPED");
  });

  it("names the clamp with the allowed/shown numbers when the row cap cut something", () => {
    const result: ChangeDocResult = {
      changes: [makeHeader({ positions: [makePos({}), makePos({ fname: "MATKL" })] })],
      summary: makeSummary(),
    };
    const policy = applyPositionPolicy(result, { assertDataPreview: () => {}, maxRows: 1 });

    const { text } = renderChangeDocs(policy, renderOpts);
    expect(text).toContain("CLAMPED");
    expect(text).toContain("2 position(s) were allowed by policy, but only 1 are shown here (max=1");
    expect(text).not.toContain("DENIED");
  });

  it("says nothing about denial or clamping when neither happened", () => {
    const result: ChangeDocResult = {
      changes: [makeHeader({ positions: [makePos({})] })],
      summary: makeSummary(),
    };
    const policy = applyPositionPolicy(result, { assertDataPreview: () => {}, maxRows: 100 });

    const { text } = renderChangeDocs(policy, renderOpts);
    expect(text).not.toContain("DENIED");
    expect(text).not.toContain("CLAMPED");
  });
});

// ---------------------------------------------------------------------------
// auditChangeDocs
// ---------------------------------------------------------------------------

describe("auditChangeDocs", () => {
  it("carries the object class and the counts, and no field value from the rows", () => {
    const SEKRIT = "SEKRIT-VALUE-42";
    const result: ChangeDocResult = {
      changes: [
        makeHeader({
          objectclas: "MATERIAL",
          objectid: "M-0001",
          positions: [makePos({ tabname: "MARA", value_new: SEKRIT })],
        }),
      ],
      summary: makeSummary({ objectclass: "MATERIAL", objectid: "M-0001" }),
    };
    const policy = applyPositionPolicy(result, { assertDataPreview: () => {}, maxRows: 100 });

    const lines: string[] = [];
    auditChangeDocs(policy, (m) => lines.push(m));

    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line).toContain("core.change_docs");
    expect(line).toContain("objectclass=MATERIAL");
    expect(line).toContain("objectid=M-0001");
    expect(line).toContain("changes=1");
    expect(line).toContain("positions=1");
    expect(line).toContain("denied_tables=0");
    expect(line).not.toContain(SEKRIT);
  });

  it("still contains no field value from the rows when a denial also happened", () => {
    const SEKRIT = "SEKRIT-OLD-VALUE-99";
    const result: ChangeDocResult = {
      changes: [
        makeHeader({
          positions: [
            makePos({ tabname: "MARA", value_old: SEKRIT }),
            makePos({ tabname: DENIED_TABLE, value_old: "ANOTHER-SECRET" }),
          ],
        }),
      ],
      summary: makeSummary(),
    };
    const policy = applyPositionPolicy(result, {
      assertDataPreview: denyOnly(DENIED_TABLE),
      maxRows: 100,
    });

    const lines: string[] = [];
    auditChangeDocs(policy, (m) => lines.push(m));
    const line = lines[0]!;
    expect(line).toContain("denied_tables=1");
    expect(line).not.toContain(SEKRIT);
    expect(line).not.toContain("ANOTHER-SECRET");
  });
});
