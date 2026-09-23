# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/). It is
pre-1.0, so the usual semver caveat applies: minor versions may still contain
breaking changes to configuration or tool schemas. `0.3.0` was set in both
manifests but never tagged, so `v0.3.1` is the first tagged release. The
`0.3.1` section below therefore carries everything that landed since the
version was set to `0.3.0`, which is intended.

## [Unreleased]

### Fixed

- **`MSAG/N` create no longer reports `LOCKED` right after the object was created** (#205). The vendor create POST ran inside the stateful ADT session, and the server keeps a message class's create enqueue for the rest of that session, so the LOCK that followed was refused by our own connected user (`EU510`). Types whose registry entry carries `create.statelessPost` (today only `MSAG/N`) now send the create POST outside the stateful session, so the enqueue ends with the request; and for every created object, a LOCK right after create that is refused by the connected user's own enqueue is retried once in a fresh session (the write then reports the note "the lock was retried once in a fresh session"). A lock held by another user still surfaces `LOCKED` with `created: true`; a second write of an existing message class takes the update path (`created: false`), never `LOCKED`.
- **`abap_search mode=objects` with a bare `"*"` and a type filter could take ~19 seconds and still return no matches** (#206). The request went out untyped and fetched `max × 10` rows of mixed type for the client to re-filter, so a broad wildcard scanned far more than needed and still often missed. A typed search now asks the server for `max` plus a margin (`max + max(10, ceil(max/2))`, capped at 1000) instead of `max × 10`, and an untyped search asks for exactly `max`; the request also now carries `objectType` — the type group (e.g. `CLAS`, `FUGR`) for a name pattern, or the full sub-type (e.g. `FUGR/F`, `TABL/DS`) when the query is a bare wildcard, which the server answers in well under a second (disclosed by a `TYPE-SCOPED LISTING` note, since those rows omit description and, for some types, package) — the client-side sub-type filter stays, since the server's own sub-type filter is not exact. The quick search now runs under its own per-request timeout (see `ABAP_SEARCH_TIMEOUT_MS` below, which counts toward the session-wait sizing like the other families), and an untyped query that is empty or only wildcards (`*`, `**`, `%`) is refused `BAD_INPUT` before any request — add a `type` or a name prefix such as `Z*`. Measured on A4H: `*` + `FUGR/F` max 3 went from ~19s and 0 matches to well under a second with 3 matches.
- **A named `corr_nr` for a request created earlier in the same session was refused under `ABAP_ALLOW_TRANSPORTS=auto`** (#208). Under a list containing `auto`, any named request was refused outright regardless of which one — even a request this same session had just created, or one CTS already attributed to abapsmith for the package — so a caller that read a request back from an earlier write and named it on a later one was refused rather than honoured. A named `corr_nr` is now accepted under `auto` when it is (a) a request this session created (`abap_transport operation=create`, `abap_img_edit create_request`, or one created for a package by an earlier write in this session), or (b) on `abap_write`'s main path, a modifiable workbench request owned by the connected user carrying abapsmith's own session description for the same package — exactly the requests auto would choose itself. Anything else is still refused, and the refusal now lists the acceptable requests ("Acceptable: A4HK900200" or "none yet — omit corr_nr to have one created"). The safety gate's transport-allowlist check (check 7) takes an optional session-registry hook wired from `SessionTransport`, so a `source: "named"` request under a list containing `auto` passes only when it is pinned or in that registry; deny-all and pinned lists without `auto` are unchanged. Bridge creates (classic views, transactions, search helps, `TABL/DI`, packages) accept (a) but not (b), because their zero-wire pre-check runs before CTS is consulted.

### Added

- **`ABAP_SEARCH_TIMEOUT_MS` / `searchTimeoutMs`** (#206). Per-request HTTP timeout, ms, for `abap_search`'s repository quick search — default `60000`. Overrides `ABAP_TIMEOUT_MS` for that request family, the same pattern as `ABAP_BOPF_TIMEOUT_MS`/`ABAP_ACTIVATE_TIMEOUT_MS`/`ABAP_RUN_TIMEOUT_MS`; a timeout is reported as `TIMEOUT` naming this variable, and it counts toward the session-wait sizing alongside the other three.

## [0.6.30] - 2026-09-23

### Added

- **`abap_write` TRAN/T create gets a `kind` parameter** (#214). `kind` is `report` (default; `program`, dynpro 1000), `dialog` (`program` + `screen`, 4-digit), `parameter` (`target_transaction`, `parameters` — array of `{field, value}` — and `skip_first_screen`), `variant` (`target_transaction`, `variant`, optional `cross_client_variant`), or `oo` (`class`, `method`, optional `update_mode` S|A|L). `oo` is stored the way SE93 stores an OO transaction WITH the transaction model: a parameter transaction on `OS_APPLICATION` (`TSTCP` `/*OS_APPLICATION CLASS=...;METHOD=...;UPDATE_MODE=...;`). An OO transaction WITHOUT the transaction model (`TSTCP` `\CLASS=...\METHOD=...`, including local classes in a program) has no SAP API — `RPY_TRANSACTION_INSERT` has no OO branch — and stays read-only. The field each kind requires (`program` for report/dialog, `target_transaction` for parameter/variant, `class` for oo) is checked before the bridge runs; a missing one is refused zero-network with `BAD_INPUT` naming the field. `abap_read type=TRAN/T` now reports `KIND`, `TARGET`, `SKIP FIRST SCREEN`, the parameter list, `VARIANT`/`CROSS-CLIENT`, and `CLASS`/`METHOD`/`UPDATE MODE`/`TRANSACTION MODEL`, decoding every `TSTCP` encoding SE93 writes. `mode="update"` still retargets report transactions only. Verified on A4H: `kind=parameter` (a transaction on SM30 with `skip_first_screen`) and `kind=oo` (a class method transaction on `ZCL_AS_T201=>RUN`) created in a transportable package and read back by `abap_read` with the fields above; `kind=dialog` and `kind=variant` are covered by offline tests only.
- **`description` is optional on `abap_write` create for `TRAN/T`, `VIEW/DV`, `SHLP/DH` and the structured `ddic` types** (#209). Omitted, it now defaults to the object name for `TRAN/T`, `VIEW/DV`, `SHLP/DH`, `DOMA/DD`, `DTEL/DE` and `TTYP/DA`, and to `<TABLE> index <ID>` for `TABL/DI`; the response notes the default it used. `mode="update"` still requires a description. Verified on A4H for `TRAN/T`, `TTYP/DA` and `TABL/DI`.

### Changed

- **The `TRAN/T` description limit is now stated in the schema, and corrected to 36 characters** (#209). `TSTCT-TTEXT` is refused with `BAD_INPUT` quoting 36 — the previous code said 37. DDIC short texts stay at 60. Verified on A4H: a 37-character description is refused quoting 36.

### Fixed

- **`abap_write` TRAN/T create no longer refuses "already exists" on the VIT bridge's word alone** (#201). When the VIT stub answers 200 but TSTC has no row for the tcode, the create now proceeds — the response notes it — instead of refusing on a stub response that never actually checked TSTC. A genuine TSTC row is still refused. If `RPY_TRANSACTION_INSERT` itself refuses (e.g. `already_exist`), the server's own message is now returned as `CHECK_FAILED` with next steps: `abap_read type=TRAN/T` to see what's there, `mode="update"` to retarget, or delete then create. The same TSTC cross-check now settles the post-delete read-back: a VIT 200 with no TSTC row is reported as confirmed absent instead of unverified. The same cross-check now runs before a delete: a `TRAN/T` the VIT bridge answers 200 for but TSTC has no row for is `NOT_FOUND` (single delete) or reported as absent (batch `objects`) before any package or transport request is resolved, so a phantom delete creates no request. Verified on A4H: a create after a VIT 200 with no TSTC row proceeded, a second create of the same tcode was refused with the server's `already_exist` message, a delete of an absent tcode returned `NOT_FOUND` without a transport request, and the post-delete read-back of two deleted transactions came back verified via TSTC.
- **`abap_write` TRAN/T delete no longer breaks on the SAPLSTRD 0300 request popup in a transportable package** (#202). The delete bridge now passes the transport request to `RPY_TRANSACTION_DELETE`, registering it via `RS_CORR_INSERT` with the dialog suppressed. Without `corr_nr` the request is picked the same way a create picks it (`ABAP_ALLOW_TRANSPORTS`/the session resolver); a named `corr_nr` is honoured under the normal transport allowlist rules; a `corr_nr` on a `$TMP` transaction is refused. `VIEW/DV` delete still takes no `corr_nr` — its bridge has no transport parameter. Batch delete (`objects`) now accepts `TRAN/T` entries, each resolved and gated like a single delete, one bridge call per entry, not journalled; the other bridge-only types (`VIEW/DV`, `SHLP/DH`, `TABL/DI`) in a batch now get `BAD_INPUT` naming the entry instead of a bare `UNSUPPORTED`. `abap_journal mode=undo` of a `TRAN/T` create in a transportable package now resolves the request through the session's transport manager the same way and refuses with `TRANSPORT_ERROR` when none is wired, instead of failing on the missing `corr_nr`; this undo path is covered by offline tests only. Verified on A4H: single and batch deletes without `corr_nr` in a transportable package were recorded by CTS in the request already holding each transaction's lock.

## [0.6.29] - 2026-09-23

### Added

- **`abap_read type=TABL/DI` with a bare `<TABLE>` lists every secondary index** (#210). `abap_read {"object":"ZTAB","type":"TABL/DI"}` answers with header `object: TABL/DI ZTAB`, `indexes: N`, a `SECONDARY INDEXES` section (index, unique, status, db status, fields in position order, description) and a pseudo-DDL block with one `define index z01 on ztab { field1; field2; }` block per index. A table with no secondary index gets a definitive empty listing (`indexes: 0`, the section says so) rather than an error — DD12V answered 200 with zero rows. Read-only (`ABAP_MODE=read` suffices), two catalog SELECTs (DD12V, DD17S), same as the single-index read; `<TABLE>/<INDEX>` still renders one index exactly as before.

### Changed

- **`abap_read include=` is now `CLAS/OC`-only; every other type ignores it with a note instead of refusing `UNSUPPORTED`** (#211). `INTF/OI`, `FUGR/FF`, `PROG/P`, DDIC types and the rest proceed against the object's single document, and the response carries a `NOTE:` explaining that the object has one document and the include was ignored — the header carries no `include:` line. `INTF/OI` with `method=` and `include="definitions"` returns the method's declaration (an interface method has nothing else) with the same note, instead of the old error. `CLAS/OC` behaviour is unchanged — a non-main include still reads from its own document, and `method=` with `include="definitions"` is still the declaration-only route. `include` is still refused with `view="history"`/`"diff"`/`"footprint"`/`"docu"`/`"digest"`, on a `DEVC/K` package read, on the catalog types `SUSO/B`/`TABL/DI`, and when the object reference's own URI names a class include on a non-class.
- **`abap_read type=TABL/DI` `NOT_FOUND` for a missing index now names the table's actual index ids, and `BAD_INPUT` is narrower** (#210). `<TABLE>/<INDEX>` naming an index the table doesn't have (e.g. `ZTAB/Z09`) answers `NOT_FOUND` naming them in the message ("its secondary indexes are Z01, Z02", or "it has no secondary index at all"), carries them in `details.existing`, and hints at the bare `<TABLE>` listing. `BAD_INPUT` "is not a valid TABL/DI name" is now only for an empty part or more than one slash (`ZTAB/`, `/Z01`, `A/B/C`, empty) — no longer for a bare table name, which lists.

## [0.6.28] - 2026-09-23

### Fixed

- **A FUGR/FF create whose source PUT is rejected no longer leaves the next call `SESSION_DEAD`** (#203). The compensating DELETE ran in the stateful session and the call returned without ending it, so the vendor client kept the `sap-contextid`; the next call's existence probe of the deleted module answered 404 with `sap-contextid=0`, which the vendor client ignores on error responses, and the request after it was answered `400 ICMENOSESSION` and marked the connection dead. The rollback now ends the session with `dropSession()` right after the compensating DELETE, and a stateless request answered `400 ICMENOSESSION` inside a budgeted request is recovered by one re-logon and one resend instead of failing the call; a second consecutive one is still reported as `SESSION_DEAD`.
- **The logon-endpoint ceiling is a sliding window, not a lifetime count** (#204). A connection could reach the logon endpoint at most 5 times ever; every revival past the fifth left it permanently dead even after a long, healthy run. The ceiling is now `LOGON_CEILING_PER_WINDOW` (5) logons per sliding `LOGON_CEILING_WINDOW_MS` (10 minute) window per connection, and concurrent calls sharing one connection now share one logon via an in-flight logon promise instead of each paying for its own.

### Added

- **`LOGON_CEILING` error code** (#204). Refused locally, before any bytes are sent, when a connection's sliding-window logon budget is spent; `details.retryAfterSeconds` says how long until the next logon is allowed, and the hint names sending tool calls in parallel as the usual way to reach it. Server instructions and `doc/CONCURRENCY/session-pool-and-cost.md` now say that calls to one server share a fixed session pool and are serialized, not sped up by concurrency.

## [0.6.27] - 2026-09-23

### Added

- **`abap_rap` generates a complete RAP stack from an existing table** (#197). One call takes `table`, `package`, and either `name_prefix` (derives all six artifact names — root view, projection view, behavior class, service definition, service binding, draft table) or explicit `names` overrides, plus `flavour` (`managed`/`unmanaged`), `draft`, `service_binding_type` (`OData V2`/`V4`), `include_projection`, and `cds_form` (`entity`/`classic`, for releases before 7.55 that reject `define view entity`). Artifacts are written in dependency order through the same write path as `abap_write`, so `abap_journal mode=list` shows one entry per artifact (the behavior class is two: main and the `implementations` include) and `mode=undo` reverses any of them exactly as it would an `abap_write` entry. `dry_run` returns every generated source plus a field-coverage summary and writes nothing — the same preflight safety gate still runs, so a refusal costs zero requests either way. A real run stops at the first failing write and reports `RAP_PARTIAL` with each artifact's status (written/activated/failed/not attempted); a rerun with the same arguments writes the same names in place. Gated like every other write: needs `canWrite`, refused `READ_ONLY` on a read-only server. Verified live on A4H 2026-09-23: `dry_run` (writes: 0), a real managed/V4 run of all 8 artifacts written and activated, the binding published and its `$metadata` read back with `abap_service`, one journal entry per artifact, and every object deleted afterwards through `abap_write mode=delete`.

## [0.6.26] - 2026-09-22

### Fixed

- **`abap_write mode=delete type=DEVC/K` no longer refuses its own server-pinned request under `ABAP_ALLOW_TRANSPORTS=auto`** (#195). When CTS already held the package in a request (the usual case for a transportable package), `preflightCorr` admitted that request as auto-selected but the classic bridge's own targets gate was never told its provenance and judged it as caller-named — refusing "Transport A4HK9003xx is not permitted by ABAP_ALLOW_TRANSPORTS [auto]" for a call that named nothing. `deletePackageViaBridge` now hands the bridge the same `corrSource` the domain gate judged, exactly as the package create does; a caller-named request is still refused under `auto`. Verified live on A4H 2026-09-22 (the #185 probe package ZAS_PKG184, previously deletable only with the request pinned in the allowlist).

## [0.6.25] - 2026-09-22

### Fixed

- **`abap_img_edit` no longer treats `auto` as a blanket refusal on `corr_nr`** (#176). A request this session created — via `mode=create_request` or `abap_transport create` — is now accepted as `corr_nr` under `ABAP_ALLOW_TRANSPORTS=auto`, the same session registry (`SessionTransport`) `abap_write` already consults; any other caller-named request is still refused, and the refusal now adds "Under auto, pass a request this session created (abap_img_edit mode=create_request or abap_transport create), or omit corr_nr to let this session resolve one." With `corr_nr` omitted, the session resolves one itself instead of refusing: a client-dependent table gets the customizing request this session created earlier, or a new one (description `abapsmith customizing request <date>`); a client-independent table gets a workbench request — the session's active one, one created earlier, or a new one — because CTS refuses to record a client-independent table entry on a customizing request (TK599 "No task for editing objects can be determined", verified live 2026-09-22). The response header's `corrNrSource` (`caller` \| `session-cached` \| `session-created`) and the journal entry's `trSource` agree on which happened.
- **The CTS recording bridge now calls `TRINT_OBJECTS_CHECK_AND_INSERT` with `IV_WITH_DIALOG = 'D'`, not `TR_OBJECTS_INSERT`** (#176). `TR_OBJECTS_INSERT` hard-codes `IV_WITH_DIALOG = 'X'` and popped SAPLSTRD dynpros 0300 (request choice) / 0352 (task classification) in a classrun (`CX_SY_SEND_DYNPRO_NO_RECEIVER`) whenever the chosen request or its task needed a dialog decision — the 2026-09-06 TB004 run only succeeded because neither dialog was needed. Also fixed in the bridge: client-independent tables (no client field) are now applied at all — previously refused with "client field MANDT not found" because the DD02L client-flag guard compared a boolc string against `abap_bool` and always failed for such tables — and `WI_ORDER` is no longer passed as a string (`CX_SY_DYN_CALL_ILLEGAL_TYPE`). Verified live 2026-09-22: a delete of two BALOBJ rows on workbench request A4HK900350 filed E071 `R3TR TABU BALOBJ` (OBJFUNC K) on its task with one E071K row per key; the TABKEY of a client-independent table has no client prefix.
- **`abap_transport operation=removeObject` no longer refuses a request holding duplicate E071 rows for one object** (#184). The bridge collapses the group to the row with the lowest AS4POS — deleting the surplus E071 rows by TRKORR+AS4POS in the same LUW (E071K rows are keyed by the object, not by the E071 position, and go with the surviving row) — then calls `TR_DELETE_COMM_OBJECT_KEYS` once per remaining row; the response notes "Collapsed N duplicate E071 rows for R3TR TABL X (AS4POS 000002, 000003) to one row before removing it." and the header carries `collapsedRows`. `CTS_DUPLICATE_ENTRY` now fires only if TR 292 still fires, or an older bridge body is deployed. Verified live 2026-09-22: a task holding `R3TR TABL ZAS_T184B` twice was collapsed and the entry removed in one call.
- **A `DEVC/K` delete's "still contains" list now says whether each object still exists or is deleted and waiting for a transport release** (#185). Each line names the request and task, resolved from TADIR DELFLAG and E071/E070, e.g. "object R3TR TABL ZAS_T184 (deleted, awaiting release of request A4HK900346, task A4HK900347)." When everything left is pending release, the error is the new classified code `TRANSPORT_PENDING` (retryability conditional), naming the requests whose release would make the package deletable — abapsmith releases nothing automatically. Mixed content stays `CHECK_FAILED`, listing both groups.

### Added

- **`abap_img_edit create_request` takes `request_type`, and `master_type` accepts `TABU`** (#176). `request_type` is `customizing` (default, type `W`, task type `Q`) or `workbench` (type `K`, task type `S`). `master_type` now defaults to `TABU` when the target is the table itself, with no maintenance view involved — CTS refuses a `VDAT` header naming a plain table with TK323 "<table> is a table, it cannot be accessed as a view" (verified live 2026-09-22 on BALOBJ); `VDAT` stays the default when a view is involved.
- **`abap_transport operation=show` marks repeated keys in the OBJECTS table** (#184): `ZAS_T184 (x2, duplicate E071 rows)`, with a note that `removeObject` collapses them. Duplicates are produced by SAP itself — creating, deleting, recreating and deleting a table in one request leaves `R3TR TABL ZAS_T184` twice (OBJFUNC blank and OBJFUNC D), reproduced live 2026-09-22 on task A4HK900347; abapsmith appends no E071 row for a DDIC delete, so there is nothing to dedupe on the write side.

### Changed

- **`abap_img_edit preview` now prints which request would be used** (#176): "Applying this change would record on <REQ> (<kind> request known to this session)" or "would create a new <kind> request ..." — and, as before, `preview` never creates one.

## [0.6.24] - 2026-09-22

### Added

- **`abap_write fixed_point_arithmetic`** (#179). A new `PROG/P` opt-out for the default below — `false` omits `abapsource:fixPointArithmetic` from the create payload instead of sending it `"true"`. Named against any other type it is `BAD_INPUT`, before any request. A whole-object `abap_read` of a `PROG/P` reports `fixed_point_arithmetic: true|false` in the header, read off the program's descriptor; the line is omitted when that descriptor could not be read.
- **`abap_write text_pool`** (#182). Writes a program's text pool — text symbols and selection texts — through the `PROG/PX` textelements resource, `PROG/P` only: `{"symbols":{"001":"Hello"},"selection_texts":{"P_X":"Parameter X"}}`. Symbol keys are 1–3 alphanumerics (uppercased), texts up to 132 chars; selection-text names up to 8 chars (uppercased), texts up to 30 chars. Given with `source`, it writes after the source write and activation; given alone it targets an existing program (`BAD_INPUT` on one that does not exist yet, and `BAD_INPUT` before any request on any type other than `PROG/P`). Texts are written in the logon language and the textelements resource is activated unless `activate: false`; the write is journalled as an irreversible `update` entry on the `PROG/PX` textelements resource, so it appears in `abap_journal mode=list` but `mode=undo` refuses it. The response gains `text_pool: symbols N, selection_texts M (<language>)` and `text_pool_activated: yes|no`. A `PROG/P` whole-object `abap_read` gains a `TEXT POOL` section listing symbols and selection texts when the program has any. `PROG/PT` is the program's GUI title (`SET TITLEBAR`, Menu Painter/SE41), not the text pool, and stays unwritable and unreadable.

### Fixed

- **`create_hook` negotiates its `enhoxhh` media type instead of hardcoding v2** (#178). abapsmith now reads the `<app:accept>` list of the `/sap/bc/adt/enhancements/enhoxhh` collection from `/sap/bc/adt/discovery` (cached per connection with the rest of the discovery inventory) and sends the highest `application/vnd.sap.adt.enh.enhoxhh.vN+xml` version advertised — A4H 754 offers only v3 and `text/html`; older releases v2 or v1. Discovery unreachable falls back to v2. No `enhoxhh` collection, or one with no `enhoxhh` media type, refuses `create_hook` `UNSUPPORTED` naming `application/vnd.sap.adt.enh.enhoxhh.v2+xml`, before any request. HTTP 415 (`SADT_RESOURCE/039`, `ExceptionUnsupportedMediaType`) and HTTP 406 (`SADT_RESOURCE/037`, `ExceptionResourceNotAcceptable`) are now classified with a hint that the server does not accept the v2 enhancement-implementation payload / cannot produce the requested representation, and that reconnecting refreshes the cached inventory.
- **New `PROG/P` reports are created with Fixed Point Arithmetic on** (#179). Before, `abap_write` sent no `abapsource:fixPointArithmetic` attribute at all, which left it off and broke things like `SELECT … INTO TABLE @DATA(lt)` combined with `lines( )` arithmetic, and decimal handling generally.

## [0.6.23] - 2026-09-22

### Fixed

- **Bridge creates honour the request this session created** (#174). `VIEW/DV`, `TRAN/T`, `SHLP/DH`, `TABL/DI` and `DEVC/K` creates under `ABAP_ALLOW_TRANSPORTS=auto` now consult the session's created-request registry directly — a request from `abap_transport operation=create` that CTS's package candidate list omits (pinned, failed or empty check) is confirmed with a transport read and reused, instead of a new request being minted with the note "CTS offered no existing request for package …".
- **`TABL/DI` reports the request that actually holds the index** (#173). After a `TABL/DI`, `VIEW/DV` or `TRAN/T` bridge create, abapsmith reads the request back and `transport:` and the response NOTE name whichever request actually holds the entry, not just the number the create sent: the same request reads `Read back after the write: request <REQ> lists LIMU INDX <TABLE> <ID>.` (replacing the old "did NOT re-read" sentence); a different one reads `Recorded in <OTHER> (holds the <PGMID> <TYPE> lock for <NAME>), not in the session's request <SESSION>.`, naming the entry the holder actually lists — the `LIMU INDX` entry itself or the covering `R3TR TABL`. A read-back that cannot be confirmed is reported as such and never masks the create's own success.

### Changed

- **Session-created requests win over older abapsmith leftovers, and every non-session request carries its reason** (#175). The resolver now prefers, in order, a server pin, a named request, a request this session created, then an older modifiable request carrying the `abapsmith session <date>` description, before creating a new one — and switches away from a cached older request the moment a session-created one exists. A server-pinned request's NOTE names the object and the lock it holds instead of the session's request; an adopted older request's NOTE says why the session used it instead of creating a new one. The tool description and `doc/TOOLS/write-and-activate.md` document the order.

## [0.6.22] - 2026-09-22

### Added

- **`abap_write` gains `remote_enabled: boolean`** (#177). `FUGR/FF` only — `BAD_INPUT` zero-network for every other type and for `mode=delete`. `true` sets the module's processing type to `rfc` (Remote-Enabled Module), `false` to `normal`, written as a minimal `fmodule:abapFunctionModule` descriptor PUT (`Content-Type: application/vnd.sap.adt.functions.fmodules.v3+xml`) to the module URI under the same lock and transport as the source PUT, before unlock and activation — no ABAP bridge involved. The write response prints `processing_type: rfc|normal` and notes when it changed; omitting the parameter leaves the processing type untouched, even for a byte-identical source. `abap_read` of a `FUGR/FF` now prints `processing_type` and `remote_enabled: yes|no` in its header (one extra GET of the module descriptor).

### Fixed

- **Function module create no longer collides with its own group's transport lock** (#171). A module create with no `package` used to resolve to `$TMP` and send the create POST with no `corrNr`; CTS refused it with 403 `CTS_WBO_API/019` — the group's generated `L<GROUP>UXX` include was already locked by the request the group itself was created in. The create path now reads the group's own `adtcore:packageRef` and uses that package: transportchecks answers `KORRFLAG X` with the locking request, the POST carries `corrNr=<that request>`, and the response's `transport:` line reports the request actually used, with `package_source: container` saying the package came from the group. A `package` that disagrees with the group's is refused `BAD_INPUT` — no move. A create that still hits `CTS_WBO_API/019` (e.g. a forced `corr_nr`) is now classified `TRANSPORT_LOCKED`, `details.classifiedBy: "cts-object-locked-in-other-request"`, with `details.holdingRequest`, `details.holdingUser`, `details.lockedObject`, and a hint naming the request to pass as `corr_nr`.

## [0.6.21] - 2026-09-22

### Added

- **`add_query`/`set_query_fields` flag a missing `RETRIEVE_DEFAULT_PARAM` implementation** (#188). A query class must implement `/BOBF/IF_FRW_QUERY~RETRIEVE_DEFAULT_PARAM` even though the interface marks it `DEFAULT IGNORE` — the ABAP syntax check accepts a class without it, but BOPF activation of the business object then fails on the missing method. When the class source is readable, the preflight now checks case-insensitively for the method's implementation and adds a NOTE naming it if absent.

### Fixed

- **BOPF dangling-class-ref interface check is no longer case-sensitive** (#186). It used to test for `/BOBF/IF_FRW_ACTION` etc. as an exact-case substring, so a lower-case `INTERFACES /bobf/if_frw_action` was flagged `wrong-interface`. It now asks ADT's type hierarchy (own and inherited interfaces), falls back to a case-insensitive scan of the definition part, and reports `unchecked` — not `wrong-interface` — when it can't decide (an inheriting class whose hierarchy is unavailable, or a class whose source can't be read at all, e.g. a 403 on a delivered SAP class). The edit no longer throws on an unreadable source.
- **`add_association`/`set_association_fields` qualify a bare `targetNodeRef.name`** (#187). BOPF requires `<BO>~<NODE>`, same-BO included — a bare name like `"ITEM"` activated with "Association has no Target Node defined". A bare name is now qualified with the current business object's name before the PUT and reported in a NOTE; `spec.targetNodeRef.type` defaults to `BOBF`. An unknown node (bare, or qualified with the same BO) is refused `BAD_INPUT` before any lock or PUT, listing the nodes that exist.

## [0.6.20] - 2026-09-22

### Fixed

- **`abap_search` no longer throws on a bare `*` query under a type filter** (#172). `conn.adt.searchObject` parses object-name attributes numerically, so a whitespace-padded numeric name like `"                                00"` (a real WDCC/YG row) becomes the number `0` and the library's own `result["adtcore:name"].match(...)` throws `TypeError: match is not a function` before our code ever sees a row. `abap_search` now retries that one call with a string-preserving parse of the raw ADT XML when it hits exactly this failure; any other error is rethrown unchanged. `*` stays supported, with or without `type`, within the existing fetch cap.
- **`abap_test` on a class with no test-classes include reports `NO TESTS RAN`, not `UNKNOWN`** (#181). A class whose `testclasses` include is missing or empty now reports `NO TESTS RAN` with a reason naming which — there was nothing for ABAP Unit to run, not a run that reported nothing for no evident reason. `UNKNOWN` is now reserved for that latter case: the include exists and is non-empty but the run still came back empty, or the include could not be probed.

### Added

- **`abap_run` `keep_blank_lines`** (#180). `true` returns the captured list unfiltered — no page-header/rule strip and no trailing-blank pop (lines are still right-trimmed, and unprefixed bridge lines are still dropped). Default `false` keeps today's filtering, and the dropped-lines `NOTE` now says why and where, e.g. "Dropped 2 blank lines at positions 4 and 5 (trailing list padding); dropped the list header and rule line at positions 1 and 2; dropped 1 non-list line of bridge output at bridge line 3." A response-cap cut leaves an in-place `… (N lines omitted) …` marker in the `OUTPUT` instead of just cutting it off silently.

### Changed

- **`abap_journal`'s description lists its parameters and common calls** (#183): `mode=list`, `mode=show entry=<id>` (`detail=full` for the complete images), `mode=undo entry=<id> activate=true`, `mode=reconcile entry=<id> outcome=<succeeded|failed> reason=<text>`. `operation`/`action`/`op` are now suggested as `mode` and `target` as `object` in the `BAD_INPUT` for an unknown parameter; `abapsmith-orient`'s tool-set row shows the same calls.

## [0.6.19] - 2026-09-22

### Added

- **`abap_transport_release scope: "request"`** (#159). One call releases a whole request: every modifiable task under it that holds at least one object, in the order the request lists them, then the request itself, reporting each step's outcome as it goes. It stops at the first step whose release is not proven and does not attempt the rest — retrying with the same arguments resumes at the failed step, since an already-released step is no longer planned. One journal entry is written per attempted step. A modifiable task holding no objects is skipped rather than released, and named in a note. Called on a task number instead of a request, it is refused as `BAD_INPUT` naming the parent request, before any release.

### Changed

- **Releasing a task number now reports its parent** (#159). The response gains `parent: <request>` and `parentStillOpen: yes | no | not known`, with a note on how to finish the request (`scope: "request"` on the parent, or a plain release of it) or that nothing is left. The shared parameter checker also catches `include_tasks`/`with_tasks` as misspellings of `scope`.

## [0.6.18] - 2026-09-22

### Changed

- **`abap_write` validates `type` first** (#157). The type code is checked against the writable set before any type-specific required-field check, so `{"object":"ZFOO","type":"TRAN/P"}` with no `source` now answers `BAD_INPUT` `Unknown object type "TRAN/P". Did you mean TRAN/T?` (with `details.suggestions` and `details.writable`) instead of `source is required`, and a bridge-only or unsupported explicit type is refused the same way before any request. The suggestion is an edit-distance match over the writable codes; nothing about the accepted types changed.
- **`Writable types are ...` names the same list as `details.writable`** (#157). The sentence in the refusal is built from the registry's write set, so every code in `details.writable` appears in the prose and the two cannot drift.
- **`abapsmith-orient` is a router** (#158). The skill is down from 21.8 KB to about 5 KB: the generated writable-type table, the `abap_read` refusal list and the two write shapes now live in `skills/abapsmith-create-an-object/writable-types.md` (`scripts/gen-capability-table.mjs` and `test/capability-table-census.test.ts` follow it); the per-feature ceiling details moved into the area skills they belong to (transport ceilings to `abapsmith-put-work-on-a-transport`, `abap_ui press` and `abap_fpm_read` gating to `abapsmith-research-code`, `abap_dumps variables` to `abapsmith-debug-a-failing-run`, `abap_data_preview` and the package-first read to `abapsmith-explore-a-package`, `abap_fluid` gating to `abapsmith-write-a-fluid-plugin`). `test/skills-orient-router.test.ts` pins the size and that every skill is reachable from the router.
- **`abapsmith-put-work-on-a-transport` describes the `ABAP_ALLOW_TRANSPORTS=auto` flow** (#158). Omit `corr_nr`, read the request from the write response's `transport:` line, and call `transport_create` only when the gate mode requires a named request; the "call `transport_create` first regardless" and "AUTO" wording is gone. `abapsmith-orient` no longer claims `corr_nr` is required outside `$TMP`.
- **Skill corrections** (#158). `abapsmith-write-abap-source/classes.md` states that `abap_run` in class mode captures only `out->write( )` output — classic `WRITE` statements produce nothing there (verified on A4H). `abapsmith-edit-a-bopf-object` adds that a classrun calling the BOPF transaction manager must `COMMIT WORK` after `save( )` or nothing persists. `abapsmith-create-an-object` and `abapsmith-put-work-on-a-transport` state that a `SAFETY_DENIED` / `retryable:false` answer is terminal for that object and package: do not vary arguments, report the rule the hint names and, if the task allows, use `$TMP`. `abapsmith-create-ddic-objects` records that `ddic` for domains and data elements was re-verified live (`ZAS_DDIC_CHK`, 2026-09-22) instead of calling it unverified.

## [0.6.17] - 2026-09-22

### Added

- **`abap_bopf_edit` checks enum-valued `spec` fields client-side** (#153): `spec.multiplicity` and `spec.implementationType` on `add_association`, `spec.instanceMultiplicity` and `spec.exportingParameterCategoryType` on `add_action`, `spec.category` on `add_determination`/`add_validation`/`add_query`, `spec.relations[].relationType` on `add_determination`, and `spec.uniqueness` on `add_alternative_key` (plus the matching `set_*_fields` calls). An out-of-set value never reaches the server: it is refused `BAD_INPUT` in the shape `spec.instanceMultiplicity "1_1" is not one of "0" (…), "1" (…), "2" (…)`, with every accepted value's meaning spelled out in the message. An action's `category` is an opaque numeric code and stays unchecked; a determination `category` of `"undefined"` is refused rather than silently accepted, since BOPF defaults an omitted category to that exact string server-side and the determination then never fires.
- **`ExceptionInvalidData` responses decode their `XML_PATH`** (#153). Instead of a raw `bo:businessObject(1)bo:nodes(10)bo:actions(18)` fragment, the error hint names the element the failing call touched and its candidate fields, and carries `error.details.classifiedBy: "invalid-data-xml-path"` and `error.details.specElement` for programmatic use.
- **Per-family request timeouts** `ABAP_BOPF_TIMEOUT_MS`, `ABAP_ACTIVATE_TIMEOUT_MS`, `ABAP_RUN_TIMEOUT_MS` (#154), each defaulting to `180000` ms — `abap_bopf_edit`'s `create_bo` and BOPF `activate`, every activation request, and `abap_run`'s classrun no longer share the general `ABAP_TIMEOUT_MS` (60000 ms default), since all three can legitimately run past a minute on a larger model or a busy system.

### Changed

- **BOPF `create_bo`/`activate` re-read the object on a client timeout instead of failing blind** (#154): on a fresh session, up to 6 reads 5 seconds apart look for the object the call was building. Found and matching expectations, the call reports success with a "completed on the server after the client timeout" note (a create timeout reports success without attempting activation); found but not yet active after an activation timeout, or not found at all, it fails `TIMEOUT` with `retryable` derived from what the re-read learned — `false` once the create is confirmed to have landed and only activation remains, `true` otherwise.
- **Activation and `abap_run` transport timeouts are classified `TIMEOUT`** (#154), reusing the error code `abap_run` already had (#149); each names the timeout variable it ran under — `abap_run`'s message now names `ABAP_RUN_TIMEOUT_MS` rather than the general `ABAP_TIMEOUT_MS`.
- **The session lock's wait time is derived from the largest per-family timeout** (#154): `ABAP_SESSION_WAIT_MS` plus the largest of `ABAP_TIMEOUT_MS`, `ABAP_BOPF_TIMEOUT_MS`, `ABAP_ACTIVATE_TIMEOUT_MS` and `ABAP_RUN_TIMEOUT_MS`, so a caller queued for a session slot cannot time out before the slowest in-flight request could have finished.

### Fixed

- **`abap_bopf_edit add_action` with an out-of-set `instanceMultiplicity` (e.g. `"1_1"`) no longer reaches the server** (#153). It previously produced an opaque `ExceptionInvalidData`; it now fails `BAD_INPUT` before any request is sent, naming the accepted values.

## [0.6.16] - 2026-09-22

### Added

- `abap_fpm_read mode=find` rows gain `loadable`, `app_config_id`, `component_config_id` and `reason` (#155): for a type-02 row the bridge reads the configuration XML and reports the component and component configuration it references, checking that the component configuration exists; for a type-00 row it checks whether an application configuration with the same id exists. `mode=app` now accepts either a component or an application configuration id — when the given id fails to load as an application config, the bridge's `resolve` action looks it up in both tables and, when exactly one application configuration references it, loads that one instead and reports `config_id` (loaded) and `resolvedFrom` (given) in the header.
- A shared parameter-name check runs before the handler for every tool registered with a plain parameter shape (#156): an unknown parameter is refused as `BAD_INPUT` listing the accepted parameters and suggesting the closest one (known confusions such as `id`→`entry` for `abap_journal`, `object`→`bo` for `abap_bopf`/`abap_bopf_edit`, `action`→`operation` and `request`→`transport` for `abap_transport`, plus prefix/edit-distance matches; `abap_transport` also says `Did you mean transport="A4HK900001"?` when `object` carries a request number where `transport` is required), and an invalid enum value (e.g. `mode=history`) is refused listing the valid values — both before any SAP request. Advertised tool schemas are unchanged. `abap_journal mode=show` gains `detail` (`summary` | `full`, default `summary`).

### Changed

- `abap_journal mode=show`'s default output is now a summary, not the full before/after images (#156): header fields (object, type, operation, request, timestamp, before/after sizes, `diffAdded`/`diffRemoved`/`diffHunks`/`diffChars`) plus a unified diff of before-image → after-image, capped at about 2,000 characters and marked when truncated (`[diff truncated: N of M characters shown; detail="full" returns the complete images]`). `detail="full"` returns the complete before-image as before, plus the after-image when one was recorded; when no after-image exists (a pending entry) the summary says so and points to `detail="full"`.
- `abap_fpm_read mode=app`'s load failure is now `NOT_FOUND` with `tried` (id, config_type `"02"`, table), `existsAsApp`, `existsAsComponent`, `component`, `applicationConfigs` (capped at 20, with `applicationConfigsTruncated`), the original error frames, and a hint naming the candidate ids or pointing to `mode=find config_type="02"` (#155).

## [0.6.15] - 2026-09-22

### Added

- **`abap_read pattern=`** (#148). A case-insensitive regex over the object's source returns only the matching lines, numbered like `grep -n -C` — `NNN:` for a match, `NNN-` for the `context` lines around it (default 2), `--` between groups — so the numbers feed straight into `offset=`, `abap_quick_fix` or `view="definition"`. At most 50 matches per response (`limit=` overrides); past that a `--- TRUNCATED ---` line names the `offset=` to continue from. The etag of a pattern read is marked `partial:` (an `edit=` write accepts it, a full-source rewrite is refused). An empty or invalid regex, or `pattern` next to `outline=true`/`method`/`full`, is `BAD_INPUT` before any request; next to a `view` or on a DDIC/raw path it is `UNSUPPORTED`.
- **`abap_read full=`** (#148). Explicitly asks for the whole source of a large object (the same as `outline=false`); refused next to anything narrower.
- **`size:` line** (#148). Every `abap_read` and `abap_search` response (all four search modes) states its own size — `size: <chars> chars, <lines> lines, truncated=<bool>` — exactly, counted on the emitted text including the line itself.

### Changed

- **Large sources answer with their outline by default** (#148). A source read of a `CLAS`/`INTF`/`PROG`/`FUGR` object above 150 lines or 8000 characters returns the outline (`outline: default (large source)`, with `totalLines`/`totalChars` and a note naming the threshold and every way to get the text) unless the call passes `method`, `include`, `offset`, `limit`, `pattern`, `full=true` or `outline=false`. Below the threshold, for every other kind and for every `view` nothing changes. Measured on the standard objects the issue quotes, this turns 10K–31K-character reads paged over 2–3 calls into one outline.
- **`PROG`/`FUGR` outline** (#148). `outline=true` on a program or function group is no longer "NOT SUPPORTED": it is a statement scan of the text (`FORM`/`FUNCTION`/`MODULE`/`CLASS`/`METHOD`/`INCLUDE`, event blocks) with line ranges, disclosed as a scan in the response. Other kinds keep the unsupported answer.
- **`abap_search mode=source` groups hits per object** (#148). One `<TYPE> <NAME>  (<n> hits)` header per object, then `<line>: <text>` rows (with an `include <NAME>` sub-header where the include is not the object itself); at most 20 hits per object, the rest as a count naming how to narrow. The `NOTE:` block appears once at the top. The header gains `objectsWithHits`.
- **`context`** is now shared by `view="diff"` (per hunk, default 3) and `pattern` (around each match, default 2); it is still refused when neither is given.
- **Shorter tool schemas** (#148). Tool and parameter descriptions in `tools/list` are trimmed to the parameters plus one line of intent: explanatory paragraphs (why a check exists, which function module runs, how a section is rendered) now live in `doc/TOOLS/*.md` and the skills, which the descriptions point to. Every gating or refusal statement an agent must see before calling stays as a one-liner (what is refused, with which code, whether before any request). Measured over all 29 tools in admin mode (`JSON.stringify({name, description, inputSchema})`), the `tools/list` payload shrinks from 81967 to 75147 chars (-8.3%) even though `abap_read` gained three parameters.

## [0.6.14] - 2026-09-21

### Added

- `abap_dumps mode=show` gains `section` (#149): `"analysis"` (kap0, kap3, kap4, kap28), `"source"` (kap7, kap8), `"variables"` (kap10, gated exactly like `variables:true`), `"stack"` (kap11, kap22), `"environment"` (kap5, kap6, kap6a, kap9, kap14), or `"all"` — the full set `show` returned by default before this change. With neither `section` nor `chapters` given, `show` now returns a summary instead of chapter text: runtime error, exception class, short text, the source line (kap7/kap8 — include, line, statement), error analysis (kap3, trimmed to ~450 characters) and how to correct (kap4, ~260 characters), the top 5 call-stack frames (kap11), and a note listing every chapter the dump has. Capped at 3,000 characters, truncation marked like any other response. `section` and `chapters` together, or `offset` on the summary, are `BAD_INPUT`.
- `abap_run` gains its own `TIMEOUT` error code for a classrun request that outran `ABAP_TIMEOUT_MS` (#149), and correlates it — along with a `200` whose body isn't console output — against the ST22 dumps feed: a dump of the same user and terminated program published in the last 60 seconds (±2 s slack) is looked up before the error reaches the caller, at a cost of at most two extra GETs.

### Changed

- `abap_dumps mode=show`'s default output is now the summary above, not chapter text (#149). `section:"all"` gives the previous full-chapter-text output (kap7, kap8, kap9, kap11).
- A classrun transport timeout is now `TIMEOUT`, not the unclassified `ADT_ERROR` (#149). It carries `details.dump` and `retryable: false` when the ST22 lookup finds a matching dump (read it with `abap_dumps mode=show key=…`, don't retry unchanged); `details.dumpLookup` and `retryable: true` when it finds none (the run may simply have run past the budget); and no retry claim when the lookup itself fails. The no-console `ADT_ERROR` gets the same lookup and the same `details.dump`/`details.dumpLookup`, but keeps its own default retryability either way.

## [0.6.13] - 2026-09-21

### Added

- **`abap_read method=` resolves inherited members** (#146). When the class itself declares no such member, the lookup walks `INHERITING FROM` and `INTERFACES` from the definition source (superclass first, then interfaces, each level's own parents after it) and returns the first hit with `foundOn` in the header and the defining object's line numbers; a `NOT_FOUND` lists the class's own methods in `details.available` and the chain's in `details.availableInherited` as `NAME (ORIGIN)`, preferring names that share a prefix with the request. A parent that cannot be read is reported under `details.unresolved` instead of aborting the read.
- **`abap_read outline=true` lists inherited members** (#146). An `INHERITED` section after the class's own components names every public/protected method, attribute and event declared on its superclasses and interfaces, grouped by defining object with relation and depth; the header carries `components` and `inherited` counts.
- **`abap_read method=` returns the declaration first** (#146). The `METHODS …` statement (unchained from a `METHODS: a, b.` list) precedes the `METHOD … ENDMETHOD.` body; `method=` with `include="definitions"` returns the declaration alone instead of `UNSUPPORTED`. The tool description and the `abapsmith-write-abap-source` skill say to learn a signature this way rather than reading the full class.
- **`ABAP_AVAILABLE_MEMBERS_MAX`** (#146). Caps each candidate list in a `method=` `NOT_FOUND` (default 40, was a fixed 12); `availableTruncated` / `availableInheritedTruncated` report how many names were dropped.
- **`CHECK_FAILED` quotes the offending lines** (#147). Each syntax-check message in `details.failure.details.messages` carries `sourceLine` (trimmed, cut at 200 characters) and one line of context each side (`before` / `after`), taken from the source the call just sent — no second read.
- Live suite `test/integration-checkfail-method-repair.test.ts` (#147): a full write with a syntax error into `$TMP` class `ZCL_AS_CHECKFAIL`, a `method=` repair against the inactive version, and activation.

### Changed

- The `CHECK_FAILED` hint after a full write says the object is saved inactive and that `abap_write method="<NAME>"` repairs one method against that inactive version, then `abap_activate` (#147).

### Fixed

- **`method=` writes and reads against a class with an inactive version** (#147). Method line ranges were always taken from the ACTIVE component structure, so after a `CHECK_FAILED` full write every `method=` write spliced into stale line ranges and a method that existed only in the inactive version was `NOT_FOUND`. The object's descriptor (`adtcore:version`) now decides which structure to fetch: when it reports a newer inactive version, the structure is fetched with `?version=inactive` (falling back to the active one when that read fails or is empty); otherwise the active structure is used — because ADT answers `?version=inactive` with the active structure, unmarked, for a fully active object, so requesting it first without checking the descriptor could not tell the two apart. The response header (`structureVersion`) and the write's note say which version was used.
- A `method=` `NOT_FOUND` no longer lists the class's own name as an available member (#147) — the `CLAS/OC` / `INTF/OI` self-entry of the ADT component structure is filtered out, and so is the `CLAS/OCX` external-reference entry (the class's Text Elements, present in every class's active structure — it also made each superclass's own name appear in the outline's `INHERITED` section), so `available` names methods only.

## [0.6.12] - 2026-09-16

### Added

- `abap_debug` reports how the debugger attached (#152): the `start` response header carries `debuggee: <DBGEE_KIND>` and, for a post-mortem attach, `dump: <id>` plus a `POST-MORTEM` note saying the run has already terminated, that stepping cannot resume it, which armed exception breakpoints did not stop it, and the `abap_dumps` call that reads the dump.
- `abap_debug` exception breakpoints (#152): `start` resolves the exception class first and refuses with `BAD_INPUT`, naming the class, before any breakpoint request when it does not exist — SAP accepts such a breakpoint and never fires it. An exception breakpoint the server accepted but did not echo back is reported in the `start` response as `NOT armed`. The `start` response, the death note and the `POST-MORTEM` note state the live-verified rule: an exception breakpoint stops at the `RAISE` only when a handler for the exception exists up the stack; an uncaught raise (and a real division by zero) goes straight to the runtime error and the debugger attaches to the dump. The registration itself was not at fault. `test/integration-debug.test.ts` gains live cases 5a/5b that create the `$TMP` probe classes `ZCL_AS_DBGEXC` (uncaught raise → `PMORTEM`, dump `UNCAUGHT_EXCEPTION`) and `ZCL_AS_DBGEXC2` (caught raise → suspended at the raise), pin both outcomes, and delete the classes afterwards.

### Changed

- `abap_debug`, `abap_debug_vars` and `abap_debug_value` print a 12-character `stateId` instead of the 64-character digest (#151). The short id is what to write back; the full digest and any prefix of at least 8 characters are accepted too. A prefix matching no current state is refused as a stale id, naming the current short id and carrying both forms in `details`.
- The recurring explanatory notes on debugger responses (revisited position, `frame` read-cursor, `OMITTED`/`UNREQUESTED` variable rows, post-mortem attach) are printed in full once per debug session and as a one-line reminder afterwards; a different breakpoint hit or a post-mortem attach prints the full text again (#151). Notes sit outside the `DEBUG_MAX_CHARS` budget, so they no longer displace stack or variable content. Per-call evidence (watchpoint values, termination evidence, auto-continue reports) is unchanged. The debug skill and `doc/TOOLS/debugger.md` describe the short id and the note-once behaviour.

### Fixed

- `abap_debug mode=start` no longer fails with `parseDebuggeeResponse: unrecognised DBGEE_KIND "PMORTEM"` when the run dumps before any breakpoint fires (#152). `PMORTEM` and every `*MORTEM*` value parse as post-mortem; any other unknown kind is logged as a warning with the raw value and the session attaches as "kind unknown" instead of aborting.

## [0.6.11] - 2026-09-16

### Fixed

- **Classic-bridge creates resolve a transport request under `auto`** (#141). `VIEW/DV`, `TRAN/T`, `SHLP/DH`, `TABL/DI` and `DEVC/K` creates into a transportable package no longer demand a named `corr_nr` that `ABAP_ALLOW_TRANSPORTS=auto` then refuses. With `corr_nr` omitted they take the same route as a class create: the session resolver asks CTS for the package's modifiable requests, reuses one this session created or one attributed to abapsmith, else creates one, and the write response's `transport:` field names it. `dispatch()`'s targets gate now receives the provenance of the resolved request from a builtin caller (`FluidRunRequest.corrSource`), so an auto-selected request is judged as such instead of as caller-named; plugin tools cannot declare it, and pinned or empty lists refuse exactly as before. `TRANSPORT_ERROR` on these paths now means a request was genuinely needed and none could be resolved. Skills `abapsmith-create-an-object`, `abapsmith-create-ddic-objects` and `abapsmith-put-work-on-a-transport` updated.
- **Gate verdict before any transport is created** (#142). A bridge create is asserted against the safety gate — with the caller's `corr_nr` or as unresolved — before the resolver runs, so a denied write costs zero wire requests and creates no request; the `VIEW/DV` path used to create one first and leak it. Should the post-resolution assert refuse after a request was created in the same call, the refusal carries `details.createdTransport`, its hint names the request and `abap_transport operation=delete` removes it, and the create is journalled as `transport-create`.
- **Transport-allowlist refusals are rule-specific, caller-side and terminal** (#143). Every `SAFETY_DENIED` on rules `transport allowlist` / `transport allowlist (fail closed)`, and every session-resolver denial, now carries a hint worded for the mode in force — under `auto`: "The server picks the request itself under ABAP_ALLOW_TRANSPORTS=auto. Omit corr_nr. Naming a request is refused regardless of which request."; under a pinned list: "Only these requests are permitted: … ask the operator to extend the list"; under an empty list: only `$`-packages are writable — states that it is terminal (`retryable: false`), and never suggests editing the environment. The `abapsmith-put-work-on-a-transport` skill no longer describes an omitted `corr_nr` as "the value `AUTO`" (the string is not accepted; omit the field) and tells agents never to retry a terminal `SAFETY_DENIED` by changing arguments.

## [0.6.10] - 2026-09-16

### Added

- **`abap_write` `ddic` for `DOMA/DD`: fixed values, value table, computed output length** (#145). `fixedValues: [{low, high?, text}]` renders the `<doma:valueInformation>` / `<doma:fixValues>` block in the shape a live GET returns (the server numbers the rows); `low`/`high` are refused over 10 characters (`DD07L-DOMVALUE_L`) or over the domain length, `text` over 60, each naming the row. `valueTable` renders the `<doma:valueTableRef>` uri/type/name triple. `outputLength` now defaults per data type — `DEC`/`CURR`/`QUAN`: length + 1 for decimals + 1 for the sign; `DATS` 10; `TIMS` 8; otherwise the length — and a caller's value still wins. Live: a `CHAR 1` domain with three fixed values and a signed `DEC 13,3` domain created through `ddic` activated on A4H and read back intact.
- **Live suite `test/integration-ddic-structured.test.ts`** (#144, #145): creates, activates, reads back and deletes a `DTEL/DE` with four labels and the two domains above through the `ddic` shortcut.

### Fixed

- **`abap_write` `ddic` for `DTEL/DE`: field labels were silently discarded** (#144). The generated descriptor had no `adtcore:masterLanguage` on the root, so the server accepted the PUT and stored every `<dtel:*FieldLabel>` empty; the read-back guard then reported `CHECK_FAILED` / `VALUE_DISCARDED` and the object stayed inactive. All three builders now emit `adtcore:masterLanguage="EN" adtcore:language="EN"` on the root — the same body with the attribute activated with all labels intact on A4H. Labels over 10/20/40/55 characters are refused with `BAD_INPUT` naming the field (never truncated); `*Length` defaults to the slot maximum, must be at least the label's length, and is written two-digit padded like the live shape (`05`, `03`).
- **`abap_write` `ddic` for `DOMA/DD`: `signExists` was silently dropped** (#145). The builder emitted `<doma:signExists>` after `<doma:lowercase>`; in that order a `DEC 13,3` domain with `signExists: true` activated on A4H with the flag stored `false` and no message. The elements are now emitted in the live order (`signExists` first), and the descriptor read-back guard reports a flag sent `true` and stored `false` as a discard — previously only an emptied element counted.
- **`VALUE_DISCARDED` hint names the cause when only texts were dropped** (#144). When every discarded element is a DTEL field label or a `<doma:text>`, the hint says these are language-dependent texts stored only with `adtcore:masterLanguage` on the root, and tells the caller to add it and resend (or, when the document already carries it, that something else emptied them) instead of the generic "rework the payload".

### Changed

- **`abap_write`: `source: ""` next to `ddic` is treated as absent** (#144, #145). A client that always sends the field no longer gets `BAD_INPUT` for giving "both"; a non-empty `source` with `ddic` is still refused before any request.
- **`abapsmith-create-ddic-objects` skill** (#144, #145): the `ddic` section now states what was live-verified and documents `fixedValues`/`valueTable`/the output-length rule; the `DTEL/DE` traps gain the `adtcore:masterLanguage` label discard and correct the `*FieldLength` description (a two-digit display width, not the label's character count — `MANDT` reads back 10 for "Mandant"); the `DOMA/DD` traps gain the `signExists`/`lowercase` element order.

## [0.6.9] - 2026-09-16

### Added

- `abap_ui mode="screen"` gains `detail` (`compact` | `full`, default `compact`) (#150). Compact renders `FIELDS` one line per element — `name  type  len  pos  attrs`, with `len`/`pos` decimal and `attrs` holding only what differs from a plain input field — and folds every run of generated `%_...` flow-logic lines into one `(N generated %_ flow-logic lines omitted)` line, keeping every user-written `MODULE`/`FIELD` line; the header reports `flowOmitted` and a note names the way back. `detail: "full"` is the previous `key=[value]` dump,. The `layout: true` picture and every other section are the same under both. Render-side only: same ABAP, same single bridge call.

### Changed

- `abap_ui` checks `TSTC` before deploying anything (#150). `screen`/`fcode` by `tcode` and every `press` first run one freestyle select on the read lane and refuse a transaction with no row as a structured `NOT_FOUND: transaction X does not exist` — about a second on the wire instead of the ~20 s a fresh invoker-class deploy cost before the bridge's own SELECT failed. `press` reads `CINFO` from that same row, so the extra screen-mode bridge run it used to make for the report/dialog check is gone; a press now deploys exactly one class, its own BDCDATA bridge.
- `abap_ui mode="press"` with `program`+`dynpro` and no `tcode` is refused as `BAD_INPUT` with the message `press needs tcode; program/dynpro is only supported by mode=screen`, before any network call (#150). Driving a bare dynpro was investigated and decided against: `CALL SCREEN` from the classrun bridge has no GUI session and cannot address another program's dynpro, and a generated wrapper transaction would be a cross-client `TSTC`/`TADIR` object outside the safety gate — see `doc/TOOLS/ui-and-fpm.md`, "press needs tcode".

## [0.6.8] - 2026-09-15

### Added

- **Multi-system configuration** (#93). One server process can now serve several SAP systems. `ABAP_SYSTEMS` names a JSON file (or holds inline JSON) with one entry per alias, or the `.env`-native form `ABAP_SYSTEM_<ALIAS>_<SETTING>` sets one setting of one system at a time; plain `ABAP_*` variables remain process-wide defaults that each entry may override. Secrets never go into the file: `password_env` and `secrets` name environment variables instead, and a literal `password` key is a startup error. All validation problems across all entries are reported together, and the process refuses to start on any of them. With more than one system configured every tool gains an optional `system` parameter (an unknown alias is refused with `UNKNOWN_SYSTEM`, listing the configured aliases), and there is one `abap://{SID}/system` resource per system. Tool registration is the union of every system's capabilities, but the permission decision for a call is always made by the target system's own gate, so a system configured `read` stays read-only even when the default system is `admin`. Each system keeps its own session pool, auth breaker, discovery cache, journal directory and object-gate scope. A single-system deployment is unchanged down to the schema bytes: with no `ABAP_SYSTEMS` and no `ABAP_SYSTEM_*` variable the feature does not engage. Docs: `doc/CONFIGURATION/multi-system.md`, `doc/CONCURRENCY/multi-system-pools.md`, `doc/SAFETY/permission-model.md` ("The mode ladder is per system").
- **Cross-system diff** (#93). `abap_read view="diff"` accepts `from_system` / `to_system` when more than one system is configured and compares the object's current active source between two systems as unified-diff hunks; combining them with the same-system `from`/`to` version selectors is refused with `BAD_INPUT`, and a missing object is reported as `NOT_FOUND` naming the system that lacks it.
- **Debugger system guard** (#93). The debugger holds one session per process; a debug call that names a different system than the one the session was started on is refused with `SYSTEM_MISMATCH` instead of stepping the wrong debuggee.

### Changed

- The cross-process object gate now scopes its lock files per system, so `ZCL_FOO` on one system no longer serialises against `ZCL_FOO` on another. The lock file names changed: during a rolling upgrade a process on an older build is not serialised against one on this build for the same object (`doc/CONCURRENCY/object-gate-and-debug-lock.md`).

## [0.6.7] - 2026-09-15

### Added

- `abap_fluid {"tool":"core","action":"change_docs"}` (#114): change documents (`CDHDR`/`CDPOS`) for one `objectclass`, optionally narrowed by `objectid` (wildcard), `user`, `tcode`, `since`/`until` (`YYYYMMDDHHMMSS`, default the last 24 hours) and `max` documents (default 20), rendered one section per document with its field-level positions. Gated like `abap_data_preview`: `ABAP_ALLOW_DATA_PREVIEW` and the deny-list judge `CDHDR`/`CDPOS` before the ABAP runs, then every table a returned position names is judged again after the read — a position on a denied table is dropped and counted, its document still appears — and the whole set is clamped to `ABAP_DATA_PREVIEW_MAX_ROWS`. Malformed arguments are `BAD_INPUT` before any round trip.
- `abap_fluid {"tool":"core","action":"locks"}` (#116): enqueue locks via `ENQUEUE_READ`, filtered client-side by `object`, `table` (lock argument) or `user` with `CP` wildcards, `max` rows (default 50). At least one filter is required — an empty call is `BAD_INPUT` before any network call, so the action cannot dump the whole enqueue table — and there is no release path. `GTCODE`/`GTHOST`/`GTDATE`/`GTTIME` are probed at runtime and reported absent when the system's `SEQG3` lacks them. A `LOCKED` refusal from `abap_write`/`abap_activate` that ADT left unattributed now gains `details.lock_holders` from one read-only lookup through this action; when the lookup is unavailable or fails, the refusal is returned unchanged. `abap_fpm_read mode="locks"` stays FPM-config-specific by design (`doc/TOOLS/ui-and-fpm.md`).
- `abap_data_preview mode="snapshot"` / `mode="diff"` (#117): a snapshot runs the ordinary preview (same gate, deny-list and row ceiling), stores the rows under `ABAP_STATE_DIR/snapshots/<system>/` (mode `0600`, separate from the journal) and returns a `snapshot_id`; a diff re-reads the snapshot's own recorded selection — passing `table`/`where`/`columns`/`order_by`/`distinct`/`max_rows` alongside it is `BAD_INPUT` — re-checks the deny-list, and reports inserted/deleted/changed rows matched on the DDIC primary key (full-row identity when a `columns` projection made the key unprovable, disclosed in the response). `ttl_hours` is clamped down to `ABAP_DATA_SNAPSHOT_TTL_HOURS` (default 24); an expired snapshot is pruned and diffing it is the terminal `SNAPSHOT_EXPIRED`. `format`/`mask` apply to `mode="preview"` only. `abap_run`, `abap_test`, `abap_bopf_test` and `abap_ui mode="press"` take `snapshot_ids`: after the call's own result each id is diffed and a `DATA CHANGES` section is appended; a refused or expired snapshot yields a `refused — …` line there, never a changed call result, and a call that throws propagates unchanged.

## [0.6.6] - 2026-09-15

### Added

- MCP over Streamable HTTP in addition to stdio (#81): `ABAP_MCP_TRANSPORT=http` serves the same tool surface on `ABAP_MCP_HTTP_HOST` (default `127.0.0.1`) / `ABAP_MCP_HTTP_PORT` (default 3000; `0` lets the OS pick and the ready banner prints the bound port) / `ABAP_MCP_HTTP_PATH` (default `/mcp`), one MCP session per client over a single shared ADT pool (`src/mcp-http.ts`, `src/mcp-session.ts`). `ABAP_MCP_HTTP_TOKEN` takes a comma-separated list of `name=token` (or bare) bearer tokens, compared in constant time; a missing or unknown token is `401` with `www-authenticate: Bearer`, a request to another path `404`, `GET`/`DELETE` without a known `mcp-session-id` `404`, other methods `405` with `allow`, bodies over 4 MiB `413`. A non-loopback bind without a token is refused at startup with a message naming the host and the variable. Writes made over HTTP are journaled with `actor` = the token's name (falling back to the client's `clientInfo.name`) and `sessionIdSource: "transport"`, so two callers of one server are distinguishable in `abap_journal`. TLS is not terminated; `doc/CONFIGURATION/transport.md` and `doc/SAFETY/remote-transport.md` state what the token does and does not authenticate. stdio stays the default and is unchanged; a token set under stdio only logs a warning.

## [0.6.5] - 2026-09-15

### Added

- `abap_search mode="call_graph"` (#105): transitive callers or callees of an object to `depth` levels (default 2, max 4 — above it `BAD_INPUT`, never clamped) as an indented tree with the `abap_read` reference next to every node. `direction="callers"` walks `usageReferences` level by level, de-duplicated by URI, with the package and self rows dropped, a node whose fan-in exceeds the where-used threshold shown as `(not expanded: N references)`, and the cumulative `FETCH COST` note; `direction="callees"` statically parses `CALL FUNCTION`, `CALL METHOD`/`=>`/`->`, `PERFORM … IN PROGRAM`, `SUBMIT` and `CALL TRANSACTION` literals (`src/adt/call-sites.ts`), listing dynamic targets as unresolved leaves rather than dropping them. Cycles render `(cycle -> seen above)`; `max`/`depth` cuts end with `--- TRUNCATED ---`. `direction`/`depth` under any other mode are `BAD_INPUT`.
- `abap_read view="lineage"` on a `DDLS/DF` (#106): the view's DDL source parsed (`src/adt/cds-lineage.ts`) down to base tables — `from`, the join kinds, `union`, and associations (followed only when referenced in the field list, otherwise `(not selected)`) — to `depth` levels below the root (default 5, max 10, refused above); `field=` traces one output column layer by layer to its base column or expression. ADT's own `graphdata` endpoint is deliberately not the source (no association edges, no field lineage; refuses customer views on A4H) — see `doc/LIMITATIONS/cds-lineage.md`.
- `abap_read view="footprint"` on `PROG/P`, `CLAS/OC`, `FUGR/F`, `FUGR/FF` (#107): a static scan of every include for Open SQL writes (internal-table forms excluded by keyword position), `IN UPDATE TASK`/`IN BACKGROUND TASK` calls, `COMMIT WORK`/`ROLLBACK WORK`, the BAPI commit/rollback pair, BOPF modify, `EXEC SQL`/ADBC, `EXPORT … TO DATABASE`, `CALL TRANSACTION` and `SUBMIT` ("may write"), grouped per table with include and line; dynamic table or function-module names are listed as unresolved with the variable. Limits in `doc/LIMITATIONS/footprint.md`. `include`/`method` with footprint are `UNSUPPORTED`.

### Fixed

- `abap_search mode="where_used"` answered `referencesTotal: 0` on systems that send the lowercase `usagereferences:` namespace prefix (A4H does): the vendor parser looked up a case-sensitive path. Where-used now goes through abapsmith's own `fetchUsageReferences` (`src/adt/element-info.ts`), which the call graph shares.
- `abap_read` `depth` out of range is a structured `BAD_INPUT` naming the applicable maximum (3 for `DEVC/K`, 10 for lineage) instead of a schema-level rejection.

## [0.6.4] - 2026-09-15

### Added

- `abap_ui mode="screen"` gains `layout: true` (#113): a `LAYOUT (design-time)` section rendering the dynpro's element grid as monospace text — frames as boxes with their titles, checkboxes and radio buttons as `[ ] label`, I/O fields as underscores of the field length, pushbuttons as `[ Text ]`, table controls as a labelled box with one header row of column names, tabstrips and subscreen areas as boxes — plus a fidelity note that this is the design-time layout, not the runtime rendering. Works with `program`/`dynpro` and with `tcode`; omitted or `false` leaves the response byte-identical; ignored under `mode="press"`. Renderer in `src/tools/ui-layout.ts`.
- `abap_data_preview` gains `format` and `mask` (#115): `format="abap_value"` emits one ABAP `VALUE #( … )` literal per row group (char-like fields quoted with `'` doubled, NUMC quoted, dates as `'YYYYMMDD'`, packed values with a leading minus, every line wrapped at 255 characters); `format="test_double"` emits a paste-ready ABAP Unit fixture on `cl_osql_test_environment`; `mask` blanks the named columns in every row, an unknown column is `BAD_INPUT` listing the real ones. The audit line records the format and a masked count, never the column names. Default output is unchanged. Renderers in `src/tools/preview-fixture.ts`.
- `abap_fluid {"tool":"core","action":"eval"}` (#118): runs a caller-supplied ABAP snippet (`lines`, each ≤ 255 characters, no line breaks) inside the fluid core class and returns the named `out` variables serialised. Off by default: needs `ABAP_ALLOW_FLUID_EVAL=1` (`ABAP_MODE=admin` alone does not enable it; the catalogue lists `eval` only when it is on) and `confirm: "core.eval"` on every call, otherwise `FLUID_EVAL_DISABLED`/`BAD_INPUT`. Every snippet passes the static review and capability scan before it runs — `DELETE FROM`, `COMMIT WORK` and other mutations are `FLUID_PLUGIN_MUTATE_DISABLED`, `CALL FUNCTION` additionally needs `ABAP_ALLOW_FLUID_CALL_FM`, `DESTINATION` is refused — and every executed evaluation is journalled with its full lines and marked irreversible. A runtime exception in the snippet is a clean `FLUID_ACTION_FAILED` with the ABAP message, never a dump.

## [0.6.3] - 2026-09-15

### Added

- Transport landscape support in `abap_transport` (#88): `operation="log"` reads a request's transport log (`TRINT_GET_LOG_OVERVIEW` overview row per target system plus the `tp` log lines from `TRINT_GET_LOG_FILE`), with an E070 pre-check so a nonexistent request is `NOT_FOUND` instead of the fake "not yet imported" row the function module would otherwise answer; `operation="queue"` reads a target system's TMS import buffer (`TMS_MGR_READ_TRANSPORT_QUEUE`, optional `domain`), every lock-clearing and cache-refreshing flag forced off, and an unknown system maps to `NOT_FOUND` with a TMSCSYS/TCESYST hint; `create` with `kind="copies"` and a required `target` creates a transport of copies (`TR_INSERT_REQUEST_WITH_TASKS` type `T`) in a transportable package, journalled like other creates. `show` decodes E070 function and status codes to labels. All three run through the fluid `classic` bridge with every `CALL FUNCTION` actual declared as a typed local (a `string` actual dumps with `CX_SY_DYN_CALL_ILLEGAL_TYPE` at runtime, not at activation). Proven live on A4H; a non-empty log or queue and a routed release remain `unverified` because A4H has no transport route. Triggering an import (STMS) is deliberately not implemented and documented in `doc/LIMITATIONS/not-implemented-and-unproven.md`.

## [0.6.2] - 2026-09-15

### Added

- Application log reader `abap_fluid {"tool":"log","action":"read"}` (#108): the tenth built-in fluid tool reads SLG1/BAL log headers filtered by object, subobject, extnumber, user, tcode, program and a time window (`last_seconds` or `since`/`until`, defaulting to the last hour), and with `detail="messages"` the rendered messages of each log through the documented `BAL_DB_SEARCH` → `BAL_DB_LOAD` → `BAL_LOG_MSG_READ` pipeline. Every response carries a business-data warning, the resolved window and a truncation flag, and the server writes an audit line naming only object and counts. `abap_run`, `abap_test`, `abap_bopf_test` and `abap_ui mode=press` now append a correlation hint pointing at the `log.read` call that covers the run they just made.
- `abap_read view="docu"` (#109): SAP long texts (`DOKHL`/`DOKTL`, via the `core` fluid tool's new `docu` action and `DOCU_GET` + `CONVERT_ITF_TO_ASCII`) for classes, interfaces, programs, function modules, data elements, tables, messages (`BM 019` or `BM019`) and IMG activities (`type="SIMG"`); with `method=` on a class it returns that method's ABAP Doc comment without any fluid call. Unsupported view combinations (`format="raw"`, `enhancements`, `version`, `outline`, `include`) are refused with `UNSUPPORTED`.
- `abap_read view="digest"` (#110): a bounded one-page overview of a `CLAS/OC`, `INTF/OI`, `PROG/P`, `FUGR/F`, `FUGR/FF` or `DDLS/DF` object in six fixed sections (HEADER, PUBLIC API, DIRECT DEPENDENCIES, TESTS AND CHECKS, RECENT HISTORY, WHERE TO GO NEXT), each capped at 25 rows with a `--- TRUNCATED ---` line naming the exact follow-up call. Function-module signatures are parsed from the native `FUNCTION … IMPORTING … EXPORTING … TABLES … CHANGING … EXCEPTIONS … RAISING … .` statement (the legacy `Local Interface:` comment block is a fallback), and a parameterless module says so explicitly. A bare `FUGR` is refused as ambiguous. Proven live on A4H against `CL_ABAP_TSTMP`, `RSPARAM`, `BAL_LOG_MSG_READ`, `BAPI_USER_GET_DETAIL` and a customer class with a local test class.

## [0.6.1] - 2026-09-15

### Added

- `abap_fpm_read mode=events` (#101): resolves the toolbar events of a UIBB or application configuration to the code that handles them. The response carries a `VIEWS` section (config ID, kind, feeder class, BO and node per UIBB), an `EVENTS` section (toolbar element with its `Transl` text resolved from WDY_CONFIG_COMPT, event ID, and a handler classified as `bopf`, `feeder`, `app_controller`, `standard`, `action_impl` or `unresolved`, each with the exact follow-up `abap_bopf` or `abap_read` call) and a `WIRES` section (source UIBB, target UIBB, connector class). `uibb` narrows the views and names what was skipped; every response discloses the coverage limits (app-controller override, personalisation, CBA/deltas, nothing executed). Proven live on `/BOFU/TEST_FBI_SALES_ORDER_OVP` and `/BOFU/TEST_CUSTOMER_OIF`.
- `abap_ui mode=fcode` (#102): from a GUI-status function code to the PAI module and `CASE` branch that handles it, by `tcode` or `program`+`dynpro`, for one `fcode` or all of them. Follows ok_code aliases, several top-level `CASE`s and one remap hop (rendered as its own `via remap … at line N` row), flags `AT EXIT-COMMAND` modules, labels `CALL TRANSACTION`/`LEAVE TO TRANSACTION`, and reports modules without an ok_code `CASE` as `unresolved`. Read-only: never asks for `confirm` and does not need `ABAP_ALLOW_UI_PRESS`. Proven live on `SM30`/`UPD` (`SAPMSVMA` 0100, remap `UPD -> UPDL`) and `SE16`/`BACK`.
- Skill `abapsmith-research-code` (#103): Procedure A (find usages: objects search → where-used → source-text search → element info → report) and Procedure B (button → code: classify the UI, then `mode=fcode` for dynpros, `mode=events` for FPM, the debugger or `abap_ui mode=press` as the last resort with the gates named). Routed from `abapsmith-orient` and listed in the plugin manifest.

### Changed

- The fluid FPM builtin's `read_config` not-found errors now name the configuration key (`config … type … var …`).

## [0.6.0] - 2026-09-15

### Removed

- The experimental `v2` tool surface (`ABAP_TOOL_SURFACE=v2`: the six consolidated tools `abap_find`, `abap_read`, `abap_write`, `abap_do`, `abap_debug`, `abap_adt`) is gone, as announced in 0.5.10 (issue #76). `src/tools/v2/` and its fourteen test files were deleted; the single remaining surface is always registered and `toolSurface` is no longer a config field. Startup now classifies `ABAP_TOOL_SURFACE`: `v2` and any unrecognised value fail with "Invalid abapsmith configuration" (naming `CHANGELOG.md` and the design note), `v1` starts with one deprecation warning, unset is silent. The one v2-path file with a live caller, `src/tools/v2/edit.ts`, moved to `src/tools/edit.ts`. The reasoning (what the A/B measured, why it never reached v1 reliability, what a future consolidation must prove first) is in the new `doc/DESIGN-NOTES/tool-surface-v2.md`; every doc, skill and test sentence that qualified behaviour by surface was rewritten. All four startup outcomes and the 28-tool `tools/list` were proven on the built server.

## [0.5.21] - 2026-09-15

### Added

- `abap_test scope="impacted"` (issue #111): instead of one named object, select and run the test carriers a changed set puts at risk. The changed set comes from an explicit `changed` list, from the local write journal for this system and session, or from the journal since an ISO timestamp (`since`); each changed object is a candidate carrier itself (`changed directly`) and its where-used consumers (CLAS/PROG/FUGR, at most 20 per object, at most 10 carriers in total) are probed for a test class (`uses <object>`). `SELECTION` and `RESULTS` are reported separately, capped consumers are named on a `--- TRUNCATED ---` line, and two distinct not-a-pass outcomes exist: `NO CHANGED OBJECTS` and `NO IMPACTED TESTS FOUND`. `object`, `coverage`, `coverage_for`, `auth_trace` and `changed`+`since` are refused with `BAD_INPUT` in this scope (`src/adt/impacted.ts`, `src/journal.ts` `since`/`systemKey` filters).
- `auth_trace: true` on `abap_run`, `abap_test` and `abap_bopf_test` (issue #112): switches SAP's authorization trace on for the connected user around the run, reads back failed authority checks (kernel trace first, SU53 buffer as fallback, each line tagged `[trace]` or `[SU53 fallback]`) and switches it off again on every path, including a dump. The header always carries `auth_trace: no failed checks` / `N failed check(s)` / `unavailable: <reason>`; failed checks render as a `FAILED AUTH CHECKS` section (object, field=value, rc, program, line). Implemented as the built-in fluid tool `authtrace` (`ZCL_ZMCP_FLUID_AUTHTRACE`); refused in read mode. Live-verified on A4H via the SU53 fallback; the kernel-trace read returned no rows on the appliance and is unverified.

### Fixed

- The v2 `abap_do` activation handler no longer asserts a non-optional `object` (a crash path for `scope="impacted"`).

## [0.5.20] - 2026-09-15

### Added

- `SHLP/DH` (search help) is now readable, searchable and fully writable (issue #83): `abap_search` resolves it, `abap_read` renders a pseudo-DDL read (header, parameters, assignments, USED BY DATA ELEMENTS, INCLUDES/INCLUDED BY) from a plain-text catalog `SELECT` (`src/adt/catalog-query.ts`, `src/adt/catalog-read.ts`) that also works under `ABAP_MODE=read`, and `abap_write` creates, replaces (`mode="update"`) and deletes one through the classic fluid bridge (`RS_CORR_INSERT` → `DDIF_SHLP_PUT` → `DDIF_SHLP_ACTIVATE`) with a new `shlp` argument. Delete refuses with `CHECK_FAILED` while the help is still attached to a data element, table/view field or collective help unless `confirm_in_use: true`; it is journalled with a before-image but stays irreversible.
- `VIEW/DV` (classic database view) read-back and `mode="update"` (issue #84): `abap_read` renders base tables and fields from the catalog; an update replaces the whole projection (`base_table` + `view_fields`); delete refuses while a generated SE54 maintenance dialog (`TVDIR`) exists unless `confirm_maintenance_dialog: true`.
- `TRAN/T` (transaction) read and `mode="update"` (issue #85): `abap_read` renders the started program, authorization checks and role assignments; an update retargets an existing transaction to another existing program (`RPY_TRANSACTION_DELETE` + `RPY_TRANSACTION_INSERT` under one `RS_CORR_INSERT`) and, like delete, refuses while the tcode sits in a role menu (`AGR_TCODES`) unless `confirm_in_role_menu: true`. All three types are proven live on A4H; a transportable (non-`$TMP`) create is still unverified.
- `SHLP/DH` create and update now cover collective search helps, not just elementary ones, through the same classic fluid bridge (`RS_CORR_INSERT` → `DDIF_SHLP_PUT` → `DDIF_SHLP_ACTIVATE`); both shapes are proven live on A4H (issue #83).
- Four refusals stop a search-help write from creating an inactive-only leftover after a `DH109` activation failure ("search help & was not activated", caused by a dangling `DD31V` include or `DD33V` assignment reference): two zero-network `BAD_INPUT` checks in `src/adt/shlp-create.ts` (`assignments[i].field` must be one of the call's own `fields[].name`; `assignments[i].includedHelp` must be one of the call's own `includes[].name`), and two server-side `CHECK_FAILED` checks generated into the ABAP that runs before `RS_CORR_INSERT` in `src/adt/fluid/builtin/classic/abap-shlp.ts` (every `DD31V-SUBSHLP` must exist as an active search help; every `DD33V-SUBFIELD` must be an interface parameter of its included help, except a self-referencing assignment). `rc = 4` / `DH108` ("activated with warnings") is now recognized as a success and reported with a `ZMCP-DDIC-NOTE` line instead of passing silently (issue #83).
- `SHLP/DH` `mode="delete"` now also reaches an inactive-only search help (one left behind by a `DH109` failure or stranded by any other means): `readSearchHelp` (`src/adt/catalog-read.ts`) gained an `{ includeInactive }` option, and the catalogue query builders (`src/adt/catalog-query.ts`) take a version-state argument instead of a hard-pinned active predicate. The create/update "already exists" probe and `abap_read` deliberately stay active-only (issue #83).

### Removed

- The zero-network refusal on `SHLP/DH` create/update for `elementary: false` with an empty `includes` ("has nothing to collect") was removed: a collective search help with no includes activates fine on a real system (issue #83).

### Fixed

- `mode="update"` on a type without a bridge update route is refused zero-network with `BAD_INPUT` instead of falling through to a misleading "`source` is required" error (issue #83).
- The classic fluid bridge sent nested objects that its single-pass ABAP argument reader could not parse; bridge arguments are now flattened in one place (`src/adt/fluid/flat-args.ts`), which is what made search-help fields, includes and assignments reach the server at all (issue #83).
- An elementary search help's own DD31S self-row no longer counts as a collective help including it, so elementary helps are no longer permanently "in use" for delete (issue #83).
- `DD33S-VALUEDIREC` is now decoded on read instead of rendered as the raw stored code, and a `DD31S` self-row (a search help reading back its own include of itself) is suppressed instead of being listed as an include (issue #83).

## [0.5.19] - 2026-09-15

### Added

- `abap_debug action="breakpoints"` (`op="list"|"add"|"remove"`) and `action="watch"` (`op="add"|"list"|"remove"`, optional ABAP-expression `condition`) edit breakpoints and watchpoints while a debuggee is suspended, without ending the session (issue #89). Breakpoint kinds `exception`, `statement` and `message` join `line`, mixable in one `start` call; a `start` that lands in SAP framework code on a statement breakpoint auto-continues up to 10 times and lists the skipped frames in a note. Live captures 900–951.

### Fixed

- Each debug session now holds its own unpooled ADT connection, released on `stop`, on a force-clear and on a failed `start`, so a clean stop no longer leaves a stale attachment that makes the next `start` fail with "Debuggee already attached" (issue #89). Six consecutive start/stop cycles in one process were verified live on A4H.
- Breakpoints added or removed while suspended took effect one stop-cycle late: SAP's notify chain replaces the debuggee's runtime breakpoint set with exactly the POSTed body, so the delta POST silently wiped already-armed breakpoints. `add`/`remove` now POST the full owned set (issue #89).
- A second `start` while a session holds the only lane is refused with `DEBUG_ALL_LEASES_BUSY` (naming `ABAP_DEBUG_SESSIONS`) at every lane count, not `UNSUPPORTED` (issue #89).
- `doc/TOOLS/debugger.md` gains a "Connection hygiene" section, statement-breakpoint scope notes (`RAISE` vs `RAISE EXCEPTION TYPE`) and moves conditional watchpoints out of "Not verified" (issue #89).

## [0.5.18] - 2026-09-15

### Added

- `abap_service op="publish"` and `op="unpublish"` for OData V2 and V4 service bindings (issue #82): `runPublishJob` drives the ADT `businessservices/odatav{2,4}/(un)publishjobs` endpoints and raises `SERVICE_PUBLISH_FAILED` on a non-success job status. Publishing needs `ABAP_ALLOW_SERVICE_PUBLISH`, the `confirm` echo and a customer-namespace binding in an allowed package; it is journalled as an irreversible `service-publish`/`service-unpublish` entry written before the POST. V4 bindings resolve their `<odatav4:serviceGroup>` and the SRVB read uses media type v2. Verified live on A4H for a V2 and a V4 binding, publish and unpublish each confirmed by a follow-up read; the docs now carry that evidence instead of the earlier "unverified" wording.

### Fixed

- `doc/LIMITATIONS/editing.md` documents that a V2 publish leaves behind an `IWVB <binding>_VAN` vocabulary-annotation object which abapsmith cannot delete (issue #82).

## [0.5.17] - 2026-09-15

### Added

- `abap_trace`, a runtime tracing/profiling tool over the ADT trace APIs (issue #77): `op="start"` creates a trace request for a program, class method or transaction and executes it, `op="list"` shows the trace runs of the current user, `op="read"` returns a run as `view="hitlist"` (aggregated statement hit list), `view="tree"` (call tree, with `depth` and a `root` anchor that re-roots the tree at the first matching statement, reporting the absolute level in a note) or `view="dbaccess"`, and `op="delete"` removes a run. Tracing is gated as `execute` because a trace request is persistent server-side state. Unknown argument keys are refused with `BAD_INPUT`, and `depth`/`root` under any view other than `tree` are refused instead of being silently ignored. Verified live on A4H against a report and a class method.

## [0.5.16] - 2026-09-15

### Added

- `fluid-plugins/jobs`, an operator-installable fluid plugin covering the SM37 surface (issue #90): `list` (TBTCO by name pattern, user, status and date window), `show` (header, TBTCP steps and the job log via `BP_JOBLOG_READ`), `spool` (a step's list output via `RSPO_RETURN_ABAP_SPOOLJOB`), `schedule` (`JOB_OPEN`/`JOB_SUBMIT`/`JOB_CLOSE` for one existing executable report, immediate, timed or held; OS commands and external programs are refused structurally) and `cancel` (`BP_JOB_ABORT` for a running job, `BP_JOB_DELETE` for a scheduled one, own jobs unless `any_owner`). `schedule` and `cancel` are mutate actions behind `ABAP_ALLOW_FLUID_PLUGIN_MUTATE`, need the `confirm` echo and are journalled as irreversible. Ships with a README, loader tests and was verified end to end on A4H, including `show` on a held job that has no log yet.

## [0.5.15] - 2026-09-15

### Added

- `abap_read` `view: "definition"` answers what the identifier at a `line`/`column` is and where it comes from (issue #91): the element's kind, declaring object, visibility and ABAP type, a `DEFINITION` section with an `abap_read` reference to the declaration, a `SIGNATURE` (or `(none)`) or `COMPONENTS` table, ABAP Doc, and for an interface method an `IMPLEMENTED BY` list gathered from a where-used call — from a use site or from the interface's own `METHODS` declaration. A position on nothing resolvable, on the declaration itself (SAP message ED263) or on a method with more than one implementation (`SEDI_ADT 2`) is reported as prose, not as an error. Verified live on A4H; twelve new live captures (952–964) back the parsers.
- `abap_activate` `mode: "format"` runs the ABAP pretty printer (issue #91): with `source`, it returns the formatted text and writes nothing; with `object`, it rewrites the object formatted, journals the change so `abap_journal` `mode: "undo"` restores it, and reports `changed: false` without locking or writing when the source is already formatted.

### Fixed

- The `IMPLEMENTED BY` list no longer depends on the vendor `abap-adt-api` where-used parser, which reads the `usageReferences:` namespace prefix while A4H sends `usagereferences:` and so always returned nothing; the request is issued and parsed locally, accepting either prefix (issue #91).

## [0.5.14] - 2026-09-12

### Added

- `abap_atc` covers the ATC workflow end to end (issue #78): `op: "variants"` lists the system's check variants from a repository quickSearch and marks the default from the ATC customizing read; a named `variant` is validated against that list and refused with `BAD_INPUT` before any run is posted; `objects` runs a group of objects in one request and reports the distinct target count; `package` runs a whole package, with `include_subpackages` discovering sub-packages first and a `TIMEOUT RISK` note on large scopes; `delete_worklist` and `auto_cleanup` report A4H's `405` refusal honestly — the worklist stays and keeps accumulating findings, and the `?action=deleteFindings` no-op is never used as a substitute. Verified live on A4H against `$TMP` and `$ABAPSMITH_FLUID_API`; eight new live captures (886–893) back the parsers.

### Fixed

- An ATC run that exceeds the request timeout is classified as a timeout, not a generic `ADT_ERROR`: the message says the outcome on the server is unknown, names the worklist it posted to when one is already known, and points at `ABAP_TIMEOUT_MS` or a narrower scope (issue #78).
- The two disclosed ATC name-list cuts are allow-listed in the truncation lint with their `… [truncated, <shown> of <total> shown]` markers (issue #78).

## [0.5.13] - 2026-09-12

### Added

- `abap_read` of a package (`DEVC/K`) lists its contents (issue #74): header counts (`objects`, `sub_packages`, `depth`), a `SUB-PACKAGES` section, an `OBJECTS` table with type, name and description, a `types` filter of kind codes, `depth` (1–3) breadth-first recursion into sub-packages with a round-trip cap, and paging over large packages. A note names any sub-package that was listed but not expanded. Verified live on A4H against `$TMP` (390 objects, one sub-package).
- `abap_read` of a table (`TABL/DT`) gains an `INDEXES` section, and a secondary index is readable on its own as `abap_read {"object":"<TABLE>/<INDEX>","type":"TABL/DI"}` from a DD12V/DD17S catalog read (issue #86).
- `abap_read` of an authorization object (`SUSO/B`) renders its class, description, fields with their data elements and the permitted activities from TOBJ/TOBJT/TOBCT/TACTZ/TACTT/AUTHX/DD04L/DD07V (issue #87). Read-only; `abap_write` still refuses the type.
- `abap_write` create and delete of a secondary index (`TABL/DI`) report a definitive verdict from a post-write catalog re-read — `verified`, `index_present`, `index_active` — instead of the bridge's own `ACTFAILED` flag, which is no longer surfaced in `markers`; a `TABL/DT` delete reads the table's indexes beforehand and reports them (issue #86).
- `abap_write` accepts the same `<TABLE>/<INDEX>` slash form as `abap_read` for `TABL/DI`, with or without `base_table`; a `base_table` that disagrees with the table named in `object` is refused with `BAD_INPUT` naming both values (issue #74).

### Fixed

- Package listings paired each object with the wrong description: the `DESCRIPTION` column of ADT's nodestructure response is misaligned against `OBJECT_NAME` on the server side (reproduced with raw HTTP on A4H). Descriptions are now looked up by exact `(type, name)` key through the repository search, and an unresolved row renders empty and is counted in a note rather than guessed (issue #74).

## [0.5.12] - 2026-09-12

### Added

- `abap_test` reports ABAP Unit coverage on request (issue #75): `coverage: true` runs the tests with coverage measurement and adds a `coverage: statement n/m (p%), branch …, procedure …` header field, a `COVERAGE` section with per-class and per-method rows, `UNCOVERED METHODS`, `COVERAGE NOT REPORTED FOR`, and `ALSO TOUCHED` (objects the run executed but did not measure). `coverage_for` extends the measured set beyond the objects under test; without `coverage` it is `BAD_INPUT` before any request. The measured set is capped at 10 objects because a coverage query over a full roster timed out at 60 s on A4H. A coverage failure degrades to a note and never changes the run outcome. Verified live on A4H, including the `UNCOVERED METHODS` wording.
- Deleting a class records all four includes (`definitions`, `implementations`, `macros`, `testclasses`) in the journal entry, `abap_journal mode=show` lists them with an `include` column, and `mode=undo` recreates the class with every recorded include and activates once at the end, reporting `restoredIncludes`/`skippedIncludes`; a fully recorded recreate no longer needs `force` (issue #75). Undoing a write to a sub-include restores that include, not `main`. Verified live: delete, undo, and the restored test class ran again.
- New skill `abapsmith-write-abap-unit-tests`; the ABAP Unit capability rows are re-graded from the live evidence.

### Fixed

- `test/undo.test.ts`'s fake class server answered the four include URIs with an empty 200, which read as "captured, empty"; it now answers 404 so absence is distinguishable from an empty include (issue #75).

## [0.5.11] - 2026-09-12

### Added

- Four more credential methods next to password and session cookie, exactly one of which must be configured (issue #79): client certificate (`ABAP_CLIENT_CERT` as PEM or PKCS#12, `ABAP_CLIENT_KEY`, `ABAP_CLIENT_KEY_PASSPHRASE`), static bearer token (`ABAP_TOKEN`, reported as `AUTH_EXPIRED` when rejected, never refreshed), OAuth 2.0 client credentials (`ABAP_OAUTH_TOKEN_URL`/`ABAP_OAUTH_CLIENT_ID`/`ABAP_OAUTH_CLIENT_SECRET`/`ABAP_OAUTH_SCOPE`, cached token with one 401 refresh-and-retry and a failure cooldown, `AUTH_TOKEN_REFRESH_FAILED`), and a BTP service key (`ABAP_SERVICE_KEY`) that supplies the OAuth settings. `ABAP_CA_CERT` verifies the server certificate with any method. Configuring more than one credential refuses to start. Certificate, token and OAuth logon are unit-tested against fakes and marked `unverified` in `doc/CONFIGURATION/connection.md` and `doc/LIMITATIONS/authentication.md`; A4H offers none of them. Verified live on A4H: password logon unchanged, `ABAP_TOKEN` against a basic-auth system reports `AUTH_EXPIRED` naming the variable, and both the exactly-one-of rule and an unreadable certificate path are refused at startup with the offending variable named.
- System-role detection records `tenantKind` (`on-premise`/`cloud`/`unknown`) from the already-fetched `ato/settings` body; it never feeds the productive-system gate (issue #80). Cloud-tenant detection is unverified: no cloud tenant was available.

### Fixed

- The debugger's long-poll request (`agent: false`) copied only `rejectUnauthorized` off the shared TLS agent, so on a certificate-authenticated system it would have connected without the client certificate; it now carries `ca`/`cert`/`key`/`pfx`/`passphrase` on both the direct and the proxy branch, proven by a local `requestCert: true` server in `test/tls-policy-agreement.test.ts` (issue #79).
- `src/config.ts` promised a sy-uname mismatch report that nothing implemented; the promise is removed and the gap is documented in `doc/LIMITATIONS/authentication.md` (issue #79).

## [0.5.10] - 2026-09-12

### Deprecated

- The `v2` tool surface (`ABAP_TOOL_SURFACE=v2`) is deprecated and will be
  removed in 0.6.0. Selecting it now logs one warning line at startup and
  states the removal release in the server instructions; the surface is
  frozen. `v1` is the only supported value. (issue #76)

### Added

- Four diagnostic skills: `abapsmith-debug-a-failing-run`,
  `abapsmith-run-tests-and-fix`, `abapsmith-check-code-quality` and
  `abapsmith-explore-a-package`, each with the tool sequence, the refusals
  to expect and a transcript from a live system. `abapsmith-orient` routes
  to all four. (issue #92)

## [0.5.9] - 2026-09-12

### Added

- `abap_search mode=source` searches source text across the repository in one
  call: literal or regex `query`, scope by `packages` (with
  `include_subpackages`), `objects` pattern and `types`, `case_sensitive`,
  `include_comments`, `max`. Hits carry object, include and include-local line
  number; truncation is marked with honest object and hit counts. Backed by a
  new built-in fluid tool `scan` (deployed on first use, kernel `FIND PCRE`),
  so it needs the fluid API and a writable mode. (issue #72)

## [0.5.8] - 2026-09-12

### Added

- `abap_data_preview` takes a structured filter: `where` (typed conditions
  `eq`/`ne`/`gt`/`ge`/`lt`/`le`/`in`/`like`/`is_null` and friends), `columns`,
  `order_by` and `distinct`. Fields are validated against the entity's own
  column list (one probe request), literals are rendered by DDIC type, the
  response carries `filtered`, `total_rows` and the statement that was sent
  plus the server's compiled echo, and truncation explains keyset paging.
  Unfiltered calls are byte-identical to before. (issue #73)

## [0.5.7] - 2026-09-12

### Fixed

- `abap_write` no longer lets a named `corr_nr` be overridden in silence.
  When CTS already records the object in a different request, the transport
  resolver still imposes that request (it is the only one CTS accepts), but it
  now carries the caller's number out, and `mode=delete` is refused before any
  lock is taken: `TRANSPORT_ERROR` with `details.reason
  "CORR_NR_NOT_HONOURED"`, `details.stage "preflight"`, `details.lockCorrNr`
  naming the recording request and `details.deleted: false`. The DEVC/K
  package-delete bridge and enhancement deletes go through the same check. A
  write (create or edit) in the same situation is not refused, because the
  caller can move the object with `abap_transport removeObject` and retry, but
  its header reports `corr_nr_honoured: false` and the note names both
  numbers instead of asserting that the caller's number "is the number this
  write sent". The delete dry run predicts the refusal. Docs no longer claim
  that create-then-delete reliably produces duplicate E071 rows, which did
  not reproduce live (issue #65).

## [0.5.6] - 2026-09-12

### Fixed

- `abap_transport show` and the `abap_transport_release` dry run now answer
  "did abapsmith create this request?" from durable evidence instead of the
  running process's memory. The header field is `createdByAbapsmith`: `yes
  (this server process)` when this process minted it, otherwise `yes (journal
  entry <id>)` when the journal holds a successful `transport-create` entry for
  the number on the connected system, `no (not this process; no journal entry
  on <SID>)` when it does not, and `unknown — …` when the journal is off or
  unreadable. This also covers requests from `abap_img_edit create_request`,
  which journal but never registered in-process ownership. The armed-release
  gate is unchanged: `confirm_unowned` still counts only requests created by
  the running process, and both notes say so. The TASKS table gains a `type`
  column (the raw `tm:type` CTS sends, one-letter TRFUNCTION values glossed),
  and a task-number lookup reports `requestedType` next to `requestedStatus`,
  so the `taskType` that `create_request` reports can be confirmed
  (issue #67).

## [0.5.5] - 2026-09-12

### Fixed

- `abap_img_edit` now discloses the maintenance-view checks it cannot run.
  The tool writes rows with a plain `MODIFY`/`DELETE` on the base table, so
  the view's event routines (for `TB003`, `V_TB003_CHECK_DEFAULT` and
  `V_TB003_RESET_DFLT`, which SM30 runs to enforce `STND_ROLECAT`) never
  execute. Every preview and armed response now carries a
  `--- CHECKS NOT RUN ---` section naming the root maintenance views over the
  table, their registered TVIMF event routines, the written fields' check
  tables and domains, and any written value that is outside a domain's fixed
  values (reported as "SM30 would have rejected this input; this tool does
  not", not refused). When nothing is registered the section says so and
  that only DDIC typing was enforced. Write semantics, arguments and the
  confirmation gate are unchanged (issue #62).

## [0.5.4] - 2026-09-12

### Fixed

- On the v1 surface a read-only server (`ABAP_MODE=read`, or the legacy
  `ABAP_ALLOW_WRITE` unset) no longer hides its write-gated tools, so a caller
  no longer gets an MCP "Tool not found" for `abap_write`, `abap_run`,
  `abap_test`, `abap_atc`, `abap_quick_fix`, `abap_ui`, `abap_fpm_read`,
  `abap_img_edit`, `abap_bopf_test`, `abap_bopf_edit`, `abap_bopf_delete`,
  `abap_transport_release` or `abap_fluid`. Each is registered as a locked
  stub: empty schema, a description ending `LOCKED on this server: …`, and a
  handler that returns a structured `READ_ONLY` refusal naming the current mode
  and the lowest mode that unlocks the tool (`details.requiresMode`), with no
  connection behind it so nothing reaches the SAP system. The v1 instructions
  mention the count. v2 is unchanged; `abap_data_preview` with
  `ABAP_ALLOW_DATA_PREVIEW` off stays absent because that is a flag, not a mode
  (issue #63).

## [0.5.3] - 2026-09-12

### Fixed

- `abap_transport operation=removeObject` refused by CTS (`CTS_DUPLICATE_ENTRY`)
  left its `transport-remove-object` journal entry `pending` forever, so
  `abap_journal mode=list` reported it as STRANDED although nothing on the
  request had changed. A refusal whose ABAP transcript names no removed E071
  row now settles the entry as `failed` (description suffixed `— refused,
  nothing was removed`); a lost response or a failure after a removed row still
  stays `pending`. New `abap_journal mode=reconcile entry=<id>
  outcome=succeeded|failed reason=…` (v2: `abap_do action=journal_reconcile`)
  closes a stale `pending` entry by hand with one appended patch line, refuses
  anything already settled, takes no `object` fallback and makes no network
  call; `list` shows a `reconciled` flag and `show` prints the reconciliation
  (issue #66).

## [0.5.2] - 2026-09-12

### Fixed

- `abap_read` no longer refuses a function module named without its group
  (`{"type":"FUGR/FF","object":"BUP_ROLES_GET_ALL"}` → `BAD_INPUT … needs its
  function group`). The exact-name lookup sent `objectType=FUGR`, which selects
  function groups, so the module was never found and the group in its URI never
  seen. Parented types (`FUGR/FF`, `FUGR/I`) now search untyped, filter the rows
  back to the requested type, take the group from the URI and resolve when
  exactly one group matches; several groups refuse naming each candidate, none
  refuse explaining that generated modules (`ENQUEUE_*` …) are not indexed and
  need the group named. `abap_search` renders a `group` column between `name`
  and `package` whenever a row has a parent; searches without one keep their
  four columns. The FUGR/FF search-blind wording in write verification no
  longer claims modules are not indexed at all (issue #64).

## [0.5.1] - 2026-09-12

### Changed

- Skills, from building the shipped `nr` plugin with an orchestrator and subagents:
  `abapsmith-write-a-fluid-plugin` gains the body-class commit rule, a scratch-class
  syntax-check step, and the one-restart-per-fix-round rule for `op=repair`;
  `abapsmith-write-abap-source` gains the ABAP traps that activate cleanly and fail at run
  time (comments outside methods, `TYPE string`/`TYPE i` formals, untyped `CALL FUNCTION`
  actuals, positional `INTO TABLE`, character tests on `C(n)`) and is split by object type:
  `SKILL.md` keeps what applies to every source object and points at `classes.md`,
  `function-modules.md`, `programs.md` and `enhancements.md` in the same directory, so a
  reader loads only the file for the object being written. The skill tests
  (`test/skills-example-shapes.test.ts`, `test/skills-tool-surface.test.ts`) now scan those
  sibling files too.

## [0.5.0] - 2026-09-12

### Added

- New operator-installable fluid plugin `fluid-plugins/nr`: SAP number ranges (SNRO) — `list`,
  `describe`, `create`, `set_interval`, `get_next`, `delete` over the standard `NUMBER_RANGE_*`
  function modules. Enable it with `ABAP_FLUID_PLUGINS=<repo>/fluid-plugins` plus
  `ABAP_ALLOW_FLUID_PLUGINS`, `ABAP_ALLOW_FLUID_PLUGIN_MUTATE` and `ABAP_ALLOW_FLUID_CALL_FM`.
  Written by an opus orchestrator with sonnet subagents against the new skill and verified
  end to end on an A4H system.
- New skill `abapsmith-write-a-fluid-plugin`: the runtime contract, the argument-scanner and
  static-review limits, and the operator's enable-and-restart step — the facts a model cannot
  derive from ABAP knowledge alone when asked to add a fluid tool.
- abapsmith now installs a small set of generated ABAP objects into the connected SAP system,
  rather than leaving nothing behind between calls. They go into a local, non-transportable
  package, `$ABAPSMITH_FLUID_API`, which abapsmith creates on first use of a function that needs
  one. No transport is created or required for any of this, no ICF service is registered, no RFC
  destination is created, and no background job is scheduled. `ABAP_FLUID_API` (default `true`)
  is the switch: set it `false` to unregister `abap_fluid` itself and stop the
  `$ABAPSMITH_FLUID_API` package from ever being created, and pure-ADT tools are entirely
  unaffected either way. Full detail in `doc/FLUID-API/README.md`.
- **`ABAP_FLUID_API=false` is not "none of it".** With the flag off, `abap_run` report/class
  execution, `abap_fpm_read`, `abap_ui` (both `screen` and `press`), `abap_bopf_test`,
  `abap_img_edit` apply (including its CTS create-request path), `abap_enh`'s six create_*
  operations (create_spot, add_badi_def, add_filter_def, create_impl, set_filter_values,
  exercise), and the whole classic-call family (`abap_transport removeObject`, view-delete,
  tran-delete, package-create, package-delete) all stay registered but now refuse every call with
  `FLUID_API_DISABLED` — every one of those already worked in `0.4.0`, so turning this flag off
  is a real regression for an operator upgrading, not a no-op. `abap_enh`'s other operations —
  write_description, delete, set_impl_active, create_hook, and the read-only
  discover_hook_anchors — are plain ADT calls, not bridge deploys, and keep working. Everything
  else abapsmith writes — `abap_write`, `abap_activate`, the BOPF design-time tools, transports —
  is gated by `canWrite`, not by this flag, and is unaffected.
- A new tool, `abap_fluid`, with ops `run` (default), `list`, `describe`, `status`, `verify`,
  `repair` and `remove`; a bare call returns an info block, and `list`/`describe` make no network
  call. `abap_fluid(op="remove")` deletes the objects a scope names (`tool`, `invokers`, or
  `all`) but never the `$ABAPSMITH_FLUID_API` package itself: deleting a package requires
  deploying a helper class into it first, and a non-empty package can't be removed from inside
  itself, so an operator who wants the package gone drops it by hand once it's empty. Full op
  reference in `doc/TOOLS/abap-fluid.md`.
- Three new default-off safety flags: `ABAP_ALLOW_FLUID_PLUGINS` (load operator-supplied fluid
  plugins at all), `ABAP_ALLOW_FLUID_PLUGIN_MUTATE` (allow a plugin action categorised `mutate`;
  not implied by `ABAP_ALLOW_FLUID_PLUGINS`), and `ABAP_ALLOW_FLUID_CALL_FM` (allow the built-in
  `core.call_fm` action, which calls an arbitrary function module under the connected user's own
  SAP authorisations). `core.call_fm` is the widest blast radius in this feature, and the control
  on it is authorisation-shaped: the flag only decides whether abapsmith will issue the call, not
  what the call can do — that's the SAP authorisation concept's job.
- Every fluid object now carries a provenance marker naming the abapsmith version that deployed
  it. When an installed object's marker names a version strictly newer than the one running,
  classification reports a new `newer` state — distinct from `stale`/`present`/etc — and `run`/
  `repair` refuse to touch it (`FLUID_OBJECT_CONFLICT`, with `installed_version`/`our_version`
  details and a hint to upgrade abapsmith or run `abap_fluid op=remove`), so two abapsmith
  releases pointed at the same system can no longer treat each other's deploys as ordinary drift
  and rewrite them back and forth. `status`/`verify` report `newer` like any other state.
- A manifest may set `internal: true` (currently only the framework's own `rt` tool) to mark a
  tool as framework plumbing rather than something a caller should be routed to: it is left out of
  the `abap_fluid` tool description's route index and worked example, while `list`/`describe`
  still show it in full, flagged `internal: true`. Additive — `contract` stays `"1.0"`.
- `FluidRunResult`, and the `FLUID_ACTION_FAILED` error's details on failure, now carry
  `warnings`: human-readable notes for stray non-frame console output and for a value whose
  `OUTC`/`OUTE` reassembly could not be parsed. Neither ever fails a call on its own; both were
  previously silent.
- A plugin's ABAP source is now scanned at load time for a database-write statement or `COMMIT
  WORK`/`ROLLBACK WORK` (gated by `ABAP_ALLOW_FLUID_PLUGIN_MUTATE`) and for `CALL FUNCTION` in any
  form (gated by `ABAP_ALLOW_FLUID_CALL_FM`), in addition to the per-call gating those flags
  already did based on an action's declared `category`. Either statement found with its flag off
  refuses the whole plugin (`FLUID_PLUGIN_MUTATE_DISABLED` or `SAFETY_DENIED`), naming the object,
  file and line — closing the gap where an action with no `targets`, or a plain `CALL FUNCTION`
  outside any declared `mutate` action, previously loaded unchallenged.
- The loader now also refuses a plugin whose manifest claims an ABAP object name a different tool
  — built-in or another plugin, whichever loaded first — already claimed (`FLUID_OBJECT_CONFLICT`,
  naming both tool ids); previously only a duplicate name inside the same manifest was caught.

### Changed

- Generated objects that earlier releases wrote to `$ZMCP_HELPERS` or `$TMP` are relocated to
  `$ABAPSMITH_FLUID_API` the first time a loaded manifest that names them runs, by
  delete-then-recreate — an ABAP object can't change package, so this is a move, not a copy, and
  only objects a manifest actually names are ever touched. The retired pre-fluid bridge classes
  are a separate, closed list — ten from before the fluid API existed, plus seven retired since
  (the IMG write-apply and customizing-request-creation bridges, and `abap_enh`'s five create-family
  bridges, all superseded now that those paths dispatch against a fluid body class), seventeen in
  all: `abap_fluid(op="status")` reports each present/moved/unknown class individually, folding an
  all-absent result into a single aggregate "none" line rather than listing absent classes, and
  `abap_fluid(op="repair")` (with no `tool`) deletes the present ones. abapsmith never deletes a
  package: `$ZMCP_HELPERS` is the one it used to create, and an operator may drop it by hand once
  `status` shows it empty. `$TMP` is SAP's own standard local-development package, not abapsmith's,
  and is never something to drop — only the leftover `ZCL_ZMCP_*` objects inside it are left for
  the operator to clean up.
- `abap_fpm_read` (`find`, `outline` and `app`), `abap_ui` (`screen`), `abap_enh`'s create family
  (`create_spot`, `add_badi_def`, `add_filter_def`, `create_impl`, `set_filter_values`), and
  `abap_img_edit`'s `apply` and `create_request` now dispatch against the fluid API's static body
  classes (`ZCL_ZMCP_FLUID_FPM`/`_UI`/`_ENH`/`_IMG`) through a content-addressed invoker, instead
  of generating a throwaway `IF_OO_ADT_CLASSRUN` bridge class per call. Each tool keeps its own
  name, zod schema, annotations, domain gates and response shape; a refusal still names the
  dedicated tool, not `abap_fluid`. `abap_bopf_test`, `abap_ui` `press`, `abap_enh` `exercise`,
  `abap_fpm_read` `mode:"locks"`, and `abap_run`'s report execution still generate a per-call
  bridge, by design, because there is no fixed manifest to dispatch to when the ABAP has to be
  built fresh from the caller's own input every call.
- `abap_fluid status` gained a `DYNAMIC BRIDGES` section listing the five per-call bridge families
  that remain (`abap_bopf_test`, `abap_ui` `press`, `abap_enh` `exercise`, `abap_fpm_read`
  `mode:"locks"`, and `abap_run`'s report bridge), and `abap_fluid remove` gained an additive
  `scope: "dynamic"` that deletes every one of them.
- Removed the 50-row cap on `abap_img` preview reads and the 200-row cap on `abap_fpm_read`
  `find` queries (both its `WDY_CONFIG_APPL` and `WDY_CONFIG_DATA` branches); both now return
  every matching row. `abap_package delete`'s evidence listing (the TDEVC/TADIR contents shown
  before a non-empty package delete is refused) no longer caps at 20 rows either.
- Removed `abap_ui mode:"screen"`'s own caps too — the 30-status button-lookup loop and the
  350-row FKEY emission limit are both gone, since the response layer's own truncation already
  discloses when it cuts, and these caps were destroying data a step earlier than that.
- Generated invoker classes (`ZCL_ZMCP_I_...`) now accumulate in `$ABAPSMITH_FLUID_API` — each
  distinct call shape gets its own class, and nothing deletes them automatically.
  `abap_fluid(op="status")` counts them per tool, `repair(tool=...)` prunes stale ones, and
  `remove(scope="invokers")` sweeps all of them.
- No existing tool was renamed, removed, or changed shape, and `ABAP_TOOL_SURFACE` is unchanged;
  `abap_fluid` is purely additive. A read-only session — `ABAP_MODE=read`, legacy config (no
  `ABAP_MODE`) with `ABAP_ALLOW_WRITE` unset, a productive system, a failed role probe, or a write
  lockout — disables the fluid API completely; `abap_fluid` is not even registered when any of
  three statically-known conditions hold: `ABAP_FLUID_API=false`, `ABAP_MODE=read`, or `readOnly`
  is otherwise true. `readOnly` traces back to `ABAP_ALLOW_WRITE` only when `ABAP_MODE` is unset —
  once `ABAP_MODE` is set, `ABAP_ALLOW_WRITE` is ignored entirely and `readOnly` follows the
  mode's own capability instead.
- Operator note: a narrow `ABAP_ALLOW_PACKAGES` must now include both `$TMP` and
  `$ABAPSMITH_FLUID_API` — creating the package is judged against its superpackage `$TMP`, but
  every ordinary object write into it afterwards is judged against `$ABAPSMITH_FLUID_API`
  itself. Missing either one makes every bridge-backed tool, not just new ones, refuse at the
  package gate.
- Operator note: a narrow `ABAP_ALLOW_NAME_PREFIXES` (e.g. `Z,Y`) refuses the one-time creation
  of `$ABAPSMITH_FLUID_API`, since that name starts with neither `Z` nor `Y`. Widen the list once
  (or create the package another way); once the package exists, the prefix rule is never
  consulted for it again.

### Fixed

- The MCP `initialize` response now reports the real package version. `SERVER_VERSION` was
  hard-coded at `0.3.0` while `package.json` had already moved to `0.4.0`; it's now read from
  `package.json` at runtime so the two can't drift again.
- `img.apply`'s expert `client_field` escape hatch bypassed the same client-field split every
  other write path goes through, so `allow_cross_client: true` on a genuinely client-independent
  table could reach a live `MODIFY`/`DELETE` with a silently no-op client stamp. It now refuses
  upfront when the declared `client_field` is not a component of the target table.

## [0.4.0] - 2026-09-06

### Added

- `abap_img` — read-only navigation of the IMG (SPRO) customizing structure,
  in four modes (`search`, `show`, `tree`, `objects`). ADT has no IMG REST
  route, so it sends fixed, catalog-driven SELECTs (`src/adt/img-catalog.ts`)
  to the ADT freestyle data-preview endpoint — no ABAP is generated or
  deployed, so it registers under `ABAP_MODE=read`. Every table it actually
  queries is measured against a live system.

- `abap_img_edit` — writes IMG customizing rows: `preview`, `upsert`,
  `delete`, and `create_request` (a type-`W` customizing request). Writes go
  straight to the resolved base table with a guarded `MODIFY`/`DELETE`, not
  through the maintenance view's own SM30-generated function module, and
  are restricted to customizing delivery classes `C`/`G`/`E`. Transport
  bookkeeping reuses the same CTS calls SM30 itself uses
  (`TR_OBJECTS_CHECK`/`TR_OBJECTS_INSERT`/`TR_INSERT_REQUEST_WITH_TASKS`).
  Generated helper classes go into the new dedicated `$ZMCP_HELPERS`
  package, never `$TMP`.

### Fixed

- `abap_img_edit` defaulted an unset `language` to the two-character `EN`
  while `abap_img` defaulted to the one-character `E`; a second live run
  hit SAP's `HTTP 400 'EN' is not a valid value for C(1,0)` on the catalog
  query as a result. `CUS_IMGACT-SPRAS` (`ROLLNAME SPRAS`,
  `DATATYPE LANG`) is one character wide, and `SELECT DISTINCT SPRAS FROM
  CUS_IMGACT` on that system returns only `D E F I N P S`. Both tools now
  default from one shared constant, `IMG_DEFAULT_LANGUAGE = "E"`
  (`src/adt/img-query.ts`), and both schemas accept only a single letter
  (`^[A-Za-z]$`); a two-character ISO code like `EN`/`DE` is refused with
  `BAD_INPUT` naming the one-character form rather than mapped, since the
  ISO-to-SAP correspondence is installation-specific (`T002`/`T002C`) and
  a hardcoded map would risk silently querying the wrong language instead
  of erroring. The check applies wherever a language value reaches these
  tools, including a config-supplied `ABAP_LANGUAGE=EN`. `abap_img_edit`'s
  `preview` response header now prints the resolved language.

- `abap_img_edit`'s `create_request` failed to activate on that same live
  run: `"SY-UNAME" and the row type of "LT_USERS" are incompatible`.
  `IT_USERS`' row type, `SCTS_USER`, is a structure with exactly two
  fields — `USER` (`TR_AS4USER`) and `TYPE` (`TRFUNCTION`), measured from
  DD40L/DD03L — not the plain user-name insert an earlier entry here
  described. `IT_USERS` now fills that structure (`USER` = `sy-uname`,
  `TYPE` = `'Q'`, the customizing task type) so the request gets a task,
  and reports the number before checking for one — a first live run had
  lost a task-less request's number here. The response now also carries
  the task's type (`taskType`) alongside its number. Whether the function
  module honours `'Q'` or derives its own task type is unproven from
  here — only a live read-back settles it. A call with no confirmed
  number is `CHECK_FAILED`, not success, naming `abap_transport list` to
  recover it; both outcomes are journalled.

- The same live run's very first call, an `abap_img_edit` preview, was
  refused with `SAFETY_DENIED` rule `write-lockout` even though writes
  were live on that system: with the startup role probe suppressed, the
  T000 role verdict is only transcribed into the safety gate once some
  call has connected, and `abap_img_edit` consulted the gate before ever
  connecting, so a cold process could never get past its first call.
  It now connects first when the verdict is unknown, the same way
  `abap_write` already does — a process whose verdict is already settled
  still refuses without paying for a logon it doesn't need. The
  `write-lockout` rule itself is unchanged and intentionally fail-closed.

- `abap_img_edit`'s `upsert` refused a row that named only key fields with
  `BAD_INPUT: row 0 has no value fields to write` — a live run hit this
  arming a row on `TB004` (key `BPKIND`), whose only non-key columns are
  seven optional `FELDSTLSTn` field-status lists, a row SM30 itself
  accepts. A key-only `upsert` row is now legal: if it doesn't already
  exist it is inserted with the key fields and the client field set and
  every other column left initial; if it already exists nothing is
  written, and the per-row result reports `changed: no` with `row exists,
  no value fields to write` — a success, not a refusal. Unverified live as
  of this change.

- `preview` now runs the same plan validation `upsert`/`delete` enforce
  for real, instead of a looser check of its own — a row `preview`
  accepted (the key-only case above being one instance) could previously
  be refused once armed. The `corr_nr`/`confirm` requirements are still
  only reported as advisory notes on `preview`, never as a refusal, since
  `preview` never arms anything; every other check now matches exactly,
  so `preview` can also refuse a row it used to merely display, e.g. one
  naming a value field the table doesn't have.

- `abap_img_edit`'s resolved base table name is now printed upper-cased as
  SAP spells it, in the `confirm` token, the `preview` response header,
  and the transport-entry line — previously all three showed the
  lower-cased spelling the generated bridge happened to echo. The
  `confirm` comparison was already case-insensitive, so arming a write is
  unaffected.

- `abap_img_edit`'s generated apply bridge assigned `OBJ_NAME` on the
  `E071K` keys-table row it builds; that table has no such component —
  `E071K`'s object-name field is `OBJNAME` (`E071`/`KO200`'s own
  `OBJ_NAME` is unchanged and correct). The generated class failed to
  activate, so an armed `upsert` or `delete` could never write a
  customizing row. Now fixed, and documented: when the generated class
  fails to activate, the inactive class is left behind in the helper
  package, no journal entry is written, nothing is written to the target
  table, and no transport entry is filed.

- `abap_img_edit`'s generated apply bridge declared `lt_ko200`/`lt_e071k`
  `WITH EMPTY KEY` but passed them to `TABLES` formal parameters on the
  CTS function modules, which take a standard table with the DEFAULT key
  — a runtime type conflict that ADT's activation syntax check cannot
  catch. The generated class activated and ran, then threw
  `CX_SY_DYN_CALL_ILLEGAL_TYPE` at the first CTS call, so an armed
  `upsert`/`delete` still could not write a row and no transport entry was
  filed. Now declared `WITH DEFAULT KEY`; not re-verified live as of this
  change. The two CTS calls are now also wrapped so a runtime exception
  here becomes its own attributed transcript line naming the exception
  class, instead of surfacing only as a generic, unattributed error line,
  and a per-row write marker is now printed once a row's own
  `MODIFY`/`DELETE` returns successfully.

- An armed `upsert`/`delete` whose transcript could not be fully accounted
  for — a bridge error line, a missing `APPLIED` marker, a row with no
  after-image, or a delete row still present afterward — used to answer
  `ok` with that row's `changed` reported as `unknown`, with the failure
  visible only in the notes. It now throws `CHECK_FAILED` instead, with
  `details` carrying the table, mode, bridge class, a conservative
  `mayHaveExecuted` flag, and the errors/reasons found, and journals the
  mutation as `failed` rather than `succeeded`.

- A sixth live verification run (2026-09-06) confirms the `WITH DEFAULT
  KEY` fix above, and settles what was previously read only from the
  catalogue: an armed `upsert` on `TB004` called `TR_OBJECTS_CHECK` then
  `TR_OBJECTS_INSERT` successfully, filing a real `E071`/`E071K`
  transport entry, and a later `delete` of the same row also succeeded,
  adding no second key row. `TR_INSERT_REQUEST_WITH_TASKS` was proven the
  same run too: it created a real type-`W` customizing request, passed
  `TYPE = 'Q'`, and read back a task typed `'Q'` — consistent with the
  function module honouring the value passed, but not proof: a type-`W`
  request's task defaults to `'Q'` regardless of what `TYPE` asks for,
  so this observation alone cannot distinguish the two; only passing a
  different `TYPE` and reading it back would settle it. `TR_OBJECTS_CHECK`/
  `TR_OBJECTS_INSERT` are no longer interface-only knowledge read from
  FUPARAREF/DOKTL — docs describing them that way are corrected.

- That same run measured the exact shape of what a customizing write
  files: an `E071` header row for the maintenance view (`R3TR VDAT
  <view>`, `OBJFUNC` `K`), and an `E071K` key sub-entry beneath it for
  the base table (`PGMID R3TR`, `OBJECT TABU`, `OBJNAME` = the table,
  `MASTERTYPE`/`MASTERNAME` = the resolved master type and view, `TABKEY`
  = the client followed by the key, e.g. `001ZTMD`), with `SORTFLAG`/
  `LANG` both left blank and `AS4POS` `000001`, landing on the request
  itself rather than a task under it. `abap_img_edit`'s armed success
  response now discloses this directly, under a `TRANSPORT ENTRY
  RECORDED` section: an identity line (`R3TR TABU <TABLE> (master
  <MASTERTYPE> <VIEW>)`) above the per-row table, whose `tabkey` column
  now carries the client and key together; a transcript with no client
  line renders `tabkey` unprefixed and says so in a note, rather than
  fabricating one. There is still no tool that reads `E071K` directly —
  this disclosure is the only view into it short of SE01/SE09.

- Documented that `abap_transport` `removeObject` resolves the object it
  is given against a request's `E071` header rows only, which a
  customizing write files for the maintenance **view**, not the base
  table — asking to remove the table name (or a text-table variant)
  answers `NOT_FOUND` correctly, since only the view has a header entry;
  removing the view's entry takes its `E071K` key sub-entry with it. Not
  a behavior change — `removeObject` already worked this way — only the
  guidance describing it was missing.

- A seventh live verification run (2026-09-06) found `abap_img_edit`'s
  `upsert` refusing every value-column write, on every table: an armed row
  on `TB004T` (keys `SPRAS`/`BPKIND`, one value column `TEXT40`) was
  refused before any wire call with `BAD_INPUT: row 0 names value field
  TEXT40, which is not declared in this plan's fields.` The generated
  probe class `ZCL_ZMCP_IMG_WPROBE` read `DD03L` once per key field only,
  so the apply plan's field list was key-only and no value column could
  ever be written on any table — earlier live rounds all happened to use
  `TB004`, whose test rows name only key fields, which masked this
  completely. The probe now reads every column of the base table in one
  `DD03L` select (by table name, active version, ordered by position,
  skipping `.INCLUDE`/`.APPEND` marker rows) and emits one field line per
  column with its key flag, data type, length and data element; the
  caller's value names are validated against that full column list, and an
  unknown name is still refused `BAD_INPUT`, now naming the columns the
  plan can actually write. Value length and type checking are unchanged,
  as is the one policy rule that walks the field list, which still skips
  non-key fields. No table has ever had a value column written from this
  server until this fix, and the fix itself is not yet live-verified.

- That same seventh run found an armed `delete` of a nonexistent row
  answering `[ok] applied: 1` with a body labelled `ROWS DELETED` whose
  columns were only row / key / requested change (`DELETE this row`) — no
  `changed` column and no result column, so the response read as a
  successful deletion. The write journal already recorded this correctly
  (`existed no`, `confirmed-absent`), and no transport entry was recorded
  or claimed for the row — the generated ABAP already skips both the CTS
  call and the `DELETE` itself when the before-image finds nothing — only
  the rendered response was wrong. An armed `delete` now renders the same
  `changed`/`result` columns the `upsert` side already renders: a row that
  did not exist reports `changed: no` with the result `absent (nothing to
  delete)`; a row that did exist reports `changed: yes`/`deleted`. When any
  row was absent, a note names those rows, states nothing was deleted for
  them and no transport entry was recorded for them, and points out that
  the header's `applied` count is the number of rows the bridge processed,
  not the number changed.

## [0.3.2] - 2026-09-05

### Changed

- `abap_transport operation=removeObject` now detects up front when the
  request already holds two or more E071 rows for the object's
  PGMID+OBJECT+OBJ_NAME — legal under E071's TRKORR+AS4POS key, and typically
  the result of creating an object and then deleting it under the same
  request — and refuses with a new terminal error code, `CTS_DUPLICATE_ENTRY`,
  naming the object, the holder, the row count and the AS4POS values, instead
  of letting a partial removal run into `TR_DELETE_COMM_OBJECT_KEYS`'s own
  `w_duplicate_entry` refusal (`MESSAGE e292(tr)`) mid-batch; a late `TR 292`
  from the function module itself maps to the same code. Any other refusal in
  this family still surfaces the CTS `sy-subrc` and, when CTS set one, the
  `sy-msg*` T100 message as a `msg=` fragment on the `CHECK_FAILED` error,
  instead of swallowing them. The response also reports `objectOnSystem`
  (`present`/`absent`/`unknown`) for the entry's object, since removing the
  entry drops CTS's lock unconditionally and a `present` result means a
  still-live object just lost the lock protecting it. Read live on A4H,
  2026-09-05: both stuck fixture tasks held exactly two E071 rows apiece for
  their object, and no supported function-module call removes just one of
  them — the remedy is outside abapsmith (edit the request's object list in
  SE09/SE10, or release the request) — see
  `doc/LIMITATIONS/not-implemented-and-unproven.md`.

## [0.3.1] - 2026-09-05

### Added

- A GitHub Actions workflow (`.github/workflows/release.yml`) that tags every push to `main` as `vX.Y.Z` and publishes a GitHub release whose notes are that version's CHANGELOG section, extracted by `scripts/changelog-section.mjs`; every merged PR now carries a version bump, since the plugin marketplace only detects an update when the manifest version changes.
- Release procedure in CONTRIBUTING.md (version bump in both manifests, CHANGELOG section, bundle rebuild) and a README note on pinning the marketplace to a release tag for rollbacks.
- Core MCP server over ADT (`/sap/bc/adt/*`): connect, read source and DDIC
  (rendered as pseudo-DDL), fuzzy object resolution, and repository search.
- Write path: create, change, delete, activate, and run ABAP objects and
  classes, with `abap_test` for ABAP Unit. Writes are opt-in and restricted
  to `$TMP` by default.
- `ABAP_MODE` — a single-variable permission ladder (`read` / `edit` /
  `admin`) that supersedes the earlier per-capability `ABAP_ALLOW_*` flags,
  which remain as legacy inputs the server now warns about and ignores.
- `ABAP_VERIFY_WRITES` — two write-verification modes: `speculative` (the
  new default) treats a write that created and activated without error as
  sufficient, with no read-back on success; `verified` reads the object
  back after a successful write, reported as a `verify:` line. A per-call
  `verify: true` on `abap_write` raises one call to `verified`, raise-only
  — it cannot lower a server-configured `verified`. Failure-path
  verification is unaffected and runs in both modes, as does the
  always-on verification of classrun-bridge creates (`VIEW/DV`, `TRAN/T`)
  and the post-delete confirmation.
- Local write journal with `abap_journal` (`list` / `show` / `undo`),
  before-images, retention limits, and drift detection for undo targets that
  changed underneath the server.
- Live ADT step debugger (`abap_debug`, `abap_debug_vars`,
  `abap_debug_value`): attach, step, inspect the call stack and variables,
  with a context-budgeted variable renderer and `ABAP_ALLOW_DEBUG_JUMP_TO_LINE`
  gating forced jumps separately from ordinary stepping.
- CTS transport support (`abap_transport`, `abap_transport_release`): list,
  show, check, manage users, create, and release, with dry-run-by-default
  deletes and release.
- Session pooling and concurrency controls: bounded pool, read/write lanes,
  a reserved debug lease, and cross-process advisory locking so concurrent
  writes to the same object serialize instead of racing.
- BOPF CRUD (`abap_bopf`, `abap_bopf_edit`, `abap_bopf_delete`,
  `abap_bopf_test`): business objects, nodes, associations, and
  determinations, including dangling-reference checks and cascading DDIC
  delete.
- `abap_bopf_delete`'s `cascade_persistent` — an explicit, validated,
  name-by-name opt-out from sparing a BO's `persistentTableRef`/
  `persistentStructureRef` objects, deleted last and reported under their
  own `DDIC DELETED ON REQUEST` section.
- Enhancement framework support (`abap_enh`): BAdI definitions and
  implementations, enhancement spots, filter values, and ENHO/XHH
  source-code plug-ins, gated by customer- vs. SAP-owned target rules.
- `abap_dumps` — read ST22 runtime errors, with a two-tier gate
  (`ABAP_ALLOW_DUMP_VARIABLES`) before variable contents are disclosed, and
  correlation with `abap_run` failures.
- `abap_data_preview` — read table rows behind `ABAP_ALLOW_DATA_PREVIEW`, a
  built-in deny-list (credentials/security tables, payroll/HR, accounting
  documents, personal data), and a row ceiling.
- `abap_ui` — a headless classic-dynpro driver: screen reconnaissance
  (fields, flow logic, GUI status) and batch-input transaction driving
  behind `ABAP_ALLOW_UI_PRESS`.
- `abap_fpm_read` — read FPM/FBI screen configurations, content with no
  native ADT read endpoint.
- `abap_open_url` — build browser or Eclipse (`adt://`) deep links for an
  object, ABAP keyword documentation, or a Web Dynpro app.
- DDIC object creation for `VIEW`/`DV` and `TRAN`/`T` via a generated
  classrun bridge, for object types with no direct ADT create endpoint (see
  Fixed, below, for how the create side of this held up under later live
  testing).
- Response compaction and truncation: a single compactor with an explicit,
  always-marked truncation boundary, so no tool response is silently cut.
- The tri-state productive/non-productive/inconclusive system-role probe
  (fail-closed on inconclusive), evaluated before any connection is opened
  — later hardened further, see Security.
- Claude Code plugin packaging: topic-oriented skills covering BAdI/BOPF
  traps, DDIC write shapes, transport status, and debugger grammar. (The
  skill set itself was later replaced — see Changed.)
- An experimental consolidated tool surface (`ABAP_TOOL_SURFACE=v2`, six
  tools instead of the full per-tool set); kept opt-in after a live A/B
  found it more expensive and error-prone than `v1` at equivalent work.
- Offline test suite built on captured cassettes and fixtures (literal
  bytes from a real ABAP system), plus `check:leaks` to guard against
  committed secrets or live hostnames.
- Two `AbapErrorCode` values, `CONNECT_FAILED` (the host was never reached
  — refused socket, DNS failure, timeout, TLS) and `SYSTEM_UNAVAILABLE`
  (the system answered 5xx and is refusing everyone), so a caller can tell
  "fix the credential", "fix the network" and "wait for the system" apart
  by branching rather than by reading prose.
- `ABAP_STARTUP_PROBE` (default `true`) — the server authenticates once
  before printing its "ready" banner; on failure the banner prints the
  classified code, message and hint instead of blocking startup.
- `abap_atc` — ABAP Test Cockpit static analysis, run-and-collect in one
  tool. Registered only when the server can write, since a run creates a
  persistent worklist row on the server. As first shipped, its wire
  protocol was derived from a third-party ADT client library's source
  rather than confirmed live; a captured live run later grounded
  several specific elements of it — see Changed.
- `CONTRIBUTING.md`, `SECURITY.md`, and `CODE_OF_CONDUCT.md`.
- Pull-request and issue templates.
- `npm run lint:hints` (`scripts/lint-hint-params.mjs`) — a compiler-API
  lint that fails the build when a tool's caller-facing hint text names a
  parameter in camelCase while the schema actually accepts snake_case, the
  exact class of drift behind several of the hint-text fixes below.
- `ABAP_SESSION_COOKIE` — an alternative to `ABAP_PASSWORD`: connect with
  a pre-established session cookie instead of a password. Exactly one of
  `ABAP_PASSWORD` or `ABAP_SESSION_COOKIE` must be set; both or neither is
  a startup configuration error. The cookie is applied to every outgoing
  request by abapsmith's own HTTP layer, since the underlying ADT client
  library clears its cookie jar on every login and re-login and so cannot
  have a cookie seeded through it, and is redacted everywhere
  `ABAP_PASSWORD` already was (startup banner, error-capture dumps, the
  journal, the system-status resource, connect-failure messages). Not
  exercised against a live SAP system — the available test system does
  not support this authentication style, so cookie-mode auth is covered
  by unit tests only.
- `abap_write mode=delete` now accepts a batch `objects` array (up to 10
  objects per call), validating the whole set before deleting anything and
  journalling each delete individually; the continue-past-failure behavior
  for a partially-failing batch has not itself been live-verified.
- All five class sub-includes (CCDEF/CCIMP/CCMAC/CCAU/testclasses) are now
  writable via `abap_write`'s new `include` parameter, notably making ABAP
  Unit test classes (CCAU) writable for the first time. Undo of an include
  write is refused, since replaying it through the ordinary undo path would
  overwrite the class's main body instead.
- `abap_activate` mutations are now recorded in the journal — previously an
  activation changed which code version an ABAP system executes and left
  no audit trail at all. A static tripwire now catches any future mutation
  site that forgets to journal.
- `abap_service` — OData `$metadata`/EDMX introspection (entity sets, keys,
  typed properties, navigation, function/action imports) for both V2 and
  V4 services, resolving the service-binding → catalogue → `$metadata`
  chain. It never returns entity row data, only the contract shape,
  and reports four distinguishable error codes in place of one generic
  fallback. Test fixtures are synthetic — no live OData call has backed
  this tool yet.
- `abap_activate` gained a batch `objects` form, activating multiple ABAP
  objects in one ADT call instead of one call per object.
- `abap_write` now refuses a full-source rewrite when the caller's most
  recent read of that object was truncated, preventing a silent deletion
  of the unread tail.
- `abap_write` gained `dry_run` — resolves, reads, and applies the edit
  locally, runs the safety gate, and returns a diff and the `expect_etag` a
  real write would assert. Its gate check matches a real write, but the
  post-CTS transport-allowlist check can't run on a preview, so a clean
  transportable dry run can still be refused. Refused with `BAD_INPUT` for
  the `objects` batch-delete form, bridge-only creates, and `DEVC/K`.
- `SRVB`/`SVB` (RAP service binding) authoring support.
- The cross-process advisory object lock now also covers the debugger's
  breakpoint-arming path, closing a race where two processes could collide
  over the same object via the debugger.
- `abap_read` gained `view="history"` and `view="diff"` for object version
  history and diffing, live-verified against a real system: availability
  is checked per-object rather than gated on the discovery document,
  `$TMP`/local objects (which have no released history) are explicitly
  reported rather than silently diffed against themselves, and version ids
  are read from the content URL rather than a field that was stripping
  zero-padding.
- `BDEF`/`BDO` (RAP behavior definitions) are now authorable, supporting
  only `unmanaged` implementations — `implementation managed` is a known
  SAP-side gap. abapsmith's own create/write/activate path for this type
  had not itself been exercised against a live system as of this change.
- `DDLX`/`EX` and `SRVD`/`SRV` are now authorable, live-verified with two
  consecutive clean create → activate → read → delete runs for both types.
- BOPF create/update/delete (`abap_bopf_edit`, `abap_bopf_delete`) are now
  recorded in the journal — previously these mutations left no audit trail
  at all. Undo of a BOPF entry remains structurally refused.
- `abap_enh`'s journalled-mutation coverage was expanded from 3 of 11
  operations to 9 of 11; enhancement-implementation activation, which
  mutates a second object (the enhancement spot) in the same request, is
  now also journalled instead of activating live with no audit record.
- abapsmith can now create a **transportable** `DEVC/K` package via a
  generated classrun bridge, and delete one (empty packages only — the
  ABAP side gathers sub-package/TADIR evidence first and refuses in
  TypeScript if anything is inside), which also makes undo-of-package-
  create reversible instead of a permanent operation. Creating a
  root-level package (naming no superpackage) is now possible under an
  explicit `*` wildcard package allowlist. `IF_PACKAGE~DELETE`'s general
  failure behavior, and specifically whether a transportable package
  delete is correctly recorded against the named transport, were not
  fully live-verified — a live run found the named transport does **not**
  receive the deletion, and this gap is disclosed in the tool's response
  rather than fixed.
- `abap_fpm_read` responses are now compact by default for the `find` and
  `app` operations (`detail: "compact" | "full"`, default `"compact"`) —
  offline fixture measurements sized to match previously-observed live
  payloads suggest roughly 3.2x smaller responses for `app` and 1.7x for
  `find`; this ratio itself has not been confirmed against a live system.
  `detail` has no effect on `outline` or `locks`.
- Bridge delete and `abap_journal mode=undo` were added for `TRAN`/`T`
  and `VIEW`/`DV`. A `$TMP` classic-view create registers the view in
  TADIR (`RS_CORR_INSERT` with `korrnum = space`), so it reads back with
  a package reference and both `abap_write mode=delete` and `abap_journal
  mode=undo` reach it; a view that reads back with no `<adtcore:packageRef>`
  is still refused `SAFETY_DENIED` / `PACKAGE_UNKNOWN` on both routes,
  deliberately. This corrects the entry's own earlier wording, which said
  the `$TMP` round trip could not be reached — superseded by later live
  runs within this same effort.
- Journal entries can now record an `actor` (from `ABAP_ACTOR` or the MCP
  client's declared name) and a `sessionId` distinguishing concurrent
  conversations against the same system; `abap_journal mode=list` gained
  matching `actor`/`session` filters (`session="current"` selects this
  process). Absent, never a placeholder, on entries written before this
  change.
- A successful `DEVC/K` package delete now surfaces the classrun
  transcript markers that back its `deleted: true` result, instead of
  discarding them silently.
- Five new `remove_*` BOPF operations, each verifying the element count
  actually decreased after the call.
- `abap_read` on DDIC data elements now includes each field's length, when
  the source descriptor supplies it.
- `abap_write` (both the v1 and v2 tool surfaces) accepts an optional
  structured `ddic` object for `DOMA/DD`, `DTEL/DE`, and `TTYP/DA` writes,
  as an alternative to hand-composing the XML `source` payload. The
  generated XML element set and ordering is derived from the same
  fixtures used to verify create for these three types, and rejects any
  field not grounded there; a raw `source` write is unaffected. Two
  shape mistakes in the structured builder — unpadded numeric length/
  decimal slots on `DTEL`/`TTYP`, and a max-length derived from the
  caller's own length instead of the fixed values the fixtures show —
  were found and corrected by review within the same change before it
  merged.
- `TABL/DI` (a transparent table's secondary index) can now be created and
  deleted through a generated classrun bridge calling
  `DD_INDEX_INTERFACE` — there is no ADT REST route for indexes at all,
  so there is no read and no change, only drop and recreate. The index's
  package is the base table's, resolved by reading the table over ADT,
  never the caller's; a caller-supplied `package` is only checked for
  agreement. A transportable package requires `corr_nr` for both create
  and delete, unlike the `VIEW/DV`/`TRAN/T` deletes, which refuse one —
  `DD_INDEX_INTERFACE`'s delete takes a transport parameter too. The
  create is never `verified` and never journalled: there is no resource
  to read an index back from and so no undo path, only an explicit
  delete. A non-unique create and a unique create with the base table's
  client field were both proven live on A4H in a `$TMP` package, across
  two live rounds; omitting the client field is refused `BAD_INPUT` before
  the FM runs. The delete originally omitted `DD_INDEX_INTERFACE`'s
  mandatory `INDEX_FIELDS` parameter; fixed and confirmed deployed. A
  delete can still report `ACTFAILED` even after it already took effect;
  the fix for that — commit regardless, then re-verify via a post-commit
  `DD12V`/`DD17S` re-read — turned out to never run: its own added message
  line exceeded ABAP's 255-character source-line limit, so every delete
  failed the class-source PUT before `DD_INDEX_INTERFACE` was ever called,
  leaving the deployed bridge class on its pre-fix body. The
  `ACTFAILED`-tolerant read-back had therefore never executed live. Fixed
  again — the long messages are now built up in a variable across short
  lines, and every generated bridge class body is now rejected before it
  is written if any line exceeds 255 characters — and a fourth live round
  then deleted a non-unique and a unique index through the redeployed
  bridge, with `NOT_FOUND` on a re-delete: delete is live-proven in `$TMP`.
  `ACTFAILED` is still set on a delete that took effect. A later cleanup
  deleted a base table whose indexes' catalog rows may still have existed;
  whether the delete cascaded them away or left them orphaned is
  unverified. The transportable-package path is unexercised.
- Four new `abap_bopf_edit` operations — `add_representative_node` /
  `remove_representative_node` for cross-BO representative nodes, and
  `embed_dependent_object` / `remove_dependent_object` for delegated
  dependent-object nodes — bringing the operation total to 27, each with
  the same post-write re-read verification as the rest. `abap_bopf`
  `mode: "show"` now labels every node with a kind (`root` / `standard` /
  `delegated` / `representative`) and flags associations that are
  do-compositions or cross-BO.
- Six new `set_*_fields` BOPF operations (`set_association_fields`,
  `set_action_fields`, `set_determination_fields`, `set_validation_fields`,
  `set_query_fields`, `set_alternative_key_fields`), patching an existing
  child element in place: only the fields named in `spec` change, and every
  other attribute and every child element of the target element is
  preserved byte-for-byte. `null` clears an attribute or a ref, as
  `set_node_flags` already did. Each re-reads after the write and fails
  `CHECK_FAILED` if a named field did not stick.
- `abap_quick_fix` — lists and applies ADT position-driven quick fixes
  (`mode: "list"` / `mode: "apply"`), routed through the same journalled
  write pipeline as `abap_write` and undoable. `mode: "list"` is itself
  gated as a write because it posts the whole object source; v1 accepts
  deterministic proposals only, refusing a parameterized one `BAD_INPUT`.

### Changed

- Two source comments caught up with the code: `abap_ui`'s deps type now takes `allowUiPress` straight from `Config` instead of describing the `ABAP_ALLOW_UI_PRESS` flag as not yet implemented, and the `BDEF/BDO` skeleton-create note no longer refers to the development process that captured it.
- The committed plugin bundle labels its modules with paths inside the repository (`node_modules/...`) instead of the build machine's real dependency directory; a test now fails if a label escapes the repository again. The ignore list no longer carries the project's former working-directory name.
- `VIEW/DV` create into a transportable package resolves a transport
  request the same way a `DEVC/K` create does — `preflightPackageCorr`
  honours the caller's `corr_nr` when given, or else picks or creates one
  under `ABAP_ALLOW_TRANSPORTS`, gated before the write proceeds. The
  resolver's own refusals surface as `TRANSPORT_ERROR` (policy disabled, or
  no usable request), `TRANSPORT_LOCKED` (a request pinned elsewhere), or
  `BAD_INPUT` (a malformed number). A `$` package still refuses a `corr_nr`
  (`BAD_INPUT`).
- `abap_debug`'s `breakpoints` schema states the shared `condition`/`skipCount`
  guidance once at the array level instead of once per union branch, trimming
  the largest single property in the `tools/list` payload by about a third with
  no validator change. The facts that left the schema now live in
  `doc/TOOLS/debugger.md`; a test pins the property's size ceiling.
- A failed connect is now classified instead of being labelled
  `AUTH_FAILED` unconditionally: 401/403 map to `AUTH_FAILED`, 5xx to
  `SYSTEM_UNAVAILABLE`, and anything unidentified to `ADT_ERROR` — never
  silently back to `AUTH_FAILED`. Previously an outage that was refusing
  everyone was reported as "your credentials were rejected".
- Renamed the forensic body-dump environment variable to
  `ABAPSMITH_BODY_DUMP_DIR` (from an earlier working name for the
  project), with no fallback to the old name.
- `doc/TESTING/README.md` and `CONTRIBUTING.md` no longer claim that setting
  `ABAP_URL` can turn `npm test` into a live run — the live suites are
  excluded at config level on a separate variable, and no offline test
  reads the ABAP URL from the environment.
- `ABAP_MODE` is now the primary way to grant write, transport-release,
  and enhancement capability; the older per-flag `ABAP_ALLOW_WRITE`,
  `ABAP_ALLOW_TRANSPORT_RELEASE`, `ABAP_ALLOW_ENHANCEMENTS`,
  `ABAP_ENHANCE_TARGETS`, and `ABAP_ALLOW_SOURCE_PLUGINS` variables are
  ignored (with a startup warning) once `ABAP_MODE` is set.
- MCP tool registration is now gated statically on capability: a tool with
  no ungated mode is absent from `tools/list` entirely rather than
  present-and-refusing.
- Project renamed from its original working name to `abapsmith` as part of
  open-source preparation.
- The 12 topic-oriented skills bundled with the Claude Code plugin were
  replaced with 9 task-oriented skills, chosen against benchmarked
  outcomes rather than topic coverage — changing what guidance an agent
  driving abapsmith actually sees.
- The v2 tool surface's experimental, not-for-production status is now
  stated unmissably in both documentation and runtime behavior; `v1`
  remains the shipped default.
- The ADT discovery inventory is now shared across pooled connections
  instead of being re-fetched per connection, cutting a measured ~450ms of
  per-call latency to near zero after the first connect.
- Documented that `DDLS`/`DF` (CDS views) only support classic
  `@AbapCatalog.sqlViewName`/`define view` syntax on the ABAP release this
  project targets — `DEFINE VIEW ENTITY`, `DEFINE CUSTOM ENTITY`, and
  `AS PROJECTION ON` require a newer release and will fail. No runtime
  release detection was added.
- README gained a worked first-session walkthrough and a stated maturity
  level; its example configuration was corrected from an inline password
  to the safer env-file pattern the project's own tooling already used.
- Corrected a stale claim that no part of the ATC wire protocol had ever
  been exercised live — an earlier capture had already grounded several
  specific elements (run-POST synchronicity, worklist-id shape, finding
  attribute names) that were previously pure inference from library
  source. A separately-reported duplicate-info-note defect in ATC output
  was fixed the same day.
- Documented that abapsmith supports HTTP Basic authentication only.
- Documented that `abap_debug` can only catch breakpoints it triggers
  itself via `action:"start"`, under the configured user — it cannot
  arm-and-wait for another session or user to hit a breakpoint. Removed
  dead watchpoint-endpoint code that was never called.
- Cross-process locking and batch-activation tuning env vars moved into
  the validated config schema, so they now appear in the effective-
  configuration report instead of being invisible; the underlying
  behavior is unchanged.
- Tool descriptions and refusal hints that told the calling agent to set
  `ABAP_ALLOW_WRITE` — a lever that does nothing under `ABAP_MODE`-based
  deployments — now correctly name `ABAP_MODE=edit|admin`, and runtime
  refusal hints report the lever actually in force.
- `ABAP_ALLOW_TRANSPORTS` set by the operator now actually **replaces**
  the allowed-transports list under `ABAP_MODE=edit`/`admin`, instead of
  being silently intersected with an `["auto"]`-only ceiling — previously
  pinning a real transport request produced a deny-all refusal even
  though the operator had set exactly what the error hinted at. Several
  previously admin-only behaviors (including transport-delete and
  cascade-delete) are now independently togglable via new env vars that
  override the mode default in either direction. abapsmith now warns at
  startup if an override variable is set where it would be silently
  ignored, or if an `ABAP_ALLOW_*` variable name is unrecognized.
- `ABAP_ALLOW_PACKAGES` now defaults to `["*"]` (any customer package is
  writable) instead of `["$TMP"]`. An explicitly empty list still means
  deny-all. **This is a genuine widening of default write scope, not a
  bug fix** — operators who were relying on the previous implicit
  "`$TMP` only" default should now set `ABAP_ALLOW_PACKAGES` explicitly if
  they want that restriction. The startup message no longer falsely
  claims that nothing can be transported under the new default.
- `ABAP_ALLOW_TRANSPORTS`, `ABAP_ALLOW_PACKAGES`, and related write-scope
  refusals now render every object type the write path actually accepts,
  and the generated capability table no longer lists `DEVC/K`, `VIEW/DV`,
  and `TRAN/T` as unreachable by any write when they are in fact
  bridge-creatable.
- Transport auto-selection (`ABAP_ALLOW_TRANSPORTS=auto`) now reuses a
  request this server itself created (matched by owner and its own
  description) instead of minting a new one on every cold start whenever
  more than one candidate matches.
- MCP instructions and refusal text no longer claim the write-package
  allowlist "defaults to `$TMP`" — the real default is now rendered from
  resolved configuration so the two can't drift apart again.
- doc/SAFETY/safety-gate.md (and the v2 tool catalogue) now state explicitly that ABAP
  executed via `abap_run` is **not** bound by this server's transport,
  package, or name allowlists — `abap_run` can execute any object and
  construct a transport number at runtime. This was previously true but
  undocumented.
- `AVAILABLE_MEMBERS_MAX` (the near-miss suggestion list for an unresolved
  name) was cut from 60 to 12, ranked by edit distance to the requested
  name, so a one-character typo now surfaces the intended match at the
  top instead of being buried in a long alphabetical list. The default
  response-size ceiling was lowered from 60,000 to roughly 47,100
  characters, and the configurable override is now clamped at 200,000
  rather than left unbounded.
- `deployBridge` skips a redundant activation request on a warm bridge
  no-op when a prior read already proved everything active;
  `abap_fpm_read mode="outline"` gained opt-in paging over its previously
  unpageable raw XML; `abap_debug`/`abap_enh` tool-schema descriptions
  were trimmed to reduce `tools/list` token cost, with the displaced
  reference material moved into `doc/TOOLS/`.
- The six `add_*` BOPF operations for association/action/determination/
  validation/query/alternative-key now refuse a `name` that already exists
  on the target node, instead of silently creating a second element with
  that name.
- `TRAN/T` create now threads a transport request through to
  `RPY_TRANSACTION_INSERT`'s `transport_number` parameter, mirroring
  `VIEW/DV`'s package rule: a transportable package requires `corr_nr`
  (`TRANSPORT_ERROR` without one), and a `$` package refuses one
  (`BAD_INPUT`) and registers with `korrnum = space`. The FM's signature
  was read live on A4H 2026-09-05, confirming `transport_number` is
  forwarded verbatim to `RS_CORR_INSERT` as `korrnum`; no live create into
  a transportable package has been run yet.
- The live suites `integration-undo` and `integration-fpm-lock` now pair
  their whole-file `describe.skip` with a `liveSuiteSkipReason` case stating
  why, under the greppable `APPLIANCE STATE:` prefix, instead of just
  reporting "skipped" with no reason; the documented live-suite surface in
  `CONTRIBUTING.md` and `doc/TESTING/README.md` was also corrected against
  `LIVE_INTEGRATION_TESTS` in `vitest.config.ts`.
- Three `abap_bopf_edit` operations — `add_representative_node`,
  `remove_representative_node`, `embed_dependent_object` — are removed
  after a live discovery run against a real SAP system proved the write
  shapes they sent do not survive the endpoint: a client-written
  parentless node is hard-rejected by the deserializer
  (`/BOBF/ST_CONF_ADT`), and a `DoComposition` association plus embedded
  node comes back with its `implementationType` rewritten to
  `Composition` and its `doEmbeddingName` dropped, with the resulting
  node name then refused at activation. A representative node is now
  obtained the way the server actually produces one: a plain cross-BO
  `add_association` (an `Association` `spec.targetNodeRef` naming
  another BO's node, plus a `spec.implementationClassRef` naming an XBO
  class) causes the server to mint a parentless node itself, named
  `REP_<random>`; confirmed live that `remove_association` removes it
  too — `nodeCount` fell from 2 to 1 and the node was gone from the
  read-back.
  There is no replacement for creating an embedded dependent object.
  `remove_dependent_object` is unchanged, its refusal path having been
  exercised correctly against the live system, as are the `abap_bopf`
  `show` node-kind labels (`root` / `standard` / `delegated` /
  `representative`) and `check_refs`'s `unchecked` verdict for cross-BO
  references. `abap_bopf_edit` now has 24 operations (was 27) and the v2
  `abap_do` catalogue 52 actions (was 55), 27 of them in the `bopf` group
  (was 30). A second live run then tried both remaining candidate
  embedding shapes and both failed as well — a byte-verbatim transplant
  of SAP's own `ROOT_LONG_TEXT` embedding threw at the same
  `/BOBF/ST_CONF_ADT` deserializer even with the node correctly
  parented, and an association naming the dependent object's own root
  answered 200 with the association silently discarded — so the removal
  is a settled negative for this endpoint on this release, not a gap
  waiting on evidence. See `doc/CAPABILITIES/bopf.md`.
- `abap_bopf_edit operation:"create_bo"` now refuses with a new terminal
  error code, `BOPF_CREATE_UNUSABLE`, when the landed root node is unnamed
  (`bo:name=""`) or missing outright, instead of reporting success over an
  object that can never be activated — BOPF generates the `Z*_C` constants
  interface from the root node name at create time and never regenerates it,
  so renaming the root afterward doesn't help. The object still exists
  server-side (the journal still records `succeeded`, naming that entry's id;
  remedy: `abap_bopf_delete` then recreate), and no activation request is
  sent even with `activate: true`. A differently-named, non-empty root is
  still only a discrepancy note. See `test/bopf-create-recovery.test.ts`.
- Documentation, code comments and registry notes no longer name the appliance's transportable test package; they say "a transportable package" instead.

### Fixed

- The generated capability table's "not readable either" line is now derived
  registry-wide from the same predicate as `NON_READABLE_TYPES`, so it names all
  eight non-readable types (it previously missed `VIEW/DV` and `TRAN/T`, the two a
  caller is most likely to try to read back after a bridge create). A census
  test pins the table to the constant so the drift cannot recur silently.
- Correctness fixes found during a live-verification campaign against a
  real ABAP system: activation no longer silently drops an `affects`
  intent, the FPM lock path no longer treats a failed lock acquisition as
  held, the debugger reports how a debuggee actually ended instead of
  guessing, enhancement writes were fixed across several parameter and
  encoding issues, BOPF bridge identifiers no longer collide across
  multi-node scenarios, and DDIC fixed-value texts on domains are no
  longer reported as written when they weren't.
- `abap_write` now verifies `VIEW`/`DV` and `TRAN`/`T` creates by reading
  them back rather than trusting the classrun bridge's own report.
- `abap_ui` enumerates GUI statuses so screen mode returns real buttons.
- Credential handling: rejected credentials now latch process-wide
  instead of continuing to burn logon attempts, and a `401` trips a
  one-shot circuit breaker with no retry.
- Enhancement-object naming and encoding: namespace-prefixed BAdI/BOPF
  names are correctly percent-encoded; `PROG/PT` (GUI titles) is refused
  by name alongside `PROG/PS` and `PROG/PC`.
- Where-used fetch is honestly capped after live-verifying no server-side
  limit exists on the endpoint.
- `abap_read` (and `abap_bopf_edit`/`abap_bopf_delete`) stopped emitting a
  `structuredContent` block that carried only counters — an MCP client
  that prefers `structuredContent` over `content` when both are present
  got the counters and zero lines of ABAP source. Source now travels in
  `content` only, with a `response: complete (...)` header line carrying
  the facts `structuredContent` used to hold. A static contract test now
  guards against this defect coming back in a third tool.
- The XML parser was silently coercing DDIC fixed values on read — e.g.
  stripping the leading zero from `"01"` to `"1"`; the write path was
  already correct. Left uncaught, an agent that read `1` and wrote back
  `'1'` would never match a field actually storing `01`.
- `DOMA`/`DD` writes are now rejected-then-retried-correctly by always
  including an empty fixed-values element — SAP rejects the write payload
  without it, even for domains with no fixed values, live-confirmed
  12 for 12.
- `TABL`/`DI` (table secondary index) is now registered as an explicitly
  unsupported type in the capability tables; previously it was absent
  from every capability bucket, so a caller could only discover it was
  uncreatable after three failed calls.
- The debugger's raw long-poll/CSRF transport now honors
  `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`, matching the rest of the tool —
  previously a debug session behind a proxy could reach ABAP when other
  tools could not, or vice versa.
- `abap_activate mode=check` with no `source` now reads and checks the
  object's saved server source instead of always refusing; it still
  refuses fast for genuinely nonexistent objects or unsupported types.
- `DOMA`/`DD` writes missing the `masterLanguage` attribute silently
  dropped every fixed-value description while still reporting
  `activated:true` with no warning, live-verified 7 for 7. Such writes
  are now refused with a clear error instead.
- A blank transport-number string was previously treated as a real
  transport request, producing a confusing "named transport" refusal
  instead of correctly being treated as no transport supplied. Fixed
  across `abap_activate`, `abap_enh`, `abap_write`, and the v2 surface.
- Reads of unsupported explicit object types previously fell through to a
  generic, under-explained `NOT_FOUND` even though write already refused
  them cleanly; read now runs the same capability check up front.
- Journal entries written by `abap_write`, `abap_ui`, `abap_bopf`, and
  `abap_enh` now all carry a system key (SID, origin, client), so undo's
  cross-system safety check can use a strong comparison instead of a
  weak SID-only fallback that cannot tell two systems sharing a SID apart.
- Two independent session-death classifiers could disagree about the
  same response, risking a duplicated write on replay; wire-level
  evidence of death now outranks weaker message-prose evidence, and a
  connection marked condemned can no longer have a write replayed on it.
- `CREATE` and `DELETE` capability claims now carry a verified/unverified
  tri-state, live-swept against a real system. `ENQU/DL` create was
  downgraded to unverified after the one genuine live create failure
  found in the sweep; the three types originally suspected broken
  (`DTEL/DE`, `MSAG/N`, `TABL/DT`) all created cleanly and were not
  downgraded. `ENQU/DL` create and delete were re-verified live on
  2026-09-05 once the real cause of those failures was found: the
  descriptor's root element must be the lowercase `enqu:lockobject` in
  namespace `http://www.sap.com/adt/ddic/enqu`, not the camelCase
  `enqu:lockObject` in `http://www.sap.com/dictionary/lockobject` the
  earlier attempts sent, so both flags are `true` again and `abap_write`
  now refuses a wrong root element up front. `BDEF/BDO` delete was
  downgraded from verified-deletable to false after delete was found to
  report success while leaving the object readable, reproduced 3 times;
  the automatic rollback-on-failed-create path now respects this same
  gate.
- Fixed a pooled connection that could leak an ABAP enqueue lock and
  never get swept — the leak-detection hook is now actually wired at
  session construction, and any detected leak now drops the whole
  session, live-verified by confirming a second connection can re-lock
  the object afterward.
- A pooled session that died as a side effect of one caller's request no
  longer hands the raw error straight to the next, unrelated caller —
  reads now always safely replay on a fresh session, and writes replay
  only when the failure arrived implausibly fast.
- When a create's follow-up write is rejected, abapsmith now rolls back
  the orphaned object it just created — previously only a fraction of
  refusal paths triggered rollback. The response now honestly reports
  whether the rollback succeeded, failed, or was deliberately not
  attempted, live-verified with a before/after transcript.
- `SUSO/B` (authorization objects) confirmed via live reconnaissance to
  be a real ADT object type with no usable read/write collection;
  registered as explicitly unsupported, naming SU21 as the alternative.
- The debugger's raw HTTPS long-poll/CSRF transport now honors the
  insecure-TLS override, matching the rest of the tool — previously
  every ordinary tool worked against a private-CA/self-signed system
  while the debugger tools failed with an opaque TLS error.
- A single large DDIC batch activation had taken down a shared appliance,
  because the underlying mass-activation utility fans one request out
  into an uncontrolled burst of internal calls. Classic DDIC types
  (domains, data elements, tables, etc.) now travel in small chunks
  (default 5, configurable) while classes/programs/interfaces/CDS keep
  full batching.
- Fixed undo's drift probe reading the wrong URI, which made undo-of-
  create silently no-op (reporting success while leaving the object on
  the server) for packages and every properties-shape type. Package
  creates are now correctly marked irreversible in the tool's own
  response (packages have since gained a real, limited delete path for
  empty packages — see Added).
- A `$`-named local package (`DEVC/K`) can be deleted via `abap_write
  mode=delete`, its create undone via `abap_journal mode=undo` — both
  previously failed `SAFETY_DENIED` / `PACKAGE_UNKNOWN`. It reads back
  with no `<adtcore:packageRef>` element, and the gate resolves an
  existing package to itself; one fix covers both, since delete and
  undo share the same target-resolution step. The delete bridge also
  rejected `$`-prefixed names as `BAD_INPUT` — fixed. Empty packages
  only, unchanged; the package-create response's claim about these
  routes is now accurate, having promised two that failed.
- Corrected a false claim that `abap_write` has no surgical string edit —
  it has long supported targeted `edit` (unique-match splice) and
  `method` (single method-block replace) fields; clarified that the
  underlying write is still always a whole-document replace under the
  hood.
- Corrected a false claim, baked into both a doc comment and a live error
  message, that a BOPF business object's constants-interface reference is
  assigned only at first activation — a captured fixture shows it is
  already populated on a freshly created, never-activated object.
- Error response envelopes are no longer pretty-printed as JSON, which
  previously meant a caller reading only the first line saw just `{` and
  lost the entire diagnostic; this also recovers roughly 10% of response
  budget.
- `abap_bopf create_bo`'s response now surfaces the generated constants-
  interface name instead of omitting it.
- Several generic ADT/CTS error fallback paths previously reached the
  caller with no hint at all; they now carry honest hints stating the
  error wasn't diagnosed, pointing to where the verbatim SAP text lives,
  and forbidding blind retry. `abap_activate` was also incorrectly
  annotated as non-destructive even though it is irreversible — corrected.
- Fixed undo-of-create on properties-shape objects (`DOMA/DD`, `DTEL/DE`,
  `TTYP/DA`, `ENQU/DL`, etc.) falsely reporting drift and refusing —
  activation rewrites version metadata inside the descriptor, but the
  journal was fingerprinting the pre-activation response; it now
  re-settles the fingerprint after a successful activation.
- Object and write-target resolution no longer trusts a naming-
  convention-derived type (e.g. a `ZCL_*`-style name) as evidence of what
  an object actually is — both now probe the server first and return
  `NOT_FOUND`/`BAD_INPUT` instead of silently guessing and possibly
  acting on the wrong object type. Several caller-facing tool
  descriptions and hints that had drifted from actual behavior (bounding
  vs. fetching rows, a costly BOPF escape hatch undersold as routine,
  camelCase hints for snake_case parameters) were corrected in the same
  pass. The debugger now distinguishes a normal debuggee-ended session
  from a raw forwarded exception message; a leaked bridge class after a
  failed write now discloses a "safe to delete" hint; a timed-out
  debugger cleanup step is now surfaced in the response instead of
  silently dropped to a log.
- `abap_write` refusals now advertise every type the tool actually
  accepts — a hand-maintained list had drifted and omitted create-only or
  bridge-only types.
- A transport request released by another process mid-session is now
  detected and healed in-process instead of failing every subsequent
  write until restart, and the underlying error gets a specific
  classification instead of a generic "not recognised" message.
- `abap_bopf_edit`/`abap_bopf_test` now reject misspelled or malformed
  spec keys client-side, naming the nearest legal field, instead of
  silently discarding them. `remove_node` refuses to remove a root node.
  `create_bo` no longer reports session-dead for an object that was
  actually created. `cascade_ddic` no longer deletes DDIC objects a BO
  merely references (as opposed to generated), since those can be shared
  with other business objects.
- `$`-prefixed object names (`$TMP` and other local packages) can now be
  addressed by name on both the read/resolve and write paths — previously
  they could pass an early gate and be refused later on write, or be
  refused outright on read.
- Activation now completes ADT's two-phase handshake instead of
  misreading a non-empty intermediate check-list as failure — previously
  no object with co-required dependents in a transportable package could
  be activated at all. Co-activated objects are now disclosed in the
  response. Verification switched from that intermediate document's
  emptiness to the object's actual version history, fixing false failure
  results on function groups. The joint BAdI spot and
  implementation activation path completes the same handshake, fixing a
  case where it could self-contradictorily report itself both failed and
  succeeded.
- A BAdI enhancement write missing its required wrapper statements now
  gets an error naming that specific omission instead of a confusing,
  unrelated SAP message; `create_impl` now reports whether the
  implementing class actually exists rather than assuming so because it
  was named in the request. (The wrapper syntax as first documented in
  this fix was itself wrong and rejected by SAP; a later commit in the
  same change corrected it after live testing.)
- Fixed `PARENT/NAME` splitting at the wrong slash when a namespace is
  involved, which could silently resolve to a different object than
  named, or wrongly refuse a valid namespaced reference. The container
  name is now validated with the same rule as the object name.
- A raw ADT URI addressing a sub-object (e.g. a table index) now gets a
  specific error naming the target and sub-part, instead of a generic
  "unrecognised URI".
- Fixed existence-checking for bridge-created `TRAN/T` and `VIEW/DV`
  objects: the bridge always answers success, even for objects that were
  never actually created, so existence and registration checks had been
  conflated and `abap_journal mode=undo` could never run for these types.
  They are now checked separately.
- Reading an absent object's source where the endpoint answers with a
  server error instead of a clean "not found" now returns `NOT_FOUND`
  once a follow-up read confirms absence, instead of an unclassified
  error telling the caller not to retry.
- Markup from scraped ICF/ICM error pages is now stripped from
  diagnostic error text — previously the real error message could be
  buried in hundreds of characters of raw markup. A raw non-classified
  throw carrying a dead session now gets a reconnect hint in one more
  code path.
- `ABAP_ENHANCE_TARGETS` can now override the `ABAP_MODE` default in
  either direction — previously silently ignored once `ABAP_MODE` was
  set. An explicitly empty value is now a config-time error rather than a
  silent alias for "none".
- DDIC XML-only writes (`DOMA`/`DTEL`/`TTYP`) are now checked against a
  known-accepted skeleton before sending, catching provably-wrong root
  elements or namespaces client-side; one specific malformation was
  previously silently accepted and produced a data element with no type.
- A lock failure occurring after a create's write already landed is now
  verified and reported accurately instead of inviting a same-name retry
  that would collide; the stranded server-side lock from that failed
  attempt is now dropped.
- BOPF delete/create reporting now states only what was actually
  verified: a no-cascade delete explicitly says generated DDIC was left
  behind rather than implying it doesn't exist, the delete probe also
  checks the generated constants interface, and the reason given for a
  spared DDIC reference is now accurate rather than assumed.
- BOPF delete now distinguishes "cascade delete never requested" from
  "cascade ran, found nothing" — both previously reported an identical
  empty list.
- `add_alternative_key` now preflights against BOPF's own model and
  refuses (overridably) a key referencing a nonexistent field or a node
  with no persistent structure, catching malformed requests before they
  can crash a live session. This does not make the underlying operation
  itself reliable for every input — a fully valid payload can still
  short-dump SAP-side.
- A dropped or failed system-role probe (e.g. connection lost mid-check)
  now reports a distinct "probe failed, restart" error instead of being
  folded into the same refusal as a genuine policy decision.
- `where_used` now discloses when its underlying fetch was expensive
  (many references or several seconds), since the server enumerates and
  transfers the whole reference set before any limit is applied.
- A zero-hit repository search is no longer read as proof an object
  doesn't exist. Create-verification, delete-verification, and batch-
  delete reporting all downgrade a search-miss to indeterminate/
  unverified instead of confirmed-absent, and batch delete now separately
  counts confirmed vs. unverified deletions rather than counting
  unverified ones as successes.
- Delete verification no longer infers absence from a repository search
  on a type it doesn't index, a server error on a type whose content
  endpoint doesn't otherwise 404 for missing objects, or a dead-session
  read failure — each case now requires an actual observed absence or
  degrades to indeterminate, with one safe reconnect-and-retry.
- Batch delete now reports an error whenever any object in the batch was
  left undeleted, not only when every object failed — previously a
  partially-failed batch returned a plain success envelope.
- A batch delete where every object failed now sets the MCP error flag
  instead of returning a success envelope.
- `AUTH_CIRCUIT_OPEN` no longer tells operators that restarting the
  server clears the auth latch — it's durable on disk and a fresh process
  replays it immediately. The hint now names the actual latch file, TTL,
  and remaining time.
- BOPF write/activate/delete and bridge-create now judge one real
  transport decision per mutation instead of fabricating a placeholder
  "auto" transport that could be wrongly refused under a pinned transport
  allowlist.
- Read/search now accepts SAP-generated namespaces starting with a digit;
  write paths are unaffected — namespaced objects still cannot be written
  through this server. `abap_enh operation:"exercise"`'s parameter-type
  field now validates as a proper type reference instead of the stricter
  object-name grammar.
- A batch delete where every object failed now sets the MCP error flag
  instead of an ok envelope; a batch where some but not all objects
  failed is reported precisely (already listed above) — both fixes
  together close out the batch-delete honesty work.
- A BOPF delete with `cascade_ddic: true` whose internal DDIC walk failed
  partway through previously rendered identically to a delete that walked
  the whole tree and genuinely found nothing to clean up. The response
  now reports whether the walk actually ran, and suppresses the DDIC
  counts entirely when it didn't, with a note that a missing walk is not
  evidence of a clean sweep.
- `abap_bopf create_bo`'s recovery from a session death mid-create re-read
  the object and reported `recovered: true` without ever comparing the
  result to what was requested. A live run found the recovered object's
  root node came back with an empty name instead of the one the caller
  asked for; BOPF bakes that empty name into the generated constants
  interface at create time, so the object could never be activated, and
  renaming the root afterward does not repair the interface. `create_bo`
  now verifies the root node on every return path and reports an
  unnamed root as unactivatable (naming `abap_bopf_delete` as the
  remedy), a differing name as a discrepancy, and a missing root as
  unconfirmed, instead of a bare success.
- A session death classified from a response that actually resolved with
  a 2xx could previously be applied immediately even though the call had
  already committed server-side, discarding a real, successful result by
  throwing a session-dead error out of the same code path that was
  meant to restore state afterward. Such a death is now deferred and
  applied at the next request boundary instead of being allowed to
  overwrite a result the server already committed. A death from a
  genuinely failed (non-2xx) response is unaffected and still applied
  immediately.
- `abap_bopf` `mode: "check_refs"` used to report a cross-BO
  `targetNodeRef` (e.g. `/BOBF/DEMO_CUSTOMER~ROOT`) as `missing`, because
  it looked the target up in the host business object's own node list.
  It now reports `unchecked`, with a detail naming the other business
  object, instead of a false `missing` — `check_refs` reads one business
  object and does not fetch another to verify it.
- `abap_read` reported an absent `BDEF/BDO` as an empty success: this
  type's `/source/main` answers 200 with an empty body once the object is
  gone, indistinguishable from a genuinely (if oddly) empty source. A
  blank `BDEF/BDO` source read is now confirmed against the object's own
  URI before being reported absent in the post-delete read-back; the
  post-create read-back instead falls through to the repository search
  on a blank body rather than trusting it alone. The registry's
  `delete: false` for this type, which rested on the earlier misread, is
  corrected to `true`.
- A pinned `ABAP_ALLOW_TRANSPORTS` previously refused every `VIEW/DV`/
  `TRAN/T` bridge delete outright, because the gate synthesized an `auto`
  transport request for a call that passes none; both delete bridges now
  present the mutation as local, so the transport allowlist no longer
  blocks them (an explicit deny-all still does), and the delete response
  now flags any transport-request entry the object's create left behind
  for `abap_transport removeObject` to clean up.
- `abap_bopf_edit operation:"add_alternative_key"`/`"set_alternative_key_fields"`
  now refuse the `checkAfterModify`/`checkBeforeSave`/`noCheck` combinations
  that made BOPF's model mapper assert and take down the ADT session; `unique`/
  `uniqueIfNotInitial` now require exactly one of `noCheck`/`checkAfterModify`.

### Security

- SafetyGate's customer-namespace enforcement for `DDLS`/`DF` (CDS views)
  only checked the view's own object name, not its embedded database-view-
  name annotation — a customer-namespaced CDS view could activate an
  underlying database view name outside the customer namespace. Both are
  now checked against the same namespace guard.
- The startup probe that decides whether a connected SAP system is safe
  to write to no longer treats an unrecognized system client-category
  value as evidence that the system is non-productive. The classifier
  previously accepted anything other than the literal "production" code
  as proof of a non-productive client, so an unfamiliar or malformed
  category code could let a system that should have been refused as
  productive through as writable. It now allowlists the known
  non-productive category codes by inclusion and reports "inconclusive"
  for anything else; "inconclusive" fails closed and is treated the same
  as a confirmed-productive system by the write gate.
