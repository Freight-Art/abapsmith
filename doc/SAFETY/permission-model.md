# Permission Model

## Modes

`ABAP_MODE` is the single permission knob. Under `read` it is an absolute
ceiling no override can lift. Under `edit`/`admin` it sets the *default* for
transports, transport/cascade delete, release and enhancements — a
per-capability env var can still widen or narrow each one individually (see
[CONFIGURATION/permissions-and-allowlists.md](../CONFIGURATION/permissions-and-allowlists.md)).

| | `read` (default) | `edit` | `admin` |
|---|---|---|---|
| Read, search, resolve | yes | yes | yes |
| Write, activate, run, test | **no** | yes | yes |
| Default package | — | `*` (any) | `*` (any) |
| Transports | — | default: any caller-named request, and may auto-create | default: any caller-named request, and may auto-create |
| Transport release / delete | no | default: no | default: yes |
| Enhancements | no | default: customer-owned targets | default: customer + SAP-original |

Capability is enforced at up to three places, and which one applies depends
on the tool and, for the v1 surface, on whether the server is read-only end
to end:

- **Not registered at all.** A tool with no ungated mode is skipped outright
  when the capability is missing and (on v1) no locked stub stands in for
  it — today that means `abap_data_preview` without `ABAP_ALLOW_DATA_PREVIEW`,
  and `abap_fluid` when `ABAP_FLUID_API=false` regardless of mode. Neither
  appears in `tools/list`, so there is no schema for a model to
  discover and argue with, it costs no context, and it cannot be called by
  mistake.
