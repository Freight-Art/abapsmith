/**
 * Issue #148 item 2: `pattern=` on abap_read — grep -n -C over the
 * document. `grepSource` is tested as a pure function; the abapRead path
 * is tested with resolveObject/readSource stubbed (no network). The
 * argument-only refusals are asserted to cost zero resolve calls.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import type { ResolvedObject } from "../src/adt/resolve.js";
import { grepSource } from "../src/adt/source.js";

const stub = {
  object: {} as ResolvedObject,
  source: "",
  resolveCalls: 0,
};

vi.mock("../src/adt/resolve.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/resolve.js")>()),
  resolveObject: async () => {
    stub.resolveCalls += 1;
    return stub.object;
  },
}));

vi.mock("../src/adt/source.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/source.js")>()),
  readSource: async () => ({ source: stub.source, serverEtag: '"W/etag"' }),
  classMembers: async () => [],
  readMethod: async () => {
    throw new Error("readMethod must not be called by these tests");
  },
}));

const { abapRead, PATTERN_MAX_MATCHES } = await import("../src/tools/read.js");

function resolved(over: Partial<ResolvedObject> = {}): ResolvedObject {
  return {
    system: "A4H",
    type: "CLAS/OC",
    kind: "CLAS",
    label: "class",
    name: "ZCL_BIG",
    uri: "/sap/bc/adt/oo/classes/zcl_big",
    mode: "source",
    activation: "unknown",
    spec: {},
    ...over,
  } as unknown as ResolvedObject;
}

const conn = { cfg: { sid: "A4H" } } as unknown as AbapConnection;

const SRC = [
  "CLASS zcl_big DEFINITION.", // 1
  "  PUBLIC SECTION.", // 2
  "    METHODS run.", // 3
  "    METHODS stop.", // 4
  "ENDCLASS.", // 5
  "CLASS zcl_big IMPLEMENTATION.", // 6
  "  METHOD run.", // 7
  "    DATA lv_x TYPE i.", // 8
  "    lv_x = 1.", // 9
  "    SELECT SINGLE * FROM t000 INTO @DATA(ls).", // 10
  "  ENDMETHOD.", // 11
  "  METHOD stop.", // 12
  "    CLEAR lv_x.", // 13
  "  ENDMETHOD.", // 14
  "ENDCLASS.", // 15
].join("\n");

beforeEach(() => {
  stub.object = resolved();
  stub.source = SRC;
  stub.resolveCalls = 0;
});

describe("grepSource renders like grep -n -C", () => {
  it("numbers lines, marks matches with ':' and context with '-', separates groups with '--'", () => {
    const g = grepSource(SRC, "^\\s*METHOD ", { context: 1, fromLine: 1, maxMatches: 50 });
    expect(g.total).toBe(2);
    expect(g.shown).toBe(2);
    expect(g.truncated).toBe(false);
    expect(g.text.split("\n")).toEqual([
      " 6- CLASS zcl_big IMPLEMENTATION.",
      " 7:   METHOD run.",
      " 8-     DATA lv_x TYPE i.",
      "--",
      "11-   ENDMETHOD.",
      "12:   METHOD stop.",
      "13-     CLEAR lv_x.",
    ]);
  });

  it("merges overlapping windows so no line prints twice", () => {
    const g = grepSource(SRC, "lv_x", { context: 2, fromLine: 1, maxMatches: 50 });
    const numbered = g.text.split("\n").filter((l) => l !== "--").map((l) => Number(l.slice(0, 2)));
    expect(numbered).toEqual([...new Set(numbered)]);
    expect(g.total).toBe(3);
    expect(numbered).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it("is case-insensitive and honours fromLine and the match cap", () => {
    const g = grepSource(SRC, "method", { context: 0, fromLine: 8, maxMatches: 2 });
    // From line 8 on: 11 ENDMETHOD, 12 METHOD stop, 14 ENDMETHOD.
    expect(g.total).toBe(3);
    expect(g.shown).toBe(2);
    expect(g.truncated).toBe(true);
    expect(g.lastShownLine).toBe(12);
    expect(g.text).toBe("11:   ENDMETHOD.\n12:   METHOD stop.");
  });

  it("empty source: no matches, no text", () => {
    const g = grepSource("", "x", { context: 2, fromLine: 1, maxMatches: 5 });
    expect(g).toMatchObject({ text: "", total: 0, shown: 0, truncated: false });
  });
});

describe("abap_read pattern=", () => {
  it("returns only matching lines with default context 2 and absolute line numbers", async () => {
    const r = await abapRead(conn, { object: "ZCL_BIG", pattern: "SELECT" }, 47_100);
    expect(r.text).toContain("--- MATCHES ---");
    expect(r.text).not.toContain("--- SOURCE ---");
    expect(r.text).toMatch(/^pattern: SELECT$/m);
    expect(r.text).toMatch(/^context: 2$/m);
    expect(r.text).toMatch(/^matches: 1$/m);
    expect(r.text).toMatch(/^matchesShown: 1$/m);
    expect(r.text).toMatch(/^totalLines: 15$/m);
    expect(r.text).toContain(" 8-     DATA lv_x TYPE i.");
    expect(r.text).toContain("10:     SELECT SINGLE * FROM t000 INTO @DATA(ls).");
    expect(r.text).toContain("12-   METHOD stop.");
    expect(r.text).not.toContain("13-");
    // Never the whole text: the etag says so.
    expect(r.etag.startsWith("partial:")).toBe(true);
    expect(r.text).toMatch(/^etag: partial:/m);
  });

  it("context= applies to pattern (and is no longer refused without view=diff)", async () => {
    const r = await abapRead(conn, { object: "ZCL_BIG", pattern: "SELECT", context: 0 }, 47_100);
    expect(r.text).toMatch(/^context: 0$/m);
    expect(r.text).toContain("10:     SELECT");
    expect(r.text).not.toContain(" 9-");
  });

  it("context without pattern or view=diff is still refused, naming both", async () => {
    await expect(abapRead(conn, { object: "ZCL_BIG", context: 1 }, 47_100)).rejects.toMatchObject({
      code: "BAD_INPUT",
      message: expect.stringContaining('view="diff" or pattern'),
    });
  });

  it("caps matches (limit= overrides) and says how to continue", async () => {
    stub.source = Array.from({ length: 300 }, (_, i) => `  WRITE ${i + 1}.`).join("\n");
    const r = await abapRead(conn, { object: "ZCL_BIG", pattern: "WRITE", context: 0 }, 47_100);
    expect(r.text).toMatch(/^matches: 300$/m);
    expect(r.text).toMatch(new RegExp(`^matchesShown: ${PATTERN_MAX_MATCHES}$`, "m"));
    expect(r.text).toContain(`--- TRUNCATED --- ${PATTERN_MAX_MATCHES} of 300 matching line(s) shown`);
    expect(r.text).toContain(`offset=${PATTERN_MAX_MATCHES + 1}`);
    expect(r.text).toContain("raise with limit=");

    const r2 = await abapRead(conn, { object: "ZCL_BIG", pattern: "WRITE", context: 0, limit: 5, offset: 100 }, 47_100);
    expect(r2.text).toMatch(/^matchesShown: 5$/m);
    expect(r2.text).toMatch(/^matches: 201$/m);
    expect(r2.text).toMatch(/^scannedFrom: 100$/m);
    expect(r2.text).toContain("100:   WRITE 100.");
    expect(r2.text).toContain("offset=105");
    expect(r2.text).not.toContain("raise with limit=");
  });

  it("says when nothing matches", async () => {
    const r = await abapRead(conn, { object: "ZCL_BIG", pattern: "nomatch_here" }, 47_100);
    expect(r.text).toMatch(/^matches: 0$/m);
    expect(r.text).toContain("(no line of CLAS/OC ZCL_BIG matches /nomatch_here/i)");
  });

  it("an invalid or empty regex is BAD_INPUT before resolveObject runs (zero wire)", async () => {
    await expect(abapRead(conn, { object: "ZCL_BIG", pattern: "(" }, 47_100)).rejects.toMatchObject({
      code: "BAD_INPUT",
      message: expect.stringContaining("not a valid regular expression"),
    });
    await expect(abapRead(conn, { object: "ZCL_BIG", pattern: "" }, 47_100)).rejects.toMatchObject({
      code: "BAD_INPUT",
    });
    expect(stub.resolveCalls).toBe(0);
  });

  it.each([
    ["outline=true", { outline: true }],
    ["method", { method: "RUN" }],
  ])("pattern with %s is BAD_INPUT, zero wire", async (_label, extra) => {
    await expect(abapRead(conn, { object: "ZCL_BIG", pattern: "x", ...extra }, 47_100)).rejects.toMatchObject({
      code: "BAD_INPUT",
    });
    expect(stub.resolveCalls).toBe(0);
  });

  it("pattern with a view is refused rather than silently dropped", async () => {
    await expect(abapRead(conn, { object: "ZCL_BIG", pattern: "x", view: "history" }, 47_100)).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: expect.stringContaining("pattern"),
    });
  });

  it("pattern beats the default outline: a large class is grepped, not outlined", async () => {
    stub.source = Array.from({ length: 400 }, (_, i) => (i === 200 ? "  needle." : `  hay ${i}.`)).join("\n");
    const r = await abapRead(conn, { object: "ZCL_BIG", pattern: "needle" }, 47_100);
    expect(r.text).toContain("--- MATCHES ---");
    expect(r.text).toContain("201:   needle.");
    expect(r.text).not.toContain("--- OUTLINE ---");
  });
});
