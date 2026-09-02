/**
 * MCP server wiring. Schema size is a first-class constraint (~13 tools,
 * ~4k schema): writes use a `mode` discriminator instead of narrow tools,
 * and discovery info lives behind a resource (no schema cost).
 *
 * The safety gate is asserted before `ensureConnected()` (a network call)
 * runs, using only args decidable pre-flight; each tool re-asserts once
 * the object's real package is known.
 */
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { AbapConnection, type ConnectionOptions } from "./adt/connection.js";
import { AbapError, describeUnknownError, isAbapError } from "./adt/errors.js";
import { AdtSessionPool, type SessionPool } from "./adt/pool.js";
import { SessionTransport, type SessionTrCreatedEvent } from "./adt/session-transport.js";
import { stripUrlCredentials, resolveStaticCapabilities, type Config } from "./config.js";
import { shutdownAllDebugSessions } from "./debug/session.js";
import { Journal, journalConfigFromEnv, systemKey } from "./journal.js";
import { SafetyGate } from "./safety.js";
import type { AbapMode } from "./mode.js";
// One import per tool-feature module; each is a `registerXTools(mcp, deps)`
// registrar (see REGISTRATION in `createServer`). `createLiveDebugToolDeps`/
// `shutdownDebugTools` are lifecycle, not registration — the debugger's pool
// lease is built before the tools exist and torn down in `stop()`.
import { registerActivateTools } from "./tools/activate.js";
import { createLiveDebugToolDeps, shutdownDebugTools } from "./tools/debug.js";
import { registerDebugTools } from "./tools/debug-register.js";
import { registerJournalTools } from "./tools/journal.js";
import { registerOpenUrlTools } from "./tools/open-url.js";
import { registerReadTools } from "./tools/read.js";
import { registerRunTools } from "./tools/run.js";
import { registerTestTools } from "./tools/test.js";
import { registerSearchTools } from "./tools/search.js";
import { registerWriteTools } from "./tools/write.js";
import { registerTransportTools } from "./tools/transport.js";
import { registerBopfTools } from "./tools/bopf.js";
import { registerBopfTestTool, createBopfTestDeps } from "./tools/bopf-test.js";
import { registerFpmTools } from "./tools/fpm.js";
import { registerUiTools } from "./tools/ui.js";
import { registerEnhancementTools } from "./tools/enh.js";
import { registerDataPreviewTools } from "./tools/data-preview.js";
import { registerDumpTools } from "./tools/dumps.js";
import { registerAtcTools } from "./tools/atc.js";
import { registerServiceTools } from "./tools/service.js";
// The six v2 consolidated tools, opt-in via `cfg.toolSurface` (see REGISTRATION below).
import { registerV2Tools } from "./tools/v2/register.js";

export const SERVER_NAME = "abapsmith";
export const SERVER_VERSION = "0.3.0";

export interface ServerOptions extends ConnectionOptions {
  /** Injectable for tests; defaults to `journalConfigFromEnv()`. */
  journal?: Journal;
}

export interface AbapsmithServer {
  mcp: McpServer;
  /**
   * The pool every tool handler leases its session from. Starts with one
   * connection (`connection` below, built eagerly), grows lazily up to
   * `maxSessions` (5 by default) as concurrent leases are taken — see
   * `src/adt/pool.ts`.
   */
  pool: SessionPool;
  /**
   * The pinned slot-0 connection (`connect()`, `info()`, discovery; the
   * surface `src/index.ts` subscribes to shutdown on). A LIVE GETTER over
   * `pool.primary()`, not a captured object — a cached reference would keep
   * reviving a retired connection past its lifetime logon-revival ceiling.
   * Read it at the point of use.
   */
  readonly connection: AbapConnection;
  safety: SafetyGate;
  journal: Journal;
  start(): Promise<void>;
  stop(): Promise<void>;
}

// ADT-error → MCP-payload translation lives in `src/tool-errors.ts`;
// re-exported here since every caller already imports this file.
import { buildErrorPayload, errorResult } from "./tool-errors.js";
export { buildErrorPayload, errorResult };

