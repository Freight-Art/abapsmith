/**
 * RAP stack generation (issue #197): pure, no I/O. Turns a table's fields
 * into a full CDS/BDEF/class/SRVD/SRVB artifact list plus a field-coverage
 * summary. `src/tools/rap.ts` supplies the table read and does the writing.
 */
import { AbapError } from "./errors.js";
import type { DdlField } from "./ddic.js";
import { textTable } from "../compact.js";

export interface RapNameOverrides {
  root_view?: string;
  projection_view?: string;
  behaviour_class?: string;
  service_definition?: string;
  service_binding?: string;
  draft_table?: string;
  root_sql_view?: string;
  projection_sql_view?: string;
}

export interface RapNames {
  ns: string;
  stem: string;
  rootView: string;
  projectionView: string;
  behaviourClass: string;
  serviceDefinition: string;
  serviceBinding: string;
  draftTable: string;
  rootSqlView: string;
  projectionSqlView: string;
  alias: string;
}

export interface DeriveRapNamesOptions {
  names?: RapNameOverrides;
  bindingType: "V2" | "V4";
}

export type RapArtifactKey =
  | "draft_table"
  | "root_view"
  | "root_behaviour"
  | "projection_view"
  | "projection_behaviour"
  | "behaviour_class"
  | "behaviour_class_local"
  | "service_definition"
  | "service_binding";

export interface RapArtifact {
  key: RapArtifactKey;
  name: string;
  type: string;
  source: string;
  include?: "implementations";
  description: string;
}

export interface RapFieldSummary {
  name: string;
  type: string;
  key: boolean;
  role: "client" | "key" | "etag" | "data";
  cdsAlias?: string;
  inView: boolean;
  inMapping: boolean;
}

export interface RapSummary {
  fields: RapFieldSummary[];
  timestampField?: string;
  notes: string[];
  allFieldsCovered: boolean;
  bindingType: "V2" | "V4";
}

export interface RapStack {
  artifacts: RapArtifact[];
  summary: RapSummary;
}

export interface RapSpec {
  table: string;
  package: string;
  names: RapNames;
  alias: string;
  fields: DdlField[];
  flavour: "managed" | "unmanaged";
  draft: boolean;
  bindingType: "V2" | "V4";
  includeProjection: boolean;
  cdsForm: "entity" | "classic";
}

const PREFIX_RE = /^(\/[A-Z0-9_]+\/|[ZY])([A-Z0-9_]+)$/i;
const REQUIRED_OVERRIDES: (keyof RapNameOverrides)[] = [
  "root_view",
  "projection_view",
  "behaviour_class",
  "service_definition",
  "service_binding",
];

function camelCase(stem: string): string {
  return stem
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("");
}

