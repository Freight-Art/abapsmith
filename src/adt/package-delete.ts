/**
 * `DEVC/K` (package) delete — `CL_PACKAGE_FACTORY`, over the DDIC classrun bridge.
 *
 * No ADT REST delete route exists for a package, so this reaches
 * `CL_PACKAGE_FACTORY` the same way `./package-create.ts` does: a generated
 * `IF_OO_ADT_CLASSRUN` class deployed to `$TMP`.
 *
 * `IF_PACKAGE~DELETE`'s failure behaviour has not been verified against a
 * live system — see step 5's TDEVC re-read in {@link packageDeleteFragment}.
 *
 * STOP-THE-LINE follow-up: `LOAD_PACKAGE`/`SET_CHANGEABLE`/`DELETE`/
 * `SAVE` all raise CLASSIC (non-`cx_root`) exceptions. The generated class
 * body is wrapped in `TRY ... CATCH cx_root` (`ddicBridgeSource`), which a
 * classic exception is invisible to — it escapes the TRY and short-dumps.
 * This fired live: a LOCKED package's `set_changeable( abap_true )`
 * triggered `OBJECT_LOCKED_BY_OTHER_USER` (a plain, non-class-based
 * exception raised inside `CL_PACKAGE`), the class short-dumped, and the
 * dump destroyed the whole tagged transcript — including the `PKG-EMPTY`
 * evidence already written by step 3. Every such call in
 * {@link packageDeleteFragment} is now `CALL METHOD ... EXCEPTIONS OTHERS =
 * 1` (functional-call syntax like `lo_package->delete( )` cannot carry an
 * `EXCEPTIONS` clause at all) guarded by `subrcGuardFragment` immediately
 * after, so a classic exception now produces a clean `ZMCP-DDIC-ERR>` line
 * — parsed into a `CHECK_FAILED` — instead of a dump. `OTHERS` (never a
 * named exception like `object_locked_by_other_user`) is deliberate: naming
 * one that isn't in the method's real signature on this system is a hard
 * syntax error, and that signature has not been (cannot safely be) verified
 * live for this change.
 *
 * One `EXPORTING` parameter name this rewrite had to supply BY HAND
 * (`i_changeable` for `set_changeable`) is transcribed from the
 * `IF_PACKAGE` signature, not live-verified — see the inline ABAP/TS
 * comments at that call site. (`./package-create.ts` additionally supplies
 * `i_super_package_name`, unverified the same way — this file has no
 * `set_super_package_name` call.) `load_package`/`save` already used named
 * parameters before this change, so converting those to `CALL METHOD` is
 * purely mechanical, zero risk.
 */

import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import type { SafetyCorr, SafetyGate } from "../safety.js";
import type { RunResult } from "./run.js";
import {
  assertBridgeMutation,
  DDIC_BRIDGE_CLASS,
  ddicBridgeSource,
  runDdicBridge,
  subrcGuardFragment,
  type DdicTranscript,
} from "./ddic-bridge.js";
import { assertEnhIdentifier } from "./enhancement-templates.js";
import { isTrkorr } from "./transports.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** `TDEVC-DEVCLASS` is CHAR30, same limit `./package-create.ts` validates its `packageName` against. */
const PACKAGE_MAX_LENGTH = 30;

/** How many rows of each emptiness query this bridge shows before it stops counting — see {@link packageDeleteFragment}. */
const CONTENT_DISPLAY_LIMIT = 20;

/**
 * The `subrcGuardFragment`/`subrcCheckFragment` step name for
 * `lo_package->set_changeable( abap_true )` — exported so
 * {@link deletePackageViaBridge}'s `beforeAssert` can recognise exactly this
 * failure (by the same string the generated ABAP writes) and surface a
 * lock-shaped hint. Live incident: this is the call that actually
 * short-dumped with `OBJECT_LOCKED_BY_OTHER_USER` on A4H before this guard
 * existed — see the module header.
 */
export const SET_CHANGEABLE_STEP = "Making package changeable";

// ---------------------------------------------------------------------------
// Validation, applied to every caller string
// ---------------------------------------------------------------------------

/**
 * `corrNr` — an already gate-judged TRKORR, or `""` for a local package
 * needing no transport. This module never acquires one itself; see
 * {@link PackageDeleteParams.corrNr}.
 */
function assertOptionalCorrNr(value: string): string {
  if (value === "") return value;
  if (!isTrkorr(value)) {
    throw new AbapError(
      "BAD_INPUT",
      `corr_nr ${JSON.stringify(value)} is not a transport request/task number this system would ` +
        'issue (e.g. A4HK900121), and not the empty string "" that means "this package is local, no ' +
        'transport is needed for its delete". This module never acquires a request on its own — the ' +
        "caller must hand it one that has already been judged by the safety gate.",
      { what: "corrNr", value },
    );
  }
  return value;
}

