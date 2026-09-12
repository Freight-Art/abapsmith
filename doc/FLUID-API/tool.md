# The `abap_fluid` MCP tool

This file is the design-side page for `abap_fluid` — how the one MCP tool
sits on top of the framework described elsewhere in `doc/FLUID-API/`. For
the wire contract (parameters, one example per op, safety, errors) see
`doc/TOOLS/abap-fluid.md`; this page does not repeat that table.

## One tool, not one-per-fluid-tool

`abap_fluid` is the only MCP tool this feature ever registers, regardless
of how many fluid tools — built-in or plugin — are loaded. As
`README.md`'s "## Ops" table already states: a new fluid tool needs **no**
MCP registration of its own; it becomes reachable the moment its manifest
loads. `abap_fluid` is a router in front of whatever is loaded, not a
generator of new MCP surface per tool.

## What sits underneath: `dispatch()`, `ensureFluidTool`, `loadFluidTools`

Three pieces, one call each:

- **`loadFluidTools`** (`src/adt/fluid/plugin-loader.ts`) runs once, at
  startup, never during a request. It loads every built-in manifest, and
  every plugin manifest under `ABAP_FLUID_PLUGINS` if
  `ABAP_ALLOW_FLUID_PLUGINS` is on, validating each one (envelope schema,
  contract major, id shape and uniqueness, namespace, `entry` presence,
  source-file resolution, action schema, static review — the full order is
  in `authoring.md`). The result is the `tools` map every `abap_fluid` call
  is served from. A tool that fails to load is refused by name and path,
  not silently skipped; a good plugin alongside a bad one still loads. This
  is why a fluid tool cannot appear mid-session: the map is fixed before
  the first request is served.
- **`dispatch()`** (`src/adt/fluid/dispatch.ts`) is what `abap_fluid`'s
  `run` op actually calls. It is the single entry point that runs one
  fluid action end to end: the fluid-disabled check, input validation
  against the action's own schema, resolving the manifest's `targets`
  JSON Pointers against the call's arguments and judging the resulting
  object/package/transport through the ordinary safety gate — all *before*
  any ABAP is generated — then the ensure/deploy/execute choreography, then
  transcript parsing. Every other fluid module is a piece `dispatch()`
  assembles; it never talks to the HTTP client directly itself.
- **`ensureFluidTool`** (`src/adt/fluid/ensure.ts`) is what makes `run`
  deploy-if-needed rather than deploy-always: given a tool's manifest, it
  classifies the tool's objects against the system (the same classification
  `verify` reports), and deploys, relocates, or repairs whatever is not
  already `present` and matching. `dispatch()` calls it before executing an
  action; `abap_fluid op=repair` calls the same underlying classification
  and repair logic directly, after first forgetting the registry entry so
  the classification is not served from a stale cache.

## Why `run` is the default op

Because it is the op that does the actual work every other op exists to
support or inspect. `list`, `describe`, and `status` answer "what is
loaded / deployed", and `verify` and `repair` answer "is it actually there
and can it be fixed" — all in service of `run` eventually succeeding. Making
`run` the default means the common case — call an action, get a result —
needs no `op` field at all: `{ "tool": "rt", "action": "ping", "args": {} }`
is a complete call. Naming `op: "run"` explicitly is equivalent and never
wrong; it is only ever redundant.

## Why `list` / `describe` / `status` are zero-network

All three answer questions that are fully determined by data already held
in the process or on local disk, and none of them needs to prove anything
about the live system to answer honestly:

- `list` and `describe` read only the `tools` map `loadFluidTools` built at
  startup — what manifests loaded, and what they declare. Nothing about
  whether their ABAP objects actually exist on the system is asked or
  implied.
- `status` reads only the local registry file under `ABAP_STATE_DIR` — what
  abapsmith itself last believed it deployed. `README.md` is explicit that
  the registry is "a cache, never the source of truth": a `status` result
  can be stale relative to the system, and does not claim otherwise. Only
  `verify` (and the deploy path inside `run`/`repair`) actually reads the
  system to find out what is really there.

This is also why all three remain callable-in-principle even though, in
practice, the real tool refuses them with `FLUID_API_DISABLED` when the
system later proves read-only in one of the three runtime senses (a
productive system, a tripped write lockout, a failed role probe):
`README.md`'s "Read-only disables the whole feature" explains that refusal
is about the fluid API's *precondition* (it cannot even answer "is this
deployed" honestly without being able to deploy, since nothing in it is
guaranteed pre-installed), not about these three ops individually needing
write access to do their own zero-network work. On a v1 server that is
read-only for a *mode* reason instead (`ABAP_MODE=read`, or legacy
read-only config), `abap_fluid` is the mode-locked stub described in
`doc/TOOLS/availability-and-capabilities.md`'s case 4 rather than this
real tool, and it refuses every op — `list`/`describe`/`status` included —
identically with `READ_ONLY`, not `FLUID_API_DISABLED`.

## `internal` tools and the route index

`buildFluidDescription` (`src/adt/fluid/describe.ts`) builds the tool
description `abap_fluid` hands the caller. Most of it is a "route
index" — one line per loaded tool's actions — plus one worked example
call, so a model deciding whether to call `abap_fluid` at all can see
what is reachable without a separate `describe` round trip first. A
manifest's `internal: true` field
excludes that tool from this route index and from the worked example
entirely: not truncated, not summarized, not hinted at with a count of
"N more" — simply not one of the tools a caller is being routed to.

This is a classification, not an elision. Nothing about the tool is
hidden: `op="list"` and `op="describe"` still return it in full, each
flagged `internal: true` so a caller that does look can tell it apart
from a routable tool. The field only changes what the route index
promotes as "things to call"; it changes no gating, no schema
validation, and nothing about whether the tool can actually be called —
an internal tool's actions run through `dispatch()` exactly like any
other tool's.

The framework's own `rt` tool (`src/adt/fluid/abap/runtime.ts`) is the
first and, as of this writing, only user of the field: its `ping` and
`fail` actions exist to exercise the wire protocol itself, not as
something an operator or agent should be routed to for ordinary work,
so `rt` carries `internal: true` and is left out of the route index
while remaining fully visible and callable.

## `remove`'s package caveat

`remove` deletes abapsmith-owned ABAP objects out of `$ABAPSMITH_FLUID_API`
— never the package itself. This is not a policy choice that could be
relaxed later; it is a mechanical dead end. The only package-delete route
abapsmith has works by deploying its own helper class *into* the package
being deleted and running it from there, and the generated ABAP refuses to
delete a non-empty package. A package cannot delete itself out from under
a helper class that is still living inside it. Getting rid of an empty
`$ABAPSMITH_FLUID_API` is a manual SE80/ADT action, not something
`abap_fluid` can ever be asked to do.

## See also

- `doc/FLUID-API/README.md` — concepts, configuration, the `## Ops` table.
- `doc/FLUID-API/safety.md` — the eight-step safety ordering `dispatch()`
  follows, and every fluid error code.
- `doc/FLUID-API/protocol.md` — the wire protocol `dispatch()` speaks to
  the deployed ABAP, and the call order `dispatch()` follows.
- `doc/TOOLS/abap-fluid.md` — the wire contract for `abap_fluid` itself.
