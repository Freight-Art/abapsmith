/**
 * ARG-FORWARDING REACHABILITY — the test that would have caught DEFECT 2.
 *
 * THE DEFECT. A real call
 *
 *     abap_write({object: "ZTM_CL_HWOOP_VIEW_WRITE", edit: {old_string, new_string}})
 *
 * came back with `resolveWriteSource`'s FINAL fallback (src/tools/write.ts):
 * "`source` is required for mode=write." — and a hint advertising the very
 * `edit` form the caller had just used. `input.edit` was `undefined` by the
 * time the core saw it.
 *
 * THE MECHANISM (pinned by §1 below). `McpServer#registerTool` builds a zod
 * object from the registered shape, validates the incoming arguments against
 * it, and hands the tool callback zod's PARSED output — not the raw payload.
 * zod objects strip keys they do not declare, silently and by design. So a
 * field that the tool's code path implements, and that its own description
 * and error hints advertise, is deleted before any handler can see it if the
 * REGISTERED SCHEMA omits it. There is no warning, no error, and no log line:
 * from the handler's point of view the caller simply never sent it.
 *
 * WHERE IT HAPPENED. `abap_write` is registered by two different modules for
 * two mutually exclusive surfaces (`ABAP_TOOL_SURFACE`, src/config.ts):
 *
 *   v2 (opt-in)  src/tools/v2/register.ts   -> `abapWriteInputSchema`  — declares edit+method
 *   v1 (DEFAULT) src/tools/write.ts         -> `writeInputSchema`      — declares NEITHER
 *
 * Both call the SAME core `abapWrite`, whose parameter type `WriteInputV2`
 * (src/tools/write.ts) was widened with `edit` and `method` while only the v2
 * schema was widened alongside it. The v1 registrar's `abapWrite(conn, args
 * as never, ...)` cast is what kept that divergence from being a compile
 * error — `as never` is assignable to every parameter type, so widening the
 * core's input produced no diagnostic at the v1 call site at all.
 *
 * WHY IT IS WORSE THAN A REFUSAL. With `method` stripped too, `{object,
 * method, source}` silently degrades into `{object, source}` — a different,
 * MORE DESTRUCTIVE branch of `resolveWriteSource`: a full-object rewrite
 * whose entire new source is a bare `METHOD ... ENDMETHOD.` block. A missing
 * optional field does not merely disable a feature here; it selects another
 * one.
 *
 * WHAT THIS FILE ENCODES, in the order the sections appear:
 *
 *   §1  the mechanism itself: undeclared keys are silently dropped.
 *   §2  THE INVARIANT: every write form `resolveWriteSource` implements and
 *       the tool's hints advertise must survive EVERY registered schema, on
 *       EVERY surface. Covering only v2 would have caught nothing.
 *   §3  end-to-end reachability for the v2 handler: every key the schema
 *       declares actually ARRIVES at the core with its value intact. A newly
 *       added schema key that nobody forwards fails here.
 *   §4  the same survival check at the SDK layer for all six v2 tools, so a
 *       nested object / array / record field cannot regress unnoticed.
 *   §5  cross-surface key parity for `abap_write` — two front doors on one
 *       core function.
 *   §6  THE ROOT-CAUSE INVARIANT, generalised: every other v1 tool derives
 *       its core input type from the schema it registers, which is why none
 *       of them could drift. `abap_write` is the sole exception.
 *   §7  the v2 handlers' hand-written arg types vs. the schemas they mirror.
 *
 * Everything here is offline: no SAP system, no network, no `createServer`.
 * §1/§2/§4 stand up a throwaway `McpServer` + `Client` over
 * `InMemoryTransport` and register ONLY the shape under test, so what they
 * measure is the SDK+zod boundary and nothing else.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// --- the two registered `abap_write` schemas, one per surface -------------
import { writeInputSchema } from "../src/tools/write.js";
import {
  abapAdtInputSchema,
  abapDebugInputSchema,
  abapDoInputSchema,
  abapFindInputSchema,
  abapReadInputSchema,
  abapWriteInputSchema,
} from "../src/tools/v2/schemas.js";
import { handleAbapWrite } from "../src/tools/v2/handlers/write.js";
import type { V2ToolDeps } from "../src/tools/v2/runtime.js";
import type { AbapError } from "../src/adt/errors.js";

// --- §6: every other v1 tool's registered shape + its core input object ---
import { readInputSchema, ReadInput } from "../src/tools/read.js";
import { searchInputSchema, SearchInput } from "../src/tools/search.js";
import { activateInputSchema, ActivateInput } from "../src/tools/activate.js";
import { runInputSchema, RunInput } from "../src/tools/run.js";
import { testInputSchema, TestInput } from "../src/tools/test.js";
import { journalInputSchema, JournalInput } from "../src/tools/journal.js";
import {
  debugInputSchema,
  DebugInput,
  debugVarsInputSchema,
  DebugVarsInput,
  debugValueInputSchema,
  DebugValueInput,
} from "../src/tools/debug.js";
import { dataPreviewInputSchema, DataPreviewInput } from "../src/tools/data-preview.js";
import { fpmReadInputSchema, FpmReadInput } from "../src/tools/fpm.js";
import { enhInputSchema, EnhInput } from "../src/tools/enh.js";
import { bopfTestInputSchema, BopfTestInput } from "../src/tools/bopf-test.js";
import {
  bopfInputSchema,
  BopfInput,
  bopfEditInputSchema,
  BopfEditInput,
  bopfDeleteInputSchema,
  BopfDeleteInput,
} from "../src/tools/bopf.js";

/**
 * §3 stubs the ONE core function both surfaces call, so the handler's
 * forwarding can be observed without a connection, a gate or a journal.
 * `importOriginal` is spread back in so every OTHER export of that module —
 * `writeInputSchema` and `WriteInput`, which §2/§5/§6 read — stays real.
 *
 * NOTE for whoever is editing src/tools/write.ts concurrently: this mock
 * replaces `abapWrite` only. Nothing in this file exercises the real write
 * pipeline, so a transient failure in the method-splice suites is not from
 * here.
 */
