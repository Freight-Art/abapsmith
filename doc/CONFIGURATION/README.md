# Configuration

Every abapsmith setting comes from the environment, validated once at
startup. This folder documents each variable, its default, and what it
governs — from the ADT connection itself through the permission ladder,
resource allowlists, concurrency tuning, and the journal.

| Part | Covers |
|---|---|
| [connection.md](connection.md) | Loading `.env`, the required connection variables, and startup validation failure modes |
| [permissions-and-allowlists.md](permissions-and-allowlists.md) | `ABAP_MODE`, the capability override booleans, and the package/name/transport allowlists |
| [concurrency-and-activation.md](concurrency-and-activation.md) | Session pool sizing, lane concurrency, and batch-activation chunk limits |
| [journal-diagnostics-and-tooling.md](journal-diagnostics-and-tooling.md) | The change journal, debugger identity, response diagnostics, write verification, and the tool-surface switch |
