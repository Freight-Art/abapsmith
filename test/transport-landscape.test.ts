/**
 * Issue #88 ("Transport landscape support"): `readTransportLogViaBridge`
 * (`src/adt/transport-log.ts`), `readImportQueueViaBridge`
 * (`src/adt/transport-queue.ts`), `createTransportOfCopiesViaBridge`
 * (`src/adt/transport-copies.ts`), plus the `abap_transport` tool-layer
 * operations `log`/`queue`/`create kind="copies"` (`src/tools/transport.ts`)
 * and the classic-bridge ABAP that backs all three
 * (`src/adt/fluid/builtin/classic/abap-transport.ts`'s `transportPart`).
 *
 * Same harness as `test/transport-entry-remove.test.ts`: everything routes
 * through `runClassicAction` -> `dispatch` -> the fluid `classic` tool's
 * single static body class `ZCL_ZMCP_FLUID_CLASSIC`, faked offline via
 * `test/helpers/fluid-classic-fake.ts`'s `classicFake`. No network, no live
 * SAP, no ABAP_URL anywhere in this file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { SafetyGate } from "../src/safety.js";
import { ConfigSchema } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { DDIC_ERR_PREFIX, DDIC_TAGS, ABAP_SOURCE_LINE_MAX, parseDdicTranscript } from "../src/adt/ddic-transcript.js";
import { readTransportLogViaBridge } from "../src/adt/transport-log.js";
import { readImportQueueViaBridge } from "../src/adt/transport-queue.js";
import { createTransportOfCopiesViaBridge } from "../src/adt/transport-copies.js";
import { abapTransport, type TransportInput, type TransportJournalDeps } from "../src/tools/transport.js";
import { transportPart } from "../src/adt/fluid/builtin/classic/abap-transport.js";
import { classicManifest, CLASSIC_BODY_CLASS } from "../src/adt/fluid/builtin/classic.js";
import { resetFluidEnsureState } from "../src/adt/fluid/ensure.js";
import { FLUID_PACKAGE, resetFluidPackageMemo } from "../src/adt/fluid/package.js";
import { Journal, type JournalConfig, type JournalEntry } from "../src/journal.js";
import { fakeCtsConnection } from "./helpers/cts-fixtures.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";
import { classicFake, useFluidState } from "./helpers/fluid-classic-fake.js";

const fluidState = useFluidState();

// ---------------------------------------------------------------------------
// Fake HttpClient harness — mirrors test/transport-entry-remove.test.ts.
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

const MAX_CHARS = 60_000;
const TRKORR = "A4HK900300";

/** Wide open, read-only-safe: covers deploy into FLUID_PACKAGE only. Fine for log/queue (reads — package-blind). */
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

/**
 * For anything that exercises `createTransportOfCopiesViaBridge` through
 * `classicFake`/`dispatch`: the fluid deploy itself is gated as an ordinary
 * "write" against FLUID_PACKAGE (`classicFake`'s HTTP routing always writes
 * generated classes into FLUID_PACKAGE, regardless of the devClass under
 * test — confirmed by reading `src/adt/fluid/dispatch.ts`'s
 * `authorizeMutation(conn, gate, "write", spec)` deploy-time call, which is
 * entirely separate from the "transport" op `opCreate`/`createCopies` gate
 * against `devClass`), so allowPackages needs BOTH FLUID_PACKAGE (deploy)
 * AND devClass (the create itself, checked separately via `gate.evaluate`/
 * `gate.authorize("transport", ...)`).
 */
function copiesGate(devClass: string): SafetyGate {
  return new SafetyGate({
    readOnly: false,
    allowPackages: [FLUID_PACKAGE, devClass],
    allowNamePrefixes: ["*"],
    allowTransports: ["*"],
    allowTransportDelete: true,
    writesLockedOut: false,
  });
}

function mintCopiesAuthorization(gate: SafetyGate, devClass: string) {
  return gate.authorize(
    "transport",
    { name: devClass, packageName: devClass },
    { corr: { kind: "unresolved" } },
  );
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
    kind: undefined,
    target: undefined,
    system: undefined,
    domain: undefined,
    confirm: undefined,
    ...partial,
  };
}

// =============================================================================
// GROUP 1 — readTransportLogViaBridge transcript parsing
// =============================================================================

