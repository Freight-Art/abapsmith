/**
 * Enhancement/BAdI CREATE bridge.
 *
 * Five of the six operations here (`createEnhancementSpot`,
 * `addBadiDefinition`, `addFilterDefinition`, `createBadiImplementation`,
 * `setFilterValues`) run their ABAP-side step through `dispatch()`
 * (`./fluid/dispatch.js`) against the static fluid body `ZCL_ZMCP_FLUID_ENH`
 * (`./fluid/builtin/enh.js`) rather than a per-call generated bridge class —
 * everything AROUND that call (identifier validation, gating, the H21
 * marker-interface precondition, the post-op `activateObject`, and H23's
 * joint spot+implementation reactivation) stays exactly as it was. Only
 * `exerciseBadi` still writes, activates and runs a throwaway
 * `IF_OO_ADT_CLASSRUN` bridge class carrying one `enhancement-templates.ts`
 * fragment (same pattern as `./run.ts` and `./bopf-runtime.ts`) — it cannot
 * move to the fluid model because it needs `DATA lo_badi TYPE REF TO
 * <badi_name>`, a compile-time type built from a runtime string; see
 * `./fluid/builtin/enh.ts`'s doc comment for the full reason.
 *
 * Every exported function gates twice: `gate.assertIntent` against an
 * `EnhancementIntent` (`../safety.ts`), AND (for `exerciseBadi`)
 * `authorizeMutation`/`gate.assert("activate", …)` against the bridge class
 * itself — one gate judges "may this class run", the other "is the
 * enhancement mutation it performs allowed". For the five dispatch()-routed
 * operations, `dispatch()`'s own generic write-gate check runs in addition —
 * see `runEnhAction`'s doc comment for why that can never refuse a call the
 * existing intent-based gate has already approved. `exerciseBadi` gates with
 * `op: "execute"` (`CALL BADI` is execution, not a read).
 *
 * The user's ENHS/ENHO objects land in `$TMP` (`ENH_CREATE_PACKAGE`) —
 * fixtures 339/350; abapsmith's own generated bridge classes (and the fluid
 * API's own static/invoker classes) land in the fluid API's package
 * (`ENH_BRIDGE_PACKAGE`).
 *
 * Known deviations/defect history, full evidence in
 * the git history:
 *  - H23: a filter VALUE change must re-activate the SPOT jointly with the
 *    implementation, not the implementation alone ({@link
 *    activateSpotAndImplementation}) — fixtures 471/473/478 vs 491/492.
 *  - The vendor `abap-adt-api` array-form `activate()` emits attributes SAP
 *    400-rejects for this joint call (fixture 1119); the request/response XML
 *    for this call is built and parsed by `./activate.ts`'s shared
 *    `buildActivationBody`/`parseActivationResponse`, which exist for exactly
 *    that reason.
 *  - `addBadiDefinition`/`addFilterDefinition`'s locked `get_enhancement_spot`
 *    call is inferred by symmetry with fixture 466, not independently
 *    captured live (fixture 486 only covers the unlocked read).
 *  - `get_enhancement_spot`/`get_enhancement`'s `spot`/`enhancement` result
 *    is `RETURNING`, not `IMPORTING` — two related bugs, fixed and
 *    live-reconfirmed (fixtures 867, 893).
 *  - `isActive` can read true while `adtcore:version` stays inactive after
 *    the inline save/activate the ABAP body performs (field report
 *    ZTM_HW011B_IMPL); `createEnhancementSpot`, `addBadiDefinition`,
 *    `addFilterDefinition` and `createBadiImplementation` each perform an
 *    extra `activateObject` against the spot to close this gap.
 */
import type { AbapConnection } from "./connection.js";
import { AbapError, isAbapError } from "./errors.js";
import { normalizeCorrNr, type AuthorizedTarget, type EnhancementIntent, type SafetyCorr, type SafetyGate } from "../safety.js";
import type { ActivationResult } from "abap-adt-api/build/api/activate.js";
import {
  authorizeMutation,
  preflightPackageCorr,
  writeObject,
  enhancementIntentFor,
  NO_JOURNAL,
  type EnhancedObjectRef,
  type TransportOptions,
} from "./write.js";
import { isNotFoundError } from "./session.js";
import { isLocalPackageName } from "./transports.js";
import type { SessionTransport } from "./session-transport.js";
import {
  activateObject,
  activateWithPreauditSet,
  assertNoErrors,
  buildActivationBody,
  mapActivationMessages,
  mapInactiveObjects,
  parseActivationResponse,
  releaseActivationEnqueues,
  tally,
  type ActivationOutcome,
  type ActivationTarget,
  type AdtMessage,
  type InactiveObjectRef,
} from "./activate.js";
import {
  assertPlainName,
  deployBridge,
  executeBridge,
  verifyBridgeActivation,
  type RunResult,
} from "./run.js";
import { FLUID_PACKAGE } from "./fluid/package.js";
import { buildEnhancementUri, ENHOXH_COLLECTION, ENHSXS_COLLECTION } from "./enhancement.js";
import { dispatch } from "./fluid/dispatch.js";
import { enhManifest, enhSources } from "./fluid/builtin/enh.js";
import { manifestVersion, type LoadedFluidTool } from "./fluid/manifest.js";
import {
  assertEnhIdentifier,
  exerciseFragment,
  markerInterfaceSource,
  type CreateSpotParams,
  type AddBadiDefParams,
  type AddFilterDefParams,
  type CreateImplParams,
  type SetFilterValuesParams,
  type ExerciseParams,
} from "./enhancement-templates.js";

