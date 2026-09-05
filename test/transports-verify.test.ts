/**
 * `src/adt/transports.ts` — `trRelease` and `trDelete`, offline.
 *
 * This is half of that module's test suite (the other half,
 * `test/transports-parse.test.ts`, covers `isTrkorr`, `classifyCorrNrError`,
 * `trRequirement`, `trCreate`, `trShow`, `trList`, `trUsers`). Everything
 * here is driven by real wire bytes captured against A4H under
 * `test/fixtures/cts/`, replayed through `fakeCtsConnection` — no network, no
 * live appliance.
 *
 * Both operations under test share one shape: the HTTP envelope alone proves
 * nothing, and each function re-reads the request afterwards to find out
 * what actually happened. See `trRelease`'s and `trDelete`'s doc comments in
 * `src/adt/transports.ts` for the two live findings that make the re-read
 * necessary.
 */
import { describe, expect, it } from "vitest";

import { authorizeCeiling, trDelete, trRelease, type CeilingGate } from "../src/adt/transports.js";
import { fakeCtsConnection, loadCtsFixture } from "./helpers/cts-fixtures.js";

/**
 * `trDelete`/`trRelease` now require a `TransportCeilingProof` rather than a
 * `SafetyGate`, minted via `authorizeCeiling`. Neither
 * function reads anything off the proof at runtime today — it exists purely
 * as a compile-time capability token, checked by `tsc`, not by this test —
 * but every call site should still construct one for real rather than lean
 * on the fact that `test/` is outside `tsconfig.json`'s type-checked scope.
 * A trivially-permissive fake gate is enough: this suite is about wire-byte
 * parsing, not ceiling policy (see `test/transport-tools.test.ts` for that).
 */
const alwaysAllow: CeilingGate = {
  evaluate: () => ({ allowed: true, reason: "test: always allowed" }),
};
const releaseProof = authorizeCeiling(alwaysAllow, "transport", { release: true });
const deleteProof = authorizeCeiling(alwaysAllow, "transport");

const RELEASE_FIXTURES = [
  "transport-release-success",
  "transport-release-abort-already-released",
  "transport-release-abort-inactive-object",
  "transport-release-abort-task-not-released",
  "transport-release-abort-unclassified-task",
  "transport-release-abort-pre-export-yet-released",
] as const;

describe("trRelease: the HTTP envelope carries no success/failure signal", () => {
  it("all six captured release outcomes — one success, five different aborts — are HTTP 200 with threw: false", () => {
    // This is the whole reason trRelease cannot use response.status or a
    // try/catch around conn.post to decide anything: every single captured
    // release response, success or abort, resolves normally at HTTP 200. The
    // real discriminator lives inside the body (`chkrun:status`), and even
    // that can lie — see the "released despite abort" describe block below.
    for (const name of RELEASE_FIXTURES) {
      const { meta } = loadCtsFixture(name);
      expect(meta.status, `${name}: status`).toBe(200);
      expect(meta.threw, `${name}: threw`).toBe(false);
    }
  });
});

describe("trRelease: success — reportedReleased, re-read confirms it", () => {
  it("transport-release-success: the re-read is issued even though the envelope already said released, and confirms it: outcome released, verified true", async () => {
    // The envelope is not trusted just because it claims success — it has
    // been caught lying about failure (see the "released-despite-abort"
    // block below), so a "released" claim gets the same re-read treatment
    // as an abort.
    const release = loadCtsFixture("transport-release-success");
    const reread = loadCtsFixture("transport-details-released");
    const { conn, calls, assertExhausted } = fakeCtsConnection([release, reread]);

    const result = await trRelease(conn, "A4HK900122", releaseProof);

    expect(result.outcome).toBe("released");
    expect(result.reportedReleased).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.verificationError).toBeUndefined();
    expect(result.actualStatus).toBe("released");
    expect(result.request?.status).toBe("released");

    // POST release, then GET the request — the re-read now always happens.
    expect(calls).toHaveLength(2);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("/sap/bc/adt/cts/transportrequests/A4HK900122/newreleasejobs");
    expect(calls[1].method).toBe("GET");
    expect(calls[1].url).toBe("/sap/bc/adt/cts/transportrequests/A4HK900122");
    assertExhausted();
  });
});

