/**
 * ===========================================================================
 * HONESTY BANNER — READ BEFORE TRUSTING A GREEN RUN OF THIS FILE
 * ===========================================================================
 * EVERY assertion in this file runs against a FAKE: either
 *
 *   (a) a *string* of ABAP source text that `src/adt/fpm-lock.ts` generated but
 *       that no SAP system has compiled, activated or executed here; or
 *   (b) a transcript this test file typed out by hand in the bracket-field
 *       grammar, which the real bridge class never produced; or
 *   (c) an offline `RecordingClient` HTTP fake that answers ADT requests from a
 *       lookup table.
 *
 * Consequently NOTHING in this file proves anything about the real enqueue
 * server. In particular a green run here does NOT prove that:
 *   - `ENQUEUE_E_WDY_CONFCOMP` accepts the parameters we emit, or that its
 *     `MODE_*` default really is `'E'`;
 *   - `_SCOPE = '1'` on both sides actually releases the lock;
 *   - the three `X_CONFIG_*` flags actually produce a *precise* lock rather
 *     than a wildcard one;
 *   - `ENQUEUE_READ` with `GUNAME = space` / `GCLIENT = space` really returns
 *     other users' rows;
 *   - `GUSR` really discriminates our session from another session of the same
 *     SAP user;
 *   - the generated class even ACTIVATES.
 *
 * Those are wire guarantees, and the ONLY place in this repo where they are
 * proved against the live appliance is:
 *
 *     test/integration-fpm-lock.test.ts
 *
 * This is the repo's standing lesson ("test fakes are politer than the wire"):
 * a green fake must never be allowed to stand in for a guarantee that does not
 * exist. Each `it` below therefore carries an inline note saying what it does
 * and does NOT prove.
 *
 * Style: this file is deliberately SELF-CONTAINED — the `INJECTION_PAYLOADS`
 * array, the `expectBadInput` helper and the `RecordingClient` / `resp` /
 * `connected` fake-HTTP harness are copied verbatim from
 * `test/fpm-runtime.test.ts` rather than imported from it, matching this
 * repo's explicit convention (stated in `test/bopf-runtime.test.ts` and
 * restated in `test/fpm-runtime.test.ts`'s own header) not to share these
 * helpers across suites.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";

import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { SafetyGate } from "../src/safety.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { isAbapError, type AbapError } from "../src/adt/errors.js";
import { ERR_LINE_PREFIX } from "../src/adt/run.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";
import {
  ADT_MAX_SOURCE_LINE_LEN,
  FPM_LOCK_BRIDGE_CLASS_PREFIX,
  FPM_LOCK_OBJECTS,
  FPM_LOCK_SCOPE,
  GARG_LENGTH,
  GARG_SEGMENTS,
  GARG_WILDCARD_CHAR,
  LOCK_LINE_PREFIX,
  assertForceClearAllowed,
  assertLockBodyIsSafe,
  assertLockConfigType,
  buildForceClearSource,
  buildGarg,
  buildLockInspectSource,
  buildLockedOperationSource,
  fpmLockBridgeClassName,
  fpmLockKey,
  hasWildcardFill,
  lockKindForConfigType,
  parseGarg,
  parseLockTranscript,
  wrapAbapTemplateLines,
  type FpmLockInspectQuery,
  type FpmLockedOperation,
  type LockRow,
} from "../src/adt/fpm-lock.js";

// ---------------------------------------------------------------------------
// Helpers — copied verbatim from test/fpm-runtime.test.ts (see header)
// ---------------------------------------------------------------------------

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
  'A"; DROP',
  "A.B",
  "A B",
  "A\nB",
  "A;B",
  "<script>",
  "A%00B",
];

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

async function connected(
  route: (o: HttpClientOptions) => HttpClientResponse,
): Promise<{ conn: AbapConnection; inner: RecordingClient }> {
  const inner = new RecordingClient(route);
  // This harness is unused today (see `void connected` below) — every wire
  // claim in this file lives in test/integration-fpm-lock.test.ts instead.
  // It is still routed through the system-role probe (routeSystemRoleProbe,
  // test/system-role-probe-guard.test.ts): the guard's static scan sees
  // `new AbapConnection(` here regardless of whether any test calls
  // `connected()`, and "nonproductive" states honestly what this fake would
  // stand for if that ever changed, rather than leaving the probe silently
  // unanswered.
  const routed = routeSystemRoleProbe(inner, { answer: "nonproductive" });
  const conn = new AbapConnection(cfg(), {
    httpClient: routed,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  inner.calls.length = 0;
  return { conn, inner };
}

const allowingGate = (): SafetyGate =>
  new SafetyGate({ readOnly: false, allowPackages: ["$TMP"], writesLockedOut: false });

// Referenced so the harness above is not dead code in a file that (by design)
// makes no HTTP calls: every wire-level claim belongs to
// test/integration-fpm-lock.test.ts, not here.
void connected;
void allowingGate;
void resp;
void SESSION_URL;

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const OK_ID = "ZMCP_LK_CFG";
const KEY_00 = fpmLockKey({ configId: OK_ID, configType: "00", configVar: "" });
const KEY_02 = fpmLockKey({ configId: OK_ID, configType: "02", configVar: "V1" });

/** A benign, generator-shaped body carrying a sentinel we can locate by index. */
const BODY_SENTINEL = "ZZ_BODY_SENTINEL_MARKER";
const BENIGN_BODY = `lv_zz_marker = '${BODY_SENTINEL}'.`;
const BODY_LABEL = "save_comp_config";

const LOCKED_OP: FpmLockedOperation = { key: KEY_00, body: BENIGN_BODY, bodyLabel: BODY_LABEL };
const INSPECT_Q: FpmLockInspectQuery = { mode: "locks", configId: OK_ID, configType: "00" };

const inspectSrc = (): string => buildLockInspectSource(INSPECT_Q, fpmLockBridgeClassName(INSPECT_Q));
const lockedSrc = (): string => buildLockedOperationSource(LOCKED_OP, fpmLockBridgeClassName(LOCKED_OP));

// ---------------------------------------------------------------------------
// 1. Injection refusal
// ---------------------------------------------------------------------------

