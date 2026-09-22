/**
 * `DEVC/K` (package) delete — `CL_PACKAGE_FACTORY`, over the fluid `classic`
 * tool (`delete_package`, body class `ZCL_ZMCP_FLUID_CLASSIC`).
 *
 * No ADT REST delete route exists for a package, so this reaches
 * `CL_PACKAGE_FACTORY` the same way `./package-create.ts` does, now through
 * the shared classic body class rather than a per-call generated class.
 *
 * `IF_PACKAGE~DELETE`'s failure behaviour has not been verified against a
 * live system — see step 5's TDEVC re-read in `abap-package.ts`'s
 * `delete_package` method.
 *
 * STOP-THE-LINE follow-up: `LOAD_PACKAGE`/`SET_CHANGEABLE`/`DELETE`/`SAVE`
 * all raise CLASSIC (non-`cx_root`) exceptions, invisible to a plain `TRY ...
 * CATCH cx_root`. This fired live: a LOCKED package's
 * `set_changeable( abap_true )` triggered `OBJECT_LOCKED_BY_OTHER_USER` (a
 * plain, non-class-based exception raised inside `CL_PACKAGE`), the
 * generated class short-dumped, and the dump destroyed the whole tagged
 * transcript — including the `PKG-EMPTY` evidence already written by step 3.
 * Every such call in `abap-package.ts`'s `delete_package` method is now
 * `CALL METHOD ... EXCEPTIONS OTHERS = 1` (functional-call syntax like
 * `lo_package->delete( )` cannot carry an `EXCEPTIONS` clause at all),
 * guarded immediately after by an explicit `sy-subrc` check, so a classic
 * exception now produces a clean `fail(...)` line — parsed into a
 * `CHECK_FAILED` — instead of a dump. `OTHERS` (never a named exception like
 * `object_locked_by_other_user`) is deliberate: naming one that isn't in the
 * method's real signature on this system is a hard syntax error, and that
 * signature has not been (cannot safely be) verified live for this change.
 *
 * One `EXPORTING` parameter name this rewrite had to supply BY HAND
 * (`i_changeable` for `set_changeable`) is transcribed from the
 * `IF_PACKAGE` signature, not live-verified — see the inline ABAP comments
 * at that call site in `abap-package.ts`. (`./package-create.ts` additionally
 * supplies `i_super_package_name`, unverified the same way — this file has
 * no `set_super_package_name` call.)
 *
 * `ZMCP-PKG-CONTENT>` OBJECT rows also carry TADIR `DELFLAG` and, when it is
 * `X`, the E071/E070 request/task already holding that object's deletion
 * (issue #185) — a TADIR row with `DELFLAG=X` is not still "in" the package,
 * only pending a transport release, and `beforeAssert` below treats it as such.
 */

import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import type { AbapIdentifierOptions, SafetyCorr, SafetyGate } from "../safety.js";
import type { RunResult } from "./run.js";
import { assertBridgeMutation } from "./bridge-mutation.js";
import type { DdicTranscript } from "./ddic-transcript.js";
import { runClassicAction } from "./classic-call.js";
import { assertEnhIdentifier } from "./enhancement-templates.js";
import { isTrkorr } from "./transports.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** `TDEVC-DEVCLASS` is CHAR30, same limit `./package-create.ts` validates its `packageName` against. */
const PACKAGE_MAX_LENGTH = 30;

// allowLocal: every local package name starts with `$` (e.g. `$TMP`, and
// `$ZTMD_PKG_01` created by ./package-create.ts over REST) — without it a
// local package could be created but never deleted.
const PACKAGE_RULES: AbapIdentifierOptions = { maxLength: PACKAGE_MAX_LENGTH, allowLocal: true };

/**
 * The step name `abap-package.ts`'s `delete_package` method's `fail(...)`
 * writes for `lo_package->set_changeable( abap_true )` — exported so
 * {@link deletePackageViaBridge}'s `beforeAssert` can recognise exactly this
 * failure (by the same string the ABAP writes) and surface a lock-shaped
 * hint. Live incident: this is the call that actually short-dumped with
 * `OBJECT_LOCKED_BY_OTHER_USER` on A4H before this guard existed — see the
 * module header.
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

// ---------------------------------------------------------------------------
// Params and content-evidence parsing
// ---------------------------------------------------------------------------

export interface PackageDeleteParams {
  packageName: string;
  /** Transport for the delete, or "" for a local package that needs none. */
  corrNr: string;
}

/** Prefix of the tagged evidence lines listing what is still inside the package. */
export const PKG_CONTENT_PREFIX = "ZMCP-PKG-CONTENT>";

export interface PackageContent {
  /** "OBJECT" for a TADIR row, "SUBPKG" for a child package. */
  kind: "OBJECT" | "SUBPKG";
  pgmid: string;
  object: string;
  name: string;
  /** Present only when the ABAP reported TADIR DELFLAG=X for this row. */
  deleted?: true;
  /** The open request holding the deletion, when E071/E070 found one. */
  trkorr?: string;
  /** The task the E071 row sits on, when the request was found via a task. */
  task?: string;
}

/**
 * Parses `ZMCP-PKG-CONTENT>` lines out of a classrun transcript. Mirrors
 * `./package-create.ts`'s `parseTdevcLine` discipline (malformed rows
 * dropped, not half-trusted), extended to collect every match since a
 * non-empty package can have many.
 */
