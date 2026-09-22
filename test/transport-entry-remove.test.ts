/**
 * `src/adt/transport-entry-remove.ts` (the `TREN` classic-dispatch bridge)
 * plus the two layers around it: `trFindEntryHolder` (`src/adt/transports.ts`)
 * and `abap_transport` operation `removeObject` (`src/tools/transport.ts`).
 *
 * Post-S3 architecture: there is no more per-operation `ZCL_ZMCP_DDIC_*`
 * classrun bridge class. `removeTransportEntryViaBridge` now calls
 * `runClassicAction` (`src/adt/classic-call.ts`), which routes through the
 * fluid `classic` tool's single static body class `ZCL_ZMCP_FLUID_CLASSIC`
 * (`src/adt/fluid/builtin/classic.ts`) via `dispatch`. The ABAP itself lives
 * in `src/adt/fluid/builtin/classic/abap-transport.ts`'s `transportPart` —
 * that is now the authoritative source for this file's structural
 * regression-guard tests, not `transport-entry-remove.ts`'s own comments.
 *
 * Offline throughout except for the fluid deploy/classrun plumbing (a fake
 * `HttpClient`, never a live appliance): bridge deploy/execute mechanics are
 * exercised via `test/helpers/fluid-classic-fake.ts`'s `classicFake`;
 * `trFindEntryHolder` and the tool layer's cheap refusals are exercised via
 * `fakeCtsConnection` and the already-captured `transport-details-with-objects`
 * fixture (request A4HK900117, whose task A4HK900118 holds one locked E071
 * row for ZMCP_CTS_PROBE, R3TR PROG, wbtype PROG/P).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { HttpClientException } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { SafetyGate } from "../src/safety.js";
import { ConfigSchema } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { DDIC_ERR_PREFIX } from "../src/adt/ddic-transcript.js";
import {
  removalTouchedNothing,
  removeTransportEntryViaBridge,
  type TransportEntryRemoveParams,
} from "../src/adt/transport-entry-remove.js";
import { authorizeCeiling, trFindEntryHolder } from "../src/adt/transports.js";
import { abapTransport, type TransportInput, type TransportJournalDeps } from "../src/tools/transport.js";
import { transportPart } from "../src/adt/fluid/builtin/classic/abap-transport.js";
import { resetFluidEnsureState } from "../src/adt/fluid/ensure.js";
import { FLUID_PACKAGE, resetFluidPackageMemo } from "../src/adt/fluid/package.js";
import { canonicalArgsJson } from "../src/adt/fluid/invoke.js";
import { Journal, type JournalConfig, type JournalEntry } from "../src/journal.js";
import { fakeCtsConnection, loadCtsFixture } from "./helpers/cts-fixtures.js";
import { searchResultsXml, type FakeObjectRef } from "./helpers/fake-adt.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";
import { classicFake, useFluidState } from "./helpers/fluid-classic-fake.js";

const fluidState = useFluidState();

// ---------------------------------------------------------------------------
// Fake HttpClient harness — mirrors test/package-delete.test.ts exactly.
// ---------------------------------------------------------------------------

type Route = (o: HttpClientOptions) => HttpClientResponse | undefined;

class FakeAdt implements HttpClient {
  readonly calls: HttpClientOptions[] = [];
  constructor(private readonly route: Route) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    const res = this.route(o);
    if (!res) throw new Error(`FakeAdt: unrouted request ${(o.method ?? "GET").toUpperCase()} ${o.url}`);
    return res;
  }
}

const resp = (status: number, body = "", headers: Record<string, unknown> = {}): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_XML = { "content-type": "application/xml" };

function baseRoute(o: HttpClientOptions): HttpClientResponse | undefined {
  if (o.url.includes("/compatibility/graph")) {
    return resp(200, "<graph/>", { "content-type": "application/xml", "x-csrf-token": "TOKEN123" });
  }
  if (o.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
  if (o.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  return undefined;
}

function combine(...routes: Route[]): Route {
  return (o) => {
    for (const route of routes) {
      const hit = route(o);
      if (hit) return hit;
    }
    return undefined;
  };
}

function cfg(overrides: Record<string, unknown> = {}) {
  return ConfigSchema.parse({
    url: "http://a4h.example:50000",
    user: "TESTUSER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
    fluidApi: true,
    stateDir: fluidState.dir(),
    ...overrides,
  });
}

async function connected(route: Route) {
  const adt = new FakeAdt((r) => baseRoute(r) ?? route(r));
  const conn = new AbapConnection(cfg(), {
    httpClient: routeSystemRoleProbe(adt, { answer: "nonproductive" }),
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  adt.calls.length = 0;
  return { conn, adt };
}

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  if (!e || !isAbapError(e)) throw new Error(`expected an AbapError, got ${String(e)}`);
  return e;
};

beforeEach(() => {
  resetFluidEnsureState();
  resetFluidPackageMemo();
});

// ---------------------------------------------------------------------------
// Fixtures for the CTS network layer (trShow / repository search)
// ---------------------------------------------------------------------------

const TRANSPORT_REQUESTS = "/sap/bc/adt/cts/transportrequests";
const SEARCH_PATH = "/sap/bc/adt/repository/informationsystem/search";

const TRKORR = "A4HK900117";
const HOLDER = "A4HK900118";
const OBJECT = "ZMCP_CTS_PROBE";
const PGMID = "R3TR";
const OBJTYPE = "PROG";
const WBTYPE = "PROG/P";
const MAX_CHARS = 60_000;

const PARAMS: TransportEntryRemoveParams = { trkorr: TRKORR, objectName: OBJECT };

function trShowRoute(): Route {
  const fx = loadCtsFixture("transport-details-with-objects");
  return (o) => {
    if ((o.method ?? "GET").toUpperCase() !== "GET") return undefined;
    if (o.url !== `${TRANSPORT_REQUESTS}/${TRKORR}`) return undefined;
    return resp(fx.meta.status, fx.body, fx.meta.responseHeaders as Record<string, unknown>);
  };
}

function quickSearchRoute(mode: "hit" | "empty" | "fail"): Route {
  return (o) => {
    if (o.url !== SEARCH_PATH) return undefined;
    if (mode === "fail") {
      const r = resp(500, "", OK_XML);
      throw new HttpClientException("Request failed with status code 500", "500", 500, undefined, o, r);
    }
    const refs: FakeObjectRef[] =
      mode === "hit"
        ? [{ name: OBJECT, type: WBTYPE, uri: `/sap/bc/adt/programs/programs/${OBJECT.toLowerCase()}` }]
        : [];
    return resp(200, searchResultsXml(refs), OK_XML);
  };
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/** Wide open: fluid deploy package, "delete" ceiling, and the plain write ceiling all allowed. */
function bridgeAdminGate(): SafetyGate {
  return new SafetyGate({
    readOnly: false,
    allowPackages: [FLUID_PACKAGE],
    allowNamePrefixes: ["*"],
    allowTransports: ["*"],
    allowTransportDelete: true,
    writesLockedOut: false,
  });
}

