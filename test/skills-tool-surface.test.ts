/**
 * Coherence guard between the shipped skills (`skills/**\/SKILL.md`) and the
 * one tool surface a running server actually exposes (`src/server.ts`'s
 * registration, gated only by `cfg.readOnly` — see `src/tools/locked.ts`).
 *
 * ## History
 *
 * This file predates issue #76, which removed a second, six-tool
 * consolidated surface that used to be selectable via
 * `ABAP_TOOL_SURFACE=v2` (see the Removed entry in CHANGELOG.md and
 * doc/DESIGN-NOTES/tool-surface-v2.md; `test/tool-surface-removal.test.ts`
 * covers the removal itself — that a stale `ABAP_TOOL_SURFACE=v2` now fails
 * loudly at startup rather than silently changing what a caller can call).
 * Two of the four checks this file used to run existed only to catch a skill
 * grounded entirely in one surface's vocabulary with no acknowledgment the
 * other surface existed — with a single surface, that class of defect is
 * structurally impossible (every valid tool name IS a name on the one
 * surface, by construction of the remaining Check A below), so those two
 * checks were deleted rather than kept as permanently-vacuous assertions.
 * See the removal note further down for exactly what was dropped and why.
 *
 * ## Why the surviving checks exist
 *
 * The defect Check A guards against already happened once: a skill cited a
 * tool name (typo, or a stale reference to a renamed/removed tool) that does
 * not exist at all. A caller following that skill's worked example would hit
 * a plain "unknown tool" error with no other signal anything was wrong until
 * it was actually tried.
 *
 * A second, unrelated defect (recon, 2026-08-12) motivates Check D: a tool
 * the server actually ships (`abap_fpm_read`) had zero mentions in any skill
 * that a model working on FPM/Web Dynpro would naturally load, so live
 * sessions burned their budgets rediscovering by trial and error a boundary
 * (WDCC/WDCA are not writable over ADT REST) that both the tool and prior
 * research already made discoverable, IF a model had been routed to it.
 * Check D is this test's answer to that: every registered tool name must
 * appear in at least one skill file.
 *
 * ## What this file does NOT catch
 *
 * Both checks below are coarse "does this identifier appear somewhere in
 * this skill file's text" checks, not per-example / per-call-site shape
 * validation. Neither would mechanically catch a skill whose worked example
 * uses a real tool NAME with an action or field the current schema does not
 * accept (e.g. an action removed from `abap_debug`'s action set, or a field
 * zod would silently strip from a wire payload) — that class of drift needs
 * direct manual reading of the tool's registration against the skill's
 * examples, the way the two now-removed v1/v2 divergences that used to
 * motivate this file's Check B/Check C were originally found and fixed.
 *
 * Non-skill documentation is deliberately OUT of scope for Check D. A tool's
 * own wire description is always visible via `tools/list` regardless of
 * which skill (if any) is loaded, so "no doc ever mentions this tool" does
 * not carry the same risk as "no doc ever mentions this RESEARCH FINDING"
 * (the DDIC/SHLP/VIEW/FUGR situation). A docs-mention mechanical scan was
 * judged low-signal for the tool-coverage question specifically and was set
 * aside in favor of the manual audit already performed for that class of
 * gap.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { createServer, type AbapsmithServer } from "../src/server.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------- fixtures ---

/**
 * Every tool call this suite makes is `listTools()` only — never
 * `callTool()` — so no handler body ever runs and no request should reach
 * this client for any reason. It still has to be wrapped with
 * `routeSystemRoleProbe` (below), not because a probe will actually fire,
 * but because `test/system-role-probe-guard.test.ts`'s static intent-
 * declaration sweep triggers on `ConfigSchema.parse(` appearing in this
 * file's source at all, independent of whether a connection is ever opened
 * at runtime. See that guard's own doc comment and
 * `test/tools-schema-shape.test.ts`, which uses this exact pattern for the
 * same reason (a suite whose handlers are stubs/never called still has to
 * declare intent).
 */
class ForbiddenClient implements HttpClient {
  async request(_o: HttpClientOptions): Promise<HttpClientResponse> {
    throw new Error("NETWORK CALL LEAKED: this suite only ever calls listTools()");
  }
}

/**
 * A maximally-open config — every static capability gate
 * (`resolveStaticCapabilities`, `src/config.ts`) wide open, so `tools/list`
 * reflects the full tool inventory a server could ever expose, not whatever
 * a narrower default would hide.
 */
function fullyOpenConfig(): Config {
  return {
    ...ConfigSchema.parse({
      url: "http://sap.invalid:50000",
      user: "TESTUSER",
      password: "secret",
      sid: "TST",
      client: "001",
      readOnly: false,
      allowPackages: ["*"],
      allowNamePrefixes: ["Z", "Y"],
      allowTransportRelease: true,
      allowEnhancements: true,
      enhanceTargets: "sap",
      enhanceTargetPackages: ["*"],
      allowDataPreview: true,
      allowDumpVariables: true,
    }),
  };
}

interface Harness {
  srv: AbapsmithServer;
  client: Client;
}

