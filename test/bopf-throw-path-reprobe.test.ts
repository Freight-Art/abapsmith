/**
 * `src/adt/bopf.ts` throw paths that mutate and then rethrow with no
 * re-check — extends the same two patterns the file already establishes
 * elsewhere: re-probe on the throw path (`createBusinessObject`'s catch,
 * mirrored here for `deleteDdicCandidate`/`deleteBusinessObject`), and
 * disclosure — a new `AbapError`, same code/message/details, the probe's
 * finding folded into `hint` (`discloseBridgeResidue`'s shape in run.ts,
 * mirrored here for `deleteBusinessObject`/`putModel`).
 *
 * Same harness idiom as `test/bopf-delete-reporting.test.ts`/
 * `test/bopf-client.test.ts`: real `bopf.ts` functions against a
 * `FakeAdtServer`, only the HTTP socket is fake.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FakeAdtServer,
  __resetFakeAdtCounters,
  fakeResponse,
  bopfStore,
  BOPF_ACCEPT_V4,
  missingLockHandle400,
  type FakeRoute,
} from "./helpers/fake-adt.js";
import { DATA_PREVIEW_PATH, systemRoleProbeResponse } from "./helpers/system-role-fake.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { SafetyGate } from "../src/safety.js";
import { bopfUri, deleteBusinessObject, putModel } from "../src/adt/bopf.js";

// --------------------------------------------------------------------- harness ---

const openGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: ["*"],
    allowTransportRelease: true,
    allowCascadeDelete: true,
  });

const authWrite = (name: string, packageName = "$TMP") => openGate().authorize("write", { name, packageName, type: "BOBF" });

function mintDelete(name: string, packageName = "$TMP"): { authorized: ReturnType<SafetyGate["authorize"]>; gate: SafetyGate } {
  const gate = openGate();
  return { authorized: gate.authorize("delete", { name, packageName, type: "BOBF" }), gate };
}

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bopf");
const fixture = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");

/** ZBOPF_PRB1, root-only, just after create — real captured shape. Constants interface ref: ZIF_BOPF_PRB1_C -> /sap/bc/adt/oo/interfaces/zif_bopf_prb1_c. */
const FX_JUST_CREATED = fixture("02-created-zbopf_prb1-root-only.v4.xml");

const systemRoleRoute: FakeRoute = (r) => (r.path.includes(DATA_PREVIEW_PATH) ? systemRoleProbeResponse("nonproductive") : undefined);

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
  });

const openConnections: AbapConnection[] = [];

beforeEach(() => {
  __resetFakeAdtCounters();
});

afterEach(() => {
  for (const conn of openConnections.splice(0)) conn.dispose();
});

async function wired(options: { routes?: readonly FakeRoute[] } = {}): Promise<{ conn: AbapConnection; server: FakeAdtServer }> {
  const server = new FakeAdtServer({ transportErrors: "throw", routes: [systemRoleRoute, ...(options.routes ?? [])] });
  const client = server.client("s1");
  const conn = new AbapConnection(cfg(), { httpClient: client, log: () => {}, breaker: new AuthCircuitBreaker() });
  openConnections.push(conn);
  await conn.connect();
  return { conn, server };
}

const SYSTEM_ERROR_500 = () => fakeResponse(500, `<exc:exception><type id="ExceptionSystemError"/><message lang="EN">RFC connection lost</message></exc:exception>`, {
  "content-type": "application/xml",
});

const NOT_FOUND_404 = () => fakeResponse(404, `<exc:exception><type id="ExceptionResourceNotFound"/></exc:exception>`, {
  "content-type": "application/xml",
});

// --------------------------------------------------------- deleteDdicCandidate ---

/**
 * A single DDIC candidate URI whose existence probe (GET #1) always finds
 * the object, whose DELETE always fails (500, `ExceptionSystemError`), and
 * whose post-failure read-back (GET #2+) answers per `readBack`:
 *  - "gone": 404 — DELETE actually landed despite the thrown error.
 *  - "still-there": 200 — DELETE genuinely failed.
 *  - "flaky": 500 — the re-check itself can't settle the question.
 */
