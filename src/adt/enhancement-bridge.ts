/**
 * Enhancement/BAdI CREATE bridge.
 *
 * `./enhancement-templates.ts` provides the six ABAP FRAGMENT generators
 * (H50). This module writes and activates a throwaway `IF_OO_ADT_CLASSRUN`
 * bridge class carrying one fragment (same pattern as `./run.ts` and
 * `./bopf-runtime.ts`), runs it, and parses the tagged stdout the fragment
 * writes via `out->write(...)`.
 *
 * Every exported function gates twice: `gate.assertIntent` against an
 * `EnhancementIntent` (`../safety.ts`), AND `authorizeMutation`/
 * `gate.assert("activate", …)` against the bridge class itself — one gate
 * judges "may this class run", the other "is the enhancement mutation it
 * performs allowed". `exerciseBadi` gates with `op: "execute"` (`CALL BADI`
 * is execution, not a read).
 *
 * All creates land in `$TMP` (`ENH_CREATE_PACKAGE` = `run.ts`'s
 * `BRIDGE_PACKAGE`) — fixtures 339/350.
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
 *    `epilogueFragment`'s inline save/activate (field report
 *    ZTM_HW011B_IMPL); `createEnhancementSpot`, `addBadiDefinition`,
 *    `addFilterDefinition` and `createBadiImplementation` each perform an
 *    extra `activateObject` against the spot to close this gap.
 */
import type { AbapConnection } from "./connection.js";
import { AbapError, isAbapError } from "./errors.js";
import type { AuthorizedTarget, SafetyGate } from "../safety.js";
import type { ActivationResult } from "abap-adt-api/build/api/activate.js";
import {
  authorizeMutation,
  writeObject,
  enhancementIntentFor,
  NO_JOURNAL,
  type EnhancedObjectRef,
} from "./write.js";
import { isNotFoundError } from "./session.js";
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
  BRIDGE_PACKAGE,
  deployBridge,
  executeBridge,
  verifyBridgeActivation,
  type RunResult,
} from "./run.js";
import { buildEnhancementUri, ENHOXH_COLLECTION, ENHSXS_COLLECTION } from "./enhancement.js";
import {
  assertEnhIdentifier,
  createSpotFragment,
  addBadiDefFragment,
  addFilterDefFragment,
  createImplFragment,
  setFilterValuesFragment,
  exerciseFragment,
  markerInterfaceSource,
  type CreateSpotParams,
  type AddBadiDefParams,
  type AddFilterDefParams,
  type CreateImplParams,
  type SetFilterValuesParams,
  type ExerciseParams,
} from "./enhancement-templates.js";

/** Where every create operation lands — same value as `run.ts`'s `BRIDGE_PACKAGE`, re-exported under this module's own name. */
export const ENH_CREATE_PACKAGE = BRIDGE_PACKAGE;

// ---------------------------------------------------------------------------
// Fixed bridge-class names — one per operation, not per target object
// ---------------------------------------------------------------------------

/**
 * Fixed names, not hashed per-target like `run.ts`/`bopf-runtime.ts` — these
 * are one-off actions with no stable target to hash on; `writeObject`
 * already skips the PUT when content is unchanged. Exported so
 * `test/enhancement-bridge.test.ts` can key fake-server routes on the real
 * names.
 */
export const BRIDGE_CLASS = {
  createSpot: "ZCL_ZMCP_ENH_CSPOT",
  addBadiDef: "ZCL_ZMCP_ENH_ADEF",
  addFilterDef: "ZCL_ZMCP_ENH_FDEF",
  createImpl: "ZCL_ZMCP_ENH_CIMPL",
  setFilterValues: "ZCL_ZMCP_ENH_FVAL",
  exercise: "ZCL_ZMCP_ENH_EXEC",
} as const;

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

/** Locals every fragment in this file's DATA-section vocabulary might need — see fixtures 339/350/466. */
const DATA_COMMON = ["lv_pkg TYPE devclass VALUE '$TMP'.", "lv_trkorr TYPE trkorr."] as const;
const DATA_SPOT = ["lo_spot TYPE REF TO if_enh_spot_tool.", "lo_def TYPE REF TO cl_enh_tool_badi_def."] as const;
const DATA_FILTER = ["ls_badi TYPE enh_badi_data.", "ls_filter TYPE enh_badi_filter."] as const;
const DATA_IMPL_CREATE = [
  "lo_enh TYPE REF TO if_enh_tool.",
  "lo_impl TYPE REF TO cl_enh_tool_badi_impl.",
  "ls_impl TYPE enh_badi_impl_data.",
] as const;
const DATA_FILTER_VALUES = [
  "lo_tool TYPE REF TO if_enh_tool.",
  "lo_obj TYPE REF TO if_enh_object.",
  "lo_impl TYPE REF TO cl_enh_tool_badi_impl.",
  "ls_impl TYPE enh_badi_impl_data.",
  "ls_val TYPE enh_badiimpl_filter_value.",
  "ls_root TYPE enh_badiimpl_filter_root.",
  "ls_id TYPE LINE OF enh_badiimpl_filter_id_it.",
] as const;

