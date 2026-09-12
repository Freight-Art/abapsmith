/**
 * `src/adt/atc.ts` — the ADT I/O layer for ATC (ABAP Test Cockpit) runs.
 *
 * ## Most of this file is still SYNTHETIC — read this before trusting it.
 *
 * The four-request run lifecycle (customizing → worklist create → run → two
 * reads) has no capture of its own: nothing recorded a live run driven
 * start to finish. So the lifecycle tests below still use hand-written
 * doubles for `runAck`/`worklistDoc`, and the URLs and headers asserted
 * along that path are this client's own intentions read back to it — same
 * as before issue #78.
 *
 * What issue #78 changed: `test/fixtures/live-captured/` now holds REAL A4H
 * recordings, and this file replays the ones that fit byte-for-byte —
 * `852-i78-checkvariants-quicksearch.xml` (`listCheckVariants`),
 * `857-i78-worklist-delete-405.xml` (`deleteAtcWorklist`'s actual, only
 * OBSERVED outcome — see the module header in `src/adt/atc.ts` for why
 * DELETE is always refused on this release), and
 * `859-i78-atc-customizing.xml` (a real customizing document). A confirmed
 * WORKING delete and a package tree with subpackages have no capture at
 * all — A4H's DELETE always answers 405, and A4H has no customer package
 * with subpackages to walk — so those two are hand-written and marked
 * UNVERIFIED at the point they're used.
 *
 * That makes this file a test of the LIFECYCLE plus issue #78's additions
 * (check variants, worklist deletion, `autoCleanup`, package-tree
 * expansion), not a full protocol conformance test. It proves:
 *
 *   - the four requests happen in the right order, with the right verbs;
 *   - a worklist is created ONCE per (connection, variant) and then reused,
 *     which is the whole litter-control design;
 *   - the second worklist GET is scoped to the `LAST_RUN` object set, and when
 *     the server names no such set the result says `scopedToLastRun: false`
 *     instead of quietly presenting an accumulated worklist as one run;
 *   - a stale cached worklist id triggers exactly one retry;
 *   - failures are classified with ATC-specific hints;
 *   - a multi-URI run sends every URI and reports how many distinct
 *     targets actually went out, and an empty `authorized` list is refused
 *     before any request is made;
 *   - `listCheckVariants` makes one HTTP call per connection and caches it;
 *     `resolveCheckVariant` matches case-insensitively, refuses an unknown
 *     name, and FAILS OPEN (marking the run unvalidated) when the listing
 *     call itself cannot be made;
 *   - `deleteAtcWorklist` reports a server refusal without throwing and
 *     without discarding the cached worklist id, and only forgets it on a
 *     confirmed success;
 *   - `autoCleanup` runs cleanup AFTER findings are already in hand, so a
 *     refused cleanup never costs the caller its findings;
 *   - `expandPackageTree` makes NO HTTP call when it isn't asked to
 *     recurse, and is cycle-guarded and capped when it is.
 *
 * It proves nothing about whether SAP's ATC actually speaks the parts of
 * this dialect no capture backs. What a live run must confirm is listed in
 * `doc/TOOLS/abap-atc.md`.
 *
 * The transport is the house fake (`test/dumps.test.ts:98`,
 * `test/data-preview.test.ts`): a plain object cast through `unknown`, which
 * records every call so a test can assert on the ABSENCE of a request as well
 * as on its arguments — now with a `del` dispatch alongside `get`/`post`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AbapConnection } from "../src/adt/connection.js";
import { isAbapError } from "../src/adt/errors.js";
import {
  ATC_CHECK_VARIANT_SEARCH_ACCEPT,
  ATC_CUSTOMIZING_ACCEPT,
  ATC_CUSTOMIZING_PATH,
  ATC_RUN_ACCEPT,
  ATC_RUN_CONTENT_TYPE,
  ATC_WORKLIST_ACCEPT,
  ATC_WORKLIST_CREATE_ACCEPT,
  ATC_WORKLIST_DELETE_ACCEPT,
  buildAtcRunBody,
  buildCheckVariantSearchUrl,
  buildWorklistDeleteUrl,
} from "../src/adt/atc-query.js";
import {
  ATC_MAX_PACKAGE_DEPTH,
  ATC_MAX_PACKAGE_NODES,
  classifyAtcFailure,
  clearAtcCaches,
  deleteAtcWorklist,
  ensureAtcWorklist,
  expandPackageTree,
  fetchDefaultCheckVariant,
  knownAtcWorklists,
  listCheckVariants,
  resolveCheckVariant,
  runAtcCheck,
} from "../src/adt/atc.js";
import { SafetyGate, type AuthorizedTarget } from "../src/safety.js";

const LIVE_FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "live-captured",
);
/** REAL byte-for-byte A4H recordings — see the header for which tests use which. */
const readLiveFixture = (name: string): string =>
  readFileSync(join(LIVE_FIXTURES, name), "utf8");
/** The `.meta.json` sidecar recording the exact request/response around a capture. */
const readLiveMeta = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(LIVE_FIXTURES, name), "utf8")) as Record<string, unknown>;

// -------------------------------------------------- synthetic ATC documents ---

/** SYNTHETIC. Shaped after `abap-adt-api`'s decoder, not after a capture. */
const CUSTOMIZING = `<?xml version="1.0" encoding="UTF-8"?>
<atc:customizing xmlns:atc="http://www.sap.com/adt/atc">
  <properties>
    <property name="systemCheckVariant" value="ZDEFAULT"/>
    <property name="isBlockingFindingsEnabled" value="true"/>
  </properties>
  <exemption>
    <reasons>
      <reason id="FPOS" title="False positive" justificationMandatory="true"/>
    </reasons>
  </exemption>
</atc:customizing>`;

/** SYNTHETIC. `worklistId`/`worklistTimestamp` as child elements. */
function runAck(worklistId: string, timestamp = "2026-08-18T09:00:00Z"): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<atc:worklistRun xmlns:atc="http://www.sap.com/adt/atc">
  <atc:worklistId>${worklistId}</atc:worklistId>
  <atc:worklistTimestamp>${timestamp}</atc:worklistTimestamp>
  <atc:infos/>
