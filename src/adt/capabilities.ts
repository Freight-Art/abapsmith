/**
 * Per-type write capability registry — the single source of truth for "can
 * abapsmith mutate this ADT object type, and how."
 *
 * Before this file, `src/adt/write.ts` declared four flat string-literal
 * arrays (`WRITABLE_TYPES`, `CREATE_ONLY_TYPES`, `CREATABLE_TYPES`,
 * `ENHANCEABLE_TYPES`) that had to be hand-updated in the right combination
 * for every new type. `REGISTRY` below is now the one place a type's
 * abilities are declared; those four arrays (and every refusal message that
 * used to hand-spell "writable types are …") are *computed* from it (see the
 * bottom of this file). Nothing elsewhere should ever again hand-list ADT
 * type codes as a capability statement.
 *
 * `TypeCode` is a HAND-MAINTAINED literal union — `src/adt/types.ts`'s
 * `TYPES` array is not `as const`, so a compile-time union can't be derived
 * from it without editing that file, which this deliberately avoids.
 * `REGISTRY: Record<TypeCode, TypeCapabilities>` is compile-time-closed
 * (TypeScript rejects a missing or stray key). The reverse gap — did
 * `TypeCode` itself forget a type `types.ts` added? — is closed at runtime by
 * {@link assertRegistryCoversTypes} (boot-time crash on a missing entry).
 * {@link assertNoConflictingCapabilities} closes a third gap: no entry may
 * declare both a capability (`write`/`create`) and `unsupported`.
 *
 * Eight `TypeCode`s — `SHLP/DH`, `VIEW/DV`, `TRAN/T`, `PROG/PS`, `PROG/PC`,
 * `PROG/PT`, `SUSO/B`, `TABL/DI` — are deliberately NOT in `types.ts`'s
 * `TYPES` array: each is a real ADT concept that 404s or 405s on every write
 * (and often read) verb, and giving any of them a `path`/`mode` there would
 * let `abap_read`/search build a URI with no reachable resource behind it.
 * `TABL/DI` (a table's secondary index) joins `VIEW/DV`/`TRAN/T` in this: it
 * has no ADT-readable collection — probed live on A4H 2026-09-05, 404 on
 * every index route — and is creatable/deletable only through the classrun
 * bridge (see its REGISTRY entry). `resolveWriteTarget` checks the registry
 * for these codes directly, by exact code, before ever asking `types.ts` for
 * a spec.
 * Full per-type recon (VIT-bridge stub behavior, which collections 404, live
 * probe scripts) is in the git history — read the relevant entry's
 * `unsupported`/`bridgeCreate` fields below for the live refusal text.
 *
 * `delete` and `create.verified` are both
 * refuse-until-proven tri-states — see their own doc comments below
 * ({@link TypeCapabilities.delete}, {@link CreateCapability.verified}) for
 * the semantics both share: only `true` opens a gate, `false` and
 * `"unverified"` both refuse. Every `true`/`false` value in `REGISTRY` is
 * backed by a live run cited in that entry's own comment; the full
 * evidence — bench scripts, run ids, byte counts — lives in
 * the git history, not duplicated per-entry here.
 * `create.verified`'s gate is enforced in `src/adt/write.ts` (inside
 * `writeObject`, before `preflightCorr`, plus a defence-in-depth check in
 * `createNewObject`) — there is no `op: "create"` in `resolveWriteTarget` to
 * intercept the way `delete`/`activate` have, because creation is a side
 * effect `writeObject` discovers mid-write (an existence GET failing), not a
 * dispatched operation. It does NOT cover `bridgeCreate` (`VIEW/DV`,
 * `TRAN/T`, `TABL/DI`, created by classrun bridge, not REST) or the three create sites
 * that bypass this gate entirely on purpose because they carry no `create`
 * field at all: `enhancement-hook.ts` (`ENHO/XHH`), `enhancement-bridge.ts`
 * (`ENHS/XS`/`ENHO/XH`), `bopf.ts` (`BOBF`, not even a `TypeCode`). See the
 * archive for the full bypass audit.
 *
 * BOPF activation on this appliance never defers its companion DDIC objects
 * (structure, table type, database table) into a phase-two preaudit set —
 * live-verified 2026-08-29 on A4H. Six BO activation
 * POSTs to `activation?method=activate&preauditRequested=true`, across four
 * differently-configured attempts, returned no `ioc:inactiveObjects`
 * element; instead the appliance generates and activates the companions
 * inline, in the same phase-one call, each reported as its own `type="I"`
 * checklist message — a clean root-only BO came back byte-identical
 * (1541 bytes) across two separate runs, checklist already reading
 * "Structure ... has been created / ... has been activated", and the same
 * for the table type and the database table. `activateWithPreauditSet`
 * (`src/adt/activate.ts:960`) refuses on an empty `inactive` set or on any
 * activation error; those two guards are jointly unsatisfiable here for
 * structural reasons — a phase one clean enough to clear the second guard is
 * exactly a phase one with nothing left in the first. This is NOT an
 * argument that the phase-two path is dead code — its other caller,
 * `enhancement-bridge.ts:424`, has been exercised live in this same series —
 * nor proof that no configuration reaches it (four reasonable attempts
 * within `ZTMD_*` in `$TMP` did not provoke one), nor a claim about any
 * other SAP release.
 *
 * `namePrefixes` is read by `SafetyGate.rules()`: a type that declares it is
 * judged against its own prefix list instead of the global
 * `DEFAULT_NAME_PREFIXES`. Two types set it: `ENQU/DL` (SAP requires `E…`
 * names for lock objects) and `FUGR/I` (`LZ`/`LY`, because SAP derives the
 * function group from the include name `L<GROUP><suffix>`) — the global
 * default is deliberately not widened for either.
 *
 * `FUGR/FF` and `FUGR/I` are both `create.parent: "container"`: a function
 * module and a function group include are each parented by their function
 * GROUP (`<adtcore:containerRef>`), not a package, and `write.ts`'s
 * `createNewObject` switches on this to build a group sub-collection
 * instead of `/packages/…` — which sub-collection (`/fmodules` for
 * `FUGR/FF`, `/includes` for `FUGR/I`) comes from the vendor's own per-type
 * `creationPath`, not from anything hard-coded in `createNewObject`.
 */
import { ddicStrategy } from "./ddic.js";
import { TYPES, specForType, type TypeSpec } from "./types.js";

/** How a type's content is written: a plain-text source PUT, or a structured XML property PUT. */
export type WriteShape = "source" | "properties";

/** What kind of parent object a CREATE needs a name for. Defaults to `"package"` when absent. */
export type ParentKind = "package" | "container";

/**
 * A hand-built create-body skeleton for a `create.vendor: false` type whose
 * write shape is `"source"` — needed because `createByXml`'s usual trick
 * (POST the caller's own write payload as the create body) only works when
 * that payload is already XML (`write.shape: "properties"`, e.g. `TTYP/DA`,
 * `ENQU/DL`). `BDEF/BDO`'s payload is ABAP source, so `write.ts` builds this
 * skeleton itself instead — `abap-adt-api` has no `CreatableTypes` entry for
 * `BDEF/BDO` at all.
 *
 * The exact shape (root element, namespace, attrs) started as a raw-wire
 * capture from a standalone probe against A4H, OUTSIDE abapsmith; abapsmith's
 * own `createNewObject` → `putSource` → `activate` choreography has since
 * carried it live for `BDEF/BDO` (2026-09-05: `created: true, activated:
 * true`). See the git history for the full capture record.
 */
export interface SkeletonCreate {
  /** The create body's root element, prefixed — e.g. `"blue:blueSource"`. */
  rootName: string;
  /**
   * The root element's own `xmlns` declaration, e.g.
   * `xmlns:blue="http://www.sap.com/wbobj/blue"`. `xmlns:adtcore` is added by
   * the builder — every skeleton needs it, so it is not repeated per type.
   */
  namespace: string;
  /**
   * `Content-Type` for the create POST, sent with **no parameters** — a
   * value carrying `; charset=utf-8` gets refused with `406` /
   * `SADT_RESOURCE 037` (observed against `blues.v1`; assume the same trap
   * applies to any future skeleton type). See
   * the git history for the incident.
   */
  contentType: string;
  /**
   * Extra already-escaped attribute text spliced onto the root element after
   * the namespace declarations — e.g. XSLT/VT's
   * `trans:transformationType="XSLTProgram"`, required by the server to
   * accept the create POST at all (see that entry's own comment).
   */
  rootAttributes?: string;
}

export interface CreateCapability {
  /**
   * True ⇒ `abap-adt-api`'s `CreatableTypes` table has a real entry for this
   * type, so `createNewObject()` reuses it unchanged.
   *
   * False ⇒ no vendor entry (checked directly against `objectcreator.js`'s
   * map — `TTYP/DA`, `ENQU/DL`, `BDEF/BDO`, `XSLT/VT`, `TYPE/DG`, `DRUL/DRL`
   * are absent) — `write.ts` POSTs the create body itself via `createByXml`,
   * one of two ways, enforced by {@link assertNoConflictingCapabilities}:
   *   - no `create.skeleton` — the caller's own write payload IS the create
   *     body verbatim. Requires `write.shape === "properties"` — `TTYP/DA`,
   *     `ENQU/DL` (whose create is rejected unless `<enqu:content>` is
   *     already non-empty on the first POST).
   *   - `create.skeleton` present — `write.ts` hand-builds the create XML
   *     from name/type/package (see {@link SkeletonCreate}); the payload is
   *     ABAP source and goes on the PUT that follows. Requires
   *     `write.shape === "source"` — `BDEF/BDO`, `XSLT/VT`, `TYPE/DG`,
   *     `DRUL/DRL`.
   */
  vendor: boolean;
  /** See {@link ParentKind}. */
  parent?: ParentKind;
  /** See {@link SkeletonCreate}. Only ever consulted when `vendor` is `false`. */
  skeleton?: SkeletonCreate;
  /**
   * Live-verification tri-state for THIS type's create recipe — the
   * create-direction twin of {@link TypeCapabilities.delete}'s tri-state:
   *   - `true` a live create succeeded. Read the entry's own comment for
   *     what backs it — most are a full create → read-back → delete →
   *     verify-absent cycle through abapsmith's own tool surface; `BDEF/BDO`
   *     was a full create through `abap_write` (`created: true, activated:
   *     true`, 2026-09-05), though its delete is so far only raw-wire.
   *   - `false` create was tried live and does not reliably work.
   *   - `"unverified"` no live create evidence exists — refused like `false`.
   *
   * REQUIRED (unlike `delete`, which may be omitted): every entry that
   * carries `create` is actively claiming a working recipe exists, so an
   * optional `verified` could silently default to "not yet checked". This
   * way TypeScript refuses to compile until a human writes an explicit
   * tri-state value.
   */
  verified: true | false | "unverified";
}