/**
 * The `SessionTransport.onCreated` handler: journals every transport request
 * abapsmith mints on its own initiative, since a created CTS request that
 * appears in no journal entry is exactly the failure the journal exists to
 * prevent — the number exists on the server either way; only the record is
 * optional. Lives here (not in the policy-free `session-transport.ts`)
 * because this composition root is the only place holding both the manager
 * and the `Journal`; exported so it's testable without a full MCP server
 * (`test/session-transport-journal.test.ts`).
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

/**
 * Merge the pool's per-slot {@link ConnectionOptions} over the caller's
 * {@link ServerOptions} without letting an absent pool key erase a supplied
 * one — e.g. `log`, and every key the pool grows in future. See
 * the git history for the retired breaker-erasure bug
 * this rule was originally written to prevent.
 */
function mergeConnectionOptions(base: ServerOptions, over: ConnectionOptions): ConnectionOptions {
  const merged: ConnectionOptions = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value !== undefined) (merged as unknown as Record<string, unknown>)[key] = value;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Drop the per-tool `$schema` key
// ---------------------------------------------------------------------------
// The SDK's `tools/list` handler runs `zod-to-json-schema` per tool, which
// stamps the same `$schema` URI onto every result (18x, ~35 bytes apiece) —
// no client reads it, and the SDK has no suppression flag. Filtering at the
// wire (`Transport.send`, wrapped below) avoids reimplementing/duplicating
// the SDK's internal conversion, and catches it for any transport
// (production stdio or the test harness's in-memory one).
function stripRedundantSchemaKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripRedundantSchemaKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (key === "$schema") continue;
      out[key] = stripRedundantSchemaKeys(v);
    }
    return out;
  }
  return value;
}

function isListToolsResult(
  message: JSONRPCMessage,
): message is JSONRPCMessage & { result: { tools: unknown[] } } {
  const result = (message as { result?: unknown }).result;
  return (
    typeof result === "object" &&
    result !== null &&
    Array.isArray((result as { tools?: unknown }).tools)
  );
}

/** Wraps `mcp.connect` so every transport it is later handed has its `send`
 * filtered through `stripRedundantSchemaKeys` for `tools/list` responses
 * only — every other message (tool calls, resources, notifications) passes
 * through completely unchanged. */
function stripSchemaKeyOnConnect(mcp: McpServer): void {
  const rawConnect = mcp.connect.bind(mcp);
  mcp.connect = (async (transport: Transport) => {
    const rawSend = transport.send.bind(transport);
    transport.send = ((message: JSONRPCMessage, options?: TransportSendOptions) =>
      rawSend(
        isListToolsResult(message) ? (stripRedundantSchemaKeys(message) as JSONRPCMessage) : message,
        options,
      )) as Transport["send"];
    return rawConnect(transport);
  }) as typeof mcp.connect;
}

/**
 * The write-scope sentence `instructionsFor` embeds in both branches — the
 * whole point: rendered from the resolved config, not asserted as a
 * constant. `readOnly` is checked FIRST: in `read` mode
 * `READ_CAPABILITIES.allowPackages` (src/mode.ts) is `[]`, and a naive
 * length check would then claim the ALLOWLIST refuses every write when it is
 * the MODE doing the refusing.
 */
function packageScopeSentence(readOnly: boolean, allowPackages: readonly string[]): string {
  if (readOnly) {
    return "ABAP_ALLOW_PACKAGES unset allows every customer package, a list allows only those, and an empty value refuses every write.";
  }
  if (allowPackages.length === 0) {
    return "ABAP_ALLOW_PACKAGES is empty here, so every write is refused; a list allows only those packages, and unset allows every customer package.";
  }
  if (allowPackages.includes("*")) {
    return "ABAP_ALLOW_PACKAGES resolves to `*` here (its default when unset), so every customer package is writable; a list allows only those, and an empty value refuses every write.";
  }
  return (
    `ABAP_ALLOW_PACKAGES is [${allowPackages.join(", ")}] here, so only those packages are ` +
    "writable; unset allows every customer package, and an empty value refuses every write."
  );
}

