# Connection & startup validation

Every setting comes from the environment. `.env` in the working directory
loads automatically; a real environment variable always wins over it. Copy
`.env.example` to `.env`, fill in the connection settings, and configure
exactly one of the five credential methods described under
[Authentication](#authentication) below.

An invalid value fails startup with one combined error listing every
problem at once — the server never starts half-configured. Numeric fields
use `zod`'s `.positive()`/`.max()` checks; out-of-range values are rejected,
not clamped. One exception — `ABAP_LOCK_WAIT_MS`'s runtime copy — bypasses
that schema and fails differently; see its row.

## Connection

| Variable | Default | Effect |
|---|---|---|
| `ABAP_URL` | — (required) | ADT base URL. Must start with `http://` or `https://`, no query string. Trailing slashes stripped. |
| `ABAP_USER` | — (required) | Logon user, in every credential method — including client-certificate mode, where it is not itself sent for logon (see [Client certificate](#client-certificate-abap_client_cert-abap_client_key-abap_client_key_passphrase) below). |
| `ABAP_PASSWORD` | — (see [Authentication](#authentication)) | Basic-auth password. One of five mutually exclusive credential methods. Never logged, never serialised, never in an error message. |
| `ABAP_SESSION_COOKIE` | — (see [Authentication](#authentication)) | A pre-obtained session cookie string, `Cookie:`-header-shaped. One of five credential methods. |
| `ABAP_CLIENT_CERT` | — (see [Authentication](#authentication)) | Path to a PEM certificate, or to a PKCS#12 file (`.pfx`/`.p12`) — the extension decides which. One of five credential methods. |
| `ABAP_CLIENT_KEY` | unset | Path to the PEM private key, for `ABAP_CLIENT_CERT` in PEM mode. Omit for a PKCS#12 cert (setting it there is refused at startup) and omit if the PEM in `ABAP_CLIENT_CERT` already contains the private key. |
| `ABAP_CLIENT_KEY_PASSPHRASE` | unset | Optional passphrase for the private key or the PKCS#12 file. |
| `ABAP_TOKEN` | — (see [Authentication](#authentication)) | A static bearer token, sent as `Authorization: Bearer …` on every request. Never refreshed. One of five credential methods. |
| `ABAP_OAUTH_TOKEN_URL` | — (see [Authentication](#authentication)) | OAuth 2.0 token endpoint. Part of the OAuth credential method. |
| `ABAP_OAUTH_CLIENT_ID` | — (see [Authentication](#authentication)) | OAuth client id. |
| `ABAP_OAUTH_CLIENT_SECRET` | — (see [Authentication](#authentication)) | OAuth client secret. As sensitive as `ABAP_PASSWORD`. |
| `ABAP_OAUTH_SCOPE` | unset | Optional OAuth scope. Has no effect on its own — set with no other `ABAP_OAUTH_*`/`ABAP_SERVICE_KEY` variable, it only produces a startup warning. |
| `ABAP_SERVICE_KEY` | — (see [Authentication](#authentication)) | Path to an SAP BTP ABAP-environment service-key JSON file. Supplies the four `ABAP_OAUTH_*` variables above. Cannot be combined with explicit `ABAP_OAUTH_*` variables. |
| `ABAP_CA_CERT` | unset | Optional CA bundle (PEM) used to verify the **server's** certificate. Not a credential — usable with any of the five methods — and independent of `ABAP_INSECURE`: pinning a private CA is the opposite of turning verification off. |
| `ABAP_CLIENT` | `""` (unset) | Logon client, e.g. `001`. Documentation only unless `ABAP_SEND_CLIENT_PARAM=true`. |
| `ABAP_SEND_CLIENT_PARAM` | `false` | Actually append `?sap-client=` to requests. |
| `ABAP_SID` | `UNKNOWN` | System ID. Used to namespace the journal and the debugger identity seed. |
| `ABAP_LANGUAGE` | `""` | ADT logon language (`sap-language`), two-letter SAP code. Empty = the user's own default. |
| `ABAP_INSECURE` | `false` | Disables TLS certificate verification. |
| `ABAP_TIMEOUT_MS` | `60000` | Per-request HTTP timeout, ms. Default for every request family not covered by one of the four overrides below. |
| `ABAP_BOPF_TIMEOUT_MS` | `180000` | Per-request HTTP timeout, ms, for `abap_bopf_edit`'s `create_bo` and the BOPF-specific first phase of its `activate`. Overrides `ABAP_TIMEOUT_MS` for that request family — BOPF create and activate can take over a minute on a larger model. |
| `ABAP_ACTIVATE_TIMEOUT_MS` | `180000` | Per-request HTTP timeout, ms, for every activation request, including BOPF `activate` and mass/DDIC activation. Overrides `ABAP_TIMEOUT_MS` for that request family. |
| `ABAP_RUN_TIMEOUT_MS` | `180000` | Per-request HTTP timeout, ms, for `abap_run`'s classrun execution. Overrides `ABAP_TIMEOUT_MS` for that request family. |
| `ABAP_SEARCH_TIMEOUT_MS` | `60000` | Per-request HTTP timeout, ms, for `abap_search`'s repository quick search (`mode=objects`). Overrides `ABAP_TIMEOUT_MS` for that request family; a timeout is reported as `TIMEOUT` naming this variable (#206). |
| `ABAP_STARTUP_PROBE` | `true` | Whether `start()` runs one authenticated probe (same lazy `ensureConnected()` path every tool call uses — logon → discovery → T000 role probe → `ato/settings`) before printing `ready on stdio`. Success prints a `connected — authenticated to …` line naming the resolved SID/user/client. Failure prints the classified error code, message, and remediation hint, then still starts — `ready on stdio` prints anyway, marked `NOT CONNECTED`; a probe failure never blocks startup, since the next tool call retries via the same path. Set to `false`/`0`/`no`/`off` (case-insensitive) to skip the probe entirely — cost is reverting to the old behaviour: a bad `ABAP_URL`, down VPN, or wrong client then surfaces only on the first tool call, inside an agent's transcript, instead of loudly at startup. Same `boolishRejectDefaultTrue` idiom as `ABAP_CROSS_PROCESS_DEBUG_LOCK` in [journal-diagnostics-and-tooling.md](journal-diagnostics-and-tooling.md#debugger-identity). |

The session lock's own wait time is derived from these, not just
`ABAP_TIMEOUT_MS`: it is `ABAP_SESSION_WAIT_MS` plus the largest of
`ABAP_TIMEOUT_MS`, `ABAP_BOPF_TIMEOUT_MS`, `ABAP_ACTIVATE_TIMEOUT_MS`,
`ABAP_RUN_TIMEOUT_MS` and `ABAP_SEARCH_TIMEOUT_MS`, so a caller waiting on
the pool never times out before the slowest in-flight request could have
finished.

`ABAP_CLIENT` and `ABAP_SID` both have code defaults and will not fail
startup if left unset — but an unset `ABAP_SID` means every journal entry
and lockfile lands under a system id of literally `UNKNOWN`, which two
different real systems would then share. Set it.

`ABAP_USER` is required in every credential method. Which of the other
variables above are also required — and which are refused together —
depends on which of the five mutually exclusive authentication methods is
in play. See [Authentication](#authentication) below, and
[doc/LIMITATIONS/authentication.md](../LIMITATIONS/authentication.md) for
what each method's verification status actually is.

## Authentication

Exactly one of five mutually exclusive credential methods must be
configured: **password** (`ABAP_PASSWORD`), **cookie**
(`ABAP_SESSION_COOKIE`), **certificate** (`ABAP_CLIENT_CERT` and its two
companions), **token** (`ABAP_TOKEN`), or **oauth** (`ABAP_OAUTH_*` or
`ABAP_SERVICE_KEY`).

**Zero configured, or more than one, fails startup with a single combined
configuration error naming the variables involved.** The server never
silently picks one method over another — a credential the operator did not
intend to be in play must not be observable by any later feature gate. For
example: `no credential configured — set exactly one of ABAP_PASSWORD,
ABAP_SESSION_COOKIE, ABAP_CLIENT_CERT, ABAP_TOKEN, or the ABAP_OAUTH_*
group (ABAP_OAUTH_TOKEN_URL + ABAP_OAUTH_CLIENT_ID +
ABAP_OAUTH_CLIENT_SECRET, or ABAP_SERVICE_KEY)`, or, symmetrically, `more
than one credential is configured (... and ...) — refusing to start rather
than silently choosing one`.

### Password (`ABAP_PASSWORD`)

Basic auth. The existing default, and the only method exercised live — see
[Verification status](#verification-status).

```
ABAP_URL=https://sap.example.com:44300
ABAP_USER=DEVELOPER
ABAP_PASSWORD=correct-horse-battery-staple
```

Failure modes: a rejected password answers `401`/`403` and is reported as
`AUTH_FAILED`. It is **not retried** — repeated logon attempts count against
`login/fails_to_user_lock` (default 5) — and the hint names `ABAP_USER` /
`ABAP_PASSWORD`.

### Session cookie (`ABAP_SESSION_COOKIE`)

A pre-obtained session cookie string, captured elsewhere (for example out of
a browser after an interactive SSO login). abapsmith cannot obtain, refresh
or persist a cookie — only carry one; see
[doc/LIMITATIONS/authentication.md](../LIMITATIONS/authentication.md).

```
ABAP_URL=https://sap.example.com:44300
ABAP_USER=DEVELOPER
ABAP_SESSION_COOKIE=SAP_SESSIONID_A4H_100=abcdef0123456789
```

Failure modes: no `Authorization` header is sent at all in this mode (the
cookie is the credential). A rejected or expired cookie answers `401`/`403`
and is reported as `AUTH_FAILED`, not retried, with a hint to obtain a fresh
cookie and restart — there is no re-login path. If none of the configured
cookie's names look like a session credential (expected: something starting
`MYSAPSSO2`, `SAP_SESSIONID_`, or `JSESSIONID`), startup only warns; it does
not refuse, since an unfamiliar landscape's cookie shape is not something
this server can validate.

### Client certificate (`ABAP_CLIENT_CERT`, `ABAP_CLIENT_KEY`, `ABAP_CLIENT_KEY_PASSPHRASE`)

X.509 client-certificate (mutual TLS) authentication. `ABAP_CLIENT_CERT`
points at either a PEM certificate or a PKCS#12 file — the `.pfx`/`.p12`
extension decides which, by name, never by sniffing content.

PEM, separate key file:

```
ABAP_URL=https://sap.example.com:44300
ABAP_USER=DEVELOPER
ABAP_CLIENT_CERT=/etc/abapsmith/client.pem
ABAP_CLIENT_KEY=/etc/abapsmith/client.key
```

PKCS#12:

```
ABAP_URL=https://sap.example.com:44300
ABAP_USER=DEVELOPER
ABAP_CLIENT_CERT=/etc/abapsmith/client.pfx
ABAP_CLIENT_KEY_PASSPHRASE=correct-horse-battery-staple
```

All certificate/key/passphrase material is read off disk once, at startup —
not lazily on the first request — so a bad file is a startup error, not an
opaque TLS failure three tools later. Failure modes:

- **Unreadable file.** An unreadable `ABAP_CLIENT_CERT`, `ABAP_CLIENT_KEY`,
  or `ABAP_CA_CERT` fails startup naming the variable, the path, and the
  underlying OS error — for example `ABAP_CLIENT_CERT (/etc/abapsmith/client.pem)
  could not be read: ENOENT: no such file or directory, open '...'.`
- **No private key found.** `ABAP_CLIENT_CERT` is a PEM with no private key
  in it, and `ABAP_CLIENT_KEY` is unset — startup refuses and tells you to
  set `ABAP_CLIENT_KEY`, or point `ABAP_CLIENT_CERT` at a `.pfx`/`.p12`
  instead.
- **`ABAP_CLIENT_KEY` set with a PKCS#12 cert.** Refused at startup: a PFX
  already contains the private key, so pairing it with a separate key file
  is a configuration mistake, not something to resolve by preferring one
  over the other. The same applies to `ABAP_CLIENT_KEY` or
  `ABAP_CLIENT_KEY_PASSPHRASE` set with `ABAP_CLIENT_CERT` unset — startup
  refuses rather than guessing which file was meant.
- **Wrong `ABAP_CLIENT_KEY_PASSPHRASE`.** This is not caught at startup: the
  TLS layer fails to load the key on the first request, and the error
  surfaces from Node's TLS stack (for example `error:... bad decrypt` /
  `unsupported`) rather than as a SAP error. It is not `AUTH_FAILED` —
  nothing was ever sent to the ABAP system.
- **The server rejects the certificate.** The ABAP system answers
  `401`/`403`, usually with the ADT/ICF logon page as the body. Reported as
  `AUTH_FAILED` and — this is the important part — it is **not retried**,
  because repeated logon attempts count against `login/fails_to_user_lock`
  (default 5). The hint names `ABAP_CLIENT_CERT` and points at the
  certificate-to-user mapping (transaction `EXTID_DN` / table `USREXTID`)
  and at whether the ICF service accepts certificate logon at all.
- **Certificate expired.** Either the same `401`/`403` from the server, if
  it checks validity itself, or a TLS handshake failure if the local stack
  rejects it first.
- **`ABAP_USER` is still required, and is not sent for logon.** The effective
  SAP user is whatever the certificate maps to on the system; `ABAP_USER` is
  used only for journal attribution and the debugger identity.
  **abapsmith does not verify that the two agree** — no ADT call this server
  makes returns the connected user's `sy-uname`, and checking would cost an
  extra round trip on every connect. If the certificate maps to a different
  user, the journal will name `ABAP_USER` while the system attributes the
  actual change to the certificate's user. Set `ABAP_USER` to the user the
  certificate maps to.
- No `Authorization` header is sent at all in this mode either — the TLS
  handshake is the credential, the same way cookie mode drops it.
- Proxy support (`HTTPS_PROXY` / `https-proxy-agent`) keeps working with a
  client certificate: the tunnelling agent carries the client TLS options
  through to the post-`CONNECT` origin connection.

### Static bearer token (`ABAP_TOKEN`)

A static bearer token, sent as `Authorization: Bearer …` on every request.

```
ABAP_URL=https://sap.example.com:44300
ABAP_USER=DEVELOPER
ABAP_TOKEN=eyJhbGciOiJSUzI1NiJ9.example.token
```

Failure modes: `ABAP_TOKEN` is never refreshed. On expiry the ABAP system
answers `401` and the server reports **`AUTH_EXPIRED`**, whose message names
`ABAP_TOKEN` as the thing to renew. Renewing it requires a restart — there
is no live-refresh path for a static token.

### OAuth 2.0 client credentials (`ABAP_OAUTH_*` / `ABAP_SERVICE_KEY`)

`grant_type=client_credentials`, either configured directly or supplied by
an SAP BTP ABAP-environment service-key JSON.

Explicit variables:

```
ABAP_URL=https://sap.example.com:44300
ABAP_USER=DEVELOPER
ABAP_OAUTH_TOKEN_URL=https://sap.example.com:44300/oauth/token
ABAP_OAUTH_CLIENT_ID=abapsmith-client
ABAP_OAUTH_CLIENT_SECRET=correct-horse-battery-staple
```

Service key:

```
ABAP_URL=https://sap.example.com:44300
ABAP_USER=DEVELOPER
ABAP_SERVICE_KEY=/etc/abapsmith/service-key.json
```

`ABAP_OAUTH_SCOPE` is optional and applies to either form. It has no effect
set on its own — with no other OAuth variable configured, startup only
warns.

The access token is fetched once, cached in **process memory only** — never
written to disk — and refreshed ahead of the server-stated `expires_in`
(60 seconds of headroom). If the response omits `expires_in`, 3600 seconds
is assumed. Failure modes:

- **`ABAP_SERVICE_KEY` together with explicit `ABAP_OAUTH_*` variables** —
  refused at startup rather than silently choosing one.
- **An incomplete `ABAP_OAUTH_*` group** — startup refuses, naming exactly
  which of `ABAP_OAUTH_TOKEN_URL`, `ABAP_OAUTH_CLIENT_ID`,
  `ABAP_OAUTH_CLIENT_SECRET` is missing.
- **A malformed or incomplete `ABAP_SERVICE_KEY` file** — unreadable, not
  valid JSON, or missing the expected `uaa.clientid` / `uaa.clientsecret` /
  `uaa.url` fields — fails startup naming the path and, for a missing
  field, the field name only, never a value from the file.
- **A `401` from the ABAP system triggers exactly one refresh-and-retry.** A
  second `401` after that refresh is treated as a real rejection: it trips
  the existing auth latch, reported as `AUTH_EXPIRED`, so a revoked client
  stops rather than looping.
- **The token endpoint itself fails** — non-200 response, an unparseable
  body, or the endpoint is unreachable — and the server reports
  **`AUTH_TOKEN_REFRESH_FAILED`**, naming the endpoint (with any URL
  credentials stripped) and the HTTP status. The response **body is never
  included**, since it can echo the request back. After a failure the server
  will not call the token endpoint again for 30 seconds.
- **Bad or revoked client credentials therefore surface as
  `AUTH_TOKEN_REFRESH_FAILED`, not `AUTH_FAILED`** — the ABAP system never
  saw a request at all.

### CA bundle (`ABAP_CA_CERT`)

Not a credential, and not tied to any one method — usable alongside any of
the five, and independent of `ABAP_INSECURE`.

```
ABAP_URL=https://sap.example.com:44300
ABAP_USER=DEVELOPER
ABAP_PASSWORD=correct-horse-battery-staple
ABAP_CA_CERT=/etc/abapsmith/internal-ca.pem
```

Failure modes: an unreadable or non-PEM `ABAP_CA_CERT` fails startup the
same way an unreadable certificate/key file does (see
[Client certificate](#client-certificate-abap_client_cert-abap_client_key-abap_client_key_passphrase)
above). Setting it together with `ABAP_INSECURE=true` produces a startup
**warning**, not a refusal: verification is off entirely, so the bundle is
never consulted, and unsetting `ABAP_INSECURE` is what makes it take effect.

### Secret handling

No key material, passphrase, token, client secret, or service-key file
content is ever logged, written to disk, or included in an error message or
the startup config dump. Certificate and service-key **paths** are shown
deliberately — they are operator-supplied locations, not key material, and
they are what makes a misconfiguration diagnosable. The OAuth `client_id` is
redacted too, even though it is not itself a secret, so the rule "nothing
that came from a credential reaches the config dump" holds without
exceptions.

### Verification status

**Password mode is exercised live against the reference system.**
**Certificate, token and OAuth modes are implemented and unit-tested behind
fakes, but have never been run against a real system** — the reference
appliance (A4H, on-premise) has no certificate logon and no OAuth server
configured. Anyone connecting one of these three methods to a real system
for the first time should treat that connection as the real test. See
[doc/LIMITATIONS/authentication.md](../LIMITATIONS/authentication.md) for
the full breakdown, including cookie mode's own never-exercised-live status.

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