describe("trRelease: released-despite-abort — the abort report itself lies", () => {
  it("PU/238 'pre-export' abort with the request actually Released: outcome released-despite-abort, both claims survive", async () => {
    // Observed live: chkrun:status="abortrelapifail" / "Error in pre-export
    // methods for request A4HK900125", yet a fresh read of the very same
    // request immediately afterwards shows tm:status="R" (Released). A caller
    // that stopped at the release response would wrongly report failure.
    const release = loadCtsFixture("transport-release-abort-pre-export-yet-released");
    const reread = loadCtsFixture("transport-details-released");
    const { conn, calls, assertExhausted } = fakeCtsConnection([release, reread]);

    const result = await trRelease(conn, "A4HK900125", releaseProof);

    // trRelease must issue the re-read: POST release, then GET the request.
    expect(calls).toHaveLength(2);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("/sap/bc/adt/cts/transportrequests/A4HK900125/newreleasejobs");
    expect(calls[1].method).toBe("GET");
    expect(calls[1].url).toBe("/sap/bc/adt/cts/transportrequests/A4HK900125");

    expect(result.outcome).toBe("released-despite-abort");
    expect(result.verified).toBe(true);
    expect(result.verificationError).toBeUndefined();

    // Both claims survive in the result: what the envelope reported...
    expect(result.reportedReleased).toBe(false);
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0].status).toBe("abortrelapifail");
    expect(result.reports[0].reportedReleased).toBe(false);
    // ...and the authoritative status from the re-read.
    expect(result.actualStatus).toBe("released");
    expect(result.actualStatusText).toBe("Released");
    expect(result.request?.status).toBe("released");

    // A caller inspecting only `reportedReleased` would wrongly conclude
    // failure; `outcome` is what must be trusted instead.
    expect(result.reportedReleased).toBe(false);
    expect(result.outcome).not.toBe("aborted");

    // The message survives with its parsed reason code, not just prose.
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].messageClass).toBe("PU");
    expect(result.messages[0].messageNumber).toBe("238");
    expect(result.messages[0].text).toBe("Error in pre-export methods for request A4HK900125");

    // Never the two structurally-denied "ignore" endpoints.
    for (const c of calls) {
      expect(c.url).not.toMatch(/relwithignlock|relobjigchkatc/);
    }
    assertExhausted();
  });
});

describe("trRelease: multiple check reports — order and per-check attribution preserved", () => {
  it("two checks in one envelope stay in document order, each with its own status and its own messages", async () => {
    // Hand-built: no captured fixture carries more than one chkrun:checkReport.
    // Shape modelled on transport-release-success.xml (a report with no
    // messages) followed by transport-release-abort-pre-export-yet-released.xml
    // (a report with one checkMessageList entry).
    const body =
      '<?xml version="1.0" encoding="utf-8"?><tm:root tm:useraction="newreleasejobs" ' +
      'tm:releasetimestamp="20260827090000 " tm:number="A4HK900199" ' +
      'xmlns:tm="http://www.sap.com/cts/adt/tm"><tm:releasereports>' +
      '<chkrun:checkReport chkrun:reporter="atcCheck" ' +
      'chkrun:triggeringUri="/sap/bc/adt/cts/transportrequests/A4HK900199" ' +
      'chkrun:status="released" chkrun:statusText="ATC check passed" ' +
      'xmlns:chkrun="http://www.sap.com/adt/checkrun">' +
      '<chkrun:checkMessageList><chkrun:checkMessage ' +
      'chkrun:uri="/sap/bc/adt/cts/transportrequests/A4HK900199" chkrun:type="I" ' +
      'chkrun:shortText="No issues found">' +
      '<atom:link href="/sap/bc/adt/messageclass/AT/messages/001/longtext?language=E" ' +
      'rel="http://www.sap.com/adt/relations/longtext" type="text/html" ' +
      'xmlns:atom="http://www.w3.org/2005/Atom"/>' +
      "</chkrun:checkMessage></chkrun:checkMessageList></chkrun:checkReport>" +
      '<chkrun:checkReport chkrun:reporter="transportrelease" ' +
      'chkrun:triggeringUri="/sap/bc/adt/cts/transportrequests/A4HK900199" ' +
      'chkrun:status="abortrelapifail" chkrun:statusText="Release failed" ' +
      'xmlns:chkrun="http://www.sap.com/adt/checkrun">' +
      '<chkrun:checkMessageList><chkrun:checkMessage ' +
      'chkrun:uri="/sap/bc/adt/cts/transportrequests/A4HK900199" chkrun:type="E" ' +
      'chkrun:shortText="Locked object">' +
      '<atom:link href="/sap/bc/adt/messageclass/TR/messages/999/longtext?language=E" ' +
      'rel="http://www.sap.com/adt/relations/longtext" type="text/html" ' +
      'xmlns:atom="http://www.w3.org/2005/Atom"/>' +
      "</chkrun:checkMessage></chkrun:checkMessageList></chkrun:checkReport>" +
      "</tm:releasereports></tm:root>";
    const reread = loadCtsFixture("transport-details-empty-request");
    const { conn, assertExhausted } = fakeCtsConnection([{ status: 200, body }, reread]);

    const result = await trRelease(conn, "A4HK900199", releaseProof);

    expect(result.reports).toHaveLength(2);
    expect(result.reports[0]).toMatchObject({ reporter: "atcCheck", status: "released" });
    expect(result.reports[1]).toMatchObject({
      reporter: "transportrelease",
      status: "abortrelapifail",
    });
    // Not every report succeeded, so the envelope as a whole did not claim release.
    expect(result.reportedReleased).toBe(false);

    // Messages stay attributed to, and in the order of, their own report — the
    // earlier check's success line is not buried under the later check's failure.
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({
      type: "I",
      text: "No issues found",
      messageClass: "AT",
      messageNumber: "001",
    });
    expect(result.messages[1]).toMatchObject({
      type: "E",
      text: "Locked object",
      messageClass: "TR",
      messageNumber: "999",
    });
    assertExhausted();
  });
});

