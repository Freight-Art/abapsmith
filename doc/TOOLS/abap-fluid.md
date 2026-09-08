# abap_fluid

The single entry point to abapsmith's **fluid API** — abapsmith functions
that only work by installing generated ABAP into the SAP system, all of it
living in one package, `$ABAPSMITH_FLUID_API`. Governed by `ABAP_FLUID_API`
(default on). See `doc/FLUID-API/README.md` for what the fluid API is and
how it is built; this file is the wire contract for the one MCP tool that
exposes it.

**Availability**: registered only when the fluid API is statically
available — `ABAP_FLUID_API` on, and the system is not read-only
(`ABAP_MODE` not `read`, `ABAP_ALLOW_WRITE` on). A read-only or
not-yet-write-capable server does not have this tool at all. Even after
registration, every network op still refuses with `FLUID_API_DISABLED` if
the system later proves productive, the write lockout trips, or the
system-role probe never answers — see `doc/FLUID-API/README.md`'s
"Read-only disables the whole feature" for the full list of senses.

## Calling with no arguments

A call with **no fields at all** returns an info payload rather than an
error: the loaded tools with their ids, origin (`builtin`/`plugin`),
version and action names, plus a short usage block and a `NEXT` line
suggesting where to go. Useful as a first call to see what is loaded before
naming a `tool`.

```json
{}
```

## Parameters

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `op` | enum `list` \| `describe` \| `status` \| `verify` \| `run` \| `repair` \| `remove` | no | `run` | Which operation to perform. |
| `tool` | string | `run`/`describe`: yes; `verify`/`repair`/`remove`: no | for `verify`/`repair`/`remove`, every loaded tool | Fluid tool id, e.g. `rt`. |
| `action` | string | `run` only: yes | — | Action name within `tool`. |
| `args` | object | `run` only | `{}` | The action's arguments, validated against that action's declared input schema. |
| `confirm` | string | `remove`: yes (must be exactly `"remove"`) | — | Also passed through to `run` for actions that themselves declare a confirmation requirement. |
| `corr_nr` | string | no | unset | Transport request for the deployment. `$ABAPSMITH_FLUID_API` is a local (`$`) package, so this is normally left unset. |
| `scope` | enum `tool` \| `invokers` \| `all` | `remove` only | `tool` | `tool`: delete the named tool's own manifest objects. `invokers`: delete only the generated per-call `ZCL_ZMCP_I_*` invoker classes. `all`: delete every abapsmith-owned object in `$ABAPSMITH_FLUID_API`. |

## Ops

### list — no network

The loaded tools, their origin, version and actions, plus any refused
plugins and loader warnings.

```json
{ "op": "list" }
```

### describe — no network

One tool in full: its manifest objects (name and type), its entry class,
and each action's name, category, description, and JSON input/output
schemas.

```json
{ "op": "describe", "tool": "rt" }
```

### status — best-effort read

Where the fluid API stands on this system: the flag, the package, the
write mode, how many tools are loaded, and what abapsmith's local registry
believes is currently deployed (tool id, contract, version, objects,
`deployedAt`). Reads the local registry file under `ABAP_STATE_DIR`, and
— best effort — probes the system for retired pre-fluid bridge classes,
reporting which of them still exist. The probe is read-only and never
mutates; if no connection can be made, or the probe fails, `status` still
renders the local answer and says the probe did not run.

```json
{ "op": "status" }
```

### verify — reads

Classifies every object of the named tool (or of every loaded tool if
`tool` is omitted) against its manifest, without writing anything:
`present`, `absent`, `stale`, `inactive`, `broken`, `foreign` (an object of
that name exists in a package abapsmith does not own — it is never touched)
or `legacy` (a reserved `ZCL_ZMCP_`/`ZIF_ZMCP_` name stranded in `$TMP` or
`$ZMCP_HELPERS`, a pre-fluid install). The summary also reports how many
retired pre-fluid bridge classes are still present on the system.

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

The ordinary authorized delete path means the safety gate's package
allowlist applies to the reap like any other write. Nine of the ten
retired classes live in `$TMP`, but `ZCL_ZMCP_IMG_WPROBE` lives
in `$ZMCP_HELPERS`, so reaping that one class needs `$ZMCP_HELPERS` in
`ABAP_ALLOW_PACKAGES` — which it would be on any system that created the
class in the first place. Where it is not, the gate refuses the delete and
the class is reported `failed` with the gate's own reason, e.g.:

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
