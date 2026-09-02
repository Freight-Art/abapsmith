# Several agents, one sandbox

**The hazard.** Every budget described in
[session-pool-and-cost.md](session-pool-and-cost.md) is per process. Nothing
coordinates pool size across processes: the only cross-process state
described in this folder is the object gate and the debug arm lock (see
[object-gate-and-debug-lock.md](object-gate-and-debug-lock.md)), and neither
one bounds session count or in-flight request count. A single `abapsmith`
process's peak DIA demand is bounded by
`readConcurrency + writeConcurrency + one debug lease` — 2 + 2 + 1 = 5 at the
shipped defaults — not by how many of its `maxSessions` slots happen to
exist, since an idle pooled session holds no dialog work process and only a
request in flight (or a suspended debuggee, see the debug lease row in
[session-pool-and-cost.md](session-pool-and-cost.md#measured-numbers)) does.
Two processes at the defaults can therefore want up to 10 dialog work
processes between them against an appliance with `rdisp/wp_no_dia = 7`, plus
whatever a human is doing in SE80 at the same time.

**Why the failure mode is nasty.** DIA pressure does not fail closed. The
measured row in
[session-pool-and-cost.md](session-pool-and-cost.md#measured-numbers) — 14 075
ms of queue delay with 5 of 7 DIA work processes held busy — is a request
parking for a free work process, not a request being refused. A caller that
experiences that as a hang retries, and a retry is more demand on the same
scarce resource, not less. Reads, which callers reasonably expect to be
cheap and safe to retry, hang exactly like writes do.

**The incident, stated as an incident.** A plain read-only `abap_search`
stopped being answered against a shared A4H appliance. A later benchmark run
failed its own warm-up with `MCP error -32001` and `EPIPE`, creating nothing
before it aborted. Multiple agent worktrees were operating against the same
appliance at the time. Here is the boundary: no `SM50`/`SM66` snapshot was
taken during the incident, so the correlation between this server's session
count and appliance saturation was **never measured**. An unrelated
appliance-side problem, a wedged debug lease (which pins a DIA for the life
of the lease, not excluded), and a hung long-poll listener (115 s of
head-of-line blocking on one session, also measured in
[session-pool-and-cost.md](session-pool-and-cost.md#measured-numbers)) all
remain live, un-excluded explanations. The symptoms are consistent with DIA
exhaustion and the shipped defaults make DIA exhaustion reachable — that is
as far as the evidence goes.

**How to check your own footprint.** Read the `abap://{SID}/system` MCP
resource ([doc/TOOLS/system-resource.md](../TOOLS/system-resource.md)) and look at its
`sessions` block. `busy` is the DIA-relevant number: it counts leases
currently in flight, which is what actually occupies a work process; `total`
is slots the pool has minted, most of which sit idle between requests and
hold no DIA. A `busy` count that stays pinned while no tool call is running
is not throughput — it is the signature of a held debug lease or a live
long-poll listener, both of which occupy a slot (and a DIA) while doing
nothing a moment-in-time count would recognize as work. The resource read
itself takes no pool lease, so it keeps answering even while the pool is
fully saturated.

**What a future SM50/SM66 correlation would need.** This is what would turn
the inference above into a fact, and it has not been done. Concretely: at the
same wall-clock instant as an `SM50`/`SM66` snapshot, read `sessions` from
every `abapsmith` process running against that system, sum `busy` across
them, and compare the sum against the appliance's DIA count and against the
SM50 rows that are *not* this technical user. All `abapsmith` processes share
one technical user, so SM50 alone cannot attribute a work process to a
particular process — the per-process `sessions` read is what supplies the
attribution that SM50 can't.

**A recommendation for shared-sandbox operation.** For `M` processes sharing
one appliance, size the per-process budget so `M × (readConcurrency +
writeConcurrency + 1)` leaves headroom below `rdisp/wp_no_dia` for a human on
SE80. For example, two processes against a 7-DIA appliance:
`ABAP_READ_CONCURRENCY=1`, `ABAP_WRITE_CONCURRENCY=1`,
`ABAP_MAX_SESSIONS=3` per process — peak demand 2 × 3 = 6, leaving one DIA of
headroom. This is a recommendation, not a default change: **the shipped
defaults stay 5/2/2.** The causal claim above is unproven, and every
measurement in
[session-pool-and-cost.md](session-pool-and-cost.md#measured-numbers) was
taken against those defaults — changing them would make this file describe a
configuration nobody ships.

**Why the existing startup warning does not cover this.** `src/config.ts:1238`
already warns when `readConcurrency + writeConcurrency + 1` exceeds
`maxSessions` — but that is a single-process, lane-vs-pool over-subscription
check, and at the shipped defaults it evaluates `2 + 2 + 1 = 5` against
`maxSessions = 5` and therefore never fires. It says nothing about a second
`abapsmith` process on the same appliance and cannot be extended to: a
process cannot see how many sibling processes are running, or what budgets
they were started with. This section is the only place the cross-process
hazard is documented.
