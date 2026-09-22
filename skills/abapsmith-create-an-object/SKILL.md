---
name: abapsmith-create-an-object
description: Creates, changes, or deletes an ABAP object with abap_write and checks whether it worked. Use for any mutation, and whenever a write returned success but the result looks wrong.
---

# Create or change an object

`abap_write` does save → syntax-check → activate in one call. Locking is handled.

**A 200 does not mean it worked.** Most failures on this surface are silent
successes. Always check the response signals below — that check is free and
applies in both write-verification modes.

## Before you start

1. Target type is in the writable list — see `writable-types.md` next to this
   skill (the generated table) — and `abap_write` validates `type` before
   anything else, so a wrong code fails with zero requests.
2. Package: `$TMP` (default) or a real package. `corr_nr` is optional for
   every type: omit it and the server picks or creates the request (the
   response's `transport:` field names it); name one only when
   `ABAP_ALLOW_TRANSPORTS` permits named requests — see
   `abapsmith-put-work-on-a-transport`.
3. Changing an existing object: `abap_read` it first and keep the `etag`.

## Steps

**1. Write.**

```
abap_write { object, type, package: "$TMP", source, description }
```

- `activate` defaults to `true`. Pass `activate: false` when creating a chain of
  dependent objects, then activate together at the end.
- Changing part of an existing object — prefer `edit: {old_string, new_string}`
  (splice a unique match) or `method` (replace one `METHOD…ENDMETHOD`) over
  resending the whole source. Both supply the etag automatically. Note `edit` is
  its own nested object, not a `mode`; `mode` takes `write`, `delete`, or
  `update` (the last one only for `VIEW/DV`, `TRAN/T` and `SHLP/DH` — see
  `doc/TOOLS/write-and-activate.md`).
- A bare `{object, source}` full rewrite does **not** auto-supply the etag. Pass
  `expect_etag` yourself or you will silently overwrite a concurrent change.
- Pass `dry_run: true` to see the gate verdict, the package a create would
  use, and a diff of the source, without creating anything. Refused, in every
  mode (not just create), for the four bridge-only types (`SHLP/DH`,
  `VIEW/DV`, `TRAN/T`, `TABL/DI`) and for `DEVC/K`.
- `CLAS/OC` sub-includes: pass `include: "testclasses" | "definitions" |
  "implementations" | "macros"`. Omitting it writes MAIN.

**2. Check the response.** Never skip this — it costs nothing.

## Verify

Check the response for **each** of these before reporting success — free, in
both modes:

| Signal | Meaning |
|---|---|
| activation messages with `type: "E"` | **Failed.** HTTP was still 200. The object is inactive. |
| `created: true`, `verified: false` for `SHLP/DH`, `VIEW/DV` or `TRAN/T` | A follow-up catalog read (`src/adt/catalog-read.ts`) after the bridge create did not find the object — abapsmith is trusting the classrun transcript alone for this response. Confirm by hand (SE11/SE54/SE93) before relying on it. `verified: true` for these three means the catalog read-back DID find it — read-back is attempted for all three now, not skipped. |
| `created: true`, `verified: false` for `TABL/DI` | Always `false` for a secondary index — it has no ADT resource of its own to read back from at all, so no read-back is ever attempted. |
| domain fixed-value texts empty after write | Root element lacked `adtcore:masterLanguage`. Add it and re-write; the text does persist. |
| no `etag` change | The PUT was a no-op — your source matched byte-for-byte after normalisation. |

**`speculative` (default, `ABAP_VERIFY_WRITES=speculative`)** — a write that
reported success and activated cleanly needs no read-back. Trust it; the table
above is the whole check.

**`verified` (`ABAP_VERIFY_WRITES=verified`, or `verify: true` on this call)**
— abapsmith re-reads the object itself and reports a `verify:` line; you don't
need to issue a second `abap_read`. If you ever do read one back by hand, pass
`version: "active"` explicitly — omitting `version` can return an **inactive**
newer version, so an unactivated object reads back looking correct.

## If it fails

- **Type refused** — not in the writable enum. Not routable around.
- **Unknown object type with `Did you mean …`** — use the suggested code only
  if it is what the task meant; `details.writable` lists every accepted type.
- **`SAFETY_DENIED`, rule `transport allowlist`** — the request this call would
  use is not permitted by `ABAP_ALLOW_TRANSPORTS`. It is **terminal for this
  object and package** (`retryable: false`): the hint names the rule and the
  only caller-side remedy — under `auto`, omit `corr_nr` (naming a request is
  refused regardless of which one); under a pinned list, pass one of the
  listed requests or omit `corr_nr`; under an explicitly empty list, only
  `$`-packages are writable. Do not vary arguments (another `corr_nr`, an
  empty string, a different package spelling, a different type code) — never
  retry by changing them, and never propose editing the server's environment,
  that is the operator's setting. Report the rule the hint names and, if the
  task allows, use `$TMP`. If the refusal carries `details.createdTransport`,
  a request was created before the refusal and holds nothing; report it (the
  hint says how to remove it).
- **`TRANSPORT_ERROR`** — a transport request is genuinely needed and none could
  be resolved (no transport manager wired into the call, or CTS refused to
  create one). Get a request first: `abapsmith-put-work-on-a-transport`. **Omit
  `corr_nr` entirely** when you have no request; do not pass `""`. `abap_write`
  tolerates the empty string, but `abap_enh` and `abap_activate` read it as a
  *named* request matching nothing and refuse `SAFETY_DENIED`, whose message
  points at transport config rather than at the empty string.
- **Etag mismatch after the PUT** (`phase: "pre-activation"`) — a second, later
  check than the one guarding your write. Someone changed the object mid-call.
  Re-read and redo; do not blindly retry.
- **Create threw but the object may exist** — creation is not atomic. `abap_read`
  before retrying, or you get a duplicate-name failure on a real object.
- **Wrong content written** — `abapsmith-recover-a-bad-write`. Undo refuses if the
  object changed on the server after abapsmith wrote it, and refuses outright for
  class sub-includes; both refusals are real, so read them before forcing.
