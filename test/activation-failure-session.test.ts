/**
 * The stranded-enqueue defect (live run).
 *
 * `abap_activate` takes no client-side lock, and `withStatefulSession` already
 * `unlockAll()`s in a `finally` — so the `Object LIMU REPS <name>UXX is
 * already locked` error hit on every subsequent write was neither an
 * abapsmith lock object nor a leaked stateful session. It was the SAP-side
 * enqueue a phase-two preaudit POST takes on each named object
 * (`POST /sap/bc/adt/activation`), stranded because the handshake ended
 * not-activated with nothing left to release it. That enqueue is bound to the
 * `sap-contextid`, not a user, so the only lever the client has is
 * `conn.dropSession()` (`src/adt/activate.ts`'s `releaseActivationEnqueues`).
 * This file pins when that lever is pulled, and — just as importantly — when
 * it is not: on a plain failure with no handshake, or while the caller's own
 * session still holds locks of its own.
 *
 * No network: fake `HttpClient`, same `RoutingClient`/`sequence`/`isPhase1`/
 * `isPhase2`/`connect` idiom as test/activation-preaudit.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection, type RawRequestOptions } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { isAbapError } from "../src/adt/errors.js";
import { activateObject, activateObjects, assertNoErrors, type ActivationTarget } from "../src/adt/activate.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// --------------------------------------------------------------- fixtures ---

/**
 * The FUGR/F seed. Named after the live incident's evidence directly: its
 * generated `UXX` include follows SAP's `L<group>UXX` naming, so
 * `ZTMD_HS358B_FG` is the group whose stranded lock read
 * `Object LIMU REPS LZTMD_HS358B_FGUXX is already locked`.
 */
const FUGR_SEED: ActivationTarget = {
  name: "ZTMD_HS358B_FG",
  uri: "/sap/bc/adt/functions/groups/ztmd_hs358b_fg",
  type: "FUGR/F",
};

const VERSIONS_URL = `${FUGR_SEED.uri}/versions`;

/**
 * A DDIC-mode target — `chunkActivationTargets` never merges it into
 * `FUGR_SEED`'s chunk (different class), so a two-object batch of
 * `[FUGR_SEED, DDIC_SEED]` always travels as two sequential POSTs, no chunk
 * cap override needed.
 */
const DDIC_SEED: ActivationTarget = {
  name: "ZTMD_HS358B_DOM",
  uri: "/sap/bc/adt/ddic/domains/ztmd_hs358b_dom",
  type: "DOMA/DD",
};

/**
 * HAND-WRITTEN — the structure document `conn.adt.revisions()` GETs first,
 * to resolve the versions link relation. Non-class shape (`atom:link` at
 * root, not nested under `class:include`), per abap-adt-api's
 * `objectStructure()`/`getRevisionLink()` (`node_modules/abap-adt-api/build/
 * api/objectstructure.js`, `api/revisions.js`). Modelled on the shape those
 * two functions require, not on a capture.
 */
const FUGR_STRUCTURE = `<?xml version="1.0" encoding="utf-8"?><group:abapFunctionGroup xmlns:group="http://www.sap.com/adt/functions/groups" xmlns:adtcore="http://www.sap.com/adt/core" xmlns:atom="http://www.w3.org/2005/Atom" adtcore:name="ZTMD_HS358B_FG" adtcore:type="FUGR/F"><atom:link href="versions" rel="http://www.sap.com/adt/relations/versions" type="application/atom+xml;type=feed"/></group:abapFunctionGroup>`;

/**
 * SYNTHETIC — an Atom version feed carrying a `99999` (INACTIVE) entry.
 * Modelled on `test/fixtures/revisions/versions-feed-ztmp-local-class-a4h-754.xml`
 * (a real, active-only A4H capture) for the envelope and the one attested
 * entry's shape; the `99999` entry itself is not captured anywhere in this
 * repo (see that file's neighbouring tests) and is inferred from
 * `versionIdFromContentUri`/`revisionKind` in src/adt/revisions.ts: the
 * version id is the second-to-last `/`-segment of `atom:content/@src`, with
 * `versions` as the segment four back from the end.
 */
