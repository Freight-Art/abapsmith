/**
 * `abap_search` — four modes over one input schema.
 *  - `objects` (default): name-pattern search over the repository.
 *  - `where_used`: static usage references for one object.
 *  - `call_graph`: multi-level callers/callees tree rooted at one object.
 *  - `source`: line-wise source-text scan over a package/name scope, run
 *    through the fluid `scan` tool (`ZCL_ZMCP_FLUID_SCAN`,
 *    `src/adt/fluid/builtin/scan.ts`) — there is no ADT endpoint for this, so
 *    it deploys and calls a small generated ABAP class the same way
 *    `abap_fpm_read` does (see `src/tools/fpm.ts`).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AbapConnection } from "../adt/connection.js";
import { AbapError } from "../adt/errors.js";
import { resolveObject } from "../adt/resolve.js";
import { fetchUsageReferences, HIGH_FAN_IN_REFERENCES, SLOW_FETCH_MS } from "../adt/element-info.js";
import { buildCallGraph } from "../adt/call-graph.js";
import { repairSearchDescriptions } from "../adt/search-descriptions.js";
import { buildResponse, textTable, type BuiltResponse } from "../compact.js";
import { specForKeyword, specForType, specFromUri, TYPES } from "../adt/types.js";
import { truncateForDisplay } from "../truncate.js";
import type { SessionPool } from "../adt/pool.js";
import type { Config } from "../config.js";
import type { SafetyGate } from "../safety.js";
import { FLUID_PACKAGE } from "../adt/fluid/package.js";
import { fluidDisabledReason } from "../adt/fluid/enabled.js";
import { dispatchDisabledError } from "../adt/fluid/dispatch.js";
import { SCAN_TOOL_ID, SCAN_ACTION, SCAN_ENTRY_CLASS } from "../adt/fluid/builtin/scan.js";
import {
  runSourceScan,
  scanDispatchArgs,
  SOURCE_SCAN_TYPES,
  SOURCE_SCAN_OBJECT_CEILING,
  type SourceScanHit,
  type SourceScanQuery,
  type SourceScanResult,
} from "../adt/source-scan.js";

const DESCRIPTION_COL_WIDE = 70;
const DESCRIPTION_COL_NARROW = 60;

/**
 * The container a row's ADT URI names — the function group for FUGR/FF and
 * FUGR/I rows. The search result carries it nowhere else: `packageName` is the
 * module's package (S_BUPA_GENERAL for BUP_ROLES_GET_ALL), not its group
 * (BUDA), so without this a FUGR/FF hit named no way to address the object.
 */
function groupFromUri(uri: string | undefined): string {
  if (!uri) return "";
  try {
    return specFromUri(uri)?.parent ?? "";
  } catch {
    // specFromUri throws on an unreadable class-include URI. A rendering
    // column must not turn that into a failed search.
    return "";
  }
}

/** Every bare kind and full type code the registry knows: "CLAS" and "CLAS/OC". */
const KNOWN_TYPES: string[] = [...new Set(TYPES.flatMap((t) => [t.kind, t.type]))].sort();

/** The group half of every known type code: "CLAS/OC" -> "CLAS". */
export const KNOWN_TYPE_GROUPS = new Set(TYPES.map((t) => t.type.split("/")[0]!));

// The request now always goes out untyped, so nothing server-side rejects a
// type that does not exist; without this it would render as an ordinary empty
// result. A sub-type the registry has never heard of is still real as long as
// its group is known — quickSearch returns ENHS/XB rows nobody listed here.
function assertKnownType(type: string): void {
  const value = type.trim();
  if (!value) return;
  if (specForType(value) ?? specForKeyword(value)) return;
  if (value.includes("/") && KNOWN_TYPE_GROUPS.has(value.split("/")[0]!.toUpperCase())) return;
  throw new AbapError(
    "BAD_INPUT",
    `type "${type}" is not a recognised object type for abap_search. ` +
      `Allowed: ${KNOWN_TYPES.map((t) => `"${t}"`).join(", ")}.`,
    { type, allowed: KNOWN_TYPES },
    'A "<GROUP>/<SUBTYPE>" code whose group is one of those values is accepted too ' +
      '(e.g. "ENHS/XB"), as is a plain object-type word such as "class". ' +
      "Omit `type` to search every type.",
  );
}

