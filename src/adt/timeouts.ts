/**
 * Per-family client-side request timeouts (issue #154).
 *
 * `timeoutMs` (`ABAP_TIMEOUT_MS`) stays the default for every request. Four
 * operations regularly run longer than that on a live system — BOPF
 * create_bo/activate, DDIC activation, abap_run classruns, and abap_search's
 * repository quick search — so each gets its own configurable ceiling
 * instead of forcing one number to fit all of them.
 */
import type { Config } from "../config.js";
import { AbapError } from "./errors.js";
import { adtExceptionInfo } from "./session.js";
import { isTimeoutError } from "./source.js";

export type TimeoutFamily = "bopf" | "activate" | "run" | "search";

/** The env var that configures each family's timeout — for messages/hints. */
export const TIMEOUT_ENV_VAR: Readonly<Record<TimeoutFamily, string>> = {
  bopf: "ABAP_BOPF_TIMEOUT_MS",
  activate: "ABAP_ACTIVATE_TIMEOUT_MS",
  run: "ABAP_RUN_TIMEOUT_MS",
  search: "ABAP_SEARCH_TIMEOUT_MS",
};

/** This family's configured timeout, in milliseconds. */
export function familyTimeoutMs(
  cfg: Pick<Config, "bopfTimeoutMs" | "activateTimeoutMs" | "runTimeoutMs" | "searchTimeoutMs">,
  family: TimeoutFamily,
): number {
  switch (family) {
    case "bopf":
      return cfg.bopfTimeoutMs;
    case "activate":
      return cfg.activateTimeoutMs;
    case "run":
      return cfg.runTimeoutMs;
    case "search":
      return cfg.searchTimeoutMs;
  }
}

/**
 * The longest of the default and every per-family request timeout. Used to
 * size `SessionLock.waitTimeoutMs`: a caller queued behind the slowest
 * possible in-flight request must not be refused `SESSION_BUSY` before that
 * request can finish.
 */
export function longestRequestTimeoutMs(
  cfg: Pick<Config, "timeoutMs" | "bopfTimeoutMs" | "activateTimeoutMs" | "runTimeoutMs" | "searchTimeoutMs">,
): number {
  return Math.max(cfg.timeoutMs, cfg.bopfTimeoutMs, cfg.activateTimeoutMs, cfg.runTimeoutMs, cfg.searchTimeoutMs);
}

/**
 * A response-less transport failure that looks like a timeout. On the wire
 * `AxiosHttpClient` wraps an axios abort as an `HttpClientException` with
 * `code: "ECONNABORTED"` and no `status`; `AdtHTTP._request` then rewraps it
 * as an `AdtHttpException`, whose `status` getter answers `0` — so "no
 * status" here means `undefined` OR `0`, never a real HTTP status, and there
 * must be no response body to read.
 */
export function isTransportTimeout(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const info = adtExceptionInfo(e);
  if (info !== undefined) {
    if (info.status !== undefined && info.status !== 0) return false;
    if (info.response !== undefined) return false;
  }
  return isTimeoutError(e);
}

/** Context for minting a per-family transport-timeout {@link AbapError}. */
export interface TransportTimeoutContext {
  family: TimeoutFamily;
  operation: string;
  name: string;
  type?: string;
  uri?: string;
  timeoutMs: number;
  cause: unknown;
}

/**
 * The `TIMEOUT` envelope for a request abandoned client-side before any
 * response arrived. `RETRYABILITY.TIMEOUT` is `"conditional"` — this mint
 * site does not know yet whether the operation actually landed on the
 * server, so it takes no 5th-argument override and leaves `retryable`
 * undefined; callers that re-read the object decide retryability themselves
 * from what they find.
 */
export function transportTimeoutError(ctx: TransportTimeoutContext): AbapError {
  const envVar = TIMEOUT_ENV_VAR[ctx.family];
  const err = new AbapError(
    "TIMEOUT",
    `${ctx.operation} of ${ctx.name} did not answer within ${ctx.timeoutMs} ms (${envVar}); ` +
      "the request was abandoned client-side and the server may still be working on it.",
    {
      operation: ctx.operation,
      name: ctx.name,
      ...(ctx.type !== undefined ? { type: ctx.type } : {}),
      ...(ctx.uri !== undefined ? { uri: ctx.uri } : {}),
      timeoutMs: ctx.timeoutMs,
      family: ctx.family,
      envVar,
      timeout: true,
    },
    `Raise ${envVar} if this operation legitimately needs longer. Re-read ${ctx.name} before ` +
      "retrying: the server does not stop working when the client gives up.",
  );
  err.cause = ctx.cause;
  return err;
}
