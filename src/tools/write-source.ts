/**
 * Source resolution for `abap_write` (whole source, `edit`, `method` splice),
 * the pre-write source guards (orphan METHOD block, echoed tool response),
 * and the source-shape / DDIC-skeleton rejection hints.
 */
import type { AbapConnection } from "../adt/connection.js";
import { ddicDescriptorSkeleton } from "../adt/ddic-payload.js";
import { AbapError, isAbapError } from "../adt/errors.js";
import type { ResolvedObject } from "../adt/resolve.js";
import {
  countMethodKeywordLines,
  methodNamesMatch,
  readMethod,
  scanMethodBlocks,
} from "../adt/source.js";
import type { MethodBlock, SourceRange } from "../adt/source.js";
import { canonicalEtag, readCurrentSource } from "../adt/write.js";
import type { ResolvedTarget } from "../adt/write.js";
import { stripPartialEtag } from "../compact.js";
import type { AuthorizedTarget, MutatingOperation } from "../safety.js";
import { applyEdit, describeEditFailure, EditInputError } from "./edit.js";
import type { WriteInputV2 } from "./write-schema.js";

/**
 * Adapts `t: ResolvedTarget` (write/authorize pipeline) into the
 * `ResolvedObject` shape `readMethod`/`classMembers` (src/adt/source.js)
 * want, avoiding a second `resolveObject` round trip. Every field those two
 * functions actually read (`.uri`, `.type`, `.name`) comes from `t`; the rest
 * exist only to satisfy the shape: `system`/`kind`/`label` are still real
 * values (just sourced from `t.spec`/`conn.cfg`), `mode: "source"` is
 * accurate for method-replace targets, and `activation` is what the
 * descriptor GET in `resolveWriteTarget` reported (`"unknown"` — its honest
 * default — when nothing was read); `classMembersFor` uses it to skip the
 * inactive-structure attempt when the descriptor says active is current.
 */
function resolvedObjectAdapter(conn: AbapConnection, t: ResolvedTarget): ResolvedObject {
  return {
    system: conn.cfg.sid,
    type: t.type,
    kind: t.spec.kind,
    label: t.spec.label,
    name: t.name,
    uri: t.uri,
    sourceUri: t.sourceUri,
    packageName: t.packageName,
    description: t.description,
    mode: "source",
    activation: t.activation ?? "unknown",
    spec: t.spec,
  };
}

/** A complete `METHOD <name>. ... ENDMETHOD.` block — case-insensitive keywords. */
const METHOD_BLOCK_RE = /^\s*METHOD\s+\S+\s*\.[\s\S]*\n?\s*ENDMETHOD\s*\.\s*$/i;

/**
 * Replace ONE method's `METHOD … ENDMETHOD.` block inside `current`.
 *
 * Does NOT simply slice ADT's `{startLine,endLine}` range from
 * `/objectstructure`: that range isn't guaranteed to index the same document
 * being spliced (ADT reports ranges against includes and other objects too),
 * and a wrong slice used to silently emit unparseable ABAP. Instead the
 * boundaries are DERIVED from the bytes being rewritten, keyed by method
 * NAME (meaningful across documents), with ADT's range demoted to a
 * cross-check/disambiguator only. The result is then VERIFIED (step 6, the
 * METHOD/ENDMETHOD count invariant) before it can reach the wire.
 *
 * `scanMethodBlocks` blanks string literals/comments first, so a body
 * containing `"… ENDMETHOD …"` cannot move a boundary.
 *
 * Exported for test/write-method-splice.test.ts: pure function of two
 * strings and a name, pinnable with no connection, fake or route table.
 */
