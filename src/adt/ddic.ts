/**
 * DDIC rendering: never hands raw ADT XML to the model — always pseudo-DDL.
 *
 * Verified live on A4H, 2026-07-31: TABL/STRU are source-based
 * (`/source/main` returns real DDL); DTEL/DOMA/TTYP are XML-only (404 on
 * `/source/main`), rendered from dedicated ADT property endpoints instead.
 * The two groups do NOT move together as a release flips — do not re-derive
 * membership from a per-type flag; `ddicStrategy()` below is the one place
 * that encodes it. Full verification notes:
 * the git history.
 */
import { XMLParser } from "fast-xml-parser";
import type { Node as AdtRepositoryNode } from "abap-adt-api";
import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import type { ResolvedObject } from "./resolve.js";
import { isNotFoundError, translateAdtError, type ErrorContext } from "./session.js";
import { textTable } from "../compact.js";
import { readCatalogObject } from "./catalog-read.js";
import {
  ddicStrategy,
  DDIC_SOURCE_BASED,
  DDIC_XML_ONLY,
  DDIC_CATALOG_BASED,
} from "./ddic-strategy.js";
import { readTableIndexes, renderIndexSection } from "./index-read.js";

export interface DdicRender {
  /** The pseudo-DDL body, safe to hand to the model. */
  ddl: string;
  /** Extra digest sections (foreign keys, fixed values, …). */
  sections: Array<{ title: string; content: string }>;
  /** Header key/values. */
  meta: Record<string, string | number | undefined>;
  notes: string[];
  /** Raw content the etag is computed over. */
  hashInput: string;
  /**
   * Overrides the label `src/tools/read.ts` prints above the paged `ddl`
   * body (default "PSEUDO-DDL"). Set to "OBJECTS" by `readPackage` — a
   * package listing is not DDL and calling it that would be actively
   * misleading. Every other renderer leaves this unset.
   */
  bodyLabel?: string;
}

// DDIC descriptors are character data on the wire. Without `parseTagValue:
// false`, fast-xml-parser coerces element text: `<doma:low>01</doma:low>`
// became the number `1`, stripping leading zeros off domain fixed values
// — and along with it `1.10` -> `1.1`, `0x1F` -> `31`, `1e5` ->
// `100000`. Every other XMLParser in this codebase already sets this flag
// (src/adt/transports.ts, dumps-xml.ts, odata.ts, and others) — this parser
// was the outlier. The failure mode is an agent reading `1`, writing
// `IF x = '1'` against a field that actually stores `01`: never true, never
// an error, just silently wrong forever.
//
// Direct consequence of the flag: every tag value now arrives as a string.
// Boolean and numeric reads below MUST go through `xmlBool`/`xmlNum` —
// `=== true` or bare `Number(...)` on a tag value is now always wrong.
const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

// ---------------------------------------------------------------- tables ---

export interface DdlField {
  name: string;
  type: string;
  key: boolean;
  notNull: boolean;
  foreignKey?: string;
}

export interface ParsedDdl {
  entity?: string;
  annotations: string[];
  fields: DdlField[];
  includes: string[];
}

/** Parse source-based DDIC DDL. Tolerant: an unclassifiable bit degrades the digest, never the payload. */
export function parseDdl(source: string): ParsedDdl {
  const text = source.replace(/\r\n/g, "\n");
  const annotations = text
    .split("\n")
    .filter((l) => /^\s*@/.test(l) && !/^\s*@AbapCatalog\.foreignKey/.test(l))
    .map((l) => l.trim());
  const entity = /define\s+(?:table|structure|abstract\s+entity|view\s+entity)\s+([\w/]+)/i.exec(
    text,
  )?.[1];

  const fields: DdlField[] = [];
  const includes: string[] = [];

  const open = text.indexOf("{");
  const close = text.lastIndexOf("}");
  const body = open >= 0 && close > open ? text.slice(open + 1, close) : text;

  // DDIC DDL statements are semicolon-terminated.
  for (const rawStmt of body.split(";")) {
    const stmt = rawStmt.replace(/^\s*@[^\n]*$/gm, "").trim();
    if (!stmt) continue;

    const inc = /^include\s+([\w/]+)/i.exec(stmt);
    if (inc) {
      includes.push(inc[1]!.toUpperCase());
      continue;
    }

    const m = /^(key\s+)?([\w/]+)\s*:\s*([\s\S]+)$/i.exec(stmt);
    if (!m) continue;
    const rest = m[3]!.trim();
    // Named-component include: `node_data : include ZOTH_S_NOTE`
    const namedInclude = /^include\s+([\w/]+)/i.exec(rest);
    const fkMatch = /with\s+foreign\s+key\s+(?:\[[^\]]*\]\s*)?([\w/]+)/i.exec(rest);
    const typePart = rest
      .split(/\bwith\s+foreign\s+key\b/i)[0]!
      .replace(/\bnot\s+null\b/i, "")
      .trim();

    fields.push({
      name: m[2]!.toUpperCase(),
      type: namedInclude ? `INCLUDE ${namedInclude[1]!.toUpperCase()}` : typePart,
      key: Boolean(m[1]),
      notNull: /\bnot\s+null\b/i.test(rest),
      foreignKey: fkMatch?.[1]?.toUpperCase(),
    });
  }

  return { entity, annotations, fields, includes };
}

/** Compact digest: key fields, foreign keys, field count. */
export function renderDdlDigest(parsed: ParsedDdl): {
  sections: Array<{ title: string; content: string }>;
  meta: Record<string, string | number | undefined>;
} {
  const keys = parsed.fields.filter((f) => f.key);
  const fks = parsed.fields.filter((f) => f.foreignKey);
  const sections: Array<{ title: string; content: string }> = [];

  if (parsed.fields.length) {
    sections.push({
      title: "FIELD DIGEST",
      content: textTable(
        parsed.fields.map((f) => ({
          key: f.key ? "KEY" : "",
          field: f.name,
          type: f.type,
          "foreign key": f.foreignKey ?? "",
        })),
        ["key", "field", "type", "foreign key"],
      ),
    });
  }
  if (parsed.includes.length) {
    sections.push({ title: "INCLUDES", content: parsed.includes.join("\n") });
  }

  return {
    sections,
    meta: {
      fields: parsed.fields.length || undefined,
      keyFields: keys.length ? keys.map((k) => k.name).join(", ") : undefined,
      foreignKeys: fks.length ? fks.map((f) => `${f.name}→${f.foreignKey}`).join(", ") : undefined,
    },
  };
}

/** Fallback for releases where TABL/STRU is XML-only: extracts field-ish elements into a table, never emits XML, flags degraded fidelity. */
export function renderTableXmlFallback(body: string, name: string, why?: string): DdicRender {
  const doc = xml.parse(body) as Record<string, unknown>;
  const fields: Array<Record<string, string>> = [];

  const visit = (key: string, node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(key, item);
      return;
    }
    const attrs = node as Record<string, unknown>;
    const fname = attrs["@_name"] ?? attrs["@_fieldName"];
    if (/^(column|field|element|component)$/i.test(key) && typeof fname === "string") {
      fields.push({
        key:
          String(attrs["@_isKey"] ?? attrs["@_keyFlag"] ?? "").toLowerCase() === "true" ? "KEY" : "",
        field: String(fname).toUpperCase(),
        type: String(
          attrs["@_dataElement"] ?? attrs["@_type"] ?? attrs["@_dataType"] ?? "",
        ).toUpperCase(),
        length: String(attrs["@_length"] ?? ""),
      });
    }
    for (const [childKey, value] of Object.entries(attrs)) {
      if (childKey.startsWith("@_")) continue;
      visit(childKey, value);
    }
  };
  visit("", doc);

  const ddl = fields.length
    ? `define table ${name.toLowerCase()} {\n` +
      fields
        .map((f) => `  ${f.key ? "key " : ""}${f.field!.toLowerCase()} : ${f.type || "?"};`)
        .join("\n") +
      `\n}`
    : `-- ${name}: no field information could be extracted from the ADT XML on this release.`;

  return {
    ddl,
    sections: fields.length
      ? [{ title: "FIELD DIGEST", content: textTable(fields, ["key", "field", "type", "length"]) }]
      : [],
    meta: { fields: fields.length || undefined },
    notes: [
      // Caller passes the reason it actually observed, not a release-wide guess.
      `${why ?? `${name}: rendered from ADT XML`}. The DDL above is reconstructed and ` +
        `may omit foreign keys, technical settings and appends.`,
    ],
    hashInput: body,
  };
}

// ------------------------------------------------------------ table types ---

