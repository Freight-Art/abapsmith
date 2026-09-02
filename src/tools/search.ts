/**
 * `abap_search` — objects and where-used. Source grep needs the ZMCP
 * service and has not shipped yet.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AbapConnection } from "../adt/connection.js";
import { AbapError } from "../adt/errors.js";
import { resolveObject } from "../adt/resolve.js";
import { repairSearchDescriptions } from "../adt/search-descriptions.js";
import { buildResponse, textTable, type BuiltResponse } from "../compact.js";
import { specForKeyword, specForType, TYPES } from "../adt/types.js";
import { truncateForDisplay } from "../truncate.js";
import type { SessionPool } from "../adt/pool.js";
import type { Config } from "../config.js";
import type { SafetyGate } from "../safety.js";

const DESCRIPTION_COL_WIDE = 70;
const DESCRIPTION_COL_NARROW = 60;

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
    .describe('Name pattern (mode=objects) or target object (mode=where_used).'),
  mode: z.enum(["objects", "where_used"]).optional().describe('Default "objects".'),
  type: z
    .string()
    .optional()
    .describe(
      `ADT type filter. One of: ${[...KNOWN_TYPE_GROUPS].sort().join(" ")}; or a full code, e.g. "CLAS/OC".`,
    ),
  max: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe(
      "Default 50 rows; narrowing `query` (not lowering `max`) is what makes a broad call cheaper.",
    ),
};

export const SearchInput = z.object(searchInputSchema);
export type SearchInput = z.infer<typeof SearchInput>;

export async function abapSearch(
  conn: AbapConnection,
  input: SearchInput,
  maxChars: number,
): Promise<BuiltResponse> {
  const max = input.max ?? 50;
  if (input.type) assertKnownType(input.type);
  if ((input.mode ?? "objects") === "where_used") {
    return whereUsed(conn, input.query, input.type, max, maxChars);
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
    package: r["adtcore:packageName"] ?? "",
    description: truncateForDisplay(r["adtcore:description"] ?? "", DESCRIPTION_COL_WIDE),
  }));

  const body = rows.length
    ? [textTable(rows, ["type", "name", "package", "description"]), capLine, windowLine]
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
    hints: ["Narrow the pattern or set `type` to reduce the result set, or raise `max` (<=200)."],
    maxChars,
  });
}

// Heuristic thresholds, not a fitted cost curve: the only measured data
// point is CL_ABAP_TYPEDESCR at ~5,896 references / ~24s wall-clock on A4H.
// Either signal alone marks the call expensive.
const HIGH_FAN_IN_REFERENCES = 500;
const SLOW_FETCH_MS = 5000;

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
  const fetchStart = Date.now();
  const refs = await conn.adt.usageReferences(obj.uri);
  const fetchMs = Date.now() - fetchStart;

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
  const rows = kept.map((r) => ({
    type: r["adtcore:type"] ?? "",
    name: r["adtcore:name"] ?? "",
    package: r.packageRef?.["adtcore:name"] ?? "",
    description: truncateForDisplay(r["adtcore:description"] ?? "", DESCRIPTION_COL_NARROW),
  }));

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

export interface SearchToolDeps {
  readonly pool: SessionPool;
  readonly safety: SafetyGate;
  readonly ensureConnected: () => Promise<void>;
  readonly errorResult: (e: unknown) => CallToolResult;
  readonly cfg: Pick<Config, "maxResponseChars">;
}

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

/** Registers `abap_search` — a pure read tool, no write gate involved. */
export function registerSearchTools(mcp: McpServer, deps: SearchToolDeps): void {
  mcp.registerTool(
    "abap_search",
    {
      title: "Search ABAP repository",
      description:
        "Find objects by name pattern (mode=objects, wildcards *) or list consumers " +
        "(mode=where_used); 20+ seconds on wide fan-in — narrow by type/query first.",
      inputSchema: searchInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        await deps.ensureConnected();
        deps.safety.assert("read");
        const res = await deps.pool.withRead("abap_search", (conn) =>
          abapSearch(conn, args as SearchInput, deps.cfg.maxResponseChars),
        );
        return ok(res.text);
      } catch (e) {
        return deps.errorResult(e);
      }
    },
  );
}
