/**
 * `DEVC/K` (package) create — `CL_PACKAGE_FACTORY`, over the DDIC classrun bridge.
 *
 * ADT REST can't create a not-yet-existing package: its CTS pre-flight has no
 * TADIR entry to inspect, always answers `local`, and discards the caller's
 * `corr_nr`. This drives `CL_PACKAGE_FACTORY` directly via a throwaway
 * `$TMP` classrun — same pattern as `./ddic-bridge.ts` (read its header first).
 *
 * The `CREATE_NEW_PACKAGE` recipe and constraints in {@link packageFragment}
 * were proven live on A4H by direct testing, not by this repo's tests.
 *
 * A package created here is deletable again since `./package-delete.ts` was
 * added, but only while empty. A non-empty package still has no
 * delete/undo path here; SE21 by a human is the only way to remove one.
 *
 * STOP-THE-LINE follow-up (discovered on the delete side, audited back
 * onto this file): `CREATE_NEW_PACKAGE`/`LOAD_PACKAGE`/`SAVE`/
 * `SET_CHANGEABLE`/`SET_SUPER_PACKAGE_NAME` all raise CLASSIC (non-`cx_root`)
 * exceptions, invisible to the `CATCH cx_root` wrapping the generated class
 * body (`ddicBridgeSource`) — an unguarded classic exception here would
 * short-dump exactly like the live delete-bridge incident did, destroying
 * the transcript. Every such call in {@link packageFragment} is now `CALL
 * METHOD ... EXCEPTIONS OTHERS = 1` (functional-call syntax cannot carry an
 * `EXCEPTIONS` clause) guarded immediately after by
 * `subrcGuardFragment`/`ddic-bridge.ts`. `OTHERS`, never a named exception,
 * for the same reason as the delete bridge: this system's exact `IF_PACKAGE`
 * exception signature has not been (cannot safely be) verified live.
 *
 * Two `EXPORTING` parameter names had to be supplied BY HAND for this
 * (`i_changeable` for `set_changeable`, `i_super_package_name` for
 * `set_super_package_name`) — transcribed from the `IF_PACKAGE` interface,
 * not live-verified. See the inline comments at those call sites: a wrong
 * name fails the generated class's OWN syntax check at bridge activation
 * (`deployBridge`/`verifyBridgeActivation`), before any mutation runs — loud
 * and safe. `create_new_package`/`load_package`/`save` already used named
 * parameters before this change, so converting those is purely mechanical.
 */

import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import type { SafetyCorr, SafetyGate } from "../safety.js";
import type { RunResult } from "./run.js";
import {
  assertBridgeMutation,
  DDIC_BRIDGE_CLASS,
  DDIC_ERR_PREFIX,
  ddicBridgeSource,
  runDdicBridge,
  subrcGuardFragment,
  type DdicTranscript,
} from "./ddic-bridge.js";
import { abapLiteral, assertAbapText, assertEnhIdentifier } from "./enhancement-templates.js";
import { isTrkorr } from "./transports.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** `SCOMPKDTLN-DEVCLASS` / `DEVCLASS` is CHAR30. */
const PACKAGE_MAX_LENGTH = 30;

/** `SCOMPKDTLN-CTEXT` is CHAR60. Longer text is REFUSED, never truncated. */
const CTEXT_MAX_LENGTH = 60;

// ---------------------------------------------------------------------------
// Validation, applied to every caller string
// ---------------------------------------------------------------------------

/**
 * `SCOMPKDTLN-DLVUNIT`, validated for verbatim substitution into generated
 * ABAP. Own grammar, not `assertEnhIdentifier`'s, since this field is never
 * local: `LOCAL` is refused outright, pointing the caller at ADT REST.
 */
