/** Zero-behaviour helpers shared by `abap_do`'s group modules: reshape v2 calls into v1 schema shapes and unwrap v1 results. */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodType } from "zod";
import { AbapError } from "../../../../adt/errors.js";
import { nearest, type NextCall, type V2Ok } from "../../envelope.js";

/** Merges v2 `object` into `args[key]` (v1's field name for the primary target); throws BAD_INPUT on disagreement instead of picking a winner. */
export function withObject(
  args: Readonly<Record<string, unknown>>,
  key: string,
  object: string | undefined,
): Record<string, unknown> {
  if (object === undefined) return { ...args };
  const existing = args[key];
  if (existing !== undefined && String(existing).trim() !== object.trim()) {
    throw new AbapError(
      "BAD_INPUT",
      `object ("${object}") and args.${key} ("${String(existing)}") disagree — pass the target once, not both.`,
      { object, [key]: existing },
    );
  }
  return { ...args, [key]: object };
}

/** Force-sets `key` to the value the action implies (e.g. "activate" → v1 `mode: "activate"`); throws BAD_INPUT if the caller's `args` already disagreed. */
export function withField(
  args: Readonly<Record<string, unknown>>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const existing = args[key];
  if (existing !== undefined && existing !== value) {
    throw new AbapError(
      "BAD_INPUT",
      `args.${key} ("${String(existing)}") conflicts with the value action "${String(value)}" implies — omit args.${key}.`,
      { given: existing, implied: value },
    );
  }
  return { ...args, [key]: value };
}

/** Same conflict rule as {@link withObject}, for top-level scalars (`ctx.confirm`, `ctx.dry_run`) the context carries separately from `args`. */
export function withValue(
  args: Readonly<Record<string, unknown>>,
  key: string,
  value: string | boolean | undefined,
): Record<string, unknown> {
  if (value === undefined) return { ...args };
  const existing = args[key];
  if (existing !== undefined && existing !== value) {
    throw new AbapError(
      "BAD_INPUT",
      `${key} ("${String(value)}") and args.${key} ("${String(existing)}") disagree — pass it once, not both.`,
      { [key]: value, arg: existing },
    );
  }
  return { ...args, [key]: value };
}

/** Field names the v1 schema accepts, or `undefined` if it isn't an object schema (skip the unknown-key check, let zod decide). */
function acceptedKeysOf(schema: unknown): string[] | undefined {
  const shape: unknown = (schema as { shape?: unknown }).shape;
  if (shape === null || typeof shape !== "object") return undefined;
  return Object.keys(shape as Record<string, unknown>);
}

/**
 * Validates `input` against the v1 zod schema for this action (imported, never redefined).
 * Unknown keys are rejected here rather than left to zod, which would silently strip them —
 * zod 4 drops unrecognised keys on a plain `z.object`, so e.g. a mistyped `corr` (for
 * `corr_nr`) would activate UNTRANSPORTED and still report `ok: true`.
 * See the git history for the full incident.
 */
export function parseV1<T>(schema: ZodType<T>, input: Record<string, unknown>): T {
  const accepted = acceptedKeysOf(schema);
  if (accepted !== undefined) {
    const unknownKeys = Object.keys(input).filter((k) => !accepted.includes(k));
    if (unknownKeys.length > 0) {
      const detail = unknownKeys
        .map((k) => {
          const near = nearest(k, accepted, 2);
          return near.length > 0 ? `"${k}" (did you mean ${near.map((n) => `"${n}"`).join(" or ")}?)` : `"${k}"`;
        })
        .join(", ");
      throw new AbapError(
        "BAD_INPUT",
        `Unknown args ${unknownKeys.length === 1 ? "key" : "keys"}: ${detail}. ` +
          `Accepted for this action: ${accepted.join(", ")}.`,
        { unknown: unknownKeys, accepted },
      );
    }
  }

  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new AbapError("BAD_INPUT", `Invalid arguments: ${detail}`, { issues: parsed.error.issues });
  }
  return parsed.data;
}

/** The first text block of a v1 `CallToolResult` — every v1 tool renders exactly one. */
export function textOf(result: CallToolResult): string {
  const first = result.content[0];
  if (first === undefined || first.type !== "text") {
    throw new AbapError("ADT_ERROR", "v1 handler returned no text content.", {});
  }
  return first.text;
}

/** Wraps rendered text into the `V2Ok<string>` every `DoHandler` returns. */
export function doOk(text: string, next: readonly NextCall[] = []): V2Ok<string> {
  return { ok: true, tool: "abap_do", data: text, next };
}

/** `next` pointing at `journal_list` — the generic "see what just happened" follow-up after a write. */
export function journalNext(why = "See this change recorded in the journal."): NextCall[] {
  return [{ tool: "abap_do", args: { action: "journal_list" }, why }];
}
