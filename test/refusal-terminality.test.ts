/**
 * Proves the `retryable` affordance end to end: every `AbapError`'s
 * `retryable` field defaults from its taxonomy code via `RETRYABILITY`
 * (`src/adt/errors.ts`) — `terminal` codes claim `false`, `retryable` codes
 * claim `true`, `conditional` codes claim nothing — and that default holds
 * from construction through every serialised envelope (`errorResult`,
 * `v2Error` + `renderV2`). A per-site `{ retryable: ... }` option still
 * overrides the code's default in either direction. `RETRYABILITY` itself is
 * proven exhaustive against the real `AbapErrorCode` union (extracted from
 * source, not hand-transcribed), so a new code cannot go unclassified. Also
 * covers the pre-existing capability-registry-derived terminal claims
 * (`resolveObject`/`resolveWriteTarget`), and that the prose refusal message
 * agrees with the structured field by always ending in
 * `TERMINAL_REFUSAL_NOTE` whenever `retryable === false` is claimed.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { AbapError, RETRYABILITY } from "../src/adt/errors.js";
import { buildErrorPayload, errorResult } from "../src/tool-errors.js";
import { v2Error } from "../src/tools/v2/runtime.js";
import { renderV2 } from "../src/tools/v2/envelope.js";
import {
  REGISTRY,
  TERMINAL_REFUSAL_NOTE,
  CREATABLE_TYPES,
  ENHANCEABLE_TYPES,
  DELETABLE_TYPES,
  isBridgeOnlyCreateType,
  isBridgeDeletableType,
  type TypeCode,
} from "../src/adt/capabilities.js";
import { resolveObject } from "../src/adt/resolve.js";
import { resolveWriteTarget } from "../src/adt/write.js";
import type { AbapConnection } from "../src/adt/connection.js";
import { assertClassicViewCreateTarget, classicViewFragment, type ClassicViewParams } from "../src/adt/view-create.js";
import { SafetyGate } from "../src/safety.js";
import { runUiTool, type UiInput, type UiToolDeps } from "../src/tools/ui.js";

/** `undefined` for a non-`AbapError` throw, or nothing thrown at all. */
const retryableOf = (e: unknown): boolean | undefined => (e instanceof AbapError ? e.retryable : undefined);

/**
 * Every method rejects — the point of tests 5-7 is that the capability
 * gates in `resolveObject`/`resolveWriteTarget` fire and decide the
 * `retryable` question *before* any of these would ever be reached. A type
 * that gets past the gates fails here for an unrelated (network) reason,
 * with no `retryable` claim attached.
 */
