/**
 * `ensureFluidPackage` and the fluid-package constants — offline, same
 * `FakeAdtServer` harness as `test/write-verify-package.test.ts` /
 * `test/bopf-client.test.ts`: a real `AbapConnection` drives the real
 * `authorizeMutation`/`createPackage` against a fake socket.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdtServer, __resetFakeAdtCounters, fakeResponse, type FakeRoute } from "./helpers/fake-adt.js";
import { DATA_PREVIEW_PATH, systemRoleProbeResponse } from "./helpers/system-role-fake.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import {
  FLUID_PACKAGE,
  LEGACY_FLUID_PACKAGES,
  RESERVED_OBJECT_PREFIXES,
  isReservedFluidName,
  ensureFluidPackage,
  resetFluidPackageMemo,
} from "../src/adt/fluid/package.js";

const PKG_URI = "/sap/bc/adt/packages/%24abapsmith_fluid_api";
const PACKAGES = "/sap/bc/adt/packages";

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

const gate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: ["$TMP", "$ABAPSMITH_FLUID_API"],
    // $ is outside the default Z/Y customer namespace, same as ensureHelperPackage's ALLOW_GATE (test/helper-package.test.ts).
    allowNamePrefixes: ["*"],
    writesLockedOut: false,
  });

const PACKAGE_XML = (name: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<pak:package xmlns:pak="http://www.sap.com/adt/packages" ` +
  `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${name}" adtcore:type="DEVC/K">` +
  `<adtcore:packageRef adtcore:name="${name}" adtcore:type="DEVC/K"/>` +
  `<pak:superPackage/>` +
  `</pak:package>`;

const NOT_FOUND_XML =
  `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
  `<namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>` +
  `<message lang="EN">${FLUID_PACKAGE} does not exist</message><properties/></exc:exception>`;

/** Absent (404 on the package URI); the create POST succeeds. */
const absentRoute: FakeRoute = (r) => {
  if (r.path === PKG_URI && r.method === "GET") return fakeResponse(404, NOT_FOUND_XML, { "content-type": "application/xml" });
  if (r.path === PACKAGES && r.method === "POST") return fakeResponse(200, "", {});
  return undefined;
};

/** Already exists (200 on the package URI). */
const existingRoute: FakeRoute = (r) => {
  if (r.path === PKG_URI && r.method === "GET")
    return fakeResponse(200, PACKAGE_XML(FLUID_PACKAGE), { "content-type": "application/xml" });
  if (r.path === PACKAGES && r.method === "POST") return fakeResponse(200, "", {});
  return undefined;
};

/** Absent; the create POST 500s once, then succeeds on any later attempt. */
function absentThenFailOnceRoute(): FakeRoute {
  let creates = 0;
  return (r) => {
    if (r.path === PKG_URI && r.method === "GET")
      return fakeResponse(404, NOT_FOUND_XML, { "content-type": "application/xml" });
    if (r.path === PACKAGES && r.method === "POST") {
      creates += 1;
      return creates === 1 ? fakeResponse(500, "<x/>", {}) : fakeResponse(200, "", {});
    }
    return undefined;
  };
}

const openConnections: AbapConnection[] = [];

beforeEach(() => {
  __resetFakeAdtCounters();
  resetFluidPackageMemo();
});

afterEach(() => {
  for (const conn of openConnections.splice(0)) conn.dispose();
});

