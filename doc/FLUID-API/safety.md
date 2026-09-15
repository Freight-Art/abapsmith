# Fluid API safety

## The eight-step ordering

Checked in this order for every `run`; the first failure refuses and
nothing is written. Steps 1-7 never widen anything the existing safety
gate would otherwise refuse — the gate is still the last word.

`core.eval` runs the same ordering as every other action, plus its own
flag check and the static review/capability scan applied per call rather
than once at plugin load time — see "`core.eval`'s ordering" below.

1. **`ABAP_FLUID_API`** must be on, checked before any socket opens.
   Refusal: `FLUID_API_DISABLED`.
2. **Read-only, in any of the five senses of [README.md](README.md)**,
   for every op — not only `run`. Refusal: `FLUID_API_DISABLED`, naming
   the deciding field. This step describes the real, registered tool. On
   a v1 server, the two statically-known senses (`ABAP_MODE=read`, legacy
   `readOnly`) never actually reach this step — the server instead
   registers a mode-locked refusal stub under the `abap_fluid` name at
   startup, which refuses every call with `READ_ONLY` instead (case 4 in
   `doc/TOOLS/availability-and-capabilities.md`; `src/tools/locked.ts`,
   issue #63). The other three senses (productive system, `systemRole`,
   role-probe failure) are only known once connected, so they still reach
   the real tool and this step's `FLUID_API_DISABLED` refusal.
3. **Plugin?** `ABAP_ALLOW_FLUID_PLUGINS` must be on. Refusal:
   `FLUID_PLUGINS_DISABLED`.
4. **Plugin action with `category: "mutate"`?** `ABAP_ALLOW_FLUID_PLUGIN_MUTATE`
   must be on, and the call must carry a `confirm` argument that echoes
   exactly `<tool>.<action>`. Refusal: `FLUID_PLUGIN_MUTATE_DISABLED`. This
   is the per-call half of the gate: the same flag also governs a
   load-time check described below, which can refuse the whole plugin
   before any call is ever made.
5. **`core.call_fm`?** `ABAP_ALLOW_FLUID_CALL_FM` must be on, and the call
   must carry the same `confirm` echo when `commit: true`. Same split as
   step 4: this is the per-call half, and the flag also governs a
   load-time check below.
6. **The action's `input` schema**, validated offline, before any network
   call.
7. **`targets`** — the manifest's JSON Pointers are resolved against the
   arguments, and the resulting object, package and transport are handed
   to the safety gate, before any ABAP is generated. Without this step the
   gate would only ever see the invoker class's own harmless URI, never
   the object the action actually acts on.

   Handed to the gate is not the same as independently checked, and the
   difference matters when writing a manifest. The gate's **transport**
   allowlist (`ABAP_ALLOW_TRANSPORTS`) is reached only inside its
   `needsTransport` branch, which requires a **known, non-`$`** package —
   so an action that declares a `transport` pointer but no `package`
   pointer passes a transport number the allowlist never looks at. That
   declaration still documents intent and still reaches the journal, but
   it enforces nothing on its own. An action that records anything in CTS
   should declare the full `{object, package, transport}` triple; where
   the package genuinely is not knowable without an extra network read,
   say so at the declaration rather than leaving a lone `transport`
   pointer to read like a control.

   An action may also declare `targets: {}` — present but empty. That is
   meaningfully different from omitting `targets`, which skips the gate
   call entirely: an empty object still routes through it, so the write
   ceilings apply and, with no package resolved, the package allowlist
   falls to its fail-closed branch (nothing matches unless the allowlist
   holds the literal `*`). Use it for a mutate that genuinely acts on no
   named repository object, and say why in a comment at the declaration.
8. **The ordinary ceilings**, unchanged and above all of it: productive or
   inconclusive system, the write-lockout latch, `ABAP_MODE`, a read-only
   session. Deploying is a write plus an activate; running is an execute.
   These ceilings apply regardless of anything above, and the existing
   gate is still the last word.

## `core.eval`'s ordering

`core.eval` is a `core` action like `select`, `describe_fm` and `call_fm`,
so it is checked at steps 1-2 and 6-8 above like any other action. Its own
additional checks run in this order, before any ABAP is generated:

