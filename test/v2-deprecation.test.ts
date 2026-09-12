/**
 * Pins the v2 tool surface's deprecation notice (issue #76, step 1).
 *
 * ## Why this matters
 *
 * `ABAP_TOOL_SURFACE=v2` is frozen and scheduled for removal in
 * `V2_REMOVAL_RELEASE` (`src/server.ts`). An operator who set that env var
 * finds out from two channels: the MCP `instructions` string a model reads
 * once per session, and a stderr line `start()` prints at every launch. If
 * either channel silently drifted from `V2_REMOVAL_RELEASE` — or from each
 * other — an operator would plan a migration against a release number that
 * is no longer true, and would only discover the surface is actually gone
 * when `ABAP_TOOL_SURFACE=v2` stops working outright, not when the warning
 * told them to move. The whole point of `V2_DEPRECATION_SENTENCE` being a
 * single shared constant (see its doc comment in `src/server.ts`) is that
 * the operator-facing warning and the model-facing instructions can never
 * disagree about the date; this file is what makes a future edit to either
 * call site — or to the docs that repeat the same claim in prose — fail
 * loudly instead of drifting quietly.
 *
 * ## What this pins
 *
 * 1. `instructionsFor("v2", …)` embeds `V2_DEPRECATION_SENTENCE` (and hence
 *    `V2_REMOVAL_RELEASE`) verbatim.
 * 2. `instructionsFor("v1", …)` carries neither — v1 is not deprecated, and
 *    must not imply it is.
 * 3. Driving the REAL `createServer(cfg, { log }).start()` with
 *    `toolSurface: "v2"` prints exactly one line containing
 *    `V2_DEPRECATION_SENTENCE` that also names `doc/TOOL-SURFACE-V2/README.md`
 *    — and does so with `startupProbe: false` and an `HttpClient` that
 *    throws on any request, so this suite also proves the warning is a pure
 *    log line: it costs zero ADT requests.
 * 4. The same drive with `toolSurface: "v1"` never prints a DEPRECATED line.
 * 5. The three docs that repeat this claim in prose — `doc/TOOL-SURFACE-V2/
 *    README.md`, the `ABAP_TOOL_SURFACE` row in `doc/CONFIGURATION/
 *    journal-diagnostics-and-tooling.md`, and the `## The v2 tool surface`
 *    section of `doc/LIMITATIONS/overview.md` — all name the CURRENT
 *    `V2_REMOVAL_RELEASE`, read live off disk and compared against the
 *    constant rather than a hardcoded duplicate of it, so a doc that falls
 *    out of sync when the constant is next bumped fails here instead of
 *    only being caught by a human proofreading three files.
 *
 * `ConfigSchema.parse(` appears below (§3/§4 need a real `Config` to drive
 * `createServer`), so per `test/system-role-probe-guard.test.ts`'s
 * intent-declaration sweep this suite wraps its `HttpClient` with
 * `routeSystemRoleProbe` from `test/helpers/system-role-fake.ts` — same
 * pattern `test/tools-v2-budget.test.ts` and `test/skills-tool-surface.
 * test.ts` use for a client that must never actually be called: with
 * `startupProbe: false`, `start()` never calls `ensureConnected()`, so the
 * probe route the wrapper answers is never actually hit either, but the
 * declaration of intent (this suite's fake stands for a "nonproductive"
 * system) still has to be made on purpose rather than left silent.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { ConfigSchema, type Config } from "../src/config.js";
import {
  createServer,
  instructionsFor,
  V2_DEPRECATION_SENTENCE,
  V2_REMOVAL_RELEASE,
  type AbapsmithServer,
} from "../src/server.js";
import { Journal } from "../src/journal.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";

const DOC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "doc");

// ===========================================================================
// §1/§2 — instructionsFor
// ===========================================================================

describe("instructionsFor / v2 deprecation", () => {
  it("v2 instructions embed V2_DEPRECATION_SENTENCE (and hence V2_REMOVAL_RELEASE) verbatim", () => {
    const v2 = instructionsFor("v2", undefined, true, []);
    expect(
      v2,
      "instructionsFor(\"v2\", …) must embed V2_DEPRECATION_SENTENCE verbatim — the model reading " +
        "`instructions` is the other half of the shared-constant guarantee `src/server.ts` documents",
    ).toContain(V2_DEPRECATION_SENTENCE);
    expect(
      v2,
      `instructionsFor("v2", …) must name the current V2_REMOVAL_RELEASE (${V2_REMOVAL_RELEASE})`,
    ).toContain(V2_REMOVAL_RELEASE);
  });

  it("v1 instructions carry neither the deprecation sentence nor the removal release", () => {
    const v1 = instructionsFor("v1", undefined, true, []);
    expect(
      v1,
      "instructionsFor(\"v1\", …) must not carry a deprecation notice for a surface it is not",
    ).not.toContain(V2_DEPRECATION_SENTENCE);
    expect(
      v1,
      `instructionsFor("v1", …) must not mention V2_REMOVAL_RELEASE (${V2_REMOVAL_RELEASE}) — that release is not relevant to v1`,
    ).not.toContain(V2_REMOVAL_RELEASE);
  });
});

// ===========================================================================
// §3/§4 — the REAL start() stderr line
// ===========================================================================

/**
 * Throws on any request, recording each one first. Combined with
 * `startupProbe: false` below, `start()` never calls `ensureConnected()` at
 * all, so this client should never be touched — recording (rather than just
 * throwing) lets the tests assert that directly instead of only relying on
 * "the suite would have thrown".
 */
