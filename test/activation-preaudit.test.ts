/**
 * The ADT activation preaudit handshake.
 *
 * `POST /activation?method=activate&preauditRequested=true` can answer HTTP
 * 200 with an `ioc:inactiveObjects` document naming every object that must be
 * activated together — not an error, not a completed activation. The correct
 * response is a second POST, `preauditRequested=false`, naming seeds + every
 * addressable preaudit ref, de-duplicated by `activationRefKey` (which, unlike
 * `normaliseAdtUri`, keeps the `#fragment` — a class's method and section-part
 * refs all share one `.../source/main` URI and differ only there). Re-posting
 * only the original seeds answers a success-shaped empty 200 while activating
 * nothing (row 3 of the probe table in `src/adt/activate.ts`'s module
 * notes) — and, inferred but not itself measured, so does a second POST
 * naming too small a set: an empty 200 there is byte-identical to genuine
 * activation. So a second-POST
 * empty reply is itself re-checked with a third, verification-only POST
 * (seeds alone, `preauditRequested=true` again) before it is trusted. This
 * file pins that the second POST carries the right set, fires only when it
 * would actually add something, that the third POST fires only when the
 * second one looks like success, and that a genuine failure on either POST
 * still reads as a failure without spending a third round trip.
 *
 * No network: fake `HttpClient`, same pattern as test/activate.test.ts.
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
  activateObjects,
  activationRefKey,
  assertNoErrors,
  mapInactiveObjects,
  normaliseAdtUri,
  parseActivationResponse,
  preauditActivationSet,
  type ActivationTarget,
  type InactiveObjectRef,
} from "../src/adt/activate.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// --------------------------------------------------------------- fixtures ---

/**
 * CONSTRUCTED — live probing hit `ioc:inactiveObjects` directly with curl
 * against a real system, but this exact body was not saved; the shape below
 * follows what that probing documented (`src/adt/activate.ts`'s module
 * notes): `ioc:entry`/`ioc:object`/`ioc:ref` nesting, `ioc:ref` itself in the
 * `ioc` namespace with its attributes in `adtcore`, and every entry carrying
 * `ioc:user`/`ioc:deleted`. A maintainer with live access should re-verify
 * this byte-for-byte rather than trust it as a capture.
 *
 * Models `ZMCP_MAIN` (CLAS/OC) activating and pulling in: its own test-class
 * include, named identically in two entries but with the class-name path
 * segment differently cased (SAP repeats sub-parts across entries — the same
 * include reached via two parents); a genuinely separate dependent class
 * `ZMCP_DEP`; and one entry with no `ioc:ref` at all, the unaddressable shape
 * the probe table saw in every real preaudit document.
 */
const PREAUDIT_ZMCP_MAIN = `<?xml version="1.0" encoding="utf-8"?>
<ioc:inactiveObjects xmlns:ioc="http://www.sap.com/abapxml/inactiveCtsObjects" xmlns:adtcore="http://www.sap.com/adt/core">
  <ioc:entry>
    <ioc:object ioc:user="DEVELOPER" ioc:deleted="false">
      <ioc:ref adtcore:uri="/sap/bc/adt/oo/classes/zmcp_main/includes/testclasses" adtcore:type="CLAS/OCU" adtcore:name="ZMCP_MAIN" adtcore:parentUri="/sap/bc/adt/oo/classes/zmcp_main"/>
    </ioc:object>
  </ioc:entry>
  <ioc:entry>
    <ioc:object ioc:user="DEVELOPER" ioc:deleted="false">
      <ioc:ref adtcore:uri="/sap/bc/adt/oo/classes/ZMCP_Main/includes/testclasses" adtcore:type="CLAS/OCU" adtcore:name="ZMCP_MAIN" adtcore:parentUri="/sap/bc/adt/oo/classes/zmcp_main"/>
    </ioc:object>
  </ioc:entry>
  <ioc:entry>
    <ioc:object ioc:user="DEVELOPER" ioc:deleted="false">
      <ioc:ref adtcore:uri="/sap/bc/adt/oo/classes/zmcp_dep" adtcore:type="CLAS/OC" adtcore:name="ZMCP_DEP" adtcore:parentUri=""/>
    </ioc:object>
  </ioc:entry>
  <ioc:entry>
    <ioc:object ioc:user="DEVELOPER" ioc:deleted="false"/>
  </ioc:entry>
</ioc:inactiveObjects>`;

/**
 * CONSTRUCTED — row 3 of the probe table: a preaudit document naming
 * only the top-level ref (here, the seed itself, differently cased — the
 * same normalisation that collapses a repeated sub-part must also collapse
 * this). Re-posting this adds nothing; the real system answered such a
 * re-post 200 empty while leaving the object inactive.
 */
const PREAUDIT_SEED_ONLY = `<?xml version="1.0" encoding="utf-8"?>
<ioc:inactiveObjects xmlns:ioc="http://www.sap.com/abapxml/inactiveCtsObjects" xmlns:adtcore="http://www.sap.com/adt/core">
  <ioc:entry>
    <ioc:object ioc:user="DEVELOPER" ioc:deleted="false">
      <ioc:ref adtcore:uri="/sap/bc/adt/oo/CLASSES/zmcp_main" adtcore:type="CLAS/OC" adtcore:name="ZMCP_MAIN" adtcore:parentUri=""/>
    </ioc:object>
  </ioc:entry>
</ioc:inactiveObjects>`;

/** CONSTRUCTED — same row-3 shape, but every entry is ref-less rather than self-referential. */
const PREAUDIT_ALL_UNADDRESSABLE = `<?xml version="1.0" encoding="utf-8"?>
<ioc:inactiveObjects xmlns:ioc="http://www.sap.com/abapxml/inactiveCtsObjects" xmlns:adtcore="http://www.sap.com/adt/core">
  <ioc:entry>
    <ioc:object ioc:user="DEVELOPER" ioc:deleted="false"/>
  </ioc:entry>
</ioc:inactiveObjects>`;

