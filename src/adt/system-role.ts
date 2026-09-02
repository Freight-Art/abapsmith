/**
 * System-role / productive-system detection, split out of `connection.ts`.
 * `system-role.ts` and `connection.ts` import each other by design — one
 * responsibility split across two files that are always loaded, versioned
 * and reasoned about together; the identifiers involved are hoisted
 * functions called only after both modules finish evaluating, so the cycle
 * is inert at module-load time.
 *
 * ⚠️ HARD INVARIANT: `probeT000()` below puts exactly one POST on the wire,
 * no retry. The `probeT000` collaborator injected by `AbapConnection` MUST
 * be `noRetryTransport()._request` — never `post()`/`request()` (CSRF-resend
 * path) — or a second POST against T000 can lock a shared account under
 * `login/fails_to_user_lock`. Full story: the git history.
 */
import { XMLParser } from "fast-xml-parser";
import type { Config } from "../config.js";
import { MESSAGE_EXCERPT_MAX, truncateText } from "../truncate.js";
import { describeUnknownError } from "./errors.js";
import {
  DATA_PREVIEW_ACCEPT,
  isAbapTrue,
  logonClientFromCookies,
  normaliseClient,
} from "./wire-values.js";

export interface SystemRoleDetection {
  readonly role: ProductiveRole;
  /** Logon client the decision was made for (from `sap-usercontext`). */
  readonly client: string | null;
  /** Raw `T000-CCCATEGORY` for that client, untouched. */
  readonly ccCategory: string | null;
  /** Human-readable evidence, or why the probe was inconclusive. */
  readonly reason: string;
  /**
   * The raw cause when the probe's reported HTTP status is exactly 0 — the
   * transport's own marker that `httpclient.request()` never resolved to a
   * response (socket hang up, ECONNRESET, a timeout below HTTP), so the
   * rejection was synthesised by the transport rather than thrown from an
   * answer. Absent for a 403/406/500: those reject below `AdtHTTP`, which
   * rewraps them as exceptions whose reported status is not `0`, explained
   * by `reason`. Not a statement about the system's role; the verdict stays
   * `inconclusive` and still fails closed either way.
   */
  readonly probeFailure?: string;
}

/**
 * Deliberately tri-state, not boolean: `"inconclusive"` means the probe
 * could not PROVE the system non-productive, and the write gate treats it
 * exactly like `"productive"`. A boolean would collapse "proven safe" and
 * "unknown" into the same `false` — the fail-open bug this type prevents.
 */
export type ProductiveRole = "productive" | "nonproductive" | "inconclusive";

/** The ADT endpoint that reveals the client's system/ATO settings. */
const ATO_SETTINGS = "/sap/bc/adt/ato/settings";

/** ADT free-style data preview — the only released way to read T000. */
const DATA_PREVIEW = "/sap/bc/adt/datapreview/freestyle";

/** The request body is plain SQL text, `Content-Type: text/plain`. */
const T000_QUERY = "SELECT mandt, cccategory, cccoractiv FROM t000";

/** `parseTagValue: false` is load-bearing: MANDT "000"/"001" are character keys; default numeric coercion would break client matching. */
const dataPreviewXml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

const asArray = <T>(v: T | T[] | undefined): T[] =>
  v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];

/** Shape returned by `noRetryTransport()._request` and `AbapConnection.get()`; kept local to avoid a transport-plumbing import. */
export interface SystemRoleHttpResponse {
  body: string;
  status: number;
  headers?: Record<string, unknown>;
}

/**
 * Collaborators injected from `AbapConnection` so this module carries no
 * HTTP client, breaker, or cookie jar of its own.
 *  - `probeT000` MUST be `noRetryTransport()._request` (ONE POST, NO RETRY —
 *    see the doc on `probeT000()` below).
 *  - `getAtoSettings` uses the ordinary retried `get()` path: a stale CSRF
 *    token there isn't evidence of anything, unlike the T000 probe.
 */
export interface SystemRoleProbes {
  probeT000: (
    url: string,
    opts: Record<string, unknown>,
  ) => Promise<SystemRoleHttpResponse>;
  getAtoSettings: (
    url: string,
    opts: { headers?: Record<string, string> },
  ) => Promise<SystemRoleHttpResponse>;
  /** Current cookie-jar string (`AbapConnection.cookies()`). */
  cookies: () => string | null | undefined;
  assertBreakerClosed: () => void;
  log: (msg: string) => void;
}

