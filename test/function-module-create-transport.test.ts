/**
 * #171: a FUGR/FF (function module) create has no package of its own — it
 * lives in its group's package. Before the fix, `resolveWriteTarget` left a
 * new module's package unresolved, so the CTS pre-flight was asked about
 * $TMP, the create POST carried no corrNr, and — when the group's include
 * was already locked in a real request — the server's 403 (CTS_WBO_API/019)
 * came back as a generic, unclassified ADT_ERROR.
 *
 * Fixtures (test/fixtures/live-captured/), real A4H captures against
 * ZAS_FG171/ZAS_FM_ONE: 984 module-GET 404, 985 group-GET with
 * packageRef ZTMA_COURSES, 986 transportchecks answer when DEVCLASS was
 * $TMP (KORRFLAG empty — the pre-fix, broken path), 987 the same with
 * DEVCLASS ZTMA_COURSES (KORRFLAG X, LOCKS pinning A4HK900306/ABAPSMITH),
 * 988 the 403 the module-create POST gets back without corrNr, 989 the LOCK
 * answer naming CORRNR A4HK900306.
 *
 * Harness copied from test/write-transport-note.test.ts — the one existing
 * test that drives `abapWrite` end to end through a real `SessionTransport`
 * whose `trRequirement` hits the fake wire.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { abapWrite } from "../src/tools/write.js";
import { resolveWriteTarget } from "../src/adt/write.js";
import { isAbapError } from "../src/adt/errors.js";
import { SafetyGate } from "../src/safety.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import type { TrRequest } from "../src/adt/transports.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "live-captured");
const fx = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const FMODULE_404 = fx("984-i171-fmodule-get-404.xml");
const FGROUP_PACKAGEREF = fx("985-i171-fgroup-get-packageref.xml");
const TRANSPORTCHECKS_TMP_LOCKED = fx("986-i171-transportchecks-tmp-locked.xml");
const TRANSPORTCHECKS_ZTMA_LOCKED = fx("987-i171-transportchecks-ztma-locked.xml");
const FMODULE_403_LOCKED = fx("988-i171-fmodule-post-403-cts-wbo-api-19.xml");
const FMODULE_LOCK_CORRNR = fx("989-i171-fmodule-lock-corrnr.xml");

const GROUP_NAME = "ZAS_FG171";
const MODULE_NAME = "ZAS_FM_ONE";
const OBJECT_REF = `${GROUP_NAME}/${MODULE_NAME}`;
const GROUP_URI = "/sap/bc/adt/functions/groups/zas_fg171";
const MODULE_URI = `${GROUP_URI}/fmodules/zas_fm_one`;
const MODULE_SRC = `${MODULE_URI}/source/main`;
const CREATE_URI = `${GROUP_URI}/fmodules`;
const TRANSPORTCHECKS = "/sap/bc/adt/cts/transportchecks";
const SOURCE = "FUNCTION zas_fm_one.\nENDFUNCTION.\n";

interface Recorded {
  label: string;
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
  headers?: Record<string, string>;
}

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
  statusText?: string,
): HttpClientResponse =>
  ({ status, statusText: statusText ?? String(status), body, headers }) as unknown as HttpClientResponse;

const OK_TEXT = { "content-type": "text/plain" };
const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

type Route = (r: Recorded) => HttpClientResponse | undefined;

class FakeAdt implements HttpClient {
  readonly calls: Recorded[] = [];
  constructor(private readonly route: Route) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const method = (o.method ?? "GET").toUpperCase();
    const qs = (o.qs ?? {}) as Record<string, string>;
    const label = qs._action ? `${qs._action} ${o.url}` : `${method} ${o.url}`;
    const rec: Recorded = { label, method, url: o.url, qs, body: o.body, headers: o.headers as Record<string, string> };
    this.calls.push(rec);
    const res = this.route(rec);
    if (!res) throw new Error(`FakeAdt: unrouted request ${label}`);
    return res;
  }
}

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "ABAPSMITH",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
  });

function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle"))
    return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
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

const CLEAN_CHECKRUN = `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>`;

const gate = (allowPackages: string[] = ["ZTMA_COURSES"]) =>
  new SafetyGate({ readOnly: false, allowPackages, allowTransports: ["auto"] });

const authorizeCreate = (g: SafetyGate) => (devClass: string) =>
  g.authorize("transport", { name: devClass, packageName: devClass }, { corr: { kind: "unresolved" } });

/** Only `status`/`owner` are read by the resolver's pin path; the rest satisfies `TrRequest`. */
const trRequest = (trkorr: string): TrRequest => ({
  trkorr,
  kind: "workbench",
  kindRaw: "K",
  status: "modifiable",
  statusRaw: "D",
  owner: "ABAPSMITH",
  description: "abapsmith session 2026-09-22",
  tasks: [],
  objects: [],
});