function assertSoftwareComponent(value: string, what = "softwareComponent"): string {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{0,29}$/.test(value)) {
    throw new AbapError(
      "BAD_INPUT",
      `${what} ${JSON.stringify(value)} is not a valid software component for this bridge (a letter, ` +
        "then letters, digits and underscores only, max 30 characters, already upper-cased and " +
        "trimmed by the caller).",
      { what, value },
      "This value is substituted verbatim into generated ABAP source that is then activated and " +
        "executed — a quote, a period or a newline is refused outright, not escaped or stripped.",
    );
  }
  if (value === "LOCAL") {
    throw new AbapError(
      "BAD_INPUT",
      `${what} "LOCAL" is refused by this bridge — a local ($TMP-style) package is created over ` +
        "ordinary ADT REST, not via this classrun bridge, which exists precisely because " +
        "transportable package creation is unreachable there.",
      { what, value },
      'Use ADT REST for a local package: abap_write type=DEVC/K software_component="LOCAL" ' +
        "(there is no mode=create — abap_write's mode is write/delete, and a create is a write " +
        "to a name that does not exist yet).",
    );
  }
  return value;
}

/**
 * `corrNr`, required and validated as an ALREADY gate-judged TRKORR. This
 * module never acquires a transport request of its own — see
 * {@link PackageBridgeParams.corrNr}.
 */
function assertCorrNr(value: string): string {
  if (!isTrkorr(value)) {
    throw new AbapError(
      "BAD_INPUT",
      `corr_nr ${JSON.stringify(value)} is not a transport request/task number this system would ` +
        "issue (e.g. A4HK900121). This module never acquires a request on its own — the caller " +
        "must hand it one that has already been judged by the safety gate.",
      { what: "corrNr", value },
    );
  }
  return value;
}

/**
 * `packageType`: only `"development"` is supported today (→ `PACKTYPE = 'D'`).
 * Anything else is refused rather than silently mapped to the wrong literal.
 */
function assertPackageType(value: string | undefined): "D" {
  if (value === undefined || value === "development") return "D";
  throw new AbapError(
    "BAD_INPUT",
    `package_type ${JSON.stringify(value)} is not supported — only "development" (SCOMPKDTLN-PACKTYPE ` +
      "= 'D') is exposed by this bridge today.",
    { what: "packageType", value },
    "Structure packages, main packages and other PACKTYPE values are not implemented — this is a " +
      "deliberate scope limitation, not an oversight; extend assertPackageType (src/adt/package-create.ts) " +
      "if one of them is needed.",
  );
}

/** Quotes an ALREADY-VALIDATED identifier. Never call on an unvalidated string. */
function quoted(validatedIdentifier: string): string {
  return `'${validatedIdentifier}'`;
}

// ---------------------------------------------------------------------------
// The closed fragment
// ---------------------------------------------------------------------------

export interface PackageBridgeParams {
  /** The DEVC/K being created, e.g. ZTM_COURSE. SCOMPKDTLN-DEVCLASS. */
  packageName: string;
  /** SCOMPKDTLN-CTEXT. */
  description: string;
  /** SCOMPKDTLN-DLVUNIT, e.g. HOME. Never LOCAL — a local package goes over ADT REST. */
  softwareComponent: string;
  /** An ALREADY gate-judged TRKORR. This module never acquires one. */
  corrNr: string;
  /** Parent package. When present, attached in a SECOND step after create — see the constraints. */
  superPackage?: string;
  /** Only "development" is supported today; anything else is refused. */
  packageType?: string;
}

/**
 * Bare `DATA` declarations for `ddicBridgeSource` (no leading `DATA`
 * keyword, which `ddicBridgeSource` prepends itself).
 */
export const PACKAGE_DATA_LINES: readonly string[] = [
  "ls_data    TYPE scompkdtln.",
  "lo_package TYPE REF TO if_package.",
  "ls_tdevc   TYPE tdevc.",
];

/** Prefix of the TDEVC evidence line the generated ABAP writes. */
export const PKG_TDEVC_PREFIX = "ZMCP-PKG-TDEVC>";

export interface TdevcRow {
  readonly devclass: string;
  readonly parentcl: string;
  readonly dlvunit: string;
  readonly korrflag: string;
}

/**
 * Pulls the `PKG_TDEVC_PREFIX` line out of a raw classrun transcript.
 * `undefined` when the line is absent or any `KEY=VALUE` pair is missing —
 * never a half-filled row. `PARENTCL` legitimately comes back EMPTY for a
 * root package — a valid, present value, not a missing one.
 */