/**
 * Turns the column-major data-preview response into the productive/not
 * decision. Takes the whole response (status included), not just the body,
 * because the only response that reaches here is one the transport resolved
 * (a 2xx) — a 2xx that isn't 200 (a 204, say) still must land on `inconclusive`.
 */
export function classifyT000Response(
  resp: { status: number; body: string },
  logonClient: string | null,
): SystemRoleDetection {
  const no = (reason: string, ccCategory: string | null = null): SystemRoleDetection => ({
    role: "inconclusive",
    client: logonClient,
    ccCategory,
    reason,
  });

  if (resp.status !== 200) {
    // The real cause (ICF logon reason, 406's accepted type, short-dump
    // headline) often sits past a short cut; truncateText discloses the cap
    // with integers so a reader can tell "not in here" from "no more to say".
    const snippet = truncateText((resp.body ?? "").replace(/\s+/g, " ").trim(), MESSAGE_EXCERPT_MAX);
    return no(
      `T000 data-preview returned HTTP ${resp.status}${snippet ? `: ${snippet}` : ""} — ` +
        "the system could not be proven non-productive.",
    );
  }
  if (!logonClient) {
    return no(
      "The logon client could not be determined (no sap-client in the sap-usercontext " +
        "cookie and none configured), so no T000 row can be attributed to this session.",
    );
  }

  let columns: Array<{ name: string; values: string[] }>;
  try {
    const doc = dataPreviewXml.parse(resp.body) as Record<string, unknown>;
    const table = doc["tableData"] as Record<string, unknown> | undefined;
    if (!table) return no("T000 data-preview response was not a dataPreview:tableData document.");
    columns = asArray(table["columns"] as Record<string, unknown> | Record<string, unknown>[]).map(
      (col) => {
        const meta = (col["metadata"] ?? {}) as Record<string, unknown>;
        const dataSet = (col["dataSet"] ?? {}) as Record<string, unknown>;
        return {
          name: String(meta["@_name"] ?? "").toUpperCase(),
          values: asArray(dataSet["data"] as string | string[]).map((v) => String(v ?? "")),
        };
      },
    );
  } catch (e) {
    return no(`T000 data-preview response could not be parsed: ${describeUnknownError(e)}`);
  }

  const mandt = columns.find((c) => c.name === "MANDT");
  const cccat = columns.find((c) => c.name === "CCCATEGORY");
  if (!mandt || !cccat) {
    return no(
      `T000 data-preview response is missing MANDT and/or CCCATEGORY (got: ` +
        `${columns.map((c) => c.name).join(", ") || "no columns"}).`,
    );
  }

  // Column-major → row-major: the Nth value of every column is one row.
  const row = mandt.values.findIndex((m) => normaliseClient(m) === normaliseClient(logonClient));
  if (row < 0) {
    return no(
      `T000 has no row for the logon client ${logonClient} ` +
        `(clients returned: ${mandt.values.map((m) => m.trim()).join(", ") || "none"}).`,
    );
  }

  const raw = cccat.values[row] ?? "";
  const cc = raw.trim().toUpperCase();
  if (!cc) {
    return no(`T000-CCCATEGORY is empty for client ${logonClient}.`, raw);
  }
  if (cc === "P") {
    return {
      role: "productive",
      client: logonClient,
      ccCategory: raw,
      reason: `T000-CCCATEGORY = "P" (production) for logon client ${logonClient}.`,
    };
  }
  // Allowlist by inclusion, not `cc !== "P"` exclusion: an unrecognised
  // value must fail closed like every other unknown case in this function.
  // T/C/D/E are the standard SAP categories; S (SAP reference) is not
  // speculative — the project's own live capture has A4H client 000 at "S"
  // (test/fixtures/live-captured/087-p3b-datapreview-t000.xml, see also
  // INDEX.md's "087 detail"), so omitting it would lock writes on a real
  // client this project connects to.
  if (["T", "C", "D", "E", "S"].includes(cc)) {
    return {
      role: "nonproductive",
      client: logonClient,
      ccCategory: raw,
      reason: `T000-CCCATEGORY = "${cc}" (recognised non-productive client role) for logon client ${logonClient}.`,
    };
  }
  return no(
    `T000-CCCATEGORY = "${cc}" for logon client ${logonClient} is not a recognised ` +
      "client role (P/T/C/D/E/S), so the system could not be proven non-productive.",
    raw,
  );
}

