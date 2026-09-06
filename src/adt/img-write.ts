/**
 * IMG customizing write orchestration: the deploy-then-execute choreography
 * for the probe/apply generated bridges (`img-write-bridge.ts`) and for the
 * customizing-request-creation bridge (`customizing-request.ts`). Writing
 * still needs a generated ABAP bridge (ADT has no IMG REST route); reading
 * does not — `src/adt/img-read.ts` reads catalog tables straight through the
 * freestyle data-preview endpoint and deploys nothing.
 *
 * This module contributes ONLY that choreography. Every plan-validation
 * rule, ABAP fragment and transcript-parsing rule already lives in
 * `img-write-bridge.ts`, `customizing-request.ts` or `img-write-policy.ts`;
 * nothing here duplicates any of them — each function below calls straight
 * through to the one place that logic is allowed to exist.
 *
 * All three bridges land in `HELPER_PACKAGE` (`$ZMCP_HELPERS`), never `$TMP`
 * — see `helper-package.ts`.
 */
import type { AbapConnection } from "./connection.js";
import type { SafetyGate } from "../safety.js";
import { deployBridge, executeBridge, verifyBridgeActivation } from "./run.js";
import { ensureHelperPackage, HELPER_PACKAGE } from "./helper-package.js";
import {
  IMGW_BRIDGE_CLASS,
  validateProbePlan,
  validateApplyPlan,
  imgProbeSource,
  imgApplySource,
  parseImgWriteTranscript,
  type ImgProbePlan,
  type ImgApplyPlan,
  type ImgWriteTranscript,
} from "./img-write-bridge.js";
import {
  CUSTOMIZING_REQUEST_CLASS,
  validateCustomizingRequestPlan,
  customizingRequestSource,
  parseCustomizingRequestTranscript,
  type CustomizingRequestPlan,
  type CustomizingRequestTranscript,
} from "./customizing-request.js";

export interface ImgProbeResult {
  plan: ImgProbePlan;
  bridgeClass: string;
  bridgeRefreshed: boolean;
  durationMs: number;
  transcript: ImgWriteTranscript;
  outputComplete: boolean;
  bodyBytes: number;
}

export interface ImgApplyResult {
  plan: ImgApplyPlan;
  bridgeClass: string;
  bridgeRefreshed: boolean;
  durationMs: number;
  transcript: ImgWriteTranscript;
  outputComplete: boolean;
  bodyBytes: number;
}

export interface CustomizingRequestResult {
  plan: CustomizingRequestPlan;
  bridgeClass: string;
  bridgeRefreshed: boolean;
  durationMs: number;
  transcript: CustomizingRequestTranscript;
  outputComplete: boolean;
  bodyBytes: number;
}

/**
 * The probe bridge only SELECTs: the target table's rows, `DD02L` (delivery
 * class / client-dependence) and `DD03L` (field catalog) — all named
 * directly from the caller's own plan, nothing derived or guessed. A row
 * VALUE is never a syntax-error suspect here: every value the caller
 * supplies reaches this bridge only as a quoted ABAP literal
 * (`imgProbeSource`/`abapLiteral`), never concatenated into an identifier
 * position.
 */
const PROBE_HINT =
  "The probe only SELECTs the target table plus DD02L/DD03L, all named from the caller's own plan " +
  "(table, keyFields) — a syntax error here most likely means the table does not exist or one of " +
  "keyFields is not really a field on it, as spelled. It is never a symptom of a bad ROW VALUE: those " +
  "reach this bridge only as quoted literals, never as identifiers.";

/**
 * The apply bridge does a direct `MODIFY`/`DELETE` on the target table and
 * then calls the two CTS FMs in `CTS_INSERT_FM` (img-write-bridge.ts) —
 * ordinary, heavily-used standard SAP function modules, not themselves in
 * question. What's UNPROVEN is narrower: this server has never called them,
 * so their parameter names/types here were read from FUPARAREF/DOKTL, not
 * confirmed by a successful call — and the ADT syntax check cannot catch a
 * wrong FM interface (a class calling a nonexistent FM with bogus
 * parameters still checks clean). It DOES catch an ordinary ABAP type error
 * in the generated body, though — customizing-request.ts's 2026-09-06
 * activation failure (`"SY-UNAME" and the row type of "LT_USERS" are
 * incompatible`) is a live example of that check working, not failing. So a
 * syntax error here can equally mean either the field list the probe
 * returned no longer matches the table's real structure (the table changed
 * between probe and apply), or one of those two FMs' parameter names is
 * wrong — not a bad row value, for the same quoted-literal reason as the
 * probe.
 */
const APPLY_HINT =
  "The apply bridge MODIFYs/DELETEs the target table directly and then calls TR_OBJECTS_CHECK/" +
  "TR_OBJECTS_INSERT (see CTS_INSERT_FM) — ordinary standard SAP function modules, but this server " +
  "has never called them, so their parameter names/types here were read from FUPARAREF rather than " +
  "confirmed by a successful call, and the ADT syntax check cannot validate an FM interface. It DOES " +
  "validate ordinary ABAP statements in the generated body, though — a syntax error here can equally " +
  "mean the table's real structure has drifted from the field list the probe returned, or one of " +
  "those two FMs' parameter names is wrong. It is never a symptom of a bad row value, for the same " +
  "quoted-literal reason as the probe bridge.";

