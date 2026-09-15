/**
 * Debug identity — the `(terminalId, ideId)` pair that names this process to
 * SAP for debugging purposes. Config-driven (`ABAP_TERMINAL_ID` / `ABAP_IDE_ID`)
 * rather than random, because it's the only thing that lets SAP distinguish
 * two MCP processes debugging the same SAP user — both falling back to the
 * derived default compute an IDENTICAL pair from `sid`+`user`. Derivation
 * delegates to `resolveTerminalId`'s `sha256(seed)` fallback in `./client.js`
 * (shared with `bridgeClassName` in `src/adt/run.ts`); not reimplemented here.
 *
 * Wire evidence now backs the exclusivity claim above precisely: the
 * `listener-conflict-409` cassette
 * (`test/cassettes/debugger/listener-conflict-409.cassette.json`) shows SAP
 * answering a second `POST .../debugger/listeners` with `409`/
 * `conflictDetected` (T100 `SY 530`, "Another session already exists with
 * global debugging scope for user X") even though the refused request
 * carried a DIFFERENT `terminalId` from the holder's. So SAP's exclusivity
 * at global/external debugging scope is keyed on the SAP USER, not on
 * `(terminalId, ideId)` at all — no identity scheme this module could
 * produce makes two concurrent sessions for the SAME SAP user work today.
 *
 * `lane` (see `resolveDebugIdentity` below) exists for the cases where a
 * distinct identity per lane DOES matter: multiple abapsmith processes each
 * using a DIFFERENT `ABAP_USER` (SAP's own exclusivity is per-user, so
 * distinct users are genuinely independent), and — should it ever be proven
 * functional — a terminal-scoped debugging mode (`debuggingMode: "terminal"`,
 * modelled elsewhere in this repo but never demonstrated to work). Lanes are
 * NOT a mechanism for parallel debugging of one SAP user; they only make
 * per-lane identity multi-process-*distinguishable*, so a misconfiguration
 * (e.g. two lanes accidentally sharing one identity) fails loud instead of
 * colliding silently.
 */
import type { Config } from "../config.js";
import { resolveTerminalId } from "./client.js";

export type IdentitySource = "config" | "derived" | "lane-derived";

export interface DebugIdentity {
  readonly terminalId: string;
  readonly ideId: string;
  readonly terminalIdSource: IdentitySource;
  readonly ideIdSource: IdentitySource;
  /** Which debug lane (see `src/adt/pool.ts`'s `resolveDebugSessionLimit`) this identity is for. Lane 0 is the historical, sole lane. */
  readonly lane: number;
}

/** Only the four fields identity depends on — keeps callers and tests free of a full Config. */
export type DebugIdentityConfig = Pick<Config, "sid" | "user" | "terminalId" | "ideId">;

/**
 * Resolve the stable `(terminalId, ideId)` pair via `resolveTerminalId`, using
 * the same seeds as `src/tools/debug.ts` for `lane === 0` — do not change
 * that seed format, it would silently rename the SAP session identity for
 * existing callers. `lane` defaults to `0` so every existing caller (which
 * passes none) gets byte-identical output to before lanes existed.
 *
 * `lane > 0` always DERIVES, even when `cfg.terminalId`/`cfg.ideId` are
 * explicitly configured — an explicit value is reused verbatim for lane 0
 * only, then folded into a lane-suffixed seed (`${explicit}:lane${lane}`)
 * for every other lane, since reusing it verbatim for more than one lane
 * would recreate exactly the identity collision explicit configuration
 * exists to avoid.
 */
export function resolveDebugIdentity(cfg: DebugIdentityConfig, lane = 0): DebugIdentity {
  const terminal = resolveLanePart(cfg.terminalId, `${cfg.sid}:${cfg.user}:terminalId`, lane);
  const ide = resolveLanePart(cfg.ideId, `${cfg.sid}:${cfg.user}:ideId`, lane);
  return {
    terminalId: terminal.value,
    ideId: ide.value,
    terminalIdSource: terminal.source,
    ideIdSource: ide.source,
    lane,
  };
}

function resolveLanePart(
  explicit: string | undefined,
  baseSeed: string,
  lane: number,
): { value: string; source: IdentitySource } {
  if (lane === 0) {
    return {
      value: resolveTerminalId({ explicit, seed: baseSeed }),
      source: explicit?.trim() ? "config" : "derived",
    };
  }
  // Lane > 0 never reuses an explicit value verbatim — see the module and
  // function doc comments above for why — so `explicit` is folded into the
  // seed instead of passed through, forcing the hash-derivation path below.
  const trimmedExplicit = explicit?.trim();
  const seed = trimmedExplicit ? `${trimmedExplicit}:lane${lane}` : `${baseSeed}:lane${lane}`;
  return {
    value: resolveTerminalId({ seed }),
    source: "lane-derived",
  };
}

let warned = false;

/**
 * Warn, at most once per process, when either half of the identity was
 * derived rather than explicitly configured — `"derived"` or
 * `"lane-derived"` both count, since both carry the same collision risk
 * (two processes independently deriving the same lane's identity get an
 * IDENTICAL pair either way). Never blocks debugging — derived identity is
 * the default for single-process, single-lane users. Returns `true` iff this
 * call actually warned.
 */
export function warnIfDerivedIdentity(id: DebugIdentity, warn: (m: string) => void): boolean {
  if (warned) return false;
  const derivedParts: string[] = [];
  if (id.terminalIdSource !== "config") derivedParts.push("terminalId");
  if (id.ideIdSource !== "config") derivedParts.push("ideId");
  if (derivedParts.length === 0) return false;
  warned = true;
  const laneNote = id.lane > 0 ? ` (lane ${id.lane})` : "";
  warn(
    `[abapsmith] WARNING: debug identity's ${derivedParts.join(" and ")} ` +
      `${derivedParts.length > 1 ? "were" : "was"} derived from SID+user${laneNote} (not explicitly configured). ` +
      "A second MCP server process for the same SAP user derives the IDENTICAL pair and SAP " +
      "cannot tell the two apart. Only explicitly-configured ABAP_TERMINAL_ID / ABAP_IDE_ID are " +
      "provably multi-process-safe — set them to distinct 32-uppercase-hex values per terminal.",
  );
  return true;
}
