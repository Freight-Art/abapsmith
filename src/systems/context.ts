/**
 * One system's whole slice of the server: everything `createServer` used to
 * build exactly once (pool, journal, safety gate, transport, debug deps,
 * static capabilities, the connect-on-first-use machinery) now built once
 * PER CONFIGURED SYSTEM. A single-system server is a `SystemRegistry`
 * (`./registry.js`) holding exactly one of these — see that file's doc
 * comment for why that is the whole story for single-system behaviour.
 *
 * This module owns construction only. Deciding WHICH context a given tool
 * call uses is `./route.js` (registration-time schema/dispatch) and
 * `./current.js` (the in-flight routing signal); this file never imports
 * either.
 */
import { AbapConnection, type ConnectionOptions } from "../adt/connection.js";
import { AuthCircuitBreaker } from "../adt/circuit-breaker.js";
import { AdtSessionPool, type SessionPool } from "../adt/pool.js";
import { SessionTransport, type SessionTrCreatedEvent } from "../adt/session-transport.js";
import { resolveStaticCapabilities, type Config } from "../config.js";
import { Journal, journalConfigFromEnv, systemKey } from "../journal.js";
import { SafetyGate } from "../safety.js";
import { createLiveDebugToolDeps, type DebugToolDeps } from "../tools/debug.js";
import type { SystemSpec } from "./spec.js";
// Type-only: `server.ts` imports this module at the value level (it calls
// `createSystemContext`), so importing `ServerOptions` any other way would
// make the two modules circularly dependent on each other's runtime values.
// A type-only import is erased before that would ever matter.
import type { ServerOptions } from "../server.js";

/**
 * Merge the pool's per-slot {@link ConnectionOptions} over a base options
 * object without letting an absent pool key erase a supplied one — e.g.
 * `log`, and every key the pool grows in future. See the git history for the
 * retired breaker-erasure bug this rule was originally written to prevent.
 *
 * Widened from the pre-#93 `(base: ServerOptions, over: ConnectionOptions)`
 * to accept a plain `ConnectionOptions` base and a `Partial` overlay: this is
 * now used twice per system — once to merge a system's base connection
 * options with `connectionOptionsFor(alias)`'s overrides (which may omit any
 * field, `breaker` included), and again inside the pool's own
 * `createConnection` closure to merge the pool's minimal `{ breaker }`
 * options over that result, exactly mirroring the single-system code this
 * replaces.
 */
function mergeConnectionOptions(
  base: ConnectionOptions,
  over: Partial<ConnectionOptions>,
): ConnectionOptions {
  const merged: ConnectionOptions = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value !== undefined) (merged as unknown as Record<string, unknown>)[key] = value;
  }
  return merged;
}

/**
 * The `SessionTransport.onCreated` handler: journals every transport request
 * abapsmith mints on its own initiative, since a created CTS request that
 * appears in no journal entry is exactly the failure the journal exists to
 * prevent — the number exists on the server either way; only the record is
 * optional. Lives here (not in the policy-free `session-transport.ts`)
 * because this is the only place holding both the manager and the `Journal`
 * for a given system; exported (and re-exported from `server.ts`) so it's
 * testable without a full MCP server (`test/session-transport-journal.test.ts`).
 *
 * Filed under the TRKORR with `trSource: "session-created"` to distinguish
 * "abapsmith caused this request to exist" from a resolution merely finding
 * one that was already there. `beforeCapture` stays `"unknown"` (never
 * `"confirmed-absent"`) since existence was inferred from server-minting,
 * not checked — see the git history for the full
 * reasoning and why that is currently inert (`undoBlocker` refuses all
 * `transport-*` entries).
 */
