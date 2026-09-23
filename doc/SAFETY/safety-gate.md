# Safety Gate

The safety gate (`src/safety.ts`) is what allows this server to be pointed at
a real ABAP system.

## The gate runs before the connection

Every mutating call is evaluated **before any HTTP request is made**, including
the logon. Two offline tests assert this: a refused write and a refused undo
each put zero requests on the wire.

Order of checks:

| # | Check | Effect when it fails |
|---|---|---|
| 1 | System reports itself **productive** | read-only, no override |
| 2 | System role could not be **proven** non-productive | read-only, no override |
| 3 | Write opt-in (`ABAP_MODE=edit`/`admin`) | operation refused |
| 4 | SAP namespace (`/NS/…`) or SAP-owned package | denied |
| 5 | Package allowlist (default: any package) | denied |
| 6 | Object-name allowlist (default: any name) | denied |
| 7 | Transport allowlist, if the write needs a request (default: any request) | denied |

Checks 1 and 2 are a ceiling, not a default: no configuration value lifts them.
Checks 3–7 are configuration, and each refusal names the specific setting that
would permit the operation — computed from the live config, not hard-coded, so a
refusal cannot name a variable this server does not read.

Checks 5, 6 and 7 all pass by default — `ABAP_ALLOW_PACKAGES`,
`ABAP_ALLOW_NAME_PREFIXES` and `ABAP_ALLOW_TRANSPORTS` unset mean any
package, any name and any transport request, not just `$TMP`/`Z`/`Y`/
auto-select — so once the write opt-in (check 3) is granted, check 4 does
the real work of keeping a write off the SAP namespace and SAP-owned
packages. Setting `ABAP_ALLOW_PACKAGES`/`ABAP_ALLOW_NAME_PREFIXES`/
`ABAP_ALLOW_TRANSPORTS` is how an operator opts back into a package, name or
transport restriction — e.g. `ABAP_ALLOW_TRANSPORTS=auto` to permit only the
server's own auto-select/auto-create, or a specific TRKORR to pin every
transportable write to that one request.

Check 7 only engages when a mutation actually names or auto-selects a
transport request. A call site that provably issues no CTS call presents
`{kind:"local"}` instead, and check 7 does not apply to it — the `VIEW/DV`,
`TRAN/T` and `SHLP/DH` bridge deletes (`src/adt/view-delete.ts`,
`src/adt/tran-delete.ts`, `src/adt/shlp-delete.ts`) are the current case:
the delete bridges pass no transport request and issue no `RS_CORR_INSERT`
of their own, so abapsmith names no request for check 7 to judge. Whether
`RPY_TRANSACTION_DELETE` itself registers anything in CTS has never been
verified (`src/adt/capabilities.ts`, the `TRAN/T` `bridgeDelete` entry), so
the `TRAN/T` case rests on abapsmith attempting no transport handling
rather than on a measurement of the function module. `DD_OBJ_DEL`
(`SHLP/DH`'s delete FM) takes no transport parameter at all, so there is no
equivalent open question there. An explicit deny-all
(`ABAP_ALLOW_TRANSPORTS=`) still refuses all three deletes outright — that
check runs before the local branch, so fail-closed stays fail-closed.

#### Verdict before side effect; provenance of an auto-resolved request

Check 7 is evaluated twice on a transportable create, and the first pass
costs no wire request. Before the session resolver is consulted, the write
is asserted with the caller's own `corr_nr` if one was given (`source:
"named"`) or as `{kind:"unresolved"}` if not — an unresolved corr fails only
the deny-all rule, which is exactly the rule that must fire before any
request could be created. Only after that verdict does the resolver run
(`resolveForNewTransportable`, `src/adt/session-transport.ts`, which for a
not-yet-existing object asks CTS for the modifiable requests of the
**package** and takes the same adopt-else-create decision the ADT-lock
types get), and the number it chose is asserted again with its true
provenance — `source: "auto"` for a resolver pick, `source: "named"` for a
caller value passed through. Issue #142 was the `VIEW/DV` bridge running
the resolver, creating a request, and only then reaching the gate; issue
#141 was the bridge creates demanding a named request under `auto`, which
this same check then refused. The classic-bridge creates (`VIEW/DV`,
`TRAN/T`, `SHLP/DH`, `TABL/DI`, `DEVC/K`) now follow that order
(`resolveBridgeCreateCorr` / `bridgePreflightCorr` in `src/tools/write.ts`,
`preflightPackageCorr` in `src/adt/write.ts`).

The second gate layer those creates pass through is `dispatch()`'s own
targets gate (`assertTargetsAgainstGate`, `src/adt/fluid/dispatch.ts`),
which judges the `corr_nr` an action's `targets.transport` pointer
resolves to. It used to read every non-blank value as caller-named, so a
request abapsmith's resolver had just picked under `auto` was refused there
after the tool layer had passed it. A builtin caller (`runClassicAction`,
`src/adt/classic-call.ts`) now hands it the provenance it judged with
(`FluidRunRequest.corrSource`), and `"auto"` is honoured for the builtin
origin only: a plugin manifest or an `abap_fluid` caller cannot declare it
(`src/tools/fluid.ts` never sets it), omitting it keeps the stricter
"named" reading, and a pinned or empty list refuses an auto-selected
request exactly as before. The rules of check 7 are unchanged; what changed
is that both layers now see the same mutation with the same provenance
(`test/fluid-dispatch-corr-source.test.ts`,
`test/bridge-create-transport-auto.test.ts`).

If the post-resolution assert refuses after the resolver created a request
in the same call — possible only when the allowlist changed underneath a
live session, since the pre-resolution assert already applied it — the
refusal carries `details.createdTransport` and its hint names the request
and how to remove it (`abap_transport operation=delete`); the create is
journalled as `transport-create` regardless, so nothing is silently leaked.
Both transport-allowlist refusals name their rule and a caller-side remedy
for the mode in force (`transportAllowlistHint`, `src/safety.ts`), never an
environment edit, and are terminal (`retryable: false`) — issue #143.

#### A named request under `auto`: the session-registry hook (#208)

Check 7's own rule for `auto` used to be absolute: `normalized.includes("AUTO")`
made an `auto`-resolved request pass, but a `source: "named"` request never
did, however it got there — even one this same process had just created
and handed back in an earlier write's `transport:` field. That made it
impossible for a caller to read a request back and pass it explicitly on a
later call.

`SafetyGate` now takes an optional second constructor argument,
`SafetyGateHooks`, whose one field is `sessionCreatedRequests: () =>
readonly string[]` — TRKORRs this process's `SessionTransport` registry
has recorded as created (`SessionTransport.noteCreated`/
`sessionCreatedRequests()`), read live through a closure bound after
`SessionTransport` is constructed (`src/systems/context.ts`). A
`source: "named"` request under a list containing `AUTO` now also passes
when it appears in that registry; every other combination is exactly as
before. A refusal from this branch names what would have been accepted:
the requests the registry holds, or "omit corr_nr to have one picked or
created" when it holds none yet.

This stays fail-closed by construction, not by convention: `SafetyGate`'s
own default for the hooks argument is `{}`, so a caller that builds a gate
without wiring `sessionCreatedRequests` (every offline test that
constructs `SafetyGate` directly, and any future call site that forgets
the wiring) gets the old, stricter behaviour — every named request refused
under `auto` — rather than silently trusting an empty or absent registry
as "anything goes". The registry itself only ever grows through
`SessionTransport.noteCreated`, called at the one place a request this
process's resolver actually created is recorded; nothing else can add to
it, so the hook cannot be tricked into admitting a request from outside
this process or a different session. Deny-all (`ABAP_ALLOW_TRANSPORTS=`)
and a pinned list without `auto` in it are unaffected either way — the
hook is only ever consulted on the `normalized.includes("AUTO")` branch.

`abap_write`'s own main path (`SessionTransport.#callerMayName`,
`src/adt/session-transport.ts`) implements the same rule independently,
with one addition the gate hook does not have: tier (b), a modifiable
workbench request owned by the connected user already carrying
abapsmith's own session description for the same package, which needs a
CTS read to confirm and so cannot be judged zero-wire. The classic-bridge
creates (`VIEW/DV`, `TRAN/T`, `SHLP/DH`, `TABL/DI`, `DEVC/K`) go through
the gate hook only, at their zero-wire pre-check (`bridgePreflightCorr`,
before `resolveBridgeCreateCorr` ever asks CTS for the package's
candidates) — so they accept tier (a) but not tier (b).