/** Derives every RAP artifact name from a customer-namespace prefix, honoring `names` overrides. */
export function deriveRapNames(prefix: string | undefined, opts: DeriveRapNamesOptions): RapNames {
  const overrides = opts.names ?? {};
  let ns = "";
  let stem = "";

  if (!prefix || !prefix.trim()) {
    const missing = REQUIRED_OVERRIDES.filter((k) => !overrides[k]);
    if (missing.length > 0) {
      throw new AbapError(
        "BAD_INPUT",
        "name_prefix is required unless `names` supplies every derived name.",
        { missing },
        `Supply name_prefix (e.g. "ZAS_BK197"), or all of: ${REQUIRED_OVERRIDES.join(", ")} in \`names\`.`,
      );
    }
  } else {
    const m = PREFIX_RE.exec(prefix.trim());
    if (!m) {
      throw new AbapError(
        "BAD_INPUT",
        `name_prefix "${prefix}" is not a customer-namespace prefix (Z/Y or /NS/ plus a stem).`,
        { name_prefix: prefix },
        `Pass a prefix like "ZAS_BK197" or "/NS/BK197", or supply every name explicitly via \`names\`.`,
      );
    }
    ns = m[1]!.toUpperCase();
    stem = m[2]!.toUpperCase();
  }

  const rootView = overrides.root_view ? overrides.root_view.toUpperCase() : `${ns}I_${stem}`;
  const projectionView = overrides.projection_view ? overrides.projection_view.toUpperCase() : `${ns}C_${stem}`;
  const behaviourClass = overrides.behaviour_class ? overrides.behaviour_class.toUpperCase() : `${ns}BP_${stem}`;
  const serviceDefinition = overrides.service_definition
    ? overrides.service_definition.toUpperCase()
    : `${ns}UI_${stem}`;

  const bindingSuffix = opts.bindingType === "V2" ? "_O2" : "_O4";
  const serviceBinding = overrides.service_binding
    ? overrides.service_binding.toUpperCase()
    : `${ns}UI_${stem}${bindingSuffix}`;
  if (!overrides.service_binding && serviceBinding.length > 26) {
    throw new AbapError(
      "BAD_INPUT",
      `derived service binding name "${serviceBinding}" exceeds 26 characters.`,
      { serviceBinding, length: serviceBinding.length },
      "Pass a shorter name via names.service_binding.",
    );
  }

  const draftTable = overrides.draft_table ? overrides.draft_table.toUpperCase() : `${ns}${stem}_D`;
  if (!overrides.draft_table && draftTable.length > 16) {
    throw new AbapError(
      "BAD_INPUT",
      `derived draft table name "${draftTable}" exceeds 16 characters.`,
      { draftTable, length: draftTable.length },
      "Pass a shorter name via names.draft_table.",
    );
  }

  const rootSqlView = overrides.root_sql_view
    ? overrides.root_sql_view.toUpperCase()
    : `${ns}I${stem}`.slice(0, 16);
  const projectionSqlView = overrides.projection_sql_view
    ? overrides.projection_sql_view.toUpperCase()
    : `${ns}C${stem}`.slice(0, 16);

  const alias = camelCase(stem);

  return {
    ns,
    stem,
    rootView,
    projectionView,
    behaviourClass,
    serviceDefinition,
    serviceBinding,
    draftTable,
    rootSqlView,
    projectionSqlView,
    alias,
  };
}

interface WorkingField {
  raw: DdlField;
  nameLower: string;
  alias: string;
  isClient: boolean;
  isKey: boolean;
  isTimestamp: boolean;
}

function isClientField(f: DdlField): boolean {
  const t = f.type.toLowerCase();
  const n = f.name.toUpperCase();
  return t === "abap.clnt" || t === "mandt" || n === "MANDT" || n === "CLIENT";
}

function looksLikeTimestamp(f: DdlField): boolean {
  const n = f.name.toUpperCase();
  const t = f.type.toLowerCase();
  if (/LAST_CHANGED_AT|LASTCHANGE|CHANGED_AT$/.test(n)) return true;
  if ((t === "timestampl" || t === "abp_lastchange_tstmpl") && n.includes("CHANG")) return true;
  return false;
}

function classify(fields: DdlField[]): WorkingField[] {
  return fields.map((f) => {
    const client = isClientField(f);
    return {
      raw: f,
      nameLower: f.name.toLowerCase(),
      alias: camelCase(f.name),
      isClient: client,
      isKey: f.key && !client,
      isTimestamp: looksLikeTimestamp(f),
    };
  });
}

function escapeXmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildDraftTable(spec: RapSpec): RapArtifact {
  const lines = spec.fields.map((f) => {
    const keyword = f.key ? "key " : "";
    const notNull = f.notNull ? " not null" : "";
    return `  ${keyword}${f.name.toLowerCase()} : ${f.type}${notNull};`;
  });
  const source = [
    `@EndUserText.label : 'Draft table for ${spec.names.rootView}'`,
    `@AbapCatalog.tableCategory : #TRANSPARENT`,
    `@AbapCatalog.deliveryClass : #A`,
    `@AbapCatalog.dataMaintenance : #RESTRICTED`,
    `define table ${spec.names.draftTable.toLowerCase()} {`,
    ...lines,
    `  include sych_bdl_draft_admin_inc;`,
    `}`,
  ].join("\n");
  return {
    key: "draft_table",
    name: spec.names.draftTable,
    type: "TABL/DT",
    source,
    description: `Draft table for ${spec.names.rootView}`,
  };
}

