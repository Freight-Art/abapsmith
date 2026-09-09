/**
 * # Classic DDIC view (`VIEW/DV`) creation, through the fluid `classic` tool
 *
 * ADT REST is GET-only for `VIEW/DV`, but SE11's own view editor writes one
 * through ordinary function modules (`DDIF_VIEW_PUT` + `DDIF_VIEW_ACTIVATE`,
 * function group `SDIC`). This module validates and gates the request, then
 * hands the validated values to {@link runClassicAction} (`./classic-call.ts`),
 * which runs them as the `create_view` action of the fluid `classic` tool —
 * one `ZCL_ZMCP_FLUID_CLASSIC` invoker, not a class generated per call. The
 * ABAP itself now lives in `src/adt/fluid/builtin/classic/abap-view.ts`.
 *
 * Only `DDIF_VIEW_PUT`'s parameter names and exception list were ever
 * captured live (no field of `DD25V`/`DD26V`/`DD27P` was seen filled, and
 * `DDIF_VIEW_ACTIVATE`'s signature was never captured at all). Everything
 * beyond that is marked `ASSUMPTION:` at its point of use and unconfirmed
 * against a live system. Full capture and reasoning:
 * the git history.
 *
 * No SE54/table-maintenance dialog is generated, deliberately:
 * `VIEW_MAINTENANCE_GENERATE` is an interactive-only wizard (`CALL
 * TRANSACTION 'SE55'`) with no headless equivalent inside
 * `IF_OO_ADT_CLASSRUN`. `capabilities.ts`'s `VIEW/DV` entry states the same
 * limit to callers.
 *
 * `DDIF_VIEW_PUT` is an uncommitted, update-task-style write: a live run
 * without an explicit `COMMIT WORK` after PUT and again after ACTIVATE
 * reproduced a false success (tags present, `sy-subrc = 0`, but the view
 * absent on read-back) — `abap-view.ts`'s `create_view` method's two
 * `COMMIT WORK` statements exist because of that incident, not defensively.
 *
 * {@link createClassicView} gates on the VIEW itself via
 * {@link assertBridgeMutation} before dispatching the action — the fluid
 * tool's own gate only judges the invoker class deployment, never the view
 * or its package.
 */

import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import type { AbapIdentifierOptions, SafetyCorr, SafetyGate } from "../safety.js";
import type { RunResult } from "./run.js";
import { assertBridgeMutation } from "./bridge-mutation.js";
import type { DdicTag, DdicTranscript } from "./ddic-transcript.js";
import { runClassicAction } from "./classic-call.js";
import { assertAbapText, assertEnhIdentifier } from "./enhancement-templates.js";
import { isLocalPackageName, isTrkorr } from "./transports.js";

// ---------------------------------------------------------------------------
// Parameters and limits
// ---------------------------------------------------------------------------

export interface ClassicViewParams {
  /** The view to create, e.g. ZTM_V_CARRIER. */
  viewName: string;
  /** Its single base table. */
  baseTable: string;
  /** Base-table fields to project, in order. Must be non-empty. */
  fields: readonly string[];
  /** DD25V-DDTEXT. */
  description: string;
  /** DEVCLASS. */
  packageName: string;
  /**
   * An ALREADY gate-judged TRKORR. `validate()` requires
   * it for a transportable (non-`$`-prefixed) package (`RS_CORR_INSERT` needs
   * one to register the view in CTS) and refuse it for a local, `$`-prefixed
   * package — a local create still calls `RS_CORR_INSERT` and registers the
   * view, but with `korrnum = space` (ABAP's SPACE constant), not a transport
   * request (see {@link isLocalPackage}). The caller (`src/tools/write.ts`)
   * resolves it before calling here — from `corr_nr` or via
   * `preflightPackageCorr` — this module never acquires one itself.
   */
  corrNr?: string;
  /** Whether `corrNr` was named by a human or picked by the server (`preflightPackageCorr`'s "named"/"auto") — see `SafetyCorr` (`../safety.js`). */
  corrSource?: "named" | "auto";
}

/** `DDOBJNAME`/`TABNAME`/`FIELDNAME` are all CHAR30 — the same ceiling `assertEnhIdentifier` defaults to. */
const VIEW_NAME_MAX = 30;

/** `DD25V-DDTEXT` is `AS4TEXT`, CHAR60. */
const VIEW_TEXT_MAX = 60;

/** Keeps the zero-padded `DD27P-OBJPOS` position (4 numeric chars) inside `0001`-`9999`, which `abap-view.ts`'s `create_view` method pads at runtime. */
const MAX_VIEW_FIELDS = 249;

