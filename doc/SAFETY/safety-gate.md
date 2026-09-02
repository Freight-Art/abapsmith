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