function buildRootView(spec: RapSpec, nonClient: WorkingField[], keyFields: WorkingField[]): RapArtifact {
  const tableLower = spec.table.toLowerCase();
  const fieldLines = nonClient.map((f) => {
    const prefix = keyFields.includes(f) ? "key " : "";
    return `  ${prefix}${f.nameLower} as ${f.alias}`;
  });
  const header = [`@AccessControl.authorizationCheck: #CHECK`, `@EndUserText.label: '${spec.names.rootView}'`];
  let defineBlock: string[];
  if (spec.cdsForm === "entity") {
    defineBlock = [`define root view entity ${spec.names.rootView}`, `  as select from ${tableLower}`];
  } else {
    header.push(`@AbapCatalog.sqlViewName: '${spec.names.rootSqlView}'`);
    header.push(`@AbapCatalog.compiler.compareFilter: true`);
    header.push(`@AbapCatalog.preserveKey: true`);
    defineBlock = [`define root view ${spec.names.rootView}`, `  as select from ${tableLower}`];
  }
  const source = [...header, ...defineBlock, `{`, fieldLines.join(",\n"), `}`].join("\n");
  return {
    key: "root_view",
    name: spec.names.rootView,
    type: "DDLS/DF",
    source,
    description: `Root CDS view for ${spec.table}`,
  };
}

function buildProjectionView(spec: RapSpec, nonClient: WorkingField[], keyFields: WorkingField[]): RapArtifact {
  const fieldLines = nonClient.map((f) => {
    const prefix = keyFields.includes(f) ? "key " : "";
    return `  ${prefix}${f.alias}`;
  });
  const header = [`@AccessControl.authorizationCheck: #CHECK`, `@EndUserText.label: '${spec.names.projectionView}'`];
  let defineBlock: string[];
  if (spec.cdsForm === "entity") {
    defineBlock = [
      `define root view entity ${spec.names.projectionView}`,
      `  provider contract transactional_query`,
      `  as projection on ${spec.names.rootView}`,
    ];
  } else {
    header.push(`@AbapCatalog.sqlViewName: '${spec.names.projectionSqlView}'`);
    defineBlock = [`define root view ${spec.names.projectionView}`, `  as projection on ${spec.names.rootView}`];
  }
  const source = [...header, ...defineBlock, `{`, fieldLines.join(",\n"), `}`].join("\n");
  return {
    key: "projection_view",
    name: spec.names.projectionView,
    type: "DDLS/DF",
    source,
    description: `Projection CDS view for ${spec.names.rootView}`,
  };
}