/**
 * Local (non-transportable) package: ANY `$`-prefixed package, per
 * {@link isLocalPackageName} (`safety.ts:1677`/`transport.ts:876`'s rule, not
 * just `$TMP`), compared case-insensitively (`$tmp` == `$TMP` to the
 * server). A local view still runs `RS_CORR_INSERT` and is registered in
 * TADIR (`VIEW-REGISTERED` tag expected the same as a transportable create),
 * but with `korrnum = space` rather than a TRKORR — proven live on A4H
 * 2026-09-05: a create into `$ZTMD_I09` with `korrnum = space` returned
 * sy-subrc 0 and wrote a TADIR row with devclass `$ZTMD_I09`, and the view
 * was afterwards removed cleanly by the delete bridge. `validate` still
 * refuses a `corrNr` supplied for a local package rather than silently
 * ignoring it — there is no transport request for it to attach to. Delegates
 * to `transports.ts`'s shared `$`-prefix rule rather than re-inlining it.
 */
function isLocalPackage(packageName: string): boolean {
  return isLocalPackageName(packageName);
}

/**
 * The would-be ADT URI of a classic view that does not exist yet — the
 * GET-only collection `capabilities.ts`'s `VIEW/DV.bridgeCreate.adtRest`
 * advertises, synthesized because there is nothing to GET. Only ever used as
 * the transport resolver's target label / `<REF>` on request creation, never
 * sent to a CTS classification check.
 */
export function classicViewUri(viewName: string): string {
  return `/sap/bc/adt/ddic/views/${viewName.trim().toLowerCase()}`;
}

/** Package identifier rules, shared between `validate` and {@link assertClassicViewCreateTarget} so the two can't disagree on what counts as local (`allowLocal` for the leading `$`). */
const PACKAGE_RULES: AbapIdentifierOptions = { maxLength: VIEW_NAME_MAX, allowLocal: true };

/**
 * `corrNr`, validated as an ALREADY gate-judged TRKORR — same grammar and
 * shape as `package-create.ts`'s `assertCorrNr`, reusing `transports.ts`'s
 * `isTrkorr` rather than inventing a second one.
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
 * No-network check: does this package/corr_nr pairing make sense for a
 * classic view create, on its own terms? A local (`$`-prefixed) package
 * refuses a `corrNr` — it registers with `korrnum = space`, not a transport
 * request, so there is nothing for one to attach to. A supplied `corrNr` must
 * be TRKORR-shaped ({@link isTrkorr}). It does NOT require a `corrNr` for a
 * transportable package — {@link validate} owns that invariant, since the
 * caller may resolve one after this runs. `abapCreateViaBridge`
 * (`src/tools/write.ts`) calls this before its pre-create read, so a bad
 * pair fails before any ADT traffic.
 */
export function assertClassicViewCreateTarget(
  packageName: string,
  corrNr: string | undefined,
): string {
  const validated = assertEnhIdentifier(packageName, "packageName", PACKAGE_RULES);
  const local = isLocalPackage(validated);
  if (local && corrNr !== undefined) {
    throw new AbapError(
      "BAD_INPUT",
      `corr_nr ${JSON.stringify(corrNr)} was supplied for local package ${JSON.stringify(validated)}, ` +
        "but a local ($-prefixed) view is registered with korrnum = space rather than on a " +
        "transport request, so there is nothing here for one to attach to.",
      { packageName: validated, corrNr },
    );
  }
  if (corrNr !== undefined) assertCorrNr(corrNr);
  return validated;
}

/** Every caller string validated once, so the fragment can never see a raw one. */
function validate(p: ClassicViewParams): ClassicViewParams {
  const viewName = assertEnhIdentifier(p.viewName, "viewName", { maxLength: VIEW_NAME_MAX });
  const baseTable = assertEnhIdentifier(p.baseTable, "baseTable", { maxLength: VIEW_NAME_MAX });
  if (!Array.isArray(p.fields) || p.fields.length === 0) {
    throw new AbapError(
      "BAD_INPUT",
      "fields must be a non-empty list of base-table field names — a classic view projecting no " +
        "field at all is not a view SE11 or DDIF_VIEW_PUT would accept.",
      { viewName, baseTable },
    );
  }
  if (p.fields.length > MAX_VIEW_FIELDS) {
    throw new AbapError(
      "BAD_INPUT",
      `fields has ${p.fields.length} entries, more than the ${MAX_VIEW_FIELDS} this bridge generates. ` +
        "DD27P-OBJPOS is a 4-character numeric position and this bridge fills it by zero-padding a " +
        "1-based index, so every generated position must stay inside 0001-9999.",
      { viewName, count: p.fields.length, max: MAX_VIEW_FIELDS },
    );
  }
  const fields = p.fields.map((f, i) =>
    assertEnhIdentifier(f, `fields[${i}]`, { maxLength: VIEW_NAME_MAX }),
  );
  const description = assertAbapText(p.description, "description", VIEW_TEXT_MAX);
  const packageName = assertClassicViewCreateTarget(p.packageName, p.corrNr);
  const local = isLocalPackage(packageName);
  // This module never acquires a request itself — the caller resolves one (corr_nr, or
  // preflightPackageCorr) before calling here — but a transportable package must still
  // arrive with one: runClassicAction requires corr_nr present on every call, and an
  // absent one would silently register with korrnum = space on a transportable package.
  if (!local && p.corrNr === undefined) {
    throw new AbapError(
      "TRANSPORT_ERROR",
      `packageName ${JSON.stringify(packageName)} is not local ($-prefixed), so this view must be ` +
        "registered in CTS via RS_CORR_INSERT, which requires a transport request — pass corr_nr " +
        "(an ALREADY gate-judged TRKORR, e.g. A4HK900121).",
      { packageName },
      "Via abap_write, pass corr_nr with the TRKORR the safety gate already judged for this write " +
        "(see the abapsmith-put-work-on-a-transport skill).",
    );
  }
  const corrNr = local ? undefined : (p.corrNr as string);
  return { viewName, baseTable, fields, description, packageName, corrNr, corrSource: p.corrSource };
}

