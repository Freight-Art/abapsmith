/**
 * `src/adt/atc.ts` — the ADT I/O layer for ATC (ABAP Test Cockpit) runs.
 *
 * ## Everything in this file is SYNTHETIC. Read this before trusting it.
 *
 * Unlike `test/dumps.test.ts`, which replays bytes captured off A4H together
 * with the `.meta.json` sidecar that says what was actually sent, **nothing
 * here was recorded from a real system.** There are no ATC captures in this
 * repo, none in `abap-adt-api`'s `restcalls/*.http` recordings, and that
 * package's own ATC tests are live-only with no stored XML. So the documents
 * below are hand-written doubles, and the URLs and headers asserted below are
 * this client's own intentions read back to it.
 *
 * That makes this file a test of the LIFECYCLE, not of the protocol. It proves:
 *
 *   - the four requests happen in the right order, with the right verbs;
 *   - a worklist is created ONCE per (connection, variant) and then reused,
 *     which is the whole litter-control design;
 *   - the second worklist GET is scoped to the `LAST_RUN` object set, and when
 *     the server names no such set the result says `scopedToLastRun: false`
 *     instead of quietly presenting an accumulated worklist as one run;
 *   - a stale cached worklist id triggers exactly one retry;
 *   - failures are classified with ATC-specific hints.
 *
 * It proves nothing about whether SAP's ATC actually speaks this dialect. What
 * a live run must confirm is listed in `doc/TOOLS/abap-atc.md`.
 *
 * The transport is the house fake (`test/dumps.test.ts:98`,
 * `test/data-preview.test.ts`): a plain object cast through `unknown`, which
 * records every call so a test can assert on the ABSENCE of a request as well
 * as on its arguments.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import { isAbapError } from "../src/adt/errors.js";
import {
  ATC_CUSTOMIZING_ACCEPT,
  ATC_CUSTOMIZING_PATH,
  ATC_RUN_ACCEPT,
  ATC_RUN_CONTENT_TYPE,
  ATC_WORKLIST_ACCEPT,
  ATC_WORKLIST_CREATE_ACCEPT,
  buildAtcRunBody,
} from "../src/adt/atc-query.js";
import {
  classifyAtcFailure,
  clearAtcCaches,
  ensureAtcWorklist,
  fetchDefaultCheckVariant,
  knownAtcWorklists,
  runAtcCheck,
} from "../src/adt/atc.js";
import { SafetyGate, type AuthorizedTarget } from "../src/safety.js";

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
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
}

type Reply = { body: string; status?: number } | { throws: unknown };
type Handler = (method: "GET" | "POST", url: string) => Reply;

function fakeConn(handler: Handler): { conn: AbapConnection; calls: Call[] } {
  const calls: Call[] = [];
  const dispatch = (method: "GET" | "POST") => {
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
    get: dispatch("GET"),
    post: dispatch("POST"),
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
    const result = await runAtcCheck(conn, { objectUri: OBJECT_URI }, authorize());

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
    await runAtcCheck(conn, { objectUri: OBJECT_URI, maxVerdicts: 42 }, authorize());
    const run = calls.find((c) => c.url.startsWith("/sap/bc/adt/atc/runs"));
    expect(run?.url).toBe("/sap/bc/adt/atc/runs?worklistId=0A1B2C");
    expect(run?.headers["Accept"]).toBe(ATC_RUN_ACCEPT);
    expect(run?.headers["Content-Type"]).toBe(ATC_RUN_CONTENT_TYPE);
    expect(run?.body).toBe(buildAtcRunBody(OBJECT_URI, 42));
  });

  it("scopes the SECOND worklist read to the LAST_RUN object set", async () => {
    const { conn, calls } = fakeConn(happyHandler());
    await runAtcCheck(conn, { objectUri: OBJECT_URI }, authorize());
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
      { objectUri: OBJECT_URI, includeExempted: true },
      authorize(),
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
    const result = await runAtcCheck(conn, { objectUri: OBJECT_URI }, authorize());
    expect(result.scopedToLastRun).toBe(false);
    // Only ONE read: there is no second scope to re-read with.
    expect(
      calls.filter((c) => c.method === "GET" && c.url.includes("/worklists/")),
    ).toHaveLength(1);
  });

  it("sorts findings most severe first and counts them", async () => {
    const { conn } = fakeConn(happyHandler());
    const result = await runAtcCheck(conn, { objectUri: OBJECT_URI }, authorize());
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
    await runAtcCheck(conn, { objectUri: OBJECT_URI }, authorize());
    const after = calls.length;
    const second = await runAtcCheck(conn, { objectUri: OBJECT_URI }, authorize());
    expect(second.worklistReused).toBe(true);
    // Second run: run + two reads. No customizing, no worklist creation.
    expect(calls.slice(after).map((c) => c.method)).toEqual(["POST", "GET", "GET"]);
    expect(
      calls.filter((c) => c.method === "POST" && c.url.includes("/worklists")),
    ).toHaveLength(1);
  });

  it("uses the caller's variant and then skips customizing entirely", async () => {
    const { conn, calls } = fakeConn((method, url) => {
      if (url.startsWith(ATC_CUSTOMIZING_PATH)) {
        throw new Error("customizing must not be read when a variant was named");
      }
      if (method === "POST" && url.startsWith("/sap/bc/adt/atc/worklists")) {
        return { body: "0A1B2C" };
      }
      if (method === "POST") return { body: runAck("0A1B2C") };
      return { body: worklistDoc("0A1B2C") };
    });
    const result = await runAtcCheck(
      conn,
      { objectUri: OBJECT_URI, checkVariant: "ZSTRICT" },
      authorize(),
    );
    expect(result.checkVariant).toBe("ZSTRICT");
    expect(calls[0]?.url).toBe("/sap/bc/adt/atc/worklists?checkVariant=ZSTRICT");
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
    const result = await runAtcCheck(conn, { objectUri: OBJECT_URI }, authorize());
    expect(result.worklistId).toBe("ECHOED");
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
    const result = await runAtcCheck(conn, { objectUri: OBJECT_URI }, authorize());
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
      runAtcCheck(conn, { objectUri: OBJECT_URI }, authorize()),
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
});

describe("cache hygiene", () => {
  beforeEach(() => {});

  it("clearAtcCaches forgets both the variant and the worklists", async () => {
    const { conn, calls } = fakeConn(happyHandler());
    await runAtcCheck(conn, { objectUri: OBJECT_URI }, authorize());
    expect(knownAtcWorklists(conn)).toEqual(["0A1B2C"]);
    clearAtcCaches(conn);
    expect(knownAtcWorklists(conn)).toEqual([]);
    const before = calls.length;
    await runAtcCheck(conn, { objectUri: OBJECT_URI }, authorize());
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