const VERSIONS_FEED_STILL_INACTIVE = `<?xml version="1.0" encoding="utf-8"?><atom:feed xmlns:atom="http://www.w3.org/2005/Atom" xmlns:adtcore="http://www.sap.com/adt/core"><atom:title>Version List of ZTMD_HS358B_FG (FUGR/F)</atom:title><atom:updated>2026-08-28T00:00:00Z</atom:updated><atom:entry><atom:author><atom:name>DEVELOPER</atom:name></atom:author><atom:content type="text/plain" src="${VERSIONS_URL}/20260828000000/99999/content"/><atom:id>99999</atom:id><atom:updated>2026-08-28T00:00:00Z</atom:updated></atom:entry></atom:feed>`;

/**
 * CONSTRUCTED — same `ioc:entry`/`ioc:object`/`ioc:ref` shape as
 * `PREAUDIT_ZMCP_MAIN` in test/activation-preaudit.test.ts (itself CONSTRUCTED
 * from curl probing during the incident, not a saved body), adapted to name the FUGR
 * seed plus its generated `UXX` include — the object the stranded lock
 * actually named.
 */
const PREAUDIT_FUGR_UXX = `<?xml version="1.0" encoding="utf-8"?>
<ioc:inactiveObjects xmlns:ioc="http://www.sap.com/abapxml/inactiveCtsObjects" xmlns:adtcore="http://www.sap.com/adt/core">
  <ioc:entry>
    <ioc:object ioc:user="DEVELOPER" ioc:deleted="false">
      <ioc:ref adtcore:uri="/sap/bc/adt/functions/groups/ztmd_hs358b_fg" adtcore:type="FUGR/F" adtcore:name="ZTMD_HS358B_FG" adtcore:parentUri=""/>
    </ioc:object>
  </ioc:entry>
  <ioc:entry>
    <ioc:object ioc:user="DEVELOPER" ioc:deleted="false">
      <ioc:ref adtcore:uri="/sap/bc/adt/functions/groups/ztmd_hs358b_fg/includes/lztmd_hs358b_fguxx" adtcore:type="FUGR/I" adtcore:name="LZTMD_HS358B_FGUXX" adtcore:parentUri="/sap/bc/adt/functions/groups/ztmd_hs358b_fg"/>
    </ioc:object>
  </ioc:entry>
</ioc:inactiveObjects>`;

/**
 * CONSTRUCTED — a genuine phase-one syntax error, same `chkl:messages`
 * envelope as every other message fixture in test/activation-preaudit.test.ts
 * and test/activate.test.ts. No `ioc:inactiveObjects` at all, so no phase two
 * is possible: this is the ordinary failure path, not the handshake.
 */
const PLAIN_SYNTAX_ERROR = `<?xml version="1.0" encoding="utf-8"?><chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist"><msg objDescr="Function Group ZTMD_HS358B_FG" type="E" line="1" href="/sap/bc/adt/functions/groups/ztmd_hs358b_fg/source/main#start=4,2"><shortText><txt>The statement "WRIT" is not expected.</txt></shortText></msg></chkl:messages>`;

// ------------------------------------------------------------- transport ---

interface Route {
  match: (o: HttpClientOptions) => boolean;
  reply: HttpClientResponse | (() => HttpClientResponse);
}

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const XML = { "content-type": "application/xml; charset=utf-8" };
const ATOM = { "content-type": "application/atom+xml;type=feed" };

/** A route reply that changes on successive matching calls, oldest first — same helper as test/activation-preaudit.test.ts. */
function sequence(...replies: HttpClientResponse[]): () => HttpClientResponse {
  let i = 0;
  return () => replies[Math.min(i++, replies.length - 1)]!;
}

class RoutingClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(private readonly routes: Route[]) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    const hit = this.routes.find((r) => r.match(o));
    if (!hit) return resp(200, "ok", { "content-type": "text/plain" });
    return typeof hit.reply === "function" ? hit.reply() : hit.reply;
  }
}

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "secret",
    sid: "TST",
    client: "001",
  });

const onActivation: Route["match"] = (o) => o.url.includes("/sap/bc/adt/activation");
const onDataPreview: Route["match"] = (o) => o.url.includes("/sap/bc/adt/datapreview/freestyle");
const isPhase1: Route["match"] = (o) =>
  onActivation(o) && String((o.qs as Record<string, unknown> | undefined)?.["preauditRequested"]) === "true";