/** CONSTRUCTED — a second-phase reply where the dependent is genuinely still inactive. */
const PREAUDIT_STILL_INACTIVE = `<?xml version="1.0" encoding="utf-8"?>
<ioc:inactiveObjects xmlns:ioc="http://www.sap.com/abapxml/inactiveCtsObjects" xmlns:adtcore="http://www.sap.com/adt/core">
  <ioc:entry>
    <ioc:object ioc:user="DEVELOPER" ioc:deleted="false">
      <ioc:ref adtcore:uri="/sap/bc/adt/oo/classes/zmcp_dep" adtcore:type="CLAS/OC" adtcore:name="ZMCP_DEP" adtcore:parentUri=""/>
    </ioc:object>
  </ioc:entry>
</ioc:inactiveObjects>`;

/**
 * CONSTRUCTED and not itself a well-formed single-root document — two
 * sibling top-level elements. `fullParse` (fast-xml-parser under default
 * options) tolerates that and `parseActivationResponse` looks each tag name
 * up independently, so this is a fair stand-in for whatever exact body SAP
 * would send for a reply carrying both a genuine `[EAX]` message and an
 * inactive list, a combination the probe table did not itself capture.
 */
const ACTIVATION_ERROR_WITH_INACTIVE = `<?xml version="1.0" encoding="utf-8"?>
<chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist">
  <msg objDescr="Class ZMCP_MAIN" type="E" line="1" href="/sap/bc/adt/oo/classes/zmcp_main/source/main#start=3,0">
    <shortText><txt>Real syntax error, unrelated to the inactive dependent below.</txt></shortText>
  </msg>
</chkl:messages>
<ioc:inactiveObjects xmlns:ioc="http://www.sap.com/abapxml/inactiveCtsObjects" xmlns:adtcore="http://www.sap.com/adt/core">
  <ioc:entry>
    <ioc:object ioc:user="DEVELOPER" ioc:deleted="false">
      <ioc:ref adtcore:uri="/sap/bc/adt/oo/classes/zmcp_dep" adtcore:type="CLAS/OC" adtcore:name="ZMCP_DEP"/>
    </ioc:object>
  </ioc:entry>
</ioc:inactiveObjects>`;

/**
 * RECONSTRUCTED, not captured — the phase-one preaudit reply for a plain
 * `CLAS/OC` with one public method `COMPUTE`, first-ever write, transportable
 * package. Three things in it are attested and the rest is inference.
 * Attested: the nine entries and their `adtcore:type`/`adtcore:name` values,
 * quoted verbatim in the live-test report (including the space padding
 * between class name and method name on the `CLAS/OM/public` entry); and the
 * `.../base#type=CLAS%2FXXX;name=...` URI shape, which
 * `test/fixtures/live-captured/382-ut-testrun.xml` shows for real, three
 * distinct objects there sharing one `includes/testclasses` base URI.
 * Inferred: the XML envelope, the `ioc:transport` sub-elements, and that the
 * section parts specifically hang off `.../source/main`. A maintainer with
 * live access should replace this with a capture.
 */
