/**
 * `buildErrorPayload`'s raw-throw branch (`src/tool-errors.ts`, the `else` of
 * `isAbapError(e)`) is the one classification path that never goes through
 * `translateAdtError` — a documented gap, reused here. It already ran
 * `isLockConflict`/`isNotFoundError`, but omitted the session-death check
 * `translateAdtError` runs FIRST and at highest precedence — its `wireDeath`
 * check, `classifySessionFailure(info?.response)` (src/adt/session.ts) — so a
 * raw vendor throw carrying a dead session used to fall through to a bare
 * `ADT_ERROR` — no indication that reconnecting is the remedy. Same defect,
 * same fix shape, as `ctsError`'s session-death check
 * (src/adt/transports.ts).
 *
 * This is a narrow consistency fix, not a resolution of the underlying
 * defect: its actual root cause (what a post-undo-delete read's 400 body really contains) is
 * not established here — only that the envelope it reported (`adt.code` set
 * via `adtEnvelopeFromThrown`) proves the throw took this raw-throw branch.
 *
 * Raw vendor throws are built the same way `test/session.test.ts`'s
 * `axiosLeakLikeException` does (real `HttpClientException` +
 * `abap-adt-api`'s own `fromException`), and response bodies reuse
 * `test/helpers/fake-adt.ts`'s exported, confirmed-live fixtures
 * (`sessionTimedOut400`, `lockConflict403`) rather than hand-rolled shapes.
 */
import { describe, expect, it } from "vitest";
import { fromException } from "abap-adt-api/build/AdtException.js";
import { HttpClientException, type HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { buildErrorPayload, errorResult } from "../src/tool-errors.js";
import { fakeResponse, lockConflict403, sessionTimedOut400 } from "./helpers/fake-adt.js";

function envelope(res: CallToolResult): Record<string, any> {
  const text = (res.content[0] as { type: "text"; text: string }).text;
  return JSON.parse(text);
}

/** Mirrors `test/session.test.ts`'s `axiosLeakLikeException`, generalised to take any response fixture. */
function rawThrowFromResponse(res: HttpClientResponse): unknown {
  const httpErr = new HttpClientException(
    `Request failed with status code ${res.status}`,
    "ERR_BAD_REQUEST",
    res.status,
    {},
    {},
    res,
    undefined,
  );
  try {
    throw fromException(httpErr, {});
  } catch (e) {
    return e;
  }
}

const NOT_FOUND_404 = (): HttpClientResponse =>
  fakeResponse(
    404,
    `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
      `<type id="ExceptionResourceNotFound"/><message lang="EN">Object does not exist</message></exc:exception>`,
    { "content-type": "application/xml" },
  );

describe("raw-throw branch classifies session death ahead of lock/not-found", () => {
  it("a raw throw carrying ICMENOSESSION yields SESSION_DEAD, not ADT_ERROR", () => {
    const e = rawThrowFromResponse(sessionTimedOut400());
    const body = envelope(errorResult(e));
    expect(body.error).toBe("SESSION_DEAD");
    expect(body.error).not.toBe("ADT_ERROR");
    expect(typeof body.hint).toBe("string");
    expect(body.hint).toMatch(/retry the operation once/i);
  });

  it("buildErrorPayload agrees with errorResult for the SESSION_DEAD raw throw", () => {
    const e = rawThrowFromResponse(sessionTimedOut400());
    expect(buildErrorPayload(e)).toEqual(envelope(errorResult(e)));
  });

  it("precedence guard: a genuine raw lock conflict (423-shaped 403 ExceptionResourceNoAccess) still yields LOCKED", () => {
    const e = rawThrowFromResponse(lockConflict403({ user: "DEVELOPER", objectName: "ZCL_LOCKED" }));
    const body = envelope(errorResult(e));
    expect(body.error).toBe("LOCKED");
    expect(body.error).not.toBe("SESSION_DEAD");
  });

  it("precedence guard: a genuine raw 404 still yields NOT_FOUND", () => {
    const e = rawThrowFromResponse(NOT_FOUND_404());
    const body = envelope(errorResult(e));
    expect(body.error).toBe("NOT_FOUND");
    expect(body.error).not.toBe("SESSION_DEAD");
  });
});
