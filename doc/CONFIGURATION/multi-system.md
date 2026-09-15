# Multi-system configuration

One abapsmith process can serve several SAP systems from one plugin
registration. Configure `DEV`, `QAS` and `PRD` once and an agent gets one
server: `abap_read {"object":"ZCL_FOO","system":"QAS"}` reads from QAS,
omitting `system` reads from whichever entry is the default, and comparing
`ZCL_FOO` between DEV and QAS is one call
(`abap_read view="diff" to_system="QAS"`) instead of two agents each holding
one connection. Each system keeps its own permission ceiling — a productive
system configured `read` next to a sandbox configured `admin` is exactly
the point, not a hazard to work around.

Nothing here replaces single-system configuration. With no `ABAP_SYSTEMS`
and no `ABAP_SYSTEM_*` variable set, everything — config, tool schemas, the
resource URI, the stderr banners — is exactly what it was before this
feature existed; see [Nothing changes for a single-system
setup](#nothing-changes-for-a-single-system-setup) below.

## Two configuration sources

Two sources feed the system table, and either or both may be used at once.
Where both name the same alias, real environment variables win key by key
— the same precedence `.env` already loses to a real environment variable
(see [connection.md](connection.md)).

### 1. `ABAP_SYSTEMS` — a file, or inline JSON

`ABAP_SYSTEMS` names a path to a JSON file, or, when the trimmed value
starts with `{`, is parsed as inline JSON directly. This is the form for a
fleet of systems reviewed and managed together as one file:

```json
{
  "default": "DEV",
  "systems": {
    "DEV": {
      "url": "https://dev.example.com:44300",
      "user": "DEVELOPER",
      "password_env": "ABAP_PASSWORD_DEV",
      "client": "001",
      "sid": "DEV",
      "mode": "admin",
      "allow_packages": ["$TMP", "ZDEMO"],
      "allow_name_prefixes": ["Z"]
    },
    "QAS": {
      "url": "https://qas.example.com:44300",
      "user": "DEVELOPER",
      "password_env": "ABAP_PASSWORD_QAS",
      "client": "100",
      "sid": "QAS",
      "mode": "read"
    },
    "PRD": {
      "url": "https://prd.example.com:44300",
      "user": "SUPPORT",
      "password_env": "ABAP_PASSWORD_PRD",
      "client": "100",
      "sid": "PRD",
      "mode": "read"
    }
  }
}
```

### 2. `ABAP_SYSTEM_<ALIAS>_<SETTING>` — the `.env`-native form

For an operator who does not want a second file, each variable sets one
setting of one system, the same way `ABAP_URL` etc. set it for a
single-system deployment:

```
ABAP_SYSTEM_DEV_URL=https://dev.example.com:44300
ABAP_SYSTEM_DEV_USER=DEVELOPER
ABAP_SYSTEM_DEV_PASSWORD_ENV=ABAP_PASSWORD_DEV
ABAP_SYSTEM_DEV_CLIENT=001
ABAP_SYSTEM_DEV_SID=DEV
ABAP_SYSTEM_DEV_MODE=admin
ABAP_SYSTEM_DEV_DEFAULT=true
ABAP_SYSTEM_QAS_URL=https://qas.example.com:44300
ABAP_SYSTEM_QAS_MODE=read
```

`<SETTING>` maps to `ABAP_<SETTING>` inside that alias's overlay — `_URL`
becomes `ABAP_URL`, `_MODE` becomes `ABAP_MODE`, and so on. Two settings
are exceptions, handled specially rather than mapped to an `ABAP_*`
variable: `_DEFAULT` marks the entry as the default (see
[Defaulting](#defaulting) below), and `_PASSWORD_ENV` is the same
env-var-name indirection the file form's `password_env` provides (see
[Secrets](#secrets) below).

An **alias** is `[A-Z0-9]`, 1–16 characters, with no underscore — the alias
is read out of the variable name as the segment between `ABAP_SYSTEM_` and
the *next* underscore, so an alias containing one would leave no way to
tell where the alias ends and the setting name begins. This is also the
exact string a caller passes as the `system` tool parameter and what the
`abap://{SID}/system` resource keys off of.

## Per-entry keys

| File key | Sets | Notes |
|---|---|---|
| `url` | `ABAP_URL` | |
| `user` | `ABAP_USER` | |
| `client` | `ABAP_CLIENT` | |
| `sid` | `ABAP_SID` | |
| `mode` | `ABAP_MODE` | `read` \| `edit` \| `admin`; see [SAFETY/permission-model.md](../SAFETY/permission-model.md#the-mode-ladder-is-per-system). |
| `allow_packages` | `ABAP_ALLOW_PACKAGES` | Array of strings; joined with `,` for the overlay, matching the variable's own comma-separated shape. |
| `allow_name_prefixes` | `ABAP_ALLOW_NAME_PREFIXES` | Array of strings, same join rule. |
| `allow_transports` | `ABAP_ALLOW_TRANSPORTS` | Array of strings, same join rule. |
| `password_env` | — | Names an environment variable holding the password. See [Secrets](#secrets). |
| `default` | — | `true` marks this the default entry (top-level `default` naming an alias is the file's other way to say the same thing). See [Defaulting](#defaulting). |
| `env` | — | A flat map of any further `ABAP_*` variable to its value, for this system only. See below. |
| `secrets` | — | A map from an `ABAP_*` variable name to the name of an environment variable holding its value — the certificate/token/OAuth equivalent of `password_env`. See [Secrets](#secrets). |

The eight keys with an `ABAP_*` target above are the ones an operator
reaches for most often, but they are not the limit of what is
configurable per system. `env` is a flat map of any further `ABAP_*`
variable to a literal value (e.g. `"env": {"ABAP_MAX_SESSIONS": "8",
"ABAP_ALLOW_TRANSPORT_RELEASE": "true"}`) — **every abapsmith setting is
therefore settable per system**, not only the ones with a dedicated file
key. An unrecognised ENTRY-level key — a typo of one of the ones above,
such as `mdoe` instead of `mode` — is a startup error naming the exact key
and the entry it was found in, so that class of typo is never a silent
no-op the way an unrecognised `ABAP_ALLOW_*` used to be before that gap
was closed (see [permissions-and-allowlists.md](permissions-and-allowlists.md)).
`env`'s own keys are checked less strictly: the only rule enforced there is
that the key starts with `ABAP_`, so an `env` entry naming a misspelled or
otherwise nonexistent `ABAP_*` variable (`ABAP_MAX_SESSION` instead of
`ABAP_MAX_SESSIONS`, say) is not caught at startup — it is passed through
like any other unrecognised environment variable, and behaves accordingly.

## Secrets

**Secrets never appear in the systems file.** `password_env` does not hold
a password — it names an ENVIRONMENT VARIABLE that holds one. `secrets` is
the same indirection generalised: a map from an `ABAP_*` variable name
(`ABAP_CLIENT_KEY_PASSPHRASE`, `ABAP_TOKEN`, `ABAP_OAUTH_CLIENT_SECRET`,
…) to the name of an environment variable holding that value, for
certificate passphrases, bearer tokens and service-key material.

A literal `password` key in an entry (or `passwd`/`pass`), or an `env` key
whose name contains `PASSWORD`, `PASSPHRASE`, `SECRET`, `TOKEN` or
`COOKIE`, is refused at startup with a message pointing at
`password_env`/`secrets` instead. This is deliberate, not conservative:
a systems file is exactly the kind of thing that ends up committed into a
dotfiles repo or baked into a container image layer, and abapsmith refuses
to be the reason a password does. The env-var form has nothing equivalent
to check for the same class of mistake — a real environment variable
that happens to be named `ABAP_SYSTEM_QAS_PASSWORD` is a config typo aimed
at an unrecognised key (see above), not a leaked secret, since setting an
environment variable is not writing a secret into a file that outlives the
process.

## Shared defaults and precedence

A plain `ABAP_*` variable that is not part of any system's overlay still
applies to every configured system — it behaves as a process-wide default,
and each entry's own keys (from the file, from `env`, from
`ABAP_SYSTEM_<ALIAS>_*`, or from `secrets`) override it for that system
only. This is how `ABAP_MAX_SESSIONS` or `ABAP_JOURNAL` gets set once for
the whole process, and how one system can still override it: set
`ABAP_MAX_SESSIONS=8` in the shared environment and
`"env": {"ABAP_MAX_SESSIONS": "16"}` inside PRD's entry, and PRD alone gets
16.

Precedence, narrowest wins: an entry's own env-var-form setting
(`ABAP_SYSTEM_<ALIAS>_<SETTING>`) over the same entry's file-form setting,
over a shared `ABAP_*` default. Between the two configuration *sources*
(file vs. `ABAP_SYSTEM_*`) for the very same key on the very same alias,
the environment-variable form wins — the same rule `.env` file contents
already lose to a real environment variable.

One family of settings is not per system at all: the MCP transport
(`ABAP_MCP_TRANSPORT`, `ABAP_MCP_HTTP_HOST`/`_PORT`/`_PATH`/`_TOKEN`, see
[transport.md](transport.md)) describes the one listener the process
opens, so it is read from the **default** entry's resolved configuration.
Set it in the shared environment; putting it into a non-default entry's
`env` has no effect and is not warned about.

## Defaulting

Exactly one entry is the default. The file form names it with the
top-level `default` key (`"default": "DEV"`); the env-var form marks it
per entry (`ABAP_SYSTEM_DEV_DEFAULT=true`). With more than one system
configured, naming zero entries as default, or naming two, is a startup
error — there is no implicit "first one wins." A systems configuration
with exactly one entry makes that entry the default automatically, with
nothing to mark.

## Startup validation

Every entry is parsed and validated through the identical code path a
single-system server's `loadConfig()` already uses — a per-system `Config`
comes out the other end in the same shape a single-system deployment gets,
not a parallel, looser validation route. If any entry is invalid, **the
whole process refuses to start**, and every problem across every entry is
collected and reported together — a malformed file, a missing secret
variable, an invalid value inside one alias's overlay, an ambiguous
default — rather than failing on the first one found and leaving the rest
to surface across successive restarts. Each problem names the entry and
where it came from, in the shape `systems entry <ALIAS> (<source>):
<message>`, where `<source>` is `file:<path>` (or `file:<inline JSON>` for
an inline `ABAP_SYSTEMS` value) or `env`, e.g.:

```
systems entry QAS (env): password is not a recognised entry key — set password_env instead.
```

**Secret VALUES never appear in these messages** — only variable names.
A missing `ABAP_PASSWORD_QAS` is reported by naming `ABAP_PASSWORD_QAS`,
never by printing what (if anything) it happened to contain.

## The `system` parameter

When more than one system is configured, every tool gains an optional
`system` parameter naming the alias to target:

```json
{"object": "ZCL_FOO", "system": "QAS"}
```

Omitting it targets the default entry. **When only one system is
configured, the parameter is not added to any tool's schema at all** — a
single-system deployment pays no schema bytes, and carries no unused
parameter for a model to notice and wonder about, for a feature it is not
using. An alias that is not one of the configured systems is refused with
`UNKNOWN_SYSTEM`, and the refusal lists the aliases that are actually
configured.

For what stays isolated per system once a call is routed — session pools,
auth breakers, discovery caches, the object gate, journal directories — see
[CONCURRENCY/multi-system-pools.md](../CONCURRENCY/multi-system-pools.md).
For how the permission ceiling is decided once a tool call names a target
system, see
[SAFETY/permission-model.md](../SAFETY/permission-model.md#the-mode-ladder-is-per-system) —
tool *registration* is process-wide (the union of every configured
system's capabilities), but the permission *decision* for a given call is
always made by the target system's own `SafetyGate`, using that system's
own mode and allowlists.

## Nothing changes for a single-system setup

With no `ABAP_SYSTEMS` and no `ABAP_SYSTEM_*` variable set, this feature
does not engage at all: configuration loads exactly as it always has, no
tool schema gains a `system` parameter, the resource stays at
`abap://{SID}/system` for the one configured SID, and the startup stderr
banners are unchanged. A single-system deployment is not "multi-system
with one entry" internally — it is the same code path this project has
always had.

## What is proven

Multi-system configuration, per-system routing and the cross-system diff
are covered by unit tests against fakes, and by ordinary single-system live
runs (proving that a system entry's resolved `Config` behaves the same way
a single-system `Config` does). **Two genuinely distinct SAP systems have
never been driven from one abapsmith process** — the reference sandbox this
project develops against is a single SAP appliance, and there has never
been a second one available to configure alongside it. See
[LIMITATIONS/not-implemented-and-unproven.md](../LIMITATIONS/not-implemented-and-unproven.md#unproven)
for exactly what that leaves unproven: whether two sets of ADT session
cookies genuinely stay separate under concurrent load, whether a second
system's `/discovery` and T000 probe behave as modelled once a real second
system is in the loop, and whether per-system journal directories collide
in practice rather than only in the code that names them.
