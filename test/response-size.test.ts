/**
 * Issue #148 item 5: a `size:` line (chars, lines, truncated) in read and
 * search results — exact for the emitted text, rendered inside the budget so
 * the cap still holds. Pure tests over `buildResponse` plus the read/search
 * builders that opt in.
 */
import { describe, expect, it, vi } from "vitest";
import { buildResponse, formatSize } from "../src/compact.js";
import type { AbapConnection } from "../src/adt/connection.js";
import type { ResolvedObject } from "../src/adt/resolve.js";

const stub = { source: "" };

vi.mock("../src/adt/resolve.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/resolve.js")>()),
  resolveObject: async (): Promise<ResolvedObject> =>
    ({
      system: "A4H",
      type: "PROG/P",
      kind: "PROG",
      label: "program",
      name: "ZREPORT",
      uri: "/sap/bc/adt/programs/programs/zreport",
      mode: "source",
      activation: "unknown",
      spec: {},
    }) as unknown as ResolvedObject,
}));

vi.mock("../src/adt/source.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/source.js")>()),
  readSource: async () => ({ source: stub.source, serverEtag: '"W/etag"' }),
}));

const { abapRead } = await import("../src/tools/read.js");
const conn = { cfg: { sid: "A4H" } } as unknown as AbapConnection;

const sizeLine = (text: string) => {
  const m = /^size: (~?)(\d+) chars, (\d+) lines, truncated=(true|false)$/m.exec(text);
  expect(m, `no size line in:\n${text}`).not.toBeNull();
  return { approx: m![1] === "~", chars: Number(m![2]), lines: Number(m![3]), truncated: m![4] === "true" };
};

describe("buildResponse size line", () => {
  it("is absent unless asked for", () => {
    expect(buildResponse({ header: { a: 1 }, body: "x" }).text).not.toMatch(/^size:/m);
    expect(buildResponse({ header: { a: 1 }, body: "x" }).size).toBeUndefined();
  });

  it("states the exact chars and lines of the emitted text, complete case", () => {
    const r = buildResponse({ header: { object: "X" }, body: "a\nb\nc", bodyLabel: "SOURCE", size: true });
    const s = sizeLine(r.text);
    expect(s).toEqual({ approx: false, chars: r.text.length, lines: r.text.split("\n").length, truncated: false });
    expect(r.size).toEqual({ chars: s.chars, lines: s.lines, truncated: false });
    expect(r.text).toContain(`size: ${formatSize(r.size!)}`);
  });

  it("stays exact and inside the cap when the body is cut", () => {
    const body = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
    const maxChars = 1500;
    const r = buildResponse({ header: { object: "X" }, body, bodyLabel: "SOURCE", pagingParam: "offset", size: true, maxChars });
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(maxChars);
    const s = sizeLine(r.text);
    expect(s).toEqual({ approx: false, chars: r.text.length, lines: r.text.split("\n").length, truncated: true });
  });

  it("is exact across many sizes around digit boundaries", () => {
    for (const n of [1, 9, 10, 99, 100, 999, 1000, 1234, 2500, 9999, 10_000, 20_000]) {
      const body = "x".repeat(n);
      const r = buildResponse({ body, size: true, maxChars: 15_000 });
      const s = sizeLine(r.text);
      expect(s.chars, `n=${n}`).toBe(r.text.length);
      expect(s.lines, `n=${n}`).toBe(r.text.split("\n").length);
    }
  });
});

describe("abap_read states its size", () => {
  it("on a complete source read", async () => {
    stub.source = "REPORT zreport.\nWRITE 1.";
    const r = await abapRead(conn, { object: "ZREPORT" }, 47_100);
    const s = sizeLine(r.text);
    expect(s.chars).toBe(r.text.length);
    expect(s.truncated).toBe(false);
    expect(r.text).toMatch(/^response: complete/m);
  });

  it("on a truncated source read", async () => {
    stub.source = Array.from({ length: 3000 }, (_, i) => `WRITE ${i}.`).join("\n");
    const r = await abapRead(conn, { object: "ZREPORT", full: true }, 2000);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(2000);
    const s = sizeLine(r.text);
    expect(s.chars).toBe(r.text.length);
    expect(s.truncated).toBe(true);
  });
});
