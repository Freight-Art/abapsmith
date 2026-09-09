/**
 * Deploy a `LoadedFluidTool`'s ABAP objects and keep them in sync: classify
 * every object against the manifest, act on whatever is not already
 * `present`, and cache the outcome so a warm process costs nothing at all.
 * `classifyFluidTool` shares the classification half but never mutates —
 * used by `verify`, which must answer honestly without writing anything.
 */
import type { AbapConnection } from "../connection.js";
import type { Config } from "../../config.js";
import type { SafetyGate } from "../../safety.js";
import { systemKey } from "../../journal.js";
import { SERVER_VERSION } from "../../version.js";
import { AbapError, describeUnknownError, isAbapError } from "../errors.js";
import { discloseBridgeResidue, type BridgeResidueStage } from "../bridge-residue.js";
import {
  authorizeMutation,
  canonicalEtag,
  deleteObject,
  NO_JOURNAL,
  readCurrentSourceResult,
  resolveWriteTarget,
  writeObject,
  type ResolvedTarget,
  type WriteResult,
} from "../write.js";
import { activateObject, assertNoErrors, checkSource } from "../activate.js";
import { isSessionDeadFailure } from "../write-verify.js";
import { FLUID_PACKAGE, LEGACY_FLUID_PACKAGES, isReservedFluidName, ensureFluidPackage } from "./package.js";
import { forgetManifest, readFluidRegistry, recordManifest } from "./registry.js";
import type { FluidObjectSpec, FluidObjectType, LoadedFluidTool } from "./manifest.js";
import { fluidDisabledReason, type FluidConfigFields } from "./enabled.js";
import { FLUID_RUNTIME_CLASS, fluidRuntimeTool } from "./abap/runtime.js";

export type FluidObjectState =
  | "absent" | "present" | "stale" | "inactive" | "broken" | "foreign" | "legacy" | "newer";

export interface FluidObjectStatus {
  readonly name: string;
  readonly type: FluidObjectType;
  readonly state: FluidObjectState;
  /** set for `legacy` and `foreign` */
  readonly foundIn?: string;
}

export interface EnsureFluidToolResult {
  readonly toolId: string;
  readonly version: string;
  /** true when anything was actually written this call */
  readonly deployed: boolean;
  readonly objects: readonly FluidObjectStatus[];
}

export interface FluidCallContext {
  readonly tool: string;
  readonly action: string;
  readonly op: "list" | "describe" | "status" | "verify" | "run" | "repair" | "remove";
}

// One redeploy per (system, tool) per process, not per object: a manifest
// that needs a second write anywhere has already used its one shot for
// everything else in it too. Cleared only by `resetFluidEnsureState`.
const redeployed = new Set<string>();

export function resetFluidEnsureState(): void {
  redeployed.clear();
}

interface Classification {
  readonly resolved: ResolvedTarget;
  readonly state: FluidObjectState;
  readonly foundIn?: string;
  /** set for `newer` — the abapsmith version the installed source's marker names */
  readonly installedVersion?: string;
}

// Provenance stamped into the TEXT ENSURE ACTUALLY DEPLOYS, never into a
// manifest source or the version hash that keys the registry cache (see
// `manifestVersion` — computed straight from `LoadedFluidTool.sources`,
// which never sees this line). One ABAP comment line, same idea as the
// generated-header line `invokerSource` puts atop an invoker (invoke.ts:194),
// just one layer down: this is what lets a second abapsmith release sharing
// the system recognise an object a NEWER release already owns instead of
// classifying a mere etag difference as `stale` and rewriting it forever.
const DEPLOYED_VERSION_MARKER_RE = /^\* abapsmith fluid v(\S+)\r?\n/;

function withDeployedVersionMarker(source: string): string {
  return `* abapsmith fluid v${SERVER_VERSION}\n${source}`;
}

/** `undefined` when the installed text carries no marker at all — an object a pre-marker abapsmith deployed. */
function readDeployedVersion(installedSource: string): string | undefined {
  return DEPLOYED_VERSION_MARKER_RE.exec(installedSource)?.[1];
}

function stripDeployedVersionMarker(installedSource: string): string {
  return installedSource.replace(DEPLOYED_VERSION_MARKER_RE, "");
}