describe("trRelease: no check reports at all — empty result, no throw", () => {
  it.each([
    [
      "self-closing releasereports container",
      '<?xml version="1.0" encoding="utf-8"?><tm:root tm:useraction="newreleasejobs" ' +
        'tm:releasetimestamp="20260827090000 " tm:number="A4HK900199" ' +
        'xmlns:tm="http://www.sap.com/cts/adt/tm"><tm:releasereports/></tm:root>',
    ],
    [
      "releasereports container absent entirely",
      '<?xml version="1.0" encoding="utf-8"?><tm:root tm:useraction="newreleasejobs" ' +
        'tm:releasetimestamp="20260827090000 " tm:number="A4HK900199" ' +
        'xmlns:tm="http://www.sap.com/cts/adt/tm"></tm:root>',
    ],
  ])("%s parses to no reports and no messages, without throwing", async (_label, body) => {
    const reread = loadCtsFixture("transport-details-empty-request");
    const { conn, assertExhausted } = fakeCtsConnection([{ status: 200, body }, reread]);

    const result = await trRelease(conn, "A4HK900199", releaseProof);

    expect(result.reports).toEqual([]);
    expect(result.messages).toEqual([]);
    expect(result.reportedReleased).toBe(false);
    assertExhausted();
  });
});

describe("trRelease: genuine aborts — outcome aborted, request still modifiable", () => {
  const cases: Array<{
    fixture: (typeof RELEASE_FIXTURES)[number];
    trkorr: string;
    messageClass: string;
    messageNumber: string;
    text: string;
  }> = [
    {
      fixture: "transport-release-abort-already-released",
      trkorr: "A4HK900122",
      messageClass: "TR",
      messageNumber: "768",
      text: "Request/task A4HK900122 already released (not modifiable)",
    },
    {
      fixture: "transport-release-abort-inactive-object",
      trkorr: "A4HK900122",
      messageClass: "EU",
      messageNumber: "829",
      text: "Object REPS ZMCP_CTS_REL is inactive",
    },
    {
      fixture: "transport-release-abort-task-not-released",
      trkorr: "A4HK900121",
      messageClass: "TR",
      messageNumber: "732",
      text: "Referencing task A4HK900122 not yet released",
    },
    {
      fixture: "transport-release-abort-unclassified-task",
      trkorr: "A4HK900124",
      messageClass: "TK",
      messageNumber: "494",
      text: "Task A4HK900124 is unclassified (it cannot be released)",
    },
  ];

  for (const c of cases) {
    it(`${c.fixture}: outcome aborted, reason ${c.messageClass}/${c.messageNumber} — abortrelapifail/abortrelinacobj alone would be too coarse`, async () => {
      const release = loadCtsFixture(c.fixture);
      // Re-read shows the request genuinely still sitting there modifiable
      // (tm:status="D") — the honest counterpart to the "released despite
      // abort" case above.
      const reread = loadCtsFixture("transport-details-empty-request");
      const { conn, calls, assertExhausted } = fakeCtsConnection([release, reread]);

      const result = await trRelease(conn, c.trkorr, releaseProof);

      expect(calls).toHaveLength(2);
      expect(calls[1].method).toBe("GET");
      for (const call of calls) {
        expect(call.url).not.toMatch(/relwithignlock|relobjigchkatc/);
      }

      expect(result.outcome).toBe("aborted");
      expect(result.reportedReleased).toBe(false);
      expect(result.verified).toBe(true);
      expect(result.actualStatus).toBe("modifiable");

      // The chkrun:status collapses to one of two coarse buckets; the
      // class/number parsed from the longtext link is the only stable
      // per-cause reason code.
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].messageClass).toBe(c.messageClass);
      expect(result.messages[0].messageNumber).toBe(c.messageNumber);
      expect(result.messages[0].text).toBe(c.text);
      assertExhausted();
    });
  }
});

