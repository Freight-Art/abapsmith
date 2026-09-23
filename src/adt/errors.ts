/**
 * Structured errors surfaced across the MCP tool boundary.
 *
 * Every error the tools return carries a stable machine-readable `code` so the
 * model can react without string-matching prose.
 */

export type AbapErrorCode =
  | "AUTH_CIRCUIT_OPEN"
  | "CIRCUIT_OPEN_TRANSIENT"
  | "AUTH_FAILED"
  /**
   * A bearer credential (`ABAP_TOKEN`, or an OAuth access token) was
   * rejected with 401/403 and the most likely cause is expiry, not a wrong
   * secret. Minted in `token` and `oauth` auth modes only (see
   * `src/adt/connect-failure.ts`). Not `AUTH_FAILED`: that code's hint tells
   * the operator to fix `ABAP_USER`/`ABAP_PASSWORD`, which are not in play
   * here — the remedy is renewing `ABAP_TOKEN` (or the OAuth client's
   * grant). Like `AUTH_FAILED` it is never retried in place — a rejected
   * bearer counts against the same ICF logon path.
   */
  | "AUTH_EXPIRED"
  /**
   * The OAuth token endpoint itself refused the client-credentials request
   * or was unreachable, so no bearer could be obtained at all. Not
   * `AUTH_EXPIRED` (nothing was ever presented to the ABAP system) and not
   * `CONNECT_FAILED` (that names the ABAP system's own host; this names the
   * identity provider's). Minted only by `OAuthTokenProvider`
   * (`src/adt/oauth.ts`).
   */
  | "AUTH_TOKEN_REFRESH_FAILED"
  /**
   * 5xx from ABAP during `connect()`'s login — system down/restarting, not
   * a credential problem. Minted only by `classifyConnectFailure`
   * (`src/adt/connect-failure.ts`). Not `AUTH_FAILED` (SAP never got far
   * enough to check a credential) or `ADT_ERROR` (that's the unidentified
   * fallback); distinct from `classifySessionFailure`'s mid-session 500
   * handling. Full rationale: the git history.
   */
  | "SYSTEM_UNAVAILABLE"
  /**
   * `connect()`'s login never reached the ABAP system at all (ECONNREFUSED,
   * ENOTFOUND, ETIMEDOUT, TLS handshake failure — below HTTP). Minted only
   * by `classifyConnectFailure` (`src/adt/connect-failure.ts`).
   * Not `AUTH_FAILED` (nothing was sent to authenticate) and not
   * `TRANSPORT_ERROR` (that name means a SAP CTS transport request here,
   * see `TRANSPORT_LOCKED`/`TRANSPORT_GONE`). Full rationale:
   * the git history.
   */
  | "CONNECT_FAILED"
  | "NOT_CONNECTED"
  | "NOT_FOUND"
  | "AMBIGUOUS"
  | "UNSUPPORTED"
  | "READ_ONLY"
  /**
   * The system-role probe never got an answer — the connection dropped below
   * HTTP before `T000-CCCATEGORY` could be read — so the system is
   * unclassified and the gate stays closed. Not `READ_ONLY`: no capability
   * switch, flag or allowlist is involved and none lifts it. Not
   * `SYSTEM_UNAVAILABLE`/`CONNECT_FAILED`, which are `connect()`'s own logon
   * failing; this probe runs after a successful logon and its failure is
   * swallowed, so `connect()` still resolves. Minted only by `SafetyGate`
   * from `SafetyConfig.roleProbeFailure`. The lockout it reports is the
   * one-way latch described in doc/SAFETY/safety-gate.md, so it clears on a server
   * restart, not on a retried tool call.
   */
  | "ROLE_PROBE_FAILED"
  | "SAFETY_DENIED"
  | "ADT_ERROR"
  | "TRANSPORT_ERROR"
  | "BAD_INPUT"
  // ---- write path ----
  /** Compare-before-write failed: the object changed since the caller read it. */
  | "ETAG_CONFLICT"
  /**
   * A FULL-SOURCE write presented a `partial:`-marked etag (see
   * `PARTIAL_ETAG_PREFIX` in src/compact.ts) — the caller never saw the full
   * text it's about to overwrite, which would silently delete everything past
   * the truncation point. Not `ETAG_CONFLICT` (nothing changed
   * server-side; re-read/re-apply would just repeat the truncation) and not
   * `BAD_INPUT` (the request is well-formed). Full rationale:
   * the git history.
   */
  | "PARTIAL_READ_SOURCE"
  /** Another session (or user) holds the ADT enqueue lock. */
  | "LOCKED"
  /** Activation or syntax check reported errors. Details carry the messages. */
  | "CHECK_FAILED"
  /** The ABAP session died (short dump, `400 Session Timed Out`). NOT an auth failure. */
  | "SESSION_DEAD"
  /** The local logon-rate refusal (`LOGON_CEILING_PER_WINDOW`/`LOGON_CEILING_WINDOW_MS`): retry after `details.retryAfterSeconds`. */
  | "LOGON_CEILING"
  /** The executed ABAP code short-dumped. */
  | "RUNTIME_DUMP"
  /**
   * A request outran its per-family client timeout and was abandoned
   * client-side: `abap_run` classrun execution (`ABAP_RUN_TIMEOUT_MS`);
   * BOPF create_bo/activate (`ABAP_BOPF_TIMEOUT_MS`); activation
   * (`ABAP_ACTIVATE_TIMEOUT_MS`). Retryability is decided per site from
   * what a re-read of the object shows — e.g. `abap_run` first looks the
   * dumps feed up for a short dump of the same user and program: with one
   * found, `details.dump` names it and the error is NOT retryable; with
   * none, the run most likely ran long and `retryable` is `true`.
   */
  | "TIMEOUT"
  // ---- journal + undo ----
  /**
   * The local write journal could not be read or written — disk full, bad
   * permissions, `ABAP_JOURNAL_DIR` unwritable. Not `SAFETY_DENIED`: this is
   * local disk I/O, not an ABAP-system safety refusal.
   */
  | "JOURNAL_IO"
  // ---- transports ----
  /**
   * The object is pinned to a transport request owned by someone other than
   * the connected user (`trRequirement().pinnedTo`, `pinnedOwner` mismatch).
   * The server will not write through it and will not create a competing
   * request. Message names the TRKORR and the owner.
   */
  | "TRANSPORT_LOCKED"
  /**
   * The session's transport request was released, deleted, or otherwise
   * became unknown to the server, discovered mid-session. Fired exactly once
   * for the TRKORR that died; the connection state moves on (e.g. `gone` ->
   * `idle`) so this is not re-thrown on subsequent operations.
   */
  | "TRANSPORT_GONE"
  /**
   * A package could not be deleted because every object still listed inside
   * it is already deleted (TADIR `DELFLAG='X'`) but its deletion sits on a
   * transport request that has not been released yet. Details name the
   * request(s) (`pendingRequests`). Not `CHECK_FAILED`: that code covers a
   * package still holding live (non-deleted) content.
   */
  | "TRANSPORT_PENDING"
  /**
   * `abap_transport operation=removeObject` cannot drop the entry because the
   * request's object list holds two or more E071 rows for the same
   * PGMID+OBJECT+OBJ_NAME. E071's key is TRKORR+AS4POS, not object identity,
   * so duplicates are legal; `TRINT_DELETE_COMM_OBJECT_KEYS` counts them and
   * raises `w_duplicate_entry` (`MESSAGE e292(tr)`) at two or more, and
   * `TR_DELETE_COMM_OBJECT_KEYS` has no parameter naming which AS4POS to drop.
   * Terminal: no argument to `removeObject` changes the row count, and the
   * remedy is outside abapsmith. Message names the count and the AS4POS values.
   */
  | "CTS_DUPLICATE_ENTRY"
  /**
   * `GuardedHttpClient` refused a URL or method by policy, checked before any
   * network activity. Should be unreachable in normal operation — seeing it
   * means either a dependency changed its URLs or something tried to reach
   * an unapproved endpoint. Message includes the method and path, but never
   * the query string (it can carry identifiers).
   */
  | "HTTP_PATH_DENIED"
  // ---- BOPF (design-time authoring) ----
  /**
   * A BOPF business object references a class/structure/table that does not
   * exist (or a bare TADIR class with no `IMPLEMENTATION`). Not `NOT_FOUND`:
   * the model is well-formed, the problem is a dangling reference inside it.
   */
  | "BOPF_DANGLING_REF"
  /**
   * `create_bo` landed but the business object has no usable root node name
   * — unnamed (`bo:name=""`) or absent entirely. BOPF generates the `Z*_C`
   * constants interface from the root node name at create time and never
   * regenerates it, so the object can never activate and there is no
   * in-band repair. Not `CHECK_FAILED` (nothing was activated or syntax-
   * checked) and not `ADT_ERROR` (the create POST itself did not fail).
   */
  | "BOPF_CREATE_UNUSABLE"
  // ---- Enhancements (design-time authoring) ----
  /**
   * `ABAP_ALLOW_ENHANCEMENTS` is unset/false, or `ABAP_ENHANCE_TARGETS=none`
   * (default). Not `READ_ONLY`: can refuse even when `ABAP_ALLOW_WRITE=true`.
   */
  | "ENHANCEMENT_DISABLED"
  /**
   * Target falls outside `ABAP_ENHANCE_TARGETS` / `ABAP_ENHANCE_TARGET_PACKAGES`
   * (empty `allowPackages` is a deliberate deny-all). Not `SAFETY_DENIED`:
   * that code doesn't name which allowlist to widen. Full rationale:
   * the git history.
   */
  | "ENHANCEMENT_TARGET_DENIED"
  /**
   * Non-overridable ceiling on repairing/modifying enhancement-implied
   * behaviour — no allowlist widens this, unlike `SAFETY_DENIED`.
   */
  | "REPAIR_REFUSED"
  /**
   * ADT REST refused to create the enhancement object at the controller
   * itself, not a payload problem — covers `enhoxh`'s "no create handler"
   * 400 and `enhsxs`'s 500 `ASSERTION_FAILED`. Not `ADT_ERROR`: that invites
   * retrying with a fixed payload, which won't fix a controller that can't
   * create anything. Full rationale: the git history.
   */
  | "ENHANCEMENT_CREATE_REFUSED"
  /**
   * The specific 500 (`enhsxs` create `ASSERTION_FAILED` in
   * `CL_ENH_ADT_ENHS_OBJ_PERSIST===CP`) known to destroy the ADT session.
   * Raised immediately at the failing call, unlike `SESSION_DEAD` (raised on
   * the next request, after the fact). Never retried in place.
   */
  | "ENHANCEMENT_SESSION_DESTROYED"
  /**
   * Enhancement activation POST returned 200 with a non-empty
   * `chkl:messages` body — failure despite the status. Stricter than
   * `CHECK_FAILED`: ANY non-empty checklist is a failure here, not only
   * `@type="E"` entries.
   */
  | "ENHANCEMENT_ACTIVATION_FAILED"
  /**
   * BAdI implementation delete refused: a `badiImplementation` entry reports
   * `isActive="true"` or omits `isActive` (unknown treated as active, per
   * `undoBlocker`'s policy in `src/adt/undo.ts`). No override exists — not
   * `SAFETY_DENIED`, which would invite widening a non-existent allowlist.
   */
  | "ENHANCEMENT_ACTIVE_IMPLEMENTATION"
  /**
   * Enhancement document PUT (`enhoxh`/`enhoxhh`/`enhsxs`) refused, pre-lock,
   * because `adtcore:description` is/would-become empty — SAP's PUT handler
   * rejects that unconditionally (400 `ExceptionInvalidData`,
   * `SWB_TOOL19`/`scr_prop_no_decr`), even for writes unrelated to the
   * description; live-confirmed against A4H. Not `BAD_INPUT` (the object's
   * own state, not the request, blocks the write) and not `ADT_ERROR` (fires
   * before any request reaches the server). Full rationale:
   * the git history.
   */
  | "ENHANCEMENT_DESCRIPTION_REQUIRED"
  /**
   * `exercise` got an unbound handle from `GET BADI` — `CALL BADI` was never
   * attempted (a silent no-op on an unbound multi-use handle). Not
   * `CHECK_FAILED`: the implementation can read back fully active while the
   * kernel's runtime dispatch cache stays stale (SAP Note 944559).
   * Live-confirmed via debugger (`objectref -> 0x0`). Full rationale:
   * the git history.
   */
  | "ENHANCEMENT_NOT_DISPATCHING"
  // ---- Cross-process object locking ----
  /**
   * `FileLockObjectGate` (src/adt/pool.ts) could not take the cross-process
   * lock within its wait budget — another process/GUI session genuinely
   * holds it, or the lock file is a not-yet-stale leftover
   * (`withFileLock`'s thresholds, src/state-dir.ts). Not `JOURNAL_IO`: that's
   * local disk, this is contention. Names holder pid/hostname/startedAt when
   * known.
   */
  | "OBJECT_LOCKED_CROSS_PROCESS"
  /**
   * `FileLockDebugArmLock` (src/debug/arm-lock.ts) could not take the
   * cross-process lock for this system+client+user's single debugger slot.
   * Distinct from `OBJECT_LOCKED_CROSS_PROCESS` (no ABAP object involved,
   * remediation is "stop the other debug session") and from the pool's
   * in-process `lease-held` refusal (a `SessionBusyError`, not this type,
   * thrown when `AdtSessionPool.reserveDebug` finds every lane the CURRENT
   * process is configured for — `resolveDebugSessionLimit`, src/adt/pool.ts
   * — already leased). Names holder pid/hostname/startedAt when known;
   * dead-pid holders are collected automatically (src/state-dir.ts).
   */
  | "DEBUG_SESSION_LOCKED_CROSS_PROCESS"
  /**
   * Every debug lane this process is configured for
   * (`resolveDebugSessionLimit`, src/adt/pool.ts) is already held by a lease
   * IN THIS PROCESS — a new session cannot start until one is stopped.
   *
   * Three distinct refusals live at this boundary and must not be confused:
   * this one (all of THIS process's own lanes are busy), the pool's own
   * `SessionBusyError` (the lower-level signal this is typically surfaced
   * from, for callers that want an `AbapError`-shaped code instead),
   * `DEBUG_SESSION_LOCKED_CROSS_PROCESS` (a DIFFERENT process holds the
   * cross-process file lock for a lane), and SAP's own `409`
   * `conflictDetected` (the ADT server refusing a second global-scope
   * listener for the same SAP user regardless of which process asked — see
   * `test/cassettes/debugger/listener-conflict-409.cassette.json`, cited in
   * `src/debug/identity.ts` and `src/adt/pool.ts`).
   */
  | "DEBUG_ALL_LEASES_BUSY"
  // ---- Debugger ----
  /**
   * `step:"jumpToLine"` refused: `ABAP_ALLOW_DEBUG_JUMP_TO_LINE` unset/false
   * (`Config.allowDebugJumpToLine`), or no matching `confirm` echo. Not
   * `SAFETY_DENIED`/`READ_ONLY`/`BAD_INPUT` — none names the actual gate
   * (mirrors `ENHANCEMENT_DISABLED`). Ordinary stepping never uses this code.
   */
  | "DEBUG_JUMP_DISABLED"
  // ---- Runtime-error dumps (ST22) ----
  /**
   * Variable-contents tier of a runtime-error dump was requested and
   * `ABAP_ALLOW_DUMP_VARIABLES` is unset/false. Tier-1 dump reading (error
   * class, program, line, source, call stack) is never gated. Not
   * `READ_ONLY`: that would point at `ABAP_ALLOW_WRITE`, the opposite of the
   * relevant flag — this ceiling is orthogonal to writes on purpose.
   */
  | "DUMP_VARIABLES_DISABLED"
  // ---- Gate self-defence (abap_activate enhancement-intent fix) ----
  /**
   * The safety gate was called wrong — not a user-facing authorization
   * decision. `evaluate()`'s `phase: "final"` branch requires an
   * `EnhancementIntent` for any enhancement-type target; reaching this with
   * none means a call site resolved the target without building the intent
   * its own type demands (abapsmith's own wiring defect, not a legitimate
   * "no" — `abap_activate` shipped three such call sites deep before this
   * existed). Deliberately not `SAFETY_DENIED`, which would read as normal
   * operation and hide the bug. No flag silences this; fix the call site.
   * Full rationale: the git history.
   */
  | "INTERNAL_GATE_MISUSE"
  // ---- OData service introspection (src/adt/odata.ts, src/adt/edmx.ts) ----
  /**
   * The service binding exists and is activated but its OData service was
   * never **published** to the service runtime, so `$metadata` can't exist
   * yet — the state an agent gets stuck in most often. Not `NOT_FOUND`: the
   * binding name is right; the missing step is a publish action abapsmith
   * deliberately never performs (it mutates the system's runtime surface,
   * outside this feature's read-only scope). The hint carries the publish
   * instruction.
   */
  | "SERVICE_NOT_PUBLISHED"
  /**
   * The service runtime answered 401/403 for `$metadata`. Not `AUTH_FAILED`:
   * the ADT connection/session is fine — this user simply lacks the
   * OData-side authorization (`S_SERVICE`), or the SICF node is inactive.
   * Deliberately kept separate: collapsing this into `AUTH_FAILED` would
   * trip the connection's auth circuit breaker over a per-service
   * authorization problem and take the whole session down with it. Full
   * rationale: the git history.
   */
  | "SERVICE_METADATA_DENIED"
  /**
   * The service runtime answered 404 for a `$metadata` URL that was resolved
   * from a real, published binding. Distinct from `SERVICE_NOT_PUBLISHED`
   * (where the runtime never had the service) and from plain `NOT_FOUND`
   * (which is about repository objects): here the repository is consistent
   * and the *runtime registration* is stale or the ICF path is not active.
   */
  | "SERVICE_METADATA_NOT_FOUND"
  /**
   * Bytes came back but aren't an EDMX document — HTML logon page, ICF
   * error page, JSON, or malformed XML. Never `ADT_ERROR` (this body isn't
   * from ADT); the hint carries an excerpt of what arrived, to avoid a
   * hint-free dead end.
   */
  | "SERVICE_METADATA_UNPARSEABLE"
  /**
   * The ADT publish job for a service binding's OData service reached the
   * server and the server refused it (or answered with `severity=error`).
   * Not `SERVICE_NOT_PUBLISHED`: that code names a state nobody has acted
   * on yet — this code names a publish attempt that reached the server and
   * failed there. Not `READ_ONLY`/`SAFETY_DENIED`: both of those refuse
   * before any request goes out; this one only fires after the request was
   * sent. Usually an inactive binding or an inactive service definition —
   * see the retry classification below.
   */
  | "SERVICE_PUBLISH_FAILED"
  // ---- Fluid API ----
  /**
   * The fluid API is off (`ABAP_FLUID_API` unset/false) or the connected
   * system is read-only, covered by one code because the caller's next move
   * is identical either way. `details.reason` discriminates `"flag"` from
   * `"read-only"`.
   */
  | "FLUID_API_DISABLED"
  /** `ABAP_FLUID_PLUGINS` (the path list) and `ABAP_ALLOW_FLUID_PLUGINS` (the allow flag) are both required; either missing means no plugin loads. */
  | "FLUID_PLUGINS_DISABLED"
  /**
   * `ABAP_ALLOW_FLUID_PLUGIN_MUTATE` is off and either a plugin action
   * declared `category: "mutate"` (refused before dispatch) or the
   * plugin's ABAP source itself contains a database write or COMMIT
   * WORK/ROLLBACK WORK statement (refused at load time). Built-in tools
   * unaffected either way.
   */
  | "FLUID_PLUGIN_MUTATE_DISABLED"
  /**
   * `core.eval` was called but `ABAP_ALLOW_FLUID_EVAL` is off. Builtin only —
   * there is no plugin equivalent of running caller-supplied ABAP verbatim.
   */
  | "FLUID_EVAL_DISABLED"
  /**
   * The target ABAP object is owned by something outside this fluid run:
   * it already exists and isn't owned by this fluid run, or its provenance
   * marker names an abapsmith version strictly newer than this build's
   * (classified `newer`, never overwritten; `details.installed_version`,
   * `.our_version`, `.hint`), or two loaded fluid tools — built-in or
   * plugin — declare the same object name, refusing the second claimant at
   * load time and naming both tool ids.
   */
  | "FLUID_OBJECT_CONFLICT"
  /** The fluid manifest on disk failed validation. */
  | "FLUID_MANIFEST_INVALID"
  /** The ABAP-side action reported failure for its own reasons. */
  | "FLUID_ACTION_FAILED"
  /** The deployed ABAP side sent a response shape this client doesn't understand. */
  | "FLUID_PROTOCOL_ERROR"
  // ---- Multi-system routing (issue #93) ----
  /**
   * A tool call named a `system` alias that is not configured. Minted by
   * `SystemRegistry.resolve` (`src/systems/registry.ts`). The message lists
   * every alias the process actually knows about, since the usual cause is
   * a typo or a stale alias from a config that has since changed.
   */
  | "UNKNOWN_SYSTEM"
  /**
   * A call was routed to a different system than the one that owns the
   * state it would touch. The only case that exists today is the debugger:
   * `debugLanes` (`src/tools/debug.ts`) is process-global, not per-system,
   * so a session started against one system must refuse a step/inspect/stop
   * routed to another rather than silently acting on the wrong connection.
   * Not `SAFETY_DENIED` (nothing about permissions is in question) and not
   * `UNKNOWN_SYSTEM` (the named system is real; it just isn't the one
   * holding the state this call would touch).
   */
  | "SYSTEM_MISMATCH"
  // ---- Data snapshots (src/snapshot-store.ts, abap_data_preview diff) ----
  /**
   * A stored data snapshot outlived its TTL (`dataSnapshotTtlHours` /
   * `ABAP_DATA_SNAPSHOT_TTL_HOURS`) and has been deleted, so the diff it was
   * asked for cannot be computed. Not `NOT_FOUND`: the id was real and did
   * name a snapshot that existed — the refusal is about time, not about a
   * wrong or unknown identifier, and a caller retrying the same id with a
   * different spelling gains nothing. Deliberately never collapsed into a
   * silently empty diff: an expired snapshot must be reported as gone, not
   * quietly treated as "before == after".
   */
  | "SNAPSHOT_EXPIRED";