describe("injection refusal — every INJECTION_PAYLOAD is refused before it can reach generated ABAP", () => {
  // Asserts the TypeScript VALIDATORS refuse these strings. It does NOT prove
  // that ABAP would have mis-parsed them, nor that the appliance would have
  // executed anything: no generated source is compiled anywhere in this file.
  for (const bad of INJECTION_PAYLOADS) {
    it(`assertLockConfigType rejects ${JSON.stringify(bad)}`, () => {
      expectBadInput(() => assertLockConfigType(bad));
    });

    it(`fpmLockKey rejects it as configId: ${JSON.stringify(bad)}`, () => {
      expectBadInput(() => fpmLockKey({ configId: bad, configType: "00", configVar: "" }));
    });

    it(`fpmLockKey rejects it as configVar: ${JSON.stringify(bad)}`, () => {
      expectBadInput(() => fpmLockKey({ configId: OK_ID, configType: "00", configVar: bad }));
    });

    it(`fpmLockKey rejects it as configType: ${JSON.stringify(bad)}`, () => {
      expectBadInput(() => fpmLockKey({ configId: OK_ID, configType: bad, configVar: "" }));
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Key construction — landmine 2
// ---------------------------------------------------------------------------

describe("key construction (landmine 2: '00' is legitimate but IS INITIAL)", () => {
  // These assert the TS-side type/validator gate only. They do NOT prove that
  // a dropped X_CONFIG_TYPE would actually widen the enqueue on the server —
  // that behaviour was observed by the spike and is re-proved live in
  // test/integration-fpm-lock.test.ts, never here.

  const REJECTED: Array<[string, string | undefined]> = [
    ["undefined", undefined],
    ['""', ""],
    ['"  "', "  "],
    ['"0"', "0"],
    ['"000"', "000"],
    ['"0A"', "0A"],
    ['"A0"', "A0"],
    ['"0 "', "0 "],
    ['" 0"', " 0"],
  ];

  for (const [label, value] of REJECTED) {
    it(`assertLockConfigType refuses ${label}`, () => {
      expectBadInput(() => assertLockConfigType(value));
    });

    it(`fpmLockKey refuses ${label} as configType (the branded key is unconstructable)`, () => {
      expectBadInput(() =>
        fpmLockKey({ configId: OK_ID, configType: value as unknown as string, configVar: "" }),
      );
    });
  }

  it('ACCEPTS "00" — this is the entire point of landmine 2', () => {
    // "00" is a LEGITIMATE NUMC(2) config_type (it is the component-scope
    // value used repo-wide), yet in ABAP it satisfies `IS INITIAL`. A wrapper
    // that "helpfully" skips key fields that look initial silently converts a
    // precise lock into a generic/wildcard lock over EVERY config_type of that
    // config_id. So the validator must accept "00" while refusing "" / " " /
    // undefined — treating them as three different things, not one.
    expect(assertLockConfigType("00")).toBe("00");
    const key = fpmLockKey({ configId: OK_ID, configType: "00", configVar: "" });
    expect(key.configType).toBe("00");
    expect(key.kind).toBe("component");
  });

  it('"02" is the application-scope convention and picks the other lock object', () => {
    expect(lockKindForConfigType("02")).toBe("application");
    expect(lockKindForConfigType("00")).toBe("component");
    expect(lockKindForConfigType("10")).toBe("component");
    expect(KEY_02.kind).toBe("application");
  });

  it("a blank configVar is legal and is still carried as a real (blank-padded) segment", () => {
    // Asserts the GARG STRING WE BUILD, not that SAP stores it that way.
    const garg = buildGarg(KEY_00);
    expect(garg).toHaveLength(GARG_LENGTH);
    expect(garg.slice(32, 34)).toBe("00");
    expect(garg.slice(34, 40)).toBe("      ");
    expect(hasWildcardFill(garg)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Generated ABAP shape
// ---------------------------------------------------------------------------

describe("generated ABAP shape — X-flags, _SCOPE, ENQUEUE_READ filters, no IS INITIAL", () => {
  // ALL of the assertions in this block inspect a JavaScript STRING. They
  // assert the ABAP we EMIT, not that the enqueue server honours it, not that
  // the source activates, and not that the FM parameter names exist. The wire
  // proof is in test/integration-fpm-lock.test.ts.

  const SOURCES: Array<[string, () => string]> = [
    ["buildLockInspectSource", inspectSrc],
    ["buildLockedOperationSource", lockedSrc],
  ];

  for (const [name, make] of SOURCES) {
    describe(name, () => {
      it("emits one X_CONFIG_ID/X_CONFIG_TYPE/X_CONFIG_VAR triple per ENQUEUE **and** per DEQUEUE, every one a literal 'X'", () => {
        const src = make();
        const enqueues = src.match(/CALL FUNCTION 'ENQUEUE_E_WDY_CONF(COMP|APPL)'/g) ?? [];
        const dequeues = src.match(/CALL FUNCTION 'DEQUEUE_E_WDY_CONF(COMP|APPL)'/g) ?? [];
        const calls = enqueues.length + dequeues.length;
        expect(enqueues.length).toBeGreaterThan(0);
        expect(dequeues.length).toBeGreaterThan(0);

        for (const flag of ["x_config_id", "x_config_type", "x_config_var"]) {
          const re = new RegExp(`${flag}\\s*=\\s*([^\\n]*)`, "gi");
          const values = [...src.matchAll(re)].map((m) => m[1]!.trim());
          // one per enqueue AND one per dequeue — no more, no fewer
          expect(values).toHaveLength(calls);
          // and every single one is the unconditional literal 'X'
          expect(new Set(values)).toEqual(new Set(["'X'"]));
        }
      });

      it("never makes an X-flag conditional: no IS INITIAL appears anywhere in the generated ABAP", () => {
        // The sloppy-enqueue hazard in one assertion. This proves the emitted text
        // contains no such test; it does NOT prove the server treats a
        // missing flag as a wildcard (that is the spike's live finding).
        expect(make()).not.toMatch(/IS\s+INITIAL/i);
      });

      it("emits _SCOPE explicitly on both the enqueue and the dequeue, from the single FPM_LOCK_SCOPE constant", () => {
        const src = make();
        const calls =
          (src.match(/CALL FUNCTION '(EN|DE)QUEUE_E_WDY_CONF(COMP|APPL)'/g) ?? []).length;
        const scopes = [...src.matchAll(/_scope\s*=\s*'([^']*)'/g)].map((m) => m[1]!);
        expect(scopes).toHaveLength(calls);
        // Derived from the constant, NOT hardcoded: the whole point of
        // FPM_LOCK_SCOPE is that enqueue and dequeue cannot disagree, so a
        // test that hardcoded '1' would keep passing if one side drifted.
        expect(new Set(scopes)).toEqual(new Set([FPM_LOCK_SCOPE]));
      });

      it("never passes a MODE_* parameter to the ENQUEUE FM (the spike does not state its name for CONFCOMP)", () => {
        // Asserts an ABSENCE in emitted text. It does NOT prove the FM's
        // default really is 'E' — that is an inferred fact carried in the
        // module header and only checkable on the wire.
        const src = make();
        expect(src).not.toMatch(/\bmode_\w+/i);
      });

      it("calls ENQUEUE_READ with GUNAME = space and GCLIENT = space (its defaults are SY-UNAME / SY-MANDT)", () => {
        const src = make();
        const from = src.indexOf("CALL FUNCTION 'ENQUEUE_READ'");
        expect(from).toBeGreaterThan(-1);
        const block = src.slice(from, src.indexOf("ENDMETHOD.", from));
        expect(block).toMatch(/\bguname\s+=\s+space\b/);
        expect(block).toMatch(/\bgclient\s+=\s+space\b/);
        // Asserts the call we EMIT. Whether blanking those filters really
        // reveals another user's rows is a wire fact, proved live only in
        // test/integration-fpm-lock.test.ts.
      });

      it("uses the lock object / FM / GNAME triple recorded by the spike", () => {
        const src = make();
        const comp = FPM_LOCK_OBJECTS.component;
        expect(src).toContain(comp.enqueueFm);
        expect(src).toContain(comp.dequeueFm);
        expect(src).toContain(`'${comp.gname}'`);
      });
    });
  }

  it("an application-scope key (config_type 02) generates the CONFAPPL FMs, not CONFCOMP", () => {
    // Text-only assertion; no ADT call is made and nothing is activated.
    const op: FpmLockedOperation = { key: KEY_02, body: BENIGN_BODY, bodyLabel: BODY_LABEL };
    const src = buildLockedOperationSource(op, fpmLockBridgeClassName(op));
    expect(src).toContain(FPM_LOCK_OBJECTS.application.enqueueFm);
    expect(src).toContain(FPM_LOCK_OBJECTS.application.dequeueFm);
    expect(src).toContain(`'${FPM_LOCK_OBJECTS.application.gname}'`);
  });

  it("the DEQUEUE narration carries note=[subrc-is-not-evidence] (landmine 1, said on the wire)", () => {
    // Asserts that we EMIT the disclaimer, not that DEQUEUE actually lies.
    expect(lockedSrc()).toContain("note=[subrc-is-not-evidence]");
  });
});

// ---------------------------------------------------------------------------
// 4. Ordering guarantee
// ---------------------------------------------------------------------------

describe("ordering guarantee: the body is unreachable unless the pre-save verify passed", () => {
  it("emits the caller's body at a character index strictly AFTER the pre-save VERIFY emission", () => {
    // This is a lexical/text assertion about generated source. It proves the
    // ORDER OF THE TEXT WE EMIT. It does NOT prove ABAP executes it in that
    // order (it does, trivially), and above all it does NOT prove that
    // SAVE_COMP_CONFIG_TO_DB respects the lock — that was the original
    // finding, and only test/integration-fpm-lock.test.ts touches the wire.
    const src = lockedSrc();
    const verifyIdx = src.indexOf(`${LOCK_LINE_PREFIX}VERIFY phase=[presave]`);
    const bodyIdx = src.indexOf(BODY_SENTINEL);
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(bodyIdx).toBeGreaterThan(-1);
    expect(bodyIdx).toBeGreaterThan(verifyIdx);
  });

  it("nests the body inside a hard IF/ELSE/ENDIF guard whose ELSE branch can only emit a GUARD line", () => {
    const src = lockedSrc();
    const verifyIdx = src.indexOf(`${LOCK_LINE_PREFIX}VERIFY phase=[presave]`);
    const guardIf = src.indexOf("IF lv_lk_held = 'X' AND lv_lk_mine = 'X' AND lv_lk_wild = '-'.", verifyIdx);
    const bodyIdx = src.indexOf(BODY_SENTINEL);
    const elseIdx = src.indexOf("ELSE.", bodyIdx);
    const guardEmit = src.indexOf("emit_guard( iv_reason = 'presave-verify-failed'", elseIdx);
    const endIf = src.indexOf("ENDIF.", guardEmit);

    // IF ... <body> ... ELSE. <GUARD> ENDIF. — in that textual order.
    expect(guardIf).toBeGreaterThan(-1);
    expect(guardIf).toBeLessThan(bodyIdx);
    expect(elseIdx).toBeGreaterThan(bodyIdx);
    expect(guardEmit).toBeGreaterThan(elseIdx);
    expect(endIf).toBeGreaterThan(guardEmit);
    // Structural, not procedural: there is no "verified" flag consulted later.
    // Again — asserts the ABAP we EMIT only.
  });

  it("the body is followed by a post-body re-verify and then the release, in that order", () => {
    const src = lockedSrc();
    const bodyIdx = src.indexOf(BODY_SENTINEL);
    const postbody = src.indexOf(`${LOCK_LINE_PREFIX}VERIFY phase=[postbody]`);
    const deq = src.indexOf("CALL FUNCTION 'DEQUEUE_E_WDY_CONFCOMP'", bodyIdx);
    const release = src.indexOf(`${LOCK_LINE_PREFIX}RELEASE status=`);
    expect(postbody).toBeGreaterThan(bodyIdx);
    expect(deq).toBeGreaterThan(postbody);
    expect(release).toBeGreaterThan(deq);
  });

  it("the enqueue-refused path emits a GUARD and never reaches the body", () => {
    // Text assertion: an `ELSE` on `IF lv_lk_subrc = 0.` that only guards.
    const src = lockedSrc();
    expect(src).toContain("emit_guard( iv_reason = 'enqueue-refused'");
  });
});

// ---------------------------------------------------------------------------
// 5. Wildcard detection — REAL captured bytes from the spike
// ---------------------------------------------------------------------------

describe("wildcard detection against the spike's REAL captured GARG bytes", () => {
  // These four hex strings are copied VERBATIM from the lock-discipline
  // spike — they are bytes the live A4H appliance actually returned from
  // ENQUEUE_READ, not bytes this test invented.
  //
  // The load-bearing detail: the wildcard fill is `EF BF BF`, i.e. UTF-8 for
  // **U+FFFF**, NOT the single byte `0xFF` that anyone who has only read the
  // phrase "high values" would assume. HX2 carries 2 x EFBFBF (the 2-char
  // CONFIG_TYPE segment); HX4 carries 8 x EFBFBF (CONFIG_TYPE + CONFIG_VAR).
  // That is why HX1/HX3 are 150 utf8 bytes but HX2 is 154 and HX4 is 166.
  //
  // Decoding these here is still an OFFLINE assertion: it proves our parser
  // reads bytes the appliance once produced. It does NOT prove the appliance
  // still produces them, nor that omitting an X-flag produces them today.
  // test/integration-fpm-lock.test.ts is the only live check.

  const HX1_HEX =
    "5A4D43505F4C4B5F48583120202020202020202020202020202020202020202030302020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020";
  const HX3_HEX =
    "5A4D43505F4C4B5F48583320202020202020202020202020202020202020202031302020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020";
  const HX2_HEX =
    "5A4D43505F4C4B5F485832202020202020202020202020202020202020202020EFBFBFEFBFBF2020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020";
  const HX4_HEX =
    "5A4D43505F4C4B5F485834202020202020202020202020202020202020202020EFBFBFEFBFBFEFBFBFEFBFBFEFBFBFEFBFBFEFBFBFEFBFBF2020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020";

  const HX1 = Buffer.from(HX1_HEX, "hex").toString("utf8");
  const HX2 = Buffer.from(HX2_HEX, "hex").toString("utf8");
  const HX3 = Buffer.from(HX3_HEX, "hex").toString("utf8");
  const HX4 = Buffer.from(HX4_HEX, "hex").toString("utf8");

  it("the fixtures really are the spike's bytes: 150 characters, and EF BF BF decodes to U+FFFF (not 0xFF)", () => {
    for (const [name, hex, g] of [
      ["HX1", HX1_HEX, HX1],
      ["HX2", HX2_HEX, HX2],
      ["HX3", HX3_HEX, HX3],
      ["HX4", HX4_HEX, HX4],
    ] as const) {
      expect(g, name).toHaveLength(GARG_LENGTH); // CHAR(150), always
      expect(Buffer.from(hex, "hex")).toHaveLength(g === HX2 ? 154 : g === HX4 ? 166 : 150);
    }
    expect(GARG_WILDCARD_CHAR).toBe("￿");
    expect(GARG_WILDCARD_CHAR.charCodeAt(0)).toBe(0xffff);
    expect(Buffer.from(GARG_WILDCARD_CHAR, "utf8").toString("hex").toUpperCase()).toBe("EFBFBF");
    // Explicitly NOT 0xFF:
    expect(HX2).not.toContain("ÿ");
  });

  it("hasWildcardFill is false for the two PRECISE captures (HX1, HX3)", () => {
    // Real bytes, offline check. Proves our detector reads what the appliance
    // wrote; proves nothing about what it writes now.
    expect(hasWildcardFill(HX1)).toBe(false);
    expect(hasWildcardFill(HX3)).toBe(false);
  });

  it("hasWildcardFill is true for the two GENERIC captures (HX2, HX4)", () => {
    expect(hasWildcardFill(HX2)).toBe(true);
    expect(hasWildcardFill(HX4)).toBe(true);
  });

  it("parseGarg(HX2) names exactly the configType segment as wildcard-filled", () => {
    const view = parseGarg(HX2);
    expect(view.wildcardSegments).toEqual(["configType"]);
    expect(view.isWildcard).toBe(true);
    expect(view.configId).toBe("ZMCP_LK_HX2");
  });

  it("parseGarg(HX4) names both configType and configVar as wildcard-filled", () => {
    const view = parseGarg(HX4);
    expect(view.wildcardSegments).toEqual(["configType", "configVar"]);
    expect(view.isWildcard).toBe(true);
    expect(view.configId).toBe("ZMCP_LK_HX4");
  });

  it('parseGarg(HX1).configType === "00" — the legitimate NUMC2 value that IS INITIAL would have eaten', () => {
    const view = parseGarg(HX1);
    expect(view.configType).toBe("00");
    expect(view.configId).toBe("ZMCP_LK_HX1");
    expect(view.configVar).toBe("");
    expect(view.isWildcard).toBe(false);
  });

  it('parseGarg(HX3).configType === "10"', () => {
    const view = parseGarg(HX3);
    expect(view.configType).toBe("10");
    expect(view.configId).toBe("ZMCP_LK_HX3");
    expect(view.isWildcard).toBe(false);
  });

  it("a GARG that arrived trailing-trimmed by ABAP (STRLEN 34) still parses identically", () => {
    // The wire trims trailing blanks on the C -> STRING conversion, which is
    // exactly the spike's `STRLEN-trimmed=34`. parseGarg pads back.
    expect(HX1.trimEnd()).toHaveLength(34);
    expect(parseGarg(HX1.trimEnd())).toMatchObject({ configType: "00", isWildcard: false });
  });
});

// ---------------------------------------------------------------------------
// 6. Transcript parsing
// ---------------------------------------------------------------------------

/** HX1, trailing-trimmed exactly as the ABAP `garg=[...]` field arrives. */
const GARG_MINE = Buffer.from(
  "5A4D43505F4C4B5F48583120202020202020202020202020202020202020202030302020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020",
  "hex",
)
  .toString("utf8")
  .trimEnd();
/** HX3, likewise — a DIFFERENT config_type, held by a different owner id. */
const GARG_OTHER = Buffer.from(
  "5A4D43505F4C4B5F48583320202020202020202020202020202020202020202031302020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020",
  "hex",
)
  .toString("utf8")
  .trimEnd();

const SELF_OWNER = "0000000042";
const FOREIGN_OWNER = "0000000077";

function rowLine(phase: string, garg: string, gusr: string): string {
  return (
    `${LOCK_LINE_PREFIX}ROW phase=[${phase}] gname=[WDY_CONFIG_DATA] garg=[${garg}] gmode=[E] ` +
    `guname=[DEVELOPER] gclient=[001] gusr=[${gusr}] gusrvb=[] guse=[1] gusevb=[0] gobj=[E_WDY_CONFCOMP]`
  );
}

describe("parseLockTranscript — the bracket-field grammar", () => {
  // EVERY transcript in this block was typed by hand into the grammar the
  // generated ABAP is *supposed* to emit. No bridge class produced any of it.
  // These tests prove the PARSER is consistent with the grammar; they prove
  // nothing about whether the real bridge emits that grammar. Only
  // test/integration-fpm-lock.test.ts reads a transcript that SAP produced.

  const HAPPY =
    `${LOCK_LINE_PREFIX}SELF owner=[${SELF_OWNER}] ok=[X]\n` +
    `${LOCK_LINE_PREFIX}ENQ fm=[ENQUEUE_E_WDY_CONFCOMP] subrc=[0] exc=[none] scope=[${FPM_LOCK_SCOPE}]\n` +
    `${rowLine("after-acquire", GARG_MINE, SELF_OWNER)}\n` +
    `${rowLine("after-acquire", GARG_OTHER, FOREIGN_OWNER)}\n` +
    `${LOCK_LINE_PREFIX}COUNT phase=[after-acquire] rows=[2]\n` +
    `${LOCK_LINE_PREFIX}VERIFY phase=[presave] held=[X] mine=[X] wildcard=[-] passed=[X]\n` +
    `${LOCK_LINE_PREFIX}BODY label=[${BODY_LABEL}] state=[begin]\n` +
    `${LOCK_LINE_PREFIX}BODY label=[${BODY_LABEL}] state=[end]\n` +
    `${LOCK_LINE_PREFIX}VERIFY phase=[postbody] held=[X] mine=[X] wildcard=[-] passed=[X]\n` +
    `${LOCK_LINE_PREFIX}GUARD reason=[lock-lost-during-body] detail=[narration only]\n` +
    `${LOCK_LINE_PREFIX}DEQ fm=[DEQUEUE_E_WDY_CONFCOMP] subrc=[0] scope=[${FPM_LOCK_SCOPE}] note=[subrc-is-not-evidence]\n` +
    `${LOCK_LINE_PREFIX}COUNT phase=[after-release] rows=[0]\n` +
    `${LOCK_LINE_PREFIX}RELEASE status=[released] remaining=[0]\n` +
    `${ERR_LINE_PREFIX}ENQUEUE_READ failed subrc=2 gname=WDY_CONFIG_APPL\n` +
    `some ADT/HTTP framing noise that is neither LCK> nor ZMCP-ERR>\n` +
    `${LOCK_LINE_PREFIX}BANANA phase=[a-head-this-parser-does-not-know]\n`;

  it("populates every field of FpmLockTranscript from a full happy-path transcript", () => {
    const t = parseLockTranscript(HAPPY);

    expect(t.selfOwnerId).toBe(SELF_OWNER);
    expect(t.acquire).toEqual({ subrc: 0, foreignLock: false, systemFailure: false });
    expect(t.preSaveVerify).toEqual({ held: true, mine: true, wildcard: false, passed: true });
    expect(t.saveReached).toBe(true);
    expect(t.release).toEqual({ status: "released" });
    expect(t.wildcardDetected).toBe(false);
    expect(t.aborts).toEqual(["lock-lost-during-body: narration only"]);
    expect(t.diagnostics).toEqual([
      `${ERR_LINE_PREFIX}ENQUEUE_READ failed subrc=2 gname=WDY_CONFIG_APPL`,
    ]);

    // A COUNT line creates a phase snapshot just as a ROW line does. This
    // assertion used to demand the opposite ("only ROW lines create a phase"),
    // and that was wrong in the one direction that matters: `emit_rows` emits a
    // COUNT for every phase it runs, so a phase that found NOTHING produces a
    // COUNT and no ROWs. Dropping it made a verified-empty `after-release`
    // indistinguishable from a release that was never re-read at all — i.e. the
    // evidence of a successful release was the evidence being discarded. Caught
    // by the live suite, whose `after-release` phase was simply missing.
    expect(t.phases.map((p) => p.phase)).toEqual(["after-acquire", "after-release"]);
    expect(t.phases[0]!.rows).toHaveLength(2);
    expect(t.phases[0]!.reportedRows).toBe(2);
    expect(t.phases[1]!.rows).toHaveLength(0);
    expect(t.phases[1]!.reportedRows).toBe(0);
    // COUNT agreed with the ROW lines in both phases, so nothing is suspected
    // of truncation.
    expect(t.diagnostics.some((d) => d.includes("truncated"))).toBe(false);
  });

  it("flags a COUNT that disagrees with the ROW lines as possible truncation", () => {
    // The dangerous direction: rows lost in transit would otherwise read as
    // "fewer locks are held than really are".
    const t = parseLockTranscript(
      `${LOCK_LINE_PREFIX}SELF owner=[${SELF_OWNER}] ok=[X]\n` +
        `${rowLine("after-acquire", GARG_MINE, SELF_OWNER)}\n` +
        `${LOCK_LINE_PREFIX}COUNT phase=[after-acquire] rows=[3]\n`,
    );
    expect(t.phases[0]!.rows).toHaveLength(1);
    expect(t.phases[0]!.reportedRows).toBe(3);
    expect(t.diagnostics.some((d) => /reported 3 row\(s\).*1 ROW line/.test(d))).toBe(true);
  });

  it("classifies MINE vs FOREIGN purely on GUSR against the self-lock's owner id", () => {
    // GUNAME is DEVELOPER on both rows: the spike found GUNAME cannot tell two
    // sessions of the same user apart. Only GUSR can. Asserted here against a
    // hand-built transcript — the live discrimination is proved in
    // test/integration-fpm-lock.test.ts.
    const rows = parseLockTranscript(HAPPY).phases[0]!.rows;
    expect(rows[0]!.guname).toBe("DEVELOPER");
    expect(rows[1]!.guname).toBe("DEVELOPER");
    expect(rows[0]!.gusr).toBe(SELF_OWNER);
    expect(rows[0]!.ownership).toBe("MINE");
    expect(rows[1]!.gusr).toBe(FOREIGN_OWNER);
    expect(rows[1]!.ownership).toBe("FOREIGN");
  });

  it("maps every SEQG3 field of a ROW line and attaches a parsed GargView", () => {
    const row = parseLockTranscript(HAPPY).phases[0]!.rows[0]!;
    expect(row).toMatchObject({
      gname: "WDY_CONFIG_DATA",
      garg: GARG_MINE,
      gmode: "E",
      guname: "DEVELOPER",
      gclient: "001",
      gusr: SELF_OWNER,
      gusrvb: "",
      guse: "1",
      gusevb: "0",
      gobj: "E_WDY_CONFCOMP",
    });
    expect(row.garg_view.configId).toBe("ZMCP_LK_HX1");
    expect(row.garg_view.configType).toBe("00");
    expect(row.garg_view.isWildcard).toBe(false);
  });

  it("counts unknown lines in droppedLines: an unprefixed line AND an LCK> line with an unknown head", () => {
    expect(parseLockTranscript(HAPPY).droppedLines).toBe(2);
  });

  it("blank unprefixed lines are ADT/HTTP framing, not dropped lines", () => {
    const t = parseLockTranscript(`${LOCK_LINE_PREFIX}COUNT phase=[inspect] rows=[0]\n\n\n`);
    expect(t.droppedLines).toBe(0);
  });

  it("without a usable SELF line every row is UNKNOWN — never optimistically MINE", () => {
    const raw =
      `${LOCK_LINE_PREFIX}SELF owner=[] ok=[-]\n` + `${rowLine("inspect", GARG_MINE, SELF_OWNER)}\n`;
    const t = parseLockTranscript(raw);
    expect(t.selfOwnerId).toBeUndefined();
    expect(t.phases[0]!.rows[0]!.ownership).toBe("UNKNOWN");
  });

  it("a WILDCARD line, and a wildcard-filled ROW garg, each set wildcardDetected", () => {
    const wildGarg = Buffer.from(
      "5A4D43505F4C4B5F485832202020202020202020202020202020202020202020EFBFBFEFBFBF",
      "hex",
    ).toString("utf8");
    const viaLine = parseLockTranscript(
      `${LOCK_LINE_PREFIX}WILDCARD phase=[inspect] garg=[x] segments=[configType]\n`,
    );
    expect(viaLine.wildcardDetected).toBe(true);

    const viaRow = parseLockTranscript(`${rowLine("inspect", wildGarg, SELF_OWNER)}\n`);
    expect(viaRow.wildcardDetected).toBe(true);
    expect(viaRow.phases[0]!.rows[0]!.garg_view.wildcardSegments).toEqual(["configType"]);
  });

  it("a FOREIGN_LOCK acquire (subrc=1) is recorded as such and the body is reported as not reached", () => {
    const raw =
      `${LOCK_LINE_PREFIX}SELF owner=[${SELF_OWNER}] ok=[X]\n` +
      `${LOCK_LINE_PREFIX}ENQ fm=[ENQUEUE_E_WDY_CONFCOMP] subrc=[1] exc=[foreign_lock] scope=[${FPM_LOCK_SCOPE}]\n` +
      `${LOCK_LINE_PREFIX}GUARD reason=[enqueue-refused] detail=[subrc=1 - the body was not run]\n`;
    const t = parseLockTranscript(raw);
    expect(t.acquire).toEqual({ subrc: 1, foreignLock: true, systemFailure: false });
    expect(t.saveReached).toBe(false);
    expect(t.aborts).toEqual(["enqueue-refused: subrc=1 - the body was not run"]);
  });

  it("handles empty input without throwing", () => {
    const t = parseLockTranscript("");
    expect(t.phases).toEqual([]);
    expect(t.saveReached).toBe(false);
    expect(t.release).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7. Release verification — landmine 1
// ---------------------------------------------------------------------------

describe('release verification: "still-held" wins over a subrc=0 DEQUEUE', () => {
  // LANDMINE 1: DEQUEUE_* declares NO exceptions and returns
  // subrc = 0 even when it released nothing. SUBRC IS NOT EVIDENCE. The only
  // proof a lock is gone is a fresh ENQUEUE_READ that no longer shows it.
  //
  // Both tests below feed a HAND-BUILT transcript. They prove the PARSER
  // refuses to treat subrc as evidence. They do NOT prove that DEQUEUE really
  // lies about what it released — that is the spike's live observation, and
  // test/integration-fpm-lock.test.ts is the only place it is re-proved.

  const STILL_HELD =
    `${LOCK_LINE_PREFIX}SELF owner=[${SELF_OWNER}] ok=[X]\n` +
    `${LOCK_LINE_PREFIX}ENQ fm=[ENQUEUE_E_WDY_CONFCOMP] subrc=[0] exc=[none] scope=[${FPM_LOCK_SCOPE}]\n` +
    `${LOCK_LINE_PREFIX}VERIFY phase=[presave] held=[X] mine=[X] wildcard=[-] passed=[X]\n` +
    `${LOCK_LINE_PREFIX}BODY label=[${BODY_LABEL}] state=[begin]\n` +
    `${LOCK_LINE_PREFIX}BODY label=[${BODY_LABEL}] state=[end]\n` +
    // DEQUEUE says everything is fine...
    `${LOCK_LINE_PREFIX}DEQ fm=[DEQUEUE_E_WDY_CONFCOMP] subrc=[0] scope=[${FPM_LOCK_SCOPE}] note=[subrc-is-not-evidence]\n` +
    // ...but the re-read STILL shows our row.
    `${rowLine("after-release", GARG_MINE, SELF_OWNER)}\n` +
    `${LOCK_LINE_PREFIX}COUNT phase=[after-release] rows=[1]\n` +
    `${LOCK_LINE_PREFIX}RELEASE status=[still-held] remaining=[1]\n` +
    `${LOCK_LINE_PREFIX}GUARD reason=[release-not-verified] detail=[DEQUEUE returned but a re-read still shows the lock]\n`;

  it('parses to release.status === "still-held" and carries the surviving row', () => {
    const t = parseLockTranscript(STILL_HELD);
    expect(t.release).toBeDefined();
    expect(t.release!.status).toBe("still-held");
    const rows = (t.release as { status: "still-held"; rows: typeof t.phases[0]["rows"] }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.garg).toBe(GARG_MINE);
    expect(rows[0]!.ownership).toBe("MINE");
    expect(t.aborts).toContain(
      "release-not-verified: DEQUEUE returned but a re-read still shows the lock",
    );
  });

  it('a DEQ line with subrc=[0] is NOT enough to make the outcome "released"', () => {
    // Same transcript with the RELEASE verdict line removed entirely: a
    // successful-looking DEQUEUE plus a surviving after-release row must NOT
    // be optimistically read as a release.
    const noVerdict = STILL_HELD.split("\n")
      .filter((l) => !l.startsWith(`${LOCK_LINE_PREFIX}RELEASE `))
      .join("\n");
    const t = parseLockTranscript(noVerdict);
    expect(t.release).toBeUndefined();
    expect(t.release).not.toEqual({ status: "released" });
    // And the row the re-read found is still visible in the phase snapshot,
    // so a caller cannot mistake "no verdict" for "nothing left".
    const after = t.phases.find((p) => p.phase === "after-release");
    expect(after!.rows).toHaveLength(1);
  });

  it('the clean case still reports "released" — the guard is not a blanket pessimism', () => {
    const raw =
      `${LOCK_LINE_PREFIX}SELF owner=[${SELF_OWNER}] ok=[X]\n` +
      `${LOCK_LINE_PREFIX}DEQ fm=[DEQUEUE_E_WDY_CONFCOMP] subrc=[0] scope=[${FPM_LOCK_SCOPE}] note=[subrc-is-not-evidence]\n` +
      `${LOCK_LINE_PREFIX}COUNT phase=[after-release] rows=[0]\n` +
      `${LOCK_LINE_PREFIX}RELEASE status=[released] remaining=[0]\n`;
    expect(parseLockTranscript(raw).release).toEqual({ status: "released" });
  });
});

// ---------------------------------------------------------------------------
// 8. forceClear safety gate
// ---------------------------------------------------------------------------

describe("forceClear safety gate (ENQUE_DELETE is genuinely destructive)", () => {
  it("assertForceClearAllowed({}) throws", () => {
    expect(() => assertForceClearAllowed({})).toThrow();
    try {
      assertForceClearAllowed({});
    } catch (e) {
      expect(isAbapError(e)).toBe(true);
      // NOTE / DEVIATION: the original design called for AbapError("REFUSED",...),
      // but "REFUSED" is not a member of AbapErrorCode in src/adt/errors.ts.
      // The module deliberately uses "SAFETY_DENIED" and documents the
      // substitution at assertForceClearAllowed. Asserted as-is rather than
      // "fixed" here — the test must describe the module, not the wish.
      expect((e as AbapError).code).toBe("SAFETY_DENIED");
    }
  });

  it("assertForceClearAllowed({ allowForceClear: false }) throws", () => {
    expect(() => assertForceClearAllowed({ allowForceClear: false })).toThrow();
  });

  it("assertForceClearAllowed({ allowForceClear: true }) does not throw", () => {
    expect(() => assertForceClearAllowed({ allowForceClear: true })).not.toThrow();
  });

  it("is deliberately UNWIRED: no file under src/tools/ references forceClear or buildForceClearSource", () => {
    // A source grep, not a behavioural test. It proves no *static* reference
    // exists in this tree today. It does not prove the escape hatch is
    // unreachable by some future dynamic path, and it proves nothing about
    // ENQUE_DELETE's real behaviour (which the spike found is destructive and
    // whose SUBRC is worthless).
    const toolsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "tools");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith(".ts")) files.push(full);
      }
    };
    walk(toolsDir);
    expect(files.length).toBeGreaterThan(0);

    const offenders = files.filter((f) => {
      const text = readFileSync(f, "utf8");
      return /forceClear|buildForceClearSource|ForceClearOptions|ENQUE_DELETE/i.test(text);
    });
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 9. assertLockBodyIsSafe
// ---------------------------------------------------------------------------

describe("assertLockBodyIsSafe — defense in depth around a generator-produced body", () => {
  // Pure string inspection. It proves the guard REFUSES these tokens; it does
  // NOT prove that an accepted body is semantically safe ABAP, nor that it
  // compiles. Nothing here is executed by SAP.

  const REFUSED: Array<[string, string]> = [
    ["DEQUEUE", "CALL FUNCTION 'DEQUEUE_E_WDY_CONFCOMP'."],
    ["ENQUE_DELETE", "CALL FUNCTION 'ENQUE_DELETE'."],
    ["the LCK> transcript prefix", "mo_out->write( 'LCK> RELEASE status=[released]' )."],
    ["RETURN", "IF 1 = 2. RETURN. ENDIF."],
    ["LEAVE", "LEAVE PROGRAM."],
  ];

  for (const [what, body] of REFUSED) {
    it(`refuses a body containing ${what}`, () => {
      const err = expectBadInput(() => assertLockBodyIsSafe(body, BODY_LABEL));
      expect(err.message).toMatch(/refused/i);
    });
  }

  it("accepts a benign generator-produced body and returns it normalised", () => {
    expect(assertLockBodyIsSafe(BENIGN_BODY, BODY_LABEL)).toBe(BENIGN_BODY);
    const multi = "lv_a = 1.\r\nlv_b = 2.   \r\n";
    // CRLF folded, trailing whitespace stripped per line.
    expect(assertLockBodyIsSafe(multi, BODY_LABEL)).toBe("lv_a = 1.\nlv_b = 2.\n");
  });

  it("refuses an empty body — a lock with nothing to protect is pure contention", () => {
    expectBadInput(() => assertLockBodyIsSafe("   \n  ", BODY_LABEL));
  });

  it("refuses an unbalanced ABAP string literal (it would swallow the release statements)", () => {
    expectBadInput(() => assertLockBodyIsSafe("lv_a = 'oops.", BODY_LABEL));
  });

  it("buildLockedOperationSource refuses the same bodies (the guard is not bypassable via the generator)", () => {
    for (const [, body] of REFUSED) {
      const op = { key: KEY_00, body, bodyLabel: BODY_LABEL } as FpmLockedOperation;
      expectBadInput(() => buildLockedOperationSource(op, "ZCL_ZMCP_FPMLK_X"));
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Bridge class naming
// ---------------------------------------------------------------------------

describe("fpmLockBridgeClassName", () => {
  // Naming is pure TypeScript. It proves determinism and the 30-char limit; it
  // does NOT prove ADT accepts the name or that $TMP creation succeeds.

  it("is deterministic: a value-equal query produces the identical name", () => {
    expect(fpmLockBridgeClassName(INSPECT_Q)).toBe(fpmLockBridgeClassName({ ...INSPECT_Q }));
    expect(fpmLockBridgeClassName(LOCKED_OP)).toBe(fpmLockBridgeClassName({ ...LOCKED_OP }));
  });

  it("never exceeds ABAP's 30-char object-name limit and always starts with FPM_LOCK_BRIDGE_CLASS_PREFIX", () => {
    for (const q of [INSPECT_Q, LOCKED_OP, { ...INSPECT_Q, configType: undefined }]) {
      const name = fpmLockBridgeClassName(q);
      expect(name.length).toBeLessThanOrEqual(30);
      expect(name.startsWith(FPM_LOCK_BRIDGE_CLASS_PREFIX)).toBe(true);
      expect(name).toMatch(/^[A-Z0-9_]+$/);
    }
  });

  it("differs for different keys, different modes, and different bodies", () => {
    const names = new Set([
      fpmLockBridgeClassName(INSPECT_Q),
      fpmLockBridgeClassName({ ...INSPECT_Q, configType: "02" }),
      fpmLockBridgeClassName({ ...INSPECT_Q, configId: "ZMCP_LK_OTHER" }),
      fpmLockBridgeClassName({ ...INSPECT_Q, configType: undefined }),
      fpmLockBridgeClassName(LOCKED_OP),
      fpmLockBridgeClassName({ ...LOCKED_OP, key: KEY_02 }),
      // Same key and label, different ABAP: must NOT share a bridge class, or
      // writeObject's byte-identical skip would serve one body for another.
      fpmLockBridgeClassName({ ...LOCKED_OP, body: "lv_zz_other = 1." }),
      fpmLockBridgeClassName({ ...LOCKED_OP, bodyLabel: "other_label" }),
    ]);
    expect(names.size).toBe(8);
  });

  it("validates before hashing: a malformed query throws BAD_INPUT rather than naming a class", () => {
    expectBadInput(() => fpmLockBridgeClassName({ mode: "locks", configId: "A'B" }));
    expectBadInput(() => fpmLockBridgeClassName({ mode: "locks", configId: OK_ID, configType: "0" }));
  });
});

// ---------------------------------------------------------------------------
// 11. parseBracketFields tolerates a `]` embedded in a field value
// ---------------------------------------------------------------------------

describe("parseBracketFields via parseLockTranscript: an embedded `]` does not truncate a value", () => {
  // Hand-typed transcript line, exercising the PARSER only — no bridge class
  // produced this text. It proves the parser's bracket-field grammar is
  // robust to a `]` inside a value. It does NOT prove any real SEQG3-GARG the
  // appliance returns actually contains one — but a foreign lock's GARG is
  // not under our control, so this is a real robustness property to have
  // regardless. Only test/integration-fpm-lock.test.ts reads a transcript SAP
  // actually produced.

  it('a garg=[A]B] value round-trips intact as "A]B", and the following gmode=[E] field on the same line still parses', () => {
    const raw =
      `${LOCK_LINE_PREFIX}ROW phase=[inspect] gname=[WDY_CONFIG_DATA] garg=[A]B] gmode=[E] ` +
      `guname=[DEVELOPER] gclient=[001] gusr=[${SELF_OWNER}] gusrvb=[] guse=[1] gusevb=[0] ` +
      `gobj=[E_WDY_CONFCOMP]\n`;
    const t = parseLockTranscript(raw);
    expect(t.droppedLines).toBe(0);
    const row = t.phases[0]!.rows[0]!;
    expect(row.garg).toBe("A]B");
    expect(row.gmode).toBe("E");
    // The rest of the line did not desynchronise because of the embedded `]`.
    expect(row.gname).toBe("WDY_CONFIG_DATA");
    expect(row.guname).toBe("DEVELOPER");
    expect(row.gobj).toBe("E_WDY_CONFCOMP");
  });
});

// ---------------------------------------------------------------------------
// 12. buildForceClearSource fails CLOSED when the GARG cannot be faithfully
//     reconstructed
// ---------------------------------------------------------------------------

describe("buildForceClearSource: a non-reconstructible GARG must never be reported released", () => {
  // ALL assertions below inspect generated ABAP TEXT. They prove the
  // generator emits a hard-coded still-held verdict plus a GUARD when the
  // reconstruction is lossy, and the ordinary conditional released/still-held
  // pair when it is not. They do NOT prove ENQUE_DELETE deletes, or fails to
  // delete, anything on a real system — no offline test can prove that.
  // forceClear is not wired to any MCP tool in this repo; if it ever is,
  // test/integration-fpm-lock.test.ts is the only place that could show
  // ENQUE_DELETE actually deleting a row.

  const segLen = (name: "configId" | "configType" | "configVar"): number =>
    GARG_SEGMENTS[name][1] - GARG_SEGMENTS[name][0];

  function seqgRow(garg: string): LockRow {
    return {
      gname: FPM_LOCK_OBJECTS.component.gname,
      garg,
      gmode: "E",
      guname: "DEVELOPER",
      gclient: "001",
      gusr: SELF_OWNER,
      gusrvb: "",
      guse: "1",
      gusevb: "0",
      gobj: "E_WDY_CONFCOMP",
      garg_view: parseGarg(garg),
      ownership: "FOREIGN",
    };
  }

  // Faithful: an ordinary precise GARG, built the same way the module itself
  // builds one. reconstructForceClearGarg (private) rebuilds it segment by
  // segment and must land on the exact same bytes.
  const FAITHFUL_GARG = buildGarg(KEY_00);

  // Lossy: the configVar segment carries ONE wildcard character (U+FFFF) in
  // an otherwise ordinary 6-character segment — a PARTIAL-segment wildcard.
  // parseGarg's wildcard sweep fires on ANY illegal character in a segment,
  // and reconstructForceClearGarg then fills the WHOLE segment with U+FFFF:
  // six wildcard characters where the observed bytes had one real character
  // and five wildcard ones. The rebuilt row is therefore provably NOT the row
  // that was read.
  const LOSSY_VAR = "A" + GARG_WILDCARD_CHAR.repeat(segLen("configVar") - 1);
  const LOSSY_GARG =
    OK_ID.padEnd(segLen("configId")) +
    "00" +
    LOSSY_VAR +
    " ".repeat(GARG_LENGTH - GARG_SEGMENTS.configVar[1]);

  it("the faithful row generates the ordinary conditional released/still-held pair and no not-reconstructible GUARD", () => {
    const src = buildForceClearSource(
      [seqgRow(FAITHFUL_GARG)],
      { allowForceClear: true },
      "ZCL_ZMCP_FPMLK_FC1",
    );
    expect(src).not.toContain("force-clear-garg-not-reconstructible");
    expect(src).toContain("RELEASE status=[released] remaining=[0]");
    expect(src).toContain("RELEASE status=[still-held] remaining=[{ lv_lk_n }]");
  });

  it("the lossy row generates GUARD reason=[force-clear-garg-not-reconstructible] and a hard-coded still-held verdict, never released", () => {
    const src = buildForceClearSource(
      [seqgRow(LOSSY_GARG)],
      { allowForceClear: true },
      "ZCL_ZMCP_FPMLK_FC2",
    );
    expect(src).toContain("force-clear-garg-not-reconstructible");
    // Hard-coded: NOT behind the `IF lv_lk_n = 0.` conditional the faithful
    // path uses, and there is no `status=[released]` text ANYWHERE in this
    // source — the exact fix this regression fence protects is the old
    // behaviour of reporting `released remaining=[0]` for a delete that
    // deleted nothing.
    expect(src).not.toContain("status=[released]");
    expect(src).toMatch(/status=\[still-held\] remaining=\[\{ lines\( lt_lk_del \) \}\]/);
    // The GUARD is emitted unconditionally, right after the force-clear-input
    // rows and before the ENQUE_DELETE call — a fact about the generated
    // source, not a runtime outcome.
    const guardIdx = src.indexOf("force-clear-garg-not-reconstructible");
    const enqueDeleteIdx = src.indexOf("CALL FUNCTION 'ENQUE_DELETE'");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(enqueDeleteIdx).toBeGreaterThan(guardIdx);
  });

  it("mixing a faithful and a lossy row still fails the whole force-clear closed, and names the lossy row's 1-based index", () => {
    const src = buildForceClearSource(
      [seqgRow(FAITHFUL_GARG), seqgRow(LOSSY_GARG)],
      { allowForceClear: true },
      "ZCL_ZMCP_FPMLK_FC3",
    );
    expect(src).toContain("force-clear-garg-not-reconstructible");
    expect(src).toContain("row(s) 2");
    expect(src).not.toContain("status=[released]");
  });
});

// ---------------------------------------------------------------------------
// 13. Self-probe failure forces UNKNOWN, never MINE
// ---------------------------------------------------------------------------

describe("selfIdentifyLines (generated ABAP): an unverified self-probe forces UNKNOWN, never MINE", () => {
  // Text-only assertions against generated ABAP source. They prove the
  // generator emits the fail-closed GUARD/flag structure described in the
  // module's header item (g); they do NOT prove a real ENQUEUE on
  // ENQUEUE_E_WDY_CONFCOMP/CONFAPPL actually fails under any particular
  // condition on the live system, nor that GUSR really is blank in the case
  // the module worries about — those are wire facts, and
  // test/integration-fpm-lock.test.ts is the only place they are proved.

  it("a self-probe ENQUEUE failure sets the bad flag and emits self-probe-enqueue-failed on the very next statement", () => {
    const src = lockedSrc();
    expect(src).toMatch(
      /lv_lk_selfbad = 'X'\.\s*\n\s*emit_guard\(\s*iv_reason = 'self-probe-enqueue-failed'/,
    );
  });

  it("a probe that succeeds but yields a blank owner id sets the bad flag and emits self-probe-owner-id-blank on the very next statement", () => {
    const src = lockedSrc();
    expect(src).toMatch(
      /lv_lk_selfbad = 'X'\.\s*\n\s*emit_guard\(\s*iv_reason = 'self-probe-owner-id-blank'/,
    );
  });

  it("the ok flag is set exactly once per probed lock object, and only inside the non-blank-GUSR branch", () => {
    const src = lockedSrc(); // LOCKED_OP probes exactly one lock object (component)
    // Anchored to the ASSIGNMENT statement only (a line that is exactly
    // `lv_lk_selfok = 'X'.`) — a plain substring search also catches the
    // unrelated `IF lv_lk_selfok = 'X'.` condition checks that read the flag
    // elsewhere in the generated body (e.g. the row-ownership and
    // after-release checks), which would overcount what this test is about.
    const setOk = src.match(/^\s*lv_lk_selfok = 'X'\.\s*$/gm) ?? [];
    expect(setOk).toHaveLength(1);
    // The single assignment is textually nested inside `IF lv_lk_selfone <>
    // space.` — i.e. behind the non-blank-GUSR check — never set on a path
    // that skipped it.
    expect(src).toMatch(/IF lv_lk_selfone <> space\.[\s\S]*?lv_lk_selfok = 'X'\.[\s\S]*?ENDIF\./);
  });

  it("a disagreement between two probed lock objects also sets the bad flag (header item (g): cross-lock-object portability is checked, not assumed)", () => {
    // buildLockInspectSource with no configType probes BOTH lock objects.
    const q: FpmLockInspectQuery = { mode: "locks", configId: OK_ID };
    const src = buildLockInspectSource(q, fpmLockBridgeClassName(q));
    expect(src).toContain("lv_lk_selfbad = 'X'.");
    expect(src).toContain("self-owner-id-not-portable");
    // Two probes now, one per lock object.
    const probes = src.match(/CLEAR lv_lk_selfone\./g) ?? [];
    expect(probes).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 14. Application-scope rows are always flagged inferred, and are capped
// ---------------------------------------------------------------------------

describe("buildLockInspectSource: WDY_CONFIG_APPL rows are unconditionally flagged inferred, and capped", () => {
  // Text-only assertions against generated ABAP. The E_WDY_CONFAPPL GARG
  // layout was NEVER CAPTURED by the live spike (module header item (f)) —
  // that is exactly why EVERY WDY_CONFIG_APPL row is flagged inferred rather
  // than only the ones whose id segment fails to match: under an unverified
  // layout, even a MATCHING slice is still only a guess. Nothing here proves
  // the 0/32/34/40 offsets are correct for E_WDY_CONFAPPL, or that the
  // FM/GNAME triple used to read it is right; only
  // test/integration-fpm-lock.test.ts touches the wire.

  const applQ: FpmLockInspectQuery = { mode: "locks", configId: OK_ID, configType: "02" };
  const applSrc = (): string => buildLockInspectSource(applQ, fpmLockBridgeClassName(applQ));

  it("sets lv_lk_infer = 'X' for EVERY WDY_CONFIG_APPL row, unconditionally and before the id-segment match test — not only for non-matching rows", () => {
    const src = applSrc();
    const gnameCheckIdx = src.indexOf(`IF ls_lk_r-gname = '${FPM_LOCK_OBJECTS.application.gname}'.`);
    const inferSetIdx = src.indexOf("lv_lk_infer = 'X'.", gnameCheckIdx);
    const idSegCheckIdx = src.indexOf("lv_lk_idseg = ls_lk_r-garg+", gnameCheckIdx);
    expect(gnameCheckIdx).toBeGreaterThan(-1);
    expect(inferSetIdx).toBeGreaterThan(gnameCheckIdx);
    expect(idSegCheckIdx).toBeGreaterThan(inferSetIdx);
    // The inferred-flag assignment sits BEFORE the match test and is not
    // itself conditioned on a match: nothing between the gname check and the
    // flag assignment tests lv_lk_idseg.
    expect(src.slice(gnameCheckIdx, inferSetIdx)).not.toContain("lv_lk_idseg");
  });

  it("the retention cap constant (50) gates the speculative keep of unmatched WDY_CONFIG_APPL rows", () => {
    const src = applSrc();
    expect(src).toMatch(/IF lv_lk_apn < 50\./);
  });

  it("emits GUARD reason=[appl-rows-truncated] when the cap is hit, gated behind the truncation flag", () => {
    const src = applSrc();
    expect(src).toMatch(
      /IF lv_lk_aptr = 'X'\.\s*\n\s*emit_guard\(\s*iv_reason = 'appl-rows-truncated'/,
    );
  });

  it("also emits GUARD reason=[appl-garg-layout-inferred] whenever any WDY_CONFIG_APPL row was seen at all", () => {
    const src = applSrc();
    expect(src).toMatch(
      /IF lv_lk_apflg = 'X'\.\s*\n\s*emit_guard\(\s*iv_reason = 'appl-garg-layout-inferred'/,
    );
  });
});

// ---------------------------------------------------------------------------
// 15. The fabricated scope= field is gone from the ENQUE_DELETE transcript line
// ---------------------------------------------------------------------------

describe("ENQUE_DELETE's DEQ transcript line does not fabricate a scope= field", () => {
  // ENQUE_DELETE's actual interface is SUBRC / CHECK_UPD_REQUESTS /
  // SUPPRESS_SYSLOG_ENTRY / TABLES ENQ — it has NO `_SCOPE` parameter at all.
  // This is a text-only assertion that the generator no longer narrates a
  // parameter the call never sends. It does not prove ENQUE_DELETE deletes,
  // or fails to delete, anything — no offline test can prove that; see the
  // honesty note in section 12.

  it("buildForceClearSource's DEQ fm=[ENQUE_DELETE] line carries no scope=[ field", () => {
    const garg = buildGarg(KEY_00);
    const row: LockRow = {
      gname: FPM_LOCK_OBJECTS.component.gname,
      garg,
      gmode: "E",
      guname: "DEVELOPER",
      gclient: "001",
      gusr: SELF_OWNER,
      gusrvb: "",
      guse: "1",
      gusevb: "0",
      gobj: "E_WDY_CONFCOMP",
      garg_view: parseGarg(garg),
      ownership: "FOREIGN",
    };
    const src = buildForceClearSource([row], { allowForceClear: true }, "ZCL_ZMCP_FPMLK_NS1");
    const deqLine = src.split("\n").find((l) => l.includes("DEQ fm=[ENQUE_DELETE]"));
    expect(deqLine).toBeDefined();
    expect(deqLine).not.toContain("scope=[");
  });

  it("buildLockedOperationSource's real DEQUEUE line still DOES carry scope=[, for contrast", () => {
    const src = lockedSrc();
    const deqLine = src
      .split("\n")
      .find((l) => l.includes(`DEQ fm=[${FPM_LOCK_OBJECTS.component.dequeueFm}]`));
    expect(deqLine).toBeDefined();
    expect(deqLine).toContain("scope=[");
  });
});

// ---------------------------------------------------------------------------
// 16. Regression fence — contract-critical properties still hold in every
//     newly generated source shape
// ---------------------------------------------------------------------------

describe("regression fence: contract-critical properties across ALL generated source shapes", () => {
  // Same style of assertion as section 3, but broadened to variants section 3
  // did not cover: the application-scope buildLockedOperationSource, and
  // buildLockInspectSource with NO configType (both lock objects at once).
  // Text-only assertions against generated ABAP; none of it is compiled,
  // activated or executed here. See the file header banner.

  const APPL_OP: FpmLockedOperation = { key: KEY_02, body: BENIGN_BODY, bodyLabel: BODY_LABEL };
  const INSPECT_NO_TYPE: FpmLockInspectQuery = { mode: "locks", configId: OK_ID };

  const VARIANTS: Array<[string, () => string]> = [
    ["buildLockedOperationSource (component)", lockedSrc],
    [
      "buildLockedOperationSource (application)",
      () => buildLockedOperationSource(APPL_OP, fpmLockBridgeClassName(APPL_OP)),
    ],
    ["buildLockInspectSource (configType present)", inspectSrc],
    [
      "buildLockInspectSource (configType absent, both lock objects)",
      () => buildLockInspectSource(INSPECT_NO_TYPE, fpmLockBridgeClassName(INSPECT_NO_TYPE)),
    ],
  ];

  for (const [name, make] of VARIANTS) {
    describe(name, () => {
      it("every X_CONFIG_ID/X_CONFIG_TYPE/X_CONFIG_VAR on every ENQUEUE and DEQUEUE is the literal 'X'", () => {
        const src = make();
        const enqueues = src.match(/CALL FUNCTION 'ENQUEUE_E_WDY_CONF(COMP|APPL)'/g) ?? [];
        const dequeues = src.match(/CALL FUNCTION 'DEQUEUE_E_WDY_CONF(COMP|APPL)'/g) ?? [];
        const calls = enqueues.length + dequeues.length;
        expect(enqueues.length).toBeGreaterThan(0);
        expect(dequeues.length).toBeGreaterThan(0);
        for (const flag of ["x_config_id", "x_config_type", "x_config_var"]) {
          const re = new RegExp(`${flag}\\s*=\\s*([^\\n]*)`, "gi");
          const values = [...src.matchAll(re)].map((m) => m[1]!.trim());
          expect(values).toHaveLength(calls);
          expect(new Set(values)).toEqual(new Set(["'X'"]));
        }
      });

      it("zero IS INITIAL anywhere in the generated source", () => {
        expect(make()).not.toMatch(/IS\s+INITIAL/i);
      });

      it("_scope is identical on every ENQUEUE and DEQUEUE and comes from the imported FPM_LOCK_SCOPE constant (not hardcoded here)", () => {
        const src = make();
        const calls = (src.match(/CALL FUNCTION '(EN|DE)QUEUE_E_WDY_CONF(COMP|APPL)'/g) ?? []).length;
        const scopes = [...src.matchAll(/_scope\s*=\s*'([^']*)'/g)].map((m) => m[1]!);
        expect(scopes).toHaveLength(calls);
        expect(new Set(scopes)).toEqual(new Set([FPM_LOCK_SCOPE]));
      });

      it("ENQUEUE_READ is called with guname = space and gclient = space", () => {
        const src = make();
        const from = src.indexOf("CALL FUNCTION 'ENQUEUE_READ'");
        expect(from).toBeGreaterThan(-1);
        const block = src.slice(from, src.indexOf("ENDMETHOD.", from));
        expect(block).toMatch(/\bguname\s+=\s+space\b/);
        expect(block).toMatch(/\bgclient\s+=\s+space\b/);
      });

      it("no chained offset/length pattern (+\\w+(\\d+)+) appears anywhere in the generated source", () => {
        expect(make()).not.toMatch(/\+\w+\(\d+\)\+/);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 16b. ADT_MAX_SOURCE_LINE_LEN: no generated source line exceeds ADT's ceiling
// ---------------------------------------------------------------------------

/**
 * THE regression test for the live-confirmed defect this fix addresses:
 * `abap_fpm_read({ mode: "locks", config_id: "..." })` failed 100% of the
 * time against a live A4H system for an application-scope config
 * (`config_type: "02"`) because two `emit_guard` detail literals in
 * `buildLockInspectSource` produced generated ABAP source lines of 408 and
 * 261 characters — both over ADT's ceiling — and ADT rejects the WHOLE
 * generated bridge class at write time, before a single row of lock data is
 * ever read:
 *
 *   ADT_ERROR: "The line 481 exceeds 255 characters. Source code cannot be
 *   processed" (SEDI_ADT15 / TooLongLine)
 *
 * This block is the check that was missing before that shipped: across
 * every generator entry point in this module, every lock kind, every legal
 * config_type, and a range of config_id shapes (short, exactly
 * CONFIG_ID_LEN, and namespaced `/BOFU/...`), NO generated line may exceed
 * ADT_MAX_SOURCE_LINE_LEN.
 *
 * What this DOES prove: the necessary, offline-checkable condition — ADT
 * cannot reject any of these classes for being over-length. What this does
 * NOT prove: that the generated class activates or is otherwise well-formed
 * ABAP. Nothing here is compiled, activated or executed — see this file's
 * honesty banner at the top. Only a live run against A4H can settle that.
 */
describe("ADT_MAX_SOURCE_LINE_LEN: no generated source line exceeds ADT's ceiling", () => {
  function assertNoOverlongLines(src: string, label: string): void {
    const offenders = src
      .split("\n")
      .map((line, idx) => ({ n: idx + 1, len: line.length }))
      .filter((l) => l.len > ADT_MAX_SOURCE_LINE_LEN);
    expect(
      offenders,
      `${label}: ${offenders.length} line(s) exceed ADT_MAX_SOURCE_LINE_LEN=${ADT_MAX_SOURCE_LINE_LEN} — ` +
        offenders.map((o) => `line ${o.n} is ${o.len} chars`).join("; "),
    ).toEqual([]);
  }

  // config_id shapes: short, exactly CONFIG_ID_LEN (32) plain, and exactly
  // CONFIG_ID_LEN namespaced (the `/BOFU/...` shape called out by name) —
  // length feeds directly into generated GARG literals and self-probe
  // padding, so it is exactly the kind of input that could shift a
  // borderline line over the edge.
  const CONFIG_IDS = [
    "A",
    "BUSINESS_PARTNER_DETAIL",
    "Z_THIRTY_TWO_CHARACTER_CONFIG_ID", // checked below for real length
    "/BOFU/SOME_LONG_NAMESPACED_CFG12",
  ];

  it("fixture sanity: the two long config_id fixtures are exactly CONFIG_ID_LEN (32) characters", () => {
    // If this ever drifts, fpmLockKey's own validator (assertConfigId) would
    // refuse the fixture before this test could — this is a self-check on
    // the fixtures, not a redundant assertion on the module.
    expect(CONFIG_IDS[2]!.length).toBe(32);
    expect(CONFIG_IDS[3]!.length).toBe(32);
  });

  // NUMC2 config_type values spanning both lock kinds: "02" always routes to
  // "application" (lockKindForConfigType); every other 2-digit value routes
  // to "component".
  const CONFIG_TYPES = ["00", "01", "02", "10", "99"];

  describe("buildLockInspectSource", () => {
    for (const configId of CONFIG_IDS) {
      for (const configType of CONFIG_TYPES) {
        it(`configId=${JSON.stringify(configId)} configType=${configType}`, () => {
          const q: FpmLockInspectQuery = { mode: "locks", configId, configType };
          const src = buildLockInspectSource(q, fpmLockBridgeClassName(q));
          assertNoOverlongLines(src, `inspect(${configId}, ${configType})`);
        });
      }
      it(`configId=${JSON.stringify(configId)} configType=absent (both lock objects inspected)`, () => {
        const q: FpmLockInspectQuery = { mode: "locks", configId };
        const src = buildLockInspectSource(q, fpmLockBridgeClassName(q));
        assertNoOverlongLines(src, `inspect(${configId}, <both>)`);
      });
    }
  });

  describe("buildLockedOperationSource", () => {
    for (const configId of CONFIG_IDS) {
      for (const configType of CONFIG_TYPES) {
        it(`configId=${JSON.stringify(configId)} configType=${configType}`, () => {
          const key = fpmLockKey({ configId, configType, configVar: "" });
          const op: FpmLockedOperation = { key, body: "WRITE 'x'.", bodyLabel: "regression_probe" };
          const src = buildLockedOperationSource(op, fpmLockBridgeClassName(op));
          assertNoOverlongLines(src, `lockedOp(${configId}, ${configType})`);
        });
      }
    }
  });

  describe("buildForceClearSource", () => {
    // A GARG whose configId segment carries exactly one illegal (wildcard)
    // character. parseGarg widens the WHOLE segment to "wildcard" on any
    // illegal character, and reconstructForceClearGarg then fills the whole
    // segment with GARG_WILDCARD_CHAR — so the reconstruction provably does
    // not equal the row as read, which is what puts this row's 1-based
    // index into the `row(s) ...` guard text this section exists to test.
    function wildRow(seed: number): LockRow {
      const [idFrom, idTo] = GARG_SEGMENTS.configId;
      const idLen = idTo - idFrom;
      const configIdSeg = "A".repeat(idLen - 1) + GARG_WILDCARD_CHAR;
      const garg = (configIdSeg + "00" + "      ").padEnd(GARG_LENGTH, " ");
      return {
        gname: FPM_LOCK_OBJECTS.component.gname,
        garg,
        gmode: "E",
        guname: "DEVELOPER",
        gclient: "001",
        gusr: `USER${seed}`,
        gusrvb: "",
        guse: "1",
        gusevb: "0",
        gobj: FPM_LOCK_OBJECTS.component.lockObject,
        garg_view: parseGarg(garg),
        ownership: "FOREIGN",
      };
    }

    it("a single non-reconstructible row stays under the ceiling", () => {
      const src = buildForceClearSource([wildRow(1)], { allowForceClear: true }, "ZCL_ZMCP_FPMLK_RT1");
      assertNoOverlongLines(src, "forceClear(1 mismatched row)");
      expect(src).toContain("force-clear-garg-not-reconstructible");
    });

    it("300 non-reconstructible rows (the shape that overflowed pre-fix) stay under the ceiling", () => {
      // This is a THIRD instance of the live defect's bug class, found while
      // writing this test rather than reported live: with enough mismatched
      // rows, the un-wrapped `row(s) 1,2,3,...` guard text alone exceeded
      // 255 characters (reproduced pre-fix at 300 rows -> a 1408-char line).
      // buildForceClearSource is not wired to any MCP tool yet (see the
      // module header on ForceClearOptions), so this was never reachable
      // from a live call — but it is reachable the moment a force-clear tool
      // ships, so it is covered here rather than left for the next person to
      // rediscover.
      const rows = Array.from({ length: 300 }, (_, idx) => wildRow(idx));
      const src = buildForceClearSource(rows, { allowForceClear: true }, "ZCL_ZMCP_FPMLK_RT2");
      assertNoOverlongLines(src, "forceClear(300 mismatched rows)");
      expect(src).toContain("force-clear-garg-not-reconstructible");
      expect(src).toContain("row(s) 1, 2, 3");
    });
  });

  describe("wrapAbapTemplateLines (the helper itself)", () => {
    it("a short string round-trips as a single un-split fragment", () => {
      const out = wrapAbapTemplateLines("short text", "  ", "test");
      expect(out).toEqual(["  |short text|"]);
    });

    it("every returned line is <= ADT_MAX_SOURCE_LINE_LEN for a long string at a realistic indent", () => {
      const words = Array.from({ length: 200 }, (_, i) => `word${i}`);
      const out = wrapAbapTemplateLines(words.join(" "), "            ", "test");
      for (const line of out) {
        expect(line.length).toBeLessThanOrEqual(ADT_MAX_SOURCE_LINE_LEN);
      }
      // Every non-final fragment carries the `&&` continuation; only the
      // last line is a bare closed template with no continuation.
      expect(out.slice(0, -1).every((l) => l.endsWith(" &&"))).toBe(true);
      expect(out[out.length - 1]!.endsWith(" &&")).toBe(false);
    });

    it("concatenating the fragments (stripping the ABAP-only `|`/`&&` syntax) reproduces the original text exactly", () => {
      const text =
        "the quick brown fox jumps over the lazy dog and this sentence keeps going for quite a while " +
        "so that it is forced to wrap across several ABAP source lines when rendered at a normal indent";
      const out = wrapAbapTemplateLines(text, "      ", "test");
      const rejoined = out
        .map((line) => {
          const m = /^\s*\|(.*)\|(?: &&)?$/.exec(line);
          if (!m) throw new Error(`line does not match the expected |...| template shape: ${line}`);
          return m[1];
        })
        .join("");
      expect(rejoined).toBe(text);
    });

    for (const bad of ["has a { brace", "has a } brace", "has a | pipe"]) {
      it(`refuses text containing ${JSON.stringify(bad)} rather than mis-embedding it`, () => {
        expectBadInput(() => wrapAbapTemplateLines(bad, "  ", "test"));
      });
    }

    it("refuses a single word longer than the available budget instead of overflowing the line", () => {
      const hugeWord = "X".repeat(300);
      expectBadInput(() => wrapAbapTemplateLines(hugeWord, "  ", "test"));
    });

    it("refuses an indent too deep to leave any wrapping budget", () => {
      expectBadInput(() => wrapAbapTemplateLines("some text", " ".repeat(250), "test"));
    });
  });
});

// ---------------------------------------------------------------------------
// 17. Ownership reads BOTH owner slots — a blank GUSR is not an assertion
//     about who holds the lock
// ---------------------------------------------------------------------------

/**
 * `rowLine` above hardcodes `gusrvb=[]`, which is right for the scope-1 rows
 * every other section uses. This variant is for the rows that section 17 is
 * about: a scope-2 lock parks its owner id in `GUSRVB` and leaves `GUSR`
 * blank, and a row with BOTH slots blank identifies nobody at all.
 *
 * `guse` / `gusevb` are carried along with the observed scope pairing
 * (`GUSE=1 GUSEVB=0` for scope 1, `GUSE=0 GUSEVB=1` for scope 2) so the
 * fixtures read like the spike's captures — but note that NOTHING in the
 * classifier looks at them: it reads the two owner slots only. These fixtures
 * are hand-typed in the bracket-field grammar, exactly as in section 6; no
 * bridge class produced any of them and none of this proves what a real
 * scope-2 SEQG3 row looks like on the wire.
 */
function ownerRowLine(opts: {
  phase: string;
  garg: string;
  gusr: string;
  gusrvb: string;
  guse?: string;
  gusevb?: string;
}): string {
  const { phase, garg, gusr, gusrvb } = opts;
  const guse = opts.guse ?? (gusr.trim() === "" ? "0" : "1");
  const gusevb = opts.gusevb ?? (gusrvb.trim() === "" ? "0" : "1");
  return (
    `${LOCK_LINE_PREFIX}ROW phase=[${phase}] gname=[WDY_CONFIG_DATA] garg=[${garg}] gmode=[E] ` +
    `guname=[DEVELOPER] gclient=[001] gusr=[${gusr}] gusrvb=[${gusrvb}] guse=[${guse}] ` +
    `gusevb=[${gusevb}] gobj=[E_WDY_CONFCOMP]`
  );
}

const SELF_LINE = `${LOCK_LINE_PREFIX}SELF owner=[${SELF_OWNER}] ok=[X]\n`;

describe("parseLockTranscript ownership: both owner slots are consulted, and neither-slot means UNKNOWN", () => {
  // Hand-typed transcripts again — the parser is the only thing under test.
  // These prove how THIS CODE labels a row given a set of SEQG3 field values.
  // They do NOT prove that a real scope-2 lock arrives with a blank GUSR and a
  // populated GUSRVB (the spike observed that pairing; only
  // test/integration-fpm-lock.test.ts re-proves it), and they cannot prove
  // that a GUSRVB value from another session would never collide with ours —
  // the cross-session GUSRVB comparison was NEVER exercised on the wire, which
  // is precisely why the classifier refuses to use GUSRVB to claim MINE.

  it("a scope-2 row (blank GUSR, populated GUSRVB) is FOREIGN while the scope-1 row with our id is MINE", () => {
    const raw =
      SELF_LINE +
      `${ownerRowLine({ phase: "inspect", garg: GARG_MINE, gusr: SELF_OWNER, gusrvb: "" })}\n` +
      `${ownerRowLine({ phase: "inspect", garg: GARG_OTHER, gusr: "", gusrvb: FOREIGN_OWNER })}\n`;
    const rows = parseLockTranscript(raw).phases[0]!.rows;
    expect(rows).toHaveLength(2);

    // Scope 1: the owner id is in GUSR and it is ours.
    expect(rows[0]!.gusr).toBe(SELF_OWNER);
    expect(rows[0]!.gusrvb).toBe("");
    expect(rows[0]!.ownership).toBe("MINE");

    // Scope 2: GUSR is blank, the owner sits in the update-task slot. That is a
    // POSITIVE foreign identification — our own locks are always
    // FPM_LOCK_SCOPE = '1', so a lock owned via GUSRVB can never be ours.
    expect(rows[1]!.gusr).toBe("");
    expect(rows[1]!.gusrvb).toBe(FOREIGN_OWNER);
    expect(rows[1]!.ownership).toBe("FOREIGN");
    expect(FPM_LOCK_SCOPE).toBe("1");
  });

  it("a row with BOTH owner slots blank is UNKNOWN — it identifies nobody", () => {
    const raw =
      SELF_LINE + `${ownerRowLine({ phase: "inspect", garg: GARG_OTHER, gusr: "", gusrvb: "" })}\n`;
    const row = parseLockTranscript(raw).phases[0]!.rows[0]!;
    expect(row.gusr).toBe("");
    expect(row.gusrvb).toBe("");
    expect(row.ownership).toBe("UNKNOWN");
    // AUDIT-DRIVEN CHANGE (09-LOCK-DISCIPLINE-SPIKE-AUDIT.md): this row used to
    // come back FOREIGN, purely as a side effect of comparing a blank GUSR
    // against a non-blank self id. "FOREIGN" asserts that somebody else holds
    // this lock — a claim nothing in the captures supports for a row that names
    // no owner in either slot. UNKNOWN is the honest verdict, and it is also
    // the closed one: UNKNOWN never satisfies the MINE test that gates a save.
    expect(row.ownership).not.toBe("FOREIGN");
  });

  it("whitespace-only owner fields count as blank, so a row of spaces is UNKNOWN too", () => {
    const raw =
      SELF_LINE +
      `${ownerRowLine({ phase: "inspect", garg: GARG_OTHER, gusr: "   ", gusrvb: "  ", guse: "0", gusevb: "0" })}\n`;
    const row = parseLockTranscript(raw).phases[0]!.rows[0]!;
    // The raw field values survive into the row verbatim...
    expect(row.gusr).toBe("   ");
    expect(row.gusrvb).toBe("  ");
    // ...but a run of blanks is not an owner id.
    expect(row.ownership).toBe("UNKNOWN");
    expect(row.ownership).not.toBe("FOREIGN");
  });

  it("a scope-2 row can NEVER be MINE, even when its GUSRVB happens to equal our learned owner id", () => {
    // Our locks are taken with _SCOPE = '1', which parks the owner id in GUSR.
    // A row whose id sits in GUSRVB is therefore somebody else's regardless of
    // the value — and "the two slots are numbered from the same pool" is an
    // inference the spike never tested, so matching on GUSRVB would be claiming
    // ownership on the strength of an untested coincidence.
    const raw =
      SELF_LINE +
      `${ownerRowLine({ phase: "inspect", garg: GARG_MINE, gusr: "", gusrvb: SELF_OWNER })}\n`;
    const row = parseLockTranscript(raw).phases[0]!.rows[0]!;
    expect(row.gusrvb).toBe(SELF_OWNER);
    expect(row.ownership).toBe("FOREIGN");
    expect(row.ownership).not.toBe("MINE");
  });

  it("with no usable self owner id every row is UNKNOWN, whatever either owner slot says", () => {
    // Guards the pre-existing behaviour against regression from the two-slot
    // change: the self-id check comes FIRST, so no combination of GUSR/GUSRVB
    // can produce MINE or FOREIGN once self-identification failed.
    const rows = [
      ownerRowLine({ phase: "inspect", garg: GARG_MINE, gusr: SELF_OWNER, gusrvb: "" }),
      ownerRowLine({ phase: "inspect", garg: GARG_OTHER, gusr: FOREIGN_OWNER, gusrvb: "" }),
      ownerRowLine({ phase: "inspect", garg: GARG_OTHER, gusr: "", gusrvb: FOREIGN_OWNER }),
      ownerRowLine({ phase: "inspect", garg: GARG_OTHER, gusr: "", gusrvb: "" }),
    ];
    const raw = `${LOCK_LINE_PREFIX}SELF owner=[] ok=[-]\n` + rows.map((l) => `${l}\n`).join("");
    const t = parseLockTranscript(raw);
    expect(t.selfOwnerId).toBeUndefined();
    const parsed = t.phases[0]!.rows;
    expect(parsed).toHaveLength(4);
    expect(parsed.map((r) => r.ownership)).toEqual([
      "UNKNOWN",
      "UNKNOWN",
      "UNKNOWN",
      "UNKNOWN",
    ]);
  });

  it("GUARD reason=[body-exception] parses as an abort and is NOT counted as a dropped line", () => {
    // The reason string is new; the GUARD head is not. This proves the parser
    // surfaces it through `aborts` rather than silently binning the line — the
    // failure mode `droppedLines` exists to make visible. It proves nothing
    // about whether a real body ever raises.
    const raw =
      SELF_LINE +
      `${LOCK_LINE_PREFIX}BODY label=[${BODY_LABEL}] state=[begin]\n` +
      `${LOCK_LINE_PREFIX}GUARD reason=[body-exception] detail=[the body raised CX_SY_ZERODIVIDE: Division by zero - it did not complete]\n` +
      `${LOCK_LINE_PREFIX}DEQ fm=[DEQUEUE_E_WDY_CONFCOMP] subrc=[0] scope=[${FPM_LOCK_SCOPE}] note=[subrc-is-not-evidence]\n` +
      `${LOCK_LINE_PREFIX}RELEASE status=[released] remaining=[0]\n`;
    const t = parseLockTranscript(raw);
    expect(t.droppedLines).toBe(0);
    expect(t.aborts).toEqual([
      "body-exception: the body raised CX_SY_ZERODIVIDE: Division by zero - it did not complete",
    ]);
    // The body was entered but never completed; the release still happened.
    expect(t.saveReached).toBe(true);
    expect(t.release).toEqual({ status: "released" });
  });
});

// ---------------------------------------------------------------------------
// 18. An exception in the body (or in the self-probe) cannot unwind past the
//     DEQUEUE — the generated source wraps each of them in its own TRY
// ---------------------------------------------------------------------------

describe("buildLockedOperationSource: the caller's body sits in its own TRY, so the release is unconditional", () => {
  // Text-only assertions about generated ABAP, in the same style as sections 3
  // and 4. They prove the ORDER AND NESTING OF THE TEXT WE EMIT. They do NOT
  // prove that ABAP's CATCH cx_root really catches what the body can raise
  // (a short dump outside the exception hierarchy is not catchable at all),
  // that the generated class activates, or that the DEQUEUE releases anything.
  // Above all they do not prove the premise: that a lock can outlive the HTTP
  // request, which is the reason this wrapper exists, is a finding of the
  // lock-discipline spike audit, not of this file.

  /** Start index of the last `TRY.` statement line before `before`. */
  const lastTryBefore = (src: string, before: number): number => {
    const opens = [...src.matchAll(/^[ \t]*TRY\.[ \t]*$/gm)]
      .map((m) => m.index ?? -1)
      .filter((idx) => idx > -1 && idx < before);
    return opens.length === 0 ? -1 : opens[opens.length - 1]!;
  };

  it("encloses the injected body in TRY. ... CATCH cx_root ... ENDTRY., and that ENDTRY comes BEFORE the DEQUEUE", () => {
    const src = lockedSrc();
    const bodyIdx = src.indexOf(BODY_SENTINEL);
    const presaveIdx = src.indexOf(`${LOCK_LINE_PREFIX}VERIFY phase=[presave]`);
    const tryIdx = lastTryBefore(src, bodyIdx);
    const catchIdx = src.indexOf("CATCH cx_root INTO DATA(lx_lk_body).", bodyIdx);
    const endTryIdx = src.indexOf("ENDTRY.", catchIdx);
    const deqIdx = src.indexOf(
      `CALL FUNCTION '${FPM_LOCK_OBJECTS.component.dequeueFm}'`,
      bodyIdx,
    );

    expect(bodyIdx).toBeGreaterThan(-1);
    expect(tryIdx).toBeGreaterThan(-1);
    // The TRY that wraps the body is the body's OWN — opened after the pre-save
    // verify, i.e. inside the guard IF, not some outer TRY inherited from the
    // self-probe block above.
    expect(tryIdx).toBeGreaterThan(presaveIdx);
    expect(tryIdx).toBeLessThan(bodyIdx);
    expect(catchIdx).toBeGreaterThan(bodyIdx);
    expect(endTryIdx).toBeGreaterThan(catchIdx);
    // The whole point: the handler closes BEFORE the release, so an exception
    // in the body falls through to the DEQUEUE instead of unwinding past it to
    // the single outer TRY in main.
    expect(deqIdx).toBeGreaterThan(endTryIdx);
  });

  it("the post-body re-read, the DEQUEUE, the survivor count and the RELEASE verdict all still follow the body's ENDTRY", () => {
    const src = lockedSrc();
    const bodyIdx = src.indexOf(BODY_SENTINEL);
    const endTryIdx = src.indexOf(
      "ENDTRY.",
      src.indexOf("CATCH cx_root INTO DATA(lx_lk_body).", bodyIdx),
    );
    const postbodyIdx = src.indexOf("emit_rows( iv_phase = 'postbody'", endTryIdx);
    const deqIdx = src.indexOf(
      `CALL FUNCTION '${FPM_LOCK_OBJECTS.component.dequeueFm}'`,
      endTryIdx,
    );
    const afterReleaseIdx = src.indexOf("emit_rows( iv_phase = 'after-release'", deqIdx);
    const releaseIdx = src.indexOf(`${LOCK_LINE_PREFIX}RELEASE status=`, deqIdx);
    const survivorIdx = src.indexOf("lv_lk_left = lv_lk_left + 1.", deqIdx);

    for (const [what, idx] of [
      ["postbody re-read", postbodyIdx],
      ["DEQUEUE", deqIdx],
      ["after-release re-read", afterReleaseIdx],
      ["RELEASE verdict", releaseIdx],
      ["survivor count", survivorIdx],
    ] as const) {
      expect(idx, what).toBeGreaterThan(endTryIdx);
    }
    expect(deqIdx).toBeGreaterThan(postbodyIdx);
    expect(afterReleaseIdx).toBeGreaterThan(deqIdx);
    expect(releaseIdx).toBeGreaterThan(afterReleaseIdx);
    expect(src).toContain(`${LOCK_LINE_PREFIX}RELEASE status=[released] remaining=`);
    expect(src).toContain(`${LOCK_LINE_PREFIX}RELEASE status=[still-held] remaining=`);
  });

  it("the CATCH emits GUARD reason=[body-exception] and suppresses ONLY the lock-lost-during-body verdict", () => {
    const src = lockedSrc();
    // The flag is set and the guard emitted on the very next statement, in the
    // same style as the self-probe guards asserted in section 13.
    expect(src).toMatch(
      /lv_lk_bodyexc = 'X'\.\s*\n(?:\s*"[^\n]*\n)*\s*emit_guard\(\s*iv_reason = 'body-exception'/,
    );
    // No `BODY ... state=[end]` line is emitted on this path — the CATCH sits
    // AFTER it, so an exception skips it and the transcript never claims the
    // body completed.
    const endLineIdx = src.indexOf(`${LOCK_LINE_PREFIX}BODY label=[${BODY_LABEL}] state=[end]`);
    expect(endLineIdx).toBeGreaterThan(-1);
    expect(src.indexOf("CATCH cx_root INTO DATA(lx_lk_body).")).toBeGreaterThan(endLineIdx);
    // The flag gates exactly one thing: the second, misleading verdict.
    expect(src).toContain("IF lv_lk_bodyexc = '-' AND lv_lk_pass = '-'.");
    const gateIdx = src.indexOf("IF lv_lk_bodyexc = '-' AND lv_lk_pass = '-'.");
    const lostIdx = src.indexOf("emit_guard( iv_reason = 'lock-lost-during-body'", gateIdx);
    expect(lostIdx).toBeGreaterThan(gateIdx);
    // ...and nothing in the release block reads it, so the release is not
    // conditioned on the body having succeeded.
    const deqIdx = src.indexOf(
      `CALL FUNCTION '${FPM_LOCK_OBJECTS.component.dequeueFm}'`,
      src.indexOf(BODY_SENTINEL),
    );
    expect(src.slice(deqIdx)).not.toContain("lv_lk_bodyexc");
  });
});

describe("selfIdentifyLines (generated ABAP): the self-probe has the same TRY treatment, declared once", () => {
  // Text-only again. See the section 13 honesty note: nothing here proves the
  // probe's ENQUEUE, read-back or DEQUEUE behave as written on a live system.

  it("emits GUARD reason=[self-probe-exception] from a CATCH that closes BEFORE the probe's own DEQUEUE", () => {
    const src = lockedSrc();
    const catchIdx = src.indexOf("CATCH cx_root INTO lx_lk_self.");
    const guardIdx = src.indexOf("emit_guard( iv_reason = 'self-probe-exception'", catchIdx);
    const endTryIdx = src.indexOf("ENDTRY.", guardIdx);
    const probeDeqIdx = src.indexOf(
      `CALL FUNCTION '${FPM_LOCK_OBJECTS.component.dequeueFm}'`,
      endTryIdx,
    );
    expect(catchIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(catchIdx);
    expect(endTryIdx).toBeGreaterThan(guardIdx);
    // The probe's release is reached on the exception path too: the DEQUEUE
    // follows the ENDTRY rather than sitting inside the TRY block.
    expect(probeDeqIdx).toBeGreaterThan(endTryIdx);
    // And the probe still proves its own release by re-reading afterwards.
    expect(src).toContain("self-probe-not-released");
  });

  it("declares lx_lk_self ONCE even when two lock objects are probed — an inline DATA(lx_lk_self) twice would be a duplicate-declaration syntax error", () => {
    // buildLockInspectSource with no configType probes BOTH lock objects, so
    // the probe block — and its CATCH — is emitted twice.
    const q: FpmLockInspectQuery = { mode: "locks", configId: OK_ID };
    const src = buildLockInspectSource(q, fpmLockBridgeClassName(q));
    const catches = src.match(/CATCH cx_root INTO lx_lk_self\./g) ?? [];
    expect(catches).toHaveLength(2);

    // Exactly one DATA statement for the reference...
    const decls = src.match(/^[ \t]*DATA lx_lk_self\s+TYPE REF TO cx_root\.[ \t]*$/gm) ?? [];
    expect(decls).toHaveLength(1);
    // ...and no inline declaration anywhere, which is what would duplicate.
    expect(src).not.toMatch(/DATA\(\s*lx_lk_self\s*\)/);
    // It is declared before the first use, as any ABAP DATA must be.
    const declIdx = src.indexOf("DATA lx_lk_self");
    expect(declIdx).toBeGreaterThan(-1);
    expect(declIdx).toBeLessThan(src.indexOf("CATCH cx_root INTO lx_lk_self."));
  });
});
