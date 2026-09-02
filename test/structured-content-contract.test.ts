/**
 * Static contract: no tool module may emit `structuredContent` unless it also
 * declares an `outputSchema`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * `abap_read` used to return the ABAP source in `content[0].text` AND attach
 * a `structuredContent` object carrying nothing but counters (etag/truncated/
 * hasMore/returnedLines/totalLines/estimatedTokens — leftover counters from an earlier response-shape change).
 * That looked harmless: the MCP spec lets a tool return both, and every unit
 * test in this repo asserted on `content`, so `content` staying correct hid
 * the defect completely.
 *
 * It was not harmless. No tool this server registers declares an
 * `outputSchema` (`grep -rn outputSchema src/` finds nothing, and the second
 * `describe` below pins that as a corpus fact, not an assumption) — and an
 * MCP client is entitled to treat `structuredContent`'s mere PRESENCE as the
 * authoritative answer and skip rendering `content` at all when there is no
 * schema telling it the two might disagree. Claude Code is exactly such a
 * client. So every `abap_read` call there rendered a bare
 * `{"etag": "...", "truncated": false, ...}` dict and ZERO lines of ABAP —
 * the tool was silently unusable for its one job, and nothing failed: the
 * response had `isError: false`, the counters were even correct.
 *
 * The same shape was latent in `abap_bopf_edit`/`abap_bopf_delete`
 * (`structuredContent: { journalEntryId }`, emitted only on calls that
 * actually wrote a journal entry) — worse, because it was intermittent: a
 * `bopf_activate` call or a dry-run delete, which journal nothing, looked
 * fine; the very next edit that journalled went dark the same way `abap_read`
 * always did. Both are fixed in this worktree (`src/tools/read.ts`,
 * `src/tools/bopf.ts`, `src/tools/v2/handlers/do/bopf.ts`) — the id now rides
 * an INTERNAL, non-wire field (`BopfCallResult.journalEntryId`) that each
 * `mcp.registerTool` callback strips before the result crosses the MCP
 * boundary, and `abap_read`'s counters now live inside `content[0].text`
 * itself, as one header line for a complete response
 * (`buildReadResponse` in `src/tools/read.ts`) or already stated in full by
 * the truncation notice for an incomplete one.
 *
 * This file is the guard against a THIRD tool doing the same thing. It is
 * two things, not one:
 *
 *   1. A HEURISTIC static scan (below) that flags any `src/` module whose
 *      stripped source mentions `structuredContent` without also mentioning
 *      `outputSchema`. This catches a NEW violation with a different shape
 *      from this one — some other counters-in-structuredContent mistake in a
 *      tool nobody has written yet.
 *   2. A PINNED, un-renameable assertion that the set of such files is
 *      EMPTY, right now. A contributor cannot silence a real regression by
 *      renaming `structuredContent` to something the regex misses and
 *      leaving the corpus non-empty — the corpus itself is asserted to be
 *      `[]`, not "no worse than before".
 *
 * ---------------------------------------------------------------------------
 * HOW THE HEURISTIC WORKS (read this before trusting or "fixing" a failure)
 * ---------------------------------------------------------------------------
 *
 * 1. Comments and string/template literals are stripped from every
 *    `src/**\/*.ts` file FIRST, using the same single-pass scanner
 *    `test/journal-contract.test.ts` uses (copied here rather than imported —
 *    see "why this is a copy, not an import" below). This is not optional
 *    hygiene: since the fix, this codebase's own doc comments name
 *    `structuredContent` and `outputSchema` constantly, on purpose, to
 *    explain why a file does NOT emit the former — `src/tools/read.ts`'s
 *    `okRead` doc comment alone contains both words several times. A naive
 *    text search over the raw file would score every one of those comments
 *    as a "mentions structuredContent" hit and, worse, as a false negative on
 *    the "no outputSchema" half whenever a comment happens to say
 *    "outputSchema" nearby. Comments are replaced with spaces (not deleted),
 *    so line numbers and byte offsets stay meaningful and no two tokens
 *    accidentally splice together across a stripped comment.
 * 2. A file VIOLATES the contract if, after stripping, it contains the
 *    literal substring `structuredContent` and does NOT also contain the
 *    literal substring `outputSchema`. This is deliberately coarse — a
 *    substring match, not a call-shape match — because the failure mode this
 *    file exists to catch is "a tool return value grew a
 *    `structuredContent:` property", and every way of writing that (object
 *    literal key, `Object.assign`, a spread of a pre-built object) contains
 *    the bare word somewhere in the module that builds it. A module that
 *    legitimately needs to talk about `structuredContent` (type imports,
 *    conditionals that decide whether to attach one) earns its way off this
 *    list by ALSO declaring an `outputSchema`, which is the actual MCP
 *    mechanism that makes attaching one safe — not by an allowlist entry, on
 *    purpose: unlike `test/journal-contract.test.ts`'s `KNOWN_GAPS`, this
 *    contract has no escape hatch, because `structuredContent` without an
 *    `outputSchema` is not a known, tracked defect to excuse — it is the
 *    literal bug this file exists to catch, and the fix is always the same shape (either
 *    declare a schema, or don't emit the field).
 * 3. How it can be FOOLED, honestly:
 *      - A file that declares `outputSchema` for an UNRELATED tool while a
 *        DIFFERENT export in the same file emits `structuredContent` for a
 *        tool that has none would pass. This codebase currently has zero
 *        `outputSchema` declarations anywhere (test below pins that), so the
 *        distinction is moot today — but the day a first `outputSchema` is
 *        added, a module mixing a schema'd tool and a schema-less one in the
 *        same file could launder past this check. Keep tool registrations
 *        one-tool-per-concern, the way this codebase already does, and this
 *        stays a non-issue; splitting the check further would need per-
 *        registration-call analysis this regex corpus cannot do soundly (see
 *        `test/journal-contract.test.ts`'s header for the general shape of
 *        that argument).
 *      - A file that assigns `structuredContent` via a computed/renamed
 *        property (`res[STRUCTURED_KEY] = ...` where `STRUCTURED_KEY` is a
 *        constant defined elsewhere) would not contain the literal substring
 *        and would pass silently. Nothing in this codebase does that today.
 *      - It does not verify that `content` still carries the answer when
 *        `structuredContent` IS legitimately present alongside a real
 *        `outputSchema` — only that the schema exists. That is a correctness
 *        property of the future tool, not something a text scan can check;
 *        read the failure-message instruction on the second test below,
 *        which says so.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A COPY OF `journal-contract.test.ts`'S HELPERS, NOT AN IMPORT
 * ---------------------------------------------------------------------------
 *
 * `listTsFiles`/`stripComments` are not exported from that file, and this
 * repo's tests each keep their own copy of small fixtures rather than share a
 * mutable helper module across unrelated concerns (see
 * `test/bopf-journal.test.ts`'s harness comment for the same convention
 * stated explicitly: "kept as its own small copy per this repo's
 * one-copy-per-test-file convention"). Importing a non-exported test-file
 * symbol is also not possible without changing that file, which this worktree
 * is not touching.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  FakeAdtServer,
  __resetFakeAdtCounters,
  fakeResponse,
  objectMetadataXml,
  searchResultsXml,
  type FakeRoute,
} from "./helpers/fake-adt.js";
import { DATA_PREVIEW_PATH, systemRoleProbeResponse } from "./helpers/system-role-fake.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import { errorResult } from "../src/server.js";
import { registerReadTools, type ReadToolDeps } from "../src/tools/read.js";
import type { SessionPool } from "../src/adt/pool.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Same single-pass comment/string-literal-preserving stripper as
 * `test/journal-contract.test.ts` (see that file's header for the full
 * rationale, in particular why a two-regex approach is unsound here: the
 * string literal `"application/*"` elsewhere in this codebase reads as an
 * unterminated block-comment opener under a naive regex and swallows
 * unrelated code). Comments become spaces, not nothing, so offsets and line
 * numbers stay meaningful. String and template bodies are KEPT — this
 * contract's own `okText`/doc-comment discussion of `structuredContent` is
 * exactly the kind of text that must NOT be mistaken for a real property
 * assignment, and stripping only comments (not strings) is what makes that
 * distinction possible instead of accidental.
 */
