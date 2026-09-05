/**
 * `BDEF/BDO`'s `/source/main` answers HTTP 200 with an EMPTY body for an
 * object that does not exist — byte-identical to a genuinely empty (but
 * present) skeleton. A blank body therefore settles nothing about existence
 * on its own; see capabilities.ts's `blankSourceOnAbsence` registry field,
 * write-verify.ts's `blankSourceIsAmbiguous`/`objectAcceptFor`, and
 * source.ts's `readSource`.
 *
 * Section A exercises `readSource`'s guard directly, same idiom as
 * test/absent-source-500.test.ts. Section B exercises `verifyObjectDeleted`
 * and `verifyObjectPresent`'s own blank-body branches against
 * `FakeAdtServer`, same idiom as test/delete-verification.test.ts.
 */
import { fromResponse } from "abap-adt-api/build/AdtException.js";
import { describe, expect, it } from "vitest";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError } from "../src/adt/errors.js";
import type { ResolvedObject } from "../src/adt/resolve.js";
import { readSource } from "../src/adt/source.js";
import { buildUri, specForType } from "../src/adt/types.js";
import { verifyObjectDeleted, verifyObjectPresent } from "../src/adt/write-verify.js";
import {
  FakeAdtServer,
  __resetFakeAdtCounters,
  fakeResponse,
  searchResultsXml,
  type FakeObjectRef,
  type FakeRoute,
} from "./helpers/fake-adt.js";
import { DATA_PREVIEW_PATH, systemRoleProbeResponse } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// Section A — readSource's blank-body guard.
// ---------------------------------------------------------------------------

const spec = specForType("BDEF/BDO")!;
const NAME = "ZTMD_BLANK_R";
const OBJ_URI = buildUri(spec, NAME);
const SRC_URI = `${OBJ_URI}/source/main`;

const BDEF_OBJ: ResolvedObject = {
  system: "A4H",
  type: spec.type,
  kind: spec.kind,
  label: spec.label,
  name: NAME,
  uri: OBJ_URI,
  sourceUri: SRC_URI,
  mode: spec.mode,
  spec,
};

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

const object404 = () =>
  adtError(404, "ExceptionResourceNotFound", `Behavior definition ${NAME} does not exist`);

type Step = { body: string } | { throws: unknown };
type Route = Step | readonly Step[];

/** Per-URL fake: records every URL hit, in order. See test/absent-source-500.test.ts's identical helper. */
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

