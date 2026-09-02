/**
 * The shared session-death oracle.
 *
 * Session death is decided by two INDEPENDENTLY-IMPLEMENTED classifiers
 * reading different inputs off (sometimes) the exact same bytes:
 *
 *   - Classifier A — `classifySessionFailure` (src/adt/session.ts), consumed
 *     by `AbapConnection.noteWireResponse`/`noteWireThrow`. Input: the RAW
 *     WIRE RESPONSE (status/statusText/headers/body). Its header tier
 *     (`x-sap-icm-err-id: ICMENOSESSION` / `sap-err-id`) is UNGATED BY STATUS
 *     — it condemns the connection at ANY status, including 200.
 *   - Classifier B — `translateAdtError` (src/adt/session.ts). Input: a
 *     THROWN `AdtException`. Output: an `AbapErrorCode`, `"SESSION_DEAD"`
 *     among them.
 *
 * Before this fix, these two could disagree on the SAME response: a 423
 * `ExceptionResourceInvalidLockHandle` body that ALSO carried
 * `x-sap-icm-err-id: ICMENOSESSION` was "a death" to A (which had already
 * run, via `noteWireResponse`, and set `this.death` on the connection) and
 * "just an invalid lock handle" to B (which resolved
 * `INVALID_LOCK_HANDLE_TYPE_IDS` before it ever reached its own
 * `classifySessionFailure` call). `test/connection-liveness.test.ts`'s
 * lock-leak / dropSession() classifier-disagreement test reproduces exactly
 * this combination as a live concern, not a hypothetical this file invented.
 *
 * Why this matters beyond tidy classification: `runOnAttempt`
 * (src/adt/pool.ts) REPLAYS a mutating operation when
 * it sees a session-dead error shape. If A and B disagree about the SAME
 * response, one code path can treat the connection as dead (and be ready to
 * replay) while another treats the identical bytes as a survivable object
 * error — and replaying a mutation that was never actually lost is a
 * DUPLICATE WRITE, the worst failure mode in this codebase (see
 * `pool.ts`'s own doc comments on `runOnAttempt`).
 *
 * WHAT THIS FILE IS: a corpus of named response shapes, each run through
 * BOTH classifiers, with a THIRD test asserting they agree. Disagreement is
 * a red test here, not a production surprise.
 *
 * WHAT THIS FILE IS NOT: a claim that every case below is a live capture.
 * Each case's `provenance` field says, per case, whether the bytes are
 * live-captured, synthesised from documented-but-uncaptured live findings,
 * or a plain constructed negative control — checked against
 * `test/fixtures/live-captured/INDEX.md` and `ledger.tsv` before writing
 * this file. AS OF THIS WRITING, NEITHER FILE INDEXES A CAPTURED
 * `ICMENOSESSION` TRANSCRIPT (no fixture file's bytes carry that header) —
 * every ICMENOSESSION-bearing case here is therefore SYNTHESISED, matching
 * the wire shape `src/adt/session.ts`'s own `ICM_ERR_ID_HEADERS` doc
 * comment documents from a live probe, but not replaying a stored capture.
 * Overstating that as "live-captured" would be worse than not testing it at
 * all — see this file's closing section for the two asymmetries that are
 * deliberately NOT dressed up as more than they are.
 *
 * A CONCURRENT AGENT'S PROBE REPORT (2026-08-19, not independently verified
 * by this file — attributed, not first-hand): while this file was being
 * written, a sibling agent working the same issue reported running raw-HTTP
 * probes against a live A4H appliance and relayed four findings, folded into
 * the relevant cases' `provenance` strings below rather than asserted here
 * as this file's own capture:
 *   1. `400`/ICMENOSESSION (corpus case 3) — reported byte-exact live, with
 *      one discrepancy from `ICM_ERR_ID_HEADERS`'s doc comment (`HTTP/1.0`
 *      on the wire, not `HTTP/1.1`) that this file leaves for that doc
 *      comment's own owner to correct, being out of this file's scope.
 *   2. `423 ExceptionResourceInvalidLockHandle` ALONE, no ICM header (corpus
 *      case 5) — reported live-confirmed.
 *   3. `423` + ICMENOSESSION TOGETHER (corpus case 1) — reported to NOT
 *      occur on that appliance: a dead `sap-contextid` is reportedly
 *      intercepted by the ICM before ABAP's own lock-validation logic runs,
 *      so a `423` is structurally impossible once the session is already
 *      dead. Case 1 therefore guards a real CODE-LEVEL disagreement between
 *      two classifiers reading the same bytes (see `isLockConflict` and
 *      `classifySessionFailure`, both of which exist and can be handed this
 *      input regardless of whether SAP itself ever produces it), not a
 *      reproduction of a wire capture — and is labelled that way below.
 *   4. `200` + ICMENOSESSION — reported unreproduced, 0/15 attempts across
 *      three routes. `src/adt/connection.ts`'s own comment near
 *      `noteWireResponse` presents this shape as "Measured", but that
 *      measurement is `connect()`'s behaviour under an INJECTED fake
 *      response in a test, not a live capture — the two are not the same
 *      claim, and this file does not conflate them. See the asymmetry-1
 *      block below.
 */