/**
 * `major.minor.patch` only — the one shape `SERVER_VERSION` has ever taken,
 * and there is no semver dependency in this repo to reach for instead.
 * `undefined` for either input means "not comparable", never "not newer": the
 * caller falls back to today's plain content comparison rather than acting on
 * a guess.
 */
function isNewerVersion(a: string, b: string): boolean | undefined {
  const pa = /^(\d+)\.(\d+)\.(\d+)/.exec(a.trim());
  const pb = /^(\d+)\.(\d+)\.(\d+)/.exec(b.trim());
  if (!pa || !pb) return undefined;
  for (let i = 1; i <= 3; i++) {
    const na = Number(pa[i]);
    const nb = Number(pb[i]);
    if (na !== nb) return na > nb;
  }
  return false;
}

async function classifyOne(
  conn: AbapConnection,
  obj: FluidObjectSpec,
  expectedSource: string,
): Promise<Classification> {
  const resolved = await resolveWriteTarget(conn, { type: obj.type, name: obj.name }, "write");
  if (!resolved.exists) return { resolved, state: "absent" };

  const pkg = resolved.packageName;
  // Compare case-insensitively (the server may answer with different casing
  // than our literal), but keep `foundIn: pkg` as the server's own spelling
  // so an error names what the server actually said.
  const pkgNormalized = pkg.trim().toUpperCase();
  if (pkgNormalized !== FLUID_PACKAGE) {
    if (LEGACY_FLUID_PACKAGES.includes(pkgNormalized) && isReservedFluidName(obj.name)) {
      return { resolved, state: "legacy", foundIn: pkg };
    }
    return { resolved, state: "foreign", foundIn: pkg };
  }

  const read = await readCurrentSourceResult(conn, resolved);
  if (!read.ok) {
    throw new AbapError(
      "ADT_ERROR",
      `Could not read the current source of ${obj.name} to check it against the manifest: ` +
        describeUnknownError(read.error),
      { name: obj.name, type: obj.type },
      "Nothing was written or activated. Retry once the object is readable again.",
    );
  }

  const installed = read.source ?? "";
  const installedVersion = readDeployedVersion(installed);
  if (installedVersion !== undefined && isNewerVersion(installedVersion, SERVER_VERSION) === true) {
    return { resolved, state: "newer", installedVersion };
  }

  // Marker stripped from the installed side only — `expectedSource` is the
  // raw manifest source and never carries one. An object a pre-marker
  // abapsmith deployed (no marker at all) compares exactly as it always did:
  // lacking the marker is not by itself a content difference.
  if (canonicalEtag(stripDeployedVersionMarker(installed)) !== canonicalEtag(expectedSource)) {
    return { resolved, state: "stale" };
  }
  if (resolved.activation !== "active-is-current") {
    return { resolved, state: "inactive" };
  }
  const check = await checkSource(conn, resolved, withDeployedVersionMarker(expectedSource));
  return { resolved, state: check.ok ? "present" : "broken" };
}

function objectStatus(obj: FluidObjectSpec, c: Classification): FluidObjectStatus {
  return {
    name: obj.name,
    type: obj.type,
    state: c.state,
    ...(c.foundIn !== undefined ? { foundIn: c.foundIn } : {}),
  };
}

/**
 * Read-only, always-live classification: every status here comes from at
 * least one server round trip made in this call (`classifyOne` always starts
 * with `resolveWriteTarget`, and only reaches `"present"` after also reading
 * current source and running `checkSource`). It never reads the on-disk
 * registry (`readFluidRegistry`/`registry.ts`) and never reads the
 * `redeployed` in-memory ledger below — those are only touched by the
 * mutating path (`ensureFluidTool` / `deployAndVerify`). A `"present"` here
 * always means the server was actually asked, unlike `ensureFluidTool`'s
 * cache-trusting fast path, which can report every object `"present"` for a
 * tool the server no longer has, straight from a matching registry entry.
 */
export async function classifyFluidTool(
  conn: AbapConnection,
  cfg: FluidConfigFields,
  tool: LoadedFluidTool,
): Promise<readonly FluidObjectStatus[]> {
  const disabled = fluidDisabledReason(cfg);
  if (disabled) throw fluidDisabledError(disabled, cfg, tool);

  const statuses: FluidObjectStatus[] = [];
  for (const obj of tool.manifest.objects) {
    const expectedSource = requireSource(tool, obj);
    const c = await classifyOne(conn, obj, expectedSource);
    statuses.push(objectStatus(obj, c));
  }
  return statuses;
}