export interface TypeCapabilities {
  /** Human label — mirrors `TypeSpec.label` for types that have a `types.ts` entry. */
  label: string;
  /** Present ⇒ an EXISTING object of this type can be edited. */
  write?: { shape: WriteShape };
  /** Present ⇒ a NEW object of this type can be created. */
  create?: CreateCapability;
  /**
   * Gates `op: "delete"` in `resolveWriteTarget`. Only `true`
   * opens the gate:
   *   - `true` a live create → delete → independently-verified-absent cycle
   *     succeeded (see this entry's own comment).
   *   - `false` delete was tried live and does NOT reliably work.
   *   - `"unverified"` no live delete evidence exists — refused like `false`.
   */
  delete?: boolean | "unverified";
  /**
   * Whether a write of this type is followed by an activation. Read by
   * `src/tools/write.ts` only in the negative direction: `activate: false`
   * SUPPRESSES the post-write activation — load-bearing for `MSAG/N`, which
   * is created already `adtcore:version="active"` with no inactive stage, so
   * activating it again would be asking the server to activate something
   * already active. Absent/`true` means "activate as usual".
   */
  activate?: boolean;
  /**
   * Per-type name-prefix override, REPLACING the configured/global
   * `allowNamePrefixes` for this type only. Read by `SafetyGate.rules()` — see
   * the module doc. Set by `ENQU/DL` and `FUGR/I` only.
   */
  namePrefixes?: string[];
  /**
   * Overrides the generic `application/*` Accept/Content-Type every other
   * `write.shape: "properties"` type uses for its root-object GET/PUT/POST.
   * Absent ⇒ `application/*`.
   *
   * Needed by `SRVB/SVB` only: a root GET with a generic `Accept:
   * application/xml` 406s; only the fully-qualified vendor type
   * (`application/vnd.sap.adt.businessservices.servicebinding.v1+xml`) gets
   * `200` (live-corroborated — see that entry's own comment for scope). Read
   * by `src/adt/write.ts` (`contentAccept`/`contentType`, `createByXml`,
   * `resolveWriteTarget`'s existence GET) and `src/tools/read.ts`
   * (`fetchRawDescriptor`, threaded through to `fetchDdicXml` as an explicit
   * param rather than importing this registry into `ddic.ts`, which this
   * file already imports — that would be a cycle).
   */
  mediaType?: string;
  /**
   * This type's `/source/main` answers `200` with an EMPTY body for an
   * object that does not exist, instead of `404` — a deleted `BDEF/BDO` and
   * a name that was never created answered byte-identical 200/empty
   * responses, live against A4H 2026-09-05. A blank source read therefore
   * settles nothing about existence until the object URI is asked (see
   * `write-verify.ts`'s `blankSourceIsAmbiguous`/`objectAcceptFor` and
   * `source.ts`'s `readSource`). Set only on `BDEF/BDO` today — see that
   * entry's own comment for scope. Whether `SRVD/SRV` and `DDLX/EX`, the
   * other source-only types on this endpoint family, share the shape is
   * unchecked — no cassette covers it and no live call was made.
   */
  blankSourceOnAbsence?: true;
  /**
   * Present ⇒ a NEW object of this type is created by a generated
   * `IF_OO_ADT_CLASSRUN` bridge (`src/adt/ddic-bridge.ts`), **not** by ADT
   * REST — a separate field from {@link create} on purpose, since REST
   * itself 405s for these. `src/tools/write.ts` routes to the bridge before
   * `resolveWriteTarget` is ever consulted, the same way it routes `DEVC/K`
   * to `abapCreatePackage`.
   *
   * Mutually exclusive with `write`/`unsupported` always, and with `create`
   * UNLESS {@link alongsideRestCreate} names the discriminator — enforced by
   * `assertNoConflictingCapabilities()` below.
   */
  bridgeCreate?: {
    /** Why the REST route does not work — kept so a future reader does not re-run the recon. */
    adtRest: string;
    /** The ABAP API the bridge drives, and where the choreography lives. */
    via: string;
    /** What this create does NOT do. Honest scope, stated on the capability itself. */
    limits: string;
    /**
     * Present ⇒ a REST `create` coexists with this bridge; names the caller
     * input that picks between them. Set only by `DEVC/K`:
     * `software_component: "LOCAL"` goes through REST, anything else through
     * the bridge.
     */
    alongsideRestCreate?: string;
    /**
     * Present ⇒ the bridge exists and is described above, but abapsmith
     * refuses to RUN it: no package produces a create worth having. The
     * string is the one caller-facing sentence every site that would
     * otherwise advertise "you can create this through the bridge" renders
     * instead — `src/adt/resolve.ts` (read refusal), `src/adt/write.ts`
     * (source-write refusal) and {@link writableTypesHint} — so the read
     * hint and the write refusal cannot contradict each other. The refusal
     * itself is enforced in the type's own create module, not from here.
     */
    createRefused?: string;
  };
  /**
   * Present ⇒ an EXISTING object of this type is deleted by the same
   * classrun-bridge mechanism as {@link bridgeCreate} — no ADT REST delete
   * route exists for it at all. Deliberately NOT folded into
   * `DELETABLE_TYPES`, which is the REST-delete answer the REST paths
   * consume.
   */
  bridgeDelete?: {
    adtRest: string;
    via: string;
    limits: string;
  };
  /**
   * This is a real ADT concept abapsmith deliberately does NOT support
   * writing, as opposed to a type simply absent from `write`/`create` (which
   * gets the generic "cannot be written" refusal). An `unsupported` entry
   * gets a SPECIFIC, actionable refusal instead — see `resolveWriteTarget`.
   * Mutually exclusive with `write`/`create` — enforced by
   * `assertNoConflictingCapabilities()` below.
   */
  unsupported?: { reason: string; alternative?: string };
}

/**
 * Every ADT type code this registry knows about: the 28 entries in
 * `src/adt/types.ts`'s `TYPES` array, plus eight that are deliberately NOT
 * there (see the module doc). Hand-maintained — kept honest at runtime by
 * {@link assertRegistryCoversTypes}.
 */
export type TypeCode =
  | "CLAS/OC"
  | "INTF/OI"
  | "PROG/P"
  | "PROG/I"
  | "FUGR/F"
  | "FUGR/FF"
  | "FUGR/I"
  | "DDLS/DF"
  | "DDLX/EX"
  | "DCLS/DL"
  | "DDLA/ADF"
  | "SRVD/SRV"
  | "BDEF/BDO"
  | "XSLT/VT"
  | "TYPE/DG"
  | "DRUL/DRL"
  | "ENHO/XH"
  | "ENHO/XHH"
  | "ENHS/XS"
  | "TABL/DT"
  | "TABL/DS"
  | "DTEL/DE"
  | "DOMA/DD"
  | "TTYP/DA"
  | "MSAG/N"
  | "ENQU/DL"
  | "DEVC/K"
  | "SRVB/SVB"
  | "SHLP/DH"
  | "VIEW/DV"
  | "TRAN/T"
  | "PROG/PS"
  | "PROG/PC"
  | "PROG/PT"
  | "SUSO/B"
  | "TABL/DI";