const isPhase2: Route["match"] = (o) =>
  onActivation(o) && String((o.qs as Record<string, unknown> | undefined)?.["preauditRequested"]) === "false";
const onStructure: Route["match"] = (o) => o.url === FUGR_SEED.uri;
const onVersionsFeed: Route["match"] = (o) => o.url === VERSIONS_URL;

const T000_ROUTE: Route = {
  match: onDataPreview,
  reply: resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML),
};

const onLogon: Route["match"] = (o) => o.url.includes("/sap/bc/adt/compatibility/graph");
/**
 * Without a CSRF token in the reply, `AdtHTTP.loggedin` never flips true, so
 * every request — including the two plain GETs `conn.adt.revisions()` makes,
 * which bypass `AbapConnection`'s own budgeted request wrapper — re-triggers
 * `login()` against the logon endpoint. That runs straight into
 * `connection.ts`'s own unbudgeted-logon-endpoint ceiling (5 per connection)
 * and the run fails with `Refused logon-endpoint request #6 …` before the
 * revisions calls are ever reached. This route is what test/
 * activation-preaudit.test.ts's `activateObjects` batch test also needs it
 * for, for the same reason.
 */
const LOGON_ROUTE: Route = {
  match: onLogon,
  reply: resp(200, "<graph/>", { "content-type": "application/xml", "x-csrf-token": "TOKEN123" }),
};