function buildRootBehaviour(
  spec: RapSpec,
  nonClient: WorkingField[],
  keyFields: WorkingField[],
  timestamp: WorkingField | undefined,
): RapArtifact {
  const tableLower = spec.table.toLowerCase();
  const cls = spec.names.behaviourClass.toLowerCase();
  const kind = spec.flavour === "managed" ? "managed" : "unmanaged";
  const managed = spec.flavour === "managed";
  const lines: string[] = [];
  lines.push(`${kind} implementation in class ${cls} unique;`);
  lines.push(`strict ( 2 );`);
  if (spec.draft) lines.push(`with draft;`);
  lines.push(``);
  lines.push(`define behavior for ${spec.names.rootView} alias ${spec.alias}`);
  if (managed) lines.push(`persistent table ${tableLower}`);
  if (spec.draft) lines.push(`draft table ${spec.names.draftTable.toLowerCase()}`);
  if (spec.draft && timestamp) {
    lines.push(`lock master total etag ${timestamp.alias}`);
  } else {
    lines.push(`lock master`);
  }
  if (managed) lines.push(`authorization master ( instance )`);
  if (timestamp) lines.push(`etag master ${timestamp.alias}`);
  lines.push(`{`);
  for (const f of keyFields) lines.push(`  field ( readonly ) ${f.alias};`);
  if (timestamp && !keyFields.includes(timestamp)) lines.push(`  field ( readonly ) ${timestamp.alias};`);
  lines.push(`  create;`);
  lines.push(`  update;`);
  lines.push(`  delete;`);
  if (spec.draft) {
    lines.push(`  draft action Edit;`);
    lines.push(`  draft action Activate;`);
    lines.push(`  draft action Discard;`);
    lines.push(`  draft action Resume;`);
    lines.push(`  draft determine action Prepare;`);
  }
  lines.push(``);
  lines.push(`  mapping for ${tableLower}`);
  lines.push(`  {`);
  for (const f of nonClient) lines.push(`    ${f.alias} = ${f.nameLower};`);
  lines.push(`  }`);
  lines.push(`}`);
  return {
    key: "root_behaviour",
    name: spec.names.rootView,
    type: "BDEF/BDO",
    source: lines.join("\n"),
    description: `Root behavior definition for ${spec.names.rootView}`,
  };
}

function buildProjectionBehaviour(spec: RapSpec): RapArtifact {
  const lines: string[] = [];
  lines.push(`projection;`);
  lines.push(`strict ( 2 );`);
  if (spec.draft) lines.push(`use draft;`);
  lines.push(``);
  lines.push(`define behavior for ${spec.names.projectionView} alias ${spec.alias}`);
  lines.push(`use etag`);
  lines.push(`{`);
  lines.push(`  use create;`);
  lines.push(`  use update;`);
  lines.push(`  use delete;`);
  if (spec.draft) {
    lines.push(`  use action Edit;`);
    lines.push(`  use action Activate;`);
    lines.push(`  use action Discard;`);
    lines.push(`  use action Resume;`);
    lines.push(`  use action Prepare;`);
  }
  lines.push(`}`);
  return {
    key: "projection_behaviour",
    name: spec.names.projectionView,
    type: "BDEF/BDO",
    source: lines.join("\n"),
    description: `Projection behavior definition for ${spec.names.projectionView}`,
  };
}

function buildBehaviourClassMain(spec: RapSpec): RapArtifact {
  const cls = spec.names.behaviourClass;
  const source = [
    `CLASS ${cls} DEFINITION PUBLIC ABSTRACT FINAL FOR BEHAVIOR OF ${spec.names.rootView}.`,
    `ENDCLASS.`,
    ``,
    `CLASS ${cls} IMPLEMENTATION.`,
    `ENDCLASS.`,
  ].join("\n");
  return {
    key: "behaviour_class",
    name: cls,
    type: "CLAS/OC",
    source,
    description: `Behavior implementation class for ${spec.names.rootView}`,
  };
}