export function renderTableType(body: string, name: string): DdicRender {
  const doc = xml.parse(body) as Record<string, any>;
  const tt = doc.tableType ?? {};
  const row = tt.rowType ?? {};
  const typeKind = xmlText(row.typeKind) ?? "";
  const typeName = xmlText(row.typeName) ?? "";
  const builtIn = row.builtInType ?? {};
  const builtInType = xmlText(builtIn.dataType) ?? "";
  const builtInLen = xmlNum(builtIn.length) ?? 0;
  const access = xmlText(tt.accessType) || "standard";
  const pk = tt.primaryKey ?? {};
  const pkKind = xmlText(pk.kind) ?? "";
  const pkDef = xmlText(pk.definition) ?? "";
  const comps = pk.components?.component;
  const compNames = (Array.isArray(comps) ? comps : comps ? [comps] : [])
    .map((c: any) => String(c["@_name"] ?? ""))
    .filter(Boolean);

  const rowTypeText =
    typeKind === "predefinedAbapType"
      ? `abap.${builtInType.toLowerCase()}(${builtInLen})`
      : typeName || builtInType || "?";

  const keyText =
    pkDef === "keyComponents" && compNames.length
      ? `${pkKind} key (${compNames.join(", ")})`
      : pkDef === "standard"
        ? `${pkKind || "non-unique"} default key`
        : pkDef || "not specified";

  const ddl = [
    `define table type ${name.toLowerCase()} {`,
    `  row type   : ${rowTypeText};`,
    `  table kind : ${access};`,
    `  key        : ${keyText};`,
    `}`,
  ].join("\n");

  return {
    ddl,
    sections: [],
    meta: {
      description: String(tt["@_description"] ?? "") || undefined,
      rowType: rowTypeText,
      accessType: access,
    },
    notes: [],
    // Hash the raw resource bytes, not a derived rendering — see resourceEtag in src/tools/read.ts.
    hashInput: body,
  };
}

// ----------------------------------------------------------- data element ---

export interface DataElementView {
  name: string;
  description?: string;
  typeName: string;
  dataType: string;
  length: number;
  decimals?: number;
  labels: Record<string, string>;
  labelLengths?: Record<string, number>;
  searchHelp?: string;
  searchHelpParameter?: string;
  packageName?: string;
}

export function renderDataElement(
  view: DataElementView,
  domain?: DomainView,
  /** Why the domain could not be read, if `view.typeName` names one but `domain` is missing (see notes below). */
  domainFailure?: string,
): DdicRender {
  // Domain-typed is a property of the data element, not of whether the second round trip succeeded.
  const isDomainTyped = Boolean(view.typeName);
  const typeLine = isDomainTyped
    ? `  domain     : ${view.typeName};`
    : `  type       : abap.${view.dataType.toLowerCase()}(${view.length}${
        view.decimals ? `,${view.decimals}` : ""
      });`;

  const ddl = [
    `define data element ${view.name.toLowerCase()} {`,
    typeLine,
    `  built-in   : ${view.dataType} length ${view.length}${
      view.decimals ? ` decimals ${view.decimals}` : ""
    };`,
    ...(domain?.valueTable ? [`  value table: ${domain.valueTable};`] : []),
    ...(view.searchHelp
      ? [
          `  search help: ${view.searchHelp}${
            view.searchHelpParameter ? ` (${view.searchHelpParameter})` : ""
          };`,
        ]
      : []),
    `}`,
  ].join("\n");

  const sections: Array<{ title: string; content: string }> = [];
  const labels = Object.entries(view.labels).filter(([, v]) => v);
  if (labels.length) {
    sections.push({
      title: "FIELD LABELS",
      content: labels
        .map(([k, v]) => {
          const n = view.labelLengths?.[k];
          return n === undefined ? `${k.padEnd(8)} ${v}` : `${k.padEnd(8)} ${v} (length ${n})`;
        })
        .join("\n"),
    });
  }
  if (domain?.fixedValues?.length) {
    sections.push({
      title: `FIXED VALUES (domain ${domain.name})`,
      content: renderFixedValues(domain.fixedValues),
    });
  }

  const notes: string[] = [];
  if (isDomainTyped && !domain) {
    notes.push(
      `Domain ${view.typeName} could NOT be read${domainFailure ? `: ${domainFailure}` : ""}. ` +
        `Its value table and fixed values are UNKNOWN here — this is a failed lookup, ` +
        `NOT evidence that the domain constrains nothing.`,
    );
  }
  if (domain && !domain.valueTable && !domain.fixedValues?.length) {
    notes.push(`Domain ${domain.name} has no value table and no fixed values.`);
  }
  if (domain?.fixedValues?.length) {
    // Same table, same warning as renderDomain — an agent reading the data
    // element sees the fixed values but never went near renderDomain itself.
    const charNote = characterLiteralNote(domain);
    if (charNote) notes.push(charNote);
  }
  if (!isDomainTyped) {
    notes.push("Data element is typed directly (predefined type), not via a domain.");
  }

  return { ddl, sections, meta: { description: view.description, package: view.packageName }, notes, hashInput: ddl };
}

// ----------------------------------------------------------------- domain ---

export interface DomainFixedValue {
  low: string;
  high?: string;
  text?: string;
  /** `language` attribute observed on this value's `<doma:text>`, if any. Feeds renderDomain's guard notes, not renderFixedValues's table. */
  textLanguage?: string;
}

export interface DomainView {
  name: string;
  description?: string;
  dataType: string;
  length: number;
  decimals?: number;
  outputLength?: number;
  conversionExit?: string;
  lowercase?: boolean;
  signExists?: boolean;
  valueTable?: string;
  fixedValues?: DomainFixedValue[];
  packageName?: string;
}

/**
 * The number coercion this comment used to describe as normal WAS a real
 * bug, not a fact of life: `low`/`high` arrived as JS numbers because the
 * `XMLParser` above lacked `parseTagValue: false`, and a CHAR(2) domain's
 * `01`-`04` rendered as `1`-`4`. The parser is now configured
 * `parseTagValue: false`, so `low`/`high` arrive as the exact stored
 * characters — `01` stays `01`.
 *
 * The `String(...)` calls below stay as defence-in-depth, not as the fix:
 * this function is exported and `renderDomain`/`renderDataElement` accept
 * caller-built `DomainView`s, so a caller can still hand it a number
 * directly, and an un-stringified number reaching `textTable`'s `.padEnd`
 * throws — caught live once as a bogus ADT_ERROR on reading a freshly
 * written domain (the git history).
 *
 * Do not "simplify" by removing `parseTagValue: false` from the parser
 * above. Rendering would still succeed — it would just be wrong again,
 * silently, exactly as the original bug was.
 */
export function renderFixedValues(values: DomainFixedValue[]): string {
  return textTable(
    values.map((v) => ({
      value: v.low === "" || v.low === undefined || v.low === null ? "''" : String(v.low),
      to: v.high === undefined || v.high === null ? "" : String(v.high),
      text: v.text === undefined || v.text === null ? "" : String(v.text),
    })),
    ["value", "to", "text"],
  );
}

/** DDIC types whose values are character data even when they look numeric — see characterLiteralNote. */
const CHARACTER_DDIC_TYPES = new Set(["CHAR", "NUMC", "CUKY", "UNIT", "LANG", "CLNT", "ACCP"]);

/**
 * Warn when a domain's fixed values look like numbers but are not: a
 * CHAR/NUMC/... domain's `01` is two characters, not the number 1. The
 * rendered table intentionally does NOT add quotes around values (that
 * would render `'5'` for an INT4/DEC-typed domain, which is wrong ABAP) —
 * this note carries the character-ness instead.
 *
 * Two different notes, not one, and never derived via `Number(...)` (that
 * turns a non-numeric-but-digit-leading value like `007ABC` into `NaN`, and
 * silently un-pads an unpadded value like `1` into the false claim that
 * `IF x = '1'` doesn't match it). A genuinely zero-padded value (`01`) makes
 * the obvious ABAP literal wrong — `IF x = 1` and `IF x = '1'` both miss it
 * — and only that case gets the strong "silently never matches" wording.
 * A digit-leading but unpadded value (`1`) is still a character literal
 * that must be quoted, but `IF x = '1'` for it is correct ABAP; claiming
 * otherwise would be a note that tells the agent correct code is wrong —
 * the same failure mode as the coercion bug itself — so that case gets weaker, still-
 * true wording instead.
 */
function characterLiteralNote(view: DomainView): string | undefined {
  if (!CHARACTER_DDIC_TYPES.has(view.dataType.toUpperCase())) return undefined;
  const prefix = `${view.dataType.toUpperCase()}(${view.length})`;

  // Genuine leading zero (the coercion bug's actual case): strip textually, never via
  // Number(), so a non-numeric tail (`007ABC`) can't produce `NaN`.
  const padded = view.fixedValues?.find((v) => v.low && /^0\d/.test(v.low));
  if (padded) {
    const stripped = padded.low.replace(/^0+(?=.)/, "");
    return (
      `Fixed values on this ${prefix} domain are character literals, not numbers: '${padded.low}' ` +
      `is ${padded.low.length} characters and compares equal ` +
      `only to '${padded.low}' — IF x = ${stripped} and IF x = '${stripped}' both silently never ` +
      `match. The table above shows the stored characters exactly as the system returned them.`
    );
  }

  // Digit-leading but not zero-padded: still a character literal, must be
  // quoted, but the quoted comparison IS correct — no "never matches" claim.
  const digitLeading = view.fixedValues?.find((v) => v.low && /^\d/.test(v.low));
  if (digitLeading) {
    return (
      `Fixed values on this ${prefix} domain are character literals, not numbers: ` +
      `'${digitLeading.low}' must be compared quoted — IF x = '${digitLeading.low}', not ` +
      `IF x = ${digitLeading.low}. The table above shows the stored characters exactly as the ` +
      `system returned them.`
    );
  }

  return undefined;
}