/**
 * Quotes an already-validated identifier as an ABAP string literal; never
 * call this on unvalidated input. Mirrors `./package-create.ts`'s helper.
 */
function quoted(validatedIdentifier: string): string {
  return `'${validatedIdentifier}'`;
}

// ---------------------------------------------------------------------------
// The closed fragment
// ---------------------------------------------------------------------------

export interface PackageDeleteParams {
  packageName: string;
  /** Transport for the delete, or "" for a local package that needs none. */
  corrNr: string;
}

/** Prefix of the tagged evidence lines listing what is still inside the package. */
export const PKG_CONTENT_PREFIX = "ZMCP-PKG-CONTENT>";

/**
 * Prefix marking a content query that hit its `UP TO 21 ROWS` ceiling.
 * Not exported — callers see this via {@link parsePackageContents}'s
 * `truncated` flag, not the raw prefix.
 */
const PKG_CONTENT_TRUNCATED_PREFIX = "ZMCP-PKG-CONTENT-TRUNCATED>";

export interface PackageContent {
  /** "OBJECT" for a TADIR row, "SUBPKG" for a child package. */
  kind: "OBJECT" | "SUBPKG";
  pgmid: string;
  object: string;
  name: string;
}

/**
 * Bare `DATA` declarations for `ddicBridgeSource` (no leading `DATA`
 * keyword) — analogue of `./package-create.ts`'s `PACKAGE_DATA_LINES`.
 * `WITH EMPTY KEY` because nothing here reads these tables by key.
 */
export const PACKAGE_DELETE_DATA_LINES: readonly string[] = [
  "ls_tdevc            TYPE tdevc.",
  "lt_subpkg           TYPE STANDARD TABLE OF tdevc WITH EMPTY KEY.",
  "ls_subpkg           TYPE tdevc.",
  "lt_tadir            TYPE STANDARD TABLE OF tadir WITH EMPTY KEY.",
  "ls_tadir            TYPE tadir.",
  "lo_package          TYPE REF TO if_package.",
  "lv_content_count    TYPE i.",
  "lv_subpkg_count     TYPE i.",
  "lv_tadir_count      TYPE i.",
  "lv_subpkg_truncated TYPE abap_bool.",
  "lv_tadir_truncated  TYPE abap_bool.",
];

/**
 * Parses `ZMCP-PKG-CONTENT>` / `ZMCP-PKG-CONTENT-TRUNCATED>` lines out of a
 * classrun transcript. Mirrors `./package-create.ts`'s `parseTdevcLine`
 * discipline (malformed rows dropped, not half-trusted), extended to collect
 * every match since a non-empty package can have many.
 */
export function parsePackageContents(raw: string): { contents: PackageContent[]; truncated: boolean } {
  const contents: PackageContent[] = [];
  let truncated = false;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith(PKG_CONTENT_TRUNCATED_PREFIX)) {
      truncated = true;
      continue;
    }
    if (!trimmed.startsWith(PKG_CONTENT_PREFIX)) continue;
    const rest = trimmed.slice(PKG_CONTENT_PREFIX.length).trim();
    const fields: Record<string, string> = {};
    // KEY=VALUE pairs separated by single spaces; PGMID/OBJECT/NAME never
    // legitimately contain spaces (they are repository-object identifiers),
    // so a plain split is safe — same assumption `parseTdevcLine` documents.
    for (const part of rest.split(" ")) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      fields[part.slice(0, eq)] = part.slice(eq + 1).trim();
    }
    const kind = fields["KIND"];
    const pgmid = fields["PGMID"];
    const object = fields["OBJECT"];
    const name = fields["NAME"];
    // A half-filled row, or unrecognised KIND, is dropped rather than
    // guessed at — understating contents is safer than inventing evidence.
    // {@link deletePackageViaBridge}'s `beforeAssert` only fires when
    // `contents.length > 0`, so an empty array here isn't proof of emptiness.
    if (pgmid === undefined || object === undefined || name === undefined) continue;
    if (kind !== "OBJECT" && kind !== "SUBPKG") continue;
    contents.push({ kind, pgmid, object, name });
  }
  return { contents, truncated };
}

/**
 * `CL_PACKAGE_FACTORY=>LOAD_PACKAGE` / `IF_PACKAGE~DELETE` / `SAVE`, gated by
 * an in-bridge emptiness check and closed by a TDEVC re-read (see module
 * header). Exported for the generator/parser drift test, like
 * `packageFragment`. Five steps, labelled inline below.
 */