/**
 * abapsmith's own generated bridge classes — the fluid API owns them, so they live in its package.
 * Live re-export, not `= FLUID_PACKAGE`: a module-scope alias is read before `./fluid/package.js`'s own body has
 * run when the graph is entered at `dist/adt/fluid/package.js`, throwing a TDZ error under real Node ESM.
 */
export { FLUID_PACKAGE as ENH_BRIDGE_PACKAGE } from "./fluid/package.js";

/**
 * The user's own ENHS/ENHO objects and the H21 marker interface, whose names the caller
 * supplies. Stays `$TMP`: these are the caller's content, not abapsmith's scaffolding, and
 * must not land in the fluid API's private package.
 */
export const ENH_CREATE_PACKAGE = "$TMP";

// ---------------------------------------------------------------------------
// Fixed bridge-class name — exerciseBadi's own per-call bridge
// ---------------------------------------------------------------------------

/**
 * Only `exerciseBadi` still generates and deploys its own per-call bridge —
 * the other five operations this module used to name a bridge class for now
 * run through `dispatch()` against the static fluid body `ZCL_ZMCP_FLUID_ENH`
 * (`./fluid/builtin/enh.ts`) instead. Kept as an object (not a bare string)
 * for source-compatibility with callers that still read `BRIDGE_CLASS.exercise`
 * (`./fluid/dynamic-bridges.ts`'s `Object.values(ENH_BRIDGE_CLASS)`) and with
 * `test/enhancement-bridge.test.ts`, which keys fake-server routes on it.
 */
export const BRIDGE_CLASS = {
  exercise: "ZCL_ZMCP_ENH_EXEC",
} as const;

/**
 * The fluid `enh` tool as a `LoadedFluidTool`, for `dispatch()` — mirrors
 * `./fluid/builtin/classic.ts`'s own `classicTool` export exactly, but
 * `./fluid/builtin/enh.ts` (unlike `classic.ts`) exports only the raw
 * `enhManifest`/`enhSources` pair, so the `LoadedFluidTool` wrapper is built
 * here instead of there.
 */
const ENH_TOOL: LoadedFluidTool = {
  manifest: enhManifest,
  origin: "builtin",
  sources: enhSources,
  version: manifestVersion(enhManifest, enhSources),
};
const ENH_TOOLS: ReadonlyMap<string, LoadedFluidTool> = new Map([[enhManifest.id, ENH_TOOL]]);

// ---------------------------------------------------------------------------
// Bridge-class skeleton
// ---------------------------------------------------------------------------

/**
 * Wraps `bodyLines` in a minimal `IF_OO_ADT_CLASSRUN` class; `dataLines` are
 * declared once in `main`'s own DATA section since every
 * `enhancement-templates.ts` fragment assumes its locals already exist. A
 * single TRY/CATCH cx_root wraps the body — simpler than
 * `bopf-runtime.ts`'s skeleton since every fragment ends with its own
 * `out->write('TAG')`. Exported for `test/enhancement-bridge.test.ts`'s
 * generator/parser drift test.
 */
export function bridgeSource(className: string, dataLines: readonly string[], bodyLines: readonly string[]): string {
  const cls = assertPlainName(className, "Class name").toLowerCase();
  // Prepends the DATA keyword here (once) rather than in each of the five
  // data-line arrays — omitting it produces invalid ABAP and fails
  // activation (fixture 609). See archive.
  const data = dataLines.map((l) => `    DATA ${l}`).join("\n");
  const body = bodyLines.map((l) => `    ${l}`).join("\n");
  return `CLASS ${cls} DEFINITION
  PUBLIC FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.
  PROTECTED SECTION.
  PRIVATE SECTION.
ENDCLASS.


CLASS ${cls} IMPLEMENTATION.

  METHOD if_oo_adt_classrun~main.
*   Generated by abapsmith (T15). Do not edit: this class is regenerated from
*   src/adt/enhancement-bridge.ts whenever its content hash changes.
${data}
    TRY.
${body}
      CATCH cx_root INTO DATA(lx_err).
        out->write( |ZMCP-ENH-ERR> { lx_err->get_text( ) }| ).
    ENDTRY.
  ENDMETHOD.

ENDCLASS.
`;
}

// ---------------------------------------------------------------------------
// Transcript parsing — the bare literal tags baked into enhancement-templates.ts
// ---------------------------------------------------------------------------

const ENH_TAGS = [
  "SPOT-OBJECT-CREATED",
  "BADI-DEF-ADDED",
  "FILTER-DEF-ADDED",
  "ENHO-OBJECT-CREATED",
  "IMPL-ADDED",
  "IMPL-REPLACED",
  "EXERCISED",
  "NOT-BOUND",
  "BADI-HAS-FILTERS",
  "BADI-NO-FILTERS",
  "BADI-FILTER-CHECK-INCONCLUSIVE",
] as const;
export type EnhTag = (typeof ENH_TAGS)[number];

export interface EnhTranscriptResult {
  /** Tags found, in the order the ABAP wrote them. */
  tags: EnhTag[];
  /** Any `ZMCP-ENH-ERR>`-prefixed line from the TRY/CATCH cx_root handler. */
  errorLine?: string;
  /** Full captured output, for a caller that wants more than the tags. */
  raw: string;
}

/** Exported so `test/enhancement-bridge.test.ts` can drift-test generator tags against this parser — mirrors `bopf-runtime.ts`'s `parseBopfTranscript`. */
export function parseEnhancementTranscript(raw: string): EnhTranscriptResult {
  const tags: EnhTag[] = [];
  let errorLine: string | undefined;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("ZMCP-ENH-ERR>")) {
      errorLine = trimmed.slice("ZMCP-ENH-ERR>".length).trim();
      continue;
    }
    const tag = (ENH_TAGS as readonly string[]).find((t) => trimmed === t);
    if (tag) tags.push(tag as EnhTag);
  }
  return { tags, errorLine, raw };
}

