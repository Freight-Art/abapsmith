/**
 * Execution path — `classrun`, the report bridge, and the two traps
 * that this whole module exists to neutralise.
 *
 * Offline only. The transport is faked through `ConnectionOptions.httpClient`
 * (same seam as test/circuit-breaker.test.ts) — nothing here touches SAP.
 */
import { describe, expect, it } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { HttpClientException } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { SafetyGate } from "../src/safety.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { isAbapError } from "../src/adt/errors.js";
import { DUMP_SHORT_TEXT_MAX, TRUNCATION_MARKER_PATTERN } from "../src/truncate.js";
import {
  bridgeClassName,
  bridgeClassSource,
  buildDumpCorrelation,
  ERR_LINE_PREFIX,
  runClass,
  runReport,
  splitBridgeOutput,
  stripListHeader,
  tidyShortText,
  WIDTH_TRUNCATION_MARKER,
} from "../src/adt/run.js";
import { validateFqlQuery } from "../src/adt/dumps-query.js";
import { DATA_PREVIEW_PATH, DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "secret",
    sid: "TST",
  });

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
  statusText = String(status),
): HttpClientResponse =>
  ({ status, statusText, body, headers }) as unknown as HttpClientResponse;

class RecordingClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(private readonly respond: (o: HttpClientOptions) => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    const r = this.respond(o);
    // The real (axios) transport throws on >= 400 and carries the response on
    // the exception. `classrunThrows` fixtures opt into that shape.
    return r;
  }
}

/** `login()` and `dropSession()` both hit this URL — see abap-adt-api AdtHTTP. */
const SESSION_URL = "/sap/bc/adt/compatibility/graph";
const CLASSRUN = "/sap/bc/adt/oo/classrun/";

/** A responder that serves logon/discovery and delegates the classrun POST. */
const responder =
  (classrun: (o: HttpClientOptions) => HttpClientResponse) =>
  (o: HttpClientOptions): HttpClientResponse => {
    if (o.url.startsWith(CLASSRUN)) return classrun(o);
    if (o.url.includes(SESSION_URL)) {
      return resp(200, "<graph/>", {
        "content-type": "application/xml",
        "x-csrf-token": "TOKEN123",
      });
    }
    return resp(200, "<ok/>", { "content-type": "application/xml" });
  };