async function harness(config: Config): Promise<Harness> {
  const srv = createServer(config, {
    httpClient: routeSystemRoleProbe(new ForbiddenClient(), { answer: "nonproductive" }),
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-skills-tool-surface", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), srv.mcp.connect(serverTransport)]);
  return { srv, client };
}

const namesOf = async (h: Harness): Promise<string[]> => (await h.client.listTools()).tools.map((t) => t.name);

// ---------------------------------------------------------------------------
// Skill-file scanning
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const skillsDir = join(repoRoot, "skills");

function listSkillFiles(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(skillsDir, entry.name, "SKILL.md");
    try {
      readFileSync(skillFile, "utf8");
    } catch {
      // No SKILL.md in this directory — not this test's concern.
      continue;
    }
    // A skill may split per-topic guidance into sibling `*.md` files that
    // SKILL.md tells the reader to open (e.g. write-abap-source/classes.md);
    // their worked examples and tool mentions count the same as SKILL.md's.
    for (const f of readdirSync(join(skillsDir, entry.name))) {
      if (f.endsWith(".md")) out.push(join(skillsDir, entry.name, f));
    }
  }
  return out.sort();
}

/**
 * Matches `abap_xxx` identifiers with a negative lookbehind word boundary —
 * NOT a bare `abap_[a-z_]+`, which would falsely match the tail of
 * `cl_abap_conv_in_ce` (a real ABAP class name that appears in
 * `skills/fpm/SKILL.md`) as if it were a tool named `abap_conv_in_ce`. This
 * exact false positive was caught while designing this test — any future
 * edit to this regex must re-check against that string.
 */
const TOOL_NAME_RE = /(?<![A-Za-z0-9_])abap_[a-z_]+/g;

function extractToolNames(text: string): Set<string> {
  return new Set(text.match(TOOL_NAME_RE) ?? []);
}

/**
 * Names that legitimately appear in skill prose despite naming no tool this
 * server ever registers. Each entry must be justified — this is not a place
 * to silence a genuine typo.
 *
 * `abap_fpm_write` — mentioned in `skills/fpm/SKILL.md` purely as the name
 * of a tool that was deliberately investigated and NEVER built (~23.9%
 * silent round-trip byte corruption via the one mechanism that could reach
 * it, no transactional undo; ADT REST itself has no write endpoint for the
 * underlying WDCC/WDCA objects at all). The skill
 * discusses it explicitly to explain why it does NOT exist and to head off a
 * future contributor "finishing the job" — see the assertion immediately
 * below, which fails loudly on the day that stops being true.
 */
const KNOWN_HYPOTHETICAL_NAMES = new Set(["abap_fpm_write"]);

// ---------------------------------------------------------------------------

describe("skills <-> tool-surface coherence (capability discoverability + name accuracy)", () => {
  it("KNOWN_HYPOTHETICAL_NAMES stays disjoint from every real tool name", async () => {
    // This is the guard against "finish the job": if abap_fpm_write (or any
    // other name in the exemption set) is ever actually registered, this
    // assertion fails loudly, forcing the exemption to be removed and the
    // skill prose that explains its absence to be revisited — rather than
    // Check A silently starting to treat a real, load-bearing tool name as
    // hypothetical prose forever.
    const h = await harness(fullyOpenConfig());
    const allReal = new Set(await namesOf(h));

    const collisions = [...KNOWN_HYPOTHETICAL_NAMES].filter((n) => allReal.has(n));
    expect(
      collisions,
      `KNOWN_HYPOTHETICAL_NAMES now names a REAL registered tool (${collisions.join(", ")}). ` +
        "That tool must have just been built. Remove it from KNOWN_HYPOTHETICAL_NAMES in " +
        "test/skills-tool-surface.test.ts and update the skill prose that used to explain its " +
        "absence (see skills/fpm/SKILL.md).",
    ).toEqual([]);
  });

  it("Check A — every abap_* name mentioned in a skill is a real tool name, or is explicitly justified as hypothetical", async () => {
    const h = await harness(fullyOpenConfig());
    const known = new Set([...(await namesOf(h)), ...KNOWN_HYPOTHETICAL_NAMES]);

    const offenders: string[] = [];
    for (const file of listSkillFiles()) {
      const text = readFileSync(file, "utf8");
      for (const name of extractToolNames(text)) {
        if (!known.has(name)) offenders.push(`${file}: "${name}"`);
      }
    }

    expect(
      offenders,
      "Skill file(s) reference a tool name that does not exist and is not in " +
        "KNOWN_HYPOTHETICAL_NAMES — likely a typo or a stale reference to a renamed/removed tool:\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("Check D — every real tool name is mentioned by at least one skill (capability discoverability)", async () => {
    const h = await harness(fullyOpenConfig());
    const allReal = new Set(await namesOf(h));

    const mentioned = new Set<string>();
    for (const file of listSkillFiles()) {
      for (const name of extractToolNames(readFileSync(file, "utf8"))) mentioned.add(name);
    }

    const unmentioned = [...allReal].filter((n) => !mentioned.has(n)).sort();

    expect(
      unmentioned,
      "Tool(s) have ZERO mention across every skills/**/SKILL.md file — a model would only ever " +
        "discover them by independently reading tools/list with no guidance on when/why to reach " +
        "for them (this is exactly the abap_fpm_read discoverability defect: the tool existed and " +
        "worked, but nothing routed a caller to it). Add a pointer to the most relevant existing " +
        "skill rather than leaving this list non-empty:\n" + unmentioned.join(", "),
    ).toEqual([]);
  });

  it("sanity: the skills directory actually contains files (a guard that silently scans nothing is worse than no guard)", () => {
    const files = listSkillFiles();
    expect(files.length, "found zero skills/**/SKILL.md files — scan path is broken").toBeGreaterThan(0);
  });
});