/**
 * `bridgeSource`'s single TRY wraps the epilogue too, so a tag written before
 * the CATCH fired proves that much progress landed — and no more.
 */
function epilogueFailureHint(tags: readonly EnhTag[]): string {
  if (tags.length === 0) {
    return (
      "The bridge raised before writing any progress marker, so nothing here shows the object " +
      "was created, saved, or locked. Do not assume either outcome — read the object before " +
      "deciding whether to run the bridge again."
    );
  }
  return (
    `Already landed per the transcript: ${tags.join(", ")}. The generated bridge's SAVE may have ` +
    "committed before ACTIVATE raised, and its UNLOCK never ran afterwards, so the object may " +
    "still hold an enqueue lock. Do not blindly re-run the bridge — re-read the object first to " +
    "see what actually landed. A stranded lock clears in SM12, or on its own once the owning " +
    "session ends."
  );
}

/**
 * Throws when the transcript shows the CATCH branch fired, or shows none of
 * the tags the caller expected — a 200 classrun response with no output (or
 * the wrong output) is exactly as much "silent failure shaped like success"
 * here as it is in `run.ts`/`bopf-runtime.ts`.
 */
export function assertEnhTranscript(result: EnhTranscriptResult, expectTags: readonly EnhTag[], what: string): void {
  if (result.errorLine) {
    throw new AbapError(
      "CHECK_FAILED",
      `${what} raised an ABAP exception: ${result.errorLine}`,
      { raw: result.raw, ...(result.tags.length ? { landedTags: result.tags } : {}) },
      epilogueFailureHint(result.tags),
    );
  }
  const missing = expectTags.filter((t) => !result.tags.includes(t));
  if (missing.length > 0) {
    throw new AbapError(
      "CHECK_FAILED",
      `${what} did not report success — expected marker${missing.length > 1 ? "s" : ""} ` +
        `${missing.join(", ")} in the classrun output, got: ${result.raw || "(empty)"}`,
      { raw: result.raw, missing },
    );
  }
}

// ---------------------------------------------------------------------------
// Bridge-class write/activate/run — the F7 half every operation shares
// ---------------------------------------------------------------------------

/**
 * Write + activate + run the bridge class (`run.ts`'s `runReport` shape,
 * F7): gated as any other write/activate would be, before the enhancement
 * intent gate runs, including an execute gate immediately before
 * `executeBridge` (F8 fix — a fresh authorization token is required to
 * reach execution). `deployBridge`/`executeBridge` (`run.ts`) hold the
 * shared halves; this wraps them with the `ENH_BRIDGE_PACKAGE` alias and
 * enhancement-specific wording.
 */
async function writeActivateRunBridge(
  conn: AbapConnection,
  gate: SafetyGate,
  className: string,
  source: string,
  description: string,
  action: string,
): Promise<RunResult> {
  const deployed = await deployBridge(conn, gate, {
    className,
    source,
    description,
    packageName: FLUID_PACKAGE,
    caller: { tool: "abap_enh", action },
    what: `Activation of the generated enhancement bridge ${className}`,
    verify: (activation) => verifyBridgeActivation(activation, className, "enhancement bridge"),
  });
  return executeBridge(conn, gate, deployed);
}

/**
 * Runs one `enh` fluid action through `dispatch()` and reshapes its result
 * into this module's own `RunResult`/JSON-object idiom, so the five
 * dispatch()-routed operations below can build an `EnhTranscriptResult` from
 * it exactly as they used to build one from `writeActivateRunBridge`'s raw
 * classrun output.
 *
 * `dispatch()` also runs its generic write-gate check against the action's
 * declared `targets` (the caller's `package_name`/`corr_nr`). It is a subset
 * of the intent-based `gate.assertIntent` the caller ran first, so it never
 * refuses what that one approved; `corrSource` tells it a caller-named
 * request from a session-resolved one.
 *
 * `enh`'s five mutate actions each declare an `object`-typed output, so
 * `dispatch()` hands back exactly one JSON value in `fr.result` — never the
 * array-of-string-lines shape `classic-call.ts`'s `object` narrowing expects
 * for `classic`'s own actions.
 */
async function runEnhAction(
  conn: AbapConnection,
  gate: SafetyGate,
  action: string,
  args: Record<string, unknown>,
  corrSource?: "named" | "auto",
): Promise<{ result: Record<string, unknown>; run: RunResult }> {
  const fr = await dispatch(
    { conn, cfg: conn.cfg, gate, tools: ENH_TOOLS },
    // `caller` names the MCP-facing identity (abap_enh + the operation the
    // caller actually invoked, which is byte-identical to this fluid
    // action name for all five reroutes) so a FLUID_API_DISABLED refusal
    // names abap_enh, not the internal fluid tool id "enh" dispatch() runs
    // this as under the hood.
    { tool: enhManifest.id, action, args, caller: { tool: "abap_enh", action }, corrSource },
  );
  if (typeof fr.result !== "object" || fr.result === null || Array.isArray(fr.result)) {
    throw new AbapError(
      "FLUID_PROTOCOL_ERROR",
      `enh.${action}: expected a JSON object result, got ${typeof fr.result}.`,
      { tool: enhManifest.id, action, result: fr.result },
    );
  }
  const result = fr.result as Record<string, unknown>;
  const raw = JSON.stringify(result);
  const run: RunResult = {
    mode: "class",
    object: enhManifest.entry,
    output: raw,
    lines: 1,
    durationMs: fr.ms,
    droppedLines: 0,
    bodyBytes: raw.length,
    outputComplete: !fr.truncated,
  };
  return { result, run };
}

