/**
 * `VIEW/DV` (classic database view) delete bridge — offline; mirrors
 * `test/package-delete.test.ts`'s fixture/gate/route style.
 */
import { describe, expect, it } from "vitest";
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
import { isAbapError, type AbapError } from "../src/adt/errors.js";
import {
  DDIC_BRIDGE_CLASS,
  DDIC_BRIDGE_PACKAGE,
  DDIC_ERR_PREFIX,
  DDIC_TAGS,
} from "../src/adt/ddic-bridge.js";
import {
  VIEW_DELETE_DATA_LINES,
  deleteClassicViewViaBridge,
  viewDeleteFragment,
  type ViewDeleteParams,
} from "../src/adt/view-delete.js";
import { serverPackage, type ServerPackage } from "../src/adt/resolved-package.js";
import type { VerifyOutcome } from "../src/adt/write-verify.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// Fake transport — same shape as test/package-delete.test.ts
// ---------------------------------------------------------------------------

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "secret",
    sid: "TST",
    client: "001",
    readOnly: false,
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
const CLASS_COLLECTION = "/sap/bc/adt/oo/classes";
const BRIDGE = DDIC_BRIDGE_CLASS.deleteView;

const LOCK_XML = (handle = "H1") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

/** GET-404 -> POST-create -> LOCK -> PUT -> UNLOCK for the bridge class itself. */
function objectHappyPath(collectionUrl: string, name: string): (o: HttpClientOptions) => HttpClientResponse | undefined {
  const objUrl = `${collectionUrl}/${name.toLowerCase()}`;
  const sourceUri = `${objUrl}/source/main`;
  return (o: HttpClientOptions) => {
    const qs = (o.qs ?? {}) as Record<string, string>;
    const method = (o.method ?? "GET").toUpperCase();
    if (o.url === objUrl && method === "GET" && !qs._action) {
      const r = resp(404, "<exc:exception/>", { "content-type": "application/xml" });
      throw new HttpClientException("Request failed with status code 404", "404", 404, undefined, o, r);
    }
    if (o.url === collectionUrl && method === "POST") return resp(200, "", {});
    if (o.url === objUrl && qs._action === "LOCK") return resp(200, LOCK_XML(), { "content-type": "application/xml" });
    if (o.url === objUrl && qs._action === "UNLOCK") return resp(200, "", { "content-type": "text/plain" });
    if (o.url === sourceUri && method === "PUT") return resp(200, "", { "content-type": "text/plain" });
    return undefined;
  };
}

/** Session/discovery/activation/classrun plumbing shared by every test below. */
function sharedRoute(
  classrun: (o: HttpClientOptions) => HttpClientResponse | undefined,
): (o: HttpClientOptions) => HttpClientResponse | undefined {
  return (o: HttpClientOptions) => {
    if (o.url.startsWith("/sap/bc/adt/oo/classrun/")) return classrun(o);
    if (o.url.includes(SESSION_URL)) {
      return resp(200, "<graph/>", { "content-type": "application/xml", "x-csrf-token": "TOKEN123" });
    }
    if (o.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
    if (o.url.includes("/ato/settings")) return resp(200, "<settings/>", { "content-type": "application/xml" });
    if (o.url.includes("/sap/bc/adt/activation")) return resp(200, "", { "content-length": "0" });
    return undefined;
  };
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

/** A bare classrun body — see test/package-delete.test.ts's identical helper. */
function classrunOutput(lines: readonly string[]): (o: HttpClientOptions) => HttpClientResponse {
  const body = lines.join("\n");
  return () => resp(200, body, { "content-type": "text/plain" });
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
// Gates
// ---------------------------------------------------------------------------

const VIEW = "ZTM_TESTVIEW";
const PKG = "ZTM_TESTPKG";

/** Allows both the bridge class ($TMP) and the view's own package. */
const allowingGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: [DDIC_BRIDGE_PACKAGE, PKG],
    allowTransports: ["*"],
    writesLockedOut: false,
  });

/** Allows the bridge class only — the domain gate must refuse the view delete before anything reaches the wire. */
const bridgeOnlyGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: [DDIC_BRIDGE_PACKAGE],
    allowTransports: ["*"],
    writesLockedOut: false,
  });

/** Mirrors test/resolved-package.test.ts's `confirmed` helper — the only legitimate way to mint a `ServerPackage`. */
const confirmedOutcome = (packageName: string | undefined): VerifyOutcome => ({
  status: "confirmed",
  uri: "/sap/bc/adt/vit/wb/object_type/viewdv/object_name/ZTM_TESTVIEW",
  via: "vit-bridge",
  packageName,
});

