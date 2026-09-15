/**
 * `mode="call_graph"` for `abap_search` — an indented tree of what calls, or
 * is called by, one object.
 *
 * `direction="callers"` walks {@link fetchUsageReferences} breadth-first,
 * one level of ADT's own where-used index at a time: node N's children are
 * the object-level rows of `fetchUsageReferences(conn, N.uri)`. "Breadth-
 * first" describes that level-by-level expansion rule (nothing past `depth`
 * levels is ever fetched), not the render order below — the render walks
 * depth-first so a child's lines nest directly under its parent, which is
 * what the indentation in the rendered tree has to look like.
 *
 * There is no ADT endpoint for the reverse question ("what does this object
 * call"), so `direction="callees"` is answered by reading the object's own
 * source and pattern-matching call statements in it (`call-sites.ts`), then
 * resolving each statically-named target with `resolveObject`.
 *
 * Two facts about the where-used rows that {@link callerChildren} encodes,
 * both confirmed against `test/fixtures/live-captured/971-…-973-…`
 * (i105-usage-references-{cycle-a,cycle-b,leaf}):
 *   - every answer carries exactly one `DEVC/K` row for the containing
 *     package ($TMP), which has BOTH `adtcore:name` and `adtcore:type` like
 *     a real caller row but is not one — fixture 973's `.meta.json` calls
 *     `ZCL_I105_LEAF` "a one-caller leaf" although its raw XML has two rows
 *     with both attributes (`ZCL_I105_A` and the `$TMP` package); excluding
 *     `DEVC/K` is what makes the count match.
 *   - the target object appears in its OWN where-used answer (973: the
 *     `ZCL_I105_LEAF` row itself, `isResult="false"` like every other row —
 *     nothing in the row shape marks it as "self") — excluded by comparing
 *     `uri` against the node being expanded.
 * 971/972 are the cycle fixtures: callers of A include B, callers of B
 * include A — the `seen` map below is what turns that into a `(cycle ->
 * seen above)` leaf instead of infinite recursion.
 */
import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import { fetchUsageReferences, HIGH_FAN_IN_REFERENCES, SLOW_FETCH_MS } from "./element-info.js";
import { resolveObject, type ResolvedObject } from "./resolve.js";
import { readSource } from "./source.js";
import { parseCallSites, type CallSite, type CallKind } from "./call-sites.js";
import { CLASS_INCLUDES } from "./types.js";
import { buildResponse, type BuiltResponse } from "../compact.js";

// `HIGH_FAN_IN_REFERENCES`/`SLOW_FETCH_MS` live in `element-info.ts`, next to
// the `usageReferences` wire call whose cost they describe — `where_used`
// (in `src/tools/search.ts`) predates this module and does not depend on it,
// so the thresholds cannot live here without making `where_used`'s cost
// notes reach into `call-graph.ts` for a number that has nothing to do with
// call graphs. Re-exported by neither; both this file and search.ts import
// them straight from element-info.ts.

interface GraphStats {
  cumulativeFetchMs: number;
  maxFanIn: number;
  nodeCount: number;
  truncatedNodes: number;
}

/** `type name (package)` — the label half of every rendered line, both directions. */
function nodeLabel(node: { type: string; name: string; packageName?: string }): string {
  return `${node.type} ${node.name} (${node.packageName ?? "unknown package"})`;
}

/** The exact follow-up call a caller would type to read this node, compact JSON, one object per line. */
function abapReadCall(node: { type: string; name: string }): string {
  return `abap_read ${JSON.stringify({ object: node.name, type: node.type })}`;
}

/** First line of an `AbapError`/`Error` message — the leaf label stays one line even if the error has a long multi-line hint. */
function resolveFailureReason(e: unknown): string {
  if (e instanceof AbapError) return e.message.split("\n")[0] ?? e.message;
  return e instanceof Error ? e.message : String(e);
}

/** `cs.statement` without its trailing period — cosmetic, keeps `unresolved` leaves from reading "….` (dynamic target)". */
function statementText(cs: CallSite): string {
  return cs.statement.replace(/\.\s*$/, "");
}

// ---------------------------------------------------------------------------
// direction: "callers"
// ---------------------------------------------------------------------------

interface CallerNode {
  readonly type: string;
  readonly name: string;
  readonly uri: string;
  readonly packageName?: string;
}