describe("readTransportLogViaBridge — transcript parsing", () => {
  it("a single system with an empty RC ('-' placeholder on the wire) reports rc: '' — not the literal string '-'", async () => {
    // Regression guard: TRINT_GET_LOG_OVERVIEW's RC came back EMPTY for every
    // overview row observed live on A4H 2026-09-15 ("not yet flagged for
    // import"). The ABAP substitutes "-" so the fixed-token line always has
    // the same number of tokens; the TS side must turn that "-" back into ""
    // (unplaceholder), not leave the placeholder character sitting in `rc`
    // where a caller could mistake it for a real return code.
    const fake = classicFake({
      action: "read_transport_log",
      lines: () => [
        `ZMCP-TRLG-REQ ${TRKORR} T D`,
        "ZMCP-TRLG-SYS 1 A4H - 20260915 103744 10",
        "ZMCP-TRLG-SYSTXT 1 ",
        "ZMCP-TRLG-RCTXT 1 ",
        "ZMCP-TRLG-COUNT 1",
        "TRLG-READ",
      ],
    });
    const { conn } = await connected(fake.route);
    const gate = bridgeAdminGate();
    const res = await readTransportLogViaBridge(conn, gate, { trkorr: TRKORR });
    expect(res.systems).toHaveLength(1);
    expect(res.systems[0]!.rc).toBe("");
    expect(res.systems[0]!.rc).not.toBe("-");
  });

  it("SYSTXT/RCTXT free text (with internal spaces) attaches to the right system by index", async () => {
    const fake = classicFake({
      action: "read_transport_log",
      lines: () => [
        `ZMCP-TRLG-REQ ${TRKORR} T D`,
        "ZMCP-TRLG-SYS 1 A4H 0 20260915 103744 10",
        "ZMCP-TRLG-SYSTXT 1 Import into A4H completed",
        "ZMCP-TRLG-RCTXT 1 no errors, no warnings",
        "ZMCP-TRLG-COUNT 1",
        "TRLG-READ",
      ],
    });
    const { conn } = await connected(fake.route);
    const gate = bridgeAdminGate();
    const res = await readTransportLogViaBridge(conn, gate, { trkorr: TRKORR });
    expect(res.systems[0]!.systemText).toBe("Import into A4H completed");
    expect(res.systems[0]!.rcText).toBe("no errors, no warnings");
  });

  it("two systems with interleaved LINE rows attach lines to the correct system by index", async () => {
    const fake = classicFake({
      action: "read_transport_log",
      lines: () => [
        `ZMCP-TRLG-REQ ${TRKORR} T D`,
        "ZMCP-TRLG-SYS 1 A4H 0 20260915 103744 10",
        "ZMCP-TRLG-SYSTXT 1 sys one text",
        "ZMCP-TRLG-RCTXT 1 sys one rc text",
        "ZMCP-TRLG-SYS 2 QAS 8 20260916 090000 20",
        "ZMCP-TRLG-SYSTXT 2 sys two text",
        "ZMCP-TRLG-RCTXT 2 sys two rc text",
        // Interleaved: system 2's line first, then system 1's, then system 2's again.
        "ZMCP-TRLG-LINE 2 E K1 001 first QAS line",
        "ZMCP-TRLG-LINE 1 I S0 002 first A4H line",
        "ZMCP-TRLG-LINE 2 W K2 003 second QAS line",
        "ZMCP-TRLG-COUNT 2",
        "TRLG-READ",
      ],
    });
    const { conn } = await connected(fake.route);
    const gate = bridgeAdminGate();
    const res = await readTransportLogViaBridge(conn, gate, { trkorr: TRKORR });
    expect(res.systems).toHaveLength(2);
    const sys1 = res.systems.find((s) => s.system === "A4H")!;
    const sys2 = res.systems.find((s) => s.system === "QAS")!;
    expect(sys1.lines).toEqual([{ severity: "I", msgClass: "S0", msgNumber: "002", text: "first A4H line" }]);
    expect(sys2.lines).toEqual([
      { severity: "E", msgClass: "K1", msgNumber: "001", text: "first QAS line" },
      { severity: "W", msgClass: "K2", msgNumber: "003", text: "second QAS line" },
    ]);
  });

  it("'-' placeholders for severity/class/number become '', internal text spaces are preserved", async () => {
    const fake = classicFake({
      action: "read_transport_log",
      lines: () => [
        `ZMCP-TRLG-REQ ${TRKORR} T D`,
        "ZMCP-TRLG-SYS 1 A4H 0 20260915 103744 10",
        "ZMCP-TRLG-SYSTXT 1 ",
        "ZMCP-TRLG-RCTXT 1 ",
        "ZMCP-TRLG-LINE 1 - - - a message with   several words in it",
        "ZMCP-TRLG-COUNT 1",
        "TRLG-READ",
      ],
    });
    const { conn } = await connected(fake.route);
    const gate = bridgeAdminGate();
    const res = await readTransportLogViaBridge(conn, gate, { trkorr: TRKORR });
    const line = res.systems[0]!.lines[0]!;
    expect(line.severity).toBe("");
    expect(line.msgClass).toBe("");
    expect(line.msgNumber).toBe("");
    expect(line.text).toBe("a message with   several words in it");
  });

  it("a 'no such request' error line throws NOT_FOUND naming the TRKORR", async () => {
    const fake = classicFake({
      action: "read_transport_log",
      lines: () => [`${DDIC_ERR_PREFIX} no such request ${TRKORR}`],
    });
    const { conn } = await connected(fake.route);
    const gate = bridgeAdminGate();
    const err = await catchErr(readTransportLogViaBridge(conn, gate, { trkorr: TRKORR }));
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toContain(TRKORR);
  });

  it("the TRLG-READ tag with no ZMCP-TRLG-REQ line throws CHECK_FAILED (parser drift)", async () => {
    const fake = classicFake({ action: "read_transport_log", lines: () => ["TRLG-READ"] });
    const { conn } = await connected(fake.route);
    const gate = bridgeAdminGate();
    const err = await catchErr(readTransportLogViaBridge(conn, gate, { trkorr: TRKORR }));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("ZMCP-TRLG-REQ");
  });

  it("an invalid trkorr is rejected by assertTrkorr before any network call", async () => {
    const offline = null as unknown as AbapConnection;
    const gate = bridgeAdminGate();
    const err = await catchErr(readTransportLogViaBridge(offline, gate, { trkorr: "not-a-trkorr!" }));
    expect(err.code).toBe("BAD_INPUT");
  });
});

