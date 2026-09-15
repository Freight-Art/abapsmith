/**
 * Fluid tool manifest: schema, validation, and the deploy-version hash.
 * Pure — no network, no filesystem, no AbapConnection. The loader (plugin.ts
 * / package.ts) resolves `FluidObjectSource` into actual ABAP text and
 * builds a `LoadedFluidTool`; this module only knows the shape.
 */
import { z } from "zod";

import { canonicalEtag, contentHash } from "../../compact.js";

export const FLUID_CONTRACT = "1.0";
export const FLUID_CONTRACT_MAJOR = 1;

export type FluidObjectType = "CLAS/OC" | "INTF/OI";
export type FluidCategory = "read" | "execute" | "mutate";

/** The documented JSON-Schema subset. Unknown keywords are ignored, never rejected. */
export interface FluidJsonSchema {
  readonly type?: "object" | "array" | "string" | "number" | "integer" | "boolean";
  readonly properties?: Readonly<Record<string, FluidJsonSchema>>;
  readonly required?: readonly string[];
  readonly items?: FluidJsonSchema;
  readonly enum?: readonly (string | number | boolean)[];
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly description?: string;
}

export type FluidObjectSource =
  | { readonly text: string }
  | { readonly file: string };

export interface FluidObjectSpec {
  readonly name: string;
  readonly type: FluidObjectType;
  readonly description: string;
  readonly source: FluidObjectSource;
}

export interface FluidTargets {
  readonly object?: string;
  readonly package?: string;
  readonly transport?: string;
  /** This action registers nothing in CTS — see `src/safety.ts` step 10 for who else may mint `{kind:"local"}`. Builtin actions only; a plugin manifest declaring it is ignored (`assertTargetsAgainstGate`). */
  readonly corr?: "local";
}

export interface FluidActionSpec {
  readonly name: string;
  readonly category: FluidCategory;
  readonly description: string;
  readonly input: FluidJsonSchema;
  readonly output: FluidJsonSchema;
  readonly targets?: FluidTargets;
}

export interface FluidManifest {
  readonly contract: string;
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly objects: readonly FluidObjectSpec[];
  readonly entry: string;
  readonly actions: readonly FluidActionSpec[];
  /**
   * Framework plumbing rather than a tool a caller should be routed to (the
   * shared `rt` runtime is the only current example). Additive and
   * backward-compatible — absent/false means routable, so `contract` stays
   * "1.0" — and `manifestVersion` never reads it, so setting or clearing it
   * moves no deploy-version hash.
   */
  readonly internal?: boolean;
  /**
   * This tool's ABAP reads its arguments with the flat, single-pass
   * `scan()` in `src/adt/fluid/builtin/classic/abap-core.ts`, so the
   * dispatcher flattens nested arrays-of-objects/objects in `args` into
   * `key/index/prop` rows (`flattenScanArgs`, `./flat-args.js`) before
   * serialising. Absent/false means the tool gets plain nested JSON. A
   * plugin manifest may set this too, same as `internal`.
   */
  readonly flatArgs?: boolean;
}

