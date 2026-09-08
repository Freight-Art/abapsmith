/**
 * `DEVC/K` (package) create — `CL_PACKAGE_FACTORY`, over the fluid `classic`
 * tool (`create_package`, body class `ZCL_ZMCP_FLUID_CLASSIC`).
 *
 * ADT REST can't create a not-yet-existing package: its CTS pre-flight has no
 * TADIR entry to inspect, always answers `local`, and discards the caller's
 * `corr_nr`. This drives `CL_PACKAGE_FACTORY` directly, now through the
 * shared classic body class rather than a throwaway per-call `$TMP` classrun.
 *
 * The `CREATE_NEW_PACKAGE` recipe and constraints below (mirrored in
 * `src/adt/fluid/builtin/classic/abap-package.ts`'s `create_package` method)
 * were proven live on A4H by direct testing, not by this repo's tests.
 *
 * A package created here is deletable again since `./package-delete.ts` was
 * added, but only while empty. A non-empty package still has no
 * delete/undo path here; SE21 by a human is the only way to remove one.
 *
 * STOP-THE-LINE follow-up (discovered on the delete side, audited back onto
 * this file): `CREATE_NEW_PACKAGE`/`LOAD_PACKAGE`/`SAVE`/`SET_CHANGEABLE`/
 * `SET_SUPER_PACKAGE_NAME` all raise CLASSIC (non-`cx_root`) exceptions — an
 * unguarded one here would short-dump exactly like the live delete-bridge
 * incident did, destroying the transcript. Every such call in
 * `abap-package.ts`'s `create_package` method is `CALL METHOD ... EXCEPTIONS
 * OTHERS = 1`, guarded immediately after by an explicit `sy-subrc` check.
 * `OTHERS`, never a named exception, for the same reason as the delete
 * bridge: this system's exact `IF_PACKAGE` exception signature has not been
 * (cannot safely be) verified live.
 *
 * Two `EXPORTING` parameter names had to be supplied BY HAND for this
 * (`i_changeable` for `set_changeable`, `i_super_package_name` for
 * `set_super_package_name`) — transcribed from the `IF_PACKAGE` interface,
 * not live-verified. A wrong name fails the class's OWN syntax check at
 * deployment, before any mutation runs — loud and safe.
 */

import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import type { SafetyCorr, SafetyGate } from "../safety.js";
import type { RunResult } from "./run.js";
import { assertBridgeMutation } from "./bridge-mutation.js";
import type { DdicTranscript } from "./ddic-transcript.js";
import { runClassicAction } from "./classic-call.js";
import { assertAbapText, assertEnhIdentifier } from "./enhancement-templates.js";
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
 * `SCOMPKDTLN-DLVUNIT`, validated before being handed to the classic action.
 * Own grammar, not `assertEnhIdentifier`'s, since this field is never local:
 * `LOCAL` is refused outright, pointing the caller at ADT REST.
 */
function assertSoftwareComponent(value: string, what = "softwareComponent"): string {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{0,29}$/.test(value)) {
    throw new AbapError(
      "BAD_INPUT",
      `${what} ${JSON.stringify(value)} is not a valid software component for this bridge (a letter, ` +
        "then letters, digits and underscores only, max 30 characters, already upper-cased and " +
        "trimmed by the caller).",
      { what, value },
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
 * `packageType`: only `"development"` is supported today. Anything else is
 * refused rather than silently accepted — the classic action re-checks this
 * same rule itself, but a zero-network `BAD_INPUT` here is cheaper.
 */
function assertPackageType(value: string | undefined): void {
  if (value === undefined || value === "development") return;
  throw new AbapError(
    "BAD_INPUT",
    `package_type ${JSON.stringify(value)} is not supported — only "development" ` +
      "(SCOMPKDTLN-PACKTYPE = 'D') is exposed by this bridge today.",
    { what: "packageType", value },
    "Structure packages, main packages and other PACKTYPE values are not implemented — this is a " +
      "deliberate scope limitation, not an oversight; extend assertPackageType (src/adt/package-create.ts) " +
      "if one of them is needed.",
  );
}

// ---------------------------------------------------------------------------
// Params and TDEVC evidence parsing
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

/** Prefix of the TDEVC evidence line the classic action writes. */
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
 * Compares the TDEVC evidence row against what the create asked for; one
 * sentence per discrepancy, empty when it matches. This is the judgement the
 * classic action deliberately doesn't make (see `abap-package.ts`'s
 * `create_package` method) — every check here runs AFTER a create that
 * already happened and the action does not self-delete, so a discrepancy
 * means "exists, but not quite as asked" (deletable afterwards via
 * `abap_write mode=delete`, while empty — see `./package-delete.ts`), never
 * "nothing happened".
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
 * Create a `DEVC/K` package over the fluid `classic` tool. Order, mirroring
 * `./tran-create.ts`: (1) validate every caller string, zero-network;
 * (2) {@link assertBridgeMutation} on the domain object, zero-network, before
 * any classic action runs; (3) run `create_package` and assert the
 * transcript, then parse TDEVC.
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
  // 1 — safe standalone.
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

  // 2 — the second gate, on the domain object, zero-network, before the classic action runs.
  // The fluid tool's own gate only covers its body class — a different object entirely —
  // and a package has no activation step, hence activate: false.
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

  // 3 — PKG-CREATED fires only after create_new_package + save (with corrNr) + set_changeable(false)
  // + COMMIT WORK all succeeded — see abap-package.ts's create_package method. set_super_package_name
  // (if any) runs strictly AFTER this tag, so "not attached to a super package" is accurate at this
  // point. PKG-PARENT-SET fires only after the reload + set_super_package_name + save +
  // set_changeable(false) + COMMIT WORK of the second step all succeeded.
  const expectTags =
    superPackage !== undefined
      ? (["PKG-CREATED", "PKG-PARENT-SET", "PKG-CONFIRMED"] as const)
      : (["PKG-CREATED", "PKG-CONFIRMED"] as const);
  const { run, transcript } = await runClassicAction(conn, gate, {
    action: "create_package",
    args: {
      package_name: packageName,
      description,
      software_component: softwareComponent,
      corr_nr: corrNr,
      super_package: superPackage ?? "",
      package_type: params.packageType ?? "",
    },
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