</atc:worklistRun>`;
}

/** SYNTHETIC. Two findings so the priority sort is observable. */
function worklistDoc(
  id: string,
  opts: { readonly lastRun?: boolean; readonly findings?: boolean } = {},
): string {
  const sets =
    opts.lastRun === false
      ? `<objectSet name="ALL" kind="ALL" title="Everything"/>`
      : `<objectSet name="ALL" kind="ALL" title="Everything"/>
    <objectSet name="00001" kind="LAST_RUN" title="Last run"/>`;
  const findings =
    opts.findings === false
      ? ""
      : `<finding uri="/sap/bc/adt/atc/findings/1"
                 location="/sap/bc/adt/oo/classes/zcl_x/source/main#start=17,4"
                 priority="3" checkId="CI1" checkTitle="Naming"
                 messageId="0003" messageTitle="Name is not conventional"
                 exemptionKind="" exemptionApproval=""/>
        <finding uri="/sap/bc/adt/atc/findings/2"
                 location="/sap/bc/adt/oo/classes/zcl_x/source/main#start=42,2"
                 priority="1" checkId="CI2" checkTitle="Security"
                 messageId="0001" messageTitle="Dynamic SQL"
                 exemptionKind="" exemptionApproval=""/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<atc:worklist xmlns:atc="http://www.sap.com/adt/atc"
              id="${id}" timestamp="2026-08-18T09:00:00Z"
              objectSetIsComplete="true">
  <objectSets>
    ${sets}
  </objectSets>
  <objects>
    <object uri="/sap/bc/adt/oo/classes/zcl_x" name="ZCL_X" type="CLAS/OC"
            packageName="$TMP">
      <findings>
        ${findings}
      </findings>
    </object>
  </objects>
