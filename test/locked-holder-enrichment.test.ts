/**
 * Pure unit tests for `src/adt/locked-holders.ts`'s `enrichLockedError`
 * (issue #116) — the behavioural core: attaching best-effort enqueue-table
 * holder rows to an already-classified `LOCKED` refusal without ever
 * changing what the refusal itself says, and without ever letting a failed
 * diagnostic replace or mask it. No AbapConnection, no dispatch(), no fluid
 * runtime — `lookup` is a hand-written fake, same convention as
 * `test/bal-log.test.ts` and `test/fluid-core-locks.test.ts`.
 *
 * Also covers `summarise` (`src/tool-errors.ts`) for an envelope carrying
 * `lock_holders`, exercised through the exported `buildErrorPayload` since
 * `summarise` itself is not exported — see `test/session.test.ts` for the
 * existing convention of asserting the LOCKED hint's fixed wording and the
 * "no SM12" guarantee on the rendered envelope.
 */
import { describe, expect, it } from "vitest";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import {
  enrichLockedError,
  LOCK_HOLDER_LIMIT,
  type LockHolderLookup,
} from "../src/adt/locked-holders.js";
import type { EnqueueReadResult, EnqueueLockRow } from "../src/adt/enqueue-read.js";
import { buildErrorPayload } from "../src/tool-errors.js";

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

function makeResult(locks: EnqueueLockRow[], summaryOverrides: Partial<EnqueueReadResult["summary"]> = {}): EnqueueReadResult {
  return {
    locks,
    summary: {
      object: "",
      table: "*ZTAB*",
      user: "",
      max: 50,
      locks_read: locks.length,
      matched: locks.length,
      kept: locks.length,
      truncated: false,
      server_time: "20260915120000",
      fields_present: [],
      ...summaryOverrides,
    },
  };
}

const LOCKED_ERROR = () =>
  new AbapError(
    "LOCKED",
    "The ADT enqueue on ZTAB is held by another session.",
    { operation: "write" },
    "The ADT enqueue on ZTAB is held by another session. Locks bind to a session (sap-contextid), " +
      "not to a user: the holder may be another session of yours, or even this one.",
    { retryable: false },
  );

describe("enrichLockedError: pass-through cases", () => {
  it("returns a non-AbapError value identically (same reference)", async () => {
    const notAnError = { some: "value" };
    const out = await enrichLockedError(notAnError, "ZTAB", "abap_write", undefined);
    expect(out).toBe(notAnError);
  });

  it("returns an AbapError whose code is not LOCKED identically (same reference)", async () => {
    const e = new AbapError("NOT_FOUND", "ZTAB was not found.");
    const out = await enrichLockedError(e, "ZTAB", "abap_write", undefined);
    expect(out).toBe(e);
  });

  it("returns a LOCKED error that already carries a non-blank blockingUser identically, without calling the lookup", async () => {
    const e = new AbapError("LOCKED", "Locked.", { blockingUser: "DEVELOPER" }, "hint", { retryable: false });
    let called = false;
    const lookup: LockHolderLookup = async () => {
      called = true;
      return makeResult([makeLock()]);
    };
    const out = await enrichLockedError(e, "ZTAB", "abap_write", lookup);
    expect(out).toBe(e);
    expect(called).toBe(false);
  });

  it("returns e identically when no lookup is wired (undefined)", async () => {
    const e = LOCKED_ERROR();
    const out = await enrichLockedError(e, "ZTAB", "abap_write", undefined);
    expect(out).toBe(e);
  });

  it("returns e identically when objectName is undefined, even with a lookup wired", async () => {
    const e = LOCKED_ERROR();
    let called = false;
    const lookup: LockHolderLookup = async () => {
      called = true;
      return makeResult([makeLock()]);
    };
    const out = await enrichLockedError(e, undefined, "abap_write", lookup);
    expect(out).toBe(e);
    expect(called).toBe(false);
  });

  it("returns e identically when objectName is blank, even with a lookup wired", async () => {
    const e = LOCKED_ERROR();
    let called = false;
    const lookup: LockHolderLookup = async () => {
      called = true;
      return makeResult([makeLock()]);
    };
    const out = await enrichLockedError(e, "   ", "abap_write", lookup);
    expect(out).toBe(e);
    expect(called).toBe(false);
  });
});

