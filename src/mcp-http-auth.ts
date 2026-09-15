/**
 * Bearer-token authentication for the Streamable HTTP MCP transport
 * (`src/mcp-http.ts`). Token parsing (`ABAP_MCP_HTTP_TOKEN`) and the
 * loopback check both also run inside `src/config.ts` at startup — this
 * module is self-contained (no imports beyond `node:crypto`) so `config.ts`
 * can import it without pulling in the HTTP transport.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export interface HttpToken {
  readonly name?: string;
  readonly value: string;
}

/** A named token's name — printable ASCII, no `=`, no comma (both are the `ABAP_MCP_HTTP_TOKEN` list/pair separators). */
export const HTTP_TOKEN_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Parses `ABAP_MCP_HTTP_TOKEN` — a comma-separated list of tokens, each
 * either bare (`value`) or named (`name=value`).
 *
 * Splits on `,`, trims each entry, drops empties. For each remaining entry:
 *  - if it matches `^(name)=(rest)$` where `name` satisfies
 *    {@link HTTP_TOKEN_NAME_PATTERN} and `rest` is non-empty, it is a NAMED
 *    token `{ name, value: rest }` — the name is what the journal records
 *    as `actor` (`src/mcp-session.ts`'s `mcpSessionActor`) when this token
 *    authenticates a caller.
 *  - otherwise the WHOLE entry (including any `=` it contains) is an
 *    UNNAMED token `{ value: entry }`. This fallback is what keeps a plain
 *    base64 token — which may itself contain `=` padding — working
 *    unnamed instead of being misparsed as a (name, rest) pair whose
 *    "name" isn't a real name at all.
 *
 * Duplicate names are not rejected here — `verifyBearer` iterates every
 * token regardless, so a duplicate name just means two tokens answer with
 * the same `caller`.
 */
export function parseHttpTokens(raw: string | undefined): HttpToken[] {
  if (raw === undefined) return [];
  const tokens: HttpToken[] = [];
  for (const rawEntry of raw.split(",")) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq > 0) {
      const name = entry.slice(0, eq);
      const rest = entry.slice(eq + 1);
      if (HTTP_TOKEN_NAME_PATTERN.test(name) && rest !== "") {
        tokens.push({ name, value: rest });
        continue;
      }
    }
    tokens.push({ value: entry });
  }
  return tokens;
}

/**
 * True for a host that only ever accepts connections from this machine.
 * Case-insensitive: `localhost`, `::1`, `[::1]`, `0:0:0:0:0:0:0:1`, and any
 * IPv4 in `127.0.0.0/8`.
 *
 * Everything else — INCLUDING the wildcard binds `0.0.0.0` and `::` — is
 * false. A wildcard bind is reachable from off-box, which is exactly the
 * case `ABAP_MCP_HTTP_TOKEN` exists to guard: `loadConfig` (`src/config.ts`)
 * refuses to start with `ABAP_MCP_TRANSPORT=http` on a non-loopback host
 * unless a token is configured.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === "localhost" || h === "::1" || h === "[::1]" || h === "0:0:0:0:0:0:0:1") return true;
  const m = /^(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (!m) return false;
  const firstOctet = Number(m[1]);
  return Number.isInteger(firstOctet) && firstOctet === 127;
}

export type BearerVerdict =
  | { ok: true; caller?: string }
  | { ok: false; reason: "missing" | "malformed" | "rejected" };

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Checks a raw `Authorization` header against the configured tokens.
 *
 * `tokens.length === 0` unconditionally returns `{ ok: true }` — no auth is
 * configured. This is only reachable on a loopback bind in practice:
 * `loadConfig` (`src/config.ts`) refuses to start `ABAP_MCP_TRANSPORT=http`
 * on a non-loopback host with no token configured, so this function is not
 * itself the place that enforces the loopback rule — it trusts the caller
 * (`src/mcp-http.ts`, constructed from a `Config` that already passed that
 * check) to have an empty `tokens` array only when that's safe.
 */
export function verifyBearer(header: string | undefined, tokens: readonly HttpToken[]): BearerVerdict {
  if (tokens.length === 0) return { ok: true };

  if (header === undefined || header.trim() === "") return { ok: false, reason: "missing" };

  const m = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  const presented = m?.[1]?.trim();
  if (!presented) return { ok: false, reason: "malformed" };

  const presentedHash = sha256(presented);
  let matched: HttpToken | undefined;
  // Iterate ALL tokens, never short-circuiting on the first match: the
  // loop's duration must not depend on which entry matched (or whether any
  // did), so it doesn't itself become a timing side-channel for a caller
  // brute-forcing token names/positions.
  for (const token of tokens) {
    const candidateHash = sha256(token.value);
    if (timingSafeEqual(presentedHash, candidateHash) && matched === undefined) {
      matched = token;
    }
  }

  if (matched === undefined) return { ok: false, reason: "rejected" };
  return matched.name !== undefined ? { ok: true, caller: matched.name } : { ok: true };
}