function ddicDeleteFailsRoute(uri: string, readBack: "gone" | "still-there" | "flaky"): FakeRoute {
  let getCount = 0;
  return (r) => {
    if (r.path !== uri) return undefined;
    const accept = String(r.headers["accept"] ?? "");
    if (accept !== "*/*") return undefined;
    if (r.method === "GET") {
      getCount += 1;
      if (getCount === 1) {
        return fakeResponse(200, `<tabl:table xmlns:tabl="http://www.sap.com/wbobj/tables"/>`, { "content-type": "application/xml" });
      }
      if (readBack === "gone") return NOT_FOUND_404();
      if (readBack === "still-there") {
        return fakeResponse(200, `<tabl:table xmlns:tabl="http://www.sap.com/wbobj/tables"/>`, { "content-type": "application/xml" });
      }
      return SYSTEM_ERROR_500();
    }
    if (r.method === "DELETE") {
      const handle = r.qs["lockHandle"];
      if (typeof handle !== "string" || handle === "") return missingLockHandle400();
      return SYSTEM_ERROR_500();
    }
    return undefined;
  };
}

describe("deleteDdicCandidate: DELETE throws, re-probes the same way the success path does", () => {
  const CONST_IFACE_URI = "/sap/bc/adt/oo/interfaces/zif_bopf_prb1_c";

  it("read-back 404s: deleted true, reason names both the delete failure and the confirming read-back", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route, ddicDeleteFailsRoute(CONST_IFACE_URI, "gone")] });

    const result = await conn.withStatefulSession(async (session) => {
      const { authorized, gate } = mintDelete("ZBOPF_PRB1");
      return deleteBusinessObject(conn, session, "ZBOPF_PRB1", authorized, gate, { cascadeDdic: true });
    });

    const constants = result.ddic.find((d) => d.name === "ZIF_BOPF_PRB1_C");
    expect(constants?.existed).toBe(true);
    expect(constants?.deleted).toBe(true);
    expect(constants?.reason).toMatch(/delete failed/i);
    expect(constants?.reason).toMatch(/read-back.*confirms|confirms.*gone/i);
  });

  it("read-back still 200s: deleted false, the original delete-failed reason survives", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route, ddicDeleteFailsRoute(CONST_IFACE_URI, "still-there")] });

    const result = await conn.withStatefulSession(async (session) => {
      const { authorized, gate } = mintDelete("ZBOPF_PRB1");
      return deleteBusinessObject(conn, session, "ZBOPF_PRB1", authorized, gate, { cascadeDdic: true });
    });

    const constants = result.ddic.find((d) => d.name === "ZIF_BOPF_PRB1_C");
    expect(constants?.existed).toBe(true);
    expect(constants?.deleted).toBe(false);
    expect(constants?.reason).toMatch(/delete failed/i);
    expect(constants?.reason).toMatch(/still finds the object/i);
  });

  it("read-back itself throws a non-404: deleted \"unverified\", never true or false", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route, ddicDeleteFailsRoute(CONST_IFACE_URI, "flaky")] });

    const result = await conn.withStatefulSession(async (session) => {
      const { authorized, gate } = mintDelete("ZBOPF_PRB1");
      return deleteBusinessObject(conn, session, "ZBOPF_PRB1", authorized, gate, { cascadeDdic: true });
    });

    const constants = result.ddic.find((d) => d.name === "ZIF_BOPF_PRB1_C");
    expect(constants?.existed).toBe(true);
    expect(constants?.deleted).toBe("unverified");
    expect(constants?.reason).toMatch(/delete failed/i);
    expect(constants?.reason).toMatch(/read-back.*also failed/i);
  });
});

// --------------------------------------------------------- deleteBusinessObject ---

/**
 * The BOPF entry itself: GET/DELETE self-contained (not `bopfStore`, so the
 * DELETE's failure and the post-failure GET's answer are independently
 * controlled — `bopfStore`'s own DELETE handler never fails).
 */
function boDeleteFailsThenReadBackRoute(bo: string, xml: string, opts: { postFailureFound: boolean }): FakeRoute {
  const uri = bopfUri(bo);
  let deleteAttempted = false;
  return (r) => {
    if (r.path !== uri) return undefined;
    if (r.method === "GET") {
      const accept = String(r.headers["accept"] ?? "");
      if (!accept.includes("bopf.businessobjects.v4")) return undefined;
      if (deleteAttempted && !opts.postFailureFound) return NOT_FOUND_404();
      return fakeResponse(200, xml, { "content-type": `${BOPF_ACCEPT_V4}; charset=utf-8` });
    }
    if (r.method === "DELETE") {
      const handle = r.qs["lockHandle"];
      if (typeof handle !== "string" || handle === "") return missingLockHandle400();
      deleteAttempted = true;
      return SYSTEM_ERROR_500();
    }
    return undefined;
  };
}