export const REGISTRY: Record<TypeCode, TypeCapabilities> = {
  // CLAS/INTF/PROG delete: true live-verified 2026-08-19: create →
  // delete → independent abap_read confirming absence, all clean. Archive:
  // the git history.
  "CLAS/OC": {
    label: "Class",
    write: { shape: "source" },
    // verified: true — create-verification sweep, 2/2 FULL_CYCLE_OK. Load-bearing
    // beyond abap_write: abapsmith deploys its own IF_OO_ADT_CLASSRUN bridge
    // classes through this same path. Archive has the full run record.
    create: { vendor: true, verified: true },
    delete: true,
    activate: true,
  },
  "INTF/OI": {
    label: "Interface",
    write: { shape: "source" },
    // verified: true — create-verification sweep, 3/3 FULL_CYCLE_OK. Load-bearing:
    // the enhancement bridge creates a marker INTERFACE via this path too.
    create: { vendor: true, verified: true },
    delete: true,
    activate: true,
  },
  "PROG/P": {
    label: "Program",
    write: { shape: "source" },
    // verified: true — create-verification sweep, 2/2 FULL_CYCLE_OK. Load-bearing:
    // abap_run creates a runner PROGRAM through this same path.
    create: { vendor: true, verified: true },
    delete: true,
    activate: true,
  },
  // Package-parented (unlike FUGR/I below): vendor CreatableTypes has a real
  // PROG/I entry (creationPath programs/includes, validationPath
  // includes/validation) using the ordinary createBodySimple/
  // <adtcore:packageRef> body, so create.parent stays at its "package"
  // default — an include is a standalone repository object; nothing in the
  // create body ties it to a host program, only the host's own
  // `INCLUDE <name>.` statement does that.
  //
  // Evidence, A4H 2026-09-04: POST .../includes/validation?objtype=PROG/I&
  // objname=ZTMD_INC_01&packagename=$TMP returned CHECK_RESULT=X (name is
  // free-form, 30 chars); GET .../programs/includes/lsabp_unit_sboxtop
  // 200s with a generic Accept, so no mediaType override is needed.
  // `create.verified: true` and `delete: true` — live-verified full cycle on
  // A4H 2026-09-04: create, check clean, activate, re-write (etag changed,
  // activate), read-back. Delete is refused by the server (403
  // ExceptionResourceDeletionFailure, "referenced in other programs") while
  // any program still INCLUDEs it; delete succeeded once the host's own
  // `INCLUDE` statement was removed, and a read then 404d.
  "PROG/I": {
    label: "Include",
    write: { shape: "source" },
    create: { vendor: true, verified: true },
    delete: true,
    activate: true,
  },
  // PACKAGE-parented (unlike FUGR/FF below): vendor CreatableTypes has a real
  // FUGR/F entry using the ordinary <adtcore:packageRef> body, so
  // create.parent stays at its "package" default. Registering this is what
  // makes FUGR/FF reachable at all — a function module needs a group to be
  // created inside, and until this entry existed the group could be neither
  // written nor created.
  //
  // `write` is live-verified with a distinguishing marker-comment PUT into
  // the group's /source/main (its top-include skeleton), not inferred from
  // types.ts. Footgun: PUTting /source/main REPLACES that include list — a
  // caller must write the INCLUDE L<GROUP>TOP./L<GROUP>UXX. lines back.
  // Omitting the UXX line specifically is silent: the group writes, activates
  // and reads back active while every CALL FUNCTION against its modules dumps
  // CX_SY_DYN_CALL_ILLEGAL_FUNC / CALL_FUNCTION_NOT_ACTIVE.
  // assertFunctionGroupImplementationInclude in write.ts refuses that shape
  // before the PUT.
  //
  // `delete: true` live-verified 2026-08-19, twice. One divergence
  // recorded: DELETE without a lock 423s here (unlike FUGR/FF) — moot today
  // since deleteObject always locks first, but flagged against a future
  // lock-elision fast path. Full method: the git history.
  "FUGR/F": {
    label: "Function group",
    write: { shape: "source" },
    // verified: true — create-verification sweep, 2/2 FULL_CYCLE_OK (dedicated
    // CREATE citation; earlier evidence only covered WRITE of an existing
    // group's top include).
    create: { vendor: true, verified: true },
    delete: true,
    activate: true,
  },
  // Container-parented — see the module doc. Vendor FUGR/FF entry emits
  // <adtcore:containerRef> instead of <adtcore:packageRef>; vendor: true
  // still holds, parent: "container" only changes which parent
  // createNewObject hands it.
  //
  // `delete: true` live-verified 2026-08-19, twice: DELETE succeeded
  // both times and the sibling group's own delete+verify-absent corroborated
  // it. Direct abap_read absence-check on the function module itself is NOT
  // reliable for this type — reading /source/main of an already-deleted FM
  // 500s instead of 404ing (a pre-existing appliance quirk, not something
  // this pass fixes); `true` rests on the DELETE call's own success plus the
  // container-level corroboration, not on that read.
  "FUGR/FF": {
    label: "Function module",
    write: { shape: "source" },
    // verified: true — create-verification sweep, 2 iterations, both createOk AND
    // verifyPresentOk (independent read-back while it existed). Both
    // iterations' post-delete bench verdict reads CREATED_STILL_PRESENT —
    // that is the /source/main-500s-not-404s quirk above tripping the
    // harness's absence check, NOT a leak: the containing group was
    // independently confirmed deleted in both runs and a function module
    // cannot outlive its group. `verified` describes CREATE only; full
    // record in the archive.
    create: { vendor: true, parent: "container", verified: true },
    delete: true,
    activate: true,
  },
  // Container-parented like FUGR/FF: the vendor FUGR/I row goes through
  // createBodyFunc, emitting <adtcore:containerRef> naming the function
  // GROUP. Name shape: the caller passes the FULL include name
  // (L<GROUP><suffix>) together with the group as container — e.g.
  // object: "ZTMD_FG_01/LZTMD_FG_01F01". The vendor row's maxLen: 3 is a
  // client-side hint the server contradicts: POST .../functions/validation?
  // objtype=FUGR/I&fugrname=SABP_UNIT_SBOX&objname=… answered SEVERITY
  // ERROR ("Include F01 will not be created in function group
  // SABP_UNIT_SBOX") for the bare 3-char suffix, and SEVERITY OK for
  // LSABP_UNIT_SBOXF01 (A4H, 2026-09-04). So t.name goes to createObject
  // unchanged, and it's the same name the read/write/delete URI carries — a
  // live GET .../functions/groups/sabp_unit_sbox/includes/lsabp_unit_sboxtop
  // returns adtcore:name="LSABP_UNIT_SBOXTOP".
  //
  // createNewObject needed no change; see the container-parent note in the
  // module doc above.
  //
  // namePrefixes is server-derived, like ENQU/DL's ["EZ","EY"]: SAP derives
  // the group name from the include name, so an include of a customer
  // Z…/Y… group necessarily begins LZ/LY, and the global ["Z","Y"] list
  // would refuse every valid name. `create.verified: true` and `delete: true`
  // — live-verified full cycle on A4H 2026-09-04 (ZTMD_FG_01/LZTMD_FG_01F01
  // and an arbitrary LZTMD_FG_01ABC suffix, both): create, activate, update
  // (etag changed), read, delete, then a 404 read. The group must already
  // exist — POST against a missing group 500s
  // ExceptionResourceCreationFailure "cannot be created without a package".
  "FUGR/I": {
    label: "Function group include",
    write: { shape: "source" },
    create: { vendor: true, parent: "container", verified: true },
    delete: true,
    activate: true,
    namePrefixes: ["LZ", "LY"],
  },
  // Source-shape, reuses createNewObject/putSource/deleteObject unchanged
  // (vendor CreatableTypes has a DDLS/DF entry). `delete: true`
  // live-verified 2026-08-19: create → delete → independent
  // abap_read confirming absence, clean, twice.
  "DDLS/DF": {
    label: "CDS view / DDL source",
    write: { shape: "source" },
    // verified: true — create-verification sweep, 3/3 FULL_CYCLE_OK, including a
    // dedicated read-back while present.
    create: { vendor: true, verified: true },
    delete: true,
    activate: true,
  },
  // Same recipe as DDLS/DF: vendor CreatableTypes has a real DDLX/EX entry,
  // so create.vendor: true reuses createNewObject unchanged. Live-verified
  // end to end, twice, on A4H: create 201 → PUT source 200 → activate 200
  // clean → read back 200 (118 bytes) → delete 200. NOT re-tested by the
  // 2026-08-19 delete pass — this citation already met that bar.
  //
  // Caller trap, not a code issue: a metadata extension only activates
  // against a base CDS view carrying `@Metadata.allowExtensions: true`
  // (default false) — "Annotation 'Metadata.allowExtensions' missing"
  // otherwise. Property of the DDLS text abapsmith writes, not of this entry.
  "DDLX/EX": {
    label: "Metadata extension",
    write: { shape: "source" },
    // verified: true rests on the pre-existing create→read-back→delete
    // citation in the comment above. the create-verification sweep deliberately did NOT
    // re-create this type (bar already met; avoids a leftover-object risk).
    create: { vendor: true, verified: true },
    delete: true,
    activate: true,
  },
  // Same source-shape recipe as DDLS/DF: vendor CreatableTypes has a real
  // DCLS/DL entry (creationPath acm/dcl/sources). Live-verified end to end
  // on A4H, 2026-09-04, all through abapsmith's own abap_write/abap_read:
  // create ZTMD_DCL_01 in $TMP → source PUT → read back verbatim → PUT with
  // activate=true → activated clean, read back verbatim → delete → NOT_FOUND
  // on a subsequent read. Object GET 406s with a generic Accept, 200 with
  // the vendor media type — hence mediaType below.
  "DCLS/DL": {
    label: "CDS access control",
    write: { shape: "source" },
    create: { vendor: true, verified: true },
    delete: true,
    activate: true,
    mediaType: "application/vnd.sap.adt.dclSource+xml",
  },
  // Same source-shape recipe as DCLS/DL: vendor CreatableTypes has a real
  // DDLA/ADF entry (validationPath ddic/ddla/sources/validation), and
  // `GET .../ddic/ddla/sources/endusertext/source/main` 200s (the object URI
  // 406s with a generic Accept, 200 with the vendor media type — hence
  // mediaType). But `verified: false` — settled (not "unverified"): a
  // 2026-09-04 A4H probe DISPROVED create for both `abap_write` (creating
  // ZTMD_ANNO_01 in $TMP) and a raw `POST .../ddic/ddla/sources` with the
  // vendor body — both refused 403, exception `com.sap.adt.ddla
  // .ExceptionNoAnnotationDefinitionAuthorization`, "You are not authorized
  // to create Annotation Definitions", from an admin user that creates every
  // other type. Annotation definitions are SAP-only on this system. `delete`
  // stays "unverified": create never succeeded, so delete was never once
  // reachable to test.
  "DDLA/ADF": {
    label: "Annotation definition",
    write: { shape: "source" },
    create: { vendor: true, verified: false },
    delete: "unverified",
    activate: true,
    mediaType: "application/vnd.sap.adt.ddic.ddla.v1+xml",
  },
  // Same recipe again: vendor CreatableTypes has a real SRVD/SRV entry, so
  // this is createNewObject/putSource/deleteObject unchanged. Live-verified
  // end to end, twice, on A4H: create 201 → PUT source 200 → activate 200
  // clean → delete 200.
  //
  // Two caveats this entry does NOT clear, recorded so nobody re-derives
  // them: (1) a service definition may only expose DDIC-based CDS views, CDS
  // projection views or custom entities — an ABSTRACT CDS entity activates
  // cleanly and short-dumps at PUBLISH time instead (SAP RAP 1909 guide, pp.
  // 11/72; a property of the DDL text, not this code). (2) delete is not
  // unconditional: the server refuses `SDDIC_ADT_SRVD207` ("Service
  // Definition &1 is still used and cannot be deleted") while any `R3TR
  // SRVB`/`R3TR SRVC` still references it — correct teardown is unpublish
  // binding → delete SRVB → delete SRVD. NOT re-tested by the 2026-08-19
  // 2026-08-19 delete pass, same reasoning as DDLX/EX above.
  "SRVD/SRV": {
    label: "Service definition",
    write: { shape: "source" },
    // verified: true rests on the pre-existing create→delete citation above.
    // the create-verification sweep deliberately did NOT re-create this type — the citation
    // already meets that bar, and a fresh SRVD risks a leftover if
    // teardown order (see SDDIC_ADT_SRVD207 note above) isn't followed exactly.
    create: { vendor: true, verified: true },
    delete: true,
    activate: true,
  },
  // Source-shape (PUT {uri}/source/main, ABAP behavior-definition text), but
  // no vendor CreatableTypes entry AND the payload is ABAP source, not XML,
  // so it can't double as the create body — create.skeleton is the
  // mechanism that fills the gap; see SkeletonCreate's doc for the shape and
  // its provenance caveat.
  //
  // A `managed` behavior definition over a CDS root view with a persistent
  // table was created and activated live on this release (A4H, 2026-09-05) —
  // `implementation unmanaged` is NOT the only usable flavour on-prem, contra
  // the 1909 FPS00 RAP guide. On 7.56+ BDEF strict mode the bare
  // `implementation {managed|unmanaged};` header this skeleton pairs with is
  // obsolete and becomes a syntax error — a known forward-compat limitation,
  // not solved here.
  //
  // `delete: true` — a live lock + raw DELETE answered 200, and the absence
  // was independently confirmed two ways: the repository search row was
  // gone, and a GET of the object URI answered the identical
  // "Error while importing object ... from the database" a never-existing
  // name gets (A4H, 2026-09-05). The earlier "survived two deletes" reading
  // was a misdiagnosis — the source endpoint answers 200 with an empty body
  // for an absent BDEF/BDO (see `blankSourceOnAbsence` below), which reads as
  // "still there" unless the object URI is also asked; `write-verify.ts` and
  // `source.ts` now do that. Exercised so far only via a raw lock+DELETE, not
  // yet through abapsmith's own `abap_write mode=delete` end to end — a live
  // run is queued to confirm that path too.
  "BDEF/BDO": {
    label: "Behavior definition",
    write: { shape: "source" },
    create: {
      vendor: false,
      skeleton: {
        rootName: "blue:blueSource",
        namespace: 'xmlns:blue="http://www.sap.com/wbobj/blue"',
        // No `; charset=utf-8` — see SkeletonCreate.contentType's doc.
        contentType: "application/vnd.sap.adt.blues.v1+xml",
      },
      // verified: true — create ran live end to end through abap_write on
      // A4H 2026-09-05 (table → classic CDS root view → BDEF with a
      // `managed;` header): created: true, activated: true.
      verified: true,
    },
    delete: true,
    activate: true,
    // The source endpoint answers 200/empty for an absent object — see the
    // field's own doc comment.
    blankSourceOnAbsence: true,
  },
  // `create.vendor: false` — no XSLT/VT row in abap-adt-api's CreatableTypes
  // (checked against objectcreator.js), so create needs a skeleton like
  // BDEF/BDO. Live-probed against A4H 2026-09-04: the plural namespace
  // `.../adt/transformations` 400s ("System expected the element
  // '{http://www.sap.com/adt/transformation}transformation'"); the singular
  // namespace below then 400s InvalidTransformationValue ("Transformation
  // Type is not supported") until `trans:transformationType="XSLTProgram"`
  // is on the root — with that attribute the raw POST returned 200 and the
  // object read back afterwards. `contentType` carries no parameters, per
  // SkeletonCreate.contentType's doc.
  "XSLT/VT": {
    label: "Transformation",
    write: { shape: "source" },
    create: {
      vendor: false,
      skeleton: {
        rootName: "trans:transformation",
        namespace: 'xmlns:trans="http://www.sap.com/adt/transformation"',
        contentType: "application/vnd.sap.adt.transformations+xml",
        rootAttributes: 'trans:transformationType="XSLTProgram"',
      },
      // Live 2026-09-04 through abap_write itself: create ZTMD_XSLT_01 in $TMP
      // (created: true, check clean, activated), read back verbatim.
      verified: true,
    },
    // Live 2026-09-04: abap_write mode=delete → deleted: true, read → NOT_FOUND.
    delete: true,
    activate: true,
    // Discovery advertises this as the transformations collection's accept
    // type (2026-09-04); a generic Accept on the object GET was not tested.
    mediaType: "application/vnd.sap.adt.transformations+xml",
  },
  // Two DDIC source types added 2026-09-04. Full create → write → activate →
  // read-back → delete cycles ran live through abapsmith on A4H (2026-09-04,
  // $TMP objects: ZTMDY for TYPE/DG, ZTMD_DRUL_02 for DRUL/DRL) and worked
  // end to end. Neither has a `CreatableTypes` row in abap-adt-api, so
  // create goes through a hand-built skeleton like `BDEF/BDO`/`XSLT/VT`.
  // `mediaType` is the vendor Accept actually used on the object URI (the
  // sibling DCLS/DL/DDLA/ADF URIs 406 without it) — a generic Accept was not
  // tried.
  //
  // Type group: GET .../ddic/typegroups/trexc → 200, root
  // `<atypgr:abapTypeGroup ... adtcore:type="TYPE/DG">`; GET .../source/main
  // with Accept: text/plain → 200, real `TYPE-POOL trexc. CONSTANTS: …`.
  // Live full cycle on ZTMDY ($TMP) through abapsmith 2026-09-04: create
  // (skeleton POST then source PUT, check clean, activated) → update (added
  // a CONSTANTS line, changed, activated) → read back both lines → delete →
  // NOT_FOUND. Wire quirk: ADT rejects underscores in type-group names ("Do
  // not use underscores in type group names", 403 — confirmed again on
  // ZTMD_TG_01) and caps them at 5 characters (TYPE-POOL naming rule).
  "TYPE/DG": {
    label: "Type group",
    write: { shape: "source" },
    // Skeleton POST .../ddic/typegroups, Content-Type
    // application/vnd.sap.adt.ddic.typegroups.v2+xml, then a source PUT —
    // full cycle via abap_write on A4H 2026-09-04 (ZTMDY, $TMP):
    // created: true, check clean, activated: true.
    create: {
      vendor: false,
      skeleton: {
        rootName: "atypgr:abapTypeGroup",
        namespace: 'xmlns:atypgr="http://www.sap.com/adt/ddic/typegroups"',
        contentType: "application/vnd.sap.adt.ddic.typegroups.v2+xml",
      },
      verified: true,
    },
    delete: true,
    activate: true,
    mediaType: "application/vnd.sap.adt.ddic.typegroups.v2+xml",
  },
  // Dependency rule: discovery advertises drul/sources with this media type,
  // title "Dependency Rule"; GET .../drul/sources/demo_drul_1 → 200, root
  // `<blue:blueSource adtcore:type="DRUL/DRL">`; .../source/main → 200, real
  // `DEFINE FILTER DEPENDENCY RULE demo_drul_1 ON demo_parts_1 …`.
  // Live full cycle on ZTMD_DRUL_02 ($TMP) through abapsmith 2026-09-04:
  // create with activate: false (created: true, check clean, source landed
  // on the create PUT) → rewrite with the same source (changed: false,
  // activated: true) → read back the 4-line rule → delete → NOT_FOUND.
  "DRUL/DRL": {
    label: "Dependency rule",
    write: { shape: "source" },
    // Skeleton POST .../ddic/drul/sources, Content-Type
    // application/vnd.sap.adt.ddic.drul.v1+xml — the created source is
    // empty, so the caller PUTs the DEFINE FILTER DEPENDENCY RULE text
    // afterwards. Full cycle via abap_write on A4H 2026-09-04
    // (ZTMD_DRUL_02, $TMP).
    create: {
      vendor: false,
      skeleton: {
        rootName: "blue:blueSource",
        namespace: 'xmlns:blue="http://www.sap.com/wbobj/blue"',
        contentType: "application/vnd.sap.adt.ddic.drul.v1+xml",
      },
      verified: true,
    },
    delete: true,
    activate: true,
    mediaType: "application/vnd.sap.adt.ddic.drul.v1+xml",
  },
  // No write/create — an existing BAdI implementation is edited through
  // enhancement-write.ts's specialised document PUT (ENHANCEMENT_WRITE_TYPES),
  // not this registry's generic PUT. `activate: true` lets abap_activate
  // resolve an EXISTING ENHO/XH via ACTIVATION_ONLY_TYPES below, without
  // granting abap_write/abap_delete any new reach.
  "ENHO/XH": { label: "BAdI implementation", activate: true },
  // Enhancement-only: writable but never created here (see ENHANCEABLE_TYPES
  // below).
  "ENHO/XHH": { label: "Enhancement source plug-in", write: { shape: "source" } },
  // Same reasoning as ENHO/XH above: no generic write/create, but an existing
  // spot can be activated.
  "ENHS/XS": { label: "Enhancement spot", activate: true },
  // `delete: true` live-verified 2026-08-19: create → delete →
  // independent abap_read confirming absence, clean.
  "TABL/DT": {
    label: "Database table",
    write: { shape: "source" },
    // verified: true — this create-verification sweep, 6/6 FULL_CYCLE_OK (double
    // the usual iterations, deliberately hunting the ~1-in-3 create flake
    // reported from an earlier 2026-08-18 benchmark). Did not find
    // it — honest value is `true`, not a predicted downgrade. Root cause of
    // the 2026-08-18 failures is still open (appliance state /
    // work-process exhaustion / a different name shape). If the flake
    // resurfaces, downgrade to `false` with a citation, not silently back to
    // "unverified". Full record: the git history.
    create: { vendor: true, verified: true },
    delete: true,
    activate: true,
  },
  // Same source-shape recipe as TABL/DT (vendor CreatableTypes has a
  // TABL/DS entry too, maxLen 30 not 16). `delete: true` live-verified
  // 2026-08-19, same method as TABL/DT above.
  "TABL/DS": {
    label: "Structure",
    write: { shape: "source" },
    // verified: true — create-verification sweep, 3/3 FULL_CYCLE_OK, swept in its
    // own right rather than inferred from TABL/DT sharing the recipe.
    create: { vendor: true, verified: true },
    delete: true,
    activate: true,
  },
  // ---- Properties shape: PUT the full XML descriptor to the object's OWN
  // URI (/source/main 404s for all five below, verified live). Same
  // compare-before-write/transport/journal/lock choreography as source
  // shape; see writeObject in write.ts.
  //
  // `delete: true` live-verified 2026-08-19: create → delete →
  // independent abap_read confirming absence, clean.
  "DTEL/DE": {
    label: "Data element",
    write: { shape: "properties" },
    // verified: true — this create-verification sweep, 3/3 FULL_CYCLE_OK. Issue
    // An earlier report asserted (from a 2026-08-18 benchmark) that data elements "do not
    // create at all" — did NOT reproduce; every attempt succeeded.
    create: { vendor: true, verified: true },
    delete: true,
    activate: true,
  },
  // `delete: true` live-verified 2026-08-19, same method as DTEL/DE
  // above.
  "DOMA/DD": {
    label: "Domain",
    write: { shape: "properties" },
    // verified: true — create-verification sweep, 3/3 FULL_CYCLE_OK.
    create: { vendor: true, verified: true },
    delete: true,
    activate: true,
  },
  // No vendor CreatableTypes entry at all — vendor: false routes the create
  // through write.ts's own XML POST. `delete: true` live-verified
  // 2026-08-19: row type pinned to built-in structure SYST, create →
  // delete → independent abap_read confirming absence, clean.
  "TTYP/DA": {
    label: "Table type",
    write: { shape: "properties" },
    // verified: true — create-verification sweep, 3/3 FULL_CYCLE_OK. Exercises
    // createByXml's no-skeleton branch (vendor: false, no vendor
    // CreatableTypes entry — the payload IS the create body).
    create: { vendor: false, verified: true },
    delete: true,
    activate: true,
  },
  // `activate: false` is load-bearing, not descriptive: a message class is
  // born ACTIVE with zero messages and every property PUT lands active too —
  // there is no inactive version for an activation to publish.
  //
  // `delete: true` live-verified 2026-08-19: create → delete (both
  // ok) → independent absence check. Default abap_read cannot render MSAG/N
  // at all, so verify-absent needed a follow-up `format: "raw"` read
  // (the shape this type round-trips through) to get a clean NOT_FOUND.
  "MSAG/N": {
    label: "Message class",
    write: { shape: "properties" },
    // verified: true — this create-verification sweep, run M02, 3/3 FULL_CYCLE_OK.
    // Cite M02, not the earlier M01: M01 silently made zero create attempts
    // (a harness bug — its absence-precheck never passed format: "raw" for
    // this type, so every precheck was misbucketed as "name taken" and
    // skipped; fixed at source, MSAG re-run as M02, other types' logs
    // re-checked and unaffected). An earlier report asserted message classes "do
    // not create at all" — like DTEL/DE, that did not reproduce. Full
    // record: the git history.
    create: { vendor: true, verified: true },
    delete: true,
    activate: false,
  },
  // Lock object. Server-enforced: SAP refuses Z…/Y… names outright (hence
  // namePrefixes), and create is rejected unless the body already carries a
  // non-empty <enqu:content><enqu:primaryTable> — so create can't be a
  // vendor skeleton POST followed by a PUT.
  //
  // create/delete verified 2026-09-05 on A4H (EZTMD_I30 in $TMP, table
  // T000): the root must be lowercase <enqu:lockobject> in namespace
  // http://www.sap.com/adt/ddic/enqu, not the camelCase <enqu:lockObject> /
  // http://www.sap.com/dictionary/lockobject the earlier failed attempts
  // sent. Content needs primaryTable/{tableName, lockMode} in that order;
  // omitting lockMode 400s. POST 201'd as plain application/* — no
  // mediaType override needed — and delete (LOCK/MODIFY handle, then
  // DELETE?lockHandle=…) 200'd, confirmed absent on read-back.
  "ENQU/DL": {
    label: "Lock object",
    write: { shape: "properties" },
    create: { vendor: false, verified: true },
    delete: true,
    activate: true,
    namePrefixes: ["EZ", "EY"],
  },
  // DEVC/K is created by abapCreatePackage (src/tools/write.ts), a separate
  // code path that never touches createNewObject or this gate at all
  // (routed the same way VIEW/DV/TRAN/T bypass to the classrun bridge) — so
  // VERIFIED_CREATABLE_TYPES never gates package creation either way.
  // `verified: true` is live evidence: a LOCAL root package created over
  // ADT REST landed on A4H 2026-09-04, was read back, was searchable, and
  // was deleted through abapsmith.
  //
  // `create` covers only software_component=LOCAL, over ADT REST; the
  // TRANSPORTABLE route is `bridgeCreate` below, coexisting deliberately
  //
  "DEVC/K": {
    label: "Package",
    create: { vendor: true, verified: true },
    bridgeCreate: {
      adtRest:
        "POST /sap/bc/adt/packages is NOT 405 here — it is still how a LOCAL package is created " +
        "(software_component=LOCAL, the create above). What is unreachable over REST is a " +
        "TRANSPORTABLE one, and the blocker is abapsmith's own pre-flight, not SAP's: preflightCorr " +
        "(src/adt/write.ts) asks CTS transportchecks whether the object needs a request, and CTS " +
        "answers 'local' for a package that does not exist yet because it has nothing to classify — " +
        "so the 'did we get a transport?' guard can never be satisfied and the caller's corr_nr is " +
        "never consulted. Verified live on A4H for a root package and for a sub-package under a " +
        "real transportable parent; byte-identical refusal in both cases, with a valid modifiable " +
        "request in the arguments. The guard itself is not wrong to exist: POSTing a " +
        "transportable package with no request makes SAP answer 200 and silently fabricate one.",
      via:
        "CL_PACKAGE_FACTORY=>CREATE_NEW_PACKAGE, then lo_package->save( i_transport_request = ... ) " +
        "— SE21's own backend — called from a generated IF_OO_ADT_CLASSRUN bridge. A superpackage " +
        "is attached in a SECOND step (LOAD_PACKAGE / SET_SUPER_PACKAGE_NAME / SAVE): " +
        "SCOMPKDTLN carries no usable superpackage field on create, and its PDEVCLASS is the " +
        "transport LAYER, not the parent. See src/adt/package-create.ts and src/adt/ddic-bridge.ts.",
      limits:
        "Transportable packages (any software_component other than LOCAL) go through the bridge; " +
        "LOCAL packages go through REST. Development packages only (PACKTYPE 'D'). A package " +
        "created here can be deleted by abapsmith, but only while empty. The gate judges a package " +
        "create by its superpackage; a root create (no `package`) needs the `*` wildcard in " +
        "ABAP_ALLOW_PACKAGES.",
      alongsideRestCreate:
        "software_component — LOCAL is created over ADT REST, anything else through the bridge.",
    },
    // No alongsideRestDelete counterpart to alongsideRestCreate: create
    // genuinely has two routes (LOCAL over REST, transportable over the
    // bridge); delete has exactly one, for both.
    bridgeDelete: {
      adtRest:
        "There is no ADT REST delete route for a package at all — not a 405 on a verb that " +
        "exists for other reasons, simply nothing to call, for either a LOCAL or a transportable " +
        "package.",
      via:
        "CL_PACKAGE_FACTORY=>LOAD_PACKAGE, then lo_package->set_changeable( abap_true ), " +
        "lo_package->delete( ), lo_package->save( i_transport_request = ... ) — SE21's own backend " +
        "— called from a generated IF_OO_ADT_CLASSRUN bridge. See src/adt/package-delete.ts and " +
        "src/adt/ddic-bridge.ts.",
      limits:
        "Deletes only an EMPTY package: no TADIR objects (its own R3TR DEVC row doesn't count) " +
        "and no sub-packages. A non-empty package is refused, listing what's inside — abapsmith " +
        "never deletes contents for you. A transportable package needs corr_nr; a LOCAL one does " +
        "not. Success is proven by re-reading TDEVC after COMMIT WORK, not by a clean return alone.",
    },
  },
  // RAP service binding. Properties-shape like DTEL/DOMA/TTYP/MSAG/ENQU: no
  // /source/main, the whole object is one XML document at its own URI.
  //
  // PROVENANCE WARNING, RESOLVED: an earlier claimed raw-probe run and a
  // separately-reported "service bindings don't exist on this release" both
  // sat on record and could not both be true. Resolved by a later
  // independent live verification through abapsmith's own v1 tool surface
  // (2026-08-18, A4H SAP_BASIS 754 SP0007): create, activate, read-back and
  // delete all succeeded, and the create-body XML shape round-tripped on
  // read-back (not merely accepted). NOT confirmed by that run: the
  // 26-character name-limit boundary, and publish/OData-service-generation
  // (deliberately out of scope). Full run evidence:
  // the git history.
  //
  // `create.vendor: false`, despite abap-adt-api's CreatableTypes having an
  // SRVB/SVB row: its createBody() dispatches to createBodyBinding(), which
  // throws unless the caller passes service/bindingtype fields
  // createNewObject never sends. Reuses the vendor: false route (createByXml
  // POSTs the caller's own complete XML document) instead of teaching
  // createNewObject a fifth options shape — see test/write.test.ts's SRVB
  // create-body fixture.
  //
  // `mediaType` is the one field no other properties-shape type sets (see
  // its doc comment above) — only OData V2 exists on this release
  // (/businessservices/bindings/bindingtypes returns exactly two ODATA/V2
  // entries); there is no V4 to offer.
  //
  // `namePrefixes` NOT overridden: no ENQU-style foreign-namespace rule, and
  // vendor CreatableTypes already gives it maxLen 26. NOT re-tested by the
  // 2026-08-19 delete pass — the 2026-08-18 run above already met that
  // bar.
  "SRVB/SVB": {
    label: "Service binding",
    write: { shape: "properties" },
    // verified: true rests on the pre-existing 2026-08-18 citation above
    // (dedicated, independently-corroborated create verification, same bar
    // DDLX/EX/SRVD/SRV meet). the create-verification sweep deliberately did NOT re-create
    // this type — bar already met, and a fresh binding risks a leftover.
    create: { vendor: false, verified: true },
    delete: true,
    activate: true,
    mediaType: "application/vnd.sap.adt.businessservices.servicebinding.v1+xml",
  },
  // Not in types.ts — see the module doc.
  "SHLP/DH": {
    label: "Search help",
    unsupported: {
      reason:
        "Search helps are not reachable over ADT on this release — every read and write " +
        "attempt against /sap/bc/adt/ddic/searchhelps/... 404s, verified by recon.",
      alternative:
        "There is no ADT-reachable substitute for a classic search help. If the goal is " +
        "value-help logic, consider a CDS view (DDLS/DF, writable here) with a value-help " +
        "annotation instead.",
    },
  },
  "VIEW/DV": {
    label: "Classic view",
    bridgeCreate: {
      adtRest:
        "ADT's REST surface is GET-only for classic (non-CDS) views: /sap/bc/adt/ddic/views/... " +
        "returns 405 ExceptionMethodNotSupported on every mutating verb, and the discovery " +
        "collection advertises an empty <app:accept>. That GET is not a route a caller can " +
        "take from here: with no collection there is nothing to resolve a name against, and " +
        "abap_search rejects VIEW/DV as an unrecognised type, so there is no way to read a " +
        "classic view through abapsmith either. Four independent recons agree. This entry " +
        "previously read 'not reachable over ADT, every read and write 404s' " +
        "and concluded the type was unwritable — the REST finding is right, the conclusion was " +
        "not: SE11 does not use REST either.",
      via:
        "DDIF_VIEW_PUT then DDIF_VIEW_ACTIVATE (function group SDIC — the same DD_VIEW_EXPAND/" +
        "DD_VIEW_PUT/DD_VIEW_ACT primitives SE11's view editor drives), called from a generated " +
        "IF_OO_ADT_CLASSRUN bridge. See src/adt/view-create.ts and src/adt/ddic-bridge.ts.",
      limits:
        "The bridge builds a database view (DD25V view class 'D') projecting fields of exactly " +
        "ONE base table. Multi-table joins (DD28J), selection conditions (DD28V) and " +
        "search-help attachments (DD35V/DD36M) are not exposed. NO SE54 table-maintenance " +
        "dialog is generated: VIEW_MAINTENANCE_GENERATE is a SET PARAMETER + CALL TRANSACTION " +
        "'SE55' wrapper around an interactive wizard with no headless equivalent, so a view " +
        "created here has no maintenance view/dialog and SM30 will not open it. The bridge " +
        "creates and deletes only — changing an existing view is not supported. Whether " +
        "DDIF_VIEW_PUT would behave as an upsert against a view that already exists is " +
        "inferred, not live-verified: no create-over-an-existing-view call has ever been " +
        "attempted here. The create is proven live on A4H: 2026-09-04, into the TRANSPORTABLE " +
        "a transportable package with a corr_nr, produced VIEW-REGISTERED / VIEW-PUT / " +
        "VIEW-ACTIVATED, the view read back with its fields (not through abap_read — that path " +
        "stays closed, see adtRest above), and a TADIR row; 2026-09-05, RS_CORR_INSERT " +
        "called for a LOCAL (`$`-prefixed) package with korrnum = space and the 44-character " +
        "DICT object key returned sy-subrc 0 and wrote a TADIR row under that package's `$` " +
        "devclass, and the created view was then removed cleanly by the delete bridge (see " +
        "bridgeDelete below). A TRANSPORTABLE package resolves a transport request the same way " +
        "a DEVC/K create does: preflightPackageCorr (src/adt/write.ts) hands off to " +
        "SessionTransport.resolveForNewTransportable, honouring the caller's corr_nr when given " +
        "or else picking or creating one under the ABAP_ALLOW_TRANSPORTS policy (a pinned TRKORR " +
        "from the list, or a fresh request when the policy is `*`/AUTO), gate-judged before the " +
        "bridge runs. The resolver's own refusals surface as TRANSPORT_ERROR (policy disabled, " +
        "or no usable request), TRANSPORT_LOCKED (a request pinned elsewhere), or BAD_INPUT (a " +
        "malformed number). A LOCAL package still refuses a corr_nr (BAD_INPUT). Registering the " +
        "view in TADIR either way — with the caller's corr_nr " +
        "or with korrnum = space — is what makes the created view deletable afterwards. See " +
        "src/adt/view-create.ts. The create is otherwise irreversible in the sense that " +
        "abapsmith cannot read the view back to verify it: success is proven by the transcript " +
        "markers, not by a read-back.",
    },
    bridgeDelete: {
      adtRest:
        "Same finding as bridgeCreate: ADT's REST surface is GET-only for classic views, 405 " +
        "ExceptionMethodNotSupported on every mutating verb — there is no REST delete route either.",
      via:
        "DD_OBJ_DEL (object_type='VIEW', del_state='A' then 'N') clears DD25L, then " +
        "TR_TADIR_INTERFACE (wi_delete_tadir_entry='X', wi_test_modus=space) clears the TADIR " +
        "row — both called from a generated IF_OO_ADT_CLASSRUN bridge. Success is proven by " +
        "re-reading DD25L and TADIR after COMMIT WORK, not by a clean FM return alone. See " +
        "src/adt/view-delete.ts and src/adt/ddic-bridge.ts.",
      limits:
        "DDIF_VIEW_DELETE, the route this bridge used before, was live-disproven on A4H " +
        "2026-09-04: the function does not exist on this system (CHECK_FAILED). The DD_OBJ_DEL " +
        "route is measured, not exhaustively verified — RS_DD_DELETE_OBJ, the obvious " +
        "alternative, opens a CTS dialog and short-dumps headless, so it is deliberately not " +
        "used. The TADIR row is removed by a SEPARATE call from the DD25L delete: under an " +
        "open transport-request lock on the object, TR_TADIR_INTERFACE's TADIR delete fails " +
        "sy-subrc=1 / TR022, and abapsmith does NOT clear that lock (TRINT_READ_REQUEST / " +
        "TR_DELETE_COMM_OBJECT_KEYS is out of scope, deliberately unimplemented) — so a locked " +
        "view loses its DD25L rows but keeps its TADIR row. No corrNr is accepted " +
        "(src/tools/write.ts refuses one outright), so this path cannot fully remove a view " +
        "sitting on an open transport request. abapsmith's own create now registers every view " +
        "in TADIR, including one in a `$` package, so the delete path acts on views abapsmith " +
        "created — proven live on A4H 2026-09-05, where a bridge-created view in a LOCAL " +
        "package was deleted with VIEW-DELETED / VIEW-GONE.",
    },
  },
  "TRAN/T": {
    label: "Transaction",
    bridgeCreate: {
      adtRest:
        "ADT exposes a transaction read-only through the generic VIT bridge and returns 405 " +
        "ExceptionMethodNotSupported on every mutating verb; there is no writable ADT " +
        "collection for TRAN/T. (The ADT type code is TRAN/T, not TSTC — TSTC is the " +
        "underlying database table, not an ADT object type.)",
      via:
        "RPY_TRANSACTION_INSERT (function group SEUA) — SE93's own backend: it collision-checks " +
        "TSTC, runs RS_ACCESS_PERMISSION, fires the SWBM_C_OP_CREATE BAdI check, calls " +
        "RS_CORR_INSERT for transport/TADIR registration, then inserts TSTC/TSTCT/TSTCC. Called " +
        "from a generated IF_OO_ADT_CLASSRUN bridge — see src/adt/tran-create.ts.",
      limits:
        "Creates a REPORT transaction (dynpro 1000) that starts an EXISTING program the caller " +
        "names; the program is not created or checked for existence here. Dialog, parameter, " +
        "variant and OO transactions, and a caller-chosen dynpro number, are not exposed. " +
        "Changing an existing transaction is still not supported: abapsmith " +
        "implements no update route for TRAN/T — the bridge implements create and delete only. " +
        "Whether function group SEUA offers any change FM at all — and whether SE93's own edit " +
        "path uses one — is unknown; that has never been investigated here, so this is a " +
        "statement about what abapsmith implements, not a claim that the backend itself would " +
        "refuse a change: unverified. Deleting one is " +
        "attempted through a bridge whose delete FM parameter set is inferred (live-verified " +
        "once for a $ package) — see this type's bridgeDelete entry below. A transportable package " +
        "requires corr_nr (TRANSPORT_ERROR without one); a $ package refuses one (BAD_INPUT) " +
        "and registers with korrnum = space. RPY_TRANSACTION_INSERT's signature was read live " +
        "on A4H 2026-09-05: transport_number is optional and is forwarded verbatim to " +
        "RS_CORR_INSERT as korrnum, and suppress_corr_insert defaults to space, so the " +
        "transport/TADIR registration always runs. No live create with a transport has been " +
        "run yet.",
    },
    bridgeDelete: {
      adtRest:
        "Read-only through the generic VIT bridge, same as bridgeCreate: 405 " +
        "ExceptionMethodNotSupported on every mutating verb, no writable ADT collection.",
      via:
        "RPY_TRANSACTION_DELETE (function group SEUA — SE93's own backend), called from a " +
        "generated IF_OO_ADT_CLASSRUN bridge. Success is proven by re-reading TSTC, not by a " +
        "clean FM return alone. See src/adt/tran-delete.ts and src/adt/ddic-bridge.ts.",
      limits:
        "RPY_TRANSACTION_DELETE's parameter set is inferred from RPY_TRANSACTION_INSERT's " +
        "`transaction` parameter name, not transcribed from a capture of the delete FM itself. " +
        "Live-verified once, 2026-09-05: a $ package transaction was created and then deleted " +
        "with TRAN-DELETED / TRAN-GONE and a post-delete re-read proving absence. " +
        "This bridgeCreate entry's own `via` already records that " +
        "RPY_TRANSACTION_INSERT calls RS_CORR_INSERT for transport/TADIR registration; whether " +
        "RPY_TRANSACTION_DELETE does the same is unknown, so deleting a transaction out of a " +
        "TRANSPORTABLE package may plausibly hit a headless-dynpro failure the way " +
        "VIEW/DV create originally did, before suppress_dialog fixed it there. No transport " +
        "handling is attempted here either way.",
    },
  },
  // Not in types.ts — see the module doc. Program subobjects (not standalone
  // ADT types), reachable read-only via the generic VIT bridge (content-free
  // metadata stub, no layout/field list), 405 on every write verb. Verified live.
  "PROG/PS": {
    label: "Screen (dynpro)",
    unsupported: {
      reason:
        "Screens are program subobjects maintained in the classic Screen Painter (SE51) and " +
        "are not reachable as ADT-writable objects on this release: no ADT discovery " +
        "collection exists for them, PROG/PS is not a registered ADT object type " +
        "(repository/informationsystem/objecttypes has no entry for it), and the only route " +
        "that answers a GET at all — the generic VIT bridge — returns a five-field metadata " +
        "stub (name/description/package/dates, no field list or layout) and a 405 Method Not " +
        "Allowed on every write verb, verified live with a valid CSRF token.",
      alternative:
        "Screens can only be edited in SE51 (or SE80's Screen Painter), both SAPGUI tools " +
        "outside abapsmith's reach. What abapsmith CAN edit: the screen's flow logic (PBO/PAI " +
        "modules) — these are ordinary ABAP code living in the program's own source and are " +
        "already writable as PROG/P.",
    },
  },
  "PROG/PC": {
    label: "GUI status (CUA status)",
    unsupported: {
      reason:
        "GUI statuses (function-key/menu/toolbar assignments) are program subobjects " +
        "maintained in the classic Menu Painter (SE41) and are not reachable as ADT-writable " +
        "objects on this release: no ADT discovery collection exists for them, PROG/PC is not " +
        "a registered ADT object type, and the only route that answers a GET at all — the " +
        "generic VIT bridge — returns a five-field metadata stub (no function-key list, no " +
        "menu structure) and a 405 Method Not Allowed on every write verb, verified live with " +
        "a valid CSRF token.",
      alternative:
        "GUI statuses can only be edited in SE41 (or SE80's Menu Painter), both SAPGUI tools " +
        "outside abapsmith's reach. What abapsmith CAN edit: the PAI module that reads sy-ucomm " +
        "for this status's function codes — that is ordinary ABAP code already writable as " +
        "PROG/P.",
    },
  },
  // Third member of the PROG/PS/PROG/PC family — see the module doc. A GUI
  // title (SET TITLEBAR) is also SE41/Menu-Painter territory. Its VIT bridge
  // is even less trustworthy as a "read": it returns 200 for ANY key,
  // including a nonexistent title id or even a nonexistent PROGRAM name
  // (live-verified) — it echoes the key back rather than validating
  // existence. Write verbs 405, identical to PS/PC.
  "PROG/PT": {
    label: "GUI title (titlebar)",
    unsupported: {
      reason:
        "GUI titles (SET TITLEBAR text) are program subobjects maintained in the classic Menu " +
        "Painter (SE41) and are not reachable as ADT-writable objects on this release: no ADT " +
        "discovery collection exists for them, PROG/PT is not a registered ADT object type, and " +
        "the only route that answers a GET at all — the generic VIT bridge — returns a " +
        "content-free stub for ANY key, including nonexistent title ids and even nonexistent " +
        "program names (it does not validate existence, only echoes the requested key), and a " +
        "405 Method Not Allowed on every write verb, verified live with a valid CSRF token.",
      alternative:
        "GUI titles can only be edited in SE41 (or SE80's Menu Painter), both SAPGUI tools " +
        "outside abapsmith's reach. There is no ABAP-code equivalent to fall back on the way " +
        "PROG/PS and PROG/PC have their flow-logic/PAI-module escape hatch — SET TITLEBAR just " +
        "names a titlebar id, it does not carry the title text itself.",
    },
  },
  // Not in types.ts — see the module doc. A different shape of gap from
  // PROG/PS/PC/PT: SUSO/B IS a registered ADT object type (confirmed live)
  // but has no discovery collection and no writable route. Established by
  // live reconnaissance against a real system.
  "SUSO/B": {
    label: "Authorization object",
    unsupported: {
      reason:
        "Authorization objects have no ADT-writable collection on this release: no discovery " +
        "collection is advertised for them (aps/iam/suso, security/authorizationobjects and " +
        "ddic/authorizationobjects all 404), and the vendor-table-derived creation path " +
        "(aps/iam/suso, from abap-adt-api's CreatableTypes) 404s outright too — there is no " +
        "writable ADT collection to target, live-verified, not merely undocumented. The only " +
        "route that answers a GET at all is the generic VIT bridge " +
        "(vit/wb/object_type/susob/object_name/{NAME}), and it returns a basic-properties stub " +
        "only — name, description, language, responsible, package — with no field list and no " +
        "permission values, so it is not a usable read of the object's actual content, the same " +
        "class of stub that keeps PROG/PS and PROG/PC unsupported. Unlike PROG/PT's stub, it " +
        "does distinguish a real object from a nonexistent one by content (a real object's stub " +
        "carries a non-empty description; a name guaranteed not to exist gets a bare four-field " +
        "echo with none of the enriched attributes — packageRef is a separate TADIR-registration " +
        "signal, not an existence one) — but that still falls short of an actual read. " +
        "OPTIONS on the same URI answers 400 'HTTP method OPTIONS not supported', so even " +
        "write-feasibility-by-Allow-header could not be checked. Verified live against the " +
        "real objects S_TCODE and S_DEVELOP plus a name guaranteed not to exist.",
      alternative:
        "Authorization objects can only be created and edited in SU21, a SAPGUI transaction " +
        "outside abapsmith's reach. There is no ABAP-code equivalent to fall back on.",
    },
  },
  // Not in types.ts — see the module doc. Type code chosen deliberately:
  // `TABL/DI` is the code callers actually reach for, and the one consistent
  // with this registry's own `TABL/DT`/`TABL/DS`; the transport-layer name
  // for an index (LIMU INDX) is deliberately not used here, for the same
  // reason TRAN/T's entry refuses to conflate the ADT type code with the
  // underlying table name TSTC. Was `unsupported` (no probed ADT resource at
  // all) until a live probe on A4H 2026-09-05 found the REST route
  // conclusively absent and a working classrun-bridge route instead — see
  // bridgeCreate/bridgeDelete below.
  "TABL/DI": {
    label: "Table secondary index",
    bridgeCreate: {
      adtRest:
        "Probed live on A4H 2026-09-05: GET /sap/bc/adt/ddic/tables/t000/indexes 404s, and " +
        "PUT /sap/bc/adt/ddic/tables/t000/indexes/z01 404s for any body and any content type — " +
        "there is no writable (or even readable) index collection under a table. The table XML " +
        "itself (application/vnd.sap.adt.tables.v2+xml) carries exactly one index-related link, " +
        "rel=\"http://www.sap.com/adt/relations/indexes\" pointing at " +
        "/sap/bc/adt/vit/wb/object_type/tabldt/object_name/<TABLE>#view=INDX with " +
        "type=\"application/vnd.sap.sapgui\" — a GUI handoff (SE11's Indexes tab), not a REST " +
        "resource. No discovery collection mentions indexes either.",
      via:
        "DD_INDEX_INTERFACE (function group SDBT, package SDIC), ACTION='I', called from a " +
        "generated IF_OO_ADT_CLASSRUN bridge (ZCL_ZMCP_DDIC_CINDX). Success is proven by " +
        "re-reading DD12V (AS4LOCAL='A') and DD17S after COMMIT WORK, not by ACTFAILED alone — " +
        "the same read-back-after-commit discipline VIEW/DV and TRAN/T use in place of an " +
        "ADT read. See src/adt/index-create.ts and src/adt/ddic-bridge.ts. Proven live on A4H " +
        "2026-09-05, local $TMP package: a NON-UNIQUE single-field index created through this " +
        "bridge came back INDEX-CREATED / INDEX-ACTIVE / INDEX-FIELDS from that genuine " +
        "post-commit DD12V/DD17S re-read. Round 3 (same date) re-ran both creates — " +
        "non-unique Z01 and unique Z02 with MANDT — and each again returned all three " +
        "markers; the round-3 delete-path defect below never touched create.",
      limits:
        "Changing or updating an existing index is not supported: the bridge creates and " +
        "deletes only, the same as VIEW/DV and TRAN/T — drop the index (bridgeDelete) and " +
        "recreate it instead. There is no abap_read route for TABL/DI, per adtRest above. A " +
        "unique create over two non-client fields of a client-dependent table returned " +
        "ACTFAILED='X' live on A4H 2026-09-05; the client-field cause, then only suspected, " +
        "is now CONFIRMED live (A4H, second round, 2026-09-05): a unique create that " +
        "included the base table's client field (MANDT) returned INDEX-CREATED / " +
        "INDEX-ACTIVE / INDEX-FIELDS, and the identical create omitting MANDT was refused " +
        "BAD_INPUT by the DD03L (DATATYPE='CLNT') guard before DD_INDEX_INTERFACE was ever " +
        "called — raw line \"unique index Z02 on ZTMD_I28_T omits the client field MANDT\", " +
        "hint \"Add ZTMD_I28_T's client field to index_fields, or create Z02 without " +
        "index_unique.\" The package is not the caller's to choose: an index is DDIC " +
        "content of its base table and belongs to the base table's package, so abap_write " +
        "reads the base table's own ADT resource and gates on THAT package — a " +
        "caller-supplied `package` is only ever checked for agreement, never trusted. The " +
        "transport pairing itself mirrors VIEW/DV's: a `$` package sets " +
        "NO_TRANSP_REQUEST='X' and refuses a caller-supplied corr_nr, a transportable " +
        "package REQUIRES corr_nr, passed through as TRANSPORT_NUMBER — unexercised live " +
        "in either direction. The create is not journalled — there is no ADT resource to capture " +
        "a before-image from, and none existed before this create by definition — so reversal " +
        "is `mode: \"delete\"`, not undo.",
    },
    bridgeDelete: {
      adtRest: "Same finding as bridgeCreate: no writable or readable index collection exists under a table.",
      via:
        "DD_INDEX_INTERFACE (function group SDBT), ACTION='D', called from a generated " +
        "IF_OO_ADT_CLASSRUN bridge (ZCL_ZMCP_DDIC_DINDX). Success is proven by re-reading " +
        "DD12V/DD17S after COMMIT WORK, not by a clean FM return alone. See " +
        "src/adt/index-create.ts and src/adt/ddic-bridge.ts. The bridge's own DD12V pre-check " +
        "is proven live, A4H 2026-09-05: a delete aimed at a nonexistent index returned " +
        "NOT_FOUND correctly, before ever calling the FM. Round 1's defect — the generated " +
        "ABAP omitted DD_INDEX_INTERFACE's mandatory TABLES parameter INDEX_FIELDS — is " +
        "fixed and deployed: confirmed live, A4H 2026-09-05, the class body of " +
        "ZCL_ZMCP_DDIC_DINDX now carries the TABLES clause. Round 2 (same date) found a " +
        "second defect: ACTION='D' reports ACTFAILED='X' even when the delete already took " +
        "effect — the failure message's own DD12V read showed zero rows for the pair, and " +
        "an immediate re-delete returned NOT_FOUND. The fragment treated ACTFAILED as fatal " +
        "and returned before COMMIT WORK, so a real delete was reported CHECK_FAILED and " +
        "never recorded. The fix written for round 2 — commit regardless, re-read " +
        "DD12V (unfiltered and AS4LOCAL='A') and DD17S, and report success (tagging the " +
        "transcript INDEX-DELETED-ACTFAILED) only when all three come back empty — never " +
        "ran: round 3 found its own added ACTFAILED note line rendered as a " +
        "272-character ABAP source line (292 at the longest legal names), over the " +
        "255-character class-source limit, so every TABL/DI delete failed the " +
        "class-source PUT itself (ADT_ERROR / TooLongLine, SEDI_ADT15, line 65 of " +
        "ZCL_ZMCP_DDIC_DINDX) before DD_INDEX_INTERFACE was ever called — the bridge " +
        "class was never refreshed and stayed on its round-2 body. The " +
        "ACTFAILED-tolerant read-back above had therefore never executed live before " +
        "round 4. Round 4 fixes the generator two ways: this fragment's two long messages " +
        "are now built up in a string variable across several short source lines and " +
        "written once, so no generated line can exceed 255 for any legal name; and " +
        "ddicBridgeSource — the single point every bridge class body is assembled " +
        "through — now throws CHECK_FAILED before returning if any line exceeds 255, " +
        "naming the line and its length, so this defect class cannot reach the server " +
        "again from any bridge. Round 4 then ran live on A4H 2026-09-05, $TMP: the " +
        "non-unique Z01 and the unique-with-client-field Z02 were each deleted with " +
        "INDEX-DELETED-ACTFAILED / INDEX-DELETED / INDEX-GONE, a re-delete of Z02 " +
        "returned NOT_FOUND from the DD12V pre-check, and the deployed ZCL_ZMCP_DDIC_DINDX " +
        "body read back with the new read-back variable and no line over 255. So the " +
        "ACTFAILED-tolerant read-back is live-proven; ACTFAILED='X' was set on both " +
        "deletes while all three read-backs came back empty, so what the flag itself " +
        "means is still not established, only that it does not mean the rows survived.",
      limits:
        "The bridge deletes any index it finds in DD12V for the given table by name — it checks " +
        "only DD12V/indexname, not provenance, so this is not restricted to indexes the bridge " +
        "itself created. Deleting the BASE TABLE is not itself blocked by an index still on " +
        "it — live-proven on A4H 2026-09-05, the table delete succeeded with an index in " +
        "place — but abapsmith cannot confirm the index went with it: no ADT resource can " +
        "read an index back, per adtRest above, so a table delete's effect on its indexes is " +
        "unverifiable either way. Same package rule as bridgeCreate: the base table's " +
        "package, never the caller's. Unlike the VIEW/DV and TRAN/T deletes, which refuse a " +
        "caller's corr_nr outright, a TABL/DI DELETE takes the same transport pair the create " +
        "does — a `$` package sets NO_TRANSP_REQUEST='X' and refuses corr_nr, a transportable " +
        "package REQUIRES corr_nr as TRANSPORT_NUMBER — because DD_INDEX_INTERFACE with " +
        "ACTION='D' does. Round 3's cleanup deleted the base table while Z01/Z02's own " +
        "DD12V/DD17S rows may still have existed; whether the base-table delete cascaded " +
        "them away or orphaned them is unverified, not confirmed-absent — there is no ADT " +
        "resource for TABL/DI to check with, and abap_data_preview was confirmed live to " +
        "carry no WHERE filter, so a targeted DD12V check was not practical.",
    },
  },
};

