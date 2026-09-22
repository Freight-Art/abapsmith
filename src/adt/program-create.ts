/**
 * PROG/P create with an explicit Fixed Point Arithmetic flag (issue #179).
 * The vendor library's `createObject` has no way to set
 * `abapsource:fixPointArithmetic`, so PROG/P is diverted here — a raw
 * `POST /sap/bc/adt/programs/programs` — ahead of `createNewObject`'s
 * vendor/`createByXml` branch in write.ts. Live-confirmed shape: see
 * `test/fixtures/programs/rsparam-descriptor.xml`.
 */
import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import { translateAdtError } from "./session.js";
import type { GatedCorr, ResolvedTarget } from "./write.js";

const PROGRAM_CREATE_COLLECTION = "/sap/bc/adt/programs/programs";

/** `fixed_point_arithmetic`/`text_pool` apply to PROG/P only — shared refusal for both. */
export function assertProgramOnlyOption(
  option: "fixed_point_arithmetic" | "text_pool",
  type: string | undefined,
  details: Record<string, unknown>,
): void {
  if (type === "PROG/P") return;
  throw new AbapError("BAD_INPUT", `\`${option}\` applies to PROG/P only.`, details);
}

export interface ProgramCreateInput {
  name: string;
  description: string;
  packageName: string;
  responsible: string;
  fixPointArithmetic: boolean;
}

/** Local to this module — see the house-idiom note on `escapeXmlAttr` in write.ts. */
function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * `abapsource:fixPointArithmetic` is written as `"true"` or omitted: the
 * server treats an absent attribute as off (the #179 bug), so omission is
 * the opt-out.
 */
export function buildProgramCreateBody(input: ProgramCreateInput): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<program:abapProgram xmlns:program="http://www.sap.com/adt/programs/programs" ` +
    `xmlns:adtcore="http://www.sap.com/adt/core" xmlns:abapsource="http://www.sap.com/adt/abapsource" ` +
    `adtcore:description="${escapeXmlAttr(input.description)}" ` +
    `adtcore:name="${escapeXmlAttr(input.name.toUpperCase())}" ` +
    `adtcore:type="PROG/P" adtcore:language="EN" adtcore:masterLanguage="EN" ` +
    `adtcore:responsible="${escapeXmlAttr(input.responsible)}"` +
    (input.fixPointArithmetic ? ` abapsource:fixPointArithmetic="true"` : ``) +
    `><adtcore:packageRef adtcore:name="${escapeXmlAttr(input.packageName)}"/></program:abapProgram>`
  );
}

/** `undefined` when the attribute is absent from the XML — not the same as `false`. */
export function parseFixPointArithmetic(descriptorXml: string): boolean | undefined {
  const m = descriptorXml.match(/abapsource:fixPointArithmetic="(true|false)"/);
  return m ? m[1] === "true" : undefined;
}

/**
 * `POST /sap/bc/adt/programs/programs` — mirrors `createByXml`'s POST/error
 * shape in write.ts (same `translateAdtError` context, same `corrNr` qs
 * carried only for a transport-kind `GatedCorr`).
 */
export async function createProgram(
  conn: AbapConnection,
  target: ResolvedTarget,
  corr: GatedCorr | undefined,
  fixPointArithmetic: boolean,
): Promise<void> {
  const body = buildProgramCreateBody({
    name: target.name,
    description: target.description,
    packageName: target.packageName,
    responsible: conn.cfg.user,
    fixPointArithmetic,
  });
  try {
    await conn.post(PROGRAM_CREATE_COLLECTION, {
      body,
      headers: { "Content-Type": "application/*" },
      ...(corr?.kind === "transport" ? { qs: { corrNr: corr.corrNr } } : {}),
    });
  } catch (e) {
    throw translateAdtError(e, {
      operation: "create",
      uri: target.uri,
      name: target.name,
      type: target.type,
    });
  }
}