// ---------------------------------------------------------------------------
// The operation
// ---------------------------------------------------------------------------

/**
 * `completed`/`hint` for {@link runClassicAction}'s partial-success
 * reporting: `RS_CORR_INSERT` runs before `DDIF_VIEW_PUT` for every package
 * (see `abap-view.ts`'s `create_view` method), so a later failure can leave
 * either just a TADIR entry, or that plus a committed-but-inactive view.
 * Exported so the shape is testable without a live transcript.
 */
export function viewCreatePartialSuccess(viewName: string): {
  completed: Readonly<Partial<Record<DdicTag, string>>>;
  hint: string;
} {
  return {
    completed: {
      "VIEW-REGISTERED": `RS_CORR_INSERT registered ${viewName} in TADIR — on the transport request for a transportable package, with korrnum = space for a local one — before any dictionary write; no view was created by it.`,
      "VIEW-PUT": `DDIF_VIEW_PUT wrote ${viewName}, and the COMMIT WORK that follows it committed it, inactive.`,
    },
    hint:
      `If VIEW-PUT fired, ${viewName} exists AND is registered — abap_write mode="delete" ` +
      `type="VIEW/DV" can remove it. If only VIEW-REGISTERED fired, no view was written and only ` +
      "the TADIR entry exists — for a transportable package, remove it from the request in " +
      "SE09/SE10, or reuse it by re-running the create into the same request; for a local " +
      "package (korrnum = space) it is registered but not on any request.",
  };
}

/**
 * Create one classic database view: validate, gate the VIEW, then dispatch
 * the `create_view` action of the fluid `classic` tool and assert the
 * transcript. `validate()` (via {@link assertClassicViewCreateTarget}) runs
 * first — `BAD_INPUT`/`TRANSPORT_ERROR` before anything else — then
 * {@link assertBridgeMutation} on the VIEW (zero-network, so a refusal
 * dispatches nothing), only then {@link runClassicAction}.
 *
 * `expectTags` is `VIEW-REGISTERED`, `VIEW-PUT`, `VIEW-ACTIVATED` for every
 * package: `RS_CORR_INSERT` registers a local package too (with
 * `korrnum = space`), so registration is expected regardless of
 * {@link isLocalPackage}. Proven live on A4H: a transportable create into
 * a transportable package with a task succeeded 2026-09-04; a local create into
 * `$ZTMD_I09` with `korrnum = space` succeeded 2026-09-05 (sy-subrc 0, a
 * TADIR row written, the view then removed cleanly by the delete bridge).
 *
 * `corr`'s `source` reflects however the caller resolved `corrNr` — `"named"`
 * by default (a caller-supplied `corr_nr`), or `"auto"` when the caller
 * passes `corrSource: "auto"` (`preflightPackageCorr` picked the request) —
 * same shape as `package-create.ts`'s `createPackageViaBridge`.
 */
export async function createClassicView(
  conn: AbapConnection,
  gate: SafetyGate,
  params: ClassicViewParams,
): Promise<{ run: RunResult; transcript: DdicTranscript }> {
  const validated = validate(params);
  const { viewName, baseTable, fields, description, packageName, corrNr, corrSource } = validated;

  const corr: SafetyCorr | undefined = isLocalPackage(packageName)
    ? undefined
    : { kind: "transport", corrNr: corrNr as string, source: corrSource ?? "named" };

  // Gate on the domain object itself, zero-network, before dispatching the fluid action.
  // activate: true because DDIF_VIEW_ACTIVATE runs inside the same invocation.
  assertBridgeMutation(
    gate,
    { type: "VIEW/DV", name: viewName, packageName },
    { activate: true, ...(corr !== undefined ? { corr } : {}) },
  );

  const expectTags: DdicTag[] = ["VIEW-REGISTERED", "VIEW-PUT", "VIEW-ACTIVATED"];
  const partial = viewCreatePartialSuccess(viewName);

  return runClassicAction(conn, gate, {
    action: "create_view",
    args: {
      view_name: viewName,
      base_table: baseTable,
      fields,
      description,
      package_name: packageName,
      corr_nr: corrNr ?? "",
    },
    what: `Creating classic view ${viewName}`,
    expectTags,
    completed: partial.completed,
    partialHint: partial.hint,
  });
}
