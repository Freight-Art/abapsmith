# Security Policy

abapsmith connects an agent to a live SAP ABAP system with real credentials
and, when configured to, performs real writes against that system. Treat
anything that weakens the safety gate, leaks credentials, or widens what the
server will attempt as a security issue, not an ordinary bug.

## Supported versions

| Version | Supported |
|---|---|
| 0.3.x | yes |
| < 0.3 | no |

This project is pre-1.0 and moves quickly. Security fixes land on the latest
0.3.x release; there is no long-term-support branch at this stage.

## Reporting a vulnerability

**Do not open a public GitHub issue for a security problem.**

Report it privately through GitHub's private security advisory feature on
this repository: open the "Security" tab on
[Freight-Art/abapsmith](https://github.com/Freight-Art/abapsmith) and use
"Report a vulnerability" to start a private advisory. That gives maintainers
a private channel to discuss, reproduce, and fix the issue before any public
disclosure.

We aim to acknowledge a new report within a few days and to keep you updated
as it's investigated. That's a goal, not a contractual SLA — this is a small
project maintained without a dedicated security team.

When reporting, include:

- What you found and why it matters (e.g. "this bypasses check N of the
  safety gate" or "this logs the password").
- Steps to reproduce, or a minimal patch/test that demonstrates it.
- Whether it requires a specific `ABAP_MODE`, flag, or configuration to
  trigger.

## Security model

This section summarizes the project's actual safety posture. For the full,
authoritative version, read [doc/SAFETY/README.md](doc/SAFETY/README.md) and
[doc/CONFIGURATION/README.md](doc/CONFIGURATION/README.md) — if anything here and those
documents disagree, the docs are correct.

### Writes are opt-in and gated before the network is touched

The server is **read-only by default**. Nothing mutates until `ABAP_MODE` is
explicitly set to `edit` or `admin`. The gate (`src/safety.ts`) evaluates
every mutating call **before any HTTP request is made, including the
logon** — a refused write costs zero network requests. In order, it checks:
whether the target system reports itself productive (read-only, no
override), whether the system's role could not be proven non-productive
(treated identically to productive — fail-closed on an inconclusive probe),
the write opt-in itself, SAP namespaces/packages (always denied), the
package allowlist (default: any package), the object-name allowlist
(default: any name), and the transport allowlist.

### The mode ladder and the default write scope

`ABAP_MODE` is the single permission knob: `read` (default, no mutation
possible, structurally — no configuration overrides this), `edit` (write /
activate / run, against customer-owned enhancement targets), and `admin`
(adds transport release and SAP-original enhancement targets).

Write scope is a separate knob, `ABAP_ALLOW_PACKAGES`. Unset, it defaults to
every customer package on the system — SAP-owned namespaces and packages
are refused by an earlier, unconditional gate check regardless. Set, it
replaces that default with a whitelist. Set to the empty string
(`ABAP_ALLOW_PACKAGES=`), it refuses every write. In practice this means an
unconfigured `edit`/`admin` installation can write, delete, and activate in
every customer package — and since `ABAP_ALLOW_TRANSPORTS` independently
defaults to `auto`, those writes can land on a transport. Set
`ABAP_ALLOW_PACKAGES=$TMP` to confine writes to local objects only.

Three capabilities sit outside the mode ladder entirely and stay off in
every mode, including `admin`, until named explicitly — because each one
puts business or personal data into the calling model's transcript rather
than just mutating an object:

- `ABAP_ALLOW_DATA_PREVIEW` — registers `abap_data_preview` (table row
  reads) at all.
- `ABAP_ALLOW_DUMP_VARIABLES` — lets `abap_dumps` return variable
  *contents* from an ST22 dump, not just the dump metadata.
- `ABAP_ALLOW_UI_PRESS` — lets `abap_ui` submit a batch-input script that
  commits immediately (also requires `ABAP_MODE=admin`).

### The write journal is undo, not an audit log

Every mutation is recorded to a local write journal before it happens, so
`abap_journal mode=undo` can put the previous source back. This is a
convenience for recovering from an agent's mistake, not a security control:
the journal is not tamper-evident, it doesn't see changes made by anyone
else on the target system, and it lives on the machine running the server.

### What this is not

Directly from `doc/SAFETY/data-access-and-credentials.md`, because these boundaries matter and are easy
to overstate:

- **Not a substitute for SAP authorisations.** The gate constrains what the
  server will *attempt*. What it can actually do is bounded by the
  technical user's own SAP profile. Give that user the least privilege that
  works, on a system you would not mind an agent making mistakes on.
- **Not an audit log**, as above.
- **Not a sandbox.** `abap_run`, `abap_test`, and `abap_bopf_test` execute
  real ABAP on the target system with the technical user's rights.
  `abap_bopf_test` writes real rows.
- **Not protection against a productive system you misconfigured into
  reporting itself non-productive.** Detection reads what the system says
  about itself.
- The `abap_data_preview` deny-list (roughly seventy table/pattern rules) is
  a supplement, not the boundary — it fails open by design (anything not
  named is readable), and the real control is the technical user's
  `S_TABU_DIS`/`S_TABU_NAM` authorisations.

### Credentials and lockout

- Authentication is HTTP basic only — no SSO, SAML, OAuth/bearer, X.509
  client certificates, or Kerberos/SPNEGO. See
  [doc/LIMITATIONS/authentication.md](doc/LIMITATIONS/authentication.md).
- The password is never logged, never echoed in an error, and never
  included in a tool response.
- A `401` trips a process-wide circuit breaker on the first failure and is
  **never retried** — a retry loop against a stale password is how a
  shared SAP account gets locked (`login/fails_to_user_lock` commonly
  defaults to 5). Clearing it requires restarting the server with corrected
  credentials.
- There are no lock/unlock tools exposed to the agent.
- The debugger can read variables but has no surface for writing one.

## Credentials and local files you must not commit

- `.env` holds live SAP credentials (`ABAP_URL`, `ABAP_USER`,
  `ABAP_PASSWORD`, ...). It is gitignored. Never commit it, paste it into an
  issue, or hand it to a tool that might echo it back.
- `.abapsmith/` (the write journal, by default under
  `<cwd>/.abapsmith/journal`) holds **before-images of real customer ABAP
  source** captured ahead of every write, so undo has something to restore.
  It is gitignored for exactly that reason. If you relocate it with
  `ABAP_JOURNAL_DIR`, make sure the new path is not committed, synced, or
  backed up anywhere that source should not go.
- `ABAP_INSECURE=true` disables TLS certificate verification entirely — it
  is not a convenience flag for self-signed certificates, it removes the
  check. Point `NODE_EXTRA_CA_CERTS` at your CA bundle instead.
- Embedding credentials directly in `ABAP_URL`
  (`https://user:pass@host`) works but puts a live password into an
  environment variable, visible to `ps`/`/proc` and anything that echoes
  the URL. Use `ABAP_USER`/`ABAP_PASSWORD` instead.
- `npm run check:leaks` scans tracked files for routable hostnames before
  they can land in git history — run it before committing anything you
  captured from a real system.

## Scope

In scope: the safety gate and mode ladder (`src/safety.ts`, `src/mode.ts`),
credential handling, the write journal, the ADT client and debugger
transport, and the `bin/abap-guard` client-side hook. Out of scope: the
underlying SAP system's own authorisation model (`S_TABU_DIS` etc.) — that's
the operator's responsibility, as described above.