1. **`ABAP_ALLOW_FLUID_EVAL`** must be on. It is off by default and is not
   switched on by any `ABAP_MODE`, not even `admin`; it is independent of
   `ABAP_ALLOW_FLUID_PLUGINS` and `ABAP_ALLOW_FLUID_PLUGIN_MUTATE`. While
   it is off, `core.eval` does not appear in the fluid catalogue at all,
   and a direct call refuses with `FLUID_EVAL_DISABLED`, naming the flag.
2. **`confirm` must equal `"core.eval"`** on every call — there is no
   once-per-session memory. Otherwise `BAD_INPUT`.
3. **Shape checks on `lines` and `out`**: each `lines` entry at most
   `FLUID_ABAP_LINE_MAX` (255) characters with no CR or LF, and each `out`
   entry matching `^[A-Za-z_][A-Za-z0-9_]{0,29}$`. Otherwise `BAD_INPUT`,
   naming the offending line index or value.
4. **The static review** (`reviewFluidAbap`) runs per call over the
   supplied `lines`, the same rules as the plugin-load-time review: any
   finding refuses the call outright, naming the rule and the line.
5. **The capability scan** (`scanFluidCapabilities`) runs per call over
   the same `lines`. A database write or `COMMIT WORK`/`ROLLBACK WORK`
   additionally requires `ABAP_ALLOW_FLUID_PLUGIN_MUTATE` (else
   `FLUID_PLUGIN_MUTATE_DISABLED`); any `CALL FUNCTION` additionally
   requires `ABAP_ALLOW_FLUID_CALL_FM` (else `SAFETY_DENIED`). The
   refusal names the statement and its line.

Unlike a plugin, where the static review and capability scan run once at
load time over the plugin's own `.abap` files, `core.eval`'s `lines` are
caller-supplied per call, so both scans run per call instead.

## Static review is a lint, not a sandbox

Offline, before the first network call. Two parts:

- **The 255-character ABAP line guard.**
- **An additive prohibition list**: `CALL 'SYSTEM'`, `EXEC SQL`,
  `INSERT REPORT`, `GENERATE SUBROUTINE POOL`,
  `CALL FUNCTION ... DESTINATION`, `SUBMIT ... VIA JOB`, dynamic
  `CALL METHOD (...)`. Operators may add rules of their own; they can
  never remove a shipped rule.

A separate capability scan runs after the static review passes, over the
same source text, looking for two more statement classes: a
database-write statement or `COMMIT WORK`/`ROLLBACK WORK` (gated by
`ABAP_ALLOW_FLUID_PLUGIN_MUTATE`), and `CALL FUNCTION` in any form, not
only the `DESTINATION` form the prohibition list above already blocks
outright (gated by `ABAP_ALLOW_FLUID_CALL_FM`). Unlike the prohibition
list, these two are not blocked outright — they are refused only when
their flag is off, and the refusal (`FLUID_PLUGIN_MUTATE_DISABLED` or
`SAFETY_DENIED` with rule `ABAP_ALLOW_FLUID_CALL_FM`) takes down the
*whole plugin* at load time, naming the object, file, and line, rather
than gating the one action whose declared `category` happens to match.
This is the same kind of statement-text scan as the rest of static
review, with the same limit: it is a lint, not a sandbox, and it runs
once, offline, before the plugin ever makes a call. See
[authoring.md](authoring.md) for the exact loader step.

Stated plainly, not hedged: a plugin runs with the technical user's full
authorisations. The static review is a lint, and it offers no
containment. The real controls are the SAP authorisation concept and
`ABAP_ALLOW_FLUID_PLUGINS`.

No ABAP parser dependency is added — no `@abaplint/core` — for two
reasons. First, `test/plugin-bundle.test.ts` forbids that string from
appearing in the server bundle. Second, and more importantly, claiming
containment here would be false: a lint over source text cannot bound
what a plugin does once it runs with the technical user's authorisations,
and the docs do not pretend otherwise.

## `core.eval` is a lint, not a sandbox

Stated plainly, the same way as the plugin static review above: the static
review and the capability scan reject a handful of named statements; they
do not confine the code. The real boundary is the SAP user's
authorisations, and `ABAP_ALLOW_FLUID_EVAL` is consent to run
model-authored code inside that boundary, nothing narrower.

What it does not do, stated honestly rather than left implicit:

- It does not stop a `SELECT` against any table the connected user may
  read — the capability scan only looks for a *write*, not a read.
