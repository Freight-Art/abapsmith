/**
 * `src/adt/transports.ts` — parsing and classification, offline.
 *
 * This is half of that module's test suite (the other half,
 * `test/transports-verify.test.ts`, covers `trRelease`/`trDelete`, the
 * re-read-to-verify operations). Everything here is driven by real wire bytes
 * captured against A4H under `test/fixtures/cts/`, replayed through
 * `fakeCtsConnection` — no network, no live appliance.
 *
 * Scope: `isTrkorr`, `classifyCorrNrError`, `trRequirement`, `trCreate`,
 * `trShow`, `trList`, `trUsers`. `trRelease` and `trDelete` are out of scope.
 */
import { describe, expect, it } from "vitest";

import { AbapError } from "../src/adt/errors.js";
import { SafetyGate } from "../src/safety.js";
import {
  authorizeCeiling,
  classifyCorrNrError,
  isTrkorr,
  trCreate,
  trCreateSearchConfiguration,
  trList,
  trRequirement,
  trSearchConfigurations,
  trShow,
  trUsers,
  type CeilingGate,
} from "../src/adt/transports.js";
import type { LoadedCtsFixture } from "./helpers/cts-fixtures.js";
import { fakeCtsConnection, loadCtsFixture } from "./helpers/cts-fixtures.js";

/**
 * Same trivially-permissive fake gate `test/transports-verify.test.ts` uses
 * for `trDelete`/`trRelease`'s proof requirement — `trCreateSearchConfiguration`
 * takes a `TransportCeilingProof` for the same reason (a compile-time
 * capability token, not something it reads at runtime), and this suite is
 * about wire-byte parsing, not ceiling policy.
 */
const alwaysAllowCeiling: CeilingGate = {
  evaluate: () => ({ allowed: true, reason: "test: always allowed" }),
};
const searchConfigProof = authorizeCeiling(alwaysAllowCeiling, "transport");

/**
 * Mints a fresh `AuthorizedTarget<"transport">` from a fresh, fully-open
 * gate — `trCreate` now requires one. Mirrors the
 * `openGate()`/mint-helper convention in `test/bopf-client.test.ts`.
 */
const authorizeCreate = (devClass: string) =>
  new SafetyGate({ readOnly: false, allowPackages: ["*"] }).authorize(
    "transport",
    { name: devClass, packageName: devClass },
    { corr: { kind: "unresolved" } },
  );

/**
 * Build a synthetic thrown-fixture step: same shape `loadCtsFixture` returns,
 * but for a response with no captured file behind it. `fakeCtsConnection`
 * only inspects `meta.threw` / `meta.status` / `meta.statusText` /
 * `meta.responseHeaders` to decide how to replay a step, so this is enough to
 * exercise the real `fromResponse` throw path without a fixture on disk.
 */
function syntheticThrow(status: number, statusText: string, body: string): LoadedCtsFixture {
  return {
    meta: {
      method: "POST",
      url: "/synthetic",
      qs: null,
      requestHeaders: {},
      requestBody: null,
      status,
      statusText,
      responseHeaders: { "content-type": "application/xml" },
      threw: true,
      bodyFile: "synthetic",
      bodyBytes: Buffer.byteLength(body, "utf8"),
    },
    body,
  };
}

describe("isTrkorr", () => {
  it("accepts the shape this system actually issues", () => {
    expect(isTrkorr("A4HK900121")).toBe(true);
  });

  it("accepts lowercase — isTrkorr uppercases internally before testing the pattern", () => {
    // Contrary to what the doc comment ("matches the shape this system
    // actually issues") might suggest, isTrkorr is lenient about case: it
    // runs `value.trim().toUpperCase()` through TRKORR_RE, so a lowercase
    // number passes here even though the wire never sends one. Every call
    // site inside transports.ts already uppercases before calling isTrkorr,
    // so this never bites internally — but an external caller relying on
    // isTrkorr to reject a case mismatch would be surprised.
    expect(isTrkorr("a4hk900121")).toBe(true);
  });

  it("rejects a number one character short", () => {
    expect(isTrkorr("A4HK90012")).toBe(false);
  });

  it("rejects a number one character long", () => {
    expect(isTrkorr("A4HK9001212")).toBe(false);
  });

  it("rejects a number missing the K", () => {
    expect(isTrkorr("A4HX900121")).toBe(false);
  });

  it("rejects the empty string", () => {
    expect(isTrkorr("")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isTrkorr(undefined)).toBe(false);
    expect(isTrkorr(null)).toBe(false);
    expect(isTrkorr(900121)).toBe(false);
    expect(isTrkorr({ trkorr: "A4HK900121" })).toBe(false);
  });

  it("accepts whitespace-padded input by trimming it first", () => {
    expect(isTrkorr("  A4HK900121  ")).toBe(true);
  });

  it("accepts whitespace-padded lowercase input too, for the same case-normalising reason", () => {
    expect(isTrkorr("  a4hk900121  ")).toBe(true);
  });

  it("still rejects a whitespace-padded value that is wrong regardless of case", () => {
    expect(isTrkorr("  a4hk90012  ")).toBe(false);
  });
});

