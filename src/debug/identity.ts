/**
 * Debug identity — the `(terminalId, ideId)` pair that names this process to
 * SAP for debugging purposes. Config-driven (`ABAP_TERMINAL_ID` / `ABAP_IDE_ID`)
 * rather than random, because it's the only thing that lets SAP distinguish
 * two MCP processes debugging the same SAP user — both falling back to the
 * derived default compute an IDENTICAL pair from `sid`+`user`. Derivation
 * delegates to `resolveTerminalId`'s `sha256(seed)` fallback in `./client.js`
 * (shared with `bridgeClassName` in `src/adt/run.ts`); not reimplemented here.
 *
 * No configuration of two concurrent debug listeners for one SAP user
 * actually works — measured failure modes (both same-identity and
 * different-identity cases) archived in
 * the git history. This module enables NO parallel
 * debugging; it only makes single-process identity multi-process-
 * *distinguishable*, so misconfiguration fails loud instead of colliding
 * silently.
 */
import type { Config } from "../config.js";
import { resolveTerminalId } from "./client.js";

export type IdentitySource = "config" | "derived";

export interface DebugIdentity {
  readonly terminalId: string;
  readonly ideId: string;
  readonly terminalIdSource: IdentitySource;
  readonly ideIdSource: IdentitySource;
}

/** Only the four fields identity depends on — keeps callers and tests free of a full Config. */
export type DebugIdentityConfig = Pick<Config, "sid" | "user" | "terminalId" | "ideId">;

/**
 * Resolve the stable `(terminalId, ideId)` pair via `resolveTerminalId`, using
 * the same seeds as `src/tools/debug.ts` — do not change the seed format, it
 * would silently rename the SAP session identity for existing callers.
 */
export function resolveDebugIdentity(cfg: DebugIdentityConfig): DebugIdentity {
  const terminalId = resolveTerminalId({
    explicit: cfg.terminalId,
    seed: `${cfg.sid}:${cfg.user}:terminalId`,
  });
  const ideId = resolveTerminalId({
    explicit: cfg.ideId,
    seed: `${cfg.sid}:${cfg.user}:ideId`,
  });
  return {
    terminalId,
    ideId,
    terminalIdSource: cfg.terminalId?.trim() ? "config" : "derived",
    ideIdSource: cfg.ideId?.trim() ? "config" : "derived",
  };
}

let warned = false;

/**
 * Warn, at most once per process, when either half of the identity was
 * derived rather than explicitly configured. Never blocks debugging — derived
 * identity is the default for single-process users. Returns `true` iff this
 * call actually warned.
 */
export function warnIfDerivedIdentity(id: DebugIdentity, warn: (m: string) => void): boolean {
  if (warned) return false;
  const derivedParts: string[] = [];
  if (id.terminalIdSource === "derived") derivedParts.push("terminalId");
  if (id.ideIdSource === "derived") derivedParts.push("ideId");
  if (derivedParts.length === 0) return false;
  warned = true;
  warn(
    `[abapsmith] WARNING: debug identity's ${derivedParts.join(" and ")} ` +
      `${derivedParts.length > 1 ? "were" : "was"} derived from SID+user (not explicitly configured). ` +
      "A second MCP server process for the same SAP user derives the IDENTICAL pair and SAP " +
      "cannot tell the two apart. Only explicitly-configured ABAP_TERMINAL_ID / ABAP_IDE_ID are " +
      "provably multi-process-safe — set them to distinct 32-uppercase-hex values per terminal.",
  );
  return true;
}
