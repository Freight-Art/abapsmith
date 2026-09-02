/**
 * Tests for `src/adt/fpm-runtime.ts` — bridge generation, transcript parsing,
 * and query-field injection defense for `abap_fpm_read`.
 *
 * Mirrors `test/bopf-runtime.test.ts`'s structure and offline-HTTP-fake
 * pattern (`RecordingClient` + a hand-rolled `bridgeHappyPath`-style route,
 * repeated self-contained here rather than imported — matching that file's
 * own stated choice not to share this helper across suites).
 *
 * Fixture note: the outline-mode XML tests use the byte-verbatim FBI probe
 * capture at `test/fixtures/fpm/36-BOFU_DEMO_SO_HDR_VIEW.full-config.xml`
 * (copied unmodified from a live capture) as ground truth for what a real
 * FBI view config XML body looks like — not invented. The app-mode
 * `NODE`/`RESOLVED` field VALUES used below (node names, paths, descriptions,
 * component names) are likewise drawn from a real capture
 * (`CL_FPM_CFG_HRCHY_BRWSR_ASSIST` walking `/BOBF/EPM_FPM_SADL_PD`) — only the
 * surrounding `FPM> NODE key=[val] ...` bracket-field WIRE FORMAT is this
 * project's own invented transcript protocol (there is no prior SAP capture
 * of it, because this bridge class did not exist before now), so that
 * part is constructed directly per fpm-runtime.ts's own `appBody`/`emit_xml`
 * source, not sourced from any fixture.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { HttpClientException } from "abap-adt-api/build/AdtHTTP.js";

import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { SafetyGate } from "../src/safety.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { isAbapError, type AbapError } from "../src/adt/errors.js";
import { ERR_LINE_PREFIX } from "../src/adt/run.js";
import { activationFailureXml } from "./helpers/fake-adt.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";
import {
  FPM_BRIDGE_CLASS_PREFIX,
  FPM_LINE_PREFIX,
  assertConfigId,
  assertConfigType,
  assertConfigVar,
  assertComponent,
  assertPackageFilter,
  buildLikePattern,
  fpmBridgeClassName,
  fpmBridgeSource,
  parseFpmTranscript,
  runFpmRead,
  type FpmAppQuery,
  type FpmBridgeQuery,
  type FpmFindQuery,
  type FpmOutlineQuery,
} from "../src/adt/fpm-runtime.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fpm");
/** Real captured FBI view config XML, copied verbatim — see file header. */
const REAL_OUTLINE_XML = readFileSync(join(FIXTURES, "36-BOFU_DEMO_SO_HDR_VIEW.full-config.xml"), "utf8");

function expectBadInput(fn: () => unknown): AbapError {
  try {
    fn();
  } catch (e) {
    if (isAbapError(e)) {
      expect(e.code).toBe("BAD_INPUT");
      return e;
    }
    throw e;
  }
  throw new Error("expected fn() to throw a BAD_INPUT AbapError");
}

// A representative set of injection-shaped payloads — the single most
// safety-critical property of this file: every one of these strings would,
// if interpolated unescaped into generated ABAP source, either close a
// string literal early or inject a statement separator.
const INJECTION_PAYLOADS = [
  "O'BRIEN",
  "X'; DELETE FROM t99 WHERE 'a'='a",
  "`whoami`",
  "A\"; DROP",
  "A.B",
  "A B",
  "A\nB",
  "A;B",
  "<script>",
  "A%00B",
];

// ---------------------------------------------------------------------------
// Field validators
// ---------------------------------------------------------------------------

describe("assertConfigId", () => {
  it("accepts a plain config id up to 32 chars", () => {
    expect(assertConfigId("BOFU_DEMO_SO_HDR_VIEW")).toBe("BOFU_DEMO_SO_HDR_VIEW");
    expect(assertConfigId("/BOFU/DEMO_SO_HDR_VIEW")).toBe("/BOFU/DEMO_SO_HDR_VIEW");
    expect(assertConfigId("A".repeat(32))).toBe("A".repeat(32));
  });

  it("rejects a config id longer than 32 chars (WDY_CONFIG_ID is CHAR32) even though it is otherwise plain", () => {
    // 33 plain chars passes assertPlainName's 40-char ABAP-name regex but
    // must still be refused on the field-specific 32-char limit.
    expect(() => assertConfigId("A".repeat(33))).toThrowError(/CHAR32/);
  });

  for (const bad of INJECTION_PAYLOADS) {
    it(`rejects injection-shaped input: ${JSON.stringify(bad)}`, () => {
      expectBadInput(() => assertConfigId(bad));
    });
  }
});