export function transportCreateJournalHook(deps: {
  journal: Journal;
  cfg: Pick<Config, "sid" | "url" | "client">;
  warn: (msg: string) => void;
}): (event: SessionTrCreatedEvent) => Promise<void> {
  const { journal, cfg, warn } = deps;
  return async (event) => {
    try {
      const entry = await journal.begin({
        operation: "transport-create",
        object: {
          name: event.trkorr,
          type: "CTS/TR",
          uri: `/sap/bc/adt/cts/transportrequests/${event.trkorr}`,
          package: event.devclass ?? "",
          description: event.description,
        },
        // The server minted this number: there was no request here before.
        existedBefore: false,
        systemKey: systemKey({ sid: cfg.sid, url: cfg.url, client: cfg.client }),
        corrNr: event.trkorr,
        trSource: event.source,
        tool: "abapsmith session transport (auto-created)",
      });
      // `undefined` ⇒ journal is off (ABAP_JOURNAL=off), not a failure.
      if (!entry) return;

      // Settling (not `finish()`) distinguishes "server confirmed this
      // request" from an entry left by a process that died mid-creation.
      const settled = await journal.settle(entry.id, { outcome: "succeeded" });
      if (!settled.settled) {
        warn(
          `[abapsmith] WARNING: transport request ${event.trkorr} was created and journalled as ` +
            `${entry.id}, but the entry could not be settled (${settled.reason}` +
            `${settled.error ? `: ${settled.error}` : ""}). It will read as \`pending\` — the ` +
            `request itself DOES exist on ${cfg.sid}.`,
        );
      }
    } catch (e) {
      // Never rethrown — the request already exists server-side; report loudly instead.
      warn(
        `[abapsmith] WARNING: transport request ${event.trkorr} WAS CREATED on ${cfg.sid} ` +
          `(package ${event.devclass ?? "unknown"}, for ${event.objSourceUrl}) but could NOT be ` +
          `journalled: ${(e as Error).message}. abapsmith has no record of it and abap_journal ` +
          `will not show it. Write ${event.trkorr} down now — it has to be released or deleted ` +
          `by hand.`,
      );
    }
  };
}

/** One configured system's whole slice of the server. */
export interface SystemContext {
  readonly alias: string;
  readonly isDefault: boolean;
  readonly cfg: Config;
  readonly pool: SessionPool;
  readonly safety: SafetyGate;
  readonly journal: Journal;
  readonly transport: SessionTransport;
  readonly debugDeps: DebugToolDeps;
  readonly capabilities: ReturnType<typeof resolveStaticCapabilities>;
  /**
   * The pinned slot-0 connection (`connect()`, `info()`, discovery). A LIVE
   * GETTER over `pool.primary()`, not a captured object — a cached reference
   * would keep reviving a retired connection past its lifetime logon-revival
   * ceiling. Read it at the point of use, same contract as
   * `AbapsmithServer.connection`.
   */
  readonly connection: AbapConnection;
  /** Lazy connect — the first tool call routed to this system pays for the logon, not server start. */
  ensureConnected(): Promise<void>;
  /** `pool.shutdown(reason)` then `pool.dispose()` — see `AbapsmithServer.stop()`'s ordering comment. */
  shutdown(reason: string): Promise<void>;
}

export interface SystemContextOptions {
  /** The `ServerOptions` `createServer` was called with — the shared base every system's connection options merge over. */
  readonly base: ServerOptions;
  /** Per-system connection option overrides, e.g. a distinct `httpClient` for tests. Absent field ⇒ inherit from `base`. */
  readonly connectionOptionsFor?: (alias: string) => Partial<ConnectionOptions> | undefined;
  readonly warn: (msg: string) => void;
  /**
   * Whether startup-probe warning lines should be prefixed with the system's
   * alias. `false` for a single-system server (today's exact wording);
   * `true` whenever more than one system is configured, including for the
   * default system — otherwise a DEV-vs-QAS warning printed with no alias
   * would be ambiguous about which system it's about.
   */
  readonly labelSystems: boolean;
}

