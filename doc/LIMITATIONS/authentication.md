# Authentication

Five mutually exclusive credential methods exist. Exactly one must be
configured — see
[CONFIGURATION/connection.md#authentication](../CONFIGURATION/connection.md#authentication)
for the variables, worked examples, and failure modes of each. This page is
about what has actually been checked, split by the kind of system each
method targets: password, cookie, and client certificate are the on-premise
methods; static token and OAuth client credentials are the cloud methods.
Nothing technical enforces that split — an on-premise landscape with an
OAuth-capable identity provider in front of it could use `ABAP_OAUTH_*` too
— it is simply what each method was built for and, separately, what has
been run against a real system.

## On-premise

- **Password (`ABAP_PASSWORD`) — verified.** The existing default: the ADT
  client is constructed with a plain username/password pair
  (`src/adt/connection.ts`). This is the only credential method exercised
  live against the reference system (A4H).
- **Session cookie (`ABAP_SESSION_COOKIE`) — implemented, never exercised
  against a real system.** An operator can set `ABAP_SESSION_COOKIE` to a
  `Cookie:`-header-shaped value captured elsewhere; abapsmith merges it into
  the outgoing `Cookie` header on every request at its own HTTP guard
  (`mergeInjectedCookies`, `src/adt/http-guard.ts`) and drops Basic auth from
  the request entirely in that mode. abapsmith cannot obtain, refresh, or
  persist a cookie — only carry one (`parseSessionCookie`, `src/config.ts`,
  only parses a value it's handed). The cookie has to already exist — an
  operator obtains it some other way, e.g. copied out of a browser after an
  interactive SSO login — and it lives in process memory only, supplied by
  environment variable, never written to disk. There is no re-login path:
  once the cookie expires, the server simply starts failing to authenticate.
  The available test appliance does not support SSO at all, so this path is
  covered by unit tests only — no live capture, no wire-level confirmation
  that any real SSO-fronted backend accepts what abapsmith sends.
- **Client certificate (`ABAP_CLIENT_CERT` / `ABAP_CLIENT_KEY` /
  `ABAP_CLIENT_KEY_PASSPHRASE`) — implemented, unverified.** X.509
  mutual-TLS logon: the certificate (PEM or PKCS#12) is presented during the
  TLS handshake itself, no `Authorization` header is sent, and `ABAP_USER`
  is not sent for logon — it is used only for journal attribution and the
  debugger identity, while the effective SAP user is whatever the
  certificate maps to on the system (transaction `EXTID_DN` / table
  `USREXTID`). This mode is covered by unit tests behind fakes only: A4H,
  the reference appliance, has no certificate logon configured, so no
  handshake has ever completed against a real ABAP system.
- **Client certificate: the identity mismatch is unchecked.** abapsmith
  cannot tell you that `ABAP_USER` and the certificate's mapped user
  disagree — no ADT call this server makes returns the connected user's
  `sy-uname`, so nothing here observes it. Journal attribution and the
  debugger identity are both keyed off `ABAP_USER`, so if the certificate
  maps to a different SAP user, the journal and the debugger will name the
  wrong user while the system attributes the actual change to whoever the
  certificate mapped to. Set `ABAP_USER` to the user the certificate maps to.
- **`ABAP_INSECURE` is unrelated to all three.** It only disables
  verification of the *server's* TLS certificate (see
  [CONFIGURATION/connection.md](../CONFIGURATION/connection.md)); it has
  nothing to do with authenticating this client. Verifying the server's
  certificate against a private CA, independently of `ABAP_INSECURE`, is
  `ABAP_CA_CERT` — also unverified, for the same reason as the certificate
  method above.

## Cloud

- **Static bearer token (`ABAP_TOKEN`) — implemented, unverified.** A fixed
  token sent as `Authorization: Bearer …` on every request, never refreshed.
  Simplest to reason about, and the easiest to get wrong operationally: a
  static token still needs a real rotation plan somewhere outside this
  server.
- **OAuth 2.0 client credentials (`ABAP_OAUTH_*` / `ABAP_SERVICE_KEY`) —
  implemented, unverified.** `grant_type=client_credentials` against an
  OAuth token endpoint, either configured directly or read out of an SAP BTP
  ABAP-environment service-key JSON. The access token is cached in process
  memory only, refreshed ahead of expiry, and a single 401 triggers exactly
  one refresh-and-retry.
- **Both are covered by unit tests behind fakes only.** A4H, the reference
  appliance, is an on-premise system with no OAuth server in front of it, so
  neither a token fetch nor a token-authenticated ADT request has ever gone
  over the wire to a real system. Anyone with a real cloud tenant should
  treat the first connection as the actual test of this code, not a
  formality.

None of the above closes the on-premise SSO/SAML/Kerberos gap described
above — bearer-token and OAuth support were built for cloud tenants, which
authenticate differently in the first place, not as a workaround for an
on-premise system's SSO front door. abapsmith still cannot perform an
SSO/SAML/X.509-via-browser/Kerberos-SPNEGO handshake itself; a design
sketch for bearer-token injection once lived at
`doc/analysis/sso-auth-design.md` (not included in this public tree) and
has since become the `ABAP_TOKEN`/OAuth implementation described above —
but, as that design always said, it targets cloud tenants (BTP ABAP
Environment, S/4HANA Cloud Public), not the on-premise SSO population the
cookie-mode gap above is about.

**abapsmith has never connected to a cloud tenant of any kind, so the rest
of this section is derived from SAP's documented cloud restrictions, not
from anything observed.** A cloud tenant is expected to differ from A4H
(the on-premise reference system every other verified claim in this
project's docs is checked against) in ways that go beyond authentication:

- A cloud tenant publishes a **reduced ADT discovery set**. Collections that
  are absent are expected to report `unsupported` rather than failing — so
  any tool that needs an absent collection should refuse with
  `UNSUPPORTED` rather than producing a confusing error. This has not been
  observed live; it follows from how this server already handles a missing
  discovery entry on any system.
- No classic dynpro is expected to be available. `$TMP`-style local-package
  semantics are also not expected to exist on a cloud tenant, so the
  `$TMP` conventions this server documents elsewhere (see
  [CONFIGURATION/permissions-and-allowlists.md](../CONFIGURATION/permissions-and-allowlists.md))
  do not apply there. The ABAP language version is restricted to `ABAP for
  Cloud Development`, so source that is legal on-premise can be rejected
  outright.
- The system-role probe records a **tenant observation**
  (`SystemRoleDetection.tenantKind`: `"cloud"` / `"on-premise"` / `"unknown"`,
  read from `ato/settings`'s `operationsType` attribute — `"C"` for cloud,
  `"H"` for on-premise/hybrid) but this **never changes the
  productive/non-productive verdict**. A cloud tenant is usually productive,
  and the safety gate stays fail-closed regardless of tenant kind — see
  [SAFETY/safety-gate.md](../SAFETY/safety-gate.md). The attribute's exact
  spelling and the value set above are UNVERIFIED: A4H has no
  `operationsType` to read, so this is read from SAP's own documentation of
  the field, not from a captured response.
- The debugger, ATC, traces, and anything else that depends on a collection
  a tenant does not publish are expected not to be available. As above,
  this was never run against a tenant; the list here is derived from SAP's
  documented cloud restrictions, not observed behaviour.

## Out of scope

Issue #80's stage 3 — a pluggable "login command" hook that would let an
operator re-obtain a fresh `ABAP_SESSION_COOKIE` automatically when the
current one expires — is deliberately not implemented. In every SSO-fronted
flow observed, obtaining a fresh session cookie requires an interactive
browser round trip (the identity provider's login page, possibly MFA); there
is no non-interactive command this server could reliably shell out to, so a
pluggable hook would have nothing dependable to call. An operator who does
have such a command already can run it themselves outside this server and
restart with a new `ABAP_SESSION_COOKIE` — that path exists today and does
not need a hook to work.

## Scope of the safety model

Restated here because it is the most common misreading — the full version is in
[doc/SAFETY/](../SAFETY/README.md):

- The data-preview deny-list **fails open** and is not a security control. The
  real boundary is the technical user's `S_TABU_DIS` / `S_TABU_NAM`
  authorisations.
- Nothing here substitutes for SAP authorisations. Give the technical user the
  least privilege that works.
- `abap_run`, `abap_test` and `abap_bopf_test` execute real ABAP with that
  user's rights. `abap_bopf_test` writes real rows. That ABAP can call SAP
  APIs directly, so none of it is subject to the package, object-name or
  transport allowlists — `ABAP_ALLOW_TRANSPORTS` does not constrain a
  transport request that ABAP names itself.
