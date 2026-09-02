# Resource: `abap://{SID}/system`

The one MCP resource this server exposes. `{SID}` is the configured system
ID, e.g. `abap://A4H/system`. Reading it triggers a connection (if not
already connected) and returns a JSON document:

```json
{
  "connection": { "...": "connection info from the session's info() call" },
  "discovery": { "...": "summary of the ADT /discovery feature inventory" },
  "sessions": {
    "total": 1, "busy": 0, "idle": 1, "waiting": 0, "dead": 0,
    "limits": { "maxSessions": 5, "readConcurrency": 2, "writeConcurrency": 2 }
  },
  "safety": {
    "...": "the rest of the safety config",
    "systemRole": "nonproductive",
    "writesEnabled": true,
    "allowPackages": ["$TMP"],
    "allowNamePrefixes": ["ZDEMO_"],
    "allowTransports": ["auto"]
  },
  "journal": {
    "enabled": true,
    "dir": "/path/to/journal/dir",
    "retention": "500 entries / 90 days"
  }
}
```

`connection` and `discovery` reflect live session state. `sessions` is a
snapshot of this process's own pool occupancy: `total` is the slots the pool
currently holds (live or awaiting retirement), `busy` is slots with a lease
out right now — the DIA-relevant number — `idle` is live slots free this
instant, `waiting` is callers parked in the FIFO queue, and `dead` is slots
known dead but not yet dropped (`dead` overlaps `busy`, since a dead slot can
still have an outstanding lease). `limits` echoes the configured ceiling
(`ABAP_MAX_SESSIONS` / `ABAP_READ_CONCURRENCY` / `ABAP_WRITE_CONCURRENCY`),
included here because those are otherwise only printed to stderr once at
startup and have no other way to be queried from a running process. See
[doc/CONCURRENCY § Several agents, one sandbox](../CONCURRENCY/several-agents-one-sandbox.md)
for why `busy`, not `total`, is the number to read when checking this
process's footprint on a shared appliance. `safety` mirrors
the resolved `SafetyConfig` plus derived fields: `writesEnabled` is
`!readOnly`, and `allowPackages` / `allowNamePrefixes` / `allowTransports`
are the resolved allowlists the gate will actually enforce, not the raw
environment strings. `systemRole` is the tri-state probe verdict
(`productive` | `nonproductive` | `inconclusive`) — anything but
`nonproductive` means writes are locked out with no override, so this is the
field to read when a write was refused and you want to know why. `journal.dir`
is `null` when the journal is disabled.
