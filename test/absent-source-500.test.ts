/**
 * `abap_read` on an absent FUGR/FF function module reports the
 * source endpoint's ordinary 500 for absence (see capabilities.ts's FUGR/FF
 * entry) as an unclassified ADT_ERROR instead of NOT_FOUND. The envelope
 * alone cannot tell that 500 apart from a genuinely broken server answering
 * about an object that DOES exist — test/fixtures/live-captured/040-terminate-debuggee.xml
 * is a captured 500 from an unrelated debugger failure whose message is also
 * exactly "An exception was raised". `readSource` now confirms absence with
 * a second GET at the bare object URI (mirroring `resolveWriteTarget` in
 * write.ts) before minting NOT_FOUND, and leaves every other outcome alone.
 *
 * Failure inputs are built with abap-adt-api's OWN exception factory
 * (`fromResponse`), same idiom as test/source.test.ts — not FakeAdt (see
 * test/helpers/fake-adt.ts's header: it resolves statuses >= 400 where the
 * real transport rejects) and not a hand-rolled object.
 */
import { AdtErrorException, fromResponse } from "abap-adt-api/build/AdtException.js";
import { describe, expect, it } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import { AbapError } from "../src/adt/errors.js";
import type { ResolvedObject } from "../src/adt/resolve.js";
import { classifySourceFailure, readSource } from "../src/adt/source.js";
import { buildUri, specForType } from "../src/adt/types.js";

const spec = specForType("FUGR/FF")!;
const GROUP = "ZTMD_HS359";
const FM = "ZTMD_HS359_FM";
const OBJ_URI = buildUri(spec, FM, GROUP);
const SRC_URI = `${OBJ_URI}/source/main`;

const FM_OBJ: ResolvedObject = {
  system: "A4H",
  type: spec.type,
  kind: spec.kind,
  label: spec.label,
  name: FM,
  uri: OBJ_URI,
  sourceUri: SRC_URI,
  mode: spec.mode,
  spec,
};

