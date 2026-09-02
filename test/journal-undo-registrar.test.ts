/**
 * `registerJournalTools`'s `mode=undo` branch (src/tools/journal.ts) used to
 * call the generic `deps.safety.assert(...)` gate BEFORE checking
 * `enhancementUndoBlocked()` — so an undo of any enhancement-type journal
 * entry (ENHO/XH, ENHO/XHH, ENHS/XS) reached the intent-based gate's "no
 * intent" branch at `phase:"final"` first, and got the confusing, misapplied
 * "supply `affects`"
 * refusal (a parameter `abap_journal` does not have and never reads) instead
 * of the purpose-built, unconditional H7/H8/H26-H28 refusal `undoBlocker()`
 * exists to give. The fix reorders the two checks: `enhancementUndoBlocked()`
 * runs first (it is zero-network, same as the gate call it now precedes), so
 * the refusal that actually applies is the one the caller sees.
 *
 * `test/undo.test.ts` already pins `enhancementUndoBlocked`/`undoBlocker`
 * directly at the unit level. This file is the missing layer: it exercises
 * the real `registerJournalTools()` MCP tool registration (previously
 * uncovered by any test — confirmed by grepping test/ for
 * "registerJournalTools" before adding this file) so the ORDERING fix itself,
 * not just the function it now calls first, is under test. Mirrors
 * test/activate-affects-preflight.test.ts's `harnessWithCounter` pattern:
 * `pool.withWrite` never invokes its callback, it only counts whether the
 * gate sequence let the call reach it — proof the enhancement-undo refusal
 * fires BEFORE any write slot is leased, not just that it fires eventually.
 *
 * Nothing here touches a network or a live SAP system; the `Journal` is a
 * real instance backed by a throwaway `fs.mkdtemp` directory (same pattern as
 * test/journal.test.ts), so entries are genuinely persisted and read back,
 * but no ADT call is made.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerJournalTools, type JournalToolDeps } from "../src/tools/journal.js";
import { Journal, type JournalBeginInput, type JournalObjectRef } from "../src/journal.js";
import { errorResult } from "../src/server.js";
import { SafetyGate } from "../src/safety.js";

let tmp: string;
let journal: Journal;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "abapsmith-journal-undo-registrar-"));
  journal = new Journal({ dir: tmp, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "A4H");
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const enhoRef: JournalObjectRef = {
  name: "ZENH_BADI_UNDO",
  type: "ENHO/XH",
  uri: "/sap/bc/adt/enhancements/enhoxhh/zenh_badi_undo",
  sourceUri: "/sap/bc/adt/enhancements/enhoxhh/zenh_badi_undo/source/main",
  package: "$TMP",
  description: "enhancement undo-registrar test",
};

const progRef: JournalObjectRef = {
  name: "ZMCP_UNDO_DEMO",
  type: "PROG/P",
  uri: "/sap/bc/adt/programs/programs/zmcp_undo_demo",
  sourceUri: "/sap/bc/adt/programs/programs/zmcp_undo_demo/source/main",
  package: "$TMP",
  description: "non-enhancement undo-registrar control",
};

const begin = async (object: JournalObjectRef, over: Partial<JournalBeginInput> = {}) => {
  const entry = await journal.begin({
    operation: "update",
    object,
    existedBefore: true,
    beforeSource: "* before\n",
    afterSource: "* after\n",
    tool: "abap_write",
    ...over,
  });
  if (!entry) throw new Error("begin() returned undefined, but this journal is enabled");
  return entry;
};

/** Same shape as test/activate-affects-preflight.test.ts's `harnessWithCounter`. */
function harnessWithCounter(gate: SafetyGate) {
  let poolCalls = 0;
  const deps: JournalToolDeps = {
    pool: {
      withWrite: async <T>(): Promise<T> => {
        poolCalls += 1;
        return { text: "stub: reached pool.withWrite (gate sequence passed)", truncated: false } as unknown as T;
      },
      withRead: async <T>(): Promise<T> => {
        throw new Error("not exercised (mode=undo only in this file)");
      },
      primary: () => {
        throw new Error("not exercised (mode=undo only in this file)");
      },
    } as never,
    safety: gate,
    ensureConnected: async () => {},
    errorResult,
    cfg: { maxResponseChars: 50_000 },
    journal,
  };
  const server = new McpServer({ name: "journal-undo-registrar-probe", version: "0.0.0" });
  registerJournalTools(server, deps);
  const call = async (args: Record<string, unknown>): Promise<string> => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "journal-undo-registrar-probe", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const res = await client.callTool({ name: "abap_journal", arguments: args });
    const first = Array.isArray(res.content) ? res.content[0] : undefined;
    return first && typeof first === "object" && "text" in first ? String((first as { text: unknown }).text) : "";
  };
  return { call, calls: () => poolCalls };
}

const permissiveGate = () =>
  new SafetyGate({
    readOnly: false,
    allowPackages: ["$TMP"],
    allowEnhancements: true,
    enhanceTargets: "customer",
    originSystems: ["A4H"],
  });

