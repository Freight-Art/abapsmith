# abap_fluid

The single entry point to abapsmith's **fluid API** — abapsmith functions
that only work by installing generated ABAP into the SAP system, all of it
living in one package, `$ABAPSMITH_FLUID_API`. Governed by `ABAP_FLUID_API`
(default on). See `doc/FLUID-API/README.md` for what the fluid API is and
how it is built; this file is the wire contract for the one MCP tool that
exposes it.

**Availability**: the real, fully-functional tool registers only when the
fluid API is statically available — `ABAP_FLUID_API` on, and the system is
not read-only (`ABAP_MODE` not `read`, `ABAP_ALLOW_WRITE` on). With
`ABAP_FLUID_API` off, `abap_fluid` is absent from `tools/list` entirely,
regardless of mode. A read-only or not-yet-write-capable v1 server is
different: as long as `ABAP_FLUID_API` stays on, `abap_fluid` is still
listed, but as a mode-locked refusal stub under the same name (no
parameters, LOCKED in its description, refuses every call `READ_ONLY`
without making any network request) rather than being absent — see
`doc/TOOLS/availability-and-capabilities.md`'s case 4. Once the real tool
*is* registered, every network op still refuses with `FLUID_API_DISABLED`
if the system later proves productive, the write lockout trips, or the
system-role probe never answers — see `doc/FLUID-API/README.md`'s
"Read-only disables the whole feature" for the full list of senses; those
are runtime discoveries the locked stub above never needed, since it never
attempts a connection at all.

## The tool description is generated

The MCP tool description a client sees for `abap_fluid` is not
hand-written — `buildFluidDescription` (`src/adt/fluid/describe.ts`) builds
it at registration time from the loaded manifests: the header, a
`tools.actions (category)` route index listing every loaded tool and every
one of its actions, and two example calls built from the first tool's first
action. The route index is **complete by construction**: every loaded tool
and every action is rendered every time, never truncated, never an `+N
more` elision. This means installing a fluid plugin and restarting the
server is enough for its tool and actions to appear in the description —
no code change, no MCP re-registration logic to update. A tool set with
nothing loaded gets `No fluid tools are loaded.` instead of a route index.

## Calling with no arguments

A call with **no fields at all** returns an info block rather than an
error — `buildFluidInfoBlock` (`src/adt/fluid/describe.ts`): the
`ABAP_FLUID_API` flag state, the package, the contract, the abap mode, the
read-only state, whatever the safety gate exposes (system role, productive,
write-lockout, role-probe failure), every loaded tool with its id, origin
(`builtin`/`plugin`), version and action names, every **refused** plugin
(its path, manifest id if parsed, refusal code and reason), any loader
warnings, and a `next` line suggesting where to go — `describe` on the
first loaded tool when one exists, otherwise a pointer at
`ABAP_FLUID_PLUGINS`/`ABAP_ALLOW_FLUID_PLUGINS` or at the refusals. This is
the one place a misconfigured plugin directory is never silently invisible.
Useful as a first call to see what is loaded before naming a `tool`.

This is all about the real, registered tool. With `ABAP_FLUID_API` off,
there is no `abap_fluid` to call at all. On a v1 server that is read-only
for a mode reason (`ABAP_MODE=read`, or legacy read-only config) with
`ABAP_FLUID_API` still on, `abap_fluid` names the mode-locked stub instead
(see "Availability" above): an empty call `{}` gets the same fixed
`READ_ONLY` refusal as any other call, not the info block and not
`FLUID_API_DISABLED` — the stub does not branch on its arguments at all.
Only once the real tool is registered (write-capable session) does an
empty call's flag/read-only gate look like the ordinary
`FLUID_API_DISABLED` refusal described in "Read-only disables the whole
feature" in `doc/FLUID-API/README.md` — reachable there for the ceilings
discovered only after `connect()` (productive system, write lockout,
failed role probe), since the mode/flag ceilings that page also lists are
already excluded by registration or replaced by the stub before a call is
ever dispatched.

```json
{}
```