describe("readSource: a blank BDEF/BDO source body defers to the object URI", () => {
  it("blank body + object URI 404 -> NOT_FOUND (the red proof)", async () => {
    const { conn, urls } = routedConn({
      [SRC_URI]: { body: "" },
      [OBJ_URI]: { throws: object404() },
    });
    const err = await caught(() => readSource(conn, BDEF_OBJ));
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toContain(NAME);
    expect(err.details.absenceConfirmedVia).toBe(OBJ_URI);
    expect(urls).toEqual([SRC_URI, OBJ_URI]);
  });

  it("blank body + object URI 200 -> resolves with the empty source (a created-but-not-yet-filled skeleton is empty, not missing)", async () => {
    const { conn, urls } = routedConn({
      [SRC_URI]: { body: "" },
      [OBJ_URI]: { body: '<blue:blueSource xmlns:blue="http://www.sap.com/wbobj/blue"/>' },
    });
    const result = await readSource(conn, BDEF_OBJ);
    expect(result.source).toBe("");
    expect(urls).toEqual([SRC_URI, OBJ_URI]);
  });

  it("blank body + object URI no-answer -> resolves with the empty source (a probe that established nothing must not mint NOT_FOUND)", async () => {
    const { conn, urls } = routedConn({
      [SRC_URI]: { body: "" },
      [OBJ_URI]: { throws: adtError(500, "ExceptionInternalServerError", "An exception was raised") },
    });
    const result = await readSource(conn, BDEF_OBJ);
    expect(result.source).toBe("");
    expect(urls).toEqual([SRC_URI, OBJ_URI]);
  });

  it("a whitespace-only body counts as blank too", async () => {
    const { conn, urls } = routedConn({
      [SRC_URI]: { body: "\n  \n" },
      [OBJ_URI]: { throws: object404() },
    });
    const err = await caught(() => readSource(conn, BDEF_OBJ));
    expect(err.code).toBe("NOT_FOUND");
    expect(urls).toEqual([SRC_URI, OBJ_URI]);
  });

  it("a non-blank body never probes the object URI at all", async () => {
    const source =
      "managed implementation in class zbp_ztmd_blank_r unique;\n" +
      "strict(2);\n" +
      "define behavior for ZTMD_BLANK_R\n{\n}\n";
    const { conn, urls } = routedConn({ [SRC_URI]: { body: source } });
    const result = await readSource(conn, BDEF_OBJ);
    expect(result.source).toBe(source);
    expect(urls).toEqual([SRC_URI]);
  });

  it("a type WITHOUT blankSourceOnAbsence is untouched: a blank body just resolves, zero extra requests (control)", async () => {
    const ctlSpec = specForType("DDLS/DF")!;
    const ctlName = "ZTMD_DDLS_CTL";
    const ctlObjUri = buildUri(ctlSpec, ctlName);
    const ctlSrcUri = `${ctlObjUri}/source/main`;
    const ctlObj: ResolvedObject = {
      system: "A4H",
      type: ctlSpec.type,
      kind: ctlSpec.kind,
      label: ctlSpec.label,
      name: ctlName,
      uri: ctlObjUri,
      sourceUri: ctlSrcUri,
      mode: ctlSpec.mode,
      spec: ctlSpec,
    };
    const { conn, urls } = routedConn({ [ctlSrcUri]: { body: "" } });
    const result = await readSource(conn, ctlObj);
    expect(result.source).toBe("");
    expect(urls).toEqual([ctlSrcUri]);
  });
});

// ---------------------------------------------------------------------------
// Section B — verifyObjectDeleted and verifyObjectPresent, direct against
// FakeAdtServer.
// ---------------------------------------------------------------------------

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
  });

const systemRoleRoute: FakeRoute = (r) =>
  r.path.includes(DATA_PREVIEW_PATH) ? systemRoleProbeResponse("nonproductive") : undefined;

