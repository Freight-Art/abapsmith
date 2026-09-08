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
import { AbapError, describeUnknownError } from "../errors.js";
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
import { FLUID_PACKAGE, LEGACY_FLUID_PACKAGES, isReservedFluidName, ensureFluidPackage } from "./package.js";
import { readFluidRegistry, recordManifest } from "./registry.js";
import type { FluidObjectSpec, FluidObjectType, LoadedFluidTool } from "./manifest.js";
import { fluidDisabledReason } from "./enabled.js";

export type FluidObjectState =
  | "absent" | "present" | "stale" | "inactive" | "broken" | "foreign" | "legacy";

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

  if (canonicalEtag(read.source ?? "") !== canonicalEtag(expectedSource)) {
    return { resolved, state: "stale" };
  }
  if (resolved.activation !== "active-is-current") {
    return { resolved, state: "inactive" };
  }
  const check = await checkSource(conn, resolved, expectedSource);
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

export async function classifyFluidTool(
  conn: AbapConnection,
  cfg: Config,
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
  cfg: Config,
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
): Promise<WriteResult> {
  const authorized = await authorizeMutation(conn, gate, "write", {
    type: obj.type,
    name: obj.name,
    packageName: FLUID_PACKAGE,
    description: obj.description,
  });

  const write = await writeObject(conn, authorized, { source: expectedSource, onBeforeImage: NO_JOURNAL });

  // Same F6 shortcut as deployBridge (run.ts): nothing changed and round
  // trip 1's own body already showed the active version is current, so a
  // reactivation POST would be a pure no-op.
  const alreadyActive =
    !write.created && !write.changed && write.target.activation === "active-is-current";

  gate.assert("activate", {
    name: write.target.name,
    packageName: write.target.packageName,
    type: write.target.type,
  });

  if (alreadyActive) return write;

  const activation = await activateObject(conn, write.target);
  assertNoErrors(activation, {
    what: `Deploy fluid object ${obj.name}`,
    name: obj.name,
    source: expectedSource,
  });
  return write;
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
): Promise<WriteResult> {
  let write = await writeAndActivateOnce(conn, gate, obj, expectedSource);
  if (await contentConfirmed(conn, write.target, expectedSource)) return write;

  if (redeployed.has(ledgerKey)) {
    throw redeployExhaustedError(obj, tool, false);
  }
  redeployed.add(ledgerKey);

  write = await writeAndActivateOnce(conn, gate, obj, expectedSource);
  if (await contentConfirmed(conn, write.target, expectedSource)) return write;

  throw redeployExhaustedError(obj, tool, true);
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

  switch (c.state) {
    case "present":
      return { status: objectStatus(obj, c), wrote: false };

    case "foreign":
      throw foreignConflictError(obj, c.foundIn ?? "", tool);

    case "absent":
    case "stale": {
      await deployAndVerify(conn, gate, ledgerKey, tool, obj, expectedSource);
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
      await deployAndVerify(conn, gate, ledgerKey, tool, obj, expectedSource);
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
        source: expectedSource,
      });
      return { status: { name: obj.name, type: obj.type, state: "present" }, wrote: false };
    }

    case "broken": {
      const write = await writeAndActivateOnce(conn, gate, obj, expectedSource);
      const recheck = await checkSource(conn, write.target, expectedSource);
      const fixed = recheck.ok;
      return {
        status: { name: obj.name, type: obj.type, state: fixed ? "present" : "broken" },
        wrote: Boolean(write.created || write.changed),
      };
    }
  }
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