const CODES = Object.keys(REGISTRY) as TypeCode[];

/**
 * Look up a type's capabilities by exact ADT code, or by the kind form
 * (`CLAS`, `STRU`, ...) resolved to its canonical code through `specForType`
 * (case/whitespace-insensitive). `undefined` when neither names a type this
 * registry knows.
 */
export function capabilitiesFor(type: string | undefined): TypeCapabilities | undefined {
  if (!type) return undefined;
  const code = type.trim().toUpperCase();
  if (Object.prototype.hasOwnProperty.call(REGISTRY, code)) return REGISTRY[code as TypeCode];
  // Kind forms ("CLAS", "STRU") resolve through the map specForType owns, never by guessing a suffix.
  const canonical = specForType(code)?.type;
  return canonical !== undefined && Object.prototype.hasOwnProperty.call(REGISTRY, canonical)
    ? REGISTRY[canonical as TypeCode]
    : undefined;
}

function codesWith(pred: (c: TypeCapabilities) => boolean): string[] {
  return CODES.filter((c) => pred(REGISTRY[c]));
}

/**
 * Types an EXISTING object of which can be written AND newly created.
 * Deliberately excludes `ENHO/XHH` (write, no create — see
 * {@link ENHANCEABLE_TYPES}).
 */
export const WRITABLE_TYPES: readonly string[] = codesWith((c) => c.write !== undefined && c.create !== undefined);