describe("enrichLockedError: happy path", () => {
  it("keeps code/message/hint/retryable unchanged and gains details.lock_holders", async () => {
    const e = LOCKED_ERROR();
    let calledWith: { argPattern: string; callerTool: string } | undefined;
    const lookup: LockHolderLookup = async (argPattern, callerTool) => {
      calledWith = { argPattern, callerTool };
      return makeResult([makeLock({ guname: "DEV1" }), makeLock({ guname: "DEV2", garg: "300ZTAB 2" })]);
    };

    const out = await enrichLockedError(e, "ztab", "abap_write", lookup);

    expect(isAbapError(out)).toBe(true);
    const enriched = out as AbapError;
    // Not the same reference — a new error is returned — but every part of
    // the refusal's MEANING is unchanged.
    expect(enriched).not.toBe(e);
    expect(enriched.code).toBe(e.code);
    expect(enriched.message).toBe(e.message);
    expect(enriched.hint).toBe(e.hint);
    expect(enriched.retryable).toBe(e.retryable);

    expect(enriched.details.lock_holders).toBeDefined();
    const holders = enriched.details.lock_holders as unknown[];
    expect(holders).toHaveLength(2);
    expect(enriched.details.lock_holders_total).toBeUndefined();

    // Original details keys survive alongside the new one.
    expect(enriched.details.operation).toBe("write");

    // The lookup argument pattern: uppercased object name, wildcarded both
    // sides — see src/adt/locked-holders.ts's own comment on why.
    expect(calledWith?.argPattern).toBe("*ZTAB*");
    expect(calledWith?.callerTool).toBe("abap_write");
  });

  it("threads callerTool through to the lookup unchanged", async () => {
    const e = LOCKED_ERROR();
    let seenCallerTool: string | undefined;
    const lookup: LockHolderLookup = async (_argPattern, callerTool) => {
      seenCallerTool = callerTool;
      return makeResult([makeLock()]);
    };
    await enrichLockedError(e, "ZTAB", "abap_activate", lookup);
    expect(seenCallerTool).toBe("abap_activate");
  });

  it("returns e unchanged when the lookup finds nothing", async () => {
    const e = LOCKED_ERROR();
    const lookup: LockHolderLookup = async () => makeResult([]);
    const out = await enrichLockedError(e, "ZTAB", "abap_write", lookup);
    expect(out).toBe(e);
  });

  it("returns e unchanged when the lookup resolves to undefined", async () => {
    const e = LOCKED_ERROR();
    const lookup: LockHolderLookup = async () => undefined;
    const out = await enrichLockedError(e, "ZTAB", "abap_write", lookup);
    expect(out).toBe(e);
  });

  it("caps the shown holder list at LOCK_HOLDER_LIMIT and sets lock_holders_total from more rows", async () => {
    const e = LOCKED_ERROR();
    const ROW_COUNT = LOCK_HOLDER_LIMIT + 2;
    const locks = Array.from({ length: ROW_COUNT }, (_, i) => makeLock({ guname: `DEV${i}`, garg: `300ZTAB ${i}` }));
    const lookup: LockHolderLookup = async () => makeResult(locks, { matched: ROW_COUNT, kept: ROW_COUNT });

    const out = (await enrichLockedError(e, "ZTAB", "abap_write", lookup)) as AbapError;

    const holders = out.details.lock_holders as unknown[];
    expect(holders).toHaveLength(LOCK_HOLDER_LIMIT);
    expect(out.details.lock_holders_total).toBe(ROW_COUNT);
  });
});

