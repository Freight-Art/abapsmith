# Fluid API

The fluid API is the set of abapsmith functions that only work by installing
custom ABAP into the SAP system: IMG customizing write, the DDIC bridge,
package delete, report execution, the BOPF runtime test, and the FPM/UI
runtime. Each of those used to hand-roll a throwaway class with a private
console dialect. The fluid API replaces that with one framework: one
package, one manifest format, one wire protocol, one registry.

The framework is reached through exactly one MCP tool, `abap_fluid` — see
`tool.md` for how it sits on top of `dispatch()`, `ensureFluidTool` and
`loadFluidTools`, and `doc/TOOLS/abap-fluid.md` for its wire contract.

## Parts

| File | Covers |
|---|---|
| [manifest.md](manifest.md) | The manifest format — fields, the object model, a complete JSON example |
| [protocol.md](protocol.md) | The `ZMCP-H>` wire protocol and the ABAP body-class contract |
| [authoring.md](authoring.md) | How to write and install a plugin |
| [safety.md](safety.md) | The eight-step safety ordering, static review, error codes |

## Concepts

| Term | Meaning |
|---|---|
| Fluid tool | A named unit of ABAP functionality (`ddic`, `img`, `core`, `myplug`) with one or more actions. Built-in or plugin. Not an MCP tool. |
| Manifest | JSON describing one fluid tool: id, contract version, ABAP objects, actions. The unit of versioning and deployment. |
| Object | An ABAP repository object the tool needs (class or interface). Static — its source never depends on call arguments. |
| Action | A named callable on a tool, with an input schema, an output schema, and a safety category. |
| Invoker | A tiny generated per-call class carrying one call's arguments. The only thing written per call. |
| Plugin | An operator-installed directory: `fluid-plugin.json` plus `.abap` files. |
| Package | `$ABAPSMITH_FLUID_API`, a local (`$`, non-transportable) package holding every fluid object. Created on first use. |
| Registry | A local JSON cache under `ABAP_STATE_DIR` recording what abapsmith believes is deployed per system. A cache, never the source of truth. |

## Built-in tools

`core` is a built-in fluid tool with three actions:

- `core.select` (read) — a read-only row preview of one DDIC table.
  Judged by the **existing** data-preview policy
  (`ABAP_ALLOW_DATA_PREVIEW` plus the gate's table deny-list and
  ceiling), not by a new fluid-specific policy.
- `core.describe_fm` (read) — a function module's interface as a JSON
  Schema, built from FUPARAREF.
- `core.call_fm` (execute) — calls a function module dynamically. Off
  by default; requires `ABAP_ALLOW_FLUID_CALL_FM`. When `commit: true`,
  also requires a per-call `confirm: "core.call_fm"` echo.

`select`'s `fields` are validated against the table's DDIC components
before they reach the dynamic column list. `where` is passed through as
a dynamic Open SQL condition scoped to that one table; Open SQL cannot
express DML there, but the condition itself is not otherwise parsed or
restricted.

## Contract version

The contract is **1.0**, `"<major>.<minor>"`. A manifest names the contract
it was written against.

- An unknown **major** refuses the plugin outright.
- An unknown **minor** loads, with a warning.
- Adding an optional field to the manifest or protocol is a minor change.
- Anything else — a new required field, a changed frame shape, a changed
  error code — needs a **major** bump.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `ABAP_FLUID_API` | on | Master switch. Off refuses every fluid operation before any socket. |
| `ABAP_FLUID_PLUGINS` | unset | Comma-separated absolute plugin directories. |
| `ABAP_ALLOW_FLUID_PLUGINS` | off | Required, in addition to a non-empty `ABAP_FLUID_PLUGINS`, before any plugin loads or runs. |
| `ABAP_ALLOW_FLUID_PLUGIN_MUTATE` | off | Required for a plugin action with `category: "mutate"`. Built-ins are unaffected. |
| `ABAP_ALLOW_FLUID_CALL_FM` | off | Required for the built-in `core.call_fm` action. Every other `core` action is unaffected. |

`call_fm` is an **authorisation-shaped control, not a sandbox.** With the
flag on, any function module the logged-on user may call can be called,
including ones that write. The controls are the flag, the ordinary write
ceilings, the `commit: true` confirm echo, and the SAP user's own
authorisations — there is no allow-list of "safe" function modules and no
attempt to classify a module as read-only.

`ABAP_FLUID_PLUGINS` is split on commas alone, not by the general
`splitList` helper — that helper also splits on whitespace, which would
tear a path such as `/opt/My Plugins/x` into two bogus entries. Paths
containing commas are unsupported.