const SERVER_PKG: ServerPackage = serverPackage(confirmedOutcome(PKG))!;

const PARAMS: ViewDeleteParams = { viewName: VIEW, packageName: SERVER_PKG };

// ---------------------------------------------------------------------------
// 1 - every tag the fragment writes is a tag the shared parser knows
// ---------------------------------------------------------------------------

describe("viewDeleteFragment only ever writes tags DDIC_TAGS declares", () => {
  it("VIEW-DELETED and VIEW-GONE, and nothing else — asserted as a set", () => {
    const lines = viewDeleteFragment(PARAMS);
    const written = new Set(
      lines
        .map((l) => /out->write\(\s*'([A-Z-]+)'\s*\)/.exec(l)?.[1])
        .filter((t): t is string => t !== undefined),
    );
    expect(written).toEqual(new Set(["VIEW-DELETED", "VIEW-GONE"]));
    for (const tag of written) {
      expect(DDIC_TAGS as readonly string[]).toContain(tag);
    }
  });
});

// ---------------------------------------------------------------------------
// 2 - input validation, refused before any network call
// ---------------------------------------------------------------------------

describe("a malformed view name is refused before any network call", () => {
  const offline = null as unknown as AbapConnection;
  const bad = ["Z'FOO", "Z.FOO", "Z\nFOO", "Z FOO"];

  it.each(bad)("%s is refused with BAD_INPUT, not escaped or stripped", async (viewName) => {
    const err = await catchErr(
      deleteClassicViewViaBridge(offline, allowingGate(), { viewName, packageName: SERVER_PKG }),
    );
    expect(err.code).toBe("BAD_INPUT");
  });

  it("zero requests reach the fake server for any of these", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(classrunOutput(["VIEW-DELETED", "VIEW-GONE"])),
    );
    const { conn, inner } = await connected(route);
    for (const viewName of bad) {
      await catchErr(deleteClassicViewViaBridge(conn, allowingGate(), { viewName, packageName: SERVER_PKG }));
    }
    expect(inner.calls.length).toBe(0);
  });

  it("a view name longer than 30 characters is refused", async () => {
    const tooLong = `Z${"A".repeat(30)}`;
    const err = await catchErr(
      deleteClassicViewViaBridge(offline, allowingGate(), { viewName: tooLong, packageName: SERVER_PKG }),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("30");
  });
});

// ---------------------------------------------------------------------------
// 3 - safety gate runs first, zero-network, and sees op "delete"
// ---------------------------------------------------------------------------

