/**
 * Coherence guard between the shipped skills (`skills/**\/SKILL.md`) and the
 * two tool surfaces a running server can actually expose
 * (`ABAP_TOOL_SURFACE=v1`, the shipped default, and `v2`, the 6-tool
 * consolidated surface — see `src/config.ts`'s `toolSurface` doc comment).
 *
 * ## Why this file exists
 *
 * The defect this guards against already happened once: the shipped skills
 * were written primarily against v2 tool names/shapes (`abap_do`, `abap_find`,
 * `abap_debug`'s `vars`/`value` actions, `abap_write`'s `edit`/`method`
 * fields) while the shipped DEFAULT surface is v1, which either doesn't have
 * those names at all, or has the same tool name with a materially different
 * action/field set. A caller following a skill's worked example on a fresh,
 * default-configured server would send a call shape the running server
 * cannot honor — sometimes with a clear error (unknown tool), sometimes with
 * a much worse one (zod silently strips unknown fields, e.g. `edit`/`method`
 * on v1's `abap_write`, and the call fails downstream with a confusing
 * "source is required" instead of a clear "unsupported field on this
 * surface" message).
 *
 * A second, related defect (recon, 2026-08-12): a tool the server actually
 * ships (`abap_fpm_read`) had zero mentions in any skill that a model
 * working on FPM/Web Dynpro would naturally load, so live sessions burned
 * their budgets rediscovering by trial and error a boundary (WDCC/WDCA are
 * not writable over ADT REST) that both the tool and prior research already
 * made discoverable, IF a model had been routed to them. Check D below is
 * this test's answer to that: every registered tool name must appear in at
 * least one skill file.
 *
 * ## What this file does NOT catch
 *
 * All four checks below are coarse "does this identifier appear somewhere in
 * this skill file's text" checks, not per-example / per-call-site shape
 * validation. They would NOT have mechanically caught the two divergences
 * that motivated this file in the first place:
 *
 *   - `abap_debug` is a shared tool NAME on both surfaces, but v1's action
 *     set is `{start, step, stack, frame, keepalive, stop, status}` (no
 *     `vars`/`value` — those are separate standalone tools `abap_debug_vars`/
 *     `abap_debug_value` on v1) while v2's is `{start, step, stack, vars,
 *     value, keepalive, stop, status}` (no `frame`). Since "abap_debug"
 *     itself is a valid name on both surfaces, a name-presence check trivially
 *     passes regardless of which actions a skill's examples actually use.
 *   - `abap_write` is likewise a shared name on both surfaces, but v1's wire
 *     schema (`writeInputSchema`, `src/tools/write.ts`) has no `edit`/
 *     `method` keys — v2-only fields that zod silently strips if sent to v1.
 *
 * Both of THOSE defects were found and fixed by direct manual reading of
 * `src/tools/debug-register.ts` / `src/tools/write.ts` against
 * `skills/debugging/SKILL.md` / `skills/editing/SKILL.md`, not by anything
 * mechanical. This file's job is narrower and more durable: it stops a skill
 * from ever citing a tool NAME that plain does not exist on either surface
 * (Check A — typo/hallucination), stops a skill from grounding its guidance
 * entirely in one surface's vocabulary with zero acknowledgment the other
 * surface exists (Checks B/C — the actual class of defect that shipped), and
 * stops a real tool from shipping with literally no route to it from any
 * skill (Check D — the capability-discoverability class). None of that
 * substitutes for the manual "does the WORKED EXAMPLE actually work on this
 * surface" reading that found the two known-fixed defects above — it raises
 * the floor, it does not replace the ceiling.
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
import type { AbapMode } from "../src/mode.js";
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
 * at runtime. See that guard's own doc comment and `test/tools-v2-budget.
 * test.ts`, which established this exact pattern for the same reason (a
 * suite whose handlers are stubs/never called still has to declare intent).
 */
class ForbiddenClient implements HttpClient {
  async request(_o: HttpClientOptions): Promise<HttpClientResponse> {
    throw new Error("NETWORK CALL LEAKED: this suite only ever calls listTools()");
  }
}