async function wired(
  options: { routes?: readonly FakeRoute[] } = {},
): Promise<{ conn: AbapConnection; server: FakeAdtServer }> {
  __resetFakeAdtCounters();
  const server = new FakeAdtServer({
    transportErrors: "throw",
    routes: [systemRoleRoute, ...(options.routes ?? [])],
  });
  const client = server.client("s1");
  const conn = new AbapConnection(cfg(), {
    httpClient: client,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  return { conn, server };
}

const CONTENT_URI = "/sap/bc/adt/bo/behaviordefinitions/ztmd_blank_r/source/main";
const OBJECT_URI = "/sap/bc/adt/bo/behaviordefinitions/ztmd_blank_r";
const CONTENT_ACCEPT = "text/plain";
const EXPECT_TYPE = "BDEF/BDO";
const SEARCH_PATH = "/sap/bc/adt/repository/informationsystem/search";

const verifyOpts = { uri: CONTENT_URI, accept: CONTENT_ACCEPT, objectName: NAME, expectType: EXPECT_TYPE };

describe("verifyObjectDeleted: a blank 200 read-back defers to the confirming GET, not to the search directly", () => {
  it("confirmed-absent via the confirming GET, with no repository search at all (the red proof)", async () => {
    const { conn, server } = await wired({
      routes: [
        (r) => (r.url === CONTENT_URI ? fakeResponse(200, "", { "content-type": "text/plain" }) : undefined),
        (r) => (r.url === OBJECT_URI ? fakeResponse(404, "") : undefined),
      ],
    });

    const result = await verifyObjectDeleted(conn, verifyOpts);

    expect(result.status).toBe("confirmed-absent");
    if (result.status === "confirmed-absent") {
      expect(result.uri).toBe(OBJECT_URI);
      expect(result.via).toBe("read-back");
    }
    expect(server.calls.some((c) => c.path === SEARCH_PATH)).toBe(false);
  });

  it("confirmed via the repository search once the confirming GET also finds the object still there", async () => {
    const ref: FakeObjectRef = { name: NAME, type: EXPECT_TYPE, uri: OBJECT_URI };
    const { conn, server } = await wired({
      routes: [
        (r) => (r.url === CONTENT_URI ? fakeResponse(200, "", { "content-type": "text/plain" }) : undefined),
        (r) =>
          r.url === OBJECT_URI
            ? fakeResponse(200, '<blue:blueSource xmlns:blue="http://www.sap.com/wbobj/blue"/>', {
                "content-type": "application/xml",
              })
            : undefined,
        (r) => (r.path === SEARCH_PATH ? fakeResponse(200, searchResultsXml([ref]), { "content-type": "application/xml" }) : undefined),
      ],
    });

    const result = await verifyObjectDeleted(conn, verifyOpts);

    // Neither the blank content body nor the confirming GET alone settles it —
    // both are inconclusive-for-absence, so the search is what actually confirms.
    expect(result.status).toBe("confirmed");
    if (result.status === "confirmed") expect(result.via).toBe("repository-search");
    expect(server.callsFor((r) => r.url === OBJECT_URI)).toHaveLength(1);
  });

  it("indeterminate, and the reason says the read-back never settled it, when the confirming GET also fails to answer", async () => {
    const { conn } = await wired({
      routes: [
        (r) => (r.url === CONTENT_URI ? fakeResponse(200, "", { "content-type": "text/plain" }) : undefined),
        (r) => (r.url === OBJECT_URI ? fakeResponse(500, "<exc:exception/>", { "content-type": "application/xml" }) : undefined),
        (r) => (r.path === SEARCH_PATH ? fakeResponse(200, searchResultsXml([]), { "content-type": "application/xml" }) : undefined),
      ],
    });

    const result = await verifyObjectDeleted(conn, verifyOpts);

    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason).toMatch(/never settled it/);
      expect(result.reason).not.toMatch(/the object is still there/);
    }
  });
});

describe("verifyObjectPresent: a blank 200 read-back does not short-circuit to confirmed for this type", () => {
  it("confirmed via the search, and a search request was actually made", async () => {
    const ref: FakeObjectRef = { name: NAME, type: EXPECT_TYPE, uri: OBJECT_URI };
    const { conn, server } = await wired({
      routes: [
        (r) => (r.url === CONTENT_URI ? fakeResponse(200, "", { "content-type": "text/plain" }) : undefined),
        (r) => (r.path === SEARCH_PATH ? fakeResponse(200, searchResultsXml([ref]), { "content-type": "application/xml" }) : undefined),
      ],
    });

    const result = await verifyObjectPresent(conn, verifyOpts);

    expect(result.status).toBe("confirmed");
    if (result.status === "confirmed") expect(result.via).toBe("repository-search");
    expect(server.calls.some((c) => c.path === SEARCH_PATH)).toBe(true);
  });

  it("indeterminate, quoting the blank-body wording, when the search also misses", async () => {
    const { conn } = await wired({
      routes: [
        (r) => (r.url === CONTENT_URI ? fakeResponse(200, "", { "content-type": "text/plain" }) : undefined),
        (r) => (r.path === SEARCH_PATH ? fakeResponse(200, searchResultsXml([]), { "content-type": "application/xml" }) : undefined),
      ],
    });

    const result = await verifyObjectPresent(conn, verifyOpts);

    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason).toMatch(/does not distinguish an absent object from an empty one/);
    }
  });
});
