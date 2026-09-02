/**
 * The FUGR/F false negative that motivated the version-history fix.
 *
 * On a live run against an A4H sandbox, `abapsmith` activated
 * `FUGR/F ZTMD_HS358B_FG`, which was genuinely active: version history
 * showed a single `00000 ACTIVE` row and no `99999 INACTIVE` row,
 * `abap_activate mode=check` came back clean, and an active-source read
 * matched what had been written. Despite that, the old code returned
 * CHECK_FAILED, because its verification step re-ran phase one (a POST) on
 * the seed and trusted whatever `ioc:inactiveObjects` list came back — and
 * for a function group, that reply is never empty: SAP always lists the
 * group's own generated sub-includes (`L<name>TOP`, `L<name>UXX`) in it,
 * active or not. The exact JSON that run returned, captured verbatim:
 *
 *   {"error":"CHECK_FAILED","message":"Activation failed: ZTMD_HS358B_FG was
 *   NOT activated because 4 dependent objects are still inactive ((unknown)
 *   (unknown), FUGR/F ZTMD_HS358B_FG, FUGR/F ZTMD_HS358B_FG, FUGR/F
 *   ZTMD_HS358B_FG).","hint":"abapsmith already re-sent the activation
 *   naming every object ADT's preaudit reply listed, and a re-check still
 *   reports these as inactive — one of them cannot activate. Check them
 *   individually with `abap_activate mode=check`.","details":{"object":
 *   "ZTMD_HS358B_FG","activated":false,"inactive":[{"name":"(unknown)",
 *   "type":"(unknown)"},{"name":"ZTMD_HS358B_FG","type":"FUGR/F","uri":
 *   "/sap/bc/adt/functions/groups/ztmd_hs358b_fg"},{"name":"ZTMD_HS358B_FG",
 *   "type":"FUGR/F","uri":"/sap/bc/adt/functions/groups/ztmd_hs358b_fg/source/main"},
 *   {"name":"ZTMD_HS358B_FG","type":"FUGR/F","uri":
 *   "/sap/bc/adt/functions/groups/ztmd_hs358b_fg/source/main"}]},"errors":0,
 *   "warnings":0}
 *
 * The current fix (`seedsStillInactive`, `src/adt/activate.ts`) replaces
 * that re-POST with a GET of the seed's OWN version history — this file's
 * first `describe` block pins that a genuinely-active FUGR/F activates
 * cleanly through the fixed path and that no third POST happens at all.
 *
 * The captured message text above also names the same object four times
 * over instead of once — `displayInactive`'s dedup fixes that independently
 * of the version-history change. The second `describe` block pins that fix
 * against the captured `inactive` array itself, byte-for-byte.
 *
 * Harness copied from test/activation-preaudit.test.ts (same RoutingClient/
 * sequence/isPhase1/isPhase2/connect/connectWrite idiom); this file does not
 * touch that one.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import {
  activateObject,
  assertNoErrors,
  type ActivationOutcome,
  type ActivationTarget,
  type InactiveObjectRef,
} from "../src/adt/activate.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// --------------------------------------------------------------- fixtures ---

const ZTMD_HS358B_FG: ActivationTarget = {
  name: "ZTMD_HS358B_FG",
  uri: "/sap/bc/adt/functions/groups/ztmd_hs358b_fg",
  type: "FUGR/F",
};

/**
 * LIVE-CAPTURED — copied character for character from the `details.inactive`
 * array in the captured JSON error payload (see this file's header
 * comment for the full payload and what corroborated the object was
 * actually active). Reused verbatim, not re-typed by hand, in both
 * `describe` blocks below.
 */
const CAPTURED_INACTIVE: InactiveObjectRef[] = [
  { name: "(unknown)", type: "(unknown)" },
  {
    name: "ZTMD_HS358B_FG",
    type: "FUGR/F",
    uri: "/sap/bc/adt/functions/groups/ztmd_hs358b_fg",
  },
  {
    name: "ZTMD_HS358B_FG",
    type: "FUGR/F",
    uri: "/sap/bc/adt/functions/groups/ztmd_hs358b_fg/source/main",
  },
  {
    name: "ZTMD_HS358B_FG",
    type: "FUGR/F",
    uri: "/sap/bc/adt/functions/groups/ztmd_hs358b_fg/source/main",
  },
];