### The ladder governs what this server does, not ABAP it executes

Checks 4–7 constrain the arguments this server itself passes on a write —
the package, object name and transport request behind `abap_write`,
`abap_transport` and friends. They are not a sandbox around ABAP the
server executes. `abap_run`, `abap_test` and `abap_bopf_test` run ABAP
under the connected technical user's SAP authorisations, and that ABAP can
call SAP APIs directly — including CTS APIs that name a transport request,
e.g. `lo_package->save( i_transport_request = 'A4HK900189' )`. A classrun
written to `$TMP` (which needs no transport, so check 7 never engages) and
then executed with `abap_run` can land work in a transport request
`ABAP_ALLOW_TRANSPORTS` had just refused, because that call passes through
none of checks 4–7 — the same holds for the package and object-name
allowlists. The boundary for anything this server executes is the
technical user's SAP authorisations, not this ladder.

Inspecting the submitted ABAP source cannot close this gap: a transport
number can be assembled at runtime from fragments, read from a table, or
reached through any of several CTS APIs. `abap_run` takes an object name,
not source, and can execute objects this server never wrote — written in
SE80, transported in, or SAP standard — so there is often no submitted
source to inspect in the first place. This server does not attempt such a
check, rather than ship one that would suggest a boundary exists where
none does.

## Productive-system detection is tri-state

Detection (`src/adt/system-role.ts`) returns `productive`, `nonproductive`, or
`inconclusive` — deliberately not a boolean. A boolean would collapse "proven
safe" and "unknown" into the same `false`, which is the fail-open bug the
tri-state exists to make unrepresentable.

`inconclusive` is treated exactly like `productive`: writes are locked out.
Neither `ABAP_MODE` nor any other setting overrides it. The evidence — the logon
client and the raw `T000-CCCATEGORY` value for it — is included in the refusal
and in the `abap://{SID}/system` resource, so an operator can see precisely why
the server refused.

`CCCATEGORY` is classified by allowlist, not by excluding `"P"`: `T`/`C`/`D`/
`E`/`S` are recognised as `nonproductive`, and anything else is `inconclusive` —
not assumed non-productive just because it isn't `"P"`. This means a system
with an exotic `CCCATEGORY` is write-locked until the list is extended — the
recoverable direction.

The probe puts **exactly one POST on the wire, with no retry**. This is a hard
invariant of that module: a second POST against `T000` on a system with
`login/fails_to_user_lock` set is how a shared account gets locked.

### The lockout is a one-way latch

Once the gate has been told writes are locked out, nothing clears it except a
process restart. The primary pooled connection is re-seatable — when the pool
replaces a dead primary, the fresh connection re-probes from scratch — and
without the latch a `productive` verdict followed by an `inconclusive`-then-
`nonproductive` sequence could re-open writes process-wide.

Staying locked on what is really a sandbox costs an operator some
inconvenience, and the refusal says exactly what to look at. Unlocking on what
is really production costs an unauthorised write to live business data, which
no restart undoes.
