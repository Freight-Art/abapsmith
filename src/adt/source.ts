/**
 * Source reads — covers both source-based objects and method-level reads
 * ("read(CLAS ZCL_FOO, method=CALCULATE) → 30 lines, not 1,200").
 */
import type { ClassComponent } from "abap-adt-api";
import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import type { ResolvedObject } from "./resolve.js";
import { type ErrorContext, translateAdtError } from "./session.js";
import { CLASS_INCLUDES, type ClassInclude, classIncludeUri } from "./types.js";
import {
  blankSourceIsAmbiguous,
  objectAcceptFor,
  probeObjectPresence,
  type ObjectPresence,
} from "./write-verify.js";

export interface SourceResult {
  source: string;
  /** Server-supplied ETag header, if any. Distinct from our content hash. */
  serverEtag?: string;
  sourceUri: string;
  /** Which class include was actually read, when one was asked for. */
  include?: ClassInclude;
}

/**
 * A resolved object plus, optionally, the class include the caller asked for
 * — a structural widening over `ResolvedObject` (resolve.ts), which has no
 * `include` field of its own.
 */
export type SourceTarget = ResolvedObject & { include?: ClassInclude };

/**
 * Failure classification. Previously everything collapsed to `NOT_FOUND`
 * with a "check the name" hint, sending 401s, dead sessions and open circuit
 * breakers on a wild goose chase for a typo — see
 * the git history. Delegates to `translateAdtError`
 * (same pattern as `write.ts:240-256`), then refines: 401/403 → `AUTH_FAILED`;
 * a response-less transport timeout → `details.timeout`.
 */
export function classifySourceFailure(e: unknown, ctx: ErrorContext): AbapError {
  const err = translateAdtError(e, ctx);
  if (err.code !== "ADT_ERROR") return err;

  const status = typeof err.details.status === "number" ? err.details.status : undefined;

  if (status === 401) {
    return new AbapError(
      "AUTH_FAILED",
      `Authentication failed (HTTP 401) while reading ${ctx.type ?? "object"} ${ctx.name ?? ctx.uri}. ` +
        `The server rejected the credentials — the object name was never checked.`,
      { ...err.details, status: 401 },
      "Fix ABAP_USER / ABAP_PASSWORD. Credentials are NOT retried automatically: " +
        "repeated logon attempts lock the SAP user. This is not a naming problem.",
    );
  }
  if (status === 403) {
    return new AbapError(
      "AUTH_FAILED",
      `Not authorised (HTTP 403) to read ${ctx.type ?? "object"} ${ctx.name ?? ctx.uri}. ` +
        `The logon succeeded; the user lacks the authorisation for this object.`,
      { ...err.details, status: 403 },
      "The user is authenticated but not authorised (typically S_DEVELOP). The name " +
        "is not in question — do not retry with a different name.",
    );
  }
  if (status === undefined && isTimeoutError(e)) {
    return new AbapError(
      "ADT_ERROR",
      `No response from the ABAP system while reading ${ctx.type ?? "object"} ` +
        `${ctx.name ?? ctx.uri}: the request timed out (${err.message}).`,
      { ...err.details, timeout: true },
      "The system did not answer at all, so nothing is known about the object. " +
        "Retry once; if it repeats the system is unreachable or overloaded.",
    );
  }
  return err;
}

/** Transport-level timeout: axios/undici shapes, plus an explicit abort. */
function isTimeoutError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const any = e as { code?: unknown; name?: unknown; message?: unknown };
  const code = typeof any.code === "string" ? any.code.toUpperCase() : "";
  if (["ECONNABORTED", "ETIMEDOUT", "ESOCKETTIMEDOUT", "UND_ERR_HEADERS_TIMEOUT"].includes(code)) {
    return true;
  }
  if (any.name === "AbortError" || any.name === "TimeoutError") return true;
  return /\btime(d)?\s*-?\s*out\b|\btimeout\b/i.test(String(any.message ?? ""));
}