export const searchInputSchema = {
  query: z
    .string()
    .describe(
      "Name pattern (mode=objects), target object (mode=where_used/call_graph), or literal/regex text (mode=source).",
    ),
  mode: z
    .enum(["objects", "where_used", "source", "call_graph"])
    .optional()
    .describe(
      'Default "objects". "source" scans raw source text (literal/regex, any line) and needs the fluid API; prefer "where_used" when you want real static references to one object, since a text scan also matches strings, comments and dead code. "call_graph" walks multiple levels of callers or callees instead of just one.',
    ),
  type: z
    .string()
    .optional()
    .describe(
      `ADT type filter (mode=objects/where_used/call_graph only). One of: ${[...KNOWN_TYPE_GROUPS].sort().join(" ")}; ` +
        `or a full code, e.g. "CLAS/OC".`,
    ),
  max: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe(
      "Default 50 rows (mode=objects/where_used), 100 hits (mode=source), or 50 children per node " +
        "(mode=call_graph); narrowing `query` (not lowering `max`) is what makes a broad call cheaper.",
    ),
  direction: z
    .enum(["callers", "callees"])
    .optional()
    .describe('mode=call_graph: "callers" (who calls this, default) or "callees" (what this calls).'),
  depth: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("mode=call_graph: levels to expand. Default 2, max 4."),
  packages: z
    .array(z.string())
    .max(20)
    .optional()
    .describe("mode=source: package scope (TADIR-DEVCLASS). Required unless `objects` is given."),
  include_subpackages: z
    .boolean()
    .optional()
    .describe("mode=source: also scan every package transitively under `packages` (TDEVC-PARENTCL)."),
  objects: z
    .string()
    .optional()
    .describe('mode=source: object-name pattern (wildcards `*`), e.g. "ZCL_MY_*". Alternative/addition to `packages`.'),
  types: z
    .array(z.string())
    .max(10)
    .optional()
    .describe(`mode=source: object types to scan. One of: ${SOURCE_SCAN_TYPES.join(" ")}. Default: all five.`),
  regex: z.boolean().optional().describe("mode=source: treat `query` as a PCRE pattern instead of literal text."),
  case_sensitive: z.boolean().optional().describe("mode=source: default false."),
  include_comments: z
    .boolean()
    .optional()
    .describe("mode=source: also match inside comments (heuristic, line-local). Default false."),
};

export const SearchInput = z.object(searchInputSchema);
export type SearchInput = z.infer<typeof SearchInput>;

/** Zod's `depth` schema has no `.max()` (G-08: a caller asking for more must be REFUSED, not silently clamped down to this). */
const MAX_CALL_GRAPH_DEPTH = 4;

export async function abapSearch(
  conn: AbapConnection,
  input: SearchInput,
  maxChars: number,
): Promise<BuiltResponse> {
  const max = input.max ?? 50;
  if (input.type) assertKnownType(input.type);
  const mode = input.mode ?? "objects";
  if (mode === "where_used") {
    return whereUsed(conn, input.query, input.type, max, maxChars);
  }
  if (mode === "call_graph") {
    const depth = input.depth ?? 2;
    if (depth > MAX_CALL_GRAPH_DEPTH) {
      throw new AbapError(
        "BAD_INPUT",
        `depth=${depth} exceeds the maximum of ${MAX_CALL_GRAPH_DEPTH} for mode="call_graph".`,
        { depth, max: MAX_CALL_GRAPH_DEPTH },
        `Pass depth<=${MAX_CALL_GRAPH_DEPTH}. This is refused, not silently capped, because a call ` +
          "graph's cost grows with fan-in at every level — a caller expecting depth=6 and silently " +
          "getting depth=4 would draw wrong conclusions from an incomplete tree without knowing it.",
      );
    }
    return buildCallGraph(conn, input.query, input.type, input.direction ?? "callers", depth, max, maxChars);
  }
  return searchObjects(conn, input.query, input.type, max, maxChars);
}

// quickSearch's objectType is not trusted server-side (captures
// 818/819): the sub-type half is ignored and typed rows drop description/
// packageName. So every request goes out untyped and is filtered here instead.
const TYPED_FETCH_MULTIPLIER = 10;
const TYPED_FETCH_CAP = 1000;