/**
 * Types that can be CREATED but never rewritten or activated (`DEVC/K`, a
 * package has no source) — `write === undefined` only, says nothing about
 * delete. `DEVC/K` is in this set AND separately deletable via
 * `bridgeDelete` (see {@link BRIDGE_DELETABLE_TYPES}); check `delete`/
 * `bridgeDelete`, not membership here, for whether a type can be removed.
 */
export const CREATE_ONLY_TYPES: readonly string[] = codesWith((c) => c.create !== undefined && c.write === undefined);

/**
 * Everything `resolveWriteTarget` will resolve a CREATE target for —
 * `WRITABLE_TYPES ∪ CREATE_ONLY_TYPES`. Deliberately stays as broad as
 * `c.create !== undefined`, unfiltered by the `verified` tri-state, even
 * after the create-verification sweep added {@link VERIFIED_CREATABLE_TYPES} below: this set
 * also drives whether an EXISTING object of the type can be EDITED (create
 * and edit share the `resolveWriteTarget` code path — an existing object
 * just skips `createNewObject`), so narrowing it to `verified === true`
 * would additionally block editing already-existing `DTEL/DE`/`MSAG/N`/
 * `TABL/DT` objects — a much worse regression than that sweep is fixing.
 * `VERIFIED_CREATABLE_TYPES` is the narrow set a create-specific gate should
 * read instead.
 */