/**
 * Confirms an object's existence at its own URI when the source endpoint's
 * response can't be trusted on its own — either a 500 with a genuine ADT
 * exception type, or (for a `blankSourceOnAbsence` type) a 200 with an empty
 * body. A source-endpoint 500 with a genuine ADT exception type is FUGR/FF's
 * known answer for an absent function module (see capabilities.ts's FUGR/FF
 * entry: "/source/main of an already-deleted FM 500s instead of 404ing") —
 * but the identical envelope is also what a genuinely broken server sends for
 * an object that DOES exist (`test/fixtures/live-captured/040-terminate-debuggee.xml`
 * is a captured 500 from an unrelated debugger failure whose message is also
 * exactly "An exception was raised"). The envelope alone can't tell those
 * apart, so absence is confirmed the same way `resolveWriteTarget`
 * (write.ts) does: a second GET against the bare object URI — delegated to
 * `probeObjectPresence` (write-verify.ts) so a dead session there gets the
 * same one-reconnect-and-retry as every other read-back, and so the
 * caller sees `no-answer` as distinct from a confirmed presence rather than
 * both collapsing to "not absent". One extra GET, fired only on a 500 (or a
 * blank body for a `blankSourceOnAbsence` type) — the appliance's dialog
 * work processes are finite.
 */
async function objectUriPresence(conn: AbapConnection, obj: SourceTarget): Promise<ObjectPresence> {
  return (await probeObjectPresence(conn, obj.uri, objectAcceptFor(obj.type))).presence;
}

/** A string that is empty after trimming; a non-string body is never blank. */
function isBlankBody(body: unknown): boolean {
  return typeof body === "string" && body.trim() === "";
}

/**
 * Which URI actually gets fetched. An include other than `main` is never
 * answered from the main source — the call fails instead.
 */
export function sourceUriFor(obj: SourceTarget, include?: ClassInclude): string {
  const inc = include ?? obj.include;
  if (!inc || inc === "main") return obj.sourceUri ?? `${obj.uri}/source/main`;
  if (obj.type !== "CLAS/OC" && obj.kind !== "CLAS") {
    throw new AbapError(
      "UNSUPPORTED",
      `${obj.type} ${obj.name} has no "${inc}" include — class includes ` +
        `(${CLASS_INCLUDES.join(", ")}) exist only for classes.`,
      { type: obj.type, name: obj.name, requested: inc, uri: obj.uri },
      "Read this object without an include. It was NOT silently answered with the main source.",
    );
  }
  return classIncludeUri(obj.uri, inc);
}

/**
 * Read one object's source, optionally a specific class include
 * (`definitions`, `implementations`, `macros`, `testclasses`, `main`).
 * ABAP Unit reports failures inside `testclasses`, so it must be readable
 * on its own.
 */
