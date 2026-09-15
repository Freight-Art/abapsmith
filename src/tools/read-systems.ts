/**
 * Cross-system `view="diff"` (issue #93): compares the CURRENT active
 * source of one object across two configured systems, e.g. "what does
 * ZCL_FOO look like on QAS vs. on DEV right now". Deliberately separate
 * from `readDiff` in `read.ts`, which compares two VERSIONS of one object
 * on one system — the two features share rendering machinery
 * (`buildReadResponse`, `DIFF_MAX_HUNKS`, `includeNote`) but not a version
 * feed: there is no shared history between two independent SAP systems,
 * so this never touches `listRevisions`/`resolveDiffPair` at all.
 *
 * All the "should this call even be allowed" refusals (both sides naming
 * the same alias, `from`/`to` version selectors combined with a
 * cross-system request, `method`/`outline`/etc. not being meaningful here)
 * live in `read.ts`, next to `registerReadTools` — this file only fetches,
 * diffs and renders once both sides are already validated and resolved.
 */
import { AbapError } from "../adt/errors.js";
import { resolveObject, type ResolvedObject } from "../adt/resolve.js";
import { readSource } from "../adt/source.js";
import { diffSources, renderHunks, DEFAULT_CONTEXT_LINES } from "../diff.js";
import { sliceLines, type BuiltResponse } from "../compact.js";
import { buildReadResponse, includeNote, DIFF_MAX_HUNKS, type ReadInput, type ReadSystemSide } from "./read.js";

/** `system.alias (sid/client)`, matching the `from`/`to` header fields' spec. */
function describeSide(side: ReadSystemSide, obj: ResolvedObject): string {
  return `${side.alias} (${obj.system}/${side.cfg.client})`;
}

/**
 * Fetches one side of a cross-system diff: connects, gates the READ against
 * that side's OWN safety gate (never the default's — a read-only QAS must
 * refuse this exactly like it would refuse a direct `abap_read` against
 * it), resolves the object and reads its current active source. No
 * `version` is ever passed to `readSource` — cross-system diff compares
 * CURRENT active source only, on both sides.
 */
async function fetchCrossSystemSide(
  side: ReadSystemSide,
  input: ReadInput,
): Promise<{ obj: ResolvedObject; source: string }> {
  await side.ensureConnected();
  side.safety.assert("read");
  try {
    return await side.pool.withRead("abap_read", async (conn) => {
      const obj = await resolveObject(conn, input.object, input.type ? { type: input.type } : {});
      const { source } = await readSource(conn, obj, input.include);
      return { obj, source };
    });
  } catch (e) {
    // Re-wrap NOT_FOUND to name WHICH system the object was missing from —
    // the bare message ("ZCL_FOO does not exist") is ambiguous the moment
    // two systems are in play. Code, hint and the rest of details are kept
    // as-is; only the message gains the system and details gains `system`.
    if (e instanceof AbapError && e.code === "NOT_FOUND") {
      throw new AbapError(
        e.code,
        `${input.object} was not found on ${side.alias} (${e.message})`,
        { ...e.details, system: side.alias },
        e.hint,
      );
    }
    throw e;
  }
}

/**
 * Runs a cross-system `view="diff"`: fetches the object's current active
 * source from both `from` and `to` in parallel, diffs it exactly like
 * `readDiff` diffs two versions, and renders through the same
 * `buildReadResponse` so paging, truncation and notes behave identically
 * to every other view this tool serves. All parameter-compatibility
 * refusals (same-alias, `from`/`to` version selectors, `method` etc.) have
 * already run in `read.ts` before this is called — this function assumes
 * `input` is already a request this feature CAN answer.
 */
export async function runCrossSystemDiff(params: {
  from: ReadSystemSide;
  to: ReadSystemSide;
  input: ReadInput;
  maxChars: number;
}): Promise<BuiltResponse> {
  const { from, to, input, maxChars } = params;

  const [older, newer] = await Promise.all([fetchCrossSystemSide(from, input), fetchCrossSystemSide(to, input)]);

  const result = diffSources(older.source, newer.source, {
    context: input.context ?? DEFAULT_CONTEXT_LINES,
    maxHunks: DIFF_MAX_HUNKS,
  });
  const rendered = renderHunks(result.hunks);
  const window = sliceLines(rendered, input.offset ?? 1, input.limit);

  const fromLabel = describeSide(from, older.obj);
  const toLabel = describeSide(to, newer.obj);

  const notes: string[] = [
    `Compares the CURRENT ACTIVE source of ${older.obj.type} ${older.obj.name} on ${fromLabel} against ` +
      `${newer.obj.type} ${newer.obj.name} on ${toLabel} — not a released version on either side, and ` +
      "no shared version feed between two independent systems, unlike a same-system view=\"diff\".",
    "Only the unified-diff hunks were fetched from each side, not either full source.",
    ...includeNote(input.include),
  ];
  if (older.obj.type !== newer.obj.type) {
    notes.push(
      `TYPE DIFFERS: ${older.obj.name} resolved to ${older.obj.type} on ${from.alias} but ` +
        `${newer.obj.type} on ${to.alias}. This is a finding, not an error — the object may have been ` +
        "recreated under a different type on one side.",
    );
  }
  if (older.obj.packageName !== newer.obj.packageName) {
    notes.push(
      `PACKAGE DIFFERS: ${older.obj.packageName ?? "(none)"} on ${from.alias} vs. ` +
        `${newer.obj.packageName ?? "(none)"} on ${to.alias}. This is a finding, not an error.`,
    );
  }
  if (result.coarse) {
    notes.push(
      "COARSE DIFF: the two sides share almost no leading or trailing lines, so the exact " +
        "line-matching pass was skipped and the whole changed region is reported as one " +
        "delete-then-insert block. The diff is correct but not minimal.",
    );
  }
  if (result.droppedHunks > 0) {
    notes.push(
      `TRUNCATED: showing ${result.hunks.length} of ${result.totalHunks} hunks; ` +
        `${result.droppedHunks} were withheld to stay inside the response budget. Narrow the ` +
        "comparison (e.g. include=\"main\" only) or read each side separately.",
    );
  }

  const header: Record<string, string | number | undefined> = {
    object: input.object,
    view: "diff",
    ...(input.include ? { include: input.include } : {}),
    from: fromLabel,
    to: toLabel,
    added: result.added,
    removed: result.removed,
    hunks: result.totalHunks,
  };
  if (older.obj.packageName === newer.obj.packageName) {
    header.package = older.obj.packageName;
  } else {
    header.fromPackage = older.obj.packageName;
    header.toPackage = newer.obj.packageName;
  }

  return buildReadResponse({
    header,
    body: result.identical
      ? `(no differences: ${older.obj.type} ${older.obj.name} is line-for-line identical on ` +
        `${fromLabel} and ${toLabel}.)`
      : window.text,
    bodyLabel: "DIFF",
    bodyOffset: result.identical ? undefined : window.offset,
    bodyTotalLines: result.identical ? undefined : window.total,
    notes,
    hints: [
      "Unified-diff hunks only — the unchanged bulk of both sides was never fetched into this " +
        `response. Read a side in full with a plain abap_read against system: "${from.alias}" or ` +
        `system: "${to.alias}" if you need it.`,
    ],
    pagingParam: "offset",
    maxChars,
  });
}