const captured = vi.hoisted(() => ({ input: undefined as unknown }));
vi.mock("../src/tools/write.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/write.js")>();
  return {
    ...actual,
    abapWrite: async (_conn: unknown, input: unknown) => {
      captured.input = input;
      return { text: "stub: write accepted", truncated: false };
    },
  };
});

// ---------------------------------------------------------------- helpers ---

type RawShape = Record<string, z.ZodTypeAny>;

/**
 * Registers `shape` as a throwaway tool on a real `McpServer`, calls it
 * through a real `Client` with `args`, and returns EXACTLY what the tool
 * callback received. This is the SDK+zod boundary under test and nothing
 * else — no abapsmith server, no config, no connection.
 */
async function whatTheHandlerReceives(shape: RawShape, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const server = new McpServer({ name: "arg-forwarding-probe", version: "0.0.0" });
  let seen: Record<string, unknown> = {};
  server.registerTool(
    "probe",
    { description: "arg forwarding probe", inputSchema: shape },
    (received: Record<string, unknown>) => {
      seen = received;
      return { content: [{ type: "text" as const, text: "ok" }] };
    },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "arg-forwarding-probe", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  await client.callTool({ name: "probe", arguments: args });
  return seen;
}

const keysOf = (shape: RawShape): string[] => Object.keys(shape).sort();
const missing = (from: readonly string[], required: readonly string[]): string[] =>
  required.filter((k) => !from.includes(k)).sort();

// ===========================================================================
// §1 — THE MECHANISM. Why losing a field is SILENT.
// ===========================================================================

describe("§1 the drop mechanism: an undeclared key is deleted without a word", () => {
  it("hands the tool callback zod's PARSED args, so a key the schema omits never arrives", async () => {
    // A shape deliberately unrelated to any real tool, so this pins the SDK
    // behaviour itself and cannot be invalidated by fixing a schema.
    const shape: RawShape = { declared: z.string().optional() };

    const received = await whatTheHandlerReceives(shape, {
      declared: "arrived",
      undeclared: "vanished",
      alsoUndeclared: { nested: true },
    });

    expect(received.declared).toBe("arrived");
    // No error, no warning: the caller was told nothing.
    expect(received).not.toHaveProperty("undeclared");
    expect(received).not.toHaveProperty("alsoUndeclared");
    expect(Object.keys(received)).toEqual(["declared"]);
  });

  it("does NOT drop a declared nested object — zod v4 + SDK 1.30 forward it whole", async () => {
    // The suspicion that nested `z.object({...})` fields were mangled by the
    // JSON-Schema conversion is refuted here, for good: the drop is always a
    // DECLARATION problem, never a nesting problem.
    const shape: RawShape = {
      nest: z.object({ a: z.string(), b: z.boolean().optional() }).optional(),
    };
    const received = await whatTheHandlerReceives(shape, { nest: { a: "x", b: true } });
    expect(received.nest).toEqual({ a: "x", b: true });
  });
});

// ===========================================================================
// §2 — THE INVARIANT. Every write form, on every surface.
// ===========================================================================

/**
 * The source-producing forms `resolveWriteSource` (src/tools/write.ts)
 * actually implements, each keyed by the argument field that selects it.
 * These are the same three forms `ABAP_WRITE_DESCRIPTION`, the bare-call
 * text and the BAD_INPUT hint all advertise — so a surface that does not
 * declare one is a surface whose own error messages lie.
 *
 * ADD A FORM HERE when `resolveWriteSource` grows a branch. The point of the
 * table is that it is derived from what the CORE implements, not from what
 * any one schema happens to declare.
 */
const WRITE_FORM_FIELDS: Record<string, unknown> = {
  // {object, source} — full rewrite.
  source: "CLASS zcl_probe DEFINITION PUBLIC.\nENDCLASS.",
  // {object, edit:{old_string,new_string}} — unique-match splice. The exact
  // payload shape the real call sent.
  edit: {
    old_string: "No transport orders found for the given selection.",
    new_string: "No transport orders match the given selection.",
  },
  // {object, method, source} — whole-method replace.
  method: "IF_HTTP_EXTENSION~HANDLE_REQUEST",
};

/**
 * Every module that registers a tool NAMED `abap_write`. Both surfaces route
 * to the same core `abapWrite`, so both must accept the same forms.
 * ADD A ROW when a third surface appears.
 */
const WRITE_SURFACES: readonly { readonly surface: string; readonly registrar: string; readonly shape: RawShape }[] = [
  {
    surface: "v1 (ABAP_TOOL_SURFACE=v1 — the shipped DEFAULT, src/config.ts)",
    registrar: "src/tools/write.ts registerWriteTools",
    shape: writeInputSchema as RawShape,
  },
  {
    surface: "v2 (ABAP_TOOL_SURFACE=v2)",
    registrar: "src/tools/v2/register.ts registerV2Tools",
    shape: abapWriteInputSchema as RawShape,
  },
];

describe("§2 every write form survives every registered abap_write schema", () => {
  for (const { surface, registrar, shape } of WRITE_SURFACES) {
    it(`${surface}: declares every form resolveWriteSource implements`, () => {
      const absent = missing(keysOf(shape), Object.keys(WRITE_FORM_FIELDS));
      expect(
        absent,
        `${registrar} registers abap_write without ${JSON.stringify(absent)}. ` +
          "resolveWriteSource implements that form and the tool's own BAD_INPUT hint advertises it, " +
          "so a caller who uses it gets the field deleted by zod and then a refusal telling them to " +
          "use the form they just used.",
      ).toEqual([]);
    });

    it(`${surface}: DELIVERS every form field to the handler, values intact`, async () => {
      const args: Record<string, unknown> = { object: "ZTM_CL_HWOOP_VIEW_WRITE", ...WRITE_FORM_FIELDS };
      const received = await whatTheHandlerReceives(shape, args);

      for (const [field, value] of Object.entries(WRITE_FORM_FIELDS)) {
        expect(
          received[field],
          `${registrar}: \`${field}\` did not reach the handler. It was sent, it is a form the core ` +
            "implements, and it arrived as `undefined` — the exact shape of the reported defect.",
        ).toEqual(value);
      }
    });
  }
});

// ===========================================================================
// §3 — REACHABILITY. Every declared v2 key arrives at the core function.
// ===========================================================================

/**
 * One representative value per field of `abapWriteInputSchema`. The test
 * below asserts this table's key set EQUALS the schema's, so adding a field
 * to the schema fails here until somebody states what it should look like —
 * and then fails again if the handler does not forward it.
 *
 * EXPECTED RED UNTIL THE v2 SCHEMA COMMIT MERGES. The `include` row
 * below describes `abapWriteInputSchema` AFTER `include` is added to it
 * (`src/tools/v2/schemas.ts`, commit 0c9e84d on feat/class-includes). On a
 * tree without that commit the equality is exact in the other direction and
 * three tests here fail — §3's "covers exactly the schema", §4's "covers
 * exactly the schema" and §4's "all N declared fields arrive intact". That is
 * the table doing its job: it is the thing that refuses to let a schema and
 * its coverage drift apart, so it must be wrong on exactly one side of the
 * merge. Do NOT resolve this by deleting the row.
 */
const V2_WRITE_SAMPLES: Record<string, unknown> = {
  object: "ZCL_PROBE",
  edit: { old_string: "old", new_string: "new", replace_all: true },
  method: "DO_SOMETHING",
  source: "CLASS zcl_probe DEFINITION PUBLIC.\nENDCLASS.",
  mode: "delete",
  type: "CLAS/OC",
  package: "$TMP",
  description: "probe object",
  expect_etag: "20260812120000",
  corr_nr: "A4HK900123",
  activate: false,
  format: true,
  // Not `mode`-coupled: §3 sends one field at a time on top of `object`,
  // so this never meets the table's `mode: "delete"`. `testclasses` rather than
  // `main` on purpose — `main` is the default, so a handler that dropped the
  // field entirely would still forward the right thing and the test would pass
  // while proving nothing.
  include: "testclasses",
  // One value per key, so a dropped key inside the nested object would
  // fail this the same way a dropped top-level field would.
  ddic: {
    dataType: "CHAR",
    length: 10,
    decimals: 0,
    outputLength: 10,
    lowercase: true,
    signExists: false,
    typeKind: "domain",
    typeName: "ZDOM_PROBE",
    shortLabel: "Short",
    shortLength: 10,
    mediumLabel: "Medium",
    mediumLength: 20,
    longLabel: "Long",
    longLength: 40,
    headingLabel: "Heading",
    headingLength: 55,
  },
};

/** Enough of `V2ToolDeps` for `handleAbapWrite` to reach `abapWrite`. */
function stubDeps(): V2ToolDeps {
  return {
    pool: {
      withWrite: async <T>(_tool: string, _key: string, fn: (conn: unknown) => Promise<T>): Promise<T> =>
        fn({ cfg: { sid: "TST" } }),
    },
    safety: { assert: () => {} },
    ensureConnected: async () => {},
    errorResult: () => ({ content: [] }),
    journal: {},
    transport: {},
    debugDeps: {},
    warn: () => {},
    cfg: { maxResponseChars: 50_000, abapMode: "edit" },
  } as unknown as V2ToolDeps;
}

describe("§3 v2 abap_write: every declared field reaches the core abapWrite", () => {
  it("the sample table covers exactly the schema — no more, no less", () => {
    expect(
      Object.keys(V2_WRITE_SAMPLES).sort(),
      "abapWriteInputSchema and this file's sample table disagree. If you added a field to the " +
        "schema, add a representative value here so its reachability is actually proven.",
    ).toEqual(keysOf(abapWriteInputSchema as RawShape));
  });

  for (const field of Object.keys(V2_WRITE_SAMPLES)) {
    it(`forwards \`${field}\` to abapWrite`, async () => {
      captured.input = undefined;
      // One field at a time on top of `object`: `edit`+`source` and
      // `edit`+`method` are refused by the handler on purpose, so sending the
      // whole bag at once would prove nothing.
      const args =
        field === "object"
          ? { object: V2_WRITE_SAMPLES.object }
          : { object: V2_WRITE_SAMPLES.object, [field]: V2_WRITE_SAMPLES[field] };

      await handleAbapWrite(args, stubDeps());

      const input = captured.input as Record<string, unknown> | undefined;
      expect(input, `abapWrite was never called for \`${field}\``).toBeDefined();
      expect(
        input?.[field],
        `handleAbapWrite accepted \`${field}\` and did not pass it on. Forward the args bag wholesale ` +
          "rather than copying fields by hand — a hand-maintained mapping is what loses fields.",
      ).toEqual(V2_WRITE_SAMPLES[field]);
    });
  }

  /**
   * EXPECTED RED UNTIL THE v2 SCHEMA COMMIT MERGES.
   *
   * `include` is `z.string()` on the v2 surface, not `z.enum` — Rule 1 forbids
   * the closed-enum combinator under `src/tools/v2/` and
   * `test/tools-v2-budget.test.ts:254` source-scans for it. So the schema
   * cannot reject a misspelling; `assertClassInclude` in the handler is the
   * ONLY thing standing between "testclass" and a silent write to the wrong
   * document. That narrowing must stay hoisted above `deps.safety.assert` and
   * `deps.ensureConnected`, which is what this pins: the ordering is invisible
   * at the call site and is exactly what a later tidy-up moves.
   */
  it("refuses a misspelled include BY NAME, before it connects or checks the gate", async () => {
    const seen: string[] = [];
    const errors: unknown[] = [];
    const deps = {
      ...stubDeps(),
      safety: { assert: () => seen.push("safety.assert") },
      ensureConnected: async () => {
        seen.push("ensureConnected");
      },
      pool: {
        withWrite: async <T>(_t: string, _k: string, fn: (c: unknown) => Promise<T>): Promise<T> => {
          seen.push("pool.withWrite");
          return fn({ cfg: { sid: "TST" } });
        },
      },
      errorResult: (e: unknown) => {
        errors.push(e);
        return { content: [], isError: true };
      },
    } as unknown as V2ToolDeps;

    captured.input = undefined;
    const thrown = await handleAbapWrite(
      { object: "ZCL_PROBE", source: "CLASS zcl_probe DEFINITION PUBLIC.\nENDCLASS.", include: "testclass" },
      deps,
    ).then(
      (r: unknown) => ({ result: r, error: undefined }),
      (e: unknown) => ({ result: undefined, error: e }),
    );

    // THREE places the refusal can legitimately surface, and this test accepts
    // any of them — pinning one would make it a test of style rather than of
    // behaviour. In practice `handleAbapWrite` takes the third: its top-level
    // catch wraps everything in the v2 envelope (`v2Result(v2Error(...))`), so
    // it neither throws nor calls `deps.errorResult`, and a capture that only
    // watched those two would read "no refusal happened" from a handler that
    // refused correctly. That is a false GREEN in the making, so the envelope
    // is parsed too.
    // `v2Result` renders the envelope as TEXT (`renderV2`), not JSON — so this
    // reads the rendered block rather than parsing it. `code` is matched
    // loosely against the whole text for the same reason the assertions below
    // are: what matters is that the refusal REACHED THE CALLER naming the
    // include, not which serialisation carried it.
    const fromEnvelope = ((): { code: string; message: string } | undefined => {
      const result = thrown.result as
        | { isError?: boolean; content?: { type?: string; text?: string }[] }
        | undefined;
      if (result?.isError !== true) return undefined;
      const text = result.content?.find((c) => c.type === "text")?.text;
      if (text === undefined) return undefined;
      return { code: /UNSUPPORTED/.test(text) ? "UNSUPPORTED" : text, message: text };
    })();
    const direct = (thrown.error ?? errors[0]) as AbapError | undefined;
    const err = direct ? { code: direct.code, message: direct.message } : fromEnvelope;

    expect(
      err,
      'handleAbapWrite accepted include="testclass". `z.string()` cannot catch it, so if the ' +
        "handler does not, a write aimed at the unit tests lands somewhere else entirely.",
    ).toBeDefined();
    expect(err!.code).toBe("UNSUPPORTED");
    // Naming all five is the difference between a refusal a model can act on
    // and one it retries verbatim.
    for (const inc of ["main", "definitions", "implementations", "macros", "testclasses"]) {
      expect(err!.message).toContain(inc);
    }
    expect(err!.message).toContain("testclass");

    expect(
      captured.input,
      "abapWrite was reached with a bad include — the narrowing is below the write, not above it.",
    ).toBeUndefined();
    expect(
      seen,
      "the refusal cost a connection and/or a safety-gate call. It is decidable from the " +
        "argument alone; hoist `assertClassInclude` above both.",
    ).toEqual([]);
  });
});

// ===========================================================================
// §4 — the same survival check for all six v2 tools.
// ===========================================================================

/**
 * A representative value for EVERY field of EVERY v2 schema. Each tool's
 * sample set is asserted to match its schema's key set exactly, so a new
 * field anywhere in schemas.ts fails this suite until it is proven to
 * survive the registered shape.
 */
const V2_TOOL_SAMPLES: readonly { readonly tool: string; readonly shape: RawShape; readonly samples: Record<string, unknown> }[] = [
  {
    tool: "abap_find",
    shape: abapFindInputSchema as RawShape,
    samples: { query: "ZCL_*", kind: "class", where: "usages", type: "CLAS/OC", max: 25 },
  },
  {
    tool: "abap_read",
    shape: abapReadInputSchema as RawShape,
    samples: { object: "ZCL_PROBE", view: "method", method: "DO_IT", offset: 1, limit: 200, version: "active" },
  },
  { tool: "abap_write", shape: abapWriteInputSchema as RawShape, samples: V2_WRITE_SAMPLES },
  {
    tool: "abap_do",
    shape: abapDoInputSchema as RawShape,
    samples: { action: "activate", object: "ZCL_PROBE", args: { corr_nr: "A4HK900123" }, confirm: "ZCL_PROBE", dry_run: true },
  },
  {
    tool: "abap_debug",
    shape: abapDebugInputSchema as RawShape,
    samples: {
      action: "start",
      stateId: "dbg-1",
      run: "ZCL_PROBE",
      breakpoints: ["ZCL_PROBE:42", "exception:CX_SY_ZERODIVIDE"],
      step: "into",
      toLine: 42,
      frame: 2,
      path: "lt_orders[1]-guid",
      scope: "locals",
      filter: "lv_",
      from: 1,
      count: 50,
      depth: 3,
    },
  },
  {
    tool: "abap_adt",
    shape: abapAdtInputSchema as RawShape,
    samples: {
      method: "GET",
      path: "/sap/bc/adt/repository/nodestructure",
      body: "<x/>",
      headers: { Accept: "application/xml" },
    },
  },
];

describe("§4 every field of every v2 schema survives the SDK boundary", () => {
  for (const { tool, shape, samples } of V2_TOOL_SAMPLES) {
    it(`${tool}: sample table covers exactly the schema`, () => {
      expect(
        Object.keys(samples).sort(),
        `${tool}'s schema (src/tools/v2/schemas.ts) and this file's sample table disagree.`,
      ).toEqual(keysOf(shape));
    });

    it(`${tool}: all ${Object.keys(samples).length} declared fields arrive intact`, async () => {
      const received = await whatTheHandlerReceives(shape, { ...samples });
      for (const [field, value] of Object.entries(samples)) {
        expect(received[field], `${tool}.${field} was dropped or altered crossing the SDK boundary`).toEqual(value);
      }
    });
  }
});

// ===========================================================================
// §5 — cross-surface parity: two front doors, one core function.
// ===========================================================================

/**
 * Fields v1's `abap_write` declares that v2's does not. These are the DEVC/K
 * package-creation riders (`software_component` is REQUIRED for a new
 * package — src/tools/write.ts's own describe() says so), so a v2-surface
 * caller cannot create a package at all: the fields are stripped and the
 * write fails downstream for a reason that does not mention them. This is
 * the SAME defect class as `edit`, pointing the other way; it is recorded
 * rather than fixed here because widening `abapWriteInputSchema` spends
 * schema bytes, on every request, on a still-opt-in surface.
 *
 * `affects` (Blocker A: ENHO/XHH source writes were unreachable
 * because no tool schema could ever build the EnhancementIntent the
 * gate requires) joined this list for the identical reason — the shipped
 * DEFAULT surface is v1 (`ABAP_TOOL_SURFACE=v1`), so making the capability
 * reachable there was the fix; widening v2's schema too would spend bytes on
 * a still-opt-in surface no live agent was blocked on.
 *
 * `base_table`, `program` and `view_fields` joined this list for the third
 * instance of the same reason, and it is recorded here rather than waved
 * through. They are the riders for classic-view (`VIEW/DV`) and transaction
 * (`TRAN/T`) creation through the classrun bridge — `abapCreateViaBridge` in
 * src/tools/write.ts requires `base_table` + `view_fields` for a view and
 * `program` for a transaction, and refuses BAD_INPUT naming the missing one.
 * v2's `abap_write` reaches that same `abapWrite`, so a v2-surface caller who
 * sends them has them stripped by zod and gets the refusal anyway; the
 * refusal names the field, so the failure is loud rather than silent, but the
 * capability is genuinely unreachable on v2. Widening `abapWriteInputSchema`
 * spends real bytes, on every request, to reach an opt-in surface, when the
 * shipped DEFAULT is v1 (`ABAP_TOOL_SURFACE=v1`) and no live agent runs v2.
 * Same trade as `affects`, decided the same way. If v2 ever becomes the
 * default this MUST be fixed before the flip, not after.
 *
 * `objects` (batch delete, `feat/batch-activation`'s sibling on the write
 * side) is a DIFFERENT kind of entry from the six above: those are "not yet
 * worth the bytes on an opt-in surface" and the comment on "the premise the
 * gap list rests on" (below) says so explicitly — flip the default and they
 * become a real gap. `objects` is not that. Batching is deliberately, and
 * permanently, a v1 tool-surface concept: `abap_do action=activate`
 * (src/tools/v2/handlers/do/activation.ts) already established the precedent
 * that v2 never carries the `objects` batch form, independent of which
 * surface ships as the default — its own comment states plainly that
 * `abap_do` never uses the batch form. So if v1 ever stops being the
 * default, every other entry in this list is a promise to go fix; `objects`
 * is not — it stays on this list (or moves to a list of its own) rather than
 * being closed by widening `abapWriteInputSchema` to carry a batch form v2
 * was never meant to have.
 *
 * THIS LIST MUST ONLY EVER SHRINK. It is not an endorsement — the test below
 * fails both when a NEW gap appears and when a listed gap is fixed (delete
 * the entry then). Growing it is a decision, not a default: every entry
 * above states why widening v2 was rejected, not merely deferred.
 */
const KNOWN_V1_ONLY_WRITE_FIELDS = [
  "affects",
  "base_table",
  // TABL/DI index-create also needs `base_table`, already on this list, so
  // the whole index-create route is v1-only — widening v2 for
  // `index_fields`/`index_unique` alone would declare two fields v2 could
  // never make use of. Closing this gap means adding `base_table` at the
  // same time, not these two on their own.
  "index_fields",
  "index_unique",
  "objects",
  "package_type",
  "program",
  "software_component",
  "transport_layer",
  // Per-call override that raises ONE write to verified mode
  // (server default comes from ABAP_VERIFY_WRITES). Same trade as every
  // other entry here: widening `abapWriteInputSchema` spends bytes on every
  // request of a still-opt-in surface. v2's mode-aware `next` already reads
  // the server-wide `deps.cfg.verifyWrites` default; only the per-call raise
  // is unreachable on v2 today.
  "verify",
  "view_fields",
] as const;

describe("§5 the two registered abap_write schemas agree", () => {
  it("v2 declares no field v1 lacks (both reach the same abapWrite)", () => {
    const v1 = keysOf(writeInputSchema as RawShape);
    const v2 = keysOf(abapWriteInputSchema as RawShape);
    expect(
      v2.filter((k) => !v1.includes(k)),
      "a field only the v2 surface declares is a form the DEFAULT surface silently swallows",
    ).toEqual([]);
  });

  it("v1 declares no field v2 lacks, beyond the recorded gap", () => {
    const v1 = keysOf(writeInputSchema as RawShape);
    const v2 = keysOf(abapWriteInputSchema as RawShape);
    expect(v1.filter((k) => !v2.includes(k))).toEqual([...KNOWN_V1_ONLY_WRITE_FIELDS]);
  });

  /**
   * Every entry in KNOWN_V1_ONLY_WRITE_FIELDS was accepted on ONE premise:
   * v2 is opt-in, so a capability missing there blocks nobody. The comment on
   * that list says "if v2 ever becomes the default this MUST be fixed before
   * the flip". That sentence is a promise between two files with nothing
   * holding them together — which is a defect shape this repo has shipped
   * before. So it is asserted
   * here instead: flipping the default makes THIS test red, and its message
   * names the list to empty.
   *
   * Read from source rather than importing the config: `loadConfig()` wants a
   * populated environment, and what is being pinned is the DECLARED default,
   * not whatever this process happens to have in `ABAP_TOOL_SURFACE`.
   */
  it("the premise the gap list rests on — v1 is still the default surface", () => {
    const config = readFileSync(join(srcRoot, "config.ts"), "utf8");
    const declared = /toolSurface:\s*z\.enum\(\[[^\]]*\]\)\.default\("(\w+)"\)/.exec(config);
    expect(declared, "toolSurface's zod default moved or changed shape — re-read src/config.ts").not.toBeNull();
    expect(
      declared?.[1],
      "ABAP_TOOL_SURFACE now defaults to v2, so KNOWN_V1_ONLY_WRITE_FIELDS above is no longer a " +
        "deferral against an opt-in surface — it is a set of capabilities unreachable on the " +
        "surface every agent gets. Widen src/tools/v2/schemas.ts until that list is empty, " +
        "then delete this test with it.",
    ).toBe("v1");
  });
});