export function parseTdevcLine(raw: string): TdevcRow | undefined {
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(PKG_TDEVC_PREFIX)) continue;
    const rest = trimmed.slice(PKG_TDEVC_PREFIX.length).trim();
    const fields: Record<string, string> = {};
    // KEY=VALUE pairs separated by single spaces; values themselves never
    // contain spaces for these four DDIC fields, so a plain split is safe.
    for (const part of rest.split(" ")) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      fields[part.slice(0, eq)] = part.slice(eq + 1).trim();
    }
    const devclass = fields["DEVCLASS"];
    const parentcl = fields["PARENTCL"];
    const dlvunit = fields["DLVUNIT"];
    const korrflag = fields["KORRFLAG"];
    if (
      devclass === undefined ||
      parentcl === undefined ||
      dlvunit === undefined ||
      korrflag === undefined
    ) {
      return undefined;
    }
    return { devclass, parentcl, dlvunit, korrflag };
  }
  return undefined;
}

/**
 * `CL_PACKAGE_FACTORY=>CREATE_NEW_PACKAGE(...)`, optionally followed by a
 * second step to attach a superpackage, then a TDEVC re-read gating
 * `PKG-CONFIRMED`. The constraints below (also inline as ABAP comments) cost
 * a live iteration on A4H. Do not "simplify" them away.
 */