export async function readSource(
  conn: AbapConnection,
  obj: SourceTarget,
  include?: ClassInclude,
  // G-08: explicit version selection; `undefined` = ADT's current default.
  // `abap_read`'s zod schema restricts callers to "active" | "inactive".
  version?: "active" | "inactive",
): Promise<SourceResult> {
  const inc = include ?? obj.include;
  const sourceUri = sourceUriFor(obj, inc);
  const ctx: ErrorContext = {
    operation: inc && inc !== "main" ? `read include ${inc}` : "read source",
    uri: sourceUri,
    name: obj.name,
    type: obj.type,
  };
  try {
    const resp = await conn.get(sourceUri, {
      headers: { Accept: "text/plain" },
      ...(version ? { qs: { version } } : {}),
    });
    if (isBlankBody(resp.body) && blankSourceIsAmbiguous(obj.type)) {
      const presence = await objectUriPresence(conn, obj);
      if (presence === "absent") {
        throw new AbapError(
          "NOT_FOUND",
          `${obj.type} ${obj.name} does not exist: its source endpoint answered HTTP 200 with ` +
            `an empty body (this type's known response for an absent object there), and a ` +
            `direct GET of ${obj.uri} confirmed the absence with a not-found response.`,
          { type: obj.type, name: obj.name, uri: sourceUri, absenceConfirmedVia: obj.uri },
          "Check the name with abap_search, or create it first with abap_write. This was " +
            "established by a second, independent request against the object URI, not " +
            "inferred from the empty body.",
        );
      }
      // "present" or "no-answer": a created-but-not-yet-filled skeleton is
      // not missing — return the empty source unchanged.
    }
    return {
      source: resp.body,
      serverEtag: typeof resp.headers.etag === "string" ? resp.headers.etag : undefined,
      sourceUri,
      ...(inc ? { include: inc } : {}),
    };
  } catch (e) {
    const err = classifySourceFailure(e, ctx);
    // Confirm before relabelling a 500. Requiring a server-sent `<type
    // id=...>` (not just status 500) keeps out AdtErrorException's other 500
    // shape — the one it fabricates for a non-HTTP failure, `err: 500` with
    // no `type` at all — which a real envelope always carries.
    const answered500WithType =
      err.code === "ADT_ERROR" &&
      err.details.status === 500 &&
      typeof err.details.adtExceptionType === "string" &&
      Boolean(err.details.adtExceptionType);
    if (answered500WithType) {
      const presence = await objectUriPresence(conn, obj);
      if (presence === "absent") {
        throw new AbapError(
          "NOT_FOUND",
          `${obj.type} ${obj.name} does not exist: its source endpoint answered HTTP 500 ` +
            `(the response some releases give for an absent object there), and a direct GET ` +
            `of ${obj.uri} confirmed the absence with a 404.`,
          { ...err.details, absenceConfirmedVia: obj.uri },
          "Check the name with abap_search, or create it first with abap_write. This was " +
            "established by a second, independent request against the object URI, not " +
            "inferred from the 500 alone.",
        );
      }
      // "the server said it is there" and "the server said nothing" are
      // different facts — record which, rather than letting the bare 500 imply either.
      throw new AbapError(err.code, err.message, { ...err.details, objectUriProbe: presence }, err.hint);
    }
    // A 404 on a sub-include means *the include* is absent (a class with no
    // test class has no testclasses include) — not that the class is misnamed.
    if (err.code === "NOT_FOUND" && inc && inc !== "main") {
      throw new AbapError(
        "NOT_FOUND",
        `${obj.type} ${obj.name} has no "${inc}" include at ${sourceUri}.`,
        { ...err.details, requested: inc },
        `A class with no test class has no testclasses include. Read ${obj.name} ` +
          "itself to confirm the class exists before doubting the name.",
      );
    }
    throw err;
  }
}

/**
 * A line range inside ONE source document, in ADT's coordinate space. Crosses
 * a module boundary (`/objectstructure` → `readMethod` → `abap_read`'s
 * renderer AND `abap_write`'s method splice); a wrong guess here produces
 * syntactically impossible ABAP and ships it to the server. Hence, stated not
 * assumed:
 *
 *  - `startLine`/`endLine` are 1-based, inclusive at both ends.
 *  - For `implementationBlock`, `startLine`/`endLine` are the `METHOD ...`
 *    and `ENDMETHOD.` lines THEMSELVES — not body-only.
 *  - `document` is the href path the numbers index into. ADT may report a
 *    range against a different object than the one you're holding — line 12
 *    of one document is unrelated to line 12 of another. `undefined` means
 *    the href was fragment-only (`#start=…`).
 *
 * Inclusive-of-keyword-lines confirmed against a real A4H response — see
 * the git history.
 */
export interface SourceRange {
  startLine: number;
  endLine: number;
  /** Href path before the `#`; undefined if fragment-only. Compare before reusing against a separately-fetched text. */
  document?: string;
}