async function connected(
  classrun: (o: HttpClientOptions) => HttpClientResponse,
): Promise<{ conn: AbapConnection; inner: RecordingClient }> {
  const inner = new RecordingClient(responder(classrun));
  const conn = new AbapConnection(cfg(), {
    httpClient: inner,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  inner.calls.length = 0; // only look at what the run itself does
  return { conn, inner };
}

// ---------------------------------------------------------------------------
// Fixtures straight out of live write-reconnaissance captures
// ---------------------------------------------------------------------------

/**
 * VERBATIM captured classrun output of the verified bridge driver, including
 * the `LIST>` prefix the driver adds. Trailing spaces added on the list lines
 * to model `LIST_TO_ASCI`'s right-padding to the list width.
 */
const CAPTURED_LIST_OUTPUT =
  "LIST> 31.07.2026                   MCP write recon probe report                          1  \n" +
  "LIST> ------------------------------------------------------------------------------------\n" +
  "LIST> ZMCP probe line 1                                                                   \n" +
  "LIST> ZMCP probe line 2                                                                   \n" +
  "LIST> DEVELOPER    31.07.2026                                                             \n";

/**
 * ⚠️ HAND-MODELLED, NOT A WIRE CAPTURE ⚠️ Stand-in for the ~10 KB ICM
 * "Application Server Error" page, built to the *classic* ICF
 * error-page shape (`<p>Error: … (termination: RABAX_STATE)</p>`).
 *
 * There IS a real, live-captured `500 text/html` "Application Server Error"
 * page at test/fixtures/live-captured/016-trigger-classrun.xml (and its
 * superseded sibling test/fixtures/live-captured/_run1-accept-bug/016-…xml,
 * see that dir's own note) — but per its .meta.json / INDEX.md item 14, that
 * capture is from a classrun POST hitting a *breakpoint-suspended debuggee*,
 * and its body reads `<span id="msgText">Communication failure</span>`, not
 * an ABAP exception short text. It proves the "500 text/html, not XML" shape
 * of the trap this module guards against, but it is NOT evidence for the
 * `Error: … (termination: RABAX_STATE)` markup below — do not mistake one
 * for validating the other. If the real RABAX short-dump body is ever
 * captured, replace this fixture verbatim; extraction itself lives in
 * src/adt/session.ts.
 *
 * The `Server time` block below, unlike the rest of this fixture, IS modelled
 * on real bytes: test/fixtures/live-captured/701-…706-… (six genuine RABAX
 * ICF pages) all render a client-side `var d`/`var t` script rather than a
 * pre-composed string — see `extractDumpServerTime`.
 */
const dumpPage = (shortText = "Division by zero"): string =>
  `<!DOCTYPE html><html><head><title>Application Server Error</title>
<style type="text/css">${"body{font-family:Arial;} .err{color:#c00;} ".repeat(400)}</style>
</head><body>
<div class="err"><h1>500 Internal Server Error</h1>
<p>Error: ${shortText} (termination: RABAX_STATE)</p>
<p class="detailText"><span id="msgText">Server time:
<script>
var d = "20260731";
var t = "130257";
document.write(d.slice(0,4)+"-"+d.slice(4,6)+"-"+d.slice(6,8)+" "+t.slice(0,2)+":"+t.slice(2,4)+":"+t.slice(4,6));
</script>
</span></p>
<p>What has happened? The URL http://sapa4h:50000/sap/bc/adt/oo/classrun/ZCL_ZMCP_PROBE
was not called due to an error.</p>
<p>Please contact your system administrator.</p>
</div></body></html>`;

/**
 * ⚠️ HAND-MODELLED, NOT A WIRE CAPTURE ⚠️ The 400 page every request on the
 * dead cookies gets afterwards. No live capture of this exact page
 * exists in test/fixtures/live-captured/ (checked: no "Session Timed Out"
 * hit anywhere under that tree) — this is a plausible reconstruction from the
 * recon notes only, not bytes off the wire.
 */
const SESSION_TIMEOUT_PAGE =
  `<!DOCTYPE html><html><head><title>Session Timed Out</title></head><body>` +
  `<h1>400 Session Timed Out</h1><p>Session no longer exists</p>` +
  `${"<p>&nbsp;</p>".repeat(200)}</body></html>`;

// ---------------------------------------------------------------------------

describe("tidyShortText", () => {
  it("leaves a normal short text untouched", () => {
    expect(tidyShortText("Error: Division by zero (termination: RABAX_STATE)")).toBe("Division by zero");
  });

  it("marks an oversized short text as truncated instead of cutting it silently", () => {
    const longText = "Divide by zero in program ZMCP_PROBE ".repeat(10).trim(); // > 200 chars, normalised
    const result = tidyShortText(longText);

    expect(result.length).toBeGreaterThan(DUMP_SHORT_TEXT_MAX);
    expect(result).toMatch(TRUNCATION_MARKER_PATTERN);
    expect(result.startsWith(longText.slice(0, DUMP_SHORT_TEXT_MAX))).toBe(true);
  });
});

describe("stripListHeader", () => {
  it("turns the verbatim captured list into exactly the report's three lines", () => {
    const { list, diagnostics } = splitBridgeOutput(CAPTURED_LIST_OUTPUT);
    expect(diagnostics).toEqual([]);
    expect(list).toHaveLength(5);

    expect(stripListHeader(list)).toEqual([
      "ZMCP probe line 1",
      "ZMCP probe line 2",
      "DEVELOPER    31.07.2026",
    ]);
  });

  it("right-trims the list-width padding but keeps leading column alignment", () => {
    expect(
      stripListHeader([
        "01.01.2026   Report   1",
        "-".repeat(40),
        "    indented value      ",
      ]),
    ).toEqual(["    indented value"]);
  });

  it("does NOT strip a report's own text-then-rule (false-positive guard, F2)", () => {
    // Both tests above feed input already shaped exactly like the header the
    // function is built to strip, which only proves it strips what it was
    // built to strip. The real bug this guards against: a report whose own
    // first line is ordinary text (no date, no trailing page number),
    // followed by its own >=20-dash rule, must survive intact — it is not a
    // LIST_TO_ASCI page header just because it happens to look like one.
    expect(stripListHeader(["Total: 5", "-".repeat(40), "x"])).toEqual([
      "Total: 5",
      "-".repeat(40),
      "x",
    ]);
  });

  it("does NOT strip a line that merely quotes a date (false-positive guard, F6)", () => {
    // The other half of the same bug. The header test used to be
    // `date-anywhere OR trailing-page-number`, so EITHER signal alone was
    // enough to drop two lines. `Total: 5` above reproduces the page-number
    // half; this reproduces the date half — an ordinary report line that
    // happens to quote a date, followed by the report's own rule. A genuine
    // standard page heading is `<sy-datum at the left> <title> <page no. at
    // the right>` and carries both signals, so requiring both keeps every
    // real header (see the two tests above) while neither of these survives
    // as a match.
    expect(stripListHeader(["Posting date 01.01.2026", "-".repeat(40), "x"])).toEqual([
      "Posting date 01.01.2026",
      "-".repeat(40),
      "x",
    ]);
    // …and a date at the left edge is still not enough on its own.
    expect(stripListHeader(["01.01.2026 opening balance", "-".repeat(40), "x"])).toEqual([
      "01.01.2026 opening balance",
      "-".repeat(40),
      "x",
    ]);
  });

  it("does not eat output that is not a classic list", () => {
    expect(stripListHeader(["just one line"])).toEqual(["just one line"]);
    expect(stripListHeader(["hello", "world"])).toEqual(["hello", "world"]);
    // A genuine 20+-dash rule line alone is still not enough: line 0 also has
    // to look like a page header (date / trailing page number), or nothing is
    // stripped. This exercises isRuleLine for real, unlike a 2-dash string
    // that could never satisfy it in the first place.
    expect(stripListHeader(["a", "-".repeat(40), "b"])).toEqual(["a", "-".repeat(40), "b"]);
    // A rule that is not on line 2 is the program's own output.
    expect(stripListHeader(["a", "b", "-".repeat(40)])).toEqual(["a", "b", "-".repeat(40)]);
    // Header-shaped but with an empty first line ⇒ leave it alone.
    expect(stripListHeader(["", "-".repeat(40), "x"])).toEqual(["", "-".repeat(40), "x"]);
    expect(stripListHeader([])).toEqual([]);
  });

  it("drops only trailing blank padding lines, never internal ones", () => {
    expect(stripListHeader(["a", "", "b", "   ", ""])).toEqual(["a", "", "b"]);
  });
});

describe("splitBridgeOutput", () => {
  it("separates driver diagnostics from captured list lines, distinguishably from a genuinely empty run", () => {
    const failure = splitBridgeOutput(
      "ZMCP-ERR> LIST_FROM_MEMORY sy-subrc = 1 (1 = no list in ABAP memory)",
    );
    expect(failure.list).toEqual([]);
    expect(failure.diagnostics).toEqual([
      "ZMCP-ERR> LIST_FROM_MEMORY sy-subrc = 1 (1 = no list in ABAP memory)",
    ]);

    // A driver failure and a genuinely empty successful run (report printed
    // nothing, nothing went wrong) both have list: [] — that alone is not
    // enough for a caller to tell them apart. diagnostics is what carries the
    // distinction, so the two result objects must not be byte-identical.
    const emptySuccess = splitBridgeOutput("");
    expect(emptySuccess.list).toEqual([]);
    expect(emptySuccess.diagnostics).toEqual([]);
    expect(failure.diagnostics.length).toBeGreaterThan(0);
    expect(emptySuccess).not.toEqual(failure);
  });

  it("keeps an empty list line as an empty line", () => {
    expect(splitBridgeOutput("LIST> a\nLIST> \nLIST> b").list).toEqual(["a", "", "b"]);
  });
});

describe("bridgeClassName", () => {
  it("is deterministic, customer-namespace and within the 30-char limit", () => {
    for (const report of [
      "ZMCP_PROBE_REP",
      "Z_SHORT",
      "ZREPORT_WITH_A_VERY_LONG_NAME_X",
      "/DMO/FLIGHT_REPORT",
      "RSUSR002",
    ]) {
      const name = bridgeClassName(report);
      expect(name).toBe(bridgeClassName(report));
      expect(name.length).toBeLessThanOrEqual(30);
      expect(name.startsWith("Z")).toBe(true);
      expect(name).toMatch(/^[A-Z0-9_]+$/);
    }
  });

  it("is case-insensitive on the report name", () => {
    expect(bridgeClassName("zmcp_probe_rep")).toBe(bridgeClassName("ZMCP_PROBE_REP"));
  });

  it("keeps the readable prefix for short names", () => {
    expect(bridgeClassName("ZMCP_PROBE_REP")).toBe("ZCL_ZMCP_RUN_ZMCP_PROBE_REP");
  });

  it("stays collision-safe for long names sharing a prefix", () => {
    const a = bridgeClassName("ZMCP_VERY_LONG_REPORT_NAME_AAA");
    const b = bridgeClassName("ZMCP_VERY_LONG_REPORT_NAME_BBB");
    expect(a).not.toBe(b);
    expect(a.length).toBe(30);
    expect(b.length).toBe(30);
  });

  it("disambiguates namespaced names from their sanitised twins", () => {
    expect(bridgeClassName("/DMO/FLIGHT")).not.toBe(bridgeClassName("_DMO_FLIGHT"));
  });

  it("rejects anything that is not a plain repository name", () => {
    expect(() => bridgeClassName("ZFOO. DELETE FROM t")).toThrowError(/not a valid ABAP object name/);
    expect(() => bridgeClassName("")).toThrowError(/not a valid ABAP object name/);
  });
});

describe("bridgeClassSource", () => {
  const cls = bridgeClassName("ZMCP_PROBE_REP");
  const src = bridgeClassSource(cls, "ZMCP_PROBE_REP");

  it("is byte-stable across calls (the write path hashes it to skip the PUT)", () => {
    expect(bridgeClassSource(cls, "ZMCP_PROBE_REP")).toBe(src);
    // …and independent of the case the caller used.
    expect(bridgeClassSource(cls.toLowerCase(), "zmcp_probe_rep")).toBe(src);
  });

  it("carries the verified SUBMIT / LIST_FROM_MEMORY / LIST_TO_ASCI driver", () => {
    expect(src).toContain("INTERFACES if_oo_adt_classrun.");
    expect(src).toContain("METHOD if_oo_adt_classrun~main.");
    expect(src).toContain("DATA: lt_list TYPE TABLE OF abaplist,");
    // Safety property, not a literal type name: the capture line must be wider
    // than the old 255-char cut that silently truncated every wider list line,
    // AND any residual cut at whatever the new width is must be disclosed via
    // a ZMCP-ERR> diagnostic rather than dropped without a trace.
    const captureWidth = Number(src.match(/ty_txt_line TYPE c LENGTH (\d+)/)?.[1]);
    expect(captureWidth).toBeGreaterThan(255);
    expect(src).toContain(`IF strlen( lv_line ) >= ${captureWidth}.`);
    expect(src).toContain(`${ERR_LINE_PREFIX}list line hit the ${captureWidth}-char ${WIDTH_TRUNCATION_MARKER}`);
    expect(src).toContain("SUBMIT zmcp_probe_rep AND RETURN EXPORTING LIST TO MEMORY.");
    expect(src).toContain("CALL FUNCTION 'LIST_FROM_MEMORY'");
    expect(src).toContain("CALL FUNCTION 'LIST_TO_ASCI'");
    expect(src).toContain("list_index         = -1");
    expect(src).toContain("LOOP AT lt_txt INTO DATA(lv_line).");
    expect(src).toContain("out->write( |LIST> { lv_line }| ).");
    expect(src.trimEnd().endsWith("ENDCLASS.")).toBe(true);
  });

  it("refuses to embed anything that is not a plain name (ABAP injection)", () => {
    expect(() => bridgeClassSource(cls, "ZFOO. LEAVE PROGRAM")).toThrowError(
      /not a valid ABAP object name/,
    );
  });

  it("with an empty rows array is byte-identical to the 2-arg call (no-parameters path)", () => {
    // This is the property that keeps the content-hash PUT-skip optimisation
    // working for every caller that never supplies selection-screen values —
    // it must never regress silently when the parameterised path is added to.
    expect(bridgeClassSource(cls, "ZMCP_PROBE_REP", [])).toBe(src);
  });

  it("embeds a populated rsparams selection table and swaps to SUBMIT ... WITH SELECTION-TABLE", () => {
    const withRows = bridgeClassSource(cls, "ZMCP_PROBE_REP", [
      { selname: "P_STR", kind: "P", sign: "I", option: "EQ", low: "hello", high: "" },
      { selname: "S_ID", kind: "S", sign: "I", option: "BT", low: "A", high: "Z" },
    ]);
    expect(withRows).toContain("DATA: lt_seltab TYPE STANDARD TABLE OF rsparams,");
    expect(withRows).toContain("ls_seltab TYPE rsparams.");
    expect(withRows).toContain("ls_seltab-selname = 'P_STR'.");
    expect(withRows).toContain("ls_seltab-kind    = 'P'.");
    expect(withRows).toContain("ls_seltab-low     = 'hello'.");
    expect(withRows).toContain("ls_seltab-selname = 'S_ID'.");
    expect(withRows).toContain("ls_seltab-option  = 'BT'.");
    expect(withRows).toContain("ls_seltab-high    = 'Z'.");
    expect(withRows).toContain("APPEND ls_seltab TO lt_seltab.");
    expect(withRows).toContain(
      "SUBMIT zmcp_probe_rep WITH SELECTION-TABLE lt_seltab AND RETURN EXPORTING LIST TO MEMORY.",
    );
    // The plain (no selection-table) SUBMIT must be gone, not merely present
    // alongside the new one.
    expect(withRows).not.toContain("SUBMIT zmcp_probe_rep AND RETURN EXPORTING LIST TO MEMORY.");
    // Everything downstream of SUBMIT (capture driver) is untouched.
    expect(withRows).toContain("CALL FUNCTION 'LIST_FROM_MEMORY'");
    expect(withRows).toContain("CALL FUNCTION 'LIST_TO_ASCI'");
  });

  it("escapes an embedded single quote in a row value (ABAP literal injection defence)", () => {
    const withRows = bridgeClassSource(cls, "ZMCP_PROBE_REP", [
      { selname: "P_STR", kind: "P", sign: "I", option: "EQ", low: "it's", high: "" },
    ]);
    // Single-quote doubling, the standard ABAP literal escape — never a bare
    // unescaped quote, which would break out of the literal into live ABAP.
    expect(withRows).toContain("ls_seltab-low     = 'it''s'.");
  });
});

describe("runClass", () => {
  it("POSTs the uppercase class name to /oo/classrun and returns the raw output", async () => {
    const { conn, inner } = await connected(() =>
      resp(200, "ZMCP classrun line 1\nZMCP classrun line 2\n", { "content-type": "text/plain" }),
    );

    const result = await runClass(conn, "zcl_zmcp_probe");

    expect(result.mode).toBe("class");
    expect(result.object).toBe("ZCL_ZMCP_PROBE");
    expect(result.output).toBe("ZMCP classrun line 1\nZMCP classrun line 2");
    expect(result.lines).toBe(2);

    const post = inner.calls.find((c) => c.url.startsWith(CLASSRUN))!;
    expect(post.url).toBe("/sap/bc/adt/oo/classrun/ZCL_ZMCP_PROBE");
    expect(post.method).toBe("POST");
    expect(post.body).toBeUndefined();
  });

  /**
   * ⭐ THE REGRESSION TEST FOR THE BUG THAT MAKES THIS FEATURE LIE.
   *
   * classrun runs the *stale* class inside a live session.
   * Every execution must therefore be preceded by a session drop / fresh logon.
   * Both `AdtHTTP.dropSession()` and `AdtHTTP.login()` are requests to
   * `/sap/bc/adt/compatibility/graph`, so that URL appearing before the
   * classrun POST is the wire-level proof that the session was re-established
   * — whichever of the two mechanisms the connection layer uses.
   */
  it("drops the session BEFORE executing (stale-code trap)", async () => {
    const { conn, inner } = await connected(() =>
      resp(200, "output\n", { "content-type": "text/plain" }),
    );

    await runClass(conn, "ZCL_ZMCP_PROBE");

    const urls = inner.calls.map((c) => c.url);
    const runIdx = urls.findIndex((u) => u.startsWith(CLASSRUN));
    expect(runIdx).toBeGreaterThan(0);
    expect(urls.slice(0, runIdx).some((u) => u.includes(SESSION_URL))).toBe(true);

    // …and again on the second run: freshness is unconditional, never cached.
    inner.calls.length = 0;
    await runClass(conn, "ZCL_ZMCP_PROBE");
    const urls2 = inner.calls.map((c) => c.url);
    const runIdx2 = urls2.findIndex((u) => u.startsWith(CLASSRUN));
    expect(urls2.slice(0, runIdx2).some((u) => u.includes(SESSION_URL))).toBe(true);
  });

  it("turns a 500 text/html short dump into RUNTIME_DUMP without tripping the breaker", async () => {
    const { conn } = await connected(() =>
      resp(500, dumpPage(), { "content-type": "text/html; charset=utf-8", connection: "close" }),
    );

    const err = await runClass(conn, "ZCL_ZMCP_PROBE").catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    if (!isAbapError(err)) return;
    expect(err.code).toBe("RUNTIME_DUMP");
    expect(err.details.shortText).toBe("Division by zero");
    expect(err.details.serverTime).toBe("2026-07-31 13:02:57");
    expect(err.message).toContain("Division by zero");

    // No HTML, no 10 KB page, ever reaches the model.
    expect(err.message).not.toMatch(/[<>]/);
    expect(err.message.length).toBeLessThan(300);
    expect(JSON.stringify(err.toJSON())).not.toMatch(/DOCTYPE|font-family/);

    // A user's syntax mistake must never brick the server.
    expect(conn.breaker.isTripped).toBe(false);
    // Still the raw feed path, once: under ABAP_TOOL_SURFACE=v2 `abap_dumps`
    // is not registered, so this is the only true instruction there.
    expect(err.hint).toMatch(/\/sap\/bc\/adt\/runtime\/dumps/);

    // The old "no tool for that lookup" claim was falsified by the addition
    // of `abap_dumps`; the hint now hands over the computed lookup instead.
    expect(err.hint).not.toMatch(/does not yet expose a tool/);
    expect(err.hint).toContain("abap_dumps");
    // The literal window `dumpPage()`'s 2026-07-31 13:02:57 implies, ±2 s.
    expect(err.hint).toContain('"from":"20260731130255"');
    expect(err.hint).toContain('"to":"20260731130259"');
    // This exact phrasing is mandated verbatim.
    expect(err.hint).toContain("Any output written before the dump is lost.");
    // Candidates, never "this is your dump" — a false positive here would
    // point someone at the wrong dump.
    expect(err.hint).toMatch(/candidate/i);
    expect(err.hint!.length).toBeLessThanOrEqual(550);
    expect(err.hint!.length).toBeGreaterThanOrEqual(100);
  });

  // Integration level: the same window the hint prints must also reach
  // `details` in machine-readable form, so a v2 surface or an orchestrator can
  // consume it without regex-scraping prose.
  it("attaches a machine-readable dump correlation to details", async () => {
    const { conn } = await connected(() =>
      resp(500, dumpPage(), { "content-type": "text/html; charset=utf-8", connection: "close" }),
    );

    const err = await runClass(conn, "ZCL_ZMCP_PROBE").catch((e: unknown) => e);
    if (!isAbapError(err)) throw new Error("expected an AbapError");

    // The four pre-existing keys are untouched.
    expect(err.details.class).toBe("ZCL_ZMCP_PROBE");
    expect(err.details.shortText).toBe("Division by zero");
    expect(err.details.serverTime).toBe("2026-07-31 13:02:57");
    expect(err.details.status).toBe(500);

    expect(err.details.dumpCorrelation).toEqual({
      from: "20260731130255",
      to: "20260731130259",
      user: "TESTUSER",
      query: "and ( equals ( user , TESTUSER ) )",
      feedPath: "/sap/bc/adt/runtime/dumps",
      call: {
        tool: "abap_dumps",
        arguments: {
          mode: "list",
          from: "20260731130255",
          to: "20260731130259",
          query: "and ( equals ( user , TESTUSER ) )",
        },
      },
      confidence: "candidates",
    });

    // Never a bare HTML page, never a dump key this page does not carry.
    expect(JSON.stringify(err.toJSON())).not.toMatch(/DOCTYPE|font-family/);
  });

  it("falls back to placeholders, not invented digits, when the page has no server time", async () => {
    // Strip the `var d`/`var t` block — some ICF pages may not carry it, and a
    // hint that made up a window would be authoritative and wrong.
    const noTime = dumpPage().replace(/<script>[\s\S]*?<\/script>/, "");
    const { conn } = await connected(() =>
      resp(500, noTime, { "content-type": "text/html; charset=utf-8", connection: "close" }),
    );

    const err = await runClass(conn, "ZCL_ZMCP_PROBE").catch((e: unknown) => e);
    if (!isAbapError(err)) throw new Error("expected an AbapError");

    expect(err.details.serverTime).toBeUndefined();
    expect(err.details.dumpCorrelation).toBeUndefined();
    expect(err.hint).toContain("no server time");
    expect(err.hint).toContain("abap_dumps");
    expect(err.hint).toContain("[YYYYMMDDHHMMSS just before this call]");
    // No 14-digit literal anywhere: nothing was invented.
    expect(err.hint).not.toMatch(/\d{14}/);
    expect(err.hint).toContain("Any output written before the dump is lost.");
    expect(err.hint).toMatch(/\/sap\/bc\/adt\/runtime\/dumps/);
    expect(err.hint!.length).toBeLessThanOrEqual(550);
  });

  it("classifies the dump the same way when the transport throws (axios shape)", async () => {
    const inner = new RecordingClient(responder(() => resp(200, "unused")));
    const throwing: HttpClient = {
      request: async (o) => {
        if (o.url.startsWith(CLASSRUN)) {
          const r = resp(500, dumpPage("Field symbol has not yet been assigned"), {
            "content-type": "text/html; charset=utf-8",
          });
          throw new HttpClientException("Request failed with status code 500", "500", 500, undefined, o, r);
        }
        return inner.request(o);
      },
    };
    const conn = new AbapConnection(cfg(), {
      httpClient: throwing,
      log: () => {},
      breaker: new AuthCircuitBreaker(),
    });
    await conn.connect();

    const err = await runClass(conn, "ZCL_ZMCP_PROBE").catch((e: unknown) => e);
    expect(isAbapError(err) && err.code).toBe("RUNTIME_DUMP");
    expect(isAbapError(err) && err.details.shortText).toBe("Field symbol has not yet been assigned");
    expect(conn.breaker.isTripped).toBe(false);
  });

  it("classifies '400 Session Timed Out' as session death, not an auth failure", async () => {
    const { conn } = await connected(() =>
      resp(400, SESSION_TIMEOUT_PAGE, { "content-type": "text/html" }, "Bad Request"),
    );

    const err = await runClass(conn, "ZCL_ZMCP_PROBE").catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    if (!isAbapError(err)) return;
    expect(err.code).toBe("SESSION_DEAD");
    expect(err.code).not.toBe("AUTH_FAILED");
    expect(err.message).not.toMatch(/[<>]/);
    expect(conn.breaker.isTripped).toBe(false);
  });

  it("rejects a class name that is not a plain repository name before any request", async () => {
    const { conn, inner } = await connected(() => resp(200, ""));
    await expect(runClass(conn, "ZCL_X. LEAVE PROGRAM")).rejects.toThrowError(
      /not a valid ABAP object name/,
    );
    expect(inner.calls).toHaveLength(0);
  });
});

/**
 * F7 — the bridge class is a REAL repository object, so `runReport` is a WRITE
 * path and must be gated like every other mutation in this codebase.
 *
 * The bug these guard: `runReport` used to call `writeObject` directly on an
 * unauthorized `WriteTarget` with a hard-coded `$TMP`, so the safety gate never
 * saw the one object `abap_run` actually creates. The only check was an
 * *optional* `gate?.assert(...)` one layer up in tools/run.ts — a gate that a
 * caller can forget is not a gate (write.ts makes the same argument).
 */
describe("runReport safety gate (F7)", () => {
  /** A gate that permits writes generally, but not into the bridge's package. */
  const denyingGate = (): SafetyGate =>
    new SafetyGate({
      readOnly: false,
      allowPackages: ["ZFOO_*"], // deliberately NOT $TMP
      writesLockedOut: false,
    });

  /** Same, but with `$TMP` allowed — the control for the test above it. */
  const allowingGate = (): SafetyGate =>
    new SafetyGate({ readOnly: false, allowPackages: ["$TMP"], writesLockedOut: false });

  /**
   * The class does not exist yet, which is the normal first-run case: the GET
   * 404s, `resolveWriteTarget` treats it as a create and takes the package from
   * the request ($TMP), and the gate then judges that package.
   */
  const bridgeMissing = async (): Promise<{ conn: AbapConnection; inner: RecordingClient }> => {
    const inner = new RecordingClient((o) => {
      if (o.url.includes(SESSION_URL)) {
        return resp(200, "<graph/>", {
          "content-type": "application/xml",
          "x-csrf-token": "TOKEN123",
        });
      }
      if (o.url.includes("/oo/classes/")) {
        const r = resp(404, "not found");
        throw new HttpClientException("Request failed with status code 404", "404", 404, undefined, o, r);
      }
      return resp(200, "<ok/>", { "content-type": "application/xml" });
    });
    const conn = new AbapConnection(cfg(), {
      httpClient: inner,
      log: () => {},
      breaker: new AuthCircuitBreaker(),
    });
    await conn.connect();
    inner.calls.length = 0;
    return { conn, inner };
  };

  it("refuses when the gate disallows the bridge package, and writes nothing", async () => {
    const { conn, inner } = await bridgeMissing();

    const err = await runReport(conn, "ZMCP_PROBE_REP", denyingGate()).catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("SAFETY_DENIED");

    // The refusal must land BEFORE anything mutates the system. Resolving the
    // target costs a GET (that is what gives the gate the real package), but no
    // lock, no PUT and no activation may reach the wire.
    const mutations = inner.calls.filter(
      (c) => c.method === "PUT" || c.method === "POST" || String(c.url).includes("_action=LOCK"),
    );
    expect(mutations).toEqual([]);
  });

  it("gets past the gate when the bridge package IS allowed (control)", async () => {
    const { conn } = await bridgeMissing();

    // Proves the refusal above is the PACKAGE rule firing and not merely that
    // this fake never lets `runReport` reach the wire: with $TMP allowed the
    // call gets past the gate and fails later, on the fake's own responses.
    const err = await runReport(conn, "ZMCP_PROBE_REP", allowingGate()).catch((e: unknown) => e);

    expect((err as { code?: string } | undefined)?.code).not.toBe("SAFETY_DENIED");
  });
});

/**
 * The bridge class is written, then activation itself comes back with a real
 * error — the backend compiled nothing. `runReport` must not let that read as
 * a successful, zero-output run.
 */
describe("runReport — activation refusal", () => {
  const LOCK_XML =
    `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
    `<LOCK_HANDLE>H1</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/><IS_LOCAL>X</IS_LOCAL>` +
    `<IS_LINK_UP/><MODIFICATION_SUPPORT/></DATA></asx:values></asx:abap>`;

  const ACTIVATION_ERROR = `<?xml version="1.0" encoding="utf-8"?>
<chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist">
  <msg objDescr="Class ZMCP_RUN_BRIDGE" type="E" line="1"
       href="/sap/bc/adt/oo/classes/zmcp_run_bridge/source/main#start=12,4"
       forceSupported="true">
    <shortText><txt>Field "LV_UNDEFINED" is unknown. It is neither in one of the specified tables nor defined by a "DATA" statement.</txt></shortText>
  </msg>
</chkl:messages>`;

  const bridgeActivationRefused = async (): Promise<{ conn: AbapConnection; inner: RecordingClient }> => {
    const inner = new RecordingClient((o) => {
      if (o.url.includes(SESSION_URL)) {
        return resp(200, "<graph/>", {
          "content-type": "application/xml",
          "x-csrf-token": "TOKEN123",
        });
      }
      if (o.url.includes(DATA_PREVIEW_PATH)) {
        return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
      }
      const action = (o.qs as Record<string, unknown> | undefined)?._action;
      if (action === "LOCK") return resp(200, LOCK_XML, { "content-type": "application/xml" });
      if (action === "UNLOCK") return resp(200, "", { "content-type": "text/plain" });
      if (o.url.includes("/oo/classes/") && (o.method ?? "GET").toUpperCase() === "GET") {
        const r = resp(404, "not found");
        throw new HttpClientException("Request failed with status code 404", "404", 404, undefined, o, r);
      }
      if (o.url.includes("/sap/bc/adt/activation")) {
        return resp(200, ACTIVATION_ERROR, { "content-type": "application/xml" });
      }
      return resp(200, "<ok/>", { "content-type": "application/xml" });
    });
    const conn = new AbapConnection(ConfigSchema.parse({ ...cfg(), readOnly: false, client: "001" }), {
      httpClient: inner,
      log: () => {},
      breaker: new AuthCircuitBreaker(),
    });
    await conn.connect();
    inner.calls.length = 0;
    return { conn, inner };
  };

  const allowingGate = (): SafetyGate =>
    new SafetyGate({ readOnly: false, allowPackages: ["$TMP"], writesLockedOut: false });

  it("reports a CHECK_FAILED run, carrying the backend's own message, and never executes", async () => {
    const { conn, inner } = await bridgeActivationRefused();

    const err = await runReport(conn, "ZMCP_PROBE_REP", allowingGate()).catch((e: unknown) => e);

    expect(isAbapError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("CHECK_FAILED");
    const details = (err as { details?: { raw?: Array<{ text?: string }> } }).details;
    expect(details?.raw?.[0]?.text).toBe(
      'Field "LV_UNDEFINED" is unknown. It is neither in one of the specified tables nor defined by a "DATA" statement.',
    );

    expect(inner.calls.some((c) => c.url.includes(CLASSRUN))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildDumpCorrelation
// ---------------------------------------------------------------------------

/**
 * The correlation helper is pure and exported precisely so the ±2 s arithmetic
 * can be proven without a connection, an HTTP fake or a dump.
 *
 * The rollover cases below are the reason the implementation does the maths on
 * numeric UTC components instead of hand-rolled carry logic — and the reason
 * it must NEVER parse `serverTime` with `new Date(string)`, which would
 * reinterpret a server wall clock in the Node host's local zone.
 */
describe("buildDumpCorrelation", () => {
  it("builds the ±2 s window and the FQL predicate from a server time", () => {
    expect(buildDumpCorrelation("2026-08-11 12:34:47", "DEVELOPER")).toEqual({
      from: "20260811123445",
      to: "20260811123449",
      user: "DEVELOPER",
      query: "and ( equals ( user , DEVELOPER ) )",
      feedPath: "/sap/bc/adt/runtime/dumps",
      call: {
        tool: "abap_dumps",
        arguments: {
          mode: "list",
          from: "20260811123445",
          to: "20260811123449",
          query: "and ( equals ( user , DEVELOPER ) )",
        },
      },
      confidence: "candidates",
    });
  });

  it("is undefined without a server time — a window it cannot honour is worse than none", () => {
    expect(buildDumpCorrelation(undefined, "DEVELOPER")).toBeUndefined();
    expect(buildDumpCorrelation("", "DEVELOPER")).toBeUndefined();
  });

  it.each([
    ["too few digits", "2026-08-11 12:34"],
    ["too many digits", "2026-08-11 12:34:47.123"],
    ["not a real month", "2026-13-11 12:34:47"],
    ["not a real day", "2026-02-30 12:34:47"],
    ["not a real hour", "2026-08-11 25:34:47"],
    ["prose", "Server time unavailable"],
  ])("refuses a malformed server time (%s) rather than emitting a bad bound", (_why, value) => {
    // A bad `from=` is one of the feed's silently-ignored inputs: it comes back
    // 200 with the WHOLE unfiltered feed, so a malformed bound reads as a
    // filtered answer to a filter that never applied.
    expect(buildDumpCorrelation(value, "DEVELOPER")).toBeUndefined();
  });

  it("uppercases the user (assumed, not proven, to be what the feed matches)", () => {
    const c = buildDumpCorrelation("2026-08-11 12:34:47", "developer");
    expect(c?.user).toBe("DEVELOPER");
    expect(c?.query).toBe("and ( equals ( user , DEVELOPER ) )");
  });

  it.each([undefined, "", "   "])(
    "omits the user predicate rather than emitting `equals ( user , )` (a 400) for %o",
    (user) => {
      const c = buildDumpCorrelation("2026-08-11 12:34:47", user);
      expect(c).toBeDefined();
      expect(c).not.toHaveProperty("user");
      expect(c).not.toHaveProperty("query");
      // The time window survives: a worse filter, and a correct one.
      expect(c?.from).toBe("20260811123445");
      expect(c?.to).toBe("20260811123449");
      expect(c?.call.arguments).toEqual({
        mode: "list",
        from: "20260811123445",
        to: "20260811123449",
      });
    },
  );

  it("emits a query the repo's own FQL validator accepts", () => {
    const c = buildDumpCorrelation("2026-08-11 12:34:47", "DEVELOPER");
    const result = validateFqlQuery(c!.query!);
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    // Operator-first, unquoted, mandatory single `and ( … )` wrapper.
    expect(result.canonical).toBe("and ( equals ( user , DEVELOPER ) )");
  });

  it.each([
    ["minute rollover", "2026-08-11 12:34:01", "20260811123359", "20260811123403"],
    ["hour rollover", "2026-08-11 13:00:01", "20260811125959", "20260811130003"],
    ["day rollover", "2026-08-11 23:59:59", "20260811235957", "20260812000001"],
    ["month end", "2026-08-31 23:59:59", "20260831235957", "20260901000001"],
    ["30-day month end", "2026-04-30 23:59:59", "20260430235957", "20260501000001"],
    ["year end", "2026-12-31 23:59:59", "20261231235957", "20270101000001"],
    ["non-leap Feb end", "2026-02-28 23:59:59", "20260228235957", "20260301000001"],
    ["leap year 2028-02-28 → 29", "2028-02-28 23:59:59", "20280228235957", "20280229000001"],
    ["leap day 2028-02-29 → 03-01", "2028-02-29 23:59:59", "20280229235957", "20280301000001"],
  ])("carries correctly across %s", (_why, serverTime, from, to) => {
    const c = buildDumpCorrelation(serverTime, "DEVELOPER");
    expect(c?.from).toBe(from);
    expect(c?.to).toBe(to);
  });

  it("never claims more precision than (user, timestamp) can carry", () => {
    // The full dump key is (host, user, client, MODNO, timestamp); the
    // 2026-08-11 burst produced dumps one second apart from one user, so the
    // confidence signal is a constant and there is no 'exact' to widen to.
    expect(buildDumpCorrelation("2026-08-11 12:34:47", "DEVELOPER")?.confidence).toBe("candidates");
  });
});