- It does not stop an `UPDATE` (or `INSERT`/`MODIFY`/`DELETE`, or `COMMIT
  WORK`/`ROLLBACK WORK`) when `ABAP_ALLOW_FLUID_PLUGIN_MUTATE` is also on
  — that flag's whole purpose is to allow exactly that.
- It does not limit runtime or memory. A snippet that loops forever or
  allocates without bound runs exactly as any other ABAP would, under
  whatever server-side limits the SAP system itself imposes.

## Built-ins versus plugins

Built-ins keep their TypeScript-side domain gates — the enhancement
intent gate, the transport allowlist, the IMG table checks — as adapter
code wrapped around the generic fluid path. A plugin gets declarative
gating only: `category` plus `targets`, nothing more specific to the
individual action. Built-ins are trusted because they ship with
abapsmith; that is the whole difference, and it is stated here rather
than blurred.

## Plugin loading refusals

Plugins are validated once, at startup, never during a request, so a
plugin cannot appear mid-session and surprise a running agent. Any
validation failure refuses that plugin by name and path — never a silent
skip, because a silently absent tool is indistinguishable from a
typo'd path. One refused plugin does not block the others: a good plugin
in the same `ABAP_FLUID_PLUGINS` root still loads.

When `ABAP_ALLOW_FLUID_PLUGINS` is off, the built-ins still load, and
each configured-but-unused plugin path is reported as
`FLUID_PLUGINS_DISABLED` rather than silently ignored.

A plugin object name colliding with a name a different tool already
claimed — built-in or plugin, whichever loaded first — is a distinct
refusal from the namespace check: `FLUID_OBJECT_CONFLICT`, naming both
tool ids. This is a load-time check, unrelated to the same-named
`FLUID_OBJECT_CONFLICT` a deployed object already in a foreign package
can raise later (see "Object ownership and relocation" below) — the
code is shared, the two situations are not.

An unreadable configured plugin root (a path that does not exist, or
that the process cannot read) is reported under a configuration-error
code, distinct from the manifest-validation codes below, since nothing
about the operator's ABAP or manifest is at fault.

The full validation order — envelope schema, contract major, id shape and
uniqueness, name namespace, cross-tool name uniqueness, `entry` presence,
source-file path resolution, action schema parsing, static review, the
capability scan — is in [authoring.md](authoring.md).

## Object lifecycle, ownership and relocation

Every fluid ABAP object is classified into exactly one of eight states
before `run` decides whether to deploy, repair, relocate, or refuse.
`status` and `verify` report the same classification directly; `run`
and `repair` act on it.

| State | Meaning |
|---|---|
| `absent` | The object does not exist yet. Deployed fresh. |
| `present` | Exists, content and activation both match the manifest. Nothing to do. |
| `stale` | Exists, but its content no longer matches the manifest. Redeployed (content rewritten). |
| `inactive` | Content matches, but the object is not active-is-current. Activated in place. |
| `broken` | Content matches and the object is active, but activation checks still report errors on it. Repaired by delete-and-recreate. |
| `foreign` | Under a reserved abapsmith prefix, but in a package abapsmith does not own. Never touched — see below. |
| `legacy` | Under a reserved prefix, in one of the known pre-fluid packages (`$TMP` or `$ZMCP_HELPERS`). Relocated into `$ABAPSMITH_FLUID_API`. |
| `newer` | Deployed by a newer abapsmith release than the one running. Never touched — see below. |

`ZCL_ZMCP_` and `ZIF_ZMCP_` are reserved to abapsmith on any system it
touches.

An object under a reserved prefix found in `$TMP` or the legacy
`$ZMCP_HELPERS` package — a package nothing creates any more, only
relocates objects out of — is relocated: deleted there, recreated in
`$ABAPSMITH_FLUID_API`. ABAP
objects cannot change package, so this is the only way an existing
pre-fluid install can continue to work. Relocation requires **both**
conditions — the reserved prefix and one of the two known-legacy
packages — not either alone.

An object under a reserved prefix in any other package is `foreign`:
`FLUID_OBJECT_CONFLICT`. It is never deleted and never overwritten.

### `newer`: two abapsmith releases sharing one system

Every object abapsmith deploys carries a provenance marker naming the
abapsmith version that wrote it. When an object's installed marker
names a version strictly newer than the one currently running,
classification stops at `newer` before any content comparison — the
object is never rewritten, activated, or deleted. Refusal:
`FLUID_OBJECT_CONFLICT`, with details `{installed_version, our_version,
hint: "upgrade abapsmith or run abap_fluid op=remove"}`.