- **Registered as a locked stub (v1 only).** On a v1 server that is
  read-only end to end (`cfg.readOnly === true`), the mutating tools that
  would otherwise fall into the bullet above instead get a refusal-only
  stub under their real name: `abap_write`, `abap_run`, `abap_test`,
  `abap_atc`, `abap_quick_fix`, `abap_ui`, `abap_fpm_read`,
  `abap_img_edit`, `abap_bopf_test`, `abap_bopf_edit`, `abap_bopf_delete`,
  `abap_transport_release`, and `abap_fluid` (while `ABAP_FLUID_API` stays
  on). Each stub lists with an empty schema and a description that says
  it is LOCKED, why, and which `ABAP_MODE` unlocks it; calling it returns a
  structured `READ_ONLY` refusal naming the required mode and the missing
  capabilities, and nothing else. **The safety outcome does not change**:
  the stub's handler is not a thinner version of the real one — it holds
  no connection, session-pool slot, or `SafetyGate` reference at all, so
  there is no code path from it to the SAP system, exactly as when the
  tool was absent. Only what a read-only server can *tell* a caller about
  these tools changed; what it can *do* did not. Before this
  (`src/tools/locked.ts`, issue #63), calling one of these on a read-only
  v1 server got `MCP error -32602: Tool <name> not found` —
  indistinguishable from a typo'd name, with no hint that raising
  `ABAP_MODE` was the fix. `abap_data_preview` is deliberately excluded
  from this mechanism: its gate is the out-of-band `ABAP_ALLOW_DATA_PREVIEW`
  flag, not a mode ceiling, so it stays in the bullet above instead. The v2
  surface has no equivalent of this bullet: `abap_do`'s `minMode` already
  answers "what would unlock this" structurally per action, and `abap_write`
  stays genuinely absent from v2's `tools/list` under `read` mode.
- **Registered, gated per call.** A tool with a genuinely ungated read mode is
  always listed, and its mutating modes are refused at the point of use:
  `abap_transport` (list/show/check/users are reads), `abap_bopf` (pure read),
  `abap_enh` (`discover_hook_anchors` makes no gate call at all),
  `abap_activate` (`mode=check` takes no lock and changes nothing),
  `abap_journal`, and `abap_dumps`.

`abap_dumps` is the one case where the **schema** varies rather than the
registration: without `ABAP_ALLOW_DUMP_VARIABLES` the `variables` field is not
advertised, so an un-opted deployment's `tools/list` carries no property and no
sentence mentioning variable values, and neither can be argued for or
prompt-injected into. The advertisement is not the permission — the handler
checks on every request that asks for that chapter by either route, so a
hand-crafted call against a schema the client never read is still refused.

Eight capabilities are two-way overrides rather than a strict ladder:
`ABAP_ALLOW_TRANSPORT_RELEASE`, `ABAP_ALLOW_TRANSPORT_DELETE`,
`ABAP_ALLOW_CASCADE_DELETE`, `ABAP_ALLOW_SERVICE_PUBLISH`,
`ABAP_ALLOW_ENHANCEMENTS`, `ABAP_ALLOW_SOURCE_PLUGINS`,
`ABAP_ALLOW_ENHANCEMENT_DELETE` and `ABAP_ALLOW_RAW_ADT_WRITES` (the last has
no `abap_*` tool yet). Left unset, each falls back to its mode's default from
the table above; set explicitly, it wins in either direction — an operator
can grant `ABAP_ALLOW_ENHANCEMENT_DELETE` under `edit` or withhold
`ABAP_ALLOW_TRANSPORT_RELEASE` under `admin`. `ABAP_ALLOW_SERVICE_PUBLISH`
gates `abap_service` `op="publish"`/`op="unpublish"` — the same tier as
`ABAP_ALLOW_TRANSPORT_RELEASE`, and each call additionally needs a matching
per-call `confirm` echo of the binding name. See
[CONFIGURATION/permissions-and-allowlists.md](../CONFIGURATION/permissions-and-allowlists.md) for the per-variable defaults.

## Out-of-band flags

Three flags sit outside the mode ladder and are off in every mode, including
`admin`, until named explicitly, because each puts business or personal data
into an agent transcript — a different kind of risk from "this call changes
an object":

| Flag | Grants |
|---|---|
| `ABAP_ALLOW_DATA_PREVIEW` | registers `abap_data_preview` at all |
| `ABAP_ALLOW_DUMP_VARIABLES` | lets `abap_dumps` return variable *contents* |
| `ABAP_ALLOW_UI_PRESS` | lets `abap_ui` submit a batch-input script (also needs `ABAP_MODE=admin`) |

A fourth flag, `ABAP_ALLOW_DEBUG_JUMP_TO_LINE`, sits outside the ladder for a
different reason: it changes what *executes* rather than what is disclosed. No
mode, `admin` included, implies it, and `ABAP_MODE=read` cannot take it away —
it has no capability field at all, so the one boolean is the whole story.

`jumpToLine` is separated from ordinary stepping deliberately. `into`, `over`,
`return`, `continue` and `runToLine` all execute code in order; `jumpToLine`
skips statements outright, including the authorisation and validation checks
they would have run. The flag only raises the ceiling — each individual jump
additionally needs a matching per-call `confirm` echo.

Three more flags, `ABAP_ALLOW_FLUID_PLUGINS`, `ABAP_ALLOW_FLUID_PLUGIN_MUTATE`
and `ABAP_ALLOW_FLUID_CALL_FM`, are out-of-band for yet another reason: they
gate the fluid API surface (`abap_fluid`) rather than disclosure or execution
order. All three default off (`src/config.ts:743-747`), none is implied by
another, and none widens `ABAP_MODE` — setting one cannot make a productive
or write-locked-out system writable. `ABAP_ALLOW_FLUID_PLUGIN_MUTATE` and
`ABAP_ALLOW_FLUID_CALL_FM` are also each enforced at plugin load time, not
only per call: a static source scan refuses to load a plugin object whose
ABAP contains a database write or `COMMIT WORK`/`ROLLBACK WORK` without the
former, or `CALL FUNCTION` in any form without the latter. See
[CONFIGURATION/permissions-and-allowlists.md](../CONFIGURATION/permissions-and-allowlists.md)
for what each permits.

A fourth flag in the same family, `ABAP_ALLOW_FLUID_EVAL`, gates the
built-in `core.eval` fluid action — running a caller-supplied ABAP snippet
as the body of one generated method. It is off by default, and unlike
every mode-scoped capability elsewhere on this page, no `ABAP_MODE` value
turns it on, not even `admin`; it is independent of
`ABAP_ALLOW_FLUID_PLUGINS` and `ABAP_ALLOW_FLUID_PLUGIN_MUTATE`. Every call
still needs its own `confirm: "core.eval"` echo — there is no
once-per-session memory — and the supplied lines still go through the
static review and capability scan on every call, the same as a plugin's
source at load time. This is a lint-not-sandbox control: the static
review and the capability scan reject a handful of named statements; they
do not confine the code. The real boundary is the SAP user's
authorisations, and `ABAP_ALLOW_FLUID_EVAL` is consent to run
model-authored code inside that boundary, nothing narrower. See
[FLUID-API/safety.md](../FLUID-API/safety.md) for the full ordering.

## The fluid API and read-only

A read-only session disables the fluid API completely: every `abap_fluid` op
— including `list` and `describe` — is refused with no HTTP request of any
kind. "Read-only" is several distinct conditions here, not one, and
`fluidDisabledReason(cfg, gate?)` (`src/adt/fluid/enabled.ts:21-37`) reports
exactly which one fired. Checked in order:

1. `cfg.fluidApi === false` — `kind: "flag"`, field `ABAP_FLUID_API`
2. `cfg.abapMode === "read"` — `kind: "read-only"`, field `cfg.abapMode`
3. `cfg.readOnly === true` — `kind: "read-only"`, field `cfg.readOnly` (under
   `ABAP_MODE`, this is the mode's own `allowWrite` capability — only `read`
   sets it false, and `ABAP_ALLOW_WRITE` is ignored; only in legacy config
   with no `ABAP_MODE` does `ABAP_ALLOW_WRITE` not being truthy drive it,
   `src/config.ts:1082`)
4. `gate.config.productive === true` — field `gate.config.productive`
5. `gate.config.systemRole === "productive"` — field `gate.config.systemRole`
6. `gate.config.roleProbeFailure !== undefined` — field
   `gate.config.roleProbeFailure`
7. `gate.config.writesLockedOut === true` — field `gate.config.writesLockedOut`

`fluidDisabledReason`'s return type distinguishes the single `kind: "flag"`
reason above from the six `kind: "read-only"` field names (2-7) — six, not
five, is easy to undercount if `roleProbeFailure` and `writesLockedOut` are
mistaken for the same condition; they are checked and reported separately.

The first three checks are static and known before `connect()` runs:
`canUseFluidApi = cfg.fluidApi && !cfg.readOnly && cfg.abapMode !== "read"`
(`src/config.ts:1632`), and `src/server.ts:708-719` registers `abap_fluid`
only when that holds — with `ABAP_FLUID_API=false`, under `ABAP_MODE=read`,
or (in legacy config with no `ABAP_MODE`) with `ABAP_ALLOW_WRITE` not
truthy, the tool does not appear in `tools/list` at all. The remaining four
are `SafetyConfig` fields on the gate and stay `undefined` until `connect()`
has run the T000 probe (`src/server.ts:519-524` transcribes the verdict onto
the gate), so that refusal can arrive at first use of `abap_fluid` rather
than at startup.

`ABAP_FLUID_API=false` also refuses the bridge-backed operations of several
already-shipped tools, not only `abap_fluid` — see
[CONFIGURATION/permissions-and-allowlists.md](../CONFIGURATION/permissions-and-allowlists.md)
for the full list.

`writesLockedOut` is a one-way latch on the safety gate (`src/safety.ts:174`,
latched at `:1154-1172`), cleared only by an explicit
`resetWriteLockout(reason)`. There is no `ABAP_READ_ONLY` environment
variable and no `writesLockedOut` field on `Config` — both live on the gate,
not on `Config`.

None of this can be talked around: setting `ABAP_FLUID_API=true` on a
productive system, or on one whose write lockout has already latched, still
refuses. The flag decides whether abapsmith is willing to try; it does not
move the ceiling.

## Authorisation is carried in the type system

Mutating call sites do not take an optional gate parameter. They take an
`AuthorizedTarget<Op>`, which can only be produced by `SafetyGate.authorize()`.
Forgetting to gate a call is therefore a compile error rather than a silent,
legal permit. The constructor also checks a module-private token at runtime, so
a deliberate `as unknown as` cast still throws when the forged value is
constructed — a bypass is loud, not silent.

### An ATC run is gated as `execute`, and that is not a typo

Static analysis reads code, so `abap_atc` looks like it belongs under
`analyze`. It does not, because ATC has no stateless "check this and tell me"
endpoint: findings live in a **worklist**, which is a persistent server-side
row created by its own POST. The run leaves state behind, and "it is only a
worklist" is exactly the argument a read-only ceiling exists to overrule — so
the POST goes through `conn.post` and is refused under `ABAP_MODE=read` like
any other write, rather than being routed around the ceiling.

`execute` is also the operation carrying the package-allowlist and
name-prefix rules. Without them this tool could aim unbounded server-side
check work at SAP-standard packages on a system the operator scoped this
server away from.

A read-only deployment cannot run ATC at all. `runAtcCheck` takes an
`AuthorizedTarget<"execute">`, so that decision is enforced by the type system
per the section above, not by a convention someone can forget.