function makeDeadConn(): AbapConnection {
  const dead = async (): Promise<never> => {
    throw new Error("refusal-terminality: fake connection has no network");
  };
  return {
    cfg: { sid: "T00" },
    adt: {
      searchObject: dead,
      objectStructure: dead,
    },
    get: dead,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as AbapConnection;
}

/** Same union-extraction technique as `test/iserror-envelope-contract.test.ts`. */
function extractAbapErrorCodes(): string[] {
  const src = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const raw = readFileSync(resolve(src, "adt", "errors.ts"), "utf8");
  const text = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  const start = text.indexOf("export type AbapErrorCode =");
  if (start === -1) throw new Error("AbapErrorCode union not found");
  const end = text.indexOf(";", start);
  const block = text.slice(start, end);
  return [...block.matchAll(/\|\s*"([A-Z0-9_]+)"/g)].map((m) => m[1]!);
}

describe("RETRYABILITY covers the taxonomy exhaustively", () => {
  it("has exactly one entry per AbapErrorCode union member, and no others", () => {
    const codes = extractAbapErrorCodes();
    expect(new Set(Object.keys(RETRYABILITY))).toEqual(new Set(codes));
    expect(Object.keys(RETRYABILITY)).toHaveLength(codes.length);
  });

  it("every value is one of the three legal Retryability strings", () => {
    const legal = new Set(["terminal", "retryable", "conditional"]);
    for (const [code, value] of Object.entries(RETRYABILITY)) {
      expect(legal.has(value), `${code}: ${value}`).toBe(true);
    }
  });
});

describe("retryable on the error envelope", () => {
  it("buildErrorPayload reports retryable:false for an AbapError constructed with that option", () => {
    const e = new AbapError("UNSUPPORTED", "cannot be read", {}, undefined, { retryable: false });
    const payload = buildErrorPayload(e);
    expect(payload.retryable).toBe(false);
  });

  it("buildErrorPayload omits the key entirely when the AbapError never claimed a retryable value — including for SESSION_DEAD, whose code is classified `conditional`, a documented recovery path that must never read as terminal", () => {
    const e = new AbapError("SESSION_DEAD", "the ABAP session died mid-request");
    const payload = buildErrorPayload(e);
    expect(Object.prototype.hasOwnProperty.call(payload, "retryable")).toBe(false);
  });

  it("errorResult's serialised JSON text round-trips the field", () => {
    const e = new AbapError("UNSUPPORTED", "cannot be written", {}, undefined, { retryable: false });
    const res = errorResult(e);
    const text = (res.content[0] as { type: "text"; text: string }).text;
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.retryable).toBe(false);
  });

  it("v2Error forwards retryable, and renderV2 prints it as a `retryable: false` line", () => {
    const e = new AbapError("UNSUPPORTED", "cannot be read", {}, undefined, { retryable: false });
    const res = v2Error("abap_read", e, []);
    const rendered = renderV2(res);
    expect(rendered.split("\n")).toContain("retryable: false");
  });

  it("a code with no options set claims false when its code is terminal (UNSUPPORTED)", () => {
    const e = new AbapError("UNSUPPORTED", "cannot be read");
    expect(e.retryable).toBe(false);
    expect(buildErrorPayload(e).retryable).toBe(false);
    const jsonText = (errorResult(e).content[0] as { type: "text"; text: string }).text;
    expect((JSON.parse(jsonText) as Record<string, unknown>).retryable).toBe(false);
    const rendered = renderV2(v2Error("abap_read", e, []));
    expect(rendered.split("\n")).toContain("retryable: false");
  });

  it("a code with no options set claims true when its code is retryable (BAD_INPUT) — a length limit is retryable with a shorter argument", () => {
    const e = new AbapError("BAD_INPUT", "value too long");
    expect(e.retryable).toBe(true);
    const rendered = renderV2(v2Error("abap_read", e, []));
    expect(rendered.split("\n")).toContain("retryable: true");
  });

  it("conditional codes (SESSION_DEAD, ADT_ERROR) render no retryable key at all", () => {
    for (const code of ["SESSION_DEAD", "ADT_ERROR"] as const) {
      const e = new AbapError(code, "something happened");
      expect(e.retryable, code).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(buildErrorPayload(e), "retryable"), code).toBe(false);
      const rendered = renderV2(v2Error("abap_read", e, []));
      expect(rendered.includes("retryable:"), `${code}: ${rendered}`).toBe(false);
    }
  });

  it("an explicit option overrides the code's default in both directions", () => {
    const forcedRetryable = new AbapError("UNSUPPORTED", "actually retryable here", {}, undefined, {
      retryable: true,
    });
    expect(forcedRetryable.retryable).toBe(true);

    const forcedTerminal = new AbapError("BAD_INPUT", "actually terminal here", {}, undefined, {
      retryable: false,
    });
    expect(forcedTerminal.retryable).toBe(false);
  });
});

describe("assertClassicViewCreateTarget / classicViewFragment derive retryable from RETRYABILITY with no 5th argument — neither refusal is terminal", () => {
  const CORR_NR = "A4HK900121";

  it("a local package given a corrNr claims retryable:true (BAD_INPUT's default), not terminal", () => {
    let caught: unknown;
    try {
      assertClassicViewCreateTarget("$TMP", CORR_NR);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AbapError);
    const e = caught as AbapError;
    expect(e.code).toBe("BAD_INPUT");
    expect(RETRYABILITY["BAD_INPUT"]).toBe("retryable");
    expect(e.retryable).toBe(true);
  });

  // `assertClassicViewCreateTarget` no longer refuses a transportable package
  // with no corrNr — that invariant moved into view-create.ts's module-private
  // `validate()`, which `classicViewFragment` calls. TRANSPORT_ERROR's default
  // is "conditional" — no claim either way, which is itself proof this
  // refusal is not terminal (a terminal claim requires an explicit
  // retryable:false, never a bare code default).
  it("classicViewFragment given a transportable package with no corrNr claims no retryable value (TRANSPORT_ERROR's conditional default), not terminal", () => {
    const params: ClassicViewParams = {
      viewName: "ZTM_V_CARRIER",
      baseTable: "SCARR",
      fields: ["CARRID"],
      description: "Carriers",
      packageName: "ZTM",
    };
    let caught: unknown;
    try {
      classicViewFragment(params);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AbapError);
    const e = caught as AbapError;
    expect(e.code).toBe("TRANSPORT_ERROR");
    expect(RETRYABILITY["TRANSPORT_ERROR"]).toBe("conditional");
    expect(e.retryable).toBeUndefined();
  });
});

