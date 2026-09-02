/**
 * `activateSpotAndImplementation`'s preaudit handshake.
 *
 * H23 requires the spot and the implementation to re-activate JOINTLY (one
 * POST naming both, `src/adt/enhancement-bridge.ts`). The defect this file
 * guards against is that the preaudit handshake this function now shares with `activateObject`
 * (`activateWithPreauditSet`, `src/adt/activate.ts`) touched that jointness in
 * two ways: the phase-two POST must still name BOTH seeds plus whatever the
 * preaudit reply added, not just one of them; and `ok` must fail whenever any
 * object — seed or preaudit-added — is still inactive, not just when the
 * response itself carried a `[EAX]` message. Before the fix, `ok` was graded
 * as `errors === 0`, so a phase-one reply that named inactive dependents but
 * carried no error message of its own graded `ok: true` while `activated`
 * correctly read `false`.
 *
 * No network: fake `HttpClient`, same `RoutingClient`/`resp`/`sequence`/
 * `isPhase1`/`isPhase2`/`LOGON_ROUTE`/`T000_ROUTE` idiom as
 * `test/activation-preaudit.test.ts` and `test/activation-failure-session.test.ts`
 * — each of those files keeps its own local copy rather than sharing one
 * (see `test/enhancement-bridge.test.ts`'s header for why), so this file does
 * too. The gate/authorize idiom (`allowingGate`, `authorizeActivate`, `AFFECTS`,
 * `noJournalHook`) is reproduced from `test/enhancement-bridge.test.ts` for the
 * same reason: `activateSpotAndImplementation` requires a real
 * `AuthorizedTarget<"activate">`, minted via `SafetyGate.authorizeIntent` with
 * an `EnhancementIntent` because `ENHO/XH`'s effect targets an object outside
 * its own name/package/URI — a plain `gate.authorize("activate", ...)` will
 * not do. `test/helpers/fake-adt.ts`'s `FakeAdt` is not used here; that double
 * does not model the two-phase handshake this file exercises.
 *
 * Fixture provenance: no capture of `ioc:inactiveObjects` for an enhancement
 * object exists anywhere in this repo (the only preaudit documents on file are
 * for `CLAS/OC`, in `test/activation-preaudit.test.ts`). The XML below is
 * CONSTRUCTED: the `ioc:` envelope (`ioc:entry`/`ioc:object`/`ioc:ref` nesting,
 * `ioc:user`/`ioc:deleted` attributes) follows the same shape
 * `test/activation-preaudit.test.ts`'s `PREAUDIT_ZMCP_MAIN` uses, itself
 * modelled on `abap-adt-api`'s `parseInactive` (`api/activate.js`) rather than
 * a saved body. The object names/uris/types inside are real, attested
 * elsewhere: `ZMCP_ENH_BADI` / `/sap/bc/adt/enhancements/enhoxh/zmcp_enh_badi`
 * from `test/fixtures/enhancement/391-activate-success-enhoxh.meta.json` (a
 * live-captured activation POST for that exact object); `ZMCP_SPOT` (type
 * `ENHS/XS`) and the BAdI-definition interface `ZIF_MCP_BADI` (type `INTF/OI`,
 * uri `/sap/bc/adt/oo/interfaces/zif_mcp_badi`) from
 * `test/fixtures/enhancement/343-enhsxs-no-filters.xml`, a live-captured spot
 * GET. What this file's tests prove: that `activateSpotAndImplementation`
 * sends a second POST naming every object such a reply lists, in one call,
 * and grades `ok`/`activated` off the result — not that SAP replies with this
 * exact document for a real `ENHS/XS` + `ENHO/XH` pair; nobody has captured
 * that live.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { SafetyGate } from "../src/safety.js";
import { ConfigSchema, type Config } from "../src/config.js";
import {
  activateSpotAndImplementation,
  spotUri,
  implUri,
  ENH_CREATE_PACKAGE,
} from "../src/adt/enhancement-bridge.js";
import { enhancementIntentFor } from "../src/adt/write.js";
import type { ActivationTarget } from "../src/adt/activate.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// --------------------------------------------------------------- fixtures ---

const SPOT: ActivationTarget = { name: "ZMCP_SPOT", uri: spotUri("ZMCP_SPOT"), type: "ENHS/XS" };
const IMPL: ActivationTarget = { name: "ZMCP_ENH_BADI", uri: implUri("ZMCP_ENH_BADI"), type: "ENHO/XH" };
const THIRD_URI = "/sap/bc/adt/oo/interfaces/zif_mcp_badi";
const THIRD_NAME = "ZIF_MCP_BADI";

/**
 * CONSTRUCTED — see module header. Names all three: both seeds (spot, impl)
 * plus a third, unnamed-until-now dependent (the BAdI-definition marker
 * interface `ZIF_MCP_BADI`, real name/uri/type from fixture 343). Proves
 * phase two's set grows beyond the seeds, so `activateWithPreauditSet` does
 * not decline to send it.
 */
