/**
 * Regression test for the empty-source `abap_read` defect: a freshly
 * created object with a 0-byte `/source/main` was reported as
 * `totalLines: 1` with "Returned 0 of 1 line(s)" and a `partial:`-marked
 * etag — which then made `abap_write` refuse the caller's very next
 * full-source write. Root cause: `"".split("\n")` is `[""]` (length 1), not
 * an empty document; see `countLines` in src/compact.ts.
 *
 * Offline: `resolveObject`/`readSource` stubbed, same idiom as
 * test/read-search.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import type { ResolvedObject } from "../src/adt/resolve.js";
import { canonicalEtag } from "../src/adt/write.js";
import { countLines, sliceLines } from "../src/compact.js";

const stub = {
  object: {} as ResolvedObject,
  source: "",
};

vi.mock("../src/adt/resolve.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/resolve.js")>()),
  resolveObject: async () => stub.object,
}));

vi.mock("../src/adt/source.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/source.js")>()),
  readSource: async () => ({ source: stub.source, serverEtag: '"W/etag"' }),
  classMembers: async () => [],
  readMethod: async () => {
    throw new Error("not stubbed for this test file");
  },
}));

const { abapRead } = await import("../src/tools/read.js");

function resolved(over: Partial<ResolvedObject> = {}): ResolvedObject {
  return {
    system: "A4H",
    type: "DRUL/DRL",
    kind: "DRUL",
    label: "dependency rule",
    name: "ZTMD_DRUL_01",
    uri: "/sap/bc/adt/vit/wb/object_type/drulso/object_name/ztmd_drul_01",
    mode: "source",
    activation: "unknown",
    spec: {},
    ...over,
  } as unknown as ResolvedObject;
}

const conn = { cfg: { sid: "A4H" } } as unknown as AbapConnection;

beforeEach(() => {
  stub.object = resolved();
  stub.source = "";
});

describe("abap_read of a freshly created, empty (0-byte) object", () => {
  it("reports totalLines: 0 and response: complete, not the old 1-line/truncated shape", async () => {
    const r = await abapRead(conn, { object: "ZTMD_DRUL_01" }, 20_000);
    expect(r.text).toContain("totalLines: 0");
    expect(r.text).toMatch(/response: complete/);
    expect(r.text).not.toContain("--- WINDOW ---");
    expect(r.text).not.toContain("--- TRUNCATED ---");
    expect(r.text).not.toMatch(/Returned 0 of 1 line/);
    expect(r.text).not.toContain("INCOMPLETE");
  });

  it("does not mark the etag partial: — it must survive into the next full-source write", async () => {
    const r = await abapRead(conn, { object: "ZTMD_DRUL_01" }, 20_000);
    expect(r.text).not.toContain("partial:");
    expect(r.etag.startsWith("partial:")).toBe(false);
  });

  it("hands out exactly the etag abap_write's own comparison accepts for empty source", async () => {
    const r = await abapRead(conn, { object: "ZTMD_DRUL_01" }, 20_000);
    // resourceEtag (read.ts) delegates to canonicalEtag (write.ts) — this is
    // the same function assertEtagMatches hashes the server copy with, so an
    // unmarked etag here is guaranteed to be accepted by the next write.
    expect(r.etag).toBe(canonicalEtag(""));
  });

  it("explains the missing SOURCE section instead of leaving it silently absent", async () => {
    const r = await abapRead(conn, { object: "ZTMD_DRUL_01" }, 20_000);
    expect(r.text).toContain("Source is empty (0 bytes)");
    expect(r.text).not.toContain("--- SOURCE ---");
  });
});

describe("sliceLines/countLines treat an empty source as zero lines, not one", () => {
  it("sliceLines('') is { text: '', total: 0 }", () => {
    const w = sliceLines("");
    expect(w.text).toBe("");
    expect(w.total).toBe(0);
  });

  it("countLines('') is 0", () => {
    expect(countLines("")).toBe(0);
  });

  it("control: a normal one-line body is still counted as 1 line", () => {
    expect(countLines("a")).toBe(1);
    expect(sliceLines("a").total).toBe(1);
  });
});

describe('a source of exactly "\\n" is deliberately left as 2 lines', () => {
  // DECISION: "\n".split("\n") is ["", ""], so total=2 — the same
  // trailing-newline convention every source uses ("a\n" is also 2 lines).
  // bodyLines.length(2) < totalLines(2) is false, so this read was already
  // `complete` with a normal (unmarked) etag before this fix; the
  // truncation/partial-etag defect never touched it, so behavior here is
  // intentionally unchanged.
  it("counts 2 lines and reads as complete, not partial", async () => {
    expect(countLines("\n")).toBe(2);
    stub.source = "\n";
    const r = await abapRead(conn, { object: "ZTMD_DRUL_01" }, 20_000);
    expect(r.text).toContain("totalLines: 2");
    expect(r.text).toMatch(/response: complete/);
    expect(r.text).not.toContain("partial:");
  });
});