describe("trRelease: verification itself can fail", () => {
  it("re-read throws a genuine (non-gone) error: outcome unknown, verified false, error retained — never reported as success or failure", async () => {
    const release = loadCtsFixture("transport-release-abort-already-released");
    // Reused from the delete fixture set purely for its shape: a genuine,
    // non-"gone" thrown failure (400, ADT_TM_COMMON_EXCEPTION, message that
    // does not match the "does not exist in system" pattern isGone() looks
    // for). What matters here is only that the scripted GET throws.
    const rereadFails = loadCtsFixture("transport-delete-error-locked-objects");
    const { conn, calls, assertExhausted } = fakeCtsConnection([release, rereadFails]);

    const result = await trRelease(conn, "A4HK900122", releaseProof);

    expect(calls).toHaveLength(2);
    expect(result.outcome).toBe("unknown");
    expect(result.verified).toBe(false);
    expect(result.verificationError).toBeTruthy();
    expect(result.actualStatus).toBeUndefined();
    expect(result.request).toBeUndefined();
    // The original abort report is still there — verification failing does
    // not erase what the envelope did say.
    expect(result.reports).toHaveLength(1);
    expect(result.reportedReleased).toBe(false);
    assertExhausted();
  });

  it("re-read throws TRANSPORT_GONE after the post-abort report: verified false, outcome unknown, error names the request as no longer existing", async () => {
    // Same abort report as above, but this time the re-read itself finds
    // the request gone rather than merely erroring. A "gone" re-read is not
    // evidence of anything except that verification could not happen — it
    // must not be reported as `verified: true`.
    const release = loadCtsFixture("transport-release-abort-already-released");
    const rereadGone = loadCtsFixture("transport-details-nonexistent-error");
    const { conn, calls, assertExhausted } = fakeCtsConnection([release, rereadGone]);

    const result = await trRelease(conn, "A4HK900122", releaseProof);

    expect(calls).toHaveLength(2);
    expect(result.outcome).toBe("unknown");
    expect(result.verified).toBe(false);
    expect(result.verificationError).toBeTruthy();
    expect(result.verificationError).toMatch(/no longer exists/i);
    expect(result.actualStatus).toBeUndefined();
    expect(result.request).toBeUndefined();
    expect(result.reportedReleased).toBe(false);
    assertExhausted();
  });
});

describe("trRelease: envelope claims released, but the re-read disagrees", () => {
  it("transport-release-success + still modifiable on re-read: outcome unknown, verified true, both claims survive", async () => {
    // The envelope says released; the re-read says otherwise. This is the
    // scenario this whole reconciliation exists to catch: believing the
    // envelope here would be a false success report.
    const release = loadCtsFixture("transport-release-success");
    const reread = loadCtsFixture("transport-details-empty-request");
    const { conn, calls, assertExhausted } = fakeCtsConnection([release, reread]);

    const result = await trRelease(conn, "A4HK900122", releaseProof);

    expect(calls).toHaveLength(2);
    expect(result.outcome).toBe("unknown");
    expect(result.verified).toBe(true);
    expect(result.verificationError).toBeUndefined();
    expect(result.actualStatus).toBe("modifiable");
    // Both claims survive: the envelope's and the re-read's, even though
    // they contradict each other.
    expect(result.reportedReleased).toBe(true);
    assertExhausted();
  });

  it("transport-release-success + re-read throws: outcome falls back to released, verified false, verificationError set", async () => {
    // A failed re-read must not downgrade a genuine success to unknown —
    // it falls back to the envelope's claim, flagged unverified.
    const release = loadCtsFixture("transport-release-success");
    const rereadFails = loadCtsFixture("transport-delete-error-locked-objects");
    const { conn, calls, assertExhausted } = fakeCtsConnection([release, rereadFails]);

    const result = await trRelease(conn, "A4HK900122", releaseProof);

    expect(calls).toHaveLength(2);
    expect(result.outcome).toBe("released");
    expect(result.reportedReleased).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.verificationError).toBeTruthy();
    expect(result.actualStatus).toBeUndefined();
    expect(result.request).toBeUndefined();
    assertExhausted();
  });
});