// =============================================================================
// GROUP 2 — readImportQueueViaBridge
// =============================================================================

describe("readImportQueueViaBridge", () => {
  it("an empty queue reports exact values (live-observed shape: 0 rows, subrc 0)", async () => {
    const fake = classicFake({
      action: "read_import_queue",
      lines: () => ["ZMCP-TRQU-HEAD A4H DOMAIN_A4H 20260915 103744 - 0", "TRQU-READ"],
    });
    const { conn } = await connected(fake.route);
    const gate = bridgeAdminGate();
    const res = await readImportQueueViaBridge(conn, gate, { system: "A4H" });
    expect(res.system).toBe("A4H");
    expect(res.domain).toBe("DOMAIN_A4H");
    expect(res.collectedDate).toBe("20260915");
    expect(res.collectedTime).toBe("103744");
    expect(res.collectFlag).toBe("");
    expect(res.entries).toEqual([]);
  });

  it("a '-' domain placeholder becomes ''", async () => {
    const fake = classicFake({
      action: "read_import_queue",
      lines: () => ["ZMCP-TRQU-HEAD A4H - 20260915 103744 - 0", "TRQU-READ"],
    });
    const { conn } = await connected(fake.route);
    const gate = bridgeAdminGate();
    const res = await readImportQueueViaBridge(conn, gate, { system: "A4H" });
    expect(res.domain).toBe("");
  });

  it("two ROW+TEXT pairs are paired by position, not by arrival order alone", async () => {
    const fake = classicFake({
      action: "read_import_queue",
      lines: () => [
        "ZMCP-TRQU-HEAD A4H DOMAIN_A4H 20260915 103744 - 2",
        "ZMCP-TRQU-ROW 0001 A4HK900001 X 0000 W DEVELOPER1 001",
        "ZMCP-TRQU-TEXT 0001 first request description",
        "ZMCP-TRQU-ROW 0002 A4HK900002 - 0004 K DEVELOPER2 001",
        "ZMCP-TRQU-TEXT 0002 second request description",
        "TRQU-READ",
      ],
    });
    const { conn } = await connected(fake.route);
    const gate = bridgeAdminGate();
    const res = await readImportQueueViaBridge(conn, gate, { system: "A4H" });
    expect(res.entries).toHaveLength(2);
    expect(res.entries[0]).toEqual({
      position: "0001",
      trkorr: "A4HK900001",
      importFlag: "X",
      maxRc: "0000",
      trFunction: "W",
      owner: "DEVELOPER1",
      targetClient: "001",
      description: "first request description",
    });
    expect(res.entries[1]).toEqual({
      position: "0002",
      trkorr: "A4HK900002",
      importFlag: "",
      maxRc: "0004",
      trFunction: "K",
      owner: "DEVELOPER2",
      targetClient: "001",
      description: "second request description",
    });
  });

  it("'-' placeholders on a row become ''", async () => {
    const fake = classicFake({
      action: "read_import_queue",
      lines: () => [
        "ZMCP-TRQU-HEAD A4H DOMAIN_A4H 20260915 103744 - 1",
        "ZMCP-TRQU-ROW 0001 - - - - - -",
        "ZMCP-TRQU-TEXT 0001 ",
        "TRQU-READ",
      ],
    });
    const { conn } = await connected(fake.route);
    const gate = bridgeAdminGate();
    const res = await readImportQueueViaBridge(conn, gate, { system: "A4H" });
    const e = res.entries[0]!;
    expect(e.trkorr).toBe("");
    expect(e.importFlag).toBe("");
    expect(e.maxRc).toBe("");
    expect(e.trFunction).toBe("");
    expect(e.owner).toBe("");
    expect(e.targetClient).toBe("");
  });

  it("a READ_CONFIG_FAILED error with EMPTY message fields still throws a clean NOT_FOUND (no 'undefined', no dangling punctuation)", async () => {
    // Live-verified on A4H 2026-09-15: IV_SYSTEM='DEV' came back READ_CONFIG_FAILED
    // with an EMPTY ES_EXCEPTION — the ABAP's fail() message must still read
    // sensibly blank, and the TS-side wrapper must not leak "undefined" from
    // an unset sy-msgid/msgno into the thrown message.
    const errLine = "cannot read the import queue of DEV: subrc=1 msg=  v1= exc-msg=  v1=";
    const fake = classicFake({
      action: "read_import_queue",
      lines: () => [`${DDIC_ERR_PREFIX} ${errLine}`],
    });
    const { conn } = await connected(fake.route);
    const gate = bridgeAdminGate();
    const err = await catchErr(readImportQueueViaBridge(conn, gate, { system: "DEV" }));
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).not.toContain("undefined");
    expect(err.message).not.toMatch(/[.,]{2,}/);
  });

  it("an empty system is refused BAD_INPUT before any network call", async () => {
    const offline = null as unknown as AbapConnection;
    const gate = bridgeAdminGate();
    const err = await catchErr(readImportQueueViaBridge(offline, gate, { system: "" }));
    expect(err.code).toBe("BAD_INPUT");
  });
});

