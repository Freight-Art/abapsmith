/**
 * `objectGateLockPath`'s `scope` parameter and `AdtSessionPool`'s scope
 * wiring (issue #93, multi-system support) — `src/adt/object-gate.ts`,
 * `src/adt/pool.ts`.
 *
 * Object identity is really `(system, object)`, not just `object`: without a
 * scope, two differently-configured systems that both happen to have a
 * `ZCL_FOO` would serialise writes against each other for no reason. Three
 * things need pinning:
 *
 *   1. `objectGateLockPath(dir, uri)` with NO scope is byte-identical to the
 *      pre-#93 path — an existing installation's lock files must not move.
 *   2. Two different scopes for the same object URI resolve to two
 *      different lock paths; the same scope resolves to the same path.
 *   3. Two `FileLockObjectGate` instances (standing in for two abapsmith
 *      PROCESSES) do not contend across scopes, but do contend within one.
 *   4. `AdtSessionPool`'s constructor derives `scope` from `systemKey({sid,
 *      url, client})` off a FULL `Config`, and passes no scope at all when
 *      any of `sid`/`url`/`client` is missing or empty on a partial test
 *      double — proven from the OUTSIDE, via the actual lock file path a
 *      real `withWrite` call produces, never by reaching into `pool`'s
 *      private `gate` field (test/pool-cross-process-object-gate.test.ts's
 *      "pool construction selects the gate" tests do reach in, to tell one
 *      gate CLASS from another; this file's job is different — proving
 *      WHICH scope string one gate instance was actually built with — and a
 *      class check can't answer that).
 *
 * Like test/pool-cross-process-object-gate.test.ts, (3) and (4) are
 * deliberately NOT offline: real `fs.mkdtempSync` state dirs, real
 * `withFileLock`. `waitMs` is short everywhere contention is expected, so a
 * failing test times out quickly rather than at the 1500 ms default.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  AdtSessionPool,
  FileLockObjectGate,
  objectGateLockPath,
  type SessionPoolOptions,
} from "../src/adt/pool.js";
import { objectUriOf } from "../src/adt/session.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { systemKey } from "../src/system-key.js";
import type { Config } from "../src/config.js";
import type { AbapConnection, ConnectionOptions } from "../src/adt/connection.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];
function mkStateDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "abapsmith-object-gate-scope-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}
function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

/** Real fs I/O — poll rather than drain microtasks. Mirrors the sibling file. */
async function waitUntil(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

/** Minimal `SessionPoolOptions.cfg` double — mirrors the sibling file's `fakeConfig`. */
function fakeConfig(over: Partial<Record<string, unknown>> = {}): Config {
  return {
    maxSessions: 1,
    readConcurrency: 1,
    writeConcurrency: 1,
    sessionIdleMs: 300_000,
    sessionWaitMs: 10_000,
    debugDiaBudget: 2,
    ...over,
  } as unknown as Config;
}

function fakeCreateConnection(): SessionPoolOptions["createConnection"] {
  return (_c, o: ConnectionOptions) =>
    ({
      breaker: o.breaker,
      async shutdown() {},
      dispose() {},
    }) as unknown as AbapConnection;
}

const URI = "/sap/bc/adt/oo/classes/zcl_x/source/main";

// ---------------------------------------------------------------------------
// 1-2. objectGateLockPath: pure-function pinning
// ---------------------------------------------------------------------------

describe("objectGateLockPath: unscoped path is byte-identical to the pre-#93 formula", () => {
  it("hashes objectUriOf(uri) alone when no scope is passed", () => {
    const dir = mkStateDir();
    const key = objectUriOf(URI);
    const hash = createHash("sha256").update(key).digest("hex").slice(0, 20);
    const expected = path.join(dir, "locks", "objects", `${hash}.lock`);

    expect(objectGateLockPath(dir, URI)).toBe(expected);
  });

  it("is unaffected by /source/main or a trailing query/fragment, same as before #93", () => {
    const dir = mkStateDir();
    const withSourceMain = objectGateLockPath(dir, "/sap/bc/adt/oo/classes/zcl_x/source/main");
    const bare = objectGateLockPath(dir, "/sap/bc/adt/oo/classes/zcl_x");
    const withQuery = objectGateLockPath(dir, "/sap/bc/adt/oo/classes/zcl_x?version=active");

    expect(withSourceMain).toBe(bare);
    expect(withQuery).toBe(bare);
  });
});

describe("objectGateLockPath: scope parameter", () => {
  it("hashes `${scope}\\n${objectUriOf(uri)}` when a scope is passed", () => {
    const dir = mkStateDir();
    const key = objectUriOf(URI);
    const hash = createHash("sha256").update(`DEV-SCOPE\n${key}`).digest("hex").slice(0, 20);
    const expected = path.join(dir, "locks", "objects", `${hash}.lock`);

    expect(objectGateLockPath(dir, URI, "DEV-SCOPE")).toBe(expected);
  });

  it("two different scopes on the same object URI resolve to two different lock paths", () => {
    const dir = mkStateDir();
    const a = objectGateLockPath(dir, URI, "DEV-SCOPE");
    const b = objectGateLockPath(dir, URI, "QAS-SCOPE");

    expect(a).not.toBe(b);
  });

  it("the same scope on the same object URI resolves to the same lock path every time", () => {
    const dir = mkStateDir();
    const a = objectGateLockPath(dir, URI, "DEV-SCOPE");
    const b = objectGateLockPath(dir, URI, "DEV-SCOPE");

    expect(a).toBe(b);
  });

  it("a scoped path is never equal to the unscoped path for the same object URI", () => {
    const dir = mkStateDir();
    const unscoped = objectGateLockPath(dir, URI);
    const scoped = objectGateLockPath(dir, URI, "DEV-SCOPE");

    expect(scoped).not.toBe(unscoped);
  });
});

// ---------------------------------------------------------------------------
// 3. FileLockObjectGate: cross-scope isolation
// ---------------------------------------------------------------------------

describe("FileLockObjectGate: scope isolates cross-process contention", () => {
  it("two gates with DIFFERENT scopes on the SAME object URI do not serialise against each other", async () => {
    const stateDir = mkStateDir();
    const devGate = new FileLockObjectGate({ stateDir, waitMs: 300, scope: "DEV-SCOPE" });
    const qasGate = new FileLockObjectGate({ stateDir, waitMs: 300, scope: "QAS-SCOPE" });
    const order: string[] = [];
    const hold = deferred<void>();

    const a = devGate.run(URI, async () => {
      order.push("dev-start");
      await hold.promise;
      order.push("dev-end");
    });
    await waitUntil(
      () => existsSync(objectGateLockPath(stateDir, URI, "DEV-SCOPE")),
      "devGate to create its scoped lock file",
    );

    // qasGate's own scoped lock is a DIFFERENT file — must acquire and run
    // immediately, without waiting for devGate to release.
    const b = qasGate.run(URI, async () => {
      order.push("qas-start");
      return "qas-done";
    });
    await expect(b).resolves.toBe("qas-done");
    // qasGate ran to completion (pushed "qas-start" AND returned) while
    // devGate was still holding its own lock — proof it never waited on it.
    expect(order, "qasGate must not have waited on devGate's held lock").toEqual(["dev-start", "qas-start"]);

    hold.resolve();
    await a;
    expect(order).toEqual(["dev-start", "qas-start", "dev-end"]);
  });

  it("two gates with the SAME scope on the SAME object URI DO serialise (contend on one lock file)", async () => {
    const stateDir = mkStateDir();
    const gateA = new FileLockObjectGate({ stateDir, waitMs: 300, scope: "DEV-SCOPE" });
    const gateB = new FileLockObjectGate({ stateDir, waitMs: 300, scope: "DEV-SCOPE" });

    const hold = deferred<void>();
    const a = gateA.run(URI, async () => {
      await hold.promise;
      return "a-done";
    });
    await waitUntil(
      () => existsSync(objectGateLockPath(stateDir, URI, "DEV-SCOPE")),
      "gateA to create the shared scoped lock file",
    );

    // gateB contends on the SAME lock file gateA is holding; a short waitMs
    // means it gives up with OBJECT_LOCKED_CROSS_PROCESS rather than hanging
    // — the same observable contention proof the sibling file's "rejects a
    // concurrent second gate instance" test uses, just with matching scopes.
    let bError: unknown;
    try {
      await gateB.run(URI, async () => "b-done");
    } catch (e) {
      bError = e;
    }
    expect(bError).toBeDefined();
    expect((bError as { code?: string }).code).toBe("OBJECT_LOCKED_CROSS_PROCESS");

    hold.resolve();
    await expect(a).resolves.toBe("a-done");
  });
});

// ---------------------------------------------------------------------------
// 4. AdtSessionPool: scope derivation from Config
// ---------------------------------------------------------------------------

describe("AdtSessionPool: scope derivation from Config, proven via the resulting lock file path", () => {
  function buildPool(cfg: Config, stateDir: string): AdtSessionPool {
    let pool!: AdtSessionPool;
    withEnv("ABAP_CROSS_PROCESS_OBJECT_LOCK", undefined, () => {
      withEnv("ABAP_STATE_DIR", stateDir, () => {
        pool = new AdtSessionPool({
          cfg,
          breaker: new AuthCircuitBreaker(),
          createConnection: fakeCreateConnection(),
        });
      });
    });
    return pool;
  }

  it("a FULL Config (sid+url+client all present) scopes the lock to systemKey({sid,url,client})", async () => {
    const stateDir = mkStateDir();
    const full = fakeConfig({ sid: "DEV", url: "http://dev.sap.invalid:50000", client: "100" });
    const expectedScope = systemKey({ sid: "DEV", url: "http://dev.sap.invalid:50000", client: "100" });
    const pool = buildPool(full, stateDir);

    const hold = deferred<void>();
    const w = pool.withWrite("w", URI, async () => {
      await hold.promise;
      return "done";
    });
    await waitUntil(
      () => existsSync(objectGateLockPath(stateDir, URI, expectedScope)),
      "pool.withWrite to create the scoped lock file for a full Config",
    );
    // The unscoped (pre-#93) path must NOT be the one in use — proves the
    // scope was actually threaded through, not merely that SOME lock file
    // exists.
    expect(existsSync(objectGateLockPath(stateDir, URI))).toBe(false);

    hold.resolve();
    await expect(w).resolves.toBe("done");
    pool.dispose();
  });

  it("a PARTIAL Config missing sid/url/client entirely passes NO scope (reproduces the pre-#93 path exactly)", async () => {
    const stateDir = mkStateDir();
    const partial = fakeConfig(); // no sid/url/client keys at all
    const pool = buildPool(partial, stateDir);

    const hold = deferred<void>();
    const w = pool.withWrite("w", URI, async () => {
      await hold.promise;
      return "done";
    });
    await waitUntil(
      () => existsSync(objectGateLockPath(stateDir, URI)),
      "pool.withWrite to create the UNSCOPED lock file for a partial Config",
    );

    hold.resolve();
    await expect(w).resolves.toBe("done");
    pool.dispose();
  });

  it("a Config with sid+url present but client=\"\" also passes NO scope (all three are required, not just present)", async () => {
    const stateDir = mkStateDir();
    const emptyClient = fakeConfig({ sid: "DEV", url: "http://dev.sap.invalid:50000", client: "" });
    const pool = buildPool(emptyClient, stateDir);

    const hold = deferred<void>();
    const w = pool.withWrite("w", URI, async () => {
      await hold.promise;
      return "done";
    });
    await waitUntil(
      () => existsSync(objectGateLockPath(stateDir, URI)),
      "pool.withWrite to create the UNSCOPED lock file when client is an empty string",
    );

    hold.resolve();
    await expect(w).resolves.toBe("done");
    pool.dispose();
  });
});