describe("classifyCorrNrError — the brittle 403 discrimination", () => {
  it("maps the byte-identical 'not-found' 403 to problem: not-found, trkorr extracted", async () => {
    const fixture = loadCtsFixture("create-object-error-corrnr-not-found");
    const { conn } = fakeCtsConnection([fixture]);
    let caught: unknown;
    try {
      await conn.post("/sap/bc/adt/programs/programs", { qs: { corrNr: "A4HK999999" } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    const diagnosis = classifyCorrNrError(caught);
    expect(diagnosis).toEqual({
      problem: "not-found",
      trkorr: "A4HK999999",
      message: "Task/request A4HK999999 does not exist in system A4H",
      exceptionType: "ExceptionResourceNoAuthorization",
    });
  });

  it("maps the byte-identical 'not-a-change-request' 403 to its own problem, not the other one", async () => {
    const fixture = loadCtsFixture("create-object-error-corrnr-not-a-change-request");
    const { conn } = fakeCtsConnection([fixture]);
    let caught: unknown;
    try {
      await conn.post("/sap/bc/adt/programs/programs", { qs: { corrNr: "A4HK900122" } });
    } catch (e) {
      caught = e;
    }
    const diagnosis = classifyCorrNrError(caught);
    expect(diagnosis).toEqual({
      problem: "not-a-change-request",
      trkorr: "A4HK900122",
      message: "Request A4HK900122 is not a change request",
      exceptionType: "ExceptionResourceNoAuthorization",
    });
  });

  it("both known 403s share status, exception type, and empty properties — text is the only discriminator", () => {
    const notFound = loadCtsFixture("create-object-error-corrnr-not-found");
    const notARequest = loadCtsFixture("create-object-error-corrnr-not-a-change-request");
    expect(notFound.meta.status).toBe(403);
    expect(notARequest.meta.status).toBe(403);
    expect(notFound.meta.status).toBe(notARequest.meta.status);
    expect(notFound.body).toContain('<type id="ExceptionResourceNoAuthorization"/>');
    expect(notARequest.body).toContain('<type id="ExceptionResourceNoAuthorization"/>');
    // And that type name is actively misleading: neither failure is about
    // authorisation at all, which is exactly why classification cannot key on it.
  });

  it("a third 403 matching neither known message degrades to problem: unknown with the verbatim message preserved, never guessed into a known bucket", async () => {
    const body =
      '<?xml version="1.0" encoding="utf-8"?><exc:exception ' +
      'xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">' +
      '<namespace id="com.sap.adt"/><type id="ExceptionResourceNoAuthorization"/>' +
      '<message lang="EN">Request A4HK900199 is locked by another user</message>' +
      '<localizedMessage lang="EN">Request A4HK900199 is locked by another user</localizedMessage>' +
      "<properties/></exc:exception>";
    const { conn } = fakeCtsConnection([syntheticThrow(403, "Forbidden", body)]);
    let caught: unknown;
    try {
      await conn.post("/sap/bc/adt/programs/programs", { qs: { corrNr: "A4HK900199" } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    const diagnosis = classifyCorrNrError(caught);
    expect(diagnosis).toEqual({
      problem: "unknown",
      message: "Request A4HK900199 is locked by another user",
      exceptionType: "ExceptionResourceNoAuthorization",
    });
    // Never forced into one of the two known buckets:
    expect(diagnosis?.problem).not.toBe("not-found");
    expect(diagnosis?.problem).not.toBe("not-a-change-request");
    expect(diagnosis?.trkorr).toBeUndefined();
  });

  it("a non-403 failure returns undefined rather than a diagnosis", async () => {
    const fixture = loadCtsFixture("transport-details-nonexistent-error");
    const { conn } = fakeCtsConnection([fixture]);
    let caught: unknown;
    try {
      await conn.get("/sap/bc/adt/cts/transportrequests/A4HK900119");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(classifyCorrNrError(caught)).toBeUndefined();
  });

  it("returns undefined for a value that is not a thrown ADT exception at all", () => {
    expect(classifyCorrNrError(new Error("plain error"))).toBeUndefined();
    expect(classifyCorrNrError(undefined)).toBeUndefined();
  });
});

describe("trRequirement — the RESULT trap", () => {
  it("RESULT is identical ('S') across the $TMP fixture and the transportable-package fixture — no branch may key on it", () => {
    // This is the whole point of trRequirement's design: RESULT alone cannot
    // distinguish "no transport needed" from "transport needed". Both wire
    // captures below say RESULT=S; only KORRFLAG (and, for the fabrication
    // trap, RECORDING) tell the two cases apart. If this assertion ever
    // fails, some fixture was recaptured with a different RESULT and the
    // regression this test exists to catch has changed shape.
    const tmp = loadCtsFixture("transport-info-tmp");
    const transportable = loadCtsFixture("transport-info-transportable");
    expect(tmp.body).toContain("<RESULT>S</RESULT>");
    expect(transportable.body).toContain("<RESULT>S</RESULT>");
  });

  it("$TMP (KORRFLAG empty) classifies as kind: local, no corrNr required, nothing fabricated", async () => {
    const fixture = loadCtsFixture("transport-info-tmp");
    const { conn, calls } = fakeCtsConnection([fixture]);
    const req = await trRequirement(conn, "/sap/bc/adt/programs/programs/zmcp_dbg_demo", "$TMP");

    expect(req.kind).toBe("local");
    expect(req.mustSupplyCorrNr).toBe(false);
    expect(req.serverWouldFabricate).toBe(false);
    expect(req.raw).toEqual({ result: "S", korrflag: "", recording: "" });
    expect(req.checkFailed).toBe(false);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/sap/bc/adt/cts/transportchecks");
  });

  it("a transportable package with RECORDING=X classifies as kind: transport-auto-created — this is the live-observed fixture, not a synthetic one", async () => {
    // Captured live: KORRFLAG=X and RECORDING=X together. This is the
    // dangerous case the whole module exists to catch — omitting corrNr does
    // NOT fail, the server silently mints a request (observed live as
    // A4HK900117, "Generated Request for Change Recording").
    const fixture = loadCtsFixture("transport-info-transportable");
    expect(fixture.body).toContain("<KORRFLAG>X</KORRFLAG>");
    expect(fixture.body).toContain("<RECORDING>X</RECORDING>");

    const { conn } = fakeCtsConnection([fixture]);
    const req = await trRequirement(
      conn,
      "/sap/bc/adt/programs/programs/zmcp_cts_probe",
      "Z_FLIGHT_ADDITIONAL",
    );

    expect(req.kind).toBe("transport-auto-created");
    expect(req.mustSupplyCorrNr).toBe(true);
    expect(req.serverWouldFabricate).toBe(true);
    expect(req.raw).toEqual({ result: "S", korrflag: "X", recording: "X" });
    // The dangerous state must be visible to callers, not just implied by kind:
    expect(req).toMatchObject({ serverWouldFabricate: true });
  });

  it("a transportable package with RECORDING empty classifies as kind: transport-required — synthetic, no fixture captures this branch", async () => {
    // No captured fixture has KORRFLAG=X with RECORDING NOT X: on this system,
    // both live pre-flight checks against transportable packages happened to
    // return RECORDING=X. So this branch of the three-way union is exercised
    // with a hand-built response, structurally identical to the real
    // transport-info-transportable capture except for RECORDING and REQUESTS.
    const body =
      '<?xml version="1.0" encoding="utf-8"?><asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml">' +
      "<asx:values><DATA><PGMID>LIMU</PGMID><OBJECT>REPS</OBJECT><OBJECTNAME>ZMCP_SYNTH</OBJECTNAME>" +
      "<OPERATION>I</OPERATION><DEVCLASS>ZSYNTH</DEVCLASS><CTEXT>Synthetic package</CTEXT>" +
      "<KORRFLAG>X</KORRFLAG><AS4USER/><PDEVCLASS/><DLVUNIT>LOCAL</DLVUNIT><NAMESPACE>/synth/</NAMESPACE>" +
      "<RESULT>S</RESULT><RECORDING/><EXISTING_REQ_ONLY/><MESSAGES/><REQUESTS/><LOCKS/>" +
      "<TADIRDEVC>ZSYNTH</TADIRDEVC><URI>/sap/bc/adt/programs/programs/zmcp_synth</URI><CTS_PROJECTS/>" +
      "</DATA></asx:values></asx:abap>";
    const { conn } = fakeCtsConnection([
      { status: 200, body, headers: { "content-type": "application/vnd.sap.as+xml" } },
    ]);
    const req = await trRequirement(conn, "/sap/bc/adt/programs/programs/zmcp_synth", "ZSYNTH");

    expect(req.kind).toBe("transport-required");
    expect(req.mustSupplyCorrNr).toBe(true);
    expect(req.serverWouldFabricate).toBe(false);
    expect(req.raw).toEqual({ result: "S", korrflag: "X", recording: "" });
  });

  it("an object already locked in another request reports its identity and the lock holder", async () => {
    const fixture = loadCtsFixture("transport-info-object-already-in-request");
    const { conn } = fakeCtsConnection([fixture]);
    const req = await trRequirement(
      conn,
      "/sap/bc/adt/programs/programs/zmcp_cts_probe",
      "Z_FLIGHT_ADDITIONAL",
    );

    expect(req.pgmid).toBe("LIMU");
    expect(req.objectType).toBe("REPS");
    expect(req.objectName).toBe("ZMCP_CTS_PROBE");
    expect(req.devclass).toBe("Z_FLIGHT_ADDITIONAL");
    expect(req.tadirDevclass).toBe("Z_FLIGHT_ADDITIONAL");

    expect(req.locks).toHaveLength(1);
    const [lock] = req.locks;
    expect(lock.object).toEqual({ pgmid: "LIMU", type: "REPS", name: "ZMCP_CTS_PROBE" });
    expect(lock.request.trkorr).toBe("A4HK900117");
    expect(lock.request.owner).toBe("DEVELOPER");
    expect(lock.request.kind).toBe("workbench");
    expect(lock.tasks).toHaveLength(1);
    expect(lock.tasks[0].trkorr).toBe("A4HK900118");
    expect(lock.tasks[0].owner).toBe("DEVELOPER");
    expect(lock.tasks[0].kind).toBe("task");

    // pinnedTo/pinnedOwner surface the lock's own request without a caller
    // having to dig into `locks[0]` themselves.
    expect(req.pinnedTo).toBe("A4HK900117");
    expect(req.pinnedOwner).toBe("DEVELOPER");
  });

  it("RESULT=E surfaces as checkFailed regardless of KORRFLAG, orthogonally to kind", async () => {
    const body =
      '<?xml version="1.0" encoding="utf-8"?><asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml">' +
      "<asx:values><DATA><RESULT>E</RESULT><KORRFLAG/><RECORDING/>" +
      "<MESSAGES><CTS_MESSAGE><SEVERITY>E</SEVERITY><ARBGB>TO</ARBGB><MSGNR>140</MSGNR>" +
      "<TEXT>Package check failed</TEXT></CTS_MESSAGE></MESSAGES><REQUESTS/><LOCKS/>" +
      "<URI>/sap/bc/adt/programs/programs/zmcp_bad</URI></DATA></asx:values></asx:abap>";
    const { conn } = fakeCtsConnection([{ status: 200, body }]);
    const req = await trRequirement(conn, "/sap/bc/adt/programs/programs/zmcp_bad", "$TMP");

    expect(req.checkFailed).toBe(true);
    expect(req.kind).toBe("local");
    expect(req.messages).toEqual([
      { severity: "E", messageClass: "TO", messageNumber: "140", text: "Package check failed", variables: [] },
    ]);
  });

  // No-trkorr branch: `trRequirement` calls `ctsError(e,
  // "trRequirement")` with NO trkorr (unlike trShow/trAddUser/trSetOwner/
  // trDelete/trRelease, which all pass one), so the fallback hint cannot name
  // a specific request and must fall back to the generic `operation "list"`
  // verb instead of `"show"` + a number it does not have.
  it("the unclassified TRANSPORT_ERROR fallback falls back to abap_transport operation \"list\" when no trkorr is known", async () => {
    const { conn } = fakeCtsConnection([
      syntheticThrow(
        500,
        "Internal Server Error",
        `<?xml version="1.0" encoding="utf-8"?><exc:exception ` +
          `xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
          `<namespace id="com.sap.adt.tm"/><type id="ADT_TM_COMMON_EXCEPTION"/>` +
          `<message lang="EN">Internal error during transport check</message>` +
          `<localizedMessage lang="EN">Internal error during transport check</localizedMessage>` +
          `<properties/></exc:exception>`,
      ),
    ]);
    let caught: unknown;
    try {
      await trRequirement(conn, "/sap/bc/adt/programs/programs/zmcp_synth", "ZSYNTH");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AbapError);
    const err = caught as AbapError;
    expect(err.code).toBe("TRANSPORT_ERROR");
    expect(err.hint).toBeTruthy();
    expect(err.hint).toMatch(/abap_transport/);
    expect(err.hint).toMatch(/operation "list"/);
    expect(err.hint).not.toMatch(/operation "show"/);
    expect(err.hint).not.toMatch(/\baction\b/);
    expect(err.hint).toMatch(/do not retry/i);
  });

  // `trRequirement` runs unconditionally on every write, and
  // before this fix its classifier (`ctsError`) never checked for session
  // death — a dead session hitting this pre-flight check fell all the way
  // through to the SAME generic `TRANSPORT_ERROR` fallback proven above,
  // indistinguishable from an unrelated CTS hiccup and invisible to
  // `pool.ts`'s `isSessionDeadError`, so the bounded dead-slot replay never
  // engaged for this path. Live-confirmed against A4H:
  // the raw failure `trRequirement` actually throws on a dead session is a
  // `400` whose message matches `SESSION_GONE_MARKERS`. Built as a real
  // `<exc:exception>` envelope (like the fallback fixture above), NOT a bare
  // text body — `fromResponse` (`abap-adt-api`) requires that shape to parse
  // at all; a plain-text 400 body throws inside the vendor parser itself
  // before ever reaching `ctsError`, which would silently prove nothing.
  it("a 400 'Session Timed Out' envelope is SESSION_DEAD, not the generic TRANSPORT_ERROR fallback", async () => {
    const body =
      '<?xml version="1.0" encoding="utf-8"?><exc:exception ' +
      'xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">' +
      '<namespace id="com.sap.adt.tm"/><type id="ADT_TM_COMMON_EXCEPTION"/>' +
      '<message lang="EN">Session Timed Out - Session no longer exists</message>' +
      '<localizedMessage lang="EN">Session Timed Out - Session no longer exists</localizedMessage>' +
      "<properties/></exc:exception>";
    const { conn } = fakeCtsConnection([syntheticThrow(400, "Session Timed Out", body)]);
    let caught: unknown;
    try {
      await trRequirement(conn, "/sap/bc/adt/programs/programs/zmcp_synth", "ZSYNTH");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AbapError);
    const err = caught as AbapError;
    expect(err.code).toBe("SESSION_DEAD");
  });
});

describe("trCreate — parses a bare relative path, not a URL", () => {
  const input = {
    objSourceUrl: "/sap/bc/adt/programs/programs/zmcp_cts_probe",
    description: "abapsmith CTS recon throwaway B",
    devClass: "Z_FLIGHT_ADDITIONAL",
  };
  const authorized = authorizeCreate(input.devClass);

  it("extracts the trkorr from the captured 200/text-plain/37-byte response and preserves the raw path", async () => {
    const fixture = loadCtsFixture("create-transport-response");
    expect(fixture.meta.status).toBe(200);
    expect(fixture.meta.bodyBytes).toBe(37);
    expect(fixture.body).toBe("/com.sap.cts/object_record/A4HK900121");

    const { conn, calls } = fakeCtsConnection([fixture]);
    const created = await trCreate(conn, input, authorized);

    expect(created).toEqual({ trkorr: "A4HK900121", path: "/com.sap.cts/object_record/A4HK900121" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/sap/bc/adt/cts/transports");
  });

  it("a trailing newline is trimmed away, not left dangling in the parsed path", async () => {
    // Not a failure case: `raw.trim()` runs before the path is split, so a
    // trailing newline is absorbed and the trkorr comes out identical to the
    // no-newline capture above — never a garbage value, never a throw.
    const { conn } = fakeCtsConnection([
      { status: 200, body: "/com.sap.cts/object_record/A4HK900121\n" },
    ]);
    const created = await trCreate(conn, input, authorized);
    expect(created).toEqual({ trkorr: "A4HK900121", path: "/com.sap.cts/object_record/A4HK900121" });
  });

  it("a trailing slash leaves an empty last segment and fails cleanly, never a garbage trkorr", async () => {
    const { conn } = fakeCtsConnection([
      { status: 200, body: "/com.sap.cts/object_record/A4HK900121/" },
    ]);
    let caught: unknown;
    try {
      await trCreate(conn, input, authorized);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AbapError);
    expect((caught as AbapError).code).toBe("TRANSPORT_ERROR");
  });

  it("an empty body fails cleanly", async () => {
    const { conn } = fakeCtsConnection([{ status: 200, body: "" }]);
    await expect(trCreate(conn, input, authorized)).rejects.toMatchObject({ code: "TRANSPORT_ERROR" });
  });

  it("a body that is not a path at all fails cleanly", async () => {
    const { conn } = fakeCtsConnection([{ status: 200, body: "Internal Server Error" }]);
    await expect(trCreate(conn, input, authorized)).rejects.toMatchObject({ code: "TRANSPORT_ERROR" });
  });

  it("a path whose last segment fails isTrkorr fails cleanly", async () => {
    const { conn } = fakeCtsConnection([
      { status: 200, body: "/com.sap.cts/object_record/NOT_A_NUMBER" },
    ]);
    await expect(trCreate(conn, input, authorized)).rejects.toMatchObject({ code: "TRANSPORT_ERROR" });
  });
});

describe("trShow — namespace stripping, task/object extraction, status/kind normalisation", () => {
  it("strips tm:/asx: prefixes and extracts a request with its task and its object", async () => {
    const fixture = loadCtsFixture("transport-details-with-objects");
    const { conn, calls } = fakeCtsConnection([fixture]);

    const request = await trShow(conn, "A4HK900117");

    // The GET went to the plain CTS path, keyed by trkorr — no tm:/asx: left
    // over anywhere in what the caller sees, because that is namespace noise
    // from the wire, not part of the value.
    expect(calls).toEqual([
      {
        method: "GET",
        url: "/sap/bc/adt/cts/transportrequests/A4HK900117",
        qs: undefined,
        body: undefined,
        headers: { Accept: "application/vnd.sap.adt.transportorganizer.v1+xml" },
      },
    ]);

    expect(request.trkorr).toBe("A4HK900117");
    expect(request.kind).toBe("workbench");
    expect(request.kindRaw).toBe("K");
    expect(request.status).toBe("modifiable");
    expect(request.statusRaw).toBe("D");
    expect(request.owner).toBe("DEVELOPER");
    // A4H has no transport route: target is always the empty string, never
    // undefined and never a throw.
    expect(request.target).toBe("");

    expect(request.tasks).toHaveLength(1);
    const [task] = request.tasks;
    expect(task.trkorr).toBe("A4HK900118");
    // Details responses spell the task type out ("Development/Correction")
    // rather than using the one-letter transportchecks code — toKind's regex
    // fallback is what recognises this as a task.
    expect(task.kindRaw).toBe("Development/Correction");
    expect(task.kind).toBe("task");

    // The request's only object lives under tm:all_objects; the task carries
    // the same object directly (no all_objects wrapper on a task).
    expect(request.objects).toHaveLength(1);
    expect(request.objects[0]).toMatchObject({
      pgmid: "R3TR",
      type: "PROG",
      name: "ZMCP_CTS_PROBE",
      wbType: "PROG/P",
      locked: true, // tm:lock_status="X"
    });
    expect(task.objects).toHaveLength(1);
    expect(task.objects[0]).toMatchObject({ name: "ZMCP_CTS_PROBE", locked: true });
  });

  it("a request with no recorded objects parses to an empty objects array, not a throw", async () => {
    const fixture = loadCtsFixture("transport-details-empty-request");
    const { conn } = fakeCtsConnection([fixture]);

    const request = await trShow(conn, "A4HK900121");

    expect(request.trkorr).toBe("A4HK900121");
    expect(request.objects).toEqual([]);
    expect(request.tasks).toHaveLength(1);
    const [task] = request.tasks;
    expect(task.trkorr).toBe("A4HK900122");
    expect(task.objects).toEqual([]);

    // Wire fact: this task's tm:type is "Unclassified", an exact wire token
    // that toKind now recognises directly rather than only via its
    // /task|correction|repair/i fallback regex — it is structurally a task
    // (tm:parent is set to the request) even though it names no specific task
    // category. kindRaw keeps the verbatim wire value regardless.
    expect(task.kindRaw).toBe("Unclassified");
    expect(task.kind).toBe("task");
  });

  it("a released request keeps statusRaw/kindRaw at the wire values under the normalised status/kind", async () => {
    const fixture = loadCtsFixture("transport-details-released");
    const { conn } = fakeCtsConnection([fixture]);

    const request = await trShow(conn, "A4HK900125");

    expect(request.trkorr).toBe("A4HK900125");
    expect(request.status).toBe("released");
    expect(request.statusRaw).toBe("R");
    expect(request.statusText).toBe("Released");
    expect(request.tasks).toHaveLength(1);
    expect(request.tasks[0].status).toBe("released");
    expect(request.tasks[0].statusRaw).toBe("R");

    // Wire fact: this capture lists the same ZMCP_CTS_REL2 object BOTH
    // directly under tm:request (alongside a CORR/RELE "Comment Entry:
    // Released" pseudo-object) AND wrapped in tm:all_objects. objectsOf() now
    // de-duplicates by pgmid+type+name, so a released request that carries
    // both shapes at once yields exactly the two distinct entries a caller
    // would expect — the real object once, and the pseudo-object, which is
    // genuinely distinct (it never appears in tm:all_objects) and survives.
    expect(request.objects).toHaveLength(2);
    const realObjectCount = request.objects.filter((o) => o.name === "ZMCP_CTS_REL2").length;
    expect(realObjectCount).toBe(1); // no longer duplicated
    expect(request.objects.some((o) => o.type === "RELE")).toBe(true);
  });

  it("raises TRANSPORT_GONE for a 400 ADT_TM_COMMON_EXCEPTION 'does not exist' response", async () => {
    const fixture = loadCtsFixture("transport-details-nonexistent-error");
    expect(fixture.meta.status).toBe(400);
    expect(fixture.meta.threw).toBe(true);
    // This fixture's meta omits errorName/errorMessage even though threw is
    // true — the loader's own doc warns not to assume they always accompany
    // a throw, so this assertion is the regression guard for that.
    expect(fixture.meta.errorName).toBeUndefined();
    expect(fixture.meta.errorMessage).toBeUndefined();

    const { conn } = fakeCtsConnection([fixture]);
    let caught: unknown;
    try {
      await trShow(conn, "A4HK900119");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AbapError);
    expect((caught as AbapError).code).toBe("TRANSPORT_GONE");
    // An earlier fix wrongly assumed TRANSPORT_GONE already had a
    // hint ("`ctsError` gives `TRANSPORT_GONE` and `TRANSPORT_LOCKED`
    // proper hints"); it did not. This is the regression guard.
    const hint = (caught as AbapError).hint;
    expect(hint).toBeTruthy();
    expect(hint).toMatch(/does not recognise this transport\/task number/i);
    // Honest about cause: isGone only proves "unknown to the system", never
    // WHY — released, deleted, or a typo are all the same shape — so the
    // hint must not claim a specific cause with certainty.
    expect(hint).toMatch(/usually/i);
    expect(hint).toMatch(/operation "list"/);
    expect(hint).toMatch(/not evidence of a system problem/i);
  });

  // -------------------------------------------------------------------------
  // The ctsError() fallback (unclassified CTS response) must
  // carry a hint, and the hint must point to a real abap_transport parameter.
  // -------------------------------------------------------------------------
  //
  // "Request A4HK900122 is not a change request" matches neither `isGone`
  // (no "does not exist in system") nor "contains locked objects", so it
  // falls all the way through `ctsError` to the generic `TRANSPORT_ERROR`
  // branch — this is the same live incident shape referenced in the doc
  // comment above `ctsError` (`TRANSPORT_ERROR: "Request failed with status
  // code 400"` reaching a caller with `details.operation: "trRequirement"`
  // and nothing else to act on).
  it("the unclassified TRANSPORT_ERROR fallback carries a hint naming the adt envelope and a real abap_transport call (trkorr known)", async () => {
    const { conn } = fakeCtsConnection([
      syntheticThrow(
        400,
        "Bad Request",
        `<?xml version="1.0" encoding="utf-8"?><exc:exception ` +
          `xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
          `<namespace id="com.sap.adt.tm"/><type id="ADT_TM_COMMON_EXCEPTION"/>` +
          `<message lang="EN">Request A4HK900122 is not a change request</message>` +
          `<localizedMessage lang="EN">Request A4HK900122 is not a change request</localizedMessage>` +
          `<properties/></exc:exception>`,
      ),
    ]);
    let caught: unknown;
    try {
      await trShow(conn, "A4HK900122");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AbapError);
    const err = caught as AbapError;
    expect(err.code).toBe("TRANSPORT_ERROR");
    expect(err.hint).toBeTruthy();
    expect(err.hint).toMatch(/adt\.localizedMessage/);
    expect(err.hint).toMatch(/adt\.t100/);
    // The real parameter name is `operation`, never `action` —
    // a hint that names a non-existent parameter sends the caller straight
    // into a BAD_INPUT.
    expect(err.hint).toMatch(/abap_transport/);
    expect(err.hint).toMatch(/operation "show"/);
    expect(err.hint).not.toMatch(/\baction\b/);
    // trkorr was known on this call (trShow passes it through), so the hint
    // names it rather than falling back to the generic "list" verb.
    expect(err.hint).toMatch(/A4HK900122/);
    expect(err.hint).toMatch(/do not retry/i);
    // Must not be confused for the sibling codes' own hints.
    expect(err.hint).not.toMatch(/locked objects/i);
  });

  describe("a task GET's sibling <tm:task> is merged in, not dropped (D-23 parser fix)", () => {
    it("the fixture really is a sibling shape, not the nested shape every other capture uses", () => {
      const fixture = loadCtsFixture("transport-details-task-resolves-to-parent");
      // <tm:task> closes </tm:request> and opens immediately after it, as a
      // sibling directly under <tm:root> — never nested inside <tm:request>.
      expect(fixture.body).toContain('<tm:request tm:number="A4HK900131"');
      expect(fixture.body).toContain('</tm:request><tm:task tm:number="A4HK900132"');
      expect(fixture.body).not.toMatch(/<tm:request[^>]*>[\s\S]*<tm:task tm:number="A4HK900132"[\s\S]*<\/tm:task>[\s\S]*<\/tm:request>/);
    });

    it("trShow(task) returns the PARENT as the top-level TrRequest, with the named task recovered into .tasks", async () => {
      const fixture = loadCtsFixture("transport-details-task-resolves-to-parent");
      const { conn } = fakeCtsConnection([fixture]);

      const request = await trShow(conn, "A4HK900132");

      // Substitution is unchanged: the top-level answer is still the parent.
      expect(request.trkorr).toBe("A4HK900131");
      expect(request.status).toBe("modifiable");

      // The fix: the named task is no longer silently dropped.
      expect(request.tasks).toHaveLength(1);
      const [task] = request.tasks;
      expect(task.trkorr).toBe("A4HK900132");
      expect(task.parent).toBe("A4HK900131");
      // Wire fact: the task is already Released while its parent is still
      // Modifiable — this is what makes the sibling fixture a genuine,
      // non-synthetic case where "the parent's status" and "the task's own
      // status" provably disagree.
      expect(task.status).toBe("released");
      expect(task.statusRaw).toBe("R");
      expect(task.statusText).toBe("Released");
      expect(task.owner).toBe("DEVELOPER");
      expect(task.kind).toBe("task");
      expect(task.kindRaw).toBe("Development/Correction");

      // The task carries its own object directly (no all_objects wrapper on
      // a task, same as the nested shape).
      expect(task.objects).toHaveLength(1);
      expect(task.objects[0]).toMatchObject({
        pgmid: "R3TR",
        type: "PROG",
        name: "ZMCP_TR_LIVE1",
        wbType: "PROG/P",
        locked: false, // tm:lock_status=""
      });

      // The parent's own objects are untouched by the merge: this fixture's
      // <tm:request> carries none of its own.
      expect(request.objects).toEqual([]);
    });

    it("trShow(parent) on the SAME fixture returns identically — the merge is keyed off the response shape, not the number asked", async () => {
      // Regression guard: GETting the parent number replays the identical
      // wire bytes (CTS answers the same way regardless of which of the two
      // numbers in the pair was asked), so the merge must produce the same
      // result no matter which trkorr triggered the call.
      const fixture = loadCtsFixture("transport-details-task-resolves-to-parent");
      const { conn } = fakeCtsConnection([fixture]);

      const request = await trShow(conn, "A4HK900131");

      expect(request.trkorr).toBe("A4HK900131");
      expect(request.tasks).toHaveLength(1);
      expect(request.tasks[0].trkorr).toBe("A4HK900132");
      expect(request.tasks[0].status).toBe("released");
    });

    it("the nested-shape fixtures are unaffected: no root-level sibling <tm:task> exists to merge", () => {
      // Confirms the merge in trShow cannot fire (and cannot double-count)
      // for any of the request-GET fixtures already covered above — none of
      // them has <tm:task> as a direct child of <tm:root>.
      for (const name of [
        "transport-details-with-objects",
        "transport-details-empty-request",
        "transport-details-released",
      ]) {
        const fixture = loadCtsFixture(name);
        // A root-level sibling task would immediately follow the closing
        // </tm:request> tag, exactly as in the sibling fixture above. None
        // of these do: their <tm:task> elements are nested strictly inside
        // <tm:request>...</tm:request>.
        expect(fixture.body).not.toMatch(/<\/tm:request>\s*<tm:task/);
      }
    });
  });
});

describe("trList — tree flattening into { workbench, customizing }", () => {
  it("flattens a nested workbench/modifiable tree, request headers and their tasks intact", async () => {
    const fixture = loadCtsFixture("transports-by-config");
    const { conn, calls } = fakeCtsConnection([fixture]);

    const list = await trList(conn, {
      configUri: "/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations/1A2263E0A4E31FE1A3B6BDE618A5D650",
    });

    expect(calls[0].url).toBe("/sap/bc/adt/cts/transportrequests");
    expect(calls[0].qs).toEqual({
      configUri: "/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations/1A2263E0A4E31FE1A3B6BDE618A5D650",
      targets: "false",
    });

    // The customizing branch never appeared in this system; collectRequests
    // must return an empty array for it rather than throwing on the missing node.
    expect(list.customizing).toEqual([]);
    const trkorrs = list.workbench.map((r) => r.trkorr).sort();
    // A4HK900044 lives in this capture under a third top-level category —
    // tm:transportofcopies (tm:type="T", "Transport of Copies") — which
    // trList now visits generically along with every other direct child of
    // <tm:root>, rather than only root>workbench and root>customizing. Since
    // TrList's shape is frozen at { workbench, customizing }, a category that
    // is neither is appended to workbench; it stays identifiable via its own
    // kind, not via which array it landed in (see the assertion below).
    expect(trkorrs).toEqual([
      "A4HK900044",
      "A4HK900111",
      "A4HK900117",
      "A4HK900121",
      "A4HK900125",
    ]);
    const transportOfCopies = list.workbench.find((r) => r.trkorr === "A4HK900044");
    expect(transportOfCopies).toBeDefined();
    // Reachable from trList's output, and still correctly self-classified as
    // transport-of-copies even though it landed in the `workbench` array.
    expect(transportOfCopies?.kind).toBe("transport-of-copies");
    expect(transportOfCopies?.kindRaw).toBe("T");
    // The tm:modifiable/tm:released status-group nesting is flattened away —
    // each request's own status header is what survives, not a grouping key.
    for (const r of list.workbench) {
      expect(r.status).not.toBe("");
    }
  });

  it("defaults targets to false and reads a user's requests, released ones included", async () => {
    const fixture = loadCtsFixture("user-transports-targets-false");
    const { conn, calls } = fakeCtsConnection([fixture]);

    const list = await trList(conn, { user: "DEVELOPER" });

    expect(calls[0].qs).toEqual({ user: "DEVELOPER", targets: "false" });
    expect(list.customizing).toEqual([]);
    const trkorrs = list.workbench.map((r) => r.trkorr).sort();
    expect(trkorrs).toEqual(["A4HK900121", "A4HK900125"]);
    expect(list.workbench.every((r) => r.status === "released")).toBe(true);
  });

  it("a completely empty <tm:root/> (no workbench, no customizing) parses to two empty arrays, not a throw", async () => {
    // A4H's target value-help returns totalItemCount 0 and this is the
    // targets=true analogue at the tree level: the root element carries no
    // children at all. collectRequests(undefined) must degrade to [] cleanly.
    const fixture = loadCtsFixture("user-transports-targets-true-empty");
    const { conn } = fakeCtsConnection([fixture]);

    const list = await trList(conn, { user: "DEVELOPER", targets: true });

    expect(list).toEqual({ workbench: [], customizing: [] });
  });
});

describe("trSearchConfigurations / trCreateSearchConfiguration", () => {
  it("an empty <configurations:configurations/> parses to no entries", async () => {
    const fixture = loadCtsFixture("transport-search-configurations-empty");
    const { conn, calls } = fakeCtsConnection([fixture]);

    const configs = await trSearchConfigurations(conn);

    expect(configs).toEqual([]);
    expect(calls[0]).toMatchObject({
      method: "GET",
      url: "/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations",
    });
  });

  it("a single real <configuration:configuration> is found by its atom:link[type=CONFIGURATION_TYPE], wrapper tag name irrelevant", async () => {
    // This fixture is the real captured POST-create response body — a bare
    // `<configuration:configuration>` with no plural wrapper at all. Feeding
    // it to trSearchConfigurations (rather than trCreateSearchConfiguration)
    // exercises the fact that `walkForConfigEntries` finds a configuration
    // entry by its link's `type` attribute, not by a hardcoded wrapper tag —
    // so it tolerates either this singular create-response shape or the true
    // plural-list wrapper (see the next test). Note this fixture's link
    // carries `rel="self"`; the plural list fixture below does NOT (it
    // carries `rel="http://www.sap.com/adt/categories/configurations")` —
    // confirmed live against A4H 2026-08-07. `rel` is
    // therefore not part of the match at all; only `type` is.
    const fixture = loadCtsFixture("transport-search-configuration-created");
    const { conn } = fakeCtsConnection([fixture]);

    const configs = await trSearchConfigurations(conn);

    expect(configs).toEqual([
      {
        uri: "/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations/1A2263E0A4E31FE1A3B6BDE618A5D650",
        user: "DEVELOPER",
      },
    ]);
  });

  it("a real plural list with two entries (live A4H capture) parses both, via rel=categories/configurations not rel=self", async () => {
    // Captured live 2026-08-07 while two genuine search-configuration objects
    // existed on A4H (residue from earlier live verification). This
    // is the shape that exposed the original bug: each entry's atom:link
    // carries rel="http://www.sap.com/adt/categories/configurations", never
    // rel="self" — matching on rel="self" alone found zero entries here,
    // which meant "list" could never discover and reuse an existing
    // configuration live, only ever create new ones.
    const fixture = loadCtsFixture("transport-search-configurations-list");
    const { conn } = fakeCtsConnection([fixture]);

    const configs = await trSearchConfigurations(conn);

    expect(configs).toEqual([
      {
        uri: "/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations/1A2263E0A4E31FE1A4D49AA2214E3650",
        user: undefined,
      },
      {
        uri: "/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations/1A2263E0A4E31FE1A4D48D46CDD6F650",
        user: undefined,
      },
    ]);
  });

  it("trCreateSearchConfiguration reads the configUri off the Location header, not the body", async () => {
    const fixture = loadCtsFixture("transport-search-configuration-created");
    const { conn, calls } = fakeCtsConnection([fixture]);

    const created = await trCreateSearchConfiguration(conn, searchConfigProof);

    expect(created).toEqual({
      uri: "/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations/1A2263E0A4E31FE1A3B6BDE618A5D650",
    });
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations",
    });
  });

  it("trCreateSearchConfiguration falls back to parsing the body when there is no Location header", async () => {
    const step = {
      status: 201,
      body:
        '<?xml version="1.0" encoding="utf-8"?><configuration:configuration ' +
        'xmlns:configuration="http://www.sap.com/adt/configuration">' +
        '<configuration:properties><configuration:property key="User">DEVELOPER</configuration:property>' +
        "</configuration:properties>" +
        '<atom:link href="/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations/NOLOCHDR" ' +
        'rel="self" type="application/vnd.sap.adt.configuration.v1+xml" xmlns:atom="http://www.w3.org/2005/Atom"/></configuration:configuration>',
      headers: {},
    };
    const { conn } = fakeCtsConnection([step]);

    const created = await trCreateSearchConfiguration(conn, searchConfigProof);

    expect(created).toEqual({
      uri: "/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations/NOLOCHDR",
      user: "DEVELOPER",
    });
  });

  it("trCreateSearchConfiguration throws a clear error when neither a Location header nor a parseable body is present", async () => {
    const step = { status: 201, body: "", headers: {} };
    const { conn } = fakeCtsConnection([step]);

    await expect(trCreateSearchConfiguration(conn, searchConfigProof)).rejects.toThrow(
      /neither a Location header nor a parseable body/,
    );
  });
});

describe("transport-targets-valuehelp-empty — a captured fixture with no current consumer", () => {
  // No export in `src/adt/transports.ts` calls the target valuehelp endpoint
  // (`/sap/bc/adt/cts/transportrequests/valuehelp/target`) — grepping the
  // module for "valuehelp" finds nothing. This fixture is kept because it is
  // the direct evidence for the doc comment above trList(): A4H has no
  // transport route configured, so asking the server what targets exist
  // returns zero results rather than erroring. Asserted here against the raw
  // fixture body/meta only, not through a transports.ts function, since none
  // exists to route it through without editing that file.
  it("documents that A4H's target valuehelp returns totalItemCount 0, not an error", () => {
    const fixture = loadCtsFixture("transport-targets-valuehelp-empty");
    expect(fixture.meta.status).toBe(200);
    expect(fixture.meta.url).toBe("/sap/bc/adt/cts/transportrequests/valuehelp/target");
    expect(fixture.body).toContain("<nameditem:totalItemCount>0</nameditem:totalItemCount>");
  });
});

describe("trUsers — atom feed entries, ids filtered for emptiness", () => {
  it("parses every entry's id/title, in feed order", async () => {
    const fixture = loadCtsFixture("system-users");
    const { conn, calls } = fakeCtsConnection([fixture]);

    const users = await trUsers(conn);

    expect(calls).toEqual([
      {
        method: "GET",
        url: "/sap/bc/adt/system/users",
        qs: undefined,
        body: undefined,
        headers: { Accept: "application/atom+xml;type=feed" },
      },
    ]);

    expect(users).toEqual([
      { id: "BWDEVELOPER", title: "Doe Jane" },
      { id: "DDIC", title: "DDIC" },
      { id: "DEVELOPER", title: "John Doe" },
      { id: "USER1", title: "Doe Jane" },
      { id: "USER2", title: "Doe Jane" },
      { id: "SAP*", title: "SAP*" },
      { id: "SDMI_DLRYYAU", title: "SDMI_DLRYYAU" },
    ]);
  });
});

describe("no in-scope call ever targets a release link", () => {
  // relwithignlock / relobjigchkatc are release-with-overrides endpoints that
  // belong to trRelease (out of scope for this file, owned by
  // test/transports-verify.test.ts). Several fixtures used above advertise
  // those links in atom:link elements of the response bodies they parse —
  // the risk this guards is a future edit to trShow/trList/trCreate/
  // trRequirement/trUsers accidentally following one of those hrefs instead
  // of treating them as inert metadata.
  it("every recorded call in this file targets a plain cts path, never relwithignlock or relobjigchkatc", async () => {
    // First confirm the temptation is real: this response body advertises
    // both release-override links, so a naive "grab any href from the
    // response and re-request it" implementation would have somewhere to go
    // wrong.
    const released = loadCtsFixture("transport-details-released");
    expect(released.body).toContain("relwithignlock");
    expect(released.body).toContain("relobjigchkatc");

    const { conn, calls } = fakeCtsConnection([released]);
    await trShow(conn, "A4HK900125");
    for (const call of calls) {
      expect(call.url).toMatch(/^\/sap\/bc\/adt\/cts\//);
      expect(call.url).not.toMatch(/relwithignlock|relobjigchkatc/i);
    }
  });
});