export function renderDomain(view: DomainView): DdicRender {
  const ddl = [
    `define domain ${view.name.toLowerCase()} {`,
    `  type        : ${view.dataType} length ${view.length}${
      view.decimals ? ` decimals ${view.decimals}` : ""
    };`,
    ...(view.outputLength !== undefined ? [`  output len  : ${view.outputLength};`] : []),
    ...(view.conversionExit ? [`  conv exit   : ${view.conversionExit};`] : []),
    ...(view.lowercase ? [`  lowercase   : true;`] : []),
    ...(view.signExists ? [`  sign        : true;`] : []),
    ...(view.valueTable ? [`  value table : ${view.valueTable};`] : []),
    ...(view.fixedValues?.length ? [`  fixed values: ${view.fixedValues.length};`] : []),
    `}`,
  ].join("\n");

  const sections: Array<{ title: string; content: string }> = [];
  if (view.fixedValues?.length) {
    sections.push({ title: "FIXED VALUES", content: renderFixedValues(view.fixedValues) });
  }

  const notes: string[] = [];
  if (!view.valueTable && !view.fixedValues?.length) {
    notes.push("No value table and no fixed values — this domain constrains type only.");
  }
  if (view.fixedValues?.length) {
    const charNote = characterLiteralNote(view);
    if (charNote) notes.push(charNote);
    // Symptom-only guard for objects that predate the write-time fix.
    // Root-caused: a DOMA/DD write whose root element carries no
    // `adtcore:masterLanguage` silently drops every <doma:fixedValue><doma:text>
    // description while the codes survive; re-writing with the attribute
    // present repairs the domain in place. `abap_write` now refuses that
    // payload before sending (`assertDomaMasterLanguage` in src/adt/write.ts),
    // so a domain missing text going forward means either it predates that
    // guard or it genuinely never had descriptions — this note can't tell
    // which, hence the remedy below rather than a bare warning. Independent
    // of, and not to be confused with, the `language`-attribute-on-<doma:text>
    // hypothesis, which was tested and falsified (full trial record: the
    // git history).
    const withoutText = view.fixedValues.filter((v) => !v.text);
    if (withoutText.length === view.fixedValues.length) {
      notes.push(
        `All ${view.fixedValues.length} fixed value(s) have no text. If descriptions were sent ` +
          `for them, this domain was likely written before adtcore:masterLanguage was present on ` +
          `the payload's root element, independent of whether <doma:text> ` +
          `carries its own language attribute. Re-write this domain with adtcore:masterLanguage=` +
          `"EN" on the root to repair it in place, then re-read to confirm.`,
      );
    } else if (withoutText.length > 0) {
      const sample = withoutText
        .slice(0, 5)
        .map((v) => (v.low === "" ? "''" : v.low))
        .join(", ");
      notes.push(
        `${withoutText.length} of ${view.fixedValues.length} fixed value(s) have no text` +
          (sample ? ` (${sample}${withoutText.length > 5 ? ", …" : ""})` : "") +
          `. If descriptions were intended for these, this domain was likely written before ` +
          `adtcore:masterLanguage was present on the payload's root element. Re-write it ` +
          `with adtcore:masterLanguage="EN" on the root to repair it in place, then re-read to ` +
          `confirm.`,
      );
    }
    const withTextNoLang = view.fixedValues.filter((v) => v.text && !v.textLanguage);
    if (withTextNoLang.length > 0) {
      notes.push(
        `${withTextNoLang.length} fixed value(s) have text with no language attribute observed ` +
          `on the <doma:text> element that produced it. This is not itself a sign of trouble — ` +
          `real SAP-delivered domains (e.g. XFELD, BOOLE) return their genuine text this exact ` +
          `way, with no language attribute at all — but it does mean this text's provenance is ` +
          `not distinguishable, from a read alone, from an object written before this module's ` +
          `parsing fix. Informational only.`,
      );
    }
  }

  return {
    ddl,
    sections,
    meta: { description: view.description, package: view.packageName },
    notes,
    hashInput: ddl,
  };
}

// -------------------------------------------------------- the write guard ---
//
// A prior `lintDdicWritePayload()` pre-send check (flagging <doma:text>
// with content but no `language` attribute) was removed: live verification
// showed a compliant payload fails identically to a non-compliant one, so
// the lint gave false confidence. Guidance moved to skills/ddic/SKILL.md;
// `renderDomain`'s guard notes above are the durable, symptom-only
// replacement. Full history: the git history.

// ------------------------------------------------------------- the reader ---

// Moved to ddic-strategy.ts (an importless leaf module) to break a runtime
// import cycle back through capabilities.ts; re-exported here so existing
// importers of this module keep working.
export {
  DDIC_SOURCE_BASED,
  DDIC_XML_ONLY,
  DDIC_CATALOG_BASED,
  ddicStrategy,
} from "./ddic-strategy.js";
export type { DdicStrategy } from "./ddic-strategy.js";

/**
 * Classify a failed DDIC fetch instead of swallowing it. A 403 is an
 * AUTHORISATION failure; presenting it as "this object has no source" (or as
 * an empty rendering) tells the agent something false about the system.
 * Mirrors `classifySourceFailure` in source.ts, which this module cannot own.
 */
export function classifyDdicFailure(e: unknown, ctx: ErrorContext): AbapError {
  const err = translateAdtError(e, ctx);
  if (err.code !== "ADT_ERROR") return err;
  const status = typeof err.details.status === "number" ? err.details.status : undefined;
  if (status === 401 || status === 403) {
    return new AbapError(
      "AUTH_FAILED",
      status === 401
        ? `Authentication failed (HTTP 401) while reading ${ctx.type ?? "object"} ${ctx.name ?? ctx.uri}.`
        : `Not authorised (HTTP 403) to read ${ctx.type ?? "object"} ${ctx.name ?? ctx.uri}. ` +
          `The logon succeeded; the user lacks the authorisation for this object.`,
      { ...err.details, status },
      status === 401
        ? "Fix ABAP_USER / ABAP_PASSWORD. This is not a naming problem and the object was never inspected."
        : "The user is authenticated but not authorised (typically S_DEVELOP / table display). " +
          "This is NOT evidence that the object is empty or has no source — nothing about its " +
          "content was returned.",
    );
  }
  return err;
}

/**
 * Raw XML descriptor at a properties-shape object's own URI. Factored out of
 * `renderTableType`'s `conn.get` so `readDataElement`/`readDomain`/
 * `tryReadDomain` share one fetch instead of going through
 * `abap-adt-api`'s parse-and-discard accessors (which would need a second,
 * separate GET just to hash the raw bytes for the etag). Shared with
 * `abap_read`'s `format:"raw"` path via `fetchRawDescriptor` in
 * src/tools/read.ts.
 *
 * `accept` defaults to `application/*`; `SRVB/SVB` needs its own vendor
 * media type instead (406s on a generic Accept — see
 * `TypeCapabilities.mediaType` in src/adt/capabilities.ts and its PROVENANCE
 * WARNING). Not imported from here to avoid a cycle with capabilities.ts, so
 * `fetchRawDescriptor` passes the override in explicitly. Full rationale:
 * the git history.
 */
export async function fetchDdicXml(
  conn: AbapConnection,
  target: { uri: string; name: string; type: string },
  operation: string,
  accept = "application/*",
): Promise<string> {
  try {
    const { body } = await conn.get(target.uri, { headers: { Accept: accept } });
    return body;
  } catch (e) {
    throw classifyDdicFailure(e, { operation, uri: target.uri, name: target.name, type: target.type });
  }
}

function xmlAttr(node: unknown, attr: string): string | undefined {
  if (node && typeof node === "object" && !Array.isArray(node)) {
    const v = (node as Record<string, unknown>)[`@_${attr}`];
    return typeof v === "string" && v !== "" ? v : undefined;
  }
  return undefined;
}

/**
 * Text content of an element that may or may not carry attributes.
 *
 * fast-xml-parser (with `ignoreAttributes: false`) parses an attribute-free
 * leaf as a plain string but an attributed one (e.g.
 * `<doma:text language="EN">Truck</doma:text>`) as `{ "@_language": ...,
 * "#text": "Truck" }`. Reading `.text` straight through silently renders
 * `"[object Object]"` the day an element gains an attribute — every
 * attribute-capable element (incl. `doma:text`) must go through this helper.
 * Kept even though no live SAP response observed so far actually carries the
 * attribute — costs nothing, guards a real footgun. See archive for detail.
 */
function xmlText(node: unknown): string | undefined {
  if (node === undefined || node === null) return undefined;
  if (typeof node === "object" && !Array.isArray(node)) {
    const t = (node as Record<string, unknown>)["#text"];
    return t === undefined || t === null ? undefined : String(t);
  }
  return String(node);
}

/**
 * Under `parseTagValue: false`, `<doma:lowercase>true</doma:lowercase>` is
 * the string `"true"` — the old `oi.lowercase === true` compared a
 * string to a boolean and was permanently `false`. Routes through `xmlText`
 * for the same reason `xmlText` exists: an element that gains an attribute
 * must still resolve. ADT also writes some DDIC flags as `X` rather than
 * `true` — accept both spellings.
 */
function xmlBool(node: unknown): boolean {
  const t = xmlText(node)?.trim().toLowerCase();
  return t === "true" || t === "x";
}

/**
 * DDIC descriptors zero-pad numerics (`<ttyp:length>000000</ttyp:length>`);
 * now that `parseTagValue: false` stops the parser from doing it, callers
 * that need a real number must parse explicitly, here, and only where the
 * value really is a number — never on fixed values or labels.
 */
