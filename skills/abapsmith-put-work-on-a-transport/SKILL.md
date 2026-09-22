---
name: abapsmith-put-work-on-a-transport
description: Explains which transport request a write outside $TMP lands in, when to omit corr_nr, when a request must be created or named, and how to release one. Use before any write outside $TMP, or after a TRANSPORT_ERROR / SAFETY_DENIED on corr_nr.
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

The gate compares your `corr_nr` against that allowlist. Omitting the field means
"let the server pick or create the request" — the `auto` route. **Omit the field;
never pass the string `AUTO`, it is not accepted** (it is read as a named request
called `AUTO`, which matches nothing).

| allowlist | omitted | named `A4HK900123` | `""` |
|---|---|---|---|
| `auto` (default, unset) | allowed | **`SAFETY_DENIED`** | `SAFETY_DENIED` |
| `A4HK900123` (pinned) | **`SAFETY_DENIED`** | allowed | `SAFETY_DENIED` |
| `*` | allowed | allowed | `SAFETY_DENIED` |
| `[]` (explicitly empty) | denied | denied | denied |

Two consequences worth stating to the user:

- **Under `auto` you cannot choose the request.** Naming one is refused
  regardless of which request; the server reuses a modifiable request this
  session created (or one attributed to abapsmith) for the package, else creates
  one. Say which request it landed in, read back from the write response's
  `transport:` field — the user cannot ship what they cannot find.
- **Pinning a request forbids auto-creation.** Omitting `corr_nr` under a pinned
  list uses the first pinned request that is still modifiable, and fails once
  none is; pinned mode never creates a request.
- **A `SAFETY_DENIED` with `retryable: false` is terminal for this object and
  package.** Never retry it by changing arguments — not another request
  number, not an empty string, not a different package spelling. Its hint
  names the rule and the one caller-side way out (omit `corr_nr`, pass a
  listed request, or ask the operator). The allowlist is the operator's
  setting; do not suggest editing the environment to get past it. Report the
  rule the hint names and, if the task allows, use `$TMP` instead.

**Never send an empty string.** It is not the same as omitting the field: it is
read as a named request whose name is empty, and matches nothing under any
allowlist. Omit the field instead.

`$TMP` never reaches this gate.

## Steps

1. **Omit `corr_nr`.** This is the default path — correct under `auto` (and
   when the allowlist is unset), and also correct under a pinned list or `*`
   if you don't need to steer where the write lands.
2. **Write, then read the request number back.** The write response's
   `transport:` field names the request the server used. Report that number —
   the user cannot ship what they cannot find.
3. **Only if the allowlist is a pinned list or `*`, and you need to name a
   request:**
   - `transport_list` — look for a **Modifiable** request (`tm:status = "D"`).
     Key on `tm:status`, never `tm:status_text` (localised).
   - Under `*`, no suitable request → `transport_create { package,
     description }`. Under a pinned list, there is nothing to create — a
     freshly created number won't be on the pin; if none of the pinned
     requests is modifiable, that's the operator's setting, not something to
     work around.
   - Pass the number as `corr_nr`.

**Under `auto`, never call `transport_create` before a write.** A named
`corr_nr` is refused under `auto` regardless of which request, so calling
`transport_create` first buys you nothing — it can't be passed to the write
that follows — and just leaves an extra, empty request behind if the
resolver doesn't happen to pick it back up. Omit `corr_nr` and read the
request back from the write response instead (step 2).

This applies to every transportable create, including the classic-bridge types
(`VIEW/DV`, `TRAN/T`, `SHLP/DH`, `TABL/DI`, `DEVC/K`): none of them requires a
`corr_nr` any more. Under `auto` they take the same reuse-or-create route as a
class or program, and the response's `transport:` field names the request.
Naming one for them under `auto` is the same terminal `SAFETY_DENIED`.

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

For an object that does not exist yet, the candidates in steps 2–3 come from
CTS's view of the **package** (the object cannot be classified before it
exists). The safety gate judges the write before any of this — a refusal
costs no CTS call and creates no request. If a request was nonetheless created
in a call that then refused (only possible when the operator's allowlist
changes underneath a live session), the refusal names it in
`details.createdTransport` and its hint says `abap_transport operation=delete
corr_nr=<TRKORR>` removes it; every created request is journalled as
`transport-create`, so `abap_journal` lists it either way.

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

