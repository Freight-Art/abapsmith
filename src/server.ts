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
import type { AbapConnection, ConnectionOptions } from "./adt/connection.js";
import { AbapError, describeUnknownError, isAbapError } from "./adt/errors.js";
import type { SessionPool } from "./adt/pool.js";
import { stripUrlCredentials, type Config } from "./config.js";
import { shutdownAllDebugSessions } from "./debug/session.js";
import type { Journal } from "./journal.js";
import type { SafetyGate } from "./safety.js";
import type { AbapMode } from "./mode.js";
import { createSystemContext, type SystemContext } from "./systems/context.js";
import { SystemRegistry } from "./systems/registry.js";
import { installSystemRouting } from "./systems/route.js";
import type { SystemSpec } from "./systems/spec.js";
// One import per tool-feature module; each is a `registerXTools(mcp, deps)`
// registrar (see REGISTRATION in `createServer`). `shutdownDebugTools` is
// lifecycle, not registration — each system's debugger deps are built by
// `createSystemContext` and torn down in `stop()`.
import { registerActivateTools } from "./tools/activate.js";
import { shutdownDebugTools } from "./tools/debug.js";
import { registerDebugTools } from "./tools/debug-register.js";
import { registerJournalTools } from "./tools/journal.js";
import { lockedToolsFor, registerLockedTools } from "./tools/locked.js";
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
import { registerImgTools } from "./tools/img.js";
import { registerImgEditTools } from "./tools/img-edit.js";
import { registerUiTools } from "./tools/ui.js";
import { registerEnhancementTools } from "./tools/enh.js";
import { registerDataPreviewTools } from "./tools/data-preview.js";
import { registerDumpTools } from "./tools/dumps.js";
import { registerAtcTools } from "./tools/atc.js";
import { registerQuickFixTools } from "./tools/quickfix.js";
import { registerServiceTools } from "./tools/service.js";
import { registerTraceTools } from "./tools/trace.js";
import { builtinFluidToolSet, registerFluidTool } from "./tools/fluid.js";
import { BUILTIN_FLUID_TOOLS } from "./adt/fluid/builtin/index.js";
import type { FluidToolSet } from "./adt/fluid/plugin-loader.js";
import { SERVER_VERSION } from "./version.js";

export const SERVER_NAME = "abapsmith";
export { SERVER_VERSION };

export interface ServerOptions extends ConnectionOptions {
  /** Injectable for tests; defaults to `journalConfigFromEnv()`. Honoured for the DEFAULT system only — see `createSystemContext`'s doc comment. */
  journal?: Journal;
  /** Fluid tools resolved by `loadFluidTools` (async, so it happens in src/index.ts). Defaults to builtins only. */
  fluidToolSet?: FluidToolSet;
  /**
   * Every system this process serves. Absent, or a single entry, means
   * exactly today's behaviour: one system, `cfg` above IS that system's
   * config, and `systems` on the returned server is a `SystemRegistry` of
   * one. When present, exactly one entry must have `isDefault: true` and
   * its `cfg` must equal the `cfg` this function was called with — see
   * `createServer`'s step 1 for how that invariant is produced rather than
   * merely asserted.
   */
  systems?: readonly SystemSpec[];
  /**
   * Per-system connection option overrides — e.g. a distinct `httpClient`
   * for tests, or a distinct `breaker`. A field this returns as `undefined`
   * (or an alias this has no entry for) inherits from the top-level
   * `ServerOptions` instead, exactly like `SystemContextOptions` documents.
   */
  connectionOptionsFor?: (alias: string) => Partial<ConnectionOptions> | undefined;
}