describe("SafetyGate.assertDataPreview derives retryable:false from SAFETY_DENIED", () => {
  it("a denied table (USR02) throws with retryable === false", () => {
    const gate = new SafetyGate({ readOnly: true, allowPackages: [], writesLockedOut: false });
    let caught: unknown;
    try {
      gate.assertDataPreview("USR02");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AbapError);
    const e = caught as AbapError;
    expect(e.code).toBe("SAFETY_DENIED");
    expect(e.retryable).toBe(false);
  });
});

describe("abap_ui press's confirm gate overrides SAFETY_DENIED's terminal default", () => {
  it("confirm omitted throws SAFETY_DENIED with retryable:true, not RETRYABILITY's terminal default", async () => {
    const input = { mode: "press" } as UiInput;
    let caught: unknown;
    try {
      // assertPressConfirmed is the first thing runPressTool does, so `deps`
      // never gets touched before the throw — same "never reached" shape as
      // the boom() deps other tool-level tests in this repo use.
      await runUiTool({} as UiToolDeps, input);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AbapError);
    const e = caught as AbapError;
    expect(e.code).toBe("SAFETY_DENIED");
    expect(RETRYABILITY["SAFETY_DENIED"]).toBe("terminal");
    expect(e.retryable).toBe(true);
  });
});