// =============================================================================
// GROUP 3 — createTransportOfCopiesViaBridge
// =============================================================================

describe("createTransportOfCopiesViaBridge", () => {
  it("happy path: exact field values, including tasks: 0", async () => {
    const devClass = "ZPKG_COPIES";
    const gate = copiesGate(devClass);
    const fake = classicFake({
      action: "create_transport_of_copies",
      lines: () => ["ZMCP-TRTC-CREATED A4HK900501 T D A4H DEVELOPER1 0", "TRTC-CREATED"],
    });
    const { conn } = await connected(fake.route);
    const authorized = mintCopiesAuthorization(gate, devClass);
    const res = await createTransportOfCopiesViaBridge(
      conn,
      gate,
      { description: "copy to A4H", target: "A4H", devClass },
      authorized,
    );
    expect(res.trkorr).toBe("A4HK900501");
    expect(res.trFunction).toBe("T");
    expect(res.trStatus).toBe("D");
    expect(res.target).toBe("A4H");
    expect(res.owner).toBe("DEVELOPER1");
    expect(res.tasks).toBe(0);
  });

  // The most important test in this file: an AuthorizedTarget minted for one
  // package must never be usable to create a request recorded under a
  // DIFFERENT package — the runtime backstop in transport-copies.ts exists
  // as defense-in-depth on top of the type system (which only proves SOME
  // AuthorizedTarget<"transport", ...> was minted, never that it matches
  // THIS call's devClass). Uses an offline connection because the backstop
  // check is the very first thing the function does, before any network
  // call could happen — so a network call here would itself be a bug.
  it("SAFETY_DENIED backstop: an AuthorizedTarget minted for one package cannot create a request for another — zero classrun POSTs", async () => {
    const offline = null as unknown as AbapConnection;
    const gate = copiesGate("ZPKG_A");
    const authorizedForA = mintCopiesAuthorization(gate, "ZPKG_A");
    const err = await catchErr(
      createTransportOfCopiesViaBridge(
        offline,
        gate,
        { description: "sneaky", target: "A4H", devClass: "ZPKG_B" },
        authorizedForA,
      ),
    );
    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.message).toContain("ZPKG_A");
    expect(err.message).toContain("ZPKG_B");
  });

  it("a missing target is refused BAD_INPUT, naming why (cannot be imported anywhere)", async () => {
    const offline = null as unknown as AbapConnection;
    const devClass = "ZPKG_COPIES";
    const gate = copiesGate(devClass);
    const authorized = mintCopiesAuthorization(gate, devClass);
    const err = await catchErr(
      createTransportOfCopiesViaBridge(
        offline,
        gate,
        { description: "copy", target: "", devClass },
        authorized,
      ),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("target");
  });

  it("'allocated no request number' throws CHECK_FAILED", async () => {
    const devClass = "ZPKG_COPIES";
    const gate = copiesGate(devClass);
    const fake = classicFake({
      action: "create_transport_of_copies",
      lines: () => [`${DDIC_ERR_PREFIX} CTS reported success but allocated no request number`],
    });
    const { conn } = await connected(fake.route);
    const authorized = mintCopiesAuthorization(gate, devClass);
    const err = await catchErr(
      createTransportOfCopiesViaBridge(conn, gate, { description: "copy", target: "A4H", devClass }, authorized),
    );
    expect(err.code).toBe("CHECK_FAILED");
  });

  it("'but E070 has no row for it' throws CHECK_FAILED, message still names the allocated request number", async () => {
    const devClass = "ZPKG_COPIES";
    const gate = copiesGate(devClass);
    const errLine = "TR_INSERT_REQUEST_WITH_TASKS allocated A4HK900777 but E070 has no row for it";
    const fake = classicFake({
      action: "create_transport_of_copies",
      lines: () => [`${DDIC_ERR_PREFIX} ${errLine}`],
    });
    const { conn } = await connected(fake.route);
    const authorized = mintCopiesAuthorization(gate, devClass);
    const err = await catchErr(
      createTransportOfCopiesViaBridge(conn, gate, { description: "copy", target: "A4H", devClass }, authorized),
    );
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("A4HK900777");
  });

  it("the TRTC-CREATED tag with no matching ZMCP-TRTC-CREATED line throws CHECK_FAILED (parser drift)", async () => {
    const devClass = "ZPKG_COPIES";
    const gate = copiesGate(devClass);
    const fake = classicFake({ action: "create_transport_of_copies", lines: () => ["TRTC-CREATED"] });
    const { conn } = await connected(fake.route);
    const authorized = mintCopiesAuthorization(gate, devClass);
    const err = await catchErr(
      createTransportOfCopiesViaBridge(conn, gate, { description: "copy", target: "A4H", devClass }, authorized),
    );
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("ZMCP-TRTC-CREATED");
  });
});