export function packageDeleteFragment(p: PackageDeleteParams): string[] {
  const packageName = assertEnhIdentifier(p.packageName, "packageName", { maxLength: PACKAGE_MAX_LENGTH });
  const corrNr = assertOptionalCorrNr(p.corrNr);
  const pkg = quoted(packageName);

  // CALL METHOD is required to carry EXCEPTIONS at all (see the module
  // header) — save( i_transport_request = ... ) already used a named
  // parameter, so converting it is mechanical, zero risk.
  const saveCallLines: string[] =
    corrNr === ""
      ? ["CALL METHOD lo_package->save", "  EXCEPTIONS", "    OTHERS = 1."]
      : [
          "CALL METHOD lo_package->save",
          "  EXPORTING",
          `    i_transport_request = ${quoted(corrNr)}`,
          "  EXCEPTIONS",
          "    OTHERS               = 1.",
        ];

  return [
    '" Step 1 - confirm the package exists; refuse honestly if it does not,',
    '" rather than treating a delete of a never-existed name as a no-op.',
    // Defence-in-depth, not live via `abap_write mode=delete`: authorizeMutation
    // (src/adt/write.ts) calls resolveWriteTarget(..., "delete") first and throws
    // NOT_FOUND for a nonexistent DEVC/K before this bridge is even generated —
    // verified by reading that code path. This check still matters because the
    // bridge is also reachable from the undo path (src/adt/undo.ts's "undo a
    // create" delete, which does not re-run that NOT_FOUND guard) and it costs
    // only one SELECT SINGLE. Do not delete it, and do not write a test that
    // asserts `abap_write mode=delete` surfaces this message — it can't.
    `SELECT SINGLE * FROM tdevc INTO @ls_tdevc WHERE devclass = ${pkg}.`,
    "IF sy-subrc <> 0.",
    `  out->write( |ZMCP-DDIC-ERR> package ${packageName} does not exist| ).`,
    "  RETURN.",
    "ENDIF.",
    "",
    '" Step 2 - gather emptiness evidence first: sub-packages (TDEVC-PARENTCL)',
    '" and objects (TADIR-DEVCLASS), UP TO 21 ROWS so a 21st row signals more.',
    `SELECT * FROM tdevc UP TO 21 ROWS INTO TABLE @lt_subpkg WHERE parentcl = ${pkg}.`,
    "lv_subpkg_count = lines( lt_subpkg ).",
    `IF lv_subpkg_count > ${CONTENT_DISPLAY_LIMIT}.`,
    "  lv_subpkg_truncated = abap_true.",
    "ENDIF.",
    "LOOP AT lt_subpkg INTO ls_subpkg.",
    `  IF sy-tabix > ${CONTENT_DISPLAY_LIMIT}.`,
    "    CONTINUE.",
    "  ENDIF.",
    "  lv_content_count = lv_content_count + 1.",
    `  out->write( |${PKG_CONTENT_PREFIX} KIND=SUBPKG PGMID=R3TR OBJECT=DEVC NAME={ ls_subpkg-devclass }| ).`,
    "ENDLOOP.",
    "IF lv_subpkg_truncated = abap_true.",
    `  out->write( '${PKG_CONTENT_TRUNCATED_PREFIX} SOURCE=SUBPKG' ).`,
    "ENDIF.",
    "",
    `SELECT * FROM tadir UP TO 21 ROWS INTO TABLE @lt_tadir WHERE devclass = ${pkg}.`,
    "lv_tadir_count = lines( lt_tadir ).",
    `IF lv_tadir_count > ${CONTENT_DISPLAY_LIMIT}.`,
    "  lv_tadir_truncated = abap_true.",
    "ENDIF.",
    "LOOP AT lt_tadir INTO ls_tadir.",
    `  IF sy-tabix > ${CONTENT_DISPLAY_LIMIT}.`,
    "    CONTINUE.",
    "  ENDIF.",
    '  " The package\'s own R3TR DEVC row in TADIR is filtered here, in the',
    '  " LOOP, rather than in the SQL WHERE clause, deliberately.',
    `  IF ls_tadir-pgmid = 'R3TR' AND ls_tadir-object = 'DEVC' AND ls_tadir-obj_name = ${pkg}.`,
    "    CONTINUE.",
    "  ENDIF.",
    "  lv_content_count = lv_content_count + 1.",
    `  out->write( |${PKG_CONTENT_PREFIX} KIND=OBJECT PGMID={ ls_tadir-pgmid } OBJECT={ ls_tadir-object } NAME={ ls_tadir-obj_name }| ).`,
    "ENDLOOP.",
    "IF lv_tadir_truncated = abap_true.",
    `  out->write( '${PKG_CONTENT_TRUNCATED_PREFIX} SOURCE=TADIR' ).`,
    "ENDIF.",
    "",
    '" Step 3 - delete is only attempted on a provably empty package; any',
    '" content found above stops here before CL_PACKAGE_FACTORY is touched.',
    "IF lv_content_count > 0.",
    "  RETURN.",
    "ENDIF.",
    "out->write( 'PKG-EMPTY' ).",
    "",
    '" Step 4 - LOAD_PACKAGE mirrors ./package-create.ts; SAVE takes',
    '" i_transport_request only when a transport was supplied.',
    '" LOAD_PACKAGE / SET_CHANGEABLE / DELETE / SAVE all raise CLASSIC',
    '" (non-cx_root) exceptions, invisible to the CATCH cx_root wrapping this',
    '" whole method (see ddic-bridge.ts). CALL METHOD ... EXCEPTIONS OTHERS = 1',
    '" is the only way to attach EXCEPTIONS to a method call - functional-call',
    '" syntax (e.g. the old `lo_package->delete( ).`) cannot carry one at all.',
    '" A locked package short-dumped through set_changeable live before this',
    '" guard existed and destroyed the whole tagged transcript.',
    "CALL METHOD cl_package_factory=>load_package",
    "  EXPORTING",
    `    i_package_name = ${pkg}`,
    "  IMPORTING",
    "    e_package      = lo_package",
    "  EXCEPTIONS",
    "    OTHERS         = 1.",
    ...subrcGuardFragment("Loading package"),
    "",
    // lo_package is TYPE REF TO if_package (an INTERFACE reference), so
    // IF_PACKAGE~ prefixing this call is invalid - A4H rejects it at
    // activation ("Class IF_PACKAGE does not contain an interface
    // IF_PACKAGE"). Every call on lo_package already omits it.
    '" i_changeable is transcribed from the IF_PACKAGE signature and is NOT',
    '" verified live by this change. If the name is wrong, the generated',
    '" class fails ITS OWN SYNTAX CHECK at bridge activation - caught by',
    '" deployBridge/verifyBridgeActivation BEFORE any mutation runs. Loud,',
    '" and safe: nothing is created or deleted on a bad name here.',
    "CALL METHOD lo_package->set_changeable",
    "  EXPORTING",
    "    i_changeable = abap_true",
    "  EXCEPTIONS",
    "    OTHERS       = 1.",
    ...subrcGuardFragment(SET_CHANGEABLE_STEP),
    "",
    "CALL METHOD lo_package->delete",
    "  EXCEPTIONS",
    "    OTHERS = 1.",
    ...subrcGuardFragment("Deleting package"),
    "",
    ...saveCallLines,
    ...subrcGuardFragment("Saving package"),
    "COMMIT WORK.",
    "out->write( 'PKG-DELETED' ).",
    "",
    '" Step 5 - re-read TDEVC because a clean return from IF_PACKAGE~DELETE is',
    '" not trusted (unverified live); only then write PKG-GONE.',
    `SELECT SINGLE * FROM tdevc INTO @ls_tdevc WHERE devclass = ${pkg}.`,
    "IF sy-subrc = 0.",
    `  out->write( |ZMCP-DDIC-ERR> delete of ${packageName} reported no error but the TDEVC row still exists| ).`,
    "  RETURN.",
    "ENDIF.",
    "out->write( 'PKG-GONE' ).",
  ];
}