/**
 * `terminal` — no input the caller can supply satisfies this code.
 * `retryable` — a different argument genuinely would work.
 * `conditional` — depends on circumstances this layer cannot see, so no claim is made.
 */
export type Retryability = "terminal" | "retryable" | "conditional";

/**
 * Every {@link AbapErrorCode} classified once, here, instead of by hand at
 * each throw site. `Record<AbapErrorCode, Retryability>` is the enforcement:
 * adding a code to the union without adding it here is a compile error, and
 * so is a key here that is not in the union. Order mirrors the union above.
 * `terminal`/`retryable` entries carry a one-line reason; `conditional`
 * entries don't — see {@link Retryability}'s doc comment for what that means.
 */
export const RETRYABILITY: Record<AbapErrorCode, Retryability> = {
  AUTH_CIRCUIT_OPEN: "terminal", // circuit only clears on a server restart
  CIRCUIT_OPEN_TRANSIENT: "conditional",
  AUTH_FAILED: "terminal", // trips the circuit breaker; retrying risks locking a shared account
  AUTH_EXPIRED: "terminal", // renewing the token is an operator action outside the call; no argument fixes it
  AUTH_TOKEN_REFRESH_FAILED: "conditional",
  SYSTEM_UNAVAILABLE: "conditional",
  CONNECT_FAILED: "conditional",
  NOT_CONNECTED: "conditional",
  NOT_FOUND: "retryable", // a different identifier could exist
  AMBIGUOUS: "retryable", // a more specific identifier resolves it
  UNSUPPORTED: "terminal", // no argument changes what the tool implements
  READ_ONLY: "terminal", // ABAP_ALLOW_WRITE gates this, not the call's arguments
  ROLE_PROBE_FAILED: "conditional",
  SAFETY_DENIED: "terminal", // the deny-list/allowlist forbids the object, not the request shape
  ADT_ERROR: "conditional",
  TRANSPORT_ERROR: "conditional",
  BAD_INPUT: "retryable", // a different argument can satisfy validation
  ETAG_CONFLICT: "conditional",
  PARTIAL_READ_SOURCE: "conditional",
  LOCKED: "conditional",
  CHECK_FAILED: "conditional",
  SESSION_DEAD: "conditional",
  LOGON_CEILING: "conditional",
  RUNTIME_DUMP: "conditional",
  TIMEOUT: "conditional",
  JOURNAL_IO: "conditional",
  TRANSPORT_LOCKED: "conditional",
  TRANSPORT_GONE: "conditional",
  TRANSPORT_PENDING: "conditional", // retry after the named request is released
  CTS_DUPLICATE_ENTRY: "terminal", // the duplicate E071 rows persist until a human edits the object list
  HTTP_PATH_DENIED: "terminal", // policy denial checked before any network activity
  BOPF_DANGLING_REF: "conditional",
  BOPF_CREATE_UNUSABLE: "terminal", // the object exists and its interface is already invalid; delete it first
  ENHANCEMENT_DISABLED: "terminal", // the flag is off; no payload turns it on
  ENHANCEMENT_TARGET_DENIED: "terminal", // the allowlist excludes the target, not the request
  REPAIR_REFUSED: "terminal", // non-overridable ceiling, no allowlist widens it
  ENHANCEMENT_CREATE_REFUSED: "conditional",
  ENHANCEMENT_SESSION_DESTROYED: "conditional",
  ENHANCEMENT_ACTIVATION_FAILED: "conditional",
  ENHANCEMENT_ACTIVE_IMPLEMENTATION: "conditional",
  ENHANCEMENT_DESCRIPTION_REQUIRED: "retryable", // supplying a description satisfies the PUT
  ENHANCEMENT_NOT_DISPATCHING: "conditional",
  OBJECT_LOCKED_CROSS_PROCESS: "conditional",
  DEBUG_SESSION_LOCKED_CROSS_PROCESS: "conditional",
  DEBUG_ALL_LEASES_BUSY: "conditional", // resolves once a lane frees up; not fixable by a different argument, but not permanent either
  DEBUG_JUMP_DISABLED: "terminal", // the flag is off; no argument enables it
  DUMP_VARIABLES_DISABLED: "terminal", // the flag is off; no argument enables it
  INTERNAL_GATE_MISUSE: "terminal", // a call-site wiring bug, not a caller-facing decision
  SERVICE_NOT_PUBLISHED: "conditional",
  SERVICE_METADATA_DENIED: "terminal", // an authorization gap, not a bad argument
  SERVICE_METADATA_NOT_FOUND: "conditional",
  SERVICE_METADATA_UNPARSEABLE: "conditional",
  SERVICE_PUBLISH_FAILED: "conditional", // usually an inactive binding or definition; the same call succeeds once that's fixed
  FLUID_API_DISABLED: "terminal", // the flag is off or the system refuses writes; no argument changes either
  FLUID_PLUGINS_DISABLED: "terminal", // the flag is off; no argument enables it
  FLUID_PLUGIN_MUTATE_DISABLED: "terminal", // the flag is off; no argument enables it
  FLUID_EVAL_DISABLED: "terminal", // the flag is off; no argument enables it
  FLUID_OBJECT_CONFLICT: "terminal", // the ABAP name is owned by something else; retrying rewrites nothing
  FLUID_MANIFEST_INVALID: "terminal", // the manifest on disk is wrong; the call's arguments cannot fix it
  FLUID_ACTION_FAILED: "terminal", // the ABAP action itself reported the failure; abapsmith cannot judge a retry's safety
  FLUID_PROTOCOL_ERROR: "terminal", // the deployed ABAP is not speaking the contract; a redeploy, not a retry
  UNKNOWN_SYSTEM: "retryable", // a correct alias (see the message's list) resolves this
  SYSTEM_MISMATCH: "retryable", // re-issuing with the session's own system, or stopping it first, resolves this
  SNAPSHOT_EXPIRED: "terminal", // no argument the caller can supply brings a deleted snapshot back; a new snapshot has a new id
};