## Parameters

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `op` | enum `list` \| `describe` \| `status` \| `verify` \| `run` \| `repair` \| `remove` | no | `run` | Which operation to perform. |
| `tool` | string | `run`: yes; `describe`/`verify`/`repair`/`remove`: no | for `describe`/`verify`/`repair`/`remove`, every loaded tool | Fluid tool id, e.g. `rt`. |
| `action` | string | `run` only: yes | — | Action name within `tool`. |
| `args` | object | `run` only | `{}` | The action's arguments, validated against that action's declared input schema. |
| `confirm` | string | `remove`: yes (must be exactly `"remove"`) | — | Also passed through to `run` for actions that themselves declare a confirmation requirement. |
| `corr_nr` | string | no | unset | Transport request for the deployment. `$ABAPSMITH_FLUID_API` is a local (`$`) package, so this is normally left unset. |
| `scope` | enum `tool` \| `invokers` \| `dynamic` \| `all` | `remove` only | `tool` | `tool`: delete the named tool's own manifest objects. `invokers`: delete only the generated per-call `ZCL_ZMCP_I_*` invoker classes. `dynamic`: delete only the per-call dynamic bridge classes (see "Dynamic bridges" below). `all`: delete every abapsmith-owned object in `$ABAPSMITH_FLUID_API`. |

