/**
 * `abap_search`'s `mode: "source"` adapter onto the static fluid `scan` tool
 * body (`ZCL_ZMCP_FLUID_SCAN`, src/adt/fluid/builtin/scan.ts). Modeled
 * directly on `src/adt/fpm-runtime.ts`: `runSourceScan` maps a query onto a
 * `dispatch()` call, and `mapScanRows` rebuilds a typed result from the row
 * array `dispatch()` returns after validating it against the manifest's
 * declared output schema (dispatch.ts still re-checks the row shape itself
 * from that schema; `mapScanRows` narrows it further into the two concrete
 * row shapes this file's callers need, and is the only place that turns "the
 * schema matched" into "this specific row is well-formed").
 */
import { AbapError } from "./errors.js";
import type { AbapConnection } from "./connection.js";
import { dispatch } from "./fluid/dispatch.js";
import { scanManifest, scanSources, SCAN_TOOL_ID, SCAN_ACTION } from "./fluid/builtin/scan.js";
import { manifestVersion, type LoadedFluidTool } from "./fluid/manifest.js";
import type { SafetyGate } from "../safety.js";

// ---------------------------------------------------------------------------
// Query model
// ---------------------------------------------------------------------------

export const SOURCE_SCAN_TYPES = ["PROG", "CLAS", "INTF", "FUGR", "DDLS"] as const;

/** Object-count ceiling `abap_search` imposes on mode="source" scopes. */
export const SOURCE_SCAN_OBJECT_CEILING = 200;

export interface SourceScanQuery {
  readonly query: string;
  readonly regex: boolean;
  readonly caseSensitive: boolean;
  readonly includeComments: boolean;
  readonly packages: readonly string[];
  readonly includeSubpackages: boolean;
  readonly objects?: string;
  readonly types: readonly string[];
  readonly maxHits: number;
  readonly maxObjects: number;
}

export interface SourceScanHit {
  readonly objType: string;
  readonly objName: string;
  readonly include: string;
  readonly line: number;
  readonly text: string;
}

export interface SourceScanSummary {
  readonly objectsTotal: number;
  readonly objectsScanned: number;
  readonly includesScanned: number;
  readonly includesSkipped: number;
  readonly hits: number;
  readonly truncated: "" | "hits" | "objects";
}

export interface SourceScanResult {
  readonly sid: string;
  readonly hits: readonly SourceScanHit[];
  readonly summary: SourceScanSummary;
  readonly ms: number;
  readonly truncated: boolean;
}

// ---------------------------------------------------------------------------
// dispatch() plumbing
// ---------------------------------------------------------------------------

const SCAN_TOOLS: ReadonlyMap<string, LoadedFluidTool> = new Map([
  [
    SCAN_TOOL_ID,
    {
      manifest: scanManifest,
      origin: "builtin",
      sources: scanSources,
      version: manifestVersion(scanManifest, scanSources),
    } as const,
  ],
]);

/** Omits undefined/empty-valued keys entirely rather than passing them through to `dispatch()`'s schema validation (mirrors `fpmDispatchArgs` in fpm-runtime.ts). */
export function scanDispatchArgs(q: SourceScanQuery): Record<string, unknown> {
  return {
    query: q.query,
    regex: q.regex,
    case_sensitive: q.caseSensitive,
    include_comments: q.includeComments,
    ...(q.packages.length > 0 ? { packages: q.packages } : {}),
    include_subpackages: q.includeSubpackages,
    ...(q.objects !== undefined && q.objects !== "" ? { objects: q.objects } : {}),
    ...(q.types.length > 0 ? { types: q.types } : {}),
    max_hits: q.maxHits,
    max_objects: q.maxObjects,
  };
}

// ---------------------------------------------------------------------------
// Result mapping — pure and total; throws FLUID_PROTOCOL_ERROR on any shape
// the manifest's output schema does not actually rule out (e.g. `dispatch()`
// only checks that array items are objects with a string "kind"; the rest of
// the per-row shape is this function's job to enforce).
// ---------------------------------------------------------------------------

