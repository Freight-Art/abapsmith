# The HTTP transport's boundary

`ABAP_MCP_HTTP_TOKEN` authenticates CALLERS TO ABAPSMITH; it does not
authenticate them to SAP. Every session that gets past the token acts as
the one configured `ABAP_USER`, with the one configured `ABAP_MODE` and
allowlists — the connection to SAP is not re-established or re-scoped per
caller. SAP authorizations and the safety gate ([safety-gate.md](safety-gate.md),
[permission-model.md](permission-model.md)) remain the actual boundary on
what a request can do; the token only decides who is allowed to reach a
server that already holds those credentials.

What the token does not do:

- **It is not a per-user identity.** Two holders of the same unnamed token
  are indistinguishable from each other except by MCP session id. A
  **named** token (`name=token` in `ABAP_MCP_HTTP_TOKEN`) is the only thing
  that puts a caller name in the journal `actor` field — and that name is a
  label the operator chose when configuring the token, not an authenticated
  identity SAP or abapsmith verified.
- **It does not scope permissions.** There is no per-token `ABAP_MODE`,
  allowlist, or package scope. Every token — named or not — gets the whole
  surface this process was configured with. A token meant for a read-only
  caller and a token meant for an admin caller are, from abapsmith's side,
  the same capability.
- **It does not provide confidentiality.** abapsmith terminates plain HTTP
  and never TLS. Traffic between client and server carries ABAP source
  code, and under `ABAP_ALLOW_DATA_PREVIEW`/`ABAP_ALLOW_DUMP_VARIABLES` it
  can carry business data read out of the connected system. TLS, if you
  need it, must be terminated by a reverse proxy placed in front of this
  server — abapsmith does not speak it.
- **It does not rotate, expire, or revoke.** Changing a token means
  restarting the process — `ABAP_MCP_HTTP_TOKEN` is read once, at startup.
  There is no token store, no admin endpoint, and no refresh path.
- **It does not protect against a browser on the same machine.** The SDK's
  Streamable HTTP transport supports DNS-rebinding protection
  (`enableDnsRebindingProtection` with `allowedHosts`/`allowedOrigins`), and
  this server does **not** enable it — abapsmith exposes no variable for
  it. On a loopback bind with no token configured, any page a developer has
  open locally can POST to the MCP endpoint. This is a known gap, not an
  oversight to be discovered later. The mitigation today is to set
  `ABAP_MCP_HTTP_TOKEN` even on a loopback bind, where the startup refusal
  in [doc/CONFIGURATION/transport.md](../CONFIGURATION/transport.md#startup-refusal)
  does not otherwise force one.
- **It says nothing about the journal being shared.** Every MCP session
  writes into the one `ABAP_JOURNAL` directory and one `ABAP_STATE_DIR` the
  process was started with. One caller can list and `abap_journal
  mode=undo` another caller's writes — nothing in the token model
  separates journal entries by caller beyond the `actor`/`sessionId`
  fields recorded on them (see
  [doc/JOURNAL/journal-format.md](../JOURNAL/journal-format.md)). That is
  the same blast radius two people already have sharing one stdio server
  and one `.env` — the HTTP transport just makes it reachable over a
  network instead of requiring shell access to the same machine.

## Operator checklist

- Bind loopback (`ABAP_MCP_HTTP_HOST=127.0.0.1`, the default) and put a
  reverse proxy in front for anything that needs to be reached off-box —
  that proxy is where TLS gets terminated.
- Set a **named** token per caller (`name=token` in `ABAP_MCP_HTTP_TOKEN`,
  comma-separated for more than one) if you want journal entries to say who
  made a change, even loosely.
- Keep `ABAP_MODE` as low as the work in front of you allows — `edit`, not
  `admin`, when nobody needs transport release or cascade delete this
  session.
- Remember the write journal's before-images contain source: `ABAP_JOURNAL`
  is as sensitive as a checkout of the objects it covers, whether the
  transport is stdio or http.