For `describe`, `verify` and `repair`, an explicit `tool: ""` is treated
exactly like omitting `tool` — describe-all, verify-all, or whole-system
repair. `remove`'s default `scope: "tool"` is the one exception: it still
requires a non-empty `tool` and rejects `tool: ""` the same as omitting it
entirely (`scope: "invokers"`/`"all"` don't need `tool` at all).

## Ops

### list — no network

The loaded tools, their origin, version and actions, plus any refused
plugins and loader warnings. A compact catalogue: it carries **no** JSON
schemas — for those, use `describe`. Answered entirely from the loaded
manifests; issues zero HTTP requests.

```json
{ "op": "list" }
```

### describe — no network

One or more tools in full: each tool's manifest objects (name and type),
its entry class, and each action's name, category, description, and full
JSON input/output schemas, verbatim from the manifest, `targets` included
where the action declares them. **`tool` is optional here**: name one to
describe just that tool, or omit it to describe every loaded tool in one
call. Like `list`, `describe` is answered entirely from the loaded
manifests and issues zero HTTP requests.

The response shape follows what was **asked for**, not how many tools
happen to be loaded: naming a `tool` always renders the flat, single-tool
form (a `TOOL` header plus one `OBJECTS`/`ACTIONS` body); omitting `tool`
always renders one section per tool, each titled `<id> (<origin>,
v<version>)`, even when exactly one tool is loaded. A system with a single
fluid tool therefore renders differently depending on whether that tool's
id was named in the call.

```json
{ "op": "describe", "tool": "rt" }
```

```json
{ "op": "describe" }
```

### status — best-effort read

Where the fluid API stands on this system: the flag, the package, the
contract, the abap mode, whether the connection is read-only, how many
tools are loaded, and what abapsmith's local registry believes is
currently deployed (tool id, contract, version, objects, `deployedAt`).
Reads the local registry file under `ABAP_STATE_DIR`, then — best effort,
over one shared connection attempt — runs three further read-only probes: a
`RETIRED BRIDGE CLASSES` section (which retired pre-fluid bridge classes
are still present), an `INVOKER CLASSES` section (a per-tool invoker
count, see "Invoker classes" below), and a `DYNAMIC BRIDGES` section (see
"Dynamic bridges" below). No probe mutates anything. All three read the
system rather than the registry, so what they report is observed, not
believed — unlike the registry summary above them, which is a cache. If
the connection attempt itself fails, the local-registry answer above still
renders in full, and all three sections render their own
`(probe unavailable: ...)` line instead of failing the whole call.

The three probes **degrade independently** once connected. The invoker and
dynamic-bridge probes can each still fail on their own after that point —
listing the package or reading one class's source can throw — in which case
that section alone shows `(probe unavailable: ...)` while the others, which
already succeeded, render normally. The retired-bridge probe itself
never throws (an unreadable class is reported per-row as `unknown`
instead), so `RETIRED BRIDGE CLASSES` is unavailable only when the initial
connection attempt fails outright, which blanks all three sections at once.

`status`'s invoker probe attributes every `ZCL_ZMCP_I_<hash8>` invoker
class present in `$ABAPSMITH_FLUID_API` to a tool — one source read per
invoker inside a held connection lease, however many invokers exist.
`repair` prunes stale invokers (see below), which is what keeps the count
bounded in practice.

```json
{ "op": "status" }
```

### verify — reads

Classifies every object of the named tool (or of every loaded tool if
`tool` is omitted) against its manifest, without writing anything:
`present`, `absent`, `stale`, `inactive`, `broken`, `foreign` (an object of
that name exists in a package abapsmith does not own — it is never touched)
or `legacy` (a reserved `ZCL_ZMCP_`/`ZIF_ZMCP_` name stranded in `$TMP` or
`$ZMCP_HELPERS`, a pre-fluid install). The response also carries a
`RETIRED BRIDGE CLASSES` section — the same list `status` renders (see
above): each non-absent retired class's name, state
(`present`/`moved`/`unknown`), and where it was found, not merely a count.
Unlike `status`'s copy of this probe, `verify`'s never reports
`(probe unavailable: ...)`: it runs inside the same already-held read
lease used to classify the tools' own objects, and the underlying probe
never throws. If the connection itself cannot be made, `verify` fails the
whole call rather than degrading — there is no best-effort fallback here
the way there is for `status`.

```json
{ "op": "verify", "tool": "rt" }
```

### run — writes and executes (the default)

Deploy-if-needed, then execute one action. `op` may be omitted:

```json
{ "tool": "rt", "action": "ping", "args": {} }
```

is the same call as:

```json
{ "op": "run", "tool": "rt", "action": "ping", "args": {} }
```

The result carries the action's own result plus the tool id, action,
manifest version, whether anything was deployed on this call, elapsed
milliseconds, and whether the console output was truncated.

**`log.read`** is one built-in worth calling out here: unlike every other
built-in action, its result is not returned as the generic JSON dump above —
`src/tools/fluid.ts`'s `runRun` recognizes `tool: "log", action: "read"` and
renders it instead as one text table per matched log (header fields, then —
with `detail: "messages"` — a message table), via `renderLogRead` in
`src/adt/bal-log.ts`. It also writes a stderr audit line naming only what was
asked for and how much came back, never message text:

```
[abapsmith] audit: abap_fluid log.read object=ZFOO subobject=* logs=3 messages=0
```

Arguments (all optional; defaults in parentheses): `object`, `subobject`,
`extnumber` (each `*`/`+` pattern-capable), `user` (connected user; pass `*`
for every user), `since`/`until` (`YYYYMMDDHHMMSS`, server time),
`last_seconds` (mutually exclusive with `since`/`until`), `tcode`, `program`,
`max` (20), and `detail` (`headers` or `messages`). With neither an absolute
nor a relative window given, the window defaults to the last hour
(`DEFAULT_LOG_WINDOW_SECONDS = 3600`).

```json
{ "tool": "log", "action": "read", "args": { "object": "ZFOO", "last_seconds": 3600, "detail": "messages" } }
```

`detail: "messages"` note: message text and its `msgv1`..`msgv4` variables
are application data written by the logging program, not abapsmith's own
output, and may contain business data — see
[diagnostics.md](diagnostics.md)'s `log` section for the full parameter
table, the write-back caveat on `BAL_DB_LOAD`, and the correlation hints
`abap_run`/`abap_test`/`abap_bopf_test`/`abap_ui mode=press` emit pointing
back at this call.

`last_seconds` cannot be combined with `since`/`until` — passing both is
refused as `BAD_INPUT` before any network call (`bal-log.ts`'s
`assertLogReadArgsNoWindowConflict`, called from `runRun` before it
connects), with the same check kept on the ABAP side as a backstop.

**`core.change_docs`** also gets a dedicated render instead of the generic
JSON dump: `runRun` recognizes `tool: "core", action: "change_docs"` and
renders it as one section per change document via `renderChangeDocs` in
`src/adt/change-docs.ts`. It writes a stderr audit line naming only the
object class and counts, never field values:

```
[abapsmith] audit: abap_fluid core.change_docs objectclass=EQUIPMENT objectid=* changes=4 positions=11 denied_tables=0
```

Arguments: `objectclass` (required, max 15 chars), `objectid` (`*` wildcard
accepted, max 90 chars), `user`, `since`/`until` (`YYYYMMDDHHMMSS`; the
default window is the last 24 hours, both ends taken from one server-time
snapshot so they cannot disagree about "now"), `tcode`, and `max` (a cap on
change **documents**, not positions — 0 or omitted means 20; every position
of each returned document is read in full, then the whole set is clamped
against the `ABAP_DATA_PREVIEW_MAX_ROWS` ceiling in TypeScript).

```json
{ "tool": "core", "action": "change_docs", "args": { "objectclass": "EQUIPMENT", "objectid": "*", "since": "20240101000000" } }
```

`core.change_docs` reads real field-level history from `CDHDR`/`CDPOS` and
is gated exactly like `abap_data_preview`/`core.select`: it requires
`ABAP_ALLOW_DATA_PREVIEW`, refused as `SAFETY_DENIED` before any network
call otherwise (`guardCoreAction` in `src/adt/fluid/builtin/core.ts`). That
pre-read check only covers `CDHDR`/`CDPOS` themselves; every table a
returned `CDPOS` row names is checked again, after the read, by
`applyPositionPolicy` — see `doc/SAFETY/data-access-and-credentials.md`.
`objectclass`/`since`/`until` are validated before any network call
(`assertChangeDocsArgs`, called from `runRun` before it connects): a
missing `objectclass`, a malformed `since`/`until`, or `since` after `until`
is refused as `BAD_INPUT` with no round trip spent.

**`core.locks`** gets the same dedicated-render-plus-audit treatment,
via `renderLocks`/`auditLocks` in `src/adt/enqueue-read.ts`:

```
[abapsmith] audit: abap_fluid core.locks object=* table=ZFOO_T user=* read=42 matched=3 kept=3
```

Arguments: `object` (matched against the lock's `GNAME`/`GOBJ`), `table`
(matched against `GARG`, the lock argument), `user` (matched against
`GUNAME`), and `max` (row cap; 0 or omitted means 50). All matching is done
client-side with a `CP` ("contains pattern") wildcard, because
`ENQUEUE_READ`'s own filter parameters are exact-match only. At least one of
`object`, `table` or `user` is required — an empty call is refused as
`BAD_INPUT` before any network call (`assertLocksArgs`, called from `runRun`
before it connects, mirroring `log.read`'s pre-connect check above), so
there is no way to use this action to dump the whole enqueue table.
`core.locks` is read-only: there is no release/`DEQUEUE` action, and it is
not gated by the data-preview policy — enqueue state is runtime lock
information, not table data. Diagnostic fields such as `GTCODE`, `GTHOST`,
`GTDATE` and `GTTIME` are probed at runtime and reported absent when a
system's `SEQG3` does not carry them, never faked.

```json
{ "tool": "core", "action": "locks", "args": { "table": "ZFOO_T" } }
```

### repair — writes

Forgets the local registry entry so every object is re-classified fresh
from the system, then deploys, relocates, or re-creates whatever is not
`present`. A `broken` object is repaired by delete-then-recreate, not a
plain rewrite — the source already matches what would be written, so a
plain write short-circuits and never touches a broken object. One repair
attempt per object per call; never a retry loop.

When `tool` is **omitted**, `repair` additionally deletes any retired
pre-fluid bridge classes that are still present, through the ordinary
authorized delete path, and reports what it deleted. A class of one of
those names found in a package abapsmith does not own is reported as
moved and is never touched. Naming a `tool` skips the reap entirely.

When `tool` is **given**, `repair` additionally prunes that tool's *stale*
invoker classes — see "Invoker classes" below. Whole-system `repair` (no
`tool`) does not prune invokers at all; pruning is a per-tool operation
only.

Pruning first re-probes every one of that tool's invokers present in
`$ABAPSMITH_FLUID_API` — one source read per invoker, however many exist
— then prunes whichever are stale. That pruning is itself what keeps the
invoker count from growing without bound in practice.

The ordinary authorized delete path means the safety gate's package allowlist
applies to the reap like any other write. Of the seventeen retired classes,
nine live in `$TMP` and seven were deployed into `$ABAPSMITH_FLUID_API` itself:
`ZCL_ZMCP_IMG_WAPPLY` and `ZCL_ZMCP_CTS_WREQ` (the static IMG write and
customizing-request bridges superseded by the `img` fluid tool), plus the five
fixed-name enhancement create-family bridges — `ZCL_ZMCP_ENH_CSPOT`,
`ZCL_ZMCP_ENH_ADEF`, `ZCL_ZMCP_ENH_FDEF`, `ZCL_ZMCP_ENH_CIMPL`,
`ZCL_ZMCP_ENH_FVAL` — superseded by the `enh` fluid tool. `ZCL_ZMCP_IMG_WPROBE`
is the odd one out: it lives in `$ZMCP_HELPERS`, so reaping that one class
needs `$ZMCP_HELPERS` in `ABAP_ALLOW_PACKAGES` — which it would be on any
system that created the class in the first place. Where it is not, the gate
refuses the delete and the class is reported `failed` with the gate's own
reason, e.g.:

```
Package $ZMCP_HELPERS is not in the allowlist [$TMP, $ABAPSMITH_FLUID_API].
```

This is distinct from `moved`: `moved` is a class found sitting in some
other, unexpected package, which is never touched; a gate refusal is the
class sitting exactly where expected, refused only because the allowlist
no longer covers that package.

Each delete takes its own write lease rather than sharing one connection
across the reap: deleting an ABAP class kills the ADT session server-side,
and a connection may only re-logon a small fixed number of times outside a
budgeted request, so sharing one connection across a ten-class reap would
run it out partway through and silently leave the tail of the list
untouched. One lease per delete gives every delete a fresh connection.
Pruning stale invokers (above) follows the same one-lease-per-delete
discipline, for the same reason.

```json
{ "op": "repair", "tool": "rt" }
```

### remove — deletes

Deletes abapsmith-owned ABAP objects from `$ABAPSMITH_FLUID_API`. Requires
`confirm: "remove"`.

```json
{ "op": "remove", "tool": "rt", "confirm": "remove" }
```

**`remove` deletes objects only — it never deletes the
`$ABAPSMITH_FLUID_API` package itself.** The package-delete route abapsmith
uses elsewhere deploys its own helper class into the target package before
deleting it, and the generated ABAP refuses to delete a non-empty package —
deleting the package from inside itself cannot work. Drop the empty
package manually in SE80 or ADT if you want it gone.

Like the reap and the invoker prune above, deleting several objects in one
`remove` call takes a fresh write lease per delete, not one connection
looped over the list — deleting an ABAP class ends the ADT session
server-side, and a single connection survives only a small fixed number of
re-logons. Expect `remove` and `repair` on a tool with many objects or many
accumulated invokers to take one connection round-trip per object deleted,
not one round-trip total.

## Invoker classes

Every `run` deploys a tiny generated invoker class, `ZCL_ZMCP_I_<8 hex>`
(see `doc/FLUID-API/README.md`'s "Invoker accumulation" for why they
accumulate and how `verify`/`remove` see them). The name is
content-addressed from `(toolId, action, contract, canonical args)` —
deliberately **excluding the tool version**. That keeps the invoker's name
stable across a version bump of the same tool/action/args, so the
runtime's `BEGIN.ver` version echo stays a real check of what actually
ran, rather than a tautology against a name that already encodes the
version it's supposed to confirm.

Because the version is left out of the name, it cannot be read back from
it. The only recoverable provenance is inside the generated ABAP source
itself: a comment naming the tool id and action, and the `attach()` call
naming the version and contract the invoker was built against. Reading
that provenance means listing the package and reading each class's source
— there is no cheaper way to attribute an invoker to a tool.

This provenance drives two ops. Both read source for every invoker
present, however many there are — the full invoker count is always cheap
and exact, and so is attributing or checking each one, just at the cost
of one source read per invoker:

- **`status`** counts invokers per tool (see `status` above) — both the
  total and the per-tool breakdown are exact, and `status`'s three probes
  degrade independently rather than failing the whole call when one of
  them can't run.
- **`repair` with a `tool`** prunes that tool's *stale* invokers: those
  whose source attributes them to that tool, parses a version, and that
  version differs from the tool's current version. An invoker whose source
  cannot be attributed to any tool, or that carries no parsed version, is
  **never** pruned — an unattributable object is never safe to delete.
  Whole-system `repair` (no `tool`) does not prune invokers at all. This
  pruning is what keeps the invoker count bounded in practice, since
  every invoker present is checked on every call.

## Dynamic bridges

Most abapsmith tools that once generated a per-call `IF_OO_ADT_CLASSRUN`
bridge class now run through the fluid API instead. Five paths still
generate one, because each needs to emit ABAP built from the caller's own
input rather than drive a fixed body with JSON arguments:

| Family | Tool path | Class names |
|---|---|---|
| BOPF test bridges | `abap_bopf_test` | `ZCL_ZMCP_BO_*` |
| Enhancement exercise bridges | `abap_enh` with `operation: "exercise"` | `ZCL_ZMCP_ENH_EXEC` |
| FPM lock-mode bridges | `abap_fpm_read` with `mode: "locks"` | `ZCL_ZMCP_FPMLK_*` |
| Run report bridges | `abap_run` | `ZCL_ZMCP_RUN_*` |
| UI press bridges | `abap_ui` with `mode: "press"` | `ZCL_ZMCP_UI_*` |

These are a deliberate remainder, not an oversight. The fluid runtime
passes arguments as a JSON object of scalars and string arrays, which is
enough for a fixed body but not for these five, whose generated ABAP
varies with the caller's request — a BOPF scenario's node graph, a
dynpro's field list, a report's selection screen.

`status` reports them in its `DYNAMIC BRIDGES` section, by family and
count, from a live probe of `$ABAPSMITH_FLUID_API` rather than from the
registry cache. `remove` with `scope: "dynamic"` deletes exactly these
five families. `scope: "all"` already deleted them before that scope
existed — every one of these names is reserved (`ZCL_ZMCP_*`) and `all`
matches on the reserved-name rule — so `dynamic` narrows the sweep, it
does not widen `all`.

Each family's classes accumulate the same way invokers do, and are cleaned
up the same way: per-delete write leases, as described under `remove`.

## Safety

Every op runs under the ordinary write ceilings on top of the fluid flag:
`ABAP_ALLOW_WRITE`/`ABAP_MODE`, the customer-namespace name rule,
`ABAP_ALLOW_PACKAGES` (which must include `$ABAPSMITH_FLUID_API` or every
fluid-backed tool is denied), and the productive-system lockout. See
`doc/FLUID-API/safety.md` for the full ordering.

abapsmith never deletes or overwrites an object it does not own: an object
of a manifest name found in a foreign package is reported `foreign` and
left alone, never touched.

Responses are capped by `ABAP_MAX_RESPONSE_CHARS`; truncation is always
marked in the result rather than silently dropped.

## Errors

Fluid-specific error codes (`FLUID_API_DISABLED`, `FLUID_PLUGINS_DISABLED`,
`FLUID_PLUGIN_MUTATE_DISABLED`, `FLUID_OBJECT_CONFLICT`,
`FLUID_MANIFEST_INVALID`, `FLUID_ACTION_FAILED`, `FLUID_PROTOCOL_ERROR`)
are documented in full, with the condition that raises each one, in
`doc/FLUID-API/safety.md`'s "Error codes" table.

## See also

- `doc/FLUID-API/README.md` — what the fluid API is, its concepts, and the
  `## Ops` table this file's per-op sections match.
- `doc/FLUID-API/tool.md` — how `abap_fluid` is built on the framework's
  `dispatch()`/`ensureFluidTool`/`loadFluidTools` internals.
- `doc/FLUID-API/safety.md` — the eight-step safety ordering and every
  error code.