// ---------------------------------------------------------------------------
// Epilogue / acquisition — the two small closed-vocabulary generators every
// create path shares. Parametrized only by a handful of CODE-CONTROLLED
// handle-expression literals — never by caller input.
// ---------------------------------------------------------------------------

type HandleExpr = "lo_spot->if_enh_object~" | "lo_enh->if_enh_object~" | "lo_obj->";

/**
 * `SAVE`/`ACTIVATE`/`UNLOCK`, run_dark throughout — verified live at fixtures
 * 339, 350 and 466 (three independent captures of this exact three-call
 * shape, differing only in the handle expression / `~` qualifier per fixture
 * 466's doc comment in `enhancement-templates.ts`).
 */
function epilogueFragment(handle: HandleExpr): string[] {
  return [
    `${handle}save( EXPORTING run_dark = abap_true CHANGING devclass = lv_pkg trkorr = lv_trkorr ).`,
    `${handle}activate( EXPORTING run_dark = abap_true CHANGING devclass = lv_pkg trkorr = lv_trkorr ).`,
    `${handle}unlock( ).`,
  ];
}

/**
 * Diagnostic-only defect-2 guard: reports whether the BAdI definition this
 * implementation binds to declares any filters, so `createBadiImplementation`
 * can warn about a filter-less impl on a filter-dependent multi-use BAdI
 * silently dispatching for any value. Never blocks, mutates, or fails the
 * surrounding create — wrapped in its own TRY/CATCH (swallowed) since
 * `bridgeSource`'s outer TRY/CATCH is fatal to the whole classrun. Lock
 * release is a second, separate nested TRY/CATCH so a failure mid-check
 * can't leave the spot locked. See archive for full rationale.
 */