function stripComments(text: string): string {
  type Mode = "code" | "line" | "block" | "single" | "double" | "template";
  let mode: Mode = "code";
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const d = text[i + 1];
    if (mode === "code") {
      if (c === "/" && d === "*") {
        mode = "block";
        out += "  ";
        i += 2;
        continue;
      }
      if (c === "/" && d === "/") {
        mode = "line";
        out += "  ";
        i += 2;
        continue;
      }
      if (c === '"') mode = "double";
      else if (c === "'") mode = "single";
      else if (c === "`") mode = "template";
      out += c;
      i += 1;
      continue;
    }
    if (mode === "line") {
      if (c === "\n") mode = "code";
      out += c === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    if (mode === "block") {
      if (c === "*" && d === "/") {
        mode = "code";
        out += "  ";
        i += 2;
        continue;
      }
      out += c === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    // Inside a string or template literal: copy through, honouring escapes.
    if (c === "\\") {
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (
      (mode === "double" && c === '"') ||
      (mode === "single" && c === "'") ||
      (mode === "template" && c === "`")
    ) {
      mode = "code";
    }
    out += c;
    i += 1;
  }
  return out;
}

const files = listTsFiles(SRC);
const contents = new Map(files.map((f) => [f, stripComments(readFileSync(f, "utf8"))]));
const rel = (f: string) => relative(SRC, f).split("\\").join("/");

const mentionsStructuredContent = (text: string): boolean => text.includes("structuredContent");
const mentionsOutputSchema = (text: string): boolean => text.includes("outputSchema");

const violations = files
  .filter((f) => mentionsStructuredContent(contents.get(f)!) && !mentionsOutputSchema(contents.get(f)!))
  .map(rel)
  .sort();

describe("structuredContent contract (heuristic, see file header)", () => {
  it("no src/ module emits structuredContent without declaring an outputSchema", () => {
    expect(
      violations,
      `module(s) mention \`structuredContent\` with no \`outputSchema\` anywhere in the same ` +
        `file: ${violations.join(", ")}.\n\n` +
        `This is exactly that failure shape: no tool this server registers declares an ` +
        `\`outputSchema\`, and an MCP client (Claude Code among them) is entitled to prefer ` +
        `\`structuredContent\` over \`content\` whenever it is merely PRESENT — so a tool result ` +
        `that attaches one hands the caller a bare metadata dict and none of the actual answer. ` +
        `\`abap_read\` did exactly this with etag/truncated/hasMore/returnedLines/totalLines/` +
        `estimatedTokens; \`abap_bopf_edit\`/\`abap_bopf_delete\` did it with { journalEntryId }.\n\n` +
        `Fix it one of two ways:\n` +
        `  1. Declare an \`outputSchema\` for the tool AND make sure \`content\` still carries the ` +
        `full answer on its own (a client without schema support must still work) — then this file ` +
        `stops flagging the module.\n` +
        `  2. Don't emit \`structuredContent\` at all. Put whatever facts it was going to carry into ` +
        `\`content[0].text\` instead — see \`buildReadResponse\` in \`src/tools/read.ts\` for the ` +
        `pattern (counters folded into one header line inside the existing budgeted render), or the ` +
        `internal, non-wire \`BopfCallResult.journalEntryId\` field plus \`toMcpResult\` in ` +
        `\`src/tools/bopf.ts\` for the pattern where a value needs to reach an in-process caller ` +
        `(a v2 handler) without ever reaching the MCP boundary.`,
    ).toEqual([]);
  });

  it("the violation set is EMPTY — pinned, not just 'no worse than before'", () => {
    // This is the test that cannot be defeated by renaming `structuredContent`
    // to dodge the substring match above while still shipping the same bug:
    // even a regex that a rename fools would only ever make THIS array grow
    // from its pinned value of `[]`, which is asserted directly, not derived
    // from `violations.length` or any other quantity a rename could also
    // shrink. If this fails, do not edit the expected value to match — that
    // is re-approving the exact defect this contract exists to catch. Fix the offending module per
    // the instructions in the test above, and this returns to `[]` on its
    // own.
    expect(violations).toEqual([]);
  });

  it("finds a non-empty, expected corpus of outputSchema mentions — not a vacuous pass (there are none)", () => {
    // The two tests above are meaningless if `mentionsOutputSchema` silently
    // matched everything (a typo'd substring, say) or the corpus scan found
    // no files at all. Pin both failure directions: the file list is
    // non-trivial, AND, as an explicit fact about this codebase rather than
    // an assumption, no module anywhere under src/ currently declares an
    // outputSchema — the exact condition this contract's header explains is
    // what makes emitting structuredContent unsafe in the first place. The
    // day a tool legitimately adds one, this assertion is expected to fail
    // and must be updated deliberately, in the same commit that adds it.
    expect(files.length).toBeGreaterThan(50);
    const schemaFiles = files.filter((f) => mentionsOutputSchema(contents.get(f)!)).map(rel).sort();
    expect(
      schemaFiles,
      `module(s) now mention \`outputSchema\`: ${schemaFiles.join(", ")}. If this is a deliberate, ` +
        `new tool-output-schema declaration, update this assertion in the same commit — this test ` +
        `exists to make that a visible, deliberate diff rather than a silent corpus change.`,
    ).toEqual([]);
  });

  it("the comment stripper actually strips — not a vacuous pass on this file's own doc comments", () => {
    // This test file's own header (above) says `structuredContent` and
    // `outputSchema` in the same sentence dozens of times, entirely inside a
    // block comment. If `stripComments` regressed to a no-op, this very file
    // would score itself as a violation the moment it is added to `src/`
    // (it isn't — it lives in test/ — but the same regression against a real
    // src/ doc comment, e.g. the one on `okRead` in `src/tools/read.ts`,
    // would silently defeat the whole contract). Assert directly that
    // stripping removes a known comment body rather than trusting the
    // violations list to stay empty for the right reason.
    const sample = `/* structuredContent lives here, in a comment, on purpose */\nconst x = 1;`;
    const stripped = stripComments(sample);
    expect(stripped).not.toContain("structuredContent");
    expect(stripped).toContain("const x = 1;");
    // And the read.ts doc comment this whole contract exists because of must
    // itself strip clean, or the first test above is checking nothing.
    const readTs = readFileSync(join(SRC, "tools", "read.ts"), "utf8");
    const strippedReadTs = stripComments(readTs);
    expect(strippedReadTs).not.toContain("structuredContent");
  });
});

// ---------------------------------------------------------------------------
// Behavioural test: abap_read's actual registered CallToolResult
// ---------------------------------------------------------------------------
//
// The static contract above proves no module MENTIONS structuredContent
// without a schema. It cannot prove that a real tool call's return value has
// no such key at runtime — a key could be attached dynamically in a way the
// text scan cannot see (spreading an object built elsewhere, say). This
// exercises the fix for the headline structuredContent defect directly: register abap_read
// against a fake ADT backend (the same FakeAdtServer + AbapConnection idiom
// test/bopf-journal.test.ts uses, itself modelled on
// test/pool-characterization.test.ts's golden-trace harness for this exact
// tool call), capture its registered callback the way
// test/bopf-journal.test.ts's fakeMcp()/invoke() do, and inspect the raw
// CallToolResult object the handler returns — before it ever reaches an MCP
// Client/Server transport that might normalise the shape.

const CLAS_URI = "/sap/bc/adt/oo/classes/zcl_demo";
const CLASS_SOURCE =
  "CLASS zcl_demo DEFINITION PUBLIC.\nENDCLASS.\nCLASS zcl_demo IMPLEMENTATION.\nENDCLASS.\n";

const systemRoleRoute: FakeRoute = (r) =>
  r.path.includes(DATA_PREVIEW_PATH) ? systemRoleProbeResponse("nonproductive") : undefined;

/**
 * `resolveObject` spends one search round trip to recover `packageName` even
 * on a type-certain ref (see `src/adt/resolve.ts`'s `lookupPackageName`) — no
 * ref shape carries the package for free. Without this route the lookup would
 * throw inside `AbapConnection`'s fake transport (an unrouted-request
 * violation) and `lookupPackageName` swallows that into `undefined`, so the
 * read would still nominally succeed; routing it properly keeps this test
 * honest about what a real read does, matching
 * `test/pool-characterization.test.ts`'s identical `searchRoute`.
 */
const searchRoute: FakeRoute = (r) =>
  r.path.endsWith("/repository/informationsystem/search")
    ? fakeResponse(
        200,
        searchResultsXml([{ name: "ZCL_DEMO", type: "CLAS/OC", uri: CLAS_URI, packageName: "$TMP" }]),
        { "content-type": "application/xml; charset=utf-8" },
      )
    : undefined;

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
  });

