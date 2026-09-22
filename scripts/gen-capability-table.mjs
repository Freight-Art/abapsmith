#!/usr/bin/env node
/**
 * gen-capability-table.mjs — emit the writable-type table that
 * `abapsmith-create-an-object/writable-types.md` carries.
 *
 * The table is GENERATED, never hand-written. A hand-maintained copy of
 * `src/adt/capabilities.ts` is what produced three wrong skills (a promised
 * ENQU/DL delete that the registry actually refuses, a "13 writable types"
 * figure that missed the entire RAP stack). Reading the registry at build time
 * removes that whole defect class.
 *
 *   node scripts/gen-capability-table.mjs            # print the table
 *   node scripts/gen-capability-table.mjs --check    # exit 1 if the skill is stale
 *
 * --check is the CI guard: it regenerates the table and diffs it against the
 * block currently between the BEGIN/END markers in the skill file.
 *
 * `buildCapabilityTable` takes REGISTRY as a parameter rather than loading it
 * itself — the CLI supplies it from `dist/adt/capabilities.js`
 * (this file is plain Node, and the source is TypeScript), while tests supply
 * it straight from the TypeScript source, so the census can never silently
 * report on a stale or absent `dist/`.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const BEGIN = "<!-- BEGIN generated: scripts/gen-capability-table.mjs -->";
const END = "<!-- END generated -->";

// This defaulted to `skills-v2/abapsmith-orient/SKILL.md`, a path
// that has never existed in this repo — `--check` therefore exited 1 with
// "does not exist" for anyone who ran it without `--skill=`, so the table
// silently went stale (indexes were missing from every bucket). The table
// now ships in `skills/abapsmith-create-an-object/writable-types.md`,
// moved out of `abapsmith-orient/SKILL.md` (issue #158) to keep the router
// skill small.
const skillPath =
  process.argv.find((a) => a.startsWith("--skill="))?.slice("--skill=".length) ??
  resolve(REPO_ROOT, "skills/abapsmith-create-an-object/writable-types.md");

// Create sites for types with NO `create` field in `REGISTRY`:
// a REGISTRY-only read misfiles them as unreachable by any write, which is
// false and harmful. See the bypass note in src/adt/capabilities.ts
// (~lines 52-57). `BOBF` is deliberately absent — not a `TypeCode`, no
// REGISTRY entry, can't appear in this table.
export const OUT_OF_REGISTRY_CREATE = {
  "ENHS/XS": "src/adt/enhancement-bridge.ts — createEnhancementSpot",
  "ENHO/XH": "src/adt/enhancement-bridge.ts — createBadiImplementation",
  "ENHO/XHH": "src/adt/enhancement-hook.ts — createHookImplementation (PROG/P host only)",
};

// Bridge-only-create types (bridgeCreate set, no create) that are readable
// anyway, through a plain-text catalog SELECT (src/adt/catalog-query.ts +
// catalog-read.ts) rather than the ADT REST collection the bridge exists to
// go around. Duplicates the exclusion NON_READABLE_TYPES applies in
// src/adt/capabilities.ts — see the `nonReadable` field below for why this
// script can't just import that logic.
const CATALOG_READABLE_BRIDGE_ONLY_TYPES = new Set(["SHLP/DH", "VIEW/DV", "TRAN/T"]);

// Per-type gloss for the bridge bucket, grounded in each type's
// `bridgeCreate` entry in src/adt/capabilities.ts.
const BRIDGE_NOTE = {
  "SHLP/DH":
    "builds an elementary (one interface) or collective (DD31S includes of other search " +
    "helps) search help via RS_CORR_INSERT then DDIF_SHLP_PUT then DDIF_SHLP_ACTIVATE; an " +
    "elementary help needs at least one import AND one export interface field, checked " +
    "zero-network before dispatch. `update_search_help` REPLACES the whole definition — any " +
    "field, include or assignment not passed again is removed. There is no ADT REST read or " +
    "write route for a search help at all (every mutating verb 404s), but " +
    "src/adt/catalog-read.ts reads one back through plain-text DD30L/DD30T/DD32S/DD31S/DD33S " +
    "catalog SELECTs, so success is not proven by transcript markers alone. Proven live on " +
    "A4H 2026-09-12, $TMP only: DDIF_SHLP_PUT + DDIF_SHLP_ACTIVATE returned DH107, and a " +
    "catalog read-back matched what was put. A transportable package requires corr_nr; a `$` " +
    "package refuses one and registers with korrnum = space — same pairing rule as VIEW/DV " +
    "and TRAN/T. The transportable path has NOT itself been run live.",
  "VIEW/DV":
    "builds a single-table database view (DD25V class 'D') via RS_CORR_INSERT then " +
    "DDIF_VIEW_PUT then DDIF_VIEW_ACTIVATE; no joins, no SE54 maintenance dialog. A " +
    "transportable package resolves a transport request the same way a DEVC/K create does — " +
    "the caller's corr_nr, or else one picked or created under ABAP_ALLOW_TRANSPORTS; a `$` " +
    "package refuses a corr_nr and registers with korrnum = space instead. There is no ADT " +
    "REST read route (405 on every mutating verb, empty discovery collection), but " +
    "src/adt/catalog-read.ts reads DD25L/DD25T/DD26S/DD27S/TVDIR back through plain-text " +
    "catalog SELECTs, so success is not proven by transcript markers alone. Proven live on A4H: 2026-09-04 " +
    "into a transportable package with a corr_nr; 2026-09-05, RS_CORR_INSERT registered one " +
    "in a `$` package with korrnum = space (sy-subrc 0, TADIR row), then removed by the " +
    "delete bridge. Changing an EXISTING view is also supported now (`update_view`, " +
    "DDIF_VIEW_PUT again — REPLACES the whole definition, so an omitted field is dropped), " +
    "proven live 2026-09-12 (message D0322, field count 2 to 3).",
  "TRAN/T":
    "creates a REPORT transaction (dynpro 1000) starting an existing program, via " +
    "RPY_TRANSACTION_INSERT. Retargeting an EXISTING transaction to a different program is " +
    "also supported now (`update_transaction`: RPY_TRANSACTION_DELETE then re-INSERT under " +
    "one RS_CORR_INSERT registration, refused unless confirm_in_role_menu is passed when the " +
    "tcode is already in a role menu; an SM01 lock is NOT checked either way, by design), " +
    "proven live 2026-09-12 (message EU075, program confirmed changed on read-back). A " +
    "transportable package requires corr_nr; a `$` package refuses one and registers with " +
    "korrnum = space instead. RPY_TRANSACTION_INSERT's signature was read live on A4H " +
    "2026-09-05: transport_number is optional and forwarded verbatim to RS_CORR_INSERT as " +
    "korrnum, and suppress_corr_insert defaults to space so the registration always runs. No " +
    "live create into a transportable package has been run.",
  "TABL/DI":
    "creates a secondary index on an existing table via DD_INDEX_INTERFACE (ACTION='I'); there " +
    "is no ADT-readable index route at all, so success is proven only by re-reading DD12V/DD17S " +
    "after COMMIT WORK. The package is the base table's, not the caller's; a transportable " +
    "package requires corr_nr, a `$` package sets NO_TRANSP_REQUEST='X' and refuses one, the " +
    "same rule VIEW/DV uses. Change is not supported either. Proven live on A4H 2026-09-05: a " +
    "non-unique single-field index created in `$TMP`, confirmed by a post-commit DD12V/DD17S " +
    "re-read. The client-field requirement for a unique index on a client-dependent table, " +
    "once suspected, is now CONFIRMED live (A4H, 2026-09-05): the generated DD03L guard " +
    "refuses an omitting create with BAD_INPUT before the FM runs, and an including create " +
    "succeeds with all three markers. A third live round re-ran both creates the same day " +
    "and got all three markers again for each — the round-3 delete-path defect below never " +
    "touched create.",
  "DEVC/K":
    "`software_component: \"LOCAL\"` goes over ADT REST; anything else needs the bridge and a " +
    "transport request. Delete works only on an EMPTY package — no sub-packages, no TADIR objects.",
};

// The trailing "Delete: ..." clause for a bridgeDelete type comes only from
// here, grounded in that type's bridgeDelete.limits — a type with no entry
// is a build error (see the throw below), not an inherited guarantee.
const BRIDGE_DELETE_NOTE = {
  "SHLP/DH":
    "DD_OBJ_DEL (del_state 'A' then 'N') clears DD30L, then TR_TADIR_INTERFACE clears the " +
    "TADIR row — the same two-call pattern VIEW/DV's delete uses, with the same open-" +
    "transport-request-lock caveat (TR_TADIR_INTERFACE's TADIR delete fails under a lock " +
    "this path does not clear). Guarded by a where-used check the other two bridge deletes " +
    "do not have: attached to a data element (DD04L), a table/view field (DD35L), or " +
    "included by a collective search help (DD31S) refuses the delete unless the caller " +
    "passes confirm_in_use — all three checked live on A4H 2026-09-12. No corr_nr is " +
    "accepted. Proven live on A4H 2026-09-12, $TMP only: DD_OBJ_DEL returned DH051, " +
    "TR_TADIR_INTERFACE removed the TADIR row, and a post-delete re-read proved absence " +
    "(SHLP-DELETED / SHLP-GONE).",
  "VIEW/DV":
    "abapsmith's own create registers every view in TADIR, so the delete bridge " +
    "(src/adt/view-delete.ts) always has one to act on. Proven live on A4H 2026-09-05: a " +
    "bridge-created view in a `$`-prefixed package was removed cleanly, VIEW-DELETED / " +
    "VIEW-GONE.",
  "TRAN/T":
    "the bridge calls RPY_TRANSACTION_DELETE, whose parameter set was captured live on A4H " +
    "2026-09-12 (IN TRANSACTION TSTC-TCODE required, TRANSPORT_NUMBER, " +
    "SUPPRESS_AUTHORITY_CHECK, SUPPRESS_CORR_INSERT, SUPPRESS_CORR_CHECK; exceptions " +
    "NOT_EXCECUTED — SAP's own misspelling — and OBJECT_NOT_FOUND) — not inferred from " +
    "RPY_TRANSACTION_INSERT's `transaction` parameter name, as this entry previously read. " +
    "Guarded by the same where-used check as retargeting: a tcode already assigned to one or " +
    "more roles' menus (AGR_TCODES) refuses the delete unless the caller passes " +
    "confirm_in_role_menu; an SM01 transaction lock is NOT checked either way. Live-verified " +
    "once, 2026-09-05: TRAN-DELETED / TRAN-GONE with a post-delete re-read proving absence. " +
    "Whether RPY_TRANSACTION_DELETE itself calls RS_CORR_INSERT (the way RPY_TRANSACTION_" +
    "INSERT does) is still unknown, so deleting a transaction out of a TRANSPORTABLE package " +
    "may plausibly hit a headless-dynpro failure; no transport handling is attempted here " +
    "either way.",
  "DEVC/K":
    "runs over the same bridge (src/adt/package-delete.ts) the create uses, gated by the same " +
    "empty-package limit noted above; the create's journal entry no longer marks itself " +
    "irreversible; but IF_PACKAGE~DELETE's failure behaviour is not itself live-verified.",
  "TABL/DI":
    "deletes any index it finds in DD12V for the given table by name, not only ones the bridge " +
    "itself created — no provenance check exists. Unlike the VIEW/DV/TRAN/T deletes, this " +
    "DELETE takes the same transport pair as create — DD_INDEX_INTERFACE ACTION='D' needs it " +
    "too. The DD12V pre-check is proven live (2026-09-05: NOT_FOUND for a nonexistent index). " +
    "The missing mandatory INDEX_FIELDS table parameter is fixed and confirmed deployed live " +
    "(2026-09-05). A second defect surfaced live: ACTION='D' reports ACTFAILED='X' even when " +
    "the delete already took effect. The round-2 fix for that — commit regardless, then " +
    "re-verify via a post-commit DD12V/DD17S re-read — never ran: its own added note line " +
    "rendered as a 272-character ABAP source line (292 at the longest legal names), over the " +
    "255-character class-source limit, so every delete failed the class-source PUT " +
    "(ADT_ERROR / TooLongLine, SEDI_ADT15) before DD_INDEX_INTERFACE was ever called, and the " +
    "deployed bridge class silently stayed on its pre-fix body. Fixed again: the fragment's long " +
    "messages are now built up in a variable across short lines, and every generated bridge " +
    "class body is now rejected before it is written if any line exceeds 255 characters. " +
    "Round 4 then ran live (A4H 2026-09-05, $TMP): a non-unique and a unique index were each " +
    "deleted through the redeployed bridge (INDEX-DELETED-ACTFAILED / INDEX-DELETED / " +
    "INDEX-GONE), a re-delete returned NOT_FOUND, and the deployed class body read back with " +
    "no line over 255 — delete is live-proven. ACTFAILED is no longer surfaced to the caller " +
    "at all, for either create or delete: the response instead carries a definitive `verified` " +
    "boolean plus `index_present`/`index_active` from a fresh post-write DD12V/DD17S re-read " +
    "(src/adt/index-read.ts's verifySecondaryIndex), and a re-read that itself fails to run is " +
    "reported as not verified, with a reason, never inferred from ACTFAILED. A base-table " +
    "delete is not blocked by an index still on it (round 1); abap_write's TABL/DT delete now " +
    "reads the table's indexes immediately before deleting it and reports what it found, so the " +
    "cascade-or-orphan question is answered from that pre-delete state rather than left to an " +
    "unfiltered abap_data_preview check. The index is also independently readable at any time: " +
    'abap_read {"object":"<TABLE>/<INDEX>","type":"TABL/DI"} renders it from the same two ' +
    "catalog tables.",
};

/** Buckets every type in the given REGISTRY and renders the generated block. Exported so tests can inspect the bucketing directly instead of re-deriving it from REGISTRY by hand. */
export async function buildCapabilityTable(registry) {
  if (!registry || typeof registry !== "object") {
    throw new Error(
      "buildCapabilityTable(registry): a REGISTRY object is required — pass " +
        "src/adt/capabilities.ts's REGISTRY (tests) or loadRegistryFromDist() (CLI).",
    );
  }

  const rows = Object.entries(registry).map(([type, cap]) => {
    const createV = cap.create?.verified;
    // Tri-state: only `true` permits a create. `false` (disproven) and
    // "unverified" both refuse, so both must read as "no" to a caller.
    const create = createV === true ? "yes" : createV === false ? "no (disproven)" : cap.create ? "no (unverified)" : "—";
    const write = cap.write?.shape ?? "—";
    // `delete` is a bare tri-state (`true` | "unverified" | absent), NOT an
    // object like `create`. Only `true` permits a delete; "unverified" refuses.
    const del = cap.delete === true ? "yes" : cap.delete ? "no (unverified)" : "no";
    return {
      type,
      create,
      write,
      del,
      bridge: Boolean(cap.bridgeCreate),
      // The bridge exists but abapsmith refuses to run it — the bucket
      // heading below would otherwise promise a create that never happens.
      bridgeRefused: Boolean(cap.bridgeCreate?.createRefused),
      bridgeDel: Boolean(cap.bridgeDelete),
      outOfRegistry: type in OUT_OF_REGISTRY_CREATE,
      // Mirrors NON_READABLE_TYPES's predicate in src/adt/capabilities.ts:
      // `unsupported`, plus a bridge-only create (bridgeCreate set, no create)
      // MINUS two independent exemptions, exactly as NON_READABLE_TYPES
      // applies them:
      //   * a `catalogRead` type has no ADT resource either, but abap_read
      //     dispatches it to a catalog-TABLE render before resolveObject ever
      //     runs, so it does not belong in this bucket (SUSO/B, TABL/DI);
      //   * the three bridge-only types with a working catalog-based DDIC
      //     read (src/adt/catalog-query.ts + catalog-read.ts) — SHLP/DH,
      //     VIEW/DV, TRAN/T. This script is plain Node with no TypeScript
      //     loader, so it can't import src/adt/ddic-strategy.ts's
      //     DDIC_CATALOG_BASED to derive that the way capabilities.ts does;
      //     the three-code duplicate above is deliberate and cheap, and the
      //     census test asserts buckets.nonReadable equals NON_READABLE_TYPES
      //     exactly, so the two lists can't silently drift apart.
      nonReadable:
        cap.catalogRead === undefined &&
        (Boolean(cap.unsupported) ||
          (cap.bridgeCreate !== undefined &&
            cap.create === undefined &&
            !CATALOG_READABLE_BRIDGE_ONLY_TYPES.has(type))),
      catalogRead: Boolean(cap.catalogRead),
    };
  });

  // `bridge` rows create only through the classrun bridge, not ADT REST;
  // `outOfRegistry` rows create through their own dedicated function, not a
  // bridge and not REGISTRY's generic create path. Both get their own bucket
  // and are excluded from the three REGISTRY-shaped buckets below — `DEVC/K`
  // also has a REST create (LOCAL route) and would double-count in
  // `creatable` otherwise.
  const bridged = rows.filter((r) => r.bridge);
  const outOfRegistry = rows.filter((r) => r.outOfRegistry);
  const rest = rows.filter((r) => !r.bridge && !r.outOfRegistry);
  const creatable = rest.filter((r) => r.create === "yes");
  const writableOnly = rest.filter((r) => r.create !== "yes" && r.write !== "—");
  const unreachable = rest.filter((r) => r.create !== "yes" && r.write === "—");
  const nonReadable = rows.filter((r) => r.nonReadable);
  const catalogReadable = rows.filter((r) => r.catalogRead);

  const fmt = (list) => list.map((r) => `\`${r.type}\``).join(" ");

  const table = [
    BEGIN,
    "",
    `**Creatable and writable (${creatable.length}).** Everything else is not.`,
    "",
    ...creatable.map((r) => `- \`${r.type}\` — write shape \`${r.write}\`, delete: ${r.del}`),
    "",
    `**Bridge-only create types (${bridged.length}).** ADT REST has no usable create for these, so ` +
      "abapsmith runs them over the fluid `classic` tool's shared `ZCL_ZMCP_FLUID_CLASSIC` body " +
      "class in `$ABAPSMITH_FLUID_API`, not a throwaway per-call `$TMP` classrun. Whether it can " +
      "also update an EXISTING object, and whether it can delete one — and so whether the " +
      "create is reversible — differs per type; see each bullet." +
      (bridged.some((r) => r.bridgeRefused)
        ? " A bullet marked **create REFUSED** creates nothing at all: the bridge is described but " +
          "abapsmith will not run it, in any package " +
          `(${bridged.filter((r) => r.bridgeRefused).length} of ${bridged.length} today).`
        : ""),
    "",
    ...bridged.map((r) => {
      if (r.bridgeDel && !(r.type in BRIDGE_DELETE_NOTE)) {
        throw new Error(
          `buildCapabilityTable: ${r.type} declares bridgeDelete but has no BRIDGE_DELETE_NOTE ` +
            "entry — add one grounded in its bridgeDelete.limits before regenerating.",
        );
      }
      const del = r.bridgeDel ? BRIDGE_DELETE_NOTE[r.type] : "none — irreversible.";
      const refused = r.bridgeRefused ? "**create REFUSED** — " : "";
      return `- \`${r.type}\` — ${refused}${BRIDGE_NOTE[r.type] ?? "see src/adt/capabilities.ts."} Delete: ${del}`;
    }),
    "",
    `**Creatable, but the create site is outside this registry (${outOfRegistry.length}).** No ` +
      "`create` field in `REGISTRY` at all — these bypass the `create.verified` gate on purpose " +
      "(src/adt/capabilities.ts, ~lines 52-57). Not a classrun bridge: each has its own create call.",
    "",
    ...outOfRegistry.map((r) => `- \`${r.type}\` — ${OUT_OF_REGISTRY_CREATE[r.type]}.`),
    "",
    `**Writable but NOT creatable (${writableOnly.length}).** Change an existing one; creating fails.`,
    "",
    writableOnly.length ? fmt(writableOnly) : "_(none)_",
    "",
    `**Not reachable by any write (${unreachable.length}).** Do not probe for a write route.`,
    "",
    ...(() => {
      const readable = unreachable.filter((r) => !r.nonReadable && !r.catalogRead);
      // Registry-wide, not bucket-scoped: catches non-readable types (e.g. VIEW/DV, TRAN/T)
      // that are bridge-creatable and so never land in `unreachable` at all.
      const bridgeCreatableNonReadable = nonReadable.filter((r) => r.bridge && !unreachable.includes(r));
      return [
        `- Readable, not writable (${readable.length}): ${readable.length ? fmt(readable) : "_(none)_"}`,
        `- Readable through the catalog route, not writable (${catalogReadable.length}) — no ADT ` +
          "resource exists for these at all; `abap_read` renders them read-only from catalog tables " +
          `instead (\`catalogRead\`, src/adt/capabilities.ts), not an ordinary ADT read: ` +
          `${catalogReadable.length ? fmt(catalogReadable) : "_(none)_"}.`,
        `- Not readable either (${nonReadable.length}) — \`abap_read\` refuses these before any ` +
          "network call, from an `unsupported` entry or a bridge-only create with no read route " +
          `of any kind (NON_READABLE_TYPES, src/adt/capabilities.ts): ${nonReadable.length ? fmt(nonReadable) : "_(none)_"}.` +
          (bridgeCreatableNonReadable.length
            ? " Registry-wide, not just this bucket: " +
              `${fmt(bridgeCreatableNonReadable)} — creatable through the bridge above, still unreadable.`
            : ""),
      ];
    })(),
    "",
    END,
  ].join("\n");

  return {
    table,
    buckets: { creatable, bridged, outOfRegistry, writableOnly, unreachable, nonReadable, catalogReadable },
  };
}

