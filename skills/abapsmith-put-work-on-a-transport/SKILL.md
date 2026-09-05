---
name: abapsmith-put-work-on-a-transport
description: Gets a transport request number to pass as corr_nr before writing to a transportable package. Use before any write outside $TMP, or after a TRANSPORT_ERROR.
---

# Getting a transport request

This is a **precondition of writing**, not a shipping step. Do it before
`abap_write`, not after.

## Do you need one?

- Package `$TMP` or local → **no**. `corr_nr` is ignored if you pass it.
- Any other package → **yes**, and the request that gets used depends on
  `ABAP_ALLOW_TRANSPORTS`.

**Check `ABAP_ALLOW_TRANSPORTS` before you choose a number.** It decides which
`corr_nr` values are legal, and its default is narrower than it looks.

## `corr_nr` is gated by ABAP_ALLOW_TRANSPORTS

The gate compares your `corr_nr` against that allowlist. Omitting the field is not
"no value" — it is the value `AUTO`.

| allowlist | omitted (AUTO) | named `A4HK900123` | `""` |
|---|---|---|---|
| `auto` (default, unset) | allowed | **`SAFETY_DENIED`** | `SAFETY_DENIED` |
| `A4HK900123` (pinned) | **`SAFETY_DENIED`** | allowed | `SAFETY_DENIED` |
| `*` | allowed | allowed | `SAFETY_DENIED` |
| `[]` (explicitly empty) | denied | denied | denied |

Two consequences worth stating to the user:

- **On the default config you cannot choose the request.** Naming one is refused;
  the server auto-selects or auto-creates. Say which request it landed in, read
  back from the write response — the user cannot ship what they cannot find.
- **Pinning a request forbids auto-selection.** `AUTO` is not in a pinned list, so
  omitting `corr_nr` starts failing the moment someone pins one.

**Never send an empty string.** It is not the same as omitting the field: it is
read as a named request whose name is empty, and matches nothing under any
allowlist. Omit the field instead.

`$TMP` never reaches this gate.

## Steps

1. `transport_list` — look for a **Modifiable** request (`tm:status = "D"`).
   Key on `tm:status`, never `tm:status_text` (localised).
2. No suitable request → `transport_create { package, description }`.
3. Pass the number as `corr_nr` only if the allowlist permits a named request;
   otherwise omit it and report which request the server chose.
4. Want the work isolated in its own request under `auto`? Call
   `transport_create` first regardless — you still can't name it as `corr_nr`,
   but the next transportable write in this session lands in it. Then write
   with `corr_nr` omitted, and read the write response's transport note to
   confirm which request it picked.

### Which request an omitted `corr_nr` lands in

Under `auto`, the server picks in this order:

1. The request this session is already using — if this session created it.
2. Any modifiable workbench request this session created (via `transport_create`,
   or auto-created by an earlier write), even over the request the session is
   currently holding if that one wasn't created this session.
3. Failing that, a modifiable request owned by the connected user whose
   description matches abapsmith's own naming (`abapsmith session <date>`) —
   which can be a **leftover from a previous abapsmith session**, not this one.
   The write response says so plainly when it happens.
4. Failing that, it creates a fresh request.

## Reading a list result

`transport_list` needs a persisted CTS search configuration to see Modifiable
requests at all. Without one the server silently answers with a canned
"Released (last 2 weeks)" view regardless of your filters. When write access
is allowed, `list` may perform a one-time write of its own — persisting that
search configuration — purely so later `list` calls see Modifiable requests;
it is otherwise a read.

**If the response carries a note saying Modifiable requests were not reliably
included, an empty result proves nothing.** That happens in read-only mode.
Use `transport_show` on a known number, or `transport_check` on the object,
instead of concluding there are no open requests.

## Requests vs tasks

A **request** (`A4HK900123`) contains **tasks**. Objects are recorded into tasks.
The two are numbered identically and are indistinguishable by eye — and a GET on a
task returns its **parent request**. `corr_nr` wants a request; passing a task
gives a clean 400 (`CTS_WBO_API` 037).

## Failure messages that mislead

`ExceptionResourceNoAuthorization` (403) is **not** an authorization problem for
bad `corr_nr` values. It fires for *"task/request does not exist"* and *"not a
change request"*. Read the free-text message.

`TRANSPORT_GONE` — the request was released or deleted mid-session. Get a fresh
number; this one is retryable.

`TRANSPORT_LOCKED` — an object entry stays locked to its request until the
request is released; deleting the object does not clear it, and the task
refuses the same delete. Reach for `abap_transport operation="removeObject"`
(object = the entry's name, confirm = the request/task number) only when
that entry is for an object that no longer exists and you need the request
to become deletable — it needs admin mode and removes the entry outright
rather than unlocking it. There's no way to keep the object on the request
while clearing its lock, so this is the wrong move when you still want the
object transported. An auto-created request is therefore
mostly not disposable: don't spin one up as a scratch request, and don't
reach for release just to clean one up (see Releasing, below).

## Releasing

`abap_transport_release` is a **separate, irreversible** tool, and it is gated off
by default (`allowTransportRelease`). Release is a deployment decision, not a
cleanup step — never release a request just because the work is finished. Confirm
with the user first, and check the request is complete and owned by them.

A `SAFETY_DENIED` here means the config forbids release; that is the intended
answer, not an obstacle to route around.

Releasing a request this session did not create is refused by default: `BAD_INPUT`
names the request, lists every object it would carry, and asks for
`confirm_unowned: "<TRKORR>"` alongside `confirm`. `confirm_unowned` must echo the
request number exactly, same as `confirm`. When this fires, the right response is
almost always to release the request **you** created instead — not to override.
Overriding is a deliberate decision about someone else's work, not a default path.

Check ownership before releasing: `transport_show` reports `createdThisSession:
yes|no`; use it, don't guess.