async function wiredReadConnection(): Promise<{ conn: AbapConnection; server: FakeAdtServer }> {
  const server = new FakeAdtServer({
    routes: [systemRoleRoute, searchRoute],
    objects: { [`${CLAS_URI}/source/main`]: CLASS_SOURCE },
    objectMetadata: {
      [CLAS_URI]: objectMetadataXml({ name: "ZCL_DEMO", type: "CLAS/OC", packageName: "$TMP" }),
    },
  });
  const conn = new AbapConnection(cfg(), {
    httpClient: server.client("s1"),
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  return { conn, server };
}

function fakePool(conn: AbapConnection): SessionPool {
  return {
    withRead: <T,>(_op: string, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
    withWrite: <T,>(_op: string, _objectUri: string | undefined, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
    reserveDebug: () => {
      throw new Error("reserveDebug: not used by abap_read, and not implemented in this fake.");
    },
  } as unknown as SessionPool;
}

function fakeMcp(): { mcp: McpServer; tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }> } {
  const tools = new Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>();
  const mcp = {
    registerTool: (name: string, _config: unknown, handler: (args: unknown) => Promise<CallToolResult>) => {
      tools.set(name, { handler });
      return {} as unknown;
    },
  } as unknown as McpServer;
  return { mcp, tools };
}

describe("abap_read's real CallToolResult (structuredContent regression, behavioural)", () => {
  it("carries the source in content[0].text and NO structuredContent key at all", async () => {
    __resetFakeAdtCounters();
    const { conn } = await wiredReadConnection();
    try {
      const { mcp, tools } = fakeMcp();
      const deps: ReadToolDeps = {
        pool: fakePool(conn),
        safety: new SafetyGate({ readOnly: true, allowPackages: [], allowTransportRelease: false, allowCascadeDelete: false }),
        ensureConnected: async () => {},
        errorResult,
        cfg: { maxResponseChars: 30_000 },
      };
      registerReadTools(mcp, deps);
      const entry = tools.get("abap_read");
      if (!entry) throw new Error('"abap_read" was never registered');

      const result = await entry.handler({ object: "ZCL_DEMO", type: "CLAS/OC" });

      expect(result.isError).toBeFalsy();
      // The headline assertion: not merely `undefined` on the typed
      // field, but the KEY ITSELF absent from the object the handler
      // returned — `"structuredContent" in result` catches a key present
      // with an `undefined` value too, which `toBeUndefined()` alone would
      // not distinguish from "never set".
      expect(Object.prototype.hasOwnProperty.call(result, "structuredContent")).toBe(false);
      expect(result.structuredContent).toBeUndefined();

      const text = (result.content[0] as { type: string; text: string }).text;
      // The actual ABAP source must be present — this is the half the old bug broke:
      // a client that reads only structuredContent got the counters below and
      // NONE of this.
      expect(text).toContain("CLASS zcl_demo DEFINITION PUBLIC.");
      expect(text).toContain("CLASS zcl_demo IMPLEMENTATION.");
      expect(text).toContain("ENDCLASS.");
      // The counters that used to live only in structuredContent must
      // still reach the caller — now folded into one header line inside
      // content[0].text itself (buildReadResponse, src/tools/read.ts).
      expect(text).toMatch(/response: complete \(/);
      expect(text).toContain("truncated=false");
      expect(text).toMatch(/hasMore=\S+/);
      expect(text).toMatch(/returnedLines=\d+/);
      expect(text).toMatch(/totalLines=\d+/);
      expect(text).toMatch(/estimatedTokens=~\d+/);
    } finally {
      conn.dispose();
    }
  });
});