function proofFor(gate: SafetyGate) {
  return authorizeCeiling(gate, "transport");
}

function transportInput(
  partial: Partial<TransportInput> & { operation: TransportInput["operation"] },
): TransportInput {
  return {
    transport: undefined,
    user: undefined,
    object: undefined,
    package: undefined,
    description: undefined,
    confirm: undefined,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// 1 — remove_transport_entry ABAP source: structural regression guard
//
// Cross-checked directly against src/adt/fluid/builtin/classic/abap-transport.ts
// (transportPart.source), not against the TS bridge's own comments.
// ---------------------------------------------------------------------------

// transportPart now carries several methods (read_transport_log, read_import_queue,
// create_transport_of_copies, ...), so an open-ended slice from the start of
// remove_transport_entry to the end of the source would silently widen every guard
// below to cover unrelated ABAP and stop being a guard on remove_transport_entry at
// all. Pin the end bound to this method's own ENDMETHOD. to keep the slice — and the
// guards below — scoped to just this method's body.
const TRANSPORT_METHOD_START = transportPart.source.indexOf("METHOD remove_transport_entry.");
const TRANSPORT_METHOD = transportPart.source.slice(
  TRANSPORT_METHOD_START,
  transportPart.source.indexOf("\n  ENDMETHOD.", TRANSPORT_METHOD_START),
);

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

describe("remove_transport_entry ABAP source — structural regression guard", () => {
  it("is part of the transport_entry method list", () => {
    expect(transportPart.methods).toContain("remove_transport_entry");
  });

  it("calls exactly TRINT_READ_REQUEST then TR_DELETE_COMM_OBJECT_KEYS, in that order", () => {
    const calls = [...TRANSPORT_METHOD.matchAll(/CALL FUNCTION '([A-Z_]+)'/g)].map((m) => m[1]);
    expect(calls).toEqual(["TRINT_READ_REQUEST", "TR_DELETE_COMM_OBJECT_KEYS"]);
  });

  it("both CALL FUNCTIONs are immediately followed by a subrc capture and an sy-message snapshot", () => {
    const hits = [
      ...TRANSPORT_METHOD.matchAll(
        /EXCEPTIONS OTHERS = 1\.\s*lv_subrc = sy-subrc\.\s*MOVE-CORRESPONDING sy TO ls_msg\./g,
      ),
    ];
    expect(hits.length).toBe(2);
  });

  it("guards all three failures with 'IF lv_subrc <> 0.' — never a bare 'IF sy-subrc <> 0.'", () => {
    expect((TRANSPORT_METHOD.match(/IF lv_subrc <> 0\./g) ?? []).length).toBe(3);
    expect(TRANSPORT_METHOD).not.toMatch(/IF sy-subrc <> 0\./);
  });

  it("both sy-message snapshots interpolate the same spaced msgty/msgid/msgno/v1-v4 fields", () => {
    const hits = [
      ...TRANSPORT_METHOD.matchAll(
        /\{ ls_msg-msgty \} \{ ls_msg-msgid \} \{ ls_msg-msgno \} v1=\{ ls_msg-msgv1 \} v2=\{ ls_msg-msgv2 \} v3=\{ ls_msg-msgv3 \} v4=\{ ls_msg-msgv4 \}/g,
      ),
    ];
    expect(hits.length).toBe(2);
    // Only the TRINT_READ_REQUEST branch's snapshot is prefixed "msg=" inline (it builds
    // lv_readerr directly); the TR_DELETE_COMM_OBJECT_KEYS branch builds lv_msgtext first,
    // then references it as "msg={ lv_msgtext }" inside fail() further down.
    expect(TRANSPORT_METHOD).toContain("msg={ ls_msg-msgty }");
    expect(TRANSPORT_METHOD).toContain("msg={ lv_msgtext }");
  });

  it("the duplicate-row guard (step 4) runs before the delete call (step 5)", () => {
    const dupIdx = TRANSPORT_METHOD.indexOf("lv_n >= 2");
    const deleteIdx = TRANSPORT_METHOD.indexOf("CALL FUNCTION 'TR_DELETE_COMM_OBJECT_KEYS'");
    expect(dupIdx).toBeGreaterThan(0);
    expect(deleteIdx).toBeGreaterThan(dupIdx);
  });

  it("the duplicate-count inner loop filters on pgmid+object+obj_name together, not any one alone", () => {
    expect(norm(TRANSPORT_METHOD)).toContain(
      norm(
        "LOOP AT lt_rows INTO ls_other WHERE pgmid = ls_e071-pgmid AND object = ls_e071-object " +
          "AND obj_name = ls_e071-obj_name.",
      ),
    );
  });

  it("2+ rows sharing pgmid+object+obj_name emit a ZMCP-TREN-DEDUP line instead of fail()", () => {
    expect(norm(TRANSPORT_METHOD)).toContain(
      norm(
        "IF lv_n >= 2. " +
          "line( |ZMCP-TREN-DEDUP { ls_e071-pgmid } { ls_e071-object } { ls_e071-obj_name } " +
          "{ lv_n } AS4POS { lv_positions }| ). " +
          "ENDIF.",
      ),
    );
  });

  it("sorts lt_rows by pgmid object obj_name as4pos before the dedup loop", () => {
    expect(TRANSPORT_METHOD).toContain("SORT lt_rows BY pgmid object obj_name as4pos.");
  });

  it("surplus rows are deleted from e071 by trkorr+as4pos, subrc-guarded, with a ROLLBACK before fail()", () => {
    expect(norm(TRANSPORT_METHOD)).toContain(
      norm(
        "LOOP AT lt_surplus INTO ls_surplus. " +
          "DELETE FROM e071 WHERE trkorr = @lv_holder AND as4pos = @ls_surplus-as4pos. " +
          "lv_subrc = sy-subrc. " +
          "IF lv_subrc <> 0. " +
          "ROLLBACK WORK.",
      ),
    );
  });

  it("never deletes from e071k — the surviving E071 row still covers the object's key rows", () => {
    expect(TRANSPORT_METHOD).not.toContain("DELETE FROM e071k");
  });

  it("step 5's failure path rolls back when lt_surplus is not initial, before its fail()", () => {
    expect(norm(TRANSPORT_METHOD)).toContain(
      norm(
        "IF lt_surplus IS NOT INITIAL. " +
          "ROLLBACK WORK. " +
          "ENDIF. " +
          "fail( |TR_DELETE_COMM_OBJECT_KEYS failed for { ls_e071-pgmid } { ls_e071-object } { ls_e071-obj_name }, " +
          "sy-subrc={ lv_subrc }, msg={ lv_msgtext }| ).",
      ),
    );
  });

  it("both 'no entry for' fail branches sit inside one IF lv_holder IS INITIAL guard, then RETURN", () => {
    expect(norm(TRANSPORT_METHOD)).toContain(
      norm(
        "IF lv_holder IS INITIAL. " +
          "IF lv_readerr IS INITIAL. " +
          "fail( |no entry for { lv_object } on { lv_trkorr } or its tasks| ). " +
          "ELSE. " +
          "fail( |no entry for { lv_object } on { lv_trkorr } or its tasks; last TRINT_READ_REQUEST " +
          "failure: { lv_readerr }| ). " +
          "ENDIF. " +
          "RETURN. " +
          "ENDIF.",
      ),
    );
  });

  it("TREN-REMOVED and TREN-GONE are the only two plain single-quoted line() tags", () => {
    const plain = [...TRANSPORT_METHOD.matchAll(/line\( '([^']+)' \)/g)].map((m) => m[1]);
    expect(plain).toEqual(["TREN-REMOVED", "TREN-GONE"]);
    // Every other line() call is interpolated (a |...| literal), not plain-quoted.
    const interpolated = [...TRANSPORT_METHOD.matchAll(/line\( \|([^|]*)\| \)/g)];
    expect(interpolated.length).toBeGreaterThan(0);
  });

  it("COMMIT WORK AND WAIT sits after TREN-REMOVED and before the post-commit re-select / TREN-GONE", () => {
    const removedIdx = TRANSPORT_METHOD.indexOf("line( 'TREN-REMOVED' )");
    const commitIdx = TRANSPORT_METHOD.indexOf("COMMIT WORK AND WAIT.");
    const selectIdx = TRANSPORT_METHOD.indexOf("SELECT SINGLE trkorr FROM e071");
    const goneIdx = TRANSPORT_METHOD.indexOf("line( 'TREN-GONE' )");
    expect(removedIdx).toBeGreaterThan(0);
    expect(commitIdx).toBeGreaterThan(removedIdx);
    expect(selectIdx).toBeGreaterThan(commitIdx);
    expect(goneIdx).toBeGreaterThan(selectIdx);
  });

  it("lv_trkorr is assigned exactly once — the candidate loop uses a separate lv_cursor variable", () => {
    expect((TRANSPORT_METHOD.match(/lv_trkorr = s\( 'trkorr' \)\./g) ?? []).length).toBe(1);
    expect(TRANSPORT_METHOD).toContain("LOOP AT lt_candidates INTO lv_cursor.");
    expect(TRANSPORT_METHOD).not.toContain("LOOP AT lt_candidates INTO lv_trkorr.");
  });

  it("resolves candidates from the target itself plus its own tasks (strkorr = lv_trkorr)", () => {
    expect(TRANSPORT_METHOD).toContain("APPEND lv_trkorr TO lt_candidates.");
    expect(TRANSPORT_METHOD).toContain(
      "SELECT trkorr FROM e070 INTO TABLE @lt_tasks WHERE strkorr = @lv_trkorr.",
    );
    expect(TRANSPORT_METHOD).toContain("APPEND LINES OF lt_tasks TO lt_candidates.");
  });
});

// ---------------------------------------------------------------------------
// 2 — wire content: canonicalArgsJson
// ---------------------------------------------------------------------------

describe("removeTransportEntryViaBridge — wire content", () => {
  it("deploys an invoker whose embedded JSON matches canonicalArgsJson({trkorr, object_name})", async () => {
    const fake = classicFake({
      action: "remove_transport_entry",
      lines: () => [`ZMCP-TREN-HOLDER ${HOLDER}`, `ZMCP-TREN-ROW ${PGMID} ${OBJTYPE} ${OBJECT}`, "TREN-REMOVED", "TREN-GONE"],
    });
    const { conn } = await connected(fake.route);
    const gate = bridgeAdminGate();
    await removeTransportEntryViaBridge(conn, gate, PARAMS, proofFor(gate));

    const invoker = fake.invoker();
    expect(invoker).toBeDefined();
    const src = fake.sourceOf(invoker!);
    expect(src).toBeDefined();
    const payload = [...src!.matchAll(/`([^`]*)`/g)].map((m) => m[1]).join("");
    expect(payload).toBe(canonicalArgsJson({ trkorr: TRKORR, object_name: OBJECT }));
  });
});

// ---------------------------------------------------------------------------
// 3 — removeTransportEntryViaBridge: zero-network input validation
// ---------------------------------------------------------------------------

describe("removeTransportEntryViaBridge — input validation (zero network)", () => {
  const offline = null as unknown as AbapConnection;

  it("rejects a malformed trkorr before any network call", async () => {
    const gate = bridgeAdminGate();
    const err = await catchErr(
      removeTransportEntryViaBridge(offline, gate, { trkorr: "not-a-trkorr!", objectName: OBJECT }, proofFor(gate)),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("Not a transport request/task number");
  });

  it("rejects an empty trkorr", async () => {
    const gate = bridgeAdminGate();
    const err = await catchErr(
      removeTransportEntryViaBridge(offline, gate, { trkorr: "", objectName: OBJECT }, proofFor(gate)),
    );
    expect(err.code).toBe("BAD_INPUT");
  });

  it("rejects an object name over 40 characters", async () => {
    const gate = bridgeAdminGate();
    const long = "Z" + "A".repeat(45);
    const err = await catchErr(
      removeTransportEntryViaBridge(offline, gate, { trkorr: TRKORR, objectName: long }, proofFor(gate)),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("max 40 characters");
  });

  it("rejects an object name with an embedded quote/space", () => {
    const gate = bridgeAdminGate();
    return catchErr(
      removeTransportEntryViaBridge(
        offline,
        gate,
        { trkorr: TRKORR, objectName: "ZFOO' BAR" },
        proofFor(gate),
      ),
    ).then((err) => {
      expect(err.code).toBe("BAD_INPUT");
      expect(err.message).toContain("not a valid ABAP object name");
    });
  });
});

// ---------------------------------------------------------------------------
// 4 — trFindEntryHolder (src/adt/transports.ts), via fakeCtsConnection
// ---------------------------------------------------------------------------

describe("trFindEntryHolder", () => {
  it("resolves to the task holding the entry, not the parent request", async () => {
    const { conn, calls } = fakeCtsConnection([loadCtsFixture("transport-details-with-objects")]);
    const holder = await trFindEntryHolder(conn, TRKORR, OBJECT);
    expect(holder.trkorr).toBe(HOLDER);
    expect(holder.onTask).toBe(true);
    expect(holder.requested).toBe(TRKORR);
    expect(holder.rows).toEqual([
      expect.objectContaining({ pgmid: PGMID, type: OBJTYPE, name: OBJECT, wbType: WBTYPE, locked: true }),
    ]);
    expect(calls.length).toBe(1);
  });

  it("throws NOT_FOUND for an object absent from the request and its tasks", async () => {
    const { conn } = fakeCtsConnection([loadCtsFixture("transport-details-with-objects")]);
    const err = await catchErr(trFindEntryHolder(conn, TRKORR, "ZNOT_THERE"));
    expect(err.code).toBe("NOT_FOUND");
    expect(err.hint).toContain('operation "show"');
  });

  it("rejects a malformed trkorr before any network call", async () => {
    const { conn, calls } = fakeCtsConnection([]);
    const err = await catchErr(trFindEntryHolder(conn, "!!!not-valid!!!", OBJECT));
    expect(err.code).toBe("BAD_INPUT");
    expect(calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5 — abap_transport removeObject: cheap refusals (zero network)
// ---------------------------------------------------------------------------

describe("abap_transport removeObject — cheap refusals (zero network)", () => {
  it("refuses with no confirm, naming the exact echo needed", async () => {
    const { conn, calls } = fakeCtsConnection([]);
    const err = await catchErr(
      abapTransport(conn, transportInput({ operation: "removeObject", transport: TRKORR, object: OBJECT }), MAX_CHARS, bridgeAdminGate()),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain(`confirm: "${TRKORR}"`);
    expect(calls.length).toBe(0);
  });

  it("refuses a confirm that doesn't echo the transport number", async () => {
    const { conn, calls } = fakeCtsConnection([]);
    const err = await catchErr(
      abapTransport(
        conn,
        transportInput({ operation: "removeObject", transport: TRKORR, object: OBJECT, confirm: "WRONG000001" }),
        MAX_CHARS,
        bridgeAdminGate(),
      ),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(calls.length).toBe(0);
  });

  it("refuses under a readOnly gate", async () => {
    const { conn, calls } = fakeCtsConnection([]);
    const readOnly = new SafetyGate({ readOnly: true, allowPackages: [] });
    const err = await catchErr(
      abapTransport(
        conn,
        transportInput({ operation: "removeObject", transport: TRKORR, object: OBJECT, confirm: TRKORR }),
        MAX_CHARS,
        readOnly,
      ),
    );
    expect(err.code).toBe("READ_ONLY");
    expect(calls.length).toBe(0);
  });

  it("refuses a write-enabled gate that lacks the admin-only allowTransportDelete ceiling", async () => {
    const { conn, calls } = fakeCtsConnection([]);
    const writeOnly = new SafetyGate({ readOnly: false, allowPackages: ["*"] });
    const err = await catchErr(
      abapTransport(
        conn,
        transportInput({ operation: "removeObject", transport: TRKORR, object: OBJECT, confirm: TRKORR }),
        MAX_CHARS,
        writeOnly,
      ),
    );
    expect(err.code).toBe("READ_ONLY");
    expect(err.hint).toContain("admin-mode transport-delete ceiling");
    expect(calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6 — removeTransportEntryViaBridge: happy path + beforeAssert, via classicFake
// ---------------------------------------------------------------------------

describe("removeTransportEntryViaBridge — happy path", () => {
  it("parses holder and removed rows from the ZMCP-TREN-* lines", async () => {
    const fake = classicFake({
      action: "remove_transport_entry",
      lines: () => [`ZMCP-TREN-HOLDER ${HOLDER}`, `ZMCP-TREN-ROW ${PGMID} ${OBJTYPE} ${OBJECT}`, "TREN-REMOVED", "TREN-GONE"],
    });
    const { conn } = await connected(fake.route);
    const gate = bridgeAdminGate();
    const res = await removeTransportEntryViaBridge(conn, gate, PARAMS, proofFor(gate));
    expect(res.holder).toBe(HOLDER);
    expect(res.removed).toEqual([{ pgmid: PGMID, object: OBJTYPE, name: OBJECT }]);
    expect(res.transcript.tags).toEqual(expect.arrayContaining(["TREN-REMOVED", "TREN-GONE"]));
  });

  it("falls back to the requested trkorr as holder when no HOLDER line is seen", async () => {
    const fake = classicFake({
      action: "remove_transport_entry",
      lines: () => [`ZMCP-TREN-ROW ${PGMID} ${OBJTYPE} ${OBJECT}`, "TREN-REMOVED", "TREN-GONE"],
    });
    const { conn } = await connected(fake.route);
    const gate = bridgeAdminGate();
    const res = await removeTransportEntryViaBridge(conn, gate, PARAMS, proofFor(gate));
    expect(res.holder).toBe(TRKORR);
  });

  it("supports removing more than one row (batch)", async () => {
    const fake = classicFake({
      action: "remove_transport_entry",
      lines: () => [
        `ZMCP-TREN-HOLDER ${HOLDER}`,
        `ZMCP-TREN-ROW ${PGMID} ${OBJTYPE} ${OBJECT}`,
        `ZMCP-TREN-ROW ${PGMID} CLAS ${OBJECT}_CL`,
        "TREN-REMOVED",
        "TREN-GONE",
      ],
    });
    const { conn } = await connected(fake.route);
    const gate = bridgeAdminGate();
    const res = await removeTransportEntryViaBridge(conn, gate, PARAMS, proofFor(gate));
    expect(res.removed).toHaveLength(2);
  });

  it("parses a ZMCP-TREN-DEDUP line into collapsed, alongside the removed row", async () => {
    const fake = classicFake({
      action: "remove_transport_entry",
      lines: () => [
        `ZMCP-TREN-HOLDER ${HOLDER}`,
        "ZMCP-TREN-DEDUP R3TR TABL ZAS_T184 2 AS4POS 000001,000003",
        "ZMCP-TREN-ROW R3TR TABL ZAS_T184",
        "TREN-REMOVED",
        "TREN-GONE",
      ],
    });
    const { conn } = await connected(fake.route);
    const gate = bridgeAdminGate();
    const res = await removeTransportEntryViaBridge(conn, gate, PARAMS, proofFor(gate));
    expect(res.collapsed).toEqual([
      { pgmid: "R3TR", object: "TABL", name: "ZAS_T184", rows: 2, positions: ["000001", "000003"] },
    ]);
    expect(res.removed).toHaveLength(1);
  });

  it("collapsed is empty when no ZMCP-TREN-DEDUP line appears", async () => {
    const fake = classicFake({
      action: "remove_transport_entry",
      lines: () => [`ZMCP-TREN-HOLDER ${HOLDER}`, `ZMCP-TREN-ROW ${PGMID} ${OBJTYPE} ${OBJECT}`, "TREN-REMOVED", "TREN-GONE"],
    });
    const { conn } = await connected(fake.route);
    const gate = bridgeAdminGate();
    const res = await removeTransportEntryViaBridge(conn, gate, PARAMS, proofFor(gate));
    expect(res.collapsed).toEqual([]);
  });
});

describe("removeTransportEntryViaBridge — beforeAssert branches", () => {
  it('a "no entry for" line throws NOT_FOUND, naming trkorr and object', async () => {
    const fake = classicFake({
      action: "remove_transport_entry",
      lines: () => [`${DDIC_ERR_PREFIX} no entry for ${OBJECT} on ${TRKORR} or its tasks`],
    });
    const { conn } = await connected(fake.route);
    const gate = bridgeAdminGate();
    const err = await catchErr(removeTransportEntryViaBridge(conn, gate, PARAMS, proofFor(gate)));
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toContain(`No entry for ${OBJECT} on ${TRKORR}`);
    expect(err.hint).toBeUndefined();
  });

  it("a well-formed duplicate-E071 line throws CTS_DUPLICATE_ENTRY, parsed fields distinct from the closure's own objectName/trkorr", async () => {
    // Deliberately different object name in the regex-matched line than PARAMS.objectName,
    // to prove details.objectName is the CLOSURE value (normalized input), not the parsed one.
    const errLine = `duplicate E071 entries for ${PGMID} ${OBJTYPE} OTHEROBJ on ${HOLDER}: 2 rows at AS4POS 0001,0002`;
    const fake = classicFake({
      action: "remove_transport_entry",
      lines: () => [`${DDIC_ERR_PREFIX} ${errLine}`],
    });
    const { conn } = await connected(fake.route);
    const gate = bridgeAdminGate();
    const err = await catchErr(removeTransportEntryViaBridge(conn, gate, PARAMS, proofFor(gate)));
    expect(err.code).toBe("CTS_DUPLICATE_ENTRY");
    expect(err.message).toBe(
      `CTS refused to remove OTHEROBJ from ${HOLDER}: 2 E071 rows share ${PGMID} ${OBJTYPE} OTHEROBJ ` +
        `(AS4POS 0001, 0002) — nothing was removed. Raw ABAP-side detail: ${errLine}`,
    );
    expect(err.details.objectName).toBe(OBJECT); // closure value, NOT the regex-parsed "OTHEROBJ"
    expect(err.details.trkorr).toBe(TRKORR);
    expect(err.details.holder).toBe(HOLDER);
    expect(err.details.count).toBe(2);
    expect(err.details.positions).toEqual(["0001", "0002"]);
    expect(err.hint).toContain("older bridge body");
    expect(err.hint).toContain("Redeploy");
  });

  it("a malformed duplicate-E071 line (regex doesn't match) still throws CTS_DUPLICATE_ENTRY, generically", async () => {
    const fake = classicFake({
      action: "remove_transport_entry",
      lines: () => [`${DDIC_ERR_PREFIX} duplicate E071 entries for something unparseable`],
    });
    const { conn } = await connected(fake.route);
    const gate = bridgeAdminGate();
    const err = await catchErr(removeTransportEntryViaBridge(conn, gate, PARAMS, proofFor(gate)));
    expect(err.code).toBe("CTS_DUPLICATE_ENTRY");
    expect(err.details).toEqual({
      trkorr: TRKORR,
      objectName: OBJECT,
      raw: expect.any(String),
    });
    expect(err.hint).toBeUndefined();
  });

  it("an unrelated ZMCP-DDIC-ERR> line falls through to the generic CHECK_FAILED", async () => {
    const fake = classicFake({
      action: "remove_transport_entry",
      lines: () => [`${DDIC_ERR_PREFIX} something else entirely went wrong`],
    });
    const { conn } = await connected(fake.route);
    const gate = bridgeAdminGate();
    const err = await catchErr(removeTransportEntryViaBridge(conn, gate, PARAMS, proofFor(gate)));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toBe(
      `Removing ${OBJECT} from ${TRKORR} failed on the server: something else entirely went wrong`,
    );
  });

  it("a transcript missing TREN-GONE (truncated success) throws CHECK_FAILED naming the missing marker", async () => {
    const fake = classicFake({
      action: "remove_transport_entry",
      lines: () => [`ZMCP-TREN-HOLDER ${HOLDER}`, `ZMCP-TREN-ROW ${PGMID} ${OBJTYPE} ${OBJECT}`, "TREN-REMOVED"],
    });
    const { conn } = await connected(fake.route);
    const gate = bridgeAdminGate();
    const err = await catchErr(removeTransportEntryViaBridge(conn, gate, PARAMS, proofFor(gate)));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("TREN-GONE");
  });
});

// ---------------------------------------------------------------------------
// 7 — abap_transport removeObject: end-to-end happy path + objectOnSystem probe
// ---------------------------------------------------------------------------

function happyLines(): readonly string[] {
  return [`ZMCP-TREN-HOLDER ${HOLDER}`, `ZMCP-TREN-ROW ${PGMID} ${OBJTYPE} ${OBJECT}`, "TREN-REMOVED", "TREN-GONE"];
}

describe("abap_transport removeObject — end to end", () => {
  it("removes the entry, reports the resolved holder, removed rows and gone:true", async () => {
    const fake = classicFake({ action: "remove_transport_entry", lines: happyLines });
    const combined = combine(trShowRoute(), quickSearchRoute("empty"), fake.route);
    const { conn } = await connected(combined);
    const gate = bridgeAdminGate();
    const input = transportInput({ operation: "removeObject", transport: TRKORR, object: OBJECT, confirm: TRKORR });

    const result = await abapTransport(conn, input, MAX_CHARS, gate);
    expect(result.text).toContain("operation: removeObject");
    expect(result.text).toContain(`transport: ${TRKORR}`);
    expect(result.text).toContain(`holder: ${HOLDER}`);
    expect(result.text).toContain(`object: ${OBJECT}`);
    expect(result.text).toContain("removedCount: 1");
    expect(result.text).toContain("gone: true");
    expect(result.text).toContain(`${OBJECT} lived on ${HOLDER}, a task of the request you passed (${TRKORR})`);
    expect(result.text).toContain(`Removed: ${PGMID} ${OBJTYPE} ${OBJECT}`);
  });
});

describe("abap_transport removeObject — objectOnSystem probe", () => {
  async function run(mode: "hit" | "empty" | "fail") {
    const fake = classicFake({ action: "remove_transport_entry", lines: happyLines });
    const combined = combine(trShowRoute(), quickSearchRoute(mode), fake.route);
    const { conn } = await connected(combined);
    const gate = bridgeAdminGate();
    const input = transportInput({ operation: "removeObject", transport: TRKORR, object: OBJECT, confirm: TRKORR });
    return abapTransport(conn, input, MAX_CHARS, gate);
  }

  it('"hit" -> present, with a live-object warning note; removal still succeeds', async () => {
    const result = await run("hit");
    expect(result.text).toContain("objectOnSystem: present");
    expect(result.text).toContain("still exists on the system");
    expect(result.text).toContain("gone: true");
  });

  it('"empty" -> absent, no extra note', async () => {
    const result = await run("empty");
    expect(result.text).toContain("objectOnSystem: absent");
    expect(result.text).not.toContain("still exists on the system");
    expect(result.text).not.toContain("Could not settle");
  });

  it('"fail" (search throws) -> unknown, with a could-not-settle note; removal still succeeds', async () => {
    const result = await run("fail");
    expect(result.text).toContain("objectOnSystem: unknown");
    expect(result.text).toContain("Could not settle whether");
    expect(result.text).toContain("gone: true");
  });
});

// ---------------------------------------------------------------------------
// 8 — enrichRemovalRefusal (module-private; exercised only via abapTransport)
// ---------------------------------------------------------------------------

// Copied verbatim from src/tools/transport.ts's module-private constants, so
// this file can assert exact hint text without exporting them. If the source
// text changes, this copy must be updated deliberately.
const COMM_OBJECT_KEYS_HINT =
  "The entry and its CTS lock are still on the request — it cannot be deleted while they are. " +
  'If the refusal names a lock or an owner, SE03\'s "Unlock Objects (Expert Tool)" is the tool ' +
  "for that — it does nothing for the duplicate-row guard (TR 292), which counts E071 rows, " +
  "not locks. Every remaining route is outside abapsmith and not guaranteed to succeed: edit " +
  "the request's object list in SE09/SE10; or release the request (irreversible). " +
  "The msg= fragment in the message above is the T100 message CTS itself raised — it may be " +
  "blank (a function module that raises with a bare RAISE sets no message) — but quote it " +
  "when reporting this failure.";

describe("abap_transport removeObject — enrichRemovalRefusal", () => {
  async function runWith(errorLines: readonly string[]) {
    const fake = classicFake({ action: "remove_transport_entry", lines: () => errorLines });
    const combined = combine(trShowRoute(), quickSearchRoute("empty"), fake.route);
    const { conn } = await connected(combined);
    const gate = bridgeAdminGate();
    const input = transportInput({ operation: "removeObject", transport: TRKORR, object: OBJECT, confirm: TRKORR });
    return catchErr(abapTransport(conn, input, MAX_CHARS, gate));
  }

  it("a generic TR_DELETE_COMM_OBJECT_KEYS CHECK_FAILED gets objectOnSystem attached and the generic hint appended", async () => {
    const errLine = `TR_DELETE_COMM_OBJECT_KEYS failed for ${PGMID} ${OBJTYPE} ${OBJECT}, sy-subrc=1, msg=E TR 123 v1= v2= v3= v4=`;
    const err = await runWith([`ZMCP-TREN-HOLDER ${HOLDER}`, `${DDIC_ERR_PREFIX} ${errLine}`]);
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toBe(`Removing ${OBJECT} from ${HOLDER} failed on the server: ${errLine}`);
    expect(err.details.objectOnSystem).toBe("absent");
    expect(err.hint).toBe(COMM_OBJECT_KEYS_HINT);
  });

  it("a late msg=E TR 292 is now thrown directly as CTS_DUPLICATE_ENTRY by beforeAssert, no hint", async () => {
    const errLine = `TR_DELETE_COMM_OBJECT_KEYS failed for ${PGMID} ${OBJTYPE} ${OBJECT}, sy-subrc=1, msg=E TR 292 v1= v2= v3= v4=`;
    const err = await runWith([`ZMCP-TREN-HOLDER ${HOLDER}`, `${DDIC_ERR_PREFIX} ${errLine}`]);
    expect(err.code).toBe("CTS_DUPLICATE_ENTRY");
    expect(err.message).toBe(
      `CTS refused to remove ${OBJECT} from ${HOLDER}: TR_DELETE_COMM_OBJECT_KEYS still raised ` +
        `TR 292 after the bridge's collapse — nothing further was removed. ` +
        `Raw ABAP-side detail: ${errLine}`,
    );
    expect(err.hint).toBeUndefined();
    expect(err.details.objectOnSystem).toBe("absent");
    expect(err.details.positions).toBeUndefined();
    expect(err.details.pgmid).toBeUndefined();
  });

  it("the bridge's own well-formed CTS_DUPLICATE_ENTRY gets objectOnSystem attached but message/hint stay exactly unchanged", async () => {
    const errLine = `duplicate E071 entries for ${PGMID} ${OBJTYPE} ${OBJECT} on ${HOLDER}: 2 rows at AS4POS 0001,0002`;
    const err = await runWith([`ZMCP-TREN-HOLDER ${HOLDER}`, `${DDIC_ERR_PREFIX} ${errLine}`]);
    expect(err.code).toBe("CTS_DUPLICATE_ENTRY");
    expect(err.message).toBe(
      `CTS refused to remove ${OBJECT} from ${HOLDER}: 2 E071 rows share ${PGMID} ${OBJTYPE} ${OBJECT} ` +
        `(AS4POS 0001, 0002) — nothing was removed. Raw ABAP-side detail: ${errLine}`,
    );
    expect(err.details.objectOnSystem).toBe("absent");
    expect(err.hint).toContain("older bridge body");
    expect(err.hint).toContain("Redeploy");
    // No LATE_DUPLICATE_ENTRY_HINT text appended — passthrough branch keeps e.hint exactly.
    expect(err.hint).not.toContain("abapsmith cannot say which action produced the extra row");
  });

  it('a NOT_FOUND refusal ("no entry for") passes through completely untouched — no objectOnSystem, no hint added', async () => {
    const err = await runWith([`${DDIC_ERR_PREFIX} no entry for ${OBJECT} on ${HOLDER} or its tasks`]);
    expect(err.code).toBe("NOT_FOUND");
    expect(err.hint).toBeUndefined();
    expect(err.details.objectOnSystem).toBeUndefined();
    expect(err.message).toContain(`No entry for ${OBJECT} on ${HOLDER}`);
  });

  it("a CHECK_FAILED not naming TR_DELETE_COMM_OBJECT_KEYS (missing expectTag) passes through completely untouched", async () => {
    // TREN-REMOVED present, TREN-GONE missing -> missing-marker CHECK_FAILED, no FM name in the message.
    const err = await runWith([`ZMCP-TREN-HOLDER ${HOLDER}`, `ZMCP-TREN-ROW ${PGMID} ${OBJTYPE} ${OBJECT}`, "TREN-REMOVED"]);
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.details.objectOnSystem).toBeUndefined();
    expect(err.message).toContain("TREN-GONE");
  });
});

// ---------------------------------------------------------------------------
// 9 — journalling (caller-driven removeObject)
// ---------------------------------------------------------------------------

describe("abap_transport removeObject — journalling", () => {
  let tmp: string;
  let warn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "abapsmith-tr-entry-remove-journal-"));
    warn = vi.fn();
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const jcfg = (): JournalConfig => ({ dir: tmp, enabled: true, maxEntries: 200, maxAgeDays: 30 });
  const FAKE_CFG = { sid: "A4H", url: "http://a4h.example:50000", client: "001" };
  const deps = (): TransportJournalDeps => ({
    journal: new Journal(jcfg(), "A4H"),
    cfg: FAKE_CFG,
    warn: warn as unknown as (msg: string) => void,
  });
  const written = async (): Promise<JournalEntry[]> => new Journal(jcfg(), "A4H").list();
  const only = async (): Promise<JournalEntry> => {
    const list = await written();
    expect(list.length, "journal entries").toBe(1);
    return list[0]!;
  };

  it("a successful removeObject journals one succeeded entry under the resolved holder, with a before-image", async () => {
    const fake = classicFake({ action: "remove_transport_entry", lines: happyLines });
    const combined = combine(trShowRoute(), quickSearchRoute("empty"), fake.route);
    const { conn } = await connected(combined);
    const gate = bridgeAdminGate();
    const input = transportInput({ operation: "removeObject", transport: TRKORR, object: OBJECT, confirm: TRKORR });

    await abapTransport(conn, input, MAX_CHARS, gate, deps());

    const entry = await only();
    expect(entry.outcome).toBe("succeeded");
    expect(entry.corrNr).toBe(HOLDER);
    expect(entry.object.name).toBe(HOLDER);
    expect(entry.beforeCapture).toBe("captured");
    expect(entry.tool).toBe("abap_transport removeObject");

    const blob = await new Journal(jcfg(), "A4H").beforeImage(entry);
    expect(blob).toBeTruthy();
    expect(blob).toContain(OBJECT);
    expect(blob).toContain(HOLDER);
    expect(blob).toContain(PGMID);
    // removeObjectBeforeImage's rows include only pgmid/type/name/locked — not wbType/uri.
    expect(blob).not.toContain(WBTYPE);
  });

  // Pins the NEW behaviour: a "no entry for" refusal produces a transcript
  // with no ZMCP-TREN-ROW line, so `removalTouchedNothing()` proves CTS
  // removed nothing and the entry settles `failed` instead of being left
  // `pending` (the OLD behaviour this test used to pin — every thrown bridge
  // error stayed `pending` and was flagged STRANDED by `abap_journal
  // mode=list`, a false alarm for the common case of a clean CTS refusal).
  it("a refusal that removed nothing journals under the resolved holder and settles failed", async () => {
    const fake = classicFake({
      action: "remove_transport_entry",
      lines: () => [`ZMCP-TREN-HOLDER ${HOLDER}`, `${DDIC_ERR_PREFIX} no entry for ${OBJECT} on ${HOLDER} or its tasks`],
    });
    const combined = combine(trShowRoute(), quickSearchRoute("empty"), fake.route);
    const { conn } = await connected(combined);
    const gate = bridgeAdminGate();
    const input = transportInput({ operation: "removeObject", transport: TRKORR, object: OBJECT, confirm: TRKORR });

    const err = await catchErr(abapTransport(conn, input, MAX_CHARS, gate, deps()));
    expect(err.code).toBe("NOT_FOUND"); // enrichRemovalRefusal still throws it unchanged

    const entry = await only();
    expect(entry.outcome).toBe("failed");
    expect(entry.corrNr).toBe(HOLDER); // holder resolution must not regress
    expect(entry.error).toContain("Refused, nothing was removed");
    expect(entry.object.description).toContain("refused, nothing was removed");
    expect(warn.mock.calls.some((c) => String(c[0]).includes("stays `pending` on purpose"))).toBe(false);
  });

  // The exact live scenario from the issue: CTS refuses a removeObject
  // because the request holds two or more E071 rows for the same object.
  // No row was ever removed, so this also settles `failed`.
  it("a CTS_DUPLICATE_ENTRY refusal also settles failed", async () => {
    const errLine = `duplicate E071 entries for ${PGMID} ${OBJTYPE} ${OBJECT} on ${HOLDER}: 2 rows at AS4POS 0001,0002`;
    const fake = classicFake({
      action: "remove_transport_entry",
      lines: () => [`ZMCP-TREN-HOLDER ${HOLDER}`, `${DDIC_ERR_PREFIX} ${errLine}`],
    });
    const combined = combine(trShowRoute(), quickSearchRoute("empty"), fake.route);
    const { conn } = await connected(combined);
    const gate = bridgeAdminGate();
    const input = transportInput({ operation: "removeObject", transport: TRKORR, object: OBJECT, confirm: TRKORR });

    const err = await catchErr(abapTransport(conn, input, MAX_CHARS, gate, deps()));
    expect(err.code).toBe("CTS_DUPLICATE_ENTRY");

    const entry = await only();
    expect(entry.outcome).toBe("failed");
    expect(warn.mock.calls.some((c) => String(c[0]).includes("stays `pending` on purpose"))).toBe(false);
  });

  // A failure AFTER a row was already removed proves CTS WAS touched, so
  // "nothing happened" is not provable — the entry must stay `pending` (aka
  // `unproven`) rather than be asserted `failed`, exactly as before this
  // change. Emits a transcript missing TREN-GONE (see section 6) so it
  // surfaces as the generic CHECK_FAILED rather than a named refusal.
  it("a failure after a row was removed still stays pending/unproven", async () => {
    const fake = classicFake({
      action: "remove_transport_entry",
      lines: () => [`ZMCP-TREN-HOLDER ${HOLDER}`, `ZMCP-TREN-ROW ${PGMID} ${OBJTYPE} ${OBJECT}`, "TREN-REMOVED"],
    });
    const combined = combine(trShowRoute(), quickSearchRoute("empty"), fake.route);
    const { conn } = await connected(combined);
    const gate = bridgeAdminGate();
    const input = transportInput({ operation: "removeObject", transport: TRKORR, object: OBJECT, confirm: TRKORR });

    const err = await catchErr(abapTransport(conn, input, MAX_CHARS, gate, deps()));
    expect(err.code).toBe("CHECK_FAILED");

    const entry = await only();
    expect(entry.outcome).toBe("pending");
    expect(warn.mock.calls.some((c) => String(c[0]).includes("stays `pending` on purpose"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// removalTouchedNothing() — direct unit tests
// ---------------------------------------------------------------------------

describe("removalTouchedNothing()", () => {
  // Absence of a transcript is absence of evidence, not evidence of absence:
  // a plain Error and an AbapError with no `details.raw` at all could equally
  // be a dropped connection where the ABAP ran and answered into thin air, so
  // neither may be read as "nothing was removed".
  it("a plain Error is not proof anything was untouched", () => {
    expect(removalTouchedNothing(new Error("boom"))).toBe(false);
  });

  it("an AbapError with no details.raw is not proof anything was untouched", () => {
    const e = new AbapError("CHECK_FAILED", "boom", {});
    expect(removalTouchedNothing(e)).toBe(false);
  });

  it("an AbapError whose raw names a ZMCP-TREN-ROW line is not untouched — the loop died partway", () => {
    const e = new AbapError("CHECK_FAILED", "boom", {
      raw: `ZMCP-TREN-HOLDER ${HOLDER}\nZMCP-TREN-ROW ${PGMID} ${OBJTYPE} ${OBJECT}\nTREN-REMOVED`,
    });
    expect(removalTouchedNothing(e)).toBe(false);
  });

  it("an AbapError whose raw has other lines but no row line is proven untouched", () => {
    const e = new AbapError("NOT_FOUND", "boom", {
      raw: `${DDIC_ERR_PREFIX} no entry for ${OBJECT} on ${HOLDER} or its tasks`,
    });
    expect(removalTouchedNothing(e)).toBe(true);
  });

  it("an AbapError whose raw names a ZMCP-TREN-DEDUP line is not untouched — surplus rows were already deleted", () => {
    const e = new AbapError("CHECK_FAILED", "boom", {
      raw: `ZMCP-TREN-HOLDER ${HOLDER}\nZMCP-TREN-DEDUP R3TR TABL ZAS_T184 2 AS4POS 000001,000003`,
    });
    expect(removalTouchedNothing(e)).toBe(false);
  });
});
