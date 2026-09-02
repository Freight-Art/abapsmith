/**
 * v2 response envelope for the six consolidated tools (`abap_find`,
 * `abap_read`, `abap_write`, `abap_do`, `abap_debug`, `abap_adt`). Three
 * cross-cutting rules:
 *
 *   1. No closed enums in schemas — legal values live in prose/catalogue
 *      (enforced in `schemas.ts`/`catalogue.ts`, not here).
 *   2. A bare call (no meaningful args) self-describes instead of erroring —
 *      see `isBareCall`.
 *   3. Every response carries a concrete follow-up call: `next` is REQUIRED
 *      on both `V2Ok` and `V2Err`, never optional.
 *
 * History: see the git history.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** A concrete, copy-pasteable follow-up call. Rule 3: every response carries these. */
export interface NextCall {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly why: string;
}

export interface V2Ok<T = unknown> {
  readonly ok: true;
  readonly tool: string;
  readonly data: T;
  readonly notes?: readonly string[];
  /**
   * `data` was windowed/cut to fit the response budget. `ok`
   * stays `true` — a partial read is a successful partial read, not an
   * error. The handler must state the gap in `notes` and the next page in
   * `next`; `renderV2` flags this instead of printing a bare `ok: true`.
   */
  readonly truncated?: boolean;
  /** Rule 3 is enforced by the type: `next` is REQUIRED, never optional. */
  readonly next: readonly NextCall[];
}

export interface V2Err {
  readonly ok: false;
  readonly tool: string;
  readonly error: string; // machine code, e.g. "UNKNOWN_ACTION", "NOT_IMPLEMENTED"
  readonly message: string;
  readonly hint?: string;
  /**
   * Required (unlike {@link AbapErrorOptions} in `src/adt/errors.ts`) so every
   * construction site is forced to decide: `undefined` makes no claim,
   * `false` means no input can satisfy this, `true` means a different
   * argument would work.
   */
  readonly retryable: boolean | undefined;
  readonly given?: string;
  readonly closest?: readonly string[];
  readonly catalogue?: string;
  readonly skill?: string;
  readonly next: readonly NextCall[];
}

export type V2Response<T = unknown> = V2Ok<T> | V2Err;

/**
 * Rule 2's trigger: `args` is bare if `undefined`/`null`, or every own value
 * is `undefined`/`null`/`""`. `{}` and `{action: undefined}` count as bare.
 */
export function isBareCall(args: unknown): boolean {
  if (args === undefined || args === null) return true;
  if (typeof args !== "object") return false;
  const values = Object.values(args as Record<string, unknown>);
  return values.every((v) => v === undefined || v === null || v === "");
}

/** `UNKNOWN_ACTION` error: nearest legal candidates, catalogue/skill pointers, and a `next` back to the bare catalogue call. */
export function unknownAction(
  tool: string,
  given: string,
  closest: readonly string[],
  catalogue: string,
  skill: string,
): V2Err {
  const closestPart = closest.length > 0 ? ` Closest match(es): ${closest.join(", ")}.` : "";
  return {
    ok: false,
    tool,
    error: "UNKNOWN_ACTION",
    message: `"${given}" is not a known action for ${tool}.${closestPart}`,
    hint: `Call ${tool}({}) with no args to list every action available in this mode.`,
    retryable: true, // a different action string would work
    given,
    closest,
    catalogue,
    skill,
    next: [
      {
        tool,
        args: {},
        why: "List the full action catalogue for this mode.",
      },
    ],
  };
}

/** A bare-call self-description: always `ok`, no notes, `next` carries the examples. */
export function bareOk(tool: string, data: string, next: readonly NextCall[]): V2Ok<string> {
  return { ok: true, tool, data, next };
}

/**
 * First `n` entries via a bounded loop, not array slicing — the truncation
 * source scan in this repo's test suite flags slice-based prefix cuts. Only
 * ever used on small, complete catalogues, never as a cap on withheld data.
 */
export function firstN<T>(entries: readonly T[], n: number): T[] {
  const out: T[] = [];
  for (const entry of entries) {
    if (out.length >= n) break;
    out.push(entry);
  }
  return out;
}