/** CLI-only: loads REGISTRY from the compiled tree, since this script is plain Node and can't import the TypeScript source directly. */
async function loadRegistryFromDist() {
  const distPath = resolve(REPO_ROOT, "dist/adt/capabilities.js");
  if (!existsSync(distPath)) {
    throw new Error(
      `${distPath} does not exist — run \`npm run build\` first. This CLI reads the ` +
        "compiled tree because this script is plain Node and src/adt/capabilities.ts is TypeScript.",
    );
  }
  const { REGISTRY } = await import(distPath);
  return REGISTRY;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const { table } = await buildCapabilityTable(await loadRegistryFromDist());

  if (process.argv.includes("--check")) {
    if (!existsSync(skillPath)) {
      console.error(`stale-check: ${skillPath} does not exist`);
      process.exit(1);
    }
    const body = readFileSync(skillPath, "utf8");
    const start = body.indexOf(BEGIN);
    const stop = body.indexOf(END);
    if (start === -1 || stop === -1) {
      console.error(`stale-check: markers not found in ${skillPath}`);
      process.exit(1);
    }
    const current = body.slice(start, stop + END.length);
    if (current.trim() !== table.trim()) {
      console.error("stale-check: capability table in the skill no longer matches the registry.");
      console.error("Regenerate with: node scripts/gen-capability-table.mjs");
      process.exit(1);
    }
    console.log("stale-check: capability table is current.");
    process.exit(0);
  }

  console.log(table);
}