/**
 * Package/corr resolution shared by the five mutate functions: the zero-network
 * intent preflight, then (transportable package) the real transport resolution
 * through `preflightPackageCorr`. Local package + named `corr_nr` is BAD_INPUT.
 */
async function resolveEnhCorr(
  conn: AbapConnection,
  gate: SafetyGate,
  intent: EnhancementIntent,
  t: { name: string; type: string; uri: string; packageName: string; exists: boolean },
  transport: SessionTransport | undefined,
  named: string | undefined,
  activate: boolean,
): Promise<{ corrNr: string; corrSource?: "named" | "auto" }> {
  const local = isLocalPackageName(t.packageName);
  if (local && named !== undefined) {
    throw new AbapError(
      "BAD_INPUT",
      `package ${t.packageName} is local; a transport request does not apply.`,
      { field: "corr_nr", packageName: t.packageName, corrNr: named },
    );
  }
  const preflight: SafetyCorr =
    named === undefined ? { kind: "unresolved" } : { kind: "transport", corrNr: named, source: "named" };
  gate.assertIntent(intent, { op: "write", corr: preflight, phase: "preflight" });
  if (activate) gate.assertIntent(intent, { op: "activate", corr: preflight, phase: "preflight" });

  if (local) return { corrNr: "" };

  if (transport === undefined) {
    if (named !== undefined) {
      gate.assertIntent(intent, { op: "write", corr: { kind: "transport", corrNr: named, source: "named" } });
      return { corrNr: named, corrSource: "named" };
    }
    throw new AbapError(
      "TRANSPORT_ERROR",
      `${t.name} needs a transport request (package ${t.packageName} is not local), but no ` +
        "transport manager is wired into this call. This is an internal wiring failure in " +
        "abapsmith, not a mistake in the request.",
      { name: t.name, type: t.type, packageName: t.packageName },
    );
  }

  // The gate judges the artefact the intent names (the BAdI for add_badi_def/add_filter_def,
  // not the spot CTS records); the request itself is still resolved from `t.uri`.
  const corr = await preflightPackageCorr(
    conn,
    { uri: t.uri, name: intent.enhancementName, type: t.type, packageName: t.packageName, exists: t.exists },
    { transport, gate, corrNr: named, intent },
  );
  return { corrNr: corr.corrNr, corrSource: corr.source };
}

// ---------------------------------------------------------------------------
// H21 — the marker interface
// ---------------------------------------------------------------------------

/**
 * Check-then-create-if-missing, per `enhancement-templates.ts`'s H21 doc
 * comment: never overwrite a caller's own interface body. Always activated,
 * whatever the caller's `activate` flag: add_badi_def needs it active.
 * Lands in the BAdI definition's own package and request.
 */
async function ensureMarkerInterface(
  conn: AbapConnection,
  gate: SafetyGate,
  interfaceName: string,
  packageName: string,
  transport: SessionTransport | undefined,
  corr: { corrNr: string; source: "named" | "auto" } | undefined,
): Promise<void> {
  const name = assertEnhIdentifier(interfaceName, "interfaceName");
  const authorized = await authorizeMutation(conn, gate, "write", {
    type: "INTF/OI",
    name,
    packageName,
    description: "abapsmith BAdI marker interface (H21)",
  });
  if (!authorized.target.exists) {
    // A session-resolved request is reused by the session itself; only a caller-named one is
    // passed on (naming an auto-resolved number would be refused under ABAP_ALLOW_TRANSPORTS=auto).
    const transportOpts: TransportOptions =
      transport !== undefined
        ? { transport, gate, ...(corr?.source === "named" ? { corrNr: corr.corrNr } : {}) }
        : {};
    // NO_JOURNAL — a generated marker interface, not user source; no
    // before-image worth journaling.
    await writeObject(conn, authorized, {
      source: markerInterfaceSource(name),
      onBeforeImage: NO_JOURNAL,
      ...transportOpts,
    });
  }
  gate.assert("activate", {
    name: authorized.target.name,
    packageName: authorized.target.packageName,
    type: authorized.target.type,
  });
  const activation = await activateObject(conn, { name: authorized.target.name, uri: authorized.target.uri });
  assertNoErrors(activation, {
    what: `Activation of BAdI marker interface ${name} (H21)`,
    name,
  });
}

// ---------------------------------------------------------------------------
// H23 — joint spot + implementation activation
// ---------------------------------------------------------------------------

/**
 * `POST /sap/bc/adt/activation?method=activate&preauditRequested=true` naming
 * BOTH the spot and the implementation in the SAME call (fixtures 491/492) —
 * H23's joint re-activation, followed by `./activate.js`'s standard
 * two-phase handshake. The body is `buildActivationBody` from `./activate.js`
 * — the same builder `activateObject` uses — and produces fixture 491's exact
 * bytes; `parseActivationResponse` turns the reply into the `ActivationResult`
 * shape the existing `mapActivationMessages`/`mapInactiveObjects`/`tally`/
 * `assertNoErrors` machinery consumes. When phase one's reply carries a
 * non-empty preaudit set, `activateWithPreauditSet` re-sends that same
 * builder's output naming both seeds plus the preaudit set in one POST,
 * which keeps the two objects joint through phase two as well.
 *
 * `authorized` is a single token covering both targets: they are facets of
 * one gated intent ("may this BAdI's filter change go live"), matching the
 * single joint POST — a raw `conn.post` must be structurally unreachable
 * without holding that token.
 *
 * `onBeforeActivation` is REQUIRED, fired before the `conn.post` and outside
 * its try/catch: `src/adt/` has no journaling seam of its own, so this hook
 * is the only place a journal entry can be wired for the SPOT half of this
 * joint mutation (the sole caller previously journalled only
 * the implementation, leaving the spot unrecorded). `NO_JOURNAL`
 * (`./write.js`) opts out explicitly.
 */