async function searchObjects(
  conn: AbapConnection,
  query: string,
  type: string | undefined,
  max: number,
  maxChars: number,
): Promise<BuiltResponse> {
  const spec = type ? (specForType(type) ?? specForKeyword(type)) : undefined;
  const wanted = type ? (spec?.type ?? type.toUpperCase().trim()) : undefined;
  // Widened so a typed search still gets useful coverage now that the server
  // no longer narrows the fetch — captures 827/828 confirm a window this
  // size is honoured (1000 and 5000 rows). `max` itself still only bounds
  // what is DISPLAYED (see the cap below), never what is fetched.
  const fetchMax = type ? Math.min(TYPED_FETCH_CAP, max * TYPED_FETCH_MULTIPLIER) : max;
  const rawResults = await conn.adt.searchObject(query, undefined, fetchMax);

  // Repaired BEFORE the type filter: the permutation is defined over the
  // whole type group as the server returned it, so filtering to one
  // sub-type first would see only half the group and repair nothing.
  const { refs: results, repairedGroups, suspectGroups } = repairSearchDescriptions(rawResults);

  const filtered = wanted
    ? results.filter((r) => {
        const rowType = (r["adtcore:type"] ?? "").toUpperCase();
        return wanted.includes("/") ? rowType === wanted : rowType.split("/")[0] === wanted;
      })
    : results;
  const droppedByFilter = results.length - filtered.length;
  const windowFull = results.length >= fetchMax;

  // `filtered` can outgrow `max` now that the fetch window is wider than the
  // display cap — cap the display separately from the fetch, and disclose
  // the exact residual (unlike windowFull below, this count IS known).
  const capped = filtered.slice(0, max);
  const droppedByCap = filtered.length - capped.length;
  const capLine =
    droppedByCap > 0
      ? `--- TRUNCATED --- ${droppedByCap} of ${filtered.length} matching row(s) not shown ` +
        `(display cap max=${max}). Raise \`max\` (<=200) to see them.`
      : undefined;

  const notes: string[] = [];
  if (repairedGroups.length > 0) {
    notes.push(
      `DESCRIPTIONS RE-PAIRED: the server sent type group(s) ${repairedGroups.join(", ")} carrying ` +
        `other rows' descriptions — a server-side defect — and this tool re-paired ` +
        `them. The response carries no key tying a description to its row, so the fix is ` +
        `reconstructed from ordering and confirmed against per-object reads, not proven by the ` +
        `payload; confirm with abap_read if a description is load-bearing.`,
    );
  }
  if (suspectGroups.length > 0) {
    notes.push(
      `DESCRIPTIONS MAY BE MIS-PAIRED: type group(s) ${suspectGroups.join(", ")} span several ` +
        `sub-types and show the same shape as the server-side description-pairing defect, which is only ` +
        `wire-confirmed for TABL and PROG. At least one such group (FUGR) was tested and arrives ` +
        `correct, so unverified groups are left exactly as the server sent them rather than ` +
        `repaired. Their descriptions may belong to another row in the same group — confirm with abap_read.`,
    );
  }
  if (droppedByFilter > 0) {
    notes.push(
      `UNDER-REPORTED: the fetch window was deliberately widened to ${fetchMax} row(s) of mixed type ` +
        `for "${query}" — your max=${max} bounds only what is shown, not what is fetched, because the ` +
        `server's own type filter is not trusted and type is filtered here instead. ` +
        `The server returned ${results.length} hit(s) of mixed type; ` +
        `${droppedByFilter} were dropped here because their type is not ${wanted}. ` +
        `${filtered.length} row(s) matched. ` +
        (windowFull
          ? `More ${wanted} objects may exist beyond this window — raise max (<=200) or narrow the query pattern.`
          : `The window was not full, so this is every hit the server has for "${query}" — no other ${wanted} object matches this pattern.`),
    );
  }
  if (droppedByCap > 0) {
    notes.push(
      `DISPLAY CAP: ${filtered.length} ${wanted} row(s) matched within this fetch window; only the ` +
        `first max=${max} are shown. ${droppedByCap} matching row(s) are NOT listed — raise max ` +
        `(<=200) to see them.`,
    );
  }
  if (windowFull) {
    notes.push(
      `The server returned its full page of ${results.length} hit(s) at max=${fetchMax}; ` +
        `there are probably more matches it did not send.`,
    );
  }

  const windowLine = windowFull
    ? `--- TRUNCATED --- the fetch window (max=${fetchMax}) was full for "${query}"; the list above ` +
      `may be incomplete beyond this window, and there is no count of what was left unsent. Raise ` +
      `\`max\` (<=200) or narrow the query pattern to see more.`
    : undefined;

  const rows = capped.map((r) => ({
    type: r["adtcore:type"] ?? "",
    name: r["adtcore:name"] ?? "",
    group: groupFromUri(r["adtcore:uri"]),
    package: r["adtcore:packageName"] ?? "",
    description: truncateForDisplay(r["adtcore:description"] ?? "", DESCRIPTION_COL_WIDE),
  }));

  // The `group` column only appears when at least one displayed row has one,
  // so an ordinary (non-parented) search renders exactly as it did before.
  const hasGroup = rows.some((r) => r.group !== "");
  const columns = hasGroup
    ? ["type", "name", "group", "package", "description"]
    : ["type", "name", "package", "description"];

  const body = rows.length
    ? [textTable(rows, columns), capLine, windowLine]
        .filter((line): line is string => line !== undefined)
        .join("\n")
    : droppedByFilter > 0
      ? windowFull
        ? `(no ${wanted} matches among the ${results.length} hit(s) the server returned` +
          ` at max=${fetchMax} — see the note above; this is NOT proof that none exist)`
        : `(no ${wanted} matches among the ${results.length} hit(s) the server returned for "${query}"` +
          ` — the fetch window (max=${fetchMax}) was not full, so that is every object of any type` +
          ` matching this pattern)`
      : "(no matches)";

  return buildResponse({
    header: {
      system: conn.cfg.sid,
      mode: "objects",
      query,
      type: wanted,
      matches: rows.length,
      matchedTotal: droppedByCap > 0 ? filtered.length : undefined,
      serverHits: results.length,
      droppedByTypeFilter: droppedByFilter || undefined,
      droppedByDisplayCap: droppedByCap || undefined,
      fetchMax: type ? fetchMax : undefined,
      descriptionsRepaired: repairedGroups.length ? repairedGroups.join(", ") : undefined,
      descriptionsSuspect: suspectGroups.length ? suspectGroups.join(", ") : undefined,
    },
    body,
    bodyLabel: "RESULTS",
    notes,
    // abap_search has no offset/paging parameter — `max` is the only lever, so
    // the hint must not promise one.
    hints: [
      "Narrow the pattern or set `type` to reduce the result set, or raise `max` (<=200).",
      ...(hasGroup
        ? [
            "`group` is the function group a FUGR row lives in — `package` is the module's own package, not its group.",
          ]
        : []),
    ],
    maxChars,
  });
}