const PREAUDIT_JOINT = `<?xml version="1.0" encoding="utf-8"?>
<ioc:inactiveObjects xmlns:ioc="http://www.sap.com/abapxml/inactiveCtsObjects" xmlns:adtcore="http://www.sap.com/adt/core">
  <ioc:entry>
    <ioc:object ioc:user="DEVELOPER" ioc:deleted="false">
      <ioc:ref adtcore:uri="${SPOT.uri}" adtcore:type="ENHS/XS" adtcore:name="ZMCP_SPOT" adtcore:parentUri=""/>
    </ioc:object>
  </ioc:entry>
  <ioc:entry>
    <ioc:object ioc:user="DEVELOPER" ioc:deleted="false">
      <ioc:ref adtcore:uri="${IMPL.uri}" adtcore:type="ENHO/XH" adtcore:name="ZMCP_ENH_BADI" adtcore:parentUri=""/>
    </ioc:object>
  </ioc:entry>
  <ioc:entry>
    <ioc:object ioc:user="DEVELOPER" ioc:deleted="false">
      <ioc:ref adtcore:uri="${THIRD_URI}" adtcore:type="INTF/OI" adtcore:name="${THIRD_NAME}" adtcore:parentUri=""/>
    </ioc:object>
  </ioc:entry>
</ioc:inactiveObjects>`;

/**
 * CONSTRUCTED — same envelope, but names only the two seeds, differently
 * cased on the uri path segment (the same normalisation
 * `test/activation-preaudit.test.ts`'s `PREAUDIT_SEED_ONLY` exercises for a
 * single-seed case). `preauditActivationSet` collapses both back onto the
 * seeds themselves, so `set.targets.length` stays equal to `seeds.length` and
 * `activateWithPreauditSet` declines to send a second POST at all
 * (`src/adt/activate.ts`: `if (set.targets.length <= seeds.length) return
 * undefined;`).
 */
const PREAUDIT_SEEDS_ONLY = `<?xml version="1.0" encoding="utf-8"?>
<ioc:inactiveObjects xmlns:ioc="http://www.sap.com/abapxml/inactiveCtsObjects" xmlns:adtcore="http://www.sap.com/adt/core">
  <ioc:entry>
    <ioc:object ioc:user="DEVELOPER" ioc:deleted="false">
      <ioc:ref adtcore:uri="/sap/bc/adt/ENHANCEMENTS/enhsxs/ZMCP_Spot" adtcore:type="ENHS/XS" adtcore:name="ZMCP_SPOT" adtcore:parentUri=""/>
    </ioc:object>
  </ioc:entry>
  <ioc:entry>
    <ioc:object ioc:user="DEVELOPER" ioc:deleted="false">
      <ioc:ref adtcore:uri="/sap/bc/adt/ENHANCEMENTS/enhoxh/ZMCP_Enh_Badi" adtcore:type="ENHO/XH" adtcore:name="ZMCP_ENH_BADI" adtcore:parentUri=""/>
    </ioc:object>
  </ioc:entry>
</ioc:inactiveObjects>`;

/**
 * CONSTRUCTED — a genuine phase-two failure, same `chkl:messages` envelope
 * fixture 455 (`test/fixtures/enhancement/455-activate-failure-syntax-error.xml`)
 * carries for a `CLAS/OC`, text adapted to an enhancement implementation
 * since no phase-two failure for one has been captured live. What's real: the
 * envelope shape and the `href`'s `#start=line,col` fragment convention
 * `parseStartFragment` reads (`src/adt/activate.ts`); the message text itself
 * is invented for this test.
 */
const PHASE2_FAILURE = `<?xml version="1.0" encoding="utf-8"?><chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist"><msg objDescr="BAdI Implementation ZMCP_ENH_BADI" type="E" line="1" href="${IMPL.uri}/source/main#start=1,0" forceSupported="true"><shortText><txt>Enhancement implementation ZMCP_ENH_BADI could not be activated: filter value conflicts with an active version.</txt></shortText></msg></chkl:messages>`;

// ------------------------------------------------------------- transport ---
// Reproduced from test/activation-preaudit.test.ts — see that file's header
// for why each suite keeps its own copy rather than sharing one.

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
    readOnly: false,
  });

const onActivation: Route["match"] = (o) => o.url.includes("/sap/bc/adt/activation");
const onDataPreview: Route["match"] = (o) => o.url.includes("/sap/bc/adt/datapreview/freestyle");
const isPhase1: Route["match"] = (o) =>
  onActivation(o) && String((o.qs as Record<string, unknown> | undefined)?.["preauditRequested"]) === "true";
