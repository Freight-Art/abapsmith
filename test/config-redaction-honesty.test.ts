/**
 * `redactConfigSecrets` (`src/config.ts`).
 *
 * The function used to be called `redactConfig` with the doc comment "Safe-to-
 * log projection" — false: `url` goes through `stripUrlCredentials`, which
 * DELIBERATELY keeps the host (see `test/config-url-redaction.test.ts`), and
 * the projection also emits `user`, `sid`, and `stateDir` (a filesystem path)
 * verbatim. Two things changed together:
 *
 *   - the function was renamed to `redactConfigSecrets`, with NO back-compat
 *     alias — mirroring `redactUrl` → `stripUrlCredentials`, which earlier
 *     made the identical call for the identical reason;
 *   - the doc comment now says what actually happens: secrets are redacted,
 *     the host/user/sid are not.
 *
 * This file has two halves. The first (RED before, GREEN after) pins the
 * rename and the secret-stripping. The second — clearly marked below — is
 * CHARACTERISATION: it passes both before and after this change, on purpose.
 * Its job isn't to catch a regression in behaviour that doesn't exist yet; it
 * is to turn "the host/user/sid survive redaction" from an accident a future
 * edit could quietly undo into a stated, tested contract that can't drift
 * from the doc comment without a red test forcing the doc comment to be
 * touched too.
 */
import { describe, expect, it } from "vitest";

import { ConfigSchema, redactConfigSecrets } from "../src/config.js";
import * as config from "../src/config.js";

const cfg = (over: Record<string, unknown> = {}) =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "s3cr3t-do-not-log",
    sid: "A4H",
    ...over,
  });

describe("redactConfigSecrets: the rename and the secret-stripping it was named for", () => {
  it("is exported and redacts the password", () => {
    const redacted = redactConfigSecrets(cfg());
    expect(redacted.password).toBe("***");
    expect(JSON.stringify(redacted)).not.toContain("s3cr3t-do-not-log");
  });

  // Pins the deliberate no-alias policy, the same call made earlier for
  // redactUrl → stripUrlCredentials: the old name isn't kept around as a
  // compatibility shim, it's just gone.
  it("no longer exports the old `redactConfig` name — no back-compat alias, mirroring the earlier redactUrl removal", () => {
    expect("redactConfig" in config).toBe(false);
  });

  it("strips userinfo credentials embedded in the URL", () => {
    const redacted = redactConfigSecrets(
      cfg({ url: "http://user:s3cr3t@sap.invalid:50000" }),
    );
    const url = String(redacted.url);
    expect(url).not.toContain("s3cr3t");
    expect(url).not.toContain("user:s3cr3t");
  });
});

// ---------------------------------------------------------------------------
// Characterisation only, below this line: these assertions pass on BOTH the
// old and the new code. They are not red-proof — they exist so that the
// retained fields are a stated contract, not an accident a later edit could
// silently drop without also having to change the (now-accurate) doc comment
// on redactConfigSecrets.
// ---------------------------------------------------------------------------
describe("redactConfigSecrets: fields DELIBERATELY not stripped (characterisation, not a regression guard)", () => {
  it("keeps the host — server.ts already prints the same host unconditionally, so hiding it here would close nothing", () => {
    const redacted = redactConfigSecrets(cfg({ url: "http://sap.invalid:50000" }));
    expect(String(redacted.url)).toContain("sap.invalid");
  });

  it("keeps `user` verbatim — needed for operator diagnostics (which account is this process running as)", () => {
    const redacted = redactConfigSecrets(cfg({ user: "DEVELOPER" }));
    expect(redacted.user).toBe("DEVELOPER");
  });

  it("keeps `sid` verbatim — needed for operator diagnostics (which system is this process pointed at)", () => {
    const redacted = redactConfigSecrets(cfg({ sid: "A4H" }));
    expect(redacted.sid).toBe("A4H");
  });
});