export async function activateSpotAndImplementation(
  conn: AbapConnection,
  authorized: AuthorizedTarget<"activate">,
  targets: readonly ActivationTarget[],
  onBeforeActivation: () => Promise<void>,
): Promise<ActivationOutcome> {
  const body = buildActivationBody(targets);
  await onBeforeActivation();
  let result: ActivationResult;
  let preaudit: InactiveObjectRef[] | undefined;
  try {
    const resp = await conn.post("/sap/bc/adt/activation", {
      qs: { method: "activate", preauditRequested: "true" },
      headers: { "Content-Type": "application/xml", Accept: "application/xml" },
      body,
    });
    result = parseActivationResponse(resp.body);
    const phase2 = await activateWithPreauditSet(conn, targets, result);
    if (phase2) {
      result = phase2.result;
      preaudit = phase2.preaudit;
    }
  } catch (e) {
    if (isAbapError(e)) throw e;
    throw new AbapError(
      "ADT_ERROR",
      `Joint activation of ${targets.map((t) => t.name).join(" + ")} failed.`,
      { targets, authorizedFor: authorized.target.name, cause: e instanceof Error ? e.message : String(e) },
    );
  }
  const messages: AdtMessage[] = mapActivationMessages(result);
  const inactive = mapInactiveObjects(result);
  const { errors, warnings } = tally(messages);
  const activated = errors === 0 && inactive.length === 0 && result.success !== false;
  if (preaudit && !activated) await releaseActivationEnqueues(conn);
  return {
    activated,
    ok: errors === 0 && inactive.length === 0,
    messages,
    errors,
    warnings,
    inactive,
    ...(preaudit ? { preaudit } : {}),
  };
}

/**
 * `/sap/bc/adt/enhancements/enhsxs/<name>` / `enhoxh/<name>` — fixture 491's
 * exact URI shape (lowercase name segment). Built via `enhancement.ts`'s
 * `buildEnhancementUri` (carries the doubled-`/sap/bc/adt/` backstop this
 * system's discovery document requires) rather than by hand.
 */
// Exported so src/tools/enh.ts can build the same pre-creation URI for
// journal entries.
export function spotUri(spotName: string): string {
  return buildEnhancementUri(ENHSXS_COLLECTION, spotName.toLowerCase());
}
export function implUri(enhName: string): string {
  return buildEnhancementUri(ENHOXH_COLLECTION, enhName.toLowerCase());
}

// ---------------------------------------------------------------------------
// 1/6 — createEnhancementSpot
// ---------------------------------------------------------------------------

export interface CreateEnhancementSpotParams extends CreateSpotParams {
  /** The object this spot will bind to — see `EnhancementIntent`'s Q2. */
  affects: EnhancedObjectRef;
  /** Target package (devclass). Default `ENH_CREATE_PACKAGE` ("$TMP"). */
  packageName?: string;
  /** Caller-named transport request; ignored/refused on a local package. */
  corrNr?: string;
  /** Session transport resolver — required to resolve an omitted `corrNr` on a transportable package. */
  transport?: SessionTransport;
  /** Save-only when `false` (default `true`) — the spot is left inactive. */
  activate?: boolean;
}

export async function createEnhancementSpot(
  conn: AbapConnection,
  gate: SafetyGate,
  params: CreateEnhancementSpotParams,
): Promise<{
  run: RunResult;
  transcript: EnhTranscriptResult;
  activation?: ActivationOutcome;
  corr?: { corrNr: string; source: "named" | "auto" };
}> {
  const spotName = assertEnhIdentifier(params.spotName, "spotName");
  const packageName = (params.packageName ?? ENH_CREATE_PACKAGE).trim().toUpperCase();
  const named = normalizeCorrNr(params.corrNr);
  const activate = params.activate ?? true;
  const intent = enhancementIntentFor({ name: spotName, type: "ENHS/XS", packageName }, params.affects);

  const resolved = await resolveEnhCorr(
    conn,
    gate,
    intent,
    { name: spotName, type: "ENHS/XS", uri: spotUri(spotName), packageName, exists: false },
    params.transport,
    named,
    activate,
  );

  const { result, run } = await runEnhAction(
    conn,
    gate,
    "create_spot",
    {
      spot_name: spotName,
      description: params.description,
      package_name: packageName,
      corr_nr: resolved.corrNr,
      activate,
    },
    resolved.corrSource,
  );
  const transcript: EnhTranscriptResult = {
    tags: result.created === true ? ["SPOT-OBJECT-CREATED"] : [],
    raw: JSON.stringify(result),
  };
  assertEnhTranscript(transcript, ["SPOT-OBJECT-CREATED"], `Creating enhancement spot ${spotName}`);

  // Closes the isActive-vs-adtcore:version gap (see header). Not
  // assertNoErrors-wrapped: creation is already confirmed above, so a
  // failure here means "created, not activated", not "nothing created".
  const activation = activate ? await activateObject(conn, { name: spotName, uri: spotUri(spotName) }) : undefined;
  return {
    run,
    transcript,
    ...(activation !== undefined ? { activation } : {}),
    ...(resolved.corrSource !== undefined ? { corr: { corrNr: resolved.corrNr, source: resolved.corrSource } } : {}),
  };
}

