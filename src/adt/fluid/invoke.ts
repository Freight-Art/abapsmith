/**
 * The generated invoker: `IF_OO_ADT_CLASSRUN` has no input channel, so a
 * per-call fluid invocation is a tiny generated class that bakes the action
 * name and argument JSON in as ABAP literals and calls the tool's entry
 * class. Content-addressed by its inputs (see {@link invokerName}), so an
 * identical repeat call reuses the same class and writes nothing.
 */
import { contentHash } from "../../compact.js";
import { AbapError } from "../errors.js";
import { assertPlainName } from "../run.js";

/** Length-prefixed so no part's content can forge a boundary with the next — mirrors `versionPart` in manifest.ts. */
function hashPart(s: string): string {
  return `${s.length}:${s}`;
}

/**
 * Sorts object keys at every depth, omits `undefined`-valued properties,
 * keeps array order, emits no whitespace. Two argument objects differing
 * only in key order must hash identically — this is what makes that true.
 *
 * The invoker name is derived from this exact serialization (see
 * `invokerName`) — callers that bake argument JSON into the invoker source
 * must use it too, not `JSON.stringify`, or a key-order difference produces
 * the same name for different generated source and breaks content-addressing.
 */
export function canonicalArgsJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? "null" : canonicalArgsJson(v))).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalArgsJson(obj[k])}`).join(",")}}`;
}

/**
 * Deterministic invoker class name, `ZCL_ZMCP_I_` + 8 uppercase hex (19
 * chars, well under the 30-char ABAP name limit).
 *
 * The manifest version is deliberately NOT one of the hashed parts: keeping
 * the invoker name stable across a version bump is what makes the runtime's
 * version echo a real check instead of a tautology — a stale class or a
 * stale ABAP program buffer echoes the OLD version and dispatch can catch it.
 *
 * Pure: no timestamp, no counter, no randomness, byte-stable across processes.
 */
export function invokerName(toolId: string, action: string, args: unknown, contract: string): string {
  const joined = [toolId, action, contract, canonicalArgsJson(args)].map(hashPart).join("");
  const hex = contentHash(joined).replace(/^sha256:/, "").slice(0, 8).toUpperCase();
  return `ZCL_ZMCP_I_${hex}`;
}

/**
 * Raw (unescaped) chars per chunk. 90 is the raw ceiling because each `` ` ``
 * doubles to ` `` ` on escaping, so 90 raw is at most 180 escaped chars per
 * line — comfortably under ADT's 255-char source-line limit alongside the
 * assignment prefix.
 */
const ARG_CHUNK_RAW = 90;

const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;

/**
 * Splits `json` into raw chunks of at most 90 code units, in order;
 * concatenating them back yields exactly `json`.
 *
 * A chunk boundary that would land right after a high surrogate is backed
 * off by one code unit so a surrogate pair (an astral character) is never
 * split across two chunks — Node can't re-encode a lone surrogate as UTF-8.
 */
export function abapArgumentChunks(json: string): readonly string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < json.length) {
    let end = Math.min(i + ARG_CHUNK_RAW, json.length);
    if (end < json.length && end - 1 > i) {
      const code = json.charCodeAt(end - 1);
      if (code >= HIGH_SURROGATE_MIN && code <= HIGH_SURROGATE_MAX) {
        end -= 1;
      }
    }
    chunks.push(json.slice(i, end));
    i = end;
  }
  return chunks;
}