describe("deleteBusinessObject: DELETE throws, re-probes before rethrowing", () => {
  it("re-GET 404s: rethrown error keeps its original code, hint discloses the delete may have landed", async () => {
    const { conn } = await wired({ routes: [boDeleteFailsThenReadBackRoute("ZBOPF_PRB1", FX_JUST_CREATED, { postFailureFound: false })] });

    const err = await conn
      .withStatefulSession(async (session) => {
        const { authorized, gate } = mintDelete("ZBOPF_PRB1");
        return deleteBusinessObject(conn, session, "ZBOPF_PRB1", authorized, gate);
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(isAbapError(err)).toBe(true);
    const abapErr = err as AbapError;
    expect(abapErr.code).toBe("ADT_ERROR");
    expect(abapErr.message).toMatch(/RFC connection lost/);
    expect(abapErr.hint).toMatch(/no longer finds the object/i);
    expect(abapErr.hint).toMatch(/may have landed/i);
    expect(abapErr.details.postFailureProbe).toMatch(/may have landed/i);
  });

  it("re-GET still 200s: rethrown error keeps its original code, hint discloses the delete did not land", async () => {
    const { conn } = await wired({ routes: [boDeleteFailsThenReadBackRoute("ZBOPF_PRB1", FX_JUST_CREATED, { postFailureFound: true })] });

    const err = await conn
      .withStatefulSession(async (session) => {
        const { authorized, gate } = mintDelete("ZBOPF_PRB1");
        return deleteBusinessObject(conn, session, "ZBOPF_PRB1", authorized, gate);
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(isAbapError(err)).toBe(true);
    const abapErr = err as AbapError;
    expect(abapErr.code).toBe("ADT_ERROR");
    expect(abapErr.hint).toMatch(/still finds the object/i);
    expect(abapErr.hint).toMatch(/did not land/i);
  });
});

// --------------------------------------------------------------------- putModel ---

/** Structural short-dump markers `classifySessionFailure` checks first — same shape as `bopf-create-recovery.test.ts`'s `DUMP_BODY`. */
const DUMP_BODY_HTML =
  `<html><body><div class="errorTextHeader">Short dump</div>` +
  `<div id="msgText">The current ABAP program had to be terminated.</div></body></html>`;

/** PUT to this BO's URI always answers a genuine SESSION_DEAD (dump-shaped 500) — GET/LOCK/UNLOCK untouched. */
function sessionDeathOnPutRoute(bo: string): FakeRoute {
  const uri = bopfUri(bo);
  return (r) => {
    if (r.path !== uri || r.method !== "PUT") return undefined;
    const handle = r.qs["lockHandle"];
    if (typeof handle !== "string" || handle === "") return missingLockHandle400();
    return fakeResponse(500, DUMP_BODY_HTML, { "content-type": "text/html" });
  };
}

describe("putModel: PUT throws, disclosure appended without changing the code", () => {
  it("PUT dies with SESSION_DEAD: rethrown error keeps its code, hint discloses a failed PUT is not proof the model is unchanged", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [sessionDeathOnPutRoute("ZBOPF_PRB1"), store.route] });

    const err = await conn
      .withStatefulSession(async (session) => putModel(conn, session, "ZBOPF_PRB1", (xml) => xml, authWrite("ZBOPF_PRB1")))
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(isAbapError(err)).toBe(true);
    const abapErr = err as AbapError;
    expect(abapErr.code).toBe("SESSION_DEAD");
    expect(abapErr.hint).toMatch(/failed PUT is not proof the model is unchanged/i);
    expect(abapErr.details.postFailureProbe).toBeDefined();
  });

  it("PUT gets a plain refusal (invalid lock handle): error rethrown untouched, no disclosure text, no extra probe", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    store.failNextPuts(99); // every attempt (both of withRelockRetry's) fails
    const { conn } = await wired({ routes: [store.route] });

    const err = await conn
      .withStatefulSession(async (session) => putModel(conn, session, "ZBOPF_PRB1", (xml) => xml, authWrite("ZBOPF_PRB1")))
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(isAbapError(err)).toBe(true);
    const abapErr = err as AbapError;
    // failNextPuts answers 423 ExceptionResourceInvalidLockHandle -> "ADT_ERROR" (see session.ts's INVALID_LOCK_HANDLE_TYPE_IDS branch).
    // It carries a real response (not SESSION_DEAD, not response-less) — no disclosure, no extra GET.
    expect(abapErr.code).toBe("ADT_ERROR");
    expect(abapErr.hint).not.toMatch(/failed PUT is not proof the model is unchanged/i);
    expect(abapErr.details.postFailureProbe).toBeUndefined();
    // withRelockRetry's own exhaustion annotation still applies.
    expect(abapErr.details.attempts).toBe(2);
  });
});