export interface AbapsmithServer {
  mcp: McpServer;
  /**
   * The DEFAULT system's pool — every tool handler leases its session from
   * ITS OWN routed system's pool (see `routed` inside `createServer`), not
   * necessarily this one. Kept for backward compatibility with code written
   * before #93 that reads `server.pool` directly; on a single-system server
   * this and the routed pool are the same object.
   */
  pool: SessionPool;
  /**
   * The default system's pinned slot-0 connection (`connect()`, `info()`,
   * discovery; the surface `src/index.ts` subscribes to shutdown on). A LIVE
   * GETTER over `registry.default.pool.primary()`, not a captured object —
   * a cached reference would keep reviving a retired connection past its
   * lifetime logon-revival ceiling. Read it at the point of use.
   */
  readonly connection: AbapConnection;
  /** The default system's safety gate. See the `pool` doc comment above — every tool call gates on ITS OWN routed system, not necessarily this one. */
  safety: SafetyGate;
  /** The default system's journal. Same caveat as `pool`/`safety` above. */
  journal: Journal;
  /** Every configured system. A single-system server still has one — of exactly one system. */
  readonly systems: SystemRegistry;
  start(): Promise<void>;
  stop(): Promise<void>;
}

// ADT-error → MCP-payload translation lives in `src/tool-errors.ts`;
// re-exported here since every caller already imports this file.
import { buildErrorPayload, errorResult } from "./tool-errors.js";
export { buildErrorPayload, errorResult };

// `transportCreateJournalHook` now lives in `src/systems/context.ts` — every
// system builds its own `SessionTransport` there, so the hook moved with it.
// Re-exported here so `test/session-transport-journal.test.ts`'s existing
// `import { transportCreateJournalHook } from "../src/server.js"` keeps
// working unchanged.
export { transportCreateJournalHook } from "./systems/context.js";

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
 * The write-scope sentence `instructionsFor` embeds. The point is that it is
 * rendered from the resolved config, not asserted as a constant. `readOnly`
 * is checked FIRST: in `read` mode `READ_CAPABILITIES.allowPackages`
 * (src/mode.ts) is `[]`, and a naive length check would then claim the
 * ALLOWLIST refuses every write when it is the MODE doing the refusing.
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
 * tool registry, so it is hand-synced with the tools this server actually
 * registers below. There is only one tool surface now, so there is no
 * branch to keep in sync. The write-scope clause, though, is not
 * hand-synced: it is rendered from the resolved `readOnly`/`allowPackages`
 * config by {@link packageScopeSentence}, so it cannot drift from
 * `EDIT_PACKAGE_DEFAULT` the way an old hardcoded "default $TMP" claim
 * once did. Exported so `test/server-instructions-write-scope.test.ts` can
 * exercise it directly.
 */