function makeTransport(g: SafetyGate): { transport: SessionTransport; trCreate: ReturnType<typeof vi.fn> } {
  const trCreate = vi.fn(async () => {
    throw new Error("trCreate must not be called: the request comes from the LOCKS pin");
  });
  const trShow = vi.fn(async (_conn: AbapConnection, trkorr: string) => trRequest(trkorr));
  const transport = new SessionTransport({
    allowTransports: ["auto"],
    authorizeCreate: authorizeCreate(g),
    whoami: () => "ABAPSMITH",
    cts: { trCreate, trShow },
  });
  return { transport, trCreate };
}

describe("FUGR/FF create in a transportable package goes into the request holding the group's include (#171)", () => {
  it("derives the module's package from its group: the pre-flight asks CTS about ZTMA_COURSES and the create POST carries corrNr=A4HK900306", async () => {
    const g = gate();
    const { conn, adt } = await connected((r) => {
      if (r.url === MODULE_URI && r.method === "GET") return resp(404, FMODULE_404, OK_XML);
      if (r.url === GROUP_URI && r.method === "GET") return resp(200, FGROUP_PACKAGEREF, OK_XML);
      if (r.url === TRANSPORTCHECKS && r.method === "POST") {
        // The real bug: a broken package derivation asked CTS about $TMP.
        // Answering with the $TMP-shaped fixture there would make this test
        // fail exactly the way the bug did.
        return r.body?.includes("<DEVCLASS>ZTMA_COURSES</DEVCLASS>")
          ? resp(200, TRANSPORTCHECKS_ZTMA_LOCKED, OK_XML)
          : resp(200, TRANSPORTCHECKS_TMP_LOCKED, OK_XML);
      }
      if (r.url === CREATE_URI && r.method === "POST") return resp(201, "", OK_TEXT);
      if (r.qs._action === "LOCK") return resp(200, FMODULE_LOCK_CORRNR, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === MODULE_SRC && r.method === "PUT") return resp(200, "", OK_TEXT);
      if (r.url.includes("/checkruns")) return resp(200, CLEAN_CHECKRUN, OK_XML);
      return undefined;
    });

    const { transport, trCreate } = makeTransport(g);

    const result = await abapWrite(
      conn,
      { object: OBJECT_REF, type: "FUGR/FF", source: SOURCE, activate: false },
      20_000,
      g,
      undefined,
      transport,
    );

    const transportChecksBody = adt.calls.find(
      (c) => c.url === TRANSPORTCHECKS && c.method === "POST",
    )?.body;
    expect(transportChecksBody).toContain("<DEVCLASS>ZTMA_COURSES</DEVCLASS>");

    const createCall = adt.calls.find((c) => c.url === CREATE_URI && c.method === "POST");
    expect(createCall?.qs.corrNr).toBe("A4HK900306");

    expect(result.text).toMatch(/^transport: A4HK900306$/m);
    expect(result.text).toMatch(/^package: ZTMA_COURSES$/m);
    expect(result.text).toMatch(/^package_source: container$/m);
    expect(result.text).toMatch(/^created: true$/m);

    expect(trCreate).not.toHaveBeenCalled();

    const groupIdx = adt.calls.findIndex((c) => c.url === GROUP_URI && c.method === "GET");
    const checksIdx = adt.calls.findIndex((c) => c.url === TRANSPORTCHECKS && c.method === "POST");
    expect(groupIdx).toBeGreaterThanOrEqual(0);
    expect(checksIdx).toBeGreaterThan(groupIdx);
  });

  it("reports packageSource 'container' on the resolved target, and never asks CTS about $TMP", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === MODULE_URI && r.method === "GET") return resp(404, FMODULE_404, OK_XML);
      if (r.url === GROUP_URI && r.method === "GET") return resp(200, FGROUP_PACKAGEREF, OK_XML);
      return undefined;
    });

    const target = await resolveWriteTarget(conn, { type: "FUGR/FF", name: OBJECT_REF });

    expect(target.exists).toBe(false);
    expect(target.packageName).toBe("ZTMA_COURSES");
    expect(target.packageSource).toBe("container");
    expect(adt.calls.some((c) => c.url === TRANSPORTCHECKS)).toBe(false);
  });

  it("refuses a package argument that disagrees with the group's package before any transport call", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === MODULE_URI && r.method === "GET") return resp(404, FMODULE_404, OK_XML);
      if (r.url === GROUP_URI && r.method === "GET") return resp(200, FGROUP_PACKAGEREF, OK_XML);
      return undefined;
    });

    let thrown: unknown;
    try {
      await resolveWriteTarget(conn, { type: "FUGR/FF", name: OBJECT_REF, packageName: "$TMP" });
    } catch (e) {
      thrown = e;
    }

    expect(isAbapError(thrown)).toBe(true);
    if (isAbapError(thrown)) {
      expect(thrown.code).toBe("BAD_INPUT");
      expect(thrown.message).toContain("ZTMA_COURSES");
      expect(thrown.message).toContain("$TMP");
    }
    expect(adt.calls.some((c) => c.url === TRANSPORTCHECKS)).toBe(false);
    expect(adt.calls.some((c) => c.url === CREATE_URI && c.method === "POST")).toBe(false);
  });

  it("falls back to the requested package when the group cannot be read", async () => {
    const { conn } = await connected((r) => {
      if (r.url === MODULE_URI && r.method === "GET") return resp(404, FMODULE_404, OK_XML);
      if (r.url === GROUP_URI && r.method === "GET") return resp(404, FMODULE_404, OK_XML);
      return undefined;
    });

    const target = await resolveWriteTarget(conn, { type: "FUGR/FF", name: OBJECT_REF });

    expect(target.packageName).toBe("$TMP");
    expect(target.packageSource).toBe("requested");
  });

  it("the 403 the old path produced is now TRANSPORT_LOCKED and names the holding request", async () => {
    const g = gate(["$TMP", "ZTMA_COURSES"]);
    const { conn } = await connected((r) => {
      if (r.url === MODULE_URI && r.method === "GET") return resp(404, FMODULE_404, OK_XML);
      // The group GET 404s too, so the package really is $TMP — this is the
      // pre-fix shape, not the fixed one.
      if (r.url === GROUP_URI && r.method === "GET") return resp(404, FMODULE_404, OK_XML);
      if (r.url === TRANSPORTCHECKS && r.method === "POST")
        return resp(200, TRANSPORTCHECKS_TMP_LOCKED, OK_XML);
      if (r.url === CREATE_URI && r.method === "POST")
        return resp(403, FMODULE_403_LOCKED, OK_XML, "Forbidden");
      return undefined;
    });

    const { transport } = makeTransport(g);

    let thrown: unknown;
    try {
      await abapWrite(
        conn,
        { object: OBJECT_REF, type: "FUGR/FF", source: SOURCE, activate: false },
        20_000,
        g,
        undefined,
        transport,
      );
    } catch (e) {
      thrown = e;
    }

    expect(isAbapError(thrown)).toBe(true);
    if (isAbapError(thrown)) {
      expect(thrown.code).toBe("TRANSPORT_LOCKED");
      expect(thrown.details.classifiedBy).toBe("cts-object-locked-in-other-request");
      expect(thrown.details.holdingRequest).toBe("A4HK900306");
      expect(thrown.details.holdingUser).toBe("ABAPSMITH");
      expect(thrown.details.lockedObject).toBe("LIMU REPS LZAS_FG171UXX");
      expect(thrown.hint).toContain("A4HK900306");
      expect(thrown.hint).toMatch(/corr_nr/);
      expect(thrown.hint).not.toMatch(/was not recognised by any specific rule here/);
    }
  });
});