const isPhase2: Route["match"] = (o) =>
  onActivation(o) && String((o.qs as Record<string, unknown> | undefined)?.["preauditRequested"]) === "false";

const T000_ROUTE: Route = {
  match: onDataPreview,
  reply: resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML),
};

const onLogon: Route["match"] = (o) => o.url.includes("/sap/bc/adt/compatibility/graph");
/**
 * Only needed by the jointness test below: its two extra version-history GETs
 * push the run past the logon-endpoint call budget (`http-guard.ts`) unless
 * the CSRF handshake is stubbed to succeed — same reason
 * `test/activation-preaudit.test.ts` includes this route on its own
 * version-history tests.
 */
const LOGON_ROUTE: Route = {
  match: onLogon,
  reply: resp(200, "<graph/>", { "content-type": "application/xml", "x-csrf-token": "TOKEN123" }),
};

/** Both activation phases go through `AbapConnection.post()`, which is write-gated. */
async function connectWrite(routes: Route[]): Promise<{ conn: AbapConnection; http: RoutingClient }> {
  const http = new RoutingClient([...routes, T000_ROUTE]);
  const conn = new AbapConnection(cfg(), {
    httpClient: http,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  return { conn, http };
}

// --------------------------------------- version-history verification GETs ---
// Reproduced from test/activation-preaudit.test.ts (`seedsStillInactive`,
// src/adt/activate.ts, reads each seed's OWN version history: a GET of its
// structure document, then a GET of whatever `atom:link
// rel=".../relations/versions"` resolves to).

const REVISIONS_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "revisions");

/**
 * The one live capture in this repo that is unambiguously active-only:
 * exactly one `00000` entry, no `99999`. Read at test time, not copied in —
 * see `test/fixtures/revisions/README.md` for provenance (A4H, SAP_BASIS 754
 * SP0007, captured 2026-08-18). Same fixture `test/activation-preaudit.test.ts`
 * uses for its own version-history verification tests.
 */
const ACTIVE_ONLY_FEED = readFileSync(
  join(REVISIONS_FIXTURES, "versions-feed-ztmp-local-class-a4h-754.xml"),
  "utf8",
);

/**
 * CONSTRUCTED — the ADT object-structure document `seedsStillInactive`'s
 * first GET reads, same shape as `test/activation-preaudit.test.ts`'s
 * `structureWithVersionsLink`. No `class:visibility` attribute, so the
 * version link is read at the root rather than per-include — correct for a
 * non-`CLAS/OC` object such as an enhancement spot or implementation.
 */
function structureWithVersionsLink(target: ActivationTarget): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?><adtcore:object ` +
    `xmlns:adtcore="http://www.sap.com/adt/core" xmlns:atom="http://www.w3.org/2005/Atom" ` +
    `adtcore:name="${target.name}" adtcore:type="${target.type ?? ""}">` +
    `<atom:link href="versions" rel="http://www.sap.com/adt/relations/versions" ` +
    `type="application/atom+xml;type=feed"/></adtcore:object>`
  );
}

/** Matches the structure-document GET `seedsStillInactive` sends for `uri` — no query string, so an exact match. */
const isSeedStructureGet = (uri: string): Route["match"] => (o) => o.url === uri;
/** Matches the versions-feed GET `href="versions"` resolves to (`followUrl`: `<uri>/versions`). */
const isSeedVersionsGet = (uri: string): Route["match"] => (o) => o.url === `${uri}/versions`;

// ------------------------------------------------------------------- gate ---
// Reproduced from test/enhancement-bridge.test.ts — see that file's header
// comment on `authorizeActivate` for why a plain `gate.authorize("activate",
// ...)` will not do here.

const allowingGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: [ENH_CREATE_PACKAGE],
    writesLockedOut: false,
    allowEnhancements: true,
    enhanceTargets: "customer",
    originSystems: ["TST"],
  });

const AFFECTS = { name: "ZCL_TARGET", packageName: "ZTARGET_PKG", masterSystem: "TST" };

const authorizeActivate = (gate: SafetyGate, name: string) =>
  gate.authorizeIntent(
    "activate",
    enhancementIntentFor({ name, type: "ENHO/XH", packageName: ENH_CREATE_PACKAGE }, AFFECTS),
    { name, packageName: ENH_CREATE_PACKAGE, type: "ENHO/XH" },
  );

const noJournalHook = async (): Promise<void> => {};

// ----------------------------------------------------------------- tests ---