/**
 * Is this a productive system? Authoritative source: `T000-CCCATEGORY` for
 * the logon client, via ONE `POST /sap/bc/adt/datapreview/freestyle`. `P` =
 * production. (`runtime/workprocesses` is 405 on both verbs and `ato/settings`
 * names no role on this release, so neither can carry the decision alone;
 * `ato/settings` is consulted only as a one-way escalation to `productive`.)
 *
 * Every failure — 403, 406, timeout, bad XML, unknown client, no matching
 * row — returns `inconclusive`, treated by the write gate exactly like
 * `productive`. No retries (see `probeT000`). Deliberately does not cache:
 * whether a prior DEFINITIVE answer still stands is decided by
 * `AbapConnection` before this is ever called (see its call site in `connect()`).
 */
export async function detectSystemRole(
  probes: SystemRoleProbes,
  cfg: Pick<Config, "client">,
): Promise<SystemRoleDetection> {
  return await escalateIfAtoSaysProductive(probes, await probeT000(probes, cfg));
}

/**
 * ONE POST. NO RETRY. Do not route this through `post()`/`request()`, and
 * do not "just resend it once to be sure" — a stale CSRF token is the only
 * thing a retry could fix, and this probe runs milliseconds after `login()`
 * captured a fresh one, so a 403 here IS the answer (`inconclusive`), not a
 * transient. This used to send 4 POSTs (two independent retry layers
 * stacking) for a single 403, which is how a shared account risks a
 * `login/fails_to_user_lock` lockout. Fewer attempts can only ever move the
 * verdict TOWARDS fail-closed. Full incident and safety argument:
 * the git history. A failure whose status is exactly 0 — the transport
 * reporting that `httpclient.request()` itself never resolved, rather than
 * rejecting on an answered 403/406/500 that `AdtHTTP` rewraps — is still
 * `inconclusive`, and reports its cause through `SystemRoleDetection.probeFailure`
 * so a caller can tell it from an answer it did not like.
 */
async function probeT000(
  probes: SystemRoleProbes,
  cfg: Pick<Config, "client">,
): Promise<SystemRoleDetection> {
  const client = logonClientFromCookies(probes.cookies()) ?? (cfg.client || null);
  try {
    const resp = await probes.probeT000(DATA_PREVIEW, {
      method: "POST",
      qs: { rowNumber: "20" },
      headers: { Accept: DATA_PREVIEW_ACCEPT, "Content-Type": "text/plain" },
      body: T000_QUERY,
    });
    return classifyT000Response(resp, client);
  } catch (e) {
    probes.assertBreakerClosed();
    // httpclient.request() rejects on an answered 4xx/5xx before AdtHTTP's own status
    // check runs, so what lands here carries no `.response` — only the message is recoverable.
    const cause = describeUnknownError(e);
    const reason = `T000 data-preview probe failed: ${cause}`;
    if ((e as { status?: unknown }).status === 0) {
      return { role: "inconclusive", client, ccCategory: null, reason, probeFailure: cause };
    }
    return { role: "inconclusive", client, ccCategory: null, reason };
  }
}

/**
 * One-way ratchet towards `productive`. Never downgrades: an `ato/settings`
 * that says nothing (the A4H case) leaves the T000 verdict untouched.
 */
async function escalateIfAtoSaysProductive(
  probes: SystemRoleProbes,
  detection: SystemRoleDetection,
): Promise<SystemRoleDetection> {
  if (detection.role === "productive") return detection;
  try {
    const { body } = await probes.getAtoSettings(ATO_SETTINGS, { headers: { Accept: "application/*" } });
    const attr = (name: string): string | undefined =>
      new RegExp(`${name}="([^"]*)"`, "i").exec(body)?.[1];
    const isProduction = attr("isProductionSystem") ?? attr("productionSystem");
    if (isAbapTrue(isProduction)) {
      return {
        role: "productive",
        client: detection.client,
        ccCategory: detection.ccCategory,
        reason:
          `ato/settings reports isProductionSystem="${isProduction}". ` +
          `(T000 probe said: ${detection.reason})`,
      };
    }
  } catch (e) {
    probes.assertBreakerClosed();
    probes.log(
      "[abapsmith] ato/settings probe failed (non-fatal — it can only escalate to " +
        `productive): ${describeUnknownError(e)}`,
    );
  }
  return detection;
}