function buildBehaviourClassLocal(spec: RapSpec): RapArtifact {
  const view = spec.names.rootView;
  const lhc = `lhc_${spec.alias.toLowerCase()}`;
  let source: string;
  if (spec.flavour === "managed") {
    source = [
      `CLASS ${lhc} DEFINITION INHERITING FROM cl_abap_behavior_handler.`,
      `  PRIVATE SECTION.`,
      `    METHODS get_instance_authorizations FOR INSTANCE AUTHORIZATION`,
      `      IMPORTING keys REQUEST requested_authorizations FOR ${spec.alias} RESULT result.`,
      `ENDCLASS.`,
      ``,
      `CLASS ${lhc} IMPLEMENTATION.`,
      `  METHOD get_instance_authorizations.`,
      `  ENDMETHOD.`,
      `ENDCLASS.`,
    ].join("\n");
  } else {
    const lsc = `lsc_${spec.alias.toLowerCase()}`;
    source = [
      `CLASS ${lhc} DEFINITION INHERITING FROM cl_abap_behavior_handler.`,
      `  PRIVATE SECTION.`,
      `    METHODS create FOR MODIFY`,
      `      IMPORTING entities FOR CREATE ${spec.alias}.`,
      `    METHODS update FOR MODIFY`,
      `      IMPORTING entities FOR UPDATE ${spec.alias}.`,
      `    METHODS delete FOR MODIFY`,
      `      IMPORTING keys FOR DELETE ${spec.alias}.`,
      `    METHODS read FOR READ`,
      `      IMPORTING keys FOR READ ${spec.alias} RESULT result.`,
      `    METHODS lock FOR LOCK`,
      `      IMPORTING keys FOR LOCK ${spec.alias}.`,
      `ENDCLASS.`,
      ``,
      `CLASS ${lhc} IMPLEMENTATION.`,
      `  METHOD create.`,
      `  ENDMETHOD.`,
      `  METHOD update.`,
      `  ENDMETHOD.`,
      `  METHOD delete.`,
      `  ENDMETHOD.`,
      `  METHOD read.`,
      `  ENDMETHOD.`,
      `  METHOD lock.`,
      `  ENDMETHOD.`,
      `ENDCLASS.`,
      ``,
      `CLASS ${lsc} DEFINITION INHERITING FROM cl_abap_behavior_saver.`,
      `  PROTECTED SECTION.`,
      `    METHODS finalize REDEFINITION.`,
      `    METHODS check_before_save REDEFINITION.`,
      `    METHODS save REDEFINITION.`,
      `    METHODS cleanup REDEFINITION.`,
      `    METHODS cleanup_finalize REDEFINITION.`,
      `ENDCLASS.`,
      ``,
      `CLASS ${lsc} IMPLEMENTATION.`,
      `  METHOD finalize.`,
      `  ENDMETHOD.`,
      `  METHOD check_before_save.`,
      `  ENDMETHOD.`,
      `  METHOD save.`,
      `  ENDMETHOD.`,
      `  METHOD cleanup.`,
      `  ENDMETHOD.`,
      `  METHOD cleanup_finalize.`,
      `  ENDMETHOD.`,
      `ENDCLASS.`,
    ].join("\n");
  }
  return {
    key: "behaviour_class_local",
    name: spec.names.behaviourClass,
    type: "CLAS/OC",
    include: "implementations",
    source,
    description: `Local handler${spec.flavour === "unmanaged" ? "/saver" : ""} implementation for ${view}`,
  };
}

function buildServiceDefinition(spec: RapSpec): RapArtifact {
  const target = spec.includeProjection ? spec.names.projectionView : spec.names.rootView;
  const source = [
    `@EndUserText.label: 'Service definition for ${target}'`,
    `define service ${spec.names.serviceDefinition} {`,
    `  expose ${target} as ${spec.alias};`,
    `}`,
  ].join("\n");
  return {
    key: "service_definition",
    name: spec.names.serviceDefinition,
    type: "SRVD/SRV",
    source,
    description: `Service definition exposing ${target}`,
  };
}