describe("safety gate — asserted as a delete on the domain object, and runs FIRST (zero-network)", () => {
  it("gate.assert sees op 'delete' with type VIEW/DV and the view's own name, not 'write'", async () => {
    const seen: Array<{ op: string; type?: string; name?: string }> = [];
    class RecordingGate extends SafetyGate {
      override assert(
        op: Parameters<SafetyGate["assert"]>[0],
        obj?: Parameters<SafetyGate["assert"]>[1],
        opts?: Parameters<SafetyGate["assert"]>[2],
      ): void {
        if (obj?.type === "VIEW/DV") seen.push({ op, type: obj.type, name: obj.name });
        super.assert(op, obj, opts);
      }
    }
    const gate = new RecordingGate({
      readOnly: false,
      allowPackages: [DDIC_BRIDGE_PACKAGE, PKG],
      allowTransports: ["*"],
      writesLockedOut: false,
    });
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(classrunOutput(["VIEW-DELETED", "VIEW-GONE"])),
    );
    const { conn } = await connected(route);
    await deleteClassicViewViaBridge(conn, gate, PARAMS);
    expect(seen).toEqual([{ op: "delete", type: "VIEW/DV", name: VIEW }]);
  });

  it("a gate that refuses the view's package refuses the whole call with ZERO HTTP requests", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(classrunOutput(["VIEW-DELETED", "VIEW-GONE"])),
    );
    const { conn, inner } = await connected(route);
    const err = await catchErr(deleteClassicViewViaBridge(conn, bridgeOnlyGate(), PARAMS));
    expect(err.code).toBe("SAFETY_DENIED");
    expect(inner.calls.length).toBe(0);
  });

  it("a readOnly gate refuses too, zero requests made", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(classrunOutput(["VIEW-DELETED", "VIEW-GONE"])),
    );
    const { conn, inner } = await connected(route);
    const readOnly = new SafetyGate({
      readOnly: true,
      allowPackages: [DDIC_BRIDGE_PACKAGE, PKG],
      writesLockedOut: false,
    });
    const err = await catchErr(deleteClassicViewViaBridge(conn, readOnly, PARAMS));
    expect(err).toBeTruthy();
    expect(inner.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3b - a caller-claimed (unbranded) package is refused before the gate is
//      even consulted — a doc comment cannot enforce this, only the type +
//      runtime assertion can (see src/adt/resolved-package.ts)
// ---------------------------------------------------------------------------

describe("packageName must be a genuine server-resolved ServerPackage, not a caller-claimed string", () => {
  it("a value forced through `as unknown as ServerPackage` (how a real bypass looks) is refused SAFETY_DENIED/PACKAGE_UNKNOWN, the gate is NEVER consulted, and no ABAP is generated", async () => {
    let gateCalls = 0;
    class RecordingGate extends SafetyGate {
      override assert(...args: Parameters<SafetyGate["assert"]>): void {
        gateCalls++;
        super.assert(...args);
      }
    }
    const gate = new RecordingGate({
      readOnly: false,
      allowPackages: [DDIC_BRIDGE_PACKAGE, PKG],
      allowTransports: ["*"],
      writesLockedOut: false,
    });
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(classrunOutput(["VIEW-DELETED", "VIEW-GONE"])),
    );
    const { conn, inner } = await connected(route);
    const forged = PKG as unknown as ServerPackage;
    const err = await catchErr(deleteClassicViewViaBridge(conn, gate, { viewName: VIEW, packageName: forged }));
    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.details.reason).toBe("PACKAGE_UNKNOWN");
    // The load-bearing assertions: not just "it threw", but that it threw
    // BEFORE the gate saw anything and before any HTTP request was made.
    expect(gateCalls).toBe(0);
    expect(inner.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4 - the sy-subrc guard sits between the call and the VIEW-DELETED tag
// ---------------------------------------------------------------------------

describe("viewDeleteFragment generates the expected ABAP (closed template — regression guard)", () => {
  it("DDIF_VIEW_DELETE call, THEN an IF sy-subrc <> 0 guard, THEN the VIEW-DELETED tag — in that order", () => {
    const lines = viewDeleteFragment(PARAMS);
    const callIdx = lines.findIndex((l) => l.includes("CALL FUNCTION 'DDIF_VIEW_DELETE'"));
    const guardIdx = lines.findIndex((l, i) => i > callIdx && l.trim() === "IF sy-subrc <> 0.");
    const tagIdx = lines.findIndex((l, i) => i > guardIdx && l.includes("out->write( 'VIEW-DELETED' )"));
    expect(callIdx).toBeGreaterThanOrEqual(0);
    expect(guardIdx).toBeGreaterThan(callIdx);
    expect(tagIdx).toBeGreaterThan(guardIdx);
  });

  it("the call carries only NAME and EXCEPTIONS OTHERS = 1 — no STATE, no named exception", () => {
    const lines = viewDeleteFragment(PARAMS);
    const start = lines.findIndex((l) => l.includes("CALL FUNCTION 'DDIF_VIEW_DELETE'"));
    const end = lines.findIndex((l, i) => i >= start && l.trim().endsWith("."));
    const stmt = lines.slice(start, end + 1).join("\n");
    expect(stmt).toContain(`EXPORTING name = '${VIEW}'`);
    expect(stmt).not.toContain("STATE");
    expect(stmt).toContain("EXCEPTIONS OTHERS = 1.");
  });

  it('every comment uses " — never a *-style comment', () => {
    const lines = viewDeleteFragment(PARAMS);
    expect(lines.filter((l) => l.trim().startsWith("*"))).toEqual([]);
    expect(lines.some((l) => l.trim().startsWith('"'))).toBe(true);
  });

  it("interpolates the view name where expected, and nowhere else for a different view", () => {
    const a = viewDeleteFragment({ viewName: "ZTM_ALPHA", packageName: SERVER_PKG }).join("\n");
    const b = viewDeleteFragment({ viewName: "ZTM_BETA", packageName: SERVER_PKG }).join("\n");
    expect(a).toContain("'ZTM_ALPHA'");
    expect(a).not.toContain("ZTM_BETA");
    expect(b).toContain("'ZTM_BETA'");
    expect(b).not.toContain("ZTM_ALPHA");
  });

  it("VIEW_DELETE_DATA_LINES declares the locals the fragment relies on", () => {
    expect(VIEW_DELETE_DATA_LINES).toContain("ls_dd25l TYPE dd25l.");
    expect(VIEW_DELETE_DATA_LINES).toContain("lv_dd25l_count TYPE i.");
  });
});

// ---------------------------------------------------------------------------
// 5 - partial delete: VIEW-DELETED without VIEW-GONE is a failure
//     (the most important test in this file)
// ---------------------------------------------------------------------------

describe("VIEW-DELETED without VIEW-GONE is a failure, not a partial success", () => {
  it("a transcript that stops after VIEW-DELETED (e.g. a default STATE that only deleted the inactive version) throws CHECK_FAILED naming the missing VIEW-GONE marker", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(classrunOutput(["VIEW-DELETED"])),
    );
    const { conn } = await connected(route);
    const err = await catchErr(deleteClassicViewViaBridge(conn, allowingGate(), PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("VIEW-GONE");
  });
});

// ---------------------------------------------------------------------------
// 6 - non-existent view: named refusal, not a generic missing-tag error
// ---------------------------------------------------------------------------

describe("a non-existent view produces a named refusal from beforeAssert, not a generic missing-tag CHECK_FAILED", () => {
  it("says the view does not exist, and carries the raw ABAP-side detail", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(classrunOutput([`${DDIC_ERR_PREFIX} view ${VIEW} does not exist`])),
    );
    const { conn } = await connected(route);
    const err = await catchErr(deleteClassicViewViaBridge(conn, allowingGate(), PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain(`${VIEW} does not exist`);
  });
});

// ---------------------------------------------------------------------------
// 7 - empty transcript, and a ZMCP-DDIC-ERR> transcript, are both failures
// ---------------------------------------------------------------------------

describe("empty and ZMCP-DDIC-ERR> transcripts are both failures", () => {
  it("an empty transcript (no tags at all) throws CHECK_FAILED, not a silent success", async () => {
    const route = combine(objectHappyPath(CLASS_COLLECTION, BRIDGE), sharedRoute(classrunOutput([])));
    const { conn } = await connected(route);
    const err = await catchErr(deleteClassicViewViaBridge(conn, allowingGate(), PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
  });

  it("the post-COMMIT DD25L row survives: still tagged an error, not swallowed", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(
        classrunOutput([
          "VIEW-DELETED",
          `${DDIC_ERR_PREFIX} delete of ${VIEW} reported no error but DD25L still has a row`,
        ]),
      ),
    );
    const { conn } = await connected(route);
    const err = await catchErr(deleteClassicViewViaBridge(conn, allowingGate(), PARAMS));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("DD25L still has a row");
  });
});

// ---------------------------------------------------------------------------
// 8 - happy path
// ---------------------------------------------------------------------------

describe("deleteClassicViewViaBridge happy path", () => {
  it("VIEW-DELETED, VIEW-GONE resolves; the deployed source carries DDIF_VIEW_DELETE, COMMIT WORK, and the DD25L re-read in that order", async () => {
    const route = combine(
      objectHappyPath(CLASS_COLLECTION, BRIDGE),
      sharedRoute(classrunOutput(["VIEW-DELETED", "VIEW-GONE"])),
    );
    const { conn, inner } = await connected(route);
    const { transcript } = await deleteClassicViewViaBridge(conn, allowingGate(), PARAMS);
    expect(transcript.tags).toEqual(["VIEW-DELETED", "VIEW-GONE"]);
    expect(transcript.errorLine).toBeUndefined();

    const sourceUri = `${CLASS_COLLECTION}/${BRIDGE.toLowerCase()}/source/main`;
    const put = inner.calls.find((c) => (c.method ?? "").toUpperCase() === "PUT" && c.url === sourceUri);
    const body = String(put?.body);
    const deleteIdx = body.indexOf("DDIF_VIEW_DELETE");
    const commitIdx = body.indexOf("COMMIT WORK.");
    const reselectIdx = body.indexOf("SELECT COUNT( * ) FROM dd25l");
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeGreaterThan(deleteIdx);
    expect(reselectIdx).toBeGreaterThan(commitIdx);
  });

  it("gates against the correct bridge class name (ZCL_ZMCP_DDIC_DVIEW)", async () => {
    expect(BRIDGE).toBe("ZCL_ZMCP_DDIC_DVIEW");
  });
});
