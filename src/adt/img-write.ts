/**
 * IMG customizing write orchestration: thin result-shaping wrappers around
 * the fluid `img` tool's three actions (`preview`, `apply`, `create_request`)
 * for the probe/apply plans (`img-write-bridge.ts`) and the
 * customizing-request-creation plan (`customizing-request.ts`). Writing
 * still needs the `img` body class (ADT has no IMG REST route); reading does
 * not — `src/adt/img-read.ts` reads catalog tables straight through the
 * freestyle data-preview endpoint and deploys nothing.
 *
 * This module contributes ONLY that choreography. Every plan-validation
 * rule and transcript-parsing rule already lives in `img-write-bridge.ts`,
 * `customizing-request.ts` or `img-write-policy.ts`; nothing here duplicates
 * any of them — each function below calls straight through to the one place
 * that logic is allowed to exist.
 *
 * All three actions run through `dispatch()` (`fluid/dispatch.ts`) against
 * the built-in `img` manifest (`fluid/builtin/img.ts`), landing the shared
 * body class in `FLUID_PACKAGE`. Each dispatch call's `caller` field names
 * the `abap_img_edit` mode/action that actually invoked it, so a
 * `FLUID_API_DISABLED` refusal reports that name instead of the internal
 * fluid tool/action ids ("img"/"preview", "img"/"apply", "img"/"create_request").
 */
import type { AbapConnection } from "./connection.js";
import type { Config } from "../config.js";
import type { SafetyGate } from "../safety.js";
import { AbapError } from "./errors.js";
import { imgManifest, imgSources } from "./fluid/builtin/img.js";
import { manifestVersion, type LoadedFluidTool } from "./fluid/manifest.js";
import { dispatch } from "./fluid/dispatch.js";
import {
  validateProbePlan,
  validateApplyPlan,
  parseImgWriteTranscript,
  type ImgProbePlan,
  type ImgApplyPlan,
  type ImgWriteTranscript,
} from "./img-write-bridge.js";
import {
  validateCustomizingRequestPlan,
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
 * Run the read-only IMG write probe through the fluid `img` tool's `preview` action and return its
 * parsed transcript. `callerAction` is the `abap_img_edit` mode the MCP caller actually invoked
 * ("preview", "upsert" or "delete" — an armed upsert/delete previews before it writes) — it names
 * the dispatch call's `caller` field so a `FLUID_API_DISABLED` refusal reports the tool/action the
 * caller invoked, not the internal fluid ids ("img"/"preview") dispatch runs it as underneath.
 */
export async function runImgProbe(
  conn: AbapConnection,
  gate: SafetyGate,
  plan: ImgProbePlan,
  cfg: Config,
  callerAction: "preview" | "upsert" | "delete",
): Promise<ImgProbeResult> {
  const started = Date.now();
  validateProbePlan(plan);

  const res = await dispatch(
    { conn, cfg, gate, tools: IMG_TOOLS },
    {
      tool: "img",
      action: "preview",
      args: { table: plan.table, keyFields: plan.keyFields, rows: plan.rows.map((row) => row.key) },
      caller: { tool: "abap_img_edit", action: callerAction },
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

/**
 * Run the IMG write apply through the fluid `img` tool's `apply` action (direct MODIFY/DELETE + CTS
 * recording) and return its parsed transcript. `callerAction` is the `abap_img_edit` mode the MCP
 * caller invoked ("upsert" or "delete" — preview never reaches this function) — see runImgProbe's own
 * doc comment for why this exists.
 */
export async function runImgApply(
  conn: AbapConnection,
  gate: SafetyGate,
  plan: ImgApplyPlan,
  cfg: Config,
  callerAction: "upsert" | "delete",
): Promise<ImgApplyResult> {
  const started = Date.now();
  validateApplyPlan(plan);

  const res = await dispatch(
    { conn, cfg, gate, tools: IMG_TOOLS },
    {
      tool: "img",
      action: "apply",
      args: {
        table: plan.table,
        clientField: plan.clientField,
        keyFields: plan.keyFields,
        rows: plan.rows,
        op: plan.op,
        ...(plan.corrNr !== undefined ? { corrNr: plan.corrNr } : {}),
        view: plan.view,
        masterType: plan.masterType,
        expectedDeliveryClass: plan.expectedDeliveryClass,
        expectedClientDependent: plan.expectedClientDependent,
      },
      caller: { tool: "abap_img_edit", action: callerAction },
    },
  );

  if (!Array.isArray(res.result) || res.result.some((line) => typeof line !== "string")) {
    throw new AbapError(
      "FLUID_PROTOCOL_ERROR",
      "img.apply returned a result that is not an array of strings.",
      { tool: "img", action: "apply", result: res.result },
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

/**
 * Run the customizing-request creation through the fluid `img` tool's `create_request` action and
 * return its parsed transcript (request/task numbers). This is the only mode `runCreateRequestMode`
 * (img-edit.ts) ever calls, so the dispatch caller action is a fixed literal, not a parameter.
 */
export async function runCreateCustomizingRequest(
  conn: AbapConnection,
  gate: SafetyGate,
  plan: CustomizingRequestPlan,
  cfg: Config,
): Promise<CustomizingRequestResult> {
  const started = Date.now();
  validateCustomizingRequestPlan(plan);

  const res = await dispatch(
    { conn, cfg, gate, tools: IMG_TOOLS },
    {
      tool: "img",
      action: "create_request",
      args: { description: plan.description, ...(plan.owner !== undefined ? { owner: plan.owner } : {}) },
      caller: { tool: "abap_img_edit", action: "create_request" },
    },
  );

  if (!Array.isArray(res.result) || res.result.some((line) => typeof line !== "string")) {
    throw new AbapError(
      "FLUID_PROTOCOL_ERROR",
      "img.create_request returned a result that is not an array of strings.",
      { tool: "img", action: "create_request", result: res.result },
    );
  }
  const raw = res.result.join("\n");
  const transcript = parseCustomizingRequestTranscript(raw);

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