/** Builds the whole per-system slice described by {@link SystemContext} for one {@link SystemSpec}. */
export function createSystemContext(spec: SystemSpec, opts: SystemContextOptions): SystemContext {
  const { alias, cfg, isDefault } = spec;
  const { base, warn } = opts;
  const overrides = opts.connectionOptionsFor?.(alias);

  // Default system keeps the composition root's breaker (the one visible
  // line src/index.ts owns); every additional system gets its own breaker
  // keyed by its own credentials, so an auth latch for QAS must never lock
  // out DEV.
  const breaker = overrides?.breaker ?? (isDefault ? base.breaker : AuthCircuitBreaker.forConfig(cfg));
  const connOpts: ConnectionOptions = mergeConnectionOptions(
    mergeConnectionOptions(base, overrides ?? {}),
    { breaker },
  );

  // Declared before the pool: `AdtSessionPool`'s constructor builds slot 0
  // eagerly/synchronously, so anything `createConnection` closes over must
  // already be initialised.
  /**
   * Builds exactly one connection eagerly (slot 0); every other slot mints
   * lazily on first lease, up to `maxSessions` — see `src/adt/pool.ts`.
   */
  const pool: SessionPool = new AdtSessionPool({
    cfg,
    // The pool sets `breaker` before building slot 0, so `mergeConnectionOptions`
    // below always sees the same instance on both sides.
    breaker,
    log: warn,
    createConnection: (poolCfg, poolOpts) =>
      new AbapConnection(poolCfg, mergeConnectionOptions(connOpts, poolOpts)),
    /**
     * No-op for the primary slot: `ensureConnected()` below remains slot 0's
     * sole connect path (it applies the safety-gate verdict and owns the
     * `onDead` revival memo) — preparing it here too would cost a logon just
     * for taking the slot. Non-primary slots have no such owner, so they
     * connect here. `isPrimary` comes from the pool as an argument rather
     * than `conn !== pool.primary()`, which was re-entrant and could skip
     * connecting the very slot being prepared — see
     * the git history.
     */
    prepareConnection: async (conn, _role, isPrimary) => {
      if (!isPrimary) await conn.connect();
    },
  });

  // `base.journal` is honoured ONLY for the default system (tests inject
  // it there); every other system gets its own `Journal`, built from
  // `spec.env` rather than `process.env` so a per-system ABAP_JOURNAL_*
  // override in that system's overlay is honoured instead of falling back
  // to the shared process environment.
  const journal =
    isDefault && base.journal !== undefined
      ? base.journal
      : new Journal(journalConfigFromEnv(spec.env, cfg.sid), cfg.sid);

  // Every optional field below fails CLOSED (denied) if omitted, per
  // `SafetyGate`'s own defaults — so skipping one never widens access, but
  // it silently strands the matching ABAP_ALLOW_* / ABAP_MODE setting as a
  // permanent no-op. `allowTransports`/`allowTransportRelease` are the one
  // exception: both are non-optional on `Config` (`ConfigSchema` defaults
  // them), so there is deliberately no fallback here — see
  // the git history for the historical bug (an omitted
  // `allowTransports` silently re-widened an explicit deny-all).
  // Bound after `transport` is constructed below — the gate is built before
  // the resolver exists, so this hook reads the registry late via closure.
  let transportRef: SessionTransport | undefined;
  const safety = new SafetyGate(
    {
      readOnly: cfg.readOnly,
      allowPackages: cfg.allowPackages,
      allowNamePrefixes: cfg.allowNamePrefixes,
      allowTransports: cfg.allowTransports,
      allowTransportRelease: cfg.allowTransportRelease,
      allowTransportDelete: cfg.allowTransportDelete,
      allowCascadeDelete: cfg.allowCascadeDelete,
      allowServicePublish: cfg.allowServicePublish,
      allowEnhancements: cfg.allowEnhancements,
      enhanceTargets: cfg.enhanceTargets,
      enhanceTargetPackages: cfg.enhanceTargetPackages,
      originSystems: cfg.originSystems,
      // This system's own SID, so the origin gate (SafetyGate.isLocalOrigin)
      // recognises this system's own content as local without needing it
      // repeated via ABAP_ORIGIN_SYSTEMS.
      sid: cfg.sid,
      // Operator additions to the frozen data-preview deny-list.
      dataPreviewDenyTables: cfg.dataPreviewDenyTables,
      // Tier-2 dump reads; registration-time counterpart is
      // `capabilities.canReadDumpVariables` below (both read
      // `cfg.allowDumpVariables`, deliberately not `readOnly`).
      allowDumpVariables: cfg.allowDumpVariables,
      // Not a capability — records WHICH MECHANISM decided every field above,
      // so a refusal names the actual input rather than guessing legacy flags.
      abapMode: cfg.abapMode,
    },
    { sessionCreatedRequests: () => transportRef?.sessionCreatedRequests() ?? [] },
  );

  // Registration-time tool filtering, computed once (not per-request) from
  // `Config` fields `SafetyGate.update()` never mutates — additive to, not a
  // replacement for, the runtime checks `safety` performs per call. See
  // `resolveStaticCapabilities`'s doc comment in src/config.ts.
  const capabilities = resolveStaticCapabilities(cfg);

  const transport = new SessionTransport({
    allowTransports: cfg.allowTransports,
    whoami: () => cfg.user,
    onCreated: transportCreateJournalHook({ journal, cfg, warn }),
    // Mints the `AuthorizedTarget` `trCreate` requires. Mirrors `opCreate`
    // (src/tools/transport.ts): the auto-created package is passed as both
    // `name` and `packageName`, so ABAP_ALLOW_NAME_PREFIXES also judges it.
    authorizeCreate: (devClass) =>
      safety.authorize(
        "transport",
        { name: devClass, packageName: devClass },
        { corr: { kind: "unresolved" } },
      ),
  });
  transportRef = transport;

  // Hands the debugger the pool's one debug lease (`DEBUG_CONCURRENCY = 1`),
  // held for the whole session and released at terminate — this is what
  // makes an ordinary read/write refuse `lease-held` instead of blocking on
  // a parked debug long poll. Exclusive, not queued: a second concurrent
  // debug session is refused. The pool also mints the debugger's trigger
  // connection, so it shares this system's breaker (pool law L3) by
  // construction.
  const debugDeps = createLiveDebugToolDeps({
    cfg,
    pool,
    log: warn,
    gate: safety,
  });

  /** Lazy connect — the first tool call routed to this system pays for the logon, not server start. */
  let connectPromise: Promise<unknown> | undefined;
  // A session dying mid-life (idle ~32min -> HTTP 400 ICMENOSESSION) used to
  // leave `connectPromise` resolved forever, wedging every later request
  // until process restart — see the git history. Dropping
  // the memo on `onDead` is what lets the next `ensureConnected()` log on
  // again; pinned by test/server-session-revival.test.ts.
  //
  // Follows the primary rather than being taken once: the pool re-mints slot
  // 0 on retirement, and a memo built for the retired object must never be
  // awaited on behalf of its replacement — `watchPrimary` re-arms on
  // identity change and drops the stale memo in the same step.
  let watched: AbapConnection | undefined;
  const watchPrimary = (conn: AbapConnection): void => {
    if (watched === conn) return;
    watched = conn;
    connectPromise = undefined;
    conn.onDead(() => {
      if (watched === conn) connectPromise = undefined;
    });
  };
  watchPrimary(pool.primary());
  // Prefix warning lines with the alias whenever more than one system is
  // configured (or this isn't the only one) — otherwise a DEV-vs-QAS warning
  // printed with no alias is ambiguous about which system it's about. A
  // single-system server (`labelSystems: false`) keeps today's exact wording.
  const label = opts.labelSystems ? `${alias}: ` : "";
  const ensureConnected = async (): Promise<void> => {
    const connection = pool.primary();
    watchPrimary(connection);
    if (connection.isConnected) return;
    // An explicit re-arm must not be blocked by the memoised auth rejection —
    // exactly one attempt is allowed to reach the wire again.
    if (connectPromise && connection.breaker.authProbeArmed) connectPromise = undefined;
    connectPromise ??= connection.connect().then(
      (info) => {
        // T000 probe is the authority; this only transcribes its verdict.
        // `writesLockedOut` covers both "productive" and "unprovable" and is
        // NOT overridable by ABAP_ALLOW_WRITE — see `SafetyConfig.writesLockedOut`.
        safety.update({
          productive: info.roleDetection.role === "productive",
          systemRole: info.systemRole,
          writesLockedOut: info.writesLockedOut,
          lockoutReason: info.roleDetection.reason,
          roleProbeFailure: info.roleDetection.probeFailure,
        });
        // Only worth a stderr line when what the operator asked for and what
        // they got differ.
        if (info.writesLockedOut && !cfg.readOnly) {
          warn(
            `[abapsmith] ${label}WARNING: writes are enabled by configuration (${
              cfg.abapMode !== undefined ? `ABAP_MODE=${cfg.abapMode}` : "ABAP_ALLOW_WRITE=true"
            }), but they are REFUSED on this ` +
              `system: ${info.roleDetection.reason} ` +
              `(role=${info.roleDetection.role}, client=${info.roleDetection.client ?? "unknown"}, ` +
              `T000-CCCATEGORY=${info.roleDetection.ccCategory ?? "unknown"}). ` +
              "This is fail-closed by design and there is no override — a system that cannot " +
              "be PROVEN non-productive is treated exactly like a productive one.",
          );
        } else if (!info.writesLockedOut && !cfg.readOnly) {
          warn(
            `[abapsmith] ${label}writes are LIVE — ${cfg.sid} proven non-productive ` +
              `(client ${info.roleDetection.client ?? "?"}, T000-CCCATEGORY=` +
              `${info.roleDetection.ccCategory ?? "?"}).`,
          );
        }
        return info;
      },
      (e) => {
        // Only the permanent auth latch keeps this rejection cached forever —
        // retrying burns logon attempts and can lock the SAP user. Transient
        // states clear so the breaker's own cooldown/probe cycle can recover.
        // Do NOT widen this back to `isTripped`.
        const authLatched = connection.breaker.state === "latched";
        if (!authLatched) connectPromise = undefined;
        throw e;
      },
    );
    await connectPromise;
  };

  return {
    alias,
    isDefault,
    cfg,
    pool,
    safety,
    journal,
    transport,
    debugDeps,
    capabilities,
    get connection() {
      return pool.primary();
    },
    ensureConnected,
    async shutdown(reason: string): Promise<void> {
      await pool.shutdown(reason);
      pool.dispose();
    },
  };
}
