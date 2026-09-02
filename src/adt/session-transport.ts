/**
 * Per-session transport manager.
 *
 * Decides which transport request a write goes into, creating at most one
 * request per server session and caching it for the session's lifetime.
 *
 * Not a safety gate: `src/safety.ts` `evaluate()` owns the authoritative
 * SAFETY_DENIED verdict against `ABAP_ALLOW_TRANSPORTS`. This module reads
 * the same config only to know what action it may take (create, reuse a
 * pin, or refuse); a refusal here is a `denied` resolution — a resolution
 * failure, not the safety verdict itself.
 *
 * Not a CTS client: every wire call delegates to `src/adt/transports.ts`.
 *
 * Three rules this file is built to (live-capture evidence archived in
 * the git history):
 * 1. Transport-need detection is PRE-FLIGHT, never error-driven —
 *    `checkFailed` (`RESULT === "E"`) is read unconditionally, before
 *    branching on `kind`, because a `$TMP` object can still fail its
 *    transportchecks (needing no transport says nothing about whether the
 *    check objects).
 * 2. `resolve()` never answers "no transport, just try it" for a
 *    transportable object — omitting `corrNr` lets SAP silently fabricate
 *    a request that never reaches our journal.
 * 3. Auto-ADOPT prefers a request THIS SESSION created (see `SessionTrOwner`)
 *    over one merely attributed to abapsmith by owner+description; only when
 *    neither is on offer does auto-CREATE run — see {@link SessionTransport}
 *    for the exact precedence.
 */

import type { AbapConnection } from "./connection.js";
import { AbapError, type AbapErrorCode } from "./errors.js";
import {
  isTrkorr,
  trCreate,
  trRequirement,
  trShow,
  type TrHeader,
  type TrOperation,
} from "./transports.js";
import type { AuthorizedTarget } from "../safety.js";

// ---------------------------------------------------------------------------
// Injection seam
// ---------------------------------------------------------------------------

/**
 * The slice of `src/adt/transports.ts` this manager uses. Injectable so tests
 * can drive the state machine without a connection; production passes nothing
 * and gets the real functions.
 */