export function spliceMethodBlock(args: {
  /** The object's current source — the text whose line numbers are authoritative. */
  current: string;
  /** The replacement, already trimmed: exactly one complete METHOD…ENDMETHOD block. */
  replacement: string;
  /** ADT's canonical member name, e.g. `ZIF_FOO~BAR`. */
  memberName: string;
  /** What the caller actually typed, for error messages and as a second key. */
  requested: string;
  /** ADT's claim about where the block is. A hint — never the authority. */
  range?: SourceRange;
  /** Object name, for error details. */
  object: string;
}): string {
  const { current, replacement, memberName, requested, range, object } = args;
  const details = { object, method: requested, member: memberName };

  // 1. The replacement must be exactly ONE well-formed block — unlike
  //    METHOD_BLOCK_RE (a whole-string regex), this can't be fooled by an
  //    ENDMETHOD. inside a literal or by two concatenated methods.
  const rep = scanMethodBlocks(replacement);
  if (rep.malformed || rep.blocks.length !== 1) {
    throw new AbapError(
      "BAD_INPUT",
      `source for method=${requested} must be exactly ONE complete "METHOD ... ENDMETHOD." block ` +
        `(found ${rep.blocks.length}${rep.malformed ? `; ${rep.malformed}` : ""}).`,
      { ...details, blocks: rep.blocks.length, ...(rep.malformed ? { malformed: rep.malformed } : {}) },
      "Send one method only. To change several, call abap_write once per method, or rewrite the " +
        "whole object with `source` alone.",
    );
  }

  // 2. The object's own source must tokenise cleanly, or we don't know where
  //    anything begins/ends and a rewrite would be a guess.
  const scan = scanMethodBlocks(current);
  if (scan.malformed) {
    throw new AbapError(
      "UNSUPPORTED",
      `The current source of ${object} does not parse into well-formed method blocks ` +
        `(${scan.malformed}), so abapsmith cannot safely replace ${requested} inside it.`,
      { ...details, malformed: scan.malformed },
      "Read the object, fix the unbalanced METHOD/ENDMETHOD, and write the whole source back — " +
        "or pass the complete new source with `source` alone.",
    );
  }

  // 3. Locate the block BY NAME. Exact match wins; the interface-prefix-
  //    insensitive rule is the fallback for an ALIASES declaration
  //    (`METHOD bar.` implementing `ZIF_FOO~BAR`).
  const named = (name: string): MethodBlock[] => {
    const exact = scan.blocks.filter((b) => b.name.toUpperCase() === name.toUpperCase());
    return exact.length ? exact : scan.blocks.filter((b) => methodNamesMatch(b.name, name));
  };
  let candidates = named(memberName);
  if (candidates.length === 0) candidates = named(requested);

  if (candidates.length === 0) {
    // The method exists on the server but its block isn't in the text we
    // hold — the implementation lives in another document. Refuse rather
    // than cut at line numbers that describe a different document.
    throw new AbapError(
      "NOT_FOUND",
      `No "METHOD ${memberName} ... ENDMETHOD." block was found in the current source of ${object}, ` +
        `so there is nothing to replace. The class reports the method, but its implementation is not ` +
        `in the source abapsmith read` +
        (range?.document ? ` (ADT places it in ${range.document})` : "") +
        ".",
      {
        ...details,
        ...(range ? { adtRange: `${range.startLine}-${range.endLine}` } : {}),
        ...(range?.document ? { adtDocument: range.document } : {}),
        methodsInSource: scan.blocks.map((b) => b.name),
      },
      "The implementation may live in a class include or another object. Read the object first and " +
        "use `edit` to splice the exact text you can see, or write the full source.",
    );
  }

  // 4. Two blocks can legitimately share a short name (`IF1~DO`/`IF2~DO` both
  //    match bare `DO`) — ADT's range is the tie-breaker here, never the boundary itself.
  let block = candidates[0] as MethodBlock;
  if (candidates.length > 1) {
    const pinned = range
      ? candidates.filter((b) => b.startLine <= range.startLine && range.startLine <= b.endLine)
      : [];
    if (pinned.length !== 1) {
      throw new AbapError(
        "AMBIGUOUS",
        `${object} has ${candidates.length} method blocks matching ${requested} ` +
          `(lines ${candidates.map((b) => `${b.startLine}-${b.endLine}`).join(", ")}), and abapsmith ` +
          "cannot tell which one you mean.",
        { ...details, candidates: candidates.map((b) => ({ name: b.name, lines: `${b.startLine}-${b.endLine}` })) },
        "Name the method with its full interface prefix, e.g. ZIF_FOO~BAR.",
      );
    }
    block = pinned[0] as MethodBlock;
  }

  // 5. Splice on the LOCALLY DERIVED, name-verified boundaries — used even
  //    when ADT's range disagrees; step 6 re-checks the result either way.
  const lines = current.replace(/\r\n/g, "\n").split("\n");
  const spliced = [
    ...lines.slice(0, block.startLine - 1),
    replacement,
    ...lines.slice(block.endLine),
  ].join("\n");

  // 6. THE BACKSTOP: one block out, one block in, so the object must end up
  //    with exactly as many METHOD/ENDMETHOD statements as it started with.
  //    Cheap invariant over the finished text; holds regardless of which
  //    assumption above turns out to be wrong.
  const before = countMethodKeywordLines(current);
  const after = countMethodKeywordLines(spliced);
  if (after.method !== before.method || after.endmethod !== before.endmethod) {
    throw new AbapError(
      "UNSUPPORTED",
      `Internal check failed: replacing ${requested} in ${object} changed the object's METHOD/ENDMETHOD ` +
        `balance (before ${before.method}/${before.endmethod}, after ${after.method}/${after.endmethod}), ` +
        "which cannot be valid ABAP. Nothing was written.",
      { ...details, before, after, block: `${block.startLine}-${block.endLine}` },
      "This is an abapsmith bug, not a problem with your code — the source on the server is untouched. " +
        "Rewrite the whole object with `source` alone, and please report the object shape.",
    );
  }
  return spliced;
}