class ThrowingHttpClient implements HttpClient {
  public readonly requests: HttpClientOptions[] = [];
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.requests.push(o);
    throw new Error(`NETWORK CALL LEAKED: the v2 deprecation warning must be printable with zero ADT requests (${o.url})`);
  }
}

const cfg = (toolSurface: Config["toolSurface"]): Config => ({
  ...ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "secret",
    sid: "TST",
    client: "001",
    toolSurface,
    // The point of this suite: prove the deprecation line is a pure log
    // statement that never touches the wire, not just that it survives a
    // healthy probe.
    startupProbe: false,
  }),
});

describe("start() v2 deprecation warning", () => {
  let openServers: AbapsmithServer[] = [];
  let journalDir = "";
  let warnings: string[] = [];

  function log(m: string): void {
    warnings.push(m);
  }

  async function build(config: Config, client: ThrowingHttpClient): Promise<AbapsmithServer> {
    const srv = createServer(config, {
      httpClient: routeSystemRoleProbe(client, { answer: "nonproductive" }),
      log,
      breaker: new AuthCircuitBreaker(),
      journal: new Journal({ dir: journalDir, enabled: true, maxEntries: 100, maxAgeDays: 30 }, config.sid),
    });
    openServers.push(srv);
    return srv;
  }

  beforeEach(() => {
    openServers = [];
    warnings = [];
    journalDir = mkdtempSync(join(tmpdir(), "abapsmith-v2-deprecation-"));
  });

  afterEach(async () => {
    for (const srv of openServers) {
      await srv.stop().catch(() => {});
    }
    openServers = [];
    rmSync(journalDir, { recursive: true, force: true });
  });

  it("v2: prints exactly one line naming V2_DEPRECATION_SENTENCE and doc/TOOL-SURFACE-V2/README.md, with zero ADT requests", async () => {
    const client = new ThrowingHttpClient();
    const srv = await build(cfg("v2"), client);

    await srv.start();

    const deprecationLines = warnings.filter((w) => w.includes(V2_DEPRECATION_SENTENCE));
    expect(
      deprecationLines,
      `expected exactly one deprecation line, got: ${JSON.stringify(warnings)}`,
    ).toHaveLength(1);
    const deprecationLine = deprecationLines.find(() => true);
    expect(
      deprecationLine,
      "the startup warning must point operators at the v2 doc for known defects and status",
    ).toContain("doc/TOOL-SURFACE-V2/README.md");
    expect(
      client.requests,
      `ABAP_STARTUP_PROBE=false must mean zero ADT requests reach the wire from start(); saw: ${JSON.stringify(client.requests.map((r) => r.url))}`,
    ).toHaveLength(0);
  });

  it("v1: never prints a DEPRECATED line", async () => {
    const client = new ThrowingHttpClient();
    const srv = await build(cfg("v1"), client);

    await srv.start();

    expect(
      warnings.some((w) => w.includes("DEPRECATED")),
      `v1 must never print a DEPRECATED line, saw: ${JSON.stringify(warnings)}`,
    ).toBe(false);
    expect(client.requests).toHaveLength(0);
  });
});

