# Safety

The safety gate (`src/safety.ts`) is what allows this server to be pointed at
a real ABAP system. These parts state what it guarantees, and what it does
not: the checks it runs before any request goes out, the permission model
built on top of them, and the boundaries around data exposure, credentials
and this gate's own non-guarantees.

| Part | Description |
|---|---|
| [safety-gate.md](safety-gate.md) | The pre-connection check order and productive-system detection |
| [permission-model.md](permission-model.md) | `ABAP_MODE`, per-capability overrides, and how authorization is enforced in the type system |
| [data-access-and-credentials.md](data-access-and-credentials.md) | The data-preview deny-list, credential handling, and what this gate is not |