Two plugin variables exist on purpose, not one: `ABAP_FLUID_PLUGINS` names
paths, `ABAP_ALLOW_FLUID_PLUGINS` consents to running the operator ABAP
found there. Configuring a path and consenting to run operator-supplied
ABAP are separate acts — a path can arrive from an inherited profile or a
shared config file without that being consent to execute it, and plugins
can be switched off without losing the configured path.

## Read-only disables the whole feature

Every op — including `list`, `describe`, `status` and `verify` — refuses
with `FLUID_API_DISABLED` when abapsmith is read-only, in any of five
senses:

| # | Condition | Field |
|---|---|---|
| 1 | `ABAP_MODE=read` | `cfg.abapMode === "read"` |
| 2 | legacy read-only default | `cfg.readOnly === true` |
| 3 | productive system | `gate.config.productive === true` or `gate.config.systemRole === "productive"` |
| 4 | write-lockout latch engaged | `gate.config.writesLockedOut === true` |
| 5 | role probe never answered | the same latch, distinguished by `roleProbeFailure` |

There is no `ABAP_READ_ONLY` environment variable. It does not exist in
this codebase. The read-only state is derived from `ABAP_ALLOW_WRITE` and
`ABAP_MODE`: `cfg.readOnly` comes from `ABAP_ALLOW_WRITE` when `ABAP_MODE`
is unset, or from the mode's own capabilities otherwise, and conditions 1
and 2 above are exactly that derivation.

There is no read-only subset of the fluid API, because the fluid API
cannot answer anything without first installing ABAP into the system. A
`list` that enumerated fluid tools on a read-only session would be
enumerating tools that provably cannot run.

See [safety.md](safety.md) for how this fits into the full eight-step
ordering.

## Ops

One MCP tool, `abap_fluid`. A new fluid tool — built-in or plugin — needs
**no** MCP registration: it becomes reachable the moment its manifest
loads. `ABAP_TOOL_SURFACE` is unaffected by this feature; no existing MCP
tool is hidden, renamed or unregistered.

| `op` | Arguments | Network |
|---|---|---|
| `list` | — | none |
| `describe` | `tool` | none |
| `status` | — | best-effort read |
| `verify` | `tool?` | reads |
| `run` (default) | `tool`, `action`, `args`, `confirm?`, `corr_nr?` | writes and executes |
| `repair` | `tool?` | writes |
| `remove` | `tool?`, `scope?`, `confirm` | deletes |

`status`'s local registry read is now paired with a best-effort probe of
the system for retired pre-fluid bridge classes, reporting which of them
still exist. The probe is read-only and never mutates; if no connection
can be made, or the probe fails, `status` still renders the local answer
and says the probe did not run. See `doc/TOOLS/abap-fluid.md`'s `status`
section for the wire-level detail.

## Operations

**Deployment happens on first use.** No extra tool call, no confirmation,
no prompt. At most one informational line the first time something is
actually written into the system.

**The registry is a cache, never an authority.** It is a local JSON file
under `ABAP_STATE_DIR`, one per system. A miss costs one read. A stale hit
is corrected either by the content compare on the next deploy, or at run
time by the protocol's `BEGIN.ver` frame, which proves which version
actually ran. Deleting the state dir cannot corrupt a system — it only
costs the next call one extra read.

**Deploys take the existing cross-process object gate**, keyed by object
URI, waiting up to `ABAP_OBJECT_LOCK_WAIT_MS` (default 1500 ms). A
server-side `LOCKED` — a real ADT session holding the enqueue — is
reported immediately, naming the holder, and is never waited on or
retried: no lock timeout exists while the holder lives. If a write reports
success but the content still does not match, the deploy is retried once
per manifest per process; a second mismatch is a terminal
`FLUID_OBJECT_CONFLICT`.

## Invoker accumulation

Every call writes one `ZCL_ZMCP_I_<hash8>` invoker, and the name is a hash
of `{tool, action, args, contract}`. Population is bounded by **distinct
call shapes, not by call count**: a loop that repeats the same call
reuses the same invoker, and the identical write is skipped by the
existing content compare. Nothing is deleted automatically. `verify` lists
accumulated invokers under `scaffolding`. `remove` with `scope: "invokers"`
sweeps them without touching the deployed tools or the package.

## No caps

The framework never truncates its own output. There is no byte ceiling, no
value-count ceiling, and no input ceiling. The only ceiling is the
operator's own `ABAP_MAX_RESPONSE_CHARS`, applied by `buildResponse`
(`src/compact.ts:206`, default 47,100 characters), exactly as for every
other tool. `FLUID_INPUT_TOO_LARGE` does not exist as an error code. A
long argument becomes more generated ABAP source lines, never a refusal —
see [protocol.md](protocol.md) for the chunking rule.

`core.select`'s `max_rows` imposes nothing by default: omitted means no
row restriction — the generated ABAP passes 0, and ABAP's `UP TO 0 ROWS`
means no restriction. The only output budget remains `buildResponse`,
above.