/** The ADT communication-framework error envelope, as A4H sends it — same shape as 072/040's captures. */
const envelope = (type: string, message: string) =>
  `<?xml version="1.0" encoding="utf-8"?><exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
  `<namespace id="com.sap.adt"/><type id="${type}"/><message lang="EN">${message}</message>` +
  `<localizedMessage lang="EN">${message}</localizedMessage>` +
  `<properties><entry key="ExceptionText">${message}</entry></properties></exc:exception>`;

const adtError = (status: number, type: string, message: string): unknown => {
  const body = envelope(type, message);
  return fromResponse(body, {
    status,
    statusText: message,
    headers: { "content-type": "application/xml" },
    body,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
};

/** 401 answers are the ICF logon page, not an XML envelope. */
const unauthorized = (): unknown => {
  const html = `<html><head><title>Logon Error Message</title></head><body>401 Unauthorized</body></html>`;
  return fromResponse(html, {
    status: 401,
    statusText: "Unauthorized",
    headers: { "content-type": "text/html" },
    body: html,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
};

/** The issue's exact wire evidence: 500 ExceptionInternalServerError, "An exception was raised". */
const source500 = () => adtError(500, "ExceptionInternalServerError", "An exception was raised");

/** The 072 capture's shape: a real absent-object 404. */
const object404 = () =>
  adtError(404, "ExceptionResourceNotFound", `Function module ${FM} does not exist`);

/** A genuine (non-hand-rolled) transport error whose `.response` carries the ICM dead-session header. */
const sessionDeadOnWire = (): unknown =>
  AdtErrorException.create(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { status: 400, statusText: "Bad Request", headers: { "x-sap-icm-err-id": "ICMENOSESSION" }, body: "" } as any,
    {},
  );

type Step = { body: string } | { throws: unknown };
type Route = Step | readonly Step[];

/**
 * Per-URL fake: some routes answer 200, others reject with a given exception.
 * A route may also be an ARRAY of steps, consumed in order per URL (sticking
 * on the last entry once exhausted) — needed to simulate a dead-session GET
 * followed by a clean answer after reconnect, at the same URL. Records every
 * URL hit, in order.
 */
function routedConn(routes: Record<string, Route>): { conn: AbapConnection; urls: string[] } {
  const urls: string[] = [];
  const seen: Record<string, number> = {};
  const conn = {
    get: async (url: string) => {
      urls.push(url);
      const route = routes[url];
      if (!route) throw new Error(`test bug: unrouted GET ${url}`);
      const step: Step = Array.isArray(route) ? route[Math.min(seen[url] ?? 0, route.length - 1)] : route;
      seen[url] = (seen[url] ?? 0) + 1;
      if ("throws" in step) throw step.throws;
      return { body: step.body, status: 200, headers: {} };
    },
    connect: async () => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as AbapConnection;
  return { conn, urls };
}

const caught = async (fn: () => Promise<unknown>): Promise<AbapError> => {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AbapError);
    return e as AbapError;
  }
  throw new Error("expected a throw");
};

describe("a 500 source read confirmed absent at the object URI becomes NOT_FOUND", () => {
  it("FUGR/FF: source 500 + object URI 404 -> NOT_FOUND (the red proof)", async () => {
    const { conn, urls } = routedConn({
      [SRC_URI]: { throws: source500() },
      [OBJ_URI]: { throws: object404() },
    });
    const err = await caught(() => readSource(conn, FM_OBJ));
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toContain(FM);
    expect(err.message).toContain("500");
    expect(err.details.absenceConfirmedVia).toBe(OBJ_URI);
    expect(`${err.message} ${err.hint ?? ""}`).not.toMatch(/do not retry unchanged/i);
    expect(urls).toEqual([SRC_URI, OBJ_URI]);
  });
});

describe("a 500 source read confirmed absent only after the confirming probe survives a dead session", () => {
  it("FUGR/FF: source 500, object URI dies with ICMENOSESSION then confirms 404 after reconnect -> NOT_FOUND", async () => {
    const { conn, urls } = routedConn({
      [SRC_URI]: { throws: source500() },
      [OBJ_URI]: [{ throws: sessionDeadOnWire() }, { throws: object404() }],
    });
    const err = await caught(() => readSource(conn, FM_OBJ));
    // LOAD-BEARING: at base, `confirmedAbsentAt500` had no reconnect — the
    // dead-session GET was the probe's only answer, it returned `false`, and
    // the original unclassified ADT_ERROR (from the 500) stood uncorrected.
    expect(err.code).toBe("NOT_FOUND");
    expect(err.details.absenceConfirmedVia).toBe(OBJ_URI);
    expect(urls).toEqual([SRC_URI, OBJ_URI, OBJ_URI]);
  });
});

describe("anything but a confirmed 404 at the object URI leaves the 500 alone", () => {
  it("object URI resolves 200 -> still ADT_ERROR, message/hint unchanged (broken endpoint, real object)", async () => {
    const { conn, urls } = routedConn({
      [SRC_URI]: { throws: source500() },
      [OBJ_URI]: { body: "<fm:function-module/>" },
    });
    const err = await caught(() => readSource(conn, FM_OBJ));
    expect(err.code).toBe("ADT_ERROR");
    const expected = classifySourceFailure(source500(), {
      operation: "read source",
      uri: SRC_URI,
      name: FM,
      type: spec.type,
    });
    expect(err.message).toBe(expected.message);
    expect(err.hint).toBe(expected.hint);
    expect(urls).toEqual([SRC_URI, OBJ_URI]);
  });

  it("object URI is ALSO 500 -> still ADT_ERROR (server genuinely broken, false NOT_FOUND would be worst here)", async () => {
    const { conn, urls } = routedConn({
      [SRC_URI]: { throws: source500() },
      [OBJ_URI]: { throws: adtError(500, "ExceptionInternalServerError", "An exception was raised") },
    });
    const err = await caught(() => readSource(conn, FM_OBJ));
    expect(err.code).toBe("ADT_ERROR");
    expect(urls).toEqual([SRC_URI, OBJ_URI]);
  });

  it("the probe itself fails at the transport level -> still ADT_ERROR, original error untouched", async () => {
    const { conn, urls } = routedConn({
      [SRC_URI]: { throws: source500() },
      [OBJ_URI]: { throws: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) },
    });
    const err = await caught(() => readSource(conn, FM_OBJ));
    expect(err.code).toBe("ADT_ERROR");
    expect(urls).toEqual([SRC_URI, OBJ_URI]);
  });
});

describe("a 500 the probe could not disprove still records what the probe actually saw", () => {
  // A boolean couldn't express this pair: "confirmed there" and "said nothing
  // at all" are different facts — record which happened
  // rather than letting the bare 500 imply either.
  it("object URI answers 200 -> ADT_ERROR carries objectUriProbe: present", async () => {
    const { conn } = routedConn({
      [SRC_URI]: { throws: source500() },
      [OBJ_URI]: { body: "<fm:function-module/>" },
    });
    const err = await caught(() => readSource(conn, FM_OBJ));
    expect(err.code).toBe("ADT_ERROR");
    expect(err.details.objectUriProbe).toBe("present");
  });

  it("object URI never answers -> ADT_ERROR carries objectUriProbe: no-answer", async () => {
    const { conn } = routedConn({
      [SRC_URI]: { throws: source500() },
      [OBJ_URI]: { throws: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) },
    });
    const err = await caught(() => readSource(conn, FM_OBJ));
    expect(err.code).toBe("ADT_ERROR");
    expect(err.details.objectUriProbe).toBe("no-answer");
  });
});

describe("the probe is gated narrowly: it never fires outside a 500 with a real ADT exception type", () => {
  const cases: Array<{ label: string; error: () => unknown; code: string }> = [
    { label: "401", error: unauthorized, code: "AUTH_FAILED" },
    {
      label: "403",
      error: () => adtError(403, "ExceptionSecurityFault", "No authorization to display it"),
      code: "AUTH_FAILED",
    },
    {
      label: "session-dead 400",
      error: () => new AdtErrorException(400, {}, "", "Session Timed Out"),
      code: "SESSION_DEAD",
    },
  ];

  for (const c of cases) {
    it(`a ${c.label} source failure is unchanged and issues no probe request`, async () => {
      const { conn, urls } = routedConn({ [SRC_URI]: { throws: c.error() } });
      const err = await caught(() => readSource(conn, FM_OBJ));
      expect(err.code).toBe(c.code);
      expect(urls).toEqual([SRC_URI]);
    });
  }

  it("a plain 404 on the source stays on the existing NOT_FOUND path, no probe issued", async () => {
    const { conn, urls } = routedConn({ [SRC_URI]: { throws: object404() } });
    const err = await caught(() => readSource(conn, FM_OBJ));
    expect(err.code).toBe("NOT_FOUND");
    expect(err.details.absenceConfirmedVia).toBeUndefined();
    expect(urls).toEqual([SRC_URI]);
  });

  it("a 500 with no ADT exception type at all issues no probe (AdtErrorException's fabricated non-HTTP shape)", async () => {
    // Mirrors AdtException.js's fromError(): a non-HTTP throw becomes
    // `new AdtErrorException(500, {}, "", error.message)` — err:500, type:"".
    const fabricated = new AdtErrorException(500, {}, "", "connect ECONNRESET");
    const { conn, urls } = routedConn({ [SRC_URI]: { throws: fabricated } });
    const err = await caught(() => readSource(conn, FM_OBJ));
    expect(err.code).toBe("ADT_ERROR");
    expect(urls).toEqual([SRC_URI]);
  });
});