Without this check, two abapsmith releases pointed at the same SAP
system would treat each other's deploys as ordinary content drift and
rewrite each other's classes back and forth on alternate calls,
forever. An object whose marker names an **equal or older** version is
rewritten exactly as before — including a same-version dev build, which
still redeploys on a content-hash mismatch, since two dev builds of the
same version are not distinguishable by version alone. `status` and
`verify` report `newer` like any other state; only `run`/`repair`'s
deploy path refuses to act on it.

## Journalling

Framework deploys, relocations and `remove` are not journalled — this is
abapsmith's own generated scaffolding, not operator content.

Every `mutate` run through `abap_fluid` — built-in or plugin alike — is
journalled post-hoc: the mutation is already real by the time the journal
entry is written, so a journalling failure can never fail a mutation that
already happened, only warn about it. The entry is marked irreversible
with no before-image (`beforeCapture: "unknown"`): this framework never
reads the ABAP-side state a fluid action touches, so there is no undo to
offer. What it does record is what was done — the object ref is
`<tool>.<action>` and the description carries the canonical args JSON,
truncated past ~500 chars.

The legacy owning tools — `abap_enh`, `abap_img_edit`, `abap_ui`,
classic-call, customizing-request — route through the same dispatch
without a journal and write their own richer entries, with before-images
and undo support, so nothing is double-journalled.

## Error codes

| Code | Raised when |
|---|---|
| `FLUID_API_DISABLED` | `ABAP_FLUID_API` is off, or abapsmith is read-only in any of the five senses of [README.md](README.md). Carries a `reason` discriminator, `"flag"` or `"read-only"`, and the deciding `field`. On a v1 server this is the real tool's refusal; if the read-only sense is one of the two known at registration time (`ABAP_MODE=read`, legacy `readOnly`), `abap_fluid` is instead the mode-locked stub and refuses with `READ_ONLY`, not this code — see [README.md](README.md). |
| `FLUID_PLUGINS_DISABLED` | A plugin tool is invoked while `ABAP_ALLOW_FLUID_PLUGINS` is off. |
| `FLUID_PLUGIN_MUTATE_DISABLED` | A plugin `mutate` action is invoked while `ABAP_ALLOW_FLUID_PLUGIN_MUTATE` is off, or without the required `confirm` echo; also raised by a `core.eval` call whose capability scan finds a database write or `COMMIT WORK`/`ROLLBACK WORK` while `ABAP_ALLOW_FLUID_PLUGIN_MUTATE` is off. |
| `FLUID_EVAL_DISABLED` | Terminal. `core.eval` is called while `ABAP_ALLOW_FLUID_EVAL` is off; naming the flag. Set `ABAP_ALLOW_FLUID_EVAL` to unlock it — no `ABAP_MODE` does. |
| `FLUID_OBJECT_CONFLICT` | A reserved-prefix object is found in a package that is neither the fluid package nor a legacy package (`foreign`); a redeploy still does not match after one retry; a deployed object carries a provenance marker naming a newer abapsmith version than the one running (`newer`); or, at load time, two tools (built-in or plugin) claim the same ABAP object name. |
| `FLUID_MANIFEST_INVALID` | A manifest or plugin envelope fails validation — schema, contract major, id shape or uniqueness, namespace, `entry` presence, source-file resolution, or action schema. |
| `FLUID_ACTION_FAILED` | The ABAP side reports an `ERR` frame during a call. |
| `FLUID_PROTOCOL_ERROR` | An unparseable or malformed frame on the wire, or a generated ABAP line over 255 characters, caught offline before the first network call and naming the offending line. |

All eight are terminal and never auto-retried. `core.eval` can also refuse
with the general-purpose `BAD_INPUT` (bad `confirm`, or a `lines`/`out`
shape violation) and `SAFETY_DENIED` (a `CALL FUNCTION` in the snippet
while `ABAP_ALLOW_FLUID_CALL_FM` is off) — neither is fluid-specific, so
neither is in this table.

A missing `END` is not one of these codes: it is a dump or a cut-off
run, reported as such through the existing ABAP-dump translation, and
never as empty success. See [protocol.md](protocol.md) for the frame
rules.