export interface CtsClient {
  readonly trRequirement: typeof trRequirement;
  readonly trCreate: typeof trCreate;
  readonly trShow: typeof trShow;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/** Why a cached request stopped being usable. */
export type SessionTrGoneReason = "released" | "deleted" | "not-found";

/**
 * States: `idle` → `creating` → `active` → `gone` → `idle`, plus the terminal
 * `disabled` when `ABAP_ALLOW_TRANSPORTS` is explicitly empty.
 */
export type SessionTrState =
  | { readonly kind: "idle" }
  | { readonly kind: "creating"; readonly since: number }
  | {
      readonly kind: "active";
      readonly trkorr: string;
      readonly devclass?: string;
      readonly createdAt: string;
      /**
       * How this session came to hold `trkorr`: freshly created, adopted
       * from CTS's own candidate list, or a configured pin.
       */
      readonly origin: "created" | "adopted" | "config-pin";
    }
  | {
      readonly kind: "gone";
      readonly trkorr: string;
      readonly reason: SessionTrGoneReason;
      readonly detectedAt: string;
    }
  | { readonly kind: "disabled"; readonly reason: string };

// ---------------------------------------------------------------------------
// Resolution result
// ---------------------------------------------------------------------------

/** Where the returned TRKORR came from. */
export type SessionTrSource =
  /** Freshly created by this session. */
  | "session-created"
  /** The session request, reused from cache with no HTTP call. */
  | "session-cached"
  /**
   * An existing open request the pre-flight offered that abapsmith could
   * attribute to itself — see {@link SessionTransport} for the rule.
   */
  | "session-adopted"
  /** An explicit TRKORR listed in `ABAP_ALLOW_TRANSPORTS`. */
  | "config-pin"
  /** Server-imposed: the object is already recorded in this request. */
  | "server-pin"
  /** Named by the caller and permitted by policy. */
  | "caller";

/** Machine-readable reason a resolution was refused. */
export type SessionTrDenial =
  /** `ABAP_ALLOW_TRANSPORTS` is explicitly empty — fail closed. */
  | "transports-disabled"
  /** Policy permits no transport we could use for this write. */
  | "not-allowlisted"
  /** The caller's `corrNr` is not a well-formed TRKORR. */
  | "bad-corrnr"
  /** A named/pinned TRKORR exists but is released, protected or missing. */
  | "corrnr-unusable"
  /** The object is already recorded in another user's request. */
  | "pinned-elsewhere"
  /** The cached session request died; surfaced once, then healed to idle. */
  | "transport-gone"
  /** Pinned mode, but none of the pinned requests is usable. */
  | "no-usable-pin"
  /** No package could be determined, so no request could be created. */
  | "unknown-package"
  /** `transportchecks` came back with `RESULT === "E"`. */
  | "precheck-failed";

/**
 * The answer to "which transport does this write go into?".
 *
 * Three outcomes, all first-class — `undefined` never does double duty:
 *
 * - `not-needed` — a local (`$TMP`-style) object; `KORRFLAG` was empty.
 * - `transport`  — here is your TRKORR.
 * - `denied`     — no transport can be supplied, and here is exactly why.
 *
 * `not-needed` and `denied` are deliberately distinct: "this write needs no
 * transport" and "this write needs one but cannot have one" must never collapse
 * into the same value, because the first is a green light and the second is a
 * hard stop.
 */
export type SessionTrResolution =
  | {
      readonly outcome: "not-needed";
      readonly corrNr?: undefined;
      readonly created: false;
      readonly pinned: false;
      readonly reason: string;
    }
  | {
      readonly outcome: "transport";
      readonly corrNr: string;
      readonly created: boolean;
      readonly pinned: boolean;
      readonly source: SessionTrSource;
      readonly reason: string;
    }
  | {
      readonly outcome: "denied";
      readonly corrNr?: undefined;
      readonly created: false;
      readonly pinned: false;
      readonly denial: SessionTrDenial;
      readonly code: AbapErrorCode;
      readonly reason: string;
      readonly hint?: string;
    };

/** Object identity a write needs resolving for. */
export interface SessionTrTarget {
  /** ADT source URI, e.g. `/sap/bc/adt/oo/classes/zcl_foo/source/main`. */
  readonly uri: string;
  readonly devclass?: string;
  readonly name?: string;
  readonly type?: string;
}

/** Per-call knobs. */
export interface SessionTrResolveOptions {
  /** A TRKORR the caller named explicitly. Honoured only if policy allows it. */
  readonly corrNr?: string;
  /**
   * Re-validate a cached session request with a `trShow` before handing it out
   * — the lazy trigger. Off by default: the cheap path is the point
   * of caching, and the other triggers are more reliable anyway.
   */
  readonly revalidate?: boolean;
}

/**
 * Emitted once, when this session creates its request — and only then. The
 * one event reporting a new, persistent, numbered CTS object that a human
 * will later have to release or delete; every other outcome hands back a
 * request that already existed. See `#doCreate` for the ordering guarantee.
 */
export interface SessionTrCreatedEvent {
  readonly trkorr: string;
  readonly devclass?: string;
  readonly description: string;
  readonly createdAt: string;
  /** ADT source URL of the object whose write triggered the creation. */
  readonly objSourceUrl: string;
  /** Always `"session-created"`; narrowed so consumers don't re-derive provenance. */
  readonly source: Extract<SessionTrSource, "session-created">;
}

/**
 * The most recent `#resolveAuto` decision, so a write response can say which
 * request it got and why. Only meaningful when its `trkorr` matches the
 * request the write actually used — see `SessionTransport.lastAutoDecision`.
 */
export interface SessionTrAutoDecision {
  readonly trkorr: string;
  readonly source: SessionTrSource;
  readonly reason: string;
}

/**
 * What a caller outside this module needs to know about session ownership of a
 * request: whether this session created it, and a way to record a request
 * created outside the auto-resolve path (`abap_transport operation=create`).
 */
export interface SessionTrOwner {
  createdThisSession(trkorr: string): boolean;
  noteCreated(trkorr: string): void;
}

export interface SessionTransportOptions {
  /**
   * `Config.allowTransports`. Unset resolves upstream (`src/config.ts`) to
   * `["*"]`; an explicitly empty `ABAP_ALLOW_TRANSPORTS` resolves to
   * `[]`. Those mean opposite things, so this manager takes the resolved
   * array rather than re-deriving it. `parsePolicy` below reads `["*"]` as
   * `wildcard: true, auto: true` — by default this manager accepts any
   * caller-named transport AND may auto-create one on the operator's behalf;
   * set `ABAP_ALLOW_TRANSPORTS` to a specific TRKORR to pin it down instead
   * (never auto-creates), or to `auto` to restrict to auto-select/auto-create
   * only (no caller-named requests accepted).
   */
  readonly allowTransports: readonly string[];
  /** Override the CTS calls (tests). */
  readonly cts?: Partial<CtsClient>;
  /** The connected SAP user, for the pinned-owner comparison. */
  readonly whoami?: () => string | undefined;
  /** Clock injection (tests). */
  readonly now?: () => Date;
  /** Description for the auto-created request. Never truncated — see `#buildDescription`. */
  readonly description?: string;
  /**
   * Called once when this session creates its request — the caller journals
   * it. May be async; `#doCreate` awaits it so a TRKORR is never handed to a
   * write path before its journal entry exists. A handler that throws never
   * fails the creation — see `#doCreate`.
   */
  readonly onCreated?: (event: SessionTrCreatedEvent) => void | Promise<void>;
  /**
   * Mints the `AuthorizedTarget` `trCreate` (`src/adt/transports.ts`) now
   * requires. A plain function, not a `SafetyGate` — this module doesn't
   * itself consult `ABAP_ALLOW_PACKAGES` / `ABAP_ALLOW_NAME_PREFIXES`; the
   * tool layer (which holds the real gate) supplies it, expected to be
   * exactly `(devClass) => gate.authorize("transport", { name: devClass,
   * packageName: devClass }, { corr: { kind: "unresolved" } })`, mirroring
   * `opCreate` in `src/tools/transport.ts`.
   *
   * Optional so existing test constructions keep compiling; `#doCreate`
   * throws if auto-create is reached without one — fail closed.
   */
  readonly authorizeCreate?: (
    devClass: string,
  ) => AuthorizedTarget<"transport", { name: string; packageName?: string }>;
}

// ---------------------------------------------------------------------------
// Policy parsing
// ---------------------------------------------------------------------------

interface TransportPolicy {
  /** `ABAP_ALLOW_TRANSPORTS` was explicitly empty ⇒ refuse every transportable write. */
  readonly disabled: boolean;
  /**
   * This session may create exactly one request. True for a literal `"auto"`
   * token, and also whenever `wildcard` is true: `*` means "any request is
   * permitted", and a request abapsmith creates itself is a request —
   * safety.ts step 10 already reads `*` that way (it short-circuits on
   * `normalized.includes("*")` before checking `corr.source === "auto"`).
   */
  readonly auto: boolean;
  /** `"*"` present ⇒ the caller may name any TRKORR (see `#callerMayName`). */
  readonly wildcard: boolean;
  /** Explicit TRKORRs listed in config, uppercased (pinned mode). */
  readonly pins: readonly string[];
}

function parsePolicy(allowTransports: readonly string[]): TransportPolicy {
  const entries = allowTransports.map((e) => e.trim()).filter((e) => e !== "");
  // Note the distinction config.ts is careful to preserve: an unset variable
  // arrives here as ["*"], while an explicitly empty one arrives as
  // []. Only the latter disables transports.
  const disabled = allowTransports.length === 0;
  const pins: string[] = [];
  let auto = false;
  let wildcard = false;
  for (const entry of entries) {
    const upper = entry.toUpperCase();
    if (upper === "AUTO") auto = true;
    else if (entry === "*") wildcard = true;
    else if (isTrkorr(upper)) pins.push(upper);
    // Anything else is ignored here; safety.ts is what rejects unknown entries.
  }
  return { disabled, auto: auto || wildcard, wildcard, pins };
}

// ---------------------------------------------------------------------------
// Result constructors
// ---------------------------------------------------------------------------

function notNeeded(reason: string): SessionTrResolution {
  return { outcome: "not-needed", created: false, pinned: false, reason };
}

function granted(
  corrNr: string,
  source: SessionTrSource,
  reason: string,
): SessionTrResolution {
  return {
    outcome: "transport",
    corrNr,
    created: source === "session-created",
    pinned: source === "server-pin" || source === "config-pin",
    source,
    reason,
  };
}

function denied(
  denial: SessionTrDenial,
  code: AbapErrorCode,
  reason: string,
  hint?: string,
): SessionTrResolution {
  return {
    outcome: "denied",
    created: false,
    pinned: false,
    denial,
    code,
    reason,
    ...(hint === undefined ? {} : { hint }),
  };
}

/**
 * Turn a `denied` resolution into the `AbapError` the tool layer throws.
 * Returns `undefined` for the two success outcomes, so callers can write
 * `const err = toAbapError(res); if (err) throw err;`.
 */
export function toAbapError(res: SessionTrResolution): AbapError | undefined {
  if (res.outcome !== "denied") return undefined;
  return new AbapError(
    res.code,
    res.reason,
    { denial: res.denial },
    res.hint,
  );
}

// ---------------------------------------------------------------------------
// Candidate tie-break
// ---------------------------------------------------------------------------

/**
 * Picks the winner among same-tier candidates: greatest `lastChanged`, ties
 * broken by greatest `trkorr`. Shared by the session-created and attributed
 * branches of `#resolveAuto` so they cannot drift. Every candidate here came
 * from `headerFromCheck`, which builds `lastChanged` by joining zero-padded
 * AS4DATE/AS4TIME — plain string comparison is chronological order.
 * `headerFromTm`'s different format never reaches `candidates`.
 */
function pickLatest(candidates: readonly TrHeader[]): TrHeader {
  return candidates.reduce((best, c) => {
    const bestChanged = best.lastChanged ?? "";
    const cChanged = c.lastChanged ?? "";
    if (cChanged !== bestChanged) return cChanged > bestChanged ? c : best;
    return c.trkorr > best.trkorr ? c : best;
  });
}

// ---------------------------------------------------------------------------
// SessionTransport
// ---------------------------------------------------------------------------

/**
 * Per-server-session transport manager.
 *
 * Auto-create, and auto-adopt: `trRequirement()` returns a
 * `candidates: TrHeader[]` array of open requests SAP would let us reuse.
 * Adoption has two tiers. Tier 1: a candidate THIS SESSION created (recorded
 * via `noteCreated()`, see `SessionTrOwner`) — the session's own creation
 * record, no owner or description check needed, and it even pre-empts a
 * cached request this session merely adopted earlier (switches onto its own
 * request instead of continuing to hold a stranger's). Tier 2: a modifiable
 * workbench request owned by the connected user AND carrying a description
 * abapsmith itself would have written (`#isOwnDescription`) — weaker
 * evidence (a user could title a request to match ours by hand), used only
 * when tier 1 has nothing to offer. Everything else falls back to creating a
 * fresh request. A colleague's unrelated in-flight work can still never
 * silently acquire our objects.
 */
export class SessionTransport implements SessionTrOwner {
  readonly #policy: TransportPolicy;
  readonly #cts: CtsClient;
  readonly #whoami: () => string | undefined;
  readonly #now: () => Date;
  readonly #description?: string;
  readonly #onCreated?: (event: SessionTrCreatedEvent) => void | Promise<void>;
  readonly #authorizeCreate?: (
    devClass: string,
  ) => AuthorizedTarget<"transport", { name: string; packageName?: string }>;