function requireSource(tool: LoadedFluidTool, obj: FluidObjectSpec): string {
  const source = tool.sources.get(obj.name);
  if (source === undefined) {
    throw new AbapError(
      "FLUID_MANIFEST_INVALID",
      `${tool.manifest.id}: no ABAP source was loaded for object ${obj.name}.`,
      { tool: tool.manifest.id, object: obj.name },
      "This is a loader defect, not something the caller did — every manifest object must have a resolved source.",
    );
  }
  return source;
}

function fluidDisabledError(
  reason: NonNullable<ReturnType<typeof fluidDisabledReason>>,
  cfg: FluidConfigFields,
  tool: LoadedFluidTool,
  ctx?: FluidCallContext,
): AbapError {
  const flagEnabled = cfg.fluidApi !== false;
  const details: Record<string, unknown> = {
    reason: reason.kind,
    ...(reason.kind === "flag" ? {} : { field: reason.field }),
    flag: "ABAP_FLUID_API",
    flagEnabled,
    package: FLUID_PACKAGE,
    tool: ctx?.tool ?? tool.manifest.id,
    ...(ctx ? { action: ctx.action, op: ctx.op } : {}),
    objects: tool.manifest.objects.map((o) => o.name),
  };

  const who = ctx ? `${ctx.tool}.${ctx.action}` : tool.manifest.id;

  const message =
    reason.kind === "flag"
      ? `The fluid API is disabled (ABAP_FLUID_API=false). ${who} was not run — nothing was ` +
        `deployed, checked, or changed.`
      : `${who} needs the fluid API, and this connection is read-only (${reason.field}). There is ` +
        `no read-only subset of the fluid API — even a check can need to deploy or repair the ABAP ` +
        `side first, so nothing ran and nothing was changed.`;

  const hint =
    reason.kind === "flag"
      ? "Set ABAP_FLUID_API=true (or leave it unset — it defaults to enabled) to use the fluid API. " +
        "The ordinary write ceilings (ABAP_ALLOW_WRITE, ABAP_MODE, the productive-system lockout, " +
        "ABAP_ALLOW_PACKAGES) still apply on top once it is."
      : "Connect with write access (ABAP_ALLOW_WRITE=true, ABAP_MODE not \"read\", and off a " +
        "productive system) to use any part of the fluid API.";

  return new AbapError("FLUID_API_DISABLED", message, details, hint);
}

function foreignConflictError(obj: FluidObjectSpec, foundIn: string, tool: LoadedFluidTool): AbapError {
  return new AbapError(
    "FLUID_OBJECT_CONFLICT",
    `${obj.type} ${obj.name} already exists in ${foundIn}, a package abapsmith does not own. ` +
      `Nothing was changed.`,
    { name: obj.name, type: obj.type, foundIn, tool: tool.manifest.id },
    `abapsmith will not delete or overwrite an object it does not own. Rename ${obj.name} in the ` +
      `manifest, or move/delete the existing object out of ${foundIn} yourself.`,
  );
}

function newerVersionConflictError(
  obj: FluidObjectSpec,
  tool: LoadedFluidTool,
  installedVersion: string,
): AbapError {
  return new AbapError(
    "FLUID_OBJECT_CONFLICT",
    `${obj.type} ${obj.name} was deployed by abapsmith v${installedVersion}, newer than this ` +
      `abapsmith (v${SERVER_VERSION}). Nothing was changed.`,
    { name: obj.name, type: obj.type, installed_version: installedVersion, our_version: SERVER_VERSION, tool: tool.manifest.id },
    "upgrade abapsmith or run abap_fluid op=remove",
  );
}