function fail(reason: string, result: unknown): never {
  throw new AbapError(
    "FLUID_PROTOCOL_ERROR",
    `scan.source ${reason}`,
    { tool: SCAN_TOOL_ID, action: SCAN_ACTION, result },
  );
}

interface RawHitRow {
  [key: string]: unknown;
  kind: "hit";
  obj_type: string;
  obj_name: string;
  include: string;
  line: number;
  text: string;
}

interface RawSummaryRow {
  [key: string]: unknown;
  kind: "summary";
  objects_total: number;
  objects_scanned: number;
  includes_scanned: number;
  includes_skipped: number;
  hits: number;
  truncated: "" | "hits" | "objects";
}

function isHitRow(r: Record<string, unknown>): r is RawHitRow {
  return (
    typeof r["obj_type"] === "string" &&
    typeof r["obj_name"] === "string" &&
    typeof r["include"] === "string" &&
    typeof r["line"] === "number" &&
    typeof r["text"] === "string"
  );
}

function isSummaryRow(r: Record<string, unknown>): r is RawSummaryRow {
  return (
    typeof r["objects_total"] === "number" &&
    typeof r["objects_scanned"] === "number" &&
    typeof r["includes_scanned"] === "number" &&
    typeof r["includes_skipped"] === "number" &&
    typeof r["hits"] === "number" &&
    (r["truncated"] === "" || r["truncated"] === "hits" || r["truncated"] === "objects")
  );
}

export function mapScanRows(rows: unknown): { hits: SourceScanHit[]; summary: SourceScanSummary } {
  if (!Array.isArray(rows)) {
    fail("returned a result that is not an array", rows);
  }

  const hits: SourceScanHit[] = [];
  let summary: SourceScanSummary | undefined;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      fail(`row ${i} is not an object`, rows);
    }
    const r = row as Record<string, unknown>;
    if (r["kind"] !== "hit" && r["kind"] !== "summary") {
      fail(`row ${i} has kind "${String(r["kind"])}", expected "hit" or "summary"`, rows);
    }

    if (r["kind"] === "hit") {
      if (!isHitRow(r)) {
        fail(`row ${i} is a hit row missing or mistyping one of obj_type/obj_name/include/line/text`, rows);
      }
      if (summary !== undefined) {
        fail(`row ${i} is a hit row after the summary row`, rows);
      }
      hits.push({
        objType: r.obj_type,
        objName: r.obj_name,
        include: r.include,
        line: r.line,
        text: r.text,
      });
      continue;
    }

    // kind === "summary"
    if (summary !== undefined) {
      fail("returned more than one summary row", rows);
    }
    if (!isSummaryRow(r)) {
      fail(`row ${i} is a summary row missing or mistyping one of its required fields`, rows);
    }
    if (i !== rows.length - 1) {
      fail("returned a summary row that is not the last element", rows);
    }
    summary = {
      objectsTotal: r.objects_total,
      objectsScanned: r.objects_scanned,
      includesScanned: r.includes_scanned,
      includesSkipped: r.includes_skipped,
      hits: r.hits,
      truncated: r.truncated,
    };
  }

  if (summary === undefined) {
    fail("did not return a summary row", rows);
  }

  return { hits, summary };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runSourceScan(
  conn: AbapConnection,
  q: SourceScanQuery,
  gate: SafetyGate,
): Promise<SourceScanResult> {
  const started = Date.now();
  const res = await dispatch(
    { conn, cfg: conn.cfg, gate, tools: SCAN_TOOLS },
    {
      tool: SCAN_TOOL_ID,
      action: SCAN_ACTION,
      args: scanDispatchArgs(q),
      // Names the MCP-facing tool/action in a FLUID_API_DISABLED refusal — see FluidRunRequest.caller's doc.
      caller: { tool: "abap_search", action: "source" },
    },
  );

  return {
    sid: conn.cfg.sid,
    ...mapScanRows(res.result),
    ms: Date.now() - started,
    truncated: res.truncated,
  };
}