import type { HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { AdtErrorException, fromException } from "abap-adt-api/build/AdtException.js";
import { describe, expect, it } from "vitest";
import {
  adtExceptionInfo,
  classifySessionFailure,
  translateAdtError,
  type SessionResponseLike,
} from "../src/adt/session.js";
import { captured } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

interface OracleCase {
  name: string;
  /** Honest, per-case: live-captured, synthesised (and from what), or a plain negative control. */
  provenance: string;
  response: SessionResponseLike;
  /** The ADT `<type id="…"/>`, if this case carries a parsed exception envelope. */
  adtType?: string;
  properties?: Record<string, string>;
  expectedDead: boolean;
}

const ICM_HEADERS = {
  "x-sap-icm-err-id": "ICMENOSESSION",
  "sap-err-id": "ICMENOSESSION",
};

const XML_HEADERS = { "content-type": "application/xml" };

export const CORPUS: OracleCase[] = [
  {
    name: "423 ExceptionResourceInvalidLockHandle + ICMENOSESSION (classifier-disagreement reproduction)",
    provenance:
      "SYNTHESISED, AND REPORTEDLY REFUTED AS A WIRE SHAPE on the one appliance checked. " +
      "The 423/`ExceptionResourceInvalidLockHandle` envelope shape is confirmed live on its " +
      "own (lock-handle validation, two captured instances — see " +
      "`INVALID_LOCK_HANDLE_TYPE_IDS`'s doc comment in src/adt/session.ts), and the " +
      "ICMENOSESSION header shape is confirmed live on its own too (passive expiry — see " +
      "`ICM_ERR_ID_HEADERS`'s doc comment). Their CO-OCCURRENCE on one response is NOT a " +
      "stored capture, and a concurrent agent's A4H probe run (2026-08-19, reported, not " +
      "independently verified here) found this exact compound shape does not occur: a dead " +
      "`sap-contextid` is reportedly intercepted by the ICM before ABAP's own lock-validation " +
      "logic runs, so a `423` is structurally impossible once the session is already dead. " +
      "This case is therefore NOT a wire reproduction — it guards a real CODE-LEVEL " +
      "disagreement between `isLockConflict`/`INVALID_LOCK_HANDLE_TYPE_IDS` and " +
      "`classifySessionFailure`, both of which exist and can be handed this input regardless " +
      "of whether SAP itself ever produces it on this appliance. " +
      "`test/connection-liveness.test.ts`'s lock-leak / dropSession() classifier-disagreement " +
      "test uses this same combination for the same reason — a fixture engineered to exercise the " +
      "disagreement, not a claim that SAP sends it.",
    response: {
      status: 423,
      statusText: "Locked",
      headers: { ...XML_HEADERS, ...ICM_HEADERS },
      body: `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/>
  <type id="ExceptionResourceInvalidLockHandle"/>
  <message lang="EN">Resource INCLUDE ZMCPX_P1 is not locked (invalid lock handle: DEADBEEF00)</message>
</exc:exception>`,
    },
    adtType: "ExceptionResourceInvalidLockHandle",
    expectedDead: true,
  },
  {
    name: "403 ExceptionResourceNoAccess + ICMENOSESSION (lock-conflict type id, disagreement check)",
    provenance:
      "SYNTHESISED, same basis as the 423 case above, and likely non-occurring on the wire " +
      "for the same reason: `ExceptionResourceNoAccess` on 403 is confirmed live " +
      "five-for-five across object types (`LOCK_CONFLICT_TYPE_IDS`'s doc comment), and " +
      "ICMENOSESSION is confirmed live on its own. The co-occurrence is NOT a stored " +
      "capture, and was not itself probed (only the 423 compound was) — but the same " +
      "reported mechanism (a dead `sap-contextid` intercepted by the ICM before ABAP's lock " +
      "logic runs) would apply here too, so this is presumed similarly unreachable on the " +
      "wire, not confirmed either way. Kept for the same reason as case 1: it exists to " +
      "check whether the classifier disagreement also reaches the OTHER lock branch " +
      "(`isLockConflict`'s tier 1, which returns `true` on the type id alone, at ANY " +
      "status) and not just the invalid-handle branch — a CODE-LEVEL check, not a wire one.",
    response: {
      status: 403,
      statusText: "Forbidden",
      headers: { ...XML_HEADERS, ...ICM_HEADERS },
      body: `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/>
  <type id="ExceptionResourceNoAccess"/>
  <message lang="EN">User DEVELOPER is currently editing ZMCPX_P1</message>
  <localizedMessage lang="EN">User DEVELOPER is currently editing ZMCPX_P1</localizedMessage>
  <properties>
    <entry key="T100KEY-ID">EU</entry>
    <entry key="T100KEY-NO">510</entry>
    <entry key="T100KEY-V1">DEVELOPER</entry>
    <entry key="T100KEY-V2">ZMCPX_P1</entry>
  </properties>
</exc:exception>`,
    },
    adtType: "ExceptionResourceNoAccess",
    properties: {
      "T100KEY-ID": "EU",
      "T100KEY-NO": "510",
      "T100KEY-V1": "DEVELOPER",
      "T100KEY-V2": "ZMCPX_P1",
    },
    expectedDead: true,
  },
  {
    name: '400 "Session timed out" statusText + ICMENOSESSION header',
    provenance:
      "SYNTHESISED from the documented live wire shape in `ICM_ERR_ID_HEADERS`'s doc " +
      "comment (src/adt/session.ts): the exact header/status pairing quoted there " +
      '(`400`, `x-sap-icm-err-id: ICMENOSESSION`, `sap-err-id: ICMENOSESSION` mirrored). ' +
      "A concurrent agent's A4H probe (2026-08-19, reported, not independently verified " +
      "here) says this shape was re-verified byte-exact live, with one discrepancy from " +
      "that doc comment: the status line is `HTTP/1.0` on the wire, not `HTTP/1.1` as " +
      "written there — left uncorrected here, out of this file's scope, for that comment's " +
      "own owner. No ADT exception type id is involved at all, so neither lock branch in " +
      "`translateAdtError` can even be entered before its (pre-fix) `classifySessionFailure` " +
      "call. Included as the baseline case where agreement should ALREADY hold, with or " +
      "without the fix, so a regression here would mean something else broke.",
    response: {
      status: 400,
      statusText: "Session timed out",
      headers: ICM_HEADERS,
      body: "400 Session Timed Out - Session no longer exists",
    },
    expectedDead: true,
  },
  {
    name: "500 real captured ABAP short-dump HTML page (COMPUTE_INT_ZERODIVIDE), no ICM header",
    provenance:
      "LIVE-CAPTURED. `test/fixtures/live-captured/701-run-zcl_zmcp_dmp_zerodiv.html`, " +
      "indexed in INDEX.md as a genuine `COMPUTE_INT_ZERODIVIDE`-style division-by-zero " +
      "short dump captured against a real appliance. Reused verbatim, byte for byte.",
    response: {
      status: 500,
      statusText: "Internal Server Error",
      headers: { "content-type": "text/html; charset=windows-1252" },
      body: captured("701-run-zcl_zmcp_dmp_zerodiv.html"),
    },
    expectedDead: true,
  },
  {
    name: "423 ExceptionResourceInvalidLockHandle, NO ICM header (regression guard)",
    provenance:
      "SYNTHESISED from the confirmed-live 423/InvalidLockHandle shape (see the first " +
      "corpus case's own two-captured-instances basis) — and this exact ALONE shape (no " +
      "ICM header) was additionally reported re-confirmed by a concurrent agent's A4H " +
      "probe (2026-08-19, reported, not independently verified here). This is the guard " +
      "that PROVES the fix did not turn every invalid-lock-handle response into a " +
      "session death: without the header, there is no transport-level evidence of " +
      "anything, and this must stay `ADT_ERROR`/`INVALID_LOCK_HANDLE`.",
    response: {
      status: 423,
      statusText: "Locked",
      headers: XML_HEADERS,
      body: `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/>
  <type id="ExceptionResourceInvalidLockHandle"/>
  <message lang="EN">Resource INCLUDE ZMCPX_P1 is not locked (invalid lock handle: DEADBEEF00)</message>
</exc:exception>`,
    },
    adtType: "ExceptionResourceInvalidLockHandle",
    expectedDead: false,
  },
  {
    name: "403 ExceptionResourceNoAccess, NO ICM header (regression guard, stays LOCKED)",
    provenance:
      "SYNTHESISED from the confirmed-live five-object-type lock-conflict shape (see the " +
      "second corpus case), with the ICM header removed. Guards that an ordinary lock " +
      "conflict — no transport evidence at all — still reaches the caller as `LOCKED`, not " +
      "`SESSION_DEAD`.",
    response: {
      status: 403,
      statusText: "Forbidden",
      headers: XML_HEADERS,
      body: `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/>
  <type id="ExceptionResourceNoAccess"/>
  <message lang="EN">User DEVELOPER is currently editing ZMCPX_P1</message>
  <localizedMessage lang="EN">User DEVELOPER is currently editing ZMCPX_P1</localizedMessage>
  <properties>
    <entry key="T100KEY-ID">EU</entry>
    <entry key="T100KEY-NO">510</entry>
    <entry key="T100KEY-V1">DEVELOPER</entry>
    <entry key="T100KEY-V2">ZMCPX_P1</entry>
  </properties>
</exc:exception>`,
    },
    adtType: "ExceptionResourceNoAccess",
    properties: {
      "T100KEY-ID": "EU",
      "T100KEY-NO": "510",
      "T100KEY-V1": "DEVELOPER",
      "T100KEY-V2": "ZMCPX_P1",
    },
    expectedDead: false,
  },
  {
    name: "plain 404, no exception envelope",
    provenance:
      "PLAIN NEGATIVE CONTROL, not modelled on any specific capture — a bare 404 with no " +
      "body worth parsing. Neither classifier has any death-shaped evidence to work with.",
    response: {
      status: 404,
      statusText: "Not Found",
      headers: { "content-type": "text/plain" },
      body: "Not Found",
    },
    expectedDead: false,
  },
  {
    name: "plain 500 with a non-HTML JSON body and no dump markers",
    provenance:
      "PLAIN NEGATIVE CONTROL. A 500 that is definitely not a short dump — no HTML, no " +
      "structural or prose dump markers, no ICM header. Guards `classifySessionFailure`'s " +
      "500 branch against treating every server error as a session death, which is exactly " +
      "the false-positive `test/session.test.ts`'s \"does NOT classify a real 500 " +
      "<exc:exception> envelope as a dump\" test also guards, from a different angle.",
    response: {
      status: 500,
      statusText: "Internal Server Error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: { code: "INTERNAL", message: "unexpected failure" } }),
    },
    expectedDead: false,
  },
];

// ---------------------------------------------------------------------------
// Classifier B input: an `AdtErrorException`-shaped throw carrying the SAME
// response bytes as the corpus entry, so B sees exactly what A saw.
//
// Mirrors the shape `adtExceptionInfo` (src/adt/session.ts:472) actually
// reads: a numeric `.err` (checked before `.status`), a string `.type`, a
// `.properties` object, and a `.response` object whose `status`/`statusText`/
// `headers`/`body` is what `pickResponse` (src/adt/session.ts:409) looks for
// directly on the thrown value (the one-hop `.parent.response` walk exists
// for `AdtHttpException`, which this helper does not need to reproduce —
// nothing here is a transport-level wrapper).
// ---------------------------------------------------------------------------

function throwFor(c: OracleCase): unknown {
  return Object.assign(new Error(c.response.statusText || `HTTP ${c.response.status}`), {
    err: c.response.status,
    type: c.adtType,
    properties: c.properties ?? {},
    response: c.response,
  });
}

const ctx = { operation: "oracle-test" };

describe("session-death oracle — corpus run through classifier A", () => {
  for (const c of CORPUS) {
    it(`A: ${c.name}`, () => {
      const dead = classifySessionFailure(c.response) !== undefined;
      expect(dead, `classifier A verdict for "${c.name}"`).toBe(c.expectedDead);
    });
  }
});

describe("session-death oracle — corpus run through classifier B", () => {
  for (const c of CORPUS) {
    it(`B: ${c.name}`, () => {
      const err = translateAdtError(throwFor(c), ctx);
      const dead = err.code === "SESSION_DEAD";
      expect(dead, `classifier B verdict for "${c.name}" (got code ${err.code})`).toBe(
        c.expectedDead,
      );
    });
  }
});

describe("session-death oracle — THE ORACLE: A and B must agree", () => {
  for (const c of CORPUS) {
    it(`A and B agree on: ${c.name}`, () => {
      const aDead = classifySessionFailure(c.response) !== undefined;
      const bDead = translateAdtError(throwFor(c), ctx).code === "SESSION_DEAD";
      expect(
        aDead,
        `DISAGREEMENT on "${c.name}": classifier A says ${aDead ? "DEAD" : "alive"}, ` +
          `classifier B says ${bDead ? "DEAD" : "alive"}. This is exactly the failure ` +
          `mode: one response, two verdicts, and pool.ts's runOnAttempt can act on either ` +
          `one depending which classifier it asks.`,
      ).toBe(bDead);
    });
  }
});

// ---------------------------------------------------------------------------
// Two known asymmetries this fix does NOT resolve. Documented here, in
// code, so the honesty survives — neither is dressed up as more coverage
// than it is.
// ---------------------------------------------------------------------------

describe("known asymmetry 1 (documented, NOT resolved by this fix) — a 200 carrying ICMENOSESSION", () => {
  /**
   * DELIBERATELY EXCLUDED FROM `CORPUS` ABOVE, not merely skipped: the
   * agreement test above asserts "classifier A's verdict equals classifier
   * B's verdict", and there is no way to ask classifier B about a `200`,
   * because classifier B (`translateAdtError`) is only ever reached from a
   * CAUGHT THROW, and nothing throws on a 200 — `abap-adt-api` and this
   * project's own HTTP layer only construct an `AdtErrorException`/reject a
   * promise for a non-2xx status. Putting a `200` case in `CORPUS` and
   * inventing a throw for it anyway would fabricate an input B never
   * receives in production and turn a real gap into a fake green checkmark.
   * This block exists so that gap is on the record instead.
   */
  it("classifier A condemns it; classifier B has no input here because nothing throws", () => {
    // PROVENANCE: this is a CODE-BEHAVIOUR test, not a wire reproduction. A
    // concurrent agent's A4H probe (2026-08-19, reported, not independently
    // verified here) tried to reproduce a `200` carrying ICMENOSESSION across
    // three routes, 15 attempts, and saw it 0/15 times. `connection.ts`'s own
    // comment near `noteWireResponse` calls this shape "Measured", but that
    // "Measured" is `connect()`'s behaviour under an INJECTED fake response in
    // an offline test — i.e. "the code does this if handed this input" — not a
    // claim that SAP was seen to send it. This test asserts the same thing
    // that comment does (classifier A is status-ungated, so IT WOULD condemn
    // a 200 shaped like this), and no more.
    const resp: SessionResponseLike = {
      status: 200,
      statusText: "OK",
      headers: ICM_HEADERS,
      body: "",
    };
    // Classifier A: the header tier is deliberately ungated by status (see
    // `classifySessionFailure`'s doc comment), so this fires exactly like
    // the 400/423/403 cases above.
    expect(classifySessionFailure(resp)).toBe("session-timeout");

    // Classifier B is not run here at all — there is nothing to run it on.
    // `AbapConnection.noteWireResponse` (src/adt/connection.ts) is the only
    // reason classifier A ever sees this response in production: it runs
    // unconditionally on every response regardless of status, which is
    // exactly what makes this shape reachable for A but structurally
    // unreachable for B.
  });
});

describe("known asymmetry 2 (REASONED-NOT-REPRODUCED) — B fires from message text with no `.response` for A to ever see", () => {
  /**
   * REASONED-NOT-REPRODUCED: no captured transcript backs this combination.
   * It is inferred from reading two places in this codebase, not observed
   * live:
   *
   *  - `AbapConnection`'s `noteWireThrow` (src/adt/connection.ts) returns
   *    immediately, without calling classifier A at all, when the thrown
   *    value carries no `.response` object with a numeric `.status`.
   *  - `sessionDeathFromInfo`'s own doc comment (src/adt/session.ts)
   *    documents that its caller, `translateAdtError`, still classifies a
   *    throw shaped this way — "this path has NO headers, so the ... ICM
   *    tier cannot fire here and the message/marker tiers are the whole
   *    classifier" — and names `test/source.test.ts:78` as the one shape
   *    this project has actually exercised with no `.response` at all.
   *
   * This test reuses that exact shape (`AdtErrorException(400, {}, "",
   * "Session Timed Out")`, no 8th `response` argument) rather than
   * inventing a new one, and draws the conclusion those two facts imply:
   * classifier B can reach `SESSION_DEAD` here, while classifier A is never
   * even asked, because `AbapConnection` never sees anything shaped like a
   * response to classify.
   */
  it("B classifies SESSION_DEAD from text alone; A is never invoked because there is no response object", () => {
    const e = new AdtErrorException(400, {}, "", "Session Timed Out");

    // Classifier B: fires from `.err` + message text (`sessionDeathFromInfo`).
    expect(translateAdtError(e, ctx).code).toBe("SESSION_DEAD");

    // Classifier A: cannot be asked. There is no `SessionResponseLike` here
    // for `classifySessionFailure` to classify — `adtExceptionInfo` (the
    // same normalisation both classifiers' callers rely on) confirms it.
    expect(adtExceptionInfo(e)?.response).toBeUndefined();
  });
});


// ---------------------------------------------------------------------------

describe("dependency contingency — `.type` and `.response` never co-occur in abap-adt-api@8.4.1", () => {
  /**
   * WHY THIS TEST EXISTS, and why it asserts about a DEPENDENCY rather than
   * about our own code.
   *
   * The oracle's ordering change hoists a `classifySessionFailure(info?.response)`
   * check above the lock branches in `translateAdtError`. For that hoist to
   * change any verdict, ONE thrown exception must carry BOTH an ADT
   * `<type id>` (what the lock branches read) AND a `.response` (what the
   * hoisted check reads). In `abap-adt-api@8.4.1` no exception carries both.
   *
   * The exact mechanism — verified by reading the installed package, and
   * NOT the one it is easy to assume from a glance at `AdtErrorException.create`:
   *
   *   - `fromResponse` NEVER attaches a response, on EITHER of its paths.
   *     The `<exc:exception>` envelope path calls the constructor with SEVEN
   *     arguments, omitting the 8th (`response`) → `.type` set,
   *     `.response` undefined. The empty-body/401 path returns
   *     `simpleError(response)`, which is `adtException(msg, status)` —
   *     `new AdtErrorException(number, {}, "", message)`, four arguments,
   *     also no response, and an empty `.type`.
   *   - The ONLY constructor call that populates `.response` is
   *     `AdtErrorException.create(errOrResp, {})` in
   *     `fromExceptionOrResponse_int`'s CATCH — i.e. it fires only when
   *     `fromResponse` itself THREW (a body that is neither empty nor CSRF
   *     nor a parseable `exc:exception` envelope makes `root.type["@_id"]`
   *     throw). That path hardcodes `""` for `type`.
   *
   * So the two fields are populated by mutually exclusive branches, and the
   * disagreement this file's CORPUS proves is real in principle but NOT
   * reachable through today's library shapes. That is stated plainly in the
   * PR body rather than letting the change imply coverage it does not have.
   *
   * The reason this is a TEST and not merely a comment: the exclusivity is a
   * property of a PINNED VERSION, not a law. `package.json` declares
   * `"abap-adt-api": "^8.4.1"` — a CARET range, so a minor upgrade is taken
   * automatically. A release that starts attaching the response on the
   * envelope path, or stops hardcoding the empty type in the catch, would
   * make the disagreement reachable without one line of our code changing.
   * A red test here is how we find that out. The alternative — finding out
   * because a write was duplicated in production — is the exact failure mode
   * this issue is about.
   *
   * Note the direction: this does NOT demand the exclusivity hold forever.
   * If a future version breaks it, the right response is to DELETE this test
   * and record that the hoisted check is now load-bearing on a live path —
   * NOT to pin the dependency back to keep the test green.
   *
   * These call `fromException`, the public entry point `AdtHTTP` itself uses
   * (`AdtHTTP.js` throws `fromException(response, config)` on a non-2xx), so
   * this exercises the real production construction path rather than a
   * helper chosen for convenience.
   */
  const resp = (status: number, body: string, statusText = "Locked") =>
    ({ status, statusText, headers: {}, body }) as unknown as HttpClientResponse;

  const ENVELOPE =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
    `<namespace id="com.sap.adt"/>` +
    `<type id="ExceptionResourceInvalidLockHandle"/>` +
    `<message lang="EN">Resource is not locked (invalid lock handle: DEADBEEF)</message>` +
    `<localizedMessage lang="EN">Resource is not locked</localizedMessage>` +
    `<properties/></exc:exception>`;

  const responseOf = (e: unknown): unknown => (e as { response?: unknown }).response;

  it("the envelope path sets `.type` and leaves `.response` undefined", () => {
    const e = fromException(resp(423, ENVELOPE), undefined as never);

    expect((e as AdtErrorException).type).toBe("ExceptionResourceInvalidLockHandle");
    // THE LOAD-BEARING HALF: nothing for the hoisted
    // `classifySessionFailure(info?.response)` to classify, so the lock
    // branches below it still decide this shape today.
    expect(responseOf(e)).toBeUndefined();
    expect(adtExceptionInfo(e)?.response).toBeUndefined();
  });

  it("the parse-throw path sets `.response` and leaves `.type` empty", () => {
    // Neither empty, nor CSRF, nor a parseable `exc:exception` envelope —
    // so `fromResponse` throws and the catch attaches the response.
    const e = fromException(resp(423, "<html><body>not an adt envelope</body></html>"), undefined as never);

    expect((e as AdtErrorException).type).toBe("");
    expect(responseOf(e)).toBeDefined();
  });

  it("the empty-body path sets neither", () => {
    const e = fromException(resp(400, "", "Session timed out"), undefined as never);

    expect((e as AdtErrorException).type).toBe("");
    expect(responseOf(e)).toBeUndefined();
  });

  it("no exception the library builds carries both at once", () => {
    const cases: Array<[string, HttpClientResponse]> = [
      ["envelope 423", resp(423, ENVELOPE)],
      ["envelope 403", resp(403, ENVELOPE.replace("InvalidLockHandle", "NoAccess"))],
      ["parse-throw 423", resp(423, "<html>nope</html>")],
      ["parse-throw 500", resp(500, "plain text dump")],
      ["empty 400", resp(400, "", "Session timed out")],
      ["empty 401", resp(401, "", "Unauthorized")],
    ];

    for (const [label, r] of cases) {
      const e = fromException(r, undefined as never);
      const type = (e as AdtErrorException).type;
      const hasType = typeof type === "string" && type.length > 0;
      const hasResponse = responseOf(e) !== undefined;

      expect(
        hasType && hasResponse,
        `abap-adt-api built an exception (${label}) carrying BOTH .type ("${type}") ` +
          `and .response. The exclusivity assumption no longer holds — the ` +
          `hoisted wire-death check in translateAdtError is now load-bearing on a ` +
          `live path, which is a GOOD thing, but the PR body's reachability claim ` +
          `is now stale and must be corrected. Do not pin the dependency back to ` +
          `keep this green.`,
      ).toBe(false);
    }
  });
});