const PREAUDIT_ZTMD_HS358_A = `<?xml version="1.0" encoding="utf-8"?><ioc:inactiveObjects xmlns:ioc="http://www.sap.com/abapxml/inactiveCtsObjects">
<ioc:entry><ioc:object/><ioc:transport ioc:user="DEVELOPER" ioc:linked="false"><ioc:ref adtcore:uri="/sap/bc/adt/cts/transportrequests/A4HK900314" adtcore:type="/RQ" adtcore:name="A4HK900314" adtcore:description="abapsmith session 2026-08-28" xmlns:adtcore="http://www.sap.com/adt/core"/></ioc:transport></ioc:entry>
<ioc:entry><ioc:object ioc:user="" ioc:deleted="false"><ioc:ref adtcore:uri="/sap/bc/adt/oo/classes/ztmd_hs358_a" adtcore:type="CLAS/OC" adtcore:name="ZTMD_HS358_A" xmlns:adtcore="http://www.sap.com/adt/core"/></ioc:object><ioc:transport/></ioc:entry>
<ioc:entry><ioc:object ioc:user="" ioc:deleted="false"><ioc:ref adtcore:uri="/sap/bc/adt/oo/classes/ztmd_hs358_a/includes/definitions" adtcore:type="CLAS/OCN/definitions" adtcore:name="ZTMD_HS358_A" adtcore:parentUri="/sap/bc/adt/oo/classes/ztmd_hs358_a" xmlns:adtcore="http://www.sap.com/adt/core"/></ioc:object><ioc:transport ioc:user="DEVELOPER" ioc:linked="true"><ioc:ref adtcore:uri="/sap/bc/adt/cts/transportrequests/A4HK900315" adtcore:type="/RQ" adtcore:name="A4HK900315" adtcore:parentUri="/sap/bc/adt/cts/transportrequests/A4HK900314" adtcore:description="abapsmith session 2026-08-28" xmlns:adtcore="http://www.sap.com/adt/core"/></ioc:transport></ioc:entry>
<ioc:entry><ioc:object ioc:user="" ioc:deleted="false"><ioc:ref adtcore:uri="/sap/bc/adt/oo/classes/ztmd_hs358_a/includes/implementations" adtcore:type="CLAS/OCN/implementations" adtcore:name="ZTMD_HS358_A" adtcore:parentUri="/sap/bc/adt/oo/classes/ztmd_hs358_a" xmlns:adtcore="http://www.sap.com/adt/core"/></ioc:object><ioc:transport ioc:user="DEVELOPER" ioc:linked="true"><ioc:ref adtcore:uri="/sap/bc/adt/cts/transportrequests/A4HK900315" adtcore:type="/RQ" adtcore:name="A4HK900315" adtcore:parentUri="/sap/bc/adt/cts/transportrequests/A4HK900314" adtcore:description="abapsmith session 2026-08-28" xmlns:adtcore="http://www.sap.com/adt/core"/></ioc:transport></ioc:entry>
<ioc:entry><ioc:object ioc:user="" ioc:deleted="false"><ioc:ref adtcore:uri="/sap/bc/adt/oo/classes/ztmd_hs358_a/includes/macros" adtcore:type="CLAS/OCN/macros" adtcore:name="ZTMD_HS358_A" adtcore:parentUri="/sap/bc/adt/oo/classes/ztmd_hs358_a" xmlns:adtcore="http://www.sap.com/adt/core"/></ioc:object><ioc:transport ioc:user="DEVELOPER" ioc:linked="true"><ioc:ref adtcore:uri="/sap/bc/adt/cts/transportrequests/A4HK900315" adtcore:type="/RQ" adtcore:name="A4HK900315" adtcore:parentUri="/sap/bc/adt/cts/transportrequests/A4HK900314" adtcore:description="abapsmith session 2026-08-28" xmlns:adtcore="http://www.sap.com/adt/core"/></ioc:transport></ioc:entry>
<ioc:entry><ioc:object ioc:user="" ioc:deleted="false"><ioc:ref adtcore:uri="/sap/bc/adt/oo/classes/ztmd_hs358_a/source/main#type=CLAS%2FOM;name=COMPUTE" adtcore:type="CLAS/OM/public" adtcore:name="ZTMD_HS358_A                  COMPUTE" adtcore:parentUri="/sap/bc/adt/oo/classes/ztmd_hs358_a" xmlns:adtcore="http://www.sap.com/adt/core"/></ioc:object><ioc:transport ioc:user="DEVELOPER" ioc:linked="true"><ioc:ref adtcore:uri="/sap/bc/adt/cts/transportrequests/A4HK900315" adtcore:type="/RQ" adtcore:name="A4HK900315" adtcore:parentUri="/sap/bc/adt/cts/transportrequests/A4HK900314" adtcore:description="abapsmith session 2026-08-28" xmlns:adtcore="http://www.sap.com/adt/core"/></ioc:transport></ioc:entry>
<ioc:entry><ioc:object ioc:user="" ioc:deleted="false"><ioc:ref adtcore:uri="/sap/bc/adt/oo/classes/ztmd_hs358_a/source/main#type=CLAS%2FOSI;name=ZTMD_HS358_A" adtcore:type="CLAS/OSI" adtcore:name="ZTMD_HS358_A" adtcore:parentUri="/sap/bc/adt/oo/classes/ztmd_hs358_a" xmlns:adtcore="http://www.sap.com/adt/core"/></ioc:object><ioc:transport ioc:user="DEVELOPER" ioc:linked="true"><ioc:ref adtcore:uri="/sap/bc/adt/cts/transportrequests/A4HK900315" adtcore:type="/RQ" adtcore:name="A4HK900315" adtcore:parentUri="/sap/bc/adt/cts/transportrequests/A4HK900314" adtcore:description="abapsmith session 2026-08-28" xmlns:adtcore="http://www.sap.com/adt/core"/></ioc:transport></ioc:entry>
<ioc:entry><ioc:object ioc:user="" ioc:deleted="false"><ioc:ref adtcore:uri="/sap/bc/adt/oo/classes/ztmd_hs358_a/source/main#type=CLAS%2FOSO;name=ZTMD_HS358_A" adtcore:type="CLAS/OSO" adtcore:name="ZTMD_HS358_A" adtcore:parentUri="/sap/bc/adt/oo/classes/ztmd_hs358_a" xmlns:adtcore="http://www.sap.com/adt/core"/></ioc:object><ioc:transport ioc:user="DEVELOPER" ioc:linked="true"><ioc:ref adtcore:uri="/sap/bc/adt/cts/transportrequests/A4HK900315" adtcore:type="/RQ" adtcore:name="A4HK900315" adtcore:parentUri="/sap/bc/adt/cts/transportrequests/A4HK900314" adtcore:description="abapsmith session 2026-08-28" xmlns:adtcore="http://www.sap.com/adt/core"/></ioc:transport></ioc:entry>
<ioc:entry><ioc:object ioc:user="" ioc:deleted="false"><ioc:ref adtcore:uri="/sap/bc/adt/oo/classes/ztmd_hs358_a/source/main#type=CLAS%2FOSU;name=ZTMD_HS358_A" adtcore:type="CLAS/OSU" adtcore:name="ZTMD_HS358_A" adtcore:parentUri="/sap/bc/adt/oo/classes/ztmd_hs358_a" xmlns:adtcore="http://www.sap.com/adt/core"/></ioc:object><ioc:transport ioc:user="DEVELOPER" ioc:linked="true"><ioc:ref adtcore:uri="/sap/bc/adt/cts/transportrequests/A4HK900315" adtcore:type="/RQ" adtcore:name="A4HK900315" adtcore:parentUri="/sap/bc/adt/cts/transportrequests/A4HK900314" adtcore:description="abapsmith session 2026-08-28" xmlns:adtcore="http://www.sap.com/adt/core"/></ioc:transport></ioc:entry>
</ioc:inactiveObjects>`;

/** The eight `adtcore:uri` values addressable in {@link PREAUDIT_ZTMD_HS358_A}, in document order. */
const ZTMD_HS358_A_URIS = [
  "/sap/bc/adt/oo/classes/ztmd_hs358_a",
  "/sap/bc/adt/oo/classes/ztmd_hs358_a/includes/definitions",
  "/sap/bc/adt/oo/classes/ztmd_hs358_a/includes/implementations",
  "/sap/bc/adt/oo/classes/ztmd_hs358_a/includes/macros",
  "/sap/bc/adt/oo/classes/ztmd_hs358_a/source/main#type=CLAS%2FOM;name=COMPUTE",
  "/sap/bc/adt/oo/classes/ztmd_hs358_a/source/main#type=CLAS%2FOSI;name=ZTMD_HS358_A",
  "/sap/bc/adt/oo/classes/ztmd_hs358_a/source/main#type=CLAS%2FOSO;name=ZTMD_HS358_A",
  "/sap/bc/adt/oo/classes/ztmd_hs358_a/source/main#type=CLAS%2FOSU;name=ZTMD_HS358_A",
];

/**
 * RECONSTRUCTED — a phase-two reply for a second POST that named too small a
 * set: the five refs the `normaliseAdtUri` dedup produced (class, definitions,
 * implementations, macros, and only the FIRST `#type=...` ref) instead of all
 * eight addressable refs in {@link PREAUDIT_ZTMD_HS358_A}. The message text is
 * quoted verbatim from the live-test report; the `chkl:messages`
 * envelope around it is the shape this file's other message fixtures use.
 */