// ---------------------------------------------------------------------------
// 2/6 — addBadiDefinition
// ---------------------------------------------------------------------------

export interface AddBadiDefinitionParams extends AddBadiDefParams {
  spotName: string;
  affects: EnhancedObjectRef;
  packageName?: string;
  corrNr?: string;
  transport?: SessionTransport;
  activate?: boolean;
}

export async function addBadiDefinition(
  conn: AbapConnection,
  gate: SafetyGate,
  params: AddBadiDefinitionParams,
): Promise<{
  run: RunResult;
  transcript: EnhTranscriptResult;
  activation?: ActivationOutcome;
  corr?: { corrNr: string; source: "named" | "auto" };
}> {
  const spotName = assertEnhIdentifier(params.spotName, "spotName");
  const badiName = assertEnhIdentifier(params.badiName, "badiName");
  const interfaceName = assertEnhIdentifier(params.interfaceName, "interfaceName");
  const packageName = (params.packageName ?? ENH_CREATE_PACKAGE).trim().toUpperCase();
  const named = normalizeCorrNr(params.corrNr);
  const activate = params.activate ?? true;
  const intent = enhancementIntentFor({ name: badiName, type: "ENHS/XS", packageName }, { ...params.affects, spotName });

  const resolved = await resolveEnhCorr(
    conn,
    gate,
    intent,
    { name: spotName, type: "ENHS/XS", uri: spotUri(spotName), packageName, exists: true },
    params.transport,
    named,
    activate,
  );

  // H21 — before touching the spot at all. Always activated regardless of
  // `activate` (the marker interface must be active for add_badi_def to work).
  await ensureMarkerInterface(
    conn,
    gate,
    interfaceName,
    packageName,
    params.transport,
    resolved.corrSource !== undefined ? { corrNr: resolved.corrNr, source: resolved.corrSource } : undefined,
  );

  const { result, run } = await runEnhAction(
    conn,
    gate,
    "add_badi_def",
    {
      spot_name: spotName,
      badi_name: badiName,
      interface_name: interfaceName,
      single_use: params.singleUse,
      short_text: params.shortText,
      package_name: packageName,
      corr_nr: resolved.corrNr,
      activate,
    },
    resolved.corrSource,
  );
  const transcript: EnhTranscriptResult = {
    tags: result.added === true ? ["BADI-DEF-ADDED"] : [],
    raw: JSON.stringify(result),
  };
  assertEnhTranscript(transcript, ["BADI-DEF-ADDED"], `Adding BAdI definition ${badiName} to spot ${spotName}`);

  // Closes the isActive-vs-adtcore:version gap (see header). Targets the
  // spot alone (badiName has no own ADT object/URI) — not H23's joint form.
  // Non-fatal, unlike H21's marker-interface activation above: creation is
  // already confirmed by the transcript assertion.
  const activation = activate ? await activateObject(conn, { name: spotName, uri: spotUri(spotName) }) : undefined;
  return {
    run,
    transcript,
    ...(activation !== undefined ? { activation } : {}),
    ...(resolved.corrSource !== undefined ? { corr: { corrNr: resolved.corrNr, source: resolved.corrSource } } : {}),
  };
}

// ---------------------------------------------------------------------------
// 3/6 — addFilterDefinition
// ---------------------------------------------------------------------------

export interface AddFilterDefinitionParams extends AddFilterDefParams {
  spotName: string;
  affects: EnhancedObjectRef;
  packageName?: string;
  corrNr?: string;
  transport?: SessionTransport;
  activate?: boolean;
}

export async function addFilterDefinition(
  conn: AbapConnection,
  gate: SafetyGate,
  params: AddFilterDefinitionParams,
): Promise<{
  run: RunResult;
  transcript: EnhTranscriptResult;
  activation?: ActivationOutcome;
  corr?: { corrNr: string; source: "named" | "auto" };
}> {
  const spotName = assertEnhIdentifier(params.spotName, "spotName");
  const badiName = assertEnhIdentifier(params.badiName, "badiName");
  const packageName = (params.packageName ?? ENH_CREATE_PACKAGE).trim().toUpperCase();
  const named = normalizeCorrNr(params.corrNr);
  const activate = params.activate ?? true;
  const intent = enhancementIntentFor({ name: badiName, type: "ENHS/XS", packageName }, { ...params.affects, spotName });

  const resolved = await resolveEnhCorr(
    conn,
    gate,
    intent,
    { name: spotName, type: "ENHS/XS", uri: spotUri(spotName), packageName, exists: true },
    params.transport,
    named,
    activate,
  );

  const args: Record<string, unknown> = {
    spot_name: spotName,
    badi_name: badiName,
    filter_name: params.filterName,
    filter_type: params.filterType,
    package_name: packageName,
    corr_nr: resolved.corrNr,
  };
  if (params.filterText !== undefined) args.filter_text = params.filterText;
  args.activate = activate;
  const { result, run } = await runEnhAction(conn, gate, "add_filter_def", args, resolved.corrSource);
  const transcript: EnhTranscriptResult = {
    tags: result.added === true ? ["FILTER-DEF-ADDED"] : [],
    raw: JSON.stringify(result),
  };
  assertEnhTranscript(transcript, ["FILTER-DEF-ADDED"], `Adding filter definition ${params.filterName} to ${badiName}`);

  // Closes the isActive-vs-adtcore:version gap (see header). Single-object,
  // not H23's joint form: `add_filter_def` only declares that the
  // DEFINITION supports filtering (spot-level metadata) — AddFilterDefParams
  // carries no implementation identifier, so there is no second object to
  // name in a joint call. Same target as addBadiDefinition/createEnhancementSpot.
  const activation = activate ? await activateObject(conn, { name: spotName, uri: spotUri(spotName) }) : undefined;
  return {
    run,
    transcript,
    ...(activation !== undefined ? { activation } : {}),
    ...(resolved.corrSource !== undefined ? { corr: { corrNr: resolved.corrNr, source: resolved.corrSource } } : {}),
  };
}