describe("terminality is derived from the capability registry", () => {
  // Every expectation below is recomputed from REGISTRY's own derived
  // exports (CREATABLE_TYPES, ENHANCEABLE_TYPES, DELETABLE_TYPES,
  // isBridgeOnlyCreateType, isBridgeDeletableType) on each run, not
  // hand-maintained — those are the exact projections the gates themselves
  // consult, so a type gaining or losing a capability flips both the gate
  // and this test's expectation through the same computation, and no
  // separately-maintained "these types are terminal" list can go stale.

  it("read: resolveObject's retryable claim matches unsupported/bridge-only-create exactly as REGISTRY declares them", async () => {
    const fakeConn = makeDeadConn();
    for (const code of Object.keys(REGISTRY) as TypeCode[]) {
      const cap = REGISTRY[code];
      const expectTerminal = cap.unsupported !== undefined || isBridgeOnlyCreateType(code);
      let caught: unknown;
      try {
        await resolveObject(fakeConn, "ZTERM_PROBE", { type: code });
      } catch (e) {
        caught = e;
      }
      expect(
        retryableOf(caught),
        `${code}: expected retryable=${expectTerminal ? "false" : "undefined"} (unsupported=${cap.unsupported !== undefined}, bridgeOnlyCreate=${isBridgeOnlyCreateType(code)})`,
      ).toBe(expectTerminal ? false : undefined);
    }
  });

  // delete/write (unlike read, above) also check the converse: a permitted
  // type still reaches a real package-resolution request past the REGISTRY
  // gate, and against `makeDeadConn()` that request fails closed through
  // `packageUnknown()` (src/adt/write.ts) — which now overrides SAFETY_DENIED
  // to `retryable: true` (a failure to determine the package, not a policy
  // verdict), so a permitted type must never read as terminal here.

  it("delete: resolveWriteTarget's retryable claim matches non-deletable exactly as REGISTRY declares it", async () => {
    const fakeConn = makeDeadConn();
    for (const code of Object.keys(REGISTRY) as TypeCode[]) {
      const cap = REGISTRY[code];
      // The bridge-only-create refusal fires ahead of the delete-specific
      // gate for ANY op (resolveWriteTarget refuses VIEW/DV and TRAN/T
      // outright before it ever inspects `op`) — see abapBridgeCrud's and
      // resolveBridgeCreateUndo's doc comments: those two types' real
      // delete is routed around resolveWriteTarget entirely, so this early
      // refusal is not a false terminal claim for any reachable delete.
      const expectTerminal =
        cap.unsupported !== undefined ||
        isBridgeOnlyCreateType(code) ||
        !(DELETABLE_TYPES.includes(code) || isBridgeDeletableType(code));
      let caught: unknown;
      try {
        await resolveWriteTarget(fakeConn, { type: code, name: "ZTERM_PROBE" }, "delete");
      } catch (e) {
        caught = e;
      }
      // Terminal types claim false; permitted types still fail closed on the
      // dead connection, but through packageUnknown()'s retryable:true override.
      expect(retryableOf(caught), `${code}: expected retryable=${!expectTerminal}`).toBe(!expectTerminal);
    }
  });

  it("write: resolveWriteTarget's retryable claim matches unsupported/bridge-only-create/unwritable exactly as REGISTRY declares them", async () => {
    const fakeConn = makeDeadConn();
    for (const code of Object.keys(REGISTRY) as TypeCode[]) {
      const cap = REGISTRY[code];
      const expectTerminal =
        cap.unsupported !== undefined ||
        isBridgeOnlyCreateType(code) ||
        (!CREATABLE_TYPES.includes(code) && !ENHANCEABLE_TYPES.includes(code));
      let caught: unknown;
      try {
        await resolveWriteTarget(fakeConn, { type: code, name: "ZTERM_PROBE" }, "write");
      } catch (e) {
        caught = e;
      }
      // Terminal types claim false; permitted types still fail closed on the
      // dead connection, but through packageUnknown()'s retryable:true override.
      expect(retryableOf(caught), `${code}: expected retryable=${!expectTerminal}`).toBe(!expectTerminal);
    }
  });
});

// Static source scan shared by the next three tests. Uses the real
// TypeScript compiler API (not regex) because `new AbapError(...)` call
// sites in this codebase legitimately contain nested template literals
// (interpolations that themselves contain backtick strings) — a
// regex/text-based argument-count scan mis-splits those, producing a false
// positive 5-argument reading on a genuinely 4-argument call. A real parse
// does not have that failure mode.
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

interface AbapErrorCallSite {
  file: string;
  line: number;
  argCount: number;
  /** Line text of the 5th ("options") argument — a 5-arg call is a deliberate per-site override of RETRYABILITY. */
  optionArgLineText: string;
}

interface RetryableTrueHit {
  file: string;
  line: number;
  lineText: string;
}

/**
 * Parses all of `src/` once with the real TypeScript compiler and caches the
 * result at module scope — this used to run fresh (three full-`src/` parses)
 * for each of the three tests below, which is what made this file time out
 * at 30s in a full-suite run. The scan is pure and `src/` does not change
 * mid-run, so a lazily-computed, process-lifetime cache is safe.
 */
let scanSrcCache: { calls: AbapErrorCallSite[]; retryableTrueHits: RetryableTrueHit[] } | undefined;

function scanSrc(): { calls: AbapErrorCallSite[]; retryableTrueHits: RetryableTrueHit[] } {
  if (scanSrcCache) return scanSrcCache;
  const calls: AbapErrorCallSite[] = [];
  const retryableTrueHits: RetryableTrueHit[] = [];
  for (const file of listTsFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const rel = relative(SRC, file).split("\\").join("/");
    const lines = text.split("\n");

    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "AbapError") {
        const args = node.arguments ?? [];
        if (args.length >= 5) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          const optionArg = args[4]!;
          const optionLine = sf.getLineAndCharacterOfPosition(optionArg.getStart(sf)).line;
          calls.push({
            file: rel,
            line: line + 1,
            argCount: args.length,
            optionArgLineText: lines[optionLine] ?? "",
          });
        }
      }
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "retryable") {
        if (node.initializer.kind === ts.SyntaxKind.TrueKeyword) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          retryableTrueHits.push({ file: rel, line: line + 1, lineText: lines[line] ?? "" });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  scanSrcCache = { calls, retryableTrueHits };
  return scanSrcCache;
}

