/**
 * The system-role probe, as a reusable test fake.
 *
 * ## Why this file exists
 *
 * `AbapConnection.connect()` runs `detectSystemRole()` (src/adt/connection.ts),
 * which puts exactly ONE `POST /sap/bc/adt/datapreview/freestyle?rowNumber=20`
 * on the wire, reads `T000-CCCATEGORY` for the logon client, and is
 * **fail-closed**: every failure mode — 403, 406, timeout, junk XML, unknown
 * client, no matching row, and *no answer at all* — classifies as
 * `inconclusive`, which the write gate treats exactly like `productive`.
 *
 * A fake `HttpClient` that does not answer that route is therefore not
 * "neutral". It is a system that could not be proven non-productive, so writes
 * are locked out in a way `ABAP_ALLOW_WRITE` **cannot** override. Any safety
 * assertion made on such a connection is answered by the LOCKOUT, not by the
 * gate under test: the test still goes green, but it is certifying that
 * *something* refused, which is far weaker than what its name promises. Three
 * real defects this wave came from exactly that, including a green test that
 * was blessing user-facing advice ("set ABAP_ALLOW_WRITE") which would not have
 * helped, because the real refusal came from the lockout.
 *
 * ## The rule this helper encodes
 *
 * The rule is NOT "never hit the lockout" — the lockout is legitimate behaviour and
 * real fail-closed suites must keep exercising it. The rule is **intent
 * declaration**: a suite either answers the probe, or says out loud that the
 * lockout is the thing it is testing. That is why {@link routeSystemRoleProbe}
 * takes `answer` as a REQUIRED argument. Silence must not be expressible by
 * accident; `"inconclusive"` has to be typed on purpose.
 *
 * `test/system-role-probe-guard.test.ts` enforces the other half: any suite
 * that builds a connection config and answers nothing must appear in that
 * guard's justified allow-list.
 *
 * Nothing here contacts SAP. The bodies are live captures from the A4H
 * appliance (see `test/fixtures/live-captured/INDEX.md`), except the one
 * `productive` answer, which the corpus does not contain and which is
 * constructed explicitly below.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";

/** Same accessor `test/session.test.ts:45` and `test/debug-transport.test.ts:50` use. */
export const LIVE_CAPTURED_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "live-captured",
);

/** Reads one live capture verbatim. Fixture names are the capture ids in INDEX.md. */
export const captured = (name: string): string => readFileSync(join(LIVE_CAPTURED_DIR, name), "utf8");

/** The one path `detectSystemRole()` POSTs to (src/adt/connection.ts:121). */
export const DATA_PREVIEW_PATH = "/sap/bc/adt/datapreview/freestyle";

/**
 * The one Accept/content type the data-preview endpoint speaks
 * (src/adt/connection.ts:129). `Accept: application/xml` answers 406 — a
 * live-proven trap, captured as {@link T000_ACCEPT_TRAP_406}.
 */
export const DATA_PREVIEW_ACCEPT = "application/vnd.sap.adt.datapreview.table.v1+xml";

/** Response headers for a successful data preview. */
export const DATAPREVIEW_XML = {
  "content-type": `${DATA_PREVIEW_ACCEPT}; charset=utf-8`,
};

/**
 * The REAL 200 body the appliance returned for
 * `POST /sap/bc/adt/datapreview/freestyle?rowNumber=20` with
 * `SELECT mandt, cccategory, cccoractiv FROM t000`
 * (capture `087-p3b-datapreview-t000`, 2026-07-31, A4H). Column-major:
 * MANDT `000`/`001`, CCCATEGORY `S`/`C`. So client `001` is CCCATEGORY `C`
 * — a customising client, i.e. provably NON-productive.
 *
 * A config that pairs with these bytes must log on as a client that appears in
 * them (`client: "000"` or `client: "001"`). With no client configured and none
 * in the cookie jar, no row can be attributed, and the verdict is
 * `inconclusive` again — answering the route is necessary but not sufficient.
 */
export const T000_NONPRODUCTIVE = captured("087-p3b-datapreview-t000.xml");

/**
 * NOT A CAPTURE. **The live-capture corpus contains no productive system** —
 * A4H is a sandbox, and no productive SAP was ever available to record, so
 * there is no `CCCATEGORY = "P"` document to load. This is the real capture
 * `087` with client 001's `CCCATEGORY` flipped from `C` to `P`, and nothing
 * else changed. Constructed the same way, for the same stated reason, as
 * `t000WithCategory()` in `test/system-role-detection.test.ts:48`.
 *
 * Treat it as what it is: a document whose SHAPE is live-proven and whose one
 * decisive character is synthetic.
 */
export const T000_PRODUCTIVE_CONSTRUCTED = T000_NONPRODUCTIVE.replace(
  "<dataPreview:data>C</dataPreview:data>",
  "<dataPreview:data>P</dataPreview:data>",
);