const PHASE2_EAX_METHOD_NOT_DECLARED = `<?xml version="1.0" encoding="utf-8"?><chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist"><msg objDescr="Class ZTMD_HS358_A, Method COMPUTE" type="E" line="1" href="/sap/bc/adt/oo/classes/ztmd_hs358_a/source/main#start=7,9" forceSupported="true"><shortText><txt>Method "COMPUTE" is not declared or inherited in class "ZTMD_HS358_A".</txt></shortText></msg></chkl:messages>`;

/** CONSTRUCTED — a warning-only phase-two reply, same envelope as {@link PHASE2_EAX_METHOD_NOT_DECLARED} but `type="W"` and no inactive list. */
const PHASE2_WARNING_ONLY = `<?xml version="1.0" encoding="utf-8"?><chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist"><msg objDescr="Class ZTMD_HS358_A" type="W" line="1" href="/sap/bc/adt/oo/classes/ztmd_hs358_a/source/main#start=1,0"><shortText><txt>Enhancement category of class "ZTMD_HS358_A" is not defined; defaults to "cannot be enhanced".</txt></shortText></msg></chkl:messages>`;

const ZTMD_HS358_A: ActivationTarget = {
  name: "ZTMD_HS358_A",
  uri: "/sap/bc/adt/oo/classes/ztmd_hs358_a",
  type: "CLAS/OC",
};

const ZMCP_MAIN: ActivationTarget = {
  name: "ZMCP_MAIN",
  uri: "/sap/bc/adt/oo/classes/zmcp_main",
  type: "CLAS/OC",
};

// ------------------------------------------------------------- transport ---

interface Route {
  match: (o: HttpClientOptions) => boolean;
  /** A plain reply answers every matching call the same way; a thunk can answer differently call to call — see {@link sequence}. */
  reply: HttpClientResponse | (() => HttpClientResponse);
}

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const XML = { "content-type": "application/xml; charset=utf-8" };

/**
 * A route reply that changes on successive matching calls, oldest first;
 * the last reply repeats once exhausted. A handful of tests below still pass
 * two replies to the `isPhase1` route from before the verification step
 * became a GET rather than a third POST — only the first is
 * ever consumed now, but replaying it is harmless, so those tests were left
 * alone rather than rewritten just to trim it.
 */
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

/** The two activation POSTs are otherwise identical on `url`; the query string is the only thing that tells them apart. */
const isPhase1: Route["match"] = (o) =>
  onActivation(o) && String((o.qs as Record<string, unknown> | undefined)?.["preauditRequested"]) === "true";
const isPhase2: Route["match"] = (o) =>
  onActivation(o) && String((o.qs as Record<string, unknown> | undefined)?.["preauditRequested"]) === "false";

const T000_ROUTE: Route = {
  match: onDataPreview,
  reply: resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML),
};

const onLogon: Route["match"] = (o) => o.url.includes("/sap/bc/adt/compatibility/graph");
const LOGON_ROUTE: Route = {
  match: onLogon,
  reply: resp(200, "<graph/>", { "content-type": "application/xml", "x-csrf-token": "TOKEN123" }),
};

// --------------------------------------- version-history verification GETs ---
//
// `activateWithPreauditSet`'s verification step (`seedsStillInactive`, see
// `src/adt/activate.ts`) no longer POSTs. It reads each seed's OWN version
// history: a GET of the seed's ADT structure document (no query string) to
// find `atom:link rel=".../relations/versions"`, then a GET of whatever URL
// that link resolves to. Fixtures and route matchers below stand in for both.

const REVISIONS_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "revisions");

/**
 * The one live capture in this repo that is unambiguously active-only:
 * exactly one `00000` entry, no `99999`. Read at test time, not copied in —
 * see `test/fixtures/revisions/README.md` for provenance (A4H, SAP_BASIS 754
 * SP0007, captured 2026-08-18).
 */
const ACTIVE_ONLY_FEED = readFileSync(
  join(REVISIONS_FIXTURES, "versions-feed-ztmp-local-class-a4h-754.xml"),
  "utf8",
);

/**
 * SYNTHETIC — hand-written, not captured. No live capture anywhere in this
 * repo contains a `99999` (INACTIVE) row; every feed under
 * `test/fixtures/revisions/` is active-only (see that directory's README).
 * What's attested from the real captures: the single-entry shape itself
 * (`atom:author/atom:name`, `atom:content/@src`, `atom:id`, `atom:updated`),
 * copied from `versions-feed-ztmp-local-class-a4h-754.xml`. What's inferred,
 * not measured: that a genuinely pending INACTIVE draft's feed looks like
 * that same shape with `99999` (`INACTIVE_VERSION_ID`, `src/adt/revisions.ts`)
 * in the content path instead of `00000`.
 */
function syntheticInactiveFeed(objectUrl: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?><atom:feed xmlns:atom="http://www.w3.org/2005/Atom" ` +
    `xmlns:adtcore="http://www.sap.com/adt/core"><atom:title>Version List</atom:title>` +
    `<atom:updated>2026-08-27T00:00:00Z</atom:updated><atom:entry><atom:author>` +
    `<atom:name>DEVELOPER</atom:name></atom:author><atom:content type="text/plain" ` +
    `src="${objectUrl}/versions/20260827000000/99999/content"/><atom:id>99999</atom:id>` +
    `<atom:updated>2026-08-27T00:00:00Z</atom:updated></atom:entry></atom:feed>`
  );
}

/**
 * CONSTRUCTED — the ADT object-structure document `seedsStillInactive`'s
 * first GET reads. Root element name and namespace are cosmetic:
 * `abap-adt-api`'s `xmlRoot` takes whichever single top-level element is
 * present; what is actually consulted is the `atom:link` carrying
 * `rel=".../relations/versions"`. Deliberately carries no `class:visibility`
 * attribute, so `isClassStructure` reads it as a non-class object and follows
 * the link on the ROOT rather than per-include — the shape given for a
 * non-class object's structure document.
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

/**
 * CONSTRUCTED — same shape as {@link structureWithVersionsLink} but with no
 * versions link at all: `getRevisionLink` finds nothing, so
 * `conn.adt.revisions` throws "Revision URL not found", the per-object
 * unavailability `seedsStillInactive` treats as inconclusive rather than
 * evidence either way.
 */
function structureWithoutVersionsLink(target: ActivationTarget): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?><adtcore:object ` +
    `xmlns:adtcore="http://www.sap.com/adt/core" xmlns:atom="http://www.w3.org/2005/Atom" ` +
    `adtcore:name="${target.name}" adtcore:type="${target.type ?? ""}">` +
    `<atom:link href="source/main" rel="http://www.sap.com/adt/relations/source" ` +
    `type="text/plain"/></adtcore:object>`
  );
}

