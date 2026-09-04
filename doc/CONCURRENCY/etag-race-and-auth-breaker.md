# The pre-activation etag race & the 401 circuit breaker

Two independent safety mechanisms that sit outside the session pool and the
object/debug gates: closing most of the window between an unlocked write and
its activation, and refusing to retry against a rejected password.

## The pre-activation etag re-read

ADT activation carries no version pin — it POSTs an object name and URI, and
whatever inactive version happens to be saved at that instant is what gets
activated. The object lock is released before activation (it must be, to let
activation see the just-written inactive version), which leaves a real
window: another writer can lock, PUT, and unlock between this write's unlock
and its own activation.

Both the ordinary write path (`src/tools/write.ts`) and undo
(`src/adt/undo.ts`) close most of that window with a guard immediately
before activating: re-read the object's current source, hash it with
`canonicalEtag` (the same canonicalisation used to record the write's own
etag, so server-side reformatting never fires this by accident), and compare
against the etag this call itself just wrote. A mismatch throws
`ETAG_CONFLICT` with `details.phase: "pre-activation"` instead of activating
— the write already landed as the *inactive* version, but it is reported as
refused, not as silently overwritten.

This turns what would otherwise be a silent lost update — writer A's source
published under writer A's success message, when the bytes on the server are
actually writer B's — into an honest, loud failure. The limit is real and
stated plainly in the code: the guard **narrows** the race to a single round
trip (the gap between the re-read GET and the activation POST is still
unguarded); it does not and cannot **close** it, because the protocol has no
`If-Match` for activation.

## The 401 circuit breaker

`login/fails_to_user_lock` defaults to 5 on the SAP side: five consecutive
failed logons and the technical user is locked, and every abapsmith caller
stops working until an administrator unlocks it. This is a shared,
process-wide constant, so retrying against a rejected password is never
safe.

The rule: **on the first authentication failure, trip a latch, mark the
connection permanently unusable for the lifetime of the process, and never
send another authenticated request.** Concretely:

- The latch (`AuthCircuitBreaker`) lives *below* the ADT client library,
  because the library itself retries once on what it assumes is an expired
  SSO ticket — a retry that is itself a second logon attempt. Sitting below
  it means that retry is answered locally and never reaches the network.
- A failed logon is not always a clean HTTP 401. An ICF-level logon problem
  can answer `200` with an "Anmeldung fehlgeschlagen" / "Logon failed" HTML
  page; that still counts as a failed logon against the lockout counter, so
  it trips the latch too.
- The latch is **never** retried automatically or on a timer — unlike the
  separate transient-failure breaker in the same module (which does recover
  on its own from 5xx/timeouts/network errors, since those are not
  credential problems). It recovers only through an explicit re-arm, which
  admits a single probe request; a probe that fails doubles a bounded
  cooldown before the next re-arm is accepted.
- A short dump or a session-death response (a user's ABAP syntax mistake)
  must never trip the latch — that would let one bad ABAP statement disable
  the server for the rest of the process's life. These are classified
  `"ignored"`, ahead of the auth classifier.
- The latch is also recorded on disk under the state directory
  (`auth-latch.json`, keyed by a credential fingerprint), so every
  concurrently running terminal against the same rejected credentials picks
  up the same latched state instead of each independently burning a logon
  attempt.

**To clear it:** create the `auth-rearm` file beside `auth-latch.json` under
the state directory — that admits exactly one further logon attempt, without
restarting anything, and if the credentials are still wrong that attempt
spends one more against `login/fails_to_user_lock`. The durable on-disk entry
also expires on its own after a fixed TTL, or can be deleted immediately to
clear it for every terminal at once.
