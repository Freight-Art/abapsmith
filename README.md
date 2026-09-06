# abapsmith

An MCP server that lets an LLM develop in SAP ABAP on a live system over ADT (`/sap/bc/adt/*`).

## Capabilities

| Area | What the server does |
|---|---|
| Read | Source, outline, single method, line windows, raw properties, version history, diff. DDIC rendered as pseudo-DDL. Every response carries an etag. |
| Search | Object-name patterns and where-used. |
| Classes & interfaces | Create, read, update, delete, activate. |
| Programs & function groups | Programs, function groups, function modules: create, read, update, delete, activate. Includes and transformations: read. |
| DDIC | Domains, data elements, structures, table types, tables: create, read, update, delete, activate. Message classes: create, read, update, delete. Lock objects: read, update, activate. |
| CDS | DDL sources and metadata extensions: create, read, update, delete, activate. |
| RAP & services | Behavior definitions, behavior pool classes, service definitions, service bindings: create, read, update, activate. OData contract read (V2 and V4), metadata only. |
| BOPF | Business objects, nodes, associations, actions, determinations, validations, queries: create, read, delete. Dangling-reference check. End-to-end run through a generated bridge. |
| Enhancements | Enhancement spots, BAdI definitions and implementations, filters, source-code plug-ins. |
| Debugger | Arm breakpoints, trigger a run, step, read the call stack, inspect any variable in scope down to one field or table row. |
| ABAP Unit | Run existing tests. Four distinct outcomes — "nothing ran" is never reported as a pass. |
| ATC | Run ABAP Test Cockpit static analysis, return the findings. No IDE needed. |
| Quick fixes | List and apply ADT position-driven quick fixes as a gated, journalled write. Deterministic proposals only. |
| Transports | List, show, check, users, create, add user, set owner, delete. Release is separately gated and dry-run unless confirmed. |
| Run | Classes via `IF_OO_ADT_CLASSRUN`, and classic reports through a generated bridge, with list output and selection-screen parameters captured. |
| Activate | Check-only or activate, single object or batched. |
| Dumps | Read ST22 runtime errors. Variable contents are opt-in. |
| Data preview | Rows from one DDIC table or view. Opt-in, denylisted, refused on a productive system. |
| Classic dynpro | Read a screen's fields, flow logic and GUI status; drive a transaction by batch input (opt-in, admin only). |
| Undo | Local write journal: list, show, and undo a mutation, restoring the exact prior source. Drift is detected and refused. |

Per-object-type detail, and the evidence behind every claim above:
**[doc/CAPABILITIES/README.md](doc/CAPABILITIES/README.md)**.

Every response is capped and truncation is line-wise, marked, and names the call that fetches
the rest.

## Requirements

- Node >= 20
- An ABAP system with ADT enabled (`/sap/bc/adt/*` reachable over HTTP)
- A user with `S_DEVELOP`. A dedicated technical user is recommended.

## Install

### Claude Code

This repository is a plugin marketplace, so there is nothing to clone and nothing to build:

```
/plugin marketplace add Freight-Art/abapsmith
/plugin install abapsmith@abapsmith
```

That installs the MCP server together with the task-shaped skills in `skills/`, which carry the
wire lore an agent needs before it calls a tool. The server runs from `bundle/` — a committed,
dependency-free build, because plugin installation performs no build step.

To stay on a particular release, or to step back to one after an update, add the marketplace at
its tag instead of at `main`; every release is a `vX.Y.Z` tag with a CHANGELOG section of the same
name:

```
/plugin marketplace add Freight-Art/abapsmith#v0.3.1
/plugin install abapsmith@abapsmith
```

`/plugin update` follows whatever the marketplace points at, so a marketplace added at a tag stays
on that tag until you add it again at another one.

