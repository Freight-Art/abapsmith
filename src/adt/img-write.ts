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
 * The probe now runs as the fluid `img` tool's `preview` action
 * (`fluid/dispatch.ts`); the apply and customizing-request bridges still
 * deploy generated classes, landing in `FLUID_PACKAGE` via `deployBridge`'s
 * default.
 */
import type { AbapConnection } from "./connection.js";
import type { Config } from "../config.js";
import type { SafetyGate } from "../safety.js";
import { deployBridge, executeBridge, verifyBridgeActivation } from "./run.js";
import { AbapError, isAbapError } from "./errors.js";
import { imgManifest, imgSources } from "./fluid/builtin/img.js";
import { manifestVersion, type LoadedFluidTool } from "./fluid/manifest.js";
import { dispatch } from "./fluid/dispatch.js";
import {
  IMGW_BRIDGE_CLASS,
  validateProbePlan,
  validateApplyPlan,
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

const IMG_TOOLS: ReadonlyMap<string, LoadedFluidTool> = new Map([
  [
    "img",
    {
      manifest: imgManifest,
      origin: "builtin",
      sources: imgSources,
      version: manifestVersion(imgManifest, imgSources),
    } as const,
  ],
]);

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
 * The apply bridge does a direct `MODIFY`/`DELETE` on the target table and
 * then calls the two CTS FMs in `CTS_INSERT_FM` (img-write-bridge.ts) —
 * ordinary, heavily-used standard SAP function modules, not themselves in
 * question. Their parameter names/types here are confirmed by a successful
 * live call, not merely read from FUPARAREF/DOKTL: on 2026-09-06 an armed
 * upsert called both, filing a real `E071`/`E071K` row pair, and a
 * subsequent delete on the same table also succeeded. So a syntax error
 * here is an ordinary ABAP error in the generated body, not a suspected
 * FM-interface problem — most likely the field list the probe returned no
 * longer matches the table's real structure (the table changed between
 * probe and apply). customizing-request.ts's 2026-09-06 activation failure
 * (`"SY-UNAME" and the row type of "LT_USERS" are incompatible`) is a live
 * example of the ADT syntax check catching exactly that kind of body error.
 * Never a bad row value, though, for the same quoted-literal reason as the
 * probe.
 */
const APPLY_HINT =
  "The apply bridge MODIFYs/DELETEs the target table directly and then calls TR_OBJECTS_CHECK/" +
  "TR_OBJECTS_INSERT (see CTS_INSERT_FM) — ordinary standard SAP function modules whose interface " +
  "here is confirmed by a successful live call, not merely read from FUPARAREF: on 2026-09-06 an " +
  "armed upsert filed a real E071/E071K row pair through both, and a subsequent delete on the same " +
  "table also succeeded. So a syntax error here is an ordinary ABAP error in the generated body, " +
  "not a suspected FM-interface problem — the ADT syntax check DOES validate ordinary ABAP " +
  "statements in the generated body, and the likeliest cause is the table's real structure having " +
  "drifted from the field list the probe returned. It is never a symptom of a bad row value, for " +
  "the same quoted-literal reason as the probe bridge.";

/**
 * This bridge only calls `TR_INSERT_REQUEST_WITH_TASKS` (`CUSTOMIZING_REQUEST_FM`,
 * customizing-request.ts) — an ordinary standard SAP function module, not
 * itself in question — with a fixed request type `'W'` and the caller's own
 * description/owner as quoted literals. Its interface here is confirmed by
 * a successful live call, not merely read from FUPARAREF: on 2026-09-06 it
 * created a real type-`W` customizing request with a type-`Q` task. So a
 * syntax error here is an ordinary ABAP error in the generated body, not a
 * suspected FM-interface problem — the same check DOES validate ordinary
 * ABAP statements in the generated body: on 2026-09-06 it also caught
 * `"SY-UNAME" and the row type of "LT_USERS" are incompatible` in this very
 * bridge, before the FM was ever called — see the fix in
 * `customizingRequestBody` (customizing-request.ts). It is the quoted
 * activation message — not a guess — that names the actual defect;
 * `assertNoErrors` (`./activate.ts`) puts that message into the thrown
 * error's own `message`/`details.messages`, confirmed by reading
 * `checkFailedError` there. Either way the generated class is left behind
 * in the helper package, written but never activated
 * (`discloseBridgeResidue` in `./run.ts` marks this `bridgeLeftBehind: true`
 * and already says it is safe to delete); the exact way to do that is
 * `abap_write {"object":"class ZCL_ZMCP_CTS_WREQ","mode":"delete"}`.
 */
