/**
 * `VIEW/DV` / `TRAN/T` bridge CRUD — offline, with a fake
 * `HttpClient` injected through `ConnectionOptions.httpClient`. Nothing here
 * touches a real SAP system. Same harness idiom as test/write.test.ts and
 * test/write-package.test.ts: REAL production code drives a fake socket.
 *
 * Scope: `abapCreateViaBridge`'s `corr_nr` handling and its VIEW/DV create
 * refusal (every package, `$TMP` and an omitted `package` included, so the
 * post-create notes below are asserted on TRAN/T, the one bridge create that
 * still runs), and the
 * new `abapDeleteViaBridge` dispatch — most load-bearingly, that a
 * delete's package is judged against a SERVER-confirmed value via
 * `verifyViaVitBridge`, never a caller-supplied `package`. Neither delete
 * bridge module (`src/adt/view-delete.ts`, `src/adt/tran-delete.ts`) can look
 * its object's own package up itself, so a caller who names a permissive
 * package must not be able to slip a delete past `assertBridgeMutation`'s
 * allowlist — see src/tools/write.ts's `abapDeleteViaBridge` doc comment for
 * the full argument. If that check is ever weakened back to trusting the
 * caller's `package`, the test below named "does NOT let a caller's
 * disagreeing `package` reach the delete bridge" must fail with a thrown
 * `BAD_INPUT` never appearing (an `AssertionError`), not an import error.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { abapWrite } from "../src/tools/write.js";
import { SafetyGate } from "../src/safety.js";
import { DDIC_BRIDGE_CLASS } from "../src/adt/ddic-bridge.js";
import { vitBridgeUri } from "../src/adt/write-verify.js";
import { Journal } from "../src/journal.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";
import { searchResultsXml } from "./helpers/fake-adt.js";

const MAX = 20_000;

interface Recorded {
  label: string;
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
}

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_TEXT = { "content-type": "text/plain" };
const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

const NOT_FOUND_XML = (name: string): string =>
  `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>
  <message lang="EN">${name} does not exist</message><properties/></exc:exception>`;

const LOCK_XML = (handle = "H1", isLocal = "X", corrNr = "") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR>${corrNr}</CORRNR><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>${isLocal}</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

type Route = (r: Recorded) => HttpClientResponse | undefined;

class FakeAdt implements HttpClient {
  readonly calls: Recorded[] = [];
  constructor(private readonly route: Route) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const method = (o.method ?? "GET").toUpperCase();
    const qs = (o.qs ?? {}) as Record<string, string>;
    const label = qs._action ? `${qs._action} ${o.url}` : `${method} ${o.url}`;
    const rec: Recorded = { label, method, url: o.url, qs, body: o.body };
    this.calls.push(rec);
    const res = this.route(rec);
    if (!res) throw new Error(`FakeAdt: unrouted request ${label}`);
    return res;
  }
  get labels(): string[] {
    return this.calls.map((c) => c.label);
  }
}

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
  });

function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  return undefined;
}

async function connected(route: Route): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  const adt = new FakeAdt((r) => baseRoute(r) ?? route(r));
  const conn = new AbapConnection(cfg(), {
    httpClient: adt,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  adt.calls.length = 0;
  return { conn, adt };
}

const ABSENT_ROUTE: Route = () => resp(404, NOT_FOUND_XML("?"), OK_XML);

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(isAbapError(e)).toBe(true);
  return e as AbapError;
};

const gate = () =>
  new SafetyGate({
    readOnly: false,
    allowPackages: ["*"],
    allowTransports: ["*"],
    writesLockedOut: false,
  });

// ---------------------------------------------------------------------------
// Bridge class deploy — the generated classrun's own class, shared by
// create and delete: GET-404 → POST-create → LOCK → PUT → UNLOCK.
// ---------------------------------------------------------------------------

const CLASS_COLLECTION = "/sap/bc/adt/oo/classes";

const bridgeDeployRoute = (bridgeClass: string): Route => {
  const bridgeObjUrl = `${CLASS_COLLECTION}/${bridgeClass.toLowerCase()}`;
  const bridgeSourceUri = `${bridgeObjUrl}/source/main`;
  return (r) => {
    if (r.url === bridgeObjUrl && r.method === "GET" && !r.qs._action) {
      return resp(404, NOT_FOUND_XML(bridgeClass), OK_XML);
    }
    if (r.url === CLASS_COLLECTION && r.method === "POST") return resp(200, "", OK_TEXT);
    if (r.url === bridgeObjUrl && r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
    if (r.url === bridgeObjUrl && r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
    if (r.url === bridgeSourceUri && r.method === "PUT") return resp(200, "", OK_TEXT);
    return undefined;
  };
};

const classrunRoute =
  (tags: readonly string[]): Route =>
  (r) => {
    if (r.url.startsWith("/sap/bc/adt/oo/classrun/")) return resp(200, tags.join("\n"), OK_TEXT);
    if (r.url.includes("/sap/bc/adt/activation")) return resp(200, "", { "content-length": "0" });
    return undefined;
  };

/** The VIT-bridge stub GET — used both for pre-delete package resolution and post-create/-delete verification. */
const vitRoute =
  (
    mode: "confirmed" | "absent" | "indeterminate",
    vitType: string,
    name: string,
    type: string,
    packageName = "ZTM",
  ): Route =>
  (r) => {
    const uri = vitBridgeUri(vitType, name);
    if (r.url !== uri) return undefined;
    if (mode === "absent") return resp(404, NOT_FOUND_XML(name), OK_XML);
    const rich =
      mode === "confirmed" ? `<adtcore:packageRef adtcore:name="${packageName}"/>` : "";
    return resp(
      200,
      `<vit:properties xmlns:vit="http://www.sap.com/adt/vit" ` +
        `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:type="${type}" ` +
        `adtcore:name="${name}">${rich}</vit:properties>`,
      OK_XML,
    );
  };