function redeployExhaustedError(
  obj: FluidObjectSpec,
  tool: LoadedFluidTool,
  redeployedThisCall: boolean,
): AbapError {
  return new AbapError(
    "FLUID_OBJECT_CONFLICT",
    `${obj.type} ${obj.name} still does not match the manifest after ${
      redeployedThisCall ? "a redeploy" : "being written and activated"
    } — something else is writing to it concurrently, or the server is silently rejecting the content.`,
    { name: obj.name, type: obj.type, tool: tool.manifest.id },
    redeployedThisCall
      ? "This tool has already used its one redeploy for this process. Investigate before retrying."
      : "This manifest's one redeploy for this process is already spent, so none was attempted here. " +
        "Investigate before retrying.",
  );
}

async function writeAndActivateOnce(
  conn: AbapConnection,
  gate: SafetyGate,
  obj: FluidObjectSpec,
  expectedSource: string,
  // Set only by a caller whose immediately preceding request was a DELETE:
  // live-verified on A4H, deleting an ABAP class tears the session down
  // server-side, and the very next request on those cookies (this
  // re-authorize GET) is the one that surfaces `SESSION_DEAD`. Defaulting to
  // false keeps every other caller (redeploy, plain stale/absent writes)
  // from paying for a revive it will never need — a proactive reconnect on
  // every write would burn a logon against AbapConnection's lifetime ceiling
  // for nothing.
  reviveOnDeadSession = false,
): Promise<WriteResult> {
  const spec = {
    type: obj.type,
    name: obj.name,
    packageName: FLUID_PACKAGE,
    description: obj.description,
  };
  const authorized = reviveOnDeadSession
    ? await (async () => {
        // Same one-shot revive-and-retry idiom as `authorizeBridgeTarget`
        // (run.ts) and `probeObjectPresence` (write-verify.ts): one
        // reconnect-and-re-issue, never a loop. A second consecutive
        // session death is a real failure and must propagate.
        try {
          return await authorizeMutation(conn, gate, "write", spec);
        } catch (e) {
          if (!isSessionDeadFailure(e)) throw e;
          await conn.connect();
          return await authorizeMutation(conn, gate, "write", spec);
        }
      })()
    : await authorizeMutation(conn, gate, "write", spec);

  const write = await writeObject(conn, authorized, { source: expectedSource, onBeforeImage: NO_JOURNAL });

  // Same F6 shortcut as deployBridge (run.ts): nothing changed and round
  // trip 1's own body already showed the active version is current, so a
  // reactivation POST would be a pure no-op.
  const alreadyActive =
    !write.created && !write.changed && write.target.activation === "active-is-current";

  let stage: BridgeResidueStage = "activate-gate";
  try {
    gate.assert("activate", {
      name: write.target.name,
      packageName: write.target.packageName,
      type: write.target.type,
    });

    if (alreadyActive) return write;

    stage = "activation";
    const activation = await activateObject(conn, write.target);
    assertNoErrors(activation, {
      what: `Deploy fluid object ${obj.name}`,
      name: obj.name,
      source: expectedSource,
    });
    return write;
  } catch (e) {
    throw discloseBridgeResidue(e, obj.name, FLUID_PACKAGE, stage);
  }
}

async function contentConfirmed(
  conn: AbapConnection,
  target: ResolvedTarget,
  expectedSource: string,
): Promise<boolean> {
  // `target.exists` is set once by `resolveWriteTarget` and never flipped by
  // a create inside `writeObject` — reusing it as-is would make
  // `readCurrentSourceResult` skip the GET entirely for a just-created object.
  const fresh: ResolvedTarget = { ...target, exists: true };
  const read = await readCurrentSourceResult(conn, fresh);
  if (!read.ok) {
    throw new AbapError(
      "ADT_ERROR",
      `${target.name} was written and activated, but its source could not be read back to ` +
        `confirm the deploy: ${describeUnknownError(read.error)}`,
      { name: target.name, type: target.type },
      "The write and activation already happened; only the confirmation read failed. Retry the call.",
    );
  }
  return read.source !== undefined && canonicalEtag(read.source) === canonicalEtag(expectedSource);
}