/** A manifest plus its resolved ABAP sources and computed version. */
export interface LoadedFluidTool {
  readonly manifest: FluidManifest;
  readonly origin: "builtin" | "plugin";
  /** absolute plugin directory; undefined for built-ins */
  readonly dir?: string;
  /** object name -> ABAP source text, every object in `manifest.objects` present */
  readonly sources: ReadonlyMap<string, string>;
  /** 8 hex chars; see manifestVersion */
  readonly version: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const SCHEMA_TYPES = ["object", "array", "string", "number", "integer", "boolean"] as const;

/** Validate the JSON-Schema subset by hand. Returns [] when valid. */
export function validateFluidSchema(schema: unknown, where: string): readonly string[] {
  const messages: string[] = [];
  if (!isPlainObject(schema)) {
    messages.push(`${where}: must be a plain object`);
    return messages;
  }

  if (schema["type"] !== undefined) {
    const t = schema["type"];
    if (typeof t !== "string" || !(SCHEMA_TYPES as readonly string[]).includes(t)) {
      messages.push(`${where}.type: must be one of ${SCHEMA_TYPES.join(", ")}`);
    }
  }

  if (schema["properties"] !== undefined) {
    if (!isPlainObject(schema["properties"])) {
      messages.push(`${where}.properties: must be an object`);
    } else {
      for (const [key, value] of Object.entries(schema["properties"])) {
        messages.push(...validateFluidSchema(value, `${where}.properties.${key}`));
      }
    }
  }

  if (schema["required"] !== undefined) {
    const req = schema["required"];
    if (!Array.isArray(req) || !req.every((x) => typeof x === "string")) {
      messages.push(`${where}.required: must be an array of strings`);
    }
  }

  if (schema["items"] !== undefined) {
    messages.push(...validateFluidSchema(schema["items"], `${where}.items`));
  }

  if (schema["enum"] !== undefined) {
    const en = schema["enum"];
    const isMember = (x: unknown): boolean =>
      typeof x === "string" || typeof x === "number" || typeof x === "boolean";
    if (!Array.isArray(en) || en.length === 0 || !en.every(isMember)) {
      messages.push(`${where}.enum: must be a non-empty array of strings, numbers or booleans`);
    }
  }

  if (schema["maxLength"] !== undefined) {
    const ml = schema["maxLength"];
    if (typeof ml !== "number" || !Number.isInteger(ml) || ml < 0) {
      messages.push(`${where}.maxLength: must be a non-negative integer`);
    }
  }

  if (schema["minimum"] !== undefined) {
    const min = schema["minimum"];
    if (typeof min !== "number" || !Number.isFinite(min)) {
      messages.push(`${where}.minimum: must be a finite number`);
    }
  }

  if (schema["maximum"] !== undefined) {
    const max = schema["maximum"];
    if (typeof max !== "number" || !Number.isFinite(max)) {
      messages.push(`${where}.maximum: must be a finite number`);
    }
  }

  if (schema["description"] !== undefined && typeof schema["description"] !== "string") {
    messages.push(`${where}.description: must be a string`);
  }

  return messages;
}

/** Validate a value against a FluidJsonSchema. Returns [] when valid. */
export function validateAgainstSchema(
  value: unknown,
  schema: FluidJsonSchema,
  where: string,
): readonly string[] {
  const messages: string[] = [];

  if (schema.enum !== undefined && !schema.enum.some((member) => member === value)) {
    messages.push(`${where}: must be one of ${JSON.stringify(schema.enum)}`);
  }

  switch (schema.type) {
    case "object": {
      if (!isPlainObject(value)) {
        messages.push(`${where}: must be an object`);
        break;
      }
      for (const key of schema.required ?? []) {
        if (value[key] === undefined) {
          messages.push(`${where}.${key}: required`);
        }
      }
      if (schema.properties) {
        for (const [key, propSchema] of Object.entries(schema.properties)) {
          if (value[key] !== undefined) {
            messages.push(...validateAgainstSchema(value[key], propSchema, `${where}.${key}`));
          }
        }
      }
      break;
    }
    case "array": {
      if (!Array.isArray(value)) {
        messages.push(`${where}: must be an array`);
        break;
      }
      if (schema.items) {
        const itemSchema = schema.items;
        value.forEach((item, i) => {
          messages.push(...validateAgainstSchema(item, itemSchema, `${where}[${i}]`));
        });
      }
      break;
    }
    case "string": {
      if (typeof value !== "string") {
        messages.push(`${where}: must be a string`);
        break;
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        messages.push(`${where}: exceeds maxLength ${schema.maxLength}`);
      }
      break;
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        messages.push(`${where}: must be a number`);
        break;
      }
      if (schema.type === "integer" && !Number.isInteger(value)) {
        messages.push(`${where}: must be an integer`);
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        messages.push(`${where}: below minimum ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        messages.push(`${where}: above maximum ${schema.maximum}`);
      }
      break;
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        messages.push(`${where}: must be a boolean`);
      }
      break;
    }
    case undefined:
      break;
  }

  return messages;
}

const CONTRACT_RE = /^\d+\.\d+$/;
const ID_RE = /^[a-z][a-z0-9_]{0,11}$/;
const ACTION_NAME_RE = /^[a-z][a-z0-9_]{0,29}$/;

const FluidObjectSourceSchema = z.union([z.object({ text: z.string() }), z.object({ file: z.string() })]);

const FluidObjectSpecSchema = z.object({
  name: z.string().min(1).max(30),
  type: z.enum(["CLAS/OC", "INTF/OI"]),
  description: z.string().max(60),
  source: FluidObjectSourceSchema,
});

const FluidTargetsSchema = z.object({
  object: z.string().optional(),
  package: z.string().optional(),
  transport: z.string().optional(),
  corr: z.literal("local").optional(),
});

const FluidJsonSchemaSchema = z.custom<FluidJsonSchema>(isPlainObject, {
  message: "must be a plain JSON-Schema-like object",
});

const FluidActionSpecSchema = z.object({
  name: z.string().regex(ACTION_NAME_RE),
  category: z.enum(["read", "execute", "mutate"]),
  description: z.string().min(1),
  input: FluidJsonSchemaSchema,
  output: FluidJsonSchemaSchema,
  targets: FluidTargetsSchema.optional(),
});

const FluidManifestObjectSchema = z.object({
  contract: z.string().regex(CONTRACT_RE),
  id: z.string().regex(ID_RE),
  title: z.string().min(1),
  description: z.string().min(1),
  objects: z.array(FluidObjectSpecSchema).min(1),
  entry: z.string().min(1),
  actions: z.array(FluidActionSpecSchema).min(1),
  // Additive: absent/false means routable, so contract stays "1.0".
  internal: z.boolean().optional(),
  // Additive: absent/false means the tool gets plain nested JSON args.
  flatArgs: z.boolean().optional(),
});

export const FluidManifestSchema: z.ZodType<FluidManifest> = FluidManifestObjectSchema.superRefine(
  (manifest, ctx) => {
    const names = new Set<string>();
    for (const obj of manifest.objects) {
      if (names.has(obj.name)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate object name: ${obj.name}`,
          path: ["objects"],
        });
      }
      names.add(obj.name);
    }