/** The resolution GET `abapCreateViaBridge` makes for a TRAN/T's `program` — a real, existing PROG/P. */
const programRoute =
  (name: string): Route =>
  (r) =>
    r.method === "GET" && !r.qs._action && r.url === `/sap/bc/adt/programs/programs/${name.toLowerCase()}`
      ? resp(
          200,
          `<?xml version="1.0" encoding="utf-8"?>` +
            `<adtcore:objectMetadata xmlns:adtcore="http://www.sap.com/adt/core" ` +
            `adtcore:name="${name}" adtcore:type="PROG/P">` +
            `<adtcore:packageRef adtcore:name="$TMP"/></adtcore:objectMetadata>`,
          OK_XML,
        )
      : undefined;

/** `/repository/informationsystem/search` — the tie-breaker `verifyObjectDeleted` falls through to on a `200`/failed read-back. */
const searchRoute =
  (rows: readonly { name: string; type: string; uri: string }[]): Route =>
  (r) =>
    r.url.endsWith("/repository/informationsystem/search")
      ? resp(200, searchResultsXml(rows), OK_XML)
      : undefined;

const both =
  (...routes: Route[]): Route =>
  (r) => {
    for (const route of routes) {
      const hit = route(r);
      if (hit) return hit;
    }
    return undefined;
  };

// TRAN/T is the only type whose bridge create still runs, so every assertion
// about `abapCreateViaBridge`'s shared post-create notes is made on it.
const TCODE = "ZMCPT01";
const PROGRAM = "ZMCP_CARRIER_LIST";
const TRAN_BRIDGE = DDIC_BRIDGE_CLASS.createTransaction;
const TRAN_INPUT = {
  object: TCODE,
  type: "TRAN/T",
  package: "$TMP",
  description: "Carrier list",
  program: PROGRAM,
} as const;

// ---------------------------------------------------------------------------
// Task 1: corr_nr narrowing on create
// ---------------------------------------------------------------------------

