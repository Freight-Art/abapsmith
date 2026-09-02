/**
 * Configuration.
 *
 * Everything comes from the environment (optionally seeded from a `.env` file).
 * The password is never logged, never serialised, and never included in an
 * error message.
 */
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

import { isTrkorr } from "./adt/transports.js";
import { DEFAULT_MAX_CHARS } from "./compact.js";
// Re-exported so config-only tests can pin `maxResponseChars`'s default
// without importing compact.js directly (see test/system-role-probe-guard.test.ts).
export { DEFAULT_MAX_CHARS } from "./compact.js";
import {
  type AbapCapabilities,
  type AbapMode,
  type AbapModeBooleanOverrides,
  type AbapModeGrants,
  type AbapModeOverrides,
  capabilitiesForMode,
  ENHANCE_TARGETS_VALUES,
  type EnhanceTargetsValue,
  MODE_GOVERNED_LEGACY_ENV_VARS,
  MODE_OVERRIDE_ENV_VARS,
  parseAbapMode,
} from "./mode.js";
// Imported (not re-implemented) so the `*` wildcard token's meaning lives in
// one place. Safe as a value import: safety.ts reaches config.ts only via an
// erased `import type`, so there's no runtime cycle.
import { isUnrestrictedPrefixList } from "./safety.js";

let dotenvLoaded = false;

/** Load `.env` once. Real environment variables always win. */
export function loadEnvFile(path?: string): void {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  loadDotenv(path ? { path, quiet: true } : { quiet: true });
}

/**
 * Strips userinfo credentials out of a URL; DELIBERATELY leaves the host
 * intact. `ABAP_URL` may legally embed a real password
 * (`http://user:pass@host:50000`), and every place that echoes the URL
 * would otherwise leak it to stderr. Redacts rather than rejects — the
 * credential still has to reach the transport. A caller that needs a
 * host-free string must use `describeUrlWithoutHost`.
 */
export function stripUrlCredentials(url: string): string {
  if (typeof url !== "string" || !url.includes("@")) return url;
  try {
    const u = new URL(url);
    if (!u.password && !u.username) return url;
    if (u.password) u.password = "***";
    return u.toString().replace(/\/$/, url.endsWith("/") ? "/" : "");
  } catch {
    // Regex fallback for a URL the URL parser rejects: replace after the
    // first `:` in the userinfo, anchored to the scheme.
    return url.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/@:]+):[^/@]*@/i, "$1:***@");
  }
}

/**
 * Host-free descriptor of a URL for warning lines that land in raw
 * captured output where no caller-side sink can rewrite them. The host is
 * the thing that actually leaks — `stripUrlCredentials` does not remove
 * it — so this never returns a string containing the host.
 */
export function describeUrlWithoutHost(url: string): string {
  try {
    const u = new URL(url);
    // `u.port` is blank for a default port (e.g. :443 on https) — WHATWG
    // URL drops it — so an explicit port is read back off the original
    // string instead of off the parsed object.
    const port = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?[^/?#:]+:(\d+)/i.exec(url)?.[1];
    return port ? `${u.protocol}//…:${port}` : `${u.protocol}//…`;
  } catch {
    const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
    return m ? `${m[1]}://…` : "(unparseable URL)";
  }
}

/**
 * True only when the URL carries a userinfo PASSWORD (not just a
 * username). Used instead of comparing `stripUrlCredentials` output to
 * input, because WHATWG URL normalisation (e.g. lower-casing the host)
 * can make that round-trip differ even with no password present.
 */
export function urlHasEmbeddedPassword(url: string): boolean {
  if (typeof url !== "string" || !url.includes("@")) return false;
  try {
    const u = new URL(url);
    return u.password !== "";
  } catch {
    return /^[a-z][a-z0-9+.-]*:\/\/[^/@:]+:[^/@]*@/i.test(url);
  }
}

// Attribute names that ride along in a copied `Cookie:` header but are never
// themselves a cookie — matched case-insensitively, bare or with a value.
const COOKIE_ATTRIBUTE_NAMES = new Set([
  "path",
  "domain",
  "secure",
  "httponly",
  "expires",
  "max-age",
  "samesite",
]);

/**
 * Parses an `ABAP_SESSION_COOKIE` value — a `Cookie:`-request-header-shaped
 * string, as an operator would copy it out of a browser's network tab — into
 * a flat name-to-value map. Exported for direct unit testing and for reuse by
 * any later cookie-refresh logic.
 *
 * Splits on `;`, trims both sides, and splits each pair on the FIRST `=`
 * only: SAP's `sap-usercontext` cookie has a value that is itself a
 * query-string blob containing further `=`/`&`, and splitting on every `=`
 * truncates it into something present, plausible and wrong. A fragment with
 * no `=`, or an empty name, is skipped rather than fatal — a pasted header
 * commonly has trailing junk. `Path`/`Domain`/`Secure`/`HttpOnly`/`Expires`/
 * `Max-Age`/`SameSite` are dropped by name, not evaluated: an `Expires` in
 * the past must not drop the cookie — only the server knows whether a
 * session is still alive, and a client-side expiry check turns a working
 * session into a startup failure. Later duplicate names win (plain Map
 * assignment order).
 */
export function parseSessionCookie(raw: string): ReadonlyMap<string, string> {
  const cookies = new Map<string, string>();
  for (const fragment of raw.split(";")) {
    const eq = fragment.indexOf("=");
    if (eq === -1) continue;
    const name = fragment.slice(0, eq).trim();
    if (!name || COOKIE_ATTRIBUTE_NAMES.has(name.toLowerCase())) continue;
    cookies.set(name, fragment.slice(eq + 1).trim());
  }
  return cookies;
}

// Prefixes that make a captured cookie set LOOK like an authenticated
// session — used only to decide whether to warn, never to filter what is
// sent (the whole set always goes out; we can't know which cookie a
// landscape's routing layer depends on). Case-sensitive, prefix not
// equality: the real ABAP session-id name is this prefix plus system id and
// client (e.g. SAP_SESSIONID_A4H_001).
const SESSION_LIKE_COOKIE_PREFIXES = ["MYSAPSSO2", "SAP_SESSIONID_", "JSESSIONID"];

/** `sap-usercontext` deliberately does not count — set before logon completes, so counting it is a false "authenticated" verdict mid-handshake. */
function looksLikeSessionCookieSet(names: Iterable<string>): boolean {
  for (const name of names) {
    if (SESSION_LIKE_COOKIE_PREFIXES.some((p) => name.startsWith(p))) return true;
  }
  return false;
}

const boolish = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => {
    if (typeof v === "boolean") return v;
    if (v === undefined) return false;
    return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
  });

/**
 * Like {@link boolish}, but unset stays `undefined` rather than collapsing to
 * `false` — needed by `serialiseSameObjectWrites`, whose actual default is
 * decided downstream (`FileLockObjectGate`, `src/adt/pool.ts`) and which must
 * tell "never set" apart from "explicitly opted out". Only use this for a
 * field whose default isn't simply `false`; any non-truthy string (including
 * `""`) still coerces to `false`, so `ABAP_SERIALISE_SAME_OBJECT_WRITES=` is
 * an explicit opt-out, not a no-op.
 */
const boolishTri = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => {
    if (typeof v === "boolean") return v;
    if (v === undefined) return undefined;
    return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
  });

/**
 * Opposite polarity from {@link boolish}/{@link boolishTri}: a reject-list,
 * default-`true` coercion for flags whose safe behaviour is what a
 * deployment gets by setting nothing. Unset/empty → `true`;
 * `"false"`/`"0"`/`"no"`/`"off"` (case-insensitive) → `false`; anything else
 * → `true`. Mirrors `resolveCrossProcessDebugLock` (`src/debug/arm-lock.ts`)
 * and `resolveCrossProcessObjectLock` (`src/adt/object-gate.ts`)
 * byte-for-byte; kept local rather than imported so `config.ts` has no
 * dependency on `src/debug` or `src/adt`.
 */
const boolishRejectDefaultTrue = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => {
    if (typeof v === "boolean") return v;
    if (v === undefined) return true;
    const s = v.trim().toLowerCase();
    if (s === "") return true;
    return !["false", "0", "no", "off"].includes(s);
  });

/**
 * Numeric coercion that falls back to `defaultMs` on out-of-range or
 * unparseable input, rather than clamping or hard-failing like the
 * `z.coerce.number()` fields elsewhere in this schema (e.g. `lockWaitMs`) —
 * clamping would look like the setting took effect when it didn't. Mirrors
 * `resolveDebugLockWaitMs`/`resolveObjectLockWaitMs`
 * (`src/debug/arm-lock.ts`, `src/adt/object-gate.ts`).
 */
function softBoundedMsSchema(defaultMs: number, minMs: number, maxMs: number) {
  return z
    .union([z.number(), z.string()])
    .optional()
    .transform((v) => {
      if (v === undefined) return defaultMs;
      const raw = typeof v === "number" ? String(v) : v;
      if (raw.trim() === "") return defaultMs;
      const n = Number(raw.trim());
      if (!Number.isFinite(n) || n < 0) return defaultMs;
      const ms = Math.floor(n);
      if (ms < minMs || ms > maxMs) return defaultMs;
      return ms;
    });
}

/**
 * `ABAP_VERIFY_WRITES` — how hard abapsmith and its callers work to prove a
 * write landed. `"speculative"` (default) treats a create/activate that
 * returned without error as sufficient. `"verified"` reads the object back
 * and confirms it after a successful write. See the `verifyWrites` schema
 * field below for the full posture.
 */
export type VerifyWritesMode = "speculative" | "verified";

