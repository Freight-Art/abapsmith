# Fluid manifest format

A manifest names one fluid tool. On disk, for a plugin, it is
`fluid-plugin.json`. For a built-in it is the identical shape authored
directly in TypeScript (`FluidManifest`, `src/adt/fluid/manifest.ts`). One
tool, one manifest — a manifest never bundles more than one tool's objects
and actions.

## Example

A complete, valid manifest. `test/fluid-contract-doc.test.ts` extracts this
block and parses it with the real `FluidManifestSchema`, so it is not
elided anywhere.

```json
{
  "contract": "1.0",
  "id": "demo",
  "title": "Demo fluid tool",
  "description": "A minimal fluid tool used as the manifest-format example.",
  "objects": [
    { "name": "ZIF_ZMCP_X_DEMO", "type": "INTF/OI", "description": "fluid: demo types",
      "source": { "file": "abap/zif_zmcp_x_demo.abap" } },
    { "name": "ZCL_ZMCP_X_DEMO", "type": "CLAS/OC", "description": "fluid: demo actions",
      "source": { "file": "abap/zcl_zmcp_x_demo.abap" } }
  ],
  "entry": "ZCL_ZMCP_X_DEMO",
  "actions": [
    { "name": "read_status", "category": "read",
      "description": "Reads whether the named demo object exists.",
      "input": { "type": "object", "required": ["name"],
                 "properties": { "name": { "type": "string", "maxLength": 30 } } },
      "output": { "type": "object", "properties": { "exists": { "type": "boolean" } } } },
    { "name": "run_check", "category": "execute",
      "description": "Runs a read-only consistency check against the demo object.",
      "input": { "type": "object", "properties": { "verbose": { "type": "boolean" } } },
      "output": { "type": "object", "properties": {
        "passed": { "type": "boolean" },
        "messages": { "type": "array", "items": { "type": "string" } } } } },
    { "name": "create_demo", "category": "mutate",
      "description": "Creates a demo object in the named package.",
      "input": { "type": "object", "required": ["name", "package", "corr_nr"],
                 "properties": {
                   "name": { "type": "string", "maxLength": 30 },
                   "package": { "type": "string" },
                   "corr_nr": { "type": "string" } } },
      "output": { "type": "object", "properties": { "created": { "type": "boolean" } } },
      "targets": { "object": "/name", "package": "/package", "transport": "/corr_nr" } }
  ]
}
```

## Fields

| Field | Required | Notes |
|---|---|---|
| `contract` | yes | `"<major>.<minor>"`, currently `"1.0"`. Unknown major refuses the plugin; unknown minor loads with a warning. |
| `id` | yes | `/^[a-z][a-z0-9_]{0,11}$/`. Unique across built-ins and plugins together; a collision refuses the plugin. |
| `title` | yes | Non-empty. Shown by `list` and `describe`. |
| `description` | yes | Non-empty. Shown by `list` and `describe`. |
| `objects[]` | yes | `name`, `type`, `description` (60 characters or fewer), `source`. Array order is deploy order. |
| `objects[].source` | yes | `{"file": "<relative path>"}` for plugins, `{"text": "…"}` for built-ins. |
| `entry` | yes | The class whose `run( iv_action, iv_json )` the invoker calls. Must appear in `objects`. |
| `actions[]` | yes, at least one | `name` (`/^[a-z][a-z0-9_]{0,29}$/`), `category`, `description`, `input`, `output`, optional `targets`. |
| `category` | yes | `read`, `execute` or `mutate`. Classifies the action for gating: `read` and `execute` need no per-call consent beyond the plugin gate; `mutate` additionally needs `targets` and, for a plugin, `ABAP_ALLOW_FLUID_PLUGIN_MUTATE` plus a `confirm` echo of `<tool>.<action>`. See [safety.md](safety.md). |
| `input` / `output` | yes | A `FluidJsonSchema` object — the documented subset below. Input is validated before any network call; output after the transcript is parsed. |
| `targets` | only on `mutate` | JSON Pointers into the action's own arguments naming the object, package and transport the safety gate must judge, before any ABAP is generated. |

## Compatibility policy

`contract` is `"<major>.<minor>"`. The loader compares it against
`FLUID_CONTRACT_MAJOR`:

- an unknown **major** refuses the plugin outright — the shapes below are
  not assumed compatible across a major bump;
- an unknown **minor** loads the plugin, with a warning — a minor bump only
  ever adds optional fields, so an older loader can still make sense of it;
