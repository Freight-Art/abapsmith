/**
 * Source reads — error honesty (C1) and class sub-includes (C2).
 *
 * The failure inputs are built with `abap-adt-api`'s OWN exception factory
 * (`fromResponse`, the function `AdtHTTP` itself calls) from realistic ADT
 * error envelopes, so these tests exercise the shapes the wire actually
 * produces rather than a hand-rolled object shaped to please the classifier.
 */
import { AdtErrorException, fromResponse } from "abap-adt-api/build/AdtException.js";
import { describe, expect, it } from "vitest";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import type { AbapConnection } from "../src/adt/connection.js";
import { AbapError } from "../src/adt/errors.js";
import { circuitOpenError, transientOpenError } from "../src/adt/http-guard.js";
import type { ResolvedObject } from "../src/adt/resolve.js";
import { classMembers, flattenComponents, readMethod, readSource, renderOutline, sourceUriFor } from "../src/adt/source.js";
import { buildUri, specForType } from "../src/adt/types.js";

// --------------------------------------------------------------------------
// fixtures
// --------------------------------------------------------------------------

const CLASS_URI = "/sap/bc/adt/oo/classes/zcl_foo";

function objectOf(typeCode: string, name: string): ResolvedObject {
  const spec = specForType(typeCode)!;
  const uri = buildUri(spec, name);
  return {
    system: "A4H",
    type: spec.type,
    kind: spec.kind,
    label: spec.label,
    name,
    uri,
    sourceUri: spec.supportsSource ? `${uri}/source/main` : undefined,
    mode: spec.mode,
    spec,
  };
}

const CLAS = objectOf("CLAS/OC", "ZCL_FOO");

/** The ADT communication-framework error envelope, as A4H sends it. */
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

/** axios' timeout: no HTTP response ever arrives. */
const timeoutError = (): unknown =>
  Object.assign(new Error("timeout of 60000ms exceeded"), { code: "ECONNABORTED" });

/** The 45-byte `400 Session Timed Out` body captured on the LOCK verb (§D13). */
const sessionDead = (): unknown => new AdtErrorException(400, {}, "", "Session Timed Out");

const trippedBreaker = (): AuthCircuitBreaker => {
  const b = new AuthCircuitBreaker();
  b.inspect({ status: 401, headers: {}, body: "" }, `${CLASS_URI}/source/main`);
  return b;
};

const transientBreaker = (): AuthCircuitBreaker => {
  const b = new AuthCircuitBreaker();
  for (let i = 0; i < 20; i++) b.recordTransientFailure({ status: 503, message: "HTTP 503" });
  return b;
};

function throwingConn(e: unknown): AbapConnection {
  return {
    get: async () => {
      throw e;
    },
    adt: {
      classComponents: async () => {
        throw e;
      },
    },
  } as unknown as AbapConnection;
}

