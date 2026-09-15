# The object gate & the debug arm lock

Two sibling cross-process locks — one serialising writes to the same object,
one serialising who may arm a debug listener against the same user. Neither
one bounds session count or in-flight request count; see
[Several agents, one sandbox](several-agents-one-sandbox.md) for what they do
not cover.

## The object gate

Same-object writes are additionally serialised through an `ObjectGate`, keyed
on the canonical object URI (query, fragment, and a trailing `/source/main`
stripped). `AdtSessionPool` selects one of three implementations at startup
(`src/adt/pool.ts`, constructor):

| Selection | Condition | Behavior |
|---|---|---|
| `NoopObjectGate` | `ABAP_SERIALISE_SAME_OBJECT_WRITES` set to anything other than `1`/`true`/`yes`/`on` | Pure pass-through — no queue, no lock. Same-object writes run fully concurrently. |
| `InProcessObjectGate` | (serialisation not opted out) **and** `ABAP_CROSS_PROCESS_OBJECT_LOCK=false` | One promise chain per object URI, in-process only. Two writes to the same object inside one process queue behind each other; two separate processes do not see each other at all. |
| `FileLockObjectGate` | shipped default — neither of the above | Composes `InProcessObjectGate` with a file lock (`withFileLock`) over `<stateDir>/locks/objects/<sha256(uri)-20hex>.lock`. Same-process ordering is unchanged; a second **process** pointed at the same object now blocks (or fails loud) instead of interleaving. |

`FileLockObjectGate` is what lets more than one `abapsmith` server process run
against the same ABAP system on one machine — two terminals, or a supervisor
that restarts the process — without their writes to the same object
interleaving. It does nothing across machines; the lock lives on local disk
under the resolved state directory.

The gate wraps the write, not the slot: it always runs **outside** slot
acquisition (`gate.run()` wraps the pool checkout), because taking a slot
first and then waiting on the gate would deadlock instantly at
`maxSessions = 1`.