// =============================================================================
// GROUP 4 — abap_transport tool layer (log / queue / create kind="copies")
// =============================================================================

describe("abap_transport log/queue/create — cheap refusals (zero network)", () => {
  it('log with no transport -> BAD_INPUT', async () => {
    const { conn, calls } = fakeCtsConnection([]);
    const gate = bridgeAdminGate();
    const err = await catchErr(abapTransport(conn, transportInput({ operation: "log" }), MAX_CHARS, gate));
    expect(err.code).toBe("BAD_INPUT");
    expect(calls.length).toBe(0);
  });

  it('queue with no system -> BAD_INPUT', async () => {
    const { conn, calls } = fakeCtsConnection([]);
    const gate = bridgeAdminGate();
    const err = await catchErr(abapTransport(conn, transportInput({ operation: "queue" }), MAX_CHARS, gate));
    expect(err.code).toBe("BAD_INPUT");
    expect(calls.length).toBe(0);
  });

  it('create kind="copies" with no target -> BAD_INPUT', async () => {
    const devClass = "ZPKG_COPIES";
    const { conn, calls } = fakeCtsConnection([]);
    const gate = copiesGate(devClass);
    const input = transportInput({ operation: "create", kind: "copies", package: devClass, description: "a copy" });
    const err = await catchErr(abapTransport(conn, input, MAX_CHARS, gate));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("target");
    expect(calls.length).toBe(0);
  });

  it('create kind="copies" with an object anchor -> BAD_INPUT (a transport of copies is created empty)', async () => {
    const devClass = "ZPKG_COPIES";
    const { conn, calls } = fakeCtsConnection([]);
    const gate = copiesGate(devClass);
    const input = transportInput({
      operation: "create",
      kind: "copies",
      package: devClass,
      description: "a copy",
      target: "A4H",
      object: "ZSOME_OBJECT",
    });
    const err = await catchErr(abapTransport(conn, input, MAX_CHARS, gate));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("object");
    expect(calls.length).toBe(0);
  });

  it('create kind="copies" is refused under a read-only gate with the SAME code an ordinary (workbench) create gets', async () => {
    // opCreate's gate.evaluate("transport", {name: devClass, packageName: devClass}, ...)
    // runs in the SHARED preamble before the kind==="copies" branch point, so
    // both kinds hit the exact same SafetyGate.evaluate() call and code path.
    // Read directly from safety.ts rather than assumed: a plain readOnly gate
    // denies any mutating "transport" op with code "READ_ONLY".
    const devClass = "ZPKG_COPIES";
    const { conn, calls } = fakeCtsConnection([]);
    const readOnlyGate = new SafetyGate({ readOnly: true, allowPackages: [] });

    const copiesErr = await catchErr(
      abapTransport(
        conn,
        transportInput({ operation: "create", kind: "copies", package: devClass, description: "a copy", target: "A4H" }),
        MAX_CHARS,
        readOnlyGate,
      ),
    );
    const workbenchErr = await catchErr(
      abapTransport(
        conn,
        transportInput({ operation: "create", package: devClass, description: "a workbench request" }),
        MAX_CHARS,
        readOnlyGate,
      ),
    );

    expect(copiesErr.code).toBe("READ_ONLY");
    expect(workbenchErr.code).toBe("READ_ONLY");
    expect(copiesErr.code).toBe(workbenchErr.code);
    expect(calls.length).toBe(0);
  });
});