- adding an optional field to the manifest or the wire protocol is a minor
  change; anything else — a new required field, a changed frame shape, a
  changed error code — needs a major bump.

A built-in manifest is authored against the same `FLUID_CONTRACT` constant
it ships with, so this policy in practice only ever bites a plugin loaded
against a newer or older abapsmith than it was written for.

## Naming namespaces

`ZCL_ZMCP_` and `ZIF_ZMCP_` are reserved to abapsmith on any system it
touches — nothing else may be created there, and `verify` / `remove` may
act on anything found under them. Within that reservation, each layer gets
its own sub-namespace:

| Owner | Class / interface pattern |
|---|---|
| Framework | `ZCL_ZMCP_FLUID_RT` |
| Built-in | `ZCL_ZMCP_FLUID_<TOOLID>[_<SUFFIX>]` / `ZIF_ZMCP_FLUID_<TOOLID>` |
| Plugin | `ZCL_ZMCP_X_<PLUGINID>[_<SUFFIX>]` / `ZIF_ZMCP_X_<PLUGINID>` |
| Invoker | `ZCL_ZMCP_I_<hash8>` |

A plugin may declare object names only inside its own
`ZCL_ZMCP_X_<PLUGINID>` (and `ZIF_ZMCP_X_<PLUGINID>`) sub-namespace, so it
can never shadow a built-in body — `ZCL_ZMCP_FLUID_*` and any other
plugin's `ZCL_ZMCP_X_*` prefix are off limits to it. The loader checks
every object name in `objects[]` against this rule and refuses the whole
plugin, by path, on the first name that falls outside it.

## Object sources

`objects[].source` is one of two shapes:

- `{"file": "<relative path>"}` for a plugin. The path is resolved inside
  the plugin's own directory only. `..` is refused, a symlink that would
  escape the directory is refused, and this is checked by resolving and
  comparing real paths — a `..` segment that happens to land back inside
  the directory is still refused, not evaluated for where it ends up.
- `{"text": "…"}` for a built-in — the ABAP source is inline in the
  TypeScript that defines the manifest.

`objects[].type` is `CLAS/OC` or `INTF/OI`; nothing else is accepted today.
The deployer is a small dispatcher with one branch per type, so adding a
third type is a contract change, not a configuration change.

## Deploy order

`objects[]` array order **is** deploy order. `ZCL_ZMCP_FLUID_RT`, the
shared framework runtime, is always deployed first, ahead of any tool's own
objects. There is no dependency solver anywhere in the loader — a manifest
author who needs an interface deployed before the class that implements it
orders the array that way.

## The JSON-Schema subset

`input` and `output` use a fixed, small subset of JSON Schema, described by
`FluidJsonSchema`:

| Keyword | Meaning |
|---|---|
| `type` | one of `object`, `array`, `string`, `number`, `integer`, `boolean` |
| `properties` | for `type: "object"`, a map of property name to nested `FluidJsonSchema` |
| `required` | for `type: "object"`, property names that must be present |
| `items` | for `type: "array"`, the schema each element must satisfy |
| `enum` | the value must equal one of these |
| `maxLength` | for a string value |
| `minimum` / `maximum` | for a number or integer value |
| `description` | documentation only, never enforced |

This subset is validated by a small hand-written walker
(`validateFluidSchema`, `validateAgainstSchema`), not by a JSON-Schema
library — abapsmith has no such dependency today, and adding one would be
new supply-chain surface for a feature whose entire point is handling
operator-supplied code carefully. The envelope around it (the fields in
the tables above) is validated with `zod`, the library the codebase
already uses for `ConfigSchema`.

**Keywords outside this subset are ignored, never rejected.** An author
may write a richer schema — `format`, `pattern`, `additionalProperties`,
anything else JSON Schema defines — as documentation for a human reader,
but only the keywords in the table above are ever enforced against a call's
arguments or result. Do not rely on an ignored keyword to reject anything.

## Version

A manifest does not declare its own version. It is computed as
`contentHash(canonicalSource(contract + every object's type, name and
source, in array order))`, using the same source normalisation the write
path already applies when deciding whether an object's content really
changed. The result is truncated to its first 8 hex characters. Because
the version is derived rather than declared, it can never disagree with
what is actually in `objects[]` — there is nothing to forget to bump.

## See also

[README.md](README.md) for the concept glossary and configuration
variables, [protocol.md](protocol.md) for the wire protocol and the
body-class contract objects are written to satisfy, [authoring.md](authoring.md)
for how a plugin directory is laid out and loaded, and
[safety.md](safety.md) for the full gating order and static review.
