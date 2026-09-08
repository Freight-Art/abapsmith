/**
 * Where the fluid API's bridge classes actually land — `$ABAPSMITH_FLUID_API`,
 * not the legacy `$TMP` — and the refusal/relocation choreography around it.
 *
 * Offline only. The transport is faked through `ConnectionOptions.httpClient`
 * (same seam as test/run.test.ts) — nothing here touches SAP.
 */
import { describe, expect, it, beforeEach } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { HttpClientException } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { SafetyGate } from "../src/safety.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { isAbapError } from "../src/adt/errors.js";
import { deployBridge, runReport } from "../src/adt/run.js";
import { ENH_BRIDGE_PACKAGE, ENH_CREATE_PACKAGE, addBadiDefinition } from "../src/adt/enhancement-bridge.js";
import { resetFluidPackageMemo } from "../src/adt/fluid/package.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "secret",
    sid: "TST",
  });

/** A config that can actually write, and whose client the probe fixture can attribute. */
const writableCfg = (overrides: Partial<Config> = {}): Config =>
  ConfigSchema.parse({ ...cfg(), readOnly: false, client: "001", ...overrides });

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
  statusText = String(status),
): HttpClientResponse =>
  ({ status, statusText, body, headers }) as unknown as HttpClientResponse;

class RecordingClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(private readonly respond: (o: HttpClientOptions) => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    return this.respond(o);
  }
}

const notFound = (o: HttpClientOptions): never => {
  const r = resp(404, "not found");
  throw new HttpClientException("Request failed with status code 404", "404", 404, undefined, o, r);
};

/** `login()` and `dropSession()` both hit this URL — see abap-adt-api AdtHTTP. */
const SESSION_URL = "/sap/bc/adt/compatibility/graph";

const LOCK_XML =
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>H1</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/><IS_LOCAL>X</IS_LOCAL>` +
  `<IS_LINK_UP/><MODIFICATION_SUPPORT/></DATA></asx:values></asx:abap>`;

const OBJECT_XML = (name: string, type: string, packageName: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<adtcore:objectMetadata xmlns:adtcore="http://www.sap.com/adt/core" ` +
  `adtcore:name="${name}" adtcore:type="${type}">` +
  `<adtcore:packageRef adtcore:name="${packageName}"/>` +
  `</adtcore:objectMetadata>`;

const CLASS_COLLECTION = "/sap/bc/adt/oo/classes";
const classUri = (name: string): string => `${CLASS_COLLECTION}/${name.toLowerCase()}`;
const sourceUri = (name: string): string => `${classUri(name)}/source/main`;

/**
 * `INTF/OI`'s create collection — `abap-adt-api`'s `CreatableTypes` entry has
 * `creationPath: "oo/interfaces"` (objectcreator.js), matching `TYPES`'s
 * `INTF/OI` path `/sap/bc/adt/oo/interfaces/{name}` in src/adt/types.ts.
 */
const INTERFACE_COLLECTION = "/sap/bc/adt/oo/interfaces";

const bridgeSource = (className: string): string =>
  `CLASS ${className} DEFINITION PUBLIC FINAL CREATE PUBLIC.\n` +
  `  PUBLIC SECTION.\n    INTERFACES if_oo_adt_classrun.\n` +
  `ENDCLASS.\nCLASS ${className} IMPLEMENTATION.\n` +
  `  METHOD if_oo_adt_classrun~main.\n  ENDMETHOD.\nENDCLASS.`;

const allowAllGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: ["*"],
    allowNamePrefixes: ["*"],
    writesLockedOut: false,
  });

/** `allowAllGate` plus what `addBadiDefinition`'s `EnhancementIntent` gate needs. */
const enhancementGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: ["*"],
    allowNamePrefixes: ["*"],
    writesLockedOut: false,
    allowEnhancements: true,
    enhanceTargets: "customer",
  });