describe("abapCreateViaBridge — corr_nr handling, and the VIEW/DV create refused for every package", () => {
  const VIEW = "ZMCP_V_CARRIER";
  const BRIDGE = DDIC_BRIDGE_CLASS.createView;

  it("VIEW/DV into a transportable package WITH corr_nr is refused UNSUPPORTED before any network call", async () => {
    // A route that WOULD succeed if reached — proves the refusal, not a
    // missing route, is what stops this.
    const classrun = classrunRoute(["VIEW-PUT", "VIEW-REGISTERED", "VIEW-ACTIVATED"]);
    const vit = vitRoute("confirmed", "viewdv", VIEW, "VIEW/DV");
    const { conn, adt } = await connected(
      both(bridgeDeployRoute(BRIDGE), classrun, vit),
    );
    const e = await catchErr(
      abapWrite(
        conn,
        {
          object: VIEW,
          type: "VIEW/DV",
          package: "ZTM",
          description: "Carriers",
          base_table: "ZMCP_CARRIER",
          view_fields: ["CARRIER_ID", "NAME"],
          corr_nr: "TR1K900123",
        },
        MAX,
        gate(),
      ),
    );
    expect(e.code).toBe("UNSUPPORTED");
    expect(adt.calls.length).toBe(0);
  });

  it("VIEW/DV into a non-$TMP package WITHOUT corr_nr is refused UNSUPPORTED before any network call — abapCreateViaBridge's own guard, ahead of view-create.ts's validate()", async () => {
    const offline = null as unknown as AbapConnection;
    const e = await catchErr(
      abapWrite(
        offline,
        {
          object: VIEW,
          type: "VIEW/DV",
          package: "ZTM",
          description: "Carriers",
          base_table: "ZMCP_CARRIER",
          view_fields: ["CARRIER_ID", "NAME"],
        },
        MAX,
        gate(),
      ),
    );
    expect(e.code).toBe("UNSUPPORTED");
  });

  it("VIEW/DV into $TMP is refused UNSUPPORTED too, with a route that WOULD have succeeded — $TMP is not the exception, it is the one package the refusal is measured on", async () => {
    const classrun = classrunRoute(["VIEW-PUT", "VIEW-ACTIVATED"]);
    const vit = vitRoute("confirmed", "viewdv", VIEW, "VIEW/DV", "$TMP");
    const { conn, adt } = await connected(both(bridgeDeployRoute(BRIDGE), classrun, vit));
    const e = await catchErr(
      abapWrite(
        conn,
        {
          object: VIEW,
          type: "VIEW/DV",
          package: "$TMP",
          description: "Carriers",
          base_table: "ZMCP_CARRIER",
          view_fields: ["CARRIER_ID", "NAME"],
        },
        MAX,
        gate(),
      ),
    );
    expect(e.code).toBe("UNSUPPORTED");
    expect(String(e.message)).toMatch(/unregistered in TADIR/);
    expect(String(e.message)).toMatch(/PACKAGE_UNKNOWN/);
    expect(adt.calls.length).toBe(0);
  });

  it("an OMITTED `package` is refused as well — it defaults to $TMP inside abapCreateViaBridge, so leaving the argument out must not be a way past the refusal", async () => {
    const offline = null as unknown as AbapConnection;
    const e = await catchErr(
      abapWrite(
        offline,
        {
          object: VIEW,
          type: "VIEW/DV",
          description: "Carriers",
          base_table: "ZMCP_CARRIER",
          view_fields: ["CARRIER_ID", "NAME"],
        },
        MAX,
        gate(),
      ),
    );
    expect(e.code).toBe("UNSUPPORTED");
    // The refusal names the package it actually resolved, not a blank.
    expect(String(e.message)).toMatch(/"\$TMP"/);
  });

  it("TRAN/T still refuses corr_nr, but with a TRAN/T-specific message (RPY_TRANSACTION_INSERT runs its own RS_CORR_INSERT) — not the old blanket claim", async () => {
    const offline = null as unknown as AbapConnection;
    const e = await catchErr(
      abapWrite(
        offline,
        {
          object: "ZMCPT01",
          type: "TRAN/T",
          package: "ZTM",
          description: "Carrier list",
          program: "ZMCP_CARRIER_LIST",
          corr_nr: "TR1K900123",
        },
        MAX,
        gate(),
      ),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(String(e.message)).toMatch(/RPY_TRANSACTION_INSERT/);
    expect(String(e.message)).toMatch(/RS_CORR_INSERT/);
    // The old message claimed corr_nr never works for EITHER bridge type —
    // that claim is now false for VIEW/DV, so it must not survive verbatim.
    expect(String(e.message)).not.toMatch(/VIEW\/DV/);
  });

  // `bridgeReversalNote` (src/tools/write.ts) is shared by both bridge-create
  // types, and VIEW/DV no longer reaches it, so the notes below are asserted
  // on TRAN/T — the one type that still runs a bridge create.
  it("the create-response closing note states abapsmith can REACH this type via bridge (not that delete is proven), and that create is still not journalled", async () => {
    const classrun = classrunRoute(["TRAN-CREATED"]);
    const vit = vitRoute("confirmed", "trant", TCODE, "TRAN/T", "$TMP");
    const { conn } = await connected(
      both(programRoute(PROGRAM), bridgeDeployRoute(TRAN_BRIDGE), classrun, vit),
    );
    const result = await abapWrite(conn, TRAN_INPUT, MAX, gate());
    expect(result.text).toMatch(/can reach/);
    expect(result.text).toMatch(/see the limits note above/);
    expect(result.text).toMatch(/mode="delete"/);
    expect(result.text).toMatch(/abap_journal mode=undo will not reverse it/);
    // Narrowed: reachability, not a success guarantee — must not overclaim.
    expect(result.text).not.toMatch(/CAN delete/);
  });

  it("entryId===undefined (not journalled) + unregistered: the reachability claim is dropped when this create's own read-back found it unregistered, not made unconditionally", async () => {
    const classrun = classrunRoute(["TRAN-CREATED"]);
    // No packageRef, but an enriched attribute (changedBy) so vitStubShowsExistence
    // still calls it `confirmed` — the orphan shape measured on VIEW/DV, which is
    // why that type's create is refused outright now; TRAN/T can still reach it.
    const vit: Route = (r) =>
      r.url === vitBridgeUri("trant", TCODE)
        ? resp(
            200,
            `<vit:properties xmlns:vit="http://www.sap.com/adt/vit" ` +
              `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:type="TRAN/T" ` +
              `adtcore:name="${TCODE}" adtcore:changedBy="DEVELOPER"></vit:properties>`,
            OK_XML,
          )
        : undefined;
    const { conn } = await connected(
      both(programRoute(PROGRAM), bridgeDeployRoute(TRAN_BRIDGE), classrun, vit),
    );
    const result = await abapWrite(conn, TRAN_INPUT, MAX, gate());
    expect(result.text).not.toMatch(/CAN delete/);
    expect(result.text).not.toMatch(/can reach/);
    expect(result.text).toMatch(/no <adtcore:packageRef>/);
    expect(result.text).toMatch(/SAFETY_DENIED \/ PACKAGE_UNKNOWN/);
    expect(result.text).toMatch(/SE11\/SE14/);
  });
});

// ---------------------------------------------------------------------------
// Task 3: the create-response's reversal note reflects THIS create's
// own registration read-back — registered / unregistered / unknown — never
// a blanket "undo can delete it" promise. An object can land active but
// unregistered in TADIR; this only stops the note from claiming a guarantee
// that shape disproves.
// ---------------------------------------------------------------------------

describe("abapCreateViaBridge — reversal note keyed on this create's own registration read-back", () => {
  const withJournal = async (fn: (journal: Journal) => Promise<void>): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), "abapsmith-bridge-reversal-journal-"));
    try {
      await fn(new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "A4H"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  /** First hit on the object's VIT URI answers the pre-create existence check as absent (so beforeCapture="confirmed-absent"); every later hit answers with `stubBody`. */
  const vitOnceAbsentThen = (vitType: string, name: string, stubBody: string): Route => {
    const uri = vitBridgeUri(vitType, name);
    let calls = 0;
    return (r) => {
      if (r.url !== uri) return undefined;
      calls += 1;
      if (calls === 1) return resp(404, NOT_FOUND_XML(name), OK_XML);
      return resp(200, stubBody, OK_XML);
    };
  };

  const createInput = TRAN_INPUT;

  /** bridge deploy + program resolution + classrun, shared by all three cases below. */
  const around = (vit: Route): Route =>
    both(programRoute(PROGRAM), bridgeDeployRoute(TRAN_BRIDGE), classrunRoute(["TRAN-CREATED"]), vit);

  it("registered: read-back names a package — undo can REACH it through the same bridge (reachability, not a delete-success guarantee), and the note names THIS object's package, not a general type claim", async () => {
    await withJournal(async (journal) => {
      const vit = vitOnceAbsentThen(
        "trant",
        TCODE,
        `<vit:properties xmlns:vit="http://www.sap.com/adt/vit" ` +
          `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:type="TRAN/T" ` +
          `adtcore:name="${TCODE}"><adtcore:packageRef adtcore:name="$TMP"/></vit:properties>`,
      );
      const { conn } = await connected(around(vit));
      const result = await abapWrite(conn, createInput, MAX, gate(), journal);
      expect(result.text).toMatch(/read-back found it registered in package \$TMP/);
      expect(result.text).toMatch(/abap_journal mode=undo entry=/);
      expect(result.text).toMatch(/undo can reach it through the same classrun bridge abap_write mode="delete" uses/);
      expect(result.text).toMatch(/see the limits note above for whether that bridge's delete is itself proven/);
      // Narrowed: reachability, not an assertion that the delete itself succeeds.
      expect(result.text).not.toMatch(/deletes it via the same classrun bridge/);
    });
  });

  it("unregistered (the live-observed orphan): confirmed present via the VIT bridge but no <adtcore:packageRef> — the note says delete AND undo both refuse it, not that undo can reverse it", async () => {
    await withJournal(async (journal) => {
      // Enriched attribute (changedBy), no packageRef — confirmed present,
      // unregistered in TADIR, exactly the orphan shape measured on VIEW/DV.
      const vit = vitOnceAbsentThen(
        "trant",
        TCODE,
        `<vit:properties xmlns:vit="http://www.sap.com/adt/vit" ` +
          `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:type="TRAN/T" ` +
          `adtcore:name="${TCODE}" adtcore:changedBy="DEVELOPER"></vit:properties>`,
      );
      const { conn } = await connected(around(vit));
      const result = await abapWrite(conn, createInput, MAX, gate(), journal);
      expect(result.text).toMatch(/no <adtcore:packageRef>/);
      expect(result.text).toMatch(/active and unregistered in TADIR/);
      expect(result.text).toMatch(/SAFETY_DENIED \/ PACKAGE_UNKNOWN/);
      expect(result.text).toMatch(/non-overridably/);
      expect(result.text).toMatch(/SE11\/SE14/);
      // Must NOT still claim undo can reverse it — the false guarantee this fixes.
      expect(result.text).not.toMatch(/deletes it via the same classrun bridge abap_write mode="delete" uses\./);
    });
  });

  it("unknown: neither probe settled a package for it — the note is conditional and names the failure mode (SAFETY_DENIED / PACKAGE_UNKNOWN), not a bare hedge", async () => {
    await withJournal(async (journal) => {
      // A stub that does NOT echo back the requested name — genuinely
      // indeterminate under `echoesTarget` (write-verify.ts) — and the
      // repository-search fallback has no route, so it stays indeterminate too.
      const vit = vitOnceAbsentThen(
        "trant",
        TCODE,
        `<vit:properties xmlns:vit="http://www.sap.com/adt/vit" ` +
          `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:type="TRAN/T" ` +
          `adtcore:name="ZSOME_OTHER_OBJECT"></vit:properties>`,
      );
      const { conn } = await connected(around(vit));
      const result = await abapWrite(conn, createInput, MAX, gate(), journal);
      expect(result.text).toMatch(/can reach it through the same classrun bridge/);
      expect(result.text).toMatch(/if it is registered/);
      expect(result.text).toMatch(/did not establish a package for it/);
      expect(result.text).toMatch(/SAFETY_DENIED \/ PACKAGE_UNKNOWN/);
    });
  });
});

// ---------------------------------------------------------------------------
// Task 2: delete dispatch
// ---------------------------------------------------------------------------

describe("abapDeleteViaBridge — dispatch and create-only-field refusals", () => {
  it("mode:'delete' on VIEW/DV no longer throws UNSUPPORTED — it dispatches to the view delete bridge and makes real requests", async () => {
    const found = vitRoute("confirmed", "viewdv", "ZMCP_V_CARRIER", "VIEW/DV", "ZTM");
    const gone = vitRoute("absent", "viewdv", "ZMCP_V_CARRIER", "VIEW/DV");
    const classrun = classrunRoute(["VIEW-DELETED", "VIEW-GONE"]);
    const { conn, adt } = await connected(
      both(bridgeDeployRoute(DDIC_BRIDGE_CLASS.deleteView), classrun, (r) => found(r) ?? gone(r)),
    );
    const result = await abapWrite(
      conn,
      { object: "ZMCP_V_CARRIER", type: "VIEW/DV", mode: "delete" },
      MAX,
      gate(),
    );
    expect(result.text).toMatch(/deleted:\s*true/);
    expect(adt.calls.length).toBeGreaterThan(0);
  });

  it("mode:'delete' on TRAN/T dispatches to the transaction delete bridge, not the view one", async () => {
    const found = vitRoute("confirmed", "trant", "ZMCPT01", "TRAN/T", "ZTM");
    const gone = vitRoute("absent", "trant", "ZMCPT01", "TRAN/T");
    const classrun = classrunRoute(["TRAN-DELETED", "TRAN-GONE"]);
    const { conn } = await connected(
      both(bridgeDeployRoute(DDIC_BRIDGE_CLASS.deleteTransaction), classrun, (r) => found(r) ?? gone(r)),
    );
    const result = await abapWrite(
      conn,
      { object: "ZMCPT01", type: "TRAN/T", mode: "delete" },
      MAX,
      gate(),
    );
    expect(result.text).toMatch(/deleted:\s*true/);
    expect(result.text).toMatch(new RegExp(DDIC_BRIDGE_CLASS.deleteTransaction));
  });

  it("a VIEW/DV delete carrying a create-only field (base_table) is refused BAD_INPUT with ZERO requests on the wire", async () => {
    const offline = null as unknown as AbapConnection;
    const e = await catchErr(
      abapWrite(
        offline,
        { object: "ZMCP_V_CARRIER", type: "VIEW/DV", mode: "delete", base_table: "ZMCP_CARRIER" },
        MAX,
        gate(),
      ),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(String(e.message)).toMatch(/base_table/);
  });

  it("a TRAN/T delete carrying corr_nr is refused BAD_INPUT — neither delete bridge takes a transport parameter", async () => {
    const offline = null as unknown as AbapConnection;
    const e = await catchErr(
      abapWrite(
        offline,
        { object: "ZMCPT01", type: "TRAN/T", mode: "delete", corr_nr: "TR1K900123" },
        MAX,
        gate(),
      ),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(String(e.message)).toMatch(/corr_nr/);
  });

  it("a delete whose read-back and search both CONFIRM the object still present is reported as CHECK_FAILED, never as a successful delete", async () => {
    const found = vitRoute("confirmed", "viewdv", "ZMCP_V_CARRIER", "VIEW/DV", "ZTM");
    // Post-delete verifyObjectDeleted: the SAME vit URI now still answers
    // 200 (still there) — the classrun claimed success but the object
    // persists — and the repository-search tie-breaker agrees it's present.
    const stillThere = vitRoute("confirmed", "viewdv", "ZMCP_V_CARRIER", "VIEW/DV", "ZTM");
    const search = searchRoute([
      { name: "ZMCP_V_CARRIER", type: "VIEW/DV", uri: vitBridgeUri("viewdv", "ZMCP_V_CARRIER") },
    ]);
    const classrun = classrunRoute(["VIEW-DELETED", "VIEW-GONE"]);
    const { conn } = await connected(
      both(bridgeDeployRoute(DDIC_BRIDGE_CLASS.deleteView), classrun, found, stillThere, search),
    );
    const e = await catchErr(
      abapWrite(conn, { object: "ZMCP_V_CARRIER", type: "VIEW/DV", mode: "delete" }, MAX, gate()),
    );
    expect(e.code).toBe("CHECK_FAILED");
    expect(String(e.message)).toMatch(/STILL confirmed present/);
  });

  it("the delete-response notes no longer claim there is no delete endpoint for this type", async () => {
    const found = vitRoute("confirmed", "trant", "ZMCPT01", "TRAN/T", "ZTM");
    const gone = vitRoute("absent", "trant", "ZMCPT01", "TRAN/T");
    const classrun = classrunRoute(["TRAN-DELETED", "TRAN-GONE"]);
    const { conn } = await connected(
      both(bridgeDeployRoute(DDIC_BRIDGE_CLASS.deleteTransaction), classrun, (r) => found(r) ?? gone(r)),
    );
    const result = await abapWrite(
      conn,
      { object: "ZMCPT01", type: "TRAN/T", mode: "delete" },
      MAX,
      gate(),
    );
    expect(result.text).not.toMatch(/cannot be deleted/i);
    expect(result.text).not.toMatch(/UNSUPPORTED/);
  });
});

// ---------------------------------------------------------------------------
// Safety-gate-bypass fix: package is resolved from the SERVER, never trusted
// from the caller, before a delete bridge is ever invoked.
// ---------------------------------------------------------------------------

describe("abapDeleteViaBridge — package resolved from the server, not the caller (safety-gate-bypass fix)", () => {
  it("confirmed-absent (the object never existed) is refused NOT_FOUND, before any bridge class is deployed", async () => {
    const gone = vitRoute("absent", "viewdv", "ZMCP_GHOST_VIEW", "VIEW/DV");
    const { conn, adt } = await connected(gone);
    const e = await catchErr(
      abapWrite(conn, { object: "ZMCP_GHOST_VIEW", type: "VIEW/DV", mode: "delete" }, MAX, gate()),
    );
    expect(e.code).toBe("NOT_FOUND");
    // Exactly the one VIT-bridge GET — no bridge class GET/POST/LOCK/PUT/UNLOCK.
    expect(adt.calls.length).toBe(1);
  });

  it("a thin VIT stub that echoes the target but shows no existence (200, no packageRef, no enriched attrs) is refused NOT_FOUND, same as a 404 — confirmed-absent, not indeterminate", async () => {
    // Under the echoesTarget + vitStubShowsExistence split, a
    // stub that echoes the requested type/name but carries none of
    // vitStubShowsExistence's signals is `confirmed-absent`, not
    // `indeterminate` — this used to be the "indeterminate (VIT bridge
    // answers too sparsely to trust)" case (mode "indeterminate" below
    // just reuses vitRoute's sparse-body shape); this was later reclassified.
    const sparse = vitRoute("indeterminate", "viewdv", "ZMCP_V_CARRIER", "VIEW/DV");
    const { conn, adt } = await connected(sparse);
    const e = await catchErr(
      abapWrite(conn, { object: "ZMCP_V_CARRIER", type: "VIEW/DV", mode: "delete" }, MAX, gate()),
    );
    expect(e.code).toBe("NOT_FOUND");
    expect(adt.calls.length).toBe(1);
  });

  it("a VIT stub that does NOT echo the requested name (genuinely indeterminate) is refused SAFETY_DENIED / PACKAGE_UNKNOWN, carrying the reason, not a silent fall-through", async () => {
    // Genuine indeterminacy is narrower than it used to
    // be: only a stub that fails to echo back the requested type/name at
    // all (not merely "sparse") stays indeterminate — see write-verify.ts's
    // `echoesTarget`.
    const route: Route = (r) => {
      const uri = vitBridgeUri("viewdv", "ZMCP_V_CARRIER");
      if (r.url !== uri) return undefined;
      return resp(
        200,
        `<vit:properties xmlns:vit="http://www.sap.com/adt/vit" ` +
          `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:type="VIEW/DV" ` +
          `adtcore:name="ZSOME_OTHER_OBJECT"></vit:properties>`,
        OK_XML,
      );
    };
    const { conn, adt } = await connected(route);
    const e = await catchErr(
      abapWrite(conn, { object: "ZMCP_V_CARRIER", type: "VIEW/DV", mode: "delete" }, MAX, gate()),
    );
    expect(e.code).toBe("SAFETY_DENIED");
    expect(e.details.reason).toBe("PACKAGE_UNKNOWN");
    expect(String(e.details.cause ?? "")).toMatch(/did not echo back/);
    expect(adt.calls.length).toBe(1);
    // existence could not be confirmed, not denied — a healthy connection resolves it
    expect(e.retryable).toBe(true);
  });

  it("confirmed but no <adtcore:packageRef> in the VIT stub is refused SAFETY_DENIED / PACKAGE_UNKNOWN, never defaulted to $TMP or the caller's value", async () => {
    // A hand-built stub carrying no packageRef and no enriched attributes
    // would actually be classified `confirmed-absent` by
    // `vitStubShowsExistence` (see write-verify.ts) — so this exercises the
    // OTHER path to `packageName === undefined`: a VIT stub that IS rich
    // enough to be `confirmed` (an empty but present packageRef element
    // satisfies `vitStubShowsRegistration`, matching type/name) but whose
    // packageRef element itself carries no usable name for
    // `packageRefName` to extract.
    const route: Route = (r) => {
      const uri = vitBridgeUri("viewdv", "ZMCP_V_CARRIER");
      if (r.url !== uri) return undefined;
      return resp(
        200,
        `<vit:properties xmlns:vit="http://www.sap.com/adt/vit" ` +
          `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:type="VIEW/DV" ` +
          // A space before the self-close matters: `vitStubShowsRegistration`
          // (write-verify.ts) requires whitespace or `>` immediately after
          // `packageRef` — kept byte-identical to the earlier test it was carried over from —
          // so a bare `<adtcore:packageRef/>` with no preceding space would
          // NOT satisfy it, and this stub would fall through to
          // `confirmed-absent` instead of the `confirmed`-with-no-package
          // case this test means to exercise.
          `adtcore:name="ZMCP_V_CARRIER"><adtcore:packageRef /></vit:properties>`,
        OK_XML,
      );
    };
    const { conn } = await connected(route);
    const e = await catchErr(
      abapWrite(conn, { object: "ZMCP_V_CARRIER", type: "VIEW/DV", mode: "delete" }, MAX, gate()),
    );
    expect(e.code).toBe("SAFETY_DENIED");
    expect(e.details.reason).toBe("PACKAGE_UNKNOWN");
    expect(String(e.message)).toMatch(/no <adtcore:packageRef> element/);
    // Hint routes the caller to SE11/SE14 and names the known orphan outcome
    // (active but unregistered in TADIR), same vocabulary as bridgeReversalNote's
    // "unregistered" branch — catches a later rewrite that drops either
    // without weakening the gate.
    expect(String(e.hint)).toMatch(/known orphan outcome/);
    expect(String(e.hint)).toMatch(/unregistered in\s+TADIR/);
    expect(String(e.hint)).toMatch(/SE11\/SE14/);
  });

  it("a caller's `package` that AGREES with the server is accepted and reaches the delete bridge", async () => {
    const found = vitRoute("confirmed", "viewdv", "ZMCP_V_CARRIER", "VIEW/DV", "ZTM");
    const gone = vitRoute("absent", "viewdv", "ZMCP_V_CARRIER", "VIEW/DV");
    const classrun = classrunRoute(["VIEW-DELETED", "VIEW-GONE"]);
    const { conn } = await connected(
      both(bridgeDeployRoute(DDIC_BRIDGE_CLASS.deleteView), classrun, (r) => found(r) ?? gone(r)),
    );
    const result = await abapWrite(
      conn,
      { object: "ZMCP_V_CARRIER", type: "VIEW/DV", mode: "delete", package: "ZTM" },
      MAX,
      gate(),
    );
    expect(result.text).toMatch(/deleted:\s*true/);
  });

  it("does NOT let a caller's disagreeing `package` reach the delete bridge — refused BAD_INPUT, and the gate is never even asked (THE core regression guard)", async () => {
    // The server says ZTM; the caller claims $TMP (or any other permissive
    // package the gate's allowlist would have approved). If the fix in
    // abapDeleteViaBridge is ever reverted to trusting `target.packageName`
    // outright, this reaches `assertBridgeMutation`/`deleteClassicViewViaBridge`
    // with the caller's package unchecked, the fake server answers the
    // delete happily, and this assertion fails — an AssertionError on
    // `e.code`, never an import error, so a revert cannot hide behind "the
    // test didn't even run".
    const found = vitRoute("confirmed", "viewdv", "ZMCP_V_CARRIER", "VIEW/DV", "ZTM");
    const classrun = classrunRoute(["VIEW-DELETED", "VIEW-GONE"]);
    const { conn, adt } = await connected(
      both(bridgeDeployRoute(DDIC_BRIDGE_CLASS.deleteView), classrun, found),
    );
    const e = await catchErr(
      abapWrite(
        conn,
        { object: "ZMCP_V_CARRIER", type: "VIEW/DV", mode: "delete", package: "$TMP" },
        MAX,
        gate(),
      ),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(String(e.message)).toMatch(/ZTM/);
    expect(String(e.message)).toMatch(/\$TMP/);
    expect(String(e.message)).toMatch(/does not move objects between packages/);
    // Exactly the one VIT-bridge resolution GET — no bridge-class deploy, no
    // classrun execution: the mismatch is caught before any of that.
    expect(adt.calls.length).toBe(1);
  });
});
