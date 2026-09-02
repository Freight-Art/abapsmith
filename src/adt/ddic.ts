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
import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import type { ResolvedObject } from "./resolve.js";
import { isNotFoundError, translateAdtError, type ErrorContext } from "./session.js";
import { textTable } from "../compact.js";

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

/** The two live-captured groups, kept as data rather than a per-type flag. */
export const DDIC_SOURCE_BASED = ["TABL", "STRU"] as const;
export const DDIC_XML_ONLY = ["DTEL", "DOMA", "TTYP"] as const;

export type DdicStrategy = "source" | "xml" | "package" | "unsupported";

/** How this kind is actually read on this release. Verified, not guessed. */
export function ddicStrategy(kind: string): DdicStrategy {
  const k = kind.toUpperCase();
  if ((DDIC_SOURCE_BASED as readonly string[]).includes(k)) return "source";
  if ((DDIC_XML_ONLY as readonly string[]).includes(k)) return "xml";
  if (k === "DEVC") return "package";
  return "unsupported";
}

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

/** Read a DDIC object and render it as pseudo-DDL. Never returns raw XML. */
export async function readDdic(conn: AbapConnection, obj: ResolvedObject): Promise<DdicRender> {
  switch (ddicStrategy(obj.kind)) {
    case "source":
      return readTableLike(conn, obj);
    case "package":
      return readPackage(conn, obj);
    case "xml":
      switch (obj.kind.toUpperCase()) {
        case "DTEL":
          return readDataElement(conn, obj);
        case "DOMA":
          return readDomain(conn, obj);
        default:
          return readTableType(conn, obj);
      }
    default:
      throw new AbapError(
        "UNSUPPORTED",
        `${obj.type} is not a DDIC type abap_read can render.`,
        { type: obj.type, renderable: [...DDIC_SOURCE_BASED, ...DDIC_XML_ONLY, "DEVC"] },
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
    return {
      ddl: body.replace(/\r\n/g, "\n").trimEnd(),
      sections: digest.sections,
      meta: digest.meta,
      notes: [],
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
    return renderTableXmlFallback(body, obj.name, sourceFailure);
  } catch (e) {
    throw classifyDdicFailure(e, ctx);
  }
}

/** Reads a package via the repository node structure endpoint (POST /repository/nodestructure?parent_type=DEVC/K). Used to be UNSUPPORTED. */
async function readPackage(conn: AbapConnection, obj: ResolvedObject): Promise<DdicRender> {
  const ctx: ErrorContext = {
    operation: "read package",
    uri: obj.uri,
    name: obj.name,
    type: obj.type,
  };
  let nodes;
  try {
    nodes = (await conn.adt.nodeContents("DEVC/K", obj.name)).nodes ?? [];
  } catch (e) {
    throw classifyDdicFailure(e, ctx);
  }

  const rows = nodes
    .filter((n) => n.OBJECT_NAME)
    .map((n) => ({
      type: n.OBJECT_TYPE ?? "",
      name: n.OBJECT_NAME ?? "",
      description: (n.DESCRIPTION ?? "").replace(/\s+/g, " ").trim(),
    }));

  const byType = new Map<string, number>();
  for (const r of rows) byType.set(r.type, (byType.get(r.type) ?? 0) + 1);
  const subPackages = rows.filter((r) => r.type.toUpperCase().startsWith("DEVC"));

  const ddl = rows.length
    ? textTable(rows, ["type", "name", "description"])
    : `-- package ${obj.name}: the ADT node structure returned no objects. This is what the ` +
      `server sent, not a rendering failure.`;

  return {
    ddl,
    sections: byType.size
      ? [
          {
            title: "OBJECTS BY TYPE",
            content: textTable(
              [...byType.entries()].sort().map(([type, count]) => ({ type, count: String(count) })),
              ["type", "count"],
            ),
          },
        ]
      : [],
    meta: { objects: rows.length, subPackages: subPackages.length || undefined },
    notes: [
      "A package is not a DDIC object: this is its direct node contents, not pseudo-DDL.",
      ...(subPackages.length
        ? [
            `${subPackages.length} sub-package(s) are listed but NOT expanded — their contents ` +
              `are not included here. Read each sub-package to see them.`,
          ]
        : []),
    ],
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