describe("trDelete: a 200 from DELETE proves nothing", () => {
  it("transport-delete-ok and transport-delete-nonexistent-noop are byte-identical (status, body, threw) — only a follow-up GET distinguishes a real delete from a no-op", () => {
    // This is the whole reason trDelete cannot trust the DELETE response on
    // its own: deleting a request that exists and deleting one that never
    // did produce indistinguishable wire responses.
    const real = loadCtsFixture("transport-delete-ok");
    const noop = loadCtsFixture("transport-delete-nonexistent-noop");

    expect(real.meta.status).toBe(noop.meta.status);
    expect(real.meta.threw).toBe(noop.meta.threw);
    expect(real.body).toBe(noop.body);
    expect(real.meta.bodyBytes).toBe(0);
    expect(noop.meta.bodyBytes).toBe(0);
  });
});

describe("trDelete: real request — exists before, provably gone after", () => {
  it("read -> delete -> read: deleted true, existedBefore true, gone true, verified true, in that call order", async () => {
    const before = loadCtsFixture("transport-details-with-objects");
    const del = loadCtsFixture("transport-delete-ok");
    const after = loadCtsFixture("transport-details-nonexistent-error");
    const { conn, calls, assertExhausted } = fakeCtsConnection([before, del, after]);

    const result = await trDelete(conn, "A4HK900117", deleteProof);

    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ method: "GET", url: "/sap/bc/adt/cts/transportrequests/A4HK900117" });
    expect(calls[1]).toMatchObject({ method: "DELETE", url: "/sap/bc/adt/cts/transportrequests/A4HK900117" });
    expect(calls[2]).toMatchObject({ method: "GET", url: "/sap/bc/adt/cts/transportrequests/A4HK900117" });

    expect(result.existedBefore).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.gone).toBe(true);
    expect(result.deleted).toBe(true);
    expect(result.httpStatus).toBe(200);
    expect(result.remaining).toBeUndefined();
    expect(result.verificationError).toBeUndefined();
    assertExhausted();
  });
});

describe("trDelete: the request never existed", () => {
  it("read (gone) -> delete (200 noop) -> read (gone): existedBefore false, deleted false despite the 200 — caller must say 'no such request', never 'deleted'", async () => {
    const before = loadCtsFixture("transport-details-nonexistent-error");
    const del = loadCtsFixture("transport-delete-nonexistent-noop");
    const after = loadCtsFixture("transport-details-nonexistent-error");
    const { conn, calls, assertExhausted } = fakeCtsConnection([before, del, after]);

    const result = await trDelete(conn, "A4HK999999", deleteProof);

    expect(calls).toHaveLength(3);
    expect(result.existedBefore).toBe(false);
    expect(result.deleted).toBe(false);
    expect(result.verified).toBe(true);
    expect(result.gone).toBe(true);
    expect(result.httpStatus).toBe(200);
    expect(result.remaining).toBeUndefined();
    assertExhausted();
  });
});

describe("trDelete: still there after delete", () => {
  it("read (exists) -> delete (200) -> read (still exists): deleted false, the surviving request surfaced", async () => {
    const before = loadCtsFixture("transport-details-with-objects");
    const del = loadCtsFixture("transport-delete-ok");
    const after = loadCtsFixture("transport-details-with-objects");
    const { conn, calls, assertExhausted } = fakeCtsConnection([before, del, after]);

    const result = await trDelete(conn, "A4HK900117", deleteProof);

    expect(calls).toHaveLength(3);
    expect(result.existedBefore).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.gone).toBe(false);
    expect(result.deleted).toBe(false);
    expect(result.remaining).toBeDefined();
    expect(result.remaining?.trkorr).toBe("A4HK900117");
    assertExhausted();
  });
});