function bodyConn(bodies: Record<string, string>): { conn: AbapConnection; urls: string[] } {
  const urls: string[] = [];
  const conn = {
    get: async (url: string) => {
      urls.push(url);
      const body = bodies[url];
      if (body === undefined) {
        throw adtError(404, "ExceptionResourceNotFound", `Resource ${url} does not exist`);
      }
      return { body, status: 200, headers: { etag: "20260731120000001" } };
    },
  } as unknown as AbapConnection;
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

// --------------------------------------------------------------------------
// C1 — every failure used to be relabelled NOT_FOUND
// --------------------------------------------------------------------------

describe("C1: readSource classifies failures honestly", () => {
  const cases: Array<{ label: string; error: () => unknown; code: string; message: RegExp }> = [
    {
      label: "404 ExceptionResourceNotFound",
      error: () =>
        adtError(404, "ExceptionResourceNotFound", "Resource zcl_foo/source/main does not exist"),
      code: "NOT_FOUND",
      message: /does not exist/i,
    },
    {
      label: "401 ICF logon rejection",
      error: unauthorized,
      code: "AUTH_FAILED",
      message: /401/,
    },
    {
      label: "403 missing authorisation",
      error: () => adtError(403, "ExceptionSecurityFault", "No authorization to display ZCL_FOO"),
      code: "AUTH_FAILED",
      message: /403/,
    },
    {
      label: "403 ExceptionResourceNoAccess (enqueue held)",
      error: () => adtError(403, "ExceptionResourceNoAccess", "Object is locked by user DEVELOPER"),
      code: "LOCKED",
      message: /lock/i,
    },
    {
      label: "500 server error",
      error: () => adtError(500, "ExceptionInternalError", "Internal server error"),
      code: "ADT_ERROR",
      message: /internal server error/i,
    },
    {
      label: "transport timeout",
      error: timeoutError,
      code: "ADT_ERROR",
      message: /timed out/i,
    },
    {
      label: "SESSION_DEAD (400 Session Timed Out)",
      error: sessionDead,
      code: "SESSION_DEAD",
      message: /session/i,
    },
    {
      label: "auth circuit breaker open",
      error: () => circuitOpenError(trippedBreaker()),
      code: "AUTH_CIRCUIT_OPEN",
      message: /circuit breaker has tripped/i,
    },
    {
      label: "transient circuit breaker open",
      error: () => transientOpenError(transientBreaker()),
      code: "CIRCUIT_OPEN_TRANSIENT",
      message: /circuit breaker is/i,
    },
  ];

  for (const c of cases) {
    it(`maps ${c.label} to ${c.code}`, async () => {
      const err = await caught(() => readSource(throwingConn(c.error()), CLAS));
      expect(err.code).toBe(c.code);
      expect(err.message).toMatch(c.message);
      if (c.code !== "NOT_FOUND") {
        expect(err.code).not.toBe("NOT_FOUND");
        expect(`${err.message} ${err.hint ?? ""}`).not.toMatch(/abap_search/);
      }
    });
  }

  it("does not collapse the failure modes onto one code", async () => {
    const codes = new Set<string>();
    const fingerprints = new Set<string>();
    for (const c of cases) {
      const err = await caught(() => readSource(throwingConn(c.error()), CLAS));
      codes.add(err.code);
      fingerprints.add(`${err.code}|${err.details.status ?? ""}|${err.details.timeout ?? ""}`);
    }
    expect(codes.size).toBe(7);
    // Every one of the nine inputs is still distinguishable: 401 vs 403 and
    // 500 vs timeout share a code only because errors.ts (not owned here) has
    // no FORBIDDEN / NETWORK code, and they differ in details.
    expect(fingerprints.size).toBe(cases.length);
  });

  it("a 401 is never reported as a missing object (the C1 bug)", async () => {
    const err = await caught(() => readSource(throwingConn(unauthorized()), CLAS));
    expect(err.code).toBe("AUTH_FAILED");
    expect(err.code).not.toBe("NOT_FOUND");
    expect(err.message).not.toMatch(/abap_search/);
    expect(err.hint ?? "").not.toMatch(/abap_search/);
    expect(err.hint ?? "").toMatch(/ABAP_USER|credential/i);
  });

  it("keeps the genuine 404 actionable", async () => {
    const err = await caught(() =>
      readSource(
        throwingConn(adtError(404, "ExceptionResourceNotFound", "Resource does not exist")),
        CLAS,
      ),
    );
    expect(err.code).toBe("NOT_FOUND");
    expect(err.hint ?? "").toMatch(/abap_search/);
  });

  it("classMembers wraps /objectstructure failures too", async () => {
    for (const [error, code] of [
      [unauthorized(), "AUTH_FAILED"],
      [sessionDead(), "SESSION_DEAD"],
      [adtError(500, "ExceptionInternalError", "Internal server error"), "ADT_ERROR"],
    ] as const) {
      const err = await caught(() => classMembers(throwingConn(error), CLAS));
      // Before the fix this was the raw AdtErrorException, not an AbapError.
      expect(err).toBeInstanceOf(AbapError);
      expect(err.code).toBe(code);
      expect(err.details.operation).toBe("read components");
    }
  });

  it("still returns the source on the happy path", async () => {
    const { conn } = bodyConn({ [`${CLASS_URI}/source/main`]: "CLASS zcl_foo DEFINITION." });
    const res = await readSource(conn, CLAS);
    expect(res.source).toBe("CLASS zcl_foo DEFINITION.");
    expect(res.sourceUri).toBe(`${CLASS_URI}/source/main`);
    expect(res.serverEtag).toBe("20260731120000001");
    expect(res.include).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// C2 — class sub-includes
// --------------------------------------------------------------------------

describe("C2: class sub-includes are reachable", () => {
  const MAIN = "CLASS zcl_foo DEFINITION PUBLIC.";
  const TESTS = "CLASS ltcl_foo DEFINITION FOR TESTING.";

  it("fetches testclasses from the include URI, never the main source", async () => {
    const { conn, urls } = bodyConn({
      [`${CLASS_URI}/source/main`]: MAIN,
      [`${CLASS_URI}/includes/testclasses`]: TESTS,
    });
    const res = await readSource(conn, CLAS, "testclasses");
    expect(res.sourceUri).toContain("includes/testclasses");
    expect(res.sourceUri).not.toBe(`${CLASS_URI}/source/main`);
    expect(urls).toEqual([`${CLASS_URI}/includes/testclasses`]);
    expect(urls).not.toContain(`${CLASS_URI}/source/main`);
    // The C2 bug: main body returned while the caller believed it held tests.
    expect(res.source).toBe(TESTS);
    expect(res.source).not.toBe(MAIN);
    expect(res.include).toBe("testclasses");
  });

  it("reaches every include ADT exposes", async () => {
    for (const inc of ["definitions", "implementations", "macros", "testclasses"] as const) {
      const { conn, urls } = bodyConn({ [`${CLASS_URI}/includes/${inc}`]: `* ${inc}` });
      const res = await readSource(conn, CLAS, inc);
      expect(urls).toEqual([`${CLASS_URI}/includes/${inc}`]);
      expect(res.source).toBe(`* ${inc}`);
    }
  });

  it("main keeps the canonical /source/main shape", () => {
    expect(sourceUriFor(CLAS)).toBe(`${CLASS_URI}/source/main`);
    expect(sourceUriFor(CLAS, "main")).toBe(`${CLASS_URI}/source/main`);
    expect(sourceUriFor({ ...CLAS, include: "testclasses" })).toBe(
      `${CLASS_URI}/includes/testclasses`,
    );
  });

  it("refuses an include on a non-class instead of substituting the main source", () => {
    const prog = objectOf("PROG/P", "ZFOO");
    expect(() => sourceUriFor(prog, "testclasses")).toThrow(AbapError);
    try {
      sourceUriFor(prog, "testclasses");
    } catch (e) {
      const err = e as AbapError;
      expect(err.code).toBe("UNSUPPORTED");
      expect(err.message).toMatch(/testclasses/);
      expect(err.message).toMatch(/only for classes/i);
    }
  });

  it("a class with no test include 404s about the include, not the class name", async () => {
    const { conn } = bodyConn({ [`${CLASS_URI}/source/main`]: MAIN });
    const err = await caught(() => readSource(conn, CLAS, "testclasses"));
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toMatch(/has no "testclasses" include/);
    expect(err.details.requested).toBe("testclasses");
    expect(err.hint ?? "").not.toMatch(/abap_search/);
  });
});

// --------------------------------------------------------------------------
// The "available methods" list must never be cut in silence
// --------------------------------------------------------------------------

describe("readMethod discloses the cap on its component list", () => {
  const componentsConn = (count: number): AbapConnection =>
    ({
      adt: {
        classComponents: async () => ({
          "adtcore:name": "ZCL_FOO",
          "adtcore:type": "CLAS/OC",
          links: [],
          components: Array.from({ length: count }, (_, i) => ({
            "adtcore:name": `METHOD_${String(i).padStart(2, "0")}`,
            "adtcore:type": "CLAS/OM",
            links: [],
          })),
        }),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any as AbapConnection;

  it("states the true total when more components exist than it lists", async () => {
    const err = await caught(() =>
      readMethod(componentsConn(83), CLAS, "CLASS zcl_foo DEFINITION.", "NO_SUCH_METHOD"),
    );
    expect(err.code).toBe("NOT_FOUND");
    // (a) the true total, in the payload the caller receives …
    expect(err.details.availableTotal).toBe(83);
    expect((err.details.available as string[]).length).toBe(12);
    expect(err.details.availableTruncated).toBe(71);
    // (b) … and in the TEXT, so an agent reading prose is not misled into
    //     concluding the method it asked for does not exist.
    expect(err.message).toContain("83");
    expect(err.message).toMatch(/TRUNCATED/);
    expect(err.message).toMatch(/listing 12 of 83/i);
    expect(err.hint ?? "").toMatch(/INCOMPLETE/);
    const rendered = JSON.stringify(err.toJSON());
    expect(rendered).toContain("83");
    expect(rendered).toMatch(/TRUNCATED/);
  });

  it("a method beyond the cap is not implied to be absent", async () => {
    const err = await caught(() =>
      readMethod(componentsConn(83), CLAS, "CLASS zcl_foo DEFINITION.", "TYPO_METHOD"),
    );
    const listed = err.details.available as string[];
    // METHOD_70 really exists and really is missing from the list — the error
    // must therefore not read as an exhaustive inventory.
    expect(listed).not.toContain("METHOD_70");
    expect(`${err.message} ${err.hint ?? ""}`).toMatch(/TRUNCATED|INCOMPLETE/);
  });

  it("says nothing about truncation when nothing was truncated", async () => {
    const err = await caught(() =>
      readMethod(componentsConn(10), CLAS, "CLASS zcl_foo DEFINITION.", "NOPE"),
    );
    expect(err.details.availableTotal).toBe(10);
    expect(err.details.availableTruncated).toBeUndefined();
    expect(err.message).not.toMatch(/TRUNCATED/);
  });

  it("ranks a one-character typo's real target first, ahead of 82 unrelated names", async () => {
    const conn = {
      adt: {
        classComponents: async () => ({
          "adtcore:name": "ZCL_FOO",
          "adtcore:type": "CLAS/OC",
          links: [],
          components: [
            ...Array.from({ length: 82 }, (_, i) => ({
              "adtcore:name": `UNRELATED_FILLER_METHOD_${i}`,
              "adtcore:type": "CLAS/OM",
              links: [],
            })),
            { "adtcore:name": "CALCULATE_TOTAL_PRICE", "adtcore:type": "CLAS/OM", links: [] },
          ],
        }),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as AbapConnection;
    const err = await caught(() =>
      // one-character typo: F instead of the real member's trailing E.
      readMethod(conn, CLAS, "CLASS zcl_foo DEFINITION.", "CALCULATE_TOTAL_PRICF"),
    );
    const listed = err.details.available as string[];
    expect(listed[0]).toBe("CALCULATE_TOTAL_PRICE");
  });

  it("still returns the method body when the method exists", async () => {
    const src = ["one", "two", "three", "four"].join("\n");
    const conn = {
      adt: {
        classComponents: async () => ({
          "adtcore:name": "ZCL_FOO",
          "adtcore:type": "CLAS/OC",
          links: [],
          components: [
            {
              "adtcore:name": "CALCULATE",
              "adtcore:type": "CLAS/OM",
              links: [
                { rel: "http://www.sap.com/adt/relations/implementationBlock", href: "./source/main#start=2,0;end=3,0" },
              ],
            },
          ],
        }),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as AbapConnection;
    const res = await readMethod(conn, CLAS, src, "calculate");
    expect(res.member.name).toBe("CALCULATE");
    expect(res.implementation).toBe("two\nthree");
  });
});

describe("flattenComponents/renderOutline on a class outline with no members", () => {
  it("an empty components list flattens to zero members", () => {
    const root = {
      "adtcore:name": "ZCL_FOO",
      "adtcore:type": "CLAS/OC",
      links: [],
      components: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    expect(flattenComponents(root)).toEqual([]);
  });

  it("an absent components list flattens to zero members, no error", () => {
    const root = {
      "adtcore:name": "ZCL_FOO",
      "adtcore:type": "CLAS/OC",
      links: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    expect(flattenComponents(root)).toEqual([]);
  });

  it("renders an empty outline as an empty string", () => {
    expect(renderOutline([])).toBe("");
  });
});