export interface ClassMember {
  name: string;
  type: string;
  visibility?: string;
  level?: string;
  redefinition?: boolean;
  definition?: SourceRange;
  implementation?: SourceRange;
}

/**
 * `./source/main#start=20,2;end=67,11` →
 * `{startLine:20, endLine:67, document:"./source/main"}`.
 * The pre-`#` part matters — see `SourceRange.document`.
 */
export function parseFragmentRange(href: string | undefined): SourceRange | undefined {
  if (!href) return undefined;
  const m = /#start=(\d+)(?:,\d+)?(?:;end=(\d+)(?:,\d+)?)?/.exec(href);
  if (!m) return undefined;
  const startLine = Number(m[1]);
  const endLine = m[2] ? Number(m[2]) : startLine;
  const document = href.slice(0, href.indexOf("#"));
  return { startLine, endLine, ...(document ? { document } : {}) };
}

// ---------------------------------------------------------------------------
// ABAP lexical helpers: `abapCodeOf` is the one place that decides what's
// code vs. comment/string, so block scanning, keyword counting and the
// write-path splice all agree — none is fooled by `ENDMETHOD` inside a
// literal or comment.
// ---------------------------------------------------------------------------

/**
 * ABAP-visible code of one line: a full-line `*` comment becomes empty, a
 * trailing `"` comment is cut, and string-literal contents are blanked to
 * spaces (columns preserved) so keywords/periods inside them aren't mistaken
 * for code. Doubled quotes (`'it''s'`) are the ABAP escape, not a terminator.
 */