function badiFilterCheckFragment(spotName: string, badiName: string): string[] {
  return [
    "TRY.",
    `    lo_spot = cl_enh_factory=>get_enhancement_spot( spot_name = ${assertQuotedLiteral(spotName)} lock = 'X' run_dark = abap_true ).`,
    "    lo_def ?= lo_spot.",
    `    ls_badi = lo_def->get_badi_def( badi_name = ${assertQuotedLiteral(badiName)} ).`,
    "    IF ls_badi-filters IS NOT INITIAL.",
    "      out->write( 'BADI-HAS-FILTERS' ).",
    "    ELSE.",
    "      out->write( 'BADI-NO-FILTERS' ).",
    "    ENDIF.",
    "  CATCH cx_root.",
    "    out->write( 'BADI-FILTER-CHECK-INCONCLUSIVE' ).",
    "ENDTRY.",
    "IF lo_spot IS BOUND.",
    "  TRY.",
    "      lo_spot->if_enh_object~unlock( ).",
    "    CATCH cx_root.",
    "  ENDTRY.",
    "ENDIF.",
  ];
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
 * shared halves; this wraps them with the `$TMP` alias and enhancement-
 * specific wording.
 */
async function writeActivateRunBridge(
  conn: AbapConnection,
  gate: SafetyGate,
  className: string,
  source: string,
  description: string,
): Promise<RunResult> {
  const deployed = await deployBridge(conn, gate, {
    className,
    source,
    description,
    packageName: ENH_CREATE_PACKAGE,
    what: `Activation of the generated enhancement bridge ${className}`,
    verify: (activation) => verifyBridgeActivation(activation, className, "enhancement bridge"),
  });
  return executeBridge(conn, gate, deployed);
}

// ---------------------------------------------------------------------------
// H21 — the marker interface
// ---------------------------------------------------------------------------

/**
 * Check-then-create-if-missing, per `enhancement-templates.ts`'s H21 doc
 * comment: never overwrite a caller's own interface body. Activation is
 * never skipped either way (fresh or pre-existing) — an inactive marker
 * interface would break the `add_badi_def` call that follows.
 */
async function ensureMarkerInterface(conn: AbapConnection, gate: SafetyGate, interfaceName: string): Promise<void> {
  const name = assertEnhIdentifier(interfaceName, "interfaceName");
  const authorized = await authorizeMutation(conn, gate, "write", {
    type: "INTF/OI",
    name,
    packageName: ENH_CREATE_PACKAGE,
    description: "abapsmith BAdI marker interface (H21)",
  });
  if (!authorized.target.exists) {
    // NO_JOURNAL — a generated $TMP marker interface, not user source; no
    // before-image worth journaling.
    await writeObject(conn, authorized, {
      source: markerInterfaceSource(name),
      onBeforeImage: NO_JOURNAL,
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
}

export async function createEnhancementSpot(
  conn: AbapConnection,
  gate: SafetyGate,
  params: CreateEnhancementSpotParams,
): Promise<{ run: RunResult; transcript: EnhTranscriptResult; activation: ActivationOutcome }> {
  const spotName = assertEnhIdentifier(params.spotName, "spotName");
  const intent = enhancementIntentFor(
    { name: spotName, type: "ENHS/XS", packageName: ENH_CREATE_PACKAGE },
    params.affects,
  );
  gate.assertIntent(intent, { op: "write" });
  gate.assertIntent(intent, { op: "activate" });

  // createSpotFragment never called save/activate/unlock on the new spot,
  // so it was never persisted — a separate bug found via fixtures 899-914;
  // fixed here to mirror every sibling operation. See archive.
  const body = [
    ...createSpotFragment({ spotName, description: params.description }),
    ...epilogueFragment("lo_spot->if_enh_object~"),
  ];
  const source = bridgeSource(BRIDGE_CLASS.createSpot, [...DATA_COMMON, ...DATA_SPOT], body);
  const run = await writeActivateRunBridge(
    conn,
    gate,
    BRIDGE_CLASS.createSpot,
    source,
    `abapsmith T15 create-enhancement-spot bridge (${spotName})`,
  );
  const transcript = parseEnhancementTranscript(run.output);
  assertEnhTranscript(transcript, ["SPOT-OBJECT-CREATED"], `Creating enhancement spot ${spotName}`);

  // Closes the isActive-vs-adtcore:version gap (see header). Not
  // assertNoErrors-wrapped: creation is already confirmed above, so a
  // failure here means "created, not activated", not "nothing created".
  const activation = await activateObject(conn, { name: spotName, uri: spotUri(spotName) });
  return { run, transcript, activation };
}

// ---------------------------------------------------------------------------
// 2/6 — addBadiDefinition
// ---------------------------------------------------------------------------

export interface AddBadiDefinitionParams extends AddBadiDefParams {
  spotName: string;
  affects: EnhancedObjectRef;
}

export async function addBadiDefinition(
  conn: AbapConnection,
  gate: SafetyGate,
  params: AddBadiDefinitionParams,
): Promise<{ run: RunResult; transcript: EnhTranscriptResult; activation: ActivationOutcome }> {
  const spotName = assertEnhIdentifier(params.spotName, "spotName");
  const badiName = assertEnhIdentifier(params.badiName, "badiName");
  const interfaceName = assertEnhIdentifier(params.interfaceName, "interfaceName");
  const intent = enhancementIntentFor(
    { name: badiName, type: "ENHS/XS", packageName: ENH_CREATE_PACKAGE },
    { ...params.affects, spotName },
  );
  gate.assertIntent(intent, { op: "write" });
  gate.assertIntent(intent, { op: "activate" });

  // H21 — before touching the spot at all.
  await ensureMarkerInterface(conn, gate, interfaceName);

  const acquire = [
    // Locked GET of the existing spot. `spot` is RETURNING, not IMPORTING
    // (fixtures 486, 893). Locking inferred by symmetry with fixture 466 —
    // see header, deviation (2).
    `lo_spot = cl_enh_factory=>get_enhancement_spot( spot_name = ${assertQuotedLiteral(spotName)} lock = 'X' run_dark = abap_true ).`,
    "lo_def ?= lo_spot.",
  ];
  const body = [...acquire, ...addBadiDefFragment({ ...params, badiName, interfaceName }), ...epilogueFragment("lo_spot->if_enh_object~")];
  const source = bridgeSource(BRIDGE_CLASS.addBadiDef, [...DATA_COMMON, ...DATA_SPOT, ...DATA_FILTER], body);
  const run = await writeActivateRunBridge(
    conn,
    gate,
    BRIDGE_CLASS.addBadiDef,
    source,
    `abapsmith T15 add-badi-def bridge (${badiName} on ${spotName})`,
  );
  const transcript = parseEnhancementTranscript(run.output);
  assertEnhTranscript(transcript, ["BADI-DEF-ADDED"], `Adding BAdI definition ${badiName} to spot ${spotName}`);

  // Closes the isActive-vs-adtcore:version gap (see header). Targets the
  // spot alone (badiName has no own ADT object/URI) — not H23's joint form.
  // Non-fatal, unlike H21's marker-interface activation above: creation is
  // already confirmed by the transcript assertion.
  const activation = await activateObject(conn, { name: spotName, uri: spotUri(spotName) });
  return { run, transcript, activation };
}

// ---------------------------------------------------------------------------
// 3/6 — addFilterDefinition
// ---------------------------------------------------------------------------

export interface AddFilterDefinitionParams extends AddFilterDefParams {
  spotName: string;
  affects: EnhancedObjectRef;
}

export async function addFilterDefinition(
  conn: AbapConnection,
  gate: SafetyGate,
  params: AddFilterDefinitionParams,
): Promise<{ run: RunResult; transcript: EnhTranscriptResult; activation: ActivationOutcome }> {
  const spotName = assertEnhIdentifier(params.spotName, "spotName");
  const badiName = assertEnhIdentifier(params.badiName, "badiName");
  const intent = enhancementIntentFor(
    { name: badiName, type: "ENHS/XS", packageName: ENH_CREATE_PACKAGE },
    { ...params.affects, spotName },
  );
  gate.assertIntent(intent, { op: "write" });
  gate.assertIntent(intent, { op: "activate" });

  const acquire = [
    // `spot` is RETURNING, not IMPORTING — see addBadiDefinition's acquire
    // comment above and this module's header, deviation (2).
    `lo_spot = cl_enh_factory=>get_enhancement_spot( spot_name = ${assertQuotedLiteral(spotName)} lock = 'X' run_dark = abap_true ).`,
    "lo_def ?= lo_spot.",
  ];
  const body = [...acquire, ...addFilterDefFragment({ ...params, badiName }), ...epilogueFragment("lo_spot->if_enh_object~")];
  const source = bridgeSource(BRIDGE_CLASS.addFilterDef, [...DATA_COMMON, ...DATA_SPOT, ...DATA_FILTER], body);
  const run = await writeActivateRunBridge(
    conn,
    gate,
    BRIDGE_CLASS.addFilterDef,
    source,
    `abapsmith T15 add-filter-def bridge (${params.filterName} on ${badiName})`,
  );
  const transcript = parseEnhancementTranscript(run.output);
  assertEnhTranscript(transcript, ["FILTER-DEF-ADDED"], `Adding filter definition ${params.filterName} to ${badiName}`);

  // Closes the isActive-vs-adtcore:version gap (see header). Single-object,
  // not H23's joint form: addFilterDefFragment only declares that the
  // DEFINITION supports filtering (spot-level metadata) — AddFilterDefParams
  // carries no implementation identifier, so there is no second object to
  // name in a joint call. Same target as addBadiDefinition/createEnhancementSpot.
  const activation = await activateObject(conn, { name: spotName, uri: spotUri(spotName) });
  return { run, transcript, activation };
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
}

export async function createBadiImplementation(
  conn: AbapConnection,
  gate: SafetyGate,
  params: CreateBadiImplementationParams,
): Promise<{
  run: RunResult;
  transcript: EnhTranscriptResult;
  activation: ActivationOutcome;
  implClass: { name: string; exists: boolean | undefined };
}> {
  const enhName = assertEnhIdentifier(params.enhName, "enhName");
  const spotName = assertEnhIdentifier(params.spotName, "spotName");
  const badiName = assertEnhIdentifier(params.badiName, "badiName");
  const implClass = assertEnhIdentifier(params.implClass, "implClass");
  const intent = enhancementIntentFor(
    { name: enhName, type: "ENHO/XH", packageName: ENH_CREATE_PACKAGE },
    { ...params.affects, spotName },
  );
  gate.assertIntent(intent, { op: "write" });
  gate.assertIntent(intent, { op: "activate" });

  const body = [
    ...createImplFragment(params),
    ...epilogueFragment("lo_enh->if_enh_object~"),
    // Defect-2 guard (see badiFilterCheckFragment) — runs after success
    // tags are written and can never turn a successful create into a
    // failure.
    ...badiFilterCheckFragment(spotName, badiName),
  ];
  const source = bridgeSource(
    BRIDGE_CLASS.createImpl,
    [...DATA_COMMON, ...DATA_SPOT, ...DATA_FILTER, ...DATA_IMPL_CREATE],
    body,
  );
  const run = await writeActivateRunBridge(
    conn,
    gate,
    BRIDGE_CLASS.createImpl,
    source,
    `abapsmith T15 create-badi-impl bridge (${enhName})`,
  );
  const transcript = parseEnhancementTranscript(run.output);
  assertEnhTranscript(transcript, ["ENHO-OBJECT-CREATED", "IMPL-ADDED"], `Creating BAdI implementation ${enhName}`);

  // Field report ZTM_HW011B_IMPL: the epilogue's inline SAVE/ACTIVATE/UNLOCK
  // reliably sets the runtime dispatch flag (ls_impl-active) but does NOT
  // reliably promote adtcore:version to active. enhancement-write.ts's
  // writeAndActivateEnhancementDescription closes the identical gap with an
  // extra activateObject call; done here directly and unconditionally
  // (params.active is the orthogonal runtime dispatch flag). Not
  // assertNoErrors-wrapped: creation is already confirmed above, so a
  // failure here means "created, not activated", not "nothing created".
  const activation = await activateObject(conn, { name: enhName, uri: implUri(enhName) });
  const exists = await implementingClassExists(conn, implClass);
  return { run, transcript, activation, implClass: { name: implClass, exists } };
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
}

export async function setFilterValues(
  conn: AbapConnection,
  gate: SafetyGate,
  params: SetFilterValuesRequestParams,
): Promise<{ run: RunResult; transcript: EnhTranscriptResult; jointActivation: ActivationOutcome }> {
  const enhName = assertEnhIdentifier(params.enhName, "enhName");
  const spotName = assertEnhIdentifier(params.spotName, "spotName");
  const intent = enhancementIntentFor(
    { name: enhName, type: "ENHO/XH", packageName: ENH_CREATE_PACKAGE },
    { ...params.affects, spotName },
  );
  gate.assertIntent(intent, { op: "write" });
  gate.assertIntent(intent, { op: "activate" });

  const acquire = [
    // Fixture 466's exact acquisition — get-existing-and-lock, then cast
    // twice. `enhancement` is RETURNING, not IMPORTING.
    `lo_tool = cl_enh_factory=>get_enhancement( enhancement_id = ${assertQuotedLiteral(enhName)} lock = 'X' run_dark = abap_true ).`,
    "lo_impl ?= lo_tool.",
    "lo_obj ?= lo_tool.",
  ];
  const body = [...acquire, ...setFilterValuesFragment(params), ...epilogueFragment("lo_obj->")];
  const source = bridgeSource(BRIDGE_CLASS.setFilterValues, [...DATA_COMMON, ...DATA_FILTER_VALUES], body);
  const run = await writeActivateRunBridge(
    conn,
    gate,
    BRIDGE_CLASS.setFilterValues,
    source,
    `abapsmith T15 set-filter-values bridge (${enhName})`,
  );
  const transcript = parseEnhancementTranscript(run.output);
  assertEnhTranscript(transcript, ["IMPL-REPLACED"], `Setting filter values on implementation ${enhName}`);

  // H23: the inline implementation-level activate above is necessary but
  // not sufficient (fixtures 471/473/478 vs 492) — a second gate check plus
  // the joint call. `authorizeIntent` (not `assertIntent`) so the minted
  // token is the only way to reach `activateSpotAndImplementation`'s
  // `conn.post`.
  const jointAuthorized = gate.authorizeIntent(
    "activate",
    intent,
    { name: enhName, packageName: ENH_CREATE_PACKAGE, type: "ENHO/XH" },
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
  return { run, transcript, jointActivation };
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

// ---------------------------------------------------------------------------
// Small internal helper — a validated identifier as an ABAP string literal
// ---------------------------------------------------------------------------

/**
 * `assertEnhIdentifier` already refused anything a bare identifier grammar
 * would reject (H50) — this only adds the surrounding quotes for the
 * `spot_name =`/`enhancement_id =` acquisition calls above, which are not
 * part of the closed `enhancement-templates.ts` set (they are the
 * choreography AROUND it) but embed caller-controlled text the same way.
 */
function assertQuotedLiteral(identifier: string): string {
  return `'${identifier}'`;
}