export function parsePackageContents(raw: string): { contents: PackageContent[] } {
  const contents: PackageContent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
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
    const entry: PackageContent = { kind, pgmid, object, name };
    // DELFLAG/TRKORR/TASK only exist on OBJECT rows (SUBPKG lines never emit them).
    if (fields["DELFLAG"] === "X") {
      entry.deleted = true;
      if (fields["TRKORR"]) entry.trkorr = fields["TRKORR"];
      if (fields["TASK"]) entry.task = fields["TASK"];
    }
    contents.push(entry);
  }
  return { contents };
}

// ---------------------------------------------------------------------------
// The operation
// ---------------------------------------------------------------------------

/**
 * Delete a `DEVC/K` package over the fluid `classic` tool. Mirrors
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
): Promise<{ run: RunResult; transcript: DdicTranscript; contents: PackageContent[] }> {
  // 1 — safe standalone.
  const packageName = assertEnhIdentifier(params.packageName, "packageName", PACKAGE_RULES);
  const corrNr = assertOptionalCorrNr(params.corrNr);

  // 2 — the second gate, on the domain object, zero-network, before the classic action runs.
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

  // 3 — `beforeAssert` turns two specific, legitimate-but-unhelpful outcomes
  // into a named error instead of the generic "missing tag" the transcript
  // assertion would otherwise give:
  //  (a) a non-empty package (see abap-package.ts's delete_package step 3), and
  //  (b) a classic-exception guard tripping on SET_CHANGEABLE — by far the
  //      most likely real-world cause (a lock), even though EXCEPTIONS
  //      OTHERS never tells us which classic exception actually fired
  //      (live incident: OBJECT_LOCKED_BY_OTHER_USER short-dumped here
  //      before the guard existed).
  const beforeAssert = (transcript: DdicTranscript): void => {
    const { contents } = parsePackageContents(transcript.raw);
    if (contents.length > 0) {
      const live = contents.filter((c) => c.deleted === undefined);
      const pending = contents.filter((c) => c.deleted !== undefined);

      const liveList = live
        .map((c) => `${c.kind === "SUBPKG" ? "sub-package" : "object"} ${c.pgmid} ${c.object} ${c.name}`)
        .join(", ");
      const pendingList = pending
        .map((c) => {
          if (c.trkorr === undefined) {
            return (
              `object ${c.pgmid} ${c.object} ${c.name} (deleted, awaiting release of a request this ` +
              "server could not find — no open E071 row)"
            );
          }
          const taskPart = c.task !== undefined ? `, task ${c.task}` : "";
          return `object ${c.pgmid} ${c.object} ${c.name} (deleted, awaiting release of request ${c.trkorr}${taskPart})`;
        })
        .join(", ");
      // unique, in order of first appearance
      const pendingRequests: string[] = [];
      for (const c of pending) {
        if (c.trkorr !== undefined && !pendingRequests.includes(c.trkorr)) pendingRequests.push(c.trkorr);
      }

      if (live.length === 0 && pending.length > 0) {
        const releaseSentence =
          pendingRequests.length > 0
            ? `Releasing ${pendingRequests.join(", ")} will make the package deletable ` +
              "(abap_transport_release); abapsmith does not release a request on the caller's behalf."
            : "The request holding the deletion could not be found from E071; check the objects' " +
              "transport entries (abap_transport check) before retrying.";
        throw new AbapError(
          "TRANSPORT_PENDING",
          `Package ${packageName} was NOT deleted: everything left in it is already deleted and waits ` +
            `for a transport release — ${pendingList}. ${releaseSentence}`,
          { packageName, contents, pendingRequests },
        );
      }

      if (pending.length > 0) {
        throw new AbapError(
          "CHECK_FAILED",
          `Package ${packageName} is not empty and was NOT deleted. It still contains: ${liveList}. ` +
            `Also pending release: ${pendingList}.` +
            " Empty the package first (move or delete its objects and sub-packages, or reassign its " +
            "sub-packages elsewhere) and retry — abapsmith will not delete a package's contents on the " +
            "caller's behalf.",
          { packageName, contents, pendingRequests },
        );
      }

      throw new AbapError(
        "CHECK_FAILED",
        `Package ${packageName} is not empty and was NOT deleted. It still contains: ${liveList}.` +
          " Empty the package first (move or delete its objects and sub-packages, or reassign its " +
          "sub-packages elsewhere) and retry — abapsmith will not delete a package's contents on the " +
          "caller's behalf.",
        { packageName, contents },
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

  const { run, transcript } = await runClassicAction(conn, gate, {
    action: "delete_package",
    args: { package_name: packageName, corr_nr: corrNr },
    what: `Deleting package ${packageName}`,
    // The classic bridge's own targets gate (assertTargetsAgainstGate in
    // src/adt/fluid/dispatch.ts) judges `args.corr_nr` as caller-NAMED unless
    // told otherwise — so a server-pinned or session-resolved request that
    // `preflightCorr` admitted as `source: "auto"` was refused right here under
    // a bare `ABAP_ALLOW_TRANSPORTS=auto` (issue #195: "Transport A4HK900346 is
    // not permitted", named by nobody). Hand it the same provenance the domain
    // gate above just judged, exactly as `createPackageViaBridge` does.
    ...(corr !== undefined ? { corrSource: corr.source } : {}),
    expectTags: ["PKG-EMPTY", "PKG-DELETED", "PKG-GONE"],
    beforeAssert,
  });

  // 4 — success path: nothing was found (a non-empty package's own contents
  // already threw, above, out of beforeAssert), so this is always [] here —
  // parsed the same way for symmetry with the error path rather than
  // hardcoded, so a future change to either path can't silently drift apart.
  const { contents } = parsePackageContents(transcript.raw);
  return { run, transcript, contents };
}