/** Phase two goes through `AbapConnection.post()`, which is write-gated — see test/activation-preaudit.test.ts's `connectWrite`. */
async function connectWrite(routes: Route[]): Promise<{ conn: AbapConnection; http: RoutingClient }> {
  const http = new RoutingClient([...routes, T000_ROUTE]);
  const conn = new AbapConnection(ConfigSchema.parse({ ...cfg(), readOnly: false }), {
    httpClient: http,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  return { conn, http };
}

async function connect(routes: Route[]): Promise<{ conn: AbapConnection; http: RoutingClient }> {
  const http = new RoutingClient([...routes, T000_ROUTE]);
  const conn = new AbapConnection(cfg(), {
    httpClient: http,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  return { conn, http };
}

/**
 * The full stranded-enqueue shape: phase one names the seed plus its generated `UXX`
 * include, phase two answers an empty 200, and the revisions verification
 * (structure doc, then the versions feed) still shows a `99999` row — so the
 * handshake ends not-activated with a phase-two enqueue nothing else releases.
 */
function notActivatedViaRevisions(extraRoutes: Route[] = []): Route[] {
  return [
    { match: isPhase1, reply: resp(200, PREAUDIT_FUGR_UXX, XML) },
    { match: isPhase2, reply: resp(200, "", { "content-length": "0" }) },
    { match: onStructure, reply: resp(200, FUGR_STRUCTURE, XML) },
    { match: onVersionsFeed, reply: resp(200, VERSIONS_FEED_STILL_INACTIVE, ATOM) },
    LOGON_ROUTE,
    ...extraRoutes,
  ];
}

// ----------------------------------------------------------------- tests ---

describe("releaseActivationEnqueues — stranded phase-two enqueue", () => {
  it("guarantee 1 — regression: preaudit handshake sent, outcome not activated => dropSession() IS called", async () => {
    const { conn } = await connectWrite(notActivatedViaRevisions());
    const dropSession = vi.spyOn(conn, "dropSession").mockResolvedValue(undefined);
    vi.spyOn(conn, "heldLockUris").mockReturnValue([]);

    const out = await activateObject(conn, FUGR_SEED);

    expect(out.preaudit).toBeDefined();
    expect(out.activated).toBe(false);
    expect(dropSession).toHaveBeenCalledTimes(1);
  });

  it("guarantee 2 — plain failure with no preaudit (genuine syntax error, no phase two) => dropSession() is NOT called", async () => {
    const { conn, http } = await connect([
      { match: onActivation, reply: resp(200, PLAIN_SYNTAX_ERROR, XML) },
    ]);
    const dropSession = vi.spyOn(conn, "dropSession").mockResolvedValue(undefined);

    const out = await activateObject(conn, FUGR_SEED);

    // No inactive list on phase one => activateWithPreauditSet never sends a
    // second POST at all: exactly one activation call total.
    expect(http.calls.filter(onActivation)).toHaveLength(1);
    expect(out.preaudit).toBeUndefined();
    expect(out.activated).toBe(false);
    expect(out.errors).toBeGreaterThan(0);
    expect(dropSession).not.toHaveBeenCalled();
  });

  it("guarantee 3 — heldLockUris() non-empty => dropSession() is NOT called, even on a failed preaudit activation", async () => {
    const { conn } = await connectWrite(notActivatedViaRevisions());
    const dropSession = vi.spyOn(conn, "dropSession").mockResolvedValue(undefined);
    // The caller's own stateful session still owns locks of its own — dropping
    // the contextid here would strand THOSE, not just the phase-two enqueue.
    vi.spyOn(conn, "heldLockUris").mockReturnValue(["/sap/bc/adt/functions/groups/ztmd_hs358b_fg"]);

    const out = await activateObject(conn, FUGR_SEED);

    expect(out.preaudit).toBeDefined();
    expect(out.activated).toBe(false);
    expect(dropSession).not.toHaveBeenCalled();
  });

  it("guarantee 4 — a dropSession() that rejects cannot change the caller's outcome", async () => {
    const { conn } = await connectWrite(notActivatedViaRevisions());
    const dropSession = vi
      .spyOn(conn, "dropSession")
      .mockRejectedValue(new Error("ICMENOSESSION"));
    vi.spyOn(conn, "heldLockUris").mockReturnValue([]);

    const out = await activateObject(conn, FUGR_SEED);

    expect(dropSession).toHaveBeenCalledTimes(1);
    expect(out.activated).toBe(false);
    expect(out.inactive).toEqual([
      { name: FUGR_SEED.name, type: FUGR_SEED.type, uri: FUGR_SEED.uri },
    ]);

    let thrown: unknown;
    try {
      assertNoErrors(out, { what: "Activation", name: FUGR_SEED.name });
    } catch (e) {
      thrown = e;
    }
    expect(isAbapError(thrown)).toBe(true);
    // Same CHECK_FAILED a rejection-free cleanup would surface — cleanup must
    // never mask or replace the real failure.
    expect((thrown as { code: string }).code).toBe("CHECK_FAILED");
    expect((thrown as { message: string }).message).toContain("NOT activated");
  });

  it("happy path — a successful activation does NOT drop the session", async () => {
    const { conn, http } = await connect([
      { match: onActivation, reply: resp(200, "", { "content-length": "0" }) },
    ]);
    const dropSession = vi.spyOn(conn, "dropSession").mockResolvedValue(undefined);

    const out = await activateObject(conn, FUGR_SEED);

    expect(http.calls.filter(onActivation)).toHaveLength(1);
    expect(out.activated).toBe(true);
    expect(dropSession).not.toHaveBeenCalled();
  });

  it("guarantee 5 — a chunk that throws mid-batch does not skip the enqueue release", async () => {
    // `activateObjects` (the batch path), not `activateObject`: the loop
    // over chunks is where a throw could otherwise skip past the cleanup
    // below the loop.
    const { conn } = await connectWrite(notActivatedViaRevisions());
    const dropSession = vi.spyOn(conn, "dropSession").mockResolvedValue(undefined);
    vi.spyOn(conn, "heldLockUris").mockReturnValue([]);

    // FUGR_SEED's own two POSTs (query-string-distinguished preauditRequested)
    // must go through untouched; only DDIC_SEED's chunk throws, so the match
    // is on its uri in the body, not on the query string.
    const realPost = conn.post.bind(conn);
    vi.spyOn(conn, "post").mockImplementation(
      async (url: string, opts?: RawRequestOptions & { body?: string }) => {
        if (url.includes("/sap/bc/adt/activation") && String(opts?.body ?? "").includes(DDIC_SEED.uri)) {
          throw new Error("socket hang up");
        }
        return realPost(url, opts);
      },
    );

    const e = await activateObjects(conn, [FUGR_SEED, DDIC_SEED]).then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(isAbapError(e)).toBe(true);
    // Skipping this leaves the SAP-side enqueue FUGR_SEED's phase-two POST
    // took stranded, surfacing later as
    // "Object LIMU REPS LZTMD_HS358B_FGUXX is already locked".
    expect(dropSession).toHaveBeenCalledTimes(1);
  });
});