async function whereUsed(
  conn: AbapConnection,
  target: string,
  type: string | undefined,
  max: number,
  maxChars: number,
): Promise<BuiltResponse> {
  const obj = await resolveObject(conn, target, type ? { type } : {});
  // Deliberately UNBOUNDED: ADT's usageReferences endpoint ignores every known
  // limit parameter (wire-verified against A4H, 2026-08-09 — see
  // the git history) and always returns the complete
  // result set, sometimes several MB / 10-20s. The cap below is client-side,
  // applied AFTER the full fetch, and its residual cost is disclosed to the
  // caller rather than left silent.
  //
  // Goes through `fetchUsageReferences` (element-info.ts), not
  // `conn.adt.usageReferences()`: that vendor function's answer-reading path
  // hardcodes the capitalised `usageReferences:` namespace prefix while A4H's
  // wire bytes use the lowercase `usagereferences:` prefix throughout, so it
  // always returns an empty array — live-confirmed 2026-09-15,
  // `abap_search {"query":"ZCL_I105_LEAF","mode":"where_used","type":"CLAS"}`
  // answered `referencesTotal: 0` despite fixture 973's own wire bytes
  // (same request) carrying `numberOfResults="2"` with two caller rows. See
  // `fetchUsageReferences`'s doc comment.
  const { refs, fetchMs } = await fetchUsageReferences(conn, obj.uri, undefined, obj.name);

  // `isResult: false` rows are grouping nodes (packages, containers).
  const named = refs.filter((r) => r["adtcore:name"]);
  const totalReferences = named.length;
  const expensive = totalReferences >= HIGH_FAN_IN_REFERENCES || fetchMs >= SLOW_FETCH_MS;
  const kept = named.slice(0, max);
  const omitted = totalReferences - kept.length;
  // Disclosed in the body (not just notes) so it survives char-budget cuts.
  const capLine =
    omitted > 0
      ? `--- TRUNCATED --- ${omitted} of ${totalReferences} reference(s) not shown` +
        ` (display cap max=${max}). Re-run with max=${Math.min(200, totalReferences)}.`
      : undefined;
  const capped = omitted > 0;
  // `refs` rows are `Record<string, unknown>` (element-info.ts's parser makes no promise about
  // value types beyond "whatever fast-xml-parser produced"), so every field is read through this
  // guard rather than trusted with `?? ""` — same style as `callerChildren` in call-graph.ts.
  const strField = (v: unknown): string => (typeof v === "string" ? v : "");
  const rows = kept.map((r) => {
    const packageRefValue = r["packageRef"];
    const packageRef =
      packageRefValue !== null && typeof packageRefValue === "object"
        ? (packageRefValue as Record<string, unknown>)
        : undefined;
    return {
      type: strField(r["adtcore:type"]),
      name: strField(r["adtcore:name"]),
      package: packageRef ? strField(packageRef["adtcore:name"]) : "",
      description: truncateForDisplay(strField(r["adtcore:description"]), DESCRIPTION_COL_NARROW),
    };
  });

  return buildResponse({
    header: {
      system: conn.cfg.sid,
      mode: "where_used",
      object: `${obj.type} ${obj.name}`,
      uri: obj.uri,
      // Both numbers, always: "references: 50" alone reads as the true total.
      referencesShown: rows.length,
      referencesTotal: totalReferences,
      // Wall-clock, varies run to run — surfaced only where it is load-bearing.
      fetchMs: expensive ? fetchMs : undefined,
    },
    body: rows.length
      ? textTable(rows, ["type", "name", "package", "description"]) + (capLine ? `\n${capLine}` : "")
      : "(no references found)",
    bodyLabel: "USED BY",
    notes: [
      ...(expensive
        ? [
            `FETCH COST: this call took ${(fetchMs / 1000).toFixed(1)}s and returned ` +
              `${totalReferences} reference(s). ADT's usageReferences endpoint has no ` +
              `server-side limit, so the entire set is enumerated and transferred before ` +
              `max is applied. The cost is set by the target's fan-in, not by max — ` +
              `lowering max would not have made this call cheaper. If cost matters, ask ` +
              `about a narrower or less widely-referenced object instead.`,
          ]
        : []),
      // The cap used to be applied silently.
      ...(capped
        ? [
            `CAPPED: ADT returned ${totalReferences} reference(s); only the first ${max} are ` +
              `shown (max=${max}). ${totalReferences - max} reference(s) are NOT listed — ` +
              `this is a display cap, not the end of the list. Raise max (<=200) to see more.`,
            `This cap is applied AFTER the full fetch: ADT's usageReferences endpoint has no ` +
              `server-side limit (wire-verified — see source comment), so all ${totalReferences} ` +
              `reference(s) were already retrieved and held in memory before max=${max} was ` +
              `applied. On a widely-referenced object this call can take several seconds and ` +
              `several megabytes regardless of max; raising or lowering max changes what you ` +
              `see, not the cost of asking.`,
          ]
        : []),
      "Where-used is static. Dynamic calls (CALL FUNCTION lv_name, PERFORM (lv_form), " +
        "SUBMIT (lv_prog)) do not appear here — these are static-analysis " +
        "blind spots.",
    ],
    // No offset/paging parameter on abap_search: `max` is the only lever.
    hints: ["Raise `max` (<=200) for more rows."],
    maxChars,
  });
}