/** `undefined` for `conditional` — no claim either way. */
export function defaultRetryable(code: AbapErrorCode): boolean | undefined {
  const r = RETRYABILITY[code];
  return r === "conditional" ? undefined : r === "retryable";
}

/** Options for {@link AbapError} beyond its four positional fields. */
export interface AbapErrorOptions {
  /**
   * Defaults from {@link RETRYABILITY} for `code`; this option is a per-site
   * override for when a site knows more than its code does. `false` ⇒ no
   * input can satisfy this call; `true` ⇒ a different argument would work.
   * The key is omitted from the wire payload only when the code is
   * `conditional` and no site overrides.
   */
  retryable?: boolean;
}

export class AbapError extends Error {
  readonly code: AbapErrorCode;
  readonly details: Record<string, unknown>;
  readonly hint?: string;
  readonly retryable?: boolean;

  constructor(
    code: AbapErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    hint?: string,
    options?: AbapErrorOptions,
  ) {
    super(message);
    this.name = "AbapError";
    this.code = code;
    this.details = details;
    this.hint = hint;
    this.retryable = options?.retryable ?? defaultRetryable(code);
  }

  /**
   * Same `Symbol.for` value as the vendor's `AdtException` classes, so
   * `fromException` (run by `AdtHTTP._request` on every throw) returns an
   * `AbapError` unchanged instead of rewriting it into a code-less
   * `AdtErrorException` (e.g. a refusal thrown from the request hook).
   */
  get typeID(): symbol {
    return Symbol.for("ADT EXCEPTION");
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.retryable !== undefined ? { retryable: this.retryable } : {}),
      ...(Object.keys(this.details).length ? { details: this.details } : {}),
    };
  }
}

