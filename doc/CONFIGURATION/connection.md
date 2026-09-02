# Connection & startup validation

Every setting comes from the environment. `.env` in the working directory
loads automatically; a real environment variable always wins over it. Copy
`.env.example` to `.env` and fill in the required five.

An invalid value fails startup with one combined error listing every
problem at once — the server never starts half-configured. Numeric fields
use `zod`'s `.positive()`/`.max()` checks; out-of-range values are rejected,
not clamped. One exception — `ABAP_LOCK_WAIT_MS`'s runtime copy — bypasses
that schema and fails differently; see its row.

## Connection

| Variable | Default | Effect |
|---|---|---|
| `ABAP_URL` | — (required) | ADT base URL. Must start with `http://` or `https://`, no query string. Trailing slashes stripped. |
| `ABAP_USER` | — (required) | Logon user. |
| `ABAP_PASSWORD` | — (required) | Logon password. Never logged, never serialised, never in an error message. |
| `ABAP_CLIENT` | `""` (unset) | Logon client, e.g. `001`. Documentation only unless `ABAP_SEND_CLIENT_PARAM=true`. |
| `ABAP_SEND_CLIENT_PARAM` | `false` | Actually append `?sap-client=` to requests. |
| `ABAP_SID` | `UNKNOWN` | System ID. Used to namespace the journal and the debugger identity seed. |
| `ABAP_LANGUAGE` | `""` | ADT logon language (`sap-language`), two-letter SAP code. Empty = the user's own default. |
| `ABAP_INSECURE` | `false` | Disables TLS certificate verification. |
| `ABAP_TIMEOUT_MS` | `60000` | Per-request HTTP timeout, ms. |
| `ABAP_STARTUP_PROBE` | `true` | Whether `start()` runs one authenticated probe (same lazy `ensureConnected()` path every tool call uses — logon → discovery → T000 role probe → `ato/settings`) before printing `ready on stdio`. Success prints a `connected — authenticated to …` line naming the resolved SID/user/client. Failure prints the classified error code, message, and remediation hint, then still starts — `ready on stdio` prints anyway, marked `NOT CONNECTED`; a probe failure never blocks startup, since the next tool call retries via the same path. Set to `false`/`0`/`no`/`off` (case-insensitive) to skip the probe entirely — cost is reverting to the old behaviour: a bad `ABAP_URL`, down VPN, or wrong client then surfaces only on the first tool call, inside an agent's transcript, instead of loudly at startup. Same `boolishRejectDefaultTrue` idiom as `ABAP_CROSS_PROCESS_DEBUG_LOCK` in [journal-diagnostics-and-tooling.md](journal-diagnostics-and-tooling.md#debugger-identity). |

`ABAP_CLIENT` and `ABAP_SID` both have code defaults and will not fail
startup if left unset — but an unset `ABAP_SID` means every journal entry
and lockfile lands under a system id of literally `UNKNOWN`, which two
different real systems would then share. Set it.

`ABAP_USER`/`ABAP_PASSWORD` are HTTP basic auth — the only authentication
mechanism this server supports. See
[doc/LIMITATIONS/authentication.md](../LIMITATIONS/authentication.md).

## Notes on specific failure modes

**`ABAP_INSECURE=true` disables TLS certificate verification.** Credentials
are then exposed to anyone who can intercept the connection — this is not a
convenience flag for self-signed certificates, it removes the check
entirely. Point `NODE_EXTRA_CA_CERTS` at your corporate CA bundle instead.
The server warns on stderr every time it starts with this set.

**Embedding credentials in `ABAP_URL`** (`https://user:pass@host`) works —
the userinfo is handed straight to the HTTP client — but it puts a live
password into an environment variable, which `ps` and `/proc` and anything
that echoes the URL can see. The server redacts it from its own logs and
warns at startup when it detects one. Use `ABAP_USER`/`ABAP_PASSWORD`.

**A value that fails validation fails the whole startup**, not just that one
field. `loadConfig()` collects every schema violation into a single error
before throwing, so a typo in one variable surfaces as a startup error naming
exactly what was wrong, not a mysterious failure three tools later. The one
exception is `ABAP_LOCK_WAIT_MS`'s runtime copy (see
[journal-diagnostics-and-tooling.md](journal-diagnostics-and-tooling.md#journal)):
read outside the config schema, an invalid value silently falls back to the
default instead of failing startup. `ABAP_OBJECT_LOCK_WAIT_MS` (see
[concurrency-and-activation.md](concurrency-and-activation.md#session-pool--concurrency))
and `ABAP_DEBUG_LOCK_WAIT_MS` (see
[journal-diagnostics-and-tooling.md](journal-diagnostics-and-tooling.md#debugger-identity))
are read through the schema yet keep that same soft-fallback-on-invalid
behaviour rather than adopting the fail-startup rule above — moving a field
into the schema does not by itself change what counts as "invalid" for it.