/**
 * Refuse a whole-object rewrite whose ENTIRE text is a single method block —
 * the second, defense-in-depth closure of the `edit`/`method`-dropped-by-
 * schema incident above: whatever drops `method` next (a proxy, a future
 * surface), the bytes still can't reach the wire, since no ABAP object's
 * complete source is one bare METHOD block.
 *
 * Deliberately narrow (a false refusal is worse than the hole): fires only
 * when the text is exactly one block and nothing else. `INCLUDE_TYPES` are
 * exempt — a `PROG/I` include pulled into a `CLASS … IMPLEMENTATION` can
 * legitimately be nothing but a method block.
 */
const INCLUDE_TYPES = new Set(["PROG/I", "FUGR/I"]);

export function assertNotOrphanMethodBlock(source: string, object: string, type?: string): void {
  if (type !== undefined && INCLUDE_TYPES.has(type.toUpperCase())) return;
  const scan = scanMethodBlocks(source);
  if (scan.malformed || scan.blocks.length !== 1) return;
  const block = scan.blocks[0] as MethodBlock;
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const firstCode = lines.findIndex((l) => l.trim() !== "") + 1;
  let lastCode = lines.length;
  while (lastCode > 0 && (lines[lastCode - 1] ?? "").trim() === "") lastCode -= 1;
  if (block.startLine !== firstCode || block.endLine !== lastCode) return;
  throw new AbapError(
    "BAD_INPUT",
    `The source given for ${object} is a single "METHOD ${block.name} ... ENDMETHOD." block, not a ` +
      "complete object source. Writing it would REPLACE the whole object with that one method, and " +
      "the result cannot compile — no ABAP object's full source is a bare METHOD block.",
    { object, method: block.name, lines: `${block.startLine}-${block.endLine}` },
    "To replace one method, pass `method` alongside `source`: " +
      '{object, method: "MY_METHOD", source: "METHOD my_method. ... ENDMETHOD."}. If the `method` ' +
      "field is being dropped before it reaches abapsmith, the tool schema in use does not declare it. " +
      "To rewrite the whole object, send its complete source including the CLASS/REPORT scaffolding.",
  );
}