function xmlNum(node: unknown): number | undefined {
  const t = xmlText(node);
  if (t === undefined || t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/** Parse a DOMA/DD properties-XML descriptor (`doma:domain > doma:content > ...`). */
function parseDomainXml(body: string, fallbackName: string): DomainView {
  const doc = xml.parse(body) as Record<string, any>;
  const root = doc.domain ?? {};
  const content = root.content ?? {};
  const ti = content.typeInformation ?? {};
  const oi = content.outputInformation ?? {};
  const vi = content.valueInformation;
  const fixRaw = vi?.fixValues?.fixValue;
  const fixList = Array.isArray(fixRaw) ? fixRaw : fixRaw ? [fixRaw] : [];
  // All fields go through xmlText (not a raw property read) so a future
  // attribute on low/high doesn't silently break this the way `text` did.
  const fixedValues: DomainFixedValue[] = fixList.map((f: any) => {
    const low = xmlText(f?.low) ?? "";
    const high = xmlText(f?.high);
    const text = xmlText(f?.text);
    return {
      low,
      high: high === "" ? undefined : high,
      text: text === "" ? undefined : text,
      textLanguage: xmlAttr(f?.text, "language"),
    };
  });

  return {
    name: String(root["@_name"] ?? fallbackName),
    description: root["@_description"] ? String(root["@_description"]) : undefined,
    dataType: xmlText(ti.datatype) ?? "",
    length: xmlNum(ti.length) ?? 0,
    decimals: xmlNum(ti.decimals) || undefined,
    outputLength: xmlNum(oi.length),
    conversionExit: xmlText(oi.conversionExit) || undefined,
    lowercase: xmlBool(oi.lowercase),
    signExists: xmlBool(oi.signExists),
    valueTable: xmlAttr(vi?.valueTableRef, "name"),
    fixedValues: fixedValues.length ? fixedValues : undefined,
    packageName: xmlAttr(root.packageRef, "name"),
  };
}

/** Parse a DTEL/DE properties-XML descriptor (`blue:wbobj > dtel:dataElement`). */
function parseDataElementXml(
  body: string,
  fallbackName: string,
): {
  name: string;
  description?: string;
  packageName?: string;
  typeName: string;
  dataType: string;
  dataTypeLength: number;
  dataTypeDecimals: number;
  labels: Record<string, string>;
  labelLengths: Record<string, number>;
  searchHelp?: string;
  searchHelpParameter?: string;
} {
  const doc = xml.parse(body) as Record<string, any>;
  // Real wire shape is always <blue:wbobj><dtel:dataElement>...; the
  // doc.dataElement fallback degrades to empty fields rather than throwing.
  const root = doc.wbobj ?? doc.dataElement ?? {};
  const de = root.dataElement ?? {};
  // xmlText, not String(): this also used to number-coerce a short field
  // label of `0001` or an all-digit typeName — same bug, different fields.
  return {
    name: String(root["@_name"] ?? fallbackName),
    description: root["@_description"] ? String(root["@_description"]) : undefined,
    packageName: xmlAttr(root.packageRef, "name"),
    typeName: xmlText(de.typeName) ?? "",
    dataType: xmlText(de.dataType) ?? "",
    dataTypeLength: xmlNum(de.dataTypeLength) ?? 0,
    dataTypeDecimals: xmlNum(de.dataTypeDecimals) ?? 0,
    labels: {
      short: xmlText(de.shortFieldLabel) ?? "",
      medium: xmlText(de.mediumFieldLabel) ?? "",
      long: xmlText(de.longFieldLabel) ?? "",
      heading: xmlText(de.headingFieldLabel) ?? "",
    },
    // A missing *FieldLength stays missing, never 0 — a rendered "length 0"
    // would claim a value the descriptor never sent.
    labelLengths: Object.fromEntries(
      (
        [
          ["short", xmlNum(de.shortFieldLength)],
          ["medium", xmlNum(de.mediumFieldLength)],
          ["long", xmlNum(de.longFieldLength)],
          ["heading", xmlNum(de.headingFieldLength)],
        ] as Array<[string, number | undefined]>
      ).filter((e): e is [string, number] => e[1] !== undefined),
    ),
    searchHelp: xmlText(de.searchHelp) || undefined,
    searchHelpParameter: xmlText(de.searchHelpParameter) || undefined,
  };
}

/** Options threaded into a package-shaped ({@link readPackage}) read. Ignored by every other DDIC kind. */
export interface DdicReadOptions {
  /** Restrict a package listing to these ADT type codes, e.g. ["CLAS", "DDLS"]. */
  readonly types?: readonly string[];
  /** How many package levels to list. 1 = this package only (default). Capped at {@link MAX_PACKAGE_DEPTH}. */
  readonly depth?: number;
}

/** Read a DDIC object and render it as pseudo-DDL. Never returns raw XML. */
export async function readDdic(
  conn: AbapConnection,
  obj: ResolvedObject,
  opts: DdicReadOptions = {},
): Promise<DdicRender> {
  switch (ddicStrategy(obj.kind)) {
    case "source":
      return readTableLike(conn, obj);
    case "package":
      return readPackage(conn, obj, opts);
    case "xml":
      switch (obj.kind.toUpperCase()) {
        case "DTEL":
          return readDataElement(conn, obj);
        case "DOMA":
          return readDomain(conn, obj);
        default:
          return readTableType(conn, obj);
      }
    case "catalog":
      return readCatalogObject(conn, obj);
    default:
      throw new AbapError(
        "UNSUPPORTED",
        `${obj.type} is not a DDIC type abap_read can render.`,
        {
          type: obj.type,
          renderable: [...DDIC_SOURCE_BASED, ...DDIC_XML_ONLY, ...DDIC_CATALOG_BASED, "DEVC"],
        },
      );
  }
}

async function readTableLike(conn: AbapConnection, obj: ResolvedObject): Promise<DdicRender> {
  const ctx: ErrorContext = {
    operation: "read DDIC object",
    uri: obj.uri,
    name: obj.name,
    type: obj.type,
  };
  // TABL/STRU are source-based per the group, not a per-type flag.
  let sourceFailure: string | undefined;
  try {
    const { body } = await conn.get(`${obj.uri}/source/main`, {
      headers: { Accept: "text/plain" },
    });
    const parsed = parseDdl(body);
    const digest = renderDdlDigest(parsed);
    const sections = [...digest.sections];
    const meta: Record<string, string | number | undefined> = { ...digest.meta };
    const notes: string[] = [];

    // #86: a TABL/DT read appends a secondary-index section here, AFTER the
    // field list digest.sections already carries. Placed after, not before,
    // because a secondary index is defined OVER a table's fields — it reads
    // as a continuation of the field list, not a header-level fact that
    // should precede it. Tables only (obj.kind === "TABL"): a STRU structure
    // is not stored, so it has no secondary index to report. This costs two
    // extra freestyle SELECTs per table read (DD12V then DD17S — see
    // src/adt/index-read.ts), on top of the /source/main GET above.
    //
    // Non-fatal by design: a table's field list is still a complete, correct
    // answer even when the index catalog can't be reached, so a failed
    // re-read here must not fail the whole read — it is caught and turned
    // into a note instead, one that explicitly says "not read", never "none".
    if (obj.kind === "TABL") {
      try {
        const { indexes, notes: indexNotes } = await readTableIndexes(conn, obj.name);
        sections.push(renderIndexSection(indexes));
        notes.push(...indexNotes);
        // Recorded only on a successful read — an absent field here is honest
        // ("not read"); a `0` would falsely claim the table has no index.
        meta.indexes = indexes.length;
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        notes.push(
          `Secondary index catalog (DD12V/DD17S) could not be read for ${obj.name} (${reason}). ` +
            `This is NOT evidence the table has no secondary index — it means the index section is ` +
            `simply missing from this response, not that "none" was confirmed.`,
        );
      }
    }

    return {
      ddl: body.replace(/\r\n/g, "\n").trimEnd(),
      sections,
      meta,
      notes,
      hashInput: body,
    };
  } catch (e) {
    // Only a genuine 404 means "no source here" — anything else (403, 500,
    // dead session) must surface as a failure, not a degraded XML fallback.
    if (!isNotFoundError(e)) throw classifyDdicFailure(e, ctx);
    sourceFailure =
      `${obj.type} ${obj.name} has no /source/main on this system (HTTP 404); ` +
      `the definition below was reconstructed from the ADT XML`;
  }
  try {
    const { body } = await conn.get(obj.uri, { headers: { Accept: "application/*" } });
    // #86: the index section is intentionally NOT added on this fallback path.
    // renderTableXmlFallback is a pure sync renderer (no `conn`, no `obj.kind`)
    // that other callers/tests construct a DdicRender from directly; threading
    // an async catalog read and a TABL/STRU distinction through it is not a
    // clean fit for what is already a degraded-fidelity path. A release old
    // enough to need this fallback (TABL/STRU XML-only, no /source/main) is
    // not the common case this issue targets.
    return renderTableXmlFallback(body, obj.name, sourceFailure);
  } catch (e) {
    throw classifyDdicFailure(e, ctx);
  }
}

/** Package listing depth cap (issue #74's `depth` option). Each level beyond the first costs one nodestructure round trip per sub-package found at the level above — an unbounded depth turns one abap_read into an unbounded fan-out. */
const MAX_PACKAGE_DEPTH = 3;

/**
 * Total nodestructure round trips a single `readPackage` call may spend
 * EXPANDING sub-packages (i.e. beyond the mandatory level-1 fetch of the
 * package the caller actually asked for). Independent of `MAX_PACKAGE_DEPTH`:
 * a package with hundreds of direct sub-packages can exhaust this at depth 2
 * long before depth itself would stop anything. When it bites, the affected
 * sub-packages are named in a note (`test/no-silent-truncation.test.ts`
 * fails an unmarked cap by design) — they are NOT hidden, just not expanded.
 */
const MAX_PACKAGE_EXPANSIONS = 25;

/**
 * Per-request `maxResults` cap for ONE prefix-grouped description lookup
 * (`query=<char>*&packageName=<pkg>` — see buildDescriptionLookupTasks and
 * fetchPackageDescriptions below). Issue #74 follow-up: a single `query=*` per package (the original
 * design) hit ITS cap on large packages — `$TMP` has 11128 objects
 * system-wide under that packageName — and left 388 of 389 rendered rows
 * with an empty description. Scoping each request to one starting character
 * of the names actually being rendered fixes that for the realistic case:
 * live-timed against A4H 2026-09-12, `query=Z*&packageName=$TMP` returned
 * 243 entries in 2.9s (correctly resolving `ZTESTAI`), and `query=B*` — the
 * largest observed single-character group, since it matches every `B*`
 * object under `$TMP` system-wide, not just the 389 rows actually rendered —
 * returned 385 entries in 0.5s. A cap in the low thousands is generous
 * headroom for one starting character while keeping each request fast.
 */
const PACKAGE_DESCRIPTION_PREFIX_LOOKUP_CAP = 2000;

/**
 * Max distinct starting characters (i.e. prefix-grouped requests) one
 * package's rendered rows may be split into before falling back to a single
 * whole-package query instead. Bounds the fan-out: without this, a package
 * whose rendered names happen to span dozens of distinct starting
 * characters would issue one request per character with no ceiling. The
 * realistic case this issue targets ($TMP, 389 rendered rows) needs only 16
 * groups — live-confirmed 2026-09-12 — comfortably under this cap; it exists
 * for the pathological case, not the common one. When it fires, that is
 * reported in a note (see PACKAGE_DESCRIPTION_FALLBACK_LOOKUP_CAP for the
 * request it falls back to).
 */
const PACKAGE_DESCRIPTION_GROUP_CAP = 30;

/**
 * `maxResults` for the rare whole-package fallback query (see
 * PACKAGE_DESCRIPTION_GROUP_CAP) issued instead of a per-prefix fan-out when
 * a package's rendered rows span more distinct starting characters than
 * that cap allows. Larger than PACKAGE_DESCRIPTION_PREFIX_LOOKUP_CAP because
 * this path already accepts the cost of one big request in place of many
 * small ones; still bounded (see the historical 20.9s / 12000-result timing
 * on `$TMP` recorded against the old whole-package design, now
 * superseded) — when even this cap is hit, that is reported the same way
 * any other capped lookup is, not hidden.
 */
const PACKAGE_DESCRIPTION_FALLBACK_LOOKUP_CAP = 6000;

interface PackageHeaderView {
  description?: string;
  responsible?: string;
  masterLanguage?: string;
  changedAt?: string;
  packageType?: string;
  superPackage?: string;
  /** `pak:applicationComponent/@pak:name`, or its `@pak:description` when name is empty — see parsePackageHeaderXml. */
  applicationComponent?: string;
  softwareComponent?: string;
  transportLayer?: string;
}

/**
 * Parse a package header descriptor (`GET /sap/bc/adt/packages/<name>`,
 * `pak:package` root). Field provenance, all confirmed live on A4H
 * 2026-09-12 (captures 856 SABP_UNIT_CORE_RUNTIME, 857 Z_BADI_CHECK):
 * `adtcore:description/responsible/masterLanguage/changedAt` on the root,
 * `pak:attributes/@pak:packageType`, `pak:superPackage/@adtcore:name`,
 * `pak:applicationComponent/@pak:name` (+`@pak:description`),
 * `pak:transport/pak:softwareComponent/@pak:name`,
 * `pak:transport/pak:transportLayer/@pak:name`.
 */
function parsePackageHeaderXml(body: string): PackageHeaderView {
  const doc = xml.parse(body) as Record<string, any>;
  const root = doc.package ?? {};
  const attrs = root.attributes ?? {};
  const appComp = root.applicationComponent ?? {};
  const transport = root.transport ?? {};

  return {
    description: xmlAttr(root, "description"),
    responsible: xmlAttr(root, "responsible"),
    masterLanguage: xmlAttr(root, "masterLanguage"),
    changedAt: xmlAttr(root, "changedAt"),
    packageType: xmlAttr(attrs, "packageType"),
    // <pak:superPackage/> on a customer package (857) is present but carries
    // NO attributes at all — fast-xml-parser renders an attribute-free
    // self-closing element as "" (a string), and xmlAttr's typeof-object
    // guard already returns undefined for a non-object node. That IS "no
    // super package", not a parse failure — do not special-case it further.
    superPackage: xmlAttr(root.superPackage, "name"),
    // Name is legitimately "" when no application component is assigned
    // (857: pak:name="" pak:description="No application component
    // assigned"). Falling back to the description avoids rendering a blank
    // field that looks like a missed parse.
    applicationComponent: xmlAttr(appComp, "name") || xmlAttr(appComp, "description"),
    softwareComponent: xmlAttr(transport.softwareComponent, "name"),
    transportLayer: xmlAttr(transport.transportLayer, "name"),
  };
}

/**
 * Fetch and parse the package header. Best-effort: `readPackage` renders the
 * node listing regardless of whether this succeeds — a header failure (any
 * status, any parse problem) must never turn a working listing into a hard
 * error, only into a note naming the fields that are now unknown.
 *
 * Accept "any media type" (a wildcard-over-wildcard Accept header) —
 * live-verified on A4H 2026-09-12 (captures 856, 857). The vendor media type
 * this endpoint's response body actually reports
 * (`application/vnd.sap.adt.packages.v2+xml`) is NOT what the request
 * should ask for: asking for `application/vnd.sap.adt.packages.v1+xml,
 * application/xml` answers `406 ExceptionResourceNotAcceptable`. The
 * wildcard Accept is the only one observed to work here — this is not
 * laziness, do not "tighten" it to a specific media type without a fresh
 * live capture.
 */
async function fetchPackageHeader(
  conn: AbapConnection,
  ctx: ErrorContext,
): Promise<{ header?: PackageHeaderView; failure?: string }> {
  let body: string;
  try {
    ({ body } = await conn.get(ctx.uri!, { headers: { Accept: "*/*" } }));
  } catch (e) {
    const err = classifyDdicFailure(e, ctx);
    return { failure: `${err.code} — ${err.message}` };
  }
  try {
    return { header: parsePackageHeaderXml(body) };
  } catch (e) {
    return {
      failure: `header response did not parse as expected (${e instanceof Error ? e.message : String(e)})`,
    };
  }
}

/**
 * `nodeContents` for one package, tolerant of the zero-byte-200 shape a
 * package with no contents answers on this system — live-verified A4H
 * 2026-09-12, captures 852/854/877-881: an empty package is HTTP 200 with a
 * ZERO-BYTE body, not an empty XML document and not a 404. A same-session
 * control (SABP_UNIT_ADT through this identical code path, capture 880)
 * returned 10245 bytes, and a no-request-body variant (capture 881) answers
 * identically — this is a real, repeatable server behaviour, not a fluke of
 * one request shape.
 *
 * `abap-adt-api`'s own `nodeContents` already treats a falsy response body
 * as "no nodes" without throwing (`parsePackageResponse`'s `if (data)`
 * guard), so in practice the catch below is not reached for the empty-body
 * case today. It stays as a second line of defence: only a failure
 * `classifyDdicFailure` can pin to an actual numeric HTTP status (a response
 * that really reached the ABAP handler, even a 401/403/500) is a genuine
 * transport/auth failure and is re-thrown. Anything else — concretely, a
 * plain JS exception thrown by the vendor library's own XML parsing, which
 * never carries a status because it never went through `AdtHTTP`'s
 * HTTP-error path (see `adtExceptionInfo`'s `hasShape` check in
 * session.ts) — lands as "no nodes", the same outcome as the zero-byte-200
 * case it is indistinguishable from at this boundary.
 */
async function fetchPackageNodes(
  conn: AbapConnection,
  packageName: string,
  ctx: ErrorContext,
): Promise<readonly AdtRepositoryNode[]> {
  try {
    const result = await conn.adt.nodeContents("DEVC/K", packageName);
    return result?.nodes ?? [];
  } catch (e) {
    const classified = classifyDdicFailure(e, ctx);
    if (typeof classified.details.status === "number") throw classified;
    return [];
  }
}

// `nodeContents` above still asks for `withShortDescriptions=true` (the
// vendor `abap-adt-api` wrapper hardcodes it — see
// node_modules/abap-adt-api/build/api/nodeContents.js — there is no
// unwrapped call that could omit it without giving up its zero-byte-body
// tolerance documented on fetchPackageNodes). That flag is now cosmetic: the
// DESCRIPTION it puts on the wire is exactly the misaligned field issue #74
// is about, and abap_read no longer reads it (see the comment above the
// `rows` map in readPackage). Leaving the flag on costs nothing measurable
// and avoids touching a vendored code path for no benefit; it is not relied
// on for anything.

/** One `informationsystem/search` result, keyed the same way as `PackageObjectRow` (`type`, `name`). */
interface PackageDescriptionEntry {
  type: string;
  name: string;
  description: string;
}

/**
 * Resolve descriptions for ONE (packageName, query-pattern) pair via
 * `GET /sap/bc/adt/repository/informationsystem/search
 * ?operation=quickSearch&query=<pattern>&packageName=<pkg>&maxResults=<cap>`.
 * `pattern` is passed through the connection's existing `qs` encoding
 * unmodified (e.g. `"Z*"`, `"/*"`, `"$*"`, or `"*"` for the whole-package
 * fallback) — live-confirmed A4H 2026-09-12 that a literal pattern character
 * (including `/` and `$`) round-trips correctly through that same
 * single-encoding pipeline `packageName` already uses (`$TMP` already goes
 * out on the wire as `packageName=%24TMP`). Manually pre-percent-encoding
 * the pattern here would double-encode once `qs` encodes it again — verified
 * live to silently return zero results (HTTP 200, empty body) rather than
 * an error, so this must never be done.
 *
 * Live-verified A4H 2026-09-12 (captures 884/885): this endpoint pairs each
 * object with its OWN description by (type, name), independent of any wire
 * ordering — unlike the node structure endpoint's DESCRIPTION column, which
 * is not positionally trustworthy once the package has a sub-package (see
 * the comment on the `rows` map in readPackage). A sub-package's own row is
 * included here too, filed under its PARENT's packageName, even though that
 * row's own `packageName` attribute in the response points at itself, not
 * its parent — a self-referential quirk of the wire format for package
 * objects that does not affect this lookup, since the request is filtered
 * server-side.
 *
 * An object legitimately without a description omits the
 * `adtcore:description` attribute entirely rather than sending it empty
 * (live-verified) — `xmlAttr` returning undefined for that row must not be
 * confused with the row being absent from the response; both render an
 * empty description, but only the latter counts as "unresolved" upstream.
 *
 * Any HTTP failure here is caught and reported via `failure`, never thrown:
 * a description lookup failing must not turn a working package listing into
 * a hard error (the same contract fetchPackageHeader already has), and —
 * per fetchPackageDescriptions below — must not affect any OTHER task's
 * results either.
 */
async function fetchPackageDescriptionsForOne(
  conn: AbapConnection,
  packageName: string,
  query: string,
  maxResults: number,
): Promise<{ entries: PackageDescriptionEntry[]; failure?: string; hitCap: boolean }> {
  let body: string;
  try {
    ({ body } = await conn.get("/sap/bc/adt/repository/informationsystem/search", {
      headers: { Accept: "application/xml" },
      qs: {
        operation: "quickSearch",
        query,
        packageName,
        maxResults: String(maxResults),
      },
    }));
  } catch (e) {
    const ctx: ErrorContext = {
      operation: "read package",
      uri: "/sap/bc/adt/repository/informationsystem/search",
      name: packageName,
      type: "DEVC/K",
    };
    const err = classifyDdicFailure(e, ctx);
    return { entries: [], failure: `${err.code} — ${err.message}`, hitCap: false };
  }
  try {
    const doc = xml.parse(body) as Record<string, any>;
    const root = doc.objectReferences ?? {};
    const raw = root.objectReference;
    const list: unknown[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const entries: PackageDescriptionEntry[] = list
      .map((n) => ({
        type: xmlAttr(n, "type") ?? "",
        name: xmlAttr(n, "name") ?? "",
        description: xmlAttr(n, "description") ?? "",
      }))
      .filter((e) => e.type && e.name);
    return { entries, hitCap: entries.length >= maxResults };
  } catch (e) {
    return {
      entries: [],
      failure: `search response did not parse as expected (${e instanceof Error ? e.message : String(e)})`,
      hitCap: false,
    };
  }
}

/**
 * Group render-contributing names by their first character, for one
 * package's prefix-scoped description lookup. Callers must pass only names
 * that survived `types` filtering and are actually about to be rendered —
 * issue #74 is explicit that groups must never be derived from rows that
 * were filtered or paged away.
 */
function groupNamesByFirstChar(names: readonly string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const name of names) {
    if (!name) continue;
    const char = name.charAt(0);
    const group = groups.get(char);
    if (group) group.push(name);
    else groups.set(char, [name]);
  }
  return groups;
}

/**
 * Run `fn` over `items` with at most `limit` calls in flight at once,
 * resolving to results in the same order as `items`. A tiny local
 * worker-pool helper (no new dependency) — see `DESCRIPTION_LOOKUP_CONCURRENCY`
 * below for why this exists: an unbounded `Promise.all` fan-out over these
 * same requests is what produced a live `SessionBusyError`.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/**
 * Max description-lookup requests (`informationsystem/search`) allowed in
 * flight at once, across ALL packages a single `readPackage` call touches —
 * not just within one package's prefix groups. Live-observed against A4H
 * 2026-09-12 reading `$TMP` (389 rendered rows, 16 distinct
 * starting-character groups): firing all 16 group requests at once via
 * `Promise.all` left 8 of them failing with `SessionBusyError: The ABAP
 * session queue is full for
 * "/sap/bc/adt/repository/informationsystem/search"; current holder is
 * exclusive "/sap/bc/adt/packages/%24tmp"` — every row whose name started
 * with S, T, U, 3, 4, 5, 6 or 7 rendered with an empty description as a
 * result. The connection pool serialises requests per session, and its own
 * default `readConcurrency` (src/config.ts) is 2 — matching that here,
 * rather than picking a bigger number, is what keeps this fan-out from
 * reproducing the same queue-full failure it is meant to fix.
 */
const DESCRIPTION_LOOKUP_CONCURRENCY = 2;

/** One description-lookup request still to be issued, flattened across every package (see fetchPackageDescriptions). */
interface DescriptionLookupTask {
  packageName: string;
  /** The `query` pattern to send: `<char>*`, or `*` for a whole-package fallback. */
  query: string;
  maxResults: number;
  /** Group identifier used in notes/keys: a first character, or `"*"` for the whole-package fallback. */
  char: string;
  /** True when this task is a whole-package fallback (see PACKAGE_DESCRIPTION_GROUP_CAP), not a per-prefix group. */
  fellBack: boolean;
}

/**
 * Turn one package's rendered names into the description-lookup requests it
 * needs: group by first character and one task per distinct group, unless
 * the rendered names span more distinct starting characters than
 * PACKAGE_DESCRIPTION_GROUP_CAP, in which case a single whole-package
 * fallback task (PACKAGE_DESCRIPTION_FALLBACK_LOOKUP_CAP) replaces the
 * per-character fan-out instead of leaving it unbounded. Does not issue any
 * request itself — see fetchPackageDescriptions, which runs every
 * package's tasks through one shared, bounded pool.
 */
function buildDescriptionLookupTasks(
  packageName: string,
  names: readonly string[],
): DescriptionLookupTask[] {
  const groups = groupNamesByFirstChar(names);
  if (groups.size === 0) return [];
  if (groups.size > PACKAGE_DESCRIPTION_GROUP_CAP) {
    return [
      {
        packageName,
        query: "*",
        maxResults: PACKAGE_DESCRIPTION_FALLBACK_LOOKUP_CAP,
        char: "*",
        fellBack: true,
      },
    ];
  }
  return [...groups.keys()].map((char) => ({
    packageName,
    query: `${char}*`,
    maxResults: PACKAGE_DESCRIPTION_PREFIX_LOOKUP_CAP,
    char,
    fellBack: false,
  }));
}

/**
 * Resolve descriptions for every package that actually contributed a row to
 * what's about to be rendered. `namesByPackage` maps each such package to
 * exactly the names that survived `types` filtering and are about to be
 * rendered under it (see readPackage) — not every package visited while
 * expanding the `depth`-frontier, most of which contribute nothing once
 * `types` filtering runs.
 *
 * Every package's description-lookup requests (one per prefix group, or one
 * whole-package fallback — see buildDescriptionLookupTasks) are flattened
 * into a single list and run through ONE shared `mapWithConcurrency` pool
 * bounded by `DESCRIPTION_LOOKUP_CONCURRENCY`, so the total number of these
 * requests in flight at once is bounded across packages too, not just
 * within one package's own groups — see DESCRIPTION_LOOKUP_CONCURRENCY for
 * the live failure this avoids. Each task's request is independently
 * non-fatal — a failing task leaves ONLY that task's names unresolved,
 * never affecting any other task's results (issue #74 requirement). No
 * retry is attempted here: bounding the concurrency to the pool's own
 * default is what fixes the observed SessionBusyError, and a retry with no
 * backoff would not help a failure that concurrency, not transience, caused.
 */
async function fetchPackageDescriptions(
  conn: AbapConnection,
  namesByPackage: ReadonlyMap<string, readonly string[]>,
): Promise<{
  map: Map<string, string>;
  failures: string[];
  capped: string[];
  fellBack: string[];
  /** Keys of the form `<packageName> <char>` (space-separated) — or `<packageName> *` for a failed fallback — whose request failed; see readPackage's unresolved-count accounting. */
  failedGroups: Set<string>;
}> {
  const tasks = [...namesByPackage.entries()].flatMap(([packageName, names]) =>
    buildDescriptionLookupTasks(packageName, names),
  );

  const results = await mapWithConcurrency(tasks, DESCRIPTION_LOOKUP_CONCURRENCY, async (task) => ({
    task,
    ...(await fetchPackageDescriptionsForOne(conn, task.packageName, task.query, task.maxResults)),
  }));

  const map = new Map<string, string>();
  const failures: string[] = [];
  const capped: string[] = [];
  const fellBackSet = new Set<string>();
  const failedGroups = new Set<string>();
  for (const r of results) {
    const { packageName, char, fellBack } = r.task;
    if (fellBack) fellBackSet.add(packageName);
    if (r.failure) {
      failures.push(
        fellBack
          ? `${packageName} (fallback query, ${r.failure})`
          : `${packageName}/"${char}*" (${r.failure})`,
      );
      failedGroups.add(`${packageName} ${char}`);
      continue;
    }
    if (r.hitCap) capped.push(fellBack ? `${packageName} (fallback query)` : `${packageName}/"${char}*"`);
    for (const e of r.entries) map.set(`${e.type}|${e.name}`, e.description);
  }
  return { map, failures, capped, fellBack: [...fellBackSet], failedGroups };
}

/** Trim + upper-case caller-supplied `types` entries once, up front. */
function normalizedTypeFilters(types: readonly string[] | undefined): string[] {
  return (types ?? []).map((t) => t.trim().toUpperCase()).filter(Boolean);
}

/** A filter entry matches a row when it equals the row's full type code (`CLAS/OC`) OR the part before the slash (`CLAS`), case-insensitively — both already normalised by `normalizedTypeFilters`. */
function rowMatchesTypeFilters(rowType: string, filters: readonly string[]): boolean {
  if (!filters.length) return true;
  const full = rowType.toUpperCase();
  const prefix = full.split("/")[0] ?? full;
  return filters.some((f) => f === full || f === prefix);
}

interface PackageObjectRow {
  /** The package this row was actually listed under (its immediate parent) — not necessarily the package the caller named, once `depth` > 1. */
  packageName: string;
  type: string;
  name: string;
  description: string;
}

/**
 * Reads a package via the repository node structure endpoint (POST
 * /repository/nodestructure?parent_type=DEVC/K), plus its own header (GET
 * /sap/bc/adt/packages/<name>). Used to be UNSUPPORTED; issue #74 adds the
 * header, per-type object counts, and the `types`/`depth` options.
 */
async function readPackage(
  conn: AbapConnection,
  obj: ResolvedObject,
  opts: DdicReadOptions,
): Promise<DdicRender> {
  const ctx: ErrorContext = {
    operation: "read package",
    uri: obj.uri,
    name: obj.name,
    type: obj.type,
  };

  const depth = opts.depth ?? 1;
  if (!Number.isInteger(depth) || depth < 1 || depth > MAX_PACKAGE_DEPTH) {
    throw new AbapError(
      "BAD_INPUT",
      `depth must be an integer between 1 and ${MAX_PACKAGE_DEPTH}, got ${JSON.stringify(opts.depth)}. ` +
        `Each level beyond the first costs one nodestructure round trip per sub-package found at the ` +
        `level above, so depth is capped rather than left open-ended.`,
      { depth: opts.depth, maxDepth: MAX_PACKAGE_DEPTH },
      `Use a depth between 1 and ${MAX_PACKAGE_DEPTH}, or read a sub-package directly: ` +
        `abap_read {"object":"<SUBPACKAGE>","type":"DEVC/K"}.`,
    );
  }
  const typeFilters = normalizedTypeFilters(opts.types);

  // Breadth-first over sub-packages, one nodestructure call per package per
  // level. Level 1 is always `obj.name` itself — that call is the mandatory
  // cost of reading this package at all and does NOT count against
  // MAX_PACKAGE_EXPANSIONS; only descending further does.
  const allRows: PackageObjectRow[] = [];
  const emptyPackages: string[] = [];
  const notExpanded: string[] = [];
  let directSubPackages: Array<{ name: string; description: string }> = [];
  let expansions = 0;

  let frontier: string[] = [obj.name];
  for (let level = 1; level <= depth && frontier.length > 0; level++) {
    const nextFrontier: string[] = [];
    for (const packageName of frontier) {
      if (level > 1) {
        if (expansions >= MAX_PACKAGE_EXPANSIONS) {
          notExpanded.push(packageName);
          continue;
        }
        expansions++;
      }

      const nodeCtx: ErrorContext = {
        operation: "read package",
        uri: `/sap/bc/adt/packages/${packageName.toLowerCase()}`,
        name: packageName,
        type: "DEVC/K",
      };
      const nodes = await fetchPackageNodes(conn, packageName, nodeCtx);
      if (nodes.length === 0) emptyPackages.push(packageName);

      // Folder nodes (DEVC/P, DEVC/I, DEVC/N, DEVC/XS, DEVC/KI, DEVC/OC,
      // DEVC/VT, …) come back with an empty OBJECT_NAME and OBJECT_URI —
      // dropped by the `n.OBJECT_NAME` filter below. A REAL sub-package is
      // specifically `DEVC/K` (matched exactly, not `startsWith("DEVC")` —
      // that older check was only ever correct because this same
      // empty-name filter ran first and removed every other DEVC/* folder
      // row; matching the prefix again here would silently let a future
      // reordering resurrect them as false sub-packages).
      // `n.DESCRIPTION` is deliberately never read here. Issue #74, live
      // capture 884 (test/fixtures/live-captured/884-i74-nodestructure-tmp-misalignment):
      // when a package's node list contains a DEVC/K sub-package row, the
      // wire's <DESCRIPTION> values are misaligned against the <OBJECT_NAME>
      // they are serialised next to — not by a constant offset, and not
      // fixable by "un-shifting". The sub-package's own missing description
      // resurfaces several rows later, and from that point on every
      // description belongs to the PREVIOUS row, all the way to the end of
      // the list, where the true final object's description is dropped
      // entirely. This is a defect in the response payload itself
      // (reproduced with a raw curl + a regex over the raw bytes), not a
      // parsing artifact. Descriptions are filled in below by an exact
      // (type, name) key lookup against informationsystem/search instead
      // (see fetchPackageDescriptions) — a row that key can't resolve stays
      // empty, never a guessed/positional value.
      const rows: PackageObjectRow[] = nodes
        .filter((n) => n.OBJECT_NAME)
        .map((n) => ({
          packageName,
          type: n.OBJECT_TYPE ?? "",
          name: n.OBJECT_NAME ?? "",
          description: "",
        }));
      allRows.push(...rows);

      const subs = rows.filter((r) => r.type.toUpperCase() === "DEVC/K");
      if (packageName === obj.name) {
        directSubPackages = subs.map((s) => ({ name: s.name, description: "" }));
      }
      for (const s of subs) nextFrontier.push(s.name);
    }
    frontier = nextFrontier;
  }
  // Whatever is still in `frontier` once the loop above ends is the set of
  // sub-packages discovered at the deepest level actually processed, whose
  // OWN contents were never fetched — either because `depth` ran out (this
  // is the frontier for a level beyond `depth`) or because there was simply
  // nothing further to discover (in which case it's empty and no note is
  // needed). This is distinct from `notExpanded` (MAX_PACKAGE_EXPANSIONS):
  // a package that hit that cap is `continue`d before it can contribute
  // anything to `nextFrontier`, so it never appears here — the two lists
  // never overlap and a package is never reported in both notes.
  const unexpandedSubPackages = frontier;

  const matchedFilters = new Set(
    typeFilters.filter((f) => allRows.some((r) => rowMatchesTypeFilters(r.type, [f]))),
  );
  const unmatchedFilters = typeFilters.filter((f) => !matchedFilters.has(f));
  const filteredRows = typeFilters.length
    ? allRows.filter((r) => rowMatchesTypeFilters(r.type, typeFilters))
    : allRows;
  // Sort by type then name (never by package) so paging in src/tools/read.ts
  // is stable across calls regardless of which sub-package a row came from.
  const sortedRows = [...filteredRows].sort(
    (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name),
  );

  const byType = new Map<string, number>();
  for (const r of sortedRows) byType.set(r.type, (byType.get(r.type) ?? 0) + 1);

  // Descriptions are resolved by exact (type, name) key against
  // informationsystem/search, never taken from the node structure's own
  // DESCRIPTION column (see the comment above the `rows` map, and
  // fetchPackageDescriptions). Only packages that actually contributed a
  // row to `sortedRows` are looked up — not every package touched while
  // expanding the depth-frontier, most of which a `types` filter can
  // discard entirely. `obj.name` is added when there are direct
  // sub-packages to describe even if none of its own rows survived the
  // type filter (e.g. `types:["DEVC/K"]`).
  const namesByPackage = new Map<string, string[]>();
  for (const r of sortedRows) {
    const list = namesByPackage.get(r.packageName);
    if (list) list.push(r.name);
    else namesByPackage.set(r.packageName, [r.name]);
  }
  if (directSubPackages.length) {
    // A DEVC/K sub-package row can be filtered out of sortedRows by a
    // `types` filter that excludes DEVC/K (it's still shown in the
    // SUB-PACKAGES section, so its description still needs resolving) —
    // add its name to obj.name's group if it isn't there already.
    const list = namesByPackage.get(obj.name) ?? [];
    for (const s of directSubPackages) if (!list.includes(s.name)) list.push(s.name);
    namesByPackage.set(obj.name, list);
  }

  // Sequential, not concurrent: the header fetch (GET
  // /sap/bc/adt/packages/<name>) is the same request the live SessionBusyError
  // named as the exclusive holder blocking the description-lookup searches
  // (see DESCRIPTION_LOOKUP_CONCURRENCY) — awaiting it first, before spending
  // any of the description pool's slots, avoids adding it to that same
  // queue. It is one request, so this costs nothing beyond fetchPackageHeader's
  // own latency, and its existing best-effort/non-fatal contract is unchanged.
  const { header, failure: headerFailure } = await fetchPackageHeader(conn, ctx);
  const {
    map: descriptions,
    failures: descriptionFailures,
    capped: descriptionCapped,
    fellBack: descriptionFellBack,
    failedGroups,
  } = namesByPackage.size
    ? await fetchPackageDescriptions(conn, namesByPackage)
    : {
        map: new Map<string, string>(),
        failures: [] as string[],
        capped: [] as string[],
        fellBack: [] as string[],
        failedGroups: new Set<string>(),
      };

  /** A row's own group failed (or its package's whole-package fallback failed) — its emptiness is already explained by the `descriptionFailures` note, so it must not be double-counted as "unresolved" too. */
  const rowGroupFailed = (packageName: string, name: string): boolean =>
    failedGroups.has(`${packageName} *`) || failedGroups.has(`${packageName} ${name.charAt(0)}`);

  let unresolvedCount = 0;
  for (const r of sortedRows) {
    const key = `${r.type}|${r.name}`;
    if (descriptions.has(key)) {
      r.description = descriptions.get(key) ?? "";
    } else {
      r.description = "";
      if (!rowGroupFailed(r.packageName, r.name)) unresolvedCount++;
    }
  }
  for (const s of directSubPackages) {
    const key = `DEVC/K|${s.name}`;
    if (descriptions.has(key)) {
      s.description = descriptions.get(key) ?? "";
    } else if (!rowGroupFailed(obj.name, s.name)) {
      unresolvedCount++;
    }
  }

  const columns = depth > 1 ? ["package", "type", "name", "description"] : ["type", "name", "description"];
  const ddl = sortedRows.length
    ? textTable(
        sortedRows.map((r) => ({
          package: r.packageName,
          type: r.type,
          name: r.name,
          description: r.description,
        })),
        columns,
      )
    : `-- package ${obj.name}: the ADT node structure returned no objects` +
      (typeFilters.length ? ` matching types ${typeFilters.join(", ")}` : "") +
      `. This is what the server sent, not a rendering failure.`;

  const sections: Array<{ title: string; content: string }> = [];
  if (byType.size) {
    sections.push({
      title: "OBJECTS BY TYPE",
      content: textTable(
        [...byType.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([type, objects]) => ({ type, objects: String(objects) })),
        ["type", "objects"],
      ),
    });
  }
  if (directSubPackages.length) {
    sections.push({
      title: "SUB-PACKAGES",
      content: textTable(directSubPackages, ["name", "description"]),
    });
  }

  const notes: string[] = [];
  if (emptyPackages.length) {
    notes.push(
      (emptyPackages.length === 1 && emptyPackages[0] === obj.name
        ? `Package ${obj.name} has no contents`
        : `${emptyPackages.length} package(s) had no contents (${emptyPackages.join(", ")})`) +
        ` — the ADT node structure endpoint answers HTTP 200 with a ZERO-BYTE body for this, not a ` +
        `404 or an empty document (live-verified). This is a genuinely empty package, not a ` +
        `truncated or failed read.`,
    );
  }
  if (headerFailure) {
    notes.push(
      `Package header could not be read (${headerFailure}). package_type, description, ` +
        `super_package, software_component, transport_layer, application_component and ` +
        `responsible are UNKNOWN here, NOT confirmed absent — the node listing below is otherwise ` +
        `unaffected.`,
    );
  }
  if (unmatchedFilters.length) {
    notes.push(
      `types filter matched zero rows for: ${unmatchedFilters.join(", ")}. This does NOT mean the ` +
        `package has none of these — it may equally mean the type code was mistyped. Compare against ` +
        `an unfiltered read of this package, or abap_search, before concluding either way.`,
    );
  }
  if (notExpanded.length) {
    notes.push(
      `Reached MAX_PACKAGE_EXPANSIONS (${MAX_PACKAGE_EXPANSIONS}) nodestructure round trips before ` +
        `depth ${depth} finished expanding every sub-package. NOT expanded: ` +
        notExpanded.map((n) => `${n} (abap_read {"object":"${n}","type":"DEVC/K"})`).join(", ") +
        `.`,
    );
  }
  if (unexpandedSubPackages.length) {
    const shown = unexpandedSubPackages.slice(0, 5);
    const remaining = unexpandedSubPackages.length - shown.length;
    notes.push(
      `${unexpandedSubPackages.length} sub-package(s) are listed but NOT expanded: ` +
        shown.map((n) => `${n} (abap_read {"object":"${n}","type":"DEVC/K"})`).join(", ") +
        (remaining > 0 ? `, and ${remaining} more` : "") +
        `. OBJECTS below has a row for each of these sub-packages themselves, not their contents — ` +
        `depth ${depth} did not reach inside them. Use a higher depth (up to ${MAX_PACKAGE_DEPTH}) to ` +
        `expand them, or read one directly: abap_read {"object":"<name>","type":"DEVC/K"}.`,
    );
  }
  if (descriptionFailures.length) {
    notes.push(
      `Description lookup failed for: ${descriptionFailures.join("; ")}. Affected rows render with ` +
        `an EMPTY description rather than a guessed or positional value — the listing itself (type, ` +
        `name, package) is otherwise unaffected, and other name-groups within the same package are ` +
        `unaffected too (each group's lookup is independent).`,
    );
  }
  if (descriptionFellBack.length) {
    notes.push(
      `Description lookup for package(s) ${descriptionFellBack.join(", ")} used a single broader ` +
        `query instead of grouping by starting character, because rendered names there spanned more ` +
        `than ${PACKAGE_DESCRIPTION_GROUP_CAP} distinct starting characters — see ` +
        `PACKAGE_DESCRIPTION_GROUP_CAP. That request's own result cap is reported separately below if ` +
        `it was hit.`,
    );
  }
  if (descriptionCapped.length) {
    notes.push(
      `Description lookup hit its per-request result cap for: ${descriptionCapped.join(", ")} — ` +
        `coverage there may be incomplete. Rows whose description could not be resolved render empty ` +
        `rather than a guess.`,
    );
  }
  if (unresolvedCount) {
    notes.push(
      `${unresolvedCount} row(s) render with an empty description because informationsystem/search ` +
        `did not return a match for that exact (type, name) — this may mean the object genuinely has ` +
        `no description, or that it fell outside the lookup's coverage; it is never filled with the ` +
        `node structure's own (positionally unreliable) DESCRIPTION value.`,
    );
  }
  notes.push(
    `A package is not a DDIC object: OBJECTS below is its node contents (expanded up to depth ` +
      `${depth}), not pseudo-DDL.`,
  );
  notes.push(
    `Open a row with abap_read {"object":"<name>","type":"<type>"}. PARENT_NAME is empty on every ` +
      `row at package level, so none of these need parenting to open. A FUGR/F row is a function ` +
      `group; one of its modules is read as abap_read {"object":"<GROUP>/<MODULE>","type":"FUGR/FF"}. ` +
      `This is naming guidance, not a claim about what shape a function group takes at package level ` +
      `— none of the committed nodestructure captures (test/fixtures/live-captured/852, 853, 855) ` +
      `contain a FUGR row of either kind, so that shape is not itself evidenced here.`,
  );

  return {
    ddl,
    sections,
    bodyLabel: "OBJECTS",
    meta: {
      package_type: header?.packageType,
      description: header?.description,
      super_package: header?.superPackage,
      software_component: header?.softwareComponent,
      transport_layer: header?.transportLayer,
      application_component: header?.applicationComponent,
      responsible: header?.responsible,
      objects: sortedRows.length,
      objects_before_filter: typeFilters.length ? allRows.length : undefined,
      sub_packages: directSubPackages.length || undefined,
      types: typeFilters.length ? typeFilters.join(", ") : undefined,
      depth,
    },
    notes,
    hashInput: ddl,
  };
}

async function readDataElement(conn: AbapConnection, obj: ResolvedObject): Promise<DdicRender> {
  const body = await fetchDdicXml(conn, obj, "read data element");
  const p = parseDataElementXml(body, obj.name);
  const view: DataElementView = {
    name: p.name || obj.name,
    description: p.description,
    typeName: p.typeName,
    dataType: p.dataType,
    length: p.dataTypeLength,
    decimals: p.dataTypeDecimals || undefined,
    labels: p.labels,
    labelLengths: p.labelLengths,
    searchHelp: p.searchHelp,
    searchHelpParameter: p.searchHelpParameter,
    packageName: p.packageName,
  };

  const domain = p.typeName ? await tryReadDomain(conn, p.typeName) : {};
  return { ...renderDataElement(view, domain.view, domain.failure), hashInput: body };
}

/** Domain lookup is best-effort, but a failure is reported, never swallowed (a bare catch once turned a 403 into "no domain"). */
async function tryReadDomain(
  conn: AbapConnection,
  name: string,
): Promise<{ view?: DomainView; failure?: string }> {
  const uri = `/sap/bc/adt/ddic/domains/${encodeURIComponent(name.toLowerCase())}`;
  try {
    const body = await fetchDdicXml(conn, { uri, name, type: "DOMA/DD" }, "read domain of data element");
    return { view: parseDomainXml(body, name) };
  } catch (e) {
    const err = e as AbapError; // fetchDdicXml always throws via classifyDdicFailure
    return { failure: `${err.code} — ${err.message}` };
  }
}

async function readDomain(conn: AbapConnection, obj: ResolvedObject): Promise<DdicRender> {
  const body = await fetchDdicXml(conn, obj, "read domain");
  return { ...renderDomain(parseDomainXml(body, obj.name)), hashInput: body };
}

async function readTableType(conn: AbapConnection, obj: ResolvedObject): Promise<DdicRender> {
  const body = await fetchDdicXml(conn, obj, "read table type");
  return renderTableType(body, obj.name);
}