/**
 * A maximally-open v1 config — every static capability gate
 * (`resolveStaticCapabilities`, `src/config.ts`) wide open, so `tools/list`
 * for `toolSurface: "v1"` reflects the FULL v1 tool inventory a server could
 * ever expose, not whatever a narrower default would hide. `abapMode` is
 * irrelevant to v1 registration (that axis only affects v2 — see
 * `src/server.ts`'s REGISTRATION comment), so it's omitted here.
 */
function fullyOpenV1Config(): Config {
  return {
    ...ConfigSchema.parse({
      url: "http://sap.invalid:50000",
      user: "TESTUSER",
      password: "secret",
      sid: "TST",
      client: "001",
      toolSurface: "v1",
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

/** A v2 config for one `abapMode` — `abapMode` lives outside `ConfigSchema`, spread on after `.parse()` (same pattern as `test/tools-v2-budget.test.ts`). */
function v2Config(abapMode: AbapMode): Config {
  return {
    ...ConfigSchema.parse({
      url: "http://sap.invalid:50000",
      user: "TESTUSER",
      password: "secret",
      sid: "TST",
      client: "001",
      toolSurface: "v2",
    }),
    abapMode,
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
      out.push(skillFile);
    } catch {
      // No SKILL.md in this directory — not this test's concern.
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
 * server ever registers on either surface. Each entry must be justified —
 * this is not a place to silence a genuine typo.
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

describe("skills <-> tool-surface coherence (capability discoverability + surface parity)", () => {
  it("KNOWN_HYPOTHETICAL_NAMES stays disjoint from every real tool name on either surface", async () => {
    // This is the guard against "finish the job": if abap_fpm_write (or any
    // other name in the exemption set) is ever actually registered, this
    // assertion fails loudly, forcing the exemption to be removed and the
    // skill prose that explains its absence to be revisited — rather than
    // Check A silently starting to treat a real, load-bearing tool name as
    // hypothetical prose forever.
    const v1 = await harness(fullyOpenV1Config());
    const v2read = await harness(v2Config("read"));
    const v2edit = await harness(v2Config("edit"));
    const v2admin = await harness(v2Config("admin"));

    const allReal = new Set([
      ...(await namesOf(v1)),
      ...(await namesOf(v2read)),
      ...(await namesOf(v2edit)),
      ...(await namesOf(v2admin)),
    ]);

    const collisions = [...KNOWN_HYPOTHETICAL_NAMES].filter((n) => allReal.has(n));
    expect(
      collisions,
      `KNOWN_HYPOTHETICAL_NAMES now names a REAL registered tool (${collisions.join(", ")}). ` +
        "That tool must have just been built. Remove it from KNOWN_HYPOTHETICAL_NAMES in " +
        "test/skills-tool-surface.test.ts and update the skill prose that used to explain its " +
        "absence (see skills/fpm/SKILL.md).",
    ).toEqual([]);
  });

  it("Check A — every abap_* name mentioned in a skill is a real tool name on some surface, or is explicitly justified as hypothetical", async () => {
    const v1 = await harness(fullyOpenV1Config());
    const v2read = await harness(v2Config("read"));
    const v2edit = await harness(v2Config("edit"));
    const v2admin = await harness(v2Config("admin"));

    const v1Names = new Set(await namesOf(v1));
    const v2Names = new Set([...(await namesOf(v2read)), ...(await namesOf(v2edit)), ...(await namesOf(v2admin))]);
    const known = new Set([...v1Names, ...v2Names, ...KNOWN_HYPOTHETICAL_NAMES]);

    const offenders: string[] = [];
    for (const file of listSkillFiles()) {
      const text = readFileSync(file, "utf8");
      for (const name of extractToolNames(text)) {
        if (!known.has(name)) offenders.push(`${file}: "${name}"`);
      }
    }

    expect(
      offenders,
      "Skill file(s) reference a tool name that does not exist on EITHER surface and is not in " +
        "KNOWN_HYPOTHETICAL_NAMES — likely a typo or a stale reference to a renamed/removed tool:\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("Check B — a skill that cites a v2-exclusive name also grounds itself in at least one v1 name (v1 is the shipped default)", async () => {
    const v1 = await harness(fullyOpenV1Config());
    const v2read = await harness(v2Config("read"));
    const v2edit = await harness(v2Config("edit"));
    const v2admin = await harness(v2Config("admin"));

    const v1Names = new Set(await namesOf(v1));
    const v2Names = new Set([...(await namesOf(v2read)), ...(await namesOf(v2edit)), ...(await namesOf(v2admin))]);

    const offenders: string[] = [];
    for (const file of listSkillFiles()) {
      const text = readFileSync(file, "utf8");
      const names = [...extractToolNames(text)].filter((n) => !KNOWN_HYPOTHETICAL_NAMES.has(n));
      const v2Exclusive = names.filter((n) => v2Names.has(n) && !v1Names.has(n));
      const hasV1Grounding = names.some((n) => v1Names.has(n));
      if (v2Exclusive.length > 0 && !hasV1Grounding) {
        offenders.push(`${file}: cites v2-only ${JSON.stringify(v2Exclusive)} with zero v1-recognized name anywhere in the file`);
      }
    }

    expect(
      offenders,
      "Skill file(s) are grounded ENTIRELY in v2-exclusive tool names with no acknowledgment that " +
        "v1 (the shipped default, ABAP_TOOL_SURFACE unset) exists at all — a caller on the default " +
        "surface following this skill's guidance verbatim would hit unknown-tool errors throughout:\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("Check C — a skill that cites a v1-exclusive name also grounds itself in at least one v2 name (symmetric with Check B)", async () => {
    const v1 = await harness(fullyOpenV1Config());
    const v2read = await harness(v2Config("read"));
    const v2edit = await harness(v2Config("edit"));
    const v2admin = await harness(v2Config("admin"));

    const v1Names = new Set(await namesOf(v1));
    const v2Names = new Set([...(await namesOf(v2read)), ...(await namesOf(v2edit)), ...(await namesOf(v2admin))]);

    const offenders: string[] = [];
    for (const file of listSkillFiles()) {
      const text = readFileSync(file, "utf8");
      const names = [...extractToolNames(text)].filter((n) => !KNOWN_HYPOTHETICAL_NAMES.has(n));
      const v1Exclusive = names.filter((n) => v1Names.has(n) && !v2Names.has(n));
      const hasV2Grounding = names.some((n) => v2Names.has(n));
      if (v1Exclusive.length > 0 && !hasV2Grounding) {
        offenders.push(`${file}: cites v1-only ${JSON.stringify(v1Exclusive)} with zero v2-recognized name anywhere in the file`);
      }
    }

    expect(
      offenders,
      "Skill file(s) are grounded ENTIRELY in v1-exclusive tool names with no acknowledgment that " +
        "v2 (ABAP_TOOL_SURFACE=v2) exists at all — a caller on v2 following this skill's guidance " +
        "verbatim would hit unknown-tool errors throughout:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("Check D — every real tool name on either surface is mentioned by at least one skill (capability discoverability)", async () => {
    const v1 = await harness(fullyOpenV1Config());
    const v2read = await harness(v2Config("read"));
    const v2edit = await harness(v2Config("edit"));
    const v2admin = await harness(v2Config("admin"));

    const allReal = new Set<string>([
      ...(await namesOf(v1)),
      ...(await namesOf(v2read)),
      ...(await namesOf(v2edit)),
      ...(await namesOf(v2admin)),
    ]);

    const mentioned = new Set<string>();
    for (const file of listSkillFiles()) {
      for (const name of extractToolNames(readFileSync(file, "utf8"))) mentioned.add(name);
    }

    const unmentioned = [...allReal].filter((n) => !mentioned.has(n)).sort();

    expect(
      unmentioned,
      "Tool(s) registered on at least one surface have ZERO mention across every skills/**/SKILL.md " +
        "file — a model would only ever discover them by independently reading tools/list with no " +
        "guidance on when/why to reach for them (this is exactly the abap_fpm_read discoverability " +
        "defect: the tool existed and worked, but nothing routed a caller to it). Add a pointer to " +
        "the most relevant existing skill rather than leaving this list non-empty:\n" +
        unmentioned.join(", "),
    ).toEqual([]);
  });

  it("sanity: the skills directory actually contains files (a guard that silently scans nothing is worse than no guard)", () => {
    const files = listSkillFiles();
    expect(files.length, "found zero skills/**/SKILL.md files — scan path is broken").toBeGreaterThan(0);
  });
});
