# MCP transport

`ABAP_MCP_TRANSPORT` picks which MCP transport `createServer().start()`
(`src/server.ts`) constructs. The same server binary, the same tools, the
same safety gate — only how a client reaches the process changes.

## stdio (the default)

`ABAP_MCP_TRANSPORT=stdio`, or unset. The server speaks JSON-RPC over its
own stdin/stdout, the way the Claude Code plugin install
([README.md § Install](../../README.md#install)) and the `mcpServers`
example below both assume. This is the default because it matches what the
server was built for: a local Claude Code plugin, one process per
conversation, no network surface at all. stdout belongs entirely to the
transport — every log line, warning, and diagnostic this server prints goes
to stderr instead, so nothing but MCP frames ever reaches stdout to corrupt
the stream.

Under stdio, one process is one conversation. `Journal.setClientActor()` /
`setClientSession()` hold that one conversation's identity process-wide —
see [doc/JOURNAL/journal-format.md](../JOURNAL/journal-format.md) for the
`actor` and `sessionId` fields this produces.

## http

`ABAP_MCP_TRANSPORT=http`. The server instead serves the MCP Streamable
HTTP transport from `@modelcontextprotocol/sdk`, over its own Node `http`
listener, and never touches stdin/stdout for protocol traffic.

This exists for cases stdio cannot cover: a server that runs next to the
SAP system so the technical user's credentials never leave the data
centre, with agents that themselves run elsewhere and only need a URL and
a token; or several developers sharing one already-configured ADT
connection without each of them holding the technical user's password on
their own machine. Neither of those is a claim that `http` is safer than
stdio by default — see [doc/SAFETY/remote-transport.md](../SAFETY/remote-transport.md)
for the boundary the bearer token does and does not provide once this is
reachable over a network.

### Variables

| Variable | Default | Meaning |
|---|---|---|
| `ABAP_MCP_TRANSPORT` | `stdio` | `stdio` or `http`. `http` serves the MCP Streamable HTTP transport instead of speaking JSON-RPC over stdin/stdout. Case-insensitive; any other value refuses to start (see [Startup refusal](#startup-refusal) below for the loopback/token case — a bad value here is a separate, simpler refusal naming `ABAP_MCP_TRANSPORT`). |
| `ABAP_MCP_HTTP_HOST` | `127.0.0.1` | Bind address. |
| `ABAP_MCP_HTTP_PORT` | `3000` | Bind port. `0` asks the OS for a free port; the port actually bound is printed on the ready banner. |
| `ABAP_MCP_HTTP_PATH` | `/mcp` | Path the MCP endpoint is served on. Must start with `/`. Every other path answers 404. |
| `ABAP_MCP_HTTP_TOKEN` | unset | Static bearer token(s), comma-separated. An entry may be `name=token`, in which case the name is recorded as the journal `actor` for writes made through that token; an entry with no valid `name=` prefix is an unnamed token — that fallback is what keeps a base64 token with `=` padding working. Values are as sensitive as `ABAP_PASSWORD`. |

Implemented in `src/config.ts` (`mcpTransport`, `mcpHttpHost`, `mcpHttpPort`,
`mcpHttpPath`, `mcpHttpTokens` — the last populated by `parseHttpTokens` in
`src/mcp-http-auth.ts` before validation, the same way `ABAP_SESSION_COOKIE`
and `ABAP_CLIENT_CERT` are). `ABAP_MCP_HTTP_TOKEN` set while
`ABAP_MCP_TRANSPORT` stays `stdio` is not an error — it only produces a
startup warning that the token is configured but ignored.

### Startup refusal

`loadConfig` refuses to start when `ABAP_MCP_TRANSPORT=http`, the bind
address is not a loopback address, and `ABAP_MCP_HTTP_TOKEN` is unset. Loopback
is `127.0.0.0/8`, `::1`, or `localhost` (`isLoopbackHost`, `src/mcp-http-auth.ts`)
— `0.0.0.0` and `::` are deliberately **not** loopback, because a wildcard
bind with no token is exactly the case this refusal exists for. The message,
verbatim (`mcpHttpIssue` in `src/config.ts`, `<host>`/`<user>` filled in from
the resolved `ABAP_MCP_HTTP_HOST` and `ABAP_USER`):

> ABAP_MCP_TRANSPORT=http would bind \<host\>, which is not a loopback
> address, and ABAP_MCP_HTTP_TOKEN is not set. abapsmith refuses to serve
> MCP unauthenticated on an address other hosts can reach: anything that
> can open a TCP connection to it would get this server's full configured
> SAP access as \<user\>. Set ABAP_MCP_HTTP_TOKEN, or bind 127.0.0.1 and
> terminate TLS and authentication in a reverse proxy in front of it.

Pinned by `test/config-mcp-transport.test.ts`.

### Ready banner

stdio prints (`src/server.ts`):

```
[abapsmith] ready on stdio — <SID> @ <url> as <user> (<mode>)
```

`http` prints the analogous line naming the address actually bound — a `0`
port still shows the port the OS handed out (`httpAddr.port`, resolved
before this line is built), and the path is the configured
`ABAP_MCP_HTTP_PATH`. An IPv6 host is printed in bracket form
(`http://[::1]:3000/mcp`, not `http://::1:3000/mcp`, which would be
ambiguous with a port-less address):

```
[abapsmith] ready on http://<host>:<port><path> — <SID> @ <url> as <user> (<mode>)
```

It is immediately followed by a second line naming the auth state — one of
two variants, verbatim from `src/server.ts`. With `ABAP_MCP_HTTP_TOKEN`
configured:

```
[abapsmith] HTTP auth: bearer token required (<N> configured: <name1>, <name2>, ...) — TLS is NOT terminated here; put a reverse proxy in front for anything but a loopback bind.
```

`<N>` is `cfg.mcpHttpTokens.length`; each entry in the list is the token's
name, or literally `(unnamed)` for a token with no `name=` prefix. With no
token configured (only reachable on a loopback bind — see
[Startup refusal](#startup-refusal) above):

```
[abapsmith] HTTP auth: NONE — bound to a loopback address only; a non-loopback bind without ABAP_MCP_HTTP_TOKEN is refused at startup (src/config.ts).
```

Both banners (stdio's `ready on stdio` line, and http's `ready on http://...`
plus `HTTP auth:` pair) are followed by the same write-journal line stdio
already prints (journal directory, retention, or the disabled warning).

### Client configuration

stdio — a `command`/`args`/`env` block, the same shape the
[top-level README's `mcpServers` example](../../README.md#wire-it-into-an-mcp-client)
already uses:

```jsonc
{
  "mcpServers": {
    "abap": {
      "command": "node",
      "args": ["/absolute/path/to/abapsmith/dist/index.js"],
      "env": {
        "ABAP_URL": "https://sap.example.com:44300",
        "ABAP_USER": "DEVELOPER",
        "ABAP_MODE": "read"
      }
    }
  }
}
```

`http` — a URL instead of a command, plus the bearer token. The exact key
names an MCP client expects for an HTTP-transport server vary by client;
this repository does not ship or test a config block for any specific
client, so treat this as the shape the server answers to, not a config file
to copy verbatim:

```jsonc
{
  "mcpServers": {
    "abap": {
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

### Not verified

- The `http` transport has been exercised only over a loopback socket in
  the offline suite (`test/mcp-http-transport.test.ts`), against a fake ADT
  server — never as a shared service next to a real SAP system.
- No real MCP client other than the SDK's own test harness has been pointed
  at it. Whether the `url`/`headers` shape above matches any particular
  client's config format is unverified.
- TLS termination by a reverse proxy in front of `http` is documented (see
  [doc/SAFETY/remote-transport.md](../SAFETY/remote-transport.md)) but no
  proxy configuration is tested or shipped.
- More than two concurrent MCP sessions against one `http` process has not
  been exercised.

See [doc/LIMITATIONS/not-implemented-and-unproven.md](../LIMITATIONS/not-implemented-and-unproven.md)
for the full list, kept consistent with this section.
