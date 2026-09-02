/**
 * Coverage for `packageRefName` and the `packageName` it adds to a
 * `confirmed` `VerifyOutcome` (the safety-gap closure that added it) — see
 * `src/adt/write-verify.ts`'s doc on `VerifyOutcome`'s `confirmed` variant
 * for why this exists: `TRAN/T`/`VIEW/DV` deletes have no `resolveObject`
 * route, so `SafetyGate.evaluate`'s package allowlist can only be judged
 * safely off a server read-back, never a caller-supplied `packageName`.
 *
 * Harness idiom matches `test/write-verify.test.ts` (`FakeAdtServer` +
 * `AbapConnection`, not the `abap_write` tool surface).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdtServer, __resetFakeAdtCounters, fakeResponse, type FakeRoute } from "./helpers/fake-adt.js";
import { DATA_PREVIEW_PATH, systemRoleProbeResponse } from "./helpers/system-role-fake.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { packageRefName, verifyViaVitBridge, vitBridgeUri } from "../src/adt/write-verify.js";

// ----------------------------------------------------------------------- harness ---

const systemRoleRoute: FakeRoute = (r) =>
  r.path.includes(DATA_PREVIEW_PATH) ? systemRoleProbeResponse("nonproductive") : undefined;

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

async function wired(options: { routes?: readonly FakeRoute[] } = {}): Promise<{ conn: AbapConnection }> {
  const server = new FakeAdtServer({ routes: [systemRoleRoute, ...(options.routes ?? [])] });
  const client = server.client("s1");
  const conn = new AbapConnection(cfg(), {
    httpClient: client,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  openConnections.push(conn);
  await conn.connect();
  return { conn };
}

// ------------------------------------------------------------------ VIT-bridge stubs ---

const EXPECT_TYPE = "VIEW/DV";
const VIT_TYPE = "viewdv";
const OBJ_NAME = "ZPROPW_VIEW";
const VIT_URI = vitBridgeUri(VIT_TYPE, OBJ_NAME);

/**
 * A rich stub where the object's own name and its package name are
 * DIFFERENT — the normal live shape, and the one case that catches a
 * regex that grabs the first `adtcore:name` in the document instead of the
 * one scoped to `packageRef`.
 */
