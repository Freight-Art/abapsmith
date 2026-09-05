/**
 * `abap_write` handler: real routing. See `handlers/find.ts` for the shared
 * bare-call / envelope contract; `register.ts` gates registration on
 * `mode !== "read"`.
 *
 * All four forms route through the same `abapWrite` core (`src/tools/write.ts`)
 * that v1 uses. Conflicting forms are refused with `BAD_INPUT` before any
 * network cost — see the git history.
 *
 *   {object, edit:{old_string,new_string,replace_all?}} — unique-match splice
 *   {object, method, source}                            — whole-method replace
 *   {object, source}                                     — full rewrite
 *   {object, mode:"delete"}                              — delete
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { assertDdicTypeKind } from "../../../adt/ddic-payload.js";
import { AbapError } from "../../../adt/errors.js";
import { assertClassInclude } from "../../../adt/types.js";
import { preflight, writeGateKey } from "../../preflight.js";
import { abapWrite, type WriteInputV2 } from "../../write.js";
import type { NextCall, V2Ok } from "../envelope.js";
import { bareOk, isBareCall, v2Result } from "../envelope.js";
import type { V2ToolDeps } from "../runtime.js";
import { v2Error } from "../runtime.js";
import type { abapWriteInputSchema } from "../schemas.js";

/**
 * Raw v2 `abap_write` args, derived from `abapWriteInputSchema` rather than
 * hand-copied — a duplicated field list previously let a declared `edit`
 * silently vanish (see the git history).
 * Runtime half of the guarantee: test/v2-write-arg-forwarding.test.ts.
 */
type AbapWriteArgs = z.infer<z.ZodObject<typeof abapWriteInputSchema>>;

/**
 * Compile-time check: every field `abapWriteInputSchema` declares must be
 * consumed by `WriteInputV2`, or this fails to compile naming the key
 * (see archive for why the reverse direction can't be type-checked).
 */
type Assert<Ok extends true> = Ok;
type _SchemaFieldsAreConsumedByTheCore = Assert<
  [Exclude<keyof AbapWriteArgs, keyof WriteInputV2>] extends [never] ? true : false
>;

/** Best-effort `object` name for the catch block, where `a` is out of scope
 *  (the throw may predate its declaration). */
function objectNameFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const v = (args as { object?: unknown }).object;
  return typeof v === "string" && v.trim() ? v : undefined;
}