  #state: SessionTrState;

  /**
   * Single-flight guard. A *promise*, not a boolean: a boolean can only
   * say "someone is creating", which leaves the second caller with nothing to
   * await and no TRKORR to return. Holding the promise means every racer on a
   * cold cache gets the same request.
   */
  #inflight?: Promise<string>;

  /** The most recent `#resolveAuto` decision. See `lastAutoDecision`. */
  #lastAutoDecision?: SessionTrAutoDecision;

  /** TRKORRs this session itself created — auto-create, or `noteCreated()`. */
  readonly #created = new Set<string>();

  constructor(opts: SessionTransportOptions) {
    this.#policy = parsePolicy(opts.allowTransports);
    this.#cts = {
      trRequirement: opts.cts?.trRequirement ?? trRequirement,
      trCreate: opts.cts?.trCreate ?? trCreate,
      trShow: opts.cts?.trShow ?? trShow,
    };
    this.#whoami = opts.whoami ?? (() => undefined);
    this.#now = opts.now ?? (() => new Date());
    this.#description = opts.description;
    this.#onCreated = opts.onCreated;
    this.#authorizeCreate = opts.authorizeCreate;
    this.#state = this.#policy.disabled
      ? {
          kind: "disabled",
          reason:
            "ABAP_ALLOW_TRANSPORTS is explicitly empty — every transportable write is refused.",
        }
      : { kind: "idle" };
  }

  /** The state machine, for tests and for `abap_transport`'s status output. */
  get state(): SessionTrState {
    return this.#state;
  }

  /** The cached session TRKORR, if one is currently active. */
  get trkorr(): string | undefined {
    return this.#state.kind === "active" ? this.#state.trkorr : undefined;
  }

  /**
   * The last decision `#resolveAuto` made, so a write response can quote it.
   * Only meaningful when its `trkorr` matches the request the write actually
   * used — a caller must check that before attributing the reason to itself.
   */
  get lastAutoDecision(): SessionTrAutoDecision | undefined {
    return this.#lastAutoDecision;
  }

  /** Did THIS session create `trkorr` — auto-create, or a caller's `noteCreated()`? */
  createdThisSession(trkorr: string): boolean {
    const t = trkorr?.trim().toUpperCase();
    return t !== undefined && t !== "" && this.#created.has(t);
  }

  /** Record a request created outside the auto-resolve path (`abap_transport operation=create`). */
  noteCreated(trkorr: string): void {
    this.#created.add(trkorr.trim().toUpperCase());
  }

  /**
   * Decide which transport request this write goes into.
   *
   * Never returns "no transport, just try it" for a transportable object — see
   * the module header, rule 2. Wire failures from `transports.ts` propagate as
   * thrown `AbapError`s; *decisions* always come back as a value.
   */
  async resolve(
    conn: AbapConnection,
    obj: SessionTrTarget,
    operation: TrOperation = "I",
    opts: SessionTrResolveOptions = {},
  ): Promise<SessionTrResolution> {
    const named = SessionTransport.#normalizeCorrNr(opts.corrNr);
    if (!named.ok) return named.denied;
    const wanted = named.wanted;

    // Step 1: PRE-FLIGHT, never error-driven. KORRFLAG decides locality;
    // RESULT decides whether the check itself objects — orthogonal signals,
    // both read from every response before branching on `kind`.
    const req = await this.#cts.trRequirement(
      conn,
      obj.uri,
      obj.devclass,
      operation,
    );

    // Step 1b: a reported check failure is a hard stop, local or not — must
    // run before the `kind === "local"` branch below so a local object's
    // check failure is never shadowed by its localness. Live-captured: a
    // $TMP object got RESULT=E / T100 TO131 over HTTP 200 (see archive).
    if (req.checkFailed) {
      const msgs = req.messages
        .map((m) => m.text)
        .filter((t) => t !== undefined && t !== "")
        .join("; ");
      return denied(
        "precheck-failed",
        "TRANSPORT_ERROR",
        `The transport pre-check for ${obj.name ?? obj.uri} failed${msgs === "" ? "." : `: ${msgs}`}`,
      );
    }

    // Step 2: local objects need no transport.
    if (req.kind === "local") {
      return notNeeded(
        `${obj.name ?? obj.uri} is local (package ${req.devclass ?? "$TMP"}) — no transport request is involved.`,
      );
    }

    // Everything below is transportable and needs a corrNr; "auto-created"
    // vs "required" only differs in whether SAP fabricates one behind our
    // back if we omit it (rule 2). checkFailed was handled in Step 1b.
    return this.#decideTransportable(
      conn,
      obj,
      wanted,
      req.pinnedTo,
      req.pinnedOwner,
      req.devclass,
      req.candidates,
      opts.revalidate === true,
    );
  }

  /**
   * Decides a transport for a `DEVC/K` package create: CTS can't
   * classify an object that doesn't exist, so resolve()'s pre-flight always
   * answers "local". Runs Steps 3-7 unchanged with pinnedTo forced undefined
   * (no server pin is possible), and never returns "not-needed". `candidates`
   * is always empty here — CTS has never seen this object, so there is no
   * candidate list to trust.
   */
  async resolveForNewTransportable(
    conn: AbapConnection,
    obj: SessionTrTarget,
    opts: SessionTrResolveOptions = {},
  ): Promise<SessionTrResolution> {
    const named = SessionTransport.#normalizeCorrNr(opts.corrNr);
    if (!named.ok) return named.denied;
    return this.#decideTransportable(
      conn,
      obj,
      named.wanted,
      undefined,
      undefined,
      obj.devclass,
      [],
      opts.revalidate === true,
    );
  }

  /**
   * Steps 3–7 of `resolve()`, extracted so they are shared verbatim with
   * `resolveForNewTransportable()`. Steps 1, 1b and 2 (the CTS pre-flight
   * that only `resolve()` can perform) live in `resolve()` itself.
   */
  async #decideTransportable(
    conn: AbapConnection,
    obj: SessionTrTarget,
    wanted: string | undefined,
    pinnedTo: string | undefined,
    pinnedOwner: string | undefined,
    devclass: string | undefined,
    candidates: readonly TrHeader[],
    revalidate: boolean,
  ): Promise<SessionTrResolution> {
    this.#lastAutoDecision = undefined;

    // Step 3: fail closed when transports are explicitly disabled.
    if (this.#policy.disabled) {
      return denied(
        "transports-disabled",
        "TRANSPORT_ERROR",
        `${obj.name ?? obj.uri} needs a transport request, but ABAP_ALLOW_TRANSPORTS is explicitly empty — every transportable write is refused. Local ($TMP) writes are unaffected.`,
        "Set ABAP_ALLOW_TRANSPORTS=auto, or list a specific request number.",
      );
    }

    // Step 4: server-imposed pin — not an adoption. SAP is reporting the
    // object is already recorded in that request, so it's the only answer.
    if (pinnedTo !== undefined && pinnedTo !== "") {
      return this.#resolvePin(pinnedTo, pinnedOwner, obj, wanted);
    }

    // Step 5: a TRKORR the caller named.
    if (wanted !== undefined) {
      if (!this.#callerMayName(wanted)) {
        return denied(
          "not-allowlisted",
          "TRANSPORT_ERROR",
          `Transport ${wanted} is not permitted by ABAP_ALLOW_TRANSPORTS [${this.#policy.pins.join(", ") || "auto"}].`,
          'Add it to ABAP_ALLOW_TRANSPORTS, or use "*" to allow any caller-named request.',
        );
      }
      const problem = await this.#checkUsable(conn, wanted);
      if (problem !== undefined) return problem;
      return granted(wanted, "caller", `Using caller-supplied request ${wanted}.`);
    }

    // Step 6: pinned mode — use a configured TRKORR, never create.
    if (this.#policy.pins.length > 0) {
      return this.#resolveConfigPin(conn);
    }

    // Step 7: auto mode — one request per session.
    if (!this.#policy.auto) {
      return denied(
        "not-allowlisted",
        "TRANSPORT_ERROR",
        `${obj.name ?? obj.uri} needs a transport request, but ABAP_ALLOW_TRANSPORTS does not permit creating one and no request was named.`,
        'Pass a corr_nr, or set ABAP_ALLOW_TRANSPORTS=auto to let this session create one.',
      );
    }
    return this.#resolveAuto(conn, obj, devclass, candidates, revalidate);
  }

  /**
   * Step 0 shared by `resolve()` and `resolveForNewTransportable()`: validate
   * a caller-supplied `corrNr` and normalise it, so the two entry points
   * cannot drift on what counts as a well-formed request number.
   */
  static #normalizeCorrNr(
    corrNr: string | undefined,
  ):
    | { readonly ok: true; readonly wanted: string | undefined }
    | { readonly ok: false; readonly denied: SessionTrResolution } {
    const named = corrNr?.trim();
    if (named !== undefined && named !== "" && !isTrkorr(named)) {
      return {
        ok: false,
        denied: denied(
          "bad-corrnr",
          "BAD_INPUT",
          `"${named}" is not a well-formed transport request number.`,
          "Expected a TRKORR such as A4HK900123.",
        ),
      };
    }
    return { ok: true, wanted: named === "" ? undefined : named?.toUpperCase() };
  }

  /**
   * Mark the cached request dead. Called by `abap_transport` after it deletes
   * or releases the session request (and only after the mandatory verification
   * re-read — a bare 200 proves nothing), and by the write path
   * when a 403 identifies the request as missing.
   *
   * No-op unless `trkorr` is the one we are actually holding, so an unrelated
   * release cannot knock out our session.
   */
  invalidate(trkorr: string, reason: SessionTrGoneReason): void {
    if (this.#state.kind !== "active") return;
    if (this.#state.trkorr.toUpperCase() !== trkorr.trim().toUpperCase()) return;
    this.#state = {
      kind: "gone",
      trkorr: this.#state.trkorr,
      reason,
      detectedAt: this.#now().toISOString(),
    };
  }

  /** Lazy re-validation: reads the cached request, invalidating it if gone. Safe when nothing is cached. */
  async revalidate(conn: AbapConnection): Promise<SessionTrState> {
    if (this.#state.kind !== "active") return this.#state;
    const trkorr = this.#state.trkorr;
    const reason = await this.#probe(conn, trkorr);
    if (reason !== undefined) this.invalidate(trkorr, reason);
    return this.#state;
  }

  /** One line a tool response can print. */
  describe(): string {
    const s = this.#state;
    switch (s.kind) {
      case "disabled":
        return `transport: disabled — ${s.reason}`;
      case "idle":
        return this.#policy.pins.length > 0
          ? `transport: none yet (pinned mode — will use one of ${this.#policy.pins.join(", ")}, never creates)`
          : this.#policy.auto
            ? "transport: none yet (auto — one request will be created on the first transportable write)"
            : "transport: none yet (no auto-create; the caller must name a request)";
      case "creating":
        return `transport: creating (since ${new Date(s.since).toISOString()})`;
      case "active": {
        const pkg = s.devclass === undefined ? "" : `, package ${s.devclass}`;
        switch (s.origin) {
          case "created":
            return `transport: ${s.trkorr} (session, created ${s.createdAt}${pkg})`;
          case "adopted":
            return `transport: ${s.trkorr} (session, adopted ${s.createdAt}${pkg})`;
          case "config-pin":
            return `transport: ${s.trkorr} (pinned by configuration)`;
        }
      }
      case "gone":
        return `transport: ${s.trkorr} is gone (${s.reason}, detected ${s.detectedAt}) — the next transportable write resolves afresh`;
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #callerMayName(trkorr: string): boolean {
    if (this.#policy.wildcard) return true;
    return this.#policy.pins.includes(trkorr);
  }

  #resolvePin(
    pinnedTo: string,
    pinnedOwner: string | undefined,
    obj: SessionTrTarget,
    wanted: string | undefined,
  ): SessionTrResolution {
    const me = this.#whoami();
    if (
      pinnedOwner !== undefined &&
      pinnedOwner !== "" &&
      me !== undefined &&
      me !== "" &&
      pinnedOwner.toUpperCase() !== me.toUpperCase()
    ) {
      return denied(
        "pinned-elsewhere",
        "TRANSPORT_LOCKED",
        `${obj.name ?? obj.uri} is already recorded in request ${pinnedTo}, which belongs to ${pinnedOwner}, not ${me}.`,
        `Ask ${pinnedOwner} to release ${pinnedTo}, or add yourself to it.`,
      );
    }
    // Owner matches, or we cannot establish the connected user. Either way the
    // object is already in that request, so it is the only possible answer —
    // this is SAP imposing a request on us, not us adopting one.
    const note =
      wanted !== undefined && wanted !== pinnedTo.toUpperCase()
        ? ` (overriding the requested ${wanted})`
        : "";
    return granted(
      pinnedTo,
      "server-pin",
      `${obj.name ?? obj.uri} is already recorded in request ${pinnedTo} — imposed by the server${note}.`,
    );
  }

  async #resolveConfigPin(conn: AbapConnection): Promise<SessionTrResolution> {
    // Reuse the one we already validated this session.
    if (this.#state.kind === "active") {
      return granted(
        this.#state.trkorr,
        "config-pin",
        `Using configured request ${this.#state.trkorr}.`,
      );
    }
    const problems: string[] = [];
    for (const pin of this.#policy.pins) {
      const problem = await this.#checkUsable(conn, pin);
      if (problem === undefined) {
        this.#state = {
          kind: "active",
          trkorr: pin,
          createdAt: this.#now().toISOString(),
          origin: "config-pin",
        };
        return granted(pin, "config-pin", `Using configured request ${pin}.`);
      }
      problems.push(problem.outcome === "denied" ? problem.reason : pin);
    }
    return denied(
      "no-usable-pin",
      "TRANSPORT_ERROR",
      `None of the transport requests in ABAP_ALLOW_TRANSPORTS is usable: ${problems.join(" ")}`,
      "Pinned mode never creates a request; list a modifiable one or set ABAP_ALLOW_TRANSPORTS=auto.",
    );
  }

  async #resolveAuto(
    conn: AbapConnection,
    obj: SessionTrTarget,
    reqDevclass: string | undefined,
    candidates: readonly TrHeader[],
    revalidate: boolean,
  ): Promise<SessionTrResolution> {
    // gone: surface once, then heal to idle so the next write resolves afresh
    // instead of looping on a dead TRKORR (rule 4).
    if (this.#state.kind === "gone") {
      const dead = this.#state;
      this.#state = { kind: "idle" };
      return denied(
        "transport-gone",
        "TRANSPORT_GONE",
        `The session transport request ${dead.trkorr} is no longer usable (${dead.reason}). Nothing was written. Retry — the next write will resolve a fresh request.`,
      );
    }

    // Prefixed onto whatever this call ends up granting, only when the
    // cached request just died below — empty otherwise.
    let healedPrefix = "";
    // The TRKORR the heal branch below just retired, if any — excluded from
    // adoption further down so auto-adopt can't re-adopt what the heal branch just killed.
    let retired: string | undefined;
    // Set when the cached request was left untouched (not probed, not
    // invalidated) because a session-created candidate pre-empted it below —
    // feeds the "Switched from" wording in the session-created branch.
    let preemptedFrom: string | undefined;

    if (this.#state.kind === "active") {
      const cached = this.#state.trkorr;
      // PRE-EMPTION: a cached request this session did not create is worth
      // less than one it did — if a session-created candidate is on offer,
      // switch to it instead of corroborating/probing the stranger. The
      // stranger is left alone here, not retired: no probe, no invalidate.
      const preempting =
        !this.createdThisSession(cached) &&
        candidates.some(
          (c) =>
            c.kind === "workbench" &&
            c.status === "modifiable" &&
            this.createdThisSession(c.trkorr),
        );
      if (preempting) {
        preemptedFrom = cached;
      } else {
        const corroboratedAlive = candidates.some(
          (c) => c.status === "modifiable" && c.trkorr.toUpperCase() === cached.toUpperCase(),
        );
        // Corroboration is free: resolve()'s Step 1 pre-flight just ran, and if
        // it lists our TRKORR as modifiable, that's as good as a trShow. An
        // EMPTY candidate list is not evidence of anything — CTS may simply
        // have offered nothing at all — so it never triggers a probe by itself.
        const needsProbe = revalidate || (candidates.length > 0 && !corroboratedAlive);
        const goneReason = needsProbe ? await this.#probe(conn, cached) : undefined;
        if (!needsProbe || goneReason === undefined) {
          // Still usable — corroborated for free by the candidate list, or by the probe just run.
          return this.#autoGranted(
            cached,
            "session-cached",
            `Reusing this session's request ${cached}.`,
          );
        }
        // Dead. Heal in the same call and fall through to create afresh
        // — nothing has been written yet (pre-flight, before lock, journal or
        // any mutating request), so there is no half-done work to report. The
        // `gone` branch above is deliberately not re-entered.
        this.invalidate(cached, goneReason);
        this.#state = { kind: "idle" };
        healedPrefix = `The session's previous request ${cached} is no longer usable (${goneReason}). `;
        retired = cached;
      }
    }

    const devclass = reqDevclass ?? obj.devclass;
    if (devclass === undefined || devclass === "") {
      return denied(
        "unknown-package",
        "BAD_INPUT",
        `Cannot create a transport request for ${obj.name ?? obj.uri}: its package could not be determined.`,
        "Pass devclass explicitly.",
      );
    }

    // Tier 1: candidates THIS SESSION created (`noteCreated()` / auto-create).
    // No owner or description check — the session's own creation record is
    // stronger evidence than either, and it still works when whoami() is
    // unknown.
    const sessionCreated = candidates.filter(
      (c) =>
        // Same "don't re-adopt what the heal branch just killed" guard as
        // the attributed tier below.
        (retired === undefined || c.trkorr.toUpperCase() !== retired.toUpperCase()) &&
        c.kind === "workbench" &&
        c.status === "modifiable" &&
        this.createdThisSession(c.trkorr),
    );

    if (sessionCreated.length > 0) {
      const chosen = pickLatest(sessionCreated);
      this.#state = {
        kind: "active",
        trkorr: chosen.trkorr,
        devclass,
        createdAt: this.#now().toISOString(),
        origin: "adopted",
      };
      const reason =
        preemptedFrom !== undefined
          ? `${healedPrefix}Switched from ${preemptedFrom}, which this session did not create, to ${chosen.trkorr}, which THIS SESSION created.`
          : `${healedPrefix}Adopted request ${chosen.trkorr}, which THIS SESSION created, rather than creating another.`;
      return this.#autoGranted(chosen.trkorr, "session-adopted", reason);
    }

    // Tier 2: candidates merely attributed to abapsmith by owner+description
    // — weaker evidence than tier 1, so only consulted once tier 1 is empty.
    const me = this.#whoami();
    const attributed =
      me === undefined || me === ""
        ? []
        : candidates.filter(
            (c) =>
              // CTS's candidate list can still show a request the trShow probe
              // just proved dead above; the probe is the newer evidence, so a
              // just-retired request must never be re-adopted in this call.
              (retired === undefined || c.trkorr.toUpperCase() !== retired.toUpperCase()) &&
              c.kind === "workbench" &&
              c.status === "modifiable" &&
              c.owner.toUpperCase() === me.toUpperCase() &&
              this.#isOwnDescription(c.description) &&
              // Already had its chance in tier 1 above; never double-counted.
              !this.createdThisSession(c.trkorr),
          );

    if (attributed.length > 0) {
      const chosen = pickLatest(attributed);
      this.#state = {
        kind: "active",
        trkorr: chosen.trkorr,
        devclass,
        createdAt: this.#now().toISOString(),
        origin: "adopted",
      };
      return this.#autoGranted(
        chosen.trkorr,
        "session-adopted",
        `${healedPrefix}Adopted existing request ${chosen.trkorr} rather than creating another: it is a modifiable workbench request owned by ${chosen.owner} and carries abapsmith's own session description (${chosen.description}). THIS SESSION DID NOT CREATE IT — it was already open when this session started, so it may already hold objects from earlier work, and abap_transport_release will refuse to release it without an explicit override.`,
      );
    }

    const declineReason =
      me === undefined || me === ""
        ? `The connected SAP user could not be established, so no existing request could be attributed to abapsmith (and none was created by this session either).`
        : candidates.length === 0
          ? `CTS offered no existing request for package ${devclass}.`
          : `CTS offered ${candidates.length} candidate request(s) for package ${devclass}, none of which this session created or could attribute to itself (a modifiable workbench request owned by ${me} carrying abapsmith's own session description).`;

    // Distinguish the caller that actually performed the creation from the
    // racers that merely awaited the same promise: only one reports created.
    const { trkorr, created } = await this.#createOnce(conn, obj.uri, devclass);
    return this.#autoGranted(
      trkorr,
      created ? "session-created" : "session-cached",
      created
        ? `${healedPrefix}Created request ${trkorr} for this session. ${declineReason}`
        : `Reusing this session's request ${trkorr}.`,
    );
  }

  /** Wraps `granted()` and records the decision so `lastAutoDecision` can quote it. */
  #autoGranted(corrNr: string, source: SessionTrSource, reason: string): SessionTrResolution {
    this.#lastAutoDecision = { trkorr: corrNr, source, reason };
    return granted(corrNr, source, reason);
  }

  /**
   * Single-flight creation. Two writes racing on a cold cache share one
   * promise, so exactly one `trCreate` POST goes out; `created` is true only
   * for the caller that started the flight.
   */
  async #createOnce(
    conn: AbapConnection,
    objSourceUrl: string,
    devClass: string,
  ): Promise<{ trkorr: string; created: boolean }> {
    const existing = this.#inflight;
    if (existing !== undefined) return { trkorr: await existing, created: false };

    const description = this.#buildDescription();
    // Assigned synchronously, before the first await inside #doCreate can
    // yield, so a racer entering resolve() in the same tick sees it.
    const flight = this.#doCreate(conn, objSourceUrl, devClass, description)
      .catch((err: unknown) => {
        // creating → idle: the failure is clean, the next write retries.
        if (this.#state.kind === "creating") this.#state = { kind: "idle" };
        throw err;
      })
      .finally(() => {
        this.#inflight = undefined;
      });
    this.#inflight = flight;
    return { trkorr: await flight, created: true };
  }

  /**
   * ORDERING: the journal hook fires AFTER the server confirms creation, not
   * before. A pre-POST entry can't name a real TRKORR and gets written even
   * for failed creations; the accepted cost of firing after is a crash window
   * between `trCreate` returning and the hook completing, where a numbered
   * request could exist with no journal entry. That window is narrowed as far
   * as possible: the hook is `await`ed before the TRKORR is returned, so it's
   * never used by a write path whose journal entry hasn't landed. See archive
   * for the full trade-off writeup.
   */
  async #doCreate(
    conn: AbapConnection,
    objSourceUrl: string,
    devClass: string,
    description: string,
  ): Promise<string> {
    this.#state = { kind: "creating", since: this.#now().getTime() };
    if (!this.#authorizeCreate) {
      // Fail closed: reaching auto-create with no minter wired is a config
      // bug. Production always wires this (src/server.ts); this only fires
      // for a test exercising auto-create without supplying one.
      throw new Error(
        "SessionTransport: auto-create reached trCreate() with no authorizeCreate() minter " +
          "configured. This is an internal wiring bug, not a safety refusal — see " +
          "SessionTransportOptions.authorizeCreate in src/adt/session-transport.ts.",
      );
    }
    const authorized = this.#authorizeCreate(devClass);
    const created = await this.#cts.trCreate(
      conn,
      {
        objSourceUrl,
        description,
        devClass,
      },
      authorized,
    );
    this.noteCreated(created.trkorr);
    const createdAt = this.#now().toISOString();
    this.#state = {
      kind: "active",
      trkorr: created.trkorr,
      devclass: devClass,
      createdAt,
      origin: "created",
    };
    // The request already exists on the server, so a throw here must not
    // propagate (it would flip state back to idle in #createOnce's catch and
    // report a failed creation for a request that's actually sitting on the
    // appliance). Swallowed, not silent: this is the backstop warning for a
    // handler that fails before it can report its own (src/server.ts).
    try {
      await this.#onCreated?.({
        trkorr: created.trkorr,
        devclass: devClass,
        description,
        createdAt,
        objSourceUrl,
        source: "session-created",
      });
    } catch (err) {
      process.stderr.write(
        `[abapsmith] WARNING: transport request ${created.trkorr} WAS CREATED on the ABAP ` +
          `system (package ${devClass}) but recording it failed: ${(err as Error).message}. ` +
          `Note ${created.trkorr} down NOW — abapsmith has no journal entry for it, and it ` +
          `will not appear in abap_journal. It must be released or deleted by hand.\n`,
      );
    }
    return created.trkorr;
  }

  /**
   * SAP's AS4TEXT field holds 60 characters; deliberately not truncated here
   * — an over-long override should surface as a loud ADT error, not get
   * silently shortened.
   */
  #buildDescription(): string {
    return (
      this.#description ??
      `abapsmith session ${this.#now().toISOString().slice(0, 10)}`
    );
  }

  /** Is `description` one `#buildDescription()` would produce? */
  #isOwnDescription(description: string): boolean {
    const trimmed = description.trim();
    return this.#description !== undefined
      ? trimmed === this.#description.trim()
      : /^abapsmith session \d{4}-\d{2}-\d{2}$/.test(trimmed);
  }

  /**
   * Is `trkorr` a request we can write into right now? Returns `undefined` when
   * it is, or the `denied` resolution explaining why not.
   */
  async #checkUsable(
    conn: AbapConnection,
    trkorr: string,
  ): Promise<SessionTrResolution | undefined> {
    let request;
    try {
      request = await this.#cts.trShow(conn, trkorr);
    } catch (err) {
      if (err instanceof AbapError && err.code === "TRANSPORT_GONE") {
        return denied(
          "corrnr-unusable",
          "TRANSPORT_GONE",
          `Transport request ${trkorr} does not exist in this system.`,
        );
      }
      throw err;
    }
    if (request.status === "released") {
      return denied(
        "corrnr-unusable",
        "TRANSPORT_ERROR",
        `Transport request ${trkorr} has already been released and cannot take further objects.`,
      );
    }
    if (request.status !== "modifiable") {
      return denied(
        "corrnr-unusable",
        "TRANSPORT_LOCKED",
        `Transport request ${trkorr} is ${request.statusText ?? request.status} and cannot take further objects.`,
      );
    }
    const me = this.#whoami();
    if (
      me !== undefined &&
      me !== "" &&
      request.owner !== "" &&
      request.owner.toUpperCase() !== me.toUpperCase() &&
      !request.tasks.some((t) => t.owner.toUpperCase() === me.toUpperCase())
    ) {
      return denied(
        "corrnr-unusable",
        "TRANSPORT_LOCKED",
        `Transport request ${trkorr} belongs to ${request.owner}, and ${me} has no task in it.`,
      );
    }
    return undefined;
  }

  /** `undefined` when the request is still alive, else why it is not. */
  async #probe(
    conn: AbapConnection,
    trkorr: string,
  ): Promise<SessionTrGoneReason | undefined> {
    try {
      const request = await this.#cts.trShow(conn, trkorr);
      return request.status === "released" ? "released" : undefined;
    } catch (err) {
      if (err instanceof AbapError && err.code === "TRANSPORT_GONE") {
        return "not-found";
      }
      throw err;
    }
  }
}
