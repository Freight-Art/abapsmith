/**
 * `VIEW/DV` and `TRAN/T` bridge deletes issue no CTS call, so `view-delete.ts`
 * and `tran-delete.ts` gate them with `corr: { kind: "local" }`. This file
 * pins that a PINNED `ABAP_ALLOW_TRANSPORTS` (one that does not list `auto`)
 * no longer refuses either delete, that the same pinned list still refuses a
 * real CTS-touching delete exactly as before — both via `gate.evaluate`
 * directly and via `deletePackageViaBridge`'s real `corr: {kind:"transport"}`
 * call — and that an explicit deny-all list still wins over the `local`
 * presentation.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { SafetyGate } from "../src/safety.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { isAbapError, type AbapError } from "../src/adt/errors.js";
import { CLASSIC_BODY_CLASS } from "../src/adt/fluid/builtin/classic.js";
import { resetFluidEnsureState } from "../src/adt/fluid/ensure.js";
import { FLUID_PACKAGE, resetFluidPackageMemo } from "../src/adt/fluid/package.js";
import { deleteClassicViewViaBridge, type ViewDeleteParams } from "../src/adt/view-delete.js";
import {
  deleteTransactionViaBridge,
  type TransactionDeleteBridgeParams,
} from "../src/adt/tran-delete.js";
import { deletePackageViaBridge } from "../src/adt/package-delete.js";
import { serverPackage, type ServerPackage } from "../src/adt/resolved-package.js";
import type { VerifyOutcome } from "../src/adt/write-verify.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";
import { classicFake, useFluidState } from "./helpers/fluid-classic-fake.js";

// ---------------------------------------------------------------------------
// Fake transport — same shape as test/view-delete.test.ts / test/tran-delete.test.ts
// ---------------------------------------------------------------------------

let fluidState: ReturnType<typeof useFluidState>;

beforeEach(() => {
  fluidState = useFluidState();
  resetFluidEnsureState();
  resetFluidPackageMemo();
});

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "secret",
    sid: "TST",
    client: "001",
    readOnly: false,
    stateDir: fluidState.dir(),
  });

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
  statusText = String(status),
): HttpClientResponse => ({ status, statusText, body, headers }) as unknown as HttpClientResponse;

class RecordingClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(private readonly respond: (o: HttpClientOptions) => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    return this.respond(o);
  }
}

const SESSION_URL = "/sap/bc/adt/compatibility/graph";

/** Session/discovery/ato-settings plumbing shared by every test below — deploy/classrun routing comes from classicFake. */
function sharedRoute(o: HttpClientOptions): HttpClientResponse | undefined {
  if (o.url.includes(SESSION_URL)) {
    return resp(200, "<graph/>", { "content-type": "application/xml", "x-csrf-token": "TOKEN123" });
  }
  if (o.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  if (o.url.includes("/ato/settings")) return resp(200, "<settings/>", { "content-type": "application/xml" });
  return undefined;
}

function combine(
  ...routes: Array<(o: HttpClientOptions) => HttpClientResponse | undefined>
): (o: HttpClientOptions) => HttpClientResponse {
  return (o: HttpClientOptions) => {
    for (const r of routes) {
      const hit = r(o);
      if (hit) return hit;
    }
    throw new Error(`unrouted request: ${(o.method ?? "GET").toUpperCase()} ${o.url}`);
  };
}

async function connected(
  route: (o: HttpClientOptions) => HttpClientResponse,
): Promise<{ conn: AbapConnection; inner: RecordingClient }> {
  const inner = new RecordingClient(route);
  const conn = new AbapConnection(cfg(), {
    httpClient: inner,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  inner.calls.length = 0;
  return { conn, inner };
}

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  if (!e || !isAbapError(e)) throw new Error(`expected an AbapError, got ${String(e)}`);
  return e;
};

// ---------------------------------------------------------------------------
// Fixtures — synthetic request numbers, A4HK900001-style (test/config-transports.test.ts)
// ---------------------------------------------------------------------------

const VIEW = "ZTM_TESTVIEW";
const VIEW_PKG = "ZTM_TESTPKG";
const TCODE = "ZTM_CARRIERS";
const TRAN_PKG = "ZTM";
const PKGDEL_PKG = "ZTM_PKGDEL";
const PINNED = ["A4HK900001"];
const NOT_PINNED_CORR = "A4HK900099";

const VIEW_SERVER_PKG: ServerPackage = (() => {
  const outcome: VerifyOutcome = {
    status: "confirmed",
    uri: "/sap/bc/adt/vit/wb/object_type/viewdv/object_name/ZTM_TESTVIEW",
    via: "vit-bridge",
    packageName: VIEW_PKG,
  };
  const p = serverPackage(outcome);
  if (!p) throw new Error("test fixture: serverPackage for the view unexpectedly undefined");
  return p;
})();

const TRAN_SERVER_PKG: ServerPackage = (() => {
  const outcome: VerifyOutcome = {
    status: "confirmed",
    uri: `/sap/bc/adt/vit/wb/object_type/tran/object_name/${TCODE}`,
    via: "vit-bridge",
    packageName: TRAN_PKG,
  };
  const p = serverPackage(outcome);
  if (!p) throw new Error("test fixture: serverPackage for the transaction unexpectedly undefined");
  return p;
})();

const VIEW_PARAMS: ViewDeleteParams = { viewName: VIEW, packageName: VIEW_SERVER_PKG };
const TRAN_PARAMS: TransactionDeleteBridgeParams = { tcode: TCODE, packageName: TRAN_SERVER_PKG };

// ---------------------------------------------------------------------------
// 1 — pin: a classic-view bridge delete is not refused under a PINNED allowlist
// ---------------------------------------------------------------------------

describe("pin: deleteClassicViewViaBridge proceeds under a pinned ABAP_ALLOW_TRANSPORTS that does not list auto", () => {
  it("resolves VIEW-DELETED/VIEW-GONE and actually deploys+runs the bridge, rather than being refused SAFETY_DENIED", async () => {
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: [FLUID_PACKAGE, VIEW_PKG],
      // $ is outside the default Z/Y customer namespace, same as ensureHelperPackage's ALLOW_GATE
      // (test/helper-package.test.ts) — needed for the cold-path create of $ABAPSMITH_FLUID_API.
      allowNamePrefixes: ["*"],
      allowTransports: PINNED,
      writesLockedOut: false,
    });
    const fake = classicFake({ action: "delete_view", lines: () => ["VIEW-DELETED", "VIEW-GONE"] });
    const route = combine(fake.route, sharedRoute);
    const { conn } = await connected(route);
    const { transcript } = await deleteClassicViewViaBridge(conn, gate, VIEW_PARAMS);
    expect(transcript.tags).toEqual(["VIEW-DELETED", "VIEW-GONE"]);
    expect(transcript.errorLine).toBeUndefined();
    expect(fake.deployed()).toEqual(expect.arrayContaining([CLASSIC_BODY_CLASS]));
    expect(fake.sourceOf(CLASSIC_BODY_CLASS)).toBeDefined();
    expect(fake.invoker()).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2 — pin: same, for a transaction bridge delete
// ---------------------------------------------------------------------------

describe("pin: deleteTransactionViaBridge proceeds under a pinned ABAP_ALLOW_TRANSPORTS that does not list auto", () => {
  it("resolves TRAN-DELETED/TRAN-GONE and actually deploys+runs the bridge, rather than being refused SAFETY_DENIED", async () => {
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: [FLUID_PACKAGE, TRAN_PKG],
      // $ is outside the default Z/Y customer namespace, same as ensureHelperPackage's ALLOW_GATE
      // (test/helper-package.test.ts) — needed for the cold-path create of $ABAPSMITH_FLUID_API.
      allowNamePrefixes: ["*"],
      allowTransports: PINNED,
      writesLockedOut: false,
    });
    const fake = classicFake({ action: "delete_transaction", lines: () => ["TRAN-DELETED", "TRAN-GONE"] });
    const route = combine(fake.route, sharedRoute);
    const { conn } = await connected(route);
    const { transcript } = await deleteTransactionViaBridge(conn, gate, TRAN_PARAMS);
    expect(transcript.tags).toEqual(["TRAN-DELETED", "TRAN-GONE"]);
    expect(transcript.errorLine).toBeUndefined();
    expect(fake.deployed()).toEqual(expect.arrayContaining([CLASSIC_BODY_CLASS]));
    expect(fake.sourceOf(CLASSIC_BODY_CLASS)).toBeDefined();
    expect(fake.invoker()).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 3 — pin: the same pinned allowlist still refuses a delete that DOES use CTS
// ---------------------------------------------------------------------------

describe("pin: A4HK900001 does not leak to a delete that actually registers on a transport", () => {
  it("SafetyGate refuses op 'delete' on a transportable package with an auto-resolved corr, rule 'transport allowlist', code SAFETY_DENIED", () => {
    // No `corr` supplied — step 10 synthesises {kind:"transport", corrNr:"auto",
    // source:"auto"}, exactly what a real CTS-touching delete looks like to the
    // gate when it lets the server auto-select/auto-create the request. The
    // `local` presentation used by view-delete.ts/tran-delete.ts must not
    // widen this case.
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: [VIEW_PKG],
      allowTransports: PINNED,
      writesLockedOut: false,
    });
    const d = gate.evaluate("delete", { type: "VIEW/DV", name: VIEW, packageName: VIEW_PKG });
    expect(d.allowed).toBe(false);
    expect(d.rule).toBe("transport allowlist");
    expect(d.code).toBe("SAFETY_DENIED");
  });
});

// ---------------------------------------------------------------------------
// 4 — pin: an explicit deny-all still refuses a transportable VIEW/DV delete
// ---------------------------------------------------------------------------

describe("pin: ABAP_ALLOW_TRANSPORTS=[] (explicit deny-all) still refuses a transportable VIEW/DV bridge delete", () => {
  it("deleteClassicViewViaBridge is refused SAFETY_DENIED, rule 'transport allowlist (fail closed)', zero HTTP requests", async () => {
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: [FLUID_PACKAGE, VIEW_PKG],
      allowTransports: [],
      writesLockedOut: false,
    });
    const fake = classicFake({ action: "delete_view", lines: () => ["VIEW-DELETED", "VIEW-GONE"] });
    const route = combine(fake.route, sharedRoute);
    const { conn, inner } = await connected(route);
    const err = await catchErr(deleteClassicViewViaBridge(conn, gate, VIEW_PARAMS));
    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.details.rule).toBe("transport allowlist (fail closed)");
    expect(inner.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5 — pin: the same leak-pin, exercised through a real sibling gate call
// ---------------------------------------------------------------------------

describe("pin: A4HK900001 does not leak into deletePackageViaBridge's real corr: {kind:\"transport\"} gate call", () => {
  it("a DEVC/K delete naming a request NOT on the pinned list is refused SAFETY_DENIED, rule 'transport allowlist', zero HTTP requests", async () => {
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: [FLUID_PACKAGE, PKGDEL_PKG],
      allowTransports: PINNED,
      writesLockedOut: false,
    });
    const fake = classicFake({ action: "delete_package", lines: () => ["PKG-EMPTY", "PKG-DELETED", "PKG-GONE"] });
    const route = combine(fake.route, sharedRoute);
    const { conn, inner } = await connected(route);
    const err = await catchErr(
      deletePackageViaBridge(conn, gate, { packageName: PKGDEL_PKG, corrNr: NOT_PINNED_CORR }),
    );
    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.details.rule).toBe("transport allowlist");
    expect(inner.calls.length).toBe(0);
  });
});