export const CREATABLE_TYPES: readonly string[] = codesWith((c) => c.create !== undefined);

/**
 * Types declaring `bridgeCreate` — `VIEW/DV`, `TRAN/T`, `TABL/DI`, `DEVC/K`.
 * NOT a subset of {@link CREATABLE_TYPES}; `DEVC/K` also has a REST `create`
 * (LOCAL only) — see {@link BRIDGE_ONLY_CREATE_TYPES} for the rest.
 */
export const BRIDGE_CREATABLE_TYPES: readonly string[] = codesWith((c) => c.bridgeCreate !== undefined);

/**
 * True for a type declaring `bridgeCreate` at all (`VIEW/DV`, `TRAN/T`,
 * `TABL/DI`, `DEVC/K`) — not "only the bridge can create it": `DEVC/K` also
 * has a REST `create`. Use {@link isBridgeOnlyCreateType} when that
 * distinction matters.
 */
export function isBridgeCreatableType(type: string | undefined): boolean {
  const cap = capabilitiesFor(type);
  return cap?.bridgeCreate !== undefined;
}

/**
 * Types whose ONLY create route is the bridge — `VIEW/DV`, `TRAN/T`,
 * `TABL/DI`. Excludes `DEVC/K`: it also has a REST create (LOCAL) and its
 * own routing branch in `src/tools/write.ts`. `resolveWriteTarget` must keep
 * refusing these outright — no ADT collection exists to resolve them against.
 */