**Deleting an object under the same request that created it can leave a
duplicate E071 row, but `removeObject` clears it for you now.** CTS records
a separate E071 row for the create and for the delete (its row key is
TRKORR+AS4POS, not object identity, so both rows can coexist legally) — SAP
itself reliably does this for a create/delete/recreate/delete sequence on
the same object in one request. `removeObject` collapses a duplicate itself
before removing the entry: it keeps the lowest-AS4POS row, drops the
surplus E071 rows, then removes the one that's left — the response
names what it collapsed, and there's no longer a stranded request or a
human-only remedy for this case. `removeObject` returns `CTS_DUPLICATE_ENTRY`
only if the collapse itself can't bring the count to one (a late `TR 292`
from CTS, or an older bridge body without the collapse step) — in that
residual case `delete` keeps returning `TRANSPORT_LOCKED` on the request,
and the only way out needs a human: editing the request's object list in
SE09/SE10, or releasing the request outright. Still prefer deleting an
object under a different request than the one that created it when you have
the choice — it avoids the duplicate in the first place.

## Transport of copies

Workbench requests aren't the only kind. A **transport of copies** carries a
snapshot of already-active objects to one named target system, without
freezing the objects in this system: the originals stay modifiable, under
their own original request, which the copy leaves untouched. Reach for one
when you need to ship a snapshot to a target system (e.g. QAS) without
locking down further work on the same objects here.

Create one with `operation: "create"`, `kind: "copies"`, `target` (the
target system — required; a transport of copies with no target cannot be
imported anywhere, so abapsmith refuses to create one without it),
`package` (must be transportable — a `$`-package is refused, since objects
in a local package are never transported), and `description` — gated the
same as an ordinary `create` (`canWrite`, the `package` allowlist, no
`$`-package).

It has **no tasks**: `addUser` does not apply, and fails if you try it (ADT
answers HTTP 400, `TRANSPORT_ERROR "I::000"`). Don't chase that error as a
generic transport failure — recognise it as "wrong request kind" and stop.
See [doc/TOOLS/transports.md](../../doc/TOOLS/transports.md) for the wire
details and exactly what's proven live versus not.

## Did my change reach the target system?

`operation: "log"` (`transport`) reads a request's transport log.
`operation: "queue"` (`system`, optional `domain`) reads a target system's
TMS import queue. **The queue is the import BUFFER, not a history** — a
request that already imported has LEFT the buffer, so its absence there
does not mean it never arrived. Pair the two: `queue` says what's still
waiting, `log` says what already happened. Neither triggers an import —
that stays a human action in STMS; see
[doc/LIMITATIONS/not-implemented-and-unproven.md](../../doc/LIMITATIONS/not-implemented-and-unproven.md)
for why.

## Releasing

`abap_transport_release` is a **separate, irreversible** tool, and it is gated off
by default (`allowTransportRelease`). Release is a deployment decision, not a
cleanup step — never release a request just because the work is finished. Confirm
with the user first, and check the request is complete and owned by them.

Release it in one call: `abap_transport_release { transport: "<REQUEST>", confirm:
"<REQUEST>", scope: "request" }` releases every modifiable task that holds objects,
then the request itself, stopping at the first step that fails or can't be verified
and naming which step that was. Call it first without `confirm` — the dry run
reports `stepsPlanned` and a `STEPS` table, so you know the plan before it becomes
irreversible.

### Mode ceilings

Per-feature ceilings here are not implied by ordinary write access:

- **Transport release** (`abap_transport_release`) — `ABAP_MODE=admin` by
  default, or `edit` mode plus the explicit override
  `ABAP_ALLOW_TRANSPORT_RELEASE=true`. Legacy path: that same flag plus
  `ABAP_ALLOW_WRITE=true` when `ABAP_MODE` is unset.
- **Transport delete** (`abap_transport` `operation=delete`) — `ABAP_MODE=admin`
  only. There is no legacy flag that grants it; ordinary write access
  (`edit`) never does either.

`confirm`, or echoing a request number, only arms an action the ceiling
already permits — it never substitutes for the mode or the flag.

A `SAFETY_DENIED` here means the config forbids release; that is the intended
answer, not an obstacle to route around.

Releasing a request this session did not create is refused by default: `BAD_INPUT`
names the request, lists every object it would carry, and asks for
`confirm_unowned: "<TRKORR>"` alongside `confirm`. `confirm_unowned` must echo the
request number exactly, same as `confirm`. When this fires, the right response is
almost always to release the request **you** created instead — not to override.
Overriding is a deliberate decision about someone else's work, not a default path.

Releasing a task number alone leaves the request open — the response's `parent`
and `parentStillOpen` say so — so prefer `scope: "request"` on the request itself.

Check ownership before releasing: `transport_show` reports
`createdByAbapsmith` (the old `createdThisSession: yes|no` field is gone) —
use it, don't guess.