export function abapCodeOf(line: string): string {
  if (/^\*/.test(line)) return "";
  let out = "";
  let quote: "'" | "`" | undefined;
  let i = 0;
  while (i < line.length) {
    const ch = line[i] as string;
    if (quote !== undefined) {
      if (ch === quote) {
        if (line[i + 1] === quote) {
          out += "  ";
          i += 2;
          continue;
        }
        quote = undefined;
      }
      out += " ";
      i += 1;
      continue;
    }
    if (ch === "'" || ch === "`") {
      quote = ch;
      out += " ";
      i += 1;
      continue;
    }
    // Only outside a literal is `"` a comment; everything after it is prose.
    if (ch === '"') return out;
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Opening line of a method implementation. `METHOD\s` (not `\b`) excludes
 * `METHODS`, `CLASS-METHODS`, `METHOD-POOL`. No trailing period required —
 * an AMDP method opens with `METHOD get_data BY DATABASE PROCEDURE …` and
 * closes the statement several lines later.
 */
const METHOD_OPEN_RE = /^\s*method\s+([^\s.]+)/i;
const ENDMETHOD_RE = /^\s*endmethod\s*\./i;

/** One `METHOD … ENDMETHOD.` block located in a concrete source text. */
export interface MethodBlock {
  /** Name as WRITTEN in the source, e.g. `zif_foo~bar` or `bar`. */
  name: string;
  /** 1-based line of the `METHOD` statement. Inclusive — see `SourceRange`. */
  startLine: number;
  /** 1-based line of the `ENDMETHOD.` statement. Inclusive. */
  endLine: number;
}

export interface MethodBlockScan {
  blocks: MethodBlock[];
  /**
   * Set when the text does not tokenise into well-formed blocks (an
   * unterminated block, an `ENDMETHOD.` closing nothing, a nested `METHOD`).
   * A caller about to REWRITE this text must refuse rather than guess.
   */
  malformed?: string;
}

/**
 * Locate every `METHOD … ENDMETHOD.` block in `source`, comment/string-aware
 * — the local, checkable truth, as opposed to ADT's remote line numbers.
 */
export function scanMethodBlocks(source: string): MethodBlockScan {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: MethodBlock[] = [];
  let open: { name: string; startLine: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const code = abapCodeOf(lines[i] ?? "");
    const opened = METHOD_OPEN_RE.exec(code);
    if (opened) {
      if (open) {
        return {
          blocks,
          malformed:
            `line ${i + 1} opens METHOD ${opened[1]} while METHOD ${open.name} ` +
            `(line ${open.startLine}) is still open — methods cannot nest`,
        };
      }
      open = { name: opened[1] ?? "", startLine: i + 1 };
      continue;
    }
    if (ENDMETHOD_RE.test(code)) {
      if (!open) {
        return { blocks, malformed: `ENDMETHOD. at line ${i + 1} closes no METHOD` };
      }
      blocks.push({ name: open.name, startLine: open.startLine, endLine: i + 1 });
      open = undefined;
    }
  }
  if (open) {
    return {
      blocks,
      malformed: `METHOD ${open.name} (line ${open.startLine}) is never closed by ENDMETHOD.`,
    };
  }
  return { blocks };
}

/**
 * How many METHOD-opening and ENDMETHOD lines a text contains, counted with
 * the same comment/literal rules as `scanMethodBlocks` but tolerating
 * malformed input (it is used to COMPARE two texts, including a broken one).
 */
export function countMethodKeywordLines(source: string): { method: number; endmethod: number } {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let method = 0;
  let endmethod = 0;
  for (const line of lines) {
    const code = abapCodeOf(line);
    if (METHOD_OPEN_RE.test(code)) method += 1;
    else if (ENDMETHOD_RE.test(code)) endmethod += 1;
  }
  return { method, endmethod };
}

/**
 * The match rule `findMember` uses, applied to names written in source: equal
 * outright, or equal after dropping an interface prefix on either side
 * (`ZIF_FOO~BAR` ↔ `BAR`, which is what an ALIASES declaration produces).
 */
export function methodNamesMatch(a: string, b: string): boolean {
  const A = a.toUpperCase();
  const B = b.toUpperCase();
  return A === B || A.split("~").pop() === B.split("~").pop();
}

const REL_DEF_BLOCK = "definitionBlock";
const REL_IMPL_BLOCK = "implementationBlock";

function linkRange(c: ClassComponent, relSuffix: string): SourceRange | undefined {
  const link = (c.links ?? []).find((l) => l.rel?.endsWith(relSuffix));
  return parseFragmentRange(link?.href);
}

/** Flatten the component tree that `/objectstructure` returns. */
export function flattenComponents(root: ClassComponent): ClassMember[] {
  const out: ClassMember[] = [];
  const walk = (c: ClassComponent) => {
    for (const child of c.components ?? []) {
      out.push({
        name: child["adtcore:name"],
        type: child["adtcore:type"],
        visibility: child.visibility,
        level: child.level,
        redefinition: (child as { redefinition?: boolean }).redefinition,
        definition: linkRange(child, REL_DEF_BLOCK),
        implementation: linkRange(child, REL_IMPL_BLOCK),
      });
      walk(child);
    }
  };
  walk(root);
  return out;
}

export async function classMembers(
  conn: AbapConnection,
  obj: ResolvedObject,
): Promise<ClassMember[]> {
  // `/objectstructure` failed raw — an abap-adt-api exception (or a whole
  // ADT XML blob) escaped to the caller. Same classification as readSource.
  let root: ClassComponent;
  try {
    root = await conn.adt.classComponents(obj.uri);
  } catch (e) {
    throw classifySourceFailure(e, {
      operation: "read components",
      uri: obj.uri,
      name: obj.name,
      type: obj.type,
    });
  }
  return flattenComponents(root);
}

/** Case- and interface-prefix-insensitive member match. */
export function findMember(members: ClassMember[], wanted: string): ClassMember | undefined {
  const w = wanted.toUpperCase();
  return (
    members.find((m) => m.name.toUpperCase() === w) ??
    members.find((m) => m.name.toUpperCase().split("~").pop() === w)
  );
}

export interface MethodSource {
  member: ClassMember;
  declaration?: string;
  implementation?: string;
  /**
   * ADT-reported range for the implementation block (see `SourceRange` for
   * coordinate semantics). Safe to render; NOT safe to slice a separately
   * fetched text with unverified — `spliceMethodBlock` in src/tools/write.ts
   * re-derives the block from the bytes it rewrites and uses this only as a
   * cross-check.
   */
  implementationRange?: SourceRange;
}

/** How many component names a "no such method" error lists. Always disclosed. */
const AVAILABLE_MEMBERS_MAX = 12;

/** Plain Levenshtein edit distance, no dependencies. */
function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j] ?? 0;
      prev[j] = a[i - 1] === b[j - 1] ? diag : 1 + Math.min(diag, tmp, prev[j - 1] ?? 0);
      diag = tmp;
    }
  }
  return prev[b.length] ?? 0;
}

