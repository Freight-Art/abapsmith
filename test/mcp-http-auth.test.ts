/**
 * `src/mcp-http-auth.ts` — the bearer-token gate the Streamable HTTP MCP
 * transport (issue #81) sits behind, plus the loopback classifier that
 * `loadConfig` (src/config.ts) uses to decide whether a token is mandatory.
 *
 * This file is a pure unit suite: no server, no socket, no FakeAdtServer.
 * The three functions under test (`parseHttpTokens`, `isLoopbackHost`,
 * `verifyBearer`) are the entire trust boundary for the new remote
 * transport — a parsing mistake here (e.g. treating a base64 token's `=`
 * padding as a name separator) or a loopback misclassification (treating a
 * wildcard bind as safe) would silently turn "local-only, no token needed"
 * into "reachable from the network, no token needed". Every branch each
 * function can take is pinned individually so a future edit cannot narrow
 * or widen the auth surface without a test failing.
 */
import { describe, expect, it } from "vitest";
import {
  HTTP_TOKEN_NAME_PATTERN,
  isLoopbackHost,
  parseHttpTokens,
  verifyBearer,
  type HttpToken,
} from "../src/mcp-http-auth.js";

// ---------------------------------------------------------------------------
// parseHttpTokens
// ---------------------------------------------------------------------------

describe("parseHttpTokens", () => {
  it("undefined yields no tokens", () => {
    expect(parseHttpTokens(undefined)).toEqual([]);
  });

  it("an empty string yields no tokens", () => {
    expect(parseHttpTokens("")).toEqual([]);
  });

  it("a string of only commas and whitespace yields no tokens", () => {
    expect(parseHttpTokens("  ,  ")).toEqual([]);
  });

  it("a single bare value is one unnamed token", () => {
    expect(parseHttpTokens("secret")).toEqual([{ value: "secret" }]);
  });

  it("name=value is one named token", () => {
    expect(parseHttpTokens("alice=s3cr3t")).toEqual([{ name: "alice", value: "s3cr3t" }]);
  });

  it("a comma-separated list of two named tokens trims whitespace around each entry", () => {
    expect(parseHttpTokens("alice=s3cr3t, bob=other")).toEqual([
      { name: "alice", value: "s3cr3t" },
      { name: "bob", value: "other" },
    ]);
  });

  it("a base64-looking value whose own '=' padding sits at the end stays ONE UNNAMED token, not a (name, empty-rest) pair", () => {
    // "dG9rZW4" (before the '=') is itself a valid name per HTTP_TOKEN_NAME_PATTERN,
    // but the "rest" after that '=' is empty — the named branch requires a
    // non-empty rest, so this must fall through to the unnamed case with the
    // WHOLE entry (padding included) as the value.
    const tokens = parseHttpTokens("dG9rZW4=");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.name).toBeUndefined();
    expect(tokens[0]!.value).toBe("dG9rZW4=");
  });

  it("a value that itself contains '=' splits on the FIRST '=' only", () => {
    expect(parseHttpTokens("alice=abc=def")).toEqual([{ name: "alice", value: "abc=def" }]);
  });

  it("an entry whose prefix before '=' is not a valid name falls back to one unnamed token holding the whole entry", () => {
    const tokens = parseHttpTokens("not a name=x");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.name).toBeUndefined();
    expect(tokens[0]!.value).toBe("not a name=x");
  });

  it("a name longer than 64 characters is rejected by HTTP_TOKEN_NAME_PATTERN, falling back to one unnamed token", () => {
    const longName = "a".repeat(65);
    expect(HTTP_TOKEN_NAME_PATTERN.test(longName), "fixture must actually exceed the pattern's limit").toBe(
      false,
    );
    const entry = `${longName}=x`;
    const tokens = parseHttpTokens(entry);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.name).toBeUndefined();
    expect(tokens[0]!.value).toBe(entry);
  });
});

// ---------------------------------------------------------------------------
// isLoopbackHost
// ---------------------------------------------------------------------------

describe("isLoopbackHost", () => {
  it.each(["127.0.0.1", "127.1.2.3", "localhost", "LOCALHOST", "::1", "[::1]", "0:0:0:0:0:0:0:1"])(
    "%s is loopback",
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each(["0.0.0.0", "::", "192.168.1.10", "10.0.0.1", "example.invalid", ""])(
    "%s is NOT loopback",
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    },
  );

  it("a wildcard bind (0.0.0.0) is not treated as loopback, even though it can locally accept connections too", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyBearer
// ---------------------------------------------------------------------------

describe("verifyBearer", () => {
  it("an empty token list accepts any header, including no header at all", () => {
    // Safe only because loadConfig (src/config.ts) refuses to start
    // ABAP_MCP_TRANSPORT=http on a non-loopback host with no token
    // configured — verifyBearer itself trusts the caller to have an empty
    // `tokens` array only when that refusal already applies. See
    // test/config-mcp-transport.test.ts for that refusal.
    expect(verifyBearer(undefined, [])).toEqual({ ok: true });
    expect(verifyBearer("", [])).toEqual({ ok: true });
    expect(verifyBearer("Bearer whatever", [])).toEqual({ ok: true });
  });

  const tokens: HttpToken[] = [{ value: "s3cr3t" }, { name: "alice", value: "alice-secret" }];

  it.each([undefined, "", "   "])("header %j with tokens configured is reported as missing", (header) => {
    expect(verifyBearer(header, tokens)).toEqual({ ok: false, reason: "missing" });
  });

  it.each(["Basic abc", "Bearer", "Bearer   ", "abc"])(
    "header %j with tokens configured is reported as malformed",
    (header) => {
      expect(verifyBearer(header, tokens)).toEqual({ ok: false, reason: "malformed" });
    },
  );

  it("a lowercase 'bearer' scheme still matches an unnamed token, with caller undefined", () => {
    expect(verifyBearer("bearer s3cr3t", tokens)).toEqual({ ok: true, caller: undefined });
  });

  it("a matching named token's value reports that token's name as caller", () => {
    expect(verifyBearer("Bearer alice-secret", tokens)).toEqual({ ok: true, caller: "alice" });
  });

  it("a value not present in the configured tokens is rejected", () => {
    expect(verifyBearer("Bearer wrong-value", tokens)).toEqual({ ok: false, reason: "rejected" });
  });

  it("a presented value that is a strict PREFIX of a configured token is rejected, not treated as a partial match", () => {
    expect(verifyBearer("Bearer alice-secr", tokens)).toEqual({ ok: false, reason: "rejected" });
  });

  it("a presented value LONGER than a configured token (which the token itself prefixes) is also rejected", () => {
    expect(verifyBearer("Bearer alice-secretXXX", tokens)).toEqual({ ok: false, reason: "rejected" });
  });
});