/**
 * The REAL 406 the appliance sends when the Accept header is wrong (capture
 * `082-p3b-datapreview-t000`). Its body names the one acceptable type. This is
 * a genuinely captured *inconclusive* answer, which is why the `"inconclusive"`
 * option below does not have to be invented.
 */
export const T000_ACCEPT_TRAP_406 = captured("082-p3b-datapreview-t000.xml");

/** The REAL 403 body (capture `078-p3-datapreview-t000`): `CSRF token validation failed`. */
export const T000_CSRF_403 = captured("078-p3-datapreview-t000.txt");

/**
 * What a suite is declaring about the system its fake stands for.
 *
 *  - `"nonproductive"` — a system `connect()` can PROVE is not productive, on
 *    the real captured bytes. Writes are then decided by configuration alone
 *    (`ABAP_ALLOW_WRITE` / `allowPackages`), which is what most gate tests
 *    actually mean to exercise. Requires `client: "000"` or `client: "001"`.
 *  - `"productive"` — writes locked out because the system says production.
 *    Constructed, not captured; see {@link T000_PRODUCTIVE_CONSTRUCTED}.
 *  - `"inconclusive"` — the fail-closed lockout, ON PURPOSE. Choose this
 *    only when the lockout is the behaviour under test, and say so at the call
 *    site. It is deliberately as much typing as the other two.
 */
export type SystemRoleAnswer = "nonproductive" | "productive" | "inconclusive";

const httpResponse = (
  status: number,
  body: string,
  headers: Record<string, unknown>,
): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

/** True for the one request `detectSystemRole()` makes. */
export const isSystemRoleProbe = (o: { url?: string } | undefined): boolean =>
  typeof o?.url === "string" && o.url.includes(DATA_PREVIEW_PATH);

/**
 * The bytes the appliance would send back for the declared `answer`, ready to
 * return from a hand-rolled fake:
 *
 * ```ts
 * const inner = new CountingClient((o, n) =>
 *   n === 1 ? login()
 *   : isSystemRoleProbe(o) ? systemRoleProbeResponse("nonproductive")
 *   : httpResp(200, "<ok/>", XML));
 * ```
 *
 * Use {@link routeSystemRoleProbe} instead when you can — it wires both halves
 * (the match and the answer) so neither can drift.
 */
export function systemRoleProbeResponse(answer: SystemRoleAnswer): HttpClientResponse {
  switch (answer) {
    case "nonproductive":
      return httpResponse(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
    case "productive":
      return httpResponse(200, T000_PRODUCTIVE_CONSTRUCTED, DATAPREVIEW_XML);
    case "inconclusive":
      // The captured Accept-trap 406. Chosen over a 403 because it is the
      // failure a real misconfigured client actually hits, and over "no answer"
      // because an explicit refusal is what makes the intent visible.
      return httpResponse(406, T000_ACCEPT_TRAP_406, { "content-type": "application/xml" });
  }
}

/**
 * Wrap a fake `HttpClient` so the system-role probe is answered with `answer`.
 *
 * `answer` is REQUIRED and has no default. That is the entire point of this
 * helper: a suite must state what system its fake stands for, and "I never
 * thought about it" must not be spellable.
 *
 * ```ts
 * const inner = routeSystemRoleProbe(new CountingClient(respond), { answer: "nonproductive" });
 * const conn = new AbapConnection(writableCfg(), { httpClient: inner, log: () => {}, breaker: new AuthCircuitBreaker() });
 * ```
 *
 * The wrapped client still forwards the probe request to `fake` before
 * overriding the reply, so a fake that counts or records requests (the
 * `CountingClient` / `RecordingClient` pattern used across these suites) sees
 * the probe exactly as it sees every other request — the count stays honest.
 * Whatever the inner fake returns or throws for that one route is discarded;
 * only `answer` decides. All other routes are untouched.
 *
 * The return value is a Proxy over `fake`, so its own fields (`calls`,
 * `blockedCount`, …) remain readable through it.
 */
export function routeSystemRoleProbe<T extends HttpClient>(
  fake: T,
  options: { answer: SystemRoleAnswer },
): T {
  const { answer } = options;
  return new Proxy(fake, {
    get(target, prop, receiver) {
      if (prop === "request") {
        return async (o: HttpClientOptions): Promise<HttpClientResponse> => {
          if (!isSystemRoleProbe(o)) return await target.request(o);
          // Let the inner fake observe the request (counters, call logs), then
          // discard its answer — including a thrown one — and reply for it.
          try {
            await target.request(o);
          } catch {
            /* the inner fake has no opinion about this route; that is why we are here */
          }
          return systemRoleProbeResponse(answer);
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