async function deployAndVerify(
  conn: AbapConnection,
  gate: SafetyGate,
  ledgerKey: string,
  tool: LoadedFluidTool,
  obj: FluidObjectSpec,
  expectedSource: string,
  // Forwarded to the FIRST writeAndActivateOnce only — see that function's
  // doc. The redeploy attempt below always follows a completed request
  // sequence (the first write, plus a confirmation read), never a DELETE, so
  // it must not get a free revive.
  reviveOnDeadSession = false,
): Promise<WriteResult> {
  let write = await writeAndActivateOnce(conn, gate, obj, expectedSource, reviveOnDeadSession);
  try {
    if (await contentConfirmed(conn, write.target, expectedSource)) return write;

    if (redeployed.has(ledgerKey)) {
      throw redeployExhaustedError(obj, tool, false);
    }
    redeployed.add(ledgerKey);
  } catch (e) {
    throw discloseBridgeResidue(e, obj.name, FLUID_PACKAGE, "content-verify");
  }

  write = await writeAndActivateOnce(conn, gate, obj, expectedSource);
  try {
    if (await contentConfirmed(conn, write.target, expectedSource)) return write;
    throw redeployExhaustedError(obj, tool, true);
  } catch (e) {
    throw discloseBridgeResidue(e, obj.name, FLUID_PACKAGE, "content-verify");
  }
}

// SAP reuses `ExceptionResourceAlreadyExists` for two unrelated things: a
// genuine duplicate-create race, and (per write.test.ts's own
// DDIC_REJECT_XML fixture, "a syntax problem mislabelled as AlreadyExists")
// an ordinary syntax/save failure that happens to get the same exception
// type. Both `translateWriteFailure`'s CHECK_FAILED path (write.ts, the PUT
// after a skeleton create) and `translateAdtError`'s generic ADT_ERROR
// catch-all (session.ts, the vendor `createObject()` call CLAS/OC and INTF/OI
// actually go through) put the raw SAP exception type into
// `details.adtExceptionType` regardless of which one throws — so matching on
// that field, not on the wrapping `AbapError.code`, is the one signal that
// survives either path.
function isCreateConflict(e: unknown): boolean {
  return isAbapError(e) && e.details["adtExceptionType"] === "ExceptionResourceAlreadyExists";
}