/**
 * `McpServer`'s `instructions` field is free-form prose a client may show
 * up front, before any `tools/list` call — it is NOT derived from the live
 * tool registry, so it must be kept in sync with `ABAP_TOOL_SURFACE` by
 * hand. (Previously a single hardcoded v1-only paragraph, wrong under v2 —
 * same "skills vs. shipped surface" defect class as
 * `test/skills-tool-surface.test.ts` guards against.) `toolSurface` has no
 * third `both` value, so the two-way branch is exhaustive. The write-scope
 * clause, though, is no longer hand-synced: it is rendered from the resolved
 * `readOnly`/`allowPackages` config by {@link packageScopeSentence},
 * so it cannot drift from `EDIT_PACKAGE_DEFAULT` the way the old hardcoded
 * "default $TMP" claim did. Exported so
 * `test/server-instructions-write-scope.test.ts` can exercise both branches
 * directly.
 */
export function instructionsFor(
  toolSurface: Config["toolSurface"],
  abapMode: AbapMode | undefined,
  readOnly: boolean,
  allowPackages: readonly string[],
): string {
  // Under ABAP_MODE, ABAP_ALLOW_WRITE is never read; say what actually governs.
  const writeGate =
    abapMode !== undefined ? `unless ABAP_MODE is edit or admin (it is ${abapMode})` : "unless the operator set ABAP_ALLOW_WRITE";
  const packageScope = packageScopeSentence(readOnly, allowPackages);
  if (toolSurface === "v2") {
    // `instructions` is read once per session, not resent per `tools/list`
    // like each tool's `description` — so the experimental warning belongs
    // here, outside the schema-byte budget test/tools-v2-budget.test.ts measures.
    return (
      "Access to an SAP ABAP system over ADT, via 6 tools. EXPERIMENTAL SURFACE — not " +
      "supported for production use; known defects are not being fixed while it holds " +
      "this status. Prefer the v1 surface for anything that matters. Use abap_find to locate " +
      "objects, abap_read to read source or DDIC definitions (outline=true first for " +
      "large classes, then method=), abap_write to create/change/delete (edit= splices a " +
      "unique match, method= replaces one method, source= is a full rewrite, " +
      "mode=\"delete\" removes), abap_do for everything else — activation/check, " +
      "run/test, the local write journal and undo, transports, BOPF, and BAdI/enhancement " +
      "actions (call abap_do({}) with no action for the live catalogue of what's unlocked " +
      "at the current ABAP_MODE), and abap_debug to set breakpoints and step through " +
      "execution with full variable inspection (action=start/step/stack/vars/value/" +
      `keepalive/stop/status). Writes are OFF ${writeGate}, and need a customer-namespace ` +
      `object name plus a package the allowlist permits: ${packageScope} Every write is ` +
      "journalled with its previous source locally first, so " +
      "abap_do({action:\"undo\"}) can put it back — but only for objects this server " +
      "wrote. Responses are capped and truncation is always marked."
    );
  }
  return (
    "Access to an SAP ABAP system over ADT. Use abap_search to locate objects, " +
    "abap_read to read source or DDIC definitions (outline=true first for large " +
    "classes, then method=), abap_write to create/change/delete, abap_activate to " +
    "syntax-check or activate, abap_run to execute a class or report and capture " +
    "its output, abap_test to run ABAP Unit tests (it reports NO TESTS RAN separately " +
    "from PASSED — they are not the same answer), " +
    "abap_debug/abap_debug_vars/abap_debug_value to set breakpoints and " +
    "step through execution with full variable inspection, abap_journal to see what " +
    "you changed and undo it. Writes are OFF " +
    `${writeGate}, and need a customer-namespace object name plus a package the ` +
    `allowlist permits: ${packageScope} Every write records the ` +
    "previous source locally first, so abap_journal mode=undo can put it back — but " +
    "only for objects this server wrote. Responses are capped and truncation is " +
    "always marked."
  );
}