// ===========================================================================
// §5 — documentation coherence, read live off disk
// ===========================================================================

describe("v2 deprecation docs name the current V2_REMOVAL_RELEASE", () => {
  it("doc/TOOL-SURFACE-V2/README.md says DEPRECATED and names the release in its first 15 lines", () => {
    const banner = readFileSync(join(DOC_ROOT, "TOOL-SURFACE-V2", "README.md"), "utf8")
      .split("\n")
      .slice(0, 15)
      .join("\n");
    expect(
      banner,
      "doc/TOOL-SURFACE-V2/README.md's opening banner must say DEPRECATED",
    ).toContain("DEPRECATED");
    expect(
      banner,
      `doc/TOOL-SURFACE-V2/README.md's opening banner must name the current V2_REMOVAL_RELEASE ` +
        `(${V2_REMOVAL_RELEASE}) — update doc/TOOL-SURFACE-V2/README.md when bumping V2_REMOVAL_RELEASE in src/server.ts`,
    ).toContain(V2_REMOVAL_RELEASE);
  });

  it("the ABAP_TOOL_SURFACE row in doc/CONFIGURATION/journal-diagnostics-and-tooling.md names the release and says deprecated", () => {
    const docPath = join(DOC_ROOT, "CONFIGURATION", "journal-diagnostics-and-tooling.md");
    const row = readFileSync(docPath, "utf8")
      .split("\n")
      .find((line) => line.includes("| `ABAP_TOOL_SURFACE`"));
    expect(
      row,
      "doc/CONFIGURATION/journal-diagnostics-and-tooling.md must have an ABAP_TOOL_SURFACE table row",
    ).toBeDefined();
    expect(row, "the ABAP_TOOL_SURFACE row must say the value is deprecated").toContain("deprecated");
    expect(
      row,
      `the ABAP_TOOL_SURFACE row must name the current V2_REMOVAL_RELEASE (${V2_REMOVAL_RELEASE}) — ` +
        "update doc/CONFIGURATION/journal-diagnostics-and-tooling.md when bumping V2_REMOVAL_RELEASE in src/server.ts",
    ).toContain(V2_REMOVAL_RELEASE);
  });

  it("the '## The v2 tool surface' section of doc/LIMITATIONS/overview.md names the release", () => {
    const docPath = join(DOC_ROOT, "LIMITATIONS", "overview.md");
    const lines = readFileSync(docPath, "utf8").split("\n");
    const start = lines.findIndex((line) => line.startsWith("## The v2 tool surface"));
    expect(
      start,
      "doc/LIMITATIONS/overview.md must have a '## The v2 tool surface' heading",
    ).toBeGreaterThanOrEqual(0);
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if ((lines[i] ?? "").startsWith("## ")) {
        end = i;
        break;
      }
    }
    const section = lines.slice(start, end).join("\n");
    expect(
      section,
      `doc/LIMITATIONS/overview.md's '## The v2 tool surface' section must name the current ` +
        `V2_REMOVAL_RELEASE (${V2_REMOVAL_RELEASE}) — update doc/LIMITATIONS/overview.md when bumping ` +
        "V2_REMOVAL_RELEASE in src/server.ts",
    ).toContain(V2_REMOVAL_RELEASE);
  });
});