// ---------------------------------------------------------------------------
// 4/6 — createBadiImplementation
// ---------------------------------------------------------------------------

/**
 * A definite 404 on `GET /oo/classes/{name}` is the only "no" this can
 * report — anything else (network error, auth hiccup, unrouted fake in a
 * test) is "unknown", not "yes". Never throws: the enhancement this backs
 * is already created by the time it runs, so a probe failure must not fail
 * the create.
 */
async function implementingClassExists(conn: AbapConnection, className: string): Promise<boolean | undefined> {
  try {
    await conn.get(`/sap/bc/adt/oo/classes/${className.toLowerCase()}`, { headers: { Accept: "application/*" } });
    return true;
  } catch (e) {
    if (isNotFoundError(e)) return false;
    return undefined;
  }
}

export interface CreateBadiImplementationParams extends CreateImplParams {
  affects: EnhancedObjectRef;
  packageName?: string;
  corrNr?: string;
  transport?: SessionTransport;
  activate?: boolean;
}

export async function createBadiImplementation(
  conn: AbapConnection,
  gate: SafetyGate,
  params: CreateBadiImplementationParams,
): Promise<{
  run: RunResult;
  transcript: EnhTranscriptResult;
  activation?: ActivationOutcome;
  implClass: { name: string; exists: boolean | undefined };
  corr?: { corrNr: string; source: "named" | "auto" };
}> {
  const enhName = assertEnhIdentifier(params.enhName, "enhName");
  const spotName = assertEnhIdentifier(params.spotName, "spotName");
  const badiName = assertEnhIdentifier(params.badiName, "badiName");
  const implClass = assertEnhIdentifier(params.implClass, "implClass");
  const packageName = (params.packageName ?? ENH_CREATE_PACKAGE).trim().toUpperCase();
  const named = normalizeCorrNr(params.corrNr);
  const activate = params.activate ?? true;
  const intent = enhancementIntentFor({ name: enhName, type: "ENHO/XH", packageName }, { ...params.affects, spotName });

  const resolved = await resolveEnhCorr(
    conn,
    gate,
    intent,
    { name: enhName, type: "ENHO/XH", uri: implUri(enhName), packageName, exists: false },
    params.transport,
    named,
    activate,
  );

  const { result, run } = await runEnhAction(
    conn,
    gate,
    "create_impl",
    {
      enh_name: enhName,
      spot_name: spotName,
      badi_name: badiName,
      impl_name: params.implName,
      impl_class: implClass,
      active: params.active,
      description: params.description,
      package_name: packageName,
      corr_nr: resolved.corrNr,
      activate,
    },
    resolved.corrSource,
  );
  const tags: EnhTag[] = [];
  if (result.created === true) tags.push("ENHO-OBJECT-CREATED");
  if (result.impl_added === true) tags.push("IMPL-ADDED");
  if (result.filter_check === "has_filters") tags.push("BADI-HAS-FILTERS");
  else if (result.filter_check === "no_filters") tags.push("BADI-NO-FILTERS");
  else if (result.filter_check === "inconclusive") tags.push("BADI-FILTER-CHECK-INCONCLUSIVE");
  const transcript: EnhTranscriptResult = { tags, raw: JSON.stringify(result) };
  assertEnhTranscript(transcript, ["ENHO-OBJECT-CREATED", "IMPL-ADDED"], `Creating BAdI implementation ${enhName}`);

  // Field report ZTM_HW011B_IMPL: the epilogue's inline SAVE/ACTIVATE/UNLOCK
  // reliably sets the runtime dispatch flag (ls_impl-active) but does NOT
  // reliably promote adtcore:version to active. enhancement-write.ts's
  // writeAndActivateEnhancementDescription closes the identical gap with an
  // extra activateObject call; done here directly when `activate` is true
  // (params.active is the orthogonal runtime dispatch flag). Not
  // assertNoErrors-wrapped: creation is already confirmed above, so a
  // failure here means "created, not activated", not "nothing created".
  const activation = activate ? await activateObject(conn, { name: enhName, uri: implUri(enhName) }) : undefined;
  const exists = await implementingClassExists(conn, implClass);
  return {
    run,
    transcript,
    ...(activation !== undefined ? { activation } : {}),
    implClass: { name: implClass, exists },
    ...(resolved.corrSource !== undefined ? { corr: { corrNr: resolved.corrNr, source: resolved.corrSource } } : {}),
  };
}

// ---------------------------------------------------------------------------
// 5/6 — setFilterValues (H23 — the joint activation follows)
// ---------------------------------------------------------------------------

export interface SetFilterValuesRequestParams extends SetFilterValuesParams {
  /** The `ENHO/XH` implementation's own name — `cl_enh_factory=>get_enhancement`'s `enhancement_id`. */
  enhName: string;
  /** The spot it binds to — needed for the H23 joint re-activation, not the inline save/activate. */
  spotName: string;
  affects: EnhancedObjectRef;
  /** Fired before H23's joint activation POST — see {@link activateSpotAndImplementation}'s `onBeforeActivation` doc for why it's required. `NO_JOURNAL` opts out. */
  onJointActivation: () => Promise<void>;
  packageName?: string;
  corrNr?: string;
  transport?: SessionTransport;
  activate?: boolean;
}