function buildServiceBinding(spec: RapSpec): RapArtifact {
  const name = spec.names.serviceBinding;
  const srvd = spec.names.serviceDefinition;
  const version = spec.bindingType;
  const n = escapeXmlAttr(name);
  const d = escapeXmlAttr(srvd);
  const p = escapeXmlAttr(spec.package);
  const source =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<srvb:serviceBinding xmlns:srvb="http://www.sap.com/adt/ddic/ServiceBindings" xmlns:adtcore="http://www.sap.com/adt/core" ` +
    `adtcore:name="${n}" adtcore:type="SRVB/SVB" adtcore:description="Service binding for ${d}" adtcore:masterLanguage="EN">` +
    `<adtcore:packageRef adtcore:name="${p}"/>` +
    `<srvb:services srvb:name="${n}">` +
    `<srvb:content srvb:version="0001">` +
    `<srvb:serviceDefinition adtcore:type="SRVD/SRV" adtcore:name="${d}"/>` +
    `</srvb:content>` +
    `</srvb:services>` +
    `<srvb:binding srvb:type="ODATA" srvb:version="${version}" srvb:category="0">` +
    `<srvb:implementation adtcore:name="${n}"/>` +
    `</srvb:binding>` +
    `</srvb:serviceBinding>`;
  return {
    key: "service_binding",
    name,
    type: "SRVB/SVB",
    source,
    description: `Service binding (OData ${version}) for ${srvd}`,
  };
}

/** Builds the full ordered artifact list plus a field-coverage summary. No I/O. */
export function generateRapStack(spec: RapSpec): RapStack {
  const wf = classify(spec.fields);
  const nonClient = wf.filter((f) => !f.isClient);
  const keyFields = nonClient.filter((f) => f.isKey);
  const timestamp = nonClient.find((f) => f.isTimestamp);

  const notes: string[] = [];
  if (wf.some((f) => f.isClient)) notes.push("client field, handled implicitly");
  if (!timestamp) notes.push("no last-changed timestamp field found; no etag master line was generated");
  if (spec.draft && !timestamp) {
    notes.push("draft requires a total etag field; none was found — add one before activating");
  }
  if (spec.draft && spec.flavour === "unmanaged") {
    notes.push("unmanaged + draft: saver/handler must implement draft persistence");
  }

  const artifacts: RapArtifact[] = [];
  if (spec.draft) artifacts.push(buildDraftTable(spec));
  artifacts.push(buildRootView(spec, nonClient, keyFields));
  artifacts.push(buildRootBehaviour(spec, nonClient, keyFields, timestamp));
  if (spec.includeProjection) {
    artifacts.push(buildProjectionView(spec, nonClient, keyFields));
    artifacts.push(buildProjectionBehaviour(spec));
  }
  artifacts.push(buildBehaviourClassMain(spec));
  artifacts.push(buildBehaviourClassLocal(spec));
  artifacts.push(buildServiceDefinition(spec));
  artifacts.push(buildServiceBinding(spec));

  const fields: RapFieldSummary[] = wf.map((f) => {
    const role: RapFieldSummary["role"] = f.isClient ? "client" : f.isTimestamp ? "etag" : f.isKey ? "key" : "data";
    const inView = !f.isClient;
    const inMapping = !f.isClient;
    return {
      name: f.raw.name,
      type: f.raw.type,
      key: f.raw.key,
      role,
      cdsAlias: f.isClient ? undefined : f.alias,
      inView,
      inMapping,
    };
  });
  const allFieldsCovered = fields.every((f) => f.role === "client" || (f.inView && f.inMapping));

  const summary: RapSummary = {
    fields,
    timestampField: timestamp?.alias,
    notes,
    allFieldsCovered,
    bindingType: spec.bindingType,
  };

  return { artifacts, summary };
}

/** Renders the field-coverage summary as text for `dry_run`'s "consistency" section. */
export function renderRapSummary(summary: RapSummary): string {
  const rows = summary.fields.map((f) => ({
    name: f.name,
    type: f.type,
    role: f.role,
    cds_alias: f.cdsAlias ?? "",
    in_view: f.inView ? "yes" : "no",
    in_mapping: f.inMapping ? "yes" : "no",
  }));
  const parts = [textTable(rows, ["name", "type", "role", "cds_alias", "in_view", "in_mapping"])];
  parts.push(`all_fields_covered: ${summary.allFieldsCovered ? "yes" : "no"}`);
  if (summary.timestampField) parts.push(`etag field: ${summary.timestampField}`);
  for (const n of summary.notes) parts.push(`note: ${n}`);
  return parts.join("\n\n");
}