export const isAbapError = (e: unknown): e is AbapError => e instanceof AbapError;

/**
 * Names the *kind* of a value, for when nothing better can be extracted from it.
 * Never throws: the input may be a null-prototype object or an exotic proxy.
 */
function kindOf(e: unknown): string {
  if (e === null) return "null";
  const t = typeof e;
  if (t !== "object") return t;
  try {
    const name = (e as { constructor?: { name?: unknown } }).constructor?.name;
    if (typeof name === "string" && name.trim() && name !== "Object") return `${name} object`;
  } catch {
    // Null-prototype object, revoked proxy, throwing getter — fall through.
  }
  return "object";
}

/**
 * `String(x)` that cannot throw. `String()` blows up on a null-prototype object
 * (no `toString`), on a symbol reached via interpolation, and on any value with
 * a throwing `toString`. Returns `""` when no string form is obtainable.
 */
function safeToString(e: unknown): string {
  try {
    return String(e);
  } catch {
    return "";
  }
}

/**
 * Best-effort message extraction from anything abap-adt-api / axios throws.
 * Contract: always returns a non-empty string — callers splice this straight
 * into an error envelope's `message`. Every branch is checked for emptiness;
 * the last resort still names what kind of thing was thrown. Full rationale:
 * the git history.
 */