/**
 * Reduces whatever the startup probe's `ensureConnected()` rejects with
 * (`start()` below) to a displayable `{ code, message, hint }`.
 * Exported so `test/server-startup-probe.test.ts` can exercise the non-
 * `AbapError` fallback branch directly — the real ADT stack always throws
 * an `AbapError`, so that branch is unreachable except in a direct test;
 * kept as defence in depth since the probe must never throw out of `start()`.
 */
export function describeStartupProbeFailure(e: unknown): {
  code: string;
  message: string;
  hint?: string;
} {
  if (isAbapError(e)) return { code: e.code, message: e.message, hint: e.hint };
  return { code: "UNKNOWN", message: describeUnknownError(e) };
}

/**
 * `opts` IS REQUIRED, because `ServerOptions extends ConnectionOptions` and
 * `ConnectionOptions.breaker` is required. That is not incidental: this
 * function is the composition root for every connection the process builds, so
 * the process-wide breaker has to enter the system HERE, visibly, in one line
 * the reader can point at. See `src/index.ts` for that line.
 */
export function createServer(cfg: Config, opts: ServerOptions): AbapsmithServer {
  // Declared before the pool: `AdtSessionPool`'s constructor builds slot 0
  // eagerly/synchronously, so anything `createConnection` closes over must
  // already be initialised.
  const warn = opts.log ?? ((m: string) => process.stderr.write(m + "\n"));
  /**
   * Builds exactly one connection eagerly (slot 0); every other slot mints
   * lazily on first lease, up to `maxSessions` — see `src/adt/pool.ts`.
   */
  const pool: SessionPool = new AdtSessionPool({
    cfg,
    // The pool sets `breaker` before building slot 0, so `mergeConnectionOptions`
    // below always sees the same instance on both sides.
    breaker: opts.breaker,
    log: warn,
    createConnection: (poolCfg, poolOpts) =>
      new AbapConnection(poolCfg, mergeConnectionOptions(opts, poolOpts)),
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
  const journal =
    opts.journal ?? new Journal(journalConfigFromEnv(process.env, cfg.sid), cfg.sid);
  // Every optional field below fails CLOSED (denied) if omitted, per
  // `SafetyGate`'s own defaults — so skipping one never widens access, but
  // it silently strands the matching ABAP_ALLOW_* / ABAP_MODE setting as a
  // permanent no-op. `allowTransports`/`allowTransportRelease` are the one
  // exception: both are non-optional on `Config` (`ConfigSchema` defaults
  // them), so there is deliberately no fallback here — see
  // the git history for the historical bug (an omitted
  // `allowTransports` silently re-widened an explicit deny-all).
  const safety = new SafetyGate({
    readOnly: cfg.readOnly,
    allowPackages: cfg.allowPackages,
    allowNamePrefixes: cfg.allowNamePrefixes,
    allowTransports: cfg.allowTransports,
    allowTransportRelease: cfg.allowTransportRelease,
    allowTransportDelete: cfg.allowTransportDelete,
    allowCascadeDelete: cfg.allowCascadeDelete,
    allowEnhancements: cfg.allowEnhancements,
    enhanceTargets: cfg.enhanceTargets,
    enhanceTargetPackages: cfg.enhanceTargetPackages,
    originSystems: cfg.originSystems,
    // This server's own SID, so the origin gate (SafetyGate.isLocalOrigin)
    // recognises this system's own content as local without needing it
    // repeated via ABAP_ORIGIN_SYSTEMS.
    sid: cfg.sid,
    // Operator additions to the frozen data-preview deny-list.
    dataPreviewDenyTables: cfg.dataPreviewDenyTables,
    // Tier-2 dump reads; registration-time counterpart is
    // `toolCapabilities.canReadDumpVariables` below (both read
    // `cfg.allowDumpVariables`, deliberately not `readOnly`).
    allowDumpVariables: cfg.allowDumpVariables,
    // Not a capability — records WHICH MECHANISM decided every field above,
    // so a refusal names the actual input rather than guessing legacy flags.
    abapMode: cfg.abapMode,
  });
  // Registration-time tool filtering, computed once (not per-request) from
  // `Config` fields `SafetyGate.update()` never mutates — additive to, not a
  // replacement for, the runtime checks `safety` performs per call. See
  // `resolveStaticCapabilities`'s doc comment in src/config.ts.
  const toolCapabilities = resolveStaticCapabilities(cfg);
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
  // Hands the debugger the pool's one debug lease (`DEBUG_CONCURRENCY = 1`),
  // held for the whole session and released at terminate — this is what
  // makes an ordinary read/write refuse `lease-held` instead of blocking on
  // a parked debug long poll. Exclusive, not queued: a second concurrent
  // debug session is refused. The pool also mints the debugger's trigger
  // connection, so it shares the process-wide breaker (pool law L3) by
  // construction.
  const debugDeps = createLiveDebugToolDeps({
    cfg,
    pool,
    log: warn,
    gate: safety,
  });

  const mcp = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: instructionsFor(cfg.toolSurface, cfg.abapMode, cfg.readOnly, cfg.allowPackages) },
  );
  // Fallback session id — minted once here, not inside `oninitialized`,
  // so a second `initialize` on the same process (there is no such thing over
  // stdio, but nothing here depends on that) would still reuse it rather than
  // mint a new one. See the `oninitialized` comment below for when it's used.
  const processSessionId = randomUUID();
  // `journal` is built above, before `mcp.connect()` runs, so `getClientVersion()`
  // is unset at that point — the initialize handshake hasn't happened yet.
  // `oninitialized` fires once it has, handing the journal a client identity
  // for every entry `begin()` writes from here on (see `Journal.resolveActor()`).
  mcp.server.oninitialized = () => {
    journal.setClientActor(mcp.server.getClientVersion()?.name);
    // "Which conversation", distinct from "who" above. `Transport`
    // declares `sessionId?: string` (SDK shared/transport.d.ts) but
    // `StdioServerTransport` — the only transport `start()` below ever
    // constructs — never assigns it, so this is a defensive read of a
    // documented field, not something observed to fire. Fall back to a
    // value generated once for this process: for stdio, one process IS one
    // client connection, so it genuinely identifies "this conversation".
    const transportSessionId = mcp.server.transport?.sessionId;
    journal.setClientSession(transportSessionId ?? processSessionId, transportSessionId ? "transport" : "process");
  };

  /** Lazy connect — the first tool call pays for the logon, not server start. */
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
  const ensureConnected = async (): Promise<void> => {
    const connection = pool.primary();
    watchPrimary(connection);
    if (connection.isConnected) return;
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
            `[abapsmith] WARNING: writes are enabled by configuration (${
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
            `[abapsmith] writes are LIVE — ${cfg.sid} proven non-productive ` +
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

  // REGISTRATION — gated by `cfg.toolSurface` (ABAP_TOOL_SURFACE, default
  // "v1"). Exactly one branch runs — v2's `abap_read`/`abap_write`/
  // `abap_debug` reuse v1 tool names verbatim, so registering both would
  // throw "Tool abap_read is already registered" (no `"both"` value; see
  // `toolSurface`'s doc comment in src/config.ts).
  if (cfg.toolSurface === "v1") {
    // `journal` is required on `TransportToolDeps` — it was once optional
    // and silently omitted, disabling every transport journal entry (see
    // the git history); now a compile error instead of a
    // silent no-op, pinned by test/session-transport-journal.test.ts.
    registerTransportTools(mcp, {
      // The pool, not the connection: transport ops have no single ABAP
      // object to gate on (a TRKORR isn't a repository object).
      pool,
      cfg,
      safety,
      ensureConnected,
      errorResult,
      journal,
      warn,
      // Same manager that adopts requests knows which of them this session
      // created — `abap_transport show` and the release gate read the
      // record `transport`'s resolver writes.
      ownership: transport,
      // `abap_transport`'s list/show/check/users submodes are ungated and
      // always registered; only `abap_transport_release` is gated.
      registerRelease: toolCapabilities.canReleaseTransport,
    });

    // BOPF tools gate on the BO name via `bopfGateKey` (tools/bopf.ts).
    // `abap_bopf` is a pure read, always registered; only
    // `abap_bopf_edit`/`abap_bopf_delete` are gated. `journal` required —
    // same reason as `TransportToolDeps` above (BOPF journalling was added
    // under the same fix).
    registerBopfTools(mcp, {
      pool,
      cfg,
      safety,
      ensureConnected,
      errorResult,
      transport,
      journal,
      registerWrite: toolCapabilities.canWrite,
    });
    // abap_enh registers unconditionally: `discover_hook_anchors` makes no
    // `SafetyGate` call at all (a genuinely ungated read), so gating the
    // whole tool would hide that read on a read-only server. Every other
    // submode is gated via `assertIntent` at point of use. `journal`
    // required — enhancement description writes are journalled
    // (irreversible: history, never undo).
    registerEnhancementTools(mcp, {
      pool,
      cfg,
      safety,
      ensureConnected,
      errorResult,
      transport,
      journal,
    });

    // Core repository tools: one module per feature, one `registerXTools`
    // call, nothing about schema/handler visible here. Every group takes
    // `pool, cfg, safety, ensureConnected, errorResult` plus only the extra
    // collaborators it uses.
    registerReadTools(mcp, { pool, cfg, safety, ensureConnected, errorResult });
    registerSearchTools(mcp, { pool, cfg, safety, ensureConnected, errorResult });
    registerOpenUrlTools(mcp, { pool, cfg, safety, ensureConnected, errorResult });
    // `abap_write`/`abap_fpm_read`/`abap_run`/`abap_test`/`abap_bopf_test`
    // have no ungated submode, so registration itself is skipped when
    // `!toolCapabilities.canWrite`. `abap_activate` (mode=check is a genuine
    // ungated read) stays unconditional, below.
    if (toolCapabilities.canWrite) {
      registerBopfTestTool(mcp, { ...createBopfTestDeps(), pool, cfg, safety, ensureConnected, errorResult });
      registerFpmTools(mcp, { pool, cfg, safety, ensureConnected, errorResult });
      // `abap_ui`'s `screen` mode deploys a throwaway $TMP bridge class, so
      // it needs write capability just to register. `press` (committing) is
      // gated far more tightly at call time — `assertPressEnabled` in
      // src/tools/ui.ts requires ABAP_MODE=admin AND ABAP_ALLOW_UI_PRESS.
      // `journal` required: `press`'s blast radius is business data, not
      // repository objects.
      registerUiTools(mcp, { pool, cfg, safety, ensureConnected, errorResult, journal });
      // `journal` for the before-image, `transport` for the CTS assignment.
      registerWriteTools(mcp, { pool, cfg, safety, ensureConnected, errorResult, journal, transport });
      registerRunTools(mcp, { pool, cfg, safety, ensureConnected, errorResult });
      registerTestTools(mcp, { pool, cfg, safety, ensureConnected, errorResult });
      // `abap_atc`: inside `canWrite`, not beside `abap_dumps` — a run
      // creates a persistent ATC worklist row (no delete in ADT's client
      // surface) and `execute` carries the Z/Y-prefix + package-allowlist
      // rules, so gating it any weaker risks unbounded server-side checks
      // against SAP-standard packages. See src/adt/atc.ts.
      registerAtcTools(mcp, { pool, cfg, safety, ensureConnected, errorResult });
    }
    // `journal` required on `ActivateToolDeps` — it was previously missing,
    // and `abap_activate` (up to 50 objects/call) changed executing
    // code with nothing recorded to disk. Unconditional (outside `canWrite`)
    // since `mode=check` is a genuine ungated read; journal only writes on
    // `mode=activate`.
    registerActivateTools(mcp, { pool, cfg, safety, ensureConnected, errorResult, transport, journal });
    registerJournalTools(mcp, { pool, cfg, safety, ensureConnected, errorResult, journal });
    registerDebugTools(mcp, { pool, cfg, safety, ensureConnected, errorResult, debugDeps });
    // `abap_data_preview`: skipped outright (not registered-and-refusing) so
    // it costs no schema bytes when ABAP_ALLOW_DATA_PREVIEW is off. Not
    // inside `canWrite` — a preview is a read. v1 only; v2 gates by
    // `minMode` alone with no capability filter.
    if (toolCapabilities.canPreviewData) {
      registerDataPreviewTools(mcp, { pool, cfg, safety, ensureConnected, errorResult });
    }
    // `abap_dumps`: registered unconditionally — tier 1 (list, one dump's
    // header/source/system-fields/call-stack) is a genuine ungated read.
    // `registerVariables` controls only whether the `variables` field (tier
    // 2, live field values) is ADVERTISED in the schema; the handler still
    // calls `safety.assertDumpVariables()` on every request regardless of
    // route. Deliberately not derived from `canWrite` (see
    // `resolveStaticCapabilities`) — keying production-data access off
    // write capability would give read-only production the widest access.
    registerDumpTools(mcp, {
      pool,
      cfg,
      safety,
      ensureConnected,
      errorResult,
      registerVariables: toolCapabilities.canReadDumpVariables,
    });
    // `abap_service` (OData $metadata): unconditional, not inside `canWrite`
    // like `abap_atc` — three GETs, nothing created server-side. No
    // `safety` — `read` is outside `MUTATING_OPS` and always allowed.
    registerServiceTools(mcp, { pool, cfg, ensureConnected, errorResult });
  } else {
    // The six v2 consolidated tools. `abapMode` falls back to the same
    // fail-closed `"read"` `bin/abap-guard` applies to a missing/
    // unrecognized ABAP_MODE, when on legacy per-flag config
    // (`cfg.abapMode` unset) — only shapes which action names/descriptions
    // are listed, per `loadConfig`'s NOTE in src/config.ts.
    const v2Mode: AbapMode = cfg.abapMode ?? "read";
    // Same objects the v1 branch builds, reused not reconstructed.
    // `V2ToolDeps` (src/tools/v2/runtime.ts) is the union of every v1
    // registrar's dep bag, grown once for future v2 work.
    registerV2Tools(mcp, {
      pool,
      safety,
      ensureConnected,
      errorResult,
      journal,
      transport,
      debugDeps,
      warn,
      cfg: {
        abapMode: v2Mode,
        maxResponseChars: cfg.maxResponseChars,
        allowEnhancements: cfg.allowEnhancements,
        allowSourcePlugins: cfg.allowSourcePlugins,
        allowEnhancementDelete: cfg.allowEnhancementDelete,
        user: cfg.user,
        verifyWrites: cfg.verifyWrites,
      },
    });
  }

  // Objects referenceable without a tool call, and the discovery probe
  // exposed without spending tool-schema budget.
  mcp.registerResource(
    "system",
    `abap://${cfg.sid}/system`,
    {
      title: `ABAP system ${cfg.sid}`,
      description: "Connection state, system role, and the ADT feature inventory from /discovery.",
      mimeType: "application/json",
    },
    async (uri) => {
      await ensureConnected();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              {
                connection: pool.primary().info(),
                discovery: pool.primary().discovery.summary(),
                // Live occupancy at the instant of the read — `stats()` is
                // synchronous, no pool lease, safe to read mid-incident even while
                // saturated. `limits` are the denominators busy/idle are out of;
                // without them `busy: 5` alone doesn't say whether that's fine.
                sessions: {
                  ...pool.stats(),
                  limits: {
                    maxSessions: cfg.maxSessions,
                    readConcurrency: cfg.readConcurrency,
                    writeConcurrency: cfg.writeConcurrency,
                  },
                },
                safety: {
                  ...safety.config,
                  writesEnabled: !safety.config.readOnly,
                  allowPackages: safety.config.allowPackages,
                  allowNamePrefixes: safety.namePrefixes,
                  allowTransports: safety.transportAllowlist,
                },
                journal: {
                  enabled: journal.enabled,
                  dir: journal.enabled ? journal.dir : null,
                  retention: `${journal.config.maxEntries} entries / ${journal.config.maxAgeDays} days`,
                },
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // Every tool above is registered by this point, so the SDK's `tools/list`
  // handler already exists — wrap its transport now (see the comment on
  // `stripSchemaKeyOnConnect` above `createServer`).
  stripSchemaKeyOnConnect(mcp);

  return {
    mcp,
    pool,
    // A getter, not a snapshot: see the contract on `AbapsmithServer.connection`.
    get connection() {
      return pool.primary();
    },
    safety,
    journal,
    async start() {
      const transport = new StdioServerTransport();
      await mcp.connect(transport);
      const mode = cfg.readOnly
        ? "read-only"
        : `WRITES ENABLED → packages [${cfg.allowPackages.join(", ")}]`;
      // Startup probe — previously `ready on stdio` printed
      // unconditionally, so a bad ABAP_URL/VPN/client only surfaced inside
      // an agent's transcript on the first tool call, misread as agent
      // confusion. Reuses `ensureConnected()`, the same lazy-connect path
      // every tool call takes, so success costs no double logon. Never
      // throws — a probe failure must not block startup, since the next
      // tool call retries via the same lazy path. Suppressible via
      // ABAP_STARTUP_PROBE=false — see doc/CONFIGURATION/connection.md.
      let notConnectedSuffix = "";
      if (cfg.startupProbe) {
        try {
          await ensureConnected();
          // `info()` already redacts `.url`; no double-redaction needed.
          const info = pool.primary().info();
          warn(
            `[abapsmith] connected — authenticated to ${info.sid} @ ${info.url} ` +
              `as ${info.user} (client ${info.client})`,
          );
        } catch (e) {
          const { code, message, hint } = describeStartupProbeFailure(e);
          warn(
            `[abapsmith] STARTUP PROBE FAILED (${code}): ${message}` +
              (hint ? ` — ${hint}` : ""),
          );
          notConnectedSuffix = " — NOT CONNECTED, see probe failure above";
        }
      }
      // stripUrlCredentials: ABAP_URL is allowed to carry `user:password@host` userinfo,
      // and this banner is the most-copied line the server prints.
      warn(
        `[abapsmith] ready on stdio — ${cfg.sid} @ ${stripUrlCredentials(cfg.url)} as ${cfg.user} ` +
          `(${mode})${notConnectedSuffix}`,
      );
      // Runtime half of the v2 "experimental" labelling (doc/TOOL-SURFACE-V2/README.md):
      // a doc-only warning is easy to miss, so operators setting
      // ABAP_TOOL_SURFACE=v2 get it on the channel they're already reading.
      if (cfg.toolSurface === "v2") {
        warn(
          "[abapsmith] ABAP_TOOL_SURFACE=v2 — EXPERIMENTAL, NOT SUPPORTED FOR PRODUCTION USE. " +
            "Known v2 defects will not be fixed while v2 holds this status. " +
            "v1 is the supported surface — see doc/TOOL-SURFACE-V2/README.md.",
        );
      }
      warn(
        journal.enabled
          ? `[abapsmith] write journal: ${journal.dir} ` +
              `(keeps ${journal.config.maxEntries} entries / ${journal.config.maxAgeDays} days; ` +
              "before-images contain source — do not commit it)"
          : "[abapsmith] WARNING: write journal DISABLED (ABAP_JOURNAL=off) — writes cannot be undone.",
      );
    },
    async stop() {
      // First, so a rejection further down cannot strand a suspended
      // debuggee (and a dialog work process) on the server.
      shutdownDebugTools();
      await shutdownAllDebugSessions((msg) => warn(msg));
      // The pool may hold 1..maxSessions live slots by now; `pool.shutdown()`
      // reaches all of them, sequentially, never throwing — one stuck
      // session must not block the next.
      await pool.shutdown("mcp-stop");
      // `shutdown()` leaves each slot's subscription to the shared shutdown
      // hook (src/shutdown-hook.ts) installed; `dispose()` releases them —
      // otherwise every `createServer()` call leaks a listener
      // (MaxListenersExceededWarning over a long-lived process).
      // `pool.primary()` deliberately survives dispose(), so
      // `AbapsmithServer.connection` stays valid afterward.
      pool.dispose();
      await mcp.close();
    },
  };
}

export { AbapError };