describe("assertConfigType", () => {
  it("defaults to 00 when undefined", () => {
    expect(assertConfigType(undefined)).toBe("00");
  });

  it("accepts exactly-2-digit NUMC values", () => {
    expect(assertConfigType("00")).toBe("00");
    expect(assertConfigType("02")).toBe("02");
    expect(assertConfigType(" 02 ")).toBe("02");
  });

  it("rejects anything not exactly 2 digits", () => {
    expectBadInput(() => assertConfigType("0"));
    expectBadInput(() => assertConfigType("000"));
    expectBadInput(() => assertConfigType("AB"));
    expectBadInput(() => assertConfigType("0X"));
  });

  for (const bad of ["0'", "02;DELETE", "0`2", "0\n2"]) {
    it(`rejects injection-shaped input: ${JSON.stringify(bad)}`, () => {
      expectBadInput(() => assertConfigType(bad));
    });
  }
});

describe("assertConfigVar", () => {
  it("defaults to blank when undefined, and blank passes through", () => {
    expect(assertConfigVar(undefined)).toBe("");
    expect(assertConfigVar("")).toBe("");
    expect(assertConfigVar("   ")).toBe("");
  });

  it("accepts up to 6 letters/digits/underscore", () => {
    expect(assertConfigVar("V1")).toBe("V1");
    expect(assertConfigVar("ABC_12")).toBe("ABC_12");
  });

  it("rejects more than 6 characters", () => {
    expectBadInput(() => assertConfigVar("TOOLONG1"));
  });

  for (const bad of ["V'1", "V`1", "V;1", "V.1", "V/1", "V 1"]) {
    it(`rejects injection-shaped input: ${JSON.stringify(bad)}`, () => {
      expectBadInput(() => assertConfigVar(bad));
    });
  }
});

describe("assertComponent / assertPackageFilter", () => {
  it("accept a plain repository-style name", () => {
    expect(assertComponent("FPM_OVP_COMPONENT")).toBe("FPM_OVP_COMPONENT");
    expect(assertPackageFilter("ZFPM_PKG")).toBe("ZFPM_PKG");
  });

  for (const bad of INJECTION_PAYLOADS) {
    it(`assertComponent rejects injection-shaped input: ${JSON.stringify(bad)}`, () => {
      expectBadInput(() => assertComponent(bad));
    });
    it(`assertPackageFilter rejects injection-shaped input: ${JSON.stringify(bad)}`, () => {
      expectBadInput(() => assertPackageFilter(bad));
    });
  }
});

describe("buildLikePattern", () => {
  it("translates * to % and escapes literal underscores", () => {
    const { literal, escapeChar } = buildLikePattern("BOFU_*");
    expect(escapeChar).toBe("#");
    expect(literal).toBe("BOFU#_%");
  });

  it("accepts letters/digits/underscore/slash/asterisk up to 40 chars", () => {
    expect(buildLikePattern("/BOFU/DEMO*").literal).toBe("/BOFU/DEMO%");
  });

  it("rejects an empty or whitespace-only pattern", () => {
    expectBadInput(() => buildLikePattern(""));
    expectBadInput(() => buildLikePattern("   "));
  });

  it("rejects a pattern longer than 40 chars", () => {
    expectBadInput(() => buildLikePattern("A".repeat(41)));
  });

  for (const bad of ["O'BRIEN", "A`B", "A;B", "A\"B", "A(B)", "A B", "A\nB"]) {
    it(`rejects injection-shaped input: ${JSON.stringify(bad)}`, () => {
      expectBadInput(() => buildLikePattern(bad));
    });
  }

  it("the single-quote rejection is the load-bearing case: buildLikePattern never escapes-and-trusts an apostrophe", () => {
    // The module's own doc comment: "anything that could plausibly close a
    // string literal (an apostrophe) is rejected outright rather than
    // escaped-and-trusted." Confirm no literal survives to sqlQuote at all.
    expect(() => buildLikePattern("O'BRIEN'; DELETE FROM t")).toThrowError(/may only contain/);
  });
});

// ---------------------------------------------------------------------------
// fpmBridgeClassName
// ---------------------------------------------------------------------------