describe("enrichLockedError: lookup failure", () => {
  it("returns the ORIGINAL error unchanged and calls warn exactly once when the lookup throws", async () => {
    const e = LOCKED_ERROR();
    const lookup: LockHolderLookup = async () => {
      throw new Error("fluid API disabled");
    };
    const warnCalls: string[] = [];
    const out = await enrichLockedError(e, "ZTAB", "abap_write", lookup, (m) => warnCalls.push(m));

    expect(out).toBe(e);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toContain("fluid API disabled");
    expect(warnCalls[0]).toContain("LOCKED");
  });

  it("swallows the lookup failure even when no warn callback is given", async () => {
    const e = LOCKED_ERROR();
    const lookup: LockHolderLookup = async () => {
      throw new Error("boom");
    };
    const out = await enrichLockedError(e, "ZTAB", "abap_write", lookup);
    expect(out).toBe(e);
  });

  it("never lets a second error escape past a failed diagnostic", async () => {
    const e = LOCKED_ERROR();
    const lookup: LockHolderLookup = async () => {
      throw new AbapError("ADT_ERROR", "a completely different, unrelated failure");
    };
    const out = await enrichLockedError(e, "ZTAB", "abap_write", lookup, () => {});
    expect(isAbapError(out)).toBe(true);
    expect((out as AbapError).code).toBe("LOCKED");
    expect(out).toBe(e);
  });
});

// ---------------------------------------------------------------------------
// summarise (src/tool-errors.ts), exercised through buildErrorPayload
// ---------------------------------------------------------------------------

describe("summarise: LOCKED envelope carrying lock_holders", () => {
  it("names the holders, never says SM12, and keeps the session-not-user wording intact", () => {
    const e = new AbapError(
      "LOCKED",
      "The ADT enqueue on ZTAB is held by another session.",
      {
        lock_holders: [
          { user: "DEVELOPER", tcode: "SE38", gname: "EZTAB", garg: "300ZTAB 1" },
          { user: "SMITH", gname: "EZTAB", garg: "300ZTAB 2" },
        ],
      },
      "The ADT enqueue on ZTAB is held by another session. Locks bind to a session (sap-contextid), " +
        "not to a user: the holder may be another session of yours, or even this one — re-locking an " +
        "object you already hold returns this same envelope. Do NOT retry in a loop; there is no lock " +
        "timeout — the enqueue clears only when the holding session releases it or ends. Close the " +
        "other session (another terminal, an Eclipse/SE80 editor), or work on a different object.",
      { retryable: false },
    );

    const payload = buildErrorPayload(e);

    expect(typeof payload.summary).toBe("string");
    const summary = payload.summary as string;
    expect(summary).toContain("DEVELOPER");
    expect(summary).toContain("SMITH");
    expect(summary).toContain("Enqueue table shows");

    // The hint is passed through unchanged by buildErrorPayload/summarise —
    // enrichment (and this envelope construction) must not touch it.
    expect(payload.hint).toBe(e.hint);
    expect(payload.hint as string).toContain("Locks bind to a session (sap-contextid), not to a user");

    // Load-bearing: nowhere in the rendered envelope does "SM12" appear —
    // the LOCKED hint deliberately never points at SM12 (that pointer
    // belongs to the lock-LEAK hint in releaseLock, not this one), and the
    // holder-lookup addition must not introduce it either.
    const rendered = JSON.stringify(payload);
    expect(rendered).not.toMatch(/SM12/);
  });

  it("states holdersTotal as its own clause when more holders exist than were shown", () => {
    const e = new AbapError(
      "LOCKED",
      "The ADT enqueue on ZTAB is held by another session.",
      {
        lock_holders: [{ user: "DEVELOPER", gname: "EZTAB", garg: "300ZTAB 1" }],
        lock_holders_total: 7,
      },
      "Locks bind to a session (sap-contextid), not to a user.",
      { retryable: false },
    );

    const payload = buildErrorPayload(e);
    const summary = payload.summary as string;
    expect(summary).toContain("7 holders in total; 1 shown");
    expect(JSON.stringify(payload)).not.toMatch(/SM12/);
  });

  it("omits the holder sentence entirely when no lock_holders were attached", () => {
    const e = new AbapError(
      "LOCKED",
      "The ADT enqueue on ZTAB is held by another session.",
      { blockingUser: "DEVELOPER" },
      "Locks bind to a session (sap-contextid), not to a user.",
      { retryable: false },
    );
    const payload = buildErrorPayload(e);
    const summary = payload.summary as string;
    expect(summary).not.toContain("Enqueue table shows");
    expect(summary).toContain("Held by user DEVELOPER");
  });
});
