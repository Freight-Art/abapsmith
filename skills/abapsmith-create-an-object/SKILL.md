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

1. Target type is in the creatable list — see `abapsmith-orient`. If not, stop.
2. Package: `$TMP` (default) or a real package **plus `corr_nr`**.
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
  its own nested object, not a `mode`; `mode` takes only `write` or `delete`.
- A bare `{object, source}` full rewrite does **not** auto-supply the etag. Pass
  `expect_etag` yourself or you will silently overwrite a concurrent change.
- `CLAS/OC` sub-includes: pass `include: "testclasses" | "definitions" |
  "implementations" | "macros"`. Omitting it writes MAIN.

**2. Check the response.** Never skip this — it costs nothing.

## Verify

Check the response for **each** of these before reporting success — free, in
both modes:

| Signal | Meaning |
|---|---|
| activation messages with `type: "E"` | **Failed.** HTTP was still 200. The object is inactive. |
| `created: true`, `verified: false` for `TRAN/T` | Not confirmed present by read-back — abapsmith is trusting the classrun transcript alone. Confirm by hand (SE93) before relying on it. |
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

- **Type refused** — not in the creatable enum. Not routable around.
- **`TRANSPORT_ERROR`** — transportable package without `corr_nr`. Get a request
  first: `abapsmith-put-work-on-a-transport`. **Omit `corr_nr` entirely** when you
  have no request; do not pass `""`. `abap_write` tolerates the empty string, but
  `abap_enh` and `abap_activate` read it as a *named* request matching nothing and
  refuse `SAFETY_DENIED`, whose message points at transport config rather than at
  the empty string.
- **Etag mismatch after the PUT** (`phase: "pre-activation"`) — a second, later
  check than the one guarding your write. Someone changed the object mid-call.
  Re-read and redo; do not blindly retry.
- **Create threw but the object may exist** — creation is not atomic. `abap_read`
  before retrying, or you get a duplicate-name failure on a real object.
- **Wrong content written** — `abapsmith-recover-a-bad-write`. Undo refuses if the
  object changed on the server after abapsmith wrote it, and refuses outright for
  class sub-includes; both refusals are real, so read them before forcing.