/**
 * RECONSTRUCTED, not captured — only the parsed `inactive` array above was
 * recorded live; the `ioc:inactiveObjects` document phase one actually sent
 * was not saved. The first four entries below follow {@link CAPTURED_INACTIVE}
 * exactly: a ref-less entry, the group itself, and its `source/main` ref
 * listed twice (SAP repeats sub-parts across preaudit entries). The last two
 * entries — the `L<name>TOP`/`L<name>UXX` generated sub-includes — are NOT
 * in the captured array at all; they are inferred from the defect mechanism
 * this file's header comment describes (a function group's phase-one reply
 * always lists its own generated sub-includes), needed here so that
 * `preauditActivationSet` genuinely grows past the one seed and a second
 * POST fires, the same as it must have on the live run. Element/namespace
 * nesting (`ioc:entry`/`ioc:object`/`ioc:ref`) follows the shape
 * test/activation-preaudit.test.ts's PREAUDIT_ZMCP_MAIN documents.
 */
const PREAUDIT_ZTMD_HS358B_FG = `<?xml version="1.0" encoding="utf-8"?>
<ioc:inactiveObjects xmlns:ioc="http://www.sap.com/abapxml/inactiveCtsObjects" xmlns:adtcore="http://www.sap.com/adt/core">
  <ioc:entry>
    <ioc:object ioc:user="" ioc:deleted="false"/>
  </ioc:entry>
  <ioc:entry>
    <ioc:object ioc:user="DEVELOPER" ioc:deleted="false">
      <ioc:ref adtcore:uri="/sap/bc/adt/functions/groups/ztmd_hs358b_fg" adtcore:type="FUGR/F" adtcore:name="ZTMD_HS358B_FG"/>
    </ioc:object>
  </ioc:entry>
  <ioc:entry>
    <ioc:object ioc:user="DEVELOPER" ioc:deleted="false">
      <ioc:ref adtcore:uri="/sap/bc/adt/functions/groups/ztmd_hs358b_fg/source/main" adtcore:type="FUGR/F" adtcore:name="ZTMD_HS358B_FG" adtcore:parentUri="/sap/bc/adt/functions/groups/ztmd_hs358b_fg"/>
    </ioc:object>
  </ioc:entry>
  <ioc:entry>
    <ioc:object ioc:user="DEVELOPER" ioc:deleted="false">
      <ioc:ref adtcore:uri="/sap/bc/adt/functions/groups/ztmd_hs358b_fg/source/main" adtcore:type="FUGR/F" adtcore:name="ZTMD_HS358B_FG" adtcore:parentUri="/sap/bc/adt/functions/groups/ztmd_hs358b_fg"/>
    </ioc:object>
  </ioc:entry>
  <ioc:entry>
    <ioc:object ioc:user="DEVELOPER" ioc:deleted="false">
      <ioc:ref adtcore:uri="/sap/bc/adt/programs/includes/lztmd_hs358b_fgtop" adtcore:type="PROG/I" adtcore:name="LZTMD_HS358B_FGTOP" adtcore:parentUri="/sap/bc/adt/functions/groups/ztmd_hs358b_fg"/>
    </ioc:object>
  </ioc:entry>
  <ioc:entry>
    <ioc:object ioc:user="DEVELOPER" ioc:deleted="false">
      <ioc:ref adtcore:uri="/sap/bc/adt/programs/includes/lztmd_hs358b_fguxx" adtcore:type="PROG/I" adtcore:name="LZTMD_HS358B_FGUXX" adtcore:parentUri="/sap/bc/adt/functions/groups/ztmd_hs358b_fg"/>
    </ioc:object>
  </ioc:entry>
</ioc:inactiveObjects>`;

/**
 * CONSTRUCTED — the FUGR/F object-structure document, given literally as
 * part of this task rather than derived here. Only the `atom:link
 * rel=".../relations/versions"` matters to `seedsStillInactive`'s first GET;
 * the rest (root element name/namespace, `adtcore:type`) is cosmetic, same
 * as `structureWithVersionsLink` in test/activation-preaudit.test.ts.
 */
const FUGR_STRUCTURE = `<?xml version="1.0" encoding="utf-8"?><group:abapFunctionGroup xmlns:group="http://www.sap.com/adt/functions/groups" xmlns:adtcore="http://www.sap.com/adt/core" xmlns:atom="http://www.w3.org/2005/Atom" adtcore:name="ZTMD_HS358B_FG" adtcore:type="FUGR/F"><atom:link href="versions" rel="http://www.sap.com/adt/relations/versions" type="application/atom+xml;type=feed"/></group:abapFunctionGroup>`;

const REVISIONS_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "revisions");

/**
 * LIVE-CAPTURED (A4H, SAP_BASIS 754 SP0007, 2026-08-18 — see
 * test/fixtures/revisions/README.md), reused verbatim via `readFileSync`
 * rather than pasted. Captured against a CLAS, not the FUGR/F under test —
 * it is the one file in that directory that is unambiguously active-only
 * (a single `00000` entry, no `99999`), which is all this test needs: a
 * genuine active-only shape, not a FUGR/F-specific one.
 */
const ACTIVE_ONLY_FEED = readFileSync(
  join(REVISIONS_FIXTURES, "versions-feed-ztmp-local-class-a4h-754.xml"),
  "utf8",
);

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