/** abapsmith's own response furniture; `buildResponse` (src/compact.ts) emits each as a whole line. */
const TOOL_RESPONSE_FENCE_RE =
  /^[ \t]*--- (SOURCE|METHOD SOURCE|XML DESCRIPTOR|PSEUDO-DDL|OUTLINE|TRUNCATED|WINDOW|OUTPUT HARD-CLAMPED) ---[ \t]*$/m;

/**
 * The no-etag half of refusing a full rewrite whose "source" is an
 * `abap_read` RESPONSE, not an object's source. The one completeness signal
 * available when the caller passes no `expect_etag` for
 * `assertNotPartialReadSource` (src/adt/write.ts) to check.
 *
 * A *proof*, not a heuristic: these fence lines are strings abapsmith itself
 * printed, and no ABAP source or ADT XML descriptor has a line consisting
 * solely of `--- SOURCE ---` (a line starting `---` isn't valid ABAP; ABAP
 * comments start with `*` or `"`). No legitimate write can trip it.
 *
 * Only catches the sloppy case — an agent pasting back the whole tool
 * response. An agent that cleanly extracts the fenced text (losing the
 * TRUNCATED warning with it) lands in the gap `assertNotPartialReadSource` documents instead.
 */
export function assertNotToolResponseEcho(source: string, object: string, type?: string): void {
  const m = TOOL_RESPONSE_FENCE_RE.exec(source);
  if (!m) return;
  throw new AbapError(
    "BAD_INPUT",
    `The source given for ${object} contains abapsmith's own response markers (the line ` +
      `"${(m[0] ?? "").trim()}"), so it is an abap_read RESPONSE, not an object's source. ` +
      "Writing it would replace the whole object with a tool transcript — and if a " +
      "`--- TRUNCATED ---` marker is in there, the transcript is not even the whole object.",
    { object, ...(type ? { type } : {}), marker: (m[0] ?? "").trim() },
    "Send only the text INSIDE the source fence, with no header, notes, hints or TRUNCATED " +
      "block — and check that block first: if the read was truncated, the text inside the fence " +
      "is not the whole object either. Use {edit:{old_string,new_string}} to change part of an " +
      "object without holding a complete copy of it.",
  );
}

/** SAP's `OO_SOURCE_BASED` message 38 — "The statement X is unexpected". */
const UNEXPECTED_STATEMENT_T100 = { id: "OO_SOURCE_BASED", no: 38 } as const;

/**
 * Dig a T100 key out of an `AbapError`'s details, whatever shape it arrived
 * in — src/adt/session.ts stores raw `"T100KEY-ID"`/`"T100KEY-NO"` while
 * src/tool-errors.ts normalises to `{id, no}`; both are matched so this
 * doesn't fire inconsistently. Recursive since envelope nesting varies by
 * layer; depth-capped because details are caller-influenced data.
 */
function findT100(v: unknown, depth = 0): { id?: string; no?: string } {
  const out: { id?: string; no?: string } = {};
  if (!v || typeof v !== "object" || depth > 4) return out;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") {
      const key = k.toUpperCase();
      if (key === "T100KEY-ID") out.id ??= val;
      else if (key === "T100KEY-NO") out.no ??= val;
      continue;
    }
    if (val && typeof val === "object") {
      if (k.toLowerCase() === "t100") {
        const t = val as { id?: unknown; no?: unknown };
        if (typeof t.id === "string") out.id ??= t.id;
        if (typeof t.no === "string") out.no ??= t.no;
      }
      const nested = findT100(val, depth + 1);
      out.id ??= nested.id;
      out.no ??= nested.no;
    }
  }
  return out;
}

/**
 * True when SAP rejected the PUT with the ABAP parser's "unexpected
 * statement" complaint. Keyed on the T100 id/no (stable, language-
 * independent); message text is a localised fallback. Number compared
 * numerically since it arrives as both `"38"` and `"038"` depending on layer.
 */