async function wired(routes: readonly FakeRoute[]): Promise<{ conn: AbapConnection; server: FakeAdtServer }> {
  const server = new FakeAdtServer({ transportErrors: "throw", routes: [systemRoleRoute, ...routes] });
  const client = server.client("s1");
  const conn = new AbapConnection(cfg(), {
    httpClient: client,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  openConnections.push(conn);
  await conn.connect();
  return { conn, server };
}

function mutationsSince(server: FakeAdtServer, before: number) {
  return server.calls
    .slice(before)
    .filter((c) => c.method === "PUT" || c.method === "POST" || String(c.url).includes("_action=LOCK"));
}

function createsSince(server: FakeAdtServer, before: number) {
  return server.calls.slice(before).filter((c) => c.method === "POST" && c.path === PACKAGES);
}

describe("isReservedFluidName", () => {
  it("is true for ZCL_ZMCP_ and ZIF_ZMCP_ names, case-insensitively", () => {
    expect(isReservedFluidName("ZCL_ZMCP_FOO")).toBe(true);
    expect(isReservedFluidName("zif_zmcp_bar")).toBe(true);
  });

  it("is false for names outside the reserved prefixes", () => {
    expect(isReservedFluidName("ZCL_FOO")).toBe(false);
    expect(isReservedFluidName("ZFOO")).toBe(false);
    expect(isReservedFluidName("")).toBe(false);
    expect(isReservedFluidName("   ")).toBe(false);
  });

  it("requires the trailing underscore — a prefix-of-the-prefix does not match", () => {
    expect(isReservedFluidName("ZCL_ZMCPX")).toBe(false);
  });
});

describe("fluid package constants", () => {
  it("FLUID_PACKAGE is $ABAPSMITH_FLUID_API, at most 30 characters, and $-local", () => {
    expect(FLUID_PACKAGE).toBe("$ABAPSMITH_FLUID_API");
    expect(FLUID_PACKAGE.length).toBeLessThanOrEqual(30);
    // The $ prefix is what keeps the package local under the safety gate (isSapPackage, the transport allowlist).
    expect(FLUID_PACKAGE.startsWith("$")).toBe(true);
  });

  it("LEGACY_FLUID_PACKAGES has exactly the documented members", () => {
    expect(LEGACY_FLUID_PACKAGES).toEqual(["$ZMCP_HELPERS", "$TMP"]);
  });

  it("RESERVED_OBJECT_PREFIXES has exactly the documented members", () => {
    expect(RESERVED_OBJECT_PREFIXES).toEqual(["ZCL_ZMCP_", "ZIF_ZMCP_"]);
  });
});

describe("ensureFluidPackage", () => {
  it("issues the create when the package is absent, naming FLUID_PACKAGE and $TMP as its super package", async () => {
    const { conn, server } = await wired([absentRoute]);
    const before = server.calls.length;

    await ensureFluidPackage(conn, gate());

    const creates = createsSince(server, before);
    expect(creates).toHaveLength(1);
    const body = creates[0]!.body ?? "";
    expect(body).toContain(`adtcore:name="${FLUID_PACKAGE}"`);
    expect(body).toContain('<pak:superPackage adtcore:name="$TMP"/>');
    expect(body).toContain('pak:name="LOCAL"');
  });

  it("issues no mutating request at all when the package already exists", async () => {
    const { conn, server } = await wired([existingRoute]);
    const before = server.calls.length;

    await ensureFluidPackage(conn, gate());

    const mutations = mutationsSince(server, before);
    expect(mutations).toEqual([]);
  });

  it("memoizes two sequential calls into exactly one create round trip", async () => {
    const { conn, server } = await wired([absentRoute]);
    const before = server.calls.length;

    await ensureFluidPackage(conn, gate());
    await ensureFluidPackage(conn, gate());

    expect(createsSince(server, before)).toHaveLength(1);
  });

  it("memoizes concurrent calls into exactly one create round trip", async () => {
    const { conn, server } = await wired([absentRoute]);
    const before = server.calls.length;
    const g = gate();

    await Promise.all([ensureFluidPackage(conn, g), ensureFluidPackage(conn, g), ensureFluidPackage(conn, g)]);

    expect(createsSince(server, before)).toHaveLength(1);
  });

  it("does not memoize a rejection — the next call retries and can succeed", async () => {
    const { conn, server } = await wired([absentThenFailOnceRoute()]);
    const before = server.calls.length;
    const g = gate();

    await expect(ensureFluidPackage(conn, g)).rejects.toBeTruthy();
    expect(createsSince(server, before)).toHaveLength(1);

    await ensureFluidPackage(conn, g);
    expect(createsSince(server, before)).toHaveLength(2);
  });

  it("resetFluidPackageMemo makes the next call re-probe", async () => {
    const { conn, server } = await wired([absentRoute]);
    const before = server.calls.length;
    const g = gate();

    await ensureFluidPackage(conn, g);
    expect(createsSince(server, before)).toHaveLength(1);

    resetFluidPackageMemo();
    await ensureFluidPackage(conn, g);
    expect(createsSince(server, before)).toHaveLength(2);
  });
});

// A live A4H finding: `ABAP_ALLOW_NAME_PREFIXES=Z,Y` is a perfectly ordinary
// operator setting, and `$ABAPSMITH_FLUID_API` never starts with either — it
// is `$`-prefixed by construction (see FLUID_PACKAGE's own doc comment). The
// old `createFluidPackage` asked the gate to judge the create BEFORE checking
// whether there was anything to create, so a warm system (package already
// there, nothing to write) was refused for a name it was never going to
// write. `zyGate` below is that exact operator setting, reused by both tests.
describe("ensureFluidPackage under a Z/Y-only name-prefix allowlist", () => {
  const zyGate = (): SafetyGate =>
    new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP", "$ABAPSMITH_FLUID_API"],
      allowNamePrefixes: ["Z", "Y"],
      writesLockedOut: false,
    });

  it("an already-present $ABAPSMITH_FLUID_API is accepted under a Z/Y-only name-prefix allowlist", async () => {
    const { conn, server } = await wired([existingRoute]);
    const before = server.calls.length;

    // Must resolve cleanly — nothing needs creating, so nothing should ever
    // reach the gate to be judged and refused.
    await expect(ensureFluidPackage(conn, zyGate())).resolves.toBeUndefined();

    // And in particular: no create POST was ever issued.
    expect(createsSince(server, before)).toHaveLength(0);
  });

  it("creating a missing $ABAPSMITH_FLUID_API still goes through the gate", async () => {
    const { conn, server } = await wired([absentRoute]);
    const before = server.calls.length;

    // The package genuinely does not exist here, so the create path is
    // exercised for real — and SafetyGate.evaluate's name-prefix rule (run
    // unconditionally, after the package-allowlist check, independent of
    // `exists`) judges $ABAPSMITH_FLUID_API against [Z, Y] and refuses it,
    // same as it would for any other $-prefixed create under this allowlist.
    // The point of this test is that the existence-probe fix does not also
    // remove the gate from the path that actually creates something.
    await expect(ensureFluidPackage(conn, zyGate())).rejects.toMatchObject({
      code: "SAFETY_DENIED",
    });

    expect(createsSince(server, before)).toHaveLength(0);
  });
});
