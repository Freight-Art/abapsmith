/**
 * Offline unit tests for `src/debug/client.ts`. Zero live SAP calls —
 * every test runs against hand-rolled fakes (`FakeTransport`/`FakeListener`)
 * satisfying `DebugRequestIssuer`/`DebugListenIssuer`, never a real
 * `AbapConnection`. Covers: `toClassPool` (several lengths, including the
 * exact 30-char boundary), `resolveTerminalId` (stability + rejection), the
 * `stepWithBatch` 4-op recipe with a failing sub-request made visible, the
 * `@ROOT` → `getChildVariables` two-hop reroute, and the `terminateDebuggee`
 * 500-is-success unwrap.
 */
import { describe, expect, it } from "vitest";
import { AbapError } from "../src/adt/errors.js";
import {
  DebugClient,
  resolveTerminalId,
  toClassPool,
  type DebugListenIssuer,
  type DebugRequestIssuer,
} from "../src/debug/client.js";
import type { DebugRequestOptions, LongPollHandle } from "../src/debug/transport.js";
import type { RawResponse } from "../src/debug/types.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeTransport implements DebugRequestIssuer {
  public readonly calls: DebugRequestOptions[] = [];
  constructor(
    private readonly responder: RawResponse[] | ((opts: DebugRequestOptions, callIndex: number) => RawResponse),
  ) {}
  async request(opts: DebugRequestOptions): Promise<RawResponse> {
    const idx = this.calls.length;
    this.calls.push(opts);
    if (typeof this.responder === "function") {
      return this.responder(opts, idx);
    }
    const r = this.responder[idx];
    if (!r) throw new Error(`FakeTransport: no response queued for call #${idx} (${opts.method} ${opts.path})`);
    return r;
  }
}

class FakeListener implements DebugListenIssuer {
  public lastPath?: string;
  constructor(private readonly response: RawResponse = { status: 200, headers: {}, body: "" }) {}
  listen(path: string): LongPollHandle {
    this.lastPath = path;
    return {
      armed: Promise.resolve(),
      result: Promise.resolve(this.response),
      abort: () => {},
      aborted: false,
    };
  }
}

const TERMINAL = "A".repeat(32);
const IDE = "B".repeat(32);

// --- Response-body helpers for the getChildVariables / getRootVariables tests ---

const ASX_OPEN = `<?xml version="1.0" encoding="utf-8"?>
<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA>`;
const ASX_CLOSE = `</DATA></asx:values></asx:abap>`;

/** A well-formed 200 carrying neither hierarchies nor variables. */
const EMPTY_CHILD_XML = `${ASX_OPEN}<HIERARCHIES/><VARIABLES/>${ASX_CLOSE}`;

/** Hop-1 shape: a scope INDEX — `HIERARCHIES` of scope handles, zero `VARIABLES`. */
function hierarchyXml(childIds: readonly string[]): string {
  const rows = childIds
    .map(
      (id) =>
        `<STPDA_ADT_VARIABLE_HIERARCHY><PARENT_ID>@ROOT</PARENT_ID><CHILD_ID>${id}</CHILD_ID>` +
        `<CHILD_NAME>${id.trim()}</CHILD_NAME></STPDA_ADT_VARIABLE_HIERARCHY>`,
    )
    .join("");
  return `${ASX_OPEN}<HIERARCHIES>${rows}</HIERARCHIES><VARIABLES/>${ASX_CLOSE}`;
}