describe("abap_transport log — rendering", () => {
  it("a system with zero log lines renders as the normal answer, not a failure", async () => {
    const fake = classicFake({
      action: "read_transport_log",
      lines: () => [
        `ZMCP-TRLG-REQ ${TRKORR} K D`,
        "ZMCP-TRLG-SYS 1 A4H - 20260915 103744 10",
        "ZMCP-TRLG-SYSTXT 1 ",
        "ZMCP-TRLG-RCTXT 1 ",
        "ZMCP-TRLG-COUNT 1",
        "TRLG-READ",
      ],
    });
    const { conn } = await connected(fake.route);
    const gate = bridgeAdminGate();
    const result = await abapTransport(conn, transportInput({ operation: "log", transport: TRKORR }), MAX_CHARS, gate);
    expect(result.text).toContain("normal answer, not a failure");
    expect(result.text).not.toContain("No log lines recorded for this system.\n\nNo log lines");
  });

  it("renders trFunction/trStatus as readable labels with the raw code alongside", async () => {
    const fake = classicFake({
      action: "read_transport_log",
      lines: () => [
        `ZMCP-TRLG-REQ ${TRKORR} T D`,
        "ZMCP-TRLG-SYS 1 A4H 0 20260915 103744 10",
        "ZMCP-TRLG-SYSTXT 1 ",
        "ZMCP-TRLG-RCTXT 1 ",
        "ZMCP-TRLG-COUNT 1",
        "TRLG-READ",
      ],
    });
    const { conn } = await connected(fake.route);
    const gate = bridgeAdminGate();
    const result = await abapTransport(conn, transportInput({ operation: "log", transport: TRKORR }), MAX_CHARS, gate);
    expect(result.text).toContain("trFunction: transport of copies (T)");
    expect(result.text).toContain("trStatus: modifiable (D)");
  });
});

describe("abap_transport queue — rendering", () => {
  it("an empty queue renders an unambiguous 'not an error' note", async () => {
    const fake = classicFake({
      action: "read_import_queue",
      lines: () => ["ZMCP-TRQU-HEAD A4H DOMAIN_A4H 20260915 103744 - 0", "TRQU-READ"],
    });
    const { conn } = await connected(fake.route);
    const gate = bridgeAdminGate();
    const result = await abapTransport(conn, transportInput({ operation: "queue", system: "A4H" }), MAX_CHARS, gate);
    expect(result.text).toContain("EMPTY");
    expect(result.text).toContain("not an error");
  });

  it("the import-buffer caveat note renders UNCONDITIONALLY on both empty and non-empty queues", async () => {
    const caveat = "not a history";

    const emptyFake = classicFake({
      action: "read_import_queue",
      lines: () => ["ZMCP-TRQU-HEAD A4H DOMAIN_A4H 20260915 103744 - 0", "TRQU-READ"],
    });
    const { conn: emptyConn } = await connected(emptyFake.route);
    const gate = bridgeAdminGate();
    const emptyResult = await abapTransport(
      emptyConn,
      transportInput({ operation: "queue", system: "A4H" }),
      MAX_CHARS,
      gate,
    );
    expect(emptyResult.text).toContain(caveat);

    const nonEmptyFake = classicFake({
      action: "read_import_queue",
      lines: () => [
        "ZMCP-TRQU-HEAD A4H DOMAIN_A4H 20260915 103744 - 1",
        "ZMCP-TRQU-ROW 0001 A4HK900001 X 0000 W DEVELOPER1 001",
        "ZMCP-TRQU-TEXT 0001 a queued request",
        "TRQU-READ",
      ],
    });
    const { conn: nonEmptyConn } = await connected(nonEmptyFake.route);
    const nonEmptyResult = await abapTransport(
      nonEmptyConn,
      transportInput({ operation: "queue", system: "A4H" }),
      MAX_CHARS,
      gate,
    );
    expect(nonEmptyResult.text).toContain(caveat);
  });
});