export function packageFragment(p: PackageBridgeParams): string[] {
  const packageName = assertEnhIdentifier(p.packageName, "packageName", { maxLength: PACKAGE_MAX_LENGTH });
  const description = assertAbapText(p.description, "description", CTEXT_MAX_LENGTH);
  const softwareComponent = assertSoftwareComponent(p.softwareComponent);
  const corrNr = assertCorrNr(p.corrNr);
  const packType = assertPackageType(p.packageType);
  const superPackage =
    p.superPackage === undefined
      ? undefined
      : assertEnhIdentifier(p.superPackage, "superPackage", { maxLength: PACKAGE_MAX_LENGTH });

  const lines: string[] = [
    '" --- Constraints proven live on A4H. Do not "simplify" these. ---',
    '" 1. The classrun method must be if_oo_adt_classrun~main, not if_oo_adt_classrun.',
    '"    (ddicBridgeSource already emits the correct form.)',
    '" 2. SCOMPKDTLN has NO DEVLAYER field and no usable COMPONENT field - setting',
    '"    either fails the syntax check.',
    '" 3. SCOMPKDTLN-PDEVCLASS is the TRANSPORT LAYER, not the superpackage. Setting',
    '"    it to a package name silently truncates to 4 characters and short-dumps',
    '"    with LAYER_INVALID. It is never set here; the transport layer is left to',
    '"    the transport route configured for the software component.',
    '" 4. SUPERPACKAGE_IN_TDEVC looks right but is output-only on create - passing it',
    '"    leaves PARENTCL blank. The parent is attached in a SECOND step below.',
    `ls_data-devclass = ${quoted(packageName)}.`,
    `ls_data-ctext    = ${abapLiteral(description)}.`,
    "ls_data-as4user  = sy-uname.",
    `ls_data-dlvunit  = ${quoted(softwareComponent)}.`,
    "ls_data-korrflag = 'X'.",
    `ls_data-packtype = ${quoted(packType)}.`,
    "",
    '" CREATE_NEW_PACKAGE / SAVE / SET_CHANGEABLE raise CLASSIC (non-cx_root)',
    '" exceptions, invisible to the CATCH cx_root around this whole method',
    '" (see ddic-bridge.ts) - CALL METHOD ... EXCEPTIONS OTHERS = 1 is the',
    '" only way to attach EXCEPTIONS at all; functional-call syntax cannot.',
    "CALL METHOD cl_package_factory=>create_new_package",
    "  EXPORTING",
    "    i_reuse_deleted_object = abap_true",
    "  IMPORTING",
    "    e_package               = lo_package",
    "  CHANGING",
    "    c_package_data           = ls_data",
    "  EXCEPTIONS",
    "    OTHERS                   = 1.",
    ...subrcGuardFragment("Creating package"),
    "",
    "CALL METHOD lo_package->save",
    "  EXPORTING",
    `    i_transport_request = ${quoted(corrNr)}`,
    "  EXCEPTIONS",
    "    OTHERS               = 1.",
    ...subrcGuardFragment("Saving package"),
    "",
    '" i_changeable is transcribed from the IF_PACKAGE signature and is NOT',
    '" verified live by this change - see this file\'s header. A wrong name',
    '" fails the generated class\'s OWN syntax check at bridge activation,',
    '" before any mutation runs.',
    "CALL METHOD lo_package->set_changeable",
    "  EXPORTING",
    "    i_changeable = abap_false",
    "  EXCEPTIONS",
    "    OTHERS       = 1.",
    ...subrcGuardFragment("Making package not changeable"),
    "COMMIT WORK.",
    "out->write( 'PKG-CREATED' ).",
  ];

  if (superPackage !== undefined) {
    lines.push(
      "",
      '" Step 2 - the parent CANNOT be set on create (constraint 4 above); the package',
      '" is re-loaded and attached here. LOAD_PACKAGE / SET_CHANGEABLE / SAVE /',
      '" SET_SUPER_PACKAGE_NAME all raise CLASSIC exceptions - see this file\'s header.',
      "CALL METHOD cl_package_factory=>load_package",
      "  EXPORTING",
      `    i_package_name = ${quoted(packageName)}`,
      "  IMPORTING",
      "    e_package      = lo_package",
      "  EXCEPTIONS",
      "    OTHERS         = 1.",
      ...subrcGuardFragment("Loading package"),
      "",
      '" i_changeable - see the unverified-parameter-name note above.',
      "CALL METHOD lo_package->set_changeable",
      "  EXPORTING",
      "    i_changeable = abap_true",
      "  EXCEPTIONS",
      "    OTHERS       = 1.",
      ...subrcGuardFragment("Making package changeable"),
      "",
      '" i_super_package_name is transcribed from the IF_PACKAGE signature and is',
      '" NOT verified live by this change - see this file\'s header. A wrong name',
      '" fails the generated class\'s OWN syntax check at bridge activation, before',
      '" any mutation runs.',
      "CALL METHOD lo_package->set_super_package_name",
      "  EXPORTING",
      `    i_super_package_name = ${quoted(superPackage)}`,
      "  EXCEPTIONS",
      "    OTHERS                = 1.",
      ...subrcGuardFragment("Attaching super package"),
      "",
      "CALL METHOD lo_package->save",
      "  EXCEPTIONS",
      "    OTHERS = 1.",
      ...subrcGuardFragment("Saving package"),
      "",
      "CALL METHOD lo_package->set_changeable",
      "  EXPORTING",
      "    i_changeable = abap_false",
      "  EXCEPTIONS",
      "    OTHERS       = 1.",
      ...subrcGuardFragment("Making package not changeable"),
      "COMMIT WORK.",
      "out->write( 'PKG-PARENT-SET' ).",
    );
  }

  lines.push(
    "",
    '" A tag alone is not proof: the classrun could report success for a row that',
    '" was rolled back. Re-read TDEVC and refuse to write PKG-CONFIRMED unless the',
    "\" row is actually there. (This is still the bridge's own stdout -",
    '" src/tools/write.ts additionally verifies out-of-band.)',
    "\"",
    '" DLVUNIT and KORRFLAG are reported as EVIDENCE, not judged here. Two',
    '" reasons. (a) Any RETURN below this point fires AFTER the create already',
    '" happened, and this bridge does not self-delete on a discrepancy: a hard',
    '" failure here would leave the package behind while telling the caller the',
    '" operation failed - strictly worse than handing back the row and letting the TypeScript layer',
    '" say what it means. (b) The KORRFLAG value TDEVC carries for a',
    "\" transportable package is transcribed from the reporter's run, not",
    '" independently confirmed, so a mismatch is not reliably a defect. The',
    "\" comparison lives in createPackageViaBridge's caller instead, where it is a",
    '" loud note rather than a verdict.',
    `SELECT SINGLE * FROM tdevc INTO @ls_tdevc WHERE devclass = ${quoted(packageName)}.`,
    "IF sy-subrc <> 0.",
    `  out->write( |${DDIC_ERR_PREFIX} TDEVC has no row for ${packageName} after create| ).`,
    "  RETURN.",
    "ENDIF.",
    `out->write( |${PKG_TDEVC_PREFIX} DEVCLASS={ ls_tdevc-devclass } PARENTCL={ ls_tdevc-parentcl } DLVUNIT={ ls_tdevc-dlvunit } KORRFLAG={ ls_tdevc-korrflag }| ).`,
  );

  // PARENTCL is not judged here either: the package already exists, and this
  // bridge does not self-delete on a discrepancy, so the row is handed back
  // for {@link tdevcDiscrepancies} to compare instead of failing a create
  // that already happened.
  lines.push("out->write( 'PKG-CONFIRMED' ).");

  return lines;
}