describe("activateSpotAndImplementation — joint preaudit handshake", () => {
  it("phase two names the spot, the implementation, and the third preaudit-named object together in one POST, then verifies both seeds by version history", async () => {
    const { conn, http } = await connectWrite([
      LOGON_ROUTE,
      { match: isPhase1, reply: resp(200, PREAUDIT_JOINT, XML) },
      { match: isPhase2, reply: resp(200, "", { "content-length": "0" }) },
      {
        match: isSeedStructureGet(SPOT.uri),
        reply: resp(200, structureWithVersionsLink(SPOT), XML),
      },
      { match: isSeedVersionsGet(SPOT.uri), reply: resp(200, ACTIVE_ONLY_FEED, XML) },
      {
        match: isSeedStructureGet(IMPL.uri),
        reply: resp(200, structureWithVersionsLink(IMPL), XML),
      },
      { match: isSeedVersionsGet(IMPL.uri), reply: resp(200, ACTIVE_ONLY_FEED, XML) },
    ]);

    const outcome = await activateSpotAndImplementation(
      conn,
      authorizeActivate(allowingGate(), "ZMCP_ENH_BADI"),
      [SPOT, IMPL],
      noJournalHook,
    );

    const calls = http.calls.filter(onActivation);
    expect(calls).toHaveLength(2);
    expect(String((calls[0]?.qs as Record<string, unknown> | undefined)?.["preauditRequested"])).toBe(
      "true",
    );
    expect(String((calls[1]?.qs as Record<string, unknown> | undefined)?.["preauditRequested"])).toBe(
      "false",
    );

    // The decisive check: phase two's body must carry all THREE names, not
    // just the object that happened to be re-authorised, and not just one of
    // the two seeds — the joint-activation guarantee H23 depends on.
    const phase2Body = String(calls[1]?.body ?? "");
    expect(phase2Body).toContain('adtcore:name="ZMCP_SPOT"');
    expect(phase2Body).toContain('adtcore:name="ZMCP_ENH_BADI"');
    expect(phase2Body).toContain(`adtcore:name="${THIRD_NAME}"`);

    // Both version-history verification GETs (spot AND impl) fired — one
    // structure GET plus one feed GET each.
    expect(http.calls.filter(isSeedStructureGet(SPOT.uri))).toHaveLength(1);
    expect(http.calls.filter(isSeedVersionsGet(SPOT.uri))).toHaveLength(1);
    expect(http.calls.filter(isSeedStructureGet(IMPL.uri))).toHaveLength(1);
    expect(http.calls.filter(isSeedVersionsGet(IMPL.uri))).toHaveLength(1);

    expect(outcome.activated).toBe(true);
    expect(outcome.ok).toBe(true);
    expect(outcome.preaudit).toBeDefined();
    const preauditNames = outcome.preaudit!.map((r) => r.name);
    expect(preauditNames).toContain("ZMCP_SPOT");
    expect(preauditNames).toContain("ZMCP_ENH_BADI");
    expect(preauditNames).toContain(THIRD_NAME);
  });

  it("a preaudit reply naming only the two seeds sends no second POST and grades ok: false (regression: ok used to read errors === 0 alone)", async () => {
    const { conn, http } = await connectWrite([
      { match: onActivation, reply: resp(200, PREAUDIT_SEEDS_ONLY, XML) },
    ]);

    const outcome = await activateSpotAndImplementation(
      conn,
      authorizeActivate(allowingGate(), "ZMCP_ENH_BADI"),
      [SPOT, IMPL],
      noJournalHook,
    );

    expect(http.calls.filter(onActivation)).toHaveLength(1);
    expect(outcome.activated).toBe(false);
    // The pinned regression: phase one's own reply carried no `[EAX]`
    // message, only an inactive list — pre-fix, `ok: errors === 0` graded
    // this `true` even though `activated` correctly read `false`.
    expect(outcome.ok).toBe(false);
    expect(outcome.preaudit).toBeUndefined();
  });

  it("a genuine phase-two failure drops the session to release its stranded activation enqueue", async () => {
    const { conn } = await connectWrite([
      { match: isPhase1, reply: resp(200, PREAUDIT_JOINT, XML) },
      { match: isPhase2, reply: resp(200, PHASE2_FAILURE, XML) },
    ]);
    const dropSession = vi.spyOn(conn, "dropSession").mockResolvedValue(undefined);
    vi.spyOn(conn, "heldLockUris").mockReturnValue([]);

    const outcome = await activateSpotAndImplementation(
      conn,
      authorizeActivate(allowingGate(), "ZMCP_ENH_BADI"),
      [SPOT, IMPL],
      noJournalHook,
    );

    expect(outcome.activated).toBe(false);
    expect(outcome.ok).toBe(false);
    expect(outcome.errors).toBeGreaterThan(0);
    expect(dropSession).toHaveBeenCalledTimes(1);
  });
});