export const ConfigSchema = z.object({
  /** ADT base URL, e.g. http://host:50000 — no path, no query string. */
  url: z
    .string()
    .min(1, "ABAP_URL is required")
    .refine((u) => /^https?:\/\//i.test(u), "ABAP_URL must start with http:// or https://")
    .refine((u) => !u.includes("?"), "ABAP_URL must not contain a query string")
    .transform((u) => u.replace(/\/+$/, "")),
  user: z.string().min(1, "ABAP_USER is required"),
  /**
   * Optional here even though exactly one of password/`sessionCookie` is
   * required: keeping `.min(1, "ABAP_PASSWORD is required")` would fail the
   * schema before the exactly-one-of check below ever runs, telling an
   * operator who deliberately supplied a cookie that their password is
   * missing. Mutual exclusivity is enforced by hand in `loadConfig`
   * (`credentialIssue`), the same pattern `abapModeIssue` uses just below —
   * not `.refine()` (see `:1316` for why).
   */
  password: z.string().min(1).optional(),
  /**
   * Parsed `ABAP_SESSION_COOKIE` — an alternative to `password` for
   * SSO-fronted systems that don't accept one. A `ReadonlyMap`, never the raw
   * header string: `JSON.stringify(new Map(...))` is `"{}"`, so an accidental
   * serialisation of this field is inert on top of `redactConfigSecrets`'s
   * allowlist, and the raw string never lives on `Config` at all — only
   * inside `parseSessionCookie`. Populated by hand before `safeParse`,
   * mirroring how `abapMode` is resolved outside the schema.
   */
  sessionCookie: z.custom<ReadonlyMap<string, string>>().optional(),
  /**
   * Logon client — documentation only by default; see `sendClientParam`.
   * Appending `?sap-client=` breaks login on some systems (observed on A4H).
   */
  client: z.string().default(""),
  /**
   * Opt-in: actually send `sap-client` as a URL parameter. Off by default.
   * Only enable on systems that are known to accept it.
   */
  sendClientParam: boolish,
  sid: z.string().default("UNKNOWN"),
  language: z.string().default(""),
  /** TLS verification off. Opt-in, warns on stderr every time. */
  insecure: boolish,
  /**
   * Stable terminal id for the debugger. Currently unused. 32
   * uppercase hex (SYSUUID_C32).
   */
  terminalId: z
    .string()
    .refine(
      (v) => /^[0-9A-F]{32}$/.test(v),
      "ABAP_TERMINAL_ID must be exactly 32 uppercase hex characters (SYSUUID_C32) — the server does not normalise case, so lowercase hex names a different session",
    )
    .optional(),
  /**
   * Stable IDE id for the debugger (`ABAP_IDE_ID`), 32 uppercase hex
   * (SYSUUID_C32). Distinguishes processes to SAP but does NOT grant a second
   * concurrent global-scope debug session — measured: listener exclusivity is
   * keyed on the `(user, terminalId, ideId)` triple, so a distinct id here is
   * what makes a second arm conflict (409/conflictDetected), not what avoids
   * it. Terminal-scope listeners are not a workaround either.
   */
  ideId: z
    .string()
    .refine(
      (v) => /^[0-9A-F]{32}$/.test(v),
      "ABAP_IDE_ID must be exactly 32 uppercase hex characters (SYSUUID_C32) — the server does not normalise case, so lowercase hex names a different session",
    )
    .optional(),
  timeoutMs: z.coerce.number().int().positive().default(60_000),
  /** How long to wait for the cross-process journal index lock before giving up. */
  lockWaitMs: z.coerce.number().int().positive().default(5_000),
  /** Directory for cross-process state — the journal index lockfile and the durable auth latch. Default `<cwd>/.abapsmith`. */
  stateDir: z.string().default(".abapsmith"),
  /**
   * Hard cap on tool response size, sourced from `compact.ts`'s
   * `DEFAULT_MAX_CHARS` (one definition, not two). `.max(200_000)` closes
   * G-36 — that already exceeds the largest artifact measured live.
   */
  maxResponseChars: z.coerce
    .number()
    .int()
    .positive()
    .max(
      200_000,
      "ABAP_MAX_RESPONSE_CHARS must not exceed 200000 — larger values let one response crowd out the agent's whole context window",
    )
    .default(DEFAULT_MAX_CHARS),
  /**
   * Safety gate. Read-only stays the default: writes require an explicit
   * `ABAP_ALLOW_WRITE=true` opt-in, and even then the package allowlist and the
   * name-prefix rule still apply.
   */
  readOnly: z.boolean().default(true),
  /**
   * Schema default stays `[]` (fail closed): it can't tell an omitted field
   * from an explicitly empty one. `loadConfig` applies the permissive
   * default instead.
   */
  allowPackages: z.array(z.string()).default([]),
  /**
   * Object-name allowlist; a write must target a customer-namespace name,
   * checked after the namespace/package rules. `["*"]`
   * (`ABAP_ALLOW_NAME_PREFIXES=*`) lifts this rule alone — SAP-owned names,
   * packages, and per-type lists (`src/adt/capabilities.ts`) still apply. See
   * `NAME_PREFIX_WILDCARD` in `src/safety.ts`.
   *
   * Schema default stays `["Z","Y"]` (fail closed) — unreachable from
   * `loadConfig`, which applies the permissive `["*"]` default instead; this
   * is the answer for a hand-built `ConfigSchema.parse`.
   */
  allowNamePrefixes: z.array(z.string()).default(["Z", "Y"]),
  /**
   * Schema default stays `[]` (fail closed), same convention as
   * `allowPackages`: it can't tell an omitted field from an explicitly empty
   * one, and `[]` already IS the real "explicitly empty" meaning, so it isn't
   * overloaded. `loadConfig` applies the permissive `["*"]` default instead
   * — this is the answer for a hand-built `ConfigSchema.parse`. See
   * `loadConfig` for how "unset" is told apart from "explicitly empty".
   */
  allowTransports: z.array(z.string()).default([]),
  /**
   * Ceiling for RELEASING a transport request. NOT implied by
   * `allowWrite`/`ABAP_ALLOW_WRITE` — both must be true. Off by default.
   */
  allowTransportRelease: z.boolean().default(false),
  /**
   * Ceiling for the debugger's `jumpToLine` step — a forced jump that can
   * skip statements (and their authorization/validation checks) rather than
   * executing them in order, unlike `runToLine`. Its own flag, separate from
   * the general write gate; NOT implied by `allowWrite` and deliberately NOT
   * part of `ABAP_MODE` (`src/mode.ts`) — no mode grants it. Consulted
   * directly by `src/tools/debug.ts`. Off by default; each call still needs
   * its own `confirm` echo on top of this ceiling.
   */
  allowDebugJumpToLine: z.boolean().default(false),
  /**
   * Ceiling for DELETING a transport request outright (distinct from
   * releasing one). NOT implied by `allowWrite`. `ABAP_ALLOW_TRANSPORT_DELETE`
   * is the legacy/override lever; admin-only by default otherwise.
   */
  allowTransportDelete: z.boolean().default(false),
  /**
   * Ceiling for the BOPF DDIC cascade-delete sweep (`deleteBusinessObject`,
   * `src/adt/bopf.ts`) — deleting the tables/structures/constants-interface a
   * BOPF business object's own delete leaves behind. NOT implied by
   * `allowWrite`. `ABAP_ALLOW_CASCADE_DELETE` is the legacy/override lever;
   * admin-only by default otherwise.
   */
  allowCascadeDelete: z.boolean().default(false),
  /** Master switch for enhancement read/edit/activate/delete via ADT REST. NOT implied by `allowWrite`. Off by default. */
  allowEnhancements: z.boolean().default(false),
  /**
   * Which *affected* (enhanced) objects may be touched. `none` (default)
   * refuses every enhancement write regardless of `allowEnhancements`;
   * `customer` permits customer-owned objects; `sap` additionally permits
   * SAP-original objects named in `enhanceTargetPackages` — `targets=sap`
   * alone changes nothing. `ABAP_ENHANCE_TARGETS=""` is a config-time
   * rejection, not an alias for `"none"`: unlike the list-shaped vars, this
   * enum already has an explicit spelling for deny-all, so an empty string
   * can only be a typo.
   */
  enhanceTargets: z.enum(ENHANCE_TARGETS_VALUES).default("none"),
  /** Package allowlist for the *affected* object when `enhanceTargets=sap`. `[]` is a deliberate deny-all, mirroring `allowPackages`. */
  enhanceTargetPackages: z.array(z.string()).default([]),
  /**
   * Independent opt-in for creating source-code-plugin (`enhoxhh`) hooks —
   * the one enhancement object ADT REST can CREATE. NOT implied by
   * `allowEnhancements`; off by default even when enhancement read/edit is on.
   */
  allowSourcePlugins: z.boolean().default(false),
  /**
   * Independent opt-in for DELETING an existing `ENHO/XH` (BAdI
   * implementation), `ENHO/XHH` (source-code plug-in) or `ENHS/XS`
   * (enhancement spot) outright. NOT implied by `allowEnhancements` or
   * `allowSourcePlugins`. Makes deletion *reachable*, not automatically safe:
   * deleting an `ENHO/XH` implementation reported (or not confirmably not)
   * active is refused unconditionally regardless of this flag — see
   * `deleteEnhancementObject` (`src/adt/enhancement-write.ts`).
   */
  allowEnhancementDelete: z.boolean().default(false),
  /**
   * Master switch for `abap_data_preview` — reading rows out of a DDIC table
   * or view. Off by default; when off the tool is not registered, so it
   * never appears in `tools/list`.
   *
   * Deliberately INDEPENDENT of `readOnly`/`allowWrite` (a preview is a read)
   * and of `ABAP_MODE` — `ABAP_MODE=read` does not force it off, unlike every
   * other permission field here (see `AbapModeGrants` in `src/mode.ts`). This
   * is a registration gate only; per-table denial (`dataPreviewDenyTables` +
   * the frozen defaults) and the productive-system ceiling in `src/safety.ts`
   * judge every call.
   */
  allowDataPreview: z.boolean().default(false),
  /**
   * Row ceiling for a single `abap_data_preview` call. Default **100**, hard
   * max **1000**. Fails startup when out of range rather than clamping,
   * `maxSessions`-style. `0`/negatives rejected by `.positive()` — `0` on the
   * ADT endpoint means UNLIMITED (measured: 155,924 rows / 8.3 MB in one
   * call), the single most dangerous value this field could hold. Enforced
   * twice on purpose: here against configuration, and again in
   * `src/tools/data-preview.ts` against the parsed row array, since the wire
   * itself has no maximum of its own.
   */
  dataPreviewMaxRows: z.coerce.number().int().positive().max(1000).default(100),
  /**
   * OPERATOR ADDITIONS to the data-preview table deny-list — never
   * replacements. `[]` by default, upper-cased on the way in. The frozen
   * defaults (`src/safety.ts`'s `DEFAULT_PREVIEW_DENY_TABLES`) are unioned
   * with whatever is named here; there is deliberately no env var that
   * removes a default entry, so an operator can only make the list stricter.
   * Unlike `allowPackages` (where naming a value replaces the default), this
   * list fails OPEN, so a replacement knob would risk silently unblocking a
   * table like `USR02`. Matching logic lives in `src/safety.ts`; this field
   * only carries the strings.
   */
  dataPreviewDenyTables: z.array(z.string()).default([]),
  /**
   * Tier-2 opt-in for ABAP runtime-error dumps (ST22): may a dump read
   * return the **variable-contents** chapter (`kap10`, "Selected
   * Variables")? Off by default. Tier 1 (error class, program, line, source
   * extract, call stack — no field values) is an ordinary read gated by
   * nothing but the connection; tier 2 is the values of locals/work
   * areas/internal tables at termination — on a real system that's customer
   * records, bank details, salary fields, i.e. the PII surface of the whole
   * feature, and this flag alone authorises it.
   *
   * Deliberately INDEPENDENT of `readOnly`/`allowWrite`: `canWrite =
   * !readOnly`, so keying this off write capability would hand the WIDEST
   * access to production data to the careful read-only connection and the
   * narrowest to a sandbox with writes on — inverted, not just wrong.
   * Likewise independent of `ABAP_MODE` (no `AbapCapabilities`/
   * `AbapModeGrants` entry, like `allowDebugJumpToLine`): no mode implies it,
   * `ABAP_MODE=read` cannot take it away.
   *
   * A registration gate first: when off, the `abap_dumps` tool's `variables`
   * field is absent from the advertised schema, not merely refused.
   * `SafetyGate`'s `evaluateDumpVariables`/`assertDumpVariables`
   * (`src/safety.ts`) is the runtime half for any path that bypasses the
   * schema.
   */
  allowDumpVariables: z.boolean().default(false),
  /**
   * Ceiling for `abap_ui`'s `press` mode — running a batch-input (BDC)
   * script via `CALL TRANSACTION ... MODE 'N' UPDATE 'S'`, which COMMITS
   * business data immediately with no dry run and no rollback path (see
   * `src/tools/ui.ts`). Off by default. Mode-orthogonal like
   * `allowDumpVariables` above, not an `AbapModeBooleanOverrides` lever: `abap_ui`'s
   * own `assertPressEnabled` requires BOTH `ABAP_MODE === "admin"` AND this
   * flag together — neither alone reaches `press`, and this flag can only
   * narrow admin further, never substitute for it.
   *
   * `screen` mode (discovery) is NOT gated by this flag — it only deploys a
   * throwaway `$TMP` bridge class (like `abap_fpm_read`), gated by ordinary
   * write capability instead.
   */
  allowUiPress: z.boolean().default(false),
  /**
   * SIDs whose content counts as locally originated for enhancement-target
   * judging (`ABAP_ORIGIN_SYSTEMS`), compared against `adtcore:masterSystem`.
   * `masterSystem !== "SAP"` alone is NOT a safe ownership test (it would
   * wave partner/third-party originals through). `SafetyGate` treats
   * membership in this closed list as "local"; everything else needs the
   * `enhanceTargets: "sap"` opt-in. Default `[]` (nothing local), mirroring
   * `enhanceTargetPackages`.
   */
  originSystems: z.array(z.string()).default([]),
  /**
   * Which MCP tool surface this server registers (`ABAP_TOOL_SURFACE`).
   * `"v1"` (default) is today's 13 registrar modules, unchanged. `"v2"`
   * registers only six consolidated tools (`src/tools/v2/register.ts`) and
   * skips every v1 registrar. Opt-in only.
   *
   * Do not default this to v2 or drop v1 — a live paired A/B measured v2 at
   * +6.6% more expensive and +142% more tool errors than v1 for
   * statistically identical successful work, despite a genuine −87.6%
   * schema-size cut. v2 is EXPERIMENTAL and NOT supported for production;
   * known defects are intentionally not being fixed while
   * it holds that status. Full measurement, reasoning, and the bar for
   * revisiting this default: see the git history.
   *
   * Deliberately no `"both"` value: v2 reuses v1's tool names verbatim, so
   * registering both surfaces throws "Tool abap_read is already registered"
   * at startup.
   */
  toolSurface: z.enum(["v1", "v2"]).default("v1"),
  /**
   * How hard abapsmith works to prove a write landed (`ABAP_VERIFY_WRITES`).
   * `"speculative"` (default): a create/activate that returned without error
   * is sufficient, no read-back prescribed on the success path. `"verified"`:
   * the object is read back and confirmed after a successful write.
   *
   * What this trades away is agent-initiated read-back — the extra
   * `abap_read` calls skill guidance and post-write hints prescribe — not
   * server-side verification. Cases where success is KNOWN not to prove
   * persistence (the classrun-bridge creates in `src/adt/write-verify.ts`,
   * the post-DELETE confirmation) stay verified in both modes regardless.
   * So does the FAILURE path: a write reporting failure while the object
   * actually exists leaves permanent residue, since no cleanup runs for a
   * reported failure — success is the common path and is where the saving
   * is, a reported failure is rare so verifying it is nearly free. A
   * per-call `verify` on `abap_write` can raise one call to `"verified"`,
   * never lower one below this default.
   */
  verifyWrites: z.enum(["speculative", "verified"]).default("speculative"),
  /**
   * Total pooled ADT sessions. Default **5** (2 read + 2 write + 1 reserved
   * debug lease, see `debugDiaBudget`), sized against the A4H appliance's
   * `rdisp/wp_no_dia = 7`: measured queue delay was already 14,075 ms with
   * only 5 of 7 processes busy, so 5 stays deliberately short of the
   * ceiling. Do not raise without new measurement; see the coherence warning
   * in `loadConfig` if widening the lane defaults below. `.max(16)` is a
   * configured hard ceiling, not a recommendation — 16 is the largest
   * fan-out measured to complete with zero errors, but latency roughly
   * doubled at that step, so treat it as "known not to fall over," not
   * "known to perform well."
   */
  maxSessions: z.coerce.number().int().positive().max(16).default(5),
  /**
   * Concurrent read-role operations permitted against the pool. Default 2 —
   * deliberately more than one so multiple readers work concurrently out of
   * the box.
   */
  readConcurrency: z.coerce.number().int().positive().default(2),
  /**
   * Concurrent write-role operations permitted against the pool. Default 2,
   * for the same reason as `readConcurrency`: several concurrent writers is
   * a requirement, and a default of 1 cannot satisfy it regardless of
   * `maxSessions`.
   *
   * This is a concurrency ceiling only, not a serialisation guarantee — the
   * server does NOT serialise writes to the same object at this layer. Two
   * sessions racing the same object is a caller discipline problem, caught
   * downstream by SAP's own enqueue lock and the pre-activation etag
   * re-read guard on the write path.
   */
  writeConcurrency: z.coerce.number().int().positive().default(2),
  /**
   * Default (unset): the server DOES serialise writes to the same ABAP
   * object, via `FileLockObjectGate` (`src/adt/pool.ts`) — in-process FIFO
   * plus a `withFileLock`-backed cross-process lock over the state dir, so
   * two abapsmith processes pointed at the same system can't interleave
   * writes to one object either. `ABAP_CROSS_PROCESS_OBJECT_LOCK=false`
   * drops to in-process-only without touching this field. Uses
   * {@link boolishTri} (not {@link boolish}) so unset reaches the pool
   * constructor as `undefined`, distinguishable from an explicit opt-out.
   *
   * 2026-08-07 reversed the 2026-08-06 default (gate off): the safe path
   * must now be the one a deployment gets by doing nothing, not merely the
   * one reasoned to be safe. `ABAP_SERIALISE_SAME_OBJECT_WRITES=false`
   * remains an acceptable, explicit opt-out because the activating paths
   * (`src/tools/write.ts`, `src/adt/undo.ts`) re-read and re-hash the
   * source immediately before activation and throw `ETAG_CONFLICT` rather
   * than activate unexpected bytes — though that guard only narrows the
   * race to a single round trip (no version pin on ADT activation), it
   * doesn't close it.
   *
   * Guards only abapsmith processes against each other — never ADT/Eclipse
   * or a developer in SE24, which never touch this lock.
   */
  /**
   * Chunk size for the fan-out-prone half of a batch `abap_activate` call —
   * DOMA/DTEL/TABL/TABL(DS)/TTYP and the rest of `TypeSpec.mode === "ddic"`
   * (see `src/adt/activate.ts`'s `isFanoutProneType`). Default **5**.
   *
   * Bounds SERVER-SIDE async-RFC fan-out, not client concurrency — do not
   * confuse the two when tuning it. A single `abap_activate`
   * batch of 47 DDIC objects took the A4H appliance down while
   * `ABAP_MAX_SESSIONS=2`/`ABAP_READ_CONCURRENCY=1`/
   * `ABAP_WRITE_CONCURRENCY=1` were respected throughout and were never the
   * binding constraint. ST22 showed 10 identical `CALL_FUNCTION_REMOTE_ERROR`
   * dumps in SAPLSDMP (`RADMASUTC` line 7636, `DD_ACT_INFOS_C3 starting new
   * task 'ANNO_CACHE_INFORM'`) — a LOOPBACK async RFC the server issues to
   * ITSELF per activation round to invalidate the DD buffer cache, needing a
   * free dialog work process on the target. Full trace: see
   * the git history.
   *
   * Do NOT raise this on "our concurrency is only 1" — that was already true
   * during the crash and did not help; it's server-side fan-out, not client
   * concurrency. Raise only if the target's `rdisp/wp_no_dia` comfortably
   * clears this value with margin. `.max(50)` matches `MAX_ACTIVATION_BATCH`.
   */
  maxDdicActivationBatch: z.coerce.number().int().positive().max(50).default(5),
  /**
   * Chunk size for the OTHER half of a batch `abap_activate` call — types
   * whose `TypeSpec.mode` is `"source"` (CLAS, INTF, PROG, FUGR, DDLS, …).
   * These don't route through the DDIC mass-activation utility described on
   * `maxDdicActivationBatch`, so they don't fan out the same way — that
   * crash was on 47 DDIC objects, not a comparable count of these types.
   * Default **50**, matching `MAX_ACTIVATION_BATCH`, so one chunk covers the
   * whole batch this server accepts.
   */
  maxSafeActivationBatch: z.coerce.number().int().positive().max(200).default(50),
  serialiseSameObjectWrites: boolishTri,
  /**
   * Idle time after which a pooled session is PRESUMED stale and discarded
   * rather than handed back out. Default 300,000 ms (5 min), deliberately
   * well under the ~32-minute idle expiry observed live: past that point SAP
   * answers `400`/`ICMENOSESSION` and has *already silently released the
   * session's enqueue*, so a write straddling real expiry loses its lock
   * with no error at lock time. Do NOT "improve" idle detection with a
   * health-probe request — a probe on a session with an outstanding
   * long-poll is head-of-line blocked for the rest of that poll (measured
   * ~55s against a 60s listener), making detection itself one of the
   * slowest operations in the pool.
   */
  sessionIdleMs: z.coerce.number().int().positive().default(300_000),
  /**
   * Max time to wait for a free pool slot before failing closed with a busy
   * error, rather than queuing indefinitely. Default 10,000 ms.
   */
  sessionWaitMs: z.coerce.number().int().positive().default(10_000),
  /**
   * Dialog work processes this process may assume it can pin for debugging.
   * A suspended debuggee pins exactly one DIA work process, additive,
   * released on terminate (evidenced: 60 samples across three phases,
   * unanimous). `rdisp/wp_no_dia = 7` on the reference appliance (a profile
   * read; exhaustion at the ceiling was never induced/measured).
   *
   * `0`/`1` disables debugging outright (the kill switch — hence
   * `.nonnegative()` not `.positive()`). A FLOOR CHECK, not a multiplier:
   * raising it does NOT enable a second concurrent debug session (see
   * `DEBUG_CONCURRENCY` in `src/adt/pool.ts` — parallel debugging is
   * closed). Deliberately no `.max()`: `7` is A4H-specific.
   */
  debugDiaBudget: z.coerce.number().int().nonnegative().default(2),
  /**
   * Whether the live debug deps install the cross-process debug arm lock
   * (`FileLockDebugArmLock`, `src/debug/arm-lock.ts`) or its no-op stand-in.
   * ON by default: SAP allows only one debug listener per user on a system,
   * so two abapsmith processes racing to arm as the same
   * (`ABAP_URL`, client, user) would otherwise silently reassign or wedge
   * each other's session. `false`/`0`/`no`/`off` opts out — typically for a
   * shared/read-only `ABAP_STATE_DIR` where lock files can't be created.
   *
   * Plumbing, not new behaviour: mirrors `resolveCrossProcessDebugLock`'s
   * (`src/debug/arm-lock.ts`) existing default/truth table; that function
   * stays the resolver of record for callers outside `loadConfig`, kept in
   * lockstep by test rather than by one calling the other, so `config.ts`
   * has no import from `src/debug`.
   */
  crossProcessDebugLock: boolishRejectDefaultTrue,
  /**
   * How long a caller waits to acquire the cross-process debug arm lock
   * before failing with `DEBUG_SESSION_LOCKED_CROSS_PROCESS`. Default
   * 1500 ms, valid range 200-30000 ms; falls back to default rather than
   * clamping (see `softBoundedMsSchema`). Mirrors `resolveDebugLockWaitMs`
   * (`src/debug/arm-lock.ts`) verbatim.
   */
  debugLockWaitMs: softBoundedMsSchema(1_500, 200, 30_000),
  /**
   * Whether `src/adt/pool.ts`'s constructor installs the cross-process
   * object gate (`FileLockObjectGate`, `src/adt/object-gate.ts`) or drops to
   * plain `InProcessObjectGate`. ON by default, same reasoning as
   * `crossProcessDebugLock`. Does NOT override `serialiseSameObjectWrites`:
   * an explicit `false` there still wins and installs `NoopObjectGate`
   * regardless — this field only chooses between the cross-process and
   * in-process gate.
   *
   * Plumbing, not new behaviour: mirrors `resolveCrossProcessObjectLock`'s
   * (`src/adt/object-gate.ts`) existing default/truth table; that function
   * stays the resolver of record for callers outside `loadConfig`, kept in
   * lockstep by test, so `config.ts` has no import from `src/adt`.
   */
  crossProcessObjectLock: boolishRejectDefaultTrue,
  /**
   * How long `FileLockObjectGate` waits for the cross-process object lock
   * before failing closed with `OBJECT_LOCK_BUSY`. Default 1500 ms, valid
   * range 200-30000 ms; falls back to default rather than clamping (see
   * `softBoundedMsSchema`). Mirrors `resolveObjectLockWaitMs`
   * (`src/adt/object-gate.ts`) verbatim.
   */
  objectLockWaitMs: softBoundedMsSchema(1_500, 200, 30_000),
  /**
   * Whether `start()` (`src/server.ts`) performs one authenticated probe
   * (reusing `ensureConnected()`, not a second request) before printing
   * `ready on stdio`. Without this, that banner printed
   * unconditionally even against a dead host, so a typo'd `ABAP_URL` or down
   * VPN never reached the operator and surfaced only inside an agent's
   * transcript on the first tool call.
   *
   * ON by default — loudness at startup is the point; a probe failure never
   * blocks startup, it only reports (`ready on stdio`, marked `NOT
   * CONNECTED`). `false`/`0`/`no`/`off` opts out for an operator who must
   * not have the server touch SAP at startup at all.
   */
  startupProbe: boolishRejectDefaultTrue,
});

export type Config = z.infer<typeof ConfigSchema> & {
  /**
   * The resolved `ABAP_MODE` (`src/mode.ts`), when set (non-empty) at
   * startup. `undefined` means legacy per-flag configuration, not a fourth
   * mode value. When set, it decides every permission-shaped field above
   * (`readOnly`, `allowPackages`, `allowNamePrefixes`, `allowTransports`,
   * `allowTransportRelease`, `allowEnhancements`, `enhanceTargets`,
   * `enhanceTargetPackages`, `allowSourcePlugins`, `originSystems`,
   * `allowTransportDelete`, `allowCascadeDelete`) — they're the flat
   * projection of `capabilities` below, not independently derived.
   * `allowDataPreview` is the one exception: a non-mutating grant fed INTO
   * `capabilitiesForMode`, so it holds the same value in every mode.
   */
  readonly abapMode?: AbapMode;
  /**
   * The full frozen capability set `ABAP_MODE` resolved to
   * (`capabilitiesForMode()`, `src/mode.ts`); `undefined` under legacy
   * config. Every field this codebase currently consumes is already
   * flattened onto `Config` (see `abapMode` above); this exists for
   * capability-only fields with no `Config` equivalent yet (`allowActivate`,
   * `allowRawAdtWrites`) and for code that wants the whole object.
   */
  readonly capabilities?: AbapCapabilities;
};

/** Same truthiness rules as the `boolish` schema, usable before parsing. */
function boolFromEnv(v: string | undefined): boolean {
  if (v === undefined) return false;
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

/** Tri-state sibling of {@link boolFromEnv}: `undefined` only when the var is UNSET. Any set-but-not-truthy value (including `""`) is an explicit `false`. */
function boolOverrideFromEnv(v: string | undefined): boolean | undefined {
  return v === undefined ? undefined : boolFromEnv(v);
}

function splitList(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Normalise one `ABAP_ALLOW_TRANSPORTS` entry. TRKORRs are uppercased to
 * match `isTrkorr`'s (`src/adt/transports.ts`) own case-folding — previously
 * a lowercase-typed TRKORR passed `isTrkorr` but matched nothing here,
 * failing closed in silence. `auto`/`*` are matched case-insensitively but
 * folded to their canonical literal form, not uppercased.
 */
function normaliseTransportEntry(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.toLowerCase() === "auto") return "auto";
  if (trimmed === "*") return "*";
  return trimmed.toUpperCase();
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  /** Where warnings go. Defaults to stderr — stdout is the MCP transport. */
  warn?: (msg: string) => void;
  skipDotenv?: boolean;
}

/**
 * Every `ABAP_ALLOW_*` name this server reads — checked against below.
 * test/config-abap-mode.test.ts extracts the real `env.ABAP_ALLOW_*` reads
 * and diffs them against this list, so the two can't drift apart.
 */
export const RECOGNISED_ABAP_ALLOW_ENV_VARS: readonly string[] = Object.freeze([
  "ABAP_ALLOW_CASCADE_DELETE",
  "ABAP_ALLOW_DATA_PREVIEW",
  "ABAP_ALLOW_DEBUG_JUMP_TO_LINE",
  "ABAP_ALLOW_DUMP_VARIABLES",
  "ABAP_ALLOW_ENHANCEMENTS",
  "ABAP_ALLOW_ENHANCEMENT_DELETE",
  "ABAP_ALLOW_NAME_PREFIXES",
  "ABAP_ALLOW_PACKAGES",
  "ABAP_ALLOW_RAW_ADT_WRITES",
  "ABAP_ALLOW_SOURCE_PLUGINS",
  "ABAP_ALLOW_TRANSPORTS",
  "ABAP_ALLOW_TRANSPORT_DELETE",
  "ABAP_ALLOW_TRANSPORT_RELEASE",
  "ABAP_ALLOW_UI_PRESS",
  "ABAP_ALLOW_WRITE",
]);

/**
 * Build the config from the environment. Throws a readable error listing every
 * missing/invalid variable at once.
 */
export function loadConfig(opts: LoadConfigOptions = {}): Config {
  if (!opts.skipDotenv) loadEnvFile();
  const env = opts.env ?? process.env;
  const warn = opts.warn ?? ((m: string) => process.stderr.write(m + "\n"));

  // Presence is the signal (even ""), in every ABAP_MODE — a typo'd name is a silent no-op otherwise.
  for (const name of Object.keys(env)
    .filter((k) => k.startsWith("ABAP_ALLOW_") && !RECOGNISED_ABAP_ALLOW_ENV_VARS.includes(k))
    .sort()) {
    warn(
      `[abapsmith] WARNING: ${name} is not a setting this server reads — it is most likely a ` +
        "typo of one of the recognised ABAP_ALLOW_* flags (see doc/CONFIGURATION/permissions-and-allowlists.md) and has " +
        "no effect.",
    );
  }

  // ABAP_MODE (src/mode.ts). Optional; when set (non-empty after trim) it's
  // authoritative for every permission-shaped field below, else legacy
  // per-flag parsing applies unchanged. parseAbapMode() throws on an invalid
  // value; caught here so it folds into the same "Invalid abapsmith
  // configuration" issue list as every other bad env var, below.
  const rawAbapMode = env.ABAP_MODE;
  const abapModeIsSet = rawAbapMode !== undefined && rawAbapMode.trim() !== "";
  let abapMode: AbapMode | undefined;
  let abapModeIssue: string | undefined;
  if (abapModeIsSet) {
    try {
      abapMode = parseAbapMode(rawAbapMode);
    } catch (e) {
      abapModeIssue = e instanceof Error ? e.message : String(e);
    }
  }

  // Writes need an explicit flag AND an allowlist, but the allowlist itself
  // defaults to `*` (every customer package) — see the startup NOTE below.
  const allowWrite = boolFromEnv(env.ABAP_ALLOW_WRITE);
  const configuredPackages = splitList(env.ABAP_ALLOW_PACKAGES);
  // An explicitly empty ABAP_ALLOW_NAME_PREFIXES is NOT taken literally
  // (unlike ABAP_ALLOW_TRANSPORTS below): empty here would mean allow-all,
  // so the schema's `["Z","Y"]` default stands instead. Turning the name
  // rule off is `ABAP_ALLOW_NAME_PREFIXES=*` (see `NAME_PREFIX_WILDCARD` in
  // src/safety.ts).
  const namePrefixes = splitList(env.ABAP_ALLOW_NAME_PREFIXES);

  // Same shape as allowPackages: unset vs. explicitly-empty must be told
  // apart here — unset → permissive `["*"]` (any caller-named request);
  // explicit empty → deny every transportable write. `splitList` alone
  // can't distinguish them. `"auto"` is still available as an explicit
  // choice for an operator who wants pin-refusal.
  const rawTransports = env.ABAP_ALLOW_TRANSPORTS;
  const allowTransports =
    rawTransports === undefined
      ? ["*"]
      : splitList(rawTransports).map(normaliseTransportEntry);
  const allowTransportRelease = boolFromEnv(env.ABAP_ALLOW_TRANSPORT_RELEASE);

  // Deliberately NOT folded into ABAP_MODE (see allowDebugJumpToLine's
  // schema doc comment); always read from this env var regardless of mode.
  const allowDebugJumpToLine = boolFromEnv(env.ABAP_ALLOW_DEBUG_JUMP_TO_LINE);

  const allowEnhancements = boolFromEnv(env.ABAP_ALLOW_ENHANCEMENTS);
  const enhanceTargetPackages = splitList(env.ABAP_ENHANCE_TARGET_PACKAGES);
  const allowSourcePlugins = boolFromEnv(env.ABAP_ALLOW_SOURCE_PLUGINS);
  const allowEnhancementDelete = boolFromEnv(env.ABAP_ALLOW_ENHANCEMENT_DELETE);
  const originSystems = splitList(env.ABAP_ORIGIN_SYSTEMS);

  // ABAP_ENHANCE_TARGETS: validated up front, like ABAP_MODE, rather
  // than left to the schema's `z.enum(...).default("none")` — that default
  // only ever fires for `undefined`, and `""` (unlike an unset list-shaped
  // var) already has an explicit spelling for deny-all ("none"), so an empty
  // string here is a typo'd config, not a silent alias for it.
  const rawEnhanceTargets = env.ABAP_ENHANCE_TARGETS;
  let enhanceTargetsOverride: EnhanceTargetsValue | undefined;
  let enhanceTargetsIssue: string | undefined;
  if (rawEnhanceTargets !== undefined) {
    // Read from ENHANCE_TARGETS_VALUES (src/mode.ts) rather than repeating
    // the three literals a third time (the zod schema above is the second).
    const legalValues: readonly string[] = ENHANCE_TARGETS_VALUES;
    if (legalValues.includes(rawEnhanceTargets)) {
      enhanceTargetsOverride = rawEnhanceTargets as EnhanceTargetsValue;
    } else {
      const quoted = ENHANCE_TARGETS_VALUES.map((v) => JSON.stringify(v));
      enhanceTargetsIssue =
        `ABAP_ENHANCE_TARGETS=${JSON.stringify(rawEnhanceTargets)} is not a recognised value. ` +
        `Valid values are ${quoted.slice(0, -1).join(", ")}, or ${quoted[quoted.length - 1]}.`;
    }
  }

  // ABAP_PASSWORD / ABAP_SESSION_COOKIE: exactly one credential source is
  // required. Both "" and unset count as "not set" — same treatment
  // ABAP_MODE gets above (abapModeIsSet), for the same reason: only the raw
  // env var distinguishes unset from explicitly-empty, and neither should
  // count as a real value.
  const passwordIsSet = env.ABAP_PASSWORD !== undefined && env.ABAP_PASSWORD.trim() !== "";
  const rawSessionCookie = env.ABAP_SESSION_COOKIE;
  const sessionCookieIsSet = rawSessionCookie !== undefined && rawSessionCookie.trim() !== "";
  let sessionCookie: ReadonlyMap<string, string> | undefined;
  let credentialIssue: string | undefined;
  if (sessionCookieIsSet) {
    const parsedCookie = parseSessionCookie(rawSessionCookie);
    if (parsedCookie.size === 0) {
      // Proceeding credential-less here means the first request is answered
      // by the identity provider and the resulting error describes an SSO
      // redirect, not "your cookie input was empty" — fail loudly now
      // instead.
      credentialIssue =
        "ABAP_SESSION_COOKIE is set but contains no usable name=value pairs once " +
        "whitespace, malformed fragments and cookie attributes (Path, Domain, Secure, " +
        "HttpOnly, Expires, Max-Age, SameSite) are discarded — check the pasted value.";
    } else {
      sessionCookie = parsedCookie;
    }
  }
  if (credentialIssue === undefined) {
    if (passwordIsSet && sessionCookie !== undefined) {
      // Not "suppress one at dispatch": a password the operator did not
      // intend to be in play must not be observable by any later feature
      // gate, so this refuses to start rather than silently picking one.
      credentialIssue =
        "both ABAP_PASSWORD and ABAP_SESSION_COOKIE are set — refusing to start rather than " +
        "silently choosing one. Unset whichever one is not intended.";
    } else if (!passwordIsSet && sessionCookie === undefined) {
      credentialIssue =
        "no credential configured — set exactly one of ABAP_PASSWORD or ABAP_SESSION_COOKIE.";
    }
  }

  // Unlike the other ABAP_ALLOW_* gates, data preview is NOT decided by
  // ABAP_MODE: it's a GRANT fed into capabilitiesForMode below, so
  // ABAP_MODE=read cannot force it off. See `AbapModeGrants`
  // in src/mode.ts.
  const allowDataPreview = boolFromEnv(env.ABAP_ALLOW_DATA_PREVIEW);
  // Additive-only deny-list additions, upper-cased here so `src/safety.ts`
  // compares like with like (`toUpperCase`, never `toLocaleUpperCase` — the
  // Turkish dotless i breaks table-name matching). No unset/empty distinction
  // is needed: `[]` already means "no additions", and there is no permissive
  // default to preserve — nor any way to subtract from the frozen defaults.
  const dataPreviewDenyTables = splitList(env.ABAP_DATA_PREVIEW_DENY_TABLES).map((t) =>
    t.toUpperCase(),
  );

  // Tier-2 dump reads. No `AbapCapabilities` field at all (like
  // `allowDebugJumpToLine`), so this boolean is the whole story in every
  // mode: nothing grants it and `ABAP_MODE=read` cannot take it away.
  const allowDumpVariables = boolFromEnv(env.ABAP_ALLOW_DUMP_VARIABLES);

  // `abap_ui` press ceiling — same shape as `allowDumpVariables`: no mode,
  // including `admin`, grants it (`assertPressEnabled` additionally requires
  // `ABAP_MODE === "admin"` before this flag matters).
  const allowUiPress = boolFromEnv(env.ABAP_ALLOW_UI_PRESS);

  // When ABAP_MODE is set it decides WHETHER a category of operation is
  // possible; these six list-/enum-shaped legacy vars, if also explicitly
  // set, REPLACE the mode's default outright, in either direction — widening
  // or narrowing (`AbapModeOverrides`, applied by `capabilitiesForMode`).
  const modeOverrides: AbapModeOverrides = {
    ...(env.ABAP_ALLOW_PACKAGES !== undefined ? { allowPackages: configuredPackages } : {}),
    ...(env.ABAP_ALLOW_NAME_PREFIXES !== undefined ? { allowNamePrefixes: namePrefixes } : {}),
    ...(rawTransports !== undefined ? { allowTransports } : {}),
    ...(enhanceTargetsOverride !== undefined ? { enhanceTargets: enhanceTargetsOverride } : {}),
    ...(env.ABAP_ENHANCE_TARGET_PACKAGES !== undefined ? { enhanceTargetPackages } : {}),
    ...(env.ABAP_ORIGIN_SYSTEMS !== undefined ? { originSystems } : {}),
  };
  // Non-mutating grant, honoured in EVERY mode including `read` — separate
  // from `modeOverrides` because it widens rather than narrows (see
  // `AbapModeGrants` in src/mode.ts).
  const modeGrants: AbapModeGrants = { allowDataPreview };
  // Two-way per-boolean overrides (`AbapModeBooleanOverrides`, src/mode.ts):
  // unset falls back to the mode default, set wins either way. `undefined`
  // values here are harmless — `capabilitiesForMode`'s `??` treats an
  // explicit `undefined` the same as an absent key. allowRawAdtWrites has no
  // `Config` field (no consumer yet — the abap_adt tool doesn't exist) and
  // reaches `cfg.capabilities.allowRawAdtWrites` only via this bag.
  const modeBoolOverrides: AbapModeBooleanOverrides = {
    allowTransportRelease: boolOverrideFromEnv(env.ABAP_ALLOW_TRANSPORT_RELEASE),
    allowTransportDelete: boolOverrideFromEnv(env.ABAP_ALLOW_TRANSPORT_DELETE),
    allowCascadeDelete: boolOverrideFromEnv(env.ABAP_ALLOW_CASCADE_DELETE),
    allowRawAdtWrites: boolOverrideFromEnv(env.ABAP_ALLOW_RAW_ADT_WRITES),
    allowEnhancements: boolOverrideFromEnv(env.ABAP_ALLOW_ENHANCEMENTS),
    allowSourcePlugins: boolOverrideFromEnv(env.ABAP_ALLOW_SOURCE_PLUGINS),
    allowEnhancementDelete: boolOverrideFromEnv(env.ABAP_ALLOW_ENHANCEMENT_DELETE),
  };
  const modeCapabilities: AbapCapabilities | undefined =
    abapMode !== undefined
      ? capabilitiesForMode(abapMode, modeOverrides, modeGrants, modeBoolOverrides)
      : undefined;

  // Keys off env.ABAP_ALLOW_PACKAGES === undefined, never a length check —
  // only the raw env var distinguishes "unset" from "explicitly empty".
  const defaultedPackages =
    (modeCapabilities ? modeCapabilities.allowWrite : allowWrite) &&
    env.ABAP_ALLOW_PACKAGES === undefined;
  // Unlike packages, a length check IS correct here: for prefixes, unset and
  // explicitly-empty deliberately collapse (`[]` already means allow-all
  // downstream via ABAP_ALLOW_NAME_PREFIXES=*'s sibling behaviour).
  const defaultedNamePrefixes =
    (modeCapabilities ? modeCapabilities.allowWrite : allowWrite) && namePrefixes.length === 0;
  // Same shape as defaultedPackages: keys off the raw env var, not a length
  // check, since [] is the real "explicitly empty" meaning for transports.
  const defaultedTransports =
    (modeCapabilities ? modeCapabilities.allowWrite : allowWrite) && rawTransports === undefined;

  const parsed = ConfigSchema.safeParse({
    url: env.ABAP_URL,
    user: env.ABAP_USER,
    // Normalised to undefined for both "unset" and "explicitly empty" so the
    // schema's `.min(1)` never fires here — `credentialIssue` above is what
    // speaks for a missing/blank password now.
    password: passwordIsSet ? env.ABAP_PASSWORD : undefined,
    sessionCookie,
    client: env.ABAP_CLIENT ?? "",
    sendClientParam: env.ABAP_SEND_CLIENT_PARAM,
    sid: env.ABAP_SID || "UNKNOWN",
    language: env.ABAP_LANGUAGE ?? "",
    insecure: env.ABAP_INSECURE,
    terminalId: env.ABAP_TERMINAL_ID,
    ideId: env.ABAP_IDE_ID,
    timeoutMs: env.ABAP_TIMEOUT_MS ?? 60_000,
    lockWaitMs: env.ABAP_LOCK_WAIT_MS ?? 5_000,
    stateDir: env.ABAP_STATE_DIR ?? ".abapsmith",
    maxResponseChars: env.ABAP_MAX_RESPONSE_CHARS,
    // Every permission-shaped field below takes its value from
    // `modeCapabilities` when ABAP_MODE resolved, else the legacy computation.
    readOnly: modeCapabilities ? !modeCapabilities.allowWrite : !allowWrite,
    // Legacy mirror of EDIT_PACKAGE_DEFAULT in src/mode.ts.
    allowPackages: modeCapabilities
      ? modeCapabilities.allowPackages
      : defaultedPackages
        ? ["*"]
        : configuredPackages,
    // Legacy mirror of EDIT_NAME_PREFIX_DEFAULT in src/mode.ts.
    allowNamePrefixes: modeCapabilities
      ? modeCapabilities.allowNamePrefixes
      : namePrefixes.length
        ? namePrefixes
        : ["*"],
    // `AbapCapabilities.allowTransports` may be `null` (read mode — deny all
    // transportable writes); folds to `[]`, already "deny every transportable
    // write" here ($TMP writes unaffected).
    allowTransports: modeCapabilities ? (modeCapabilities.allowTransports ?? []) : allowTransports,
    allowTransportRelease: modeCapabilities
      ? modeCapabilities.allowTransportRelease
      : allowTransportRelease,
    // Not part of AbapCapabilities at all (see schema doc comment), so no
    // mode branch — read the same way regardless of ABAP_MODE.
    allowDebugJumpToLine,
    allowTransportDelete: modeCapabilities
      ? modeCapabilities.allowTransportDelete
      : boolFromEnv(env.ABAP_ALLOW_TRANSPORT_DELETE),
    allowCascadeDelete: modeCapabilities
      ? modeCapabilities.allowCascadeDelete
      : boolFromEnv(env.ABAP_ALLOW_CASCADE_DELETE),
    allowEnhancements: modeCapabilities ? modeCapabilities.allowEnhancements : allowEnhancements,
    // Already validated above (enhanceTargetsOverride/enhanceTargetsIssue) —
    // an invalid raw value throws via the combined issue list below rather
    // than reaching zod's own enum check a second time.
    enhanceTargets: modeCapabilities ? modeCapabilities.enhanceTargets : (enhanceTargetsOverride ?? "none"),
    enhanceTargetPackages: modeCapabilities
      ? modeCapabilities.enhanceTargetPackages
      : enhanceTargetPackages,
    allowSourcePlugins: modeCapabilities ? modeCapabilities.allowSourcePlugins : allowSourcePlugins,
    allowEnhancementDelete: modeCapabilities
      ? modeCapabilities.allowEnhancementDelete
      : allowEnhancementDelete,
    originSystems: modeCapabilities ? modeCapabilities.originSystems : originSystems,
    // A no-op branch by construction: modeCapabilities.allowDataPreview was
    // computed FROM allowDataPreview (passed in as a grant above) in every
    // mode. Written branched anyway so a future mode with its own opinion
    // here has somewhere to plug in, instead of silently inheriting this.
    allowDataPreview: modeCapabilities ? modeCapabilities.allowDataPreview : allowDataPreview,
    // Not part of AbapCapabilities in any form — no mode arm. See schema doc
    // comments on allowDumpVariables/allowUiPress.
    allowDumpVariables,
    allowUiPress,
    dataPreviewDenyTables,
    // Bare fields below: each has a zod `.default()`/`.max()` that is the
    // single source of truth, so out-of-range/invalid input reaches the
    // startup error list rather than being papered over here.
    dataPreviewMaxRows: env.ABAP_DATA_PREVIEW_MAX_ROWS,
    // Not mode-derived — tool surface is orthogonal to the ABAP_MODE
    // permission ceiling.
    toolSurface: env.ABAP_TOOL_SURFACE,
    // Not mode-derived — verification posture is orthogonal to the ABAP_MODE
    // permission ceiling, exactly like toolSurface above.
    verifyWrites: env.ABAP_VERIFY_WRITES,
    maxSessions: env.ABAP_MAX_SESSIONS,
    readConcurrency: env.ABAP_READ_CONCURRENCY,
    writeConcurrency: env.ABAP_WRITE_CONCURRENCY,
    // See src/adt/activate.ts's `isFanoutProneType` for why these two are
    // split rather than one shared batch-size knob.
    maxDdicActivationBatch: env.ABAP_MAX_DDIC_ACTIVATION_BATCH,
    maxSafeActivationBatch: env.ABAP_MAX_SAFE_ACTIVATION_BATCH,
    serialiseSameObjectWrites: env.ABAP_SERIALISE_SAME_OBJECT_WRITES,
    sessionIdleMs: env.ABAP_SESSION_IDLE_MS ?? 300_000,
    sessionWaitMs: env.ABAP_SESSION_WAIT_MS ?? 10_000,
    debugDiaBudget: env.ABAP_DEBUG_DIA_BUDGET,
    crossProcessDebugLock: env.ABAP_CROSS_PROCESS_DEBUG_LOCK,
    debugLockWaitMs: env.ABAP_DEBUG_LOCK_WAIT_MS,
    // Must stay byte-for-byte identical to
    // resolveCrossProcessObjectLock/resolveObjectLockWaitMs
    // (src/adt/object-gate.ts) — a `??` default here would quietly break that.
    crossProcessObjectLock: env.ABAP_CROSS_PROCESS_OBJECT_LOCK,
    objectLockWaitMs: env.ABAP_OBJECT_LOCK_WAIT_MS,
    startupProbe: env.ABAP_STARTUP_PROBE,
  });

  if (
    !parsed.success ||
    abapModeIssue !== undefined ||
    enhanceTargetsIssue !== undefined ||
    credentialIssue !== undefined
  ) {
    // Combined so an invalid ABAP_MODE/ABAP_ENHANCE_TARGETS/credential setup
    // reports in the SAME issue list as every other bad env var, in one
    // startup error.
    const zodIssues = parsed.success
      ? []
      : parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    const modeIssues = abapModeIssue !== undefined ? [`  - abapMode: ${abapModeIssue}`] : [];
    const enhanceTargetsIssues =
      enhanceTargetsIssue !== undefined ? [`  - enhanceTargets: ${enhanceTargetsIssue}`] : [];
    const credentialIssues =
      credentialIssue !== undefined ? [`  - credential: ${credentialIssue}`] : [];
    throw new Error(
      `Invalid abapsmith configuration:\n${[...zodIssues, ...modeIssues, ...enhanceTargetsIssues, ...credentialIssues].join("\n")}`,
    );
  }

  const cfg: Config = { ...parsed.data, abapMode, capabilities: modeCapabilities };

  // One legacy var (ABAP_ALLOW_WRITE) has no override slot at all. Once
  // ABAP_MODE is set and it's still present, it's dead — warn once per flag.
  if (abapMode !== undefined) {
    // Derived from MODE_GOVERNED_CAPABILITIES (src/mode.ts) rather than
    // re-listed here, so this warning and every refusal message read from one
    // list instead of two that can drift apart.
    for (const name of MODE_GOVERNED_LEGACY_ENV_VARS) {
      if ((env as Record<string, unknown>)[name] === undefined) continue;
      warn(
        `[abapsmith] WARNING: ${name} is set but ignored — ABAP_MODE is set and is now the ` +
          `source of truth for this setting. Remove ${name} or unset ABAP_MODE to use the ` +
          "legacy flags.",
      );
    }
    // read resolves to a frozen all-deny set and consults no override (src/mode.ts).
    if (abapMode === "read") {
      for (const name of MODE_OVERRIDE_ENV_VARS) {
        if ((env as Record<string, unknown>)[name] === undefined) continue;
        warn(
          `[abapsmith] WARNING: ${name} is set but ignored — ABAP_MODE=read resolves to a fixed ` +
            "all-deny capability set and consults no override. Use ABAP_MODE=edit or admin, or " +
            "unset ABAP_MODE, for it to have any effect.",
        );
      }
    }
  } else {
    // Legacy per-flag config is fully supported forever, but every operator
    // who hasn't migrated should hear about ABAP_MODE once per start.
    // Deliberately does not guess which of read/edit/admin the current flags
    // are "equivalent to" — several flags vary independently of each other
    // and of ABAP_ALLOW_WRITE, so any such inference would be misleading.
    warn(
      "[abapsmith] NOTE: Configured via legacy per-flag env vars. Consider migrating to a " +
        "single ABAP_MODE=read|edit|admin — see README.",
    );
  }

  // Names whatever actually decided a MODE-GOVERNED capability, rather than
  // always `ABAP_ALLOW_X=true` (a lie once ABAP_MODE is set). `modeOverridable`
  // covers the two-way-override capabilities: an explicit env var wins over
  // ABAP_MODE even though the mode is set (`AbapModeBooleanOverrides`).
  const enabledBy = (envVar: string, modeOverridable = false): string =>
    abapMode !== undefined && !(modeOverridable && env[envVar] !== undefined)
      ? `ABAP_MODE=${abapMode}`
      : `${envVar}=true`;

  if (cfg.insecure) {
    // Opt-in, and warn every single time it is used.
    warn(
      "[abapsmith] WARNING: ABAP_INSECURE=true — TLS certificate verification is DISABLED. " +
        "Credentials are exposed to anyone who can intercept the connection. " +
        "Prefer NODE_EXTRA_CA_CERTS with your corporate CA bundle.",
    );
  }
  if (/^http:\/\//i.test(cfg.url)) {
    // `warn`'s sink is injectable but this message text is not, so a host
    // here reaches every raw capture of the process's output regardless of
    // what the caller does — and the operator already knows which system
    // they configured (the SID is in the ready banner).
    warn(
      `[abapsmith] WARNING: the configured ABAP_URL (${describeUrlWithoutHost(cfg.url)}) is plain HTTP — basic-auth credentials are sent unencrypted.`,
    );
  }
  if (urlHasEmbeddedPassword(cfg.url)) {
    warn(
      "[abapsmith] WARNING: ABAP_URL contains an embedded password. It is redacted from this " +
        "server's own logs, but it is still a live credential sitting in an environment " +
        "variable, visible to `ps`/`/proc` and to anything that echoes the URL. Move it to " +
        "ABAP_PASSWORD.",
    );
  }
  if (cfg.sessionCookie !== undefined && !looksLikeSessionCookieSet(cfg.sessionCookie.keys())) {
    // Never a rejection (INV-23): we don't acquire cookies, so there's no
    // capture-succeeded decision to make, and rejecting an unrecognised set
    // would lock out landscapes nobody here has seen. Names only, no values.
    warn(
      "[abapsmith] WARNING: ABAP_SESSION_COOKIE is set but none of its cookie names " +
        `(${[...cfg.sessionCookie.keys()].join(", ")}) look like a session credential — expected ` +
        "one starting with MYSAPSSO2, SAP_SESSIONID_, or JSESSIONID. The whole set is still sent " +
        "as configured; this is only a hint that the pasted value may be incomplete or from the " +
        "wrong page.",
    );
  }
  if (!cfg.readOnly) {
    // Under the wildcard the banner must not read as a restriction still in
    // force — "names starting with [*]" would look like a prefix.
    const nameClause = isUnrestrictedPrefixList(cfg.allowNamePrefixes)
      ? "ANY object name (the name rule is DISABLED; SAP-owned names and packages are still refused)"
      : `names starting with [${cfg.allowNamePrefixes.join(", ")}]`;
    warn(
      `[abapsmith] WARNING: ${enabledBy("ABAP_ALLOW_WRITE")} — writes, deletes, activation and ` +
        `execution are ENABLED for packages [${cfg.allowPackages.join(", ")}] and ` +
        `${nameClause}. ` +
        "A productive system still forces read-only with no override.",
    );
    if (defaultedPackages) {
      warn(
        "[abapsmith] NOTE: no ABAP_ALLOW_PACKAGES configured — defaulting the write " +
          "allowlist to [*]. EVERY customer package on this system is writable, not just " +
          "$TMP — and, absent ABAP_ALLOW_TRANSPORTS, such writes may be recorded on any " +
          "transport request named at write time (see the ABAP_ALLOW_TRANSPORTS NOTE below " +
          "if also unconfigured). Set ABAP_ALLOW_PACKAGES to narrow this (e.g. " +
          "ABAP_ALLOW_PACKAGES=$TMP for local objects only); an explicitly empty " +
          "ABAP_ALLOW_PACKAGES= refuses every write.",
      );
    }
    if (defaultedNamePrefixes) {
      warn(
        "[abapsmith] NOTE: no ABAP_ALLOW_NAME_PREFIXES configured — the object-name rule is " +
          "OFF: any name outside the SAP namespace may be written, not just Z*/Y*. Set " +
          "ABAP_ALLOW_NAME_PREFIXES to narrow this (e.g. ABAP_ALLOW_NAME_PREFIXES=Z,Y); " +
          "SAP-owned names and packages are refused either way.",
      );
    }
    if (cfg.allowTransports.length === 0) {
      warn(
        "[abapsmith] NOTE: ABAP_ALLOW_TRANSPORTS is explicitly empty — every transportable " +
          "write is refused. $TMP writes are unaffected.",
      );
    } else if (defaultedTransports) {
      warn(
        "[abapsmith] NOTE: no ABAP_ALLOW_TRANSPORTS configured — defaulting to [*]. Any " +
          "transport request named at write time is accepted, and this session may also " +
          "auto-select or auto-create one on its own for a transportable write. Set " +
          "ABAP_ALLOW_TRANSPORTS to narrow this (e.g. a specific TRKORR to pin one request, " +
          "which never auto-creates, or ABAP_ALLOW_TRANSPORTS=auto to restrict to " +
          "auto-select/auto-create only, refusing caller-named requests); an explicitly empty " +
          "ABAP_ALLOW_TRANSPORTS= refuses every transportable write.",
      );
    } else if (cfg.allowTransports.some((t) => t.trim() === "*")) {
      warn(
        "[abapsmith] WARNING: ABAP_ALLOW_TRANSPORTS includes \"*\" — any transport request is " +
          "accepted, and this session may also auto-select or auto-create one, for a " +
          "transportable write.",
      );
    }
    // An entry that is none of "auto", "*", or a valid TRKORR shape can never
    // match a real transport — fails closed, but silently. Named here so the
    // mistake is visible at startup instead of discovered mid-incident.
    const malformedTransports = cfg.allowTransports.filter(
      (t) => t !== "auto" && t !== "*" && !isTrkorr(t),
    );
    if (malformedTransports.length > 0) {
      warn(
        "[abapsmith] WARNING: ABAP_ALLOW_TRANSPORTS has entries that are neither \"auto\", \"*\", " +
          `nor a valid transport request number: [${malformedTransports.join(", ")}]. These will ` +
          "never match a real transport, so a write pinned to one of them is refused with no " +
          "further explanation.",
      );
    }
    if (cfg.allowTransportRelease) {
      warn(
        `[abapsmith] WARNING: ${enabledBy("ABAP_ALLOW_TRANSPORT_RELEASE", true)} — releasing transport ` +
          "requests is enabled (still refused on a productive or unproven system).",
      );
    }
  }
  if (cfg.allowDebugJumpToLine) {
    // Independent of ABAP_ALLOW_WRITE/readOnly on purpose — lets the debugger
    // skip statements (and whatever checks they'd have run).
    warn(
      "[abapsmith] WARNING: ABAP_ALLOW_DEBUG_JUMP_TO_LINE=true — the debugger's jumpToLine " +
        "step is ENABLED. Each call still needs a per-call confirm echo; this only raises " +
        "the ceiling. NOT implied by ABAP_ALLOW_WRITE, and not itself implied by ABAP_MODE.",
    );
  }
  if (cfg.allowDumpVariables) {
    // Outside the !cfg.readOnly block on purpose — orthogonal to writes, and
    // a read-only server is exactly where this is most often set.
    warn(
      "[abapsmith] WARNING: ABAP_ALLOW_DUMP_VARIABLES=true — runtime-error dumps may return " +
        "the Selected Variables chapter: the live contents of locals, work areas and internal " +
        "tables at the moment of termination. On a system with real users behind it that is " +
        "business and personal data, and it lands permanently in the model's transcript. " +
        "NOT implied by ABAP_ALLOW_WRITE and not governed by ABAP_MODE.",
    );
  }
  if (cfg.allowUiPress) {
    // Press ALSO requires ABAP_MODE=admin (assertPressEnabled) — an operator
    // without admin mode gets a NOTE below, not an overstated warning.
    warn(
      "[abapsmith] WARNING: ABAP_ALLOW_UI_PRESS=true — abap_ui's press mode is one flag closer " +
        "to enabled. It executes CALL TRANSACTION ... MODE 'N' UPDATE 'S' against a live " +
        "system: this COMMITS business data immediately, with no dry run and no rollback " +
        "path. NOT implied by ABAP_ALLOW_WRITE and not itself sufficient — ABAP_MODE=admin " +
        "is also required, and neither alone unlocks it.",
    );
    if (abapMode !== "admin") {
      warn(
        "[abapsmith] NOTE: ABAP_ALLOW_UI_PRESS=true but ABAP_MODE is " +
          `${abapMode === undefined ? "unset" : abapMode} — abap_ui press stays refused until ` +
          "ABAP_MODE=admin as well; screen (discovery) mode is unaffected by either setting.",
      );
    }
  }
  if (cfg.allowEnhancements) {
    // ABAP_ENHANCE_TARGET_PACKAGES stays named unconditionally: it's a
    // replacing override still honoured under ABAP_MODE. enhanceTargets
    // itself is mode-governed but ALSO overridable, so its source
    // must be named honestly — one of three cases: no mode at all, a mode
    // with its own default standing, or a mode whose default was replaced
    // by an explicit ABAP_ENHANCE_TARGETS.
    const targetsClause =
      abapMode === undefined
        ? `ABAP_ENHANCE_TARGETS=${cfg.enhanceTargets}`
        : enhanceTargetsOverride !== undefined
          ? `targets=${cfg.enhanceTargets}, from ABAP_ENHANCE_TARGETS (overriding ABAP_MODE=${abapMode}'s default)`
          : `targets=${cfg.enhanceTargets}, from ABAP_MODE=${abapMode}`;
    warn(
      `[abapsmith] WARNING: ${enabledBy("ABAP_ALLOW_ENHANCEMENTS", true)} — enhancement ` +
        `read/edit/activate/delete is ENABLED (${targetsClause}` +
        (cfg.enhanceTargets === "sap"
          ? `, ABAP_ENHANCE_TARGET_PACKAGES=[${cfg.enhanceTargetPackages.join(", ")}]`
          : "") +
        ")." +
        (abapMode === undefined
          ? " NOT implied by ABAP_ALLOW_WRITE, and not itself implied by it either."
          : ""),
    );
    if (cfg.enhanceTargets === "sap" && cfg.enhanceTargetPackages.length === 0) {
      warn(
        "[abapsmith] NOTE: enhancement targets are 'sap' but ABAP_ENHANCE_TARGET_PACKAGES is " +
          "empty — that is a deliberate deny-all, so no SAP-original object can be " +
          "enhanced until packages are named there.",
      );
    }
    if (cfg.enhanceTargets === "none") {
      // Otherwise: enhancements ENABLED but target class is 'none' means
      // every enhancement write is refused anyway, silently. Reachable in
      // legacy config (the schema default) AND under ABAP_MODE —
      // an admin operator may narrow ABAP_ENHANCE_TARGETS=none explicitly —
      // so the legacy variable name below is correct in both cases.
      warn(
        "[abapsmith] NOTE: ABAP_ENHANCE_TARGETS is 'none' (the default), so despite the line " +
          "above EVERY enhancement write is still refused — read/inspect only. Set " +
          "ABAP_ENHANCE_TARGETS=customer for your own objects, or =sap plus a matching " +
          "ABAP_ENHANCE_TARGET_PACKAGES entry for SAP-original objects.",
      );
    }
  } else if (cfg.enhanceTargets !== "none" || cfg.enhanceTargetPackages.length > 0) {
    // Reachable under ABAP_MODE=read with ABAP_ENHANCE_TARGET_PACKAGES set
    // (that one is an override still read), so name the mode there rather
    // than a variable read mode never consults.
    warn(
      "[abapsmith] NOTE: enhancement targets/packages are configured but " +
        (abapMode !== undefined
          ? `ABAP_MODE=${abapMode} does not grant enhancement authoring`
          : "ABAP_ALLOW_ENHANCEMENTS is not true") +
        " — every enhancement write is refused regardless.",
    );
  }
  if (cfg.allowSourcePlugins) {
    warn(
      `[abapsmith] WARNING: ${enabledBy("ABAP_ALLOW_SOURCE_PLUGINS")} — creating ` +
        "source-code-plugin (enhoxhh) hooks is ENABLED. " +
        (abapMode !== undefined
          ? cfg.allowEnhancements
            ? "Enhancement authoring is on too."
            : "Enhancement authoring is NOT granted, so this alone still refuses every " +
              "enhancement write."
          : "Independent of ABAP_ALLOW_ENHANCEMENTS: " +
            (cfg.allowEnhancements
              ? "both are on."
              : "ABAP_ALLOW_ENHANCEMENTS is NOT set, so this alone still refuses every " +
                "enhancement write.")),
    );
  }
  if (cfg.allowEnhancementDelete) {
    // Independent of ABAP_ALLOW_ENHANCEMENTS — neither implies the other.
    // NOT enabledBy(...): this checks whether the MODE ALONE (no override)
    // already grants it, so a redundant ABAP_ALLOW_ENHANCEMENT_DELETE=true
    // under admin still correctly says "ABAP_MODE=admin" rather than
    // claiming the env var as the cause.
    const deleteEnabledBy =
      abapMode === undefined
        ? "ABAP_ALLOW_ENHANCEMENT_DELETE=true"
        : capabilitiesForMode(abapMode, modeOverrides, modeGrants).allowEnhancementDelete
          ? `ABAP_MODE=${abapMode}`
          : `ABAP_ALLOW_ENHANCEMENT_DELETE=true (unlocked under ABAP_MODE=${abapMode}, which alone ` +
            "does not grant this)";
    warn(
      `[abapsmith] WARNING: ${deleteEnabledBy} — deleting an ` +
        "existing enhancement spot/BAdI implementation/source-code plug-in is ENABLED. " +
        (abapMode !== undefined
          ? cfg.allowEnhancements
            ? "Enhancement authoring is also granted."
            : "Enhancement authoring is NOT granted, so this alone still refuses every " +
              "enhancement write."
          : cfg.allowEnhancements
            ? "ABAP_ALLOW_ENHANCEMENTS is also on."
            : "ABAP_ALLOW_ENHANCEMENTS is NOT set, so this alone still refuses every " +
              "enhancement write.") +
        " This does not lift the unconditional refusal for deleting a BAdI implementation " +
        "reported (or not confirmably NOT) active — that check has no override, by design: " +
        "deactivating live business logic this way fails silently, with no error and no log.",
    );
  }
  if (cfg.ideId !== undefined && cfg.ideId === cfg.terminalId) {
    warn(
      "[abapsmith] WARNING: ABAP_IDE_ID is set to the same value as ABAP_TERMINAL_ID. " +
        "SAP treats this pair as a debug session's identity, so setting them identical " +
        "makes two processes indistinguishable to SAP and to the debugger's own " +
        "bookkeeping — exactly the collision ABAP_TERMINAL_ID/ABAP_IDE_ID exist to " +
        "prevent. Separately: distinct ids do not buy SAFE concurrent debugging either " +
        "way — a second global-scope listener for the same SAP user with a DIFFERENT " +
        "(terminalId, ideId) pair is rejected server-side (409 AdiFailed, " +
        "subType=conflictDetected, \"Another session already exists with global " +
        "debugging scope for user …\"); reusing the SAME pair is accepted instead of " +
        "rejected, but was observed wedging both listeners for minutes in testing. " +
        "There is no confirmed way to run two independent, healthy global-scope " +
        "listeners for one SAP user at once.",
    );
  }
  // Not a hard failure: lane limits aren't clamped to pool size, so
  // over-subscription just degrades to queuing for the smaller number of
  // slots — a startup refine() would turn a survivable misconfiguration into
  // an outage over something that still runs correctly, just slower.
  if (cfg.readConcurrency + cfg.writeConcurrency + 1 > cfg.maxSessions) {
    warn(
      `[abapsmith] WARNING: readConcurrency (${cfg.readConcurrency}) + writeConcurrency ` +
        `(${cfg.writeConcurrency}) + 1 reserved debug lease slot exceeds maxSessions ` +
        `(${cfg.maxSessions}). The lane limits are not clamped to the pool size, so the ` +
        "lanes simply contend for the smaller number of actual slots — the excess lane " +
        "capacity configured above is unreachable. Accepted as written; the server starts " +
        "normally.",
    );
  }
  if (cfg.serialiseSameObjectWrites === false) {
    warn(
      "[abapsmith] NOTE: ABAP_SERIALISE_SAME_OBJECT_WRITES=false — writes to the same object " +
        "are NOT serialised in-process via the object gate; concurrent same-object writes will " +
        "race instead of queuing. The pre-activation etag guard (src/tools/write.ts, " +
        "src/adt/undo.ts) still refuses to activate over a change it did not expect, but that " +
        "only narrows the race to a single round trip — it does not close it. In-process " +
        "serialisation is the default; this setting opts out of it.",
    );
  }
  if (cfg.sendClientParam) {
    warn(
      "[abapsmith] NOTE: ABAP_SEND_CLIENT_PARAM=true — sending ?sap-client= on requests. " +
        "Some systems (e.g. the A4H appliance) reject this with an ICF logon-failed page.",
    );
  }

  return cfg;
}

/**
 * Which write-capable tool GROUPS this process advertises in `tools/list`,
 * computed once from `Config` at startup.
 *
 * Registration-time filtering, layered IN ADDITION TO — never instead of —
 * `SafetyGate`'s runtime checks on every call. The value is defense-in-depth:
 * a read-only server never even shows `abap_write`/`abap_run`/etc. in its
 * tool list, so there's nothing for an LLM to be tricked into calling.
 *
 * Decided by exactly five `Config` fields — `readOnly`, `allowTransportRelease`,
 * `allowEnhancements`, `allowDataPreview`, `allowDumpVariables` — all fixed
 * for the process lifetime (`SafetyGate.update()` only ever touches
 * `productive`/`systemRole`/`writesLockedOut`/`lockoutReason`), so a decision
 * made at startup can never go stale.
 *
 * `canPreviewData`/`canReadDumpVariables` are deliberately NOT derived from
 * `canWrite`: a preview/dump read is a read, and these are also the two
 * capabilities `ABAP_MODE=read` does not suppress (`AbapModeGrants`,
 * src/mode.ts). Registration is only half the story — `src/safety.ts`'s
 * deny-list/productive ceiling and `evaluateDumpVariables` judge each actual
 * call. `canReadDumpVariables` gates a schema FIELD, not a whole tool: tier-1
 * dump reading stays registered unconditionally, only variable contents vary.
 *
 * `productive`/`writesLockedOut` are unknown until after the first
 * connection, long after `tools/list` may already have been answered — this
 * function only ever sees a `Config`, never a `SafetyGate`, and must not
 * depend on either.
 *
 * `canWrite` gates every tool with no ungated submode: `abap_write`,
 * `abap_run`, `abap_test`, `abap_fpm_read`, `abap_bopf_test`, `abap_ui`
 * (`press` additionally needs `ABAP_MODE=admin` + `allowUiPress`, checked at
 * call time), and `abap_bopf_edit`/`abap_bopf_delete`. `abap_transport`,
 * `abap_journal`, `abap_activate`, `abap_enh` stay registered unconditionally
 * — each has an ungated read/check submode, so `SafetyGate` alone refuses
 * their mutating submodes. `abap_transport_release` is its own tool (split
 * out so the one irreversible verb can't be reached by fuzzing an enum) and
 * is gated separately via `canReleaseTransport`. `abap_enh` stays ungated at
 * registration because its `discover_hook_anchors` submode makes no
 * `SafetyGate` call at all — hiding it behind `canWrite` would hide a
 * legitimate read too.
 */
export interface StaticCapabilities {
  /** Register `abap_write`, `abap_run`, `abap_test`, `abap_fpm_read`, `abap_ui`, `abap_bopf_test`, and the `abap_bopf_edit`/`abap_bopf_delete` pair. */
  readonly canWrite: boolean;
  /** Register `abap_transport_release`. Strictly narrower than `canWrite`: also requires `allowTransportRelease`. */
  readonly canReleaseTransport: boolean;
  /** Not currently used to gate any registration (see the doc comment above for why `abap_enh` stays unconditional) — kept for callers that want it and for `test/tools.test.ts` parity with `canWrite`/`canReleaseTransport`. */
  readonly canEnhance: boolean;
  /**
   * Register `abap_data_preview`. Deliberately NOT `&& canWrite` — a preview
   * is a read, and a read-only server is exactly where it belongs. Set from
   * `allowDataPreview` alone, in every `ABAP_MODE`.
   */
  readonly canPreviewData: boolean;
  /**
   * Advertises the **variable-contents** tier of a runtime-error dump read
   * (ST22's "Selected Variables" chapter). Tier 1 (error class, program,
   * line, source extract, call stack) needs no capability.
   *
   * Deliberately NOT `&& canWrite`: since `canWrite = !readOnly`, folding it
   * in would give a read-only production connection the WIDEST access to
   * real data while a sandbox with writes on got the narrowest — an inverted
   * control, not a strict/lax trade-off. Set from `allowDumpVariables` alone.
   *
   * "Off" means ABSENT, not refused: the field is spread into the schema
   * only when true, so nothing exists for a model to attempt or be
   * prompt-injected into requesting.
   */
  readonly canReadDumpVariables: boolean;
}

/** Pure function of `Config` — no I/O, no `SafetyGate`, safe to call once at startup. */
export function resolveStaticCapabilities(cfg: Config): StaticCapabilities {
  const canWrite = !cfg.readOnly;
  return {
    canWrite,
    canReleaseTransport: canWrite && cfg.allowTransportRelease,
    canEnhance: canWrite && cfg.allowEnhancements,
    // No `canWrite &&` here, or below — see canPreviewData/canReadDumpVariables
    // doc comments: requiring writes to read would invert the control.
    canPreviewData: cfg.allowDataPreview,
    canReadDumpVariables: cfg.allowDumpVariables,
  };
}

/**
 * Strips the password field and any userinfo credentials embedded in `url`.
 * DELIBERATELY leaves the host (`stripUrlCredentials` keeps it by design),
 * `user`, `sid`, and filesystem paths intact — this is not a full redaction,
 * the output still identifies the system and the account it connects as. A
 * caller that must not emit the host wants `describeUrlWithoutHost`. Same
 * treatment for `sessionCookie` — a session cookie authenticates exactly like
 * a password and is redacted identically: a fixed marker when set, an
 * explicit not-set marker otherwise, never `"***"` implying one exists when
 * it doesn't. Cookie NAMES are surfaced separately (`sessionCookieNames`) so
 * the startup banner is useful for diagnosing a wrong paste — a name is a
 * diagnostic, not a credential; no cookie value is ever in this projection.
 * There is deliberately no `toJSON` on Config itself.
 */
export function redactConfigSecrets(cfg: Config): Record<string, unknown> {
  return {
    url: stripUrlCredentials(cfg.url),
    user: cfg.user,
    password: cfg.password ? "***" : "(not set)",
    sessionCookie: cfg.sessionCookie ? "***" : "(not set)",
    sessionCookieNames: cfg.sessionCookie ? [...cfg.sessionCookie.keys()] : undefined,
    client: cfg.client || "(not sent)",
    sid: cfg.sid,
    insecure: cfg.insecure,
    terminalId: cfg.terminalId ?? "(derived)",
    ideId: cfg.ideId ?? "(derived)",
    // Neither field is sensitive; `undefined` here is legacy per-flag config
    // (ABAP_MODE unset), not a redaction.
    abapMode: cfg.abapMode ?? "(unset — legacy per-flag config)",
    capabilities: cfg.capabilities,
    toolSurface: cfg.toolSurface,
    verifyWrites: cfg.verifyWrites,
    readOnly: cfg.readOnly,
    allowPackages: cfg.allowPackages,
    allowNamePrefixes: cfg.allowNamePrefixes,
    allowTransports: cfg.allowTransports,
    allowTransportRelease: cfg.allowTransportRelease,
    allowDebugJumpToLine: cfg.allowDebugJumpToLine,
    allowEnhancements: cfg.allowEnhancements,
    enhanceTargets: cfg.enhanceTargets,
    enhanceTargetPackages: cfg.enhanceTargetPackages,
    allowSourcePlugins: cfg.allowSourcePlugins,
    allowEnhancementDelete: cfg.allowEnhancementDelete,
    allowDataPreview: cfg.allowDataPreview,
    dataPreviewMaxRows: cfg.dataPreviewMaxRows,
    dataPreviewDenyTables: cfg.dataPreviewDenyTables,
    allowDumpVariables: cfg.allowDumpVariables,
    allowUiPress: cfg.allowUiPress,
    originSystems: cfg.originSystems,
    maxResponseChars: cfg.maxResponseChars,
    stateDir: cfg.stateDir,
    lockWaitMs: cfg.lockWaitMs,
    maxSessions: cfg.maxSessions,
    readConcurrency: cfg.readConcurrency,
    writeConcurrency: cfg.writeConcurrency,
    serialiseSameObjectWrites: cfg.serialiseSameObjectWrites,
    sessionIdleMs: cfg.sessionIdleMs,
    sessionWaitMs: cfg.sessionWaitMs,
    debugDiaBudget: cfg.debugDiaBudget,
    crossProcessDebugLock: cfg.crossProcessDebugLock,
    debugLockWaitMs: cfg.debugLockWaitMs,
    // Neither a secret; reported unmasked so an operator can see at a glance
    // whether the cross-process object lock is actually on.
    crossProcessObjectLock: cfg.crossProcessObjectLock,
    objectLockWaitMs: cfg.objectLockWaitMs,
    // maxDdicActivationBatch bounds the server-side aRFC fan-out that once took
    // the appliance down — "what is it set to in this process?" is an
    // incident question, so it must be answerable from this report.
    maxDdicActivationBatch: cfg.maxDdicActivationBatch,
    maxSafeActivationBatch: cfg.maxSafeActivationBatch,
    startupProbe: cfg.startupProbe,
  };
}