/**
 * Compares the TDEVC evidence row against what the create asked for; one
 * sentence per discrepancy, empty when it matches. This is the judgement the
 * generated ABAP deliberately doesn't make (see {@link packageFragment}) —
 * every check here runs AFTER a create that already happened and this bridge
 * does not self-delete, so a discrepancy means "exists, but not quite as
 * asked" (deletable afterwards via `abap_write mode=delete`, while empty —
 * see `./package-delete.ts`), never "nothing happened".
 */
export function tdevcDiscrepancies(
  row: TdevcRow | undefined,
  expect: { softwareComponent: string; superPackage?: string },
): string[] {
  if (row === undefined) {
    return [
      `The bridge wrote no ${PKG_TDEVC_PREFIX} evidence line, so the TDEVC row could not be ` +
        "compared against what was requested. This is not evidence of failure — the PKG-CONFIRMED " +
        "tag is only written after the row was read back successfully — but it is not confirmation " +
        "of the row's contents either.",
    ];
  }
  const out: string[] = [];
  if (row.dlvunit !== expect.softwareComponent) {
    out.push(
      `TDEVC-DLVUNIT is ${JSON.stringify(row.dlvunit)}, not the requested software component ` +
        `${JSON.stringify(expect.softwareComponent)}. The package exists; check it in SE21 before ` +
        "writing into it, or delete it with abap_write mode=delete while it is still empty.",
    );
  }
  if (row.korrflag !== "X") {
    out.push(
      `TDEVC-KORRFLAG is ${JSON.stringify(row.korrflag)}, not the "X" the create set on ` +
        "SCOMPKDTLN. Whether TDEVC stores that flag back verbatim for a transportable package has " +
        "not been independently confirmed by this codebase, so this may be normal — but if the " +
        "package turns out not to demand a transport when written into, this is the first thing " +
        "to look at.",
    );
  }
  const wantParent = expect.superPackage;
  if (wantParent !== undefined && row.parentcl !== wantParent) {
    out.push(
      `TDEVC-PARENTCL is ${JSON.stringify(row.parentcl)}, not the requested parent ` +
        `${JSON.stringify(wantParent)} — the second (LOAD_PACKAGE / SET_SUPER_PACKAGE_NAME) step ` +
        "did not take effect. The package itself exists as a ROOT package; attach the parent by " +
        "hand in SE21, or delete it with abap_write mode=delete while it is still empty and " +
        "recreate it with the right parent.",
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// The operation
// ---------------------------------------------------------------------------

/**
 * Create a `DEVC/K` package via the DDIC classrun bridge. Order, mirroring
 * `./tran-create.ts`: (1) validate every caller string — safe standalone even
 * though {@link packageFragment} validates again; (2) {@link assertBridgeMutation}
 * on the domain object, zero-network, before any ABAP is generated; (3) build
 * source; (4) deploy + execute + assert transcript, then parse TDEVC.
 */
export async function createPackageViaBridge(
  conn: AbapConnection,
  gate: SafetyGate,
  params: PackageBridgeParams & {
    /** Passed straight to `assertBridgeMutation`; `false` for a create. */
    exists?: boolean;
    /**
     * Whether `corrNr` was named by a human (`preflightPackageCorr`'s
     * `config-pin`/`caller`) or picked by the server (everything else) — see
     * `SafetyCorr` (src/safety.ts). Threaded into the second gate call below
     * so a refusal names the real request, never a fabricated `"auto"`.
     * Defaults to `"auto"`, matching this module's behaviour before `corr`
     * existed here (the default `ABAP_ALLOW_TRANSPORTS=["auto"]` allowlist
     * still matches by `source`, not by this literal number).
     */
    corrSource?: "named" | "auto";
  },
): Promise<{ run: RunResult; transcript: DdicTranscript; tdevc?: TdevcRow }> {
  // 1 — re-validated inside packageFragment too (exported, must be safe standalone).
  const packageName = assertEnhIdentifier(params.packageName, "packageName", {
    maxLength: PACKAGE_MAX_LENGTH,
  });
  const description = assertAbapText(params.description, "description", CTEXT_MAX_LENGTH);
  const softwareComponent = assertSoftwareComponent(params.softwareComponent);
  const corrNr = assertCorrNr(params.corrNr);
  assertPackageType(params.packageType);
  const superPackage =
    params.superPackage === undefined
      ? undefined
      : assertEnhIdentifier(params.superPackage, "superPackage", { maxLength: PACKAGE_MAX_LENGTH });

  // 2 — the second gate, on the domain object, zero-network, before any ABAP is generated.
  // `deployBridge`'s own gate only covers ZCL_ZMCP_DDIC_CPKG in $TMP — a different
  // object entirely — and a package has no activation step, hence activate: false.
  // `corr` carries the REAL corrNr (always known here — assertCorrNr already
  // required it) so the transport allowlist judges and, on refusal, names
  // the actual request rather than a synthesised "auto".
  const corr: SafetyCorr = { kind: "transport", corrNr, source: params.corrSource ?? "auto" };
  assertBridgeMutation(
    gate,
    {
      type: "DEVC/K",
      name: packageName,
      // A package create's allowlist question is answered by the SUPERPACKAGE,
      // not by the package's own not-yet-existing name — see src/safety.ts and
      // the identical construction in preflightCorr (src/adt/write.ts).
      packageName: superPackage ?? packageName,
      ...(superPackage !== undefined ? { superPackage } : {}),
      exists: params.exists ?? false,
    },
    { activate: false, corr },
  );

  // 3
  const source = ddicBridgeSource(
    DDIC_BRIDGE_CLASS.createPackage,
    PACKAGE_DATA_LINES,
    packageFragment({
      packageName,
      description,
      softwareComponent,
      corrNr,
      superPackage,
      packageType: params.packageType,
    }),
  );

  // 4
  const expectTags = (
    superPackage !== undefined
      ? (["PKG-CREATED", "PKG-PARENT-SET", "PKG-CONFIRMED"] as const)
      : (["PKG-CREATED", "PKG-CONFIRMED"] as const)
  );
  // PKG-CREATED fires only after create_new_package + save (with corrNr) + set_changeable(false)
  // + COMMIT WORK all succeeded — see packageFragment. set_super_package_name (if any) runs
  // strictly AFTER this tag, so "not attached to a super package" is accurate at this point.
  // PKG-PARENT-SET fires only after the reload + set_super_package_name + save +
  // set_changeable(false) + COMMIT WORK of the second step all succeeded.
  const { run, transcript } = await runDdicBridge(conn, gate, {
    className: DDIC_BRIDGE_CLASS.createPackage,
    source,
    description: `abapsmith create-package bridge (${packageName})`,
    what: `Creating package ${packageName}`,
    expectTags,
    completed: {
      "PKG-CREATED": `package ${packageName} was created and saved on ${conn.cfg.sid} — it exists, it is NOT attached to a super package, and abapsmith did not delete it`,
      ...(superPackage !== undefined
        ? {
            "PKG-PARENT-SET": `package ${packageName} was then attached to super package ${superPackage} and saved on ${conn.cfg.sid}`,
          }
        : {}),
    },
    partialHint:
      "SAP may also have created a transport request and a task to hold the new package's lock. " +
      "abapsmith did not create them and cannot see them from this response — abap_transport " +
      "operation=list shows the requests owned by this user.",
  });
  const tdevc = parseTdevcLine(transcript.raw);
  return { run, transcript, tdevc };
}