const REQUEST_HINT =
  "This bridge only calls TR_INSERT_REQUEST_WITH_TASKS (see CUSTOMIZING_REQUEST_FM) — an ordinary " +
  "standard SAP function module — with request type 'W' and the caller's description/owner as " +
  "quoted literals. Its interface here is confirmed by a successful live call, not merely read " +
  "from FUPARAREF: on 2026-09-06 it created a real type-W customizing request with a type-Q task. " +
  "So a syntax error here is an ordinary ABAP error in the generated body, not a suspected " +
  "FM-interface problem. The ADT syntax check DOES validate ordinary ABAP statements in the " +
  "generated body: on 2026-09-06 it also caught \"SY-UNAME\" and the row type of \"LT_USERS\" are " +
  "incompatible in this very bridge before the FM was ever called; the quoted activation message " +
  "names the actual defect, not a guess. Delete the left-behind bridge " +
  `class with abap_write {"object":"class ${CUSTOMIZING_REQUEST_CLASS}","mode":"delete"}.`;

/**
 * What every one of this module's two remaining bespoke hints (APPLY_HINT,
 * REQUEST_HINT — the probe's own PROBE_HINT is gone now that the probe runs
 * as the fluid `img` tool's `preview` action, not a generated bridge) says
 * an activation syntax error most likely means is a claim about the
 * CALLER's input (a misspelled table/keyFields, a drifted structure, an FM
 * interface) — never that the GENERATED source itself is wrong. But when
 * the activation message says a name "was already declared", the generator
 * emitted a duplicate declaration: that is a defect in abapsmith's own
 * code, and either of those bespoke hints would misreport it as the
 * caller's mistake. This says so plainly instead.
 */
const DUPLICATE_DECLARATION_HINT =
  "The activation error says a name was already declared, which means the GENERATED ABAP source " +
  "itself declares something twice — a defect in abapsmith's own code generator, not a mistake in " +
  "the caller's plan. The table, keyFields and row values here are not suspects: nothing about them " +
  "could make the generator emit the same declaration twice. Report this to abapsmith, quoting the " +
  "activation message in this error, rather than editing or resubmitting the plan.";

/**
 * `deployBridge` (./run.ts) picks its `hint` before the activation outcome
 * exists, so it cannot know whether a syntax-check failure is an ordinary
 * one (misspelled field, drifted structure, ...) or a duplicate-declaration
 * defect in the generator's own output. This inspects what it actually
 * threw and corrects the hint after the fact whenever the activation text
 * says "already declared" — checked against both `details.messages` (the
 * rendered text `checkFailedError`/`renderMessages` in ./activate.ts build)
 * and `details.raw` (the parsed `AdtMessage[]` behind it), so a change to
 * either rendering still gets caught.
 *
 * By the time this runs, `discloseBridgeResidue` (./run.ts) has ALREADY
 * appended its own residue sentence onto the hint we passed in as
 * `originalHint` ("Bridge class ... was written to ... but failed to
 * activate ... — safe to delete."). This only swaps the `originalHint`
 * PREFIX for the corrected text and keeps whatever follows it — the residue
 * sentence — verbatim; every field of `details` (`bridgeLeftBehind`,
 * `bridgeClass`, `object`, `summary`, `messages`, `raw`, ...) is carried
 * through unchanged, since only `hint` is replaced.
 *
 * One shared helper, used at all three `deployBridge` call sites below —
 * not a copy per bridge — because a duplicate declaration is equally
 * possible in the probe, apply and request bridges' generated source.
 */
