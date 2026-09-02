/**
 * Cassette -> FakeRoute generation.
 *
 * ## Outcome taken: PREFERRED, wired into the real `FakeAdtOptions.routes` seam
 *
 * `test/helpers/fake-adt.ts` already exposes exactly the seam this needs:
 * `FakeAdtOptions.routes?: readonly FakeRoute[]` (its own doc comment: "Consulted,
 * in order, before the builtin routes"), and `FakeAdtServer#route()` tries every
 * entry of `this.customRoutes` — populated verbatim from `options.routes` in the
 * constructor — before falling through to any builtin behaviour. That means a
 * cassette-derived `FakeRoute` can answer a request with ZERO changes to
 * fake-adt.ts: this module only imports the `FakeRequest`/`FakeRoute` TYPES
 * (type-only import, erased at build time — no runtime coupling) and produces
 * plain values of that type. Nothing here is wired into the 2,361-line file by
 * default; a caller opts in explicitly via `new FakeAdtServer({ routes:
 * generateFakeRoutesFromCassettes(loadAllCassettes()) })`, so existing tests
 * that construct `FakeAdtServer` without this are completely unaffected.
 *
 * Full migration of the ~2,300 lines of hand-authored routes in fake-adt.ts to
 * be cassette-generated is deliberately OUT OF SCOPE here (see
 * `cassette-lint.test.ts`'s non-blocking legacy-coverage report) — this module
 * only proves the generation mechanism works end to end for every cassette
 * that exists today, faithfully (see `cassette-replay.test.ts`).
 */
import type { FakeRequest, FakeRoute } from "../helpers/fake-adt.js";

import type { Cassette } from "./schema.js";

/**
 * Does `request` match `cassette.request`?
 *
 * Matches on METHOD + PATH (verbatim string, no normalisation — cassette
 * paths already include their query string, and `FakeRequest.url` is
 * `options.url` verbatim per fake-adt.ts's own doc comment) AND request BODY.
 *
 * The body join is not a defensive nicety, it is REQUIRED for correctness
 * against the actual fixtures in this tree: `bp-reject-inband` and
 * `bp-set-accepted` (`test/cassettes/debugger/`) both capture
 * `POST /sap/bc/adt/debugger/breakpoints` — same method, same path — but
 * with two different request bodies and two genuinely different outcomes (an
 * in-band-rejected breakpoint vs two accepted ones). A route keyed on
 * method+path alone would let whichever of the two sorts first in the array
 * silently answer for both requests, which is exactly the "fake diverges
 * from what actually happened" failure mode this whole cassette mechanism
 * exists to prevent.
 */
function cassetteRequestMatches(cassette: Cassette, request: FakeRequest): boolean {
  if (request.method !== cassette.request.method) return false;
  if (request.url !== cassette.request.path) return false;
  const expectedBody = cassette.request.body ?? undefined;
  return request.body === expectedBody;
}

/**
 * Build one `FakeRoute` that answers exactly the request `cassette` recorded
 * with exactly the response bytes it recorded, and returns `undefined`
 * ("not mine" — the `FakeRoute` convention) for every other request.
 *
 * `HttpClientResponse.body` and `.statusText` are non-nullable `string`
 * fields (`abap-adt-api/build/AdtHTTP.d.ts`): a cassette's
 * `response.body === null` (a genuinely empty body, e.g. most 200s with
 * `content-length: 0`) maps to `""`. `statusText` is never captured by the
 * cassette format and never asserted by anything in this repo, so it is left
 * `""` rather than invented from a lookup table.
 */
function cassetteToFakeRoute(cassette: Cassette): FakeRoute {
  return (request: FakeRequest) => {
    if (!cassetteRequestMatches(cassette, request)) return undefined;
    return {
      status: cassette.response.status,
      statusText: "",
      body: cassette.response.body ?? "",
      headers: { ...cassette.response.headers },
    };
  };
}

/**
 * Turn a list of cassettes into `FakeRoute` values, one per cassette, in the
 * same order they were given.
 *
 * Pure: no I/O, no mutation of `cassettes`, no shared/global state — calling
 * this twice with the same input produces two independent route lists that
 * behave identically. Wire the result into `FakeAdtOptions.routes` (optionally
 * concatenated with hand-authored routes — `customRoutes` are tried in array
 * order, first match wins, so put cassette-derived routes first if a
 * hand-authored route would otherwise shadow one of them).
 */
export function generateFakeRoutesFromCassettes(cassettes: readonly Cassette[]): FakeRoute[] {
  return cassettes.map(cassetteToFakeRoute);
}