// ===========================================================================
// §6 — THE ROOT CAUSE, generalised across the whole v1 surface.
// ===========================================================================

/**
 * Every v1 tool except `abap_write` derives the type its core function
 * consumes from the very shape it registers:
 *
 *     export const XInput = z.object(xInputSchema);
 *     export type  XInput = z.infer<typeof XInput>;
 *
 * With that one line the two lists cannot drift — which is exactly why none
 * of these tools lost a field. `abap_write` alone hand-widened its core
 * input (`interface WriteInputV2 extends WriteInput { edit; method }`,
 * src/tools/write.ts) beyond the shape it registers, and hid the mismatch
 * behind `abapWrite(conn, args as never, ...)`.
 *
 * This suite pins the healthy pattern so the v1 surface cannot acquire a
 * second `abap_write`. Two registrars are absent for reasons, not oversight:
 * `abap_transport`/`abap_transport_release` keep their `TransportInput`
 * consts module-private (only the TYPES are exported, so there is no runtime
 * shape to compare — src/tools/transport.ts:88,99), and `abap_open_url`
 * wraps its object in `.refine()` chains, which is a ZodEffects with no
 * `.shape` (src/tools/open-url.ts:72).
 */
const V1_SCHEMA_TO_CORE_INPUT: readonly { readonly tool: string; readonly shape: RawShape; readonly core: z.ZodObject<z.ZodRawShape> }[] = [
  { tool: "abap_read", shape: readInputSchema as RawShape, core: ReadInput },
  { tool: "abap_search", shape: searchInputSchema as RawShape, core: SearchInput },
  { tool: "abap_activate", shape: activateInputSchema as RawShape, core: ActivateInput },
  { tool: "abap_run", shape: runInputSchema as RawShape, core: RunInput },
  { tool: "abap_test", shape: testInputSchema as RawShape, core: TestInput },
  { tool: "abap_journal", shape: journalInputSchema as RawShape, core: JournalInput },
  { tool: "abap_debug", shape: debugInputSchema as RawShape, core: DebugInput },
  { tool: "abap_debug_vars", shape: debugVarsInputSchema as RawShape, core: DebugVarsInput },
  { tool: "abap_debug_value", shape: debugValueInputSchema as RawShape, core: DebugValueInput },
  { tool: "abap_data_preview", shape: dataPreviewInputSchema as RawShape, core: DataPreviewInput },
  { tool: "abap_fpm_read", shape: fpmReadInputSchema as RawShape, core: FpmReadInput },
  { tool: "abap_enh", shape: enhInputSchema as RawShape, core: EnhInput },
  { tool: "abap_bopf_test", shape: bopfTestInputSchema as RawShape, core: BopfTestInput },
  { tool: "abap_bopf", shape: bopfInputSchema as RawShape, core: BopfInput },
  { tool: "abap_bopf_edit", shape: bopfEditInputSchema as RawShape, core: BopfEditInput },
  { tool: "abap_bopf_delete", shape: bopfDeleteInputSchema as RawShape, core: BopfDeleteInput },
];