export async function handleAbapWrite(args: unknown, deps: V2ToolDeps): Promise<CallToolResult> {
  try {
    if (isBareCall(args)) {
      return v2Result(
        bareOk(
          "abap_write",
          "abap_write changes source. Forms:\n" +
            "  {object, edit:{old_string,new_string}} — unique-match splice (prefer this)\n" +
            "  {object, method, source} — whole-method replace\n" +
            "  {object, source} — full rewrite\n" +
            "  {object, mode:'delete'} — delete the object",
          [
            {
              tool: "abap_write",
              args: { object: "ZCL_FOO", edit: { old_string: "...", new_string: "..." } },
              why: "Cheapest, safest form: replace one unique match.",
            },
          ],
        ),
      );
    }

    const a = args as AbapWriteArgs;

    // Conflicting forms refused before any network cost.
    if (a.edit !== undefined && a.source !== undefined) {
      throw new AbapError(
        "BAD_INPUT",
        "Pass either `edit` or `source`, not both — they are two different ways of saying what the new source is.",
        { object: a.object },
        "Drop `source` to splice with `edit`, or drop `edit` and pass the complete new source.",
      );
    }
    if (a.edit !== undefined && a.method !== undefined) {
      throw new AbapError(
        "BAD_INPUT",
        "Pass either `edit` or `method`, not both — `edit` splices inside the CURRENT source; " +
          "`method` (with `source`) replaces one method's whole implementation.",
        { object: a.object },
        "Use {method, source} for a whole-method replace, or {edit:{old_string,new_string}} to splice.",
      );
    }
    if (!a.object) {
      throw new AbapError(
        "BAD_INPUT",
        "`object` is required.",
        {},
        "Pass {object: \"ZCL_FOO\", ...}. Call abap_write({}) for the full form list.",
      );
    }

    const objectName = a.object;
    // Single source of truth for the operation kind, used by both the safety
    // gate and the core input below (see `input` for why it can't just forward).
    const writeMode: WriteInputV2["mode"] = a.mode === "delete" ? "delete" : "write";

    // Narrowed before the safety gate/network so a bad `include` is refused
    // by name at zero cost — same pattern as the edit/source check above.
    const include = a.include === undefined ? undefined : assertClassInclude(a.include);

    // Same pattern — only `ddic.typeKind` is loosely typed by the v2 schema.
    const ddic =
      a.ddic === undefined
        ? undefined
        : { ...a.ddic, typeKind: a.ddic.typeKind === undefined ? undefined : assertDdicTypeKind(a.ddic.typeKind) };

    // Denied writes must never reach the wire — same preflight/writeGateKey
    // pattern as v1's registerWriteTools (src/tools/write.ts).
    deps.safety.assert(writeMode, preflight({ object: objectName, type: a.type, package: a.package }), {
      phase: "preflight",
      corr: { kind: "unresolved" },
    });
    await deps.ensureConnected();

    // LOCK → PUT → UNLOCK, gated per-object so two writes can't interleave —
    // same wiring as v1's registerWriteTools.
    // Forwarded wholesale (`...a`) to avoid a third copy of the field list.
    // `mode`/`include` can't forward verbatim (v2 schema keeps them loosely
    // typed; WriteInputV2 wants the narrowed values computed above) — this is
    // a checked assignment, not the `as WriteInputV2` cast it replaced.
    // See the git history for the details.
    const input: WriteInputV2 = { ...a, object: objectName, mode: writeMode, include, ddic };
    const result = await deps.pool.withWrite("abap_write", writeGateKey(objectName, a.type), (conn) =>
      abapWrite(
        conn,
        input,
        deps.cfg.maxResponseChars,
        deps.safety,
        deps.journal,
        deps.transport,
        deps.cfg.verifyWrites,
      ),
    );

    const next: readonly NextCall[] = a.dry_run
      ? [
          {
            tool: "abap_write",
            args: { object: objectName },
            why: "This was a preview — nothing was written. Repeat the same call without `dry_run`: " +
              "for `edit`/`method` writes pass `expect_etag` as the preview reported it; for a plain " +
              "`{object, source}` write, pass the preview's `current_etag` instead.",
          },
        ]
      : // Read-back is mode-gated: `verified` wants proof, `speculative` (default)
        // treats a clean write as sufficient and does not spend a read on it.
        // `version:"active"` is required — an unactivated object would otherwise
        // read back as its newer INACTIVE version, defeating the check.
        deps.cfg.verifyWrites === "verified"
          ? [
              {
                tool: "abap_read",
                args: { object: objectName, version: "active" },
                why: "verify: already confirmed presence and activation — read back to confirm the CONTENT matches what you intended.",
              },
            ]
          : writeMode !== "delete" && a.activate === false
            ? [
                {
                  tool: "abap_do",
                  args: { action: "activate", object: objectName },
                  why: "activate:false skipped activation on this write — activate it separately when ready.",
                },
              ]
            : [];
    const ok: V2Ok<string> = { ok: true, tool: "abap_write", data: result.text, next };
    return v2Result(ok);
  } catch (e) {
    // Existence check runs UNCONDITIONALLY in both verifyWrites modes: create
    // isn't atomic, and a reported failure means no cleanup ran, so the
    // object can exist anyway — that residue is the case worth catching.
    const failedObject = objectNameFromArgs(args);
    return v2Result(
      v2Error("abap_write", e, [
        {
          tool: "abap_read",
          args: failedObject ? { object: failedObject } : {},
          why: "The write reported failure, but a create is not atomic — check whether the object exists " +
            "anyway before retrying; a reported failure runs no cleanup.",
        },
        { tool: "abap_write", args: {}, why: "Retry with the bare call for guidance." },
      ]),
    );
  }
}