describe('abap_transport create kind="copies" — end to end', () => {
  it("succeeds, echoing package/target/owner/tasks in the response", async () => {
    const devClass = "ZPKG_COPIES";
    const gate = copiesGate(devClass);
    const fake = classicFake({
      action: "create_transport_of_copies",
      lines: () => ["ZMCP-TRTC-CREATED A4HK900601 T D A4H DEVELOPER1 0", "TRTC-CREATED"],
    });
    const { conn } = await connected(fake.route);
    const input = transportInput({
      operation: "create",
      kind: "copies",
      package: devClass,
      description: "copy to A4H",
      target: "A4H",
    });
    const result = await abapTransport(conn, input, MAX_CHARS, gate);
    expect(result.text).toContain("transport: A4HK900601");
    expect(result.text).toContain(`package: ${devClass}`);
    expect(result.text).toContain("target: A4H");
    expect(result.text).toContain("tasks: 0");
  });
});

describe("abap_transport — journalling", () => {
  let tmp: string;
  let warn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "abapsmith-tr-landscape-journal-"));
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

  it('create kind="copies" journals one succeeded transport-create entry under the returned TRKORR', async () => {
    const devClass = "ZPKG_COPIES";
    const gate = copiesGate(devClass);
    const fake = classicFake({
      action: "create_transport_of_copies",
      lines: () => ["ZMCP-TRTC-CREATED A4HK900602 T D A4H DEVELOPER1 0", "TRTC-CREATED"],
    });
    const { conn } = await connected(fake.route);
    const input = transportInput({
      operation: "create",
      kind: "copies",
      package: devClass,
      description: "copy to A4H",
      target: "A4H",
    });
    await abapTransport(conn, input, MAX_CHARS, gate, deps());

    const list = await written();
    expect(list.length, "journal entries").toBe(1);
    const entry = list[0]!;
    expect(entry.outcome).toBe("succeeded");
    expect(entry.corrNr).toBe("A4HK900602");
    expect(entry.tool).toBe("abap_transport create kind=copies");
  });

  // Load-bearing: log/queue are documented as plain reads (see
  // transportInputSchema's operation description: "list/show/check/users/
  // log/queue are plain reads, always allowed"). If either ever started
  // journalling, the journal would stop being a record of what CHANGED.
  it("log and queue reads never journal — zero journal entries for either", async () => {
    const logFake = classicFake({
      action: "read_transport_log",
      lines: () => [`ZMCP-TRLG-REQ ${TRKORR} K D`, "ZMCP-TRLG-COUNT 0", "TRLG-READ"],
    });
    const { conn: logConn } = await connected(logFake.route);
    const gate = bridgeAdminGate();
    await abapTransport(logConn, transportInput({ operation: "log", transport: TRKORR }), MAX_CHARS, gate, deps());
    expect((await written()).length, "journal entries after log").toBe(0);

    const queueFake = classicFake({
      action: "read_import_queue",
      lines: () => ["ZMCP-TRQU-HEAD A4H DOMAIN_A4H 20260915 103744 - 0", "TRQU-READ"],
    });
    const { conn: queueConn } = await connected(queueFake.route);
    await abapTransport(queueConn, transportInput({ operation: "queue", system: "A4H" }), MAX_CHARS, gate, deps());
    expect((await written()).length, "journal entries after queue").toBe(0);
  });
});

// =============================================================================
// GROUP 5 — structural regression guards on the generated ABAP
// =============================================================================

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

function methodBody(name: string): string {
  const start = transportPart.source.indexOf(`METHOD ${name}.`);
  expect(start, `METHOD ${name}. not found in transportPart.source`).toBeGreaterThanOrEqual(0);
  const after = transportPart.source.slice(start + `METHOD ${name}.`.length);
  const end = after.indexOf("\n  ENDMETHOD.");
  return after.slice(0, end === -1 ? undefined : end);
}