</atc:worklist>`;
}

// ---------------------------------------------------------------- transport ---

interface Call {
  method: "GET" | "POST" | "DELETE";
  url: string;
  headers: Record<string, string>;
  body?: string;
}

type Reply = { body: string; status?: number } | { throws: unknown };
type Handler = (method: "GET" | "POST" | "DELETE", url: string) => Reply;

function fakeConn(handler: Handler): { conn: AbapConnection; calls: Call[] } {
  const calls: Call[] = [];
  const dispatch = (method: "GET" | "POST" | "DELETE") => {
    return async (
      url: string,
      opts: { headers?: Record<string, string>; body?: string } = {},
    ) => {
      calls.push({
        method,
        url,
        headers: opts.headers ?? {},
        ...(opts.body === undefined ? {} : { body: opts.body }),
      });
      const reply = handler(method, url);
      if ("throws" in reply) throw reply.throws;
      return { body: reply.body, status: reply.status ?? 200, headers: {} };
    };
  };
  const conn = {
    // Fail-open in the real `Discovery`; a no-op here so the tests exercise the
    // lifecycle rather than the probe, which `test/discovery.test.ts` owns.
    discovery: { assertSupported: () => {} },
    // Real `AbapConnection.cfg.timeoutMs` — `classifyAtcFailure`'s timeout
    // branch names this value (`ABAP_TIMEOUT_MS=<value>`) in its hint. A
    // fixed, recognisable number so the "the timeout — see below" test can
    // assert on it without hardcoding config.ts's own default.
    cfg: { timeoutMs: 60_000 },
    get: dispatch("GET"),
    post: dispatch("POST"),
    del: dispatch("DELETE"),
    // `expandPackageTree` walks this, not `get`/`post` — see abap-adt-api's
    // `ADTClient.nodeContents`, precedented by `readPackage` in ddic.ts:858.
    // Routed through the same `calls` log (as a synthetic "nodeContents:X"
    // GET) so "no HTTP call happened" assertions stay uniform across tests.
    adt: {
      nodeContents: async (_parentType: string, parentName: string) => {
        const url = `nodeContents:${parentName}`;
        calls.push({ method: "GET", url, headers: {} });
        const reply = handler("GET", url);
        if ("throws" in reply) throw reply.throws;
        return JSON.parse(reply.body) as {
          nodes: ReadonlyArray<{ OBJECT_TYPE: string; OBJECT_NAME: string }>;
        };
      },
    },
  } as unknown as AbapConnection;
  return { conn, calls };
}

/** The default script: customizing → worklist create → run → two reads. */
function happyHandler(worklistId = "0A1B2C"): Handler {
  return (method, url) => {
    if (method === "GET" && url.startsWith(ATC_CUSTOMIZING_PATH)) {
      return { body: CUSTOMIZING };
    }
    if (method === "POST" && url.startsWith("/sap/bc/adt/atc/worklists")) {
      return { body: `${worklistId}\n` };
    }
    if (method === "POST" && url.startsWith("/sap/bc/adt/atc/runs")) {
      return { body: runAck(worklistId) };
    }
    if (method === "GET" && url.startsWith("/sap/bc/adt/atc/worklists/")) {
      return { body: worklistDoc(worklistId) };
    }
    throw new Error(`unscripted request: ${method} ${url}`);
  };
}

/** The proof object `runAtcCheck` demands, minted by a real gate. */
function authorize(name = "ZCL_X"): AuthorizedTarget<"execute"> {
  const gate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
  return gate.authorize("execute", { name, packageName: "$TMP", type: "CLAS/OC" });
}

/** One authorization per name — for the multi-object run tests. */
function authorizeAll(names: readonly string[]): readonly AuthorizedTarget<"execute">[] {
  return names.map((name) => authorize(name));
}

const OBJECT_URI = "/sap/bc/adt/oo/classes/zcl_x/source/main";

// ------------------------------------------------------------------- tests ---

describe("ATC customizing", () => {
  it("reads the system check variant and asks for the library's Accept", async () => {
    const { conn, calls } = fakeConn(happyHandler());
    expect(await fetchDefaultCheckVariant(conn)).toBe("ZDEFAULT");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(ATC_CUSTOMIZING_PATH);
    expect(calls[0]?.headers["Accept"]).toBe(ATC_CUSTOMIZING_ACCEPT);
  });

  it("caches the variant per connection", async () => {
    const { conn, calls } = fakeConn(happyHandler());
    await fetchDefaultCheckVariant(conn);
    await fetchDefaultCheckVariant(conn);
    expect(calls).toHaveLength(1);
    clearAtcCaches(conn);
    await fetchDefaultCheckVariant(conn);
    expect(calls).toHaveLength(2);
  });

  it("does not cache a failure — a blip must not be permanent", async () => {
    let attempts = 0;
    const { conn } = fakeConn((method, url) => {
      if (method === "GET" && url.startsWith(ATC_CUSTOMIZING_PATH)) {
        attempts += 1;
        if (attempts === 1) return { throws: { err: 500, message: "boom" } };
        return { body: CUSTOMIZING };
      }
      throw new Error("unscripted");
    });
    await expect(fetchDefaultCheckVariant(conn)).rejects.toThrow();
    expect(await fetchDefaultCheckVariant(conn)).toBe("ZDEFAULT");
    expect(attempts).toBe(2);
  });

  it("refuses when customizing names no default variant", async () => {
    const { conn } = fakeConn(() => ({
      body: `<atc:customizing xmlns:atc="x"><properties/></atc:customizing>`,
    }));
    await expect(fetchDefaultCheckVariant(conn)).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  });

  it("refuses a variant name the server invents that could reshape a URL", async () => {
    const { conn } = fakeConn(() => ({
      body: `<atc:customizing xmlns:atc="x"><properties>
        <property name="systemCheckVariant" value="A&amp;B=C"/>
      </properties></atc:customizing>`,
    }));
    await expect(fetchDefaultCheckVariant(conn)).rejects.toMatchObject({
      code: "BAD_INPUT",
    });
  });
});

describe("worklist creation", () => {
  it("POSTs the create URL with the plain-text Accept and returns the id", async () => {
    const { conn, calls } = fakeConn(happyHandler());
    const result = await ensureAtcWorklist(conn, "ZDEFAULT");
    expect(result).toEqual({ worklistId: "0A1B2C", reused: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("/sap/bc/adt/atc/worklists?checkVariant=ZDEFAULT");
    expect(calls[0]?.headers["Accept"]).toBe(ATC_WORKLIST_CREATE_ACCEPT);
  });

  it("creates ONE worklist per variant per connection — the litter control", async () => {
    const { conn, calls } = fakeConn(happyHandler());
    const first = await ensureAtcWorklist(conn, "ZDEFAULT");
    const second = await ensureAtcWorklist(conn, "ZDEFAULT");
    expect(first.reused).toBe(false);
    expect(second).toEqual({ worklistId: "0A1B2C", reused: true });
    expect(calls).toHaveLength(1);
  });

  it("keeps a separate worklist per variant", async () => {
    const { conn, calls } = fakeConn(happyHandler());
    await ensureAtcWorklist(conn, "ZDEFAULT");
    await ensureAtcWorklist(conn, "ZSTRICT");
    expect(calls).toHaveLength(2);
    expect(knownAtcWorklists(conn)).toHaveLength(2);
  });

  it("creates a new one on forceNew", async () => {
    let n = 0;
    const { conn } = fakeConn((method, url) => {
      if (method === "POST" && url.startsWith("/sap/bc/adt/atc/worklists")) {
        n += 1;
        return { body: `WL${n}` };
      }
      throw new Error("unscripted");
    });
    expect((await ensureAtcWorklist(conn, "ZDEFAULT")).worklistId).toBe("WL1");
    expect(
      (await ensureAtcWorklist(conn, "ZDEFAULT", { forceNew: true })).worklistId,
    ).toBe("WL2");
  });

  it("refuses an empty body — there is nothing to run checks into", async () => {
    const { conn } = fakeConn(() => ({ body: "   " }));
    await expect(ensureAtcWorklist(conn, "ZDEFAULT")).rejects.toMatchObject({
      code: "ADT_ERROR",
    });
  });

  it("refuses a body that is a document rather than an id", async () => {
    const { conn } = fakeConn(() => ({
      body: `<html><body>Logon page</body></html>`,
    }));
    await expect(ensureAtcWorklist(conn, "ZDEFAULT")).rejects.toMatchObject({
      code: "ADT_ERROR",
    });
  });

  it("rejects a caller-supplied variant before it reaches the wire", async () => {
    const { conn, calls } = fakeConn(happyHandler());
    await expect(ensureAtcWorklist(conn, "A B&C")).rejects.toMatchObject({
      code: "BAD_INPUT",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("runAtcCheck — the four-request lifecycle", () => {
  it("issues customizing, create, run, read, read — in that order", async () => {
    const { conn, calls } = fakeConn(happyHandler());
    const result = await runAtcCheck(conn, { objectUris: [OBJECT_URI] }, [authorize()]);

    expect(calls.map((c) => `${c.method} ${c.url.split("?")[0] ?? ""}`)).toEqual([
      "GET /sap/bc/adt/atc/customizing",
      "POST /sap/bc/adt/atc/worklists",
      "POST /sap/bc/adt/atc/runs",
      "GET /sap/bc/adt/atc/worklists/0A1B2C",
      "GET /sap/bc/adt/atc/worklists/0A1B2C",
    ]);
    expect(result.checkVariant).toBe("ZDEFAULT");
    expect(result.worklistId).toBe("0A1B2C");
    expect(result.worklistReused).toBe(false);
    expect(result.scopedToLastRun).toBe(true);
    expect(result.objectSetIsComplete).toBe(true);
  });

  it("sends the run body and the run headers the library sends", async () => {
    const { conn, calls } = fakeConn(happyHandler());
    await runAtcCheck(conn, { objectUris: [OBJECT_URI], maxVerdicts: 42 }, [authorize()]);
    const run = calls.find((c) => c.url.startsWith("/sap/bc/adt/atc/runs"));
    expect(run?.url).toBe("/sap/bc/adt/atc/runs?worklistId=0A1B2C");
    expect(run?.headers["Accept"]).toBe(ATC_RUN_ACCEPT);
    expect(run?.headers["Content-Type"]).toBe(ATC_RUN_CONTENT_TYPE);
    expect(run?.body).toBe(buildAtcRunBody([OBJECT_URI], 42));
  });

  it("scopes the SECOND worklist read to the LAST_RUN object set", async () => {
    const { conn, calls } = fakeConn(happyHandler());
    await runAtcCheck(conn, { objectUris: [OBJECT_URI] }, [authorize()]);
    const reads = calls.filter(
      (c) => c.method === "GET" && c.url.startsWith("/sap/bc/adt/atc/worklists/"),
    );
    expect(reads).toHaveLength(2);
    // The first read exists ONLY to learn the object set's name.
    expect(reads[0]?.url).not.toContain("usedObjectSet");
    expect(reads[1]?.url).toContain("usedObjectSet=00001");
    expect(reads[1]?.url).toContain("timestamp=");
    for (const r of reads) {
      expect(r.headers["Accept"]).toBe(ATC_WORKLIST_ACCEPT);
      // Always on the wire, `false` included — matching the library.
      expect(r.url).toContain("includeExemptedFindings=false");
    }
  });

  it("passes include_exempted through to both reads", async () => {
    const { conn, calls } = fakeConn(happyHandler());
    await runAtcCheck(
      conn,
      { objectUris: [OBJECT_URI], includeExempted: true },
      [authorize()],
    );
    const reads = calls.filter(
      (c) => c.method === "GET" && c.url.startsWith("/sap/bc/adt/atc/worklists/"),
    );
    for (const r of reads) expect(r.url).toContain("includeExemptedFindings=true");
  });

  it("falls back to the unscoped read and SAYS SO when no LAST_RUN set exists", async () => {
    const { conn, calls } = fakeConn((method, url) => {
      if (method === "GET" && url.startsWith(ATC_CUSTOMIZING_PATH)) {
        return { body: CUSTOMIZING };
      }
      if (method === "POST" && url.startsWith("/sap/bc/adt/atc/worklists")) {
        return { body: "0A1B2C" };
      }
      if (method === "POST") return { body: runAck("0A1B2C") };
      return { body: worklistDoc("0A1B2C", { lastRun: false }) };
    });
    const result = await runAtcCheck(conn, { objectUris: [OBJECT_URI] }, [authorize()]);
    expect(result.scopedToLastRun).toBe(false);
    // Only ONE read: there is no second scope to re-read with.
    expect(
      calls.filter((c) => c.method === "GET" && c.url.includes("/worklists/")),
    ).toHaveLength(1);
  });

  it("sorts findings most severe first and counts them", async () => {
    const { conn } = fakeConn(happyHandler());
    const result = await runAtcCheck(conn, { objectUris: [OBJECT_URI] }, [authorize()]);
    expect(result.findings.map((f) => f.priority)).toEqual([1, 3]);
    expect(result.counts).toEqual({
      total: 2,
      errors: 1,
      warnings: 0,
      infos: 1,
      other: 0,
      exempted: 0,
    });
    expect(result.findings[0]?.objectName).toBe("ZCL_X");
    expect(result.findings[0]?.location.line).toBe(42);
  });

  it("reuses the worklist across two runs on the same connection", async () => {
    const { conn, calls } = fakeConn(happyHandler());
    await runAtcCheck(conn, { objectUris: [OBJECT_URI] }, [authorize()]);
    const after = calls.length;
    const second = await runAtcCheck(conn, { objectUris: [OBJECT_URI] }, [authorize()]);
    expect(second.worklistReused).toBe(true);
    // Second run: run + two reads. No customizing, no worklist creation.
    expect(calls.slice(after).map((c) => c.method)).toEqual(["POST", "GET", "GET"]);
    expect(
      calls.filter((c) => c.method === "POST" && c.url.includes("/worklists")),
    ).toHaveLength(1);
  });

  it("uses the caller's variant and then skips customizing entirely", async () => {
    // issue-78: a caller-named variant is now validated against the real
    // server list via `resolveCheckVariant` before the worklist is created —
    // that adds one quickSearch GET ahead of the worklist-create call, but
    // customizing (the DEFAULT-variant lookup) must still never be read.
    const { conn, calls } = fakeConn((method, url) => {
      if (url.startsWith(ATC_CUSTOMIZING_PATH)) {
        throw new Error("customizing must not be read when a variant was named");
      }
      if (method === "GET" && url === buildCheckVariantSearchUrl()) {
        return {
          body:
            '<?xml version="1.0" encoding="UTF-8"?>' +
            '<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">' +
            '<adtcore:objectReference adtcore:uri="/sap/bc/adt/atc/checkvariants/ZSTRICT" ' +
            'adtcore:type="CHKV/TYP" adtcore:name="ZSTRICT"/>' +
            "</adtcore:objectReferences>",
        };
      }
      if (method === "POST" && url.startsWith("/sap/bc/adt/atc/worklists")) {
        return { body: "0A1B2C" };
      }
      if (method === "POST") return { body: runAck("0A1B2C") };
      return { body: worklistDoc("0A1B2C") };
    });
    const result = await runAtcCheck(
      conn,
      { objectUris: [OBJECT_URI], checkVariant: "ZSTRICT" },
      [authorize()],
    );
    expect(result.checkVariant).toBe("ZSTRICT");
    expect(result.variantUnvalidated).toBeUndefined();
    expect(calls[0]?.url).toBe(buildCheckVariantSearchUrl());
    expect(calls[1]?.url).toBe("/sap/bc/adt/atc/worklists?checkVariant=ZSTRICT");
  });

  it("trusts the worklist id the server echoes over the one it sent", async () => {
    const { conn } = fakeConn((method, url) => {
      if (method === "GET" && url.startsWith(ATC_CUSTOMIZING_PATH)) {
        return { body: CUSTOMIZING };
      }
      if (method === "POST" && url.startsWith("/sap/bc/adt/atc/worklists")) {
        return { body: "SENT" };
      }
      if (method === "POST") return { body: runAck("ECHOED") };
      return { body: worklistDoc("ECHOED") };
    });
    const result = await runAtcCheck(conn, { objectUris: [OBJECT_URI] }, [authorize()]);
    expect(result.worklistId).toBe("ECHOED");
  });

  // The live gap issue #78's verifier found: an ATC run over a large scope
  // that genuinely exceeds `ABAP_TIMEOUT_MS` reached the caller as a bare,
  // unclassified `ADT_ERROR` ("timeout of 300000ms exceeded") with no hint.
  // End to end through `runAtcCheck` (not just `classifyAtcFailure` in
  // isolation above) — proves the run POST's timeout actually reaches the
  // caller through this path with `ABAP_TIMEOUT_MS` and the fake
  // connection's own `cfg.timeoutMs` named in the message.
  it("rethrows a run-POST timeout naming ABAP_TIMEOUT_MS instead of the bare axios message", async () => {
    const { conn } = fakeConn((method, url) => {
      if (method === "GET" && url.startsWith(ATC_CUSTOMIZING_PATH)) {
        return { body: CUSTOMIZING };
      }
      if (method === "POST" && url.startsWith("/sap/bc/adt/atc/worklists")) {
        return { body: "0A1B2C\n" };
      }
      if (method === "POST" && url.startsWith("/sap/bc/adt/atc/runs")) {
        return { throws: { code: "ECONNABORTED", message: "timeout of 60000ms exceeded" } };
      }
      throw new Error(`unscripted request: ${method} ${url}`);
    });
    let caught: unknown;
    try {
      await runAtcCheck(conn, { objectUris: [OBJECT_URI] }, [authorize()]);
    } catch (e) {
      caught = e;
    }
    expect(isAbapError(caught)).toBe(true);
    const err = caught as InstanceType<typeof AbapError>;
    expect(err.code).toBe("ADT_ERROR");
    // fakeConn's cfg.timeoutMs is 60_000 — see the fakeConn helper above.
    expect(err.message).toContain("ABAP_TIMEOUT_MS=60000");
    expect(err.hint).toMatch(/ABAP_TIMEOUT_MS/);
    expect(err.hint).toMatch(/worklist/i);
  });
});

describe("stale worklist id", () => {
  it("retries ONCE with a fresh worklist when a CACHED id is refused", async () => {
    let created = 0;
    const { conn, calls } = fakeConn((method, url) => {
      if (method === "GET" && url.startsWith(ATC_CUSTOMIZING_PATH)) {
        return { body: CUSTOMIZING };
      }
      if (method === "POST" && url.startsWith("/sap/bc/adt/atc/worklists")) {
        created += 1;
        return { body: created === 1 ? "OLD" : "NEW" };
      }
      if (method === "POST" && url.includes("worklistId=OLD")) {
        return { throws: { err: 404, message: "worklist not found" } };
      }
      if (method === "POST") return { body: runAck("NEW") };
      return { body: worklistDoc("NEW") };
    });

    // First run caches OLD. It must succeed, so OLD is only refused later —
    // simulate that by priming the cache directly.
    await ensureAtcWorklist(conn, "ZDEFAULT");
    const before = calls.length;
    const result = await runAtcCheck(conn, { objectUris: [OBJECT_URI] }, [authorize()]);
    expect(result.worklistId).toBe("NEW");
    expect(result.worklistReused).toBe(false);
    const runPosts = calls
      .slice(before)
      .filter((c) => c.method === "POST" && c.url.startsWith("/sap/bc/adt/atc/runs"));
    expect(runPosts).toHaveLength(2);
    expect(created).toBe(2);
  });

  it("does NOT retry when the worklist was created for this very run", async () => {
    let created = 0;
    const { conn } = fakeConn((method, url) => {
      if (method === "GET" && url.startsWith(ATC_CUSTOMIZING_PATH)) {
        return { body: CUSTOMIZING };
      }
      if (method === "POST" && url.startsWith("/sap/bc/adt/atc/worklists")) {
        created += 1;
        return { body: `WL${created}` };
      }
      return { throws: { err: 404, message: "nope" } };
    });
    await expect(
      runAtcCheck(conn, { objectUris: [OBJECT_URI] }, [authorize()]),
    ).rejects.toThrow();
    // Retrying a brand-new worklist would just create a second one.
    expect(created).toBe(1);
  });
});

describe("classifyAtcFailure", () => {
  it("turns a 404 into UNSUPPORTED, not a missing object", () => {
    const err = classifyAtcFailure(
      { err: 404, message: "not found" },
      { operation: "atc.run", uri: "/sap/bc/adt/atc/runs" },
    );
    expect(isAbapError(err)).toBe(true);
    expect(err.code).toBe("UNSUPPORTED");
    expect(err.hint).toMatch(/not available on every release/i);
  });

  it("explains that ATC has its own authorisations on a 403", () => {
    const err = classifyAtcFailure(
      { err: 403, message: "forbidden" },
      { operation: "atc.run", uri: "/sap/bc/adt/atc/runs", checkVariant: "ZDEFAULT" },
    );
    expect(err.code).toBe("ADT_ERROR");
    expect(err.hint).toMatch(/authorisation/i);
    expect(err.details.checkVariant).toBe("ZDEFAULT");
  });

  it("blames the check variant on a 400 when one was in play", () => {
    const err = classifyAtcFailure(
      { err: 400, message: "bad request" },
      { operation: "atc.run", uri: "/sap/bc/adt/atc/runs", checkVariant: "NOSUCH" },
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("NOSUCH");
  });

  it("leaves a 400 with no variant alone", () => {
    const err = classifyAtcFailure(
      { err: 400, message: "bad request" },
      { operation: "atc.run", uri: "/sap/bc/adt/atc/runs" },
    );
    expect(err.code).toBe("ADT_ERROR");
  });

  // Issue #78's gap: a live run of a large package against A4H with
  // `ABAP_TIMEOUT_MS=300000` genuinely exceeded the timeout and surfaced as
  // a generic, unclassified `ADT_ERROR` whose message was the raw axios text
  // ("timeout of 300000ms exceeded") with no hint at all. This is the
  // client-side shape axios actually throws for that: `ECONNABORTED`, no
  // `.err`/`.status` (no response ever arrived).
  it("names ABAP_TIMEOUT_MS and the surviving worklist on a transport timeout, not the generic unclassified ADT_ERROR", () => {
    const err = classifyAtcFailure(
      { code: "ECONNABORTED", message: "timeout of 300000ms exceeded" },
      {
        operation: "atc.run",
        uri: "/sap/bc/adt/atc/runs/0A1B2C",
        name: "$TMP",
        checkVariant: "ZDEFAULT",
        worklistId: "0A1B2C",
        timeoutMs: 300_000,
      },
    );
    expect(isAbapError(err)).toBe(true);
    expect(err.code).toBe("ADT_ERROR");
    expect(err.message).toContain("ABAP_TIMEOUT_MS=300000");
    expect(err.message).toContain("timeout of 300000ms exceeded");
    expect(err.hint).toMatch(/ABAP_TIMEOUT_MS/);
    expect(err.hint).toMatch(/worklist/i);
    expect(err.hint).toMatch(/narrow the scope|smaller package/i);
    expect(err.details.timeout).toBe(true);
    // Not marked terminal: ADT_ERROR's RETRYABILITY default is "conditional"
    // (no claim either way), which this site does not override — a
    // different scope or a raised timeout genuinely can succeed.
    expect(err.retryable).not.toBe(false);
  });

  it("falls back to a generic ABAP_TIMEOUT_MS mention when no timeoutMs was recorded on the context", () => {
    const err = classifyAtcFailure(
      { code: "ETIMEDOUT", message: "timeout of 60000ms exceeded" },
      { operation: "atc.worklist", uri: "/sap/bc/adt/atc/worklists/0A1B2C" },
    );
    expect(err.message).toContain("ABAP_TIMEOUT_MS");
    expect(err.message).not.toMatch(/ABAP_TIMEOUT_MS=\d/);
    expect(err.hint).toMatch(/ABAP_TIMEOUT_MS/);
  });
});

describe("cache hygiene", () => {
  beforeEach(() => {});

  it("clearAtcCaches forgets both the variant and the worklists", async () => {
    const { conn, calls } = fakeConn(happyHandler());
    await runAtcCheck(conn, { objectUris: [OBJECT_URI] }, [authorize()]);
    expect(knownAtcWorklists(conn)).toEqual(["0A1B2C"]);
    clearAtcCaches(conn);
    expect(knownAtcWorklists(conn)).toEqual([]);
    const before = calls.length;
    await runAtcCheck(conn, { objectUris: [OBJECT_URI] }, [authorize()]);
    // Customizing and the worklist creation both happen again.
    expect(calls.slice(before).map((c) => c.method)).toEqual([
      "GET",
      "POST",
      "POST",
      "GET",
      "GET",
    ]);
  });
});

describe("multi-object runs", () => {
  const PKG_1 = "/sap/bc/adt/packages/z_flight_ref_prep";
  const PKG_2 = "/sap/bc/adt/packages/z_upg_badi_impl";
  const WORKLIST_853 = "466F46C806601FE1ABD795A0C0B5C069";

  it("sends every URI in one run, byte-identical to capture 853, and reports the DISTINCT target count", async () => {
    // test/fixtures/live-captured/853-i78-run-two-packages.{xml,meta.json}: a
    // REAL A4H capture of a run over two package references. A third,
    // duplicate URI is added below to prove `targetCount` counts distinct
    // targets, not `request.objectUris.length` — the duplicate must not
    // appear twice in the body either, so the body stays byte-identical to
    // what the server actually accepted.
    const meta = readLiveMeta("853-i78-run-two-packages.meta.json");
    expect(meta.capturedBy).toMatch(/REAL wire recording/);
    const { conn, calls } = fakeConn((method, url) => {
      if (method === "GET" && url.startsWith(ATC_CUSTOMIZING_PATH)) {
        return { body: CUSTOMIZING };
      }
      if (method === "POST" && url.startsWith("/sap/bc/adt/atc/worklists")) {
        return { body: WORKLIST_853 };
      }
      if (method === "POST" && url.startsWith("/sap/bc/adt/atc/runs")) {
        return { body: readLiveFixture("853-i78-run-two-packages.xml") };
      }
      return { body: worklistDoc(WORKLIST_853, { findings: false }) };
    });

    const result = await runAtcCheck(
      conn,
      { objectUris: [PKG_1, PKG_2, PKG_1] },
      authorizeAll(["Z_FLIGHT_REF_PREP", "Z_UPG_BADI_IMPL"]),
    );

    const run = calls.find((c) => c.url.startsWith("/sap/bc/adt/atc/runs"));
    expect(run?.body).toBe(meta.requestBody as string);
    expect(run?.body).toContain(PKG_1);
    expect(run?.body).toContain(PKG_2);
    expect(result.targetCount).toBe(2);
    expect(result.worklistId).toBe(WORKLIST_853);
  });

  it("refuses an empty authorized list before any request is made", async () => {
    const { conn, calls } = fakeConn(happyHandler());
    const err = await runAtcCheck(conn, { objectUris: [OBJECT_URI] }, []).catch((e) => e);
    expect(isAbapError(err)).toBe(true);
    expect(err.code).toBe("BAD_INPUT");
    expect(calls).toHaveLength(0);
  });
});

describe("listCheckVariants", () => {
  it("GETs the quickSearch URL with the library's Accept and parses capture 852's 19 real variants", async () => {
    // test/fixtures/live-captured/852-i78-checkvariants-quicksearch.{xml,meta.json}.
    const meta = readLiveMeta("852-i78-checkvariants-quicksearch.meta.json");
    expect(meta.capturedBy).toMatch(/REAL wire recording/);
    const { conn, calls } = fakeConn((method, url) => {
      if (method === "GET" && url === buildCheckVariantSearchUrl()) {
        return { body: readLiveFixture("852-i78-checkvariants-quicksearch.xml") };
      }
      throw new Error(`unscripted request: ${method} ${url}`);
    });

    const variants = await listCheckVariants(conn);

    expect(variants).toHaveLength(19);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(meta.requestUrl as string);
    expect(calls[0]?.headers["Accept"]).toBe(ATC_CHECK_VARIANT_SEARCH_ACCEPT);
    expect(variants.map((v) => v.name)).toContain("ZABAP_CLOUD_DEVELOPMENT");
  });

  it("caches per connection — one HTTP call for repeated listing", async () => {
    const { conn, calls } = fakeConn(() => ({
      body: readLiveFixture("852-i78-checkvariants-quicksearch.xml"),
    }));
    await listCheckVariants(conn);
    await listCheckVariants(conn);
    expect(calls).toHaveLength(1);
  });

  it("clearAtcCaches forgets the check-variant list too", async () => {
    const { conn, calls } = fakeConn(() => ({
      body: readLiveFixture("852-i78-checkvariants-quicksearch.xml"),
    }));
    await listCheckVariants(conn);
    clearAtcCaches(conn);
    await listCheckVariants(conn);
    expect(calls).toHaveLength(2);
  });
});

describe("resolveCheckVariant", () => {
  /** Serves capture 852's real 19-variant list for every quickSearch GET. */
  const listHandler: Handler = (method, url) => {
    if (method === "GET" && url === buildCheckVariantSearchUrl()) {
      return { body: readLiveFixture("852-i78-checkvariants-quicksearch.xml") };
    }
    throw new Error(`unscripted request: ${method} ${url}`);
  };

  it("matches an exact name against capture 852's real list", async () => {
    const { conn } = fakeConn(listHandler);
    expect(await resolveCheckVariant(conn, "ZABAP_CLOUD_DEVELOPMENT")).toEqual({
      name: "ZABAP_CLOUD_DEVELOPMENT",
    });
  });

  it("matches case-insensitively and returns the SERVER'S OWN spelling", async () => {
    const { conn } = fakeConn(listHandler);
    expect(await resolveCheckVariant(conn, "zabap_cloud_development")).toEqual({
      name: "ZABAP_CLOUD_DEVELOPMENT",
    });
  });

  it("refuses an unknown name, naming both the requested and the available variants", async () => {
    const { conn } = fakeConn(listHandler);
    const err = await resolveCheckVariant(conn, "ZNO_SUCH_VARIANT").catch((e) => e);
    expect(isAbapError(err)).toBe(true);
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("ZNO_SUCH_VARIANT");
    expect(err.hint).toContain("ZABAP_CLOUD_DEVELOPMENT");
  });

  it("FAILS OPEN when the listing call itself fails — an unvalidated variant must not block the run", async () => {
    const { conn } = fakeConn(() => ({ throws: { err: 500, message: "boom" } }));
    const result = await resolveCheckVariant(conn, "ZSTRICT");
    expect(result.name).toBe("ZSTRICT");
    expect(result.unvalidatedReason).toBeDefined();
    expect(result.unvalidatedReason).toContain("ZSTRICT");
  });
});

describe("deleteAtcWorklist", () => {
  // Capture 857's own worklist id — reused here so the DELETE url matches
  // the recorded requestUrl exactly.
  const WORKLIST_857 = "466F46C806601FE1ABD7F225A1B94069";

  it("reports capture 857's real 405 refusal without throwing, and KEEPS the cached id", async () => {
    // test/fixtures/live-captured/857-i78-worklist-delete-405.{xml,meta.json}:
    // DELETE on a worklist answers 405 ExceptionMethodNotSupported on A4H.
    // See src/adt/atc.ts's module header for why this is the only observed
    // outcome and why `?action=deleteFindings` (capture 858, a no-op) is
    // never called as a substitute.
    const meta = readLiveMeta("857-i78-worklist-delete-405.meta.json");
    expect(meta.capturedBy).toMatch(/REAL wire recording/);
    const { conn, calls } = fakeConn((method, url) => {
      if (method === "POST" && url.startsWith("/sap/bc/adt/atc/worklists")) {
        return { body: WORKLIST_857 };
      }
      if (method === "DELETE") {
        // `AdtErrorException extends Error` (abap-adt-api/build/AdtException.js) —
        // mirrored here as `Object.assign(new Error(...), {...})`, the house
        // convention (see e.g. test/ddic.test.ts's `adtHttpError` helper), so
        // `adtExceptionInfo`'s `describeUnknownError` extracts `.message`
        // instead of falling back to a JSON dump of a plain object.
        return {
          status: 405,
          throws: Object.assign(
            new Error("Resource controller does not support method DELETE"),
            {
              err: 405,
              type: "ExceptionMethodNotSupported",
              properties: {
                "T100KEY-ID": "SADT_RESOURCE",
                "T100KEY-NO": "010",
                "T100KEY-V1": "DELETE",
              },
            },
          ),
        } as unknown as Reply;
      }
      throw new Error(`unscripted request: ${method} ${url}`);
    });

    await ensureAtcWorklist(conn, "ZDEFAULT"); // primes the cache with WORKLIST_857
    const before = calls.length;
    const result = await deleteAtcWorklist(conn, WORKLIST_857);

    expect(result).toEqual({
      worklistId: WORKLIST_857,
      deleted: false,
      status: 405,
      reason: "ExceptionMethodNotSupported: Resource controller does not support method DELETE",
      cacheCleared: false,
    });
    expect(calls.slice(before)).toHaveLength(1);
    expect(calls[before]?.method).toBe("DELETE");
    expect(calls[before]?.url).toBe(buildWorklistDeleteUrl(WORKLIST_857));
    expect(calls[before]?.url).toBe(meta.requestUrl as string);
    expect(calls[before]?.headers["Accept"]).toBe(ATC_WORKLIST_DELETE_ACCEPT);
    // The refusal must not evict the cached id — a later run reuses it
    // rather than littering a second undeletable worklist.
    expect(knownAtcWorklists(conn)).toEqual([WORKLIST_857]);
    // The documented no-op action (capture 858) must never be called instead.
    expect(calls.some((c) => c.url.includes("action=deleteFindings"))).toBe(false);
  });

  it("UNVERIFIED against A4H (whose DELETE always 405s — capture 857): a successful delete forgets the cached id", async () => {
    const WORKLIST_ID = "SUCCESSID1";
    const { conn } = fakeConn((method, url) => {
      if (method === "POST" && url.startsWith("/sap/bc/adt/atc/worklists")) {
        return { body: WORKLIST_ID };
      }
      if (method === "DELETE") return { body: "", status: 200 };
      throw new Error(`unscripted request: ${method} ${url}`);
    });

    await ensureAtcWorklist(conn, "ZDEFAULT");
    const result = await deleteAtcWorklist(conn, WORKLIST_ID);

    expect(result).toEqual({
      worklistId: WORKLIST_ID,
      deleted: true,
      status: 200,
      cacheCleared: true,
    });
    expect(knownAtcWorklists(conn)).toEqual([]);
  });

  it("refuses a malformed worklist id before any request is made", async () => {
    const { conn, calls } = fakeConn(() => {
      throw new Error("must not be called");
    });
    // Same validator, same error code, as `ensureAtcWorklist`'s "a body
    // that is a document rather than an id" case above — assertWorklistId
    // throws ADT_ERROR (a bad server response), not BAD_INPUT (bad caller
    // input), because the id being validated always comes from the server,
    // never straight from a caller argument.
    const err = await deleteAtcWorklist(conn, "not an id!").catch((e) => e);
    expect(isAbapError(err)).toBe(true);
    expect(err.code).toBe("ADT_ERROR");
    expect(calls).toHaveLength(0);
  });
});

describe("autoCleanup", () => {
  it("keeps the findings when cleanup is refused (A4H's real 405 — capture 857)", async () => {
    const { conn, calls } = fakeConn((method, url) => {
      if (method === "GET" && url.startsWith(ATC_CUSTOMIZING_PATH)) {
        return { body: CUSTOMIZING };
      }
      if (method === "POST" && url.startsWith("/sap/bc/adt/atc/worklists")) {
        return { body: "0A1B2C" };
      }
      if (method === "POST") return { body: runAck("0A1B2C") };
      if (method === "DELETE") {
        // See the `deleteAtcWorklist` 405 test above for why this must be a
        // real `Error` instance, not a plain object literal.
        return {
          throws: Object.assign(
            new Error("Resource controller does not support method DELETE"),
            { err: 405, type: "ExceptionMethodNotSupported" },
          ),
        };
      }
      return { body: worklistDoc("0A1B2C") };
    });

    const result = await runAtcCheck(
      conn,
      { objectUris: [OBJECT_URI], autoCleanup: true },
      [authorize()],
    );

    expect(result.findings).toHaveLength(2);
    expect(result.cleanup).toEqual({
      worklistId: "0A1B2C",
      deleted: false,
      status: 405,
      reason: "ExceptionMethodNotSupported: Resource controller does not support method DELETE",
      cacheCleared: false,
    });
    // Cleanup happens AFTER the reads, once, and only once.
    const deletes = calls.filter((c) => c.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(calls[calls.length - 1]?.method).toBe("DELETE");
  });

  it("does not attempt cleanup, and reports none, when autoCleanup is off", async () => {
    const { conn, calls } = fakeConn(happyHandler());
    const result = await runAtcCheck(conn, { objectUris: [OBJECT_URI] }, [authorize()]);
    expect(result.cleanup).toBeUndefined();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});

describe("expandPackageTree", () => {
  it("does no HTTP call and just normalises the name when includeSubpackages is absent", async () => {
    const { conn, calls } = fakeConn(() => {
      throw new Error("must not be called");
    });
    expect(await expandPackageTree(conn, " z_my_pkg ")).toEqual(["Z_MY_PKG"]);
    expect(calls).toHaveLength(0);
  });

  it("does no HTTP call when includeSubpackages is explicitly false", async () => {
    const { conn, calls } = fakeConn(() => {
      throw new Error("must not be called");
    });
    expect(
      await expandPackageTree(conn, "$TMP", { includeSubpackages: false }),
    ).toEqual(["$TMP"]);
    expect(calls).toHaveLength(0);
  });

  it(
    "UNVERIFIED against A4H (no customer package there has subpackages): walks a nested " +
      "tree breadth-first, root first, de-duped",
    async () => {
      // SYNTHETIC node-structure rows: ROOT has subpackages A and B (plus one
      // non-package row that must be filtered out); A has subpackage C.
      const nodesOf: Record<
        string,
        ReadonlyArray<{ OBJECT_TYPE: string; OBJECT_NAME: string }>
      > = {
        ROOT: [
          { OBJECT_TYPE: "DEVC/K", OBJECT_NAME: "A" },
          { OBJECT_TYPE: "DEVC/K", OBJECT_NAME: "B" },
          { OBJECT_TYPE: "CLAS/OC", OBJECT_NAME: "ZCL_NOT_A_PACKAGE" },
        ],
        A: [{ OBJECT_TYPE: "DEVC/K", OBJECT_NAME: "C" }],
        B: [],
        C: [],
      };
      const { conn, calls } = fakeConn((_method, url) => {
        const name = url.replace(/^nodeContents:/, "");
        return { body: JSON.stringify({ nodes: nodesOf[name] ?? [] }) };
      });

      const result = await expandPackageTree(conn, "root", { includeSubpackages: true });

      expect(result).toEqual(["ROOT", "A", "B", "C"]);
      expect(calls.filter((c) => c.url.startsWith("nodeContents:"))).toHaveLength(4);
    },
  );

  it("is cycle-guarded — a package that lists an ancestor again is not re-queued", async () => {
    const nodesOf: Record<string, ReadonlyArray<{ OBJECT_TYPE: string; OBJECT_NAME: string }>> = {
      ROOT: [{ OBJECT_TYPE: "DEVC/K", OBJECT_NAME: "A" }],
      A: [{ OBJECT_TYPE: "DEVC/K", OBJECT_NAME: "ROOT" }], // cyclic: points back at the root
    };
    const { conn, calls } = fakeConn((_method, url) => {
      const name = url.replace(/^nodeContents:/, "");
      return { body: JSON.stringify({ nodes: nodesOf[name] ?? [] }) };
    });

    const result = await expandPackageTree(conn, "ROOT", { includeSubpackages: true });

    expect(result).toEqual(["ROOT", "A"]);
    // Exactly two nodeContents calls (ROOT, A) — the cycle back to ROOT must
    // not cause a third call or an infinite loop.
    expect(calls.filter((c) => c.url.startsWith("nodeContents:"))).toHaveLength(2);
  });

  it(`refuses BAD_INPUT, naming the cap, when the tree exceeds ATC_MAX_PACKAGE_NODES (${ATC_MAX_PACKAGE_NODES})`, async () => {
    const many = Array.from({ length: ATC_MAX_PACKAGE_NODES + 5 }, (_, i) => ({
      OBJECT_TYPE: "DEVC/K",
      OBJECT_NAME: `CHILD${i}`,
    }));
    const { conn } = fakeConn((_method, url) => {
      const name = url.replace(/^nodeContents:/, "");
      return { body: JSON.stringify({ nodes: name === "ROOT" ? many : [] }) };
    });

    const err = await expandPackageTree(conn, "ROOT", { includeSubpackages: true }).catch(
      (e) => e,
    );
    expect(isAbapError(err)).toBe(true);
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain(String(ATC_MAX_PACKAGE_NODES));
  });

  it(`refuses BAD_INPUT, naming the cap, when the tree is deeper than ATC_MAX_PACKAGE_DEPTH (${ATC_MAX_PACKAGE_DEPTH})`, async () => {
    // A straight chain ROOT -> P0 -> P1 -> … a few levels past the cap.
    const chainLength = ATC_MAX_PACKAGE_DEPTH + 3;
    const chainNodes: Record<
      string,
      ReadonlyArray<{ OBJECT_TYPE: string; OBJECT_NAME: string }>
    > = {};
    let prev = "ROOT";
    for (let i = 0; i < chainLength; i += 1) {
      const child = `P${i}`;
      chainNodes[prev] = [{ OBJECT_TYPE: "DEVC/K", OBJECT_NAME: child }];
      prev = child;
    }
    chainNodes[prev] = [];
    const { conn } = fakeConn((_method, url) => {
      const name = url.replace(/^nodeContents:/, "");
      return { body: JSON.stringify({ nodes: chainNodes[name] ?? [] }) };
    });

    const err = await expandPackageTree(conn, "ROOT", { includeSubpackages: true }).catch(
      (e) => e,
    );
    expect(isAbapError(err)).toBe(true);
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain(String(ATC_MAX_PACKAGE_DEPTH));
  });
});