const richStub = (opts: { type: string; name: string; packageName: string; nameFirst?: boolean }): string => {
  const attrs = opts.nameFirst
    ? `adtcore:name="${opts.packageName}" adtcore:type="DEVC/K"`
    : `adtcore:type="DEVC/K" adtcore:name="${opts.packageName}"`;
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<vit:stub xmlns:vit="http://www.sap.com/wbobj/vit" xmlns:adtcore="http://www.sap.com/adt/core" ` +
    `adtcore:type="${opts.type}" adtcore:name="${opts.name}">` +
    `<adtcore:packageRef ${attrs}/>` +
    `</vit:stub>`
  );
};

const sparseStub = (type: string, name: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<vit:stub xmlns:vit="http://www.sap.com/wbobj/vit" xmlns:adtcore="http://www.sap.com/adt/core" ` +
  `adtcore:type="${type}" adtcore:name="${name}"/>`;

// --------------------------------------------------------------------- packageRefName ---

describe("packageRefName", () => {
  it("returns the package, not the object's own document-level name, when they differ", () => {
    const body = richStub({ type: EXPECT_TYPE, name: "ZPROPW_VIEW", packageName: "ZTRAVEL_PKG" });
    expect(packageRefName(body)).toBe("ZTRAVEL_PKG");
  });

  it("finds adtcore:name when it is the FIRST attribute on packageRef", () => {
    const body = richStub({ type: EXPECT_TYPE, name: "ZPROPW_VIEW", packageName: "ZFIRST_PKG", nameFirst: true });
    expect(packageRefName(body)).toBe("ZFIRST_PKG");
  });

  it("finds adtcore:name when it is the LAST attribute on packageRef", () => {
    const body = richStub({ type: EXPECT_TYPE, name: "ZPROPW_VIEW", packageName: "ZLAST_PKG", nameFirst: false });
    expect(packageRefName(body)).toBe("ZLAST_PKG");
  });

  it("returns undefined when there is no packageRef element at all", () => {
    expect(packageRefName(sparseStub(EXPECT_TYPE, "ZPROPW_VIEW"))).toBeUndefined();
  });

  it("returns undefined (not empty string) when packageRef carries an empty adtcore:name", () => {
    const body =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<vit:stub xmlns:vit="http://www.sap.com/wbobj/vit" xmlns:adtcore="http://www.sap.com/adt/core" ` +
      `adtcore:type="${EXPECT_TYPE}" adtcore:name="ZPROPW_VIEW">` +
      `<adtcore:packageRef adtcore:name=""/>` +
      `</vit:stub>`;
    expect(packageRefName(body)).toBeUndefined();
  });

  it("returns undefined for a document-level adtcore:name with no packageRef — proves the regex is anchored to the element", () => {
    // Same document-level name a sparse stub carries; if the parser were
    // scanning for any `adtcore:name` in the body rather than one scoped to
    // `packageRef`, this would wrongly return "ZPROPW_VIEW".
    const body = sparseStub(EXPECT_TYPE, "ZPROPW_VIEW");
    expect(packageRefName(body)).toBeUndefined();
  });

  // `packageRefName` now delegates to `write.ts`'s `parsePackageRef` (moved
  // to `src/adt/package-ref.ts`) rather than a second, weaker scrape —
  // see that module's doc comment for why each of these four matters.

  it("a commented-out packageRef does not win over the real one", () => {
    const body =
      `<vit:stub xmlns:vit="http://www.sap.com/wbobj/vit" xmlns:adtcore="http://www.sap.com/adt/core" ` +
      `adtcore:type="${EXPECT_TYPE}" adtcore:name="ZPROPW_VIEW">` +
      `<!-- <adtcore:packageRef adtcore:name="ZEVIL"/> -->` +
      `<adtcore:packageRef adtcore:name="ZREAL"/>` +
      `</vit:stub>`;
    expect(packageRefName(body)).toBe("ZREAL");
  });

  it("two packageRef elements naming DIFFERENT packages disagree — undefined, not the first one found", () => {
    // The shape a nested <adtcore:objectReference> for a different object
    // produces: its own packageRef appears earlier in the document.
    const body =
      `<vit:stub xmlns:vit="http://www.sap.com/wbobj/vit" xmlns:adtcore="http://www.sap.com/adt/core" ` +
      `adtcore:type="${EXPECT_TYPE}" adtcore:name="ZPROPW_VIEW">` +
      `<adtcore:objectReference><adtcore:packageRef adtcore:name="ZOTHER"/></adtcore:objectReference>` +
      `<adtcore:packageRef adtcore:name="ZREAL"/>` +
      `</vit:stub>`;
    expect(packageRefName(body)).toBeUndefined();
  });

  it("two packageRef elements naming the SAME package in different case agree — the package, not undefined", () => {
    const body =
      `<vit:stub xmlns:vit="http://www.sap.com/wbobj/vit" xmlns:adtcore="http://www.sap.com/adt/core" ` +
      `adtcore:type="${EXPECT_TYPE}" adtcore:name="ZPROPW_VIEW">` +
      `<adtcore:packageRef adtcore:name="ZREAL"/>` +
      `<adtcore:packageRef adtcore:name="zreal"/>` +
      `</vit:stub>`;
    expect(packageRefName(body)).toBe("ZREAL");
  });

  it("a decoy vfs:name attribute on packageRef does not shadow the real adtcore:name", () => {
    const body =
      `<vit:stub xmlns:vit="http://www.sap.com/wbobj/vit" xmlns:adtcore="http://www.sap.com/adt/core" ` +
      `adtcore:type="${EXPECT_TYPE}" adtcore:name="ZPROPW_VIEW">` +
      `<adtcore:packageRef vfs:name="junk" adtcore:name="ZREAL"/>` +
      `</vit:stub>`;
    expect(packageRefName(body)).toBe("ZREAL");
  });
});

// ---------------------------------------------------------- verifyViaVitBridge wiring ---

describe("verifyViaVitBridge — packageName on confirmed", () => {
  it("a genuine stub yields confirmed WITH the package, distinct from the object's own name", async () => {
    const route: FakeRoute = (r) =>
      r.url === VIT_URI
        ? fakeResponse(200, richStub({ type: EXPECT_TYPE, name: OBJ_NAME, packageName: "ZTRAVEL_PKG" }), {
            "content-type": "application/xml",
          })
        : undefined;
    const { conn } = await wired({ routes: [route] });

    const result = await verifyViaVitBridge(conn, VIT_TYPE, OBJ_NAME, EXPECT_TYPE);

    expect(result.status).toBe("confirmed");
    if (result.status === "confirmed") {
      expect(result.packageName).toBe("ZTRAVEL_PKG");
      expect(result.packageName).not.toBe(OBJ_NAME);
    }
  });

  it("a thin stub that echoes the target but shows no existence yields confirmed-absent — no classification change from adding packageName", async () => {
    const route: FakeRoute = (r) =>
      r.url === VIT_URI ? fakeResponse(200, sparseStub(EXPECT_TYPE, OBJ_NAME), { "content-type": "application/xml" }) : undefined;
    const { conn } = await wired({ routes: [route] });

    const result = await verifyViaVitBridge(conn, VIT_TYPE, OBJ_NAME, EXPECT_TYPE);

    // On master, a stub that echoes the requested type/name but
    // carries none of vitStubShowsExistence's signals (no packageRef, no
    // enriched attributes) is confirmed-absent, not indeterminate — the
    // predicate this test named (`looksLikeGenuineVitStub`) no longer
    // exists; master split it into `echoesTarget` + `vitStubShowsExistence`.
    // This assertion documents that adding packageName did not itself
    // change that classification, not that the classification is
    // unmodified from the old base (it is not — see write-verify.ts's
    // module doc).
    expect(result.status).toBe("confirmed-absent");
  });

  it("confirmed-absent carries no packageName", async () => {
    const route: FakeRoute = (r) => (r.url === VIT_URI ? fakeResponse(404, "") : undefined);
    const { conn } = await wired({ routes: [route] });

    const result = await verifyViaVitBridge(conn, VIT_TYPE, OBJ_NAME, EXPECT_TYPE);

    expect(result.status).toBe("confirmed-absent");
    expect((result as { packageName?: string }).packageName).toBeUndefined();
  });

  it("indeterminate (a stub that does not echo the requested name) carries no packageName", async () => {
    const route: FakeRoute = (r) =>
      r.url === VIT_URI
        ? fakeResponse(200, sparseStub(EXPECT_TYPE, "ZUNRELATED_NAME"), { "content-type": "application/xml" })
        : undefined;
    const { conn } = await wired({ routes: [route] });

    const result = await verifyViaVitBridge(conn, VIT_TYPE, OBJ_NAME, EXPECT_TYPE);

    expect(result.status).toBe("indeterminate");
    expect((result as { packageName?: string }).packageName).toBeUndefined();
  });
});