describe("registerJournalTools mode=undo: enhancement-undo refusal wins over the generic intent-based gate call", () => {
  it("undoing an ENHO/XH entry is UNSUPPORTED with the H7/H8/H26-H28 wording — never SAFETY_DENIED, never 'supply `affects`', never INTERNAL_GATE_MISUSE", async () => {
    const entry = await begin(enhoRef);
    const { call, calls } = harnessWithCounter(permissiveGate());

    const text = await call({ mode: "undo", entry: entry.id });

    expect(text).toMatch(/UNSUPPORTED/);
    expect(text).toMatch(/refused outright|Undoing this entry would DELETE/);
    expect(text).not.toMatch(/SAFETY_DENIED/);
    expect(text).not.toMatch(/supply `affects`/);
    expect(text).not.toMatch(/INTERNAL_GATE_MISUSE/);
    // Never even reaches the write slot — the refusal is zero-network, exactly
    // like the gate call it now precedes.
    expect(calls()).toBe(0);
  });

  it("undoing an ENHS/XS entry gets the same unconditional refusal (not just ENHO/XH)", async () => {
    const entry = await begin({ ...enhoRef, name: "ZENH_SPOT_UNDO", type: "ENHS/XS" });
    const { call, calls } = harnessWithCounter(permissiveGate());

    const text = await call({ mode: "undo", entry: entry.id });

    expect(text).toMatch(/UNSUPPORTED/);
    expect(text).toMatch(/refused outright/);
    expect(calls()).toBe(0);
  });

  it("control: a non-enhancement (PROG/P) undo is completely unaffected by the reordering — still reaches the generic gate and, once it clears, the write slot", async () => {
    const entry = await begin(progRef);
    const { call, calls } = harnessWithCounter(permissiveGate());

    const text = await call({ mode: "undo", entry: entry.id });

    expect(text).toBe("stub: reached pool.withWrite (gate sequence passed)");
    expect(calls()).toBe(1);
  });

  it("control: a non-enhancement undo the gate genuinely refuses (package not allowed) still gets the ordinary gate refusal, not swallowed by the enhancement check", async () => {
    const entry = await begin(progRef);
    const closedGate = new SafetyGate({ readOnly: false, allowPackages: ["$OTHER_ONLY"] });
    const { call, calls } = harnessWithCounter(closedGate);

    const text = await call({ mode: "undo", entry: entry.id });

    expect(text).not.toMatch(/UNSUPPORTED/);
    expect(text).toMatch(/SAFETY_DENIED/);
    expect(calls()).toBe(0);
  });
});

describe("registerJournalTools: pickEntry's missing-entry-or-object refusal names the mode", () => {
  it("mode=show with neither `entry` nor `object` is refused BAD_INPUT naming mode=show", async () => {
    // harnessWithCounter's primary() throws, but mode=show calls primary() before pickEntry
    // runs — masking the refusal under ADT_ERROR. Needs a working (never dereferenced) stand-in.
    const deps: JournalToolDeps = {
      pool: {
        withWrite: async <T>(): Promise<T> => {
          throw new Error("not exercised (mode=show never leases a write slot)");
        },
        withRead: async <T>(): Promise<T> => {
          throw new Error("not exercised (mode=show reads via pool.primary(), not withRead)");
        },
        primary: () => ({}) as never,
      } as never,
      safety: permissiveGate(),
      ensureConnected: async () => {},
      errorResult,
      cfg: { maxResponseChars: 50_000 },
      journal,
    };
    const server = new McpServer({ name: "journal-show-probe", version: "0.0.0" });
    registerJournalTools(server, deps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "journal-show-probe", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const res = await client.callTool({ name: "abap_journal", arguments: { mode: "show" } });
    const first = Array.isArray(res.content) ? res.content[0] : undefined;
    const text = first && typeof first === "object" && "text" in first ? String((first as { text: unknown }).text) : "";

    expect(text).toMatch(/BAD_INPUT/);
    expect(text).toMatch(/mode=show needs `entry`.*or `object`/);
  });

  it("mode=undo with neither `entry` nor `object` is refused BAD_INPUT naming mode=undo", async () => {
    // harnessWithCounter's withWrite never invokes its run callback, which would hide pickEntry's
    // refusal entirely; the gate must be wide open too, so the fallback {name:""} assert clears.
    const wideOpenGate = new SafetyGate({
      readOnly: false,
      allowPackages: ["*"],
      allowNamePrefixes: ["*"],
    });
    const deps: JournalToolDeps = {
      pool: {
        withWrite: async <T>(_tool: string, _key: string | undefined, run: (conn: never) => Promise<T>): Promise<T> =>
          run({} as never),
        withRead: async <T>(): Promise<T> => {
          throw new Error("not exercised (mode=undo only in this test)");
        },
        primary: () => {
          throw new Error("not exercised (mode=undo only in this test)");
        },
      } as never,
      safety: wideOpenGate,
      ensureConnected: async () => {},
      errorResult,
      cfg: { maxResponseChars: 50_000 },
      journal,
    };
    const server = new McpServer({ name: "journal-undo-probe", version: "0.0.0" });
    registerJournalTools(server, deps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "journal-undo-probe", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const res = await client.callTool({ name: "abap_journal", arguments: { mode: "undo" } });
    const first = Array.isArray(res.content) ? res.content[0] : undefined;
    const text = first && typeof first === "object" && "text" in first ? String((first as { text: unknown }).text) : "";

    expect(text).toMatch(/BAD_INPUT/);
    expect(text).toMatch(/mode=undo needs `entry`.*or `object`/);
  });
});
