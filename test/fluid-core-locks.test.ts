/**
 * Pure unit tests for `src/adt/enqueue-read.ts`, the TypeScript side of
 * `abap_fluid run tool:"core" action:"locks"` (issue #116): pre-network
 * argument validation, row mapping, text rendering, the audit line, and the
 * `formatLockHolders` derived view `src/adt/locked-holders.ts` reuses. No
 * AbapConnection, no dispatch(), no fluid runtime — every row below is
 * constructed by hand against the wire contract
 * `src/adt/fluid/builtin/core/abap-locks.ts`'s header comment documents,
 * mirroring `test/bal-log.test.ts`'s approach for the sibling `log.read`
 * action.
 */
import { describe, expect, it } from "vitest";
import {
  assertLocksArgs,
  mapLockRows,
  renderLocks,
  auditLocks,
  formatLockHolders,
  type EnqueueReadResult,
  type EnqueueLockRow,
  type EnqueueLockSummary,
} from "../src/adt/enqueue-read.js";
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
  throw new Error("expected assertLocksArgs to throw, but it did not");
}

// ---------------------------------------------------------------------------
// assertLocksArgs — "at least one of object/table/user" is the guarantee
// that this action can never dump the whole enqueue table.
// ---------------------------------------------------------------------------

describe("assertLocksArgs", () => {
  it("refuses an empty args object, naming all three filters", () => {
    const err = expectBadInput(() => assertLocksArgs({}));
    expect(err.message).toContain("object");
    expect(err.message).toContain("table");
    expect(err.message).toContain("user");
  });

  it("accepts object alone", () => {
    expect(() => assertLocksArgs({ object: "ZTAB" })).not.toThrow();
  });

  it("accepts table alone", () => {
    expect(() => assertLocksArgs({ table: "*ZTAB*" })).not.toThrow();
  });

  it("accepts user alone", () => {
    expect(() => assertLocksArgs({ user: "DEVELOPER" })).not.toThrow();
  });

  it("treats a blank-string object/table/user as absent, still requiring one", () => {
    expectBadInput(() => assertLocksArgs({ object: "   ", table: "", user: undefined }));
  });

  it("rejects a non-object args value", () => {
    expectBadInput(() => assertLocksArgs("nope"));
  });

  it("rejects a negative max even when a filter is present", () => {
    expectBadInput(() => assertLocksArgs({ object: "ZTAB", max: -1 }));
  });

  it("rejects a non-string object", () => {
    expectBadInput(() => assertLocksArgs({ object: 123 }));
  });
});

// ---------------------------------------------------------------------------
// mapLockRows fixtures — literal wire shape `do_locks` emits.
// ---------------------------------------------------------------------------

function metaRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    kind: "meta",
    object: "",
    table: "ZTAB",
    user: "",
    max: 50,
    fields_present: ["tcode", "host"],
    ...overrides,
  };
}

function lockRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    kind: "lock",
    gname: "EZTAB",
    gobj: "",
    garg: "300ZTAB      000001",
    gmode: "E",
    guname: "DEVELOPER",
    gclient: "300",
    gusr: "DEVELOPER",
    gusrvb: "001",
    guse: "DEVELOPER",
    gusevb: "001",
    tcode: "SE38",
    host: "sapapp01",
    // Deliberately no date/time/wp/sysnr/usec — the row structure lacking
    // the optional GT* components this test is meant to check.
    ...overrides,
  };
}

function summaryRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    kind: "summary",
    locks_read: 50,
    matched: 2,
    kept: 2,
    truncated: false,
    server_time: "20260915120000",
    ...overrides,
  };
}

describe("mapLockRows", () => {
  it("carries GNAME/GARG/GMODE/GUNAME/client/GUSR/GUSRVB through", () => {
    const rows = [metaRow(), lockRow(), summaryRow({ locks_read: 1, matched: 1, kept: 1 })];
    const result = mapLockRows(rows);

    expect(result.locks).toHaveLength(1);
    const lock = result.locks[0]!;
    expect(lock.gname).toBe("EZTAB");
    expect(lock.garg).toBe("300ZTAB      000001");
    expect(lock.gmode).toBe("E");
    expect(lock.guname).toBe("DEVELOPER");
    expect(lock.gclient).toBe("300");
    expect(lock.gusr).toBe("DEVELOPER");
    expect(lock.gusrvb).toBe("001");
  });

  it("reports matched and locks_read as distinct numbers, not conflated", () => {
    // Many locks exist (locks_read=50), few of them matched the filter
    // (matched=2) — the meaningful case this summary has to distinguish
    // from "few locks exist at all".
    const rows = [
      metaRow(),
      lockRow(),
      lockRow({ garg: "300ZTAB      000002", guname: "OTHERUSR" }),
      summaryRow({ locks_read: 50, matched: 2, kept: 2 }),
    ];
    const result = mapLockRows(rows);
    expect(result.summary.locks_read).toBe(50);
    expect(result.summary.matched).toBe(2);
    expect(result.summary.locks_read).not.toBe(result.summary.matched);
  });

  it("reports an absent GT* component as ABSENT (key not present), not as an empty string", () => {
    const rows = [metaRow(), lockRow(), summaryRow({ locks_read: 1, matched: 1, kept: 1 })];
    const result = mapLockRows(rows);
    const lock = result.locks[0]!;
    expect(lock.date).toBeUndefined();
    expect("date" in lock).toBe(false);
    expect(lock.time).toBeUndefined();
    expect("time" in lock).toBe(false);
    expect(lock.wp).toBeUndefined();
    expect(lock.sysnr).toBeUndefined();
    expect(lock.usec).toBeUndefined();
    // The fields the fixture DID carry are still present, for contrast.
    expect(lock.tcode).toBe("SE38");
    expect(lock.host).toBe("sapapp01");
  });

  it("throws FLUID_PROTOCOL_ERROR when row 0 is not a meta row", () => {
    expect(() => mapLockRows([lockRow(), summaryRow()])).toThrow(AbapError);
  });

  it("throws FLUID_PROTOCOL_ERROR when no summary row is present", () => {
    expect(() => mapLockRows([metaRow(), lockRow()])).toThrow(AbapError);
  });
});