export function describeUnknownError(e: unknown): string {
  // Real errors — but `.message` can be empty, or (untyped input) not a string.
  if (e instanceof Error) {
    const message = typeof e.message === "string" ? e.message : "";
    if (message.trim()) return message;
    const name = typeof e.name === "string" && e.name.trim() ? e.name.trim() : "Error";
    return `${name} was thrown with an empty message`;
  }

  if (typeof e === "string") {
    return e.trim() ? e : "an empty string was thrown as an error";
  }

  // The three values `JSON.stringify` maps to the value `undefined`.
  if (e === undefined) {
    return "`undefined` was thrown as an error (a rejected promise with no reason)";
  }
  if (typeof e === "function") {
    const name = typeof e.name === "string" && e.name.trim() ? e.name.trim() : "";
    return name
      ? `a function (${name}) was thrown as an error`
      : "an anonymous function was thrown as an error";
  }
  if (typeof e === "symbol") {
    // `String(sym)` is legal and yields `Symbol(desc)`; `\`${sym}\`` would throw.
    const text = safeToString(e).trim();
    return text ? `${text} was thrown as an error` : "a symbol was thrown as an error";
  }

  if (e === null) return "`null` was thrown as an error";

  // number / boolean / bigint: `String` is faithful and always non-empty.
  if (typeof e !== "object") {
    const text = safeToString(e).trim();
    return text ? text : `a ${typeof e} value was thrown as an error`;
  }

  // Objects. `JSON.stringify` can throw (BigInt members, circular structures,
  // throwing getters) and can *return* `undefined` (a `toJSON` that yields
  // `undefined`), so neither the value nor the call can be trusted blindly.
  let json: string | undefined;
  let jsonFailure = "";
  try {
    const out = JSON.stringify(e);
    if (typeof out === "string") json = out;
  } catch (inner) {
    jsonFailure =
      inner instanceof Error && typeof inner.message === "string" ? inner.message.trim() : "";
  }
  // `"{}"` is a non-empty string that says nothing — and it is what a
  // cross-realm `Error` serialises to, since `name`/`message` are not
  // enumerable. Keep looking in that case.
  if (json !== undefined && json.trim() && json !== "{}") return json;

  // Error-shaped but not an `Error` (cross-realm throw, axios-ish reject value).
  // The read itself is guarded: `message` may be a throwing getter.
  let duck: unknown;
  try {
    duck = (e as { message?: unknown }).message;
  } catch {
    duck = undefined;
  }
  if (typeof duck === "string" && duck.trim()) return duck;

  const text = safeToString(e).trim();
  if (text && text !== "[object Object]") return text;

  const kind = kindOf(e);
  return jsonFailure
    ? `an undescribable ${kind} was thrown as an error (JSON.stringify failed: ${jsonFailure})`
    : `an undescribable ${kind} was thrown as an error`;
}
