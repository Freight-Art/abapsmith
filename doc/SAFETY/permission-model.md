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

Capability is enforced at two places, and which one applies depends on the tool:

- **Not registered at all.** A tool with no ungated mode is skipped outright
  when the capability is missing — `abap_write`, `abap_run`, `abap_test`,
  `abap_fpm_read`, `abap_bopf_test`, `abap_atc` and `abap_ui` without
  `canWrite`;
  `abap_transport_release` without release capability; `abap_bopf_edit` and
  `abap_bopf_delete` without write capability; `abap_data_preview` without its
  flag. It is absent from `tools/list`, so there is no schema for a model to
  discover and argue with, it costs no context, and it cannot be called by
  mistake.
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

Seven capabilities are two-way overrides rather than a strict ladder:
`ABAP_ALLOW_TRANSPORT_RELEASE`, `ABAP_ALLOW_TRANSPORT_DELETE`,
`ABAP_ALLOW_CASCADE_DELETE`, `ABAP_ALLOW_ENHANCEMENTS`,
`ABAP_ALLOW_SOURCE_PLUGINS`, `ABAP_ALLOW_ENHANCEMENT_DELETE` and
`ABAP_ALLOW_RAW_ADT_WRITES` (the last has no `abap_*` tool yet). Left unset,
each falls back to its mode's default from the table above; set explicitly, it
wins in either direction — an operator can grant `ABAP_ALLOW_ENHANCEMENT_DELETE`
under `edit` or withhold `ABAP_ALLOW_TRANSPORT_RELEASE` under `admin`. See
[CONFIGURATION/permissions-and-allowlists.md](../CONFIGURATION/permissions-and-allowlists.md) for the per-variable defaults.

## The three out-of-band flags

These sit outside the mode ladder and are off in every mode, including `admin`,
until named explicitly. Each one puts business or personal data into an agent
transcript, which is a different kind of risk from "this call changes an
object":

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