/**
 * `.connect()` needs an answer for the one system-role probe it fires — see
 * test/helpers/system-role-fake.ts. `routeSystemRoleProbe` supplies it without
 * this suite having to hand-roll the datapreview route itself.
 */
async function connected(
  respond: (o: HttpClientOptions) => HttpClientResponse,
): Promise<{ conn: AbapConnection; inner: RecordingClient }> {
  const inner = routeSystemRoleProbe(new RecordingClient(respond), { answer: "nonproductive" });
  const conn = new AbapConnection(writableCfg(), {
    httpClient: inner,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  inner.calls.length = 0; // only look at what the call under test itself does
  return { conn, inner };
}

/** A connection whose config alone should refuse — no request may ever be attempted. */
function unconnected(configOverrides: Partial<Config> = {}): { conn: AbapConnection; inner: RecordingClient } {
  const inner = new RecordingClient(() => resp(200, "<ok/>", { "content-type": "application/xml" }));
  const { abapMode, ...schemaOverrides } = configOverrides;
  const config: Config = { ...ConfigSchema.parse({ ...cfg(), ...schemaOverrides }), abapMode };
  const conn = new AbapConnection(config, {
    httpClient: inner,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  return { conn, inner };
}

/** Every non-classes route answers cleanly; every `/oo/classes/…` GET 404s. */
const respondBridgeMissing = (o: HttpClientOptions): HttpClientResponse => {
  if (o.url.includes(SESSION_URL)) {
    return resp(200, "<graph/>", { "content-type": "application/xml", "x-csrf-token": "TOKEN123" });
  }
  const action = (o.qs as Record<string, unknown> | undefined)?._action;
  if (action === "LOCK") return resp(200, LOCK_XML, { "content-type": "application/xml" });
  if (action === "UNLOCK") return resp(200, "", { "content-type": "text/plain" });
  if (o.url.includes("/oo/classes/") && (o.method ?? "GET").toUpperCase() === "GET") {
    return notFound(o);
  }
  return resp(200, "<ok/>", { "content-type": "application/xml" });
};

/**
 * A bridge class that already exists, stranded in `$TMP`, and stays there
 * until a DELETE for its own URI reaches the wire — after which its GETs 404,
 * modelling a clean relocate.
 */
function respondStrandedInTmp(className: string): (o: HttpClientOptions) => HttpClientResponse {
  let deleted = false;
  const classPath = classUri(className);
  const srcPath = sourceUri(className);
  const existingSource = bridgeSource(className);

  return (o: HttpClientOptions): HttpClientResponse => {
    if (o.url.includes(SESSION_URL)) {
      return resp(200, "<graph/>", { "content-type": "application/xml", "x-csrf-token": "TOKEN123" });
    }
    const method = (o.method ?? "GET").toUpperCase();
    const action = (o.qs as Record<string, unknown> | undefined)?._action;
    if (action === "LOCK") return resp(200, LOCK_XML, { "content-type": "application/xml" });
    if (action === "UNLOCK") return resp(200, "", { "content-type": "text/plain" });
    if (method === "DELETE" && o.url === classPath) {
      deleted = true;
      return resp(200, "", {});
    }
    if (o.url === classPath && method === "GET") {
      if (deleted) return notFound(o);
      return resp(200, OBJECT_XML(className, "CLAS/OC", "$TMP"), { "content-type": "application/xml" });
    }
    if (o.url === srcPath && method === "GET") {
      if (deleted) return notFound(o);
      return resp(200, existingSource, { "content-type": "text/plain" });
    }
    return resp(200, "<ok/>", { "content-type": "application/xml" });
  };
}

/** Every non-classes/interfaces route answers cleanly; both objects' GETs 404. */
const respondEnhAndBridgeMissing = (o: HttpClientOptions): HttpClientResponse => {
  if (o.url.includes(SESSION_URL)) {
    return resp(200, "<graph/>", { "content-type": "application/xml", "x-csrf-token": "TOKEN123" });
  }
  const action = (o.qs as Record<string, unknown> | undefined)?._action;
  if (action === "LOCK") return resp(200, LOCK_XML, { "content-type": "application/xml" });
  if (action === "UNLOCK") return resp(200, "", { "content-type": "text/plain" });
  const method = (o.method ?? "GET").toUpperCase();
  if (method === "GET" && (o.url.includes("/oo/classes/") || o.url.includes("/oo/interfaces/"))) {
    return notFound(o);
  }
  return resp(200, "<ok/>", { "content-type": "application/xml" });
};

beforeEach(() => {
  // Memoized per system per process (src/adt/fluid/package.ts) — would leak
  // "already ensured" across tests that use the same cfg.sid otherwise.
  resetFluidPackageMemo();
});

it("the run bridge is created in $ABAPSMITH_FLUID_API", async () => {
  const { conn, inner } = await connected(respondBridgeMissing);

  await runReport(conn, "ZMCP_PROBE_REP", allowAllGate()).catch(() => undefined);

  const create = inner.calls.find((c) => c.method === "POST" && c.url === CLASS_COLLECTION);
  expect(create).toBeDefined();
  expect(String(create?.body)).toContain('<adtcore:packageRef adtcore:name="$ABAPSMITH_FLUID_API"/>');
});

it("the enhancement bridge class is created in the fluid package", async () => {
  expect(ENH_BRIDGE_PACKAGE).toBe("$ABAPSMITH_FLUID_API");
  expect(ENH_CREATE_PACKAGE).toBe("$TMP");

  const { conn, inner } = await connected(respondBridgeMissing);
  const className = "ZCL_ZMCP_ENH_TEST";

  await deployBridge(conn, allowAllGate(), {
    className,
    source: bridgeSource(className),
    description: "abapsmith enhancement bridge for a fluid-package test",
    packageName: ENH_BRIDGE_PACKAGE,
    what: "Activation of the generated enhancement bridge",
    verify: () => true,
  }).catch(() => undefined);

  const create = inner.calls.find((c) => c.method === "POST" && c.url === CLASS_COLLECTION);
  expect(create).toBeDefined();
  expect(String(create?.body)).toContain('<adtcore:packageRef adtcore:name="$ABAPSMITH_FLUID_API"/>');
});

it("with ABAP_FLUID_API off, deployBridge refuses and nothing reaches the wire", async () => {
  const className = "ZCL_ZMCP_TEST";
  const { conn, inner } = unconnected({ fluidApi: false, readOnly: false });
  inner.calls.length = 0;

  const err = await deployBridge(conn, allowAllGate(), {
    className,
    source: bridgeSource(className),
    description: "test bridge",
    what: "test bridge activation",
    verify: () => true,
  }).catch((e: unknown) => e);

  expect(isAbapError(err)).toBe(true);
  if (!isAbapError(err)) return;
  expect(err.code).toBe("FLUID_API_DISABLED");
  expect(err.message).toContain(className);
  expect(err.details.objects).toContain(className);

  const mutations = inner.calls.filter(
    (c) => c.method === "PUT" || c.method === "POST" || String(c.url).includes("_action=LOCK"),
  );
  expect(mutations).toEqual([]);
  expect(inner.calls).toEqual([]);
});

it("the refusal names the tool that asked, not a hardcoded one", async () => {
  const className = "ZCL_ZMCP_TEST";
  const { conn, inner } = unconnected({ fluidApi: false, readOnly: false });
  inner.calls.length = 0;

  const err = await deployBridge(conn, allowAllGate(), {
    className,
    source: bridgeSource(className),
    description: "test bridge",
    what: "test bridge activation",
    caller: { tool: "abap_enh", action: "create_spot" },
    verify: () => true,
  }).catch((e: unknown) => e);

  expect(isAbapError(err)).toBe(true);
  if (!isAbapError(err)) return;
  expect(err.code).toBe("FLUID_API_DISABLED");
  expect(err.message).toContain("abap_enh create_spot");
  expect(err.message).not.toContain("abap_run");
  expect(err.details.tool).toBe("abap_enh");
  expect(err.details.action).toBe("create_spot");
  expect(inner.calls).toEqual([]);
});

it("ABAP_MODE=read refuses, naming cfg.abapMode", async () => {
  const className = "ZCL_ZMCP_TEST";
  const { conn, inner } = unconnected({ abapMode: "read" });
  inner.calls.length = 0;

  const err = await deployBridge(conn, allowAllGate(), {
    className,
    source: bridgeSource(className),
    description: "test bridge",
    what: "test bridge activation",
    verify: () => true,
  }).catch((e: unknown) => e);

  expect(isAbapError(err)).toBe(true);
  if (!isAbapError(err)) return;
  expect(err.code).toBe("FLUID_API_DISABLED");
  expect(err.details.field).toBe("cfg.abapMode");
  expect(err.details.reason).toBe("read-only");
  expect(inner.calls).toEqual([]);
});

it("a productive system refuses, naming gate.config.productive", async () => {
  const className = "ZCL_ZMCP_TEST";
  const { conn, inner } = unconnected({ readOnly: false });
  const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"], productive: true });
  inner.calls.length = 0;

  const err = await deployBridge(conn, gate, {
    className,
    source: bridgeSource(className),
    description: "test bridge",
    what: "test bridge activation",
    verify: () => true,
  }).catch((e: unknown) => e);

  expect(isAbapError(err)).toBe(true);
  if (!isAbapError(err)) return;
  expect(err.code).toBe("FLUID_API_DISABLED");
  expect(err.details.field).toBe("gate.config.productive");
  expect(err.details.reason).toBe("read-only");
  expect(inner.calls).toEqual([]);
});

it("a productive system refuses even with the flag on", async () => {
  const className = "ZCL_ZMCP_TEST";
  const { conn, inner } = unconnected({ fluidApi: true, readOnly: false });
  const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"], productive: true });
  inner.calls.length = 0;

  const err = await deployBridge(conn, gate, {
    className,
    source: bridgeSource(className),
    description: "test bridge",
    what: "test bridge activation",
    verify: () => true,
  }).catch((e: unknown) => e);

  expect(isAbapError(err)).toBe(true);
  if (!isAbapError(err)) return;
  expect(err.code).toBe("FLUID_API_DISABLED");
  expect(err.details.field).toBe("gate.config.productive");
  expect(err.details.flagEnabled).toBe(true);
  expect(inner.calls).toEqual([]);
});

it("a bridge stranded in $TMP is deleted and recreated in the fluid package", async () => {
  const className = "ZCL_ZMCP_STRAY";
  const { conn, inner } = await connected(respondStrandedInTmp(className));

  const result = await deployBridge(conn, allowAllGate(), {
    className,
    source: bridgeSource(className),
    description: "relocated fluid bridge",
    what: "Activation of the relocated bridge",
    verify: () => true,
  }).catch((e: unknown) => e);

  expect(isAbapError(result) && result.code).not.toBe("BAD_INPUT");

  const del = inner.calls.find((c) => c.method === "DELETE" && c.url === classUri(className));
  expect(del).toBeDefined();

  const create = inner.calls.find((c) => c.method === "POST" && c.url === CLASS_COLLECTION);
  expect(create).toBeDefined();
  expect(String(create?.body)).toContain('<adtcore:packageRef adtcore:name="$ABAPSMITH_FLUID_API"/>');
});

it("an object that is not a fluid-owned name is NOT relocated", async () => {
  const className = "ZCL_CUSTOM_HELPER";
  const { conn, inner } = await connected(respondStrandedInTmp(className));

  const err = await deployBridge(conn, allowAllGate(), {
    className,
    source: bridgeSource(className),
    description: "not a fluid-owned bridge",
    what: "Activation attempt",
    verify: () => true,
  }).catch((e: unknown) => e);

  expect(isAbapError(err)).toBe(true);
  if (!isAbapError(err)) return;
  expect(err.code).toBe("BAD_INPUT");

  const del = inner.calls.find((c) => c.method === "DELETE" && c.url === classUri(className));
  expect(del).toBeUndefined();
});

/**
 * Live capture shape (batch-delete-session-per-entry.test.ts's
 * `ICMENOSESSION_RESPONSE`, same header pair): a 400 whose body fails to
 * parse as ADT XML, which is the one shape `classifySessionFailure` — and the
 * connection's own wire-level death detector — can see.
 */
const ICMENOSESSION_RESPONSE = (): HttpClientResponse =>
  resp(400, "Session Timed Out — ICM: no session (not XML)", {
    "content-type": "text/html",
    "x-sap-icm-err-id": "ICMENOSESSION",
    "sap-err-id": "ICMENOSESSION",
  });

/**
 * `respondStrandedInTmp`, but the class-path GET `resolveWriteTarget` issues
 * right after the DELETE dies with the session-death shape `diesTimes` times
 * before it starts answering normally — modelling the live A4H finding that
 * deleting a class tears the session down, so the very next request on those
 * cookies gets `SESSION_DEAD`. A hit on `SESSION_URL` (the login `connect()`
 * issues) does not by itself clear the count: `diesTimes: 2` keeps the class
 * GET dying even across a reconnect, for the not-a-loop test.
 */
function respondStrandedInTmpSessionDies(
  className: string,
  diesTimes: number,
): (o: HttpClientOptions) => HttpClientResponse {
  let deleted = false;
  let deathsLeft = diesTimes;
  const classPath = classUri(className);
  const srcPath = sourceUri(className);
  const existingSource = bridgeSource(className);

  return (o: HttpClientOptions): HttpClientResponse => {
    if (o.url.includes(SESSION_URL)) {
      return resp(200, "<graph/>", { "content-type": "application/xml", "x-csrf-token": "TOKEN123" });
    }
    const method = (o.method ?? "GET").toUpperCase();
    const action = (o.qs as Record<string, unknown> | undefined)?._action;
    if (action === "LOCK") return resp(200, LOCK_XML, { "content-type": "application/xml" });
    if (action === "UNLOCK") return resp(200, "", { "content-type": "text/plain" });
    if (method === "DELETE" && o.url === classPath) {
      deleted = true;
      return resp(200, "", {});
    }
    if (o.url === classPath && method === "GET") {
      if (deleted && deathsLeft > 0) {
        deathsLeft -= 1;
        return ICMENOSESSION_RESPONSE();
      }
      if (deleted) return notFound(o);
      return resp(200, OBJECT_XML(className, "CLAS/OC", "$TMP"), { "content-type": "application/xml" });
    }
    if (o.url === srcPath && method === "GET") {
      if (deleted) return notFound(o);
      return resp(200, existingSource, { "content-type": "text/plain" });
    }
    return resp(200, "<ok/>", { "content-type": "application/xml" });
  };
}

it("a bridge stranded in $TMP survives the delete killing the session: one revive, then the recreate succeeds", async () => {
  const className = "ZCL_ZMCP_STRAY2";
  const { conn, inner } = await connected(respondStrandedInTmpSessionDies(className, 1));

  const result = await deployBridge(conn, allowAllGate(), {
    className,
    source: bridgeSource(className),
    description: "relocated fluid bridge, session died mid-relocate",
    what: "Activation of the relocated bridge",
    verify: () => true,
  });

  expect(result.write.created).toBe(true);
  expect(result.target.packageName).toBe("$ABAPSMITH_FLUID_API");

  const delIdx = inner.calls.findIndex((c) => c.method === "DELETE" && c.url === classUri(className));
  expect(delIdx).toBeGreaterThanOrEqual(0);
  const create = inner.calls.find((c) => c.method === "POST" && c.url === CLASS_COLLECTION);
  expect(create).toBeDefined();
  expect(String(create?.body)).toContain('<adtcore:packageRef adtcore:name="$ABAPSMITH_FLUID_API"/>');

  // Exactly one revive: one login after the DELETE, sitting strictly between
  // the post-delete class GET that died and the one that succeeded. The
  // pre-delete existence-check GET (which is what discovered the object
  // stranded in $TMP in the first place) is deliberately excluded here.
  const after = inner.calls.slice(delIdx + 1);
  const classGets = after.filter(
    (c) => c.url === classUri(className) && (c.method ?? "GET").toUpperCase() === "GET",
  );
  expect(classGets.length).toBe(2);
  const logins = after.filter((c) => String(c.url).includes(SESSION_URL));
  expect(logins.length).toBe(1);

  const idxFirstGet = after.indexOf(classGets[0]!);
  const idxLogin = after.findIndex((c) => String(c.url).includes(SESSION_URL));
  const idxSecondGet = after.lastIndexOf(classGets[1]!);
  expect(idxFirstGet).toBeGreaterThanOrEqual(0);
  expect(idxFirstGet).toBeLessThan(idxLogin);
  expect(idxLogin).toBeLessThan(idxSecondGet);
});

it("a second consecutive session death on the retry is not swallowed by a second reconnect", async () => {
  const className = "ZCL_ZMCP_STRAY3";
  const { conn, inner } = await connected(respondStrandedInTmpSessionDies(className, 2));

  const err = await deployBridge(conn, allowAllGate(), {
    className,
    source: bridgeSource(className),
    description: "relocated fluid bridge, session dies twice",
    what: "Activation of the relocated bridge",
    verify: () => true,
  }).catch((e: unknown) => e);

  expect(isAbapError(err)).toBe(true);
  if (!isAbapError(err)) return;
  expect(err.code).toBe("SESSION_DEAD");

  // Exactly one reconnect attempted — the second death is not itself
  // retried. Same pre-delete exclusion as the sibling test above.
  const delIdx = inner.calls.findIndex((c) => c.method === "DELETE" && c.url === classUri(className));
  expect(delIdx).toBeGreaterThanOrEqual(0);
  const after = inner.calls.slice(delIdx + 1);
  const classGets = after.filter(
    (c) => c.url === classUri(className) && (c.method ?? "GET").toUpperCase() === "GET",
  );
  expect(classGets.length).toBe(2);
  const logins = after.filter((c) => String(c.url).includes(SESSION_URL));
  expect(logins.length).toBe(1);
});

it("the user's enhancement objects still land in $TMP while the bridge goes to the fluid package", async () => {
  const { conn, inner } = await connected(respondEnhAndBridgeMissing);

  await addBadiDefinition(conn, enhancementGate(), {
    spotName: "ZENH_SPOT_TEST",
    badiName: "ZENH_BADI_TEST",
    interfaceName: "ZIF_ENH_MARKER_TEST",
    singleUse: true,
    shortText: "fluid-package split test",
    affects: { name: "ZCL_CUSTOM_TARGET", packageName: "$TMP" },
  }).catch(() => undefined);

  // H21 marker interface (ENH_CREATE_PACKAGE) — the user's own content.
  const interfaceCreate = inner.calls.find((c) => c.method === "POST" && c.url === INTERFACE_COLLECTION);
  expect(interfaceCreate).toBeDefined();
  expect(String(interfaceCreate?.body)).toContain('<adtcore:packageRef adtcore:name="$TMP"/>');
  expect(String(interfaceCreate?.body)).not.toContain("$ABAPSMITH_FLUID_API");

  // The generated bridge class (ENH_BRIDGE_PACKAGE) — abapsmith's own scaffolding.
  const classCreate = inner.calls.find((c) => c.method === "POST" && c.url === CLASS_COLLECTION);
  expect(classCreate).toBeDefined();
  expect(String(classCreate?.body)).toContain('<adtcore:packageRef adtcore:name="$ABAPSMITH_FLUID_API"/>');
});
