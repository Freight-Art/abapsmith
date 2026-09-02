# Authentication

- **HTTP basic, or a pre-obtained session cookie — nothing else.** By
  default the ADT client is constructed with a plain username/password pair
  (`src/adt/connection.ts:607-620`). As an alternative, an operator can set
  `ABAP_SESSION_COOKIE` to a `Cookie:`-header-shaped value captured
  elsewhere; abapsmith merges it into the outgoing `Cookie` header on every
  request at its own HTTP guard (`src/adt/http-guard.ts:608-618`,
  `dispatch()` step 2c) and drops Basic auth from the request entirely in
  that mode. Exactly one of `ABAP_PASSWORD` or `ABAP_SESSION_COOKIE` is
  required at startup (`src/config.ts:881-918`) — setting both, or setting
  neither, is a startup error.
- **abapsmith cannot obtain, refresh, or persist a cookie — only carry
  one.** No SSO, no SAML, no OAuth/bearer tokens, no X.509 client
  certificates, no Kerberos/SPNEGO handshake is wired up
  (`parseSessionCookie`, `src/config.ts:131-141`, only parses a value it's
  handed). The cookie has to already exist — an operator obtains it some
  other way, e.g. copied out of a browser after an interactive SSO login —
  and it lives in process memory only, supplied by environment variable,
  never written to disk. There is no re-login path: once the cookie expires,
  the server simply starts failing to authenticate.
- **Cookie mode has never been exercised against a real system.** The
  available test appliance does not support SSO at all, so this path is
  covered by unit tests only — no live capture, no wire-level confirmation
  that any real SSO-fronted backend accepts what abapsmith sends.
- **`ABAP_INSECURE` is unrelated.** It only disables verification of the
  *server's* TLS certificate (see
  [CONFIGURATION/connection.md](../CONFIGURATION/connection.md)); it
  has nothing to do with authenticating this client, and there is no way to
  present a client certificate.
- **abapsmith still cannot perform an SSO/SAML/OAuth/X.509/Kerberos handshake
  itself.** That remains a hard boundary, not a rollout in progress. A
  design for plain bearer-token injection (`ABAP_TOKEN`) exists at
  `doc/analysis/sso-auth-design.md` (not included in this public tree) —
  design only, no production code written, and it would not close this gap
  even if built: it targets cloud tenants (BTP ABAP Environment, S/4HANA
  Cloud Public), not the on-premise SSO population this gap is about.

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