// ---------------------------------------------------------------------------
// mode: "source" — line-wise source-text scan (fluid `scan` tool)
// ---------------------------------------------------------------------------

/** Default hit cap for mode=source, mirroring `max`'s default-50 role for the other two modes. */
const DEFAULT_SOURCE_MAX_HITS = 100;

/** Fields that only mean something for mode="source"; misuse under the other two modes is refused, not ignored. */
const SOURCE_ONLY_FIELDS = [
  "packages",
  "include_subpackages",
  "objects",
  "types",
  "regex",
  "case_sensitive",
  "include_comments",
] as const;

/**
 * Guards the OTHER direction from `buildSourceScanQuery`'s own `type`-forbidden
 * check: mode=objects/where_used/call_graph silently ignoring a source-only
 * field would look to a caller like the field was honoured. Kept separate
 * from `abapSearch()` (which stays byte-identical) — this runs in the
 * handler, around the call, not inside it.
 */
function assertNoSourceOnlyFields(input: SearchInput, mode: "objects" | "where_used" | "call_graph"): void {
  const passed = SOURCE_ONLY_FIELDS.filter((f) => {
    const v = (input as Record<string, unknown>)[f];
    return v !== undefined && !(Array.isArray(v) && v.length === 0);
  });
  if (passed.length > 0) {
    throw new AbapError(
      "BAD_INPUT",
      `mode="${mode}" does not use ${passed.map((f) => `\`${f}\``).join(", ")} — ` +
        `those parameters only apply to mode="source".`,
      { mode, fields: passed },
      'Omit them, or set mode="source" to run a source-text scan.',
    );
  }
}

/** Fields that only mean something for mode="call_graph"; misuse under any other mode is refused, not ignored — mirrors `assertNoSourceOnlyFields` above (and its own doc comment) for the opposite direction. */
const CALL_GRAPH_ONLY_FIELDS = ["direction", "depth"] as const;

function assertNoCallGraphOnlyFields(input: SearchInput, mode: "objects" | "where_used" | "source" | "call_graph"): void {
  if (mode === "call_graph") return;
  const passed = CALL_GRAPH_ONLY_FIELDS.filter((f) => (input as Record<string, unknown>)[f] !== undefined);
  if (passed.length === 0) return;
  const verb = passed.length > 1 ? "are" : "is";
  const pronoun = passed.length > 1 ? "them" : "it";
  throw new AbapError(
    "BAD_INPUT",
    `${passed.map((f) => `\`${f}\``).join(" and ")} ${verb} only meaningful with mode="call_graph"; ` +
      `mode="${mode}" would have discarded ${pronoun}.`,
    { mode, fields: passed },
    'Omit them, or set mode="call_graph".',
  );
}

/** A crude but adequate check for an ABAP object-name/package wildcard pattern: `esc_like()` (scan.ts) only ever sees these characters. */
const PATTERN_CHARS = /^[A-Za-z0-9_$*/]+$/;

function assertValidPattern(value: string, field: string): void {
  if (!PATTERN_CHARS.test(value)) {
    throw new AbapError(
      "BAD_INPUT",
      `\`${field}\` "${value}" is not a valid pattern — only letters, digits, "_", "$", "/" and ` +
        `the "*" wildcard are meaningful here.`,
      { field, value },
    );
  }
}