async function actOnClassification(
  conn: AbapConnection,
  gate: SafetyGate,
  ledgerKey: string,
  tool: LoadedFluidTool,
  obj: FluidObjectSpec,
  expectedSource: string,
  c: Classification,
  // False only on the one re-probed retry below, so a second "absent" create
  // race in a row (or a genuine syntax failure the retry's re-probe still
  // reads back as "absent") propagates instead of looping.
  allowCreateConflictRetry: boolean,
): Promise<{ status: FluidObjectStatus; wrote: boolean }> {
  const markedSource = withDeployedVersionMarker(expectedSource);

  switch (c.state) {
    case "present":
      return { status: objectStatus(obj, c), wrote: false };

    case "newer":
      throw newerVersionConflictError(obj, tool, c.installedVersion ?? "unknown");

    case "foreign":
      throw foreignConflictError(obj, c.foundIn ?? "", tool);

    case "absent":
    case "stale": {
      try {
        await deployAndVerify(conn, gate, ledgerKey, tool, obj, markedSource);
      } catch (e) {
        if (c.state === "absent" && allowCreateConflictRetry && isCreateConflict(e)) {
          const reclassified = await classifyOne(conn, obj, expectedSource);
          if (reclassified.state !== "absent") {
            return actOnClassification(conn, gate, ledgerKey, tool, obj, expectedSource, reclassified, false);
          }
        }
        throw e;
      }
      return { status: { name: obj.name, type: obj.type, state: "present" }, wrote: true };
    }

    case "legacy": {
      const authorizedDelete = await authorizeMutation(conn, gate, "delete", {
        type: obj.type,
        name: obj.name,
      });
      // Plain ADT delete, not the DEVC/K bridge route — these are CLAS/OC and
      // INTF/OI. ABAP objects cannot change package, so delete-then-create in
      // FLUID_PACKAGE is the only way to relocate one.
      const del = await deleteObject(conn, authorizedDelete, { onBeforeImage: NO_JOURNAL });
      if (del.deleted === false) {
        // Falling through would authorize a write into FLUID_PACKAGE while the
        // object still resolves to its old package and hit the cross-package
        // guard's confusing generic error. `"unverified"` is let through.
        throw new AbapError(
          "FLUID_OBJECT_CONFLICT",
          `${obj.type} ${obj.name} could not be relocated out of ${c.foundIn ?? "its legacy package"}: ` +
            `the delete was sent, but a read-back confirmed the object is still there.`,
          { name: obj.name, type: obj.type, foundIn: c.foundIn, tool: tool.manifest.id },
          "Delete it manually, or find out why the delete did not take effect, before retrying.",
        );
      }
      // This write is the first request after the DELETE, exactly where the
      // dead-session corpse (see writeAndActivateOnce's doc) surfaces — give
      // it the one-shot revive.
      await deployAndVerify(conn, gate, ledgerKey, tool, obj, markedSource, true);
      return { status: { name: obj.name, type: obj.type, state: "present" }, wrote: true };
    }

    case "inactive": {
      const authorized = await authorizeMutation(conn, gate, "activate", {
        type: obj.type,
        name: obj.name,
      });
      const activation = await activateObject(conn, authorized.target);
      assertNoErrors(activation, {
        what: `Activate fluid object ${obj.name}`,
        name: obj.name,
        source: markedSource,
      });
      return { status: { name: obj.name, type: obj.type, state: "present" }, wrote: false };
    }

    case "broken": {
      // `classifyOne` only reaches "broken" once the etag already matches
      // the manifest and the object is active-is-current — the object is
      // broken in the sense that `checkSource` reports errors on content
      // that, byte for byte, is what we would write anyway. A plain rewrite
      // therefore cannot fix it: `writeObject` short-circuits on equal
      // content (nothing changed, so nothing is sent), so a rewrite here
      // would be a guaranteed no-op that reports "broken" again forever. The
      // only way to actually repair it is what the "legacy" branch above
      // already does to relocate an object — delete it and recreate it from
      // scratch — structurally identical here, just without a package move.
      const authorizedDelete = await authorizeMutation(conn, gate, "delete", {
        type: obj.type,
        name: obj.name,
      });
      const del = await deleteObject(conn, authorizedDelete, { onBeforeImage: NO_JOURNAL });
      if (del.deleted === false) {
        throw new AbapError(
          "FLUID_OBJECT_CONFLICT",
          `${obj.type} ${obj.name} could not be repaired: the delete was sent, but a read-back ` +
            `confirmed the object is still there.`,
          { name: obj.name, type: obj.type, tool: tool.manifest.id },
          "Delete it manually, or find out why the delete did not take effect, before retrying.",
        );
      }
      // First request after the DELETE — same one-shot revive as "legacy".
      const write = await deployAndVerify(conn, gate, ledgerKey, tool, obj, markedSource, true);
      const recheck = await checkSource(conn, write.target, markedSource);
      // Still broken after one repair must not loop and must not be cached:
      // ensureFluidTool already declines to recordManifest unless every
      // status is "present", so reporting "broken" again here is enough —
      // no retry loop needed or wanted.
      return {
        status: { name: obj.name, type: obj.type, state: recheck.ok ? "present" : "broken" },
        wrote: true,
      };
    }
  }
}

async function ensureOneObject(
  conn: AbapConnection,
  gate: SafetyGate,
  ledgerKey: string,
  tool: LoadedFluidTool,
  obj: FluidObjectSpec,
  expectedSource: string,
): Promise<{ status: FluidObjectStatus; wrote: boolean }> {
  const c = await classifyOne(conn, obj, expectedSource);
  return actOnClassification(conn, gate, ledgerKey, tool, obj, expectedSource, c, true);
}

export async function ensureFluidTool(
  conn: AbapConnection,
  gate: SafetyGate,
  cfg: Config,
  tool: LoadedFluidTool,
  ctx: FluidCallContext,
): Promise<EnsureFluidToolResult> {
  const disabled = fluidDisabledReason(cfg, gate);
  if (disabled) throw fluidDisabledError(disabled, cfg, tool, ctx);

  const sysKey = systemKey(conn.cfg);
  const registry = await readFluidRegistry(cfg, sysKey);
  const cached = registry.get(tool.manifest.id);
  if (cached && cached.contract === tool.manifest.contract && cached.version === tool.version) {
    return {
      toolId: tool.manifest.id,
      version: tool.version,
      deployed: false,
      objects: tool.manifest.objects.map((o) => ({ name: o.name, type: o.type, state: "present" as const })),
    };
  }

  await ensureFluidPackage(conn, gate);

  const ledgerKey = `${sysKey}:${tool.manifest.id}`;
  const statuses: FluidObjectStatus[] = [];
  let deployed = false;

  for (const obj of tool.manifest.objects) {
    const expectedSource = requireSource(tool, obj);
    const { status, wrote } = await ensureOneObject(conn, gate, ledgerKey, tool, obj, expectedSource);
    statuses.push(status);
    deployed = deployed || wrote;
  }

  // A manifest with even one object still `broken` after its one repair
  // attempt is half-deployed — never cache that as present.
  if (statuses.every((s) => s.state === "present")) {
    await recordManifest(cfg, sysKey, {
      toolId: tool.manifest.id,
      contract: tool.manifest.contract,
      version: tool.version,
      objects: tool.manifest.objects.map((o) => o.name),
      deployedAt: new Date().toISOString(),
    });
  }

  return { toolId: tool.manifest.id, version: tool.version, deployed, objects: statuses };
}