// ---------------------------------------------------------------------------
// The operation
// ---------------------------------------------------------------------------

/**
 * Delete a `DEVC/K` package via the DDIC classrun bridge. Mirrors
 * `./package-create.ts`'s `createPackageViaBridge`, but gates with
 * `op: "delete"` (not the default write) and passes the package's own name
 * (it already exists, unlike a create's not-yet-existing superpackage).
 */
export async function deletePackageViaBridge(
  conn: AbapConnection,
  gate: SafetyGate,
  params: PackageDeleteParams & {
    /**
     * Whether `corrNr` was named by a human (`preflightCorr`'s
     * `config-pin`/`caller`) or picked by the server (everything else) — see
     * `SafetyCorr` (src/safety.ts) and the identical parameter on
     * `./package-create.ts`'s `createPackageViaBridge`. Threaded into the
     * second gate call below so a refusal names the real request, never a
     * fabricated `"auto"`. Defaults to `"auto"`, matching this module's
     * behaviour before `corr` existed here. Ignored when `corrNr === ""`
     * (a local package has no transport to judge).
     */
    corrSource?: "named" | "auto";
  },
): Promise<{ run: RunResult; transcript: DdicTranscript; contents: PackageContent[]; truncated: boolean }> {
  // 1 — re-validated inside packageDeleteFragment too (exported, must be safe standalone).
  const packageName = assertEnhIdentifier(params.packageName, "packageName", {
    maxLength: PACKAGE_MAX_LENGTH,
  });
  const corrNr = assertOptionalCorrNr(params.corrNr);

  // 2 — the second gate, on the domain object, zero-network, before any ABAP is generated.
  // See this function's own doc comment for why op is "delete" and packageName
  // is the package's OWN name here, unlike the create's superPackage.
  // `corrNr === ""` means a local package with no transport at all — no corr
  // is fabricated for that case, mirroring `assertOptionalCorrNr`'s contract.
  const corr: SafetyCorr | undefined =
    corrNr === "" ? undefined : { kind: "transport", corrNr, source: params.corrSource ?? "auto" };
  assertBridgeMutation(
    gate,
    {
      type: "DEVC/K",
      name: packageName,
      packageName: packageName,
      exists: true,
    },
    { activate: false, op: "delete", ...(corr !== undefined ? { corr } : {}) },
  );

  // 3
  const source = ddicBridgeSource(
    DDIC_BRIDGE_CLASS.deletePackage,
    PACKAGE_DELETE_DATA_LINES,
    packageDeleteFragment({ packageName, corrNr }),
  );

  // 4 — `beforeAssert` turns two specific, legitimate-but-unhelpful outcomes
  // into a named error instead of the generic "missing tag" the transcript
  // assertion would otherwise give:
  //  (a) a non-empty package (see packageDeleteFragment step 3), and
  //  (b) a classic-exception guard tripping on SET_CHANGEABLE — by far the
  //      most likely real-world cause (a lock), even though EXCEPTIONS
  //      OTHERS never tells us which classic exception actually fired
  //      (live incident: OBJECT_LOCKED_BY_OTHER_USER short-dumped here
  //      before the guard existed).
  const beforeAssert = (transcript: DdicTranscript): void => {
    const { contents, truncated } = parsePackageContents(transcript.raw);
    if (contents.length > 0) {
      const listed = contents
        .map((c) => `${c.kind === "SUBPKG" ? "sub-package" : "object"} ${c.pgmid} ${c.object} ${c.name}`)
        .join(", ");
      throw new AbapError(
        "CHECK_FAILED",
        `Package ${packageName} is not empty and was NOT deleted. It still contains: ${listed}` +
          (truncated ? " (and more - this list was capped at 20)." : ".") +
          " Empty the package first (move or delete its objects and sub-packages, or reassign its " +
          "sub-packages elsewhere) and retry — abapsmith will not delete a package's contents on the " +
          "caller's behalf.",
        { packageName, contents, truncated },
      );
    }
    if (transcript.errorLine?.startsWith(`${SET_CHANGEABLE_STEP} failed`)) {
      throw new AbapError(
        "CHECK_FAILED",
        `Package ${packageName} could not be made changeable, so the delete did not proceed (its ` +
          "contents were already confirmed empty — see the PKG-EMPTY evidence below). This is NOT " +
          "confirmed as the cause from here — CALL METHOD ... EXCEPTIONS OTHERS reports only that " +
          "SOME classic exception fired, never which one, and sy-msgid/sy-msgno may be blank even " +
          "when one did — but by far the most likely reason on this specific step is that another " +
          `user or an open SE21/SE80 session holds a lock on ${packageName} (SAP raises ` +
          "OBJECT_LOCKED_BY_OTHER_USER from CL_PACKAGE for exactly this). Check SM12 for a lock on " +
          `${packageName} and close any editor sessions on it, then retry. Raw ABAP-side detail: ` +
          `${transcript.errorLine}`,
        { packageName, raw: transcript.raw },
      );
    }
  };

  const { run, transcript } = await runDdicBridge(conn, gate, {
    className: DDIC_BRIDGE_CLASS.deletePackage,
    source,
    description: `abapsmith delete-package bridge (${packageName})`,
    what: `Deleting package ${packageName}`,
    expectTags: ["PKG-EMPTY", "PKG-DELETED", "PKG-GONE"],
    beforeAssert,
  });

  // 5 — success path: nothing was found (a non-empty package's own contents
  // already threw, above, out of beforeAssert), so this is always [] / false
  // here — parsed the same way for symmetry with the error path rather than
  // hardcoded, so a future change to either path can't silently drift apart.
  const { contents, truncated } = parsePackageContents(transcript.raw);
  return { run, transcript, contents, truncated };
}