// Backtick literals are ABAP's `string`-typed literal and, unlike a
// single-quoted `c`-typed literal, keep trailing blanks — required so a
// chunk boundary landing right after a space in the JSON doesn't drop it.
function escapeAbapLiteral(value: string): string {
  return value.replace(/`/g, "``");
}

const INVOKER_NAME_RE = /^ZCL_ZMCP_I_[0-9A-F]{8}$/;
const VERSION_RE = /^[0-9a-f]{8}$/;
const CONTRACT_RE = /^\d+\.\d+$/;
const QUOTE_OR_NEWLINE = /['\r\n]/;

function assertNoQuoteOrNewline(value: string, field: string): string {
  if (QUOTE_OR_NEWLINE.test(value)) {
    throw new AbapError("BAD_INPUT", `${field} "${value}" must not contain a single quote or a newline.`, {
      field,
      value,
    });
  }
  return value;
}

export interface InvokerSourceArgs {
  readonly name: string;
  readonly entry: string;
  readonly toolId: string;
  readonly action: string;
  readonly argsJson: string;
  readonly version: string;
  readonly contract: string;
  readonly commit: boolean;
  /** Present only for core.eval: the caller's statements and the local names to serialise back. */
  readonly evalBody?: { readonly lines: readonly string[]; readonly out: readonly string[] } | undefined;
}

// Mirrors `EVAL_OUT_NAME_RE` in `./builtin/core.js`, kept in sync by hand rather than imported —
// this module has no other dependency on builtin/core.ts and importing just this one regex would
// invite a cycle (dispatch.ts already imports both). `guardCoreAction` validates every `out` name
// before this module ever sees one; the check below is defense in depth, not the primary gate.
const EVAL_OUT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,29}$/;

/**
 * One `out` name's serialise-and-emit block. `/UI2/CL_JSON` is a NetWeaver/SAP_UI class that is
 * not guaranteed present on every system, so the call is dynamic (`CALL METHOD (...)=>(...)`) —
 * that form compiles even where the class is absent, and turns a missing/failing serializer into
 * one degraded OUT entry (an "error" field) instead of a hard failure for every other requested
 * name. It sits in GENERATED code, never in the caller's own `lines`, so `reviewFluidAbap`'s
 * `dynamic-call-method` rule — which only ever scans `lines` — correctly never flags it. Verified
 * against reference system A4H: `/UI2/CL_JSON=>SERIALIZE` there is
 * `IMPORTING data TYPE data ... RETURNING VALUE(r_json) TYPE json`.
 */
function evalOutEmitter(name: string): string {
  if (!EVAL_OUT_NAME_RE.test(name)) {
    throw new AbapError("BAD_INPUT", `eval out name "${name}" must match ${EVAL_OUT_NAME_RE}.`, {
      field: "out",
      value: name,
    });
  }
  // `\{`/`\}` below are literal escaped-brace characters in an ABAP `|...|` string template, not
  // TypeScript syntax — the unescaped `{ ... }` in the error branch is a real embedded ABAP
  // expression (it calls `esc(...)` at runtime), left alone on purpose.
  return `        CLEAR lv_zmcp_out.
        TRY.
            CALL METHOD ('/UI2/CL_JSON')=>('SERIALIZE') EXPORTING data = ${name} RECEIVING r_json = lv_zmcp_out.
            zcl_zmcp_fluid_rt=>out( |\\{"name":"${name}","value":| && lv_zmcp_out && |\\}| ).
          CATCH cx_root INTO lx_zmcp_ser.
            zcl_zmcp_fluid_rt=>out( |\\{"name":"${name}","error":"{ zcl_zmcp_fluid_rt=>esc( lx_zmcp_ser->get_text( ) ) }"\\}| ).
        ENDTRY.`;
}

/**
 * The `core.eval` method body: the caller's own `lines` run verbatim inside one TRY, followed by
 * one JSON-emitting block per `out` name, all wrapped by the same fluid begin/end protocol every
 * other action uses. Replaces the whole `main` body — there is no `args.entry=>run` dispatch and
 * no argument-JSON reconstruction, because there is no separate body class: the caller's
 * statements ARE the body.
 */
function evalMethodBody(
  toolId: string,
  action: string,
  version: string,
  contract: string,
  body: { readonly lines: readonly string[]; readonly out: readonly string[] },
): string {
  // Emitted at column 0, unindented and otherwise unmodified: indenting risks pushing a caller
  // line already near FLUID_ABAP_LINE_MAX (255 chars — `assertAbapLineLengths` enforces it below)
  // over the limit for no benefit, since ABAP does not care about statement indentation.
  const callerLines = body.lines.join("\n");
  const outLines = body.out.map(evalOutEmitter).join("\n");
  const tryBody = [callerLines, outLines].filter((s) => s.length > 0).join("\n");

  return `  METHOD if_oo_adt_classrun~main.
*   Generated by abapsmith for fluid tool '${toolId}', action '${action}'. Do not edit.
*   The body below is the caller's own statements, run verbatim. See doc/FLUID-API/safety.md.
    DATA lv_zmcp_out TYPE string.
*   Declared here, not inline, so more than one \`out\` name does not redeclare it.
    DATA lx_zmcp_ser TYPE REF TO cx_root.
    zcl_zmcp_fluid_rt=>attach( io_out = out iv_ver = '${version}' iv_contract = '${contract}' ).
    zcl_zmcp_fluid_rt=>begin( iv_id = '${toolId}' iv_action = '${action}' ).

    TRY.
${tryBody}
      CATCH cx_root INTO DATA(lx_err).
        zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = '${action}' iv_text = lx_err->get_text( ) ).
        zcl_zmcp_fluid_rt=>end( 8 ).
    ENDTRY.
    zcl_zmcp_fluid_rt=>end( 0 ).
  ENDMETHOD.`;
}

/**
 * Emits a complete, activatable `IF_OO_ADT_CLASSRUN` class named `args.name`.
 *
 * Two shapes, chosen by whether `args.evalBody` is present:
 *  - Absent (every non-eval action): `main` rebuilds the argument JSON, attaches the fluid
 *    runtime, dispatches to `args.entry=>run`, and — only when `args.commit` — commits or rolls
 *    back based on the runtime's own failure flag. This is the ONLY shape that existed before
 *    `core.eval`, and it is byte-for-byte unchanged.
 *  - Present (`core.eval` only): `main` runs the caller's own statements verbatim — see
 *    `evalMethodBody`. `args.argsJson`/`args.commit` are ignored in this shape (eval is
 *    `category: "execute"`, never `mutate`, so a COMMIT WORK footer would be wrong here anyway —
 *    see `builtin/core.ts`'s doc comment on why `eval` is not `mutate`).
 *
 * Byte-stable: identical arguments always produce the identical string.
 */
export function invokerSource(args: InvokerSourceArgs): string {
  const plainName = assertPlainName(args.name, "invoker class name");
  if (!INVOKER_NAME_RE.test(plainName)) {
    throw new AbapError(
      "BAD_INPUT",
      `invoker class name "${args.name}" must match ${INVOKER_NAME_RE}.`,
      { field: "name", value: args.name },
    );
  }
  const entry = assertPlainName(args.entry, "entry class name");
  const toolId = assertNoQuoteOrNewline(args.toolId, "toolId");
  const action = assertNoQuoteOrNewline(args.action, "action");
  if (!VERSION_RE.test(args.version)) {
    throw new AbapError("BAD_INPUT", `version "${args.version}" must be 8 lowercase hex characters.`, {
      field: "version",
      value: args.version,
    });
  }
  if (!CONTRACT_RE.test(args.contract)) {
    throw new AbapError("BAD_INPUT", `contract "${args.contract}" must match ${CONTRACT_RE}.`, {
      field: "contract",
      value: args.contract,
    });
  }

  const cls = plainName.toLowerCase();
  const entryLower = entry.toLowerCase();

  if (args.evalBody) {
    const source = `CLASS ${cls} DEFINITION
  PUBLIC FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.
  PROTECTED SECTION.
  PRIVATE SECTION.
ENDCLASS.


CLASS ${cls} IMPLEMENTATION.

${evalMethodBody(toolId, action, args.version, args.contract, args.evalBody)}

ENDCLASS.
`;
    assertAbapLineLengths(source);
    return source;
  }

  const jsonLines = [
    "    CLEAR lv_json.",
    ...abapArgumentChunks(args.argsJson).map(
      (chunk) => `    lv_json = lv_json && \`${escapeAbapLiteral(chunk)}\`.`,
    ),
  ].join("\n");

  const commitLines = args.commit
    ? `

* Transaction handling lives in the invoker, not the body class, so a plugin author cannot forget it.
    IF zcl_zmcp_fluid_rt=>failed( ) = abap_true.
      ROLLBACK WORK.
    ELSE.
      COMMIT WORK AND WAIT.
    ENDIF.`
    : "";

  const source = `CLASS ${cls} DEFINITION
  PUBLIC FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.
  PROTECTED SECTION.
  PRIVATE SECTION.
ENDCLASS.


CLASS ${cls} IMPLEMENTATION.

  METHOD if_oo_adt_classrun~main.
*   Generated by abapsmith for fluid tool '${toolId}', action '${action}'. Do not edit.
    DATA lv_json TYPE string.
${jsonLines}
    zcl_zmcp_fluid_rt=>attach( io_out = out iv_ver = '${args.version}' iv_contract = '${args.contract}' ).
* Opened before TRY so a throw ahead of the body class's own begin( ) still leaves ERR/END inside a frame.
    zcl_zmcp_fluid_rt=>begin( iv_id = '${toolId}' iv_action = '${action}' ).

    TRY.
        ${entryLower}=>run( iv_action = '${action}' iv_json = lv_json ).
      CATCH cx_root INTO DATA(lx_err).
        zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = '${action}' iv_text = lx_err->get_text( ) ).
        zcl_zmcp_fluid_rt=>end( 8 ).
    ENDTRY.${commitLines}
    zcl_zmcp_fluid_rt=>end( 0 ).
  ENDMETHOD.

ENDCLASS.
`;

  assertAbapLineLengths(source);
  return source;
}

/**
 * A LINE-LENGTH rule, not an input-size cap: there is no ceiling on total
 * argument size here, only on how much text may sit on one ABAP source line
 * (255 chars). Runs before the first network call so an oversized line fails
 * locally, not as an opaque ADT syntax error.
 */
export function assertAbapLineLengths(source: string): void {
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const length = lines[i]!.length;
    if (length > 255) {
      throw new AbapError(
        "BAD_INPUT",
        `generated ABAP source line ${i + 1} is ${length} characters long; ABAP source lines are capped at 255.`,
        { line: i + 1, length },
      );
    }
  }
}