/**
 * Builds a `SourceScanQuery` from `mode="source"` input. Pure and
 * network-free — every rejection here is a client-side mistake the fluid
 * side would otherwise have to reject after a round trip (or, worse, after
 * deploying `ZCL_ZMCP_FLUID_SCAN`).
 */
export function buildSourceScanQuery(input: SearchInput): SourceScanQuery {
  if (input.type !== undefined) {
    throw new AbapError(
      "BAD_INPUT",
      'mode="source" does not use `type` — pass `types` instead (any of PROG, CLAS, INTF, FUGR, DDLS).',
      { type: input.type },
    );
  }

  const query = input.query.trim();
  if (!query) {
    throw new AbapError("BAD_INPUT", 'mode="source" requires a non-empty `query`.', {});
  }
  if (query.length > 255) {
    throw new AbapError("BAD_INPUT", `\`query\` is ${query.length} characters; mode="source" allows at most 255.`, {
      length: query.length,
    });
  }

  const packages = (input.packages ?? []).map((p) => p.trim()).filter((p) => p !== "");
  packages.forEach((p) => assertValidPattern(p, "packages"));

  const objectsRaw = input.objects?.trim();
  const objects = objectsRaw === "" ? undefined : objectsRaw;
  if (objects !== undefined) assertValidPattern(objects, "objects");

  // No boundary at all: packages empty and objects absent/blank/"*" (a bare
  // "*" is every object of every type in every package — not a scope).
  if (packages.length === 0 && (objects === undefined || objects === "*")) {
    throw new AbapError(
      "BAD_INPUT",
      'mode="source" needs a scope: pass `packages` (one or more), `objects` (a name pattern ' +
        'narrower than "*"), or both.',
      {},
      'Try packages: ["Z_MY_PACKAGE"], or objects: "ZCL_MY_*".',
    );
  }

  const typesRaw = input.types ?? [];
  const types = [...new Set(typesRaw.map((t) => t.trim().toUpperCase()).filter((t) => t !== ""))];
  for (const t of types) {
    if (!(SOURCE_SCAN_TYPES as readonly string[]).includes(t)) {
      throw new AbapError("BAD_INPUT", `\`types\` entry "${t}" is not one of: ${SOURCE_SCAN_TYPES.join(", ")}.`, {
        type: t,
        allowed: SOURCE_SCAN_TYPES,
      });
    }
  }

  return {
    query,
    regex: input.regex ?? false,
    caseSensitive: input.case_sensitive ?? false,
    includeComments: input.include_comments ?? false,
    packages,
    includeSubpackages: input.include_subpackages ?? false,
    objects,
    types,
    maxHits: input.max ?? DEFAULT_SOURCE_MAX_HITS,
    maxObjects: SOURCE_SCAN_OBJECT_CEILING,
  };
}

/** `include`'s ADT include name → the CC* suffix SE24/SE80 shows it as (`src/adt/undo.ts:486`). */
const CLAS_INCLUDE_SUFFIX: ReadonlyArray<
  readonly [string, "definitions" | "implementations" | "macros" | "testclasses"]
> = [
  ["CCDEF", "definitions"],
  ["CCIMP", "implementations"],
  ["CCMAC", "macros"],
  ["CCAU", "testclasses"],
];

const READ_WINDOW_MARGIN = 10;
const READ_WINDOW_LIMIT = 40;