export const BRIDGE_ONLY_CREATE_TYPES: readonly string[] = codesWith(
  (c) => c.bridgeCreate !== undefined && c.create === undefined,
);

/**
 * Types that declare a bridge create abapsmith nonetheless refuses to run.
 * Empty today: VIEW/DV's create is proven live on A4H (see its REGISTRY
 * entry's `bridgeCreate.limits`) and is no longer refused. The mechanism
 * stays for the next `bridgeCreate` type that needs it — routing would still
 * send a member here to the bridge dispatcher, which is where the refusal
 * is raised, and this set exists so no hint anywhere advertises a create
 * that will never happen.
 */
export const BRIDGE_CREATE_REFUSED_TYPES: readonly string[] = codesWith(
  (c) => c.bridgeCreate?.createRefused !== undefined,
);

/** True for a type `src/tools/write.ts` must route to the generic classrun-bridge dispatcher rather than to `resolveWriteTarget`. See {@link BRIDGE_ONLY_CREATE_TYPES}. */
export function isBridgeOnlyCreateType(type: string | undefined): boolean {
  const cap = capabilitiesFor(type);
  return cap?.bridgeCreate !== undefined && cap.create === undefined;
}

/** Types declaring `bridgeDelete` (`DEVC/K`, `VIEW/DV`, `TRAN/T`) — the classrun-bridge delete route, disjoint from `DELETABLE_TYPES`. */
export const BRIDGE_DELETABLE_TYPES: readonly string[] = codesWith((c) => c.bridgeDelete !== undefined);

/** True for a type deleted via the classrun bridge rather than ADT REST. See {@link BRIDGE_DELETABLE_TYPES}. */
export function isBridgeDeletableType(type: string | undefined): boolean {
  const cap = capabilitiesFor(type);
  return cap?.bridgeDelete !== undefined;
}

/** The write-but-never-created set (name is historical, from when `ENHO/XHH` was its only member): resolvable/editable through the ordinary PUT-source path but never created here — today `ENHO/XHH` alone. */
export const ENHANCEABLE_TYPES: readonly string[] = codesWith((c) => c.write !== undefined && c.create === undefined);

/**
 * Types `abap_activate` can activate despite no write OR create capability —
 * an EXISTING `ENHO/XH` or `ENHS/XS` object (activation needs only identity
 * + the server's own package, never a write shape). Deliberately the
 * REMAINDER, not every activatable type: `WRITABLE_TYPES`/
 * `CREATE_ONLY_TYPES`/`ENHANCEABLE_TYPES` members are already trivially
 * activatable, so this set names only the types ACTIVATABLE AND NOTHING
 * ELSE. Read by `resolveWriteTarget`'s `op: "activate"` branch as an
 * addition to, not a replacement for, the other three sets.
 */
export const ACTIVATION_ONLY_TYPES: readonly string[] = codesWith(
  (c) => c.activate === true && c.write === undefined && c.create === undefined,
);

/**
 * Types `resolveWriteTarget`'s `op: "delete"` branch will resolve a DELETE
 * target for. Deliberately `c.delete === true` ONLY — a strict
 * `===` check, since `false` and `"unverified"` must both keep refusing. See
 * {@link TypeCapabilities.delete} for what backs each entry's value.
 */
export const DELETABLE_TYPES: readonly string[] = codesWith((c) => c.delete === true);

/**
 * Types a create-specific gate should resolve a CREATE target for —
 * the narrow, live-verified subset of {@link CREATABLE_TYPES}.
 * Deliberately `c.create?.verified === true` ONLY (strict `===`, since
 * `"unverified"` is itself truthy) — same refuse-until-proven discipline as
 * {@link DELETABLE_TYPES}. A separate set from `CREATABLE_TYPES` rather than
 * a narrowing of it because `create` has no `resolveWriteTarget` `op` of its
 * own to gate inside; see the module doc. Does NOT include `VIEW/DV`/
 * `TRAN/T`/`TABL/DI` — their `bridgeCreate` claims are a separate, untouched
 * field.
 */
export const VERIFIED_CREATABLE_TYPES: readonly string[] = codesWith((c) => c.create?.verified === true);

/**
 * Every type `abap_write` accepts in ANY mode — the discoverability list its
 * refusals advertise. Deliberately broader than {@link WRITABLE_TYPES} (which
 * means create-AND-write only): `WRITABLE_TYPES` alone under-reports the
 * create-only (`DEVC/K`), bridge-only-create (`VIEW/DV`, `TRAN/T`, `TABL/DI`)
 * and write-only (`ENHO/XHH`) types. Union of {@link CREATABLE_TYPES},
 * {@link BRIDGE_ONLY_CREATE_TYPES} and {@link ENHANCEABLE_TYPES}, de-duplicated
 * in REGISTRY order by construction (`DEVC/K` has both `create` and
 * `bridgeCreate` and appears once).
 */
export const ABAP_WRITE_TYPES: readonly string[] = codesWith(
  (c) => c.create !== undefined || c.bridgeCreate !== undefined || c.write !== undefined,
);

/**
 * Types `abap_read`'s `resolveObject` refuses outright on an explicit type
 * hint, before any network call — the `unsupported` entries plus the three
 * bridge-only-create types with no ADT-readable collection (`VIEW/DV`,
 * `TRAN/T`, `TABL/DI`). Mirrors the check in `src/adt/resolve.ts`.
 */
export const NON_READABLE_TYPES: readonly string[] = codesWith(
  (c) => c.unsupported !== undefined || (c.bridgeCreate !== undefined && c.create === undefined),
);

/**
 * Types no `abap_write` route reaches at all — no `create`, `bridgeCreate`,
 * `write`, nor an activate-only exception. Deliberately excludes `ENHO/XH`/
 * `ENHS/XS` (activate-only, see {@link ACTIVATION_ONLY_TYPES}). See the
 * refusal sites in `src/adt/write.ts`.
 */
export const NON_WRITABLE_TYPES: readonly string[] = codesWith(
  (c) => c.create === undefined && c.bridgeCreate === undefined && c.write === undefined && c.activate !== true,
);

/**
 * Types whose whole XML descriptor IS the write payload — the set
 * `abap_read`'s `format="raw"` answers for. Includes `SRVB/SVB`, which is
 * not DDIC, so caller-facing wording must not call this set "DDIC types".
 */
export const PROPERTIES_SHAPE_TYPES: readonly string[] = codesWith((c) => c.write?.shape === "properties");

/**
 * The one caller-facing sentence naming what `abap_write` accepts, composed
 * from the sets above so it cannot go stale — the single place both refusal
 * sites in `src/adt/write.ts` render it, so they cannot drift apart.
 */