/**
 * Deploy the shared fluid runtime class ({@link FLUID_RUNTIME_CLASS}) a
 * plugin tool needs before it can run, unless something has already put it
 * there. Two things make this a no-op: `tool` is not plugin-authored (a
 * builtin manifest bundles its own copy of the runtime object straight into
 * `manifest.objects`/`sources`, the same way `core.ts` does — `ensureFluidTool`
 * on `tool` itself already deploys it, so a second deploy here would be
 * redundant), or `tool`'s own manifest already lists the runtime class for
 * the same reason. Otherwise this deploys {@link fluidRuntimeTool} exactly as
 * `ensureFluidTool` deploys any other tool.
 */
export async function ensureFluidRuntimeFor(
  conn: AbapConnection,
  gate: SafetyGate,
  cfg: Config,
  tool: LoadedFluidTool,
  ctx?: FluidCallContext,
): Promise<void> {
  if (tool.origin !== "plugin") return;
  if (tool.manifest.objects.some((o) => o.name === FLUID_RUNTIME_CLASS)) return;

  const runtimeCtx: FluidCallContext = ctx ?? {
    tool: tool.manifest.id,
    action: "ensure-runtime",
    op: "run",
  };
  await ensureFluidTool(conn, gate, cfg, fluidRuntimeTool, runtimeCtx);
}

/**
 * One object's live existence, as a provable server fact — nothing else.
 * Deliberately narrower than {@link FluidObjectStatus}: no source comparison,
 * no activation check, just "did `resolveWriteTarget` find it." That is the
 * one thing cheap enough to run unconditionally on every deploy/execute
 * failure (see `anyFluidObjectMissing`'s doc) and the one thing narrow enough
 * that S9's own "is this tool's deployment still real" question can build on
 * it without paying for a full `classifyFluidTool` pass.
 */
export interface FluidObjectPresence {
  readonly name: string;
  readonly type: FluidObjectType;
  readonly exists: boolean;
}

/**
 * Cheap, read-only existence probe over every object `tool`'s manifest
 * declares — one `resolveWriteTarget` GET per object, the exact same call
 * `classifyOne` above and the retired-bridge reaper's `probeRetiredBridges`
 * (src/adt/fluid/retired.ts:73) already use to answer "does the server have
 * this?" as a provable fact rather than a guess. Never throws: a single
 * unreadable name must not blind the whole probe, so a `resolveWriteTarget`
 * failure on one object is worth surfacing, not swallowing — this
 * deliberately does NOT copy `probeRetiredBridges`'s catch-and-report-"unknown"
 * behavior, because a probe result `anyFluidObjectMissing` cannot tell apart
 * from "definitely missing" is worse than letting the caller's own retry
 * bound handle a genuine second failure.
 */
export async function probeFluidObjectsExist(
  conn: AbapConnection,
  tool: LoadedFluidTool,
): Promise<readonly FluidObjectPresence[]> {
  const results: FluidObjectPresence[] = [];
  for (const obj of tool.manifest.objects) {
    const resolved = await resolveWriteTarget(conn, { type: obj.type, name: obj.name }, "write");
    results.push({ name: obj.name, type: obj.type, exists: resolved.exists });
  }
  return results;
}