export async function setFilterValues(
  conn: AbapConnection,
  gate: SafetyGate,
  params: SetFilterValuesRequestParams,
): Promise<{
  run: RunResult;
  transcript: EnhTranscriptResult;
  jointActivation?: ActivationOutcome;
  corr?: { corrNr: string; source: "named" | "auto" };
}> {
  const enhName = assertEnhIdentifier(params.enhName, "enhName");
  const spotName = assertEnhIdentifier(params.spotName, "spotName");
  const packageName = (params.packageName ?? ENH_CREATE_PACKAGE).trim().toUpperCase();
  const named = normalizeCorrNr(params.corrNr);
  const activate = params.activate ?? true;
  const intent = enhancementIntentFor({ name: enhName, type: "ENHO/XH", packageName }, { ...params.affects, spotName });

  const resolved = await resolveEnhCorr(
    conn,
    gate,
    intent,
    { name: enhName, type: "ENHO/XH", uri: implUri(enhName), packageName, exists: true },
    params.transport,
    named,
    activate,
  );

  const { result, run } = await runEnhAction(
    conn,
    gate,
    "set_filter_values",
    {
      enh_name: enhName,
      impl_name: params.implName,
      filter_name: params.filterName,
      filter_type: params.filterType,
      compare: params.compare,
      value: params.value,
      package_name: packageName,
      corr_nr: resolved.corrNr,
      activate,
    },
    resolved.corrSource,
  );
  const transcript: EnhTranscriptResult = {
    tags: result.replaced === true ? ["IMPL-REPLACED"] : [],
    raw: JSON.stringify(result),
  };
  assertEnhTranscript(transcript, ["IMPL-REPLACED"], `Setting filter values on implementation ${enhName}`);

  if (!activate) {
    return {
      run,
      transcript,
      ...(resolved.corrSource !== undefined ? { corr: { corrNr: resolved.corrNr, source: resolved.corrSource } } : {}),
    };
  }

  // H23: the inline implementation-level activate above is necessary but
  // not sufficient (fixtures 471/473/478 vs 492) — a second gate check plus
  // the joint call. `authorizeIntent` (not `assertIntent`) so the minted
  // token is the only way to reach `activateSpotAndImplementation`'s
  // `conn.post`. Skipped entirely when `activate` is false.
  const jointAuthorized = gate.authorizeIntent(
    "activate",
    intent,
    { name: enhName, packageName, type: "ENHO/XH" },
  );
  const jointActivation = await activateSpotAndImplementation(
    conn,
    jointAuthorized,
    [
      { name: spotName.toUpperCase(), uri: spotUri(spotName) },
      { name: enhName.toUpperCase(), uri: implUri(enhName) },
    ],
    params.onJointActivation,
  );
  assertNoErrors(jointActivation, {
    what: `H23 joint activation of spot ${spotName} + implementation ${enhName} after a filter change`,
    name: enhName,
  });
  return {
    run,
    transcript,
    jointActivation,
    ...(resolved.corrSource !== undefined ? { corr: { corrNr: resolved.corrNr, source: resolved.corrSource } } : {}),
  };
}

// ---------------------------------------------------------------------------
// 6/6 — exerciseBadi (runtime verification/witness path — gated as execute)
// ---------------------------------------------------------------------------

export interface ExerciseBadiParams extends ExerciseParams {
  affects: EnhancedObjectRef;
}

export async function exerciseBadi(
  conn: AbapConnection,
  gate: SafetyGate,
  params: ExerciseBadiParams,
): Promise<{ run: RunResult; transcript: EnhTranscriptResult }> {
  const badiName = assertEnhIdentifier(params.badiName, "badiName");
  const intent = enhancementIntentFor(
    { name: badiName, type: "ENHO/XH", packageName: ENH_CREATE_PACKAGE },
    params.affects,
  );
  // No read-only classrun exemption (task framing, and enhancement-templates.ts's
  // own doc comment on exerciseFragment): "execute", never waved through.
  gate.assertIntent(intent, { op: "execute" });

  const body = exerciseFragment(params);
  const source = bridgeSource(BRIDGE_CLASS.exercise, [], body);
  const run = await writeActivateRunBridge(
    conn,
    gate,
    BRIDGE_CLASS.exercise,
    source,
    `abapsmith T15 exercise-badi bridge (${badiName})`,
    "exercise",
  );
  const transcript = parseEnhancementTranscript(run.output);
  // H2/H7: NOT-BOUND means GET BADI produced an unbound handle — CALL BADI
  // never attempted. Name the actual hazard instead of a generic
  // missing-tag message.
  if (transcript.tags.includes("NOT-BOUND")) {
    throw new AbapError(
      "ENHANCEMENT_NOT_DISPATCHING",
      `Exercising BAdI ${badiName}: GET BADI produced no implementation reference (unbound handle), so ` +
        `${params.methodName} was never called. The implementation can be workbench-active, its ACTIVE flag ` +
        "set, and its class active, and still not dispatch — SAP ships a runtime BAdI/enhancement buffer " +
        "distinct from the design-time metadata buffer (Note 944559, report ENH_BADI_REFRESH_BUFFER). " +
        "This is not necessarily an abapsmith defect: every " +
        "readable signal on the implementation can be correct while the kernel's own dispatch cache is stale.",
      { raw: transcript.raw, badiName, methodName: params.methodName },
    );
  }
  assertEnhTranscript(transcript, ["EXERCISED"], `Exercising BAdI ${badiName}`);
  return { run, transcript };
}