export function writableTypesHint(): string {
  const clauses: string[] = [`Writable types are ${WRITABLE_TYPES.join(", ")}.`];
  if (CREATE_ONLY_TYPES.length) {
    clauses.push(`${CREATE_ONLY_TYPES.join(", ")} can only be created, never rewritten — no source to write.`);
  }
  // Split, not merged: a type whose bridge create is refused is still an
  // `abap_write` type (it can be deleted), but saying it "is created through
  // a bridge" would contradict the refusal it actually gets.
  const bridgeAttempted = BRIDGE_ONLY_CREATE_TYPES.filter((c) => !BRIDGE_CREATE_REFUSED_TYPES.includes(c));
  if (bridgeAttempted.length) {
    clauses.push(
      `${bridgeAttempted.join(", ")} are created through a generated classrun bridge, also with no \`source\`.`,
    );
  }
  if (BRIDGE_CREATE_REFUSED_TYPES.length) {
    clauses.push(
      `${BRIDGE_CREATE_REFUSED_TYPES.join(", ")} cannot be created here at all, in any package — only deleted.`,
    );
  }
  if (ENHANCEABLE_TYPES.length) {
    clauses.push(`${ENHANCEABLE_TYPES.join(", ")} can be edited (not created) here.`);
  }
  if (ACTIVATION_ONLY_TYPES.length) {
    clauses.push(
      `${ACTIVATION_ONLY_TYPES.join(", ")} cannot be written here but an existing one can be activated.`,
    );
  }
  return clauses.join(" ");
}

/**
 * Appended to a refusal that a REGISTRY fact produced rather than the
 * caller's payload. Paired with `retryable: false` on the same error: prose
 * survives a human read, the field survives a summarised transcript. Both
 * stop being emitted by themselves the day the entry gains the capability —
 * the gate that raises them is the registry lookup.
 */
export const TERMINAL_REFUSAL_NOTE =
  "Terminal for this object type — an identical retry cannot succeed.";

/**
 * A delete refusal that names `abap_write` itself as the limited party, not
 * the object. At least three types reaching this today (ENHO/XH, ENHO/XHH,
 * ENHS/XS) are in fact deleted live, by `abap_enh` — see
 * `doc/CAPABILITIES/object-types.md`. "cannot be deleted" would be false for
 * those three, so the refusal states a tool gap, never an object property.
 */
export function deleteUnsupportedMessage(label: string, code: string): string {
  return (
    `abap_write does not implement delete for ${label} (${code}). That is a gap in this tool's ` +
    `coverage, not a property of the object — it may still be removable by other means. ` +
    TERMINAL_REFUSAL_NOTE
  );
}

/**
 * Walk the REAL `types.ts` `TYPES` array and throw if any `.type` code has no
 * `REGISTRY` entry — closes the gap a hand-maintained `TypeCode` union can't
 * close at compile time. Runs once below at module load (a missing entry is
 * a boot-time crash, not a silent gap) and is exported for a coherence test.
 */
export function assertRegistryCoversTypes(types: readonly TypeSpec[] = TYPES): void {
  const missing = types.map((t) => t.type).filter((t) => !Object.prototype.hasOwnProperty.call(REGISTRY, t));
  if (missing.length > 0) {
    throw new Error(
      `src/adt/capabilities.ts REGISTRY is missing an entry for: ${missing.join(", ")}. ` +
        "Every type in src/adt/types.ts's TYPES array must have a capabilities registry " +
        "entry (even an empty one, { label: \"…\" }) — see src/adt/capabilities.ts.",
    );
  }
}

/**
 * No `REGISTRY` entry may declare both a capability (`write`/`create`) and
 * `unsupported` — the two are contradictory statements about the same type.
 * Runs once below at module load, and exported for a coherence test.
 *
 * Deliberately has no rule for `create.verified`: `verified` is
 * REQUIRED on `CreateCapability` (see that field's own doc), so the one
 * failure mode a check here would exist to catch — a `create` entry with no
 * stated evidence — is already impossible to compile.
 */
export function assertNoConflictingCapabilities(): void {
  for (const code of CODES) {
    const cap = REGISTRY[code];
    if (cap.unsupported && (cap.write !== undefined || cap.create !== undefined)) {
      throw new Error(
        `src/adt/capabilities.ts REGISTRY entry ${code} declares both a capability ` +
          "(write/create) and 'unsupported' — pick one.",
      );
    }
    // Same rule extended to the bridge route: `bridgeCreate` says "creatable,
    // just not over REST"; `unsupported` says "not creatable at all". Both at
    // once would leave write.ts routing to the bridge while resolveWriteTarget
    // still hands out a stale refusal (the pre-bridge state of VIEW/DV and
    // TRAN/T). That pairing stays refused unconditionally, no exception.
    //
    // `bridgeCreate` + `create` is refused UNLESS `alongsideRestCreate` names
    // the discriminator: `DEVC/K` is the one type where REST and
    // bridge both genuinely create it (LOCAL vs. transportable), so both
    // routes are needed and the discriminator is required, not optional.
    if (cap.bridgeCreate && cap.unsupported !== undefined) {
      throw new Error(
        `src/adt/capabilities.ts REGISTRY entry ${code} declares 'bridgeCreate' together with ` +
          "'unsupported' — a type is created by the classrun bridge, or not at all. Pick one.",
      );
    }
    if (cap.bridgeCreate && cap.create !== undefined && cap.bridgeCreate.alongsideRestCreate === undefined) {
      throw new Error(
        `src/adt/capabilities.ts REGISTRY entry ${code} declares 'bridgeCreate' together with ` +
          "'create' but names no bridgeCreate.alongsideRestCreate discriminator — a type is " +
          "created over REST, or by the classrun bridge, or (with a named discriminator deciding " +
          "which) both. Pick one, or name the discriminator.",
      );
    }
    // Inverse check: `alongsideRestCreate` claims a REST `create` coexists —
    // if `create` is absent, that claim is stale/wrong documentation.
    if (cap.bridgeCreate?.alongsideRestCreate !== undefined && cap.create === undefined) {
      throw new Error(
        `src/adt/capabilities.ts REGISTRY entry ${code} declares bridgeCreate.alongsideRestCreate ` +
          "but has no 'create' — the field names a REST route to coexist with, so one must exist.",
      );
    }
    // Same contradiction as bridgeCreate+unsupported above, for the delete side.
    if (cap.bridgeDelete && cap.unsupported !== undefined) {
      throw new Error(
        `src/adt/capabilities.ts REGISTRY entry ${code} declares 'bridgeDelete' together with ` +
          "'unsupported' — a type is deleted by the classrun bridge, or not at all. Pick one.",
      );
    }
    // A type is deleted exactly one way — unlike create, there is no
    // alongsideRestDelete counterpart to alongsideRestCreate: DEVC/K needed
    // that one only because create genuinely has two routes of different
    // reach (LOCAL over REST, transportable over the bridge); delete has one.
    if (cap.bridgeDelete && cap.delete === true) {
      throw new Error(
        `src/adt/capabilities.ts REGISTRY entry ${code} declares 'bridgeDelete' together with ` +
          "'delete: true' — a type is deleted over REST, or by the classrun bridge, never both.",
      );
    }
    // `vendor: false` has exactly two valid shapes (see SkeletonCreate's and
    // CreateCapability.vendor's doc comments): "properties" write shape with
    // no skeleton (payload IS the create body — TTYP/DA, ENQU/DL), or
    // "source" write shape WITH a skeleton (write.ts hand-builds the create
    // XML — BDEF/BDO, XSLT/VT). Anything else has no body to POST.
    if (cap.create?.vendor === false) {
      const shape = cap.write?.shape;
      const hasSkeleton = cap.create.skeleton !== undefined;
      const valid =
        (shape === "properties" && !hasSkeleton) || (shape === "source" && hasSkeleton);
      if (!valid) {
        throw new Error(
          `src/adt/capabilities.ts REGISTRY entry ${code} declares create.vendor: false with ` +
            `write.shape ${JSON.stringify(shape)} and create.skeleton ${hasSkeleton ? "present" : "absent"} ` +
            "— a hand-rolled create has no body to POST unless it is either a 'properties' " +
            "shape (the write payload IS the XML document) or a 'source' shape paired with " +
            "a create.skeleton (write.ts builds the XML itself).",
        );
      }
    }
    // A skeleton is only ever consulted on the vendor: false path — declaring
    // one alongside vendor: true would be silently ignored by write.ts, which
    // is confusing enough on its own to be worth refusing at load time.
    if (cap.create?.skeleton !== undefined && cap.create.vendor !== false) {
      throw new Error(
        `src/adt/capabilities.ts REGISTRY entry ${code} declares create.skeleton alongside ` +
          "create.vendor: true — the skeleton would never be read; drop one or the other.",
      );
    }
    // A per-type prefix override that admits nothing refuses everything, and
    // it would do so with a message blaming the caller's object name.
    if (cap.namePrefixes && cap.namePrefixes.filter((p) => p.trim() !== "").length === 0) {
      throw new Error(
        `src/adt/capabilities.ts REGISTRY entry ${code} declares an empty namePrefixes ` +
          "override, which would refuse every possible name for that type. Omit the field " +
          "to inherit the global list instead.",
      );
    }
    // `blankSourceOnAbsence` is a claim about the `/source/main` endpoint —
    // meaningless for a type that never reads through it.
    if (cap.blankSourceOnAbsence && cap.write?.shape !== "source") {
      throw new Error(
        `src/adt/capabilities.ts REGISTRY entry ${code} declares blankSourceOnAbsence but ` +
          `write.shape is ${JSON.stringify(cap.write?.shape)} — this only makes sense for a ` +
          'type whose write.shape is "source".',
      );
    }
  }
}

/**
 * Every type this REGISTRY declares `write:` for must be readable by
 * `abap_read` in at least one mode — otherwise "read an existing object to
 * see the exact shape" is a dead end for it, the gap MSAG/N and ENQU/DL sat
 * in until `format: "raw"` (src/tools/read.ts) was added. This is the other
 * half of that fix: without this check, a future type could gain `write:`
 * while its `types.ts` `mode`/`kind` leaves it unreadable, undiscovered
 * until a caller hit it the hard way. Runs once below at module load, and
 * exported for a coherence test.
 *
 * A type is readable if any of these hold:
 *   - `types.ts` gives it `mode: "source"` — the generic `/source/main` GET
 *     path, independent of any per-type list.
 *   - its `write.shape` is `"properties"` — `src/tools/read.ts`'s
 *     `format: "raw"` branch is gated on exactly that predicate
 *     (`capabilitiesFor(type)?.write?.shape === "properties"`), so this case
 *     is readable BY CONSTRUCTION, not by restating a second list here.
 *   - it is `mode: "ddic"` with a `write.shape` of `"source"` (today: TABL/DT,
 *     TABL/DS) — `ddic.ts`'s `ddicStrategy()` must recognise its `kind` as
 *     `"source"`-rendered, i.e. `DDIC_SOURCE_BASED`.
 *
 * If a future type fails all three, that is a real design question — does it
 * need a new `ddic.ts` renderer, a `format: "raw"` extension, or is
 * `mode: "source"` simply missing from its `types.ts` entry — not something
 * to paper over here.
 */
export function assertWritableTypesAreReadable(): void {
  const unreadable: string[] = [];
  for (const code of CODES) {
    const cap = REGISTRY[code];
    if (!cap.write) continue;
    const spec = TYPES.find((t) => t.type === code);
    if (!spec) {
      // `assertRegistryCoversTypes` only checks the reverse direction (every
      // `TYPES` entry has a `REGISTRY` entry) — guard the direction it
      // doesn't, rather than silently skipping a type this function cannot
      // actually evaluate.
      unreadable.push(`${code} (no src/adt/types.ts entry, so no read mode to check)`);
      continue;
    }
    if (spec.mode === "source") continue;
    if (cap.write.shape === "properties") continue;
    if (spec.mode === "ddic" && ddicStrategy(spec.kind) !== "unsupported") continue;
    unreadable.push(code);
  }
  if (unreadable.length > 0) {
    throw new Error(
      `src/adt/capabilities.ts REGISTRY declares write capability for types abap_read cannot ` +
        `read in ANY mode: ${unreadable.join(", ")}. Every writable type must be readable — via ` +
        'mode: "source" (types.ts), format: "raw" (write.shape "properties"), or a ddic.ts ' +
        "pseudo-DDL renderer (ddicStrategy) — or a caller is asked to write a shape it was never " +
        "shown. If this is genuinely too strong for one of these types, that must be decided " +
        "explicitly here, not left to fail silently.",
    );
  }
}

assertRegistryCoversTypes();
assertNoConflictingCapabilities();
assertWritableTypesAreReadable();