/** Hop-2 shape: real variables. */
function variablesXml(names: readonly string[]): string {
  const rows = names
    .map(
      (n) =>
        `<STPDA_ADT_VARIABLE><ID>${n}</ID><NAME>${n}</NAME><META_TYPE>simple</META_TYPE>` +
        `<VALUE>1</VALUE></STPDA_ADT_VARIABLE>`,
    )
    .join("");
  return `${ASX_OPEN}<HIERARCHIES/><VARIABLES>${rows}</VARIABLES>${ASX_CLOSE}`;
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// ---------------------------------------------------------------------------
// toClassPool
// ---------------------------------------------------------------------------

describe("toClassPool", () => {
  it("matches the live-verified fixture exactly", () => {
    expect(toClassPool("ZMCP_DBG_RUN")).toBe("ZMCP_DBG_RUN==================CP");
  });

  it("uppercases a lowercase class name", () => {
    expect(toClassPool("zmcp_dbg_run")).toBe("ZMCP_DBG_RUN==================CP");
  });

  it("pads a short (single-character) class name", () => {
    expect(toClassPool("Z")).toBe("Z" + "=".repeat(29) + "CP");
    expect(toClassPool("Z")).toHaveLength(32);
  });

  it("pads a medium-length class name (5 chars)", () => {
    expect(toClassPool("ZCL_X")).toBe("ZCL_X" + "=".repeat(25) + "CP");
  });

  it("BOUNDARY: exactly 30 characters needs no padding at all", () => {
    const name = "Z" + "A".repeat(29); // 30 chars total
    expect(name).toHaveLength(30);
    expect(toClassPool(name)).toBe(name + "CP");
    expect(toClassPool(name)).toHaveLength(32);
  });

  it("BOUNDARY: 31 characters is rejected, not silently truncated", () => {
    const name = "Z" + "A".repeat(30); // 31 chars
    expect(() => toClassPool(name)).toThrow(/30/);
  });

  it("rejects an empty class name", () => {
    expect(() => toClassPool("")).toThrow();
    expect(() => toClassPool("   ")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// resolveTerminalId
// ---------------------------------------------------------------------------

describe("resolveTerminalId", () => {
  it("is stable across repeated calls with the same seed (never random per call)", () => {
    const a = resolveTerminalId({ seed: "user=DEVELOPER;url=http://a4h:50000" });
    const b = resolveTerminalId({ seed: "user=DEVELOPER;url=http://a4h:50000" });
    expect(a).toBe(b);
    expect(a).toHaveLength(32);
  });

  it("differs for a different seed", () => {
    const a = resolveTerminalId({ seed: "one" });
    const b = resolveTerminalId({ seed: "two" });
    expect(a).not.toBe(b);
  });

  it("is identical between a breakpoint-setting call and a listening call sharing the same seed", () => {
    // Simulates deriving the same id twice for two different debugger operations.
    const seed = "user=DEVELOPER;url=http://a4h:50000";
    const forBreakpoints = resolveTerminalId({ seed });
    const forListening = resolveTerminalId({ seed });
    expect(forBreakpoints).toBe(forListening);
  });

  it("produces exactly 32 uppercase hex characters", () => {
    const id = resolveTerminalId({ seed: "anything" });
    expect(id).toMatch(/^[0-9A-F]{32}$/);
  });

  it("prefers an explicit override when given", () => {
    const explicit = "C".repeat(32);
    expect(resolveTerminalId({ explicit, seed: "ignored-when-explicit-is-set" })).toBe(explicit);
  });

  it("rejects an explicit override that is not exactly 32 characters", () => {
    expect(() => resolveTerminalId({ explicit: "TOO_SHORT", seed: "x" })).toThrow(/32/);
    expect(() => resolveTerminalId({ explicit: "D".repeat(33), seed: "x" })).toThrow(/32/);
  });

  it("falls back to the seed-derived id when explicit is empty/whitespace", () => {
    const withEmpty = resolveTerminalId({ explicit: "", seed: "seed-x" });
    const withoutExplicit = resolveTerminalId({ seed: "seed-x" });
    expect(withEmpty).toBe(withoutExplicit);
  });
});

// ---------------------------------------------------------------------------
// getRootVariables — the @ROOT -> getChildVariables reroute (two round trips)
// ---------------------------------------------------------------------------

describe("getRootVariables — the @ROOT reroute", () => {
  it("resolves the scope index first, then expands every scope id in a second call", async () => {
    const scopeXml = `<?xml version="1.0" encoding="utf-8"?>
<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA><HIERARCHIES>
<STPDA_ADT_VARIABLE_HIERARCHY><PARENT_ID>@ROOT</PARENT_ID><CHILD_ID>@GLOBALS</CHILD_ID><CHILD_NAME>Globals</CHILD_NAME></STPDA_ADT_VARIABLE_HIERARCHY>
</HIERARCHIES><VARIABLES/></DATA></asx:values></asx:abap>`;
    const localsXml = `<?xml version="1.0" encoding="utf-8"?>
<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA><HIERARCHIES/><VARIABLES>
<STPDA_ADT_VARIABLE><ID>LV_COUNTER</ID><NAME>LV_COUNTER</NAME><META_TYPE>simple</META_TYPE><VALUE>3</VALUE></STPDA_ADT_VARIABLE>
</VARIABLES></DATA></asx:values></asx:abap>`;

    const fake = new FakeTransport([
      { status: 200, headers: {}, body: scopeXml },
      { status: 200, headers: {}, body: localsXml },
    ]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    const result = await client.getRootVariables();

    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]!.body).toContain("@ROOT");
    expect(fake.calls[1]!.body).toContain("@GLOBALS");
    expect(result.scopes).toEqual([{ parentId: "@ROOT", childId: "@GLOBALS", childName: "Globals" }]);
    expect(result.variables.variables).toHaveLength(1);
    expect(result.variables.variables[0]!.name).toBe("LV_COUNTER");
  });

  it("does not make a second round trip when @ROOT has no scope children (Trap C)", async () => {
    const emptyXml = `<?xml version="1.0" encoding="utf-8"?>
<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA><HIERARCHIES/><VARIABLES/></DATA></asx:values></asx:abap>`;
    const fake = new FakeTransport([{ status: 200, headers: {}, body: emptyXml }]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    const result = await client.getRootVariables();

    expect(fake.calls).toHaveLength(1);
    // An empty `variables` ALONE is ambiguous (Trap C): "no scopes at all" and "scopes
    // that held nothing" look identical. `outcome` is the discriminator and is the
    // assertion that actually pins the behaviour down.
    expect(result.outcome).toBe("no-scopes");
    expect(result.variables.variables).toEqual([]);
    expect(result.scopes).toEqual([]);
  });

  it("G: reports outcome 'no-scopes' and makes exactly ONE transport call when hop 1 is empty", async () => {
    const fake = new FakeTransport([{ status: 200, headers: {}, body: EMPTY_CHILD_XML }]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    const result = await client.getRootVariables();
    expect(result.outcome).toBe("no-scopes");
    expect(fake.calls).toHaveLength(1);
  });

  it("H: reports outcome 'empty-scopes' when hop 1 gives scopes but hop 2 yields zero variables", async () => {
    const fake = new FakeTransport([
      { status: 200, headers: {}, body: hierarchyXml(["@GLOBALS"]) },
      { status: 200, headers: {}, body: EMPTY_CHILD_XML },
    ]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    const result = await client.getRootVariables();
    expect(result.outcome).toBe("empty-scopes");
    expect(fake.calls).toHaveLength(2);
  });

  it("I: reports outcome 'enumerated' and returns PARSED variables on a real two-hop enumeration", async () => {
    const fake = new FakeTransport([
      { status: 200, headers: {}, body: hierarchyXml(["@GLOBALS", "@LOCALS"]) },
      { status: 200, headers: {}, body: variablesXml(["LV_COUNTER", "LT_ITEMS"]) },
    ]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    const result = await client.getRootVariables();
    expect(result.outcome).toBe("enumerated");
    expect(result.variables.variables).toHaveLength(2);
    expect(result.variables.variables.map((v) => v.name)).toEqual(["LV_COUNTER", "LT_ITEMS"]);
    expect(fake.calls).toHaveLength(2);
  });

  it("J: dedupes hop-1 handles and drops the @ROOT self-reference before hop 2", async () => {
    const fake = new FakeTransport([
      { status: 200, headers: {}, body: hierarchyXml(["@GLOBALS", "@GLOBALS", "@LOCALS", "@ROOT", " @LOCALS "]) },
      { status: 200, headers: {}, body: variablesXml(["LV_COUNTER"]) },
    ]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    const result = await client.getRootVariables();

    expect(fake.calls).toHaveLength(2); // exactly 2 — never a third hop, never a loop
    const hop2 = fake.calls[1]!.body ?? "";
    expect(occurrences(hop2, "@GLOBALS")).toBe(1);
    expect(occurrences(hop2, "@LOCALS")).toBe(1);
    expect(hop2).not.toContain("@ROOT"); // the self-reference must not be re-asked
    expect(result.outcome).toBe("enumerated");
  });
});

// ---------------------------------------------------------------------------
// getChildVariables — the @ROOT rejection guard (never reaches the wire)
// ---------------------------------------------------------------------------

describe("getChildVariables — @ROOT is rejected before any transport call", () => {
  it("A: rejects a lone @ROOT, names getRootVariables AND abap_debug_vars, and never hits the wire", async () => {
    const fake = new FakeTransport([]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    await expect(client.getChildVariables(["@ROOT"])).rejects.toThrow(/getRootVariables/);
    expect(fake.calls).toHaveLength(0);

    const fake2 = new FakeTransport([]);
    const client2 = new DebugClient({ transport: fake2, longPoll: new FakeListener() });
    await expect(client2.getChildVariables(["@ROOT"])).rejects.toThrow(/abap_debug_vars/);
    expect(fake2.calls).toHaveLength(0);
  });

  it("B: MIXED BATCH — ['@ROOT','LT_ITEMS[1]'] rejects the WHOLE call, sending no partial batch", async () => {
    const fake = new FakeTransport([{ status: 200, headers: {}, body: EMPTY_CHILD_XML }]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    await expect(client.getChildVariables(["@ROOT", "LT_ITEMS[1]"])).rejects.toThrow(/getRootVariables/);
    // The decisive assertion: not one byte went out, so LT_ITEMS[1] was NOT sent alone.
    expect(fake.calls).toHaveLength(0);
  });

  it("B2: MIXED BATCH with @ROOT in the LAST position also rejects wholesale", async () => {
    const fake = new FakeTransport([{ status: 200, headers: {}, body: EMPTY_CHILD_XML }]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    await expect(client.getChildVariables(["LT_ITEMS[1]", "@ROOT"])).rejects.toThrow(/getRootVariables/);
    expect(fake.calls).toHaveLength(0);
  });

  it("C: rejects @root and @Root — the token is matched CASE-INSENSITIVELY", async () => {
    for (const variant of ["@root", "@Root", "@rOoT"]) {
      const fake = new FakeTransport([{ status: 200, headers: {}, body: EMPTY_CHILD_XML }]);
      const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
      await expect(client.getChildVariables([variant])).rejects.toThrow(/getRootVariables/);
      expect(fake.calls).toHaveLength(0);
    }
  });

  it("D: trims a padded ordinary id before it reaches the wire", async () => {
    const fake = new FakeTransport([{ status: 200, headers: {}, body: EMPTY_CHILD_XML }]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    await client.getChildVariables(["  LT_ITEMS[1]  "]);
    expect(fake.calls).toHaveLength(1);
    const body = fake.calls[0]!.body ?? "";
    expect(body).toContain("LT_ITEMS[1]");
    expect(body).not.toContain("  LT_ITEMS[1]  ");
  });

  it("D2: rejects '  @ROOT  ' — the guard applies AFTER trimming", async () => {
    const fake = new FakeTransport([{ status: 200, headers: {}, body: EMPTY_CHILD_XML }]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    await expect(client.getChildVariables(["  @ROOT  "])).rejects.toThrow(/getRootVariables/);
    expect(fake.calls).toHaveLength(0);
  });

  it("E: @GLOBALS is a LEGITIMATE parent and passes through to the wire", async () => {
    const fake = new FakeTransport([{ status: 200, headers: {}, body: variablesXml(["LV_X"]) }]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    const result = await client.getChildVariables(["@GLOBALS"]);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.body).toContain("@GLOBALS");
    expect(result.variables.map((v) => v.name)).toEqual(["LV_X"]);
  });

  it("E2: @LOCALS and @PARAMETERS also pass through", async () => {
    const fake = new FakeTransport([{ status: 200, headers: {}, body: EMPTY_CHILD_XML }]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    await client.getChildVariables(["@LOCALS", "@PARAMETERS"]);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.body).toContain("@LOCALS");
    expect(fake.calls[0]!.body).toContain("@PARAMETERS");
  });

  it("F: rejects an empty array with BAD_INPUT and never hits the wire", async () => {
    const fake = new FakeTransport([{ status: 200, headers: {}, body: EMPTY_CHILD_XML }]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    await expect(client.getChildVariables([])).rejects.toMatchObject({ code: "BAD_INPUT" });
    expect(fake.calls).toHaveLength(0);
  });

  it("F2: rejects a blank-after-trim id with BAD_INPUT naming its index", async () => {
    const fake = new FakeTransport([{ status: 200, headers: {}, body: EMPTY_CHILD_XML }]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    await expect(client.getChildVariables(["LS_ITEM", "   "])).rejects.toThrow(/parentIds\[1\]/);
    expect(fake.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// stepWithBatch — the ported 4-op recipe, rewritten to surface failures
// ---------------------------------------------------------------------------

describe("stepWithBatch — the ported 4-op recipe", () => {
  it("issues one batch POST with 4 sub-operations and a failing sub-request is VISIBLE, not flattened to success", async () => {
    const boundary = "batch_test123";
    const stepXml = `<dbg:step xmlns:dbg="http://www.sap.com/adt/debugger" isRfc="false"/>`;
    // REAL frames. A childless self-closing <dbg:stack/> never enters the frame
    // loop, so the old fixture proved nothing about frame parsing.
    const stackXml = STACK_XML;
    const rootXml =
      `<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA>` +
      `<HIERARCHIES><STPDA_ADT_VARIABLE_HIERARCHY><PARENT_ID>@ROOT</PARENT_ID><CHILD_ID>@GLOBALS</CHILD_ID>` +
      `<CHILD_NAME>Globals</CHILD_NAME></STPDA_ADT_VARIABLE_HIERARCHY></HIERARCHIES><VARIABLES/>` +
      `</DATA></asx:values></asx:abap>`;
    const canaryErrorXml =
      `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationFramework">` +
      `<type id="AdiFailed"/><message lang="EN">No session attached</message><properties>` +
      `<entry key="com.sap.adt.communicationFramework.subType">noSessionAttached</entry>` +
      `</properties></exc:exception>`;

    const multipart =
      `--${boundary}\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/xml\r\n\r\n${stepXml}\r\n` +
      `--${boundary}\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/xml\r\n\r\n${stackXml}\r\n` +
      `--${boundary}\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/xml\r\n\r\n${rootXml}\r\n` +
      `--${boundary}\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 500 Internal Server Error\r\nContent-Type: application/xml\r\n\r\n${canaryErrorXml}\r\n` +
      `--${boundary}--\r\n`;

    const fake = new FakeTransport([{ status: 200, headers: {}, body: multipart }]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    const result = await client.stepWithBatch("stepOver");

    expect(fake.calls).toHaveLength(1); // ONE batch POST, not 4 round trips
    expect(fake.calls[0]!.method).toBe("POST");
    expect(fake.calls[0]!.body).toContain("stepOver");
    expect(fake.calls[0]!.body).toContain("getChildVariables");
    expect(fake.calls[0]!.body).toContain("getVariables");

    expect(result.step.ok).toBe(true);
    expect(result.stack.ok).toBe(true);
    expect(result.rootVariables.ok).toBe(true);

    // The stack part must yield REAL PARSED FRAMES, not merely `ok: true`.
    if (result.stack.ok) {
      expect(result.stack.value.frames).toHaveLength(2);
      expect(result.stack.value.frames[0]!.programName).toBe("ZMCP_DBG_RUN");
      expect(result.stack.value.frames[0]!.line).toBe(17);
      expect(result.stack.value.frames[0]!.stackPosition).toBe(1);
      expect(result.stack.value.frames[1]!.programName).toBe("SAPMSSY1");
      expect(result.stack.value.frames[1]!.line).toBe(105);
      expect(result.stack.value.frames[1]!.stackPosition).toBe(2);
    }

    // The failing sub-request (the canary) must be VISIBLE, never silently
    // flattened to success (a known earlier bug).
    expect(result.canary.ok).toBe(false);
    if (!result.canary.ok) {
      expect(result.canary.error.status).toBe(500);
      expect(result.canary.error.subtype).toBe("noSessionAttached");
    }
  });

  // decodeBatchPart's "2xx but unparseable" branch. A sub-response that succeeded
  // at the HTTP level but whose body the parser cannot read must surface as
  // ok:false. Flattening it into a success is the exact bug this rewrite existed
  // to fix, and no test reached this path before.
  it("surfaces a 2xx sub-response with an UNPARSEABLE body as ok:false, never flattened to success", async () => {
    const boundary = "batch_unparseable";
    const okStep = `<dbg:step xmlns:dbg="http://www.sap.com/adt/debugger" isRfc="false"/>`;
    const junkStack = `<dbg:notAStackAtAll xmlns:dbg="http://www.sap.com/adt/debugger"/>`;
    const emptyRoot =
      `<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA>` +
      `<HIERARCHIES/><VARIABLES/></DATA></asx:values></asx:abap>`;
    const emptyVars =
      `<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA/></asx:values></asx:abap>`;

    const part = (body: string): string =>
      `--${boundary}\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/xml\r\n\r\n${body}\r\n`;
    const multipart = part(okStep) + part(junkStack) + part(emptyRoot) + part(emptyVars) + `--${boundary}--\r\n`;

    const fake = new FakeTransport([{ status: 200, headers: {}, body: multipart }]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    const result = await client.stepWithBatch("stepOver");

    // The unparseable part is VISIBLE as a failure...
    expect(result.stack.ok).toBe(false);
    if (!result.stack.ok) {
      // status echoes the 2xx — proving this is the unparseable branch, not the >=400 branch.
      expect(result.stack.error.status).toBe(200);
      expect(result.stack.error.message).toMatch(/dbg:stack/);
      expect(result.stack.error.path).toContain("getStack");
      expect(result.stack.error.bodyExcerpt).toContain("notAStackAtAll");
    }
    // ...and its siblings are unaffected: one bad part must not poison the batch.
    expect(result.step.ok).toBe(true);
    expect(result.rootVariables.ok).toBe(true);
  });

  // review finding 13: this bodyExcerpt used to be a silent 2000-char slice with
  // no marker — the exact path an ABAP short dump on a 2xx-but-unparseable
  // sub-response would travel. It must now route through truncateDiagnosticBody
  // (20000-char limit) and always carry the truncation marker when cut.
  it("marks bodyExcerpt as truncated when an unparseable sub-response body exceeds 20000 chars", async () => {
    const boundary = "batch_oversized";
    const okStep = `<dbg:step xmlns:dbg="http://www.sap.com/adt/debugger" isRfc="false"/>`;
    const padding = "X".repeat(25000);
    const junkStack = `<dbg:notAStackAtAll xmlns:dbg="http://www.sap.com/adt/debugger" pad="${padding}"/>`;
    const emptyRoot =
      `<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA>` +
      `<HIERARCHIES/><VARIABLES/></DATA></asx:values></asx:abap>`;
    const emptyVars =
      `<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA/></asx:values></asx:abap>`;

    const part = (body: string): string =>
      `--${boundary}\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/xml\r\n\r\n${body}\r\n`;
    const multipart = part(okStep) + part(junkStack) + part(emptyRoot) + part(emptyVars) + `--${boundary}--\r\n`;

    const fake = new FakeTransport([{ status: 200, headers: {}, body: multipart }]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    const result = await client.stepWithBatch("stepOver");

    expect(result.stack.ok).toBe(false);
    if (!result.stack.ok) {
      expect(result.stack.error.bodyExcerpt.length).toBeGreaterThan(20000);
      expect(result.stack.error.bodyExcerpt).toMatch(/… \[truncated, \d+ of \d+ chars shown\]/);
      // the excerpt itself must not silently exceed the 20000-char content budget
      expect(result.stack.error.bodyExcerpt.length).toBeLessThan(20200);
    }
  });
});

describe("runBatch — per-sub-request status is never flattened", () => {
  it("reports each sub-response's own status", async () => {
    const boundary = "batch_x";
    const multipart =
      `--${boundary}\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 200 OK\r\n\r\n<ok/>\r\n` +
      `--${boundary}\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 500 Internal Server Error\r\n\r\n<bad/>\r\n` +
      `--${boundary}--\r\n`;
    const fake = new FakeTransport([{ status: 200, headers: {}, body: multipart }]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    const results = await client.runBatch([
      { method: "GET", path: "/x" },
      { method: "GET", path: "/y" },
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 500]);
  });

  it("rejects an empty operation list", async () => {
    const client = new DebugClient({ transport: new FakeTransport([]), longPoll: new FakeListener() });
    await expect(client.runBatch([])).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// terminateDebuggee — the 500-is-success unwrap
// ---------------------------------------------------------------------------

describe("terminateDebuggee", () => {
  it("resolves normally on a plain 200", async () => {
    const fake = new FakeTransport([{ status: 200, headers: {}, body: "" }]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    await expect(client.terminateDebuggee()).resolves.toEqual({ terminated: true });
  });

  it("treats HTTP 500 + subtype=terminateDebuggee as SUCCESS", async () => {
    const err = new AbapError("ADT_ERROR", "boom", { status: 500, subtype: "terminateDebuggee" });
    const fake = new FakeTransport(() => {
      throw err;
    });
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    await expect(client.terminateDebuggee()).resolves.toEqual({ terminated: true });
  });

  it("rethrows any other error untouched", async () => {
    const err = new AbapError("AUTH_FAILED", "nope", { status: 401 });
    const fake = new FakeTransport(() => {
      throw err;
    });
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    await expect(client.terminateDebuggee()).rejects.toThrow("nope");
  });
});

// ---------------------------------------------------------------------------
// launchListener — parses the long-poll's settled result
// ---------------------------------------------------------------------------

describe("launchListener", () => {
  it("parses an empty 200 body as 'empty' (not a timeout)", async () => {
    const fake = new FakeListener({ status: 200, headers: {}, body: "" });
    const client = new DebugClient({ transport: new FakeTransport([]), longPoll: fake });
    const handle = client.launchListener({
      debuggingMode: "user",
      terminalId: TERMINAL,
      ideId: IDE,
      requestUser: "DEV",
    });
    await expect(handle.result).resolves.toEqual({ kind: "empty" });
  });

  it("an empty body is never labelled a timeout — the wire cannot tell timeout from a cancelled poll", async () => {
    const fake = new FakeListener({ status: 200, headers: {}, body: "" });
    const client = new DebugClient({ transport: new FakeTransport([]), longPoll: fake });
    const handle = client.launchListener({
      debuggingMode: "user",
      terminalId: TERMINAL,
      ideId: IDE,
      requestUser: "DEV",
    });
    const result = await handle.result;
    expect(result.kind).toBe("empty");
    expect(result.kind).not.toBe("timeout");
  });

  it("parses a whitespace-only 200 body as 'empty' (the parser trims)", async () => {
    const fake = new FakeListener({ status: 200, headers: {}, body: "\n  " });
    const client = new DebugClient({ transport: new FakeTransport([]), longPoll: fake });
    const handle = client.launchListener({
      debuggingMode: "user",
      terminalId: TERMINAL,
      ideId: IDE,
      requestUser: "DEV",
    });
    await expect(handle.result).resolves.toEqual({ kind: "empty" });
  });

  it("parses a caught debuggee body", async () => {
    const debuggeeXml =
      `<?xml version="1.0" encoding="utf-8"?><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">` +
      `<asx:values><DATA><STPDA_DEBUGGEE><DEBUGGEE_ID>D1</DEBUGGEE_ID><DBGEE_KIND>DEBUGGEE</DBGEE_KIND>` +
      `</STPDA_DEBUGGEE></DATA></asx:values></asx:abap>`;
    const fake = new FakeListener({ status: 200, headers: {}, body: debuggeeXml });
    const client = new DebugClient({ transport: new FakeTransport([]), longPoll: fake });
    const handle = client.launchListener({
      debuggingMode: "user",
      terminalId: TERMINAL,
      ideId: IDE,
      requestUser: "DEV",
    });
    const result = await handle.result;
    expect(result.kind).toBe("debuggee");
    if (result.kind === "debuggee") expect(result.debuggee.id).toBe("D1");
  });

  it("parses a conflict body (the displaced client's conflictNotification)", async () => {
    const conflictXml =
      `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationFramework">` +
      `<message lang="EN">busy</message><properties>` +
      `<entry key="com.sap.adt.communicationFramework.subType">conflictNotification</entry>` +
      `<entry key="conflictText">Another user is debugging this session</entry>` +
      `<entry key="ideUser">OTHERUSER</entry></properties></exc:exception>`;
    const fake = new FakeListener({ status: 200, headers: {}, body: conflictXml });
    const client = new DebugClient({ transport: new FakeTransport([]), longPoll: fake });
    const handle = client.launchListener({
      debuggingMode: "user",
      terminalId: TERMINAL,
      ideId: IDE,
      requestUser: "DEV",
    });
    const result = await handle.result;
    expect(result.kind).toBe("conflict");
    if (result.kind === "conflict") {
      expect(result.conflict.conflictText).toContain("Another user");
      expect(result.conflict.ideUser).toBe("OTHERUSER");
    }
  });

  it("still reports 'debuggee' for a debuggee body — the 'empty' variant did not swallow it", async () => {
    const debuggeeXml =
      `<?xml version="1.0" encoding="utf-8"?><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">` +
      `<asx:values><DATA><STPDA_DEBUGGEE><DEBUGGEE_ID>D1</DEBUGGEE_ID><DBGEE_KIND>DEBUGGEE</DBGEE_KIND>` +
      `</STPDA_DEBUGGEE></DATA></asx:values></asx:abap>`;
    const fake = new FakeListener({ status: 200, headers: {}, body: debuggeeXml });
    const client = new DebugClient({ transport: new FakeTransport([]), longPoll: fake });
    const handle = client.launchListener({
      debuggingMode: "user",
      terminalId: TERMINAL,
      ideId: IDE,
      requestUser: "DEV",
    });
    const result = await handle.result;
    expect(result.kind).toBe("debuggee");
  });

  it("still reports 'conflict' for a conflict body — the 'empty' variant did not swallow it", async () => {
    const conflictXml =
      `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationFramework">` +
      `<message lang="EN">busy</message><properties>` +
      `<entry key="com.sap.adt.communicationFramework.subType">conflictNotification</entry>` +
      `<entry key="conflictText">Another user is debugging this session</entry>` +
      `<entry key="ideUser">OTHERUSER</entry></properties></exc:exception>`;
    const fake = new FakeListener({ status: 200, headers: {}, body: conflictXml });
    const client = new DebugClient({ transport: new FakeTransport([]), longPoll: fake });
    const handle = client.launchListener({
      debuggingMode: "user",
      terminalId: TERMINAL,
      ideId: IDE,
      requestUser: "DEV",
    });
    const result = await handle.result;
    expect(result.kind).toBe("conflict");
  });
});

// ---------------------------------------------------------------------------
// getListener — non-blocking status check
// ---------------------------------------------------------------------------

describe("getListener", () => {
  it("reports 'exists' for a 200 empty body in the query branch", async () => {
    const fake = new FakeTransport([{ status: 200, headers: {}, body: "" }]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    const result = await client.getListener({ debuggingMode: "user", terminalId: TERMINAL, ideId: IDE, requestUser: "DEV" });
    expect(result).toEqual({ kind: "exists" });
  });

  it("reports 'clear' for a 200 empty body in the checkConflict=true branch", async () => {
    const fake = new FakeTransport([{ status: 200, headers: {}, body: "" }]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    const result = await client.getListener({
      debuggingMode: "user",
      terminalId: TERMINAL,
      ideId: IDE,
      requestUser: "DEV",
      checkConflict: true,
    });
    expect(result).toEqual({ kind: "clear" });
  });
});

// ---------------------------------------------------------------------------
// Composition sanity — URL/body/header wiring for a few remaining methods
// ---------------------------------------------------------------------------

describe("composition sanity", () => {
  it("setBreakpoints builds the breakpoints XML body and posts to the breakpoints path", async () => {
    const fake = new FakeTransport([
      {
        status: 200,
        headers: {},
        body:
          `<?xml version="1.0"?><dbg:breakpoints xmlns:dbg="http://www.sap.com/adt/debugger">` +
          `<dbg:breakpoint kind="line" id="X" uri="/sap/bc/adt/programs/programs/ZFOO/source/main#start=1"/>` +
          `<dbg:breakpoint kind="statement" id="Y" uri="/sap/bc/adt/programs/programs/ZFOO/source/main#start=9"/>` +
          `</dbg:breakpoints>`,
      },
    ]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    const created = (await client.setBreakpoints({
      debuggingMode: "user",
      scope: "external",
      requestUser: "DEV",
      breakpoints: [{ kind: "statement", statement: "WRITE" }],
    })) as unknown as Array<{ id: string; kind: string; uri?: string }>;
    expect(fake.calls[0]!.method).toBe("POST");
    expect(fake.calls[0]!.path).toContain("/debugger/breakpoints");
    expect(fake.calls[0]!.body).toContain("statement");
    // PARSED RESULT, not just the request arguments: a parser that returned []
    // used to pass this test unchanged.
    expect(created).toHaveLength(2);
    expect(created.map((b) => b.id)).toEqual(["X", "Y"]);
    expect(created.map((b) => b.kind)).toEqual(["line", "statement"]);
    expect(created[0]!.uri).toContain("start=1");
  });

  it("getVariables posts path-addressed ids as the asx:abap body", async () => {
    const fake = new FakeTransport([
      {
        status: 200,
        headers: {},
        body:
          `<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA>` +
          `<STPDA_ADT_VARIABLE><ID>LT_ITEMS[1]-MATNR</ID><NAME>MATNR</NAME><META_TYPE>simple</META_TYPE>` +
          `<VALUE>4711</VALUE></STPDA_ADT_VARIABLE>` +
          `<STPDA_ADT_VARIABLE><ID>LV_COUNT</ID><NAME>LV_COUNT</NAME><META_TYPE>simple</META_TYPE>` +
          `<VALUE>42</VALUE></STPDA_ADT_VARIABLE>` +
          `</DATA></asx:values></asx:abap>`,
      },
    ]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    const vars = await client.getVariables(["LT_ITEMS[1]-MATNR", "LV_COUNT"]);
    expect(fake.calls[0]!.body).toContain("LT_ITEMS[1]-MATNR");
    expect(fake.calls[0]!.path).toContain("method=getVariables");
    // PARSED RESULT: this test used to pass even if the parser returned [].
    expect(vars).toHaveLength(2);
    expect(vars[0]!.id).toBe("LT_ITEMS[1]-MATNR");
    expect(vars[0]!.name).toBe("MATNR");
    expect(vars[0]!.value).toBe("4711");
    expect(vars[1]!.id).toBe("LV_COUNT");
    expect(vars[1]!.value).toBe("42");
  });

  it("setStackPosition is 1-based and rejects 0", async () => {
    const client = new DebugClient({ transport: new FakeTransport([]), longPoll: new FakeListener() });
    await expect(client.setStackPosition({ stackPosition: 0, stackType: "ABAP" })).rejects.toThrow(/1-based/);
  });

  // REGRESSION PIN: the live server rejected `stackType`/`stackPosition` with
  // `Parameter position could not be found.` — the wire name is `position`.
  it("setStackPosition sends a 1-based `position` and no stackType", async () => {
    const fake = new FakeTransport([{ status: 200, headers: {}, body: "" }]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    await client.setStackPosition({ stackPosition: 2, stackType: "ABAP" });
    const call = fake.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/sap/bc/adt/debugger?method=setStackPosition&position=2");
    expect(call.path).not.toContain("stackType");
    expect(call.path).not.toContain("stackPosition=");
    expect(call.body).toBeUndefined();
  });

  it("deleteBreakpoint issues a DELETE with the encoded id in the path", async () => {
    const fake = new FakeTransport([{ status: 200, headers: {}, body: "" }]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    await client.deleteBreakpoint({
      id: "KIND=0.LINE_NR=5",
      scope: "external",
      debuggingMode: "user",
      requestUser: "DEV",
    });
    expect(fake.calls[0]!.method).toBe("DELETE");
    expect(fake.calls[0]!.path).toContain(encodeURIComponent("KIND=0.LINE_NR=5"));
  });
});

// ---------------------------------------------------------------------------
// terminateDebuggee: subtype AND status must both be acceptable
// ---------------------------------------------------------------------------

/** Builds a client whose only transport call throws the given AbapError. */
function throwingClient(err: AbapError): DebugClient {
  return new DebugClient({
    transport: new FakeTransport(() => {
      throw err;
    }),
    longPoll: new FakeListener(),
  });
}

describe("terminateDebuggee — status/subtype acceptance rule", () => {
  it("a GENUINE 500 with subtype=terminateDebuggee resolves {terminated:true} (the live success shape)", async () => {
    const client = throwingClient(
      new AbapError("ADT_ERROR", "CX_TPDA_SYS_COMM_DBGSESSIONEND", {
        status: 500,
        subtype: "terminateDebuggee",
      }),
    );
    await expect(client.terminateDebuggee()).resolves.toEqual({ terminated: true });
  });

  it("a 403 carrying subtype=terminateDebuggee REJECTS — the debuggee is still alive", async () => {
    const client = throwingClient(
      new AbapError("ADT_ERROR", "Forbidden", { status: 403, subtype: "terminateDebuggee" }),
    );
    await expect(client.terminateDebuggee()).rejects.toThrow(/Forbidden/);
  });

  for (const status of [400, 401, 404]) {
    it(`a ${status} with matching subtype rejects rather than reporting termination`, async () => {
      const err = new AbapError("ADT_ERROR", `refused ${status}`, { status, subtype: "terminateDebuggee" });
      const client = throwingClient(err);
      await expect(client.terminateDebuggee()).rejects.toBe(err);
    });
  }

  it("an undefined status with matching subtype still resolves {terminated:true}", async () => {
    const client = throwingClient(
      new AbapError("ADT_ERROR", "status dropped by transport", { subtype: "terminateDebuggee" }),
    );
    await expect(client.terminateDebuggee()).resolves.toEqual({ terminated: true });
  });

  it("an accepted status but ABSENT subtype (ICM HTML / short dump) rethrows unchanged", async () => {
    const err = new AbapError("ADT_ERROR", "<html>Anmeldung</html>", { status: 500 });
    const client = throwingClient(err);
    await expect(client.terminateDebuggee()).rejects.toBe(err);
  });
});

// ---------------------------------------------------------------------------
// runBatch arity guard and the stepWithBatch double-step hazard
// ---------------------------------------------------------------------------

/** A multipart body carrying `count` well-formed application/http sub-responses. */
function batchBody(count: number, boundary = "batch_arity"): string {
  let out = "";
  for (let i = 0; i < count; i++) {
    out += `--${boundary}\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/xml\r\n\r\n<ok n="${i}"/>\r\n`;
  }
  // A part the parser SKIPS — the dropped-part simulation.
  out += `--${boundary}\r\nContent-Type: text/plain\r\n\r\nnot-a-sub-response\r\n`;
  out += `--${boundary}--\r\n`;
  return out;
}

describe("runBatch part-count arity guard", () => {
  it("N operations but fewer decodable parts throws naming EXPECTED and ACTUAL counts", async () => {
    const fake = new FakeTransport([{ status: 200, headers: {}, body: batchBody(2) }]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    const ops = [
      { method: "POST" as const, path: "/a" },
      { method: "POST" as const, path: "/b" },
      { method: "POST" as const, path: "/c" },
    ];
    const err = await client.runBatch(ops).then(
      () => undefined,
      (e: unknown) => e as AbapError,
    );
    expect(err).toBeInstanceOf(AbapError);
    expect(err!.message).toContain("3");
    expect(err!.message).toContain("2");
    expect(err!.message).toMatch(/expected/i);
  });

  it("the arity error carries details.batchArity === true", async () => {
    const fake = new FakeTransport([{ status: 200, headers: {}, body: batchBody(1) }]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    const err = await client
      .runBatch([
        { method: "POST", path: "/a" },
        { method: "POST", path: "/b" },
      ])
      .then(
        () => undefined,
        (e: unknown) => e as AbapError,
      );
    expect(err).toBeInstanceOf(AbapError);
    expect(err!.details?.["batchArity"]).toBe(true);
    expect(err!.details?.["expected"]).toBe(2);
    expect(err!.details?.["actual"]).toBe(1);
  });

  it("DOUBLE-STEP HAZARD — a short batch response says the step ALREADY EXECUTED and is not retryable", async () => {
    const fake = new FakeTransport([{ status: 200, headers: {}, body: batchBody(3) }]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    const err = await client.stepWithBatch("stepInto").then(
      () => undefined,
      (e: unknown) => e as AbapError,
    );
    expect(err).toBeInstanceOf(AbapError);
    expect(err!.message).toMatch(/ALREADY EXECUTED/);
    expect(err!.message).toMatch(/DO NOT RETRY|not.*retr/i);
    expect(err!.message).toMatch(/getStack\(\)/);
    // The warning must ride on the runBatch arity diagnosis, counts and all —
    // not on a bare fallback that has lost which counts disagreed.
    expect(err!.message).toContain("4");
    expect(err!.message).toContain("3");
    expect(err!.details?.["batchArity"]).toBe(true);
    expect(err!.details?.["expected"]).toBe(4);
    expect(err!.details?.["actual"]).toBe(3);
    expect(err!.details?.["stepExecuted"]).toBe(true);
    expect(err!.details?.["retrySafe"]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getListener: only an ADT-SHAPED 404 means "absent"
// ---------------------------------------------------------------------------

describe("getListener 404 discrimination", () => {
  const PARAMS = { debuggingMode: "user" as const, terminalId: TERMINAL, ideId: IDE, requestUser: "DEV" };

  it("a genuine ADT 404 (NOT_FOUND with details.abapType) reports {kind:'absent'}", async () => {
    const client = throwingClient(
      new AbapError("NOT_FOUND", "no listener", {
        path: "/sap/bc/adt/debugger/listeners",
        abapType: "ExceptionResourceNotFound",
      }),
    );
    await expect(client.getListener(PARAMS)).resolves.toEqual({ kind: "absent" });
  });

  it("a bare/proxy 404 (abapType undefined) REJECTS and is NOT reported as absent", async () => {
    const err = new AbapError("NOT_FOUND", "proxy 404", { path: "/sap/bc/adt/debugger/listeners" });
    const client = throwingClient(err);
    await expect(client.getListener(PARAMS)).rejects.toBe(err);
  });
});

// ---------------------------------------------------------------------------
// launchListener must OBSERVE the derived result promise
// ---------------------------------------------------------------------------

/** A listener whose long poll rejects in the background. */
class RejectingListener implements DebugListenIssuer {
  constructor(private readonly error: Error) {}
  listen(_path: string): LongPollHandle {
    return {
      armed: Promise.resolve(),
      result: new Promise<RawResponse>((_res, rej) => setTimeout(() => rej(this.error), 0)),
      abort: () => {},
      aborted: false,
    };
  }
}

const LAUNCH_PARAMS = {
  debuggingMode: "user" as const,
  terminalId: TERMINAL,
  ideId: IDE,
  requestUser: "DEV",
};

describe("launchListener unhandled-rejection safety", () => {
  // HAZARD: `handle.result` is a DERIVED promise (`handle.result.then(parse)`).
  // If the long poll rejects while nobody is awaiting it, Node raises
  // `unhandledRejection` — which kills the whole MCP SERVER PROCESS, not just
  // the debug session. `launchListener` must mark the derived promise observed.
  // Do not delete this test as noise; a microtask flush alone cannot catch this.
  it("a background rejection with no awaiter does NOT raise unhandledRejection", async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const client = new DebugClient({
        transport: new FakeTransport([]),
        longPoll: new RejectingListener(new Error("long poll died")),
      });
      // Deliberately NOT awaiting the returned handle's result promise.
      client.launchListener(LAUNCH_PARAMS);
      // Macrotask turns: microtask flushing alone is NOT enough for Node to
      // decide a rejection is unobserved and emit the event.
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 0));
      }
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a caller who DOES await still receives the original rejection unswallowed", async () => {
    const boom = new Error("long poll died");
    const client = new DebugClient({
      transport: new FakeTransport([]),
      longPoll: new RejectingListener(boom),
    });
    const handle = client.launchListener(LAUNCH_PARAMS);
    await expect(handle.result).rejects.toThrow("long poll died");
    await expect(handle.result).rejects.toBe(boom);
  });
});

// ===========================================================================
// COVERAGE GAP CLOSURE — seven public methods that previously had no tests
// at all. Every happy path below asserts on PARSED FIELD VALUES (or, for the
// void-returning methods, on the actual request shape), never on `toBeDefined`.
// ===========================================================================

const OK = (body: string): RawResponse => ({ status: 200, headers: {}, body });
const NO_BODY: RawResponse = { status: 200, headers: {}, body: "" };

/** A realistic `<dbg:attach>` body — camelCase attributes, `"true"`/`"false"` booleans (`dbg:` family). */
const ATTACH_XML = `<?xml version="1.0" encoding="utf-8"?>
<dbg:attach xmlns:dbg="http://www.sap.com/adt/debugger" isRfc="false" isSameSystem="true"
  serverName="a4hhost_A4H_00" debugSessionId="0050569301D31EE0" processId="4711"
  isPostMortem="false" isUserAuthorizedForChanges="true" debuggeeSessionId="SID:ANON:a4hhost"
  abapTraceState="Off" canAdvancedTableFeatures="true" isNonExclusive="true"
  isNonExclusiveToggled="false" guiEditorGuid="GUID-1" sessionTitle="ZMCP_DBG_RUN"
  isSteppingPossible="true" isTerminationPossible="true">
  <dbg:actions>
    <dbg:action name="systemDebugging" style="toggle" group="settings" title="System Debugging" value="false" disabled="false"/>
    <dbg:action name="abapTrace" style="toggle" group="settings" title="ABAP Trace" value="true" disabled="true"/>
  </dbg:actions>
  <dbg:reachedBreakpoints>
    <dbg:breakpoint id="ZMCP_DBG_RUN,17" kind="line"/>
  </dbg:reachedBreakpoints>
</dbg:attach>`;

/** A realistic `<dbg:step>` body, including the `<dbg:settings>` child `parseStepResponse` reads. */
const STEP_XML = `<?xml version="1.0" encoding="utf-8"?>
<dbg:step xmlns:dbg="http://www.sap.com/adt/debugger" isRfc="false" isSameSystem="true"
  serverName="a4hhost_A4H_00" debugSessionId="0050569301D31EE0" processId="4711"
  isSteppingPossible="true" isTerminationPossible="true" isDebuggeeChanged="true">
  <dbg:settings systemDebugging="true" createExceptionObject="false" backgroundRFC="false"
    sharedObjectDebugging="true" showDataAging="false" updateDebugging="false"/>
  <dbg:reachedBreakpoints>
    <dbg:breakpoint id="ZMCP_DBG_RUN,23" kind="line"/>
  </dbg:reachedBreakpoints>
</dbg:step>`;

/** Two genuinely different frames: an application frame with a uri, and a system frame without one. */
const STACK_XML = `<?xml version="1.0" encoding="utf-8"?>
<dbg:stack xmlns:dbg="http://www.sap.com/adt/debugger" isRfc="false" isSameSystem="true"
  serverName="a4hhost_A4H_00" debugCursorStackIndex="1">
  <dbg:stackEntry stackPosition="1" stackType="ABAP" stackUri="/stack/1"
    programName="ZMCP_DBG_RUN" includeName="ZMCP_DBG_RUN" line="17" eventType="METHOD"
    eventName="RUN" sourceType="ABAP" systemProgram="false" isVit="false"
    uri="/sap/bc/adt/programs/programs/zmcp_dbg_run/source/main#start=17"/>
  <dbg:stackEntry stackPosition="2" stackType="ABAP" stackUri="/stack/2"
    programName="SAPMSSY1" includeName="SAPMSSY1" line="105" eventType="FORM"
    eventName="%_RFC_START" sourceType="ABAP" systemProgram="true" isVit="false"/>
</dbg:stack>`;

/** A `getChildVariables` answer for `LS_ITEM`: one hierarchy row plus two real component rows. */
const CHILD_VARS_XML = `${ASX_OPEN}<HIERARCHIES>` +
  `<STPDA_ADT_VARIABLE_HIERARCHY><PARENT_ID>LS_ITEM</PARENT_ID><CHILD_ID>LS_ITEM-MATNR</CHILD_ID>` +
  `<CHILD_NAME>MATNR</CHILD_NAME></STPDA_ADT_VARIABLE_HIERARCHY>` +
  `<STPDA_ADT_VARIABLE_HIERARCHY><PARENT_ID>LS_ITEM</PARENT_ID><CHILD_ID>LS_ITEM-MENGE</CHILD_ID>` +
  `<CHILD_NAME>MENGE</CHILD_NAME></STPDA_ADT_VARIABLE_HIERARCHY>` +
  `</HIERARCHIES><VARIABLES>` +
  `<STPDA_ADT_VARIABLE><ID>LS_ITEM-MATNR</ID><NAME>MATNR</NAME><META_TYPE>simple</META_TYPE>` +
  `<VALUE>000000000000000042</VALUE><TECHNICAL_TYPE>C</TECHNICAL_TYPE><LENGTH>18</LENGTH>` +
  `<READ_ONLY>X</READ_ONLY><DECLARED_TYPE_NAME>MATNR</DECLARED_TYPE_NAME></STPDA_ADT_VARIABLE>` +
  `<STPDA_ADT_VARIABLE><ID>LS_ITEM-MENGE</ID><NAME>MENGE</NAME><META_TYPE>simple</META_TYPE>` +
  `<VALUE>7</VALUE><TECHNICAL_TYPE>P</TECHNICAL_TYPE><LENGTH>8</LENGTH>` +
  `<READ_ONLY></READ_ONLY></STPDA_ADT_VARIABLE>` +
  `</VARIABLES>${ASX_CLOSE}`;

const STOP_PARAMS = { debuggingMode: "user" as const, terminalId: TERMINAL, ideId: IDE, requestUser: "DEV" };

describe("stopListener", () => {
  it("issues a DELETE on the listeners resource carrying the terminal id, and resolves", async () => {
    const fake = new FakeTransport([NO_BODY]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    await expect(client.stopListener(STOP_PARAMS)).resolves.toBeUndefined();
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.method).toBe("DELETE");
    expect(fake.calls[0]!.path).toContain("/debugger/listeners");
    expect(fake.calls[0]!.path).toContain(`terminalId=${TERMINAL}`);
    expect(fake.calls[0]!.path).toContain("debuggingMode=user");
  });

  it("propagates a transport AbapError unchanged", async () => {
    const boom = new AbapError("ADT_ERROR", "listener stop refused", { status: 500 });
    const fake = new FakeTransport(() => {
      throw boom;
    });
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    await expect(client.stopListener(STOP_PARAMS)).rejects.toBe(boom);
  });
});

describe("attach", () => {
  it("parses the attach response's session state, actions and reached breakpoints", async () => {
    const fake = new FakeTransport([OK(ATTACH_XML)]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    const result = await client.attach({ debuggeeId: "DBGEE-1", debuggingMode: "user", requestUser: "DEV" });

    expect(result.debugSessionId).toBe("0050569301D31EE0");
    expect(result.serverName).toBe("a4hhost_A4H_00");
    expect(result.processId).toBe(4711);
    expect(result.isSameSystem).toBe(true);
    expect(result.isRfc).toBe(false);
    expect(result.isSteppingPossible).toBe(true);
    expect(result.isNonExclusive).toBe(true);
    expect(result.sessionTitle).toBe("ZMCP_DBG_RUN");
    expect(result.actions.map((a) => a.name)).toEqual(["systemDebugging", "abapTrace"]);
    expect(result.actions[1]!.disabled).toBe(true);
    expect(result.actions[0]!.disabled).toBe(false);
    expect(result.reachedBreakpoints).toEqual([
      { id: "ZMCP_DBG_RUN,17", kind: "line", unresolvableCondition: undefined, unresolvableConditionErrorOffset: undefined },
    ]);

    expect(fake.calls[0]!.method).toBe("POST");
    expect(fake.calls[0]!.path).toContain("method=attach");
    expect(fake.calls[0]!.path).toContain("debuggeeId=DBGEE-1");
  });

  it("a blank body is a parse failure, not an empty attach result", async () => {
    const fake = new FakeTransport([NO_BODY]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    await expect(client.attach({ debuggeeId: "DBGEE-1", debuggingMode: "user" })).rejects.toThrow(
      /expected root <dbg:attach>/,
    );
  });
});

describe("step", () => {
  it("parses the step response (settings, isDebuggeeChanged, reached breakpoint) and sends the step kind", async () => {
    const fake = new FakeTransport([OK(STEP_XML)]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    const result = await client.step({ step: "stepOver" });

    expect(result.debugSessionId).toBe("0050569301D31EE0");
    expect(result.isDebuggeeChanged).toBe(true);
    expect(result.settings).toEqual({
      systemDebugging: true,
      createExceptionObject: false,
      backgroundRFC: false,
      sharedObjectDebugging: true,
      showDataAging: false,
      updateDebugging: false,
    });
    expect(result.reachedBreakpoints).toHaveLength(1);
    expect(result.reachedBreakpoints[0]!.id).toBe("ZMCP_DBG_RUN,23");
    expect(result.isTerminationPossible).toBe(true);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.method).toBe("POST");
    expect(fake.calls[0]!.path).toContain("method=stepOver");
  });

  it("carries the uri through for stepRunToLine and propagates a transport AbapError unchanged", async () => {
    const boom = new AbapError("ADT_ERROR", "noSessionAttached", { status: 500, subtype: "noSessionAttached" });
    const fake = new FakeTransport(() => {
      throw boom;
    });
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    await expect(
      client.step({ step: "stepRunToLine", uri: "/sap/bc/adt/programs/programs/zmcp_dbg_run/source/main#start=30" }),
    ).rejects.toBe(boom);
    expect(fake.calls[0]!.path).toContain("method=stepRunToLine");
    expect(fake.calls[0]!.path).toContain("uri=");
  });

  it("sends stepOver, stepInto and stepContinue as three distinct requests, in order", async () => {
    const fake = new FakeTransport([OK(STEP_XML), OK(STEP_XML), OK(STEP_XML)]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });

    await client.step({ step: "stepOver" });
    await client.step({ step: "stepInto" });
    await client.step({ step: "stepContinue" });

    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[0]!.path).toContain("method=stepOver");
    expect(fake.calls[1]!.path).toContain("method=stepInto");
    expect(fake.calls[2]!.path).toContain("method=stepContinue");
  });
});

describe("getStack", () => {
  it("parses BOTH frames with their real program names, lines and 1-based stack positions", async () => {
    const fake = new FakeTransport([OK(STACK_XML)]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    const stack = await client.getStack();

    expect(stack.serverName).toBe("a4hhost_A4H_00");
    expect(stack.debugCursorStackIndex).toBe(1);
    expect(stack.frames).toHaveLength(2);

    const [first, second] = stack.frames;
    expect(first!.stackPosition).toBe(1);
    expect(first!.programName).toBe("ZMCP_DBG_RUN");
    expect(first!.line).toBe(17);
    expect(first!.eventName).toBe("RUN");
    expect(first!.systemProgram).toBe(false);
    expect(first!.uri).toBe("/sap/bc/adt/programs/programs/zmcp_dbg_run/source/main#start=17");

    expect(second!.stackPosition).toBe(2);
    expect(second!.programName).toBe("SAPMSSY1");
    expect(second!.line).toBe(105);
    expect(second!.eventType).toBe("FORM");
    expect(second!.systemProgram).toBe(true);
    // Not every frame carries a resolvable source URI — the system frame has none.
    expect(second!.uri).toBeUndefined();

    expect(fake.calls[0]!.method).toBe("GET");
    expect(fake.calls[0]!.path).toContain("/debugger/stack");
    expect(fake.calls[0]!.path).toContain("emode=");
    expect(fake.calls[0]!.path).toContain("semanticURIs=true");
  });

  it("a blank body is a parse failure, not a zero-frame stack", async () => {
    const fake = new FakeTransport([NO_BODY]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    await expect(client.getStack()).rejects.toThrow(/expected root <dbg:stack>/);
  });
});

describe("getChildVariables (valid parent)", () => {
  it("parses the hierarchies AND the component variables of a structure", async () => {
    const fake = new FakeTransport([OK(CHILD_VARS_XML)]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    const result = await client.getChildVariables(["LS_ITEM"]);

    expect(result.hierarchies).toEqual([
      { parentId: "LS_ITEM", childId: "LS_ITEM-MATNR", childName: "MATNR" },
      { parentId: "LS_ITEM", childId: "LS_ITEM-MENGE", childName: "MENGE" },
    ]);
    expect(result.variables).toHaveLength(2);
    expect(result.variables.map((v) => v.id)).toEqual(["LS_ITEM-MATNR", "LS_ITEM-MENGE"]);
    expect(result.variables[0]!.name).toBe("MATNR");
    expect(result.variables[0]!.value).toBe("000000000000000042");
    expect(result.variables[0]!.declaredTypeName).toBe("MATNR");
    expect(result.variables[0]!.technicalType).toBe("C");
    expect(result.variables[0]!.length).toBe(18);
    // `asx:abap` family booleans: "X" = true, "" = false — never a raw "X".
    expect(result.variables[0]!.readOnly).toBe(true);
    expect(result.variables[1]!.value).toBe("7");
    expect(result.variables[1]!.readOnly).toBe(false);
    expect(result.variables[1]!.length).toBe(8);

    expect(fake.calls[0]!.method).toBe("POST");
    expect(fake.calls[0]!.path).toContain("method=getChildVariables");
    expect(fake.calls[0]!.body).toContain("LS_ITEM");
  });

  it("a table-row parent id reaches the wire verbatim; a transport AbapError propagates unchanged", async () => {
    const boom = new AbapError("ADT_ERROR", "variable not found", { status: 500 });
    const fake = new FakeTransport(() => {
      throw boom;
    });
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    await expect(client.getChildVariables(["LT_ITEMS[1]"])).rejects.toBe(boom);
    expect(fake.calls[0]!.body).toContain("LT_ITEMS[1]");
  });
});

describe("setVariableValue", () => {
  it("sends the raw value as the body and the variable name on the query string", async () => {
    const fake = new FakeTransport([NO_BODY]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    await expect(client.setVariableValue("LV_COUNT", "42")).resolves.toBeUndefined();
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.method).toBe("POST");
    expect(fake.calls[0]!.path).toContain("method=setVariableValue");
    expect(fake.calls[0]!.path).toContain("variableName=LV_COUNT");
    // Raw value, NOT XML-wrapped.
    expect(fake.calls[0]!.body).toBe("42");
  });

  it("propagates a transport AbapError unchanged (e.g. a read-only variable)", async () => {
    const boom = new AbapError("ADT_ERROR", "variable is read-only", { status: 500 });
    const fake = new FakeTransport(() => {
      throw boom;
    });
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    await expect(client.setVariableValue("SY-SUBRC", "9")).rejects.toBe(boom);
  });
});

describe("setDebuggerSettings", () => {
  const SETTINGS = {
    systemDebugging: true,
    createExceptionObject: false,
    backgroundRFC: true,
    sharedObjectDebugging: false,
    showDataAging: true,
    updateDebugging: false,
  };

  /** The server's authoritative echo: the POST's response body IS a `<dbg:settings>` block. */
  function settingsEchoXml(s: Record<string, boolean>): string {
    const attrs = Object.entries(s)
      .map(([k, v]) => `${k}="${v ? "true" : "false"}"`)
      .join(" ");
    return `<?xml version="1.0" encoding="UTF-8"?><dbg:settings xmlns:dbg="http://www.sap.com/adt/debugger" ${attrs}/>`;
  }

  const echoResponse = (s: Record<string, boolean>): RawResponse => ({
    status: 200,
    headers: {},
    body: settingsEchoXml(s),
  });

  it("carries every flag into the body using the dbg: family's true/false convention", async () => {
    const fake = new FakeTransport([echoResponse(SETTINGS)]);
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    await expect(client.setDebuggerSettings(SETTINGS)).resolves.toEqual(SETTINGS);

    const call = fake.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.path).toContain("method=setDebuggerSettings");
    expect(call.headers?.["Content-Type"]).toBe("application/xml");
    const body = call.body ?? "";
    expect(body).toContain(`systemDebugging="true"`);
    expect(body).toContain(`createExceptionObject="false"`);
    expect(body).toContain(`backgroundRFC="true"`);
    expect(body).toContain(`sharedObjectDebugging="false"`);
    expect(body).toContain(`showDataAging="true"`);
    expect(body).toContain(`updateDebugging="false"`);
    // The dbg: family never uses the asx:abap "X"/"" boolean convention.
    expect(body).not.toContain(`="X"`);
    // Round-trips through the settings parser (parseStepResponse reads this element shape).
    expect(occurrences(body, "<dbg:settings")).toBe(1);
  });

  it("propagates a transport AbapError unchanged", async () => {
    const boom = new AbapError("ADT_ERROR", "settings refused", { status: 500 });
    const fake = new FakeTransport(() => {
      throw boom;
    });
    const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
    await expect(client.setDebuggerSettings(SETTINGS)).rejects.toBe(boom);
  });

  it("returns what the SERVER echoed, not what was requested", async () => {
    // The server is entitled to refuse/adjust: here it applies neither showDataAging
    // nor systemDebugging. Returning the request would hide exactly that.
    const applied = { ...SETTINGS, showDataAging: false, systemDebugging: false };
    const warnings: string[] = [];
    const fake = new FakeTransport([echoResponse(applied)]);
    const client = new DebugClient({
      transport: fake,
      longPoll: new FakeListener(),
      warn: (m) => warnings.push(m),
    });

    await expect(client.setDebuggerSettings(SETTINGS)).resolves.toEqual(applied);
    expect(warnings).toEqual([]);
  });

  it("round-trips all six booleans off the echo, in both polarities", async () => {
    const allTrue = {
      systemDebugging: true,
      createExceptionObject: true,
      backgroundRFC: true,
      sharedObjectDebugging: true,
      showDataAging: true,
      updateDebugging: true,
    };
    const allFalse = Object.fromEntries(Object.keys(allTrue).map((k) => [k, false])) as typeof allTrue;

    for (const expected of [allTrue, allFalse]) {
      const fake = new FakeTransport([echoResponse(expected)]);
      const client = new DebugClient({ transport: fake, longPoll: new FakeListener() });
      await expect(client.setDebuggerSettings(SETTINGS)).resolves.toEqual(expected);
    }
  });

  it("an EMPTY body warns and falls back to the requested settings rather than failing an applied mutation", async () => {
    const warnings: string[] = [];
    const fake = new FakeTransport([NO_BODY]);
    const client = new DebugClient({
      transport: fake,
      longPoll: new FakeListener(),
      warn: (m) => warnings.push(m),
    });

    // The transport already accepted a 2xx, so the change IS applied server-side;
    // throwing here would report a false failure and invite a retry of a done mutation.
    await expect(client.setDebuggerSettings(SETTINGS)).resolves.toEqual(SETTINGS);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("[setDebuggerSettings]");
    expect(warnings[0]).toContain("EMPTY body");
  });

  it("an UNPARSEABLE body warns (naming the parse failure) and falls back the same way", async () => {
    const warnings: string[] = [];
    const fake = new FakeTransport([{ status: 200, headers: {}, body: "<dbg:step/>" }]);
    const client = new DebugClient({
      transport: fake,
      longPoll: new FakeListener(),
      warn: (m) => warnings.push(m),
    });

    await expect(client.setDebuggerSettings(SETTINGS)).resolves.toEqual(SETTINGS);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("[setDebuggerSettings]");
    expect(warnings[0]).toContain("parseSettingsResponse");
  });
});

// ---------------------------------------------------------------------------
// longPollAbortTimeoutMs — forwards the injected long-poll's client-side
// abort deadline; must never throw when the fake omits it (every existing
// fake in this file does).
// ---------------------------------------------------------------------------

/** A long-poll fake that (optionally) exposes `clientAbortTimeoutMs`, mutable post-construction. */
class FakeListenerWithAbortTimeout implements DebugListenIssuer {
  public clientAbortTimeoutMs: number | undefined;
  public listenCalls = 0;
  constructor(clientAbortTimeoutMs: number | undefined) {
    this.clientAbortTimeoutMs = clientAbortTimeoutMs;
  }
  listen(path: string): LongPollHandle {
    this.listenCalls++;
    return {
      armed: Promise.resolve(),
      result: Promise.resolve({ status: 200, headers: {}, body: "" }),
      abort: () => {},
      aborted: false,
    };
  }
}

describe("longPollAbortTimeoutMs", () => {
  it("returns the exact number when the injected long-poll exposes clientAbortTimeoutMs", () => {
    const longPoll = new FakeListenerWithAbortTimeout(180_000);
    const client = new DebugClient({ transport: new FakeTransport([]), longPoll });
    expect(client.longPollAbortTimeoutMs()).toBe(180_000);
  });

  it("returns undefined, and does not throw, when the injected fake is a partial DebugListenIssuer lacking clientAbortTimeoutMs — the shape every existing test fake in this file has", () => {
    const client = new DebugClient({ transport: new FakeTransport([]), longPoll: new FakeListener() });
    expect(() => client.longPollAbortTimeoutMs()).not.toThrow();
    expect(client.longPollAbortTimeoutMs()).toBeUndefined();
  });

  it("returns undefined, and does not throw, when clientAbortTimeoutMs is present but explicitly undefined", () => {
    const longPoll = new FakeListenerWithAbortTimeout(undefined);
    const client = new DebugClient({ transport: new FakeTransport([]), longPoll });
    expect(() => client.longPollAbortTimeoutMs()).not.toThrow();
    expect(client.longPollAbortTimeoutMs()).toBeUndefined();
  });

  it("reads the value LIVE rather than caching at construction — a mutation between two calls is reflected on the second", () => {
    const longPoll = new FakeListenerWithAbortTimeout(120_000);
    const client = new DebugClient({ transport: new FakeTransport([]), longPoll });
    expect(client.longPollAbortTimeoutMs()).toBe(120_000);
    longPoll.clientAbortTimeoutMs = 240_000;
    expect(client.longPollAbortTimeoutMs()).toBe(240_000);
  });

  it("is a pure accessor: calling it issues no transport request and starts no long poll", () => {
    const transport = new FakeTransport([]);
    const longPoll = new FakeListenerWithAbortTimeout(90_000);
    const client = new DebugClient({ transport, longPoll });
    client.longPollAbortTimeoutMs();
    client.longPollAbortTimeoutMs();
    expect(transport.calls).toHaveLength(0);
    expect(longPoll.listenCalls).toBe(0);
  });
});