    if (!names.has(manifest.entry)) {
      ctx.addIssue({
        code: "custom",
        message: `entry "${manifest.entry}" is not present in objects`,
        path: ["entry"],
      });
    }

    manifest.actions.forEach((action, i) => {
      for (const msg of validateFluidSchema(action.input, `actions[${i}].input`)) {
        ctx.addIssue({ code: "custom", message: msg, path: ["actions", i, "input"] });
      }
      for (const msg of validateFluidSchema(action.output, `actions[${i}].output`)) {
        ctx.addIssue({ code: "custom", message: msg, path: ["actions", i, "output"] });
      }
    });
  },
);

// Length-prefixed so no source text can forge a part boundary: a plain
// separator line survives canonicalSource as an ordinary blank line and could
// be spelled out inside an ABAP source. Each source is hashed first, so CRLF
// churn leaves the version alone while a real edit moves it.
function versionPart(s: string): string {
  return `${s.length}:${s}`;
}

export function manifestVersion(
  manifest: FluidManifest,
  sources: ReadonlyMap<string, string>,
): string {
  const parts: string[] = [versionPart(manifest.contract)];
  for (const obj of manifest.objects) {
    parts.push(
      versionPart(obj.type),
      versionPart(obj.name),
      versionPart(canonicalEtag(sources.get(obj.name) ?? "")),
    );
  }
  return contentHash(parts.join("")).replace(/^sha256:/, "").slice(0, 8);
}
