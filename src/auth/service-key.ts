/**
 * An SAP BTP ABAP-environment service key is a JSON document; this reads the
 * OAuth 2.0 client-credentials settings out of it so an operator can point
 * `ABAP_SERVICE_KEY` at the file SAP handed them instead of re-typing the
 * four `ABAP_OAUTH_*` variables by hand. The `clientsecret` inside is
 * exactly as sensitive as `ABAP_PASSWORD`: held in memory only, never
 * logged, never serialised.
 *
 * UNVERIFIED: this path has never been exercised against a real BTP tenant
 * — see the "unverified" note in doc/LIMITATIONS/authentication.md.
 *
 * Shape handled: the standard BTP ABAP-environment service key has a
 * top-level `url` (the ABAP system itself — not read here, `ABAP_URL`
 * remains the source of truth for that) and a `uaa` object carrying
 * `clientid`, `clientsecret`, and `url` (the UAA base). The token endpoint
 * is `<uaa.url>/oauth/token`, unless `uaa.url` already ends in
 * `/oauth/token` — some key variants embed it already — in which case it is
 * used as-is rather than doubling the suffix. `uaa.scope`, when present and
 * non-empty, becomes the default scope (usually absent).
 */

export interface OAuthSettings {
  readonly tokenUrl: string;
  readonly clientId: string;
  /** Secret. Never log, never serialise. */
  readonly clientSecret: string;
  readonly scope?: string;
  /** Where the settings came from. Safe to log. */
  readonly source: "env" | "service-key";
  /** Safe to log. Set only when `source` is "service-key". */
  readonly serviceKeyPath?: string;
}

interface RawServiceKey {
  readonly uaa?: {
    readonly clientid?: unknown;
    readonly clientsecret?: unknown;
    readonly url?: unknown;
    readonly scope?: unknown;
  };
}

/** Joins field names the way the rest of config.ts's startup messages do: `"a"`, `"a and b"`, `"a, b, and c"`. */
function joinFieldNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

export function parseServiceKey(
  path: string,
  raw: string,
): { settings?: OAuthSettings; issue?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { issue: `ABAP_SERVICE_KEY (${path}) is not valid JSON: ${msg}.` };
  }

  const uaa = (parsed as RawServiceKey | null)?.uaa;
  const clientId = typeof uaa?.clientid === "string" ? uaa.clientid : undefined;
  const clientSecret = typeof uaa?.clientsecret === "string" ? uaa.clientsecret : undefined;
  const uaaUrl = typeof uaa?.url === "string" ? uaa.url : undefined;

  const missing = [
    ...(clientId === undefined ? ["uaa.clientid"] : []),
    ...(clientSecret === undefined ? ["uaa.clientsecret"] : []),
    ...(uaaUrl === undefined ? ["uaa.url"] : []),
  ];
  if (missing.length > 0) {
    // Never echo any value from the file here — only field NAMES, which
    // carry no secret.
    return {
      issue:
        `ABAP_SERVICE_KEY (${path}) is missing ${joinFieldNames(missing)} — this does not look ` +
        "like an SAP BTP ABAP-environment service key.",
    };
  }

  // Guaranteed defined past the `missing` check above; re-asserted via the
  // condition below rather than a non-null assertion so a future refactor
  // that reorders these checks can't silently reintroduce `undefined`.
  if (clientId === undefined || clientSecret === undefined || uaaUrl === undefined) {
    return { issue: `ABAP_SERVICE_KEY (${path}) is missing required uaa fields.` };
  }

  const tokenUrl = uaaUrl.endsWith("/oauth/token")
    ? uaaUrl
    : `${uaaUrl.replace(/\/+$/, "")}/oauth/token`;
  const scope = typeof uaa?.scope === "string" && uaa.scope.length > 0 ? uaa.scope : undefined;

  return {
    settings: {
      tokenUrl,
      clientId,
      clientSecret,
      ...(scope !== undefined ? { scope } : {}),
      source: "service-key",
      serviceKeyPath: path,
    },
  };
}