export function instructionsFor(
  abapMode: AbapMode | undefined,
  readOnly: boolean,
  allowPackages: readonly string[],
  // Optional, defaulted, so `test/server-instructions-write-scope.test.ts`'s
  // existing shorter-arity calls keep compiling.
  fluidAvailable = false,
  // Same reasoning as `fluidAvailable` above: optional and defaulted so
  // existing shorter-arity calls keep compiling.
  lockedToolCount = 0,
  // Optional, defaulted (undefined), for the same reason as the two params
  // above — a multi-system deployment passes every configured system here;
  // a single-system one omits it and gets today's exact wording.
  systems?: readonly { alias: string; sid: string; mode: string }[],
): string {
  // Under ABAP_MODE, ABAP_ALLOW_WRITE is never read; say what actually governs.
  const writeGate =
    abapMode !== undefined ? `unless ABAP_MODE is edit or admin (it is ${abapMode})` : "unless the operator set ABAP_ALLOW_WRITE";
  const packageScope = packageScopeSentence(readOnly, allowPackages);
  const systemsSentence =
    systems !== undefined && systems.length > 1
      ? ` This process serves ${systems.length} systems: ` +
        `${systems.map((s) => `${s.alias} (${s.sid}, ${s.mode})`).join(", ")}. Every tool takes an ` +
        `optional system parameter naming one of these aliases and defaults to ${systems[0]?.alias ?? "the default system"} ` +
        "when omitted; each system's permission ceiling is its own — read-only on one alias is not " +
        "lifted by admin mode on another."
      : "";
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
    "always marked." +
    (fluidAvailable
      ? " abap_fluid deploys and runs small generated ABAP tools inside " +
        "$ABAPSMITH_FLUID_API (call it with no arguments for the catalogue)."
      : "") +
    (lockedToolCount > 0
      ? ` ${lockedToolCount} further tools are listed but LOCKED at this permission level ` +
        "(abap_write among them) — each one's description says what unlocks it, and calling " +
        "one returns a refusal without touching the SAP system."
      : "") +
    systemsSentence
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
 * Adds `extra`'s own properties onto `base` without evaluating any getter
 * `base` exposes — spreading (`{ ...base, ...extra }`) would call every
 * getter on `base` immediately and freeze its result into a plain value,
 * which is exactly wrong for `routed` below: the whole point of its
 * `pool`/`cfg`/`safety`/`journal`/`transport`/`debugDeps` getters is that
 * each one re-resolves the CURRENT routed system on every access, not once
 * at registration time (registration runs once per process, outside any
 * routed request). `Object.create` makes `base` the new object's
 * prototype instead of copying it, so a lookup `extra` doesn't shadow still
 * runs `base`'s getter fresh, on every access, for the life of the process.
 */
function withDeps<Base extends object, Extra extends object>(base: Base, extra: Extra): Base & Extra {
  return Object.create(base, Object.getOwnPropertyDescriptors(extra)) as Base & Extra;
}

/**
 * `opts` IS REQUIRED, because `ServerOptions extends ConnectionOptions` and
 * `ConnectionOptions.breaker` is required. That is not incidental: this
 * function is the composition root for every connection the process builds, so
 * the process-wide breaker has to enter the system HERE, visibly, in one line
 * the reader can point at. See `src/index.ts` for that line.
 */
export function createServer(cfg: Config, opts: ServerOptions): AbapsmithServer {
  const warn = opts.log ?? ((m: string) => process.stderr.write(m + "\n"));

  // Step 1: every system this process serves. `opts.systems` absent (or
  // empty) means exactly today's behaviour — one system, built from `cfg`
  // itself rather than from a `SystemSpec` array, so a caller that never
  // heard of issue #93 sees no difference at all. `env: process.env` here
  // matches what `cfg` was already resolved from in that case.
  const specs: readonly SystemSpec[] =
    opts.systems && opts.systems.length > 0
      ? opts.systems
      : [{ alias: cfg.sid, cfg, isDefault: true, env: process.env, source: "process.env" }];

  // Warning lines get an alias prefix as soon as there is more than one
  // system to disambiguate between — including the default one, since a
  // DEV-vs-QAS warning printed with no alias is ambiguous about which
  // system it's about. A single-system server keeps today's exact wording.
  const labelSystems = specs.length > 1;

  const contexts: readonly SystemContext[] = specs.map((spec) =>
    createSystemContext(spec, {
      base: opts,
      connectionOptionsFor: opts.connectionOptionsFor,
      warn,
      labelSystems,
    }),
  );
  const registry = new SystemRegistry(contexts);
  const def = registry.default;

  // Step 2 (union of step 3 from the brief, folded in here): registration-time
  // tool filtering unions ACROSS every configured system — a tool is
  // registered (spends schema bytes) if ANY configured system could use it;
  // the SAFETY GATE that actually judges a call always evaluates the
  // call's OWN routed system (via `routed` below), never this union. This
  // is what keeps "read-only on DEV does not widen because QAS is admin"
  // true even though `abap_write` is registered process-wide.
  const toolCapabilities = {
    canWrite: contexts.some((c) => c.capabilities.canWrite),
    canReleaseTransport: contexts.some((c) => c.capabilities.canReleaseTransport),
    canEnhance: contexts.some((c) => c.capabilities.canEnhance),
    canPreviewData: contexts.some((c) => c.capabilities.canPreviewData),
    canReadDumpVariables: contexts.some((c) => c.capabilities.canReadDumpVariables),
    canUseFluidApi: contexts.some((c) => c.capabilities.canUseFluidApi),
  };

  // Locked refusal stubs (issue #63) only replace the real mutating tools
  // when EVERY configured system is read-only — if even one system can
  // write, the real tools register (via the union above) and a call routed
  // to a read-only system is refused by THAT system's `SafetyGate` instead,
  // with the same fail-closed outcome but the correct per-system reason.
  const lockedTools = specs.every((s) => s.cfg.readOnly) ? lockedToolsFor(def.cfg) : [];

  /** The `mode` word `instructionsFor`'s multi-system sentence uses for one system. */
  const systemModeLabel = (c: Config): string => c.abapMode ?? (c.readOnly ? "read-only" : "write");

  const mcp = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: instructionsFor(
        def.cfg.abapMode,
        def.cfg.readOnly,
        def.cfg.allowPackages,
        toolCapabilities.canUseFluidApi,
        lockedTools.length,
        registry.size > 1
          ? contexts.map((c) => ({ alias: c.alias, sid: c.cfg.sid, mode: systemModeLabel(c.cfg) }))
          : undefined,
      ),
    },
  );

  // Must run before any `registerXTools(mcp, ...)` call below — it rebinds
  // `mcp.registerTool` in place, so only tools registered AFTER this point
  // gain the `system` parameter and routing. No-op when there is only one
  // configured system (see its own doc comment), which is what keeps a
  // single-system server's tool schemas byte-identical to before #93.
  installSystemRouting(mcp, registry);

  // Fallback session id — minted once here, not inside `oninitialized`,
  // so a second `initialize` on the same process (there is no such thing over
  // stdio, but nothing here depends on that) would still reuse it rather than
  // mint a new one. See the `oninitialized` comment below for when it's used.
  const processSessionId = randomUUID();
  // Every system's `Journal` is built above, before `mcp.connect()` runs, so
  // `getClientVersion()` is unset at that point — the initialize handshake
  // hasn't happened yet. `oninitialized` fires once it has, handing EVERY
  // configured system's journal the same client identity — an entry
  // recorded against any of them from here on shares one "who"/"which
  // conversation" (see `Journal.resolveActor()`), not just the default's.
  mcp.server.oninitialized = () => {
    const clientName = mcp.server.getClientVersion()?.name;
    // "Which conversation", distinct from "who" above. `Transport`
    // declares `sessionId?: string` (SDK shared/transport.d.ts) but
    // `StdioServerTransport` — the only transport `start()` below ever
    // constructs — never assigns it, so this is a defensive read of a
    // documented field, not something observed to fire. Fall back to a
    // value generated once for this process: for stdio, one process IS one
    // client connection, so it genuinely identifies "this conversation".
    const transportSessionId = mcp.server.transport?.sessionId;
    const sessionId = transportSessionId ?? processSessionId;
    const sessionSource = transportSessionId ? "transport" : "process";
    for (const ctx of contexts) {
      ctx.journal.setClientActor(clientName);
      ctx.journal.setClientSession(sessionId, sessionSource);
    }
  };

  // Every registrar below reads its per-request dependencies off `routed`
  // (or `withDeps(routed, extra)` when it needs a field `routed` doesn't
  // carry) instead of a plain `{ pool, cfg, safety, ... }` literal. `routed`'s
  // getters call `registry.current()` on every access — the in-flight
  // routed system if `installSystemRouting` wrapped this call (see
  // `src/systems/route.ts`/`current.ts`), else the default — so ONE set of
  // ~25 registrar calls, made ONCE at startup, still dispatches every
  // request to its own target system's pool/safety/journal/transport, with
  // zero change to any `registerXTools` module itself.
  const routed = {
    get pool(): SessionPool {
      return registry.current().pool;
    },
    get cfg(): Config {
      return registry.current().cfg;
    },
    get safety(): SafetyGate {
      return registry.current().safety;
    },
    get journal(): Journal {
      return registry.current().journal;
    },
    get transport() {
      return registry.current().transport;
    },
    get debugDeps() {
      return registry.current().debugDeps;
    },
    ensureConnected: (): Promise<void> => registry.current().ensureConnected(),
    errorResult,
    warn,
  };

  // Every tool registrar this server has; there is one tool surface and it
  // is always registered.
  // `journal` is required on `TransportToolDeps` — it was once optional
  // and silently omitted, disabling every transport journal entry (see
  // the git history); now a compile error instead of a
  // silent no-op, pinned by test/session-transport-journal.test.ts.
  registerTransportTools(
    mcp,
    withDeps(routed, {
      // The pool, not the connection: transport ops have no single ABAP
      // object to gate on (a TRKORR isn't a repository object).
      // Same manager that adopts requests knows which of them this session
      // created — `abap_transport show` and the release gate read the
      // record `transport`'s resolver writes. A getter, like the rest of
      // `routed`: the manager that "this session" means depends on which
      // system the call was routed to.
      get ownership() {
        return registry.current().transport;
      },
      // `abap_transport`'s list/show/check/users submodes are ungated and
      // always registered; only `abap_transport_release` is gated.
      registerRelease: toolCapabilities.canReleaseTransport,
    }),
  );

  // BOPF tools gate on the BO name via `bopfGateKey` (tools/bopf.ts).
  // `abap_bopf` is a pure read, always registered; only
  // `abap_bopf_edit`/`abap_bopf_delete` are gated. `journal` required —
  // same reason as `TransportToolDeps` above (BOPF journalling was added
  // under the same fix).
  registerBopfTools(mcp, withDeps(routed, { registerWrite: toolCapabilities.canWrite }));
  // abap_enh registers unconditionally: `discover_hook_anchors` makes no
  // `SafetyGate` call at all (a genuinely ungated read), so gating the
  // whole tool would hide that read on a read-only server. Every other
  // submode is gated via `assertIntent` at point of use. `journal`
  // required — enhancement description writes are journalled
  // (irreversible: history, never undo).
  registerEnhancementTools(mcp, routed);

  // Core repository tools: one module per feature, one `registerXTools`
  // call, nothing about schema/handler visible here. Every group takes
  // `pool, cfg, safety, ensureConnected, errorResult` plus only the extra
  // collaborators it uses.
  // `systems`/`multiSystem` (issue #93) enable cross-system
  // `view="diff"` (`from_system`/`to_system`) — `multiSystem` is what
  // gates whether those two fields are spliced into the registered schema
  // at all, so a single-system server's `abap_read` schema stays exactly
  // what it always was.
  registerReadTools(
    mcp,
    withDeps(routed, {
      systems: {
        aliases: registry.aliases,
        resolve: (alias?: string) => registry.resolve(alias),
      },
      multiSystem: registry.size > 1,
    }),
  );
  registerSearchTools(mcp, routed);
  registerOpenUrlTools(mcp, routed);
  // `abap_img` reads catalog tables straight through the freestyle data-preview endpoint
  // (src/adt/img-read.ts) — it generates no ABAP and deploys nothing, so it needs no write
  // capability and registers unconditionally, same as the other read tools above.
  registerImgTools(mcp, routed);
  // `abap_write`/`abap_fpm_read`/`abap_run`/`abap_test`/`abap_bopf_test`
  // have no ungated submode, so registration itself is skipped when
  // `!toolCapabilities.canWrite`. `abap_activate` (mode=check is a genuine
  // ungated read) stays unconditional, below.
  if (toolCapabilities.canWrite) {
    registerBopfTestTool(mcp, withDeps(routed, createBopfTestDeps()));
    registerFpmTools(mcp, routed);
    // `abap_ui`'s `screen` mode deploys reused $ABAPSMITH_FLUID_API fluid classes, so
    // it needs write capability just to register. `press` (committing) is
    // gated far more tightly at call time — `assertPressEnabled` in
    // src/tools/ui.ts requires ABAP_MODE=admin AND ABAP_ALLOW_UI_PRESS.
    // `journal` required: `press`'s blast radius is business data, not
    // repository objects.
    registerUiTools(mcp, routed);
    // `journal` for the before-image, `transport` for the CTS assignment.
    registerWriteTools(mcp, routed);
    // `abap_img_edit` writes IMG customizing rows by dispatching against the reused
    // $ABAPSMITH_FLUID_API body class ZCL_ZMCP_FLUID_IMG (src/adt/fluid/builtin/img.ts) —
    // an irreversible business-data write, gated here like every other mutating tool.
    // `journal` records the before-image; the wider `cfg` slice (`sid`/`url`/`client`) is
    // for `systemKey()` on those journal entries.
    registerImgEditTools(mcp, routed);
    registerRunTools(mcp, routed);
    registerTestTools(mcp, routed);
    // `abap_atc`: inside `canWrite`, not beside `abap_dumps` — a run
    // creates a persistent ATC worklist row, and this server observably
    // REFUSES to remove it (DELETE answers 405 `ExceptionMethodNotSupported`,
    // capture `891-i78-worklist-delete-405.xml`; the advertised
    // `?action=deleteFindings` action is a zero-byte 200 no-op, capture 858)
    // — and `execute` carries the Z/Y-prefix + package-allowlist rules, so
    // gating it any weaker risks unbounded server-side checks against
    // SAP-standard packages. See src/adt/atc.ts.
    registerAtcTools(mcp, routed);
    // Same reasoning: mode="list" POSTs the object's whole source for evaluation.
    registerQuickFixTools(mcp, routed);
  }
  // `journal` required on `ActivateToolDeps` — it was previously missing,
  // and `abap_activate` (up to 50 objects/call) changed executing
  // code with nothing recorded to disk. Unconditional (outside `canWrite`)
  // since `mode=check` is a genuine ungated read; journal only writes on
  // `mode=activate`.
  registerActivateTools(mcp, routed);
  registerJournalTools(mcp, routed);
  registerDebugTools(mcp, routed);
  // `abap_data_preview`: skipped outright (not registered-and-refusing) so
  // it costs no schema bytes when ABAP_ALLOW_DATA_PREVIEW is off. Not
  // inside `canWrite` — a preview is a read.
  if (toolCapabilities.canPreviewData) {
    registerDataPreviewTools(mcp, routed);
  }
  // `abap_dumps`: registered unconditionally — tier 1 (list, one dump's
  // header/source/system-fields/call-stack) is a genuine ungated read.
  // `registerVariables` controls only whether the `variables` field (tier
  // 2, live field values) is ADVERTISED in the schema; the handler still
  // calls `safety.assertDumpVariables()` on every request regardless of
  // route. Deliberately not derived from `canWrite` (see
  // `resolveStaticCapabilities`) — keying production-data access off
  // write capability would give read-only production the widest access.
  registerDumpTools(mcp, withDeps(routed, { registerVariables: toolCapabilities.canReadDumpVariables }));
  // `abap_service` (OData $metadata): registered unconditionally, not
  // inside `canWrite` like `abap_atc` — `op="read"` (the default) is three
  // GETs, nothing created server-side, always allowed. `op="publish"`/
  // `"unpublish"` DO mutate (they call an ADT publish job), but the
  // connected ceilings that would gate them — `allowServicePublish`,
  // `readOnly`, a productive-system lockout, a failed namespace/package
  // check against the binding's package — are unknowable at registration
  // time, exactly like `abap_fluid` below: every call re-checks via
  // `safety` at call time instead of the tool being registered or not.
  registerServiceTools(mcp, routed);
  // `abap_trace` (ABAP runtime tracing, SAT): unconditional like `abap_dumps`
  // and `abap_service` above — `list`/`read` are genuine ungated reads, and
  // `start`/`run`/`delete` each self-gate per op inside the handler (a
  // target-less capability probe, plus the same object-specific preflight
  // assert `abap_run` uses for `start`/`run`). Not added to `./locked.ts`
  // for the same reason: it is registered everywhere and refuses at call
  // time, never omitted from the schema.
  registerTraceTools(mcp, routed);
  // `abap_fluid` installs generated ABAP into $ABAPSMITH_FLUID_API — there is
  // no read-only subset of it, so when ABAP_FLUID_API is off or the system is
  // read-only the tool is not registered at all and costs no schema bytes,
  // exactly like `abap_data_preview` above. `canUseFluidApi` is strictly
  // narrower than `canWrite` (see its doc comment in config.ts), so this is
  // outside/adjacent to the `canWrite` block rather than nested in it. The
  // connected ceilings (a productive system, a write lockout, a failed role
  // probe) are unknowable here, so every op re-checks
  // `fluidDisabledReason(cfg, safety)` at call time (`src/tools/fluid.ts`).
  if (toolCapabilities.canUseFluidApi) {
    registerFluidTool(
      mcp,
      withDeps(routed, {
        toolSet: opts.fluidToolSet ?? builtinFluidToolSet(BUILTIN_FLUID_TOOLS),
      }),
    );
  }
  // Refusal-only stubs closing the "Tool abap_write not found" gap from
  // issue #63: on a read-only server, `abap_write` and friends were
  // never registered at all, so a caller got an MCP "tool not found"
  // error indistinguishable from a typo, with no hint that raising
  // ABAP_MODE is the fix. These stubs take no pool/cfg-write/safety
  // dependency — only `cfg.abapMode` and `errorResult` — so they cannot
  // reach SAP no matter what a caller passes; `[]` on any non-read-only
  // server, so this is a no-op there. `cfg: def.cfg`, not `routed.cfg`:
  // this only registers at all when EVERY system is read-only (see
  // `lockedTools` above), so the default's `abapMode` speaks for all of
  // them for the purpose of this stub's explanatory text.
  registerLockedTools(mcp, { cfg: def.cfg, errorResult, tools: lockedTools });

  // Objects referenceable without a tool call, and the discovery probe
  // exposed without spending tool-schema budget — one resource per
  // configured system.
  const seenResourceUris = new Set<string>();
  for (const ctx of registry.all()) {
    const uri = `abap://${ctx.cfg.sid}/system`;
    let resourceUri = uri;
    if (seenResourceUris.has(uri)) {
      // Two systems sharing a SID (e.g. distinguished only by client) would
      // otherwise collide on the same URI — disambiguate with the alias
      // rather than silently dropping the second system's resource.
      resourceUri = `abap://${ctx.cfg.sid}/system-${ctx.alias.toLowerCase()}`;
      warn(
        `[abapsmith] WARNING: system "${ctx.alias}" shares SID "${ctx.cfg.sid}" with an earlier ` +
          `configured system — its resource is registered at ${resourceUri} instead of ${uri}.`,
      );
    }
    seenResourceUris.add(uri);
    const resourceName = registry.size > 1 ? `system-${ctx.alias.toLowerCase()}` : "system";
    mcp.registerResource(
      resourceName,
      resourceUri,
      {
        title: registry.size > 1 ? `ABAP system ${ctx.cfg.sid} (${ctx.alias})` : `ABAP system ${ctx.cfg.sid}`,
        description: "Connection state, system role, and the ADT feature inventory from /discovery.",
        mimeType: "application/json",
      },
      async (resUri) => {
        await ctx.ensureConnected();
        return {
          contents: [
            {
              uri: resUri.href,
              mimeType: "application/json",
              text: JSON.stringify(
                {
                  connection: ctx.pool.primary().info(),
                  discovery: ctx.pool.primary().discovery.summary(),
                  // Live occupancy at the instant of the read — `stats()` is
                  // synchronous, no pool lease, safe to read mid-incident even while
                  // saturated. `limits` are the denominators busy/idle are out of;
                  // without them `busy: 5` alone doesn't say whether that's fine.
                  sessions: {
                    ...ctx.pool.stats(),
                    limits: {
                      maxSessions: ctx.cfg.maxSessions,
                      readConcurrency: ctx.cfg.readConcurrency,
                      writeConcurrency: ctx.cfg.writeConcurrency,
                    },
                  },
                  safety: {
                    ...ctx.safety.config,
                    writesEnabled: !ctx.safety.config.readOnly,
                    allowPackages: ctx.safety.config.allowPackages,
                    allowNamePrefixes: ctx.safety.namePrefixes,
                    allowTransports: ctx.safety.transportAllowlist,
                  },
                  journal: {
                    enabled: ctx.journal.enabled,
                    dir: ctx.journal.enabled ? ctx.journal.dir : null,
                    retention: `${ctx.journal.config.maxEntries} entries / ${ctx.journal.config.maxAgeDays} days`,
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
  }

  // Every tool above is registered by this point, so the SDK's `tools/list`
  // handler already exists — wrap its transport now (see the comment on
  // `stripSchemaKeyOnConnect` above `createServer`).
  stripSchemaKeyOnConnect(mcp);

  return {
    mcp,
    // The default system's pool/connection/safety/journal — see this
    // field's doc comment on `AbapsmithServer` for why it's the default and
    // not "whichever system was routed last".
    pool: def.pool,
    // A getter, not a snapshot: see the contract on `AbapsmithServer.connection`.
    get connection() {
      return def.pool.primary();
    },
    safety: def.safety,
    journal: def.journal,
    systems: registry,
    async start() {
      const transport = new StdioServerTransport();
      await mcp.connect(transport);
      // Sequential, not `Promise.all` — each system's probe prints its own
      // banner, and interleaved banners from concurrent probes would be
      // unreadable. A slow/unreachable system delays the ones after it in
      // the list, same trade-off the pre-#93 single-probe startup always had.
      for (const ctx of registry.all()) {
        const label = registry.size > 1 ? `${ctx.alias}: ` : "";
        const mode = ctx.cfg.readOnly
          ? "read-only"
          : `WRITES ENABLED → packages [${ctx.cfg.allowPackages.join(", ")}]`;
        // Startup probe — previously `ready on stdio` printed
        // unconditionally, so a bad ABAP_URL/VPN/client only surfaced inside
        // an agent's transcript on the first tool call, misread as agent
        // confusion. Reuses `ensureConnected()`, the same lazy-connect path
        // every tool call takes, so success costs no double logon. Never
        // throws — a probe failure must not block startup, since the next
        // tool call retries via the same lazy path. Suppressible via
        // ABAP_STARTUP_PROBE=false — see doc/CONFIGURATION/connection.md.
        let notConnectedSuffix = "";
        if (ctx.cfg.startupProbe) {
          try {
            await ctx.ensureConnected();
            // `info()` already redacts `.url`; no double-redaction needed.
            const info = ctx.pool.primary().info();
            warn(
              `[abapsmith] ${label}connected — authenticated to ${info.sid} @ ${info.url} ` +
                `as ${info.user} (client ${info.client})`,
            );
          } catch (e) {
            const { code, message, hint } = describeStartupProbeFailure(e);
            warn(
              `[abapsmith] ${label}STARTUP PROBE FAILED (${code}): ${message}` +
                (hint ? ` — ${hint}` : ""),
            );
            notConnectedSuffix = " — NOT CONNECTED, see probe failure above";
          }
        }
        // stripUrlCredentials: ABAP_URL is allowed to carry `user:password@host` userinfo,
        // and this banner is the most-copied line the server prints.
        warn(
          `[abapsmith] ${label}ready on stdio — ${ctx.cfg.sid} @ ${stripUrlCredentials(ctx.cfg.url)} as ` +
            `${ctx.cfg.user} (${mode})${notConnectedSuffix}`,
        );
        warn(
          ctx.journal.enabled
            ? `[abapsmith] ${label}write journal: ${ctx.journal.dir} ` +
                `(keeps ${ctx.journal.config.maxEntries} entries / ${ctx.journal.config.maxAgeDays} days; ` +
                "before-images contain source — do not commit it)"
            : `[abapsmith] ${label}WARNING: write journal DISABLED (ABAP_JOURNAL=off) — writes cannot be undone.`,
        );
      }
    },
    async stop() {
      // First, so a rejection further down cannot strand a suspended
      // debuggee (and a dialog work process) on the server. Process-global
      // (see `debug-register.ts`'s `debugSessionSystem` guard) — one call
      // tears down every system's debug lane, not just the default's.
      shutdownDebugTools();
      await shutdownAllDebugSessions((msg) => warn(msg));
      // Each system's pool may hold 1..maxSessions live slots by now;
      // `ctx.shutdown()` reaches all of them, sequentially, never throwing —
      // one stuck session on one system must not block another system's
      // shutdown, nor `mcp.close()` below.
      for (const ctx of registry.all()) {
        await ctx.shutdown("mcp-stop");
      }
      await mcp.close();
    },
  };
}

export { AbapError };