/**
 * A concrete `abap_read` follow-up for one hit — the args differ per object
 * type/include shape:
 *  - PROG/FUGR: `object` is the bare include name `abap_read` resolves on
 *    its own (verified live on A4H: `object="LBRF_FLIGHT_UTILSU01"` resolves
 *    as FUGR/I and honours offset/limit — the unverified "<group>/<include>"
 *    spelling is deliberately not used here).
 *  - DDLS: the object name itself is the one document, offset/limit apply.
 *  - INTF: one document, no offset — a class-only concept.
 *  - CLAS: the include name's CC* suffix maps onto abap_read's `include`
 *    enum (`CLASS_INCLUDES`); anything else is a method/main-source include,
 *    which abap_read cannot address by that raw include name or offset —
 *    say so instead of inventing an `include=` value outside the enum.
 */
function readHint(hit: SourceScanHit): string {
  const off = Math.max(1, hit.line - READ_WINDOW_MARGIN);
  switch (hit.objType) {
    case "PROG":
    case "FUGR":
      return `abap_read object="${hit.include}" offset=${off} limit=${READ_WINDOW_LIMIT} — read around line ${hit.line}.`;
    case "DDLS":
      return `abap_read object="${hit.objName}" offset=${off} limit=${READ_WINDOW_LIMIT} — read around line ${hit.line}.`;
    case "INTF":
      return `abap_read object="${hit.objName}" — interface source is a single document, no offset needed.`;
    case "CLAS": {
      const mapped = CLAS_INCLUDE_SUFFIX.find(([suffix]) => hit.include.endsWith(suffix));
      if (mapped) {
        const [, include] = mapped;
        return (
          `abap_read object="${hit.objName}" include="${include}" offset=${off} limit=${READ_WINDOW_LIMIT}` +
          ` — read around line ${hit.line}.`
        );
      }
      return (
        `abap_read object="${hit.objName}" — the match was in include "${hit.include}" (a method or the ` +
        "main class source); the reported line number is include-local and does NOT transfer to an " +
        'offset on the class as a whole. Use `method="<name>"` to narrow, or read the class outline first.'
      );
    }
    default:
      return `abap_read object="${hit.objName}" offset=${off} limit=${READ_WINDOW_LIMIT} — read around line ${hit.line}.`;
  }
}

function scopeLabel(q: SourceScanQuery): string {
  const parts: string[] = [];
  if (q.packages.length) parts.push(`packages=${q.packages.join(",")}`);
  if (q.objects) parts.push(`objects=${q.objects}`);
  return parts.join(" ");
}

export function buildSourceResponse(q: SourceScanQuery, result: SourceScanResult, maxChars: number): BuiltResponse {
  const { hits, summary } = result;
  const rows = hits.map((h) => ({
    type: h.objType,
    name: h.objName,
    include: h.include,
    line: String(h.line),
    text: truncateForDisplay(h.text, 120),
  }));

  const objectsNotScanned = summary.objectsTotal - summary.objectsScanned;
  const truncLine =
    summary.truncated === "hits"
      ? `--- TRUNCATED --- the hit cap (max=${q.maxHits}) was reached; more matches may exist ` +
        `beyond the last one shown. Raise \`max\` (<=200) or narrow \`query\`/scope.`
      : summary.truncated === "objects"
        ? `--- TRUNCATED --- ${objectsNotScanned} of ${summary.objectsTotal} object(s) in scope were ` +
          `not scanned (object ceiling ${q.maxObjects}). Narrow \`packages\`/\`objects\`/\`types\`.`
        : undefined;

  // `truncLine` is disclosure of a real gap in what was scanned, independent
  // of whether anything matched — an object-ceiling cut with zero hits is
  // still a cut, and used to be reported silently as a plain "(no matches)".
  const body = [rows.length ? textTable(rows, ["type", "name", "include", "line", "text"]) : "(no matches)", truncLine]
    .filter((s): s is string => s !== undefined)
    .join("\n");

  const exampleHints = (() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const h of hits) {
      if (seen.has(h.objType)) continue;
      seen.add(h.objType);
      out.push(readHint(h));
      if (out.length >= 3) break;
    }
    return out;
  })();

  return buildResponse({
    header: {
      system: result.sid,
      mode: "source",
      query: q.query,
      regex: q.regex || undefined,
      case_sensitive: q.caseSensitive || undefined,
      include_comments: q.includeComments || undefined,
      scope: scopeLabel(q) || undefined,
      include_subpackages: q.includeSubpackages || undefined,
      types: q.types.length ? q.types.join(",") : undefined,
      hits: summary.hits,
      objectsScanned: summary.objectsScanned,
      objectsTotal: summary.objectsTotal,
      includesScanned: summary.includesScanned,
      includesSkipped: summary.includesSkipped || undefined,
      truncated: summary.truncated || undefined,
    },
    body,
    bodyLabel: "MATCHES",
    notes: [
      // `notes` are ALWAYS shown (unlike `hints`, which `compact.ts`'s
      // `buildResponse` only renders when the response is incomplete) — the
      // concrete abap_read follow-up has to survive a response that fits
      // fully, so it lives here, not in `hints`.
      ...(exampleHints.length > 0 ? ["Read around a hit with abap_read:", ...exampleHints] : []),
      "Line numbers are include-local: for CLAS/FUGR hits, `line` counts from the top of the " +
        "matching include (a method's own program, not the class as a whole), not from the object.",
      ...(summary.includesSkipped > 0
        ? [
            `${summary.includesSkipped} include(s) could not be read (e.g. a generated or ` +
              "inconsistent include) and are NOT represented in the results above — this is a " +
              "gap, not proof those includes have no match.",
          ]
        : []),
      "include_comments=false strips comments with a per-line heuristic (`code_part()`), which can " +
        "misjudge a line whose quote/comment state depends on the previous line. DDLS/CDS sources have " +
        "no ABAP comment syntax, so they are always matched in full text regardless of include_comments.",
      "This is a text scan, not a call graph: it finds literal/regex matches wherever they sit " +
        '(strings, comments, dead code). Use mode="where_used" instead when what you actually want ' +
        "is real static references to one object.",
    ],
    hints: [
      "Raise `max` (<=200) for more hits, or narrow `query`/`packages`/`objects`/`types` instead of widening scope.",
    ],
    maxChars,
  });
}