describe("§6 every v1 tool's core input type is derived from the shape it registers", () => {
  for (const { tool, shape, core } of V1_SCHEMA_TO_CORE_INPUT) {
    it(`${tool}: registered shape and core input object have the same fields`, () => {
      expect(
        keysOf(core.shape as RawShape),
        `${tool}'s core function accepts fields its registered schema does not declare (or vice versa). ` +
          "Every such field is silently stripped by zod before the handler runs — that is exactly how " +
          "abap_write lost `edit`. Derive the core input type from the registered shape.",
      ).toEqual(keysOf(shape));
    });
  }

  /**
   * `abap_write` USED TO BE the one v1 tool that could not join the table
   * above: its core took `WriteInputV2`, a hand-written interface that
   * EXTENDED the schema-derived `WriteInput` with `edit` and `method` —
   * fields `writeInputSchema` did not declare. That hand-widening WAS the
   * defect: `resolveWriteSource` branched on two fields zod deleted before
   * the handler ever ran, and the tool's own BAD_INPUT hint then advertised
   * the very form it had just discarded.
   *
   * The fix collapsed the widening — `edit`/`method` moved into
   * `writeInputSchema`, and `WriteInputV2` became a plain alias of the
   * schema-derived `WriteInput`. So the guarantee is now STRUCTURAL rather
   * than checked: there is exactly one list of the fields `abap_write`
   * accepts (the schema), and a field the core reads but no surface declares
   * can no longer be expressed.
   *
   * This test pins that collapse in place. If someone reintroduces a
   * hand-written widening, it does not merely complain — it falls back to
   * the original, harder check and demands that EVERY widened field be
   * declared by EVERY registered surface. Either way the hole stays shut.
   */
  it("abap_write: the core input type is the schema-derived type, not a hand-widened one", () => {
    const writeSource = readFileSync(join(srcRoot, "tools/write.ts"), "utf8");

    // The alias form: `export type WriteInputV2 = WriteInput;` — no body, so
    // the core cannot consume a field the registered schema does not declare.
    const isAlias = /(?:export\s+)?type\s+WriteInputV2\s*=\s*WriteInput\s*;/.test(writeSource);

    if (isAlias) {
      // Structural guarantee holds. Assert the derivation it rests on is
      // still real, i.e. `WriteInput` really is inferred FROM the registered
      // shape rather than re-declared by hand alongside it.
      expect(
        /WriteInput\s*=\s*z\.object\(\s*writeInputSchema\s*\)/.test(writeSource),
        "WriteInputV2 aliases WriteInput, but WriteInput is no longer inferred from `writeInputSchema` — " +
          "the core's input type and the registered schema can drift apart again.",
      ).toBe(true);
      return;
    }

    // Fallback: hand-widening is back. Hold it to the original contract.
    const widenedFields = declaredFields(writeSource, "WriteInputV2");
    for (const { surface, registrar, shape } of WRITE_SURFACES) {
      expect(
        missing(keysOf(shape), widenedFields),
        `${registrar} (${surface}) does not declare a field the core \`abapWrite\` reads from its input. ` +
          "zod deletes it before the handler runs, so the feature is dead on that surface — and if the " +
          "core BRANCHES on it (as resolveWriteSource does), the call silently takes a different path.",
      ).toEqual([]);
    }
  });
});

