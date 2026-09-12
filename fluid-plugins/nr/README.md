# nr — Number ranges (SNRO)

A fluid plugin that reads and maintains SAP number range objects (SNRO):
list and describe objects, create an object, create/change an interval,
draw next numbers, and delete an object. Entry class: `ZCL_ZMCP_X_NR`.

## Actions

| Action | Category | What it does |
|---|---|---|
| `list` | read | Lists number range objects matching a name pattern. |
| `describe` | read | Reads one object's definition and its intervals. |
| `create` | mutate | Creates a number range object and registers it in TADIR. |
| `set_interval` | mutate | Creates or changes one interval on an object. |
| `get_next` | execute | Draws the next number(s) from an interval. |
| `delete` | mutate | Deletes an object (and, optionally, its intervals). |

## Enabling

Plugins load only when the MCP server starts. Set these in the server's
environment and restart it:

```
ABAP_FLUID_PLUGINS=/workspace/fluid-plugin-bench/plugins
ABAP_ALLOW_FLUID_PLUGINS=true
ABAP_ALLOW_FLUID_CALL_FM=true
ABAP_ALLOW_FLUID_PLUGIN_MUTATE=true
```

`ABAP_ALLOW_FLUID_CALL_FM` is required because the class calls function
modules (`NUMBER_RANGE_OBJECT_UPDATE/_CLOSE/_DELETE`,
`NUMBER_RANGE_INTERVAL_LIST/_UPDATE`, `NUMBER_GET_NEXT`, ...) — it contains
no direct database writes and no `COMMIT`/`ROLLBACK` of its own.
`ABAP_ALLOW_FLUID_PLUGIN_MUTATE` is required to call `create`,
`set_interval` or `delete`; each such call also needs a `confirm` echo of
`"nr.<action>"` (e.g. `"nr.create"`). The first call against this tool
deploys `ZCL_ZMCP_X_NR` into `$ABAPSMITH_FLUID_API`. The framework commits
on success and rolls back on error — the plugin never commits itself.

## Examples

```
abap_fluid(tool="nr", action="list", args={"pattern": "Z*"})

abap_fluid(tool="nr", action="describe", args={"object": "ZNR_DEMO"})

abap_fluid(tool="nr", action="create",
  args={"object": "ZNR_DEMO", "text": "Demo number range",
        "domain": "NUMC10", "package": "$TMP", "corr_nr": ""},
  confirm="nr.create")

abap_fluid(tool="nr", action="set_interval",
  args={"object": "ZNR_DEMO", "nrrangenr": "01",
        "fromnumber": "0000000001", "tonumber": "0000099999"},
  confirm="nr.set_interval")

abap_fluid(tool="nr", action="get_next",
  args={"object": "ZNR_DEMO", "nrrangenr": "01"})

abap_fluid(tool="nr", action="delete",
  args={"object": "ZNR_DEMO", "package": "$TMP", "corr_nr": "",
        "with_intervals": true, "force": true},
  confirm="nr.delete")
```

## Notes

- **Gating.** `create` and `delete` declare `targets` on object, package
  *and* transport, so the safety gate judges all three. `set_interval`
  declares only the object — an interval is client-dependent customizing
  in NRIV with no package of its own — so under a non-`*`
  `ABAP_ALLOW_PACKAGES` it fails closed rather than guessing a package.
  `get_next` is `execute` with no `targets`; it consumes numbers but
  changes no repository object.
- **TADIR bookkeeping.** Objects created through this plugin are
  registered as `R3TR NROB` in TADIR. For a transportable package the
  object is added to `corr_nr`; interval values themselves are never
  transported (they are client-specific).
- **Errors** come back as `FLUID_ACTION_FAILED` with `kind`, `step`,
  `subrc`, `msgid`, `msgno`, `text` describing where the call failed.
- **Verify:** `abap_fluid(op="list")` shows `nr` (or, if refused, the
  reason); `abap_fluid(op="describe", tool="nr")` shows the schemas above;
  `abap_fluid(op="verify", tool="nr")` shows what is actually deployed on
  the system.