export function isUnexpectedStatementRejection(e: unknown): boolean {
  if (!isAbapError(e)) return false;
  const { id, no } = findT100(e.details);
  if (id === UNEXPECTED_STATEMENT_T100.id && no !== undefined && Number(no) === UNEXPECTED_STATEMENT_T100.no) {
    return true;
  }
  return /\bstatement\b.*\bis unexpected\b/i.test(e.message);
}

/**
 * Say which `source` shape THIS tool expects, for the write form actually
 * used. SAP's rejection names only the token its parser choked on — live
 * telemetry caught a caller burning both its guesses on the same
 * `OO_SOURCE_BASED 38` (bare method body, then the same body wrapped in
 * METHOD/ENDMETHOD), never told the contract it was failing.
 *
 * Lives here, not in `summarise()` (src/tool-errors.ts, facts-only) or the
 * adt layer (never sees the caller's write form), because only here is
 * `input.method`/`input.edit` still in scope.
 */
export function sourceShapeGuidance(input: Pick<WriteInputV2, "method" | "edit">, type?: string): string {
  if (input.method !== undefined) {
    return (
      `\`source\` under \`method\` must be exactly one complete "METHOD ${input.method} ... ENDMETHOD." ` +
      "block — the METHOD and ENDMETHOD lines included, the method body alone is not accepted and is " +
      "never auto-wrapped."
    );
  }
  if (input.edit !== undefined) {
    return (
      "`edit` spliced into the object's current source and the result did not parse, so `old_string`/" +
      "`new_string` most likely straddle a statement boundary. Re-read the object with abap_read and " +
      "widen the match to whole statements."
    );
  }
  const scaffold =
    type && type.toUpperCase().startsWith("CLAS")
      ? "a complete `CLASS ... IMPLEMENTATION. ... ENDCLASS.` source"
      : "the object's COMPLETE source including its scaffolding";
  return (
    `\`source\` on its own REPLACES THE WHOLE OBJECT, so it must be ${scaffold} — not a fragment and ` +
    "not a single method. To change one method use {object, type, method, source} with source as a " +
    "full METHOD ... ENDMETHOD. block; to change a few lines use {object, edit:{old_string, new_string}}."
  );
}

/**
 * Rethrow a write rejection, appending the expected-shape sentence when
 * SAP's complaint was a bare parser token. Keeps SAP's message verbatim; any
 * other error passes through untouched.
 */
export function rethrowWithSourceShapeHint(
  e: unknown,
  input: Pick<WriteInputV2, "method" | "edit">,
  type?: string,
): never {
  if (!isAbapError(e) || !isUnexpectedStatementRejection(e)) throw e;
  const guidance = sourceShapeGuidance(input, type);
  throw new AbapError(
    e.code,
    e.message,
    { ...e.details, expectedSourceShape: guidance },
    e.hint ? `${e.hint} ${guidance}` : guidance,
  );
}

/**
 * Rethrow a write rejection for one of the three XML-only DDIC types,
 * attaching a known-accepted skeleton — same keep-SAP's-message-verbatim
 * idiom as `rethrowWithSourceShapeHint`. `details.ddicSkeleton` already set
 * means our OWN pre-send `assertDdicDescriptorShape` guard raised this one
 * (see the call site above `writeObject`); re-appending would duplicate a
 * 1-2 KB skeleton the caller already has.
 */
export function rethrowWithDdicSkeletonHint(e: unknown, type?: string, name?: string): never {
  if (!isAbapError(e) || e.details.ddicSkeleton !== undefined) throw e;
  const skeleton = type && name ? ddicDescriptorSkeleton(type, name) : undefined;
  if (!skeleton) throw e;
  const guidance = `Known-accepted starting document for ${type}:\n${skeleton}`;
  throw new AbapError(
    e.code,
    e.message,
    { ...e.details, ddicSkeleton: skeleton },
    e.hint ? `${e.hint} ${guidance}` : guidance,
  );
}