const T000_ROUTE: Route = {
  match: onDataPreview,
  reply: resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML),
};

/**
 * Without this, every logon-endpoint hit that isn't wrapped in a budgeted
 * `conn.post()`/`conn.get()` call (phase one's `conn.adt.activate()` and
 * both of `seedsStillInactive`'s `conn.adt.revisions()` GETs all are) gets
 * no cacheable CSRF token and re-logs on every time, running the connection
 * past its lifetime logon-endpoint ceiling before the version-history GETs
 * ever get a chance to fire. Same route as the batch tests in
 * test/activation-preaudit.test.ts.
 */
const onLogon: Route["match"] = (o) => o.url.includes("/sap/bc/adt/compatibility/graph");
const LOGON_ROUTE: Route = {
  match: onLogon,
  reply: resp(200, "<graph/>", { "content-type": "application/xml", "x-csrf-token": "TOKEN123" }),
};

/** Matches the structure-document GET `seedsStillInactive` sends for `uri` — no query string, so an exact match. */
const isSeedStructureGet = (uri: string): Route["match"] => (o) => o.url === uri;
/** Matches the versions-feed GET `href="versions"` resolves to (`followUrl`: `<uri>/versions`). */
const isSeedVersionsGet = (uri: string): Route["match"] => (o) => o.url === `${uri}/versions`;

/**
 * Phase two goes through `AbapConnection.post()`, which is write-gated
 * unlike the vendor-routed phase-one call — a write-enabled connection is
 * required whenever phase two is expected to actually fire.
 */
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

/** Run `fn`, require an `AbapError`, hand it back for field-level assertions. */
function catchAbap(fn: () => unknown): AbapError {
  try {
    fn();
  } catch (e) {
    if (isAbapError(e)) return e;
    throw e;
  }
  throw new Error("expected an AbapError, but the call returned normally");
}

// ----------------------------------------------------------------- tests ---

describe("activateObject — FUGR/F false negative", () => {
  it("activates a genuinely-active FUGR/F, with no CHECK_FAILED and no third POST", async () => {
    const { conn, http } = await connectWrite([
      LOGON_ROUTE,
      { match: isPhase1, reply: resp(200, PREAUDIT_ZTMD_HS358B_FG, XML) },
      { match: isPhase2, reply: resp(200, "", { "content-length": "0" }) },
      { match: isSeedStructureGet(ZTMD_HS358B_FG.uri), reply: resp(200, FUGR_STRUCTURE, XML) },
      { match: isSeedVersionsGet(ZTMD_HS358B_FG.uri), reply: resp(200, ACTIVE_ONLY_FEED, XML) },
    ]);

    const out = await activateObject(conn, ZTMD_HS358B_FG);
    expect(out.activated).toBe(true);
    expect(() =>
      assertNoErrors(out, { what: "Activation", name: ZTMD_HS358B_FG.name }),
    ).not.toThrow();

    // The regression itself: the old verification step re-POSTed phase one
    // and trusted its always-non-empty FUGR/F reply. The fix reads version
    // history instead, so the activation endpoint sees exactly the two POSTs
    // of the handshake — never a third.
    expect(http.calls.filter(onActivation)).toHaveLength(2);
    expect(http.calls.filter(isSeedStructureGet(ZTMD_HS358B_FG.uri))).toHaveLength(1);
    expect(http.calls.filter(isSeedVersionsGet(ZTMD_HS358B_FG.uri))).toHaveLength(1);
  });
});

describe("assertNoErrors — the captured message, byte for byte", () => {
  it("reports one dependent, not four, and keeps the raw wire list at length 4", () => {
    const outcome: ActivationOutcome = {
      activated: false,
      ok: false,
      messages: [],
      errors: 0,
      warnings: 0,
      inactive: CAPTURED_INACTIVE,
    };
    const err = catchAbap(() =>
      assertNoErrors(outcome, { what: "Activation", name: ZTMD_HS358B_FG.name }),
    );
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("1 dependent object is still inactive");
    expect(err.message).toContain("FUGR/F ZTMD_HS358B_FG");
    expect(err.message).not.toContain("4 dependent objects");

    // The name+type pair appears once in the rendered message, even though
    // it occurs three times (once with no source/main uri, twice with it)
    // in the raw captured array.
    const occurrences = (err.message.match(/FUGR\/F ZTMD_HS358B_FG/g) ?? []).length;
    expect(occurrences).toBe(1);

    // The raw wire evidence is untouched — dedup is display-only.
    expect(err.details.inactive).toEqual(CAPTURED_INACTIVE);
    expect((err.details.inactive as unknown[]).length).toBe(4);

    // The unnamed entry is disclosed, not silently dropped.
    expect(err.hint).toContain("1 more inactive dependent");
  });
});