// ---------------------------------------------------------------------------
// renderLocks
// ---------------------------------------------------------------------------

function makeSummary(overrides: Partial<EnqueueLockSummary> = {}): EnqueueLockSummary {
  return {
    object: "",
    table: "ZTAB",
    user: "",
    max: 50,
    locks_read: 0,
    matched: 0,
    kept: 0,
    truncated: false,
    server_time: "20260915120000",
    fields_present: [],
    ...overrides,
  };
}

function makeLock(overrides: Partial<EnqueueLockRow> = {}): EnqueueLockRow {
  return {
    gname: "EZTAB",
    gobj: "",
    garg: "300ZTAB      000001",
    gmode: "E",
    guname: "DEVELOPER",
    gclient: "300",
    gusr: "DEVELOPER",
    gusrvb: "001",
    guse: "DEVELOPER",
    gusevb: "001",
    ...overrides,
  };
}

describe("renderLocks", () => {
  const renderOpts = { maxChars: 20_000 };

  it("renders an empty result as a plain answer, not an error, and does not claim a match", () => {
    const result: EnqueueReadResult = { locks: [], summary: makeSummary() };
    expect(() => renderLocks(result, renderOpts)).not.toThrow();
    const { text, truncated } = renderLocks(result, renderOpts);
    expect(truncated).toBe(false);
    expect(text).toContain("kept: 0");
    expect(text).toContain("matched: 0");
    // No LOCKS table section is rendered for zero rows — buildResponse
    // drops a section whose content is empty — so there is nothing here
    // that could be mistaken for row data.
    expect(text).not.toContain("--- LOCKS ---");
    expect(text).not.toMatch(/error/i);
  });

  it("marks a truncated result, naming read/matched/kept distinctly", () => {
    const result: EnqueueReadResult = {
      locks: [makeLock(), makeLock({ guname: "OTHERUSR" })],
      summary: makeSummary({ locks_read: 10, matched: 5, kept: 2, max: 2, truncated: true }),
    };
    const { text } = renderLocks(result, renderOpts);
    expect(text).toContain(
      "Not every matching lock was returned: 10 lock(s) were read from the enqueue table, " +
        "5 matched object/table/user, and only 2 (max=2) are shown below.",
    );
  });

  it("does not mark truncation when everything matched fit under max", () => {
    const result: EnqueueReadResult = {
      locks: [makeLock()],
      summary: makeSummary({ locks_read: 1, matched: 1, kept: 1, truncated: false }),
    };
    const { text } = renderLocks(result, renderOpts);
    expect(text).not.toContain("Not every matching lock was returned");
  });
});

// ---------------------------------------------------------------------------
// formatLockHolders
// ---------------------------------------------------------------------------

describe("formatLockHolders", () => {
  it("returns at most `limit` records, in order", () => {
    const result: EnqueueReadResult = {
      locks: [
        makeLock({ guname: "FIRST" }),
        makeLock({ guname: "SECOND" }),
        makeLock({ guname: "THIRD" }),
      ],
      summary: makeSummary({ locks_read: 3, matched: 3, kept: 3 }),
    };
    const holders = formatLockHolders(result, 2);
    expect(holders).toHaveLength(2);
    expect(holders.map((h) => h.user)).toEqual(["FIRST", "SECOND"]);
    // The caller can tell the list was cut by comparing the trimmed length
    // to the full `result.locks.length` it still has on hand — there is no
    // truncation flag inside the trimmed array itself.
    expect(holders.length).toBeLessThan(result.locks.length);
  });

  it("returns every record, untrimmed, when limit is not exceeded", () => {
    const result: EnqueueReadResult = {
      locks: [makeLock({ guname: "ONLY" })],
      summary: makeSummary({ locks_read: 1, matched: 1, kept: 1 }),
    };
    const holders = formatLockHolders(result, 5);
    expect(holders).toHaveLength(1);
    expect(holders.length).toBe(result.locks.length);
  });
});

// ---------------------------------------------------------------------------
// auditLocks
// ---------------------------------------------------------------------------

describe("auditLocks", () => {
  it("carries only counts, no lock argument value", () => {
    const SEKRIT_GARG = "300ZTAB      SEKRIT-KEY-77";
    const result: EnqueueReadResult = {
      locks: [makeLock({ garg: SEKRIT_GARG })],
      summary: makeSummary({ object: "ZTAB", table: "*ZTAB*", user: "", locks_read: 5, matched: 1, kept: 1 }),
    };
    const lines: string[] = [];
    auditLocks(result, (m) => lines.push(m));

    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line).toContain("core.locks");
    expect(line).toContain("object=ZTAB");
    expect(line).toContain("table=*ZTAB*");
    expect(line).toContain("read=5");
    expect(line).toContain("matched=1");
    expect(line).toContain("kept=1");
    expect(line).not.toContain(SEKRIT_GARG);
    expect(line).not.toContain("SEKRIT-KEY-77");
  });
});