describe("terminality overrides are deliberate and explained", () => {
  it("every 5-argument `new AbapError(...)` call site in src/ carries an explanatory trailing `//` comment on its option-argument line — a 5th argument is a deliberate per-site override of RETRYABILITY (not just for UNSUPPORTED: SAFETY_DENIED sites override it too), so a claim this consequential is never left unexplained", () => {
    const { calls } = scanSrc();
    const unexplained = calls.filter((c) => !c.optionArgLineText.includes("//"));
    expect(
      unexplained,
      unexplained.map((c) => `${c.file}:${c.line} (argCount=${c.argCount})`).join(", "),
    ).toEqual([]);
  });

  it("every `retryable: true` property assignment in src/ carries a trailing comment explaining why — retryable:true is no longer forbidden (it's the default for a `retryable`-classified code, see RETRYABILITY), so the real contract is that a claim this consequential is never left unexplained", () => {
    const { retryableTrueHits } = scanSrc();
    const unexplained = retryableTrueHits.filter((h) => !h.lineText.includes("//"));
    expect(
      unexplained,
      unexplained.map((h) => `${h.file}:${h.line}: ${h.lineText.trim()}`).join(", "),
    ).toEqual([]);
    // The scan must actually have found some, or the assertion above is vacuous.
    expect(retryableTrueHits.length).toBeGreaterThan(0);
  });

  it("exactly 19 call sites pass a 5th argument to `new AbapError(...)` — 2 in adt/resolve.ts, 8 in adt/write.ts, 1 in adt/resolved-package.ts, 1 in adt/index-create.ts, 3 in adt/undo.ts, 1 in tools/write.ts, 1 in tools/debug.ts, 1 in tools/ui.ts and 1 in debug/session.ts, all per-site overrides of RETRYABILITY's default (terminal-by-code UNSUPPORTED/SAFETY_DENIED sites whose own prose promises a working retry, plus BAD_INPUT sites whose own prose forbids a retry): most terminal codes still get retryable:false automatically from RETRYABILITY with no 5th argument at all", () => {
    const { calls } = scanSrc();
    expect(
      calls.length,
      `found: ${calls.map((c) => `${c.file}:${c.line}`).join(", ")}`,
    ).toBe(19);
  });
});

describe("the prose and the field say the same thing", () => {
  it("every read refusal that claims retryable:false ends its message with TERMINAL_REFUSAL_NOTE", async () => {
    // Re-runs the loop independently rather than sharing state with the
    // "terminality is derived from the capability registry" describe block.
    const fakeConn = makeDeadConn();
    let terminalRefusalsSeen = 0;
    for (const code of Object.keys(REGISTRY) as TypeCode[]) {
      let caught: unknown;
      try {
        await resolveObject(fakeConn, "ZTERM_PROBE", { type: code });
      } catch (e) {
        caught = e;
      }
      if (caught instanceof AbapError && caught.retryable === false) {
        terminalRefusalsSeen++;
        expect(caught.message.endsWith(TERMINAL_REFUSAL_NOTE), `${code}: "${caught.message}"`).toBe(true);
      }
    }
    // The scan must actually have exercised at least one terminal refusal,
    // or the assertion above would be vacuously true.
    expect(terminalRefusalsSeen).toBeGreaterThan(0);
  });

  it("TERMINAL_REFUSAL_NOTE itself reads as a fact, not an instruction to retry", () => {
    expect(TERMINAL_REFUSAL_NOTE.length).toBeGreaterThan(0);
    const sentences = TERMINAL_REFUSAL_NOTE.split(".").filter((s) => s.trim().length > 0);
    expect(sentences).toHaveLength(1);
    expect(TERMINAL_REFUSAL_NOTE).toContain("Terminal");
    expect(TERMINAL_REFUSAL_NOTE).toContain("cannot succeed");
    expect(TERMINAL_REFUSAL_NOTE.toLowerCase()).not.toContain("try again");
  });
});