function withDuplicateDeclarationHintFix(e: unknown, originalHint: string): unknown {
  if (!isAbapError(e)) return e;

  const rendered = typeof e.details.messages === "string" ? e.details.messages : "";
  const raw = Array.isArray(e.details.raw) ? (e.details.raw as ReadonlyArray<{ text?: unknown }>) : [];
  const rawText = raw.map((m) => (typeof m?.text === "string" ? m.text : "")).join("\n");
  const isDuplicateDeclaration = /already declared/i.test(`${rendered}\n${rawText}`);
  if (!isDuplicateDeclaration) return e;

  // discloseBridgeResidue always composes `${originalHint} ${residueSentence}` when
  // `originalHint` is defined (it always is here — every call site below passes one) —
  // so stripping the known prefix leaves exactly the residue sentence, space included.
  const residue = e.hint !== undefined && e.hint.startsWith(originalHint) ? e.hint.slice(originalHint.length) : "";

  return new AbapError(
    e.code,
    e.message,
    e.details,
    `${DUPLICATE_DECLARATION_HINT}${residue}`,
    { retryable: e.retryable }, // re-wrap, not an override — no site reachable here overrides RETRYABILITY today
    // carries the caught error's retryable across instead of recomputing it, so that stays true if one ever does
  );
}

/** Run the read-only IMG write probe through the fluid `img` tool's `preview` action and return its parsed transcript. */
export async function runImgProbe(
  conn: AbapConnection,
  gate: SafetyGate,
  plan: ImgProbePlan,
  cfg: Config,
): Promise<ImgProbeResult> {
  const started = Date.now();
  validateProbePlan(plan);

  const res = await dispatch(
    { conn, cfg, gate, tools: IMG_TOOLS },
    {
      tool: "img",
      action: "preview",
      args: { table: plan.table, keyFields: plan.keyFields, rows: plan.rows.map((row) => row.key) },
    },
  );

  // dispatch() already validates res.result against imgManifest's declared output schema (array of
  // string) — this is type narrowing, not a real recovery path, but stays a hard refusal, not a cast.
  if (!Array.isArray(res.result) || res.result.some((line) => typeof line !== "string")) {
    throw new AbapError(
      "FLUID_PROTOCOL_ERROR",
      "img.preview returned a result that is not an array of strings.",
      { tool: "img", action: "preview", result: res.result },
    );
  }
  const raw = res.result.join("\n");
  const transcript = parseImgWriteTranscript(raw);

  return {
    plan,
    bridgeClass: imgManifest.entry,
    bridgeRefreshed: res.deployed,
    durationMs: Date.now() - started,
    transcript,
    outputComplete: !res.truncated,
    bodyBytes: Buffer.byteLength(raw, "utf8"),
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

  const className = IMGW_BRIDGE_CLASS.apply;
  const source = imgApplySource(plan);

  const deployed = await deployBridge(conn, gate, {
    className,
    source,
    description: "abapsmith IMG customizing write apply",
    what: "Activation of the generated IMG write-apply bridge",
    hint: APPLY_HINT,
    verify: (activation) =>
      verifyBridgeActivation(activation, className, "IMG write-apply bridge", { table: plan.table, op: plan.op }),
  }).catch((e) => {
    throw withDuplicateDeclarationHintFix(e, APPLY_HINT);
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

  const className = CUSTOMIZING_REQUEST_CLASS;
  const source = customizingRequestSource(plan);

  const deployed = await deployBridge(conn, gate, {
    className,
    source,
    description: "abapsmith customizing request creation",
    what: "Activation of the generated customizing-request-creation bridge",
    hint: REQUEST_HINT,
    verify: (activation) => verifyBridgeActivation(activation, className, "customizing-request bridge", {}),
  }).catch((e) => {
    throw withDuplicateDeclarationHintFix(e, REQUEST_HINT);
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