export interface SearchToolDeps {
  readonly pool: SessionPool;
  readonly safety: SafetyGate;
  readonly ensureConnected: () => Promise<void>;
  readonly errorResult: (e: unknown) => CallToolResult;
  readonly cfg: Config;
}

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

/**
 * Registers `abap_search`. `objects`/`where_used` are pure reads (no write
 * gate). `source` is read-SHAPED — it never changes an ABAP object the
 * caller asked about — but it deploys/runs `ZCL_ZMCP_FLUID_SCAN` to do it, so
 * it needs the fluid API and a write-capable session/pool slot the same way
 * `abap_fpm_read` does (see `src/tools/fpm.ts`). The fluid-disabled check
 * runs BEFORE the write-target safety assert, not after: on a read-only
 * connection, `safety.assert("write", ...)` would already refuse, but with a
 * generic write-denied message that hides the real, more specific reason
 * (`FLUID_API_DISABLED`, which also fires for `ABAP_FLUID_API=false` on an
 * otherwise-writable system) — checking fluid-disabled first gives the
 * caller the reason that actually explains the refusal.
 */
export function registerSearchTools(mcp: McpServer, deps: SearchToolDeps): void {
  mcp.registerTool(
    "abap_search",
    {
      title: "Search ABAP repository",
      description:
        "Find objects by name pattern (mode=objects, wildcards *), list consumers " +
        "(mode=where_used; 20+ seconds on wide fan-in — narrow by type/query first), walk multiple " +
        "levels of callers or callees (mode=call_graph, direction=callers|callees, depth<=4), or scan " +
        "source text line by line (mode=source, needs the fluid API and a package/objects scope).",
      inputSchema: searchInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const input = args as SearchInput;
        const mode = input.mode ?? "objects";
        assertNoCallGraphOnlyFields(input, mode);

        if (mode === "source") {
          const q = buildSourceScanQuery(input);
          await deps.ensureConnected();
          deps.safety.assert("read");
          const disabled = fluidDisabledReason(deps.cfg, deps.safety);
          if (disabled) {
            throw dispatchDisabledError(disabled, deps.cfg, {
              tool: SCAN_TOOL_ID,
              action: SCAN_ACTION,
              args: scanDispatchArgs(q),
              caller: { tool: "abap_search", action: "source" },
            });
          }
          deps.safety.assert(
            "write",
            {
              name: SCAN_ENTRY_CLASS,
              packageName: FLUID_PACKAGE,
              type: "CLAS/OC",
            },
            { phase: "preflight" },
          );
          const res = await deps.pool.withWrite("abap_search", SCAN_ENTRY_CLASS, (conn) =>
            runSourceScan(conn, q, deps.safety),
          );
          return ok(buildSourceResponse(q, res, deps.cfg.maxResponseChars).text);
        }

        assertNoSourceOnlyFields(input, mode);
        await deps.ensureConnected();
        deps.safety.assert("read");
        const res = await deps.pool.withRead("abap_search", (conn) =>
          abapSearch(conn, input, deps.cfg.maxResponseChars),
        );
        return ok(res.text);
      } catch (e) {
        return deps.errorResult(e);
      }
    },
  );
}