describe("trDelete: verification itself can fail", () => {
  it("post-delete read throws a genuine (non-gone) error: verified false, deleted false, error retained", async () => {
    const before = loadCtsFixture("transport-details-with-objects");
    const del = loadCtsFixture("transport-delete-ok");
    // Reused for its shape only: a genuine, non-"gone" thrown failure (400,
    // ADT_TM_COMMON_EXCEPTION, message that does not match the "does not
    // exist in system" pattern), standing in for some unrelated read failure
    // after the delete itself succeeded.
    const afterFails = loadCtsFixture("transport-delete-error-locked-objects");
    const { conn, calls, assertExhausted } = fakeCtsConnection([before, del, afterFails]);

    const result = await trDelete(conn, "A4HK900117", deleteProof);

    expect(calls).toHaveLength(3);
    expect(result.existedBefore).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.deleted).toBe(false);
    expect(result.gone).toBe(false);
    expect(result.remaining).toBeUndefined();
    expect(result.verificationError).toBeTruthy();
    assertExhausted();
  });
});

describe("trDelete: real refusals do throw", () => {
  it("transport-delete-error-already-released: DELETE itself rejects, trDelete propagates, no re-read attempted", async () => {
    const before = loadCtsFixture("transport-details-with-objects");
    const del = loadCtsFixture("transport-delete-error-already-released");
    const { conn, calls, assertExhausted } = fakeCtsConnection([before, del]);

    // "already released (not modifiable)" matches neither `isGone` nor
    // "contains locked objects", so this is the unclassified `ctsError`
    // fallback — its generic TRANSPORT_ERROR hint must be present here too,
    // and it must not borrow TRANSPORT_LOCKED's "release or remove the locked
    // objects" wording (that hint did not fire; this is a different request,
    // already released, not locked).
    let caught: unknown;
    try {
      await trDelete(conn, "A4HK900121", deleteProof);
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({
      code: "TRANSPORT_ERROR",
      message: expect.stringContaining("already released"),
      hint: expect.stringMatching(/adt\.localizedMessage/),
    });
    expect((caught as { hint?: string }).hint).not.toMatch(/release or remove the locked objects/i);

    // Only the read and the failed delete — trDelete throws straight out of
    // the catch around conn.del rather than attempting a re-read.
    expect(calls).toHaveLength(2);
    assertExhausted();
  });

  it("transport-delete-error-locked-objects: DELETE itself rejects, trDelete propagates, no re-read attempted", async () => {
    const before = loadCtsFixture("transport-details-with-objects");
    const del = loadCtsFixture("transport-delete-error-locked-objects");
    const { conn, calls, assertExhausted } = fakeCtsConnection([before, del]);

    // Regression guard: TRANSPORT_LOCKED must keep its own specific hint,
    // untouched by the generic TRANSPORT_ERROR fallback hint added for the
    // unclassified-error case. The very old hint ("release or remove the locked
    // objects, or delete the owning task first") was false — abapsmith had no such call.
    // This is `trDelete`'s own raw hint (ctsError in src/adt/transports.ts); it now
    // names operation "removeObject" as the first real exit, since that call landed.
    // The tool layer's own hint, built by `diagnoseLockedDelete`/`lockedDeleteBaseHint`
    // in src/tools/transport.ts and exercised via `abapTransport` in
    // test/transport-tools.test.ts, enriches this further with a discrepancy prefix
    // and per-entry present/absent detail.
    const caught = await trDelete(conn, "A4HK900117", deleteProof).catch((e: unknown) => e);
    expect(caught).toMatchObject({
      code: "TRANSPORT_LOCKED",
      message: expect.stringContaining("locked objects"),
      hint: expect.stringContaining('operation "removeObject"'),
    });
    const hint = (caught as { hint?: string }).hint ?? "";
    expect(hint).toMatch(/may be a child task/i);
    expect(hint).not.toMatch(/abapsmith has no call/i);
    expect(hint).not.toMatch(/delete the owning task first/i);
    expect(hint).not.toMatch(/release or remove the locked objects/i);

    expect(calls).toHaveLength(2);
    assertExhausted();
  });
});

