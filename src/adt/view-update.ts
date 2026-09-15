/**
 * # Classic DDIC view (`VIEW/DV`) update, through the fluid `classic` tool
 *
 * Sibling of `./view-create.ts`'s `createClassicView`: same args shape
 * ({@link ClassicViewParams}), same validation
 * ({@link assertClassicViewCreateTarget}), same gating discipline
 * ({@link assertBridgeMutation} before dispatch), dispatching
 * `update_view` instead of `create_view`. The ABAP lives in
 * `src/adt/fluid/builtin/classic/abap-view.ts`'s `update_view` method,
 * which mirrors `create_view`'s DD25V/DD26V/DD27P fill and
 * `DDIF_VIEW_PUT`/`DDIF_VIEW_ACTIVATE` sequence exactly, but only against a
 * view that already exists (a pre-check refuses a name that doesn't).
 *
 * `DDIF_VIEW_PUT` replaces the whole definition: any joined table or field
 * not passed in this call is removed — `abap-view.ts`'s `update_view`
 * method emits a `ZMCP-DDIC-NOTE>` line saying so, matching
 * `create_view`'s own uncommitted-write/`COMMIT WORK` discipline.
 *
 * Proven live on A4H (NetWeaver 7.54, client 001) 2026-09-12, in `$TMP`
 * only: `DDIF_VIEW_PUT` returned message D0322, activation returned
 * `sy-subrc = 0`, and a read-back showed the field count going from 2 to 3.
 * The transportable (non-`$TMP`) path runs the identical FM sequence with a
 * real `korrnum` but has NOT itself been run against a live system.
 */

import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import type { SafetyCorr, SafetyGate } from "../safety.js";
import type { RunResult } from "./run.js";
import { assertBridgeMutation } from "./bridge-mutation.js";
import type { DdicTag, DdicTranscript } from "./ddic-transcript.js";
import { runClassicAction } from "./classic-call.js";
import { assertAbapText, assertEnhIdentifier } from "./enhancement-templates.js";
import { isLocalPackageName } from "./transports.js";
import {
  assertClassicViewCreateTarget,
  MAX_VIEW_FIELDS,
  VIEW_NAME_MAX,
  VIEW_TEXT_MAX,
  type ClassicViewParams,
} from "./view-create.js";

/**
 * Update an EXISTING classic database view: validate (via
 * {@link assertClassicViewCreateTarget}, the same package/corr_nr pairing
 * rule `./view-create.ts` uses), gate the VIEW, then dispatch the
 * `update_view` action of the fluid `classic` tool and assert the
 * transcript. `expectTags` is `VIEW-REGISTERED`, `VIEW-UPDATED`,
 * `VIEW-ACTIVATED` — read off `abap-view.ts`'s `update_view` method's own
 * `line(...)` calls, not assumed from `create_view`'s tag set.
 */
export async function updateClassicView(
  conn: AbapConnection,
  gate: SafetyGate,
  params: ClassicViewParams,
): Promise<{ run: RunResult; transcript: DdicTranscript }> {
  // Same validation as ./view-create.ts's createClassicView (via its internal validate()):
  // identical helper calls, field names, length limits and error shapes — see that
  // module's VIEW_NAME_MAX/VIEW_TEXT_MAX/MAX_VIEW_FIELDS doc comments for why an
  // unvalidated viewName/baseTable/fields entry/description must never reach
  // abap-view.ts's update_view, which assigns them into CHAR30/CHAR60 structure
  // fields that silently truncate rather than reject an over-length value.
  const viewName = assertEnhIdentifier(params.viewName, "viewName", { maxLength: VIEW_NAME_MAX });
  const baseTable = assertEnhIdentifier(params.baseTable, "baseTable", { maxLength: VIEW_NAME_MAX });
  if (!Array.isArray(params.fields) || params.fields.length === 0) {
    throw new AbapError(
      "BAD_INPUT",
      "fields must be a non-empty list of base-table field names — an update replaces the whole " +
        "field list, and DDIF_VIEW_PUT would not accept a view projecting no field at all.",
      { viewName, baseTable },
    );
  }
  if (params.fields.length > MAX_VIEW_FIELDS) {
    throw new AbapError(
      "BAD_INPUT",
      `fields has ${params.fields.length} entries, more than the ${MAX_VIEW_FIELDS} this bridge ` +
        "generates. DD27P-OBJPOS is a 4-character numeric position and this bridge fills it by " +
        "zero-padding a 1-based index, so every generated position must stay inside 0001-9999.",
      { viewName, count: params.fields.length, max: MAX_VIEW_FIELDS },
    );
  }
  const fields = params.fields.map((f, i) =>
    assertEnhIdentifier(f, `fields[${i}]`, { maxLength: VIEW_NAME_MAX }),
  );
  const description = assertAbapText(params.description, "description", VIEW_TEXT_MAX);
  const packageName = assertClassicViewCreateTarget(params.packageName, params.corrNr);
  const local = isLocalPackageName(packageName);

  if (!local && params.corrNr === undefined) {
    throw new AbapError(
      "TRANSPORT_ERROR",
      `packageName ${JSON.stringify(packageName)} is not local ($-prefixed), so this view update must ` +
        "be registered in CTS via RS_CORR_INSERT, which requires a transport request — pass corr_nr " +
        "(an ALREADY gate-judged TRKORR, e.g. A4HK900121).",
      { packageName },
      "Via abap_write, pass corr_nr with the TRKORR the safety gate already judged for this write " +
        "(see the abapsmith-put-work-on-a-transport skill).",
    );
  }
  const corrNr = local ? undefined : params.corrNr;

  const corr: SafetyCorr | undefined = local
    ? undefined
    : { kind: "transport", corrNr: corrNr as string, source: params.corrSource ?? "named" };

  // Gate on the domain object itself, zero-network, before dispatching the fluid action.
  // activate: true because DDIF_VIEW_ACTIVATE runs inside the same invocation.
  assertBridgeMutation(
    gate,
    { type: "VIEW/DV", name: viewName, packageName },
    { activate: true, ...(corr !== undefined ? { corr } : {}) },
  );

  // beforeAssert turns the "view does not exist" transcript into a clear named error
  // instead of the generic missing-tag CHECK_FAILED the plain assertion would otherwise
  // give — same shape as view-delete.ts's beforeAssert.
  const beforeAssert = (transcript: DdicTranscript): void => {
    if (transcript.errorLine?.includes(`${viewName} does not exist`)) {
      throw new AbapError(
        "CHECK_FAILED",
        `View ${viewName} does not exist, so there is nothing to update. Raw ABAP-side detail: ` +
          `${transcript.errorLine}`,
        { viewName, raw: transcript.raw },
      );
    }
  };

  const expectTags: DdicTag[] = ["VIEW-REGISTERED", "VIEW-UPDATED", "VIEW-ACTIVATED"];

  return runClassicAction(conn, gate, {
    action: "update_view",
    args: {
      view_name: viewName,
      base_table: baseTable,
      fields,
      description,
      package_name: packageName,
      corr_nr: corrNr ?? "",
    },
    what: `Updating classic view ${viewName}`,
    expectTags,
    beforeAssert,
  });
}