/**
 * Return only the declaration and body of one method.
 * Costs one extra round trip (`/objectstructure`) and saves ~20x on payload.
 */
export async function readMethod(
  conn: AbapConnection,
  obj: ResolvedObject,
  source: string,
  method: string,
): Promise<MethodSource> {
  const members = await classMembers(conn, obj);
  const methods = members.filter((m) => m.type === "CLAS/OM" || m.type === "INTF/OM");
  const member = findMember(methods.length ? methods : members, method);
  if (!member) {
    // The cap MUST be disclosed — a silently-cut list makes an agent
    // conclude a real method doesn't exist. Ranked by edit distance so a
    // typo's real target surfaces first.
    const pool = methods.length ? methods : members;
    const wantedUpper = method.toUpperCase();
    const ranked = [...pool].sort(
      (a, b) =>
        levenshtein(a.name.toUpperCase(), wantedUpper) -
        levenshtein(b.name.toUpperCase(), wantedUpper),
    );
    const shown = ranked.slice(0, AVAILABLE_MEMBERS_MAX);
    const dropped = pool.length - shown.length;
    const disclosure =
      dropped > 0
        ? ` [TRUNCATED: listing ${shown.length} of ${pool.length} components — ` +
          `${dropped} not shown, retrieve with: abap_read({outline:true})]`
        : "";
    throw new AbapError(
      "NOT_FOUND",
      `${obj.type} ${obj.name} has no method ${method}.${disclosure}`,
      {
        method,
        availableTotal: pool.length,
        available: shown.map((m) => m.name),
        ...(dropped > 0 ? { availableTruncated: dropped } : {}),
      },
      dropped > 0
        ? `The list above is INCOMPLETE (${shown.length} of ${pool.length}). Read the object ` +
          "with outline=true for every component before concluding the method is missing."
        : "Read the object without `method` to see its full component list.",
    );
  }
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const cut = (r?: SourceRange) =>
    r ? lines.slice(Math.max(0, r.startLine - 1), r.endLine).join("\n") : undefined;

  return {
    member,
    declaration: cut(member.definition),
    implementation: cut(member.implementation),
    implementationRange: member.implementation,
  };
}

/** One-line-per-member outline. Cheap orientation before a targeted read. */
export function renderOutline(members: ClassMember[]): string {
  const rows = members
    .filter((m) => m.type === "CLAS/OM" || m.type === "INTF/OM" || m.type === "CLAS/OA")
    .map((m) => {
      const loc = m.implementation
        ? `${m.implementation.startLine}-${m.implementation.endLine}`
        : m.definition
          ? `${m.definition.startLine}-${m.definition.endLine}`
          : "";
      const flags = [m.visibility, m.level, m.redefinition ? "redefinition" : undefined]
        .filter(Boolean)
        .join(" ");
      return `  ${m.name}  [${flags}]${loc ? `  lines ${loc}` : ""}`;
    });
  return rows.join("\n");
}
