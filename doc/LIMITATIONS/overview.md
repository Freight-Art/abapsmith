# Overview

What this server does not do, cannot do, or has not proven it does — grouped
by whether the boundary is a missing feature, a structural property of the
platform, or something simply not verified yet.

## Refusals that are terminal

Some refusals are permanent: the identical call cannot succeed no matter how
many retries. Those carry `retryable: false` on the error envelope, and where
the refusal was produced by a capability-registry fact, the sentence "Terminal
for this object type — an identical retry cannot succeed." in the message text
(`TERMINAL_REFUSAL_NOTE`, `src/adt/capabilities.ts`).

`retryable` is derived from the error's taxonomy code rather than decided
per message: `RETRYABILITY` in `src/adt/errors.ts` classifies every
`AbapErrorCode` as terminal, retryable or conditional, and an individual throw
site departs from that classification only with a stated reason. So
`retryable: true` *is* sent, and means a different argument genuinely would
work — a `BAD_INPUT` on a length limit, for instance. Absence of the key is
still not a claim that retrying will work: it is the conditional case, where
this layer cannot see enough to say either way.

`SESSION_DEAD` and `CHECK_FAILED` — along with `LOCKED`, `ETAG_CONFLICT`,
transport errors and other payload-fixable refusals — are classified
conditional for exactly that reason, and so are never marked terminal:
retrying (after a fix, or as-is for `SESSION_DEAD`) can be the correct move
for those.

`TERMINAL_REFUSAL_NOTE` is raised inside a branch gated on a
capability-registry lookup (`REGISTRY` in `src/adt/capabilities.ts`) rather
than hardcoded per message — so the day a type gains that capability, the
refusal stops firing and the sentence disappears with it, rather than going
stale.

## The v2 tool surface (`ABAP_TOOL_SURFACE=v2`)

Experimental, not supported for production use — see
[doc/TOOL-SURFACE-V2/](../TOOL-SURFACE-V2/README.md) for known defects and
status; they are not being fixed while it holds this status. Every
limitation below applies to v2 as well as v1 unless noted otherwise — v2 is
a thinner routing layer over the same core, not a separate implementation.