The plugin deliberately declares no `env` block, so configure the connection the way the next
section describes: a `.env` in the directory you start Claude Code from, or exported shell
variables. Both reach the server. [Wire it into an MCP
client](#wire-it-into-an-mcp-client) is then only for other clients.

### Any other MCP client

Not published to a registry — build from a clone.

```bash
git clone https://github.com/Freight-Art/abapsmith.git
cd abapsmith
npm install
npm run build
```

`npm run build` emits `dist/index.js`, which is the server entry point.

## Configure

Five variables connect to a system. Put them in a `.env` in the directory the server runs from
— it is loaded automatically — or in your MCP client's `env` block. Copy `.env.example` for the
annotated version.

```bash
ABAP_URL=https://abap.example.com:44300
ABAP_USER=DEVELOPER
ABAP_PASSWORD=your-password
ABAP_CLIENT=001
ABAP_SID=A4H
ABAP_MODE=read          # read (default) | edit | admin
```

`ABAP_MODE` is the single permission knob. `read` is an absolute ceiling that no other variable
lifts. `edit` allows write, activate and run. `admin` adds transport release, transport and
cascade delete, and SAP-original enhancement targets. Three capabilities sit outside the ladder
and stay off in every mode, `admin` included, until named explicitly:
`ABAP_ALLOW_DATA_PREVIEW`, `ABAP_ALLOW_DUMP_VARIABLES`, `ABAP_ALLOW_UI_PRESS`.

Every other variable — allowlists, pool sizing, journal retention, timeouts, debugger identity —
is in **[doc/CONFIGURATION/README.md](doc/CONFIGURATION/README.md)**.

## Wire it into an MCP client

For clients other than Claude Code, which the plugin install above already wires up:

```jsonc
{
  "mcpServers": {
    "abap": {
      "command": "node",
      "args": ["/absolute/path/to/abapsmith/dist/index.js"],
      "env": {
        "ABAP_URL": "https://abap.example.com:44300",
        "ABAP_USER": "DEVELOPER",
        "ABAP_CLIENT": "001",
        "ABAP_SID": "A4H",
        "ABAP_MODE": "read"
      }
    }
  }
}
```

`ABAP_PASSWORD` is deliberately absent from that block: keep it in the `.env` the client's
working directory supplies, so the secret never lands in a JSON file that is easy to commit or
sync alongside the rest of an editor config. Start on `ABAP_MODE=read` and opt into `edit` once
you intend to write.

## Documentation

| | |
|---|---|
| [doc/CAPABILITIES/README.md](doc/CAPABILITIES/README.md) | Every object type, framework and capability, with the evidence behind each claim |
| [doc/TOOLS/README.md](doc/TOOLS/README.md) | Full per-tool parameter reference |
| [doc/CONFIGURATION/README.md](doc/CONFIGURATION/README.md) | Every environment variable, its default, and its failure mode |
| [doc/SAFETY/README.md](doc/SAFETY/README.md) | The gate, the modes, and the boundaries that are not security controls |
| [doc/JOURNAL/README.md](doc/JOURNAL/README.md) | Journal format, undo semantics, drift detection, retention |
| [doc/CONCURRENCY/README.md](doc/CONCURRENCY/README.md) | Session pool, lanes, object gate |
| [doc/LIMITATIONS/README.md](doc/LIMITATIONS/README.md) | What is unproven, unimplemented, or structurally impossible here |
| [doc/DESIGN-NOTES/README.md](doc/DESIGN-NOTES/README.md) | Decisions that are load-bearing and not obvious from the code |
| [doc/TESTING/README.md](doc/TESTING/README.md) | Suite layout, fixtures, and how the live tests are gated |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Build, test, and the bar for a change |
| [SECURITY.md](SECURITY.md) | Reporting a vulnerability |
| [CHANGELOG.md](CHANGELOG.md) | What changed, release by release |

## License

MIT — see [LICENSE](LICENSE). Third-party attribution: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Thanks

Big thanks to two projects whose ideas shaped this one:

- [Vibing Steampunk](https://github.com/oisee/vibing-steampunk) — also the source of the ADT
  debugger protocol knowledge behind `src/debug/`, credited in
  [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
- [mcp-abap-adt](https://github.com/fr0ster/mcp-abap-adt)