// ===========================================================================
// §7 — the v2 handlers' hand-written arg types vs. their schemas.
// ===========================================================================

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..", "src");

/**
 * Field names of an `interface X { ... }` / `type X = { ... }` declaration.
 * Read from source because these types are module-private by design — the
 * point of the check is that they exist at all, so exporting them just to
 * test them would defeat it.
 */
function declaredFields(source: string, name: string): string[] {
  const head = new RegExp(`(?:interface|type)\\s+${name}\\b[^{]*\\{`).exec(source);
  if (head === null) throw new Error(`could not find the declaration of \`${name}\` — has it been renamed?`);
  const open = head.index + head[0].length - 1;
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new Error(`unbalanced braces reading \`${name}\``);
  const fields = source
    .slice(open + 1, end)
    .split(/[;\n]/)
    .map((line) => /^\s*(?:readonly\s+)?([A-Za-z_]\w*)\??\s*:/.exec(line)?.[1])
    .filter((f): f is string => f !== undefined);
  return [...new Set(fields)].sort();
}

/**
 * Each v2 handler re-narrows the SDK's validated-but-untyped bag through a
 * local type. That local type is a SECOND copy of the schema's field list,
 * and a second copy is a second chance to drift — `handlers/write.ts` no
 * longer has one (its arg type is now `z.infer<z.ZodObject<typeof
 * abapWriteInputSchema>>`, which is why it is absent from this table).
 *
 * KNOWN GAP, recorded rather than fixed here: `abap_debug`. `RawDebugArgs`
 * (src/tools/debug-register.ts:262) reads `a.confirm` and forwards it to
 * `DebugInput.confirm` (line 386), but `abapDebugInputSchema` does not
 * declare `confirm` — so on the v2 surface it is always stripped, and
 * `step:"jumpToLine"`, which refuses to run without `confirm:"jumpToLine"`
 * on the SAME call (src/tools/debug.ts:1541), is unreachable. v1's
 * `debugInputSchema` DOES declare it (src/tools/debug.ts:911). Same defect
 * as `edit`, different tool. Fixing it means widening a v2 schema, which
 * spends real bytes, on every request, on a still-opt-in surface.
 *
 * THIS LIST MUST ONLY EVER SHRINK.
 */