/**
 * Produce the full replacement `source` string for `abapWrite`, from
 * whichever of the three write forms `input` used:
 *
 *  - `edit` — splice a unique (or every, with `replace_all`) match of
 *    `old_string` in the object's CURRENT source. Reads first (one GET), so
 *    this has a real TOCTOU window, closed by defaulting `expectEtag` to
 *    `canonicalEtag` of the bytes just read, unless the caller supplied
 *    their own (which wins). This default is specific to `edit` — it is
 *    NOT a general `abap_write` statement; the full-rewrite branch never
 *    defaults its etag.
 *  - `method` (+ `source`) — replace one method's implementation. `source`
 *    must be a complete `METHOD ... ENDMETHOD.` block (BAD_INPUT otherwise;
 *    no auto-wrap of a bare body). Same TOCTOU treatment as `edit`.
 *  - `source` alone — full rewrite, no extra read, no etag default. The
 *    destructive branch: the whole-object data-loss risk lives here, replacing the
 *    WHOLE object with whatever the caller holds. Guarded by
 *    `assertNotToolResponseEcho` below and, when an etag is supplied,
 *    `writeObject`'s `assertNotPartialReadSource` (src/adt/write.ts).
 *
 * The `edit`+`source`/`method`-requires-`source` checks below are the only
 * gate for these three forms — callers (the registered tool, tests,
 * `abapWrite` driven directly) all funnel through here.
 */