/** Matches the structure-document GET `seedsStillInactive` sends for `uri` — no query string, so an exact match. */
const isSeedStructureGet = (uri: string): Route["match"] => (o) => o.url === uri;
/** Matches the versions-feed GET `href="versions"` resolves to (`followUrl`: `<uri>/versions`). */
const isSeedVersionsGet = (uri: string): Route["match"] => (o) => o.url === `${uri}/versions`;

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
 * The second POST of the handshake always goes through `AbapConnection.post()`
 * (unlike the first, single-object POST, which goes through the vendor's
 * `conn.adt.activate()` and is not gated), so any test where phase two
 * actually fires needs a write-enabled connection — see test/activate.test.ts
 * for the full explanation and the three tests this file's sibling had to fix
 * for exactly this reason.
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

/** Every `adtcore:uri="..."` attribute value appearing in a hand-built activation body. */
function extractUris(body: string): string[] {
  return [...body.matchAll(/adtcore:uri="([^"]*)"/g)].map((m) => m[1] ?? "");
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

describe("activateObject — preaudit handshake", () => {
  it("makes exactly two POSTs to /sap/bc/adt/activation when phase two answers empty, then verifies by reading the seed's version history, not a third POST", async () => {
    const { conn, http } = await connectWrite([
      // The extra version-history GETs below push this test past the
      // logon-endpoint call budget (`http-guard.ts`) unless the CSRF handshake
      // itself is stubbed to succeed rather than falling through to the
      // RoutingClient's plain-text default reply.
      LOGON_ROUTE,
      { match: isPhase1, reply: resp(200, PREAUDIT_ZMCP_MAIN, XML) },
      { match: isPhase2, reply: resp(200, "", { "content-length": "0" }) },
      {
        match: isSeedStructureGet(ZMCP_MAIN.uri),
        reply: resp(200, structureWithVersionsLink(ZMCP_MAIN), XML),
      },
      { match: isSeedVersionsGet(ZMCP_MAIN.uri), reply: resp(200, ACTIVE_ONLY_FEED, XML) },
    ]);
    await activateObject(conn, ZMCP_MAIN);

    const calls = http.calls.filter(onActivation);
    expect(calls).toHaveLength(2);
    expect(String((calls[0]?.qs as Record<string, unknown> | undefined)?.["preauditRequested"])).toBe(
      "true",
    );
    expect(String((calls[1]?.qs as Record<string, unknown> | undefined)?.["preauditRequested"])).toBe(
      "false",
    );
    // The old third-POST verification probe is gone: it was
    // live-proven wrong on a FUGR/F. Confirm no third call to the
    // activation endpoint happens at all...
    expect(http.calls.filter(onActivation)).toHaveLength(2);
    // ...and that verification instead reached the seed's own version
    // history: one GET for the structure document, one for the feed it points to.
    expect(http.calls.filter(isSeedStructureGet(ZMCP_MAIN.uri))).toHaveLength(1);
    expect(http.calls.filter(isSeedVersionsGet(ZMCP_MAIN.uri))).toHaveLength(1);
  });

  it("the second POST carries the seed plus the de-duplicated preaudit refs, with the ref-less entry absent", async () => {
    const { conn, http } = await connectWrite([
      { match: isPhase1, reply: resp(200, PREAUDIT_ZMCP_MAIN, XML) },
      { match: isPhase2, reply: resp(200, "", { "content-length": "0" }) },
    ]);
    await activateObject(conn, ZMCP_MAIN);

    const phase2 = http.calls.filter(isPhase2);
    expect(phase2).toHaveLength(1);
    const uris = extractUris(String(phase2[0]?.body ?? ""));
    // Exactly 3: the seed, the (de-duplicated) testclasses include, ZMCP_DEP.
    // NOT 4 (the case-varied duplicate not collapsed) and NOT 1 (row-3 no-op).
    expect(uris).toHaveLength(3);
    expect(new Set(uris)).toEqual(
      new Set([
        ZMCP_MAIN.uri,
        "/sap/bc/adt/oo/classes/zmcp_main/includes/testclasses",
        "/sap/bc/adt/oo/classes/zmcp_dep",
      ]),
    );
    expect(uris).toContain(ZMCP_MAIN.uri);
  });

  it("returns activated: true, and assertNoErrors does not throw, once the verification POST also reports empty", async () => {
    const { conn } = await connectWrite([
      {
        match: isPhase1,
        reply: sequence(
          resp(200, PREAUDIT_ZMCP_MAIN, XML),
          resp(200, "", { "content-length": "0" }),
        ),
      },
      { match: isPhase2, reply: resp(200, "", { "content-length": "0" }) },
    ]);
    const out = await activateObject(conn, ZMCP_MAIN);
    expect(out.activated).toBe(true);
    expect(out.ok).toBe(true);
    // The bug this fixes: a real activation, correctly completed via the
    // handshake, must never be reported through the "dependent objects are
    // still inactive" CHECK_FAILED path.
    expect(() =>
      assertNoErrors(out, { what: "Activation", name: ZMCP_MAIN.name }),
    ).not.toThrow();
  });

  it("populates outcome.preaudit with the co-activated objects", async () => {
    const { conn } = await connectWrite([
      {
        match: isPhase1,
        reply: sequence(
          resp(200, PREAUDIT_ZMCP_MAIN, XML),
          resp(200, "", { "content-length": "0" }),
        ),
      },
      { match: isPhase2, reply: resp(200, "", { "content-length": "0" }) },
    ]);
    const out = await activateObject(conn, ZMCP_MAIN);
    expect(out.preaudit).toBeDefined();
    const names = out.preaudit!.map((r) => r.name);
    expect(names).toContain("ZMCP_DEP");
    expect(names).toContain("ZMCP_MAIN");
  });

  it("still surfaces as a failure when the second POST still lists an inactive dependent, with no third POST", async () => {
    const { conn, http } = await connectWrite([
      { match: isPhase1, reply: resp(200, PREAUDIT_ZMCP_MAIN, XML) },
      { match: isPhase2, reply: resp(200, PREAUDIT_STILL_INACTIVE, XML) },
    ]);
    const out = await activateObject(conn, ZMCP_MAIN);
    // A self-describingly-failed second POST is trusted directly — the third,
    // verification-only POST exists to disbelieve an EMPTY 200, not this.
    expect(http.calls.filter(onActivation)).toHaveLength(2);
    expect(out.activated).toBe(false);
    expect(out.inactive).toEqual([
      { name: "ZMCP_DEP", type: "CLAS/OC", uri: "/sap/bc/adt/oo/classes/zmcp_dep" },
    ]);
    const err = catchAbap(() =>
      assertNoErrors(out, { what: "Activation", name: ZMCP_MAIN.name }),
    );
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("ZMCP_DEP");
    expect(err.message).toContain("NOT activated");
  });

  it("row-3 guard: a preaudit set naming only the seed sends no second POST and still fails", async () => {
    const { conn, http } = await connect([
      { match: onActivation, reply: resp(200, PREAUDIT_SEED_ONLY, XML) },
    ]);
    const out = await activateObject(conn, ZMCP_MAIN);
    expect(http.calls.filter(onActivation)).toHaveLength(1);
    expect(out.activated).toBe(false);
    expect(out.inactive).toHaveLength(1);
    expect(out.preaudit).toBeUndefined();
  });

  it("row-3 guard: a preaudit set with only ref-less entries sends no second POST and still fails", async () => {
    const { conn, http } = await connect([
      { match: onActivation, reply: resp(200, PREAUDIT_ALL_UNADDRESSABLE, XML) },
    ]);
    const out = await activateObject(conn, ZMCP_MAIN);
    expect(http.calls.filter(onActivation)).toHaveLength(1);
    expect(out.activated).toBe(false);
    expect(out.inactive).toEqual([{ name: "(unknown)", type: "(unknown)" }]);
    expect(out.preaudit).toBeUndefined();
  });

  it("a first reply carrying both a real [EAX] message and an inactive list does not trigger a second POST", async () => {
    const { conn, http } = await connect([
      { match: onActivation, reply: resp(200, ACTIVATION_ERROR_WITH_INACTIVE, XML) },
    ]);
    const out = await activateObject(conn, ZMCP_MAIN);
    expect(http.calls.filter(onActivation)).toHaveLength(1);
    expect(out.activated).toBe(false);
    expect(out.errors).toBeGreaterThan(0);
  });

  it("$TMP shape: a 200-empty first reply makes exactly one POST and activates", async () => {
    const { conn, http } = await connect([
      { match: onActivation, reply: resp(200, "", { "content-length": "0" }) },
    ]);
    const out = await activateObject(conn, ZMCP_MAIN);
    expect(http.calls.filter(onActivation)).toHaveLength(1);
    expect(out.activated).toBe(true);
    expect(out.preaudit).toBeUndefined();
  });
});

describe("preauditActivationSet", () => {
  const SEED_A: ActivationTarget = {
    name: "ZMCP_A",
    uri: "/sap/bc/adt/oo/classes/zmcp_a",
    type: "CLAS/OC",
  };
  const SEED_B: ActivationTarget = {
    name: "ZMCP_B",
    uri: "/sap/bc/adt/oo/classes/zmcp_b",
    type: "CLAS/OC",
  };

  it("keeps seeds in the given order ahead of any preaudit refs", () => {
    const set = preauditActivationSet([SEED_A, SEED_B], []);
    expect(set.targets).toEqual([SEED_A, SEED_B]);
    expect(set.unaddressable).toBe(0);
  });

  it("de-dupes by activationRefKey — a differently-cased path segment still collapses", () => {
    const inactive: InactiveObjectRef[] = [
      { name: "ZMCP_DEP", type: "CLAS/OC", uri: "/sap/bc/adt/oo/classes/zmcp_dep" },
      { name: "ZMCP_DEP", type: "CLAS/OC", uri: "/sap/bc/adt/oo/CLASSES/ZMCP_Dep" },
    ];
    const set = preauditActivationSet([SEED_A], inactive);
    expect(set.targets).toHaveLength(2);
    expect(set.targets[1]).toMatchObject({
      name: "ZMCP_DEP",
      uri: "/sap/bc/adt/oo/classes/zmcp_dep",
    });
  });

  it("counts ref-less entries in unaddressable and leaves them out of targets", () => {
    const inactive: InactiveObjectRef[] = [
      { name: "(unknown)", type: "(unknown)" },
      { name: "ZMCP_DEP", type: "CLAS/OC", uri: "/sap/bc/adt/oo/classes/zmcp_dep" },
    ];
    const set = preauditActivationSet([SEED_A], inactive);
    expect(set.targets).toHaveLength(2);
    expect(set.unaddressable).toBe(1);
  });

  it("carries type through when the ref has one, omits the field when it doesn't", () => {
    const inactive: InactiveObjectRef[] = [
      { name: "ZMCP_DEP", type: "CLAS/OC", uri: "/sap/bc/adt/oo/classes/zmcp_dep" },
      { name: "ZMCP_UNTYPED", type: "", uri: "/sap/bc/adt/oo/classes/zmcp_untyped" },
    ];
    const set = preauditActivationSet([], inactive);
    expect(set.targets[0]).toMatchObject({ type: "CLAS/OC" });
    expect(set.targets[1]).not.toHaveProperty("type");
  });

  it("keeps every ref that differs only by uri fragment, proven against the reconstructed document", () => {
    // Pre-fix (dedup by normaliseAdtUri) the four `/source/main#...` refs
    // collapse to their shared base URI, leaving 5 targets instead of 8.
    const parsed = parseActivationResponse(PREAUDIT_ZTMD_HS358_A);
    const refs = mapInactiveObjects(parsed);
    const set = preauditActivationSet([ZTMD_HS358_A], refs);
    expect(set.targets.map((t) => t.uri)).toEqual(ZTMD_HS358_A_URIS);
    expect(set.unaddressable).toBe(1);
  });
});

describe("activateObjects — preaudit handshake (batch)", () => {
  it("a chunk whose reply is a preaudit document makes exactly two POSTs (no third), verifies by version history, and BatchActivationOutcome.preaudit is populated", async () => {
    const { conn, http } = await connectWrite([
      LOGON_ROUTE,
      { match: isPhase1, reply: resp(200, PREAUDIT_ZMCP_MAIN, XML) },
      { match: isPhase2, reply: resp(200, "", { "content-length": "0" }) },
      {
        match: isSeedStructureGet(ZMCP_MAIN.uri),
        reply: resp(200, structureWithVersionsLink(ZMCP_MAIN), XML),
      },
      { match: isSeedVersionsGet(ZMCP_MAIN.uri), reply: resp(200, ACTIVE_ONLY_FEED, XML) },
    ]);
    const outcome = await activateObjects(conn, [ZMCP_MAIN]);

    const calls = http.calls.filter(onActivation);
    expect(calls).toHaveLength(2);
    expect(String((calls[0]?.qs as Record<string, unknown> | undefined)?.["preauditRequested"])).toBe(
      "true",
    );
    expect(String((calls[1]?.qs as Record<string, unknown> | undefined)?.["preauditRequested"])).toBe(
      "false",
    );
    // No third POST to the activation endpoint — verification reads the
    // seed's own version history instead.
    expect(http.calls.filter(onActivation)).toHaveLength(2);
    expect(http.calls.filter(isSeedStructureGet(ZMCP_MAIN.uri))).toHaveLength(1);
    expect(http.calls.filter(isSeedVersionsGet(ZMCP_MAIN.uri))).toHaveLength(1);

    expect(outcome.activated).toBe(true);
    expect(outcome.preaudit).toBeDefined();
    expect(outcome.preaudit!.map((r) => r.name)).toContain("ZMCP_DEP");
  });
});

describe("activateObject — the false-success regression", () => {
  it("an empty phase-two 200 with a pending inactive draft must not read as activated", async () => {
    // Inferred from the probe table, not itself measured: posting an
    // incomplete set also answers 200 empty while the object stays a pending
    // `99999 INACTIVE` draft. The old two-POST handshake trusted that empty
    // 200 outright. The current handshake instead reads the seed's own
    // version history (`seedsStillInactive`, src/adt/activate.ts) — modelled
    // here with a SYNTHETIC feed whose one entry is `99999` (see
    // `syntheticInactiveFeed`'s doc comment for exactly what in it is real
    // and what is inferred).
    const { conn } = await connectWrite([
      LOGON_ROUTE,
      { match: isPhase1, reply: resp(200, PREAUDIT_ZTMD_HS358_A, XML) },
      { match: isPhase2, reply: resp(200, "", { "content-length": "0" }) },
      {
        match: isSeedStructureGet(ZTMD_HS358_A.uri),
        reply: resp(200, structureWithVersionsLink(ZTMD_HS358_A), XML),
      },
      {
        match: isSeedVersionsGet(ZTMD_HS358_A.uri),
        reply: resp(200, syntheticInactiveFeed(ZTMD_HS358_A.uri), XML),
      },
    ]);
    const out = await activateObject(conn, ZTMD_HS358_A);
    expect(out.activated).toBe(false);
    expect(out.inactive.map((r) => r.name)).toContain(ZTMD_HS358_A.name);
    const err = catchAbap(() =>
      assertNoErrors(out, { what: "Activation", name: ZTMD_HS358_A.name }),
    );
    expect(err.code).toBe("CHECK_FAILED");
  });
});

describe("activateObject — full two-POST handshake against the reconstructed document", () => {
  it("activates once version-history verification finds no 99999 row, having sent all 8 refs with fragments intact on the second POST", async () => {
    const { conn, http } = await connectWrite([
      LOGON_ROUTE,
      { match: isPhase1, reply: resp(200, PREAUDIT_ZTMD_HS358_A, XML) },
      { match: isPhase2, reply: resp(200, "", { "content-length": "0" }) },
      {
        match: isSeedStructureGet(ZTMD_HS358_A.uri),
        reply: resp(200, structureWithVersionsLink(ZTMD_HS358_A), XML),
      },
      { match: isSeedVersionsGet(ZTMD_HS358_A.uri), reply: resp(200, ACTIVE_ONLY_FEED, XML) },
    ]);
    const out = await activateObject(conn, ZTMD_HS358_A);
    expect(out.activated).toBe(true);

    const calls = http.calls.filter(onActivation);
    expect(calls).toHaveLength(2);
    expect(String((calls[0]?.qs as Record<string, unknown> | undefined)?.["preauditRequested"])).toBe(
      "true",
    );
    expect(String((calls[1]?.qs as Record<string, unknown> | undefined)?.["preauditRequested"])).toBe(
      "false",
    );
    // No third POST — the fragment-intact second POST is what verification
    // now follows up on with a GET, not another POST.
    expect(http.calls.filter(onActivation)).toHaveLength(2);

    const phase2Body = String(http.calls.filter(isPhase2)[0]?.body ?? "");
    expect(extractUris(phase2Body)).toEqual(ZTMD_HS358_A_URIS);
  });
});

describe("activateObject — version-history verification", () => {
  it("activates, with no CHECK_FAILED, when the seed's version-history feed is the real live capture and it's active-only", async () => {
    const { conn } = await connectWrite([
      LOGON_ROUTE,
      { match: isPhase1, reply: resp(200, PREAUDIT_ZMCP_MAIN, XML) },
      { match: isPhase2, reply: resp(200, "", { "content-length": "0" }) },
      {
        match: isSeedStructureGet(ZMCP_MAIN.uri),
        reply: resp(200, structureWithVersionsLink(ZMCP_MAIN), XML),
      },
      // The real live capture (test/fixtures/revisions, see that dir's
      // README) — not a hand-built stand-in.
      { match: isSeedVersionsGet(ZMCP_MAIN.uri), reply: resp(200, ACTIVE_ONLY_FEED, XML) },
    ]);
    const out = await activateObject(conn, ZMCP_MAIN);
    expect(out.activated).toBe(true);
    expect(() =>
      assertNoErrors(out, { what: "Activation", name: ZMCP_MAIN.name }),
    ).not.toThrow();
  });

  it("activates when the seed's structure document carries no versions link at all — a deliberate fallback, not the old distrust-everything default", async () => {
    // Before this fix, the third POST distrusted every empty phase-two 200 until
    // proven active. `seedsStillInactive` (src/adt/activate.ts) inverts
    // that: a seed whose version history can't be read at all — no
    // `atom:link rel=".../relations/versions"` to follow, so
    // `conn.adt.revisions` throws — is inconclusive, and inconclusive is
    // treated as believed-activated rather than as a failure. This is the
    // documented, intentional behavior change, not an oversight.
    const { conn } = await connectWrite([
      LOGON_ROUTE,
      { match: isPhase1, reply: resp(200, PREAUDIT_ZMCP_MAIN, XML) },
      { match: isPhase2, reply: resp(200, "", { "content-length": "0" }) },
      {
        match: isSeedStructureGet(ZMCP_MAIN.uri),
        reply: resp(200, structureWithoutVersionsLink(ZMCP_MAIN), XML),
      },
    ]);
    const out = await activateObject(conn, ZMCP_MAIN);
    expect(out.activated).toBe(true);
    expect(() =>
      assertNoErrors(out, { what: "Activation", name: ZMCP_MAIN.name }),
    ).not.toThrow();
  });
});

describe("activateObject — a genuine phase-two failure sends no verification POST", () => {
  it("a real [EAX] message on phase two is trusted directly, without a third POST", async () => {
    const { conn, http } = await connectWrite([
      { match: isPhase1, reply: resp(200, PREAUDIT_ZTMD_HS358_A, XML) },
      { match: isPhase2, reply: resp(200, PHASE2_EAX_METHOD_NOT_DECLARED, XML) },
    ]);
    const out = await activateObject(conn, ZTMD_HS358_A);
    expect(http.calls.filter(onActivation)).toHaveLength(2);
    expect(out.activated).toBe(false);
    const err = catchAbap(() =>
      assertNoErrors(out, { what: "Activation", name: ZTMD_HS358_A.name }),
    );
    expect(String(err.details.messages)).toContain(
      'Method "COMPUTE" is not declared or inherited in class "ZTMD_HS358_A"',
    );
  });
});

describe("activationRefKey", () => {
  it("gives different keys to refs sharing a base uri that differ only by fragment", () => {
    const a = activationRefKey(
      "/sap/bc/adt/oo/classes/ztmd_hs358_a/source/main#type=CLAS%2FOSI;name=ZTMD_HS358_A",
    );
    const b = activationRefKey(
      "/sap/bc/adt/oo/classes/ztmd_hs358_a/source/main#type=CLAS%2FOSO;name=ZTMD_HS358_A",
    );
    expect(a).not.toBe(b);
  });

  it("still collapses a differently-cased path segment when there is no fragment", () => {
    const a = activationRefKey("/sap/bc/adt/oo/classes/zmcp_dep");
    const b = activationRefKey("/sap/bc/adt/oo/CLASSES/ZMCP_Dep");
    expect(a).toBe(b);
  });

  it("behaves like normaliseAdtUri for a uri with no fragment", () => {
    const uri = "/sap/bc/adt/oo/classes/ZMCP_Main/";
    expect(activationRefKey(uri)).toBe(normaliseAdtUri(uri));
  });
});

describe("assertNoErrors — preaudit-aware hint", () => {
  const inactive: InactiveObjectRef[] = [
    { name: "ZMCP_DEP", type: "CLAS/OC", uri: "/sap/bc/adt/oo/classes/zmcp_dep" },
  ];

  it("names the handshake when outcome.preaudit is non-empty: it already re-sent naming every preaudit object", () => {
    const err = catchAbap(() =>
      assertNoErrors(
        {
          activated: false,
          ok: false,
          messages: [],
          errors: 0,
          warnings: 0,
          inactive,
          preaudit: inactive,
        },
        { what: "Activation", name: "ZMCP_MAIN" },
      ),
    );
    expect(err.hint).toContain("already re-sent the activation");
    expect(err.hint).toContain("abap_activate mode=check");
  });

  it("keeps the plain renderInactive hint unchanged when no preaudit was sent", () => {
    const err = catchAbap(() =>
      assertNoErrors(
        { activated: false, ok: false, messages: [], errors: 0, warnings: 0, inactive },
        { what: "Activation", name: "ZMCP_MAIN" },
      ),
    );
    expect(err.hint).toContain("Activate them first, or activate them together with this object.");
    expect(err.hint).not.toContain("already re-sent the activation");
  });
});

describe("activateObject — phase two's own messages survive a clean verification POST", () => {
  it("keeps a phase-two warning even though the verification POST that follows it answers empty", async () => {
    const { conn } = await connectWrite([
      {
        match: isPhase1,
        reply: sequence(
          resp(200, PREAUDIT_ZTMD_HS358_A, XML),
          resp(200, "", { "content-length": "0" }),
        ),
      },
      { match: isPhase2, reply: resp(200, PHASE2_WARNING_ONLY, XML) },
    ]);
    const out = await activateObject(conn, ZTMD_HS358_A);
    expect(out.activated).toBe(true);
    expect(out.warnings).toBe(1);
    expect(out.messages.map((m) => m.text)).toContain(
      'Enhancement category of class "ZTMD_HS358_A" is not defined; defaults to "cannot be enhanced".',
    );
  });
});
