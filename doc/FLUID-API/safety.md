# Fluid API safety

## The eight-step ordering

Checked in this order for every `run`; the first failure refuses and
nothing is written. Steps 1-7 never widen anything the existing safety
gate would otherwise refuse — the gate is still the last word.

1. **`ABAP_FLUID_API`** must be on, checked before any socket opens.
   Refusal: `FLUID_API_DISABLED`.
2. **Read-only, in any of the five senses of [README.md](README.md)**,
   for every op — not only `run`. Refusal: `FLUID_API_DISABLED`, naming
   the deciding field.
3. **Plugin?** `ABAP_ALLOW_FLUID_PLUGINS` must be on. Refusal:
   `FLUID_PLUGINS_DISABLED`.
4. **Plugin action with `category: "mutate"`?** `ABAP_ALLOW_FLUID_PLUGIN_MUTATE`
   must be on, and the call must carry a `confirm` argument that echoes
   exactly `<tool>.<action>`. Refusal: `FLUID_PLUGIN_MUTATE_DISABLED`.
5. **`core.call_fm`?** `ABAP_ALLOW_FLUID_CALL_FM` must be on, and the call
   must carry the same `confirm` echo when `commit: true`.
6. **The action's `input` schema**, validated offline, before any network
   call.
7. **`targets`** — the manifest's JSON Pointers are resolved against the
   arguments, and the resulting object, package and transport are judged
   by the safety gate, before any ABAP is generated. Without this step the
   gate would only ever see the invoker class's own harmless URI, never
   the object the action actually acts on.
8. **The ordinary ceilings**, unchanged and above all of it: productive or
   inconclusive system, the write-lockout latch, `ABAP_MODE`, a read-only
   session. Deploying is a write plus an activate; running is an execute.
   These ceilings apply regardless of anything above, and the existing
   gate is still the last word.

## Static review is a lint, not a sandbox

Offline, before the first network call. Two parts:

- **The 255-character ABAP line guard.**
- **An additive prohibition list**: `CALL 'SYSTEM'`, `EXEC SQL`,
  `INSERT REPORT`, `GENERATE SUBROUTINE POOL`,
  `CALL FUNCTION ... DESTINATION`, `SUBMIT ... VIA JOB`, dynamic
  `CALL METHOD (...)`. Operators may add rules of their own; they can
  never remove a shipped rule.

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

The full validation order — envelope schema, contract major, id shape and
uniqueness, name namespace, `entry` presence, source-file path resolution,
action schema parsing, static review — is in
[authoring.md](authoring.md).

## Object ownership and relocation

`ZCL_ZMCP_` and `ZIF_ZMCP_` are reserved to abapsmith on any system it
touches.

An object under a reserved prefix found in `$TMP` or `$ZMCP_HELPERS` is
relocated: deleted there, recreated in `$ABAPSMITH_FLUID_API`. ABAP
objects cannot change package, so this is the only way an existing
pre-fluid install can continue to work. Relocation requires **both**
conditions — the reserved prefix and one of the two known-legacy
packages — not either alone.

An object under a reserved prefix in any other package is `foreign`:
`FLUID_OBJECT_CONFLICT`. It is never deleted and never overwritten.

## Journalling

Framework deploys, relocations and `remove` are not journalled — this is
abapsmith's own generated scaffolding, not operator content.

Plugin `mutate` runs are journalled, marked irreversible unless the
manifest names an undo action, and journalled post-hoc: the mutation is
already real by the time the journal entry is written, so a journalling
failure can never fail a mutation that already happened.

## Error codes

| Code | Raised when |
|---|---|
| `FLUID_API_DISABLED` | `ABAP_FLUID_API` is off, or abapsmith is read-only in any of the five senses of [README.md](README.md). Carries a `reason` discriminator, `"flag"` or `"read-only"`, and the deciding `field`. |
| `FLUID_PLUGINS_DISABLED` | A plugin tool is invoked while `ABAP_ALLOW_FLUID_PLUGINS` is off. |
| `FLUID_PLUGIN_MUTATE_DISABLED` | A plugin `mutate` action is invoked while `ABAP_ALLOW_FLUID_PLUGIN_MUTATE` is off, or without the required `confirm` echo. |
| `FLUID_OBJECT_CONFLICT` | A reserved-prefix object is found in a package that is neither the fluid package nor a legacy package (`foreign`), or a redeploy still does not match after one retry. |
| `FLUID_MANIFEST_INVALID` | A manifest or plugin envelope fails validation — schema, contract major, id shape or uniqueness, namespace, `entry` presence, source-file resolution, or action schema. |
| `FLUID_ACTION_FAILED` | The ABAP side reports an `ERR` frame during a call. |
| `FLUID_PROTOCOL_ERROR` | An unparseable or malformed frame on the wire, or a generated ABAP line over 255 characters, caught offline before the first network call and naming the offending line. |

All seven are terminal and never auto-retried.

A missing `END` is not one of these codes: it is a dump or a cut-off
run, reported as such through the existing ABAP-dump translation, and
never as empty success. See [protocol.md](protocol.md) for the frame
rules.