describe("transportPart — structural regression guard", () => {
  it("every name in transportPart.methods has a matching METHOD in the source, and vice versa (no orphans)", () => {
    for (const name of transportPart.methods) {
      expect(transportPart.source).toContain(`METHOD ${name}.`);
    }
    const declared = [...transportPart.source.matchAll(/^  METHOD (\w+)\./gm)].map((m) => m[1]);
    expect([...declared].sort()).toEqual([...transportPart.methods].sort());
  });

  it("all three new action names are registered in classicManifest.actions", () => {
    const names = classicManifest.actions.map((a) => a.name);
    expect(names).toContain("read_transport_log");
    expect(names).toContain("read_import_queue");
    expect(names).toContain("create_transport_of_copies");
  });

  it("no generated ABAP line in the real classic body class exceeds the 255-char limit", () => {
    // Hit for real during development: a line over ABAP_SOURCE_LINE_MAX 255s
    // the PUT with SEDI_ADT15/TooLongLine — build the body the same way the
    // manifest does (classicManifest.objects[...].source.text), not just
    // transportPart's own fragment, since concatenation with other parts
    // could in principle push something over the edge even if each part
    // alone stays under it.
    const bodyObject = classicManifest.objects.find((o) => o.name === CLASSIC_BODY_CLASS);
    expect(bodyObject).toBeDefined();
    const lines = bodyObject!.source.text.split("\n");
    const maxLen = Math.max(...lines.map((l) => l.length));
    expect(maxLen).toBeLessThanOrEqual(ABAP_SOURCE_LINE_MAX);
  });

  it("read_import_queue passes iv_clear_locks/iv_update_cache/iv_monitor as space, not their FM defaults", () => {
    // WHY: TMS_MGR_READ_TRANSPORT_QUEUE defaults these (and others) to 'X' in
    // its OWN signature, and at least these three are side-effecting —
    // clearing TMS locks / rewriting the TMS cache — which an operation
    // documented as read-only must never do as a side effect of a read.
    const body = norm(methodBody("read_import_queue"));
    expect(body).toContain(norm("iv_clear_locks      = space"));
    expect(body).toContain(norm("iv_update_cache     = space"));
    expect(body).toContain(norm("iv_monitor          = space"));
  });

  it("create_transport_of_copies passes iv_type = 'T'", () => {
    const body = norm(methodBody("create_transport_of_copies"));
    expect(body).toContain(norm("iv_type           = 'T'"));
  });

  it("read_transport_log SELECTs from e070 BEFORE calling TRINT_GET_LOG_OVERVIEW", () => {
    // WHY: TRINT_GET_LOG_OVERVIEW answers sy-subrc 0 even for a request
    // number that does not exist at all — live-proven on A4H 2026-09-15 with
    // A4HK999999, which came back with the same "not yet imported" row a
    // real request gets. Without the E070 check running FIRST, a typo'd
    // request number would silently produce a confident but meaningless
    // answer instead of a NOT_FOUND refusal.
    const body = methodBody("read_transport_log");
    const selectIdx = body.indexOf("SELECT SINGLE * FROM e070");
    const callIdx = body.indexOf("CALL FUNCTION 'TRINT_GET_LOG_OVERVIEW'");
    expect(selectIdx).toBeGreaterThanOrEqual(0);
    expect(callIdx).toBeGreaterThan(selectIdx);
  });

  it("ZMCP-TRLG-SYS and ZMCP-TRQU-HEAD emit DATE = RAW / TIME = RAW, not a plain date/time embed", () => {
    // WHY: a plain { ls_ovw-moddate }/{ lv_date } embed is converted to the
    // CURRENT USER's date/time format (e.g. "15.09.2026"), not the fixed
    // wire form "20260915" the TS side parses — the wire protocol must not
    // depend on whose user profile is running it.
    const logBody = methodBody("read_transport_log");
    expect(logBody).toContain("{ ls_ovw-moddate DATE = RAW }");
    expect(logBody).toContain("{ ls_ovw-modtime TIME = RAW }");
    const queueBody = methodBody("read_import_queue");
    expect(queueBody).toContain("{ lv_date DATE = RAW }");
    expect(queueBody).toContain("{ lv_time TIME = RAW }");
  });
});

// =============================================================================
// GROUP 6 — DDIC tag registration
// =============================================================================

describe("DDIC_TAGS registration for the three new tags", () => {
  it("TRLG-READ, TRQU-READ, TRTC-CREATED are all registered", () => {
    expect(DDIC_TAGS).toContain("TRLG-READ");
    expect(DDIC_TAGS).toContain("TRQU-READ");
    expect(DDIC_TAGS).toContain("TRTC-CREATED");
  });

  it.each(["TRLG-READ", "TRQU-READ", "TRTC-CREATED"] as const)(
    "%s requires EXACT trimmed-line equality — a line with trailing content does not set the tag",
    (tag) => {
      const exact = parseDdicTranscript(`${tag}\n`);
      expect(exact.tags).toContain(tag);

      const withExtra = parseDdicTranscript(`${tag} extra\n`);
      expect(withExtra.tags).not.toContain(tag);
    },
  );
});