export async function resolveWriteSource(
  conn: AbapConnection,
  authorized: AuthorizedTarget<MutatingOperation, ResolvedTarget>,
  input: WriteInputV2,
): Promise<{
  source: string;
  expectEtag?: string;
  /** Server bytes the splice actually ran against — undefined for the plain-`source` form, which reads nothing. */
  current?: string;
  /** For `method=`: which `/objectstructure` version the member was resolved against (issue #147). */
  methodVersion?: "active" | "inactive";
}> {
  const t = authorized.target;

  if (input.edit) {
    if (input.source !== undefined) {
      throw new AbapError(
        "BAD_INPUT",
        "Pass either `edit` or `source`, not both — they are two different ways of saying what the new source is.",
        { object: t.name },
        "Drop `source` to splice with `edit`, or drop `edit` and pass the complete new source.",
      );
    }
    if (!t.exists) {
      throw new AbapError(
        "NOT_FOUND",
        `${t.spec.label} ${t.name} does not exist on ${conn.cfg.sid}, so there is no source to edit.`,
        { object: t.name, name: t.name, type: t.type, system: conn.cfg.sid },
        "Use {object, type, source} to create it — `edit` only applies to an object that already exists.",
      );
    }
    const current = await readCurrentSource(conn, t);
    if (current === undefined) {
      // Unreachable given `t.exists` above (readCurrentSource returns
      // undefined only for !t.exists, throwing otherwise) — kept as an
      // honest guard rather than a non-null assertion.
      throw new AbapError(
        "UNSUPPORTED",
        `${t.spec.label} ${t.name} exists but its current source could not be read.`,
        { object: t.name },
      );
    }
    let result: ReturnType<typeof applyEdit>;
    try {
      result = applyEdit(current, input.edit.old_string, input.edit.new_string, input.edit.replace_all);
    } catch (e) {
      if (e instanceof EditInputError) {
        throw new AbapError("BAD_INPUT", e.message, { object: t.name });
      }
      throw e;
    }
    if (!result.ok) {
      throw new AbapError(
        "BAD_INPUT",
        describeEditFailure(result),
        {
          object: t.name,
          editFailure: result.kind,
          ...(result.kind === "ambiguous" ? { matchLines: result.matchLines } : {}),
          ...(result.kind === "no-match" && result.firstLineOccurrences
            ? { firstLineOccurrences: result.firstLineOccurrences }
            : {}),
        },
        "Re-read the object with abap_read to see the CURRENT source, then retry with old_string " +
          "copied verbatim from it.",
      );
    }
    // `stripPartialEtag`: `edit` is the ONE form a truncated read cannot turn
    // into data loss — the splice runs against `current`, the
    // object's complete server source just read above, so a caller who only
    // saw a truncated read can pick a worse `old_string` but can't delete a
    // tail they never mentioned. Marker dropped so the etag keeps doing its
    // concurrency job instead of refusing the form callers should be
    // steered TOWARDS after a truncated read.
    return {
      source: result.result,
      expectEtag: input.expect_etag ? stripPartialEtag(input.expect_etag) : canonicalEtag(current),
      current,
    };
  }

  if (input.method !== undefined) {
    if (input.source === undefined) {
      throw new AbapError(
        "BAD_INPUT",
        `\`method\` requires \`source\`: the complete replacement for ${input.method}.`,
        { object: t.name, method: input.method },
        "Pass source as a full `METHOD ... ENDMETHOD.` block, or use `edit` for a smaller, partial change.",
      );
    }
    const trimmed = input.source.replace(/\r\n/g, "\n").trim();
    if (!METHOD_BLOCK_RE.test(trimmed)) {
      throw new AbapError(
        "BAD_INPUT",
        `source for method=${input.method} must be a complete "METHOD ... ENDMETHOD." block — abapsmith ` +
          "does not auto-wrap a bare body.",
        { object: t.name, method: input.method },
        "Include the METHOD and ENDMETHOD lines themselves, or use `edit` to splice a fragment instead.",
      );
    }
    if (!t.exists) {
      throw new AbapError(
        "NOT_FOUND",
        `${t.spec.label} ${t.name} does not exist on ${conn.cfg.sid}, so there is no method ${input.method} to replace.`,
        { object: t.name, name: t.name, type: t.type, system: conn.cfg.sid, method: input.method },
        "Use {object, type, source} to create the object first.",
      );
    }
    const current = await readCurrentSource(conn, t);
    if (current === undefined) {
      throw new AbapError(
        "UNSUPPORTED",
        `${t.spec.label} ${t.name} exists but its current source could not be read.`,
        { object: t.name },
      );
    }
    // Issue #147: resolve against the inactive version when one exists (the
    // state right after a CHECK_FAILED full write), falling back to active.
    // Inherited members are NOT walked here: a method= write replaces the
    // block in THIS class, and a superclass's block is not that.
    const ms = await readMethod(conn, resolvedObjectAdapter(conn, t), current, input.method, {
      inherited: false,
    });
    if (!ms.implementationRange) {
      throw new AbapError(
        "NOT_FOUND",
        `${t.spec.label} ${t.name} method ${input.method} has no implementation block to replace ` +
          "(an interface method or an abstract method has none).",
        { object: t.name, method: input.method },
      );
    }
    const spliced = spliceMethodBlock({
      current,
      replacement: trimmed,
      memberName: ms.member.name,
      requested: input.method,
      ...(ms.implementationRange ? { range: ms.implementationRange } : {}),
      object: t.name,
    });
    return {
      source: spliced,
      expectEtag: input.expect_etag ?? canonicalEtag(current),
      current,
      methodVersion: ms.version,
    };
  }

  if (input.source !== undefined) {
    // The only destructive branch: replaces the ENTIRE object. A caller who
    // meant {method, source} but had `method` stripped in transit lands here
    // — see `assertNotOrphanMethodBlock`.
    assertNotOrphanMethodBlock(input.source, t.name, t.type);
    assertNotToolResponseEcho(input.source, t.name, t.type);
    // `partial:` marker passed through UNSTRIPPED (unlike `edit` above) —
    // `writeObject` (src/adt/write.ts) refuses it there where `current` is
    // already in hand.
    return { source: input.source, ...(input.expect_etag ? { expectEtag: input.expect_etag } : {}) };
  }

  throw new AbapError(
    "BAD_INPUT",
    "`source` is required for mode=write.",
    { object: input.object },
    "Pass the complete new source, {edit:{old_string,new_string}} to splice a unique match, or " +
      "{method,source} to replace one method's implementation. Use mode=delete to remove the object.",
  );
}