const HANDLER_ARG_TYPES: readonly {
  readonly tool: string;
  readonly file: string;
  readonly typeName: string;
  readonly shape: RawShape;
  readonly knownExtraFields: readonly string[];
}[] = [
  { tool: "abap_find", file: "tools/v2/handlers/find.ts", typeName: "FindArgs", shape: abapFindInputSchema as RawShape, knownExtraFields: [] },
  { tool: "abap_read", file: "tools/v2/handlers/read.ts", typeName: "ReadArgs", shape: abapReadInputSchema as RawShape, knownExtraFields: [] },
  { tool: "abap_do", file: "tools/v2/handlers/do.ts", typeName: "RawDoArgs", shape: abapDoInputSchema as RawShape, knownExtraFields: [] },
  { tool: "abap_adt", file: "tools/v2/handlers/adt.ts", typeName: "RawAdtArgs", shape: abapAdtInputSchema as RawShape, knownExtraFields: [] },
  { tool: "abap_debug", file: "tools/debug-register.ts", typeName: "RawDebugArgs", shape: abapDebugInputSchema as RawShape, knownExtraFields: ["confirm"] },
];

describe("§7 v2 handlers do not read fields their schema fails to declare", () => {
  for (const { tool, file, typeName, shape, knownExtraFields } of HANDLER_ARG_TYPES) {
    it(`${tool}: \`${typeName}\` matches ${tool}'s schema (known gap: ${JSON.stringify(knownExtraFields)})`, () => {
      const fields = declaredFields(readFileSync(join(srcRoot, file), "utf8"), typeName);
      const declared = keysOf(shape);

      expect(
        fields.filter((f) => !declared.includes(f)),
        `${file} narrows \`${typeName}.<field>\` off the args bag, but the registered schema does not ` +
          "declare it — zod strips it before the handler runs, so that code is unreachable.",
      ).toEqual([...knownExtraFields].sort());

      expect(
        declared.filter((f) => !fields.includes(f)),
        `${tool}'s schema declares a field \`${typeName}\` has no idea about: accepted, advertised, ignored.`,
      ).toEqual([]);
    });
  }

  it("abap_write's handler keeps NO hand-written copy of its schema", () => {
    const source = readFileSync(join(srcRoot, "tools/v2/handlers/write.ts"), "utf8");
    expect(
      source,
      "handlers/write.ts must derive its arg type from abapWriteInputSchema, not restate it — the " +
        "restatement is the drift surface this whole file exists to close.",
    ).toContain("z.infer<z.ZodObject<typeof abapWriteInputSchema>>");
  });
});
