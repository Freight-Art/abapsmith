/**
 * A minimal, structurally-correct fake `V2ToolDeps` for unit-testing
 * `abap_do`'s six group handler modules
 * (`src/tools/v2/handlers/do/*.ts`) in isolation.
 *
 * This is deliberately lighter than `test/bopf-tools.test.ts`'s harness: these
 * group handlers only need to be exercised up to the point they call into a
 * v1 orchestration function (`abapActivate`, `abapRun`, `runBopfEdit`,
 * `runEnhCreateOperation`, ...) — the tests that use this helper mock THAT
 * function directly (`vi.mock` with an `importOriginal` spread, see
 * `test/tools.test.ts` for the established pattern) and assert it was called
 * with the correctly-shaped v1 input. Nothing here talks to a network: `pool`
 * is a one-line forwarder onto a placeholder connection object the mocked v1
 * function never actually dereferences, and `safety`/`journal`/`transport`
 * are real, cheaply-constructed instances (not fakes) so that the real
 * preflight/gate logic every group handler calls BEFORE reaching the mocked
 * v1 function still runs for real.
 */
import { vi } from "vitest";
import type { AbapConnection } from "../../src/adt/connection.js";
import type { SessionPool, PoolSlot } from "../../src/adt/pool.js";
import { SafetyGate, type SafetyConfig } from "../../src/safety.js";
import { SessionTransport } from "../../src/adt/session-transport.js";
import type { TrRequirement } from "../../src/adt/transports.js";
import { Journal } from "../../src/journal.js";
import { errorResult } from "../../src/server.js";
import type { DebugToolDeps } from "../../src/tools/debug.js";
import type { V2ToolDeps } from "../../src/tools/v2/runtime.js";

/** Never dereferenced by a mocked v1 function — only ever passed through. */
export const FAKE_CONN = {} as AbapConnection;

/** A `SessionPool` that just forwards straight onto {@link FAKE_CONN}. */
export function fakeDoPool(conn: AbapConnection = FAKE_CONN): SessionPool {
  return {
    withRead: <T,>(_op: string, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
    withWrite: <T,>(_op: string, _objectUri: string | undefined, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
    reserveDebug: (_op: string): Promise<PoolSlot> => {
      throw new Error("reserveDebug: not used by any abap_do group handler, and not implemented in this fake.");
    },
    primary: () => conn,
  } as unknown as SessionPool;
}

/** A wide-open `SafetyGate` — every op/package/transport allowed. Mirrors `test/bopf-tools.test.ts`'s `openGate()`. */
export function openDoGate(overrides: Partial<SafetyConfig> = {}): SafetyGate {
  return new SafetyGate({
    readOnly: false,
    allowPackages: ["*"],
    allowTransports: ["*"],
    allowTransportRelease: true,
    allowTransportDelete: true,
    allowCascadeDelete: true,
    allowEnhancements: true,
    enhanceTargets: "sap",
    enhanceTargetPackages: ["*"],
    originSystems: ["A4H"],
    ...overrides,
  });
}

/** A fully closed `SafetyGate` — read-only, nothing allowed. Mirrors `test/bopf-tools.test.ts`'s `closedGate()`. */
export function closedDoGate(): SafetyGate {
  return new SafetyGate({ readOnly: true, allowPackages: [] });
}

const fakeTrRequirement = (overrides: Partial<TrRequirement> = {}): TrRequirement =>
  ({
    kind: "local",
    required: false,
    mustSupplyCorrNr: false,
    serverWouldFabricate: false,
    ...overrides,
  }) as unknown as TrRequirement;

/** A `$TMP`-shaped local-package transport (no CTS round trip needed). */
export function fakeDoTransport(overrides: Partial<TrRequirement> = {}): SessionTransport {
  return new SessionTransport({
    allowTransports: ["auto"],
    cts: { trRequirement: vi.fn(async () => fakeTrRequirement(overrides)) },
  });
}

export function fakeDoJournal(overrides: { enabled?: boolean } = {}): Journal {
  return new Journal(
    { dir: "/tmp/abapsmith-do-test-journal", enabled: overrides.enabled ?? true, maxEntries: 100, maxAgeDays: 30 },
    "TST",
  );
}

/** Builds a complete fake `V2ToolDeps`. Individual fields may be overridden per test. */
export function fakeDoDeps(overrides: Partial<V2ToolDeps> = {}): V2ToolDeps {
  return {
    pool: fakeDoPool(),
    safety: openDoGate(),
    ensureConnected: vi.fn(async () => {}),
    errorResult,
    journal: fakeDoJournal(),
    transport: fakeDoTransport(),
    debugDeps: {} as DebugToolDeps,
    warn: vi.fn(),
    cfg: {
      maxResponseChars: 30_000,
      allowEnhancements: true,
      allowSourcePlugins: true,
      user: "DEVELOPER",
      abapMode: "admin",
    },
    ...overrides,
  };
}