/**
 * True when at least one of `tool`'s manifest objects is provably absent from
 * the server right now. This is what `dispatch.ts`'s catch block runs on
 * ANY failure out of its deploy/execute range to decide whether a redeploy
 * can plausibly help — replacing an earlier, narrower approach
 * (`isFluidRedeployableFailure`, matched on the failing `AbapError`'s own
 * code and message text) that turned out to miss the dominant real-world
 * shape entirely.
 *
 * Deleting a fluid body class out-of-band was live-verified to surface as
 * BOTH of two different `AbapError` codes, depending on one thing:
 * `deployBridge`'s own F6 shortcut (src/adt/run.ts, `alreadyActive`), which
 * skips reactivating the generated invoker whenever its source hash is
 * unchanged AND its `adtcore:version` metadata already says active.
 *
 *   - F6 engages (the invoker already existed, unchanged, still marked
 *     active — true right after the SAME args are dispatched a second time):
 *     the stale compiled program executes anyway, and `runClass` surfaces a
 *     `RUNTIME_DUMP` short dump (`SYNTAX_ERROR`, "Syntax error in program …").
 *   - F6 does NOT engage (the invoker needs writing or (re)activating at
 *     all — new args, a class name never deployed on this connection before,
 *     or any other reason `write.created || write.changed` is true, or the
 *     server's own `adtcore:version` was not already "active-is-current"):
 *     the activation check itself catches the dangling reference to the
 *     deleted body class BEFORE `runClass` ever runs, and `assertNoErrors`
 *     throws `CHECK_FAILED` — live-verified as the actual failure on a fresh
 *     invoker built for previously-undeployed args.
 *
 * Matching free text for the second shape (a second regex over
 * `checkFailedError`'s rendered checklist) would repeat the first shape's
 * mistake — brittle, English-only prose — and worse: `CHECK_FAILED` also
 * means "the fluid layer generated ABAP that genuinely does not compile," an
 * outcome that must keep surfacing as a real error, never trigger a silent
 * redeploy. An existence probe sidesteps the whole distinction: it does not
 * look at what the failure says, only at whether the server can currently
 * prove the dependency is there. `NOT_FOUND` (a referenced object entirely
 * gone) and both of the shapes above all resolve to the same provable fact —
 * something in the manifest is missing — while a `CHECK_FAILED` (or anything
 * else) with every manifest object present is a genuine codegen defect and
 * must not be papered over: `anyFluidObjectMissing` answers `false`, and the
 * caller rethrows the original failure unchanged.
 */
export async function anyFluidObjectMissing(conn: AbapConnection, tool: LoadedFluidTool): Promise<boolean> {
  const presence = await probeFluidObjectsExist(conn, tool);
  return presence.some((p) => !p.exists);
}

/**
 * Forgets the registry's cached entry for `tool` and redeploys once per call:
 * this function's own body invokes `ensureFluidTool` exactly one time and
 * returns its result, so a single call cannot loop internally.
 *
 * Plainly: that is the only bound this function provides. Nothing in its
 * signature, return value, or body stops a caller from invoking
 * `recoverMissingFluidObject` itself repeatedly — the "call this once per
 * failure" contract is a caller-side convention, not something enforced or
 * even observable from here. A dispatch call site relying on "once" must
 * enforce it itself (e.g. a boolean already spent before this is called).
 *
 * The one real backstop is incidental, not designed as this function's loop
 * guard: `ensureFluidTool`'s own per-object `redeployed` ledger (module-level
 * `Set`, cleared only by `resetFluidEnsureState`) permits at most one extra
 * redeploy cycle per (system, tool, object) per process. So repeated calls
 * that keep hitting an unrecoverable object will eventually throw
 * `redeployExhaustedError` instead of writing to the ABAP side forever — but
 * that only engages once a write attempt has actually run; a caller looping
 * on an object that keeps classifying as merely "present" or "absent"
 * without ever reaching `deployAndVerify` gets no protection from it at all.
 */
export async function recoverMissingFluidObject(
  conn: AbapConnection,
  gate: SafetyGate,
  cfg: Config,
  tool: LoadedFluidTool,
  ctx: FluidCallContext,
): Promise<EnsureFluidToolResult> {
  const sysKey = systemKey(conn.cfg);
  await forgetManifest(cfg, sysKey, tool.manifest.id);
  return ensureFluidTool(conn, gate, cfg, tool, ctx);
}