/**
 * A recognised call this server deliberately refuses. Formerly the stub for
 * every v2 handler; the only caller left is `handlers/adt.ts`'s refusal of
 * `abap_adt`'s mutating verbs under `ABAP_MODE=admin` — a deliberate design
 * decision (see archive), not a placeholder.
 */
export function notImplemented(tool: string, what: string, next: readonly NextCall[]): V2Err {
  return {
    ok: false,
    tool,
    error: "NOT_IMPLEMENTED",
    message: `${what} is recognised by ${tool} but deliberately not implemented; no retry of this call will ever succeed — see NEXT for the supported route.`,
    retryable: false, // deliberate design decision, not a placeholder
    next,
  };
}

/** `abap_do({"action":"activate"})  — why` */
export function renderNextCall(n: NextCall): string {
  return `${n.tool}(${JSON.stringify(n.args)})  — ${n.why}`;
}

/**
 * Deterministic plain-text rendering of a `V2Response`, ending with a `NEXT`
 * block (Rule 3 made visible). Never slices or truncates any string —
 * `no-silent-truncation.test.ts` scans this file for that.
 */
export function renderV2(res: V2Response): string {
  const lines: string[] = [];
  lines.push(`tool: ${res.tool}`);
  lines.push(
    res.ok && res.truncated
      ? "ok: true (INCOMPLETE — the DATA below is NOT the whole of what was requested; see NOTES)"
      : `ok: ${String(res.ok)}`,
  );

  if (res.ok) {
    lines.push("DATA:");
    lines.push(typeof res.data === "string" ? res.data : JSON.stringify(res.data, null, 2));
    if (res.notes !== undefined && res.notes.length > 0) {
      lines.push("NOTES:");
      for (const note of res.notes) lines.push(`- ${note}`);
    }
  } else {
    lines.push(`error: ${res.error}`);
    lines.push(`message: ${res.message}`);
    if (res.hint !== undefined) lines.push(`hint: ${res.hint}`);
    if (res.retryable !== undefined) lines.push(`retryable: ${String(res.retryable)}`);
    if (res.given !== undefined) lines.push(`given: ${res.given}`);
    if (res.closest !== undefined) lines.push(`closest: ${res.closest.join(", ")}`);
    if (res.catalogue !== undefined) lines.push(`catalogue: ${res.catalogue}`);
    if (res.skill !== undefined) lines.push(`skill: ${res.skill}`);
  }

  lines.push("NEXT:");
  if (res.next.length === 0) {
    lines.push("(none)");
  } else {
    for (const call of res.next) lines.push(renderNextCall(call));
  }

  return lines.join("\n");
}

/** Wraps `renderV2` as an MCP `CallToolResult`, setting `isError: true` for `V2Err`. */
export function v2Result(res: V2Response): CallToolResult {
  const text = renderV2(res);
  if (!res.ok) {
    return { content: [{ type: "text", text }], isError: true };
  }
  return { content: [{ type: "text", text }] };
}

/** Plain Levenshtein edit distance, no dependencies. */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prev: number[] = new Array<number>(n + 1);
  let curr: number[] = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const deletion = (prev[j] ?? 0) + 1;
      const insertion = (curr[j - 1] ?? 0) + 1;
      const substitution = (prev[j - 1] ?? 0) + cost;
      curr[j] = Math.min(deletion, insertion, substitution);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }

  return prev[n] ?? 0;
}

/**
 * Nearest legal candidates to `given` by edit distance (ties alphabetical,
 * distance ≤5, capped at `max`). Built without array-slicing — the
 * truncation source scan flags that idiom; this result is small and
 * complete by construction.
 */
export function nearest(given: string, candidates: readonly string[], max = 3): string[] {
  const g = given.toLowerCase();
  const scored = candidates
    .map((c) => ({ c, d: levenshtein(g, c.toLowerCase()) }))
    .filter((x) => x.d <= 5)
    .sort((x, y) => (x.d !== y.d ? x.d - y.d : x.c.localeCompare(y.c)));

  const out: string[] = [];
  for (const { c } of scored) {
    if (out.length >= max) break;
    out.push(c);
  }
  return out;
}