describe("fpmBridgeClassName", () => {
  const findQuery: FpmFindQuery = { mode: "find", configType: "00", component: "FPM_OVP_COMPONENT" };
  const outlineQuery: FpmOutlineQuery = {
    mode: "outline",
    configId: "BOFU_DEMO_SO_HDR_VIEW",
    configType: "00",
    configVar: "",
  };
  const appQuery: FpmAppQuery = { mode: "app", configId: "/BOBF/EPM_FPM_SADL_PD", resolve: true };

  it("is deterministic: the exact same query produces the exact same class name", () => {
    expect(fpmBridgeClassName(findQuery)).toBe(fpmBridgeClassName({ ...findQuery }));
    expect(fpmBridgeClassName(outlineQuery)).toBe(fpmBridgeClassName({ ...outlineQuery }));
    expect(fpmBridgeClassName(appQuery)).toBe(fpmBridgeClassName({ ...appQuery }));
  });

  it("differs for queries that differ in mode", () => {
    const a = fpmBridgeClassName(findQuery);
    const b = fpmBridgeClassName(outlineQuery);
    const c = fpmBridgeClassName(appQuery);
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("differs for queries that differ only in one field", () => {
    const a = fpmBridgeClassName(appQuery);
    const b = fpmBridgeClassName({ ...appQuery, resolve: false });
    const c = fpmBridgeClassName({ ...appQuery, configId: "/BOBF/EPM_FPM_SADL_PD_V2" });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });

  it("differs for a find query that differs only in package filter", () => {
    const a = fpmBridgeClassName(findQuery);
    const b = fpmBridgeClassName({ ...findQuery, package: "ZFPM_PKG" });
    expect(a).not.toBe(b);
  });

  it("never exceeds ABAP's 30-char object-name limit and always starts with the fixed prefix", () => {
    for (const q of [findQuery, outlineQuery, appQuery]) {
      const name = fpmBridgeClassName(q);
      expect(name.length).toBeLessThanOrEqual(30);
      expect(name.startsWith(FPM_BRIDGE_CLASS_PREFIX)).toBe(true);
      expect(name).toMatch(/^[A-Z0-9_]+$/);
    }
  });

  it("throws BAD_INPUT for a malformed query (validateQuery runs before hashing)", () => {
    expectBadInput(() => fpmBridgeClassName({ mode: "outline", configId: "A'B", configType: "00", configVar: "" }));
    expectBadInput(() =>
      fpmBridgeClassName({ mode: "find", configType: "02", component: "FPM_OVP_COMPONENT" } as FpmFindQuery),
    );
  });
});

// ---------------------------------------------------------------------------
// fpmBridgeSource
// ---------------------------------------------------------------------------

describe("fpmBridgeSource", () => {
  it("find mode: contains the component-scope SELECT and the CONFIG line template", () => {
    const q: FpmFindQuery = { mode: "find", configType: "00", component: "FPM_OVP_COMPONENT" };
    const cls = fpmBridgeClassName(q);
    const src = fpmBridgeSource(q, cls);
    expect(src).toContain("CLASS ");
    expect(src).toContain("DEFINITION PUBLIC FINAL CREATE PUBLIC.");
    expect(src).toContain("INTERFACES if_oo_adt_classrun.");
    expect(src).toContain("METHOD if_oo_adt_classrun~main.");
    expect(src).toContain("FROM wdy_config_data");
    expect(src).toContain("component = 'FPM_OVP_COMPONENT'");
    expect(src).toContain(`${FPM_LINE_PREFIX}CONFIG config_id=`);
    expect(src.trimEnd().endsWith("ENDCLASS.")).toBe(true);
  });

  it("find mode: application scope (config_type 02) selects wdy_config_appl, not wdy_config_data", () => {
    const q: FpmFindQuery = { mode: "find", configType: "02" };
    const cls = fpmBridgeClassName(q);
    const src = fpmBridgeSource(q, cls);
    expect(src).toContain("FROM wdy_config_appl");
    expect(src).not.toContain("FROM wdy_config_data");
  });

  it("find mode with a package filter adds the TADIR devclass cross-reference and CONTINUE skip", () => {
    const q: FpmFindQuery = { mode: "find", configType: "00", package: "ZFPM_PKG" };
    const src = fpmBridgeSource(q, fpmBridgeClassName(q));
    expect(src).toContain("FROM tadir");
    expect(src).toContain("object = 'WDCC'");
    expect(src).toContain("lv_devclass <> 'ZFPM_PKG'");
    expect(src).toContain("CONTINUE.");
  });

  it("outline mode, component scope (config_type 00): contains READ_COMP_CONFIG_FROM_DB", () => {
    const q: FpmOutlineQuery = { mode: "outline", configId: "BOFU_DEMO_SO_HDR_VIEW", configType: "00", configVar: "" };
    const src = fpmBridgeSource(q, fpmBridgeClassName(q));
    expect(src).toContain("cl_wdr_cfg_persistence_utils=>read_comp_config_from_db(");
    expect(src).toContain("emit_xml( iv_tag = 'XML'");
    expect(src).toContain(`${FPM_LINE_PREFIX}META CONFIG_IDPAR=`);
    expect(src).toContain("object = 'WDCC'");
  });

  it("outline mode, application scope (config_type 02): SELECTs WDY_CONFIG_APPL directly, no READ_COMP_CONFIG_FROM_DB call, and reports delta-tracking as not implemented", () => {
    const q: FpmOutlineQuery = { mode: "outline", configId: "/BOBF/EPM_FPM_SADL_PD", configType: "02", configVar: "" };
    const src = fpmBridgeSource(q, fpmBridgeClassName(q));
    expect(src).toContain("SELECT SINGLE xcontent FROM wdy_config_appl");
    expect(src).not.toContain("read_comp_config_from_db(");
    expect(src).toContain("delta tracking not implemented for this branch");
    expect(src).toContain("object = 'WDCA'");
  });

  it("app mode: contains the CL_FPM_CFG_HRCHY_BRWSR_ASSIST hierarchy walk", () => {
    const q: FpmAppQuery = { mode: "app", configId: "/BOBF/EPM_FPM_SADL_PD", resolve: true };
    const src = fpmBridgeSource(q, fpmBridgeClassName(q));
    expect(src).toContain("cl_fpm_cfg_hrchy_brwsr_assist");
    expect(src).toContain("mv_mode = 2.");
    expect(src).toContain("init_affixes( ).");
    expect(src).toContain(`${FPM_LINE_PREFIX}NODE node_path=`);
    expect(src).toContain(`${FPM_LINE_PREFIX}RESOLVED node_path=`);
    expect(src).toContain("FEEDER");
  });

  it("app mode with resolve:false omits the per-node resolve/RESOLVED block entirely", () => {
    const q: FpmAppQuery = { mode: "app", configId: "/BOBF/EPM_FPM_SADL_PD", resolve: false };
    const src = fpmBridgeSource(q, fpmBridgeClassName(q));
    expect(src).toContain(`${FPM_LINE_PREFIX}NODE node_path=`);
    expect(src).not.toContain(`${FPM_LINE_PREFIX}RESOLVED node_path=`);
    expect(src).not.toContain("read_comp_config_from_db(");
  });

  it("is byte-stable across repeated calls with freshly reconstructed value-equal queries (needed for writeObject's compare-before-write skip)", () => {
    const q: FpmOutlineQuery = { mode: "outline", configId: "BOFU_DEMO_SO_HDR_VIEW", configType: "00", configVar: "V1" };
    const cls = fpmBridgeClassName(q);
    const a = fpmBridgeSource(q, cls);
    const b = fpmBridgeSource({ ...q }, cls);
    expect(a).toBe(b);
  });

  it("a validated-but-adversarial (max-length, boundary-char) config_id still produces source without throwing", () => {
    // 32 chars, the CHAR32 boundary, mixing letters/digits/underscore/slash —
    // every character class assertConfigId's underlying assertPlainName allows.
    const boundaryId = "/Z9/" + "A_1".repeat(9) + "AB"; // 4 + 27 + 2 = wait, compute exactly below
    const configId = ("/Z9/" + "A".repeat(28)).slice(0, 32);
    expect(configId.length).toBe(32);
    const q: FpmOutlineQuery = { mode: "outline", configId, configType: "00", configVar: "ABCDEF" };
    expect(() => fpmBridgeSource(q, fpmBridgeClassName(q))).not.toThrow();
    const src = fpmBridgeSource(q, fpmBridgeClassName(q));
    expect(src).toContain(configId);
    // (boundaryId constructed above is unused directly — kept to document the
    // intended character mix; the length-exact `configId` is what's asserted.)
    void boundaryId;
  });

  it("rejects find mode combining config_type 02 with a component filter (WDY_CONFIG_APPL has no component column)", () => {
    const q: FpmFindQuery = { mode: "find", configType: "02", component: "FPM_OVP_COMPONENT" };
    expectBadInput(() => fpmBridgeSource(q, "ZCL_ZMCP_FPM_X"));
  });
});

// ---------------------------------------------------------------------------
// parseFpmTranscript
// ---------------------------------------------------------------------------

describe("parseFpmTranscript — find mode", () => {
  it("parses multiple CONFIG lines and a COUNT line into FpmConfigRow[]", () => {
    const raw =
      `${FPM_LINE_PREFIX}COUNT 2\n` +
      `${FPM_LINE_PREFIX}CONFIG config_id=[BOFU_DEMO_SO_HDR_VIEW] config_type=[00] config_var=[] component=[FPM_OVP_COMPONENT] description=[Demo SO Header View]\n` +
      `${FPM_LINE_PREFIX}CONFIG config_id=[BOFU_DEMO_SO_ITM_VIEW] config_type=[00] config_var=[V1] component=[FPM_OVP_COMPONENT] description=[]\n`;

    const result = parseFpmTranscript(raw);

    expect(result.count).toBe(2);
    expect(result.configs).toEqual([
      {
        configId: "BOFU_DEMO_SO_HDR_VIEW",
        configType: "00",
        configVar: "",
        component: "FPM_OVP_COMPONENT",
        description: "Demo SO Header View",
        devclass: undefined,
      },
      {
        configId: "BOFU_DEMO_SO_ITM_VIEW",
        configType: "00",
        configVar: "V1",
        component: "FPM_OVP_COMPONENT",
        description: "",
        devclass: undefined,
      },
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(result.droppedLines).toBe(0);
    expect(result.appNodes).toEqual([]);
  });

  it("parses the devclass field when present (package-filtered find)", () => {
    const raw =
      `${FPM_LINE_PREFIX}COUNT 1\n` +
      `${FPM_LINE_PREFIX}CONFIG config_id=[BOFU_DEMO_SO_HDR_VIEW] config_type=[00] config_var=[] component=[FPM_OVP_COMPONENT] description=[x] devclass=[ZFPM_PKG]\n`;
    const result = parseFpmTranscript(raw);
    expect(result.configs[0]!.devclass).toBe("ZFPM_PKG");
  });
});

describe("parseFpmTranscript — outline mode XML stream and META", () => {
  /** Mirrors emit_xml's own escaping: real CR/LF -> literal two-char \n. */
  function escapeForBridge(text: string): string {
    return text.replace(/\r\n/g, "\\n").replace(/\n/g, "\\n");
  }

  function wrapXmlStream(tag: string, text: string, chunkSizes: number[]): string {
    const escaped = escapeForBridge(text);
    const lines: string[] = [`${FPM_LINE_PREFIX}${tag}_BEGIN`];
    let off = 0;
    for (const size of chunkSizes) {
      const chunk = escaped.slice(off, off + size);
      lines.push(`${FPM_LINE_PREFIX}${tag}C ${chunk}`);
      off += size;
    }
    // Any remainder not covered by the explicit chunkSizes goes in one final chunk.
    if (off < escaped.length) {
      lines.push(`${FPM_LINE_PREFIX}${tag}C ${escaped.slice(off)}`);
    }
    lines.push(`${FPM_LINE_PREFIX}${tag}_END`);
    return lines.join("\n");
  }

  it("reassembles a real captured config XML split across multiple XMLC chunks, byte-exact including the embedded '\\n' unescape", () => {
    // Deliberately split the real 1600-byte fixture across THREE chunks
    // (well under the 32000-char production chunk size) to exercise the
    // multi-chunk reassembly path even though this fixture alone would fit
    // in a single production chunk.
    const splitSizes = [400, 400, 400]; // remainder (~escaped length - 1200) forms the last chunk
    const xmlBlock = wrapXmlStream("XML", REAL_OUTLINE_XML, splitSizes);
    const raw =
      `${xmlBlock}\n` +
      `${FPM_LINE_PREFIX}META CONFIG_IDPAR=[] CONFIG_TYPEPAR=[] CONFIG_VARPAR=[] COMPONENT=[FPM_OVP_COMPONENT] DEVCLASS=[ZFPM_PKG]\n`;

    const result = parseFpmTranscript(raw);

    expect(result.outlineXml).toBe(REAL_OUTLINE_XML);
    // ConfId is namespaced as "/BOFU/DEMO_SO_HDR_VIEW" (slash-separated
    // namespace prefix, not an underscore) — the fixture's filename uses an
    // underscore for filesystem-friendliness only.
    expect(result.outlineXml).toContain("/BOFU/DEMO_SO_HDR_VIEW");
    expect(result.outlineXml).toContain("DELIVER_ORDER");
    expect(result.outlineMeta).toEqual({
      configIdPar: "",
      configTypePar: "",
      configVarPar: "",
      component: "FPM_OVP_COMPONENT",
      devclass: "ZFPM_PKG",
    });
  });

  it("a blank CONFIG_IDPAR is the non-delta case", () => {
    const raw =
      wrapXmlStream("XML", "<Component/>", [5]) +
      `\n${FPM_LINE_PREFIX}META CONFIG_IDPAR=[] CONFIG_TYPEPAR=[] CONFIG_VARPAR=[] COMPONENT=[] DEVCLASS=[]\n`;
    const result = parseFpmTranscript(raw);
    expect(result.outlineMeta?.configIdPar).toBe("");
  });

  it("a non-blank CONFIG_IDPAR is the delta case", () => {
    const raw =
      wrapXmlStream("XML", "<Component/>", [5]) +
      `\n${FPM_LINE_PREFIX}META CONFIG_IDPAR=[BOFU_DEMO_SO_HDR_VIEW] CONFIG_TYPEPAR=[00] CONFIG_VARPAR=[] COMPONENT=[FPM_OVP_COMPONENT] DEVCLASS=[]\n`;
    const result = parseFpmTranscript(raw);
    expect(result.outlineMeta?.configIdPar).toBe("BOFU_DEMO_SO_HDR_VIEW");
  });

  it("a stream that never sees its _END line contributes nothing to outlineXml", () => {
    const raw = `${FPM_LINE_PREFIX}XML_BEGIN\n${FPM_LINE_PREFIX}XMLC <Component/>\n`;
    const result = parseFpmTranscript(raw);
    expect(result.outlineXml).toBeUndefined();
  });
});

describe("parseFpmTranscript — app mode NODE/RESOLVED and excerpt attachment", () => {
  /** Same escaping helper as the outline-mode describe block above. */
  function escapeForBridge(text: string): string {
    return text.replace(/\r\n/g, "\\n").replace(/\n/g, "\\n");
  }
  function xmlExcerptBlock(ordinal: number, text: string): string {
    const escaped = escapeForBridge(text);
    return (
      `${FPM_LINE_PREFIX}XMLEXCERPT_${ordinal}_BEGIN\n` +
      `${FPM_LINE_PREFIX}XMLEXCERPT_${ordinal}C ${escaped}\n` +
      `${FPM_LINE_PREFIX}XMLEXCERPT_${ordinal}_END\n`
    );
  }

  // Real field VALUES drawn from a live capture (CL_FPM_CFG_HRCHY_BRWSR_ASSIST
  // walking /BOBF/EPM_FPM_SADL_PD); the `FPM> NODE key=[val] ...` wrapping is
  // this project's own transcript format.
  const NODE1 =
    `${FPM_LINE_PREFIX}NODE node_path=[APPLICATION_CONFIGURATION] parent_path=[] is_top=[X] node_name=[CONFIGURATION_CONTEXT] description=[Application Configuration] component=[] interface_view=[] config_id=[/BOBF/EPM_FPM_SADL_PD] config_type=[02] config_var=[] target_config_id=[Z_EPM_FPM_SADL_PD] is_configurable=[X] is_customized=[] is_enhanced=[] is_freestyle_uibb=[] is_leaf=[]`;
  const NODE2 =
    `${FPM_LINE_PREFIX}NODE node_path=[CONFIGURATION_CONTEXT.000001.OVP_APPLICATION] parent_path=[APPLICATION_CONFIGURATION] is_top=[] node_name=[OVP_APPLICATION] description=[Overview Page Floorplan] component=[FPM_OVP_COMPONENT] interface_view=[] config_id=[/BOBF/EPM_FPM_SADL_PD] config_type=[02] config_var=[] target_config_id=[] is_configurable=[X] is_customized=[] is_enhanced=[] is_freestyle_uibb=[] is_leaf=[]`;
  const NODE3 =
    `${FPM_LINE_PREFIX}NODE node_path=[CONFIGURATION_CONTEXT.000001.OVP_APPLICATION.000001.CONTENT_AREA] parent_path=[CONFIGURATION_CONTEXT.000001.OVP_APPLICATION] is_top=[] node_name=[CONTENT_AREA] description=[] component=[] interface_view=[] config_id=[/BOBF/EPM_FPM_SADL_PD] config_type=[02] config_var=[] target_config_id=[] is_configurable=[] is_customized=[] is_enhanced=[] is_freestyle_uibb=[] is_leaf=[X]`;

  it("parses several NODE lines into FpmAppNode[] with correct boolean/string field mapping", () => {
    const raw = `${FPM_LINE_PREFIX}COUNT 3\n${NODE1}\n${NODE2}\n${NODE3}\n`;
    const result = parseFpmTranscript(raw);
    expect(result.count).toBe(3);
    expect(result.appNodes).toHaveLength(3);
    expect(result.appNodes[0]).toMatchObject({
      nodePath: "APPLICATION_CONFIGURATION",
      isTopNode: true,
      nodeName: "CONFIGURATION_CONTEXT",
      description: "Application Configuration",
      isConfigurable: true,
      isLeaf: false,
    });
    expect(result.appNodes[1]).toMatchObject({
      nodePath: "CONFIGURATION_CONTEXT.000001.OVP_APPLICATION",
      parentPath: "APPLICATION_CONFIGURATION",
      isTopNode: false,
      componentName: "FPM_OVP_COMPONENT",
    });
    expect(result.appNodes[2]).toMatchObject({ nodeName: "CONTENT_AREA", isLeaf: true });
  });

  it("attaches a RESOLVED line's feederHint/bopfHint/excerpt to the correct NODE — not off-by-one to a neighbor", () => {
    // Node 1 (top node) is not resolved (not configurable). Node 2 IS
    // resolved with a FEEDER/BOPF-shaped excerpt at ordinal 2 (the 1-based
    // position of NODE2 among all NODE lines, matching the ABAP driver's
    // `sy-tabix` LOOP counter). Node 3 is not resolved.
    const excerptXml = "<UIBB><FEEDER_CLASS>/BOFU/CL_SO_CONFIRM_DIALOG</FEEDER_CLASS><BO_KEY>ROOT</BO_KEY></UIBB>";
    const resolved2 =
      `${FPM_LINE_PREFIX}RESOLVED node_path=[CONFIGURATION_CONTEXT.000001.OVP_APPLICATION] xml_len=[${excerptXml.length}] feeder_hint=[X] bopf_hint=[X]\n`;
    const raw =
      `${FPM_LINE_PREFIX}COUNT 3\n` +
      `${NODE1}\n` +
      `${NODE2}\n` +
      resolved2 +
      xmlExcerptBlock(2, excerptXml) +
      `${NODE3}\n`;

    const result = parseFpmTranscript(raw);
    expect(result.appNodes).toHaveLength(3);
    expect(result.appNodes[0]!.resolved).toBeUndefined();
    expect(result.appNodes[2]!.resolved).toBeUndefined();
    expect(result.appNodes[1]!.resolved).toEqual({
      xmlLen: excerptXml.length,
      feederHint: true,
      bopfHint: true,
      excerpt: excerptXml,
    });
  });

  it("a RESOLVED line with no preceding NODE line is silently dropped (no target to attach to), not thrown", () => {
    const raw = `${FPM_LINE_PREFIX}RESOLVED node_path=[X] xml_len=[0] feeder_hint=[] bopf_hint=[]\n`;
    expect(() => parseFpmTranscript(raw)).not.toThrow();
    expect(parseFpmTranscript(raw).appNodes).toEqual([]);
  });
});

describe("parseFpmTranscript — diagnostics and dropped lines", () => {
  it("ERR_LINE_PREFIX lines land in diagnostics, never in configs/appNodes", () => {
    const raw =
      `${FPM_LINE_PREFIX}COUNT 1\n` +
      `${FPM_LINE_PREFIX}CONFIG config_id=[X] config_type=[00] config_var=[] component=[] description=[]\n` +
      `${ERR_LINE_PREFIX}READ_COMP_CONFIG_FROM_DB FAILED some ABAP exception text\n`;
    const result = parseFpmTranscript(raw);
    expect(result.diagnostics).toEqual([`${ERR_LINE_PREFIX}READ_COMP_CONFIG_FROM_DB FAILED some ABAP exception text`]);
    expect(result.configs).toHaveLength(1);
    expect(result.appNodes).toEqual([]);
  });

  it("multiple diagnostic lines interleaved with NODE lines do not corrupt node parsing", () => {
    const raw =
      `${ERR_LINE_PREFIX}RESOLVE some/path FAILED oops\n` +
      `${FPM_LINE_PREFIX}NODE node_path=[A] parent_path=[] is_top=[X] node_name=[A] description=[] component=[] interface_view=[] config_id=[X] config_type=[00] config_var=[] target_config_id=[] is_configurable=[] is_customized=[] is_enhanced=[] is_freestyle_uibb=[] is_leaf=[]\n` +
      `${ERR_LINE_PREFIX}RESOLVE another/path FAILED oops2\n`;
    const result = parseFpmTranscript(raw);
    expect(result.diagnostics).toHaveLength(2);
    expect(result.appNodes).toHaveLength(1);
    expect(result.appNodes[0]!.nodePath).toBe("A");
  });

  it("a genuinely unprefixed/garbage line is counted in droppedLines and does not corrupt surrounding valid lines", () => {
    const raw =
      `${FPM_LINE_PREFIX}COUNT 1\n` +
      `some ADT/HTTP framing noise that is neither FPM> nor ZMCP-ERR>\n` +
      `${FPM_LINE_PREFIX}CONFIG config_id=[X] config_type=[00] config_var=[] component=[] description=[]\n`;
    const result = parseFpmTranscript(raw);
    expect(result.droppedLines).toBe(1);
    expect(result.count).toBe(1);
    expect(result.configs).toHaveLength(1);
    expect(result.configs[0]!.configId).toBe("X");
  });

  it("blank unprefixed lines are NOT counted as dropped (ADT/HTTP framing, not garbage)", () => {
    const raw = `${FPM_LINE_PREFIX}COUNT 0\n\n\n`;
    const result = parseFpmTranscript(raw);
    expect(result.droppedLines).toBe(0);
  });

  it("handles empty input", () => {
    const result = parseFpmTranscript("");
    expect(result.configs).toEqual([]);
    expect(result.appNodes).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    // "".split("\n") -> [""], a single blank line — blank unprefixed lines are
    // ADT/HTTP framing noise (per the "blank unprefixed lines" test above),
    // not counted as dropped. (Contrast bopf-runtime.test.ts's own
    // parseBopfTranscript, which DOES count this as 1 dropped line — the two
    // parsers intentionally disagree here: parseFpmTranscript special-cases
    // whitespace-only lines, parseBopfTranscript does not.)
    expect(result.droppedLines).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runFpmRead orchestration — offline, faked HttpClient (RecordingClient,
// exactly test/bopf-runtime.test.ts's runBopfTest pattern)
// ---------------------------------------------------------------------------

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "secret",
    sid: "TST",
    client: "001",
    readOnly: false,
  });

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
  statusText = String(status),
): HttpClientResponse => ({ status, statusText, body, headers }) as unknown as HttpClientResponse;

class RecordingClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(private readonly respond: (o: HttpClientOptions) => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    return this.respond(o);
  }
}

const SESSION_URL = "/sap/bc/adt/compatibility/graph";
/* `DATAPREVIEW_XML` + `T000_NONPRODUCTIVE` (fixture 087): imported from
 * ./helpers/system-role-fake.js — the productive-system probe is fail-closed,
 * so a fake that must stand for a writable system has to serve these real bytes. */

const LOCK_XML = (handle = "H1") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

/**
 * Full write -> activate -> (maybe) classrun happy path for a bridge class
 * that does not exist yet on the fake server. Adapted from
 * test/bopf-runtime.test.ts's `bridgeHappyPath` — same shape, parameterized
 * only by class name and classrun responder (`activateBody` lets a test opt
 * into a failing activation instead of the clean 200).
 */
function bridgeHappyPath(
  className: string,
  classrun: (o: HttpClientOptions) => HttpClientResponse,
  activateBody?: { body: string },
): (o: HttpClientOptions) => HttpClientResponse {
  const classUri = `/sap/bc/adt/oo/classes/${className.toLowerCase()}`;
  const sourceUri = `${classUri}/source/main`;
  return (o: HttpClientOptions) => {
    const qs = (o.qs ?? {}) as Record<string, string>;
    const method = (o.method ?? "GET").toUpperCase();

    if (o.url.startsWith("/sap/bc/adt/oo/classrun/")) return classrun(o);
    if (o.url.includes(SESSION_URL)) {
      return resp(200, "<graph/>", { "content-type": "application/xml", "x-csrf-token": "TOKEN123" });
    }
    if (o.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
    if (o.url.includes("/ato/settings")) return resp(200, "<settings/>", { "content-type": "application/xml" });
    if (o.url === classUri && method === "GET" && !qs._action) {
      const r = resp(404, "<exc:exception/>", { "content-type": "application/xml" });
      throw new HttpClientException("Request failed with status code 404", "404", 404, undefined, o, r);
    }
    if (o.url === "/sap/bc/adt/oo/classes" && method === "POST") return resp(200, "", {});
    if (qs._action === "LOCK") return resp(200, LOCK_XML(), { "content-type": "application/xml" });
    if (qs._action === "UNLOCK") return resp(200, "", { "content-type": "text/plain" });
    if (o.url === sourceUri && method === "PUT") return resp(200, "", { "content-type": "text/plain" });
    if (o.url.includes("/sap/bc/adt/activation")) {
      return activateBody
        ? resp(200, activateBody.body, { "content-type": "application/xml" })
        : resp(200, "", { "content-length": "0" });
    }
    return resp(200, "<ok/>", { "content-type": "application/xml" });
  };
}

async function connected(
  route: (o: HttpClientOptions) => HttpClientResponse,
): Promise<{ conn: AbapConnection; inner: RecordingClient }> {
  const inner = new RecordingClient(route);
  const conn = new AbapConnection(cfg(), { httpClient: inner, log: () => {}, breaker: new AuthCircuitBreaker() });
  await conn.connect();
  inner.calls.length = 0;
  return { conn, inner };
}

const allowingGate = (): SafetyGate =>
  new SafetyGate({ readOnly: false, allowPackages: ["$TMP"], writesLockedOut: false });

describe("runFpmRead", () => {
  it("find mode: writes+activates the bridge, executes it, and parses the returned transcript", async () => {
    const query: FpmFindQuery = { mode: "find", configType: "00", component: "FPM_OVP_COMPONENT" };
    const className = fpmBridgeClassName(query);
    const TRANSCRIPT =
      `${FPM_LINE_PREFIX}COUNT 1\n` +
      `${FPM_LINE_PREFIX}CONFIG config_id=[BOFU_DEMO_SO_HDR_VIEW] config_type=[00] config_var=[] component=[FPM_OVP_COMPONENT] description=[Demo]\n`;
    const { conn, inner } = await connected(
      bridgeHappyPath(className, () => resp(200, TRANSCRIPT, { "content-type": "text/plain" })),
    );

    const result = await runFpmRead(conn, query, allowingGate());

    expect(result.bridgeClass).toBe(className);
    expect(result.bridgeRefreshed).toBe(true);
    expect(result.transcript.configs).toHaveLength(1);
    expect(result.transcript.configs[0]!.configId).toBe("BOFU_DEMO_SO_HDR_VIEW");
    expect(typeof result.durationMs).toBe("number");
    expect(inner.calls.some((c) => c.url.startsWith("/sap/bc/adt/oo/classrun/"))).toBe(true);
  });

  it("throws CHECK_FAILED (not a silent bad transcript) when the bridge fails to activate", async () => {
    const query: FpmAppQuery = { mode: "app", configId: "/BOBF/EPM_FPM_SADL_PD", resolve: true };
    const className = fpmBridgeClassName(query);
    const classUri = `/sap/bc/adt/oo/classes/${className.toLowerCase()}`;
    const { conn } = await connected(
      bridgeHappyPath(
        className,
        () => resp(200, "should never be reached", { "content-type": "text/plain" }),
        { body: activationFailureXml({ uri: classUri, text: "Syntax error near LOOP" }) },
      ),
    );

    await expect(runFpmRead(conn, query, allowingGate())).rejects.toMatchObject({ code: "CHECK_FAILED" });
  });
});