/**
 * Object-level rows of a where-used answer, minus the `DEVC/K` package row
 * and the self-row — see this module's doc comment for the fixture evidence.
 * De-duplicated by `uri`: nothing in the wire shape guarantees one row per
 * object (a class with two members calling the target would otherwise be
 * counted as two callers of the same class).
 */
function callerChildren(refs: readonly Record<string, unknown>[], selfUri: string): CallerNode[] {
  const byUri = new Map<string, CallerNode>();
  for (const r of refs) {
    const name = r["adtcore:name"];
    const type = r["adtcore:type"];
    const uri = r["uri"];
    if (typeof name !== "string" || typeof type !== "string" || typeof uri !== "string") continue;
    if (type.toUpperCase() === "DEVC/K") continue;
    if (uri === selfUri) continue;
    if (byUri.has(uri)) continue;
    const packageRefValue = r["packageRef"];
    const packageRef =
      packageRefValue !== null && typeof packageRefValue === "object"
        ? (packageRefValue as Record<string, unknown>)
        : undefined;
    const packageName = packageRef ? packageRef["adtcore:name"] : undefined;
    byUri.set(uri, { type, name, uri, packageName: typeof packageName === "string" ? packageName : undefined });
  }
  return [...byUri.values()];
}

async function renderCallerNode(
  conn: AbapConnection,
  node: CallerNode,
  level: number,
  depth: number,
  max: number,
  seen: Map<string, string>,
  stats: GraphStats,
): Promise<string[]> {
  const indent = "  ".repeat(level);
  const label = nodeLabel(node);
  stats.nodeCount += 1;

  if (seen.has(node.uri)) {
    return [`${indent}${label}  (cycle -> seen above)`];
  }
  seen.set(node.uri, label);

  if (level >= depth) {
    return [`${indent}${label}  ${abapReadCall(node)}`];
  }

  const { refs, fetchMs } = await fetchUsageReferences(conn, node.uri, undefined, node.name);
  stats.cumulativeFetchMs += fetchMs;
  const children = callerChildren(refs, node.uri);
  stats.maxFanIn = Math.max(stats.maxFanIn, children.length);

  if (children.length >= HIGH_FAN_IN_REFERENCES) {
    return [`${indent}${label}  ${abapReadCall(node)}  (not expanded: ${children.length} references)`];
  }

  const lines = [`${indent}${label}  ${abapReadCall(node)}`];
  const shown = children.slice(0, max);
  for (const child of shown) {
    lines.push(...(await renderCallerNode(conn, child, level + 1, depth, max, seen, stats)));
  }
  if (children.length > shown.length) {
    const omitted = children.length - shown.length;
    stats.truncatedNodes += omitted;
    lines.push(
      `${"  ".repeat(level + 1)}--- TRUNCATED --- ${omitted} of ${children.length} caller(s) of ${node.name} not shown (max=${max}).`,
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// direction: "callees"
// ---------------------------------------------------------------------------

/**
 * Every include `CLASS_INCLUDES` lists for a `CLAS/OC` node, or `main` for
 * anything else. `readSource` already treats a class include that exists
 * but has no source as an ordinary blank read (see its `blankSourceIsAmbiguous`
 * gate, keyed off the class's own presence, not the include's) — the
 * `try`/`catch` here only guards the rarer case where the read itself
 * throws (a locked or otherwise unreadable include), which is likewise not
 * fatal to the walk: fewer call sites found, not a failed call_graph.
 */
async function collectCallSites(conn: AbapConnection, obj: ResolvedObject): Promise<CallSite[]> {
  if (obj.type.toUpperCase() === "CLAS/OC") {
    const sites: CallSite[] = [];
    for (const inc of CLASS_INCLUDES) {
      try {
        const res = await readSource(conn, obj, inc);
        sites.push(...parseCallSites(res.source, inc));
      } catch {
        continue;
      }
    }
    return sites;
  }
  try {
    const res = await readSource(conn, obj);
    return parseCallSites(res.source, "main");
  } catch {
    return [];
  }
}

interface StaticCallGroup {
  readonly target: string;
  readonly rep: CallSite;
}

/**
 * The ADT type each `CallKind` actually denotes, so `resolveObject` below
 * searches typed instead of guessing across every object kind. `"form"`
 * maps to `PROG/P` (not a form-specific type — ABAP has none): the target
 * `call-sites.ts` records for `PERFORM … IN PROGRAM` is the PROGRAM name,
 * the form itself is not a separately addressable ADT object.
 */
const CALL_KIND_TYPE: Record<CallKind, string> = {
  "function module": "FUGR/FF",
  report: "PROG/P",
  form: "PROG/P",
  method: "CLAS/OC",
  transaction: "TRAN/T",
};

/**
 * Reason text for a callee that did not resolve. `"function module"` gets a
 * fixed, specific message instead of the raw resolve error: `doc/LIMITATIONS/
 * search.md` (captures 850/851, `ENQUEUE_E_TABLE`) establishes that
 * quickSearch does not index generated function modules at all, so a miss
 * here is not evidence the module is absent — saying just "not found" would
 * overclaim.
 */
function calleeUnresolvedReason(kind: CallKind, e: unknown): string {
  if (kind === "function module") {
    return "not found by search; quickSearch does not index generated function modules, so this is not proof it does not exist";
  }
  return resolveFailureReason(e);
}

/**
 * Distinct static targets (one `resolveObject` per target, not per call
 * site — a class calling the same method twice is one child, not two), plus
 * every dynamic call site, NOT deduplicated: each is a separate line with
 * its own line number, and there is no target to group them by.
 */
function groupCallSites(sites: readonly CallSite[]): { staticGroups: StaticCallGroup[]; dynamicSites: CallSite[] } {
  const byKey = new Map<string, StaticCallGroup>();
  const dynamicSites: CallSite[] = [];
  for (const cs of sites) {
    if (cs.target === undefined) {
      dynamicSites.push(cs);
      continue;
    }
    const key = `${cs.kind}|${cs.target.toUpperCase()}`;
    if (!byKey.has(key)) byKey.set(key, { target: cs.target, rep: cs });
  }
  return { staticGroups: [...byKey.values()], dynamicSites };
}

async function renderCalleeNode(
  conn: AbapConnection,
  node: ResolvedObject,
  level: number,
  depth: number,
  max: number,
  seen: Map<string, string>,
  stats: GraphStats,
): Promise<string[]> {
  const indent = "  ".repeat(level);
  const label = nodeLabel(node);
  stats.nodeCount += 1;

  if (seen.has(node.uri)) {
    return [`${indent}${label}  (cycle -> seen above)`];
  }
  seen.set(node.uri, label);

  if (level >= depth) {
    return [`${indent}${label}  ${abapReadCall(node)}`];
  }

  const fetchStart = Date.now();
  const sites = await collectCallSites(conn, node);
  stats.cumulativeFetchMs += Date.now() - fetchStart;

  const { staticGroups, dynamicSites } = groupCallSites(sites);

  type Entry = { readonly render: string } | { readonly expand: ResolvedObject };
  const entries: Entry[] = [];
  for (const group of staticGroups) {
    const kind = group.rep.kind;
    try {
      const resolved = await resolveObject(conn, group.target, { type: CALL_KIND_TYPE[kind] });
      entries.push({ expand: resolved });
      continue;
    } catch (typedError) {
      // A `method` target read off `zif_foo=>bar(` may name an INTERFACE, not a
      // class (source text alone cannot tell the two apart — `=>` is legal on
      // both) — `{type:"CLAS/OC"}` misses it, so retry untyped before giving up.
      // Only report `unresolved` once BOTH attempts fail.
      if (kind === "method") {
        try {
          const resolved = await resolveObject(conn, group.target);
          entries.push({ expand: resolved });
          continue;
        } catch (untypedError) {
          entries.push({ render: `unresolved  ${statementText(group.rep)}  — ${calleeUnresolvedReason(kind, untypedError)}` });
          continue;
        }
      }
      entries.push({ render: `unresolved  ${statementText(group.rep)}  — ${calleeUnresolvedReason(kind, typedError)}` });
    }
  }
  for (const cs of dynamicSites) {
    entries.push({ render: `unresolved  ${statementText(cs)} (dynamic target)  — line ${cs.line} of ${cs.include}` });
  }

  const lines = [`${indent}${label}  ${abapReadCall(node)}`];
  const shown = entries.slice(0, max);
  for (const entry of shown) {
    if ("expand" in entry) {
      lines.push(...(await renderCalleeNode(conn, entry.expand, level + 1, depth, max, seen, stats)));
    } else {
      stats.nodeCount += 1;
      lines.push(`${"  ".repeat(level + 1)}${entry.render}`);
    }
  }
  if (entries.length > shown.length) {
    const omitted = entries.length - shown.length;
    stats.truncatedNodes += omitted;
    lines.push(
      `${"  ".repeat(level + 1)}--- TRUNCATED --- ${omitted} of ${entries.length} callee(s) of ${node.name} not shown (max=${max}).`,
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/**
 * Read-only — routed through `deps.pool.withRead` by `registerSearchTools`
 * in `src/tools/search.ts`, exactly like `objects`/`where_used`, and never
 * touches the fluid API (unlike `mode="source"`, which needs a write-capable
 * slot to deploy `ZCL_ZMCP_FLUID_SCAN`). `depth`/`max` are already validated
 * by the caller (depth<=4 — G-08, refused rather than clamped) by the time
 * this runs.
 */
export async function buildCallGraph(
  conn: AbapConnection,
  target: string,
  type: string | undefined,
  direction: "callers" | "callees",
  depth: number,
  max: number,
  maxChars: number,
): Promise<BuiltResponse> {
  const root = await resolveObject(conn, target, type ? { type } : {});
  const seen = new Map<string, string>();
  const stats: GraphStats = { cumulativeFetchMs: 0, maxFanIn: 0, nodeCount: 0, truncatedNodes: 0 };

  const lines =
    direction === "callers"
      ? await renderCallerNode(
          conn,
          { type: root.type, name: root.name, uri: root.uri, packageName: root.packageName },
          0,
          depth,
          max,
          seen,
          stats,
        )
      : await renderCalleeNode(conn, root, 0, depth, max, seen, stats);

  const expensive = stats.cumulativeFetchMs >= SLOW_FETCH_MS || stats.maxFanIn >= HIGH_FAN_IN_REFERENCES;

  const notes: string[] = [];
  if (expensive) {
    notes.push(
      `FETCH COST: this walk spent ${(stats.cumulativeFetchMs / 1000).toFixed(1)}s CUMULATIVE across every ` +
        `${direction === "callers" ? "usageReferences fetch" : "source read"} it made` +
        (direction === "callers" ? ` (highest single-node fan-in: ${stats.maxFanIn} references)` : "") +
        `. The cost is set by fan-in and depth, not by max — every reference or include is fetched ` +
        `before max trims what is shown, so lowering max would not have made this walk cheaper. ` +
        `Narrow with a smaller depth, or ask about a less widely-referenced object.`,
    );
  }
  notes.push(
    "This graph is static. A dynamically dispatched call — CALL FUNCTION lv_name, obj->method( ) " +
      "through a variable, PERFORM (lv_form) IN PROGRAM (lv_prog), SUBMIT (lv_prog), CALL TRANSACTION " +
      'lv_t — cannot be resolved to a target object and appears as an "unresolved … (dynamic target)" ' +
      'leaf instead of an edge; an object reachable only that way is invisible here. Use abap_search ' +
      'mode="source" to search for it by text.',
  );
  if (direction === "callees") {
    notes.push(
      "Edges come from parsing this object's own source text, not an ADT index: a call name built " +
        "at runtime (string concatenation) or one issued from inside a macro expansion is invisible " +
        "to this parser, even though it is fully static from ABAP's own point of view.",
    );
  }

  return buildResponse({
    header: {
      system: conn.cfg.sid,
      mode: "call_graph",
      direction,
      object: `${root.type} ${root.name}`,
      uri: root.uri,
      depth,
      nodes: stats.nodeCount,
      truncatedNodes: stats.truncatedNodes > 0 ? stats.truncatedNodes : undefined,
      fetchMs: expensive ? stats.cumulativeFetchMs : undefined,
    },
    body: lines.join("\n"),
    bodyLabel: "CALL GRAPH",
    notes,
    hints: [
      direction === "callers"
        ? 'Pass direction="callees" to see what this object calls instead.'
        : 'Pass direction="callers" to see who calls this object instead.',
      "Raise `depth` (<=4) to expand further, or `max` to show more children per node.",
    ],
    maxChars,
  });
}