**Known gap — batch activation is not object-gated.** `abap_activate`'s
`objects` batch form (`src/tools/activate.ts`) activates 2–50 objects through
a single `withWrite` checkout keyed on `undefined`, not on any one object's
URI — the gate is keyed on exactly one string (or none), and there is no API
to acquire several per-object locks for one call. A single large POST of
classic DDIC objects (domains, data elements, tables,
…) was found to make SAP's own DDIC mass-activation utility fan out into concurrent
server-side async RFCs and exhaust the target's dialog work processes, so
`activateObjects` (`src/adt/activate.ts`) splits such a batch into chunks and
POSTs them sequentially within the SAME checkout (`isFanoutProneType`/
`chunkActivationTargets`; see also the "Batch activation" section of
[doc/CONFIGURATION](../CONFIGURATION/concurrency-and-activation.md#batch-activation)).
Chunking does not close the gap: it is still one
checkout, still not keyed per object — only "one ADT request" no longer holds
literally. A same-object write racing one member of a batch is therefore not
serialised against it the way two single-object writes to that object would
be. This is accepted, not hidden: nothing else in the pool exposes a way to
take more than one object lock per checkout.

### The object gate key now includes the system

With [more than one system configured](multi-system-pools.md), the gate is
keyed on `(system, object)`, not on the object URI alone — a `scope`
(the system's alias) is hashed together with the object URI
(`objectGateLockPath(stateDir, objectUri, scope)`, `src/adt/object-gate.ts`).
This is deliberate: object identity is really per-system, so a `ZCL_FOO` on
DEV and a `ZCL_FOO` on QAS are different objects that only happen to share
a name, and without a scope they would serialise writes against each other
for no reason. `FileLockObjectGate`'s constructor takes an optional `scope`
for exactly this; a single-system server passes none, and an unscoped call
resolves the identical lock-file path this mechanism has always used.

The consequence is in the lock **file name**, not only in behavior: adding
a scope changes which file on disk represents a given object's lock, since
the file name is a hash of `scope\nobjectUri` rather than of `objectUri`
alone. This opens a narrow upgrade-window gap rather than a steady-state
hole — an abapsmith process still running an older, unscoped build next to
a newer, scoped one would not see each other's lock for the same object,
because each is watching a differently-named file. Once every process
sharing a state directory is on the scoped version, the gate is exact
again, the same as before this change.

A file-lock wait defaults to 1 500 ms (`ABAP_OBJECT_LOCK_WAIT_MS`, accepted
range 200–30 000 ms) — deliberately short, because the holder is not this
process and there is no reason to sit on an MCP tool call hoping it lets go.
A lock is treated as abandoned (and broken) after 600 000 ms regardless of
`waitMs`, sized for the worst legitimate gated write (lock → GET → PUT →
unlock → syntax-check → pre-activation GET → activate, each leg bounded by
`ABAP_TIMEOUT_MS`, default 60 000 ms).

## The debug arm lock

The debug lease (see [session-pool-and-cost.md](session-pool-and-cost.md#session-pool))
is a **per-process counter**, sized by `resolveDebugSessionLimit(cfg)`
(`src/adt/pool.ts`) — `min(ABAP_DEBUG_SESSIONS, floor(ABAP_DEBUG_DIA_BUDGET / 2))`,
floored at 1, default 1 (byte-identical to the fixed `DEBUG_CONCURRENCY = 1`
this replaced). It refuses a debug session past that count inside one
`abapsmith` process and knows nothing about any other process.
`DebugSession.armListener()`'s own guards (`status !== "idle"`,
`sessionBlockedBy`) are in-process for the same reason — so before this lock
existed, writes were protected across processes and the debugger was not: two
terminals could both arm a listener against the same SAP user and silently
interleave or reassign each other's debug session.

`armListener()` therefore also takes a cross-process advisory lock
(`src/debug/arm-lock.ts`), on the same `withFileLock` primitive the object
gate uses, over `<stateDir>/locks/debug/<sha256(key)-20hex>.lock`.

**One lock file per lane.** Each concurrent debug session inside a process
occupies a numbered lane (`0..resolveDebugSessionLimit(cfg)-1`); lane 0 hashes
the same path as before lanes existed (`sha256(key)`), so an old,
lane-unaware process and a new one at lane 0 still contend on the same file.
Lane `N > 0` hashes `key|laneN` instead, giving each lane its own lock file.
Lane selection lives in the tool layer, not here — this module only turns a
lane number into a path.

**The key is `(ABAP_URL, client, user)`** — user upper-cased, client verbatim
(an empty client and a set one are different logons), URL trimmed. There is
no per-object dimension, since a debug listener is not scoped to an object.
It is *not* keyed on `(terminalId, ideId)`: SAP enforces debug exclusivity per
**user** on a system, so two processes with distinct terminal/IDE ids still
contend for the one slot, and keying on them would lock nothing — confirmed
live against A4H (`test/cassettes/debugger/listener-conflict-409.cassette.json`):
a second `POST .../debugger/listeners` for the same SAP user is refused with
`409`/`conflictDetected` (T100 `SY 530`) even when it carries a different
`terminalId` from the holder's. Consequently, giving a process more lanes
(`ABAP_DEBUG_SESSIONS > 1`) only raises how many debug sessions this process
itself may hold locally — it does not create a second slot SAP will honor for
the same SAP user. A second lane only has a chance of actually attaching a
debuggee when it authenticates as a **different** `ABAP_USER`, or once a
terminal-scoped debugging mode (`debuggingMode: "terminal"`) is proven
functional — modelled in this repo but never demonstrated to work.

**Unlike the object gate, this key needs no explicit system scope** — with
[more than one system configured](multi-system-pools.md), `ABAP_URL` and
`client` already differ per system, so the `(ABAP_URL, client, user)` key
above naturally separates one system's debug lease from another's without
any change here. What does NOT separate per system is the lane pool itself:
`resolveDebugSessionLimit(cfg)` sizes one counter for the whole process, not
one counter per configured system, so the debugger is the one part of this
page that stays a single, process-wide resource shared across every system
rather than being duplicated per system the way the object gate and the
session pools are. See
[TOOLS/debugger.md](../TOOLS/debugger.md#system_mismatch-one-debug-session-for-the-whole-process)
for the `SYSTEM_MISMATCH` refusal this produces when a debugger call is
routed at a different system than the one the active session belongs to.

This is a **sibling** of `ObjectGate` above, not a reuse of it with a synthetic key:
the object gate canonicalises its key as an object URI (which would mangle a
synthetic one), is steered by write-oriented env switches, and reports
failures as `OBJECT_LOCKED_CROSS_PROCESS` — whose "possibly-inconsistent
object" wording is simply wrong here. Nothing about it lives in pool state
(pool law L5): the lock is constructed in `createLiveDebugToolDeps` and
injected into `DebugSession` exactly like `sessionLease`.

**It fails fast, it never queues.** The wait defaults to 1 500 ms
(`ABAP_DEBUG_LOCK_WAIT_MS`, range 200–30 000) and a loss surfaces as
`DEBUG_SESSION_LOCKED_CROSS_PROCESS`, naming the holder's pid, hostname and
start time. The argument for a short budget is stronger here than for
objects: a gated write holds its lock for a bounded lock→PUT→unlock cycle,
but a debug hold lasts as long as a human keeps stepping — waiting is not
merely unhelpful, it is hopeless.

**A crash cannot brick debugging.** Release happens on every exit path that
stops listening — a synchronous `launchListener` throw, a failed arm, a
listener timeout that returns to `"idle"`, and `doTerminate()`'s `finally`
(which runs even when every teardown step blows the 4 s total deadline). It is
deliberately *not* released when the poll rejects while the status stays
`"listening"`: the server-side registration may have survived, so this process
is still the one SAP would hand a debuggee to, and `terminate()` is what ends
that. For the paths no `finally` can cover — `SIGKILL`, a panic — the lock file
is reclaimed by `withFileLock`'s stale rules: a same-host holder whose pid is
gone is collected after roughly twice the wait budget, and any lock at all is
broken after one hour (the foreign-host / pid-reuse backstop). That hour is an
honest limit, not a bug: a session still being stepped after 60 minutes *will*
have its lock broken, which is accepted because the alternative failure mode is
a permanently wedged debugger.

Set `ABAP_CROSS_PROCESS_DEBUG_LOCK=false` to fall back to the in-process
guards — a separate switch from `ABAP_CROSS_PROCESS_OBJECT_LOCK` on purpose:
different resource, different remediation.