/**
 * This bridge only calls `TR_INSERT_REQUEST_WITH_TASKS` (`CUSTOMIZING_REQUEST_FM`,
 * customizing-request.ts) — an ordinary standard SAP function module, not
 * itself in question — with a fixed request type `'W'` and the caller's own
 * description/owner as quoted literals. What's UNPROVEN is that this server
 * has never called it: its parameter names were read from FUPARAREF rather
 * than confirmed by a successful call, and the ADT syntax check cannot
 * catch a wrong FM interface. But that same check DOES validate ordinary
 * ABAP statements in the generated body: on 2026-09-06 it caught
 * `"SY-UNAME" and the row type of "LT_USERS" are incompatible` in this very
 * bridge, before the FM was ever called — see the fix in
 * `customizingRequestBody` (customizing-request.ts). So a syntax error here
 * can be either cause, and it is the quoted activation message — not a
 * guess — that tells them apart; `assertNoErrors` (`./activate.ts`) puts
 * that message into the thrown error's own `message`/`details.messages`,
 * confirmed by reading `checkFailedError` there. Either way the generated
 * class is left behind in the helper package, written but never activated
 * (`discloseBridgeResidue` in `./run.ts` marks this `bridgeLeftBehind: true`
 * and already says it is safe to delete); the exact way to do that is
 * `abap_write {"object":"class ZCL_ZMCP_CTS_WREQ","mode":"delete"}`.
 */
const REQUEST_HINT =
  "This bridge only calls TR_INSERT_REQUEST_WITH_TASKS (see CUSTOMIZING_REQUEST_FM) — an ordinary " +
  "standard SAP function module — with request type 'W' and the caller's description/owner as " +
  "quoted literals. This server has never called it, so its parameter names here were read from " +
  "FUPARAREF rather than confirmed by a successful call, and the ADT syntax check cannot validate " +
  "an FM interface. But that same check DOES validate ordinary ABAP statements in the generated " +
  "body — on 2026-09-06 it caught \"SY-UNAME\" and the row type of \"LT_USERS\" are incompatible in " +
  "this bridge before the FM was ever called — so a syntax error here can be either cause, and the " +
  "quoted activation message is what tells them apart, not a guess. Delete the left-behind bridge " +
  `class with abap_write {"object":"class ${CUSTOMIZING_REQUEST_CLASS}","mode":"delete"}.`;

/** Deploy/run the read-only IMG write probe and return its parsed transcript. */
export async function runImgProbe(
  conn: AbapConnection,
  gate: SafetyGate,
  plan: ImgProbePlan,
): Promise<ImgProbeResult> {
  const started = Date.now();
  validateProbePlan(plan);
  await ensureHelperPackage(conn, gate);

  const className = IMGW_BRIDGE_CLASS.probe;
  const source = imgProbeSource(plan);

  const deployed = await deployBridge(conn, gate, {
    className,
    source,
    description: "abapsmith IMG customizing write probe",
    packageName: HELPER_PACKAGE,
    what: "Activation of the generated IMG write-probe bridge",
    hint: PROBE_HINT,
    verify: (activation) =>
      verifyBridgeActivation(activation, className, "IMG write-probe bridge", { table: plan.table }),
  });
  const { bridgeRefreshed } = deployed;

  const run = await executeBridge(conn, gate, deployed);
  const transcript = parseImgWriteTranscript(run.output);

  return {
    plan,
    bridgeClass: className,
    bridgeRefreshed,
    durationMs: Date.now() - started,
    transcript,
    outputComplete: run.outputComplete,
    bodyBytes: run.bodyBytes,
  };
}

/** Deploy/run the IMG write apply bridge (direct MODIFY/DELETE + CTS recording) and return its parsed transcript. */
export async function runImgApply(
  conn: AbapConnection,
  gate: SafetyGate,
  plan: ImgApplyPlan,
): Promise<ImgApplyResult> {
  const started = Date.now();
  validateApplyPlan(plan);
  await ensureHelperPackage(conn, gate);

  const className = IMGW_BRIDGE_CLASS.apply;
  const source = imgApplySource(plan);

  const deployed = await deployBridge(conn, gate, {
    className,
    source,
    description: "abapsmith IMG customizing write apply",
    packageName: HELPER_PACKAGE,
    what: "Activation of the generated IMG write-apply bridge",
    hint: APPLY_HINT,
    verify: (activation) =>
      verifyBridgeActivation(activation, className, "IMG write-apply bridge", { table: plan.table, op: plan.op }),
  });
  const { bridgeRefreshed } = deployed;

  const run = await executeBridge(conn, gate, deployed);
  const transcript = parseImgWriteTranscript(run.output);

  return {
    plan,
    bridgeClass: className,
    bridgeRefreshed,
    durationMs: Date.now() - started,
    transcript,
    outputComplete: run.outputComplete,
    bodyBytes: run.bodyBytes,
  };
}

/** Deploy/run the customizing-request-creation bridge and return its parsed transcript (request/task numbers). */
export async function runCreateCustomizingRequest(
  conn: AbapConnection,
  gate: SafetyGate,
  plan: CustomizingRequestPlan,
): Promise<CustomizingRequestResult> {
  const started = Date.now();
  validateCustomizingRequestPlan(plan);
  await ensureHelperPackage(conn, gate);

  const className = CUSTOMIZING_REQUEST_CLASS;
  const source = customizingRequestSource(plan);

  const deployed = await deployBridge(conn, gate, {
    className,
    source,
    description: "abapsmith customizing request creation",
    packageName: HELPER_PACKAGE,
    what: "Activation of the generated customizing-request-creation bridge",
    hint: REQUEST_HINT,
    verify: (activation) => verifyBridgeActivation(activation, className, "customizing-request bridge", {}),
  });
  const { bridgeRefreshed } = deployed;

  const run = await executeBridge(conn, gate, deployed);
  const transcript = parseCustomizingRequestTranscript(run.output);

  return {
    plan,
    bridgeClass: className,
    bridgeRefreshed,
    durationMs: Date.now() - started,
    transcript,
    outputComplete: run.outputComplete,
    bodyBytes: run.bodyBytes,
  };
}
